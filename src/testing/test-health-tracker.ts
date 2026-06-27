/**
 * Test Health Tracker — Interfaces for test execution analytics and health monitoring.
 *
 * Tracks test execution history to compute flakiness rates, failure rates,
 * duration trends, and overall test suite health metrics.
 *
 * Requirements: 11.1–11.7
 */

// Dependencies: better-sqlite3, CallbackEngine (used at implementation time)

// ─── Types ──────────────────────────────────────────────────────

/** Test execution record */
export interface TestExecutionRecord {
  testFilePath: string;
  testName: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  timestamp: string;
  suiteRunId: string;
}

/** Health metrics for a single test */
export interface TestHealthMetrics {
  testFilePath: string;
  testName: string;
  totalExecutions: number;
  flakinessRate: number;       // 0-1 (percentage of non-deterministic outcomes)
  failureRate: number;         // 0-1 (failures / total)
  averageDurationMs: number;
  lastStatus: 'pass' | 'fail' | 'skip';
  lastExecutedAt: string;
  trend: 'improving' | 'stable' | 'degrading';
}

/** Health query options */
export interface HealthQueryOptions {
  windowDays?: number;         // default: 30
  sortBy?: 'flakiness' | 'failure-rate' | 'duration';
  limit?: number;
  minExecutions?: number;      // minimum executions to include (default: 5)
}

/** Test Health Tracker interface */
export interface ITestHealthTracker {
  record(executions: TestExecutionRecord[]): void;
  getMetrics(testFilePath: string, testName: string): TestHealthMetrics | null;
  queryProblematic(options?: HealthQueryOptions): TestHealthMetrics[];
  getOverallHealth(): { totalTests: number; flakyTests: number; failingTests: number };
}
