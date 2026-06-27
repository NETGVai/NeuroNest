/**
 * TestHealthTracker Implementation — Test execution analytics and health monitoring.
 *
 * Tracks test execution history to compute flakiness rates, failure rates,
 * duration trends, and overall test suite health metrics. Persists all records
 * to SQLite and emits lifecycle events via CallbackEngine when health
 * thresholds are crossed.
 *
 * Key behaviours:
 *   - Records pass/fail/skip status with duration and timestamp to SQLite
 *   - Computes flakiness rate: proportion of adjacent status transitions / (total - 1)
 *   - Computes failure rate: count(fail) / total executions over configurable window
 *   - Ranks tests by flakiness or failure rate via queryProblematic()
 *   - Returns aggregate health metrics via getOverallHealth()
 *   - Emits 'on-task-complete' event when health thresholds are crossed
 *   - Applies null-check guard when `test_health_analytics` flag is disabled
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type {
  ITestHealthTracker,
  TestExecutionRecord,
  TestHealthMetrics,
  HealthQueryOptions,
} from './test-health-tracker.js';

// ─── Configuration ──────────────────────────────────────────────

export interface TestHealthTrackerConfig {
  /** Flakiness rate threshold to emit a "test became flaky" event. Default: 0.3 */
  flakinessThreshold?: number;
  /** Failure rate threshold to emit a "test failing" event. Default: 0.5 */
  failureRateThreshold?: number;
  /** Default window in days for metrics computation. Default: 30 */
  defaultWindowDays?: number;
  /** Minimum executions required before computing metrics. Default: 5 */
  defaultMinExecutions?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_FLAKINESS_THRESHOLD = 0.3;
const DEFAULT_FAILURE_RATE_THRESHOLD = 0.5;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MIN_EXECUTIONS = 5;

// ─── Implementation ─────────────────────────────────────────────

export class TestHealthTracker implements ITestHealthTracker {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly callbackEngine: CallbackEngine;
  private readonly flakinessThreshold: number;
  private readonly failureRateThreshold: number;
  private readonly defaultWindowDays: number;
  private readonly defaultMinExecutions: number;

  constructor(
    db: Database.Database,
    featureGate: FeatureGateSystem,
    callbackEngine: CallbackEngine,
    config?: TestHealthTrackerConfig,
  ) {
    this.db = db;
    this.featureGate = featureGate;
    this.callbackEngine = callbackEngine;
    this.flakinessThreshold = config?.flakinessThreshold ?? DEFAULT_FLAKINESS_THRESHOLD;
    this.failureRateThreshold = config?.failureRateThreshold ?? DEFAULT_FAILURE_RATE_THRESHOLD;
    this.defaultWindowDays = config?.defaultWindowDays ?? DEFAULT_WINDOW_DAYS;
    this.defaultMinExecutions = config?.defaultMinExecutions ?? DEFAULT_MIN_EXECUTIONS;
  }

  /**
   * Record test execution results to SQLite.
   *
   * Persists each execution record and checks if health thresholds
   * have been crossed for affected tests, emitting events if so.
   *
   * Requirements: 11.1, 11.5, 11.6
   */
  record(executions: TestExecutionRecord[]): void {
    // Null-check guard: zero overhead when disabled (Req 11.7)
    if (!this.featureGate.isEnabled('test_health_analytics')) {
      return;
    }

