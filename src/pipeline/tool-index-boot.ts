/**
 * ToolIndex Cold-Start Boot (Feature 4: RAG_Tool_Selection)
 *
 * Encapsulates the once-at-boot Cold_Start_Indexing path for the {@link ToolIndex}
 * (`src/pipeline/tool-index.ts`). The boot races `ToolIndex.init()` against a
 * 30-second soft budget:
 *
 *   - On success (init completes AND the index reports `ready`), it records
 *     `tool_rag.index_ms` (elapsed time) and `tool_rag.index_size` (deduplicated
 *     tool count) to the Metrics_Sink (Requirement 30.5).
 *   - On budget-exceeded or init failure, the index stays unavailable
 *     (`ready=false`) and a one-shot retry flag is persisted to the data dir so a
 *     single retry is attempted on the next launch (Requirement 30.3, 30.4).
 *
 * The boot runs Cold_Start_Indexing exactly once per process via the run-once
 * guard in {@link bootstrapToolIndexOnce} (Requirement 30.1). While the index is
 * not ready (in progress, failed, or budget-exceeded), the pipeline substitutes
 * Full_Registry — that gating lives in the chat-message handler (task 16.2),
 * which reads {@link isToolIndexReady}.
 *
 * This module is intentionally free of Electron / `ipcMain` dependencies so it
 * can be unit-tested with stub sinks and stores. The integrator (boot path in
 * `src/main/ipc.ts`) injects the real {@link ToolIndex}, a Metrics_Sink
 * (`SessionTelemetryService`), and a config-backed retry-flag store.
 *
 * Requirements: 30.1, 30.2, 30.3, 30.4, 30.5
 */

import type { ToolIndex } from './tool-index.js';

/** Default cold-start soft budget in milliseconds (Requirement 30.4). */
export const COLD_START_BUDGET_MS = 30_000;

/** Metrics_Sink key: elapsed Cold_Start_Indexing time in ms (Requirement 30.5). */
export const TOOL_RAG_INDEX_MS_KEY = 'tool_rag.index_ms';

/** Metrics_Sink key: deduplicated tool count after indexing (Requirement 30.5). */
export const TOOL_RAG_INDEX_SIZE_KEY = 'tool_rag.index_size';

/**
 * Structural Metrics_Sink type — mirrored locally so this module does not depend
 * on `SessionTelemetryService`. Any object exposing
 * `recordMetric(sessionId, key, value)` satisfies it (notably
 * `SessionTelemetryService` from `src/session/session-telemetry.ts`).
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/**
 * Minimal structural view of the {@link ToolIndex} surface the boot path needs.
 * Lets tests pass a lightweight stand-in without a live EmbeddingProvider.
 */
export interface BootableToolIndex {
  init(): Promise<void>;
  isReady(): boolean;
  size(): number;
  markUnavailable(): void;
}

/**
 * One-shot retry-flag persistence port. The flag is a single boolean persisted
 * to the data dir; {@link consume} reads-and-clears it so retries never
 * accumulate, and {@link schedule} arms a single retry for the next launch
 * (Requirement 30.4). All methods must be fail-soft (never throw); the boot
 * path treats persistence as best-effort.
 */
export interface RetryFlagStore {
  /** Read and clear the persisted retry flag. Returns whether one was pending. */
  consume(): boolean;
  /** Persist a one-shot retry flag to be consumed on the next launch. */
  schedule(): void;
}

/** Why the boot ended — useful for logging and tests. */
export type ToolIndexBootReason =
  | 'success'
  | 'budget-exceeded'
  | 'init-failed';

/** Outcome of a single {@link bootstrapToolIndex} run. */
export interface ToolIndexBootResult {
  /** Whether the index is ready to serve retrieval after the boot. */
  ready: boolean;
  /** Terminal reason for the boot outcome. */
  reason: ToolIndexBootReason;
  /** Elapsed cold-start time in ms (only on success), else `null`. */
  indexMs: number | null;
  /** Deduplicated tool count (only on success), else `null`. */
  indexSize: number | null;
  /** Whether this boot consumed a retry flag left by a prior failed boot. */
  wasRetry: boolean;
}

export interface BootstrapToolIndexOptions {
  toolIndex: BootableToolIndex;
  /** Metrics_Sink for `tool_rag.index_ms` / `tool_rag.index_size` (optional). */
  metricsSink?: MetricsSink;
  /** One-shot retry-flag store (optional; no-op when omitted). */
  retryFlagStore?: RetryFlagStore;
  /** Cold-start soft budget in ms. Defaults to {@link COLD_START_BUDGET_MS}. */
  budgetMs?: number;
  /** Session id recorded alongside the boot metrics. Defaults to `null` (global). */
  sessionId?: string | null;
}

/**
 * Race a promise against a soft-budget timer. Resolves with `{ timedOut: false }`
 * when `work` settles first, or `{ timedOut: true }` when the budget elapses
 * first. The timer is always cleared so it never keeps the event loop alive, and
 * a late rejection from `work` after a timeout is swallowed (it can no longer
 * change the outcome).
 */
