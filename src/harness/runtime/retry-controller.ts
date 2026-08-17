/**
 * Retry_Controller — Finite Provider Retry and Recovery
 *
 * Classifies provider failures, applies configured attempt/elapsed/backoff/jitter/delay
 * budgets, clamps retry-after values, aborts on signal, prevents same-route retry for
 * nonretryable classes, and appends durable retry decisions.
 *
 * Requirements: 18.1–18.7, 45.2
 */

import type {
  ProviderErrorClass,
  ProviderErrorInput,
  RetryPolicy,
  RetryDecisionRecord,
  RetryDecisionOutcome,
  NonretryablePolicy,
} from './retry-schemas';
import {
  NONRETRYABLE_CLASSES,
  ROUTE_RETRYABLE_CLASSES,
  DEFAULT_TRANSIENT_POLICY,
  ProviderErrorClassSchema,
  RetryDecisionRecordSchema,
} from './retry-schemas';

// ─── Retry State ────────────────────────────────────────────────

/**
 * Internal state tracking retry progress for a single request/route.
 */
export interface RetryState {
  /** Current attempt number (starts at 1 for the first failure). */
  attemptNumber: number;
  /** Timestamp of the first attempt in milliseconds (epoch). */
  startedAt: number;
  /** Total delay accumulated across all waits in milliseconds. */
  totalDelayMs: number;
  /** All decisions made for this retry sequence. */
  decisions: RetryDecisionRecord[];
}

// ─── Retry Controller Configuration ────────────────────────────

export interface RetryControllerConfig {
  /** Route-specific retry policies keyed by route ID. */
  routePolicies?: Record<string, RetryPolicy>;
  /** Default policy applied when no route-specific policy exists. */
  defaultPolicy?: RetryPolicy;
  /** ID generator for decision records. */
  generateId?: () => string;
  /** Time source for testability. */
  now?: () => number;
  /** Jitter source for testability — returns value in [0, 1]. */
  random?: () => number;
}

// ─── Retry Controller Result ────────────────────────────────────

export interface RetryResult {
  /** The decision outcome. */
  outcome: RetryDecisionOutcome;
  /** Delay to wait before next attempt (0 if no retry). */
  delayMs: number;
  /** The durable decision record. */
  record: RetryDecisionRecord;
  /** Applied nonretryable policy (only for 'nonretryable' outcome). */
  appliedPolicy?: NonretryablePolicy;
}

// ─── Error Classifier ───────────────────────────────────────────

/**
 * Classify a provider error into one of the defined error classes (Requirement 18.1).
 */
export function classifyProviderError(error: ProviderErrorInput): ProviderErrorClass {
  const { statusCode, errorCode, message } = error;

  // Cancellation
  if (errorCode === 'ABORT_ERR' || errorCode === 'CANCELLED' || message.toLowerCase().includes('aborted')) {
    return 'cancellation';
  }

  // Authentication (401, 403)
  if (statusCode === 401 || statusCode === 403) {
    return 'authentication';
  }

  // Rate limit (429)
  if (statusCode === 429) {
    return 'rate_limit';
  }

  // Invalid request (400, 422)
  if (statusCode === 400 || statusCode === 422) {
    return 'invalid_request';
  }

  // Safety refusal — specific codes or content filter signals
  if (
    errorCode === 'content_filter' ||
    errorCode === 'safety_refusal' ||
    message.toLowerCase().includes('content policy') ||
    message.toLowerCase().includes('safety')
  ) {
    return 'safety_refusal';
  }

  // Quota exhaustion
  if (
    errorCode === 'quota_exceeded' ||
    errorCode === 'insufficient_quota' ||
    message.toLowerCase().includes('quota')
  ) {
    return 'quota_exhaustion';
  }

  // Server failure (5xx)
  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
    return 'server_failure';
  }

  // Transient transport errors (connection-level)
  if (
    errorCode === 'ECONNRESET' ||
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'ENETUNREACH' ||
    errorCode === 'EPIPE' ||
    errorCode === 'ENOTFOUND' ||
    statusCode === 408
  ) {
    return 'transient_transport';
  }

  // If explicitly marked retryable by provider, treat as transient
  if (error.retryable === true) {
    return 'transient_transport';
  }

  return 'unknown';
}

