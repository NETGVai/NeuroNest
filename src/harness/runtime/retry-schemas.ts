/**
 * Retry Controller Schemas
 *
 * Defines error classification, retry policy configuration, and durable
 * retry decision records for bounded provider retry and recovery.
 *
 * Requirements: 18.1–18.7, 45.2
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../contracts/primitives';

// ─── Error Classification ───────────────────────────────────────

/**
 * Provider failure classification per Requirement 18.1.
 *
 * - transient_transport: network failures, connection resets
 * - rate_limit: 429 or equivalent rate limiting
 * - server_failure: 5xx responses from provider
 * - authentication: invalid/expired credentials (nonretryable on same route)
 * - invalid_request: malformed request rejected by provider (nonretryable)
 * - quota_exhaustion: account/plan quota exceeded (nonretryable)
 * - safety_refusal: content safety filter triggered (nonretryable)
 * - cancellation: request cancelled by abort signal or user
 * - unknown: unclassified failure
 */
export const ProviderErrorClassSchema = z.enum([
  'transient_transport',
  'rate_limit',
  'server_failure',
  'authentication',
  'invalid_request',
  'quota_exhaustion',
  'safety_refusal',
  'cancellation',
  'unknown',
]);

export type ProviderErrorClass = z.infer<typeof ProviderErrorClassSchema>;

/**
 * Error classes that are NEVER retryable on the same route (Requirement 18.5).
 */
export const NONRETRYABLE_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  'authentication',
  'invalid_request',
  'quota_exhaustion',
  'safety_refusal',
]);

/**
 * Error classes eligible for same-route retry (Requirement 18.2).
 */
export const ROUTE_RETRYABLE_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  'transient_transport',
  'rate_limit',
  'server_failure',
]);

// ─── Nonretryable Resolution Policy ────────────────────────────

/**
 * When a nonretryable error occurs, the configured policy determines what to do.
 * Requirement 18.5: apply only an explicitly configured ask, stop, or compatible-route policy.
 */
export const NonretryablePolicySchema = z.enum([
  'ask',             // Prompt user/collaboration for decision
  'stop',            // Halt immediately
  'compatible_route', // Try a different compatible route
]);

export type NonretryablePolicy = z.infer<typeof NonretryablePolicySchema>;

// ─── Retry Policy Configuration ─────────────────────────────────

/**
 * Route-specific retry policy. All budgets are finite positive numbers.
 * Requirement 18.2: finite attempt count, total elapsed-time budget,
 * bounded exponential backoff, jitter limit, and maximum delay.
 */
export const RetryPolicySchema = z.object({
  /** Maximum number of retry attempts (positive integer). */
  maxAttempts: z.number().int().positive().finite(),

  /** Maximum total elapsed time for all attempts in milliseconds. */
  maxElapsedMs: z.number().positive().finite(),

  /** Maximum total delay budget across all waits in milliseconds. */
  maxTotalDelayMs: z.number().positive().finite(),

  /** Base delay for exponential backoff in milliseconds. */
  baseDelayMs: z.number().positive().finite(),

  /** Maximum delay between attempts in milliseconds. */
  maxDelayMs: z.number().positive().finite(),

  /** Jitter factor [0, 1] — fraction of delay added as random jitter. */
  jitterFactor: z.number().min(0).max(1).finite(),

  /** Maximum retry-after value to honor from provider in milliseconds. */
  maxRetryAfterMs: z.number().positive().finite(),

  /** Policy for nonretryable error classes. */
  nonretryablePolicy: NonretryablePolicySchema,
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * Default finite retry policy for transient errors (Requirement 18.7).
 * No automatic retry for non-transient errors.
 */
export const DEFAULT_TRANSIENT_POLICY: RetryPolicy = {
  maxAttempts: 3,
  maxElapsedMs: 60_000,
  maxTotalDelayMs: 30_000,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  jitterFactor: 0.2,
  maxRetryAfterMs: 30_000,
  nonretryablePolicy: 'stop',
};

// ─── Retry Decision ─────────────────────────────────────────────

/**
 * Retry decision outcome: what the controller decided to do.
 */
export const RetryDecisionOutcomeSchema = z.enum([
  'retry',           // Will retry on same route
  'exhausted',       // All attempts used
  'budget_exceeded', // Elapsed or delay budget exceeded
  'aborted',         // Abort signal fired
  'nonretryable',    // Error class is not retryable on same route
]);

export type RetryDecisionOutcome = z.infer<typeof RetryDecisionOutcomeSchema>;

/**
 * Durable retry decision record appended to Session_Log (Requirement 18.6).
 * Contains error class, attempt, delay, route, and decision.
 * This is a non-model-visible event.
 */
export const RetryDecisionRecordSchema = z.object({
  /** Unique decision record identity. */
  decisionId: IdentifierSchema,

  /** Session this decision belongs to. */
  sessionId: IdentifierSchema,

  /** Turn/request correlation. */
  correlationId: IdentifierSchema,

  /** Route that produced the error. */
  routeId: IdentifierSchema,

  /** Classified error type. */
  errorClass: ProviderErrorClassSchema,

  /** Provider error code if available. */
  errorCode: z.string().optional(),

  /** Provider error message (may be redacted). */
  errorMessage: z.string().optional(),

  /** Current attempt number (1-based). */
  attemptNumber: z.number().int().positive(),

  /** Maximum configured attempts. */
  maxAttempts: z.number().int().positive(),

  /** Computed delay before next attempt in milliseconds (0 if no retry). */
  delayMs: z.number().nonnegative().finite(),

  /** Total elapsed time since first attempt in milliseconds. */
  elapsedMs: z.number().nonnegative().finite(),

  /** Total delay accumulated so far in milliseconds. */
  totalDelayMs: z.number().nonnegative().finite(),

  /** Provider retry-after value if present (before clamping), in milliseconds. */
  providerRetryAfterMs: z.number().nonnegative().finite().optional(),

  /** The outcome of this decision. */
  outcome: RetryDecisionOutcomeSchema,

  /** Applied nonretryable policy if outcome is 'nonretryable'. */
  appliedPolicy: NonretryablePolicySchema.optional(),

  /** When this decision was made. */
  decidedAt: TimestampSchema,

  /** Schema version for forward compatibility. */
  schemaVersion: z.literal(1),
}).passthrough();

export type RetryDecisionRecord = z.infer<typeof RetryDecisionRecordSchema>;

// ─── Provider Error Input ───────────────────────────────────────

/**
 * Raw provider error input that the Retry_Controller classifies.
 */
export const ProviderErrorInputSchema = z.object({
  /** HTTP status code if applicable. */
  statusCode: z.number().int().optional(),

  /** Provider-specific error code string. */
  errorCode: z.string().optional(),

  /** Error message. */
  message: z.string(),

  /** Provider retry-after header value in milliseconds if present. */
  retryAfterMs: z.number().nonnegative().finite().optional(),

  /** Route that generated this error. */
  routeId: IdentifierSchema,

  /** Whether this is explicitly flagged retryable by the provider. */
  retryable: z.boolean().optional(),
}).passthrough();

export type ProviderErrorInput = z.infer<typeof ProviderErrorInputSchema>;