    if (executions.length === 0) {
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO test_executions (id, test_file_path, test_name, status, duration_ms, suite_run_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((records: TestExecutionRecord[]) => {
      for (const record of records) {
        stmt.run(
          randomUUID(),
          record.testFilePath,
          record.testName,
          record.status,
          record.durationMs,
          record.suiteRunId,
          record.timestamp,
        );
      }
    });

    insertMany(executions);

    // Check thresholds for affected tests and emit events (Req 11.6)
    this.checkThresholds(executions);
  }

  /**
   * Get health metrics for a specific test.
   *
   * Returns null if the test has no recorded executions within the window.
   *
   * Requirements: 11.2, 11.3
   */
  getMetrics(testFilePath: string, testName: string): TestHealthMetrics | null {
    // Null-check guard (Req 11.7)
    if (!this.featureGate.isEnabled('test_health_analytics')) {
      return null;
    }

    const records = this.getExecutionRecords(testFilePath, testName, this.defaultWindowDays);

    if (records.length === 0) {
      return null;
    }

    return this.computeMetrics(testFilePath, testName, records);
  }

  /**
   * Query for problematic tests ranked by flakiness or failure rate.
   *
   * Supports configurable window, sort order, limit, and minimum executions filter.
   *
   * Requirements: 11.4
   */
  queryProblematic(options?: HealthQueryOptions): TestHealthMetrics[] {
    // Null-check guard (Req 11.7)
    if (!this.featureGate.isEnabled('test_health_analytics')) {
      return [];
    }

    const windowDays = options?.windowDays ?? this.defaultWindowDays;
    const sortBy = options?.sortBy ?? 'flakiness';
    const limit = options?.limit ?? 50;
    const minExecutions = options?.minExecutions ?? this.defaultMinExecutions;

    // Get all distinct tests within the window
    const cutoff = this.computeCutoffDate(windowDays);
    const distinctTests = this.db.prepare(`
      SELECT DISTINCT test_file_path, test_name
      FROM test_executions
      WHERE timestamp >= ?
      GROUP BY test_file_path, test_name
      HAVING COUNT(*) >= ?
    `).all(cutoff, minExecutions) as Array<{ test_file_path: string; test_name: string }>;

    // Compute metrics for each test
    const allMetrics: TestHealthMetrics[] = [];
    for (const test of distinctTests) {
      const records = this.getExecutionRecords(test.test_file_path, test.test_name, windowDays);
      if (records.length >= minExecutions) {
        allMetrics.push(this.computeMetrics(test.test_file_path, test.test_name, records));
      }
    }

    // Sort by the requested criterion (descending — worst first)
    allMetrics.sort((a, b) => {
      switch (sortBy) {
        case 'flakiness':
          return b.flakinessRate - a.flakinessRate;
        case 'failure-rate':
          return b.failureRate - a.failureRate;
        case 'duration':
          return b.averageDurationMs - a.averageDurationMs;
        default:
          return b.flakinessRate - a.flakinessRate;
      }
    });

    return allMetrics.slice(0, limit);
  }

  /**
   * Get aggregate health metrics across all tracked tests.
   *
   * Returns the total number of distinct tests, how many are flaky,
   * and how many are currently failing.
   *
   * Requirements: 11.4
   */
  getOverallHealth(): { totalTests: number; flakyTests: number; failingTests: number } {
    // Null-check guard (Req 11.7)
    if (!this.featureGate.isEnabled('test_health_analytics')) {
      return { totalTests: 0, flakyTests: 0, failingTests: 0 };
    }

    const cutoff = this.computeCutoffDate(this.defaultWindowDays);

    // Get all distinct tests with enough executions
    const distinctTests = this.db.prepare(`
      SELECT DISTINCT test_file_path, test_name
      FROM test_executions
      WHERE timestamp >= ?
      GROUP BY test_file_path, test_name
      HAVING COUNT(*) >= ?
    `).all(cutoff, this.defaultMinExecutions) as Array<{ test_file_path: string; test_name: string }>;

    let flakyTests = 0;
    let failingTests = 0;

    for (const test of distinctTests) {
      const records = this.getExecutionRecords(test.test_file_path, test.test_name, this.defaultWindowDays);
      if (records.length < this.defaultMinExecutions) continue;

      const metrics = this.computeMetrics(test.test_file_path, test.test_name, records);
      if (metrics.flakinessRate >= this.flakinessThreshold) {
        flakyTests++;
      }
      if (metrics.failureRate >= this.failureRateThreshold) {
        failingTests++;
      }
    }

    return {
      totalTests: distinctTests.length,
      flakyTests,
      failingTests,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Retrieve execution records for a specific test within a time window.
   * Records are ordered by timestamp ascending for flakiness computation.
   */
  private getExecutionRecords(
    testFilePath: string,
    testName: string,
    windowDays: number,
  ): Array<{ status: string; duration_ms: number; timestamp: string }> {
    const cutoff = this.computeCutoffDate(windowDays);

    return this.db.prepare(`
      SELECT status, duration_ms, timestamp
      FROM test_executions
      WHERE test_file_path = ? AND test_name = ? AND timestamp >= ?
      ORDER BY timestamp ASC
    `).all(testFilePath, testName, cutoff) as Array<{ status: string; duration_ms: number; timestamp: string }>;
  }

  /**
   * Compute health metrics from a set of execution records.
   *
   * Flakiness rate: proportion of adjacent status transitions / (total - 1)
   *   - A transition occurs when consecutive executions have different statuses
   *   - If total <= 1, flakiness is 0
   *
   * Failure rate: count(fail) / total executions
   *
   * Trend: compare first-half failure rate to second-half failure rate
   */
  private computeMetrics(
    testFilePath: string,
    testName: string,
    records: Array<{ status: string; duration_ms: number; timestamp: string }>,
  ): TestHealthMetrics {
    const total = records.length;

    // Flakiness rate: adjacent status transitions / (total - 1)  (Req 11.2)
    let transitions = 0;
    for (let i = 1; i < total; i++) {
      const current = records[i]!;
      const previous = records[i - 1]!;
      if (current.status !== previous.status) {
        transitions++;
      }
    }
    const flakinessRate = total > 1 ? transitions / (total - 1) : 0;

    // Failure rate: count(fail) / total  (Req 11.3)
    const failCount = records.filter((r) => r.status === 'fail').length;
    const failureRate = total > 0 ? failCount / total : 0;

    // Average duration
    const totalDuration = records.reduce((sum, r) => sum + r.duration_ms, 0);
    const averageDurationMs = total > 0 ? totalDuration / total : 0;

    // Last execution info
    const lastRecord = records[total - 1]!;
    const lastStatus = lastRecord.status as 'pass' | 'fail' | 'skip';
    const lastExecutedAt = lastRecord.timestamp;

    // Trend: compare first-half vs second-half failure rates
    const trend = this.computeTrend(records);

    return {
      testFilePath,
      testName,
      totalExecutions: total,
      flakinessRate,
      failureRate,
      averageDurationMs,
      lastStatus,
      lastExecutedAt,
      trend,
    };
  }

  /**
   * Compute trend by comparing failure rates in the first and second halves
   * of the execution history.
   *
   * - 'improving': second half failure rate is lower than first half
   * - 'degrading': second half failure rate is higher than first half
   * - 'stable': rates are approximately equal (within 0.05 tolerance)
   */
  private computeTrend(
    records: Array<{ status: string; duration_ms: number; timestamp: string }>,
  ): 'improving' | 'stable' | 'degrading' {
    if (records.length < 4) {
      return 'stable';
    }

    const midpoint = Math.floor(records.length / 2);
    const firstHalf = records.slice(0, midpoint);
    const secondHalf = records.slice(midpoint);

    const firstHalfFailRate = firstHalf.filter((r) => r.status === 'fail').length / firstHalf.length;
    const secondHalfFailRate = secondHalf.filter((r) => r.status === 'fail').length / secondHalf.length;

    const diff = secondHalfFailRate - firstHalfFailRate;

    if (diff < -0.05) return 'improving';
    if (diff > 0.05) return 'degrading';
    return 'stable';
  }

  /**
   * Check if health thresholds have been crossed for the affected tests
   * and emit lifecycle events via CallbackEngine.
   *
   * Emits 'on-task-complete' events with context indicating the threshold
   * crossing type (flaky or stabilized).
   *
   * Requirements: 11.6
   */
  private checkThresholds(executions: TestExecutionRecord[]): void {
    // Deduplicate affected tests
    const affectedTests = new Map<string, { testFilePath: string; testName: string }>();
    for (const exec of executions) {
      const key = `${exec.testFilePath}::${exec.testName}`;
      if (!affectedTests.has(key)) {
        affectedTests.set(key, { testFilePath: exec.testFilePath, testName: exec.testName });
      }
    }

    for (const { testFilePath, testName } of affectedTests.values()) {
      const records = this.getExecutionRecords(testFilePath, testName, this.defaultWindowDays);
      if (records.length < this.defaultMinExecutions) continue;

      const metrics = this.computeMetrics(testFilePath, testName, records);

      // Check flakiness threshold crossing
      if (metrics.flakinessRate >= this.flakinessThreshold) {
        // Emit "test became flaky" event
        void this.callbackEngine.emit({
          event: 'on-task-complete',
          sessionId: 'test-health-tracker',
          iteration: 0,
          output: {
            type: 'health-threshold-crossed',
            subType: 'test-became-flaky',
            testFilePath,
            testName,
            flakinessRate: metrics.flakinessRate,
            threshold: this.flakinessThreshold,
          },
        });
      }

      // Check failure rate threshold crossing
      if (metrics.failureRate >= this.failureRateThreshold) {
        // Emit "test failing" event
        void this.callbackEngine.emit({
          event: 'on-task-complete',
          sessionId: 'test-health-tracker',
          iteration: 0,
          output: {
            type: 'health-threshold-crossed',
            subType: 'test-failing',
            testFilePath,
            testName,
            failureRate: metrics.failureRate,
            threshold: this.failureRateThreshold,
          },
        });
      }

      // Check if a previously flaky test has stabilized
      if (metrics.flakinessRate < this.flakinessThreshold && metrics.totalExecutions > this.defaultMinExecutions) {
        // Only emit stabilized if there were transitions before (was flaky at some point)
        if (metrics.flakinessRate > 0 && metrics.flakinessRate < this.flakinessThreshold * 0.5) {
          void this.callbackEngine.emit({
            event: 'on-task-complete',
            sessionId: 'test-health-tracker',
            iteration: 0,
            output: {
              type: 'health-threshold-crossed',
              subType: 'test-stabilized',
              testFilePath,
              testName,
              flakinessRate: metrics.flakinessRate,
              threshold: this.flakinessThreshold,
            },
          });
        }
      }
    }
  }

  /**
   * Compute the ISO 8601 cutoff date string for a given window in days.
   */
  private computeCutoffDate(windowDays: number): string {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    return cutoff.toISOString();
  }
}
