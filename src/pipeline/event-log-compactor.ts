/**
 * Compaction_Job — daily background pass that collapses long runs of
 * old `tool.start` / `tool.success` pairs into a single `tool.batch`
 * event so the `pipeline_events` table doesn't grow without bound for
 * long-lived sessions.
 *
 * Trigger conditions (per design.md "Compaction_Job"):
 *   - Session has more than 10000 events, OR
 *   - Session contains events older than 30 days.
 *
 * Algorithm (per design.md + tasks.md task 31):
 *   1. Identify candidate sessions via two SQL aggregations.
 *   2. For each candidate, walk its events in `seq` order and find
 *      maximal contiguous runs of `tool.start` → `tool.success` pairs
 *      where every event in the run is older than 7 days. Pairs are
 *      joined by `callId` in the payload; runs share the same tool
 *      `name`.
 *   3. Replace each run with a single `tool.batch` event:
 *        { count, summary, fromSeq, toSeq }
 *      where `summary` is `"<count>x <toolName>"`. The new event takes
 *      the lowest `seq` in the run; the original rows are deleted in
 *      the same transaction so `seq` ordering is preserved (the gap
 *      between the batch's `seq` and the next surviving row's `seq` is
 *      acceptable — `seq` is monotone, not contiguous).
 *   4. Emit `event_log.compacted_events` to Metrics_Sink with the
 *      total number of original events collapsed.
 *
 * Protected kinds (NEVER touched, per Requirement 1.5):
 *   - `chat.*`        — conversational record kept verbatim.
 *   - `error.*`       — debugging trail kept verbatim.
 *   - `approval.*`    — audit trail kept verbatim.
 *   - `checkpoint.*`  — git-ref correlation kept verbatim.
 *   Existing `tool.batch` events are also left alone (re-batching is
 *   a no-op).
 *
 * Idempotency: a second pass over the same session finds zero
 * eligible runs because every collapsed run has been replaced with a
 * single `tool.batch`, which is not a `tool.start`. Compaction is
 * therefore safe to re-run without producing extra metrics or extra
 * mutations.
 *
 * Failure handling: a per-session transaction error rolls the whole
 * session back. The compactor logs a warning, increments
 * `event_log.compaction_session_failed`, and moves on. The session
 * gets retried on the next daily run because its event count or age
 * still meets the threshold.
 *
 * Requirements: 1.5
 */

import type Database from 'better-sqlite3';

import { logger } from '../utils/logger';
import type { SessionTelemetryService } from '../session/session-telemetry';
import type { EventKind } from './event-log';
import { sanitizeToolMessages, type ChatMessage } from './tool-message-sanitizer';
import { recordDroppedMessages } from './tool-sanitizer-telemetry';

// ─── Tunables (exported for tests / future overrides) ─────────────

/** Sessions with more events than this are considered for compaction. */
export const SESSION_EVENT_COUNT_THRESHOLD = 10_000;

/** Sessions containing events older than this are considered for compaction. */
export const SESSION_AGE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Only events older than this are eligible to be folded into a batch. */
export const COMPACTION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Minimum run length worth replacing — a single pair would not save storage. */
const MIN_RUN_LENGTH = 2;

/**
 * Result of a `runCompaction` call. Both counters are useful — the
 * dashboard plots `eventsCollapsed` against time and the gate script
 * surfaces `sessionsProcessed` so a stuck job is visible.
 */
export interface CompactionResult {
  /** Number of distinct sessions for which at least one batch event was written. */
  sessionsProcessed: number;
  /** Total number of original events collapsed across all sessions. */
  eventsCollapsed: number;
}

/** Raw row shape pulled from `pipeline_events` during compaction. */
interface CompactorRow {
  id: string;
  session_id: string;
  seq: number;
  kind: string;
  payload_json: string;
  created_at: number;
}

/**
 * One contiguous run identified for collapse. The compactor builds an
 * array of these per session and applies them inside a single
 * transaction so a partial write is impossible.
 */
interface ToolRun {
  /** Tool name common to every pair in the run. */
  toolName: string;
  /** Number of `tool.start`/`tool.success` PAIRS in the run. */
  pairCount: number;
  /** Original event ids that belong to this run (start + success, in order). */
  eventIds: string[];
  /** Lowest `seq` of any event in the run — the batch event takes this. */
  fromSeq: number;
  /** Highest `seq` of any event in the run. */
  toSeq: number;
  /** Earliest `created_at` of any event in the run — the batch inherits this. */
  createdAt: number;
}

