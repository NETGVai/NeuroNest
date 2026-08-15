/**
 * Skill Evaluation Types
 *
 * Type definitions for the reproducible skill evaluation and activation
 * thresholds framework. Covers fixture management, evaluation runs,
 * metric calculation, comparison, and persistence.
 *
 * Requirements: 44.1, 44.2, 44.3, 44.4, 44.5, 44.6, 44.7, 44.8
 */

// ─── Evaluation Fixtures ─────────────────────────────────────────

/**
 * Requirement 44.1: Positive trigger cases, near-miss negative cases,
 * and conflict cases against overlapping skills.
 */
export type FixtureType = 'positive' | 'near_miss' | 'conflict';

/**
 * A versioned evaluation fixture used for reproducible testing.
 */
export interface EvaluationFixture {
  /** Unique fixture ID */
  readonly fixtureId: string;
  /** Fixture version for reproducibility */
  readonly version: number;
  /** Type of fixture */
  readonly type: FixtureType;
  /** Human-readable description */
  readonly description: string;
  /** Input data for the fixture */
  readonly input: FixtureInput;
  /** Expected outcome */
  readonly expectedOutcome: FixtureExpectedOutcome;
  /** Environment requirements */
  readonly environmentRequirements: EnvironmentRequirements;
  /** Creation timestamp */
  readonly createdAt: number;
  /** Content fingerprint for integrity */
  readonly fingerprint: string;
}

export interface FixtureInput {
  /** Task description / trigger text */
  readonly taskDescription: string;
  /** Capability keys being tested */
  readonly capabilityKeys: readonly string[];
  /** Available tools for the fixture */
  readonly tools: readonly string[];
  /** Input context (structured) */
  readonly context: Record<string, unknown>;
  /** Budget constraints */
  readonly budget: BudgetConstraints;
}

export interface FixtureExpectedOutcome {
  /** Whether the skill should activate */
  readonly shouldActivate: boolean;
  /** Expected output patterns (for executable assertions) */
  readonly outputPatterns?: readonly string[];
  /** Safety constraints that must hold */
  readonly safetyConstraints?: readonly string[];
  /** If conflict type, which skill should win */
  readonly preferredSkillId?: string;
}

export interface EnvironmentRequirements {
  /** Required tools available in environment */
  readonly requiredTools: readonly string[];
  /** Required platform features */
  readonly requiredFeatures: readonly string[];
  /** Maximum allowed tokens */
  readonly maxTokens: number;
  /** Maximum allowed time in ms */
  readonly maxTimeMs: number;
}

export interface BudgetConstraints {
  /** Maximum input tokens */
  readonly maxInputTokens: number;
  /** Maximum output tokens */
  readonly maxOutputTokens: number;
  /** Maximum cost in configured monetary unit */
  readonly maxCost: number;
  /** Maximum wall-clock time in ms */
  readonly maxTimeMs: number;
}

// ─── Evaluation Configuration ────────────────────────────────────

/**
 * Requirement 44.6: Minimum activation thresholds.
 */
export interface ActivationThresholds {
  /** Minimum trigger precision (0-1) */
  readonly minPrecision: number;
  /** Minimum trigger recall (0-1) */
  readonly minRecall: number;
  /** Minimum executable correctness (0-1) */
  readonly minCorrectness: number;
  /** Minimum quality improvement over baseline (0-1, relative) */
  readonly minQualityImprovement: number;
  /** Maximum acceptable latency in ms (p95) */
  readonly maxLatencyMs: number;
  /** Maximum acceptable tokens per evaluation */
  readonly maxTokens: number;
  /** Maximum acceptable cost per evaluation */
  readonly maxCost: number;
  /** Minimum safety score (0-1) */
  readonly minSafety: number;
}

/**
 * Configuration for grader agreement in blinded comparisons.
 *
 * Requirement 44.4: Support blinded comparison with hidden identity
 * and ordering from graders, recording grader agreement.
 */
export interface GraderConfiguration {
  /** Grader identity/version */
  readonly graderId: string;
  /** Grader version */
  readonly graderVersion: string;
  /** Whether grading is blinded */
  readonly blinded: boolean;
  /** Number of graders required */
  readonly requiredGraders: number;
  /** Minimum agreement threshold (0-1) */
  readonly minAgreement: number;
  /** Grading criteria */
  readonly criteria: readonly GradingCriterion[];
}

export interface GradingCriterion {
  /** Criterion name */
  readonly name: string;
  /** Weight (0-1, all weights sum to 1) */
  readonly weight: number;
  /** Scale (e.g., 1-5) */
  readonly scale: readonly number[];
  /** Description of what each scale point means */
  readonly scaleDescriptions: readonly string[];
}

