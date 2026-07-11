/**
 * EfficiencyKPITracker — Tracks LOC delta, dependency delta, and token cost
 * per task for lean-enabled vs lean-disabled comparison.
 *
 * Stores metrics to the `efficiency_metrics` SQLite table after task completion only.
 * Integrates with CostTrackingService for token cost data.
 * Tolerates partial metric computation failures — stores whatever is computable.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

import type { CostTrackingService } from './cost-tracking-service.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** Metrics recorded after task completion */
export interface TaskEfficiencyMetrics {
  taskId: string;
  locDelta: number;          // lines added - lines removed
  dependencyDelta: number;   // new deps added
  tokenCost: number;         // from existing cost infrastructure
  leanEnabled: boolean;      // for A/B comparison
  timestamp: string;         // ISO 8601
}

/** Partial metrics — used when some computations fail */
export interface PartialTaskMetrics {
  taskId: string;
  locDelta?: number;
  dependencyDelta?: number;
  tokenCost?: number;
  leanEnabled: boolean;
  timestamp?: string;
}

/** Result of comparing lean-enabled vs lean-disabled runs */
export interface ComparisonReport {
  taskSuiteId: string;
  leanEnabledMetrics: TaskEfficiencyMetrics[];
  leanDisabledMetrics: TaskEfficiencyMetrics[];
  averageLocDeltaEnabled: number;
  averageLocDeltaDisabled: number;
  averageDependencyDeltaEnabled: number;
  averageDependencyDeltaDisabled: number;
  averageTokenCostEnabled: number;
  averageTokenCostDisabled: number;
  locDeltaReduction: number;         // percentage reduction with lean
  dependencyDeltaReduction: number;  // percentage reduction with lean
  tokenCostReduction: number;        // percentage reduction with lean
}

/** Minimal database interface for SQLite operations */
export interface EfficiencyDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => EfficiencyStatement;
}

/** Minimal prepared statement interface */
export interface EfficiencyStatement {
  run: (...params: unknown[]) => void;
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown | undefined;
}

// ─── SQL Schema ─────────────────────────────────────────────────

/**
 * SQL statement to create the efficiency_metrics table.
 * Should be executed when the efficiency tracking feature is initialized.
 *
 * Requirements: 8.4, 8.6
 */
