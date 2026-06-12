/**
 * Evaluation Harness Types
 *
 * Defines core interfaces for the evaluation harness infrastructure
 * that measures verified-success rate across a corpus of coding tasks.
 */

/** Categories of coding tasks in the eval corpus */
export type EvalTaskCategory = 'file-creation' | 'refactoring' | 'bug-fix' | 'test-writing';

/** Status of a completed evaluation task */
export type EvalTaskStatus = 'pass' | 'fail' | 'partial';

/**
 * A single coding task in the evaluation corpus.
 * Represents a task definition with expected outcomes (not actual code generation).
 */
export interface EvalTask {
  /** Unique task identifier (e.g., "fc-001", "rf-012") */
  id: string;
  /** Category of the coding task */
  category: EvalTaskCategory;
  /** Human-readable description of what the task should accomplish */
  description: string;
  /** File paths expected to be created or modified upon successful completion */
  expectedFiles: string[];
  /** Optional complexity rating 1-5 for prioritization */
  complexity?: number;
  /** Optional tags for filtering */
  tags?: string[];
}

/**
 * Result of a single task evaluation through the full pipeline.
 * Records all metrics from generation → Verification Gate → Self-Healing.
 */
export interface EvalResult {
  /** ID of the evaluated task */
  taskId: string;
  /** Final status after pipeline execution */
  status: EvalTaskStatus;
  /** Verification Gate score (0-15 scale) */
  verificationScore: number;
  /** Total tokens consumed across all LLM calls for this task */
  tokenUsage: number;
  /** Wall-clock time from task start to completion in milliseconds */
  timeMs: number;
  /** Number of self-healing repair attempts made */
  repairAttempts: number;
  /** Optional error message if task failed */
  error?: string;
  /** Timestamp when this result was recorded */
  completedAt: string;
}

/**
 * Summary of a full evaluation run across the corpus.
 * Aggregates results and detects regressions.
 */
export interface EvalRunSummary {
  /** Unique run identifier */
  runId: string;
  /** Total number of tasks executed */
  totalTasks: number;
  /** Number of tasks that passed all verification stages */
  passed: number;
  /** Number of tasks that failed verification */
  failed: number;
  /** Number of tasks with partial success */
  partial: number;
  /** Verified-success rate: passed / totalTasks (0.0 to 1.0) */
  verifiedSuccessRate: number;
  /** Total run duration in seconds */
  durationSeconds: number;
  /** Whether a regression was detected vs baseline */
  regressionDetected: boolean;
  /** Previous baseline rate for comparison (if available) */
  baselineRate?: number;
  /** Per-task results for detailed analysis */
  results: EvalResult[];
  /** ISO 8601 timestamp of the run */
  runDate: string;
}

/**
 * Configuration for the evaluation corpus.
 */
export interface CorpusConfig {
  /** Filter tasks by categories (empty = all) */
  categories?: EvalTaskCategory[];
  /** Filter tasks by tags (empty = all) */
  tags?: string[];
  /** Maximum number of tasks to run (0 = all) */
  maxTasks?: number;
  /** Random seed for reproducible task selection */
  seed?: number;
}

/**
 * Configuration for the evaluation runner.
 */
export interface EvalRunnerConfig {
  /** Maximum concurrent task executions */
  concurrency: number;
  /** Per-task timeout in milliseconds (default: 120_000) */
  taskTimeoutMs: number;
  /** Regression detection threshold in percentage points (default: 0.05) */
  regressionThreshold: number;
  /** Baseline verified-success rate for regression comparison */
  baselineRate?: number;
  /** Maximum total run time in milliseconds (default: 7_200_000 = 120 min) */
  maxRunTimeMs: number;
}

/** Default runner configuration */
export const DEFAULT_RUNNER_CONFIG: EvalRunnerConfig = {
  concurrency: 8,
  taskTimeoutMs: 120_000,
  regressionThreshold: 0.05,
  maxRunTimeMs: 7_200_000, // 120 minutes
};
