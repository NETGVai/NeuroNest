/**
 * Job Service Schemas — Durable owner-scoped jobs and bounded continuation.
 *
 * Defines schemas for job creation, ownership, authorization, terminal results,
 * continuation bounds, durability transfer, and lifecycle transitions.
 *
 * Requirements: 5.7, 20.1–20.3, 20.5, 20.8
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Job State ──────────────────────────────────────────────────

/**
 * Lifecycle state of a durable job (Requirement 20.1).
 *
 * - pending: ownership persisted, dispatch not yet started
 * - running: work has been dispatched
 * - completed: terminal success — result committed atomically
 * - failed: terminal failure — result committed atomically
 * - cancelled: terminal cancellation — result committed atomically
 */
export const JobStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export type JobState = z.infer<typeof JobStateSchema>;

/**
 * Terminal states — once reached, no further transitions are allowed.
 */
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

// ─── Job Type ───────────────────────────────────────────────────

/**
 * Kind of job being dispatched.
 *
 * - subagent: delegated to a child agent
 * - workflow: a multi-step workflow
 * - background: generic background work
 * - continuation: a bounded continuation round
 */
export const JobTypeSchema = z.enum([
  'subagent',
  'workflow',
  'background',
  'continuation',
]);

export type JobType = z.infer<typeof JobTypeSchema>;

// ─── Cancellation Policy ────────────────────────────────────────

/**
 * How the job responds to owner or signal-based cancellation (Requirement 20.8).
 *
 * - immediate: cancel as soon as signal arrives
 * - drain: allow in-progress work to complete, then cancel
 * - ignore: job runs until terminal regardless (used for explicitly durable children)
 */
export const CancellationPolicySchema = z.enum([
  'immediate',
  'drain',
  'ignore',
]);

export type CancellationPolicy = z.infer<typeof CancellationPolicySchema>;

// ─── Continuation Bounds ────────────────────────────────────────

/**
 * Configurable finite bounds that govern continuation (Requirement 20.5).
 * All values must be positive and finite. The first exhausted bound stops
 * further rounds.
 */
export const ContinuationBoundsSchema = z.object({
  /** Maximum number of continuation rounds (positive integer). */
  maxRounds: z.number().int().positive().finite(),

  /** Maximum total elapsed time in milliseconds. */
  maxTimeMs: z.number().positive().finite(),

  /** Maximum total token budget (input + output). */
  maxTokens: z.number().int().positive().finite(),

  /** Maximum total cost budget (in smallest currency unit). */
  maxCost: z.number().positive().finite(),

  /** Maximum total output bytes. */
  maxOutputBytes: z.number().int().positive().finite().optional(),
}).passthrough();

export type ContinuationBounds = z.infer<typeof ContinuationBoundsSchema>;

/**
 * Default continuation bounds — conservative limits.
 */
export const DEFAULT_CONTINUATION_BOUNDS: ContinuationBounds = {
  maxRounds: 10,
  maxTimeMs: 300_000,
  maxTokens: 100_000,
  maxCost: 10_000,
};

// ─── Continuation Progress ──────────────────────────────────────

/**
 * Tracks current consumption against configured bounds (Requirement 20.5).
 */
export const ContinuationProgressSchema = z.object({
  /** Rounds completed so far. */
  roundsCompleted: z.number().int().nonnegative(),

  /** Elapsed time in milliseconds since dispatch. */
  elapsedMs: z.number().nonnegative().finite(),

  /** Tokens consumed so far. */
  tokensUsed: z.number().int().nonnegative(),

  /** Cost accumulated so far. */
  costAccumulated: z.number().nonnegative().finite(),

  /** Output bytes emitted so far. */
  outputBytes: z.number().int().nonnegative().optional(),
}).passthrough();

export type ContinuationProgress = z.infer<typeof ContinuationProgressSchema>;

// ─── Job Ownership Record ───────────────────────────────────────

/**
 * Persisted BEFORE dispatch (Requirement 20.1).
 * Establishes durable ownership, scope, budgets, and cancellation policy.
 */
export const JobOwnershipRecordSchema = z.object({
  /** Unique stable job identity. */
  jobId: IdentifierSchema,

  /** Session this job belongs to. */
  sessionId: IdentifierSchema,

  /** Owner (user/agent/service) identity — JSON actor reference. */
  owner: IdentifierSchema,

  /** Scope boundaries for this job. */
  scope: ScopeDescriptorV1Schema,

  /** Parent job if this is a child. */
  parentJobId: IdentifierSchema.optional(),

  /** Kind of work. */
  jobType: JobTypeSchema,

  /** Human-readable goal description. */
  goal: z.string().optional(),

  /** Resource and continuation bounds. */
  bounds: ContinuationBoundsSchema,

  /** How this job responds to cancellation signals. */
  cancellationPolicy: CancellationPolicySchema,

  /** Whether this job is explicitly durable (survives parent session end). */
  durable: z.boolean(),

  /** Retention policy for results after completion. */
  retention: z.enum(['session', 'durable', 'ephemeral']),

  /** Idempotency key to prevent duplicate creation. */
  idempotencyKey: IdentifierSchema.optional(),

  /** Schema version for forward compatibility. */
  schemaVersion: z.literal(1),

  /** When ownership was persisted. */
  createdAt: TimestampSchema,
}).passthrough();

export type JobOwnershipRecord = z.infer<typeof JobOwnershipRecordSchema>;

// ─── Job Creation Request ───────────────────────────────────────

/**
 * Input for creating a new durable job. Ownership is persisted before dispatch.
 */