/**
 * Full evaluation configuration for a run.
 */
export interface EvaluationConfig {
  /** Activation thresholds */
  readonly thresholds: ActivationThresholds;
  /** Grader configuration */
  readonly graderConfig: GraderConfiguration;
  /** Environment fingerprint for reproducibility */
  readonly environmentFingerprint: string;
  /** Config version */
  readonly configVersion: string;
}

// ─── Evaluation Subjects ─────────────────────────────────────────

/**
 * Requirement 44.3: Compare candidate with no-skill baseline and
 * previous active version.
 */
export type EvaluationSubjectType = 'no_skill_baseline' | 'previous_active' | 'candidate';

export interface EvaluationSubject {
  /** Subject type */
  readonly type: EvaluationSubjectType;
  /** Skill ID (null for no-skill baseline) */
  readonly skillId: string | null;
  /** Skill version (null for no-skill baseline) */
  readonly skillVersion: string | null;
  /** Content fingerprint for comparison integrity */
  readonly contentFingerprint: string;
}

// ─── Fixture Results ─────────────────────────────────────────────

/**
 * Result of running a single fixture against a subject.
 */
export interface FixtureResult {
  /** Fixture ID */
  readonly fixtureId: string;
  /** Subject evaluated */
  readonly subject: EvaluationSubject;
  /** Whether the skill activated */
  readonly activated: boolean;
  /** Executable assertion results */
  readonly assertionResults: readonly AssertionResult[];
  /** Safety constraint results */
  readonly safetyResults: readonly SafetyResult[];
  /** Timing data */
  readonly latencyMs: number;
  /** Token usage */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cost */
  readonly cost: number;
  /** Raw output (bounded) */
  readonly rawOutput: string;
  /** Timestamp */
  readonly evaluatedAt: number;
}

export interface AssertionResult {
  /** Assertion name/pattern */
  readonly assertion: string;
  /** Whether it passed */
  readonly passed: boolean;
  /** Details */
  readonly details: string;
}

export interface SafetyResult {
  /** Safety constraint */
  readonly constraint: string;
  /** Whether it passed */
  readonly passed: boolean;
  /** Details */
  readonly details: string;
}

// ─── Blinded Comparison ──────────────────────────────────────────

/**
 * Requirement 44.4: Blinded comparison that hides candidate identity.
 */
export interface BlindedComparison {
  /** Comparison ID */
  readonly comparisonId: string;
  /** Fixture ID that was evaluated */
  readonly fixtureId: string;
  /** Anonymized labels for the subjects (e.g., 'A', 'B', 'C') */
  readonly labels: readonly string[];
  /** Grader scores per label */
  readonly graderScores: readonly GraderScore[];
  /** Agreement metric between graders */
  readonly agreement: number;
  /** Timestamp */
  readonly gradedAt: number;
}

export interface GraderScore {
  /** Grader identity */
  readonly graderId: string;
  /** Label being scored */
  readonly label: string;
  /** Scores per criterion */
  readonly criterionScores: readonly CriterionScore[];
  /** Overall score */
  readonly overallScore: number;
}

export interface CriterionScore {
  /** Criterion name */
  readonly criterionName: string;
  /** Score value */
  readonly score: number;
}

// ─── Aggregate Metrics ───────────────────────────────────────────

/**
 * Requirement 44.2: Calculated trigger precision and recall.
 */
export interface TriggerMetrics {
  /** True positives: correctly activated */
  readonly truePositives: number;
  /** False positives: incorrectly activated */
  readonly falsePositives: number;
  /** True negatives: correctly did not activate */
  readonly trueNegatives: number;
  /** False negatives: incorrectly did not activate */
  readonly falseNegatives: number;
  /** Ambiguous resolutions (for conflict cases) */
  readonly ambiguousResolutions: number;
  /** Precision = TP / (TP + FP) */
  readonly precision: number;
  /** Recall = TP / (TP + FN) */
  readonly recall: number;
  /** F1 = 2 * (P * R) / (P + R) */
  readonly f1Score: number;
}

/**
 * Requirement 44.5: Executable assertions, safety, latency, tokens, cost.
 */
export interface PerformanceMetrics {
  /** Mean latency in ms */
  readonly meanLatencyMs: number;
  /** P95 latency in ms */
  readonly p95LatencyMs: number;
  /** Total input tokens */
  readonly totalInputTokens: number;
  /** Total output tokens */
  readonly totalOutputTokens: number;
  /** Total cost */
  readonly totalCost: number;
  /** Mean cost per fixture */
  readonly meanCostPerFixture: number;
}