async function raceBudget(
  work: Promise<void>,
  budgetMs: number,
): Promise<{ timedOut: boolean; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
    // Do not let the budget timer hold the process open during shutdown.
    if (typeof timer === 'object' && timer && typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
  });

  const wrappedWork = work.then(
    () => ({ timedOut: false as const }),
    (error: unknown) => ({ timedOut: false as const, error }),
  );

  // Swallow a late work rejection that loses the race so it never surfaces as an
  // unhandled rejection after the timeout path already won.
  void work.catch(() => undefined);

  try {
    return await Promise.race([wrappedWork, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run Cold_Start_Indexing once, bounded by a soft budget.
 *
 * Behaviour:
 *   - Consumes any pending retry flag up front so it never accumulates across
 *     launches (the boot always attempts init regardless).
 *   - Races `toolIndex.init()` against `budgetMs`.
 *   - Success path (init settled within budget AND `isReady()` is `true`):
 *     records `tool_rag.index_ms` and `tool_rag.index_size` (Requirement 30.5).
 *   - Failure path (budget exceeded, init threw, or init resolved but the index
 *     marked itself unavailable): calls `markUnavailable()` and schedules a
 *     one-shot retry for the next launch (Requirement 30.3, 30.4). No index
 *     metrics are recorded on the failure path.
 *
 * Never throws — telemetry and retry-flag persistence are best-effort.
 */
export async function bootstrapToolIndex(
  opts: BootstrapToolIndexOptions,
): Promise<ToolIndexBootResult> {
  const { toolIndex, metricsSink, retryFlagStore } = opts;
  const budgetMs = opts.budgetMs ?? COLD_START_BUDGET_MS;
  const sessionId = opts.sessionId ?? null;

  // Clear any pending retry flag first so it cannot accumulate across boots.
  let wasRetry = false;
  try {
    wasRetry = retryFlagStore?.consume() ?? false;
  } catch {
    wasRetry = false;
  }

  const t0 = Date.now();
  const { timedOut, error } = await raceBudget(toolIndex.init(), budgetMs);

  // Determine the outcome. ToolIndex.init() swallows embedding errors internally
  // and marks itself unavailable rather than rejecting, so a resolved init still
  // requires an explicit `isReady()` check.
  const ready = !timedOut && error === undefined && safeIsReady(toolIndex);

  if (ready) {
    recordMetricSafe(metricsSink, sessionId, TOOL_RAG_INDEX_MS_KEY, Date.now() - t0);
    const size = safeSize(toolIndex);
    recordMetricSafe(metricsSink, sessionId, TOOL_RAG_INDEX_SIZE_KEY, size);
    return {
      ready: true,
      reason: 'success',
      indexMs: Date.now() - t0,
      indexSize: size,
      wasRetry,
    };
  }

  // Failure path: stay unavailable and arm a single retry for the next launch.
  try {
    toolIndex.markUnavailable();
  } catch {
    // markUnavailable is defensive; ignore.
  }
  try {
    retryFlagStore?.schedule();
  } catch {
    // Persistence is best-effort.
  }

  return {
    ready: false,
    reason: timedOut ? 'budget-exceeded' : 'init-failed',
    indexMs: null,
    indexSize: null,
    wasRetry,
  };
}

function safeIsReady(toolIndex: BootableToolIndex): boolean {
  try {
    return toolIndex.isReady() === true;
  } catch {
    return false;
  }
}

function safeSize(toolIndex: BootableToolIndex): number {
  try {
    const n = toolIndex.size();
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function recordMetricSafe(
  sink: MetricsSink | undefined,
  sessionId: string | null,
  key: string,
  value: number,
): void {
  if (!sink) return;
  if (!Number.isFinite(value)) return;
  try {
    sink.recordMetric(sessionId, key, value);
  } catch {
    // Telemetry is fail-soft — a sink failure must never break boot.
  }
}

// ─── Process-wide once guard + accessor (Requirement 30.1) ──────────

let bootStarted = false;
let bootPromise: Promise<ToolIndexBootResult> | null = null;
let bootedIndex: ToolIndex | null = null;

/**
 * Run {@link bootstrapToolIndex} at most once per process (Requirement 30.1).
 * Subsequent calls return the same in-flight/settled boot promise and ignore
 * their arguments. The booted {@link ToolIndex} is retained so the chat-message
 * handler (task 16.2) can consult {@link isToolIndexReady} / {@link getToolIndex}.
 */
export function bootstrapToolIndexOnce(
  toolIndex: ToolIndex,
  opts?: Omit<BootstrapToolIndexOptions, 'toolIndex'>,
): Promise<ToolIndexBootResult> {
  if (bootStarted && bootPromise) return bootPromise;
  bootStarted = true;
  bootedIndex = toolIndex;
  bootPromise = bootstrapToolIndex({ toolIndex, ...(opts ?? {}) });
  return bootPromise;
}

/** The booted {@link ToolIndex} singleton, or `null` if boot never started. */
export function getToolIndex(): ToolIndex | null {
  return bootedIndex;
}

/**
 * Whether the booted index is ready to serve retrieval. Returns `false` when the
 * boot never started, is still in progress, failed, or exceeded its budget — in
 * all of which the pipeline substitutes Full_Registry (Requirement 30.2, 30.3).
 */
export function isToolIndexReady(): boolean {
  return bootedIndex?.isReady() === true;
}

/**
 * Reset the process-wide boot guard. Test-only — production code boots exactly
 * once and never resets.
 */
export function __resetToolIndexBootForTests(): void {
  bootStarted = false;
  bootPromise = null;
  bootedIndex = null;
}
