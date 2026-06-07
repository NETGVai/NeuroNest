/**
 * Unified_State_Reducer — folds a Pipeline_Event stream into a `SessionState`
 * snapshot used by the prompt assembler's `## Current State` block.
 *
 * Task 22 of the 12-factor-agent-improvements spec. The reducer is the
 * Factor 5 (unify execution and business state) consumer of the EventLog
 * (task 7). It reads events via `EventLog.getEventsSince`, folds them with
 * a pure `apply` step, and caches the result keyed by `sessionId` so
 * subsequent calls only fold the new tail.
 *
 * Invariants (per design.md "Unified_State_Reducer" + Requirements 6.1 / 6.2 /
 * 6.5 / 6.9):
 *
 *   1. `seq` is the canonical ordering key — never `created_at`. Two events
 *      with identical timestamps are still ordered by their distinct `seq`
 *      values, so the cache resume key (`lastSeq`) cannot drift even under
 *      clock skew.
 *
 *   2. If `getEventsSince(sessionId, lastSeq)` returns a non-empty result
 *      whose first row has `seq != lastSeq + 1`, we observed a gap. Drop
 *      the cache, emit `event_log.gap_detected` to Metrics_Sink with the
 *      gap size (numeric, since the sink is numeric-only), and full
 *      re-reduce from seq=0. The full re-reduce is correct because the
 *      authoritative table is append-only; a gap means an in-flight emit
 *      hasn't committed yet, and a from-scratch read sees whatever has.
 *
 *   3. Cache invalidation on `kind === 'checkpoint.restored'` — a checkpoint
 *      restore can rewrite both the authoritative tables and the chat
 *      transcript, so the cached state is no longer trustworthy. This
 *      happens during the fold; the next `getSessionState` call is a
 *      cold reduce.
 *
 *   4. The reducer is pure / deterministic. `apply` and `reduce` never
 *      touch `Date.now()`, `Math.random()`, or any external mutable
 *      state. All time information comes from the events themselves
 *      (`createdAt`).
 *
 *   5. Forward-compat: unknown event kinds are ignored (state passes
 *      through unchanged). Future specs that add new kinds may extend
 *      the switch without breaking older deployments.
 *
 * Telemetry recorded per `getSessionState` call (Requirement 5.1):
 *
 *   - `unified_state.cache_hit`     — 1 (warm path) or 0 (cold path).
 *   - `unified_state.reduce_ms`     — wall-clock duration of the reduce.
 *
 * `unified_state.bytes` and `unified_state.estimated_tokens` are recorded
 * by the prompt-assembler hook (task 25) which knows how the state is
 * serialised into the prompt; the reducer itself only computes the
 * structured snapshot.
 *
 * Requirements: 6.1, 6.2, 6.5, 6.9
 */

import type { EventLog, EventKind, PipelineEvent } from './event-log.js';
import type { SessionTelemetryService } from '../session/session-telemetry.js';

// ─── Public types ──────────────────────────────────────────────

/** A single message entry derived from `chat.user` / `chat.assistant` events. */
export interface ChatMessage {
  messageId: string;
  role: 'user' | 'assistant';
  body: string;
  agentId?: string;
  /** `createdAt` of the originating event so consumers can sort/display. */
  createdAt: number;
}

/** Summary of an in-flight task derived from `task.transition` events. */
export interface TaskSummary {
  taskId: string;
  status: string;
  /** The most recent transition's `by` (agent or user id). */
  lastChangedBy?: string;
  /** `createdAt` of the latest transition. */
  updatedAt: number;
}

/** Summary of a pending approval. */
export interface ApprovalSummary {
  approvalId: string;
  prompt?: string;
  kind?: string;
  /** `createdAt` of the originating `approval.created` event. */
  createdAt: number;
}

/** Compact error description retained from the most recent `error.captured`. */
export interface ErrorSummary {
  errorId: string;
  scope: string;
  message: string;
  /** `createdAt` of the originating event. */
  createdAt: number;
}

/**
 * Active-tool tracking shape. Mirrors the design: a tool is "active" between
 * `tool.start` and the matching `tool.success` / `tool.failure` (keyed by
 * `callId`). The `startedAt` is the event's `createdAt`, not wall-clock now.
 */
export interface ActiveTool {
  callId: string;
  name: string;
  startedAt: number;
}

