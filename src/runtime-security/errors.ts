/**
 * Error classes for the Runtime Security subsystems.
 *
 * These errors follow the graceful degradation pattern: when a subsystem
 * throws an unhandled error, the executeFeatureGuarded wrapper catches it,
 * disables only that subsystem, and logs the error.
 *
 * Requirements: 1.8, 4.7
 */

// ─── Base Error ─────────────────────────────────────────────────

/**
 * Base error class for all runtime security errors.
 * Subsystem errors extending this class are caught by executeFeatureGuarded
 * for graceful degradation.
 */
export class RuntimeSecurityError extends Error {
  public readonly subsystem: string;

  constructor(message: string, subsystem: string) {
    super(message);
    this.name = 'RuntimeSecurityError';
    this.subsystem = subsystem;
    Object.setPrototypeOf(this, RuntimeSecurityError.prototype);
  }
}

// ─── Config Validation Error ────────────────────────────────────

/**
 * Thrown when configuration validation fails (e.g., malformed JSON config,
 * invalid weights, missing required fields).
 *
 * The message identifies the specific invalid field for descriptive error reporting.
 */
export class ConfigValidationError extends RuntimeSecurityError {
  public readonly field: string;

  constructor(message: string, subsystem: string, field: string) {
    super(message, subsystem);
    this.name = 'ConfigValidationError';
    this.field = field;
    Object.setPrototypeOf(this, ConfigValidationError.prototype);
  }
}

// ─── Latency Budget Exceeded Error ──────────────────────────────

/**
 * Thrown when a subsystem exceeds its latency budget.
 *
 * For example, the Realtime Code Analyzer has a 200ms budget and the
 * Hackability Scoring Engine has a 500ms budget per file.
 * When exceeded, the subsystem allows the operation to proceed and
 * emits an asynchronous finding rather than blocking indefinitely.
 */
export class LatencyBudgetExceededError extends RuntimeSecurityError {
  public readonly budgetMs: number;
  public readonly actualMs: number;

  constructor(subsystem: string, budgetMs: number, actualMs: number) {
    super(
      `${subsystem} exceeded latency budget: ${actualMs}ms > ${budgetMs}ms`,
      subsystem,
    );
    this.name = 'LatencyBudgetExceededError';
    this.budgetMs = budgetMs;
    this.actualMs = actualMs;
    Object.setPrototypeOf(this, LatencyBudgetExceededError.prototype);
  }
}
