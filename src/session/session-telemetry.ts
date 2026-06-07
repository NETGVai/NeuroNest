/**
 * Session Telemetry Service — real-time per-session cost, token, and context tracking.
 *
 * Provides the data layer for the Session Inspector panel.
 *
 * Also hosts Metrics_Sink (`recordMetric` / `getMetricSeries`) — the canonical
 * landing place for arbitrary keyed numeric metrics introduced by the
 * 12-factor-agent-improvements spec. Metrics_Sink writes to the
 * `metric_samples` table (migration 030).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface TelemetrySnapshot {
  id: string;
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  contextPct: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  recordedAt: string;
}

export interface SessionTelemetrySummary {
  sessionId: string;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  avgContextPct: number;
  totalToolCalls: number;
  topTools: { name: string; count: number }[];
  snapshots: TelemetrySnapshot[];
}

/** A single row from `metric_samples`. */
export interface MetricSample {
  id: string;
  sessionId: string | null;
  key: string;
  value: number;
  recordedAt: number;
}

export interface GetMetricSeriesOptions {
  /** If provided, restricts the query to a single session. */
  sessionId?: string;
  /** If provided, only returns samples with `recorded_at >= sinceMs`. */
  sinceMs?: number;
  /** If provided, caps the number of returned rows (most-recent first). */
  limit?: number;
}

export class SessionTelemetryService {
  private stmtRecord: Database.Statement;
  private stmtList: Database.Statement;
  private stmtSummary: Database.Statement;

  // Metrics_Sink prepared statements
  private stmtRecordMetric: Database.Statement;
  private stmtGetSeriesAll: Database.Statement;
  private stmtGetSeriesAllLimit: Database.Statement;
  private stmtGetSeriesSession: Database.Statement;
  private stmtGetSeriesSessionLimit: Database.Statement;
  private stmtGetSeriesAllSince: Database.Statement;
  private stmtGetSeriesAllSinceLimit: Database.Statement;
  private stmtGetSeriesSessionSince: Database.Statement;
  private stmtGetSeriesSessionSinceLimit: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtRecord = db.prepare(
      'INSERT INTO session_telemetry (id, session_id, tokens_in, tokens_out, cost_usd, context_pct, tool_calls, tool_breakdown, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.stmtList = db.prepare(
      'SELECT * FROM session_telemetry WHERE session_id = ? ORDER BY recorded_at ASC'
    );
    this.stmtSummary = db.prepare(
      'SELECT SUM(tokens_in) as ti, SUM(tokens_out) as to2, SUM(cost_usd) as cost, AVG(context_pct) as ctx, SUM(tool_calls) as tc FROM session_telemetry WHERE session_id = ?'
    );

    // Metrics_Sink writer
    this.stmtRecordMetric = db.prepare(
      'INSERT INTO metric_samples (id, session_id, key, value, recorded_at) VALUES (?, ?, ?, ?, ?)'
    );