/** The folded view consumed by the prompt assembler (task 25). */
export interface SessionState {
  messages: ChatMessage[];
  activeTools: ActiveTool[];
  openTasks: TaskSummary[];
  blockedTasks: TaskSummary[];
  pendingApprovals: ApprovalSummary[];
  lastError?: ErrorSummary;
  lastCheckpointId?: string;
}

// ─── Pure reducer functions ────────────────────────────────────

/** Construct an empty session state. Exposed for tests + the cold path. */
export function emptySessionState(): SessionState {
  return {
    messages: [],
    activeTools: [],
    openTasks: [],
    blockedTasks: [],
    pendingApprovals: [],
  };
}

/**
 * Fold a sorted-by-seq event array into a fresh `SessionState`. Pure /
 * deterministic. Equivalent to `events.reduce(apply, emptySessionState())`.
 *
 * The event order precondition (`seq` ascending, no gaps) is the caller's
 * responsibility — `getSessionState` upholds it via the gap-detection path.
 */
export function reduce(events: PipelineEvent[]): SessionState {
  let state = emptySessionState();
  for (const evt of events) {
    state = apply(state, evt);
  }
  return state;
}

/**
 * Apply one event to the current state. Returns a new `SessionState`
 * (immutable update style) so callers can compare references for testing
 * memoisation. Unknown kinds are no-ops — the state is returned unchanged.
 */
export function apply(state: SessionState, event: PipelineEvent): SessionState {
  const payload = event.payload as Record<string, unknown> | null;

  switch (event.kind as EventKind) {
    case 'chat.user':
      return appendMessage(state, event, 'user', payload);
    case 'chat.assistant':
      return appendMessage(state, event, 'assistant', payload);

    case 'tool.start': {
      if (!payload) return state;
      const callId = stringField(payload, 'callId');
      const name = stringField(payload, 'name');
      if (!callId || !name) return state;
      // Avoid duplicate entries for the same callId (defensive — a malformed
      // log with two starts shouldn't grow the active list unbounded).
      if (state.activeTools.some((t) => t.callId === callId)) return state;
      return {
        ...state,
        activeTools: [
          ...state.activeTools,
          { callId, name, startedAt: event.createdAt },
        ],
      };
    }

    case 'tool.success':
    case 'tool.failure': {
      if (!payload) return state;
      const callId = stringField(payload, 'callId');
      if (!callId) return state;
      const next = state.activeTools.filter((t) => t.callId !== callId);
      if (next.length === state.activeTools.length) return state;
      return { ...state, activeTools: next };
    }

    case 'task.transition':
      return applyTaskTransition(state, event, payload);

    case 'approval.created': {
      if (!payload) return state;
      const approvalId = stringField(payload, 'approvalId');
      if (!approvalId) return state;
      // Idempotent insert: skip if we already track this approval.
      if (state.pendingApprovals.some((a) => a.approvalId === approvalId)) return state;
      const summary: ApprovalSummary = {
        approvalId,
        createdAt: event.createdAt,
      };
      const prompt = stringField(payload, 'prompt');
      if (prompt !== undefined) summary.prompt = prompt;
      const kind = stringField(payload, 'kind');
      if (kind !== undefined) summary.kind = kind;
      return {
        ...state,
        pendingApprovals: [...state.pendingApprovals, summary],
      };
    }

    case 'approval.decided': {
      if (!payload) return state;
      const approvalId = stringField(payload, 'approvalId');
      if (!approvalId) return state;
      const next = state.pendingApprovals.filter((a) => a.approvalId !== approvalId);
      if (next.length === state.pendingApprovals.length) return state;
      return { ...state, pendingApprovals: next };
    }

    case 'error.captured': {
      if (!payload) return state;
      const errorId = stringField(payload, 'errorId');
      const scope = stringField(payload, 'scope');
      const message = stringField(payload, 'message');
      if (!errorId || !scope || message === undefined) return state;
      const lastError: ErrorSummary = {
        errorId,
        scope,
        message,
        createdAt: event.createdAt,
      };
      return { ...state, lastError };
    }

    case 'checkpoint.created': {
      if (!payload) return state;
      const checkpointId = stringField(payload, 'checkpointId');
      if (!checkpointId) return state;
      return { ...state, lastCheckpointId: checkpointId };
    }

    case 'checkpoint.restored': {
      // The reducer's caller (`getSessionState`) is responsible for cache
      // invalidation when this kind shows up — the fold itself just records
      // the checkpoint id so a downstream consumer can correlate the prompt
      // with the latest restore.
      if (!payload) return state;
      const checkpointId = stringField(payload, 'checkpointId');
      if (!checkpointId) return state;
      return { ...state, lastCheckpointId: checkpointId };
    }

    case 'tool.batch':
      // Compaction_Job (task 31) replaces a contiguous tool-start/tool-success
      // run with a single batch event. By the time a batch lands the original
      // tool calls are no longer active, so the active-tools list isn't
      // affected. The batch is otherwise opaque to the reducer.
      return state;

    default:
      // Forward-compat: unknown kind is ignored. Logged once at warn level
      // by callers if desired; we don't log here because `apply` runs N
      // times per session and the noise would be unbounded.
      return state;
  }
}

