/**
 * Before-Merge Gateway Stage — final stage that aggregates all quality signals.
 *
 * The before-merge gateway produces a pass/fail checklist verifying:
 * - All quality gates are green
 * - All tests are green
 * - GUI acceptance is green (auto-pass for non-UI tasks)
 * - No unaudited dependencies
 * - Readiness grade not lowered
 * - Debt ledger is recorded (zero entries is valid)
 *
 * Fails closed on internal errors.
 * Gated by the `before_merge_gateway` feature flag.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5
 */
import type {
  VerificationStage,
  AgentEdit,
  ProjectContext,
  StageResult,
  Diagnostic,
  StageName,
} from '../types';
import type { FeatureFlagChecker } from './test-gap-stage';
import { DefaultFeatureFlagChecker } from './test-gap-stage';

// ─── Checklist Types ────────────────────────────────────────────

/**
 * Individual checklist item result.
 */
export interface ChecklistItem {
  /** Human-readable name of the check */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Human-readable description of the result */
  message: string;
  /** Remediation guidance if the check failed */
  remediation?: string;
}

/**
 * The full before-merge gateway checklist.
 */
export interface MergeGatewayChecklist {
  /** All quality gates from prior stages passed */
  allQualityGatesGreen: boolean;
  /** All tests passed */
  allTestsGreen: boolean;
  /** GUI acceptance passed (auto-pass for non-UI tasks) */
  guiAcceptanceGreen: boolean;
  /** No new unaudited dependencies introduced */
  noUnauditedDependencies: boolean;
  /** Readiness grade is not lower than baseline */
  readinessGradeNotLower: boolean;
  /** Debt ledger entries recorded (zero entries is valid) */
  debtLedgerRecorded: boolean;
}

/**
 * Human-readable summary produced by the gateway.
 */
export interface MergeGatewaySummary {
  /** Overall pass/fail */
  passed: boolean;
  /** Individual checklist items with pass/fail and remediation */
  items: ChecklistItem[];
  /** Summary text for display */
  summaryText: string;
}

// ─── Provider Interfaces ────────────────────────────────────────

/**
 * Provides quality gate results from prior pipeline stages.
 */
export interface QualityGateProvider {
  /** Returns true if all prior quality gates have passed */
  allGatesPassed(): boolean;
  /** Returns names of any failing gates */
  getFailingGates(): string[];
}

/**
 * Provides test execution results.
 */
export interface TestResultProvider {
  /** Returns true if all tests passed */
  allTestsPassed(): boolean;
  /** Returns count of failing tests */
  getFailingTestCount(): number;
}

/**
 * Provides GUI acceptance results.
 */
export interface GUIAcceptanceProvider {
  /** Returns true if the task is UI-touching */
  isUITouchingTask(): boolean;
  /** Returns true if GUI acceptance passed (or auto-passed for non-UI) */
  guiAcceptancePassed(): boolean;
  /** Returns descriptions of failing criteria */
  getFailingCriteria(): string[];
}

/**
 * Provides dependency audit status.
 */
export interface DependencyAuditProvider {
  /** Returns true if there are no new unaudited dependencies */
  noUnauditedDeps(): boolean;
  /** Returns list of unaudited dependency names */
  getUnauditedDeps(): string[];
}

/**
 * Provides readiness grade comparison.
 */
export interface ReadinessGradeProvider {
  /** Returns the current readiness grade (0–100) */
  getCurrentGrade(): number;
  /** Returns the baseline grade before the current task (0–100) */
  getBaselineGrade(): number;
  /** Returns true if the current grade is not lower than baseline */
  gradeNotLowerThanBaseline(): boolean;
}

/**
 * Provides debt ledger status.
 */
export interface DebtLedgerProvider {
  /** Returns true if the debt ledger is accessible (recorded state, zero entries is valid) */
  isLedgerRecorded(): boolean;
  /** Returns the number of entries in the ledger */
  getEntryCount(): number;
}

// ─── Default Providers ──────────────────────────────────────────

/**
 * Default quality gate provider that reports all gates as passing.
 * In production, integrates with the pipeline's previous stage results.
 */
