/**
 * Evaluation Harness
 *
 * Infrastructure for measuring agent quality through a corpus of coding tasks.
 * Computes verified-success rate, detects regressions, and records per-task metrics.
 *
 * Also provides KPI-oriented evaluation with a fixed task suite of 30+ tasks,
 * programmatic success checks, and CI targets for nightly and PR smoke runs.
 *
 * @module eval-harness
 */

// ─── Legacy types and runner (verified-success rate) ─────────────────────────
export {
  EvalTask as LegacyEvalTask,
  EvalTaskCategory as LegacyEvalTaskCategory,
  EvalTaskStatus,
  EvalResult as LegacyEvalResult,
  EvalRunSummary,
  CorpusConfig,
  EvalRunnerConfig as LegacyEvalRunnerConfig,
  DEFAULT_RUNNER_CONFIG,
} from './types';

export {
  getFullCorpus,
  getCorpusSize,
  filterCorpus,
  getCorpusSummary,
  getTaskById,
} from './corpus';

export {
  EvalRunner,
  TaskExecutor,
  computeVerifiedSuccessRate,
  detectRegression,
  aggregateResults,
  executeParallel,
  extractMetrics,
} from './runner';

// ─── KPI-oriented eval task suite (Requirements 23.3–23.6) ──────────────────
export {
  EvalTask,
  EvalTaskCategory,
  EvalTaskLanguage,
  EVAL_TASK_SUITE,
  SMOKE_SUBSET_IDS,
  getEvalTaskSuite,
  getSmokeSubset,
  getTasksByCategory,
  getTasksByLanguage,
  getEvalTaskById,
  getEvalTaskCount,
} from './eval-task';

export {
  EvalResult,
  EvalRunReport,
  AggregateKpis,
  EvalRunnerConfig,
  DEFAULT_EVAL_RUNNER_CONFIG,
  CITarget,
  EvalTaskExecutor,
  EvalCLIOptions,
  KpiEvalRunner,
  getTasksForCITarget,
  computeAggregateKpis,
  formatResultsTable,
  formatResultsJson,
} from './eval-runner';
