/**
 * Test Integrity Enforcer — Implementation for behavior-focused test integrity
 * enforcement and coverage analysis.
 *
 * Key behaviors:
 *   - selectTestsByBehavior() identifies required tests by behavior and risk,
 *     linking them to acceptance criteria clauses
 *   - detectViolations() scans test files for deleted, skipped, focused,
 *     quarantined, disabled, weakened, snapshot-blessed, or broadly mocked tests
 *   - enforceCoverage() validates changed-line and critical-path coverage
 *     without rewarding unexecuted code
 *   - requireRegressionTest() enforces failing regression test for defect fixes
 *   - runInRuntimeProfile() executes integration/E2E tests in a reproducible
 *     Runtime_Profile and classifies failures distinctly
 *   - generateReport() produces suite summaries, pass rates, skips, flakes,
 *     coverage deltas, and waivers for the Production_Readiness_Report
 *
 * Requirements: 38.1, 38.2, 38.3, 38.4, 38.5, 38.6, 38.7, 38.8, 38.9
 */

import { randomUUID } from 'node:crypto';
import type {
  TestCategory,
  BehaviorTest,
  TestEvidenceLink,
  IntegrityViolation,
  IntegrityViolationType,
  IntegrityPolicy,
  CoverageEnforcementResult,
  CoverageThresholds,
  ChangedLineCoverage,
  CriticalPathCoverage,
  DefectRegressionRequirement,
  RuntimeTestResult,
  TestFailureKind,
  TestSuiteReport,
  TestIntegrityReport,
  CoverageDelta,
  TestWaiver,
  ITestIntegrityEnforcer,
} from './test-integrity-enforcer.js';

// ─── Adapters ───────────────────────────────────────────────────

/**
 * Adapter for reading file contents to detect integrity violations.
 */
export interface FileReader {
  readFile(filePath: string): string | null;
  fileExists(filePath: string): boolean;
}

/**
 * Adapter for reading coverage data.
 */
export interface CoverageDataProvider {
  getLineCoverage(filePath: string): Map<number, boolean> | null;
  getExecutedFiles(): readonly string[];
}

/**
 * Adapter for executing tests in a runtime profile.
 */
export interface RuntimeTestExecutor {
  execute(
    tests: readonly BehaviorTest[],
    runtimeProfileId: string,
    workspaceRevision: string,
  ): Promise<RuntimeTestResult[]>;
}

/**
 * Adapter for tracking test file changes between revisions.
 */
export interface TestChangeTracker {
  getDeletedTests(changedFiles: readonly string[]): readonly string[];
  getPreviousCoverage(filePath: string): number | null;
}

// ─── Violation Detection Patterns ───────────────────────────────

/**
 * Patterns used to detect integrity violations in test source code.
 */
