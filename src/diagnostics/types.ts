/**
 * Type definitions for the DiagnosticsEngine module.
 *
 * Requirements: 1.1
 */

// ─── Health Check Result ────────────────────────────────────────

export interface HealthCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
  durationMs: number;
  timedOut?: boolean;
}

// ─── Diagnostics Report ─────────────────────────────────────────

export interface DiagnosticsReport {
  timestamp: number;
  checks: HealthCheckResult[];
  totalDurationMs: number;
  completedAll: boolean;
}

// ─── Health Check Interface ─────────────────────────────────────

export interface HealthCheck {
  name: string;
  run(): Promise<HealthCheckResult>;
}