export class DefaultQualityGateProvider implements QualityGateProvider {
  private stageResults: Array<{ name: string; passed: boolean }>;

  constructor(stageResults?: Array<{ name: string; passed: boolean }>) {
    this.stageResults = stageResults ?? [];
  }

  allGatesPassed(): boolean {
    return this.stageResults.every((r) => r.passed);
  }

  getFailingGates(): string[] {
    return this.stageResults.filter((r) => !r.passed).map((r) => r.name);
  }
}

/**
 * Default test result provider.
 */
export class DefaultTestResultProvider implements TestResultProvider {
  private passed: boolean;
  private failCount: number;

  constructor(passed = true, failCount = 0) {
    this.passed = passed;
    this.failCount = failCount;
  }

  allTestsPassed(): boolean {
    return this.passed;
  }

  getFailingTestCount(): number {
    return this.failCount;
  }
}

/**
 * Default GUI acceptance provider. Auto-passes for non-UI tasks.
 */
export class DefaultGUIAcceptanceProvider implements GUIAcceptanceProvider {
  private uiTouching: boolean;
  private passed: boolean;
  private failingCriteria: string[];

  constructor(uiTouching = false, passed = true, failingCriteria: string[] = []) {
    this.uiTouching = uiTouching;
    this.passed = passed;
    this.failingCriteria = failingCriteria;
  }

  isUITouchingTask(): boolean {
    return this.uiTouching;
  }

  guiAcceptancePassed(): boolean {
    // Auto-pass for non-UI tasks
    if (!this.uiTouching) return true;
    return this.passed;
  }

  getFailingCriteria(): string[] {
    if (!this.uiTouching) return [];
    return this.failingCriteria;
  }
}

/**
 * Default dependency audit provider.
 */
export class DefaultDependencyAuditProvider implements DependencyAuditProvider {
  private unaudited: string[];

  constructor(unaudited: string[] = []) {
    this.unaudited = unaudited;
  }

  noUnauditedDeps(): boolean {
    return this.unaudited.length === 0;
  }

  getUnauditedDeps(): string[] {
    return this.unaudited;
  }
}

/**
 * Default readiness grade provider.
 */
export class DefaultReadinessGradeProvider implements ReadinessGradeProvider {
  private current: number;
  private baseline: number;

  constructor(current = 80, baseline = 80) {
    this.current = current;
    this.baseline = baseline;
  }

  getCurrentGrade(): number {
    return this.current;
  }

  getBaselineGrade(): number {
    return this.baseline;
  }

  gradeNotLowerThanBaseline(): boolean {
    return this.current >= this.baseline;
  }
}

/**
 * Default debt ledger provider.
 */
export class DefaultDebtLedgerProvider implements DebtLedgerProvider {
  private recorded: boolean;
  private entryCount: number;

  constructor(recorded = true, entryCount = 0) {
    this.recorded = recorded;
    this.entryCount = entryCount;
  }

  isLedgerRecorded(): boolean {
    return this.recorded;
  }

  getEntryCount(): number {
    return this.entryCount;
  }
}

// ─── Before-Merge Stage ─────────────────────────────────────────

export interface BeforeMergeStageOptions {
  featureFlagChecker?: FeatureFlagChecker;
  qualityGateProvider?: QualityGateProvider;
  testResultProvider?: TestResultProvider;
  guiAcceptanceProvider?: GUIAcceptanceProvider;
  dependencyAuditProvider?: DependencyAuditProvider;
  readinessGradeProvider?: ReadinessGradeProvider;
  debtLedgerProvider?: DebtLedgerProvider;
}

export class BeforeMergeStage implements VerificationStage {
  readonly name: StageName = 'before-merge';
  readonly score = 5;

  private featureFlagChecker: FeatureFlagChecker;
  private qualityGateProvider: QualityGateProvider;
  private testResultProvider: TestResultProvider;
  private guiAcceptanceProvider: GUIAcceptanceProvider;
  private dependencyAuditProvider: DependencyAuditProvider;
  private readinessGradeProvider: ReadinessGradeProvider;
  private debtLedgerProvider: DebtLedgerProvider;