export interface CorrectnessMetrics {
  /** Assertion pass rate (0-1) */
  readonly assertionPassRate: number;
  /** Safety constraint pass rate (0-1) */
  readonly safetyPassRate: number;
  /** Total assertions evaluated */
  readonly totalAssertions: number;
  /** Total safety constraints evaluated */
  readonly totalSafetyConstraints: number;
}

/**
 * Complete aggregate metrics for one subject across all fixtures.
 */
export interface AggregateMetrics {
  /** Subject that was evaluated */
  readonly subject: EvaluationSubject;
  /** Trigger metrics */
  readonly trigger: TriggerMetrics;
  /** Performance metrics */
  readonly performance: PerformanceMetrics;
  /** Correctness metrics */
  readonly correctness: CorrectnessMetrics;
  /** Quality score from blinded grading (if applicable) */
  readonly qualityScore: number | null;
  /** Number of fixtures evaluated */
  readonly fixtureCount: number;
}

// ─── Threshold Decision ──────────────────────────────────────────

/**
 * Requirement 44.6: Block candidates that miss any mandatory threshold.
 */
export type ThresholdDecision = 'pass' | 'fail' | 'blocked';

export interface ThresholdCheckResult {
  /** Metric name */
  readonly metric: string;
  /** Observed value */
  readonly observed: number;
  /** Required threshold */
  readonly required: number;
  /** Whether it passes */
  readonly decision: ThresholdDecision;
  /** Direction of comparison */
  readonly direction: 'min' | 'max';
}

// ─── Evaluation Run ──────────────────────────────────────────────

export type EvaluationRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rolled_back';

/**
 * Complete evaluation run record.
 *
 * Requirement 44.8: Persist fixtures, environment fingerprints,
 * grader configuration, raw bounded results, aggregate scores,
 * threshold decisions, and comparison fingerprints.
 */
export interface EvaluationRun {
  /** Unique run ID */
  readonly runId: string;
  /** Candidate skill ID being evaluated */
  readonly candidateSkillId: string;
  /** Candidate version */
  readonly candidateVersion: string;
  /** Evaluation configuration used */
  readonly config: EvaluationConfig;
  /** Subjects evaluated */
  readonly subjects: readonly EvaluationSubject[];
  /** Fixtures used (by ID and version) */
  readonly fixtureRefs: readonly FixtureReference[];
  /** Raw fixture results (bounded) */
  readonly rawResults: readonly FixtureResult[];
  /** Blinded comparisons */
  readonly blindedComparisons: readonly BlindedComparison[];
  /** Aggregate metrics per subject */
  readonly aggregates: readonly AggregateMetrics[];
  /** Threshold check results */
  readonly thresholdChecks: readonly ThresholdCheckResult[];
  /** Overall decision */
  readonly decision: EvaluationDecision;
  /** Run status */
  readonly status: EvaluationRunStatus;
  /** Environment fingerprint */
  readonly environmentFingerprint: string;
  /** Comparison fingerprint (combined hash of all inputs) */
  readonly comparisonFingerprint: string;
  /** Started at */
  readonly startedAt: number;
  /** Completed at */
  readonly completedAt: number | null;
  /** Error details if failed */
  readonly error: string | null;
}

export interface FixtureReference {
  /** Fixture ID */
  readonly fixtureId: string;
  /** Fixture version used */
  readonly version: number;
  /** Fixture fingerprint for integrity */
  readonly fingerprint: string;
}

export type EvaluationDecision = 'approve' | 'reject' | 'blocked';

// ─── Rollback Support ────────────────────────────────────────────

/**
 * Requirement 44.7: Atomic rollback to last passing immutable version.
 */
export interface RollbackRecord {
  /** Rollback ID */
  readonly rollbackId: string;
  /** Skill ID that regressed */
  readonly skillId: string;
  /** Version that regressed */
  readonly regressedVersion: string;
  /** Version rolled back to */
  readonly rolledBackToVersion: string;
  /** Evidence of regression */
  readonly regressionEvidence: EvaluationRun;
  /** Timestamp */
  readonly rolledBackAt: number;
  /** Actor who initiated */
  readonly initiatedBy: string;
}

// ─── Monitored Outcome ───────────────────────────────────────────

/**
 * Requirement 44.7: When a newly activated version regresses
 * monitored outcomes or trigger quality.
 */
export interface MonitoredOutcome {
  /** Skill ID being monitored */
  readonly skillId: string;
  /** Version being monitored */
  readonly version: string;
  /** Last evaluation run ID */
  readonly lastEvaluationRunId: string;
  /** Whether a regression was detected */
  readonly regressionDetected: boolean;
  /** Specific metrics that regressed */
  readonly regressedMetrics: readonly string[];
  /** Checked at */
  readonly checkedAt: number;
}
