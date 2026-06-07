/**
 * Dual_Write_Reconciler — startup pass that closes any gap between the
 * authoritative tables (`agent_tasks`, `subagent_tasks`, `pipeline_traces`)
 * and the `pipeline_events` log.
 *
 * Why it exists: the EventLog writer can fail mid-batch (SQLite busy, disk
 * full, host crash, retry-queue overflow). When that happens the
 * authoritative table commit succeeds but the matching Pipeline_Event is
 * never persisted. On the next startup this reconciler walks each
 * in-scope table, finds rows newer than the most-recent matching
 * `pipeline_events.created_at` for the same `(session_id, kind)` pair,
 * and replays equivalent events directly into `pipeline_events` —
 * bypassing the EventLog buffer so reconciliation completes in a single
 * synchronous pass before chat IPC is exposed.
 *
 * Idempotency: re-runs replay zero events. After the first pass the
 * `pipeline_events.created_at` high-watermark for each `(session_id,
 * kind)` advances past every authoritative row, so the gap-window query
 * returns empty.
 *
 * Scope (per design.md "Dual_Write_Reconciler" + Requirement 6.8):
 *   • `agent_tasks`         → `task.transition` events
 *   • `subagent_tasks`      → `task.transition` events
 *   • `pipeline_traces`     → `tool.start` (+ optional `tool.success`)
 *   • git refs              → `refs/neuronest/turn/*` → `checkpoint.created`
 *   • Approval_Queue        → in-memory only, skipped with a debug log
 *
 * Tables introduced after this spec ships SHALL be added to the
 * reconciler scope by the spec that introduces them.
 *
 * Requirements: 6.8
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { logger } from '../utils/logger';
import type { SessionTelemetryService } from '../session/session-telemetry';
import type { EventLog, EventKind } from './event-log';

/**
 * Result counters returned from `runOnStartup`. The counts feed two
 * Metrics_Sink series:
 *   - `event_log.reconciled`            — cumulative replayed-row count
 *   - `event_log.reconciler_unmatched`  — cumulative unmatchable-row count
 * Either one being non-zero is a signal worth surfacing on the dashboard;
 * `unmatched > 0` is an error-level log line because it points at true
 * data loss.
 */
export interface ReconcilerSummary {
  reconciled: number;
  unmatched: number;
}

/**
 * Optional dependencies. The constructor accepts them so tests can swap
 * the Metrics_Sink for a spy and so an integration suite can run the
 * reconciler against a real `EventLog` without owning startup wiring.
 */
export interface DualWriteReconcilerOptions {
  /**
   * Working directory used for git ref enumeration. Defaults to
   * `process.cwd()`. Tests pass a temp repo so they can drive the
   * `refs/neuronest/turn/*` flow deterministically without touching the
   * project's real git state.
   */
  cwd?: string;
  /**
   * If set to false, skips the git-refs reconciliation entirely. Used by
   * tests that don't need the (slower) git pass and by environments
   * where git isn't installed.
   */
  enableGitRefs?: boolean;
}

/**
 * Per-table reconciliation plan. Documents the mapping at one place so
 * the algorithm and the design document don't drift apart.
 */
interface TableReconcilerPlan {
  table: string;
  /**
   * Pipeline_Event kinds that describe rows from this table. The first
   * entry is the canonical kind used to compute the high-watermark; the
   * rest are kinds emitted as a side-effect (e.g. a single
   * `pipeline_traces` row may emit both `tool.start` and `tool.success`,
   * but the high-watermark is keyed off `tool.start` because a partially
   * inserted trace will always have produced the start event before the
   * end event).
   */
  kinds: EventKind[];
}

/** In-scope authoritative tables. Adjust here when new tables are added. */
const PLANS: TableReconcilerPlan[] = [
  { table: 'agent_tasks', kinds: ['task.transition'] },
  { table: 'subagent_tasks', kinds: ['task.transition'] },
  { table: 'pipeline_traces', kinds: ['tool.start', 'tool.success'] },
];

