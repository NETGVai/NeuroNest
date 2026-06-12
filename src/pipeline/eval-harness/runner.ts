/**
 * Evaluation Runner
 *
 * Executes evaluation tasks through the full pipeline (generation → Verification Gate → Self-Healing)
 * with parallelized execution, metric recording, and regression detection.
 */

import {
  EvalTask,
  EvalResult,
  EvalRunSummary,
  EvalRunnerConfig,
  EvalTaskStatus,
  CorpusConfig,
  DEFAULT_RUNNER_CONFIG,
} from './types';
import { filterCorpus, getFullCorpus } from './corpus';

/**
 * Callback for executing a single task through the pipeline.
 * Implementations should run generation → Verification Gate → Self-Healing
 * and return the result metrics.
 */
export type TaskExecutor = (task: EvalTask) => Promise<EvalResult>;

/**
 * Computes the verified-success rate from an array of results.
 * Rate = count of 'pass' / total tasks (0.0 to 1.0).
 */
export function computeVerifiedSuccessRate(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  const passed = results.filter(r => r.status === 'pass').length;
  return passed / results.length;
}

/**
 * Detects whether a regression has occurred.
 * A regression is flagged if (baseline - current) > threshold.
 *
 * @param baselineRate - The previously recorded success rate (0.0 to 1.0)
 * @param currentRate - The current run's success rate (0.0 to 1.0)
 * @param threshold - The maximum acceptable drop in percentage points (default: 0.05)
 * @returns true if a regression is detected
 */
export function detectRegression(
  baselineRate: number,
  currentRate: number,
  threshold: number = 0.05
): boolean {
  return (baselineRate - currentRate) > threshold;
}

/**
 * Aggregates per-task results into a run summary.
 */
export function aggregateResults(
  results: EvalResult[],
  durationSeconds: number,
  baselineRate?: number,
  regressionThreshold: number = 0.05
): EvalRunSummary {
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const partial = results.filter(r => r.status === 'partial').length;
  const verifiedSuccessRate = computeVerifiedSuccessRate(results);

  const regressionDetected = baselineRate !== undefined
    ? detectRegression(baselineRate, verifiedSuccessRate, regressionThreshold)
    : false;

  return {
    runId: generateRunId(),
    totalTasks: results.length,
    passed,
    failed,
    partial,
    verifiedSuccessRate,
    durationSeconds,
    regressionDetected,
    baselineRate,
    results,
    runDate: new Date().toISOString(),
  };
}

/**
 * Executes tasks in parallel with concurrency control.
 * Uses a simple pool pattern to limit concurrent executions.
 */
export async function executeParallel(
  tasks: EvalTask[],
  executor: TaskExecutor,
  concurrency: number,
  taskTimeoutMs: number
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  let index = 0;

  async function runNext(): Promise<void> {
    while (index < tasks.length) {
      const currentIndex = index++;
      const task = tasks[currentIndex];
      const result = await executeWithTimeout(task, executor, taskTimeoutMs);
      results.push(result);
    }
  }

  // Create workers up to concurrency limit
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => runNext()
  );

  await Promise.all(workers);
  return results;
}

/**
 * Executes a single task with a timeout.
 * Returns a fail result if the task exceeds the timeout.
 */
async function executeWithTimeout(
  task: EvalTask,
  executor: TaskExecutor,
  timeoutMs: number
): Promise<EvalResult> {
  const startTime = Date.now();

  try {
    const result = await Promise.race([
      executor(task),
      createTimeout(timeoutMs, task.id),
    ]);
    return result;
  } catch (error) {
    return {
      taskId: task.id,
      status: 'fail',
      verificationScore: 0,
      tokenUsage: 0,
      timeMs: Date.now() - startTime,
      repairAttempts: 0,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Creates a timeout promise that rejects with a fail result.
 */
function createTimeout(ms: number, taskId: string): Promise<EvalResult> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Task ${taskId} timed out after ${ms}ms`));
    }, ms);
  });
}

/**
 * The main EvalRunner class that orchestrates evaluation runs.
 */
export class EvalRunner {
  private config: EvalRunnerConfig;
  private executor: TaskExecutor;

  constructor(executor: TaskExecutor, config: Partial<EvalRunnerConfig> = {}) {
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...config };
    this.executor = executor;
  }

  /**
   * Runs the full evaluation across the corpus.
   * Executes tasks in parallel, computes metrics, and detects regressions.
   */
  async run(corpusConfig?: CorpusConfig): Promise<EvalRunSummary> {
    const tasks = corpusConfig ? filterCorpus(corpusConfig) : getFullCorpus();
    const startTime = Date.now();

    const results = await executeParallel(
      tasks,
      this.executor,
      this.config.concurrency,
      this.config.taskTimeoutMs
    );

    const durationSeconds = (Date.now() - startTime) / 1000;

    return aggregateResults(
      results,
      durationSeconds,
      this.config.baselineRate,
      this.config.regressionThreshold
    );
  }

  /**
   * Updates the baseline rate for regression detection.
   */
  setBaseline(rate: number): void {
    this.config.baselineRate = rate;
  }

  /**
   * Returns the current runner configuration.
   */
  getConfig(): EvalRunnerConfig {
    return { ...this.config };
  }
}

/**
 * Extracts per-task performance metrics from results.
 */
export function extractMetrics(results: EvalResult[]): {
  avgTokenUsage: number;
  avgTimeMs: number;
  avgRepairAttempts: number;
  avgVerificationScore: number;
  maxTimeMs: number;
  totalTokenUsage: number;
} {
  if (results.length === 0) {
    return {
      avgTokenUsage: 0,
      avgTimeMs: 0,
      avgRepairAttempts: 0,
      avgVerificationScore: 0,
      maxTimeMs: 0,
      totalTokenUsage: 0,
    };
  }

  const totalTokenUsage = results.reduce((sum, r) => sum + r.tokenUsage, 0);
  const totalTimeMs = results.reduce((sum, r) => sum + r.timeMs, 0);
  const totalRepairAttempts = results.reduce((sum, r) => sum + r.repairAttempts, 0);
  const totalVerificationScore = results.reduce((sum, r) => sum + r.verificationScore, 0);
  const maxTimeMs = Math.max(...results.map(r => r.timeMs));

  return {
    avgTokenUsage: totalTokenUsage / results.length,
    avgTimeMs: totalTimeMs / results.length,
    avgRepairAttempts: totalRepairAttempts / results.length,
    avgVerificationScore: totalVerificationScore / results.length,
    maxTimeMs,
    totalTokenUsage,
  };
}

/**
 * Generates a unique run ID based on timestamp and random suffix.
 */
function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `eval-${timestamp}-${random}`;
}
