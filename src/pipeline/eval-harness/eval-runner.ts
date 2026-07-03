/**
 * Eval Runner — KPI-oriented evaluation runner
 *
 * Executes eval tasks headless via the CLI package, collects per-task KPI metrics,
 * emits results to the efficiency_kpis table, and supports CI targets for
 * nightly full-suite and 10-task smoke subset runs.
 *
 * Requirements: 23.3, 23.4, 23.5, 23.6
 */

import { EvalTask, getEvalTaskSuite, getSmokeSubset } from './eval-task';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Per-task evaluation result with KPI metrics.
 * Captures all efficiency-relevant measurements for before/after comparison.
 */
export interface EvalResult {
  /** ID of the evaluated task */
  taskId: string;
  /** Whether the task's success check passed */
  success: boolean;
  /** Total tokens consumed across all LLM calls */
  tokens: number;
  /** Estimated cost in USD */
  cost: number;
  /** Wall-clock time from start to completion in milliseconds */
  wallTimeMs: number;
  /** Number of tool/agent actions taken */
  actions: number;
  /** Number of stuck events detected during execution */
  stuckEvents: number;
  /** Number of LLM round-trips (request/response pairs) */
  llmRoundTrips: number;
  /** Tokens burned on loops, retries, and re-established context */
  wastedTokens: number;
}

/**
 * Summary of a full evaluation run with KPI aggregates.
 */
export interface EvalRunReport {
  /** Unique run identifier */
  runId: string;
  /** Whether this was a smoke subset or full-suite run */
  mode: 'full' | 'smoke';
  /** Total number of tasks executed */
  totalTasks: number;
  /** Number of tasks that passed their success check */
  passed: number;
  /** Number of tasks that failed */
  failed: number;
  /** Success rate (0.0 to 1.0) */
  successRate: number;
  /** Aggregate KPI metrics */
  aggregateKpis: AggregateKpis;
  /** Per-task results */
  results: EvalResult[];
  /** ISO 8601 timestamp of the run */
  startedAt: string;
  /** Total run duration in seconds */
  durationSeconds: number;
  /** Config fingerprint for reproducibility */
  configFingerprint: string;
}

/**
 * Aggregated KPI metrics across all tasks in a run.
 */
export interface AggregateKpis {
  /** Average tokens per completed task */
  avgTokensPerTask: number;
  /** Average LLM round-trips per task */
  avgLlmRoundTrips: number;
  /** Average wall-clock time per task in milliseconds */
  avgWallTimeMs: number;
  /** Average wasted tokens per task */
  avgWastedTokens: number;
  /** Total tokens across all tasks */
  totalTokens: number;
  /** Total cost across all tasks */
  totalCost: number;
  /** Total stuck events across all tasks */
  totalStuckEvents: number;
  /** Median wall-clock time in milliseconds */
  medianWallTimeMs: number;
  /** P95 wall-clock time in milliseconds */
  p95WallTimeMs: number;
}

/**
 * Configuration for the eval runner.
 */
export interface EvalRunnerConfig {
  /** Maximum concurrent task executions (default: 4) */
  concurrency: number;
  /** Per-task timeout in milliseconds (default: 300_000 = 5 min) */
  taskTimeoutMs: number;
  /** Maximum total run time in milliseconds (default: 3_600_000 = 60 min) */
  maxRunTimeMs: number;
  /** Path to workspace fixtures directory */
  fixturesDir: string;
  /** Whether to write results to the efficiency_kpis table */
  persistResults: boolean;
  /** Config fingerprint (models, mode, prompts version hash) */
  configFingerprint: string;
}

/** Default runner configuration */
export const DEFAULT_EVAL_RUNNER_CONFIG: EvalRunnerConfig = {
  concurrency: 4,
  taskTimeoutMs: 300_000,
  maxRunTimeMs: 3_600_000,
  fixturesDir: 'fixtures/eval-workspaces',
  persistResults: true,
  configFingerprint: 'default',
};

// ─── CI Targets ──────────────────────────────────────────────────────────────

/** CI run mode */
export type CITarget = 'nightly' | 'pr-smoke';

/**
 * Returns the task set for a given CI target.
 * - 'nightly': Full suite (all 32 tasks)
 * - 'pr-smoke': 10-task smoke subset for PRs touching pipeline code
 */
export function getTasksForCITarget(target: CITarget): EvalTask[] {
  switch (target) {
    case 'nightly':
      return getEvalTaskSuite();
    case 'pr-smoke':
      return getSmokeSubset();
  }
}

// ─── Task Executor Interface ─────────────────────────────────────────────────

/**
 * Callback for executing a single task through the headless pipeline.
 * Implementations should invoke the CLI agent in headless mode against a workspace fixture.
 */
export type EvalTaskExecutor = (task: EvalTask, workspaceDir: string) => Promise<EvalResult>;

// ─── KPI Aggregation ─────────────────────────────────────────────────────────

