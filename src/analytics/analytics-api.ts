/**
 * AnalyticsAPI — Dashboard data API for adoption analytics.
 *
 * Exposes metrics, trends, and per-agent effectiveness via IPC and HTTP.
 * Supports CSV/JSON export of all metrics.
 * Provides trend charts data: weekly active users, sessions, feature utilization.
 *
 * IPC channels:
 *   analytics:metrics — Get aggregated metrics
 *   analytics:agent-stats — Get per-agent effectiveness
 *   analytics:trends — Get trend chart data
 *   analytics:export — Export metrics as CSV or JSON
 *
 * Gated behind `adoption_dashboard` feature flag.
 *
 * Requirements: 23.2
 */

import type Database from 'better-sqlite3';
import {
  MetricsCollector,
  AggregatedMetrics,
  AgentEffectiveness,
  AggregationLevel,
} from './metrics-collector';

// ─── Types ─────────────────────────────────────────────────────────

export interface MetricsQuery {
  level: AggregationLevel;
  scopeId: string;
  fromDate: string;
  toDate: string;
}

export interface ExportQuery extends MetricsQuery {
  format: 'csv' | 'json';
  includeAgentStats?: boolean;
  includeTrends?: boolean;
}

export interface TrendDataPoint {
  week: string;
  activeUsers: number;
  sessions: number;
  tasksCompleted: number;
}

export interface ExportResult {
  data: string;
  filename: string;
  mimeType: string;
}

export interface AnalyticsResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ─── AnalyticsAPI ──────────────────────────────────────────────────

export class AnalyticsAPI {
  private collector: MetricsCollector;

  constructor(db: Database.Database, retentionDays?: number) {
    this.collector = new MetricsCollector(db, { retentionDays: retentionDays ?? 90 });
  }

  /**
   * Handler for `analytics:metrics` IPC channel.
   * Returns aggregated metrics for the specified scope and time range.
   */
  getMetrics(query: MetricsQuery): AnalyticsResponse<AggregatedMetrics> {
    try {
      const data = this.collector.getAggregatedMetrics(
        query.level,
        query.scopeId,
        query.fromDate,
        query.toDate
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Handler for `analytics:agent-stats` IPC channel.
   * Returns per-agent effectiveness data.
   */
  getAgentStats(query: MetricsQuery): AnalyticsResponse<AgentEffectiveness[]> {
    try {
      const data = this.collector.getAgentEffectiveness(
        query.level,
        query.scopeId,
        query.fromDate,
        query.toDate
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Handler for `analytics:trends` IPC channel.
   * Returns weekly trend data for chart rendering.
   */
  getTrends(query: MetricsQuery): AnalyticsResponse<TrendDataPoint[]> {
    try {
      const data = this.collector.getTrends(
        query.level,
        query.scopeId,
        query.fromDate,
        query.toDate
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Handler for `analytics:export` IPC channel.
   * Exports metrics data as CSV or JSON.
   */
  exportMetrics(query: ExportQuery): AnalyticsResponse<ExportResult> {
    try {
      const metrics = this.collector.getAggregatedMetrics(
        query.level,
        query.scopeId,
        query.fromDate,
        query.toDate
      );

      const agentStats = query.includeAgentStats !== false
        ? this.collector.getAgentEffectiveness(query.level, query.scopeId, query.fromDate, query.toDate)
        : [];

      const trends = query.includeTrends !== false
        ? this.collector.getTrends(query.level, query.scopeId, query.fromDate, query.toDate)
        : [];

      const exportPayload = { metrics, agentStats, trends };

      if (query.format === 'csv') {
        const data = this.toCSV(exportPayload);
        return {
          success: true,
          data: {
            data,
            filename: `analytics-export-${query.fromDate}-to-${query.toDate}.csv`,
            mimeType: 'text/csv',
          },
        };
      }

      const data = JSON.stringify(exportPayload, null, 2);
      return {
        success: true,
        data: {
          data,
          filename: `analytics-export-${query.fromDate}-to-${query.toDate}.json`,
          mimeType: 'application/json',
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Apply data retention policy (call periodically, e.g. daily).
   */
  applyRetention(): number {
    return this.collector.applyRetentionPolicy();
  }

  /**
   * Register IPC handlers with Electron's ipcMain.
   */
  registerIpcHandlers(ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void;
  }): void {
    ipcMain.handle('analytics:metrics', (_event: unknown, ...args: unknown[]) => {
      return this.getMetrics(args[0] as MetricsQuery);
    });

    ipcMain.handle('analytics:agent-stats', (_event: unknown, ...args: unknown[]) => {
      return this.getAgentStats(args[0] as MetricsQuery);
    });

    ipcMain.handle('analytics:trends', (_event: unknown, ...args: unknown[]) => {
      return this.getTrends(args[0] as MetricsQuery);
    });

    ipcMain.handle('analytics:export', (_event: unknown, ...args: unknown[]) => {
      return this.exportMetrics(args[0] as ExportQuery);
    });
  }

  // ─── Private helpers ────────────────────────────────────────────

  private toCSV(payload: {
    metrics: AggregatedMetrics;
    agentStats: AgentEffectiveness[];
    trends: TrendDataPoint[];
  }): string {
    const lines: string[] = [];

    // Summary metrics section
    lines.push('--- Summary Metrics ---');
    lines.push('Metric,Value');
    lines.push(`Active Users,${payload.metrics.activeUsers}`);
    lines.push(`Sessions/Day,${payload.metrics.sessionsPerDay}`);
    lines.push(`Tasks Completed,${payload.metrics.tasksCompleted}`);
    lines.push(`Tasks Failed,${payload.metrics.tasksFailed}`);
    lines.push(`Success Rate,${payload.metrics.successRate}`);
    lines.push(`Total Cost,${payload.metrics.totalCost}`);
    lines.push(`Cost/Task,${payload.metrics.costPerTask}`);
    lines.push(`Estimated Time Saved (hours),${payload.metrics.estimatedTimeSaved}`);
    lines.push(`Avg Feedback Score,${payload.metrics.avgFeedbackScore}`);
    lines.push('');

    // Agent stats section
    if (payload.agentStats.length > 0) {
      lines.push('--- Agent Effectiveness ---');
      lines.push('Agent ID,Invocations,Success Rate,Avg Duration (ms),Cost/Task,Avg Satisfaction');
      for (const agent of payload.agentStats) {
        lines.push(
          `${agent.agentId},${agent.invocations},${agent.successRate},${agent.avgDurationMs},${agent.costPerTask},${agent.avgSatisfaction}`
        );
      }
      lines.push('');
    }

    // Trends section
    if (payload.trends.length > 0) {
      lines.push('--- Weekly Trends ---');
      lines.push('Week,Active Users,Sessions,Tasks Completed');
      for (const trend of payload.trends) {
        lines.push(`${trend.week},${trend.activeUsers},${trend.sessions},${trend.tasksCompleted}`);
      }
    }

    return lines.join('\n');
  }
}