export const JobCreationRequestSchema = z.object({
  /** Unique job identity (generated by caller). */
  jobId: IdentifierSchema,

  /** Session this job is created within. */
  sessionId: IdentifierSchema,

  /** Owner (user/agent/service) identity. */
  owner: IdentifierSchema,

  /** Scope boundaries for authorization. */
  scope: ScopeDescriptorV1Schema,

  /** Optional parent job for hierarchical delegation. */
  parentJobId: IdentifierSchema.optional(),

  /** Kind of background work. */
  jobType: JobTypeSchema,

  /** Goal or purpose of this job. */
  goal: z.string().optional(),

  /** Finite resource and continuation bounds. */
  bounds: ContinuationBoundsSchema,

  /** Cancellation policy. */
  cancellationPolicy: CancellationPolicySchema.optional(),

  /** Whether explicitly durable (survives parent session end). */
  durable: z.boolean().optional(),

  /** Retention policy. */
  retention: z.enum(['session', 'durable', 'ephemeral']).optional(),

  /** Idempotency key. */
  idempotencyKey: IdentifierSchema.optional(),
}).passthrough();

export type JobCreationRequest = z.infer<typeof JobCreationRequestSchema>;

// ─── Job Terminal Result ────────────────────────────────────────

/**
 * Terminal result committed atomically (Requirement 20.3).
 * Once committed, the job is immutably in its terminal state.
 */
export const JobTerminalResultSchema = z.object({
  /** The terminal state reached. */
  terminalState: z.enum(['completed', 'failed', 'cancelled']),

  /** Result payload (success value or failure detail). */
  resultPayload: z.unknown().optional(),

  /** Reference to a durable result if stored externally. */
  resultRef: IdentifierSchema.optional(),

  /** Why this terminal state was reached. */
  reason: z.string().optional(),

  /** Continuation progress at termination. */
  finalProgress: ContinuationProgressSchema,

  /** When the terminal result was committed. */
  committedAt: TimestampSchema,

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type JobTerminalResult = z.infer<typeof JobTerminalResultSchema>;

// ─── Job Progress Report ────────────────────────────────────────

/**
 * Observe-only progress report (Requirement 5.3 — observe without mutating parent context).
 */
export const JobProgressReportSchema = z.object({
  /** Job this progress belongs to. */
  jobId: IdentifierSchema,

  /** Current round number. */
  currentRound: z.number().int().nonnegative(),

  /** Current state. */
  state: JobStateSchema,

  /** Progress against continuation bounds. */
  progress: ContinuationProgressSchema,

  /** Human-readable status message. */
  message: z.string().optional(),

  /** When this report was generated. */
  reportedAt: TimestampSchema,

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type JobProgressReport = z.infer<typeof JobProgressReportSchema>;

// ─── Job Authorization Context ──────────────────────────────────

/**
 * Context used to authorize observe/wait/cancel/result operations (Requirement 20.2).
 */
export const JobAuthorizationContextSchema = z.object({
  /** The actor requesting the operation. */
  actorId: IdentifierSchema,

  /** The actor's scope descriptor. */
  actorScope: ScopeDescriptorV1Schema,

  /** The operation being requested. */
  operation: z.enum(['observe', 'wait', 'cancel', 'result']),

  /** The target job ID. */
  jobId: IdentifierSchema,
}).passthrough();

export type JobAuthorizationContext = z.infer<typeof JobAuthorizationContextSchema>;

// ─── Job Transition Event ───────────────────────────────────────

/**
 * Durable state transition record for job lifecycle events.
 */
export const JobTransitionEventSchema = z.object({
  /** Unique transition event identity. */
  transitionId: IdentifierSchema,

  /** Job this transition belongs to. */
  jobId: IdentifierSchema,

  /** Previous state. */
  fromState: JobStateSchema,

  /** New state. */
  toState: JobStateSchema,

  /** What caused this transition. */
  cause: z.enum([
    'dispatch',
    'round_complete',
    'bounds_exhausted',
    'success',
    'failure',
    'cancel_requested',
    'owner_deleted',
    'session_deleted',
    'parent_cancelled',
    'durability_transfer',
  ]),

  /** Additional cause detail. */
  causeDetail: z.string().optional(),

  /** Actor who triggered the transition. */
  actor: IdentifierSchema.optional(),

  /** When this transition occurred. */
  occurredAt: TimestampSchema,

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type JobTransitionEvent = z.infer<typeof JobTransitionEventSchema>;

// ─── Durability Transfer Request ────────────────────────────────

/**
 * Request to transfer explicitly durable children to Job_Service ownership
 * when a parent session ends (Requirement 5.7).
 */
export const DurabilityTransferRequestSchema = z.object({
  /** The session that is ending. */
  endingSessionId: IdentifierSchema,

  /** New owner identity for transferred jobs. */
  newOwner: IdentifierSchema,

  /** When the transfer was requested. */
  requestedAt: TimestampSchema,
}).passthrough();

export type DurabilityTransferRequest = z.infer<typeof DurabilityTransferRequestSchema>;

// ─── Bound Exhaustion Detail ────────────────────────────────────

/**
 * Describes which bound was exhausted and the values at exhaustion (Requirement 20.5).
 */
export const BoundExhaustionDetailSchema = z.object({
  /** Which bound was exhausted first. */
  exhaustedBound: z.enum(['rounds', 'time', 'tokens', 'cost', 'output_bytes']),

  /** Configured limit for that bound. */
  configuredLimit: z.number().positive().finite(),

  /** Actual value at the point of exhaustion. */
  actualValue: z.number().nonnegative().finite(),

  /** All bounds and their current values at exhaustion time. */
  allBoundsAtExhaustion: ContinuationProgressSchema,
}).passthrough();

export type BoundExhaustionDetail = z.infer<typeof BoundExhaustionDetailSchema>;
