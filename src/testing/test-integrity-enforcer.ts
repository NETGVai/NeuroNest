/**
 * Test Integrity Enforcer — Interfaces and types for behavior-focused test
 * integrity enforcement and coverage analysis.
 *
 * Ensures tests are meaningful, behavior-focused, correctly classified,
 * and produce useful coverage metrics linked to exact requirement clauses
 * and revision Evidence.
 *
 * Requirements: 38.1, 38.2, 38.3, 38.4, 38.5, 38.6, 38.7, 38.8, 38.9
 */

// ─── Test Classification ────────────────────────────────────────

/**
 * Categories of tests selected by behavior and risk.
 * Requirement 38.1
 */
export type TestCategory =
  | 'unit'
  | 'integration'
  | 'contract'
  | 'end_to_end'
  | 'migration'
  | 'security'
  | 'accessibility'
  | 'performance';

/**
 * A test linked to specific acceptance criteria and risk areas.
 * Requirement 38.1, 38.2
 */
export interface BehaviorTest {
  readonly id: string;
  readonly filePath: string;
  readonly testName: string;
  readonly suiteName: string;
  readonly category: TestCategory;
  readonly linkedClauses: readonly string[];
  readonly riskArea: string;
  readonly behavior: string;
}

/**
 * Link between a test and the Evidence it verifies at an exact revision.
 * Requirement 38.2
 */
export interface TestEvidenceLink {
  readonly testId: string;
  readonly evidenceId: string;
  readonly workspaceRevision: string;
  readonly linkedClauses: readonly string[];
  readonly recordedAt: string;
}

// ─── Integrity Violations ───────────────────────────────────────

/**
 * Types of test integrity violations detected.
 * Requirement 38.3, 38.4
 */
export type IntegrityViolationType =
  | 'deleted'
  | 'skipped'
  | 'focused'
  | 'quarantined'
  | 'disabled'
  | 'weakened'
  | 'snapshot_blessed'
  | 'broadly_mocked';

/**
 * Severity applied to each violation based on Quality_Profile policy.
 * Requirement 38.4
 */
export type ViolationSeverity = 'error' | 'warning';

/**
 * A detected test integrity violation.
 * Requirement 38.3, 38.4
 */
export interface IntegrityViolation {
  readonly id: string;
  readonly testId: string;
  readonly filePath: string;
  readonly testName: string;
  readonly violationType: IntegrityViolationType;
  readonly severity: ViolationSeverity;
  readonly description: string;
  readonly detectedAt: string;
  readonly lineNumber?: number;
  readonly evidence?: string;
}

/**
 * Policy configuration for how violations are handled.
 * Requirement 38.4
 */
export interface IntegrityPolicy {
  readonly violationSeverities: Readonly<Record<IntegrityViolationType, ViolationSeverity>>;
  readonly blockOnErrors: boolean;
  readonly requireApprovalForSkips: boolean;
}

/**
 * Default policy — focuses and skips are errors, weakened and broadly mocked are warnings.
 */
export const DEFAULT_INTEGRITY_POLICY: IntegrityPolicy = {
  violationSeverities: {
    deleted: 'error',
    skipped: 'warning',
    focused: 'error',
    quarantined: 'warning',
    disabled: 'warning',
    weakened: 'error',
    snapshot_blessed: 'warning',
    broadly_mocked: 'warning',
  },
  blockOnErrors: true,
  requireApprovalForSkips: true,
};

// ─── Coverage Analysis ──────────────────────────────────────────

/**
 * Coverage data for changed lines.
 * Requirement 38.5
 */
export interface ChangedLineCoverage {
  readonly filePath: string;
  readonly totalChangedLines: number;
  readonly coveredChangedLines: number;
  readonly uncoveredChangedLines: readonly number[];
  readonly coveragePercent: number;
}

/**
 * Coverage data for critical paths.
 * Requirement 38.5
 */
export interface CriticalPathCoverage {
  readonly pathId: string;
  readonly description: string;
  readonly covered: boolean;
  readonly coveredByTests: readonly string[];
}

/**
 * Combined coverage enforcement result.
 * Requirement 38.5
 */
export interface CoverageEnforcementResult {
  readonly changedLineCoverage: readonly ChangedLineCoverage[];
  readonly criticalPathCoverage: readonly CriticalPathCoverage[];
  readonly overallChangedLinePercent: number;
  readonly changedLineThresholdMet: boolean;
  readonly criticalPathsAllCovered: boolean;
  readonly unexecutedCodeDetected: boolean;
  readonly unexecutedFiles: readonly string[];
}

/**
 * Coverage thresholds from the Quality_Profile.
 * Requirement 38.5
 */
export interface CoverageThresholds {
  readonly changedLineMinPercent: number;
  readonly criticalPathRequired: boolean;
  readonly ignoreUnexecutedGenerated: boolean;
}

export const DEFAULT_COVERAGE_THRESHOLDS: CoverageThresholds = {
  changedLineMinPercent: 80,
  criticalPathRequired: true,
  ignoreUnexecutedGenerated: true,
};