// ─── Helpers used by `apply` ───────────────────────────────────

function appendMessage(
  state: SessionState,
  event: PipelineEvent,
  role: 'user' | 'assistant',
  payload: Record<string, unknown> | null,
): SessionState {
  if (!payload) return state;
  const messageId = stringField(payload, 'messageId');
  const body = stringField(payload, 'body');
  if (!messageId || body === undefined) return state;
  // Idempotency: if the same messageId is already tracked, leave state alone.
  // Protects against re-fold scenarios feeding the same event twice (which
  // shouldn't happen given the `seq` monotonicity contract, but the cost of
  // checking is O(n) in current message count and worth the safety).
  if (state.messages.some((m) => m.messageId === messageId)) return state;
  const message: ChatMessage = {
    messageId,
    role,
    body,
    createdAt: event.createdAt,
  };
  const agentId = stringField(payload, 'agentId');
  if (agentId !== undefined) message.agentId = agentId;
  return { ...state, messages: [...state.messages, message] };
}

function applyTaskTransition(
  state: SessionState,
  event: PipelineEvent,
  payload: Record<string, unknown> | null,
): SessionState {
  if (!payload) return state;
  const taskId = stringField(payload, 'taskId');
  const to = stringField(payload, 'to');
  if (!taskId || !to) return state;
  const by = stringField(payload, 'by');

  // Drop the task from both buckets first, then re-insert into the bucket
  // matching its new status. Tasks that transition to a terminal state
  // (`done`, `cancelled`, etc.) are simply removed.
  const openTasks = state.openTasks.filter((t) => t.taskId !== taskId);
  const blockedTasks = state.blockedTasks.filter((t) => t.taskId !== taskId);

  const summary: TaskSummary = {
    taskId,
    status: to,
    updatedAt: event.createdAt,
  };
  if (by !== undefined) summary.lastChangedBy = by;

  switch (to) {
    case 'todo':
    case 'in_progress':
      openTasks.push(summary);
      break;
    case 'blocked':
      blockedTasks.push(summary);
      break;
    default:
      // `done`, `cancelled`, or anything else terminal — already removed.
      break;
  }

  return { ...state, openTasks, blockedTasks };
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' ? v : undefined;
}

// ─── UnifiedStateReducer (cached entrypoint) ───────────────────

interface CacheEntry {
  state: SessionState;
  lastSeq: number;
}

/**
 * Stateful wrapper around `reduce` / `apply` that maintains an in-memory
 * cache and emits the telemetry mandated by Requirement 5.1.
 *
 * Construction takes the `EventLog` and the `Metrics_Sink` (the
 * `SessionTelemetryService` extension from task 4). Both are required —
 * passing `null` would silently drop telemetry, and the rollout-gate
 * script depends on those metrics being present.
 */
export class UnifiedStateReducer {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly eventLog: EventLog;
  private readonly metrics: SessionTelemetryService;

  constructor(eventLog: EventLog, metrics: SessionTelemetryService) {
    this.eventLog = eventLog;
    this.metrics = metrics;
  }

