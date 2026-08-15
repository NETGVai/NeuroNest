/**
 * Universal Cache Budgets, Eviction Telemetry, and Worker Boundaries
 *
 * Defines observable cache budget constraints, eviction policies, operation
 * duration diagnostics, and worker boundaries for expensive operations.
 *
 * Every cache — including temporary and small-development caches — has explicit
 * size bounds, eviction policy, and observability (Requirement 24.7).
 *
 * Requirements: 7.1, 24.7, 24.9, 28.2
 */

// ─── Cache Budget Configuration ─────────────────────────────────────────────

export type EvictionPolicy = 'lru' | 'lfu' | 'ttl' | 'size-based' | 'fifo';

export interface CacheBudget {
  /** Unique cache identifier */
  readonly id: string;
  /** Human-readable cache name */
  readonly name: string;
  /** Maximum number of entries */
  readonly maxEntries: number;
  /** Maximum size in bytes (0 = entry-count only) */
  readonly maxSizeBytes: number;
  /** Eviction policy */
  readonly evictionPolicy: EvictionPolicy;
  /** Time-to-live for entries in ms (0 = no TTL) */
  readonly ttlMs: number;
  /** Whether this cache is source-free (no source content in telemetry) */
  readonly sourceFree: boolean;
  /** Category of cached content for diagnostics */
  readonly category: CacheCategory;
}

export type CacheCategory =
  | 'model-content'
  | 'completion'
  | 'context'
  | 'diff'
  | 'artifact'
  | 'lsp-response'
  | 'index'
  | 'rendering'
  | 'session'
  | 'temporary';

// ─── Default Cache Budgets ──────────────────────────────────────────────────

/**
 * Universal cache budget definitions for all NeuroNest subsystems.
 */
export const DEFAULT_CACHE_BUDGETS: readonly CacheBudget[] = [
  {
    id: 'editor-model-cache',
    name: 'Editor Model Content Cache',
    maxEntries: 50,
    maxSizeBytes: 256 * 1024 * 1024, // 256 MB
    evictionPolicy: 'lru',
    ttlMs: 0,
    sourceFree: false,
    category: 'model-content',
  },
  {
    id: 'completion-cache',
    name: 'Inline Completion Cache',
    maxEntries: 200,
    maxSizeBytes: 16 * 1024 * 1024, // 16 MB
    evictionPolicy: 'lru',
    ttlMs: 60_000, // 1 minute
    sourceFree: true,
    category: 'completion',
  },
  {
    id: 'context-cache',
    name: 'Context Resolution Cache',
    maxEntries: 500,
    maxSizeBytes: 64 * 1024 * 1024, // 64 MB
    evictionPolicy: 'lru',
    ttlMs: 300_000, // 5 minutes
    sourceFree: false,
    category: 'context',
  },
  {
    id: 'diff-cache',
    name: 'Diff Computation Cache',
    maxEntries: 100,
    maxSizeBytes: 128 * 1024 * 1024, // 128 MB
    evictionPolicy: 'lru',
    ttlMs: 120_000, // 2 minutes
    sourceFree: false,
    category: 'diff',
  },
  {
    id: 'lsp-response-cache',
    name: 'LSP Response Cache',
    maxEntries: 1_000,
    maxSizeBytes: 32 * 1024 * 1024, // 32 MB
    evictionPolicy: 'lfu',
    ttlMs: 30_000, // 30 seconds
    sourceFree: true,
    category: 'lsp-response',
  },
  {
    id: 'index-cache',
    name: 'Repository Index Cache',
    maxEntries: 10_000,
    maxSizeBytes: 512 * 1024 * 1024, // 512 MB
    evictionPolicy: 'lru',
    ttlMs: 0,
    sourceFree: true,
    category: 'index',
  },
  {
    id: 'rendering-cache',
    name: 'Rendering and Layout Cache',
    maxEntries: 500,
    maxSizeBytes: 32 * 1024 * 1024, // 32 MB
    evictionPolicy: 'lru',
    ttlMs: 60_000, // 1 minute
    sourceFree: true,
    category: 'rendering',
  },
  {
    id: 'artifact-cache',
    name: 'Artifact Preview Cache',
    maxEntries: 50,
    maxSizeBytes: 64 * 1024 * 1024, // 64 MB
    evictionPolicy: 'lru',
    ttlMs: 600_000, // 10 minutes
    sourceFree: false,
    category: 'artifact',
  },
  {
    id: 'session-temp-cache',
    name: 'Session Temporary Cache',
    maxEntries: 100,
    maxSizeBytes: 8 * 1024 * 1024, // 8 MB
    evictionPolicy: 'ttl',
    ttlMs: 30_000, // 30 seconds
    sourceFree: true,
    category: 'temporary',
  },
];