/**
 * Synthetic tool name used when a `pipeline_traces` row is replayed. The
 * value is deliberately namespaced so reducer consumers and dashboard
 * filters can distinguish reconstructed traces from real tool calls.
 */
const PIPELINE_TRACE_TOOL_NAME = 'pipeline.trace';

/** Default value used for the `by` field when a row's owner can't be derived. */
const DEFAULT_TASK_TRANSITION_BY = 'reconciler';

/**
 * Direct, synchronous reconciler. The constructor takes an `EventLog`
 * for type-symmetry with the rest of the spec, but `runOnStartup` writes
 * to `pipeline_events` itself: it needs deterministic, ordered, single-
 * transaction inserts that the buffered `emit` path cannot guarantee.
 */
export class DualWriteReconciler {
  private readonly db: Database.Database;
  private readonly eventLog: EventLog;
  private readonly metrics: SessionTelemetryService;
  private readonly cwd: string;
  private readonly enableGitRefs: boolean;

  // Prepared statements for the hot path. Kept short so the reads are
  // explicit and the indexes (`idx_pe_kind_session`) are obviously hit.
  private readonly stmtLatestEventTimestamp: Database.Statement;
  private readonly stmtMaxSeq: Database.Statement;
  private readonly stmtInsertEvent: Database.Statement;
  private readonly stmtCheckpointExists: Database.Statement;

  constructor(
    db: Database.Database,
    eventLog: EventLog,
    metrics: SessionTelemetryService,
    opts: DualWriteReconcilerOptions = {},
  ) {
    this.db = db;
    this.eventLog = eventLog;
    this.metrics = metrics;
    this.cwd = opts.cwd ?? process.cwd();
    this.enableGitRefs = opts.enableGitRefs ?? true;

    // Most-recent `pipeline_events.created_at` for a given (session_id,
    // kind) pair. Hits `idx_pe_kind_session`. Returns 0 when the pair
    // has never been seen, which makes the gap window the entire table.
    this.stmtLatestEventTimestamp = db.prepare(
      'SELECT COALESCE(MAX(created_at), 0) AS ts FROM pipeline_events WHERE session_id = ? AND kind = ?',
    );

    // Per-session monotonic seq allocator. Identical to EventLog's
    // statement so the reconciler interleaves correctly with whatever
    // partial state the previous run left behind.
    this.stmtMaxSeq = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM pipeline_events WHERE session_id = ?',
    );

    this.stmtInsertEvent = db.prepare(
      'INSERT INTO pipeline_events (id, session_id, seq, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );

    // Used by the checkpoint-refs pass to skip refs that already have a
    // matching `checkpoint.created` event. Idempotency relies on this
    // lookup hitting `idx_pe_kind_session`.
    this.stmtCheckpointExists = db.prepare(
      "SELECT 1 FROM pipeline_events WHERE kind = 'checkpoint.created' AND payload_json LIKE ? LIMIT 1",
    );
  }

