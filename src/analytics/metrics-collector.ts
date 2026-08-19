/**
 * MetricsCollector — Event collection and aggregation for adoption analytics.
 *
 * Collects metrics: sessions started, tasks completed, agent usage, costs, user feedback.
 * Calculates derived metrics: estimated time saved (3x baseline), success rates, cost per task.
 * Aggregates at user, team, and organization levels.
 * Applies data retention policy (default: 90 days, configurable).
 *
 * Gated behind `adoption_dashboard` feature flag.
 *
 * Requirements: 23.1
 */

import type Database from 'better-sqlite3';

import { redactForAnalytics } from '../shared/observable-redaction';

// ─── Types ─────────────────────────────────────────────────────────

export interface MetricEvent {
  id?: string;
  userId: string;
  teamId?: string;
  orgId?: string;
  eventType: MetricEventType;
  agentId?: string;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export type MetricEventType =
  | 'session_started'
  | 'task_completed'
  | 'task_failed'
  | 'agent_invoked'
  | 'cost_incurred'
  | 'feedback_submitted';

export interface AggregatedMetrics {
  activeUsers: number;
  sessionsPerDay: number;
  tasksCompleted: number;
  tasksFailed: number;
  successRate: number;
  totalCost: number;
  costPerTask: number;
  estimatedTimeSaved: number; // hours
  avgFeedbackScore: number;
}

export interface AgentEffectiveness {
  agentId: string;
  invocations: number;
  successRate: number;
  avgDurationMs: number;
  costPerTask: number;
  avgSatisfaction: number;
}

export type AggregationLevel = 'user' | 'team' | 'organization';

export interface RetentionConfig {
  retentionDays: number;
}

// ─── Constants ─────────────────────────────────────────────────────

const DEFAULT_RETENTION_DAYS = 90;
const TIME_SAVED_MULTIPLIER = 3; // Estimated 3x baseline

// ─── MetricsCollector ──────────────────────────────────────────────

export class MetricsCollector {
  private db: Database.Database;
  private retentionDays: number;