// ─── Eviction Telemetry ─────────────────────────────────────────────────────

/**
 * Telemetry record for a cache eviction event.
 * All records are source-free (no file content or code).
 */
export interface EvictionTelemetryRecord {
  /** Cache ID */
  readonly cacheId: string;
  /** Timestamp of eviction */
  readonly timestamp: number;
  /** Reason for eviction */
  readonly reason: EvictionReason;
  /** Number of entries evicted */
  readonly evictedCount: number;
  /** Bytes freed */
  readonly freedBytes: number;
  /** Current cache utilization after eviction (0.0 - 1.0) */
  readonly utilizationAfter: number;
  /** Duration of eviction operation in ms */
  readonly durationMs: number;
}

export type EvictionReason =
  | 'capacity-exceeded'
  | 'ttl-expired'
  | 'memory-pressure'
  | 'explicit-clear'
  | 'stale-content'
  | 'policy-eviction';

/**
 * Aggregate cache statistics for diagnostics (source-free).
 */
export interface CacheStats {
  readonly cacheId: string;
  readonly currentEntries: number;
  readonly maxEntries: number;
  readonly currentSizeBytes: number;
  readonly maxSizeBytes: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly evictionCount: number;
  readonly hitRate: number;
  readonly utilizationRatio: number;
  readonly lastEvictionAt?: number;
  readonly oldestEntryAge?: number;
}

// ─── Operation Duration Diagnostics ─────────────────────────────────────────

/**
 * Source-free operation duration diagnostic record.
 */
export interface OperationDiagnostic {
  /** Operation name */
  readonly operation: string;
  /** Duration in milliseconds */
  readonly durationMs: number;
  /** Timestamp of operation start */
  readonly startedAt: number;
  /** Whether the operation met its threshold */
  readonly withinThreshold: boolean;
  /** The threshold this operation was measured against */
  readonly thresholdMs?: number;
  /** Category of the operation */
  readonly category: OperationCategory;
  /** Additional source-free metadata */
  readonly metadata?: Record<string, string | number | boolean>;
}

export type OperationCategory =
  | 'diff-computation'
  | 'index-update'
  | 'lsp-request'
  | 'rendering'
  | 'file-io'
  | 'cache-operation'
  | 'worker-dispatch'
  | 'ipc-roundtrip';

// ─── Worker Boundaries ──────────────────────────────────────────────────────

/**
 * Defines boundaries for expensive operations that must run off
 * the renderer's main thread to maintain responsiveness.
 */
export interface WorkerBoundary {
  /** Unique worker boundary identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** The expensive operation category */
  readonly category: ExpensiveOperationCategory;
  /** Maximum time allowed on main thread before offload is required (ms) */
  readonly mainThreadBudgetMs: number;
  /** Target worker type */
  readonly workerType: WorkerType;
  /** Maximum concurrent instances of this worker */
  readonly maxConcurrency: number;
  /** Operation timeout in ms */
  readonly timeoutMs: number;
  /** Whether results from this worker need main-thread validation */
  readonly requiresMainThreadValidation: boolean;
}

export type ExpensiveOperationCategory =
  | 'diff'
  | 'index'
  | 'lsp'
  | 'rendering'
  | 'syntax-highlight'
  | 'search'
  | 'validation'
  | 'import-transform';

export type WorkerType =
  | 'web-worker'
  | 'child-process'
  | 'worker-thread'
  | 'shared-worker';

