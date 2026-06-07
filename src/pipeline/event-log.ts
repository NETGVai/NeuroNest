/**
 * Pipeline_Event_Log — append-only stream of every state-changing operation
 * in a session. Existing tool / task / error tables remain authoritative;
 * this log is parallel context used for prompt assembly and replay.
 *
 * Task 6 of the 12-factor-agent-improvements spec pinned the UUID strategy
 * (`uuidv7`, `^1`). Task 7 added the full `EventLog` writer: in-memory ring
 * buffer, batched flush, per-session `seq` allocation inside one SQLite
 * transaction, retry queue, and the read APIs `getEventsSince` /
 * `getLatestSeq` consumed by the Unified_State_Reducer.
 *
 * UUID strategy decision (per design.md → "UUID strategy decision"):
 *   - Chosen: `uuidv7` (npm), pinned to `^1` in package.json.
 *   - Reviewed: Apache-2.0 license, zero runtime dependencies, ~76 KB
 *     unpacked, 9 files, single active maintainer (LiosK), native
 *     TypeScript types.
 *   - Rationale: time-ordered IDs make the `(kind, session_id)` index useful
 *     for cross-session debugging. The per-session monotonic `seq` column
 *     is the canonical ordering key (Requirement 1.3); UUIDv7 is purely the
 *     `id` primary key.
 *   - Fallback: if the dependency is ever removed, swap `generateEventId`
 *     to `crypto.randomUUID()` (UUIDv4) and flip the strategy constant.
 *     All other code is unaffected because the reducer keys off `seq`.
 *
 * Requirements: 1.1, 1.2, 1.3, 6.7
 */

import type Database from 'better-sqlite3';
import { uuidv7 } from 'uuidv7';

// ─── UUID strategy ─────────────────────────────────────────────

/**
 * Module-level constant naming the active UUID strategy. Used by tests,
 * telemetry, and the migration that creates `pipeline_events` to assert
 * which scheme is in force. If the security review ever revokes `uuidv7`
 * approval, change this to `'uuidv4'` and switch `generateEventId` to
 * `crypto.randomUUID()`; `seq` keeps the reducer correct either way.
 */
export const UUID_STRATEGY: 'uuidv7' | 'uuidv4' = 'uuidv7';

/**
 * Generate a new event id under the active strategy. Centralised here so
 * every call site (EventLog writer, Dual_Write_Reconciler, tests) gets the
 * same generator and a future strategy change is a one-line edit.
 */
export function generateEventId(): string {
  return uuidv7();
}

// ─── Event kinds and value type ────────────────────────────────

/**
 * Discriminated union of every kind the EventLog writes. New kinds added
 * by future specs MUST extend this union AND be handled by the
 * Unified_State_Reducer's switch (or be tolerated by its forward-compat
 * default branch). The `tool.batch` kind is reserved for the
 * Compaction_Job (task 31) which collapses contiguous tool runs.
 */
export type EventKind =
  | 'chat.user'
  | 'chat.assistant'
  | 'tool.start'
  | 'tool.success'
  | 'tool.failure'
  | 'task.transition'
  | 'approval.created'
  | 'approval.decided'
  | 'error.captured'
  | 'checkpoint.created'
  | 'checkpoint.restored'
  | 'tool.batch';

/**
 * The shape returned by `getEventsSince`. Mirrors the `pipeline_events`
 * row except `payload` is parsed (the table stores `payload_json` as
 * TEXT). Field names use camelCase to match the rest of the TS codebase.
 */
export interface PipelineEvent {
  id: string;
  sessionId: string;
  seq: number;
  kind: EventKind;
  payload: unknown;
  createdAt: number;
}

// ─── Tunables ──────────────────────────────────────────────────

/** Max in-memory pending events before a synchronous force-flush. */
export const BUFFER_CAPACITY = 1000;

/** Max events held for retry after a failed flush. Older entries get dropped. */
export const RETRY_CAPACITY = 100;

/** Background flush cadence. */
export const FLUSH_INTERVAL_MS = 100;

// ─── Internal types ────────────────────────────────────────────

interface PendingEvent {
  id: string;
  sessionId: string;
  kind: EventKind;
  payload: unknown;
  createdAt: number;
}

interface RawRow {
  id: string;
  session_id: string;
  seq: number;
  kind: string;
  payload_json: string;
  created_at: number;
}

// ─── EventLog ──────────────────────────────────────────────────