  /**
   * Run the full reconciliation pass once. Caller wires this from
   * `electron-app.ts` after database init and before any chat-message
   * IPC is exposed (task 29). The result is also returned for tests.
   *
   * Failure modes:
   *   - SQLite read fails for a table → log warn, skip table, continue.
   *   - A row is structurally unreconstructable → increment `unmatched`,
   *     log error, do not emit a partial event.
   *   - Git enumeration fails / repo absent → log debug, skip refs pass.
   */
  async runOnStartup(): Promise<ReconcilerSummary> {
    const summary: ReconcilerSummary = { reconciled: 0, unmatched: 0 };

    for (const plan of PLANS) {
      try {
        const counters = this.reconcileTable(plan);
        summary.reconciled += counters.reconciled;
        summary.unmatched += counters.unmatched;
      } catch (err) {
        logger.warn(
          `[reconciler] table "${plan.table}" pass failed:`,
          (err as Error)?.message,
        );
      }
    }

    if (this.enableGitRefs) {
      try {
        const counters = this.reconcileCheckpointRefs();
        summary.reconciled += counters.reconciled;
        summary.unmatched += counters.unmatched;
      } catch (err) {
        logger.debug(
          '[reconciler] git-refs pass failed (non-fatal):',
          (err as Error)?.message,
        );
      }
    }

    // Approval_Queue is in-memory only. Documented behavior — never
    // reconcilable. A debug log keeps the audit trail intact.
    logger.debug('[reconciler] approval-queue pass skipped (in-memory only)');

    // Drain anything we just emitted (the table passes go direct to
    // INSERT, but the EventLog may have queued unrelated emits during
    // app startup before this pass ran). This keeps the high-watermark
    // honest if the same reconciler instance gets re-run in tests.
    try {
      this.eventLog.flushNow();
    } catch (err) {
      logger.warn('[reconciler] post-pass flush failed:', (err as Error)?.message);
    }

    // Always record the metrics (zero is an interesting value too — it
    // confirms the dashboard panel is alive and the gate script can
    // assert "no unmatched samples in the last 7 days").
    try {
      this.metrics.recordMetric(null, 'event_log.reconciled', summary.reconciled);
      this.metrics.recordMetric(null, 'event_log.reconciler_unmatched', summary.unmatched);
    } catch (err) {
      logger.warn('[reconciler] metrics emit failed:', (err as Error)?.message);
    }

    if (summary.unmatched > 0) {
      logger.error(
        `[reconciler] ${summary.unmatched} authoritative row(s) could not be reconstructed — possible data loss`,
      );
    }

    return summary;
  }

  // ─── Per-table passes ────────────────────────────────────────

  private reconcileTable(plan: TableReconcilerPlan): ReconcilerSummary {
    switch (plan.table) {
      case 'agent_tasks':
        return this.reconcileAgentTasks();
      case 'subagent_tasks':
        return this.reconcileSubagentTasks();
      case 'pipeline_traces':
        return this.reconcilePipelineTraces();
      default:
        // Defensive: an unknown plan would silently no-op without this
        // branch. The default emits a warn so the spec author who adds
        // a table without code support gets a clear signal.
        logger.warn(`[reconciler] no implementation for table "${plan.table}"`);
        return { reconciled: 0, unmatched: 0 };
    }
  }

  /**
   * `agent_tasks` exists in migration 003. Columns of interest:
   *   id, session_id, status, assignee_id, created_at, updated_at.
   * `created_at` is a DATETIME default `CURRENT_TIMESTAMP`, stored as a
   * string by SQLite. `pipeline_events.created_at` is INTEGER ms. The
   * comparison happens after we convert the row's timestamp to ms.
   */
  private reconcileAgentTasks(): ReconcilerSummary {
    const counters: ReconcilerSummary = { reconciled: 0, unmatched: 0 };

    if (!this.tableExists('agent_tasks')) {
      logger.debug('[reconciler] agent_tasks table absent; skipping');
      return counters;
    }

    type Row = {
      id: string | null;
      session_id: string | null;
      status: string | null;
      assignee_id: string | null;
      // SQLite returns DATETIME columns as strings; we coerce to ms.
      created_at: string | number | null;
    };

    const sessions = this.distinctSessionsFor('agent_tasks', 'session_id');
    for (const sessionId of sessions) {
      const watermark = this.getEventWatermark(sessionId, 'task.transition');
      const rows = this.db
        .prepare(
          'SELECT id, session_id, status, assignee_id, created_at FROM agent_tasks WHERE session_id = ?',
        )
        .all(sessionId) as Row[];

      for (const row of rows) {
        const rowTs = coerceMs(row.created_at);
        if (rowTs === null || rowTs <= watermark) continue;
        if (!row.id || !row.status) {
          counters.unmatched++;
          logger.error(
            `[reconciler] agent_tasks row missing required field (id or status); session=${sessionId}`,
          );
          continue;
        }
        // `from` is unknown at reconciliation time — we never persisted
        // the prior state. The reducer tolerates a missing `from` and
        // simply re-bucketises the task. `by` falls back to the
        // assignee_id, then a sentinel to keep the payload well-typed.
        this.insertEvent(sessionId, 'task.transition', rowTs, {
          taskId: row.id,
          from: null,
          to: row.status,
          by: row.assignee_id ?? DEFAULT_TASK_TRANSITION_BY,
        });
        counters.reconciled++;
      }
    }

    return counters;
  }

