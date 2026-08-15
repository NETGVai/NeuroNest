/**
 * Performance Reference Profiles and Cache Budgets — Public API
 *
 * Requirements: 7.1, 24.7, 24.9, 28.2
 */

export {
  type HardwareSpec,
  type OSSpec,
  type RepositorySizeCategory,
  type RepositorySizeFixture,
  type ConcurrentLoadSpec,
  type PercentileMethod,
  type MeasurementConfig,
  type ExclusionReason,
  type AnomalyExclusion,
  type PerformanceThreshold,
  type PerformanceReferenceProfile,
  DEFAULT_DEV_PROFILE,
  DEFAULT_CI_PROFILE,
  selectProfile,
  validateProfile,
} from './reference-profile';

export {
  type EvictionPolicy,
  type CacheBudget,
  type CacheCategory,
  type EvictionTelemetryRecord,
  type EvictionReason,
  type CacheStats,
  type OperationDiagnostic,
  type OperationCategory,
  type WorkerBoundary,
  type ExpensiveOperationCategory,
  type WorkerType,
  DEFAULT_CACHE_BUDGETS,
  DEFAULT_WORKER_BOUNDARIES,
  validateCacheBudgets,
  validateWorkerBoundaries,
} from './cache-budgets';