// ─── Retry Controller ───────────────────────────────────────────

export class RetryController {
  private readonly routePolicies: Record<string, RetryPolicy>;
  private readonly defaultPolicy: RetryPolicy;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(config: RetryControllerConfig = {}) {
    this.routePolicies = config.routePolicies ?? {};
    this.defaultPolicy = config.defaultPolicy ?? DEFAULT_TRANSIENT_POLICY;
    this.generateId = config.generateId ?? (() => `retry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.now = config.now ?? (() => Date.now());
    this.random = config.random ?? (() => Math.random());
  }

  /**
   * Get the applicable retry policy for a route.
   * Falls back to default policy if no route-specific policy exists.
   */
  getPolicy(routeId: string): RetryPolicy {
    return this.routePolicies[routeId] ?? this.defaultPolicy;
  }

  /**
   * Evaluate whether to retry after a provider failure.
   *
   * Requirement 18.1: Classify the error.
   * Requirement 18.2: Apply route's finite budgets.
   * Requirement 18.3: Honor retry-after within remaining budgets.
   * Requirement 18.4: If abort signal is raised, stop waiting and prevent attempts.
   * Requirement 18.5: Nonretryable classes never retry on same route.
   * Requirement 18.6: Append durable retry decision record.
   * Requirement 18.7: Absent policy uses finite default.
   */
  evaluate(
    error: ProviderErrorInput,
    state: RetryState,
    context: {
      sessionId: string;
      correlationId: string;
      aborted?: boolean;
    },
  ): RetryResult {
    const errorClass = classifyProviderError(error);
    const policy = this.getPolicy(error.routeId);
    const currentTime = this.now();
    const elapsedMs = currentTime - state.startedAt;

    // Requirement 18.4: Abort signal stops immediately
    if (context.aborted) {
      return this.makeDecision({
        outcome: 'aborted',
        delayMs: 0,
        errorClass,
        error,
        state,
        policy,
        context,
        elapsedMs,
      });
    }

    // Requirement 18.5: Nonretryable classes never retry on same route
    if (NONRETRYABLE_CLASSES.has(errorClass)) {
      return this.makeDecision({
        outcome: 'nonretryable',
        delayMs: 0,
        errorClass,
        error,
        state,
        policy,
        context,
        elapsedMs,
        appliedPolicy: policy.nonretryablePolicy,
      });
    }

    // Requirement 18.7: Unknown errors with no explicit retryable flag use no-retry default
    if (errorClass === 'unknown' && error.retryable !== true) {
      return this.makeDecision({
        outcome: 'nonretryable',
        delayMs: 0,
        errorClass,
        error,
        state,
        policy,
        context,
        elapsedMs,
        appliedPolicy: policy.nonretryablePolicy,
      });
    }

    // Requirement 18.2: Check attempt budget
    if (state.attemptNumber >= policy.maxAttempts) {
      return this.makeDecision({
        outcome: 'exhausted',
        delayMs: 0,
        errorClass,
        error,
        state,
        policy,
        context,
        elapsedMs,
      });
    }

    // Compute exponential backoff with jitter
    let delayMs = this.computeBackoff(state.attemptNumber, policy);

    // Requirement 18.3: Honor retry-after within budgets
    if (error.retryAfterMs !== undefined && error.retryAfterMs > 0) {
      // Clamp retry-after to configured maximum
      const clampedRetryAfter = Math.min(error.retryAfterMs, policy.maxRetryAfterMs);
      // Use the larger of computed backoff and clamped retry-after
      delayMs = Math.max(delayMs, clampedRetryAfter);
    }

    // Clamp delay to maximum per-attempt delay
    delayMs = Math.min(delayMs, policy.maxDelayMs);

    // Requirement 18.2: Check elapsed time budget
    if (elapsedMs + delayMs > policy.maxElapsedMs) {
      return this.makeDecision({
        outcome: 'budget_exceeded',
        delayMs: 0,
        errorClass,
        error,
        state,
        policy,
        context,
        elapsedMs,
      });
    }

    // Requirement 18.2: Check total delay budget
    if (state.totalDelayMs + delayMs > policy.maxTotalDelayMs) {
      return this.makeDecision({
        outcome: 'budget_exceeded',
        delayMs: 0,
        errorClass,
        error,
        state,
        policy,
        context,
        elapsedMs,
      });
    }

    // All checks pass — retry
    return this.makeDecision({
      outcome: 'retry',
      delayMs,
      errorClass,
      error,
      state,
      policy,
      context,
      elapsedMs,
    });
  }

  /**
   * Execute a wait with abort support (Requirement 18.4).
   * Returns true if wait completed, false if aborted.
   */
  async wait(delayMs: number, signal?: AbortSignal): Promise<boolean> {
    if (delayMs <= 0) return true;
    if (signal?.aborted) return false;

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(false);
      };

      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, delayMs);

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Create a fresh retry state for a new request.
   */
  createState(): RetryState {
    return {
      attemptNumber: 0,
      startedAt: this.now(),
      totalDelayMs: 0,
      decisions: [],
    };
  }

  /**
   * Advance state after a retry decision.
   * Call this after evaluate() to track state for next attempt.
   */
  advanceState(state: RetryState, result: RetryResult): RetryState {
    return {
      attemptNumber: state.attemptNumber + 1,
      startedAt: state.startedAt,
      totalDelayMs: state.totalDelayMs + result.delayMs,
      decisions: [...state.decisions, result.record],
    };
  }

  /**
   * Validate a retry decision record against the schema.
   * Returns the validated record or undefined on failure.
   */
  validateRecord(record: unknown): RetryDecisionRecord | undefined {
    const result = RetryDecisionRecordSchema.safeParse(record);
    return result.success ? result.data : undefined;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Compute exponential backoff with jitter (Requirement 18.2).
   * delay = baseDelay * 2^(attempt-1) + jitter
   */
  private computeBackoff(attemptNumber: number, policy: RetryPolicy): number {
    const exponential = policy.baseDelayMs * Math.pow(2, attemptNumber - 1);
    const capped = Math.min(exponential, policy.maxDelayMs);
    const jitter = capped * policy.jitterFactor * this.random();
    return Math.round(capped + jitter);
  }

  /**
   * Build a RetryResult with a durable decision record.
   */
  private makeDecision(params: {
    outcome: RetryDecisionOutcome;
    delayMs: number;
    errorClass: ProviderErrorClass;
    error: ProviderErrorInput;
    state: RetryState;
    policy: RetryPolicy;
    context: { sessionId: string; correlationId: string };
    elapsedMs: number;
    appliedPolicy?: NonretryablePolicy;
  }): RetryResult {
    const record: RetryDecisionRecord = {
      decisionId: this.generateId(),
      sessionId: params.context.sessionId,
      correlationId: params.context.correlationId,
      routeId: params.error.routeId,
      errorClass: params.errorClass,
      errorCode: params.error.errorCode,
      errorMessage: params.error.message,
      attemptNumber: params.state.attemptNumber + 1,
      maxAttempts: params.policy.maxAttempts,
      delayMs: params.delayMs,
      elapsedMs: params.elapsedMs,
      totalDelayMs: params.state.totalDelayMs + params.delayMs,
      providerRetryAfterMs: params.error.retryAfterMs,
      outcome: params.outcome,
      appliedPolicy: params.appliedPolicy,
      decidedAt: new Date(this.now()).toISOString(),
      schemaVersion: 1 as const,
    };

    return {
      outcome: params.outcome,
      delayMs: params.delayMs,
      record,
      appliedPolicy: params.appliedPolicy,
    };
  }
}
