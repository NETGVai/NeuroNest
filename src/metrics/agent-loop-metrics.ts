/**
 * Agent Loop Metrics Store — records and queries per-execution metrics
 * for the agentic tool-use loop (iterations, tool success/failure counts,
 * tokens consumed).
 *
 * Writes to the `session_telemetry` table (columns added by migration 035).
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface AgentLoopMetrics {
  loopIterations: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  tokensConsumed: number;
  timestamp: Date;
}

export interface CumulativeMetrics {
  totalLoopIterations: number;
  totalToolSuccessCount: number;
  totalToolFailureCount: number;
  totalTokensConsumed: number;
  sessionCount: number;
}

export class AgentLoopMetricsStore {
  private insertStmt: Database.Statement;
  private sessionStmt: Database.Statement;
  private cumulativeStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO session_telemetry
        (id, session_id, tokens_in, tokens_out, cost_usd, context_pct, tool_calls, tool_breakdown, recorded_at, loop_iterations, tool_success_count, tool_failure_count)
       VALUES (?, ?, ?, 0, 0, 0, ?, '{}', ?, ?, ?, ?)`
    );

    this.sessionStmt = db.prepare(
      `SELECT loop_iterations, tool_success_count, tool_failure_count, tokens_in, recorded_at
       FROM session_telemetry
       WHERE session_id = ?
       ORDER BY recorded_at ASC`
    );

    this.cumulativeStmt = db.prepare(
      `SELECT
         COALESCE(SUM(loop_iterations), 0) AS total_loop_iterations,
         COALESCE(SUM(tool_success_count), 0) AS total_tool_success_count,
         COALESCE(SUM(tool_failure_count), 0) AS total_tool_failure_count,
         COALESCE(SUM(tokens_in), 0) AS total_tokens_consumed,
         COUNT(DISTINCT session_id) AS session_count
       FROM session_telemetry
       WHERE loop_iterations > 0 OR tool_success_count > 0 OR tool_failure_count > 0`
    );
  }

  /**
   * Record metrics after an Agent Loop execution completes.
   */
  recordMetrics(sessionId: string, metrics: AgentLoopMetrics): void {
    const id = randomUUID();
    const toolCalls = metrics.toolSuccessCount + metrics.toolFailureCount;
    const recordedAt = metrics.timestamp.toISOString();

    this.insertStmt.run(
      id,
      sessionId,
      metrics.tokensConsumed,
      toolCalls,
      recordedAt,
      metrics.loopIterations,
      metrics.toolSuccessCount,
      metrics.toolFailureCount,
    );
  }

  /**
   * Query all agent loop metrics for a specific session.
   */
  getSessionMetrics(sessionId: string): AgentLoopMetrics[] {
    const rows = this.sessionStmt.all(sessionId) as Array<{
      loop_iterations: number;
      tool_success_count: number;
      tool_failure_count: number;
      tokens_in: number;
      recorded_at: string;
    }>;

    return rows.map((row) => ({
      loopIterations: row.loop_iterations,
      toolSuccessCount: row.tool_success_count,
      toolFailureCount: row.tool_failure_count,
      tokensConsumed: row.tokens_in,
      timestamp: new Date(row.recorded_at),
    }));
  }

  /**
   * Query cumulative metrics across all sessions.
   */
  getCumulativeMetrics(): CumulativeMetrics {
    const row = this.cumulativeStmt.get() as {
      total_loop_iterations: number;
      total_tool_success_count: number;
      total_tool_failure_count: number;
      total_tokens_consumed: number;
      session_count: number;
    };

    return {
      totalLoopIterations: row.total_loop_iterations,
      totalToolSuccessCount: row.total_tool_success_count,
      totalToolFailureCount: row.total_tool_failure_count,
      totalTokensConsumed: row.total_tokens_consumed,
      sessionCount: row.session_count,
    };
  }
}