export const EFFICIENCY_METRICS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS efficiency_metrics (
  task_id TEXT PRIMARY KEY,
  loc_delta INTEGER NOT NULL,
  dependency_delta INTEGER NOT NULL,
  token_cost REAL NOT NULL,
  lean_enabled INTEGER NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_efficiency_metrics_lean ON efficiency_metrics(lean_enabled);
CREATE INDEX IF NOT EXISTS idx_efficiency_metrics_completed ON efficiency_metrics(completed_at);
`.trim();

/**
 * Initialize the efficiency_metrics SQLite table if it doesn't exist.
 *
 * @param db - A database instance with an exec() method (e.g., better-sqlite3)
 */
export function initEfficiencyMetricsTable(db: { exec: (sql: string) => void }): void {
  db.exec(EFFICIENCY_METRICS_TABLE_SQL);
}

// ─── EfficiencyKPITracker ───────────────────────────────────────

export class EfficiencyKPITracker {
  constructor(
    private readonly db: EfficiencyDatabase | null,
    private readonly costTrackingService: CostTrackingService | null,
  ) {}

  /**
   * Record metrics after task completion.
   * Tolerates partial failures — stores what is computable with defaults for missing values.
   *
   * Requirements: 8.4, 8.6, 8.7
   */
  async recordTaskMetrics(metrics: PartialTaskMetrics): Promise<TaskEfficiencyMetrics> {
    // Resolve metrics with defaults for missing values (partial failure tolerance)
    const resolved: TaskEfficiencyMetrics = {
      taskId: metrics.taskId,
      locDelta: metrics.locDelta ?? 0,
      dependencyDelta: metrics.dependencyDelta ?? 0,
      tokenCost: metrics.tokenCost ?? this.getTokenCostFromService(),
      leanEnabled: metrics.leanEnabled,
      timestamp: metrics.timestamp ?? new Date().toISOString(),
    };

    // Store to SQLite if database is available
    if (this.db) {
      try {
        const stmt = this.db.prepare(
          `INSERT OR REPLACE INTO efficiency_metrics (task_id, loc_delta, dependency_delta, token_cost, lean_enabled, completed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        stmt.run(
          resolved.taskId,
          resolved.locDelta,
          resolved.dependencyDelta,
          resolved.tokenCost,
          resolved.leanEnabled ? 1 : 0,
          resolved.timestamp,
        );
      } catch {
        // Tolerate storage failures — log would happen at higher level
        // The resolved metrics are still returned for in-memory use
      }
    }

    return resolved;
  }

  /**
   * Record fully-specified metrics after task completion.
   * This is the primary entry point when all metrics are available.
   *
   * Requirements: 8.4, 8.6
   */
  async recordFullMetrics(metrics: TaskEfficiencyMetrics): Promise<TaskEfficiencyMetrics> {
    return this.recordTaskMetrics(metrics);
  }

  /**
   * Compare lean-enabled vs lean-disabled metrics for a task suite.
   * A task suite is identified by a prefix pattern (e.g., "suite-xyz-").
   *
   * Requirements: 8.5
   */
  async compareRuns(taskSuiteId: string): Promise<ComparisonReport> {
    const leanEnabled = this.getMetricsBySuite(taskSuiteId, true);
    const leanDisabled = this.getMetricsBySuite(taskSuiteId, false);

    const avgLocEnabled = this.average(leanEnabled.map(m => m.locDelta));
    const avgLocDisabled = this.average(leanDisabled.map(m => m.locDelta));
    const avgDepEnabled = this.average(leanEnabled.map(m => m.dependencyDelta));
    const avgDepDisabled = this.average(leanDisabled.map(m => m.dependencyDelta));
    const avgCostEnabled = this.average(leanEnabled.map(m => m.tokenCost));
    const avgCostDisabled = this.average(leanDisabled.map(m => m.tokenCost));

    return {
      taskSuiteId,
      leanEnabledMetrics: leanEnabled,
      leanDisabledMetrics: leanDisabled,
      averageLocDeltaEnabled: avgLocEnabled,
      averageLocDeltaDisabled: avgLocDisabled,
      averageDependencyDeltaEnabled: avgDepEnabled,
      averageDependencyDeltaDisabled: avgDepDisabled,
      averageTokenCostEnabled: avgCostEnabled,
      averageTokenCostDisabled: avgCostDisabled,
      locDeltaReduction: this.percentageReduction(avgLocDisabled, avgLocEnabled),
      dependencyDeltaReduction: this.percentageReduction(avgDepDisabled, avgDepEnabled),
      tokenCostReduction: this.percentageReduction(avgCostDisabled, avgCostEnabled),
    };
  }

  /**
   * Retrieve all metrics from the database.
   */
  getAllMetrics(): TaskEfficiencyMetrics[] {
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(
        'SELECT task_id, loc_delta, dependency_delta, token_cost, lean_enabled, completed_at FROM efficiency_metrics',
      );
      const rows = stmt.all() as Array<{
        task_id: string;
        loc_delta: number;
        dependency_delta: number;
        token_cost: number;
        lean_enabled: number;
        completed_at: string;
      }>;

      return rows.map(row => ({
        taskId: row.task_id,
        locDelta: row.loc_delta,
        dependencyDelta: row.dependency_delta,
        tokenCost: row.token_cost,
        leanEnabled: row.lean_enabled === 1,
        timestamp: row.completed_at,
      }));
    } catch {
      return [];
    }
  }

  // ─── Private ────────────────────────────────────────────────

  /**
   * Get token cost from CostTrackingService.
   * Returns 0 if service is unavailable (partial failure tolerance).
   */
  private getTokenCostFromService(): number {
    if (!this.costTrackingService) return 0;
    try {
      return this.costTrackingService.getSessionCost();
    } catch {
      return 0;
    }
  }

  /**
   * Retrieve metrics for a task suite filtered by lean-enabled state.
   */
  private getMetricsBySuite(taskSuiteId: string, leanEnabled: boolean): TaskEfficiencyMetrics[] {
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(
        `SELECT task_id, loc_delta, dependency_delta, token_cost, lean_enabled, completed_at
         FROM efficiency_metrics
         WHERE task_id LIKE ? AND lean_enabled = ?`,
      );
      const rows = stmt.all(`${taskSuiteId}%`, leanEnabled ? 1 : 0) as Array<{
        task_id: string;
        loc_delta: number;
        dependency_delta: number;
        token_cost: number;
        lean_enabled: number;
        completed_at: string;
      }>;

      return rows.map(row => ({
        taskId: row.task_id,
        locDelta: row.loc_delta,
        dependencyDelta: row.dependency_delta,
        tokenCost: row.token_cost,
        leanEnabled: row.lean_enabled === 1,
        timestamp: row.completed_at,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Compute average of an array of numbers.
   * Returns 0 for empty arrays.
   */
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Compute percentage reduction from baseline to current.
   * Returns 0 when baseline is 0 to avoid division by zero.
   */
  private percentageReduction(baseline: number, current: number): number {
    if (baseline === 0) return 0;
    return ((baseline - current) / Math.abs(baseline)) * 100;
  }
}
