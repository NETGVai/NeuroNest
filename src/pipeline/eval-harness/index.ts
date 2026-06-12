/**
 * Evaluation Harness
 *
 * Infrastructure for measuring agent quality through a corpus of coding tasks.
 * Computes verified-success rate, detects regressions, and records per-task metrics.
 *
 * @module eval-harness
 */

export {
  EvalTask,
  EvalTaskCategory,
  EvalTaskStatus,
  EvalResult,
  EvalRunSummary,
  CorpusConfig,
  EvalRunnerConfig,
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