/**
 * Single-writer EventLog. The Event_Bus_Bridge (`event-log.emit` IPC,
 * task 8) routes every renderer-side emit through one main-process
 * instance of this class so per-session `seq` allocation is race-free.
 *
 * Lifecycle:
 *   - `new EventLog(db)` prepares statements and starts the 100ms timer.
 *     Pass `{ autoStart: false }` to defer (used by tests that drive
 *     `flushNow` manually).
 *   - `emit({ sessionId, kind, payload })` enqueues into the ring buffer
 *     and resolves immediately. On overflow it force-flushes synchronously
 *     before resolving.
 *   - `flushNow()` drains the buffer (and the retry queue) inside a
 *     single SQLite transaction with per-session `MAX(seq)+1` allocation.
 *   - `close()` stops the timer and flushes one last time.
 *
 * Failure handling (per design.md "Error Handling"):
 *   - Per-event insert failure inside a batch: the offending event is
 *     pushed to the retry queue and the rest of the batch still commits.
 *   - Whole-transaction failure: the entire batch is pushed to the retry
 *     queue and re-attempted on the next flush.
 *   - Retry-queue overflow (cap 100): the oldest entry is dropped, a
 *     warning is logged, and `event_log.dropped_events` is incremented.
 */
export class EventLog {
  private readonly db: Database.Database;
  private readonly buffer: PendingEvent[] = [];
  private readonly retryQueue: PendingEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private droppedEvents = 0;
  private overflowFlushes = 0;

  // Prepared statements (race-free thanks to better-sqlite3 single-thread model).
  private readonly stmtMaxSeq: Database.Statement;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetSince: Database.Statement;
  private readonly stmtGetLatest: Database.Statement;