  constructor(db: Database.Database, config?: Partial<RetentionConfig>) {
    this.db = db;
    this.retentionDays = config?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  /**
   * Record a metric event.
   *
   * Task 5.5 (enhanced-chat-ui): analytics is one of the observable channels
   * the shared credential/content redaction boundary must cover. Free-form
   * `metadata` is scrubbed with the shared adapter before it is persisted so
   * Proxy Credentials, legacy provider keys, prompt/response content,
   * reasoning, private tool payloads, and private paths cannot enter the
   * aggregation pipeline even by accident. Aggregate columns (`user_id`,
   * `team_id`, `org_id`, `agent_id`) are opaque identifiers by contract and
   * are not passed through the redactor.
   */
  record(event: MetricEvent): void {
    const id = event.id ?? this.generateId();
    const timestamp = event.timestamp ?? new Date().toISOString();

    const safeMetadata = event.metadata
      ? redactForAnalytics(event.metadata)
      : undefined;

    const stmt = this.db.prepare(`
      INSERT INTO adoption_metrics (id, user_id, team_id, org_id, event_type, agent_id, value, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      event.userId,
      event.teamId ?? null,
      event.orgId ?? null,
      event.eventType,
      event.agentId ?? null,
      event.value ?? null,
      safeMetadata ? JSON.stringify(safeMetadata) : null,
      timestamp
    );
  }

  /**
   * Get aggregated metrics for a given time range and level.
   */
  getAggregatedMetrics(
    level: AggregationLevel,
    scopeId: string,
    fromDate: string,
    toDate: string
  ): AggregatedMetrics {
    const scopeColumn = this.getScopeColumn(level);

    const baseWhere = `${scopeColumn} = ? AND created_at >= ? AND created_at <= ?`;
    const baseParams = [scopeId, fromDate, toDate];

    // Active users
    const activeUsersRow = this.db.prepare(`
      SELECT COUNT(DISTINCT user_id) as count FROM adoption_metrics
      WHERE ${baseWhere}
    `).get(...baseParams) as { count: number } | undefined;
    const activeUsers = activeUsersRow?.count ?? 0;

    // Sessions per day
    const sessionsRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM adoption_metrics
      WHERE ${baseWhere} AND event_type = 'session_started'
    `).get(...baseParams) as { count: number } | undefined;
    const totalSessions = sessionsRow?.count ?? 0;
    const daySpan = Math.max(1, this.daysBetween(fromDate, toDate));
    const sessionsPerDay = totalSessions / daySpan;

    // Tasks completed/failed
    const tasksCompletedRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM adoption_metrics
      WHERE ${baseWhere} AND event_type = 'task_completed'
    `).get(...baseParams) as { count: number } | undefined;
    const tasksCompleted = tasksCompletedRow?.count ?? 0;

    const tasksFailedRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM adoption_metrics
      WHERE ${baseWhere} AND event_type = 'task_failed'
    `).get(...baseParams) as { count: number } | undefined;
    const tasksFailed = tasksFailedRow?.count ?? 0;

    // Success rate
    const totalTasks = tasksCompleted + tasksFailed;
    const successRate = totalTasks > 0 ? tasksCompleted / totalTasks : 0;

    // Total cost
    const costRow = this.db.prepare(`
      SELECT COALESCE(SUM(value), 0) as total FROM adoption_metrics
      WHERE ${baseWhere} AND event_type = 'cost_incurred'
    `).get(...baseParams) as { total: number } | undefined;
    const totalCost = costRow?.total ?? 0;

    // Cost per task
    const costPerTask = tasksCompleted > 0 ? totalCost / tasksCompleted : 0;

    // Estimated time saved (3x baseline: each completed task saves ~15min baseline * 3)
    const estimatedTimeSaved = (tasksCompleted * 15 * TIME_SAVED_MULTIPLIER) / 60; // hours

    // Average feedback score
    const feedbackRow = this.db.prepare(`
      SELECT AVG(value) as avg FROM adoption_metrics
      WHERE ${baseWhere} AND event_type = 'feedback_submitted' AND value IS NOT NULL
    `).get(...baseParams) as { avg: number | null } | undefined;
    const avgFeedbackScore = feedbackRow?.avg ?? 0;

    return {
      activeUsers,
      sessionsPerDay: Math.round(sessionsPerDay * 100) / 100,
      tasksCompleted,
      tasksFailed,
      successRate: Math.round(successRate * 1000) / 1000,
      totalCost: Math.round(totalCost * 100) / 100,
      costPerTask: Math.round(costPerTask * 100) / 100,
      estimatedTimeSaved: Math.round(estimatedTimeSaved * 10) / 10,
      avgFeedbackScore: Math.round((avgFeedbackScore ?? 0) * 100) / 100,
    };
  }