  /**
   * `subagent_tasks` exists in migration 018. Columns of interest:
   *   id, parent_session_id, status, created_at.
   * No assignee column — `by` is the sentinel `'subagent'`. The
   * `parent_session_id` plays the role of `session_id` in the event
   * log because that's the session the parent agent is running under.
   */
  private reconcileSubagentTasks(): ReconcilerSummary {
    const counters: ReconcilerSummary = { reconciled: 0, unmatched: 0 };

    if (!this.tableExists('subagent_tasks')) {
      logger.debug('[reconciler] subagent_tasks table absent; skipping');
      return counters;
    }

    type Row = {
      id: string | null;
      parent_session_id: string | null;
      status: string | null;
      created_at: string | number | null;
    };

    const sessions = this.distinctSessionsFor('subagent_tasks', 'parent_session_id');
    for (const sessionId of sessions) {
      const watermark = this.getEventWatermark(sessionId, 'task.transition');
      const rows = this.db
        .prepare(
          'SELECT id, parent_session_id, status, created_at FROM subagent_tasks WHERE parent_session_id = ?',
        )
        .all(sessionId) as Row[];

      for (const row of rows) {
        const rowTs = coerceMs(row.created_at);
        if (rowTs === null || rowTs <= watermark) continue;
        if (!row.id || !row.status) {
          counters.unmatched++;
          logger.error(
            `[reconciler] subagent_tasks row missing required field (id or status); session=${sessionId}`,
          );
          continue;
        }
        this.insertEvent(sessionId, 'task.transition', rowTs, {
          taskId: row.id,
          from: null,
          to: row.status,
          by: 'subagent',
        });
        counters.reconciled++;
      }
    }

    return counters;
  }

  /**
   * `pipeline_traces` exists in migration 027 and (as a CREATE-IF-NOT-
   * EXISTS) in `PipelineTraceService`. Columns of interest:
   *   id, session_id, prompt, start_time, end_time.
   * Both `*_time` columns are stored as INTEGER ms. The reconstruction
   * emits a `tool.start` (always) and a `tool.success` (only when
   * `end_time` is non-null) so the reducer's active-tools list resolves
   * cleanly even if the trace ended.
   */
  private reconcilePipelineTraces(): ReconcilerSummary {
    const counters: ReconcilerSummary = { reconciled: 0, unmatched: 0 };

    if (!this.tableExists('pipeline_traces')) {
      logger.debug('[reconciler] pipeline_traces table absent; skipping');
      return counters;
    }

    type Row = {
      id: string | null;
      session_id: string | null;
      prompt: string | null;
      start_time: number | null;
      end_time: number | null;
    };

    const sessions = this.distinctSessionsFor('pipeline_traces', 'session_id');
    for (const sessionId of sessions) {
      const watermark = this.getEventWatermark(sessionId, 'tool.start');
      const rows = this.db
        .prepare(
          'SELECT id, session_id, prompt, start_time, end_time FROM pipeline_traces WHERE session_id = ?',
        )
        .all(sessionId) as Row[];

      for (const row of rows) {
        if (typeof row.start_time !== 'number' || row.start_time <= watermark) continue;
        if (!row.id) {
          counters.unmatched++;
          logger.error(
            `[reconciler] pipeline_traces row missing id; session=${sessionId}`,
          );
          continue;
        }
        // `tool.start` payload mirrors the live emitter: callId is the
        // trace id, args carries the prompt prefix the trace recorded.
        this.insertEvent(sessionId, 'tool.start', row.start_time, {
          callId: row.id,
          name: PIPELINE_TRACE_TOOL_NAME,
          args: { prompt: (row.prompt ?? '').slice(0, 500) },
        });
        counters.reconciled++;

        if (typeof row.end_time === 'number' && row.end_time >= row.start_time) {
          // `tool.success` payload carries a derived `result` object.
          // The reducer only needs `callId` to clear the active-tools
          // entry, so additional fields are advisory.
          this.insertEvent(sessionId, 'tool.success', row.end_time, {
            callId: row.id,
            result: { durationMs: row.end_time - row.start_time },
          });
          counters.reconciled++;
        }
      }
    }

    return counters;
  }

