/**
 * Production Readiness Gate — Non-bypassable exit gate before task completion.
 *
 * Verifies all production readiness conditions are met:
 * - All verification stages green (including security)
 * - Dependency scan clean
 * - Coverage threshold met
 * - Zero unresolved critical/high findings in SecurityEvidenceStore
 *
 * On failure: routes failing condition back to the self-healing loop for remediation.
 * Non-bypassable: no configuration or flag can skip it for production-targeted tasks.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5
 */

import type {
  AgentEdit,
  ProjectContext,
  VerificationResult,
} from './verification-gate/types';
import type { SelfHealingResult, RepairAgent, VerificationRunner } from './self-healing-loop';
import { runSelfHealingLoop } from './self-healing-loop';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * Represents a single gate condition check result.
 */
export interface GateCondition {
  /** Human-readable name of the condition */
  name: string;
  /** Whether this condition passed */
  passed: boolean;
  /** Detail describing the check result (success or failure reason) */
  detail: string;
}

/**
 * Result of running the production readiness gate.
 */
export interface ProductionReadinessResult {
  /** Whether all gate conditions passed */
  passed: boolean;
  /** All conditions checked with their individual results */
  conditions: GateCondition[];
  /** Human-readable summary of failures and resolution guidance (only when failed) */
  failureSummary?: string;
}

/**
 * Interface for the verification pipeline used to check all stages.
 */
export interface VerificationPipelineRunner {
  run(edit: AgentEdit, context: ProjectContext): Promise<VerificationResult>;
}

/**
 * Interface for dependency scanning.
 */
export interface DependencyScanResult {
  clean: boolean;
  vulnerabilities: Array<{
    package: string;
    severity: string;
    description: string;
  }>;
}

export interface DependencyScanner {
  scan(projectDir: string): Promise<DependencyScanResult>;
}

/**
 * Interface for code coverage checking.
 */
export interface CoverageResult {
  met: boolean;
  actual: number;
  threshold: number;
}

export interface CoverageChecker {
  check(projectDir: string): Promise<CoverageResult>;
}

/**
 * Interface for querying unresolved security findings.
 */
export interface SecurityFindingsQuery {
  getUnresolvedCriticalHighFindings(sessionId: string): Array<{
    id: string;
    severity: string;
    category: string;
    message: string;
    file: string;
  }>;
}

/**
 * Configuration for the production readiness gate.
 * Note: There is intentionally NO option to bypass the gate for production-targeted tasks.
 * The gate is non-bypassable by design (Requirement 16.3).
 */
export interface ProductionReadinessGateConfig {
  /** Coverage threshold percentage (default: 80) */
  coverageThreshold: number;
  /** Maximum repair attempts when routing failures to self-healing loop */
  maxRepairAttempts: number;
  /** Token budget for self-healing repairs */
  repairTokenBudget: number;
}

const DEFAULT_CONFIG: ProductionReadinessGateConfig = {
  coverageThreshold: 80,
  maxRepairAttempts: 3,
  repairTokenBudget: 50_000,
};

// ─── Production Readiness Gate ──────────────────────────────────

/**
 * Non-bypassable exit gate that runs before a task is marked as completed.
 *
 * Requirement 16.1: Verifies all verification stages green (including security),
 *   dependency scan clean, coverage threshold met, zero unresolved critical/high findings.
 * Requirement 16.2: On failure, routes failing condition to self-healing loop.
 * Requirement 16.3: Non-bypassable — no config/flag can skip for production-targeted tasks.
 * Requirement 16.4: Integrates with existing readiness/SRE services.
 * Requirement 16.5: Provides clear summary of failures and resolution guidance.
 */
export class ProductionReadinessGate {
  private readonly config: ProductionReadinessGateConfig;