  constructor(options?: BeforeMergeStageOptions) {
    this.featureFlagChecker = options?.featureFlagChecker ?? new DefaultFeatureFlagChecker();
    this.qualityGateProvider = options?.qualityGateProvider ?? new DefaultQualityGateProvider();
    this.testResultProvider = options?.testResultProvider ?? new DefaultTestResultProvider();
    this.guiAcceptanceProvider = options?.guiAcceptanceProvider ?? new DefaultGUIAcceptanceProvider();
    this.dependencyAuditProvider = options?.dependencyAuditProvider ?? new DefaultDependencyAuditProvider();
    this.readinessGradeProvider = options?.readinessGradeProvider ?? new DefaultReadinessGradeProvider();
    this.debtLedgerProvider = options?.debtLedgerProvider ?? new DefaultDebtLedgerProvider();
  }

  /**
   * Execute the before-merge gateway stage.
   *
   * If the `before_merge_gateway` feature flag is disabled, passes immediately (no-op).
   * Aggregates all quality signals into a checklist and fails closed on internal errors.
   * Produces human-readable summary with pass/fail per item and remediation guidance.
   */
  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();

    // Check feature flag — if disabled, pass immediately (no-op)
    if (!this.featureFlagChecker.isEnabled('before_merge_gateway')) {
      return {
        stageName: this.name,
        passed: true,
        diagnostics: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Fail closed: wrap entire checklist evaluation in try/catch
    try {
      const summary = this.evaluateChecklist();
      const diagnostics = this.summaryToDiagnostics(summary, edit);

      return {
        stageName: this.name,
        passed: summary.passed,
        diagnostics,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      // Fail closed on internal errors — block task completion
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        stageName: this.name,
        passed: false,
        diagnostics: [
          {
            file: '',
            line: 0,
            column: 0,
            message: `[before-merge] INTERNAL ERROR: Gateway failed closed due to: ${errorMessage}. Task completion blocked until resolved.`,
            severity: 'error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Evaluate the full checklist and produce a human-readable summary.
   * Exposed for testing.
   */
  evaluateChecklist(): MergeGatewaySummary {
    const items: ChecklistItem[] = [];

    // 1. All quality gates green
    const qualityGatesPassed = this.qualityGateProvider.allGatesPassed();
    const failingGates = this.qualityGateProvider.getFailingGates();
    items.push({
      name: 'All Quality Gates Green',
      passed: qualityGatesPassed,
      message: qualityGatesPassed
        ? 'All quality gates passed.'
        : `Quality gates failed: ${failingGates.join(', ')}.`,
      remediation: qualityGatesPassed
        ? undefined
        : `Fix the failing quality gates (${failingGates.join(', ')}) and re-run the pipeline.`,
    });

    // 2. All tests green
    const testsPassed = this.testResultProvider.allTestsPassed();
    const failingTestCount = this.testResultProvider.getFailingTestCount();
    items.push({
      name: 'All Tests Green',
      passed: testsPassed,
      message: testsPassed
        ? 'All tests passed.'
        : `${failingTestCount} test(s) failing.`,
      remediation: testsPassed
        ? undefined
        : `Fix the ${failingTestCount} failing test(s) and re-run. Check test output for specific failures.`,
    });

    // 3. GUI acceptance green (auto-pass for non-UI tasks)
    const isUI = this.guiAcceptanceProvider.isUITouchingTask();
    const guiPassed = this.guiAcceptanceProvider.guiAcceptancePassed();
    const failingCriteria = this.guiAcceptanceProvider.getFailingCriteria();
    items.push({
      name: 'GUI Acceptance Green',
      passed: guiPassed,
      message: !isUI
        ? 'Auto-passed (non-UI task).'
        : guiPassed
          ? 'All GUI acceptance criteria passed.'
          : `GUI acceptance failed: ${failingCriteria.join('; ')}.`,
      remediation: guiPassed
        ? undefined
        : `Fix the failing GUI acceptance criteria: ${failingCriteria.join('; ')}. Ensure the DOM state matches expected outcomes.`,
    });

    // 4. No unaudited dependencies
    const noUnaudited = this.dependencyAuditProvider.noUnauditedDeps();
    const unauditedDeps = this.dependencyAuditProvider.getUnauditedDeps();
    items.push({
      name: 'No Unaudited Dependencies',
      passed: noUnaudited,
      message: noUnaudited
        ? 'No unaudited dependencies.'
        : `Unaudited dependencies found: ${unauditedDeps.join(', ')}.`,
      remediation: noUnaudited
        ? undefined
        : `Audit the following dependencies before merging: ${unauditedDeps.join(', ')}. Run the dependency audit tool or review manually.`,
    });

    // 5. Readiness grade not lower than baseline
    const gradeOk = this.readinessGradeProvider.gradeNotLowerThanBaseline();
    const currentGrade = this.readinessGradeProvider.getCurrentGrade();
    const baselineGrade = this.readinessGradeProvider.getBaselineGrade();
    items.push({
      name: 'Readiness Grade Not Lower Than Baseline',
      passed: gradeOk,
      message: gradeOk
        ? `Readiness grade (${currentGrade}) meets or exceeds baseline (${baselineGrade}).`
        : `Readiness grade dropped from ${baselineGrade} to ${currentGrade}.`,
      remediation: gradeOk
        ? undefined
        : `Improve the readiness grade back to at least ${baselineGrade}. Check individual dimensions (test coverage, E2E pass rate, accessibility, docs freshness, ADR presence, dependency audit age, bloat score) for degradation.`,
    });

    // 6. Debt ledger entries recorded (zero entries is valid)
    const ledgerOk = this.debtLedgerProvider.isLedgerRecorded();
    const entryCount = this.debtLedgerProvider.getEntryCount();
    items.push({
      name: 'Debt Ledger Recorded',
      passed: ledgerOk,
      message: ledgerOk
        ? `Debt ledger is recorded (${entryCount} entries).`
        : 'Debt ledger is not accessible or not properly recorded.',
      remediation: ledgerOk
        ? undefined
        : 'Ensure the debt ledger file (.neuronest/memory/lean-debt.json) is accessible and properly formatted. Re-run the verifier reconciliation pass.',
    });

    const passed = items.every((item) => item.passed);
    const summaryText = this.buildSummaryText(items, passed);

    return { passed, items, summaryText };
  }

  /**
   * Build a human-readable summary text for display.
   */
  private buildSummaryText(items: ChecklistItem[], passed: boolean): string {
    const header = passed
      ? '✅ Before-Merge Gateway: ALL CHECKS PASSED'
      : '❌ Before-Merge Gateway: BLOCKED — failing checks detected';

    const lines = items.map((item) => {
      const icon = item.passed ? '✅' : '❌';
      let line = `  ${icon} ${item.name}: ${item.message}`;
      if (!item.passed && item.remediation) {
        line += `\n     → Remediation: ${item.remediation}`;
      }
      return line;
    });

    return `${header}\n\n${lines.join('\n')}`;
  }

  /**
   * Convert a summary into diagnostics for the StageResult.
   */
  private summaryToDiagnostics(summary: MergeGatewaySummary, edit: AgentEdit): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    // Add individual item diagnostics for failing checks
    for (const item of summary.items) {
      if (!item.passed) {
        diagnostics.push({
          file: edit.changes[0]?.filePath ?? '',
          line: 0,
          column: 0,
          message: `[before-merge] ${item.name}: ${item.message}${item.remediation ? ` Remediation: ${item.remediation}` : ''}`,
          severity: 'error',
        });
      }
    }

    // Add the full summary as an info diagnostic (for human readability)
    const summaryFile = edit.changes[0]?.filePath ?? '';
    if (summary.passed) {
      diagnostics.push({
        file: summaryFile,
        line: 0,
        column: 0,
        message: `[before-merge] ${summary.summaryText.split('\n')[0]}`,
        severity: 'warning',
      });
    }

    return diagnostics;
  }
}