  // ─── Checkpoint refs ────────────────────────────────────────

  /**
   * Walk `refs/neuronest/turn/*` in the repo and replay any ref that
   * doesn't already have a matching `checkpoint.created` event. The
   * canonical "session id" for a checkpoint is encoded in the ref path:
   * `refs/neuronest/turn/<sessionId>/<turnId>`. This is the convention
   * used by `WorkspaceCheckpointManager` (audited as part of task 15).
   *
   * Idempotency: we look up `pipeline_events` rows whose
   * `payload_json` LIKE `%"checkpointId":"<sha>"%`. The LIKE pattern is
   * cheap because the index covers `kind` and we never have many
   * checkpoint events per session.
   */
  private reconcileCheckpointRefs(): ReconcilerSummary {
    const counters: ReconcilerSummary = { reconciled: 0, unmatched: 0 };

    let raw: string;
    try {
      raw = execSync('git for-each-ref --format=%(refname)%09%(objectname) refs/neuronest/turn', {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } catch (err) {
      logger.debug(
        '[reconciler] git for-each-ref failed (no repo or no neuronest refs):',
        (err as Error)?.message,
      );
      return counters;
    }

    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    for (const line of lines) {
      const tabIdx = line.indexOf('\t');
      if (tabIdx <= 0) {
        counters.unmatched++;
        logger.error(`[reconciler] malformed git-ref line: ${line}`);
        continue;
      }
      const refName = line.slice(0, tabIdx);
      const sha = line.slice(tabIdx + 1);

      // Expected shape: refs/neuronest/turn/<sessionId>/<turnId>
      // Extract the session and turn so the synthetic event matches the
      // shape the live emitter produces (`{ checkpointId, ref, turnId }`).
      const parts = refName.split('/');
      // parts: ['refs', 'neuronest', 'turn', sessionId, turnId?]
      if (parts.length < 5) {
        counters.unmatched++;
        logger.error(
          `[reconciler] checkpoint ref does not match expected shape (refs/neuronest/turn/<sessionId>/<turnId>): ${refName}`,
        );
        continue;
      }
      const sessionId = parts[3] || '';
      const turnId = parts.slice(4).join('/');
      if (!sessionId) {
        counters.unmatched++;
        logger.error(`[reconciler] checkpoint ref missing session segment: ${refName}`);
        continue;
      }

      // Idempotency check: skip if we already have a checkpoint.created
      // event for this sha. JSON encoding of `checkpointId` in the
      // payload is a bare quoted string so the LIKE pattern is safe.
      const existing = this.stmtCheckpointExists.get(`%"checkpointId":"${sha}"%`) as
        | { 1: number }
        | undefined;
      if (existing) continue;

      // We don't know the original creation time — the ref's commit
      // timestamp would require an extra `git show` per ref. Instead use
      // `Date.now()` so the event sorts after any pre-existing events.
      // The reducer keys off `seq`, not `created_at`, so the dashboard's
      // chronological view may be slightly off for replayed checkpoints
      // but reducer state is correct.
      this.insertEvent(sessionId, 'checkpoint.created', Date.now(), {
        checkpointId: sha,
        ref: refName,
        turnId,
      });
      counters.reconciled++;
    }

    return counters;
  }

  // ─── Internals ───────────────────────────────────────────────

  /**
   * Distinct session ids from a table column. Used to drive the per-
   * session loop in each table-pass without having to JOIN the sessions
   * table (which may be filtered by app-level retention rules the
   * reconciler must not honour). The cast to a typed shape keeps the
   * compiler happy even when the column is technically nullable.
   */
  private distinctSessionsFor(table: string, column: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT ${column} AS s FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as { s: string | null }[];
    return rows.map((r) => r.s).filter((s): s is string => typeof s === 'string' && s.length > 0);
  }

  /**
   * Highest `pipeline_events.created_at` for the given (session, kind).
   * Returns 0 when the pair has never been seen so the gap-window query
   * scans the whole authoritative table on the first run — which is the
   * intended behaviour for a brand-new install.
   */
  private getEventWatermark(sessionId: string, kind: EventKind): number {
    const row = this.stmtLatestEventTimestamp.get(sessionId, kind) as
      | { ts: number }
      | undefined;
    return row?.ts ?? 0;
  }

  /**
   * Single-row direct insert. Bypasses `EventLog.emit` because the
   * reconciler must complete synchronously before any chat IPC opens —
   * we cannot wait for the 100 ms flush timer. Allocates `seq` the same
   * way the EventLog does so the two writers share a single ordering.
   *
   * Per design.md: "Use `randomUUID` for new event ids" — so the
   * reconciler uses `crypto.randomUUID()` (UUIDv4) rather than
   * `generateEventId()` (UUIDv7). Rationale: replayed events are
   * structurally distinct from live events and giving them a different
   * `id` prefix would not buy us anything, but the spec is explicit.
   */
  private insertEvent(
    sessionId: string,
    kind: EventKind,
    createdAt: number,
    payload: unknown,
  ): void {
    const tx = this.db.transaction(() => {
      const seqRow = this.stmtMaxSeq.get(sessionId) as { s: number } | undefined;
      const nextSeq = (seqRow?.s ?? 0) + 1;
      this.stmtInsertEvent.run(
        randomUUID(),
        sessionId,
        nextSeq,
        kind,
        JSON.stringify(payload ?? null),
        createdAt,
      );
    });
    try {
      tx();
    } catch (err) {
      // Don't propagate — a single failed insert must not abort the
      // whole reconciliation pass. The unmatched counter would not be
      // accurate here (the row is structurally fine; SQLite is the
      // problem), so log and continue. The next startup re-attempts.
      logger.warn(
        `[reconciler] insert failed (kind=${kind} session=${sessionId}):`,
        (err as Error)?.message,
      );
    }
  }

  /**
   * Existence probe for a table. The in-scope tables are created by
   * other migrations (003, 018, 027) which have all been applied long
   * before this reconciler runs in production — but tests sometimes
   * spin up an in-memory DB with only the `pipeline_events` migration
   * applied. Skipping a missing table is the right behaviour in both
   * cases.
   */
  private tableExists(name: string): boolean {
    const row = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(name) as { name?: string } | undefined;
    return !!row?.name;
  }
}

// ─── Module-level helpers ────────────────────────────────────

/**
 * Coerce SQLite's polymorphic `created_at` into UNIX ms. SQLite stores
 * DATETIME default `CURRENT_TIMESTAMP` as an ISO-ish string
 * ("2024-01-15 12:34:56"); INTEGER columns come back as numbers. Both
 * shapes appear across the in-scope tables (agent_tasks uses a string,
 * pipeline_traces uses a number).
 *
 * Returns null for un-coercible inputs so the caller can skip the row
 * rather than emit a bogus event.
 */
function coerceMs(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC. Date.parse
  // expects an ISO-ish format; appending a 'Z' makes the parse stable.
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Try a numeric string first (the cheaper path).
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && /^[0-9]+$/.test(trimmed)) return asNum;
  const isoCandidate = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(isoCandidate);
  return Number.isFinite(parsed) ? parsed : null;
}

// Re-export for tests that want to assert the helper directly.
export { coerceMs as _coerceMsForTesting };