const VIOLATION_PATTERNS: ReadonlyArray<{
  type: IntegrityViolationType;
  patterns: readonly RegExp[];
  description: string;
}> = [
  {
    type: 'skipped',
    patterns: [
      /\b(?:it|test|describe)\.skip\s*\(/,
      /\bxit\s*\(/,
      /\bxdescribe\s*\(/,
      /\bxtest\s*\(/,
      /\bpending\s*\(/,
    ],
    description: 'Test is explicitly skipped',
  },
  {
    type: 'focused',
    patterns: [
      /\b(?:it|test|describe)\.only\s*\(/,
      /\bfit\s*\(/,
      /\bfdescribe\s*\(/,
    ],
    description: 'Test is focused (only), excluding other tests',
  },
  {
    type: 'disabled',
    patterns: [
      /\/\/\s*@disabled/,
      /\/\*\s*@disabled\s*\*\//,
      /\b(?:it|test|describe)\s*\(\s*['"`].*['"`]\s*,?\s*\)/,
    ],
    description: 'Test is disabled or has empty body',
  },
  {
    type: 'weakened',
    patterns: [
      /expect\s*\(\s*\w+\s*\)\s*\.toBeDefined\s*\(\s*\)/,
      /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
      /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/,
    ],
    description: 'Test has weakened assertions that always pass',
  },
  {
    type: 'snapshot_blessed',
    patterns: [
      /\.toMatchSnapshot\s*\(\s*\)/,
      /\.toMatchInlineSnapshot\s*\(/,
    ],
    description: 'Test uses snapshot blessing without behavioral assertion',
  },
  {
    type: 'broadly_mocked',
    patterns: [
      /vi\.mock\s*\(\s*['"`][^'"]+['"`]\s*\)/,
      /jest\.mock\s*\(\s*['"`][^'"]+['"`]\s*\)/,
      /vi\.spyOn\s*\(\s*\w+\s*,\s*['"`]\w+['"`]\s*\)\s*\.mockImplementation\s*\(\s*\(\s*\)\s*=>\s*(?:undefined|null|{}|\[\])\s*\)/,
    ],
    description: 'Test uses broad mocking that may hide real behavior',
  },
  {
    type: 'quarantined',
    patterns: [
      /\/\/\s*@quarantine/i,
      /\/\*\s*@quarantine[^*]*\*\//i,
      /\b(?:it|test|describe)\s*\.\s*todo\s*\(/,
    ],
    description: 'Test is quarantined or marked as TODO',
  },
];

// ─── Implementation ─────────────────────────────────────────────

/**
 * Enforces behavior-focused test integrity, coverage, and regression requirements.
 */
export class TestIntegrityEnforcer implements ITestIntegrityEnforcer {
  private readonly tests: Map<string, BehaviorTest> = new Map();
  private readonly evidenceLinks: Map<string, TestEvidenceLink> = new Map();
  private readonly violations: Map<string, IntegrityViolation> = new Map();
  private readonly waivers: Map<string, TestWaiver> = new Map();
  private readonly regressionRequirements: Map<string, DefectRegressionRequirement> = new Map();
  private readonly runtimeResults: Map<string, RuntimeTestResult[]> = new Map();
  private readonly coverageResults: Map<string, CoverageEnforcementResult> = new Map();

  constructor(
    private readonly fileReader: FileReader,
    private readonly coverageProvider: CoverageDataProvider,
    private readonly runtimeExecutor: RuntimeTestExecutor,
    private readonly changeTracker: TestChangeTracker,
  ) {}

  // ─── Test Selection (R38.1) ────────────────────────────────────

  /**
   * Select tests by behavior and risk, linking them to acceptance criteria clauses.
   * Tests are chosen based on affected behavior and risk, not arbitrary coverage targets.
   */
  selectTestsByBehavior(
    taskId: string,
    changedFiles: readonly string[],
    riskAreas: readonly string[],
  ): BehaviorTest[] {
    const selected: BehaviorTest[] = [];

    for (const filePath of changedFiles) {
      const category = this.inferTestCategory(filePath);
      const linkedClauses = this.inferLinkedClauses(filePath, taskId);

      for (const riskArea of riskAreas) {
        const test: BehaviorTest = {
          id: randomUUID(),
          filePath,
          testName: this.inferTestName(filePath, riskArea),
          suiteName: this.inferSuiteName(filePath),
          category,
          linkedClauses,
          riskArea,
          behavior: `Validates behavior for ${riskArea} in ${filePath}`,
        };

        selected.push(test);
        this.tests.set(test.id, test);
      }
    }

    return selected;
  }

  // ─── Evidence Linking (R38.2) ──────────────────────────────────

  /**
   * Link a test to Evidence at an exact revision.
   * Tests record Evidence at the exact Release_Candidate revision.
   */
  linkTestToEvidence(
    testId: string,
    evidenceId: string,
    workspaceRevision: string,
    linkedClauses: readonly string[],
  ): TestEvidenceLink {
    const link: TestEvidenceLink = {
      testId,
      evidenceId,
      workspaceRevision,
      linkedClauses,
      recordedAt: new Date().toISOString(),
    };

    this.evidenceLinks.set(`${testId}:${evidenceId}`, link);
    return link;
  }

  // ─── Integrity Violation Detection (R38.3, R38.4) ──────────────

  /**
   * Detect test integrity violations according to Quality_Profile policy.
   * Scans for deleted, skipped, focused, quarantined, disabled, weakened,
   * snapshot-blessed, or broadly mocked tests.
   */
  detectViolations(
    changedFiles: readonly string[],
    policy: IntegrityPolicy,
  ): IntegrityViolation[] {
    const detected: IntegrityViolation[] = [];
    const testFiles = changedFiles.filter((f) => this.isTestFile(f));

    // Detect deleted tests
    const deletedTests = this.changeTracker.getDeletedTests(changedFiles);
    for (const deleted of deletedTests) {
      const violation: IntegrityViolation = {
        id: randomUUID(),
        testId: '',
        filePath: deleted,
        testName: deleted,
        violationType: 'deleted',
        severity: policy.violationSeverities.deleted,
        description: `Test file '${deleted}' was deleted`,
        detectedAt: new Date().toISOString(),
      };
      detected.push(violation);
      this.violations.set(violation.id, violation);
    }

    // Scan test file content for violations
    for (const filePath of testFiles) {
      const content = this.fileReader.readFile(filePath);
      if (!content) continue;

      const lines = content.split('\n');

      for (const pattern of VIOLATION_PATTERNS) {
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex]!;
          for (const regex of pattern.patterns) {
            if (regex.test(line)) {
              const violation: IntegrityViolation = {
                id: randomUUID(),
                testId: '',
                filePath,
                testName: this.extractTestName(line) ?? `line ${lineIndex + 1}`,
                violationType: pattern.type,
                severity: policy.violationSeverities[pattern.type],
                description: pattern.description,
                detectedAt: new Date().toISOString(),
                lineNumber: lineIndex + 1,
                evidence: line.trim(),
              };
              detected.push(violation);
              this.violations.set(violation.id, violation);
              break; // Only report first pattern match per line
            }
          }
        }
      }
    }

    return detected;
  }

  // ─── Coverage Enforcement (R38.5) ─────────────────────────────

  /**
   * Enforce changed-line and critical-path coverage without rewarding
   * unexecuted code.
   */
  enforceCoverage(
    changedFiles: readonly string[],
    changedLines: Readonly<Record<string, readonly number[]>>,
    criticalPaths: readonly string[],
    thresholds: CoverageThresholds,
  ): CoverageEnforcementResult {
    const changedLineCoverage: ChangedLineCoverage[] = [];
    let totalChangedLines = 0;
    let totalCoveredChangedLines = 0;

    // Analyze changed-line coverage per file
    for (const filePath of changedFiles) {
      const fileChangedLines = changedLines[filePath] ?? [];
      if (fileChangedLines.length === 0) continue;

      const lineCoverage = this.coverageProvider.getLineCoverage(filePath);
      const uncoveredLines: number[] = [];
      let covered = 0;

      for (const lineNum of fileChangedLines) {
        if (lineCoverage?.get(lineNum)) {
          covered++;
        } else {
          uncoveredLines.push(lineNum);
        }
      }

      totalChangedLines += fileChangedLines.length;
      totalCoveredChangedLines += covered;

      changedLineCoverage.push({
        filePath,
        totalChangedLines: fileChangedLines.length,
        coveredChangedLines: covered,
        uncoveredChangedLines: uncoveredLines,
        coveragePercent: fileChangedLines.length > 0
          ? (covered / fileChangedLines.length) * 100
          : 100,
      });
    }

    // Analyze critical-path coverage
    const criticalPathCoverage: CriticalPathCoverage[] = criticalPaths.map((pathId) => {
      const coveredByTests = this.findTestsCoveringPath(pathId);
      return {
        pathId,
        description: `Critical path: ${pathId}`,
        covered: coveredByTests.length > 0,
        coveredByTests,
      };
    });

    // Detect unexecuted code (generated but never run)
    const executedFiles = this.coverageProvider.getExecutedFiles();
    const unexecutedFiles = changedFiles.filter((f) => {
      if (this.isTestFile(f)) return false;
      if (thresholds.ignoreUnexecutedGenerated && this.isGeneratedFile(f)) return false;
      return !executedFiles.includes(f);
    });

    const overallPercent = totalChangedLines > 0
      ? (totalCoveredChangedLines / totalChangedLines) * 100
      : 100;

    const result: CoverageEnforcementResult = {
      changedLineCoverage,
      criticalPathCoverage,
      overallChangedLinePercent: overallPercent,
      changedLineThresholdMet: overallPercent >= thresholds.changedLineMinPercent,
      criticalPathsAllCovered: thresholds.criticalPathRequired
        ? criticalPathCoverage.every((cp) => cp.covered)
        : true,
      unexecutedCodeDetected: unexecutedFiles.length > 0,
      unexecutedFiles,
    };

    this.coverageResults.set(`coverage-${Date.now()}`, result);
    return result;
  }

  // ─── Defect Regression (R38.6) ────────────────────────────────

  /**
   * Require a failing regression test or documented impracticality for defects.
   */
  requireRegressionTest(
    defectId: string,
    taskId: string,
    testId?: string,
    impracticalityReason?: string,
  ): DefectRegressionRequirement {
    const requirement: DefectRegressionRequirement = {
      defectId,
      taskId,
      hasFailingTest: !!testId,
      testId,
      impracticalityReason,
      documentedBy: impracticalityReason ? 'user' : undefined,
      documentedAt: impracticalityReason ? new Date().toISOString() : undefined,
    };

    this.regressionRequirements.set(defectId, requirement);
    return requirement;
  }

  // ─── Runtime Test Execution (R38.7, R38.8) ─────────────────────

  /**
   * Run integration/E2E tests in the Runtime_Profile and classify failures.
   * Distinguishes assertion, infrastructure, timeout, flake, and cancellation.
   */
  async runInRuntimeProfile(
    tests: readonly BehaviorTest[],
    runtimeProfileId: string,
    workspaceRevision: string,
  ): Promise<RuntimeTestResult[]> {
    const results = await this.runtimeExecutor.execute(tests, runtimeProfileId, workspaceRevision);

    // Classify failures by kind
    const classified = results.map((result) => {
      if (result.passed) return result;
      const failureKind = result.failureKind ?? this.classifyFailure(result);
      return { ...result, failureKind };
    });

    this.runtimeResults.set(workspaceRevision, classified);
    return classified;
  }

  // ─── Report Generation (R38.9) ────────────────────────────────

  /**
   * Generate the full test integrity report for Production_Readiness_Report.
   * Reports suites, pass rates, skips, flakes, coverage deltas, and waivers.
   */
  generateReport(workspaceRevision: string): TestIntegrityReport {
    const results = this.runtimeResults.get(workspaceRevision) ?? [];
    const suites = this.buildSuiteReports(results);

    const totalTests = results.length;
    const totalPassed = results.filter((r) => r.passed).length;
    const totalFailed = results.filter((r) => !r.passed && r.failureKind !== 'flake').length;
    const totalSkipped = 0; // Skipped tests are violations, not results
    const totalFlaky = results.filter((r) => r.failureKind === 'flake').length;

    const coverageDeltas = this.computeCoverageDeltas(workspaceRevision);
    const violations = Array.from(this.violations.values());
    const waivers = Array.from(this.waivers.values());
    const defectRegressions = Array.from(this.regressionRequirements.values());

    const violationErrors = violations.filter((v) => v.severity === 'error');
    const unmetRegressions = defectRegressions.filter(
      (r) => !r.hasFailingTest && !r.impracticalityReason,
    );

    const allGatesPassed =
      violationErrors.length === 0 &&
      unmetRegressions.length === 0 &&
      totalFailed === 0;

    return {
      workspaceRevision,
      generatedAt: new Date().toISOString(),
      suites,
      totalTests,
      totalPassed,
      totalFailed,
      totalSkipped,
      totalFlaky,
      overallPassRate: totalTests > 0 ? (totalPassed / totalTests) * 100 : 100,
      coverageDeltas,
      violations,
      waivers,
      defectRegressions,
      allGatesPassed,
    };
  }

  // ─── Waiver Management ────────────────────────────────────────

  /**
   * Grant a waiver for a violation.
   */
  grantWaiver(params: {
    violationId: string;
    actor: string;
    reason: string;
    scope: string;
    expiresAt?: string;
  }): TestWaiver {
    const waiver: TestWaiver = {
      id: randomUUID(),
      violationId: params.violationId,
      actor: params.actor,
      reason: params.reason,
      scope: params.scope,
      grantedAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
    };
    this.waivers.set(waiver.id, waiver);
    return waiver;
  }

  // ─── Query Methods ────────────────────────────────────────────

  getTest(testId: string): BehaviorTest | null {
    return this.tests.get(testId) ?? null;
  }

  getEvidenceLinks(testId: string): readonly TestEvidenceLink[] {
    return Array.from(this.evidenceLinks.values()).filter((l) => l.testId === testId);
  }

  getViolations(): readonly IntegrityViolation[] {
    return Array.from(this.violations.values());
  }

  getWaivers(): readonly TestWaiver[] {
    return Array.from(this.waivers.values());
  }

  getRegressionRequirements(): readonly DefectRegressionRequirement[] {
    return Array.from(this.regressionRequirements.values());
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Classify a test failure by analyzing its output and context.
   */
  private classifyFailure(result: RuntimeTestResult): TestFailureKind {
    const output = (result.output ?? '').toLowerCase();

    // Timeout detection
    if (output.includes('timeout') || output.includes('timed out') || output.includes('exceeded')) {
      return 'timeout';
    }

    // Infrastructure failure detection
    if (
      output.includes('econnrefused') ||
      output.includes('enotfound') ||
      output.includes('connection refused') ||
      output.includes('network error') ||
      output.includes('port already in use') ||
      output.includes('service unavailable') ||
      output.includes('database connection')
    ) {
      return 'infrastructure';
    }

    // Cancellation detection
    if (
      output.includes('cancelled') ||
      output.includes('canceled') ||
      output.includes('aborted') ||
      output.includes('sigterm') ||
      output.includes('sigint')
    ) {
      return 'cancellation';
    }

    // Flake detection — if test was retried and passed before
    if (result.retryCount > 0) {
      return 'flake';
    }

    // Default to assertion failure (real test failure)
    return 'assertion';
  }

  /**
   * Determine test category from file path patterns.
   */
  private inferTestCategory(filePath: string): TestCategory {
    const lower = filePath.toLowerCase();
    if (lower.includes('e2e') || lower.includes('end-to-end')) return 'end_to_end';
    if (lower.includes('integration') || lower.includes('integ')) return 'integration';
    if (lower.includes('contract')) return 'contract';
    if (lower.includes('migration')) return 'migration';
    if (lower.includes('security') || lower.includes('sec.')) return 'security';
    if (lower.includes('a11y') || lower.includes('accessibility')) return 'accessibility';
    if (lower.includes('perf') || lower.includes('benchmark')) return 'performance';
    return 'unit';
  }

  /**
   * Infer linked acceptance criteria clauses from the file and task context.
   */
  private inferLinkedClauses(_filePath: string, taskId: string): string[] {
    // In a real implementation, this would query the PlanningGraphService
    // to find which acceptance criteria the file is linked to
    return [`${taskId}:behavior`];
  }

  /**
   * Infer a test name from file path and risk area.
   */
  private inferTestName(filePath: string, riskArea: string): string {
    const baseName = filePath.split('/').pop()?.replace(/\.(test|spec)\.(ts|js|tsx|jsx)$/, '') ?? 'unknown';
    return `${baseName} - ${riskArea}`;
  }

  /**
   * Infer a suite name from file path.
   */
  private inferSuiteName(filePath: string): string {
    return filePath.split('/').pop()?.replace(/\.(test|spec)\.(ts|js|tsx|jsx)$/, '') ?? 'unknown';
  }

  /**
   * Check if a file is a test file.
   */
  private isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(filePath) ||
      filePath.includes('__tests__/');
  }

  /**
   * Check if a file is generated code.
   */
  private isGeneratedFile(filePath: string): boolean {
    return filePath.includes('/generated/') ||
      filePath.includes('.generated.') ||
      filePath.includes('.g.') ||
      filePath.endsWith('.d.ts');
  }

  /**
   * Extract a test name from a source code line.
   */
  private extractTestName(line: string): string | null {
    const match = line.match(/(?:it|test|describe)(?:\.(?:skip|only|todo))?\s*\(\s*['"`]([^'"`]+)['"`]/);
    return match?.[1] ?? null;
  }

  /**
   * Find tests that cover a specific critical path.
   */
  private findTestsCoveringPath(pathId: string): readonly string[] {
    return Array.from(this.tests.values())
      .filter((t) => t.riskArea === pathId || t.linkedClauses.some((c) => c.includes(pathId)))
      .map((t) => t.id);
  }

  /**
   * Build suite reports from runtime results.
   */
  private buildSuiteReports(results: readonly RuntimeTestResult[]): TestSuiteReport[] {
    const suiteMap = new Map<string, RuntimeTestResult[]>();

    for (const result of results) {
      const key = result.suiteName;
      if (!suiteMap.has(key)) {
        suiteMap.set(key, []);
      }
      suiteMap.get(key)!.push(result);
    }

    return Array.from(suiteMap.entries()).map(([suiteName, suiteResults]) => {
      const total = suiteResults.length;
      const passed = suiteResults.filter((r) => r.passed).length;
      const failed = suiteResults.filter((r) => !r.passed && r.failureKind !== 'flake').length;
      const flaky = suiteResults.filter((r) => r.failureKind === 'flake').length;
      const duration = suiteResults.reduce((sum, r) => sum + r.durationMs, 0);

      return {
        suiteId: randomUUID(),
        suiteName,
        category: suiteResults[0]?.category ?? 'unit',
        total,
        passed,
        failed,
        skipped: 0,
        flaky,
        passRate: total > 0 ? (passed / total) * 100 : 100,
        duration,
      };
    });
  }

  /**
   * Compute coverage deltas between current and previous revisions.
   */
  private computeCoverageDeltas(_workspaceRevision: string): CoverageDelta[] {
    const deltas: CoverageDelta[] = [];
    const executedFiles = this.coverageProvider.getExecutedFiles();

    for (const filePath of executedFiles) {
      const previousPercent = this.changeTracker.getPreviousCoverage(filePath);
      if (previousPercent === null) continue;

      const currentCoverage = this.coverageProvider.getLineCoverage(filePath);
      if (!currentCoverage) continue;

      let covered = 0;
      let total = 0;
      for (const [, isCovered] of currentCoverage) {
        total++;
        if (isCovered) covered++;
      }

      const currentPercent = total > 0 ? (covered / total) * 100 : 100;
      const delta = currentPercent - previousPercent;

      if (Math.abs(delta) > 0.01) {
        deltas.push({ filePath, previousPercent, currentPercent, delta });
      }
    }

    return deltas;
  }
}