/**
 * Daily event-log compactor. Wired into `cron-scheduler.ts` as an
 * internal task that fires at 03:30 local time (after the
 * `metric_samples` prune at 03:00).
 */
export class EventLogCompactor {
  private readonly db: Database.Database;
  private readonly metrics: SessionTelemetryService | undefined;

  // Prepared statements for the hot path. The candidate-session queries
  // are issued once per `runCompaction`; the per-session statements run
  // once per candidate. SQLite's better-sqlite3 driver caches plans on
  // these handles for the life of the compactor.
  private readonly stmtSessionsByCount: Database.Statement;
  private readonly stmtSessionsByAge: Database.Statement;
  private readonly stmtSessionEvents: Database.Statement;
  private readonly stmtInsertBatch: Database.Statement;
  private readonly stmtDeleteEvent: Database.Statement;

  constructor(db: Database.Database, metrics?: SessionTelemetryService) {
    this.db = db;
    this.metrics = metrics;

    // Sessions whose total event count exceeds the threshold. The
    // GROUP BY + HAVING is index-friendly because the table is sorted
    // by (session_id, seq) under `idx_pe_session_seq`.
    this.stmtSessionsByCount = db.prepare(
      `SELECT session_id FROM pipeline_events
         GROUP BY session_id
         HAVING COUNT(*) > ?`,
    );

    // Sessions containing at least one event older than the age
    // threshold. DISTINCT collapses the per-event match down to one
    // row per session.
    this.stmtSessionsByAge = db.prepare(
      `SELECT DISTINCT session_id FROM pipeline_events
         WHERE created_at < ?`,
    );

    // Walk a single session in seq order. The compactor needs every
    // column so the surviving batch event can inherit the right
    // metadata.
    this.stmtSessionEvents = db.prepare(
      `SELECT id, session_id, seq, kind, payload_json, created_at
         FROM pipeline_events
         WHERE session_id = ?
         ORDER BY seq ASC`,
    );

    // INSERT the new `tool.batch` row. It re-uses one of the deleted
    // rows' `id` values so the (session_id, seq) UNIQUE constraint is
    // satisfied without an extra read.
    this.stmtInsertBatch = db.prepare(
      `INSERT INTO pipeline_events (id, session_id, seq, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );

    // Delete one event by primary key. Called many times per run
    // inside a single transaction — the prepared form keeps each
    // delete a single bytecode dispatch.
    this.stmtDeleteEvent = db.prepare(`DELETE FROM pipeline_events WHERE id = ?`);
  }

  /**
   * Run a full compaction pass across all candidate sessions. Returns
   * the aggregate counters; the same numbers are also recorded as
   * Metrics_Sink samples so the dashboard can plot them over time.
   *
   * Designed to run once per day from the cron scheduler. Safe to call
   * manually from tests or a CLI repair tool.
   */
  async runCompaction(): Promise<CompactionResult> {
    const now = Date.now();
    const ageCutoff = now - COMPACTION_AGE_MS;
    const candidates = this.findCandidateSessions(now);

    let sessionsProcessed = 0;
    let eventsCollapsed = 0;

    for (const sessionId of candidates) {
      try {
        const collapsed = this.compactSession(sessionId, ageCutoff);
        if (collapsed > 0) {
          sessionsProcessed++;
          eventsCollapsed += collapsed;
        }
      } catch (err) {
        logger.warn(
          `[event-log-compactor] session "${sessionId}" failed:`,
          (err as Error)?.message,
        );
        try {
          this.metrics?.recordMetric(sessionId, 'event_log.compaction_session_failed', 1);
        } catch {
          // Metrics_Sink failures are non-fatal — the warn above is
          // already on the operator's radar.
        }
      }
    }

    // Always record the metric — zero is meaningful (it confirms the
    // job ran without finding eligible runs, which is the steady-state
    // for short-lived sessions).
    try {
      this.metrics?.recordMetric(null, 'event_log.compacted_events', eventsCollapsed);
    } catch (err) {
      logger.warn(
        '[event-log-compactor] metrics emit failed:',
        (err as Error)?.message,
      );
    }

    return { sessionsProcessed, eventsCollapsed };
  }

  // ─── Read-side materialization (Feature 3 integration site) ──

  /**
   * Materialize a session's persisted event stream into the provider-facing
   * `ChatMessage[]` used for prompt assembly / replay, then sanitize that
   * view before returning it.
   *
   * This is a READ-SIDE-ONLY operation (Requirement 21 + Requirement 22.2):
   * it replays rows from `pipeline_events` via the read-only
   * `stmtSessionEvents` statement and returns `sanitizeToolMessages(replayed)`.
   * The persisted event rows are NEVER mutated — the sanitizer only shapes
   * the materialized array handed to the caller, leaving the append-only log
   * untouched. (Compaction's write path in `compactSession` is the only place
   * that mutates rows, and it does not call this method.)
   *
   * Replay mapping (walked in `seq` order):
   *   - `chat.user`      → `{ role: 'user', content: body }`
   *   - `chat.assistant` → `{ role: 'assistant', content: body, tool_calls? }`
   *   - `tool.start`     → appended as a `tool_calls` entry (id = `callId`,
   *                        function.name = `name`) on the most recent
   *                        assistant message
   *   - `tool.success`   → `{ role: 'tool', content: result, tool_call_id }`
   *   - `tool.failure`   → `{ role: 'tool', content: error,  tool_call_id }`
   *   - protected kinds (`error.*`, `approval.*`, `checkpoint.*`,
   *     `task.transition`) and the compaction artifact `tool.batch` are not
   *     part of the provider-facing transcript and are skipped.
   *
   * Never throws: malformed payloads are skipped. Returns `[]` for an
   * unknown or empty session.
   *
   * Requirements: 21
   */
  materialize(sessionId: string): ChatMessage[] {
    const rows = this.stmtSessionEvents.all(sessionId) as CompactorRow[];
    if (rows.length === 0) return [];

    const replayed: ChatMessage[] = [];
    // Reference to the most recent assistant message so `tool.start` events
    // can attach their tool-call entries to it.
    let currentAssistant:
      | (ChatMessage & { tool_calls?: { id: string; function: { name: string } }[] })
      | null = null;

    for (const row of rows) {
      switch (row.kind) {
        case 'chat.user': {
          const body = extractStringField(row.payload_json, 'body') ?? '';
          replayed.push({ role: 'user', content: body } as ChatMessage);
          currentAssistant = null;
          break;
        }

        case 'chat.assistant': {
          const body = extractStringField(row.payload_json, 'body') ?? '';
          const msg = { role: 'assistant', content: body } as ChatMessage & {
            tool_calls?: { id: string; function: { name: string } }[];
          };
          replayed.push(msg);
          currentAssistant = msg;
          break;
        }

        case 'tool.start': {
          const callId = extractCallId(row.payload_json);
          const name = extractToolName(row.payload_json);
          if (callId && name && currentAssistant) {
            if (!currentAssistant.tool_calls) {
              currentAssistant.tool_calls = [];
            }
            currentAssistant.tool_calls.push({ id: callId, function: { name } });
          }
          break;
        }

        case 'tool.success':
        case 'tool.failure': {
          const callId = extractCallId(row.payload_json);
          if (callId) {
            const content = extractToolResultContent(row.payload_json);
            // `role: 'tool'` is not part of the static ChatMessage role union
            // (system | user | assistant) but is what the sanitizer keys off
            // — cast as the task allows.
            replayed.push({
              role: 'tool',
              content,
              tool_call_id: callId,
            } as unknown as ChatMessage);
          }
          break;
        }

        default:
          // Protected kinds and `tool.batch` are not part of the
          // provider-facing transcript — skip them.
          break;
      }
    }

    // Read-side sanitize only. The persisted `pipeline_events` rows are
    // never touched by this path (Requirement 22.2).
    const sanitized = sanitizeToolMessages(replayed);

    // F3 telemetry (Requirement 22.3): when the sanitizer removed one or more
    // messages from the materialized transcript, record the drop count to the
    // Metrics_Sink. Reuses the compactor's existing SessionTelemetryService
    // (`metrics`), which structurally satisfies the MetricsSink contract.
    // Fail-soft — never affects the materialized array.
    recordDroppedMessages(this.metrics, replayed.length - sanitized.length, sessionId);

    return sanitized;
  }

  // ─── Candidate selection ─────────────────────────────────────

  /**
   * Union of "sessions over the event-count threshold" and "sessions
   * with any event older than the age threshold". Returned as a plain
   * array for deterministic iteration order in tests.
   */
  private findCandidateSessions(now: number): string[] {
    const ageCutoff = now - SESSION_AGE_THRESHOLD_MS;
    const seen = new Set<string>();

    const byCount = this.stmtSessionsByCount.all(SESSION_EVENT_COUNT_THRESHOLD) as {
      session_id: string;
    }[];
    for (const row of byCount) {
      if (row.session_id) seen.add(row.session_id);
    }

    const byAge = this.stmtSessionsByAge.all(ageCutoff) as { session_id: string }[];
    for (const row of byAge) {
      if (row.session_id) seen.add(row.session_id);
    }

    return Array.from(seen);
  }

  // ─── Per-session compaction ──────────────────────────────────

  /**
   * Compact a single session. Returns the number of original events
   * collapsed (zero means no eligible runs were found). All mutations
   * happen inside a single transaction so a partial write is
   * impossible — either the session is fully compacted or its rows
   * are untouched.
   */
  private compactSession(sessionId: string, ageCutoff: number): number {
    const rows = this.stmtSessionEvents.all(sessionId) as CompactorRow[];
    if (rows.length === 0) return 0;

    const runs = this.identifyRuns(rows, ageCutoff);
    if (runs.length === 0) return 0;

    let collapsed = 0;
    const apply = this.db.transaction((collapseRuns: ToolRun[]) => {
      for (const run of collapseRuns) {
        // Re-use the FIRST event id of the run for the new batch row
        // so the UNIQUE(session_id, seq) constraint stays satisfied
        // when we DELETE the rest. The remaining ids get deleted.
        const [batchId, ...obsoleteIds] = run.eventIds;
        const payload = JSON.stringify({
          count: run.pairCount,
          summary: `${run.pairCount}x ${run.toolName}`,
          fromSeq: run.fromSeq,
          toSeq: run.toSeq,
        });

        // Delete all originals first (including the one whose id we'll
        // re-use) so the INSERT does not collide on the PRIMARY KEY.
        this.stmtDeleteEvent.run(batchId);
        for (const id of obsoleteIds) {
          this.stmtDeleteEvent.run(id);
        }

        this.stmtInsertBatch.run(
          batchId,
          sessionId,
          run.fromSeq,
          'tool.batch' satisfies EventKind,
          payload,
          run.createdAt,
        );
        // pairCount * 2 originals replaced by 1 batch — count the
        // originals that disappeared so the metric reflects the
        // storage savings.
        collapsed += run.pairCount * 2;
      }
    });

    apply(runs);
    return collapsed;
  }

  /**
   * Walk a session's events in `seq` order and identify maximal
   * contiguous runs of `tool.start` → `tool.success` pairs that share
   * the same tool name and lie entirely older than `ageCutoff`.
   *
   * Rules:
   *   - A run is broken by ANY non-tool-start/non-tool-success event
   *     (including protected kinds, `tool.failure`, `tool.batch`, or
   *     unrelated tool calls).
   *   - A run is broken when the next pair's `name` differs from the
   *     current run's name. Same-name runs of length ≥ MIN_RUN_LENGTH
   *     pairs are emitted; shorter runs are dropped.
   *   - A run is broken if any constituent event is younger than
   *     `ageCutoff`. The run accumulated up to that point is still
   *     emitted if it meets the minimum length.
   *   - A `tool.start` whose matching `tool.success` is missing (e.g.
   *     a `tool.failure` came instead) breaks the run — partial pairs
   *     are never collapsed because the failure event is part of the
   *     audit trail.
   */
  private identifyRuns(rows: CompactorRow[], ageCutoff: number): ToolRun[] {
    const runs: ToolRun[] = [];
    let i = 0;

    while (i < rows.length) {
      const start = rows[i];
      if (!start) {
        i++;
        continue;
      }

      // Only `tool.start` can open a run. Anything else (including
      // protected kinds, `tool.batch`, or `tool.success` / `tool.failure`
      // without a matching predecessor) advances the cursor.
      if (start.kind !== 'tool.start') {
        i++;
        continue;
      }

      // The matching success must be the very next event (no
      // interleaving — the spec says "contiguous"). If the pair
      // crosses the age cutoff, we can't include it.
      const next = rows[i + 1];
      if (!next || next.kind !== 'tool.success') {
        i++;
        continue;
      }

      const startCallId = extractCallId(start.payload_json);
      const successCallId = extractCallId(next.payload_json);
      if (!startCallId || startCallId !== successCallId) {
        // Mismatched callIds means these two rows are not actually a
        // pair — the orchestrator interleaved another tool. Skip the
        // start; the success will be skipped on the next iteration
        // because it cannot open a run.
        i++;
        continue;
      }

      const toolName = extractToolName(start.payload_json);
      if (!toolName) {
        i++;
        continue;
      }

      if (start.created_at >= ageCutoff || next.created_at >= ageCutoff) {
        // Pair too recent; do not include in a run. Advance past the
        // pair so we don't re-evaluate it.
        i += 2;
        continue;
      }

      // Greedily extend the run as long as the next two events form
      // another start/success pair for the same tool, both older than
      // the cutoff.
      const eventIds: string[] = [start.id, next.id];
      let pairCount = 1;
      let fromSeq = start.seq;
      let toSeq = next.seq;
      let createdAt = start.created_at;

      let cursor = i + 2;
      while (cursor + 1 < rows.length) {
        const s = rows[cursor];
        const e = rows[cursor + 1];
        if (!s || !e) break;

        if (s.kind !== 'tool.start' || e.kind !== 'tool.success') break;
        if (s.created_at >= ageCutoff || e.created_at >= ageCutoff) break;

        const sCallId = extractCallId(s.payload_json);
        const eCallId = extractCallId(e.payload_json);
        if (!sCallId || sCallId !== eCallId) break;

        const sName = extractToolName(s.payload_json);
        if (sName !== toolName) break;

        eventIds.push(s.id, e.id);
        pairCount++;
        if (s.seq < fromSeq) fromSeq = s.seq;
        if (e.seq > toSeq) toSeq = e.seq;
        if (s.created_at < createdAt) createdAt = s.created_at;
        cursor += 2;
      }

      if (pairCount >= MIN_RUN_LENGTH) {
        runs.push({
          toolName,
          pairCount,
          eventIds,
          fromSeq,
          toSeq,
          createdAt,
        });
      }

      // Whether or not the run was emitted, advance past every event
      // we examined so we don't re-check them on the next iteration.
      i = cursor;
    }

    return runs;
  }
}

// ─── Module-level helpers ────────────────────────────────────

/**
 * Pull `callId` out of a JSON-encoded payload without parsing the full
 * object when a string-search will do. The compactor walks every event
 * row in long sessions, so the constant-factor savings add up.
 *
 * Falls back to `JSON.parse` if the fast path fails — handles unusual
 * encodings (escaped quotes, reordered keys) without assuming the
 * shape that the live emitter currently uses.
 */
function extractCallId(payloadJson: string): string | null {
  // Fast path: most payloads are emitted as { callId, name, ... } with
  // callId at the start. A literal substring match is ~5x faster than
  // JSON.parse on the typical 80-char payload.
  const fastMatch = payloadJson.match(/"callId"\s*:\s*"([^"\\]*)"/);
  if (fastMatch && typeof fastMatch[1] === 'string') return fastMatch[1];

  try {
    const obj = JSON.parse(payloadJson);
    if (obj && typeof obj === 'object' && typeof obj.callId === 'string') {
      return obj.callId;
    }
  } catch {
    // Corrupt payloads return null; the caller treats that as
    // "not a valid pair" and skips the run.
  }
  return null;
}

/** Pull `name` out of a JSON-encoded `tool.start` payload. */
function extractToolName(payloadJson: string): string | null {
  const fastMatch = payloadJson.match(/"name"\s*:\s*"([^"\\]*)"/);
  if (fastMatch && typeof fastMatch[1] === 'string') return fastMatch[1];

  try {
    const obj = JSON.parse(payloadJson);
    if (obj && typeof obj === 'object' && typeof obj.name === 'string') {
      return obj.name;
    }
  } catch {
    // Same handling as `extractCallId`: unparseable payloads cannot
    // open a run.
  }
  return null;
}

/**
 * Pull an arbitrary string field out of a JSON-encoded payload. Used by the
 * read-side `materialize` path to recover `chat.*` message bodies. Returns
 * `null` when the field is absent or the payload cannot be parsed — the
 * caller substitutes the empty string so a malformed row never breaks the
 * materialized transcript.
 */
function extractStringField(payloadJson: string, key: string): string | null {
  try {
    const obj = JSON.parse(payloadJson);
    if (obj && typeof obj === 'object') {
      const v = (obj as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
    }
  } catch {
    // Corrupt payloads yield null; caller defaults to ''.
  }
  return null;
}

/**
 * Derive the provider-facing `content` string for a `tool.success` /
 * `tool.failure` event on the read-side `materialize` path. Prefers a
 * `result` field, then an `output` field, then a stringified `error`. Falls
 * back to the empty string. Never throws.
 */
function extractToolResultContent(payloadJson: string): string {
  try {
    const obj = JSON.parse(payloadJson);
    if (obj && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      if (typeof rec.result === 'string') return rec.result;
      if (typeof rec.output === 'string') return rec.output;
      if (rec.error !== undefined) {
        return typeof rec.error === 'string' ? rec.error : JSON.stringify(rec.error);
      }
      if (rec.result !== undefined) return JSON.stringify(rec.result);
    }
  } catch {
    // Corrupt payloads materialize as empty content; the message is still a
    // structurally valid tool reply for sanitizer purposes.
  }
  return '';
}