// ─── Defect Regression ──────────────────────────────────────────

/**
 * Requirement for a failing regression test when fixing defects.
 * Requirement 38.6
 */
export interface DefectRegressionRequirement {
  readonly defectId: string;
  readonly taskId: string;
  readonly hasFailingTest: boolean;
  readonly testId?: string | undefined;
  readonly impracticalityReason?: string | undefined;
  readonly documentedBy?: string | undefined;
  readonly documentedAt?: string | undefined;
}

// ─── Runtime Test Execution ─────────────────────────────────────

/**
 * Failure classification for integration/E2E test results.
 * Requirement 38.8
 */
export type TestFailureKind =
  | 'assertion'
  | 'infrastructure'
  | 'timeout'
  | 'flake'
  | 'cancellation';

/**
 * Result of running a single test in the Runtime_Profile.
 * Requirement 38.7, 38.8
 */
export interface RuntimeTestResult {
  readonly testId: string;
  readonly filePath: string;
  readonly testName: string;
  readonly suiteName: string;
  readonly category: TestCategory;
  readonly passed: boolean;
  readonly failureKind?: TestFailureKind;
  readonly durationMs: number;
  readonly retryCount: number;
  readonly runtimeProfileId: string;
  readonly workspaceRevision: string;
  readonly output?: string;
}

// ─── Test Suite Report ──────────────────────────────────────────

/**
 * Summary report for test suites.
 * Requirement 38.9
 */
export interface TestSuiteReport {
  readonly suiteId: string;
  readonly suiteName: string;
  readonly category: TestCategory;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly passRate: number;
  readonly duration: number;
}

/**
 * Complete test integrity report for Production_Readiness_Report.
 * Requirement 38.9
 */
export interface TestIntegrityReport {
  readonly workspaceRevision: string;
  readonly generatedAt: string;
  readonly suites: readonly TestSuiteReport[];
  readonly totalTests: number;
  readonly totalPassed: number;
  readonly totalFailed: number;
  readonly totalSkipped: number;
  readonly totalFlaky: number;
  readonly overallPassRate: number;
  readonly coverageDeltas: readonly CoverageDelta[];
  readonly violations: readonly IntegrityViolation[];
  readonly waivers: readonly TestWaiver[];
  readonly defectRegressions: readonly DefectRegressionRequirement[];
  readonly allGatesPassed: boolean;
}

/**
 * Coverage delta between current and previous revisions.
 * Requirement 38.9
 */
export interface CoverageDelta {
  readonly filePath: string;
  readonly previousPercent: number;
  readonly currentPercent: number;
  readonly delta: number;
}

/**
 * Waiver for a test integrity violation.
 * Requirement 38.9
 */
export interface TestWaiver {
  readonly id: string;
  readonly violationId: string;
  readonly actor: string;
  readonly reason: string;
  readonly scope: string;
  readonly grantedAt: string;
  readonly expiresAt?: string | undefined;
}

// ─── Service Interface ──────────────────────────────────────────

/**
 * Test Integrity Enforcer service interface.
 * Requirements: 38.1–38.9
 */
export interface ITestIntegrityEnforcer {
  /**
   * Select tests by behavior and risk and link them to clauses.
   * Requirement 38.1
   */
  selectTestsByBehavior(
    taskId: string,
    changedFiles: readonly string[],
    riskAreas: readonly string[],
  ): BehaviorTest[];

  /**
   * Link tests to Evidence at an exact revision.
   * Requirement 38.2
   */
  linkTestToEvidence(
    testId: string,
    evidenceId: string,
    workspaceRevision: string,
    linkedClauses: readonly string[],
  ): TestEvidenceLink;

  /**
   * Detect integrity violations according to policy.
   * Requirement 38.3, 38.4
   */
  detectViolations(
    changedFiles: readonly string[],
    policy: IntegrityPolicy,
  ): IntegrityViolation[];

  /**
   * Enforce changed-line and critical-path coverage.
   * Requirement 38.5
   */
  enforceCoverage(
    changedFiles: readonly string[],
    changedLines: Readonly<Record<string, readonly number[]>>,
    criticalPaths: readonly string[],
    thresholds: CoverageThresholds,
  ): CoverageEnforcementResult;

  /**
   * Require a failing regression test for defect fixes.
   * Requirement 38.6
   */
  requireRegressionTest(
    defectId: string,
    taskId: string,
    testId?: string,
    impracticalityReason?: string,
  ): DefectRegressionRequirement;

  /**
   * Run tests in the Runtime_Profile and classify failures.
   * Requirement 38.7, 38.8
   */
  runInRuntimeProfile(
    tests: readonly BehaviorTest[],
    runtimeProfileId: string,
    workspaceRevision: string,
  ): Promise<RuntimeTestResult[]>;

  /**
   * Generate the full test integrity report.
   * Requirement 38.9
   */
  generateReport(workspaceRevision: string): TestIntegrityReport;
}