/**
 * Computes aggregate KPI metrics from per-task results.
 */
export function computeAggregateKpis(results: EvalResult[]): AggregateKpis {
  if (results.length === 0) {
    return {
      avgTokensPerTask: 0,
      avgLlmRoundTrips: 0,
      avgWallTimeMs: 0,
      avgWastedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      totalStuckEvents: 0,
      medianWallTimeMs: 0,
      p95WallTimeMs: 0,
    };
  }

  const completedTasks = results.filter(r => r.success);
  const taskCount = completedTasks.length || 1; // avoid division by zero

  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  const totalStuckEvents = results.reduce((s, r) => s + r.stuckEvents, 0);

  const avgTokensPerTask = completedTasks.reduce((s, r) => s + r.tokens, 0) / taskCount;
  const avgLlmRoundTrips = completedTasks.reduce((s, r) => s + r.llmRoundTrips, 0) / taskCount;
  const avgWallTimeMs = completedTasks.reduce((s, r) => s + r.wallTimeMs, 0) / taskCount;
  const avgWastedTokens = completedTasks.reduce((s, r) => s + r.wastedTokens, 0) / taskCount;

  const sortedWallTimes = results.map(r => r.wallTimeMs).sort((a, b) => a - b);
  const medianWallTimeMs = percentile(sortedWallTimes, 50);
  const p95WallTimeMs = percentile(sortedWallTimes, 95);

  return {
    avgTokensPerTask,
    avgLlmRoundTrips,
    avgWallTimeMs,
    avgWastedTokens,
    totalTokens,
    totalCost,
    totalStuckEvents,
    medianWallTimeMs,
    p95WallTimeMs,
  };
}

// ─── EvalRunner Class ────────────────────────────────────────────────────────

/**
 * The main eval runner that orchestrates headless task execution
 * and collects KPI metrics for the efficiency_kpis table.
 */
export class KpiEvalRunner {
  private config: EvalRunnerConfig;
  private executor: EvalTaskExecutor;

  constructor(executor: EvalTaskExecutor, config: Partial<EvalRunnerConfig> = {}) {
    this.config = { ...DEFAULT_EVAL_RUNNER_CONFIG, ...config };
    this.executor = executor;
  }

  /**
   * Runs the full evaluation suite (nightly CI target).
   * Executes all tasks and produces a comprehensive report.
   */
  async runFullSuite(): Promise<EvalRunReport> {
    return this.executeRun('full', getEvalTaskSuite());
  }

  /**
   * Runs the 10-task smoke subset (PR CI target).
   * Quick validation that pipeline changes haven't regressed core scenarios.
   */
  async runSmokeSubset(): Promise<EvalRunReport> {
    return this.executeRun('smoke', getSmokeSubset());
  }

  /**
   * Runs a specific CI target.
   */
  async runCITarget(target: CITarget): Promise<EvalRunReport> {
    const tasks = getTasksForCITarget(target);
    const mode = target === 'nightly' ? 'full' : 'smoke';
    return this.executeRun(mode, tasks);
  }

  /**
   * Runs a custom set of tasks by their IDs.
   */
  async runTasks(tasks: EvalTask[]): Promise<EvalRunReport> {
    return this.executeRun('full', tasks);
  }

  /**
   * Returns the current runner configuration.
   */
  getConfig(): EvalRunnerConfig {
    return { ...this.config };
  }

  // ─── Private Methods ─────────────────────────────────────────────

  private async executeRun(
    mode: 'full' | 'smoke',
    tasks: EvalTask[]
  ): Promise<EvalRunReport> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const results = await this.executeParallel(tasks);

    const durationSeconds = (Date.now() - startMs) / 1000;
    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const report: EvalRunReport = {
      runId: generateRunId(),
      mode,
      totalTasks: results.length,
      passed,
      failed,
      successRate: results.length > 0 ? passed / results.length : 0,
      aggregateKpis: computeAggregateKpis(results),
      results,
      startedAt,
      durationSeconds,
      configFingerprint: this.config.configFingerprint,
    };

    if (this.config.persistResults) {
      await this.persistToKpiTable(report);
    }