  /**
   * Resolve the current state for a session.
   *
   * Algorithm (per design.md "Unified_State_Reducer"):
   *
   *   1. Read cache. If absent, treat `lastSeq = 0`.
   *   2. Call `eventLog.getEventsSince(sessionId, lastSeq)`.
   *   3. If the result is non-empty AND first row `seq != lastSeq + 1`,
   *      emit `event_log.gap_detected`, drop the cache, fall through to
   *      the cold path.
   *   4. Cache hit (no gap, no checkpoint.restored in fold): incremental
   *      apply over the new events; update cache.
   *   5. Cache miss / invalidated: full re-reduce from seq=0.
   *   6. Record `unified_state.cache_hit` (1/0) and `unified_state.reduce_ms`.
   */
  async getSessionState(sessionId: string): Promise<SessionState> {
    const t0 = nowMs();

    let cached = this.cache.get(sessionId);
    let cacheHit = cached !== undefined;
    const lastSeq = cached?.lastSeq ?? 0;

    let newEvents = await this.eventLog.getEventsSince(sessionId, lastSeq);

    // Gap detection — only meaningful when we actually had a cached state
    // to resume from. A cold path with `lastSeq = 0` and a first event of
    // seq=1 is the contiguous case; anything else we observe in the cold
    // path is whatever the table currently holds, which is by definition
    // canonical.
    if (cached && newEvents.length > 0 && newEvents[0]!.seq !== lastSeq + 1) {
      const gapSize = newEvents[0]!.seq - (lastSeq + 1);
      this.recordMetric(sessionId, 'event_log.gap_detected', gapSize);
      this.cache.delete(sessionId);
      cached = undefined;
      cacheHit = false;
      // Re-read from seq=0 so the fold sees a contiguous run.
      newEvents = await this.eventLog.getEventsSince(sessionId, 0);
    }

    let state: SessionState;
    let nextLastSeq: number;
    let invalidatedDuringFold = false;

    if (cached) {
      // Warm path. Fold the new tail onto the cached state. A
      // `checkpoint.restored` event in the new events drops the cache and
      // forces a cold re-reduce so the prompt sees post-restore state.
      const restoreIdx = indexOfRestore(newEvents);
      if (restoreIdx !== -1) {
        invalidatedDuringFold = true;
        cacheHit = false;
      } else {
        state = applyAll(cached.state, newEvents);
        nextLastSeq = newEvents.length > 0 ? newEvents[newEvents.length - 1]!.seq : lastSeq;
        this.cache.set(sessionId, { state, lastSeq: nextLastSeq });
        this.recordTiming(sessionId, t0, /*hit*/ true);
        return state;
      }
    }

    if (invalidatedDuringFold) {
      // Cache was invalidated mid-fold by checkpoint.restored. Cold
      // re-reduce from seq=0 so the fresh state reflects the restore.
      this.cache.delete(sessionId);
      newEvents = await this.eventLog.getEventsSince(sessionId, 0);
    }

    // Cold path.
    state = reduce(newEvents);
    nextLastSeq = newEvents.length > 0 ? newEvents[newEvents.length - 1]!.seq : 0;
    this.cache.set(sessionId, { state, lastSeq: nextLastSeq });
    this.recordTiming(sessionId, t0, cacheHit);
    return state;
  }

  /**
   * Drop any cached state for `sessionId`. The next `getSessionState` call
   * is a cold reduce. Idempotent — calling on an unknown session is a
   * no-op.
   */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  // ─── Diagnostics (used by tests) ─────────────────────────────

  /** Current cached `lastSeq` for a session, or `undefined` if no cache. */
  getCachedLastSeq(sessionId: string): number | undefined {
    return this.cache.get(sessionId)?.lastSeq;
  }

  /** Number of sessions currently held in cache. */
  getCacheSize(): number {
    return this.cache.size;
  }

  // ─── Internals ───────────────────────────────────────────────

  private recordTiming(sessionId: string, t0: number, hit: boolean): void {
    const dt = nowMs() - t0;
    this.recordMetric(sessionId, 'unified_state.cache_hit', hit ? 1 : 0);
    this.recordMetric(sessionId, 'unified_state.reduce_ms', dt);
  }

  private recordMetric(sessionId: string, key: string, value: number): void {
    // Telemetry is best-effort: a sink failure (e.g. SQLite busy) must
    // never propagate to the prompt-assembly path. Log once per call site
    // and continue.
    try {
      this.metrics.recordMetric(sessionId, key, value);
    } catch (err) {
      console.warn(
        `[unified-state-reducer] metric record failed (key=${key}):`,
        (err as Error)?.message,
      );
    }
  }
}

// ─── Module-scope helpers ──────────────────────────────────────

function applyAll(initial: SessionState, events: PipelineEvent[]): SessionState {
  let s = initial;
  for (const evt of events) {
    s = apply(s, evt);
  }
  return s;
}

function indexOfRestore(events: PipelineEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.kind === 'checkpoint.restored') return i;
  }
  return -1;
}

/**
 * Wall-clock timer used for `unified_state.reduce_ms`. Wrapped so tests
 * can inspect call sites; we deliberately use `performance.now()` when
 * available (millisecond fractional precision) and fall back to
 * `Date.now()` otherwise.
 */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