  constructor(db: Database.Database, opts: { autoStart?: boolean } = {}) {
    this.db = db;

    this.stmtMaxSeq = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM pipeline_events WHERE session_id = ?',
    );
    this.stmtInsert = db.prepare(
      'INSERT INTO pipeline_events (id, session_id, seq, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.stmtGetSince = db.prepare(
      'SELECT id, session_id, seq, kind, payload_json, created_at FROM pipeline_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
    );
    this.stmtGetLatest = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM pipeline_events WHERE session_id = ?',
    );

    if (opts.autoStart !== false) {
      this.start();
    }
  }

  /** Start the background flush timer. Idempotent. */
  start(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setInterval(() => {
      try {
        this.flushNow();
      } catch (err) {
        // Defensive: never let a flush exception escape the timer callback
        // and crash the host process. The retry queue absorbs the failure.
        console.warn('[event-log] flush tick threw:', (err as Error)?.message);
      }
    }, FLUSH_INTERVAL_MS);
    // Don't keep the Node event loop alive solely for the flush timer;
    // tests and CLI exits should not hang on this interval.
    if (typeof (this.flushTimer as { unref?: () => unknown }).unref === 'function') {
      (this.flushTimer as { unref: () => unknown }).unref();
    }
  }

  /** Stop the background flush timer. Idempotent. Pending events stay in memory. */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Stop the timer and synchronously flush remaining events one final time.
   * Useful in tests and during graceful shutdown. Subsequent `emit` calls
   * still enqueue, but no automatic flush will happen — call `flushNow`.
   */
  close(): void {
    this.stop();
    this.flushNow();
    this.closed = true;
  }

  /**
   * Enqueue an event for the next flush. Resolves immediately after enqueue
   * (Promise wrapper kept for parity with the design signature and to keep
   * the IPC bridge fire-and-forget on the renderer side).
   *
   * On buffer overflow (> 1000 pending) a synchronous flush is forced
   * before this method returns; design.md "Error Handling" calls this out
   * explicitly.
   */
  emit(input: { sessionId: string; kind: EventKind; payload: unknown }): Promise<void> {
    const pending: PendingEvent = {
      id: generateEventId(),
      sessionId: input.sessionId,
      kind: input.kind,
      payload: input.payload,
      createdAt: Date.now(),
    };
    this.buffer.push(pending);

    if (this.buffer.length > BUFFER_CAPACITY) {
      this.overflowFlushes++;
      // eslint-disable-next-line no-console
      console.warn(
        `[event-log] buffer overflow (${this.buffer.length} > ${BUFFER_CAPACITY}); forcing synchronous flush`,
      );
      try {
        this.flushNow();
      } catch (err) {
        console.warn('[event-log] forced flush threw:', (err as Error)?.message);
      }
    }

    return Promise.resolve();
  }

  /**
   * Drain the retry queue and the in-memory buffer in one SQLite
   * transaction. Per-session `seq` is allocated by `MAX(seq)+1` inside
   * the same transaction, then cached in a local map for the rest of
   * this batch so repeated MAX queries are unnecessary.
   *
   * Per-event insert failures are caught and pushed to the retry queue;
   * the rest of the batch still commits. A whole-transaction failure
   * (rare; SQLite busy / disk full / etc.) re-enqueues everything.
   */
  flushNow(): void {
    if (this.buffer.length === 0 && this.retryQueue.length === 0) return;

    // Retries first so they don't get starved when the buffer is full.
    const batch: PendingEvent[] = [];
    while (this.retryQueue.length > 0) {
      const next = this.retryQueue.shift();
      if (next) batch.push(next);
    }
    while (this.buffer.length > 0) {
      const next = this.buffer.shift();
      if (next) batch.push(next);
    }

    if (batch.length === 0) return;

    const failures: PendingEvent[] = [];
    const seqCounters = new Map<string, number>();

    const writeBatch = this.db.transaction((events: PendingEvent[]) => {
      for (const evt of events) {
        let prev = seqCounters.get(evt.sessionId);
        if (prev === undefined) {
          const row = this.stmtMaxSeq.get(evt.sessionId) as { s: number } | undefined;
          prev = row?.s ?? 0;
        }
        const nextSeq = prev + 1;
        try {
          this.stmtInsert.run(
            evt.id,
            evt.sessionId,
            nextSeq,
            evt.kind,
            JSON.stringify(evt.payload ?? null),
            evt.createdAt,
          );
          seqCounters.set(evt.sessionId, nextSeq);
        } catch (err) {
          // Per design: per-event failures don't roll back the rest of the
          // batch. Capture and let the for-loop continue. Don't advance
          // the seq counter — the next event in this session reuses the
          // same `prev`, which is still correct because this insert didn't
          // commit.
          console.warn(
            `[event-log] event insert failed (kind=${evt.kind} session=${evt.sessionId}):`,
            (err as Error)?.message,
          );
          failures.push(evt);
        }
      }
    });

    try {
      writeBatch(batch);
    } catch (err) {
      // Whole-transaction failure: SQLite rolled everything back. Retry
      // the entire batch on the next flush.
      console.warn('[event-log] batch transaction failed:', (err as Error)?.message);
      this.enqueueRetry(batch);
      return;
    }

    if (failures.length > 0) {
      // Defensive second pass per design ("seq allocation collision"):
      // attempt each failure individually with a fresh MAX+1 lookup. If it
      // still fails, push to the retry queue.
      this.retryFailedEventsOnce(failures);
    }
  }

  /**
   * Read events with `seq > sinceSeq` for the given session, ordered by
   * `seq` ASC. Drains pending writes first so the caller observes
   * everything that has been emitted up to this call.
   *
   * The reducer's gap-detection logic relies on this method returning
   * a contiguous run; `seq` monotonicity is enforced by the table's
   * UNIQUE(session_id, seq) constraint plus the single-writer rule.
   */
  async getEventsSince(sessionId: string, sinceSeq: number): Promise<PipelineEvent[]> {
    this.flushNow();
    const rows = this.stmtGetSince.all(sessionId, sinceSeq) as RawRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      kind: r.kind as EventKind,
      payload: parsePayload(r.payload_json),
      createdAt: r.created_at,
    }));
  }

  /**
   * Return the largest committed `seq` for a session, or 0 if none.
   * Drains pending writes first so the answer reflects everything
   * `emit`-ted prior to this call.
   */
  async getLatestSeq(sessionId: string): Promise<number> {
    this.flushNow();
    const row = this.stmtGetLatest.get(sessionId) as { s: number } | undefined;
    return row?.s ?? 0;
  }

  // ─── Diagnostics (used by tests + the rollout-gate metrics) ──

  /** Total events dropped from the retry queue due to overflow. */
  getDroppedEventsCount(): number {
    return this.droppedEvents;
  }

  /** Number of times the in-memory buffer overflowed and forced a sync flush. */
  getOverflowFlushCount(): number {
    return this.overflowFlushes;
  }

  /** Current pending count (post-emit, pre-flush). */
  getBufferLength(): number {
    return this.buffer.length;
  }

  /** Current retry-queue length. */
  getRetryQueueLength(): number {
    return this.retryQueue.length;
  }

  // ─── Internals ───────────────────────────────────────────────

  private retryFailedEventsOnce(events: PendingEvent[]): void {
    const stillFailed: PendingEvent[] = [];
    for (const evt of events) {
      try {
        const writeOne = this.db.transaction((e: PendingEvent) => {
          const row = this.stmtMaxSeq.get(e.sessionId) as { s: number } | undefined;
          const seq = (row?.s ?? 0) + 1;
          this.stmtInsert.run(
            e.id,
            e.sessionId,
            seq,
            e.kind,
            JSON.stringify(e.payload ?? null),
            e.createdAt,
          );
        });
        writeOne(evt);
      } catch (err) {
        console.warn(
          `[event-log] retry-once failed (kind=${evt.kind} session=${evt.sessionId}):`,
          (err as Error)?.message,
        );
        stillFailed.push(evt);
      }
    }
    if (stillFailed.length > 0) {
      this.enqueueRetry(stillFailed);
    }
  }

  private enqueueRetry(events: PendingEvent[]): void {
    for (const evt of events) {
      this.retryQueue.push(evt);
    }
    while (this.retryQueue.length > RETRY_CAPACITY) {
      const dropped = this.retryQueue.shift();
      this.droppedEvents++;
      console.warn(
        `[event-log] retry-queue overflow; dropping id=${dropped?.id} kind=${dropped?.kind}`,
      );
    }
  }
}

/**
 * Defensive payload parser. The writer always JSON-encodes valid values, but
 * a manual SQL edit or a corrupted row should not crash the reducer — return
 * `null` and let the reducer's default branch ignore the unknown kind.
 */
function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
