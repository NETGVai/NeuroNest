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
import type { DriftDashboardState } from '../shared/feature-integration-types.js';

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

export type AgentRunStatus = 'completed' | 'incomplete' | 'failed';
export type AgentRunSource = 'agent-loop' | 'enhanced-swarm' | 'standard-swarm';

export interface AgentRunSnapshotInput {
  projectId: string;
  sessionId: string;
  status: AgentRunStatus;
  source: AgentRunSource;
  loopIterations: number;
  phaseCount: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  taskCompletedCount: number;
  taskFailedCount: number;
  taskBlockedCount: number;
  agentOutputCount: number;
  tokensConsumed: number;
  completedAt: Date;
  driftState: DriftDashboardState | null;
}

export interface ProjectCumulativeMetrics extends CumulativeMetrics {
  totalPhases: number;
  totalTaskCompletedCount: number;
  totalTaskFailedCount: number;
  totalTaskBlockedCount: number;
  totalAgentOutputCount: number;
  runCount: number;
}

export interface StoredAgentRunSnapshot extends AgentRunSnapshotInput {
  id: string;
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

  /** Persist reliability counters and the final drift state before it is cleared. */
  recordRunSnapshot(input: AgentRunSnapshotInput, id = randomUUID()): StoredAgentRunSnapshot {
    const completedAt = input.completedAt.toISOString();
    const driftStateJson = input.driftState ? JSON.stringify(input.driftState) : null;
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT 1 FROM drift_run_snapshots WHERE id = ?',
      ).get(id);
      // Preserve the legacy tool-loop telemetry contract only for true agent-loop
      // runs. A stable snapshot ID makes retries safe without duplicating this row.
      if (!existing && input.source === 'agent-loop') {
        this.recordMetrics(input.sessionId, {
          loopIterations: input.loopIterations,
          toolSuccessCount: input.toolSuccessCount,
          toolFailureCount: input.toolFailureCount,
          tokensConsumed: input.tokensConsumed,
          timestamp: input.completedAt,
        });
      }
      this.db.prepare(
        `INSERT INTO drift_run_snapshots
          (id, project_id, session_id, status, source, loop_iterations, phase_count,
           tool_success_count, tool_failure_count, task_completed_count,
           task_failed_count, task_blocked_count, agent_output_count,
           tokens_consumed, drift_state_json, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           session_id = excluded.session_id,
           status = excluded.status,
           source = excluded.source,
           loop_iterations = excluded.loop_iterations,
           phase_count = excluded.phase_count,
           tool_success_count = excluded.tool_success_count,
           tool_failure_count = excluded.tool_failure_count,
           task_completed_count = excluded.task_completed_count,
           task_failed_count = excluded.task_failed_count,
           task_blocked_count = excluded.task_blocked_count,
           agent_output_count = excluded.agent_output_count,
           tokens_consumed = excluded.tokens_consumed,
           drift_state_json = excluded.drift_state_json,
           completed_at = excluded.completed_at`,
      ).run(
        id,
        input.projectId,
        input.sessionId,
        input.status,
        input.source,
        input.loopIterations,
        input.phaseCount,
        input.toolSuccessCount,
        input.toolFailureCount,
        input.taskCompletedCount,
        input.taskFailedCount,
        input.taskBlockedCount,
        input.agentOutputCount,
        input.tokensConsumed,
        driftStateJson,
        completedAt,
      );
    });
    transaction();
    return { id, ...input };
  }

  /** Project-scoped completed-run aggregate used by Drift & Intelligence. */
  getProjectCumulativeMetrics(projectId: string): ProjectCumulativeMetrics {
    const row = this.db.prepare(
      `SELECT
         COALESCE(SUM(loop_iterations), 0) AS total_loop_iterations,
         COALESCE(SUM(phase_count), 0) AS total_phases,
         COALESCE(SUM(tool_success_count), 0) AS total_tool_success_count,
         COALESCE(SUM(tool_failure_count), 0) AS total_tool_failure_count,
         COALESCE(SUM(task_completed_count), 0) AS total_task_completed_count,
         COALESCE(SUM(task_failed_count), 0) AS total_task_failed_count,
         COALESCE(SUM(task_blocked_count), 0) AS total_task_blocked_count,
         COALESCE(SUM(agent_output_count), 0) AS total_agent_output_count,
         COALESCE(SUM(tokens_consumed), 0) AS total_tokens_consumed,
         COUNT(DISTINCT session_id) AS session_count,
         COUNT(*) AS run_count
       FROM drift_run_snapshots
       WHERE project_id = ?`,
    ).get(projectId) as {
      total_loop_iterations: number;
      total_phases: number;
      total_tool_success_count: number;
      total_tool_failure_count: number;
      total_task_completed_count: number;
      total_task_failed_count: number;
      total_task_blocked_count: number;
      total_agent_output_count: number;
      total_tokens_consumed: number;
      session_count: number;
      run_count: number;
    };
    return {
      totalLoopIterations: row.total_loop_iterations,
      totalPhases: row.total_phases,
      totalToolSuccessCount: row.total_tool_success_count,
      totalToolFailureCount: row.total_tool_failure_count,
      totalTaskCompletedCount: row.total_task_completed_count,
      totalTaskFailedCount: row.total_task_failed_count,
      totalTaskBlockedCount: row.total_task_blocked_count,
      totalAgentOutputCount: row.total_agent_output_count,
      totalTokensConsumed: row.total_tokens_consumed,
      sessionCount: row.session_count,
      runCount: row.run_count,
    };
  }

  /** Latest completed project run, including drift evidence when it was enabled. */
  getLatestProjectRun(projectId: string): StoredAgentRunSnapshot | null {
    const row = this.db.prepare(
      `SELECT * FROM drift_run_snapshots
       WHERE project_id = ?
       ORDER BY completed_at DESC, rowid DESC
       LIMIT 1`,
    ).get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;

    let driftState: DriftDashboardState | null = null;
    if (typeof row.drift_state_json === 'string' && row.drift_state_json.length > 0) {
      try {
        driftState = JSON.parse(row.drift_state_json) as DriftDashboardState;
      } catch {
        driftState = null;
      }
    }

    return {
      id: String(row.id),
      projectId: String(row.project_id),
      sessionId: String(row.session_id),
      status: row.status as AgentRunStatus,
      source: row.source as AgentRunSource,
      loopIterations: Number(row.loop_iterations) || 0,
      phaseCount: Number(row.phase_count) || 0,
      toolSuccessCount: Number(row.tool_success_count) || 0,
      toolFailureCount: Number(row.tool_failure_count) || 0,
      taskCompletedCount: Number(row.task_completed_count) || 0,
      taskFailedCount: Number(row.task_failed_count) || 0,
      taskBlockedCount: Number(row.task_blocked_count) || 0,
      agentOutputCount: Number(row.agent_output_count) || 0,
      tokensConsumed: Number(row.tokens_consumed) || 0,
      completedAt: new Date(String(row.completed_at)),
      driftState,
    };
  }
}