/**
 * Default worker boundaries for expensive operations.
 * Ensures renderer work stays bounded to one animation frame (~16ms).
 */
export const DEFAULT_WORKER_BOUNDARIES: readonly WorkerBoundary[] = [
  {
    id: 'diff-worker',
    name: 'Diff Computation Worker',
    category: 'diff',
    mainThreadBudgetMs: 8, // Half an animation frame
    workerType: 'worker-thread',
    maxConcurrency: 2,
    timeoutMs: 30_000,
    requiresMainThreadValidation: false,
  },
  {
    id: 'index-worker',
    name: 'Repository Index Worker',
    category: 'index',
    mainThreadBudgetMs: 4,
    workerType: 'worker-thread',
    maxConcurrency: 1,
    timeoutMs: 60_000,
    requiresMainThreadValidation: false,
  },
  {
    id: 'lsp-worker',
    name: 'LSP Processing Worker',
    category: 'lsp',
    mainThreadBudgetMs: 8,
    workerType: 'child-process',
    maxConcurrency: 4,
    timeoutMs: 30_000,
    requiresMainThreadValidation: true,
  },
  {
    id: 'rendering-worker',
    name: 'Heavy Rendering Worker',
    category: 'rendering',
    mainThreadBudgetMs: 12,
    workerType: 'web-worker',
    maxConcurrency: 2,
    timeoutMs: 10_000,
    requiresMainThreadValidation: false,
  },
  {
    id: 'syntax-highlight-worker',
    name: 'Syntax Highlighting Worker',
    category: 'syntax-highlight',
    mainThreadBudgetMs: 8,
    workerType: 'web-worker',
    maxConcurrency: 2,
    timeoutMs: 5_000,
    requiresMainThreadValidation: false,
  },
  {
    id: 'search-worker',
    name: 'Full-Text Search Worker',
    category: 'search',
    mainThreadBudgetMs: 4,
    workerType: 'worker-thread',
    maxConcurrency: 1,
    timeoutMs: 15_000,
    requiresMainThreadValidation: false,
  },
  {
    id: 'validation-worker',
    name: 'Validation and Quality Worker',
    category: 'validation',
    mainThreadBudgetMs: 4,
    workerType: 'worker-thread',
    maxConcurrency: 2,
    timeoutMs: 60_000,
    requiresMainThreadValidation: true,
  },
  {
    id: 'import-transform-worker',
    name: 'Import Transformation Worker',
    category: 'import-transform',
    mainThreadBudgetMs: 4,
    workerType: 'worker-thread',
    maxConcurrency: 1,
    timeoutMs: 120_000,
    requiresMainThreadValidation: true,
  },
];

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate that all cache budgets have valid configurations.
 */
export function validateCacheBudgets(budgets: readonly CacheBudget[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const budget of budgets) {
    if (!budget.id) errors.push('Cache budget ID is required');
    if (ids.has(budget.id)) errors.push(`Duplicate cache budget ID: ${budget.id}`);
    ids.add(budget.id);
    if (budget.maxEntries < 1) errors.push(`${budget.id}: maxEntries must be >= 1`);
    if (budget.maxSizeBytes < 0) errors.push(`${budget.id}: maxSizeBytes must be >= 0`);
    if (budget.ttlMs < 0) errors.push(`${budget.id}: ttlMs must be >= 0`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate worker boundaries configuration.
 */
export function validateWorkerBoundaries(boundaries: readonly WorkerBoundary[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const boundary of boundaries) {
    if (!boundary.id) errors.push('Worker boundary ID is required');
    if (ids.has(boundary.id)) errors.push(`Duplicate worker boundary ID: ${boundary.id}`);
    ids.add(boundary.id);
    if (boundary.mainThreadBudgetMs <= 0) errors.push(`${boundary.id}: mainThreadBudgetMs must be > 0`);
    if (boundary.maxConcurrency < 1) errors.push(`${boundary.id}: maxConcurrency must be >= 1`);
    if (boundary.timeoutMs <= 0) errors.push(`${boundary.id}: timeoutMs must be > 0`);
  }

  return { valid: errors.length === 0, errors };
}