    return report;
  }

  /**
   * Executes tasks in parallel with concurrency control.
   */
  private async executeParallel(tasks: EvalTask[]): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    let index = 0;
    const runDeadline = Date.now() + this.config.maxRunTimeMs;

    const runNext = async (): Promise<void> => {
      while (index < tasks.length) {
        if (Date.now() >= runDeadline) break;

        const currentIndex = index++;
        const task = tasks[currentIndex];
        const workspaceDir = `${this.config.fixturesDir}/${task.id}`;

        const result = await this.executeWithTimeout(task, workspaceDir);
        results.push(result);
      }
    };

    const workers = Array.from(
      { length: Math.min(this.config.concurrency, tasks.length) },
      () => runNext()
    );

    await Promise.all(workers);
    return results;
  }

  /**
   * Executes a single task with timeout enforcement.
   */
  private async executeWithTimeout(task: EvalTask, workspaceDir: string): Promise<EvalResult> {
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        this.executor(task, workspaceDir),
        createTimeoutResult(this.config.taskTimeoutMs, task.id),
      ]);
      return result;
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        tokens: 0,
        cost: 0,
        wallTimeMs: Date.now() - startTime,
        actions: 0,
        stuckEvents: 0,
        llmRoundTrips: 0,
        wastedTokens: 0,
      };
    }
  }

  /**
   * Persists evaluation results to the efficiency_kpis table.
   * Each task result is stored as a separate KPI record for granular analysis.
   */
  private async persistToKpiTable(report: EvalRunReport): Promise<void> {
    // Persistence is handled by the efficiency-kpi-tracker module when available.
    // This method provides the integration point — the actual DB write is delegated
    // to avoid a hard dependency on the SQLite layer in the eval runner.
    if (this.onPersist) {
      await this.onPersist(report);
    }
  }

  /** Optional persistence callback, set by the host environment */
  onPersist?: (report: EvalRunReport) => Promise<void>;
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

/**
 * CLI-compatible entry point for running evaluations headless.
 * Intended to be invoked by the neuronest-cli package or CI scripts.
 *
 * Usage:
 *   neuronest eval --target nightly
 *   neuronest eval --target pr-smoke
 *   neuronest eval --tasks sb-node-001,bf-python-002
 */
export interface EvalCLIOptions {
  /** CI target: 'nightly' or 'pr-smoke' */
  target?: CITarget;
  /** Comma-separated list of specific task IDs to run */
  tasks?: string;
  /** Output format: 'json' for machine-readable, 'table' for human-readable */
  format?: 'json' | 'table';
  /** Path to fixtures directory override */
  fixturesDir?: string;
  /** Maximum concurrency override */
  concurrency?: number;
}

/**
 * Formats an EvalRunReport as a human-readable results table.
 */
export function formatResultsTable(report: EvalRunReport): string {
  const lines: string[] = [];
  const separator = '─'.repeat(100);

  lines.push(separator);
  lines.push(`  Eval Run: ${report.runId}  |  Mode: ${report.mode}  |  Config: ${report.configFingerprint}`);
  lines.push(separator);
  lines.push('');
  lines.push(`  ${'Task ID'.padEnd(16)} ${'Status'.padEnd(8)} ${'Tokens'.padEnd(10)} ${'Cost'.padEnd(8)} ${'Time'.padEnd(10)} ${'Actions'.padEnd(9)} ${'Stuck'.padEnd(7)} ${'Trips'.padEnd(7)} ${'Wasted'.padEnd(8)}`);
  lines.push(`  ${'─'.repeat(14)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(6)}`);

  for (const r of report.results) {
    const status = r.success ? '✓ PASS' : '✗ FAIL';
    const cost = `$${r.cost.toFixed(4)}`;
    const time = `${(r.wallTimeMs / 1000).toFixed(1)}s`;
    lines.push(`  ${r.taskId.padEnd(16)} ${status.padEnd(8)} ${String(r.tokens).padEnd(10)} ${cost.padEnd(8)} ${time.padEnd(10)} ${String(r.actions).padEnd(9)} ${String(r.stuckEvents).padEnd(7)} ${String(r.llmRoundTrips).padEnd(7)} ${String(r.wastedTokens).padEnd(8)}`);
  }

  lines.push('');
  lines.push(separator);
  lines.push(`  Summary: ${report.passed}/${report.totalTasks} passed (${(report.successRate * 100).toFixed(1)}%)  |  Duration: ${report.durationSeconds.toFixed(1)}s`);
  lines.push(`  KPIs: avg tokens/task=${report.aggregateKpis.avgTokensPerTask.toFixed(0)} | avg trips=${report.aggregateKpis.avgLlmRoundTrips.toFixed(1)} | avg time=${(report.aggregateKpis.avgWallTimeMs / 1000).toFixed(1)}s | avg wasted=${report.aggregateKpis.avgWastedTokens.toFixed(0)}`);
  lines.push(separator);

  return lines.join('\n');
}

/**
 * Formats an EvalRunReport as a JSON string for machine consumption.
 */
export function formatResultsJson(report: EvalRunReport): string {
  return JSON.stringify(report, null, 2);
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/** Generates a unique run ID */
function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `eval-kpi-${timestamp}-${random}`;
}

/** Computes a percentile from a sorted array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Creates a timeout result for tasks that exceed the time limit */
function createTimeoutResult(ms: number, taskId: string): Promise<EvalResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        taskId,
        success: false,
        tokens: 0,
        cost: 0,
        wallTimeMs: ms,
        actions: 0,
        stuckEvents: 0,
        llmRoundTrips: 0,
        wastedTokens: 0,
      });
    }, ms);
  });
}