  constructor(
    private readonly verificationPipeline: VerificationPipelineRunner,
    private readonly dependencyScanner: DependencyScanner,
    private readonly coverageChecker: CoverageChecker,
    private readonly securityFindings: SecurityFindingsQuery,
    config?: Partial<ProductionReadinessGateConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run all gate checks for a task. Cannot be skipped via configuration.
   *
   * This method is intentionally non-configurable for skip behavior.
   * The gate ALWAYS runs for production-targeted tasks regardless of any
   * external flags or configuration (Requirement 16.3).
   *
   * @param taskId - The task being checked for production readiness
   * @param edit - The agent edit to verify
   * @param context - Project context for verification
   * @param sessionId - Session ID for querying security findings
   */
  async check(
    _taskId: string,
    edit: AgentEdit,
    context: ProjectContext,
    sessionId: string,
  ): Promise<ProductionReadinessResult> {
    const conditions: GateCondition[] = [];

    // 1. Check all verification stages (including security)
    const verificationCondition = await this.checkVerificationStages(edit, context);
    conditions.push(verificationCondition);

    // 2. Check dependency scan
    const dependencyCondition = await this.checkDependencyScan(context.rootDir);
    conditions.push(dependencyCondition);

    // 3. Check coverage threshold
    const coverageCondition = await this.checkCoverageThreshold(context.rootDir);
    conditions.push(coverageCondition);

    // 4. Check unresolved critical/high security findings
    const securityCondition = this.checkSecurityFindings(sessionId);
    conditions.push(securityCondition);

    // Determine overall pass/fail
    const passed = conditions.every((c) => c.passed);

    const result: ProductionReadinessResult = {
      passed,
      conditions,
    };

    // Build failure summary with resolution guidance (Requirement 16.5)
    if (!passed) {
      result.failureSummary = this.buildFailureSummary(conditions);
    }

    return result;
  }

  /**
   * Check gate and route failures to the self-healing loop for automated repair.
   * Returns the gate result after repair attempts (if any were needed).
   *
   * Requirement 16.2: On failure, routes failing condition back to self-healing loop.
   */
  async checkAndRemediate(
    taskId: string,
    edit: AgentEdit,
    context: ProjectContext,
    sessionId: string,
    repairAgent: RepairAgent,
    verifier: VerificationRunner,
  ): Promise<{ gateResult: ProductionReadinessResult; repairResult?: SelfHealingResult }> {
    const gateResult = await this.check(taskId, edit, context, sessionId);

    if (gateResult.passed) {
      return { gateResult };
    }

    // Route failures to self-healing loop (Requirement 16.2)
    // Build a synthetic verification result from the failing conditions
    const verificationResult = this.buildVerificationResultFromConditions(gateResult.conditions);

    const repairResult = await runSelfHealingLoop(
      edit,
      verificationResult,
      repairAgent,
      verifier,
      context,
      {
        maxAttempts: this.config.maxRepairAttempts,
        tokenBudget: this.config.repairTokenBudget,
        feedbackFormat: 'structured',
      },
    );

    // Re-check the gate after repair
    if (repairResult.accepted && repairResult.finalEdit) {
      const postRepairResult = await this.check(taskId, repairResult.finalEdit, context, sessionId);
      return { gateResult: postRepairResult, repairResult };
    }

    return { gateResult, repairResult };
  }

  // ─── Individual Condition Checks ────────────────────────────────

  /**
   * Checks that all verification stages pass (syntax, typecheck, lint, security, test, smoke).
   */
  private async checkVerificationStages(
    edit: AgentEdit,
    context: ProjectContext,
  ): Promise<GateCondition> {
    try {
      const result = await this.verificationPipeline.run(edit, context);

      if (result.accepted) {
        return {
          name: 'verification-stages',
          passed: true,
          detail: `All verification stages passed (score: ${result.totalScore}/${result.maxScore})`,
        };
      }

      const failedStages = result.stages
        .filter((s) => !s.passed)
        .map((s) => s.stageName);

      return {
        name: 'verification-stages',
        passed: false,
        detail: `Verification failed at stage(s): ${failedStages.join(', ')}. Fix all ${failedStages[0]} issues before proceeding.`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: 'verification-stages',
        passed: false,
        detail: `Verification pipeline error: ${message}`,
      };
    }
  }

  /**
   * Checks that the dependency scan reports no known vulnerabilities.
   */
  private async checkDependencyScan(projectDir: string): Promise<GateCondition> {
    try {
      const result = await this.dependencyScanner.scan(projectDir);

      if (result.clean) {
        return {
          name: 'dependency-scan',
          passed: true,
          detail: 'Dependency scan clean — no known vulnerabilities',
        };
      }

      const highSeverity = result.vulnerabilities.filter(
        (v) => v.severity === 'critical' || v.severity === 'high',
      );

      return {
        name: 'dependency-scan',
        passed: false,
        detail: `Dependency scan found ${result.vulnerabilities.length} vulnerabilities (${highSeverity.length} critical/high). Update affected packages: ${highSeverity.map((v) => v.package).join(', ') || result.vulnerabilities.map((v) => v.package).join(', ')}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: 'dependency-scan',
        passed: false,
        detail: `Dependency scan error: ${message}`,
      };
    }
  }

  /**
   * Checks that code coverage meets the configured threshold.
   */
  private async checkCoverageThreshold(projectDir: string): Promise<GateCondition> {
    try {
      const result = await this.coverageChecker.check(projectDir);

      if (result.met) {
        return {
          name: 'coverage-threshold',
          passed: true,
          detail: `Coverage ${result.actual}% meets threshold ${result.threshold}%`,
        };
      }

      return {
        name: 'coverage-threshold',
        passed: false,
        detail: `Coverage ${result.actual}% is below threshold ${result.threshold}%. Add tests to reach at least ${result.threshold}% coverage.`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: 'coverage-threshold',
        passed: false,
        detail: `Coverage check error: ${message}`,
      };
    }
  }

  /**
   * Checks that there are zero unresolved critical/high findings in SecurityEvidenceStore.
   */
  private checkSecurityFindings(sessionId: string): GateCondition {
    try {
      const findings = this.securityFindings.getUnresolvedCriticalHighFindings(sessionId);

      if (findings.length === 0) {
        return {
          name: 'security-findings',
          passed: true,
          detail: 'Zero unresolved critical/high security findings',
        };
      }

      const summary = findings
        .slice(0, 5)
        .map((f) => `${f.severity}: ${f.category} in ${f.file}`)
        .join('; ');

      const suffix = findings.length > 5 ? ` (and ${findings.length - 5} more)` : '';

      return {
        name: 'security-findings',
        passed: false,
        detail: `${findings.length} unresolved critical/high security findings: ${summary}${suffix}. Resolve all findings before marking task complete.`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: 'security-findings',
        passed: false,
        detail: `Security findings check error: ${message}`,
      };
    }
  }

  // ─── Helper Methods ─────────────────────────────────────────────

  /**
   * Builds a human-readable summary of all failures with resolution guidance.
   * Requirement 16.5: Provide clear summary of failures and resolution guidance.
   */
  private buildFailureSummary(conditions: GateCondition[]): string {
    const failures = conditions.filter((c) => !c.passed);

    if (failures.length === 0) {
      return '';
    }

    const lines = [
      `Production readiness gate blocked: ${failures.length} condition(s) failed.`,
      '',
      ...failures.map((f, i) => `${i + 1}. [${f.name}] ${f.detail}`),
      '',
      'Resolution guidance:',
    ];

    for (const failure of failures) {
      switch (failure.name) {
        case 'verification-stages':
          lines.push('  • Fix all verification stage failures. The self-healing loop will attempt automated repair.');
          break;
        case 'dependency-scan':
          lines.push('  • Update vulnerable dependencies to their fixed versions. Run `npm audit fix` or manually bump affected packages.');
          break;
        case 'coverage-threshold':
          lines.push('  • Add unit tests for uncovered code paths to meet the coverage threshold.');
          break;
        case 'security-findings':
          lines.push('  • Resolve all critical/high security findings. Apply recommended remediations or use the deterministic fixer.');
          break;
        default:
          lines.push(`  • Address the ${failure.name} failure as described above.`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Builds a synthetic VerificationResult from gate conditions to feed
   * into the self-healing loop.
   */
  private buildVerificationResultFromConditions(conditions: GateCondition[]): VerificationResult {
    const diagnostics = conditions
      .filter((c) => !c.passed)
      .map((c) => ({
        file: '',
        line: 1,
        column: 0,
        message: `[${c.name}] ${c.detail}`,
        severity: 'error' as const,
      }));

    return {
      totalScore: 0,
      maxScore: 18,
      stages: [
        {
          stageName: 'security',
          passed: false,
          diagnostics,
          durationMs: 0,
        },
      ],
      accepted: false,
      failedAt: 'security',
      totalDurationMs: 0,
    };
  }
}