    // Metrics_Sink readers — pre-prepare every shape we need so callers
    // pay zero per-call query-planning cost and we never build SQL by
    // string concatenation. Eight variants cover the 2×2×2 combinations of
    // (sessionId? · sinceMs? · limit?). All return rows in time-descending
    // order (most-recent first) so a `limit` truncates the tail.
    this.stmtGetSeriesAll = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? ORDER BY recorded_at DESC'
    );
    this.stmtGetSeriesAllLimit = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? ORDER BY recorded_at DESC LIMIT ?'
    );
    this.stmtGetSeriesSession = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? AND session_id = ? ORDER BY recorded_at DESC'
    );
    this.stmtGetSeriesSessionLimit = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? AND session_id = ? ORDER BY recorded_at DESC LIMIT ?'
    );
    this.stmtGetSeriesAllSince = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? AND recorded_at >= ? ORDER BY recorded_at DESC'
    );
    this.stmtGetSeriesAllSinceLimit = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?'
    );
    this.stmtGetSeriesSessionSince = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? AND session_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC'
    );
    this.stmtGetSeriesSessionSinceLimit = db.prepare(
      'SELECT id, session_id, key, value, recorded_at FROM metric_samples WHERE key = ? AND session_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?'
    );
  }

  record(sessionId: string, data: {
    tokensIn: number; tokensOut: number; costUsd: number;
    contextPct: number; toolCalls: number; toolBreakdown?: Record<string, number>;
  }): TelemetrySnapshot {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.stmtRecord.run(
      id, sessionId, data.tokensIn, data.tokensOut, data.costUsd,
      data.contextPct, data.toolCalls, JSON.stringify(data.toolBreakdown || {}), now
    );
    return {
      id, sessionId, tokensIn: data.tokensIn, tokensOut: data.tokensOut,
      costUsd: data.costUsd, contextPct: data.contextPct, toolCalls: data.toolCalls,
      toolBreakdown: data.toolBreakdown || {}, recordedAt: now,
    };
  }

  getSnapshots(sessionId: string): TelemetrySnapshot[] {
    return (this.stmtList.all(sessionId) as any[]).map(r => ({
      id: r.id, sessionId: r.session_id, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      costUsd: r.cost_usd, contextPct: r.context_pct, toolCalls: r.tool_calls,
      toolBreakdown: JSON.parse(r.tool_breakdown || '{}'), recordedAt: r.recorded_at,
    }));
  }

  getSummary(sessionId: string): SessionTelemetrySummary {
    const row = this.stmtSummary.get(sessionId) as any;
    const snapshots = this.getSnapshots(sessionId);

    // Aggregate tool breakdown across all snapshots
    const toolTotals: Record<string, number> = {};
    for (const snap of snapshots) {
      for (const [tool, count] of Object.entries(snap.toolBreakdown)) {
        toolTotals[tool] = (toolTotals[tool] || 0) + count;
      }
    }
    const topTools = Object.entries(toolTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return {
      sessionId,
      totalTokensIn: row?.ti || 0,
      totalTokensOut: row?.to2 || 0,
      totalCost: row?.cost || 0,
      avgContextPct: row?.ctx || 0,
      totalToolCalls: row?.tc || 0,
      topTools,
      snapshots,
    };
  }

  // ── Metrics_Sink ──────────────────────────────────────────────

  /**
   * Record one numeric metric sample.
   *
   * Per design ("Data Models" / `metric_samples`): `sessionId` is nullable
   * because some metrics are global (e.g. `event_log.reconciler_unmatched`).
   * `value` must be finite — non-finite values (NaN, Infinity, -Infinity) are
   * rejected because they corrupt downstream chart axes and SQLite REAL
   * comparison semantics for NaN are undefined. The caller is responsible
   * for sanitising or dropping such inputs.
   *
   * `key` is stored verbatim (no normalisation). Dots and slashes are
   * permitted — the `metric_samples` schema places no restriction on key
   * shape, and the convention is dotted-namespace (`unified_state.bytes`).
   *
   * Throws on persistence failure; callers in fail-soft contexts (e.g. the
   * error-size tap) wrap the call in their own try/catch.
   */
  recordMetric(sessionId: string | null, key: string, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`recordMetric: value must be finite (got ${value} for key="${key}")`);
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('recordMetric: key must be a non-empty string');
    }
    this.stmtRecordMetric.run(randomUUID(), sessionId, key, value, Date.now());
  }

  /**
   * Read a metric time-series for a single key, most-recent first.
   *
   * Filters:
   *   - `sessionId`  — narrow to one session (otherwise reads across sessions).
   *   - `sinceMs`    — only samples with `recorded_at >= sinceMs`.
   *   - `limit`      — cap rows; with no limit the result is the full series.
   *
   * Returns rows in descending `recorded_at` order. The dashboard renderer
   * (task 33) re-sorts ascending for plotting; ranking-style consumers
   * (latest-N) keep the descending order.
   */
  getMetricSeries(key: string, opts: GetMetricSeriesOptions = {}): MetricSample[] {
    const hasSession = typeof opts.sessionId === 'string' && opts.sessionId.length > 0;
    const hasSince = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs);
    const hasLimit = typeof opts.limit === 'number' && opts.limit > 0 && Number.isFinite(opts.limit);
    const limit = hasLimit ? Math.floor(opts.limit as number) : undefined;

    let rows: any[];
    if (hasSession && hasSince) {
      rows = limit !== undefined
        ? this.stmtGetSeriesSessionSinceLimit.all(key, opts.sessionId, opts.sinceMs, limit)
        : this.stmtGetSeriesSessionSince.all(key, opts.sessionId, opts.sinceMs);
    } else if (hasSession) {
      rows = limit !== undefined
        ? this.stmtGetSeriesSessionLimit.all(key, opts.sessionId, limit)
        : this.stmtGetSeriesSession.all(key, opts.sessionId);
    } else if (hasSince) {
      rows = limit !== undefined
        ? this.stmtGetSeriesAllSinceLimit.all(key, opts.sinceMs, limit)
        : this.stmtGetSeriesAllSince.all(key, opts.sinceMs);
    } else {
      rows = limit !== undefined
        ? this.stmtGetSeriesAllLimit.all(key, limit)
        : this.stmtGetSeriesAll.all(key);
    }

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      key: r.key,
      value: r.value,
      recordedAt: r.recorded_at,
    }));
  }
}