  /**
   * Get per-agent effectiveness metrics.
   */
  getAgentEffectiveness(
    level: AggregationLevel,
    scopeId: string,
    fromDate: string,
    toDate: string
  ): AgentEffectiveness[] {
    const scopeColumn = this.getScopeColumn(level);
    const baseWhere = `${scopeColumn} = ? AND created_at >= ? AND created_at <= ? AND agent_id IS NOT NULL`;
    const baseParams = [scopeId, fromDate, toDate];

    const agents = this.db.prepare(`
      SELECT DISTINCT agent_id FROM adoption_metrics
      WHERE ${baseWhere}
    `).all(...baseParams) as { agent_id: string }[];

    return agents.map((row) => {
      const agentId = row.agent_id;
      const agentWhere = `${baseWhere} AND agent_id = ?`;
      const agentParams = [...baseParams, agentId];

      // Invocations
      const invocRow = this.db.prepare(`
        SELECT COUNT(*) as count FROM adoption_metrics
        WHERE ${agentWhere} AND event_type = 'agent_invoked'
      `).get(...agentParams) as { count: number } | undefined;
      const invocations = invocRow?.count ?? 0;

      // Success rate for this agent
      const completedRow = this.db.prepare(`
        SELECT COUNT(*) as count FROM adoption_metrics
        WHERE ${agentWhere} AND event_type = 'task_completed'
      `).get(...agentParams) as { count: number } | undefined;
      const completed = completedRow?.count ?? 0;

      const failedRow = this.db.prepare(`
        SELECT COUNT(*) as count FROM adoption_metrics
        WHERE ${agentWhere} AND event_type = 'task_failed'
      `).get(...agentParams) as { count: number } | undefined;
      const failed = failedRow?.count ?? 0;

      const total = completed + failed;
      const successRate = total > 0 ? completed / total : 0;

      // Avg duration from metadata
      const durationRow = this.db.prepare(`
        SELECT AVG(json_extract(metadata, '$.durationMs')) as avg FROM adoption_metrics
        WHERE ${agentWhere} AND event_type = 'task_completed' AND metadata IS NOT NULL
      `).get(...agentParams) as { avg: number | null } | undefined;
      const avgDurationMs = durationRow?.avg ?? 0;

      // Cost per task for this agent
      const costRow = this.db.prepare(`
        SELECT COALESCE(SUM(value), 0) as total FROM adoption_metrics
        WHERE ${agentWhere} AND event_type = 'cost_incurred'
      `).get(...agentParams) as { total: number } | undefined;
      const agentCost = costRow?.total ?? 0;
      const costPerTask = completed > 0 ? agentCost / completed : 0;

      // Avg satisfaction
      const satRow = this.db.prepare(`
        SELECT AVG(value) as avg FROM adoption_metrics
        WHERE ${agentWhere} AND event_type = 'feedback_submitted' AND value IS NOT NULL
      `).get(...agentParams) as { avg: number | null } | undefined;
      const avgSatisfaction = satRow?.avg ?? 0;

      return {
        agentId,
        invocations,
        successRate: Math.round(successRate * 1000) / 1000,
        avgDurationMs: Math.round(avgDurationMs ?? 0),
        costPerTask: Math.round(costPerTask * 100) / 100,
        avgSatisfaction: Math.round((avgSatisfaction ?? 0) * 100) / 100,
      };
    });
  }

  /**
   * Get trend data for charting (weekly aggregation).
   */
  getTrends(
    level: AggregationLevel,
    scopeId: string,
    fromDate: string,
    toDate: string
  ): { week: string; activeUsers: number; sessions: number; tasksCompleted: number }[] {
    const scopeColumn = this.getScopeColumn(level);
    const baseWhere = `${scopeColumn} = ? AND created_at >= ? AND created_at <= ?`;
    const baseParams = [scopeId, fromDate, toDate];

    const rows = this.db.prepare(`
      SELECT
        strftime('%Y-W%W', created_at) as week,
        COUNT(DISTINCT user_id) as activeUsers,
        SUM(CASE WHEN event_type = 'session_started' THEN 1 ELSE 0 END) as sessions,
        SUM(CASE WHEN event_type = 'task_completed' THEN 1 ELSE 0 END) as tasksCompleted
      FROM adoption_metrics
      WHERE ${baseWhere}
      GROUP BY week
      ORDER BY week ASC
    `).all(...baseParams) as { week: string; activeUsers: number; sessions: number; tasksCompleted: number }[];

    return rows;
  }

  /**
   * Apply data retention policy — delete events older than configured days.
   */
  applyRetentionPolicy(): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cutoffStr = cutoff.toISOString();

    const result = this.db.prepare(`
      DELETE FROM adoption_metrics WHERE created_at < ?
    `).run(cutoffStr);

    return result.changes;
  }

  /**
   * Update retention configuration.
   */
  setRetentionDays(days: number): void {
    if (days < 1) throw new Error('Retention days must be at least 1');
    this.retentionDays = days;
  }

  getRetentionDays(): number {
    return this.retentionDays;
  }

  // ─── Private helpers ────────────────────────────────────────────

  private getScopeColumn(level: AggregationLevel): string {
    switch (level) {
      case 'user': return 'user_id';
      case 'team': return 'team_id';
      case 'organization': return 'org_id';
    }
  }

  private daysBetween(from: string, to: string): number {
    const d1 = new Date(from).getTime();
    const d2 = new Date(to).getTime();
    return Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
  }

  private generateId(): string {
    return `met_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
