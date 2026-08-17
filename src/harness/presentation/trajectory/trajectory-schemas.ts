/**
 * Trajectory Schemas — Compact trajectory summaries and verified detail views.
 *
 * Defines the schemas for:
 * - TrajectorySummaryV1: Compact inline summary keyed by durable entity identity
 * - TrajectoryDetailV1: On-demand bounded detail with dependencies, budgets, lineage
 * - TrajectoryProjectionV1: The overall trajectory projection envelope value
 * - TrajectoryQuery: Query parameters for trajectory projection
 * - CancellationCommand: Authority-routed cancellation for active entities
 * - ResultInjectionStatus: Pending/injected/rejected/omitted/superseded state
 * - BoundedLogRange: Bounded log output within configured limits
 *
 * Requirements: 42.1–42.14
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SequenceSchema } from '../../contracts/primitives';

// ─── Trajectory Entity Kind ─────────────────────────────────────

/**
 * The kind of durable entity being tracked in the trajectory.
 * Requirements: 42.1
 */
export const TrajectoryEntityKindSchema = z.enum([
  'plan',
  'subagent',
  'job',
  'workflow',
  'result_injection',
]);
export type TrajectoryEntityKind = z.infer<typeof TrajectoryEntityKindSchema>;

// ─── Trajectory Entity State ────────────────────────────────────

/**
 * The lifecycle state of a trajectory entity.
 * Cancellation remains 'cancelling' until owning authority provides terminal projection.
 * Requirements: 42.2, 42.5, 42.6, 42.13
 */
export const TrajectoryEntityStateSchema = z.enum([
  'pending',
  'active',
  'cancelling',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
]);
export type TrajectoryEntityState = z.infer<typeof TrajectoryEntityStateSchema>;

// ─── Terminal States ────────────────────────────────────────────

const TERMINAL_STATES: Set<TrajectoryEntityState> = new Set([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
]);

/**
 * Returns true if a state is terminal (entity is no longer active).
 */
export function isTerminalState(state: TrajectoryEntityState): boolean {
  return TERMINAL_STATES.has(state);
}

// ─── Result Injection Status ────────────────────────────────────

/**
 * The injection status for a child result that is eligible for parent context.
 * Requirements: 42.7
 */
export const ResultInjectionStatusSchema = z.enum([
  'pending',
  'injected',
  'rejected',
  'omitted',
  'superseded',
]);
export type ResultInjectionStatus = z.infer<typeof ResultInjectionStatusSchema>;

// ─── Cancellation Availability ──────────────────────────────────

/**
 * Whether cancellation is available and why/why not.
 * Requirements: 42.5, 42.6
 */
export const CancellationAvailabilitySchema = z.object({
  available: z.boolean(),
  /** Authority that owns cancellation for this entity. */
  authority: IdentifierSchema,
  /** Reason cancellation is unavailable when available is false. */
  unavailableReason: z.string().optional(),
}).passthrough();
export type CancellationAvailability = z.infer<typeof CancellationAvailabilitySchema>;

// ─── Progress Indicator ─────────────────────────────────────────

/**
 * Optional progress data for the compact summary.
 * Requirements: 42.2
 */
export const ProgressIndicatorSchema = z.object({
  /** Fraction complete (0.0–1.0), null if indeterminate. */
  fraction: z.number().min(0).max(1).nullable(),
  /** Human-readable progress label. */
  label: z.string().optional(),
  /** Number of completed steps. */
  completedSteps: z.number().int().nonnegative().optional(),
  /** Total number of steps (null if unknown). */
  totalSteps: z.number().int().positive().nullable().optional(),
}).passthrough();
export type ProgressIndicator = z.infer<typeof ProgressIndicatorSchema>;

// ─── Unavailable Reason ─────────────────────────────────────────

/**
 * Structured reason why trajectory data is unavailable or incomplete.
 * Requirements: 42.11, 42.14
 */
export const UnavailableReasonSchema = z.object({
  kind: z.enum(['incomplete', 'incompatible', 'stale', 'failed', 'timeout']),
  message: z.string(),
  lastVerifiedRevision: z.number().int().nonnegative().optional(),
  lastVerifiedAt: TimestampSchema.optional(),
}).passthrough();
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

// ─── Typed Failure ──────────────────────────────────────────────

export const TrajectoryFailureSchema = z.object({
  errorClass: z.string().min(1),
  message: z.string(),
  redacted: z.boolean(),
}).passthrough();
export type TrajectoryFailure = z.infer<typeof TrajectoryFailureSchema>;

// ─── Compact Trajectory Summary V1 ─────────────────────────────

/**
 * A compact inline summary keyed by durable entity identity.
 * Displayed in the main timeline. Only one summary per entity identity + revision.
 *
 * Requirements: 42.1, 42.2, 42.8, 42.9, 42.12
 */
export const TrajectorySummaryV1Schema = z.object({
  /** Durable entity identity — unique key for deduplication. */
  entityId: IdentifierSchema,
  /** Entity kind (plan, subagent, job, workflow, result_injection). */
  entityKind: TrajectoryEntityKindSchema,
  /** Current lifecycle state. */
  state: TrajectoryEntityStateSchema,
  /** Owner identity. */
  owner: IdentifierSchema,
  /** Progress indicator (optional). */
  progress: ProgressIndicatorSchema.optional(),
  /** Terminal outcome label when state is terminal. */
  terminalOutcome: z.string().optional(),
  /** Result injection status when applicable. */
  resultInjectionStatus: ResultInjectionStatusSchema.optional(),
  /** Cancellation availability. */
  cancellation: CancellationAvailabilitySchema,
  /** Content revision for incremental updates. */
  contentRevision: z.number().int().nonnegative(),
  /** Source sequence that produced this summary. */
  sourceSequence: SequenceSchema,
  /** Timestamp of last verified state. */
  lastVerifiedAt: TimestampSchema,
  /** Structured unavailable reason if records are incomplete. */
  unavailableReason: UnavailableReasonSchema.optional(),
  schemaVersion: z.literal(1),
}).passthrough();

export type TrajectorySummaryV1 = z.infer<typeof TrajectorySummaryV1Schema>;

// ─── Bounded Log Range ──────────────────────────────────────────

/**
 * Bounded log output within configured positive line and byte limits.
 * Requirements: 42.4
 */
export const BoundedLogRangeSchema = z.object({
  /** Log lines within configured bounds. */
  lines: z.array(z.string()),
  /** Total lines available. */
  totalLines: z.number().int().nonnegative(),
  /** Total bytes available. */
  totalBytes: z.number().int().nonnegative(),
  /** Start line index of this range. */
  startLine: z.number().int().nonnegative(),
  /** End line index (exclusive) of this range. */
  endLine: z.number().int().nonnegative(),
  /** Byte size of the returned range. */
  rangeBytes: z.number().int().nonnegative(),
  /** Whether more logs are available beyond this range. */
  hasMore: z.boolean(),
  /** Authorized locator for retrieving additional ranges. */
  rangeLocator: IdentifierSchema.optional(),
}).passthrough();
export type BoundedLogRange = z.infer<typeof BoundedLogRangeSchema>;

// ─── Budget Status ──────────────────────────────────────────────

/**
 * Budget allocation and usage for the entity.
 * Requirements: 42.3
 */
export const BudgetStatusSchema = z.object({
  kind: z.enum(['token', 'cost', 'time', 'continuation', 'output']),
  label: z.string(),
  used: z.number().nonnegative().finite(),
  allocated: z.number().positive().finite(),
  unit: z.string(),
}).passthrough();
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

// ─── Dependency ─────────────────────────────────────────────────

/**
 * A dependency of this trajectory entity.
 * Requirements: 42.3
 */
export const TrajectoryDependencySchema = z.object({
  entityId: IdentifierSchema,
  entityKind: TrajectoryEntityKindSchema,
  state: TrajectoryEntityStateSchema,
  label: z.string().optional(),
}).passthrough();
export type TrajectoryDependency = z.infer<typeof TrajectoryDependencySchema>;

// ─── Parent-Child Lineage ───────────────────────────────────────

/**
 * Parent-child lineage record.
 * Requirements: 42.3
 */
export const LineageRecordSchema = z.object({
  parentEntityId: IdentifierSchema.nullable(),
  parentEntityKind: TrajectoryEntityKindSchema.optional(),
  childEntityIds: z.array(IdentifierSchema),
}).passthrough();
export type LineageRecord = z.infer<typeof LineageRecordSchema>;

// ─── Trajectory Detail V1 ───────────────────────────────────────

/**
 * On-demand trajectory detail for an expanded view.
 * Contains dependencies, budgets, attempts, ownership, lineage,
 * result-injection state, and bounded logs.
 *
 * Requirements: 42.3, 42.4, 42.5, 42.6, 42.7, 42.10, 42.11
 */
export const TrajectoryDetailV1Schema = z.object({
  /** Entity identity. */
  entityId: IdentifierSchema,
  /** Entity kind. */
  entityKind: TrajectoryEntityKindSchema,
  /** Current lifecycle state. */
  state: TrajectoryEntityStateSchema,
  /** Owner identity. */
  owner: IdentifierSchema,
  /** Projected dependencies. */
  dependencies: z.array(TrajectoryDependencySchema),
  /** Budget allocations and usage. */
  budgets: z.array(BudgetStatusSchema),
  /** Current attempt number (1-based). */
  attempt: z.number().int().positive(),
  /** Parent-child lineage. */
  lineage: LineageRecordSchema,
  /** Result injection status. */
  resultInjectionStatus: ResultInjectionStatusSchema.optional(),
  /** Bounded log output. */
  logs: BoundedLogRangeSchema.optional(),
  /** Cancellation availability and routing. */
  cancellation: CancellationAvailabilitySchema,
  /** Failure details when in a failed state. */
  failure: TrajectoryFailureSchema.optional(),
  /** Progress indicator. */
  progress: ProgressIndicatorSchema.optional(),
  /** Source sequence for this detail. */
  sourceSequence: SequenceSchema,
  /** Timestamp of last verified state. */
  lastVerifiedAt: TimestampSchema,
  /** Structured unavailable reason when records are incomplete/incompatible. */
  unavailableReason: UnavailableReasonSchema.optional(),
  /** Content revision for determining update freshness. */
  contentRevision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
}).passthrough();

export type TrajectoryDetailV1 = z.infer<typeof TrajectoryDetailV1Schema>;

// ─── Trajectory Projection V1 ───────────────────────────────────

/**
 * The trajectory projection envelope value.
 * Contains all summaries for a session and optionally expanded detail.
 *
 * Requirements: 42.1–42.14
 */
export const TrajectoryProjectionV1Schema = z.object({
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** All compact summaries keyed by entity identity. */
  summaries: z.array(TrajectorySummaryV1Schema),
  /** Expanded detail for the currently viewed entity (if open). */
  expandedDetail: TrajectoryDetailV1Schema.optional(),
  /** Projection revision. */
  projectionRevision: z.number().int().nonnegative(),
  /** Source sequence range. */
  sourceSequenceStart: SequenceSchema,
  sourceSequenceEnd: SequenceSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type TrajectoryProjectionV1 = z.infer<typeof TrajectoryProjectionV1Schema>;

// ─── Trajectory Query ───────────────────────────────────────────

/**
 * Query for trajectory projection.
 */
export const TrajectoryQuerySchema = z.object({
  sessionId: IdentifierSchema,
  /** Optional: expand detail for a specific entity. */
  expandEntityId: IdentifierSchema.optional(),
  /** Maximum log lines to include in detail. */
  maxLogLines: z.number().int().positive().finite().optional(),
  /** Maximum log bytes to include in detail. */
  maxLogBytes: z.number().int().positive().finite().optional(),
  /** Log range start line for pagination. */
  logStartLine: z.number().int().nonnegative().optional(),
}).passthrough();

export type TrajectoryQuery = z.infer<typeof TrajectoryQuerySchema>;

// ─── Cancellation Command ───────────────────────────────────────

/**
 * Command to request cancellation of an active trajectory entity.
 * Routed through the owning Orchestration_Engine or Job_Service authority.
 *
 * Requirements: 42.5, 42.13
 */
export const CancellationCommandSchema = z.object({
  /** Entity to cancel. */
  entityId: IdentifierSchema,
  /** Entity kind. */
  entityKind: TrajectoryEntityKindSchema,
  /** Actor requesting cancellation. */
  actor: IdentifierSchema,
  /** Authority to route cancellation through. */
  authority: IdentifierSchema,
  /** Command identity. */
  commandId: IdentifierSchema,
  /** Idempotency key. */
  idempotencyKey: IdentifierSchema,
  /** Expected entity revision at time of command. */
  expectedRevision: z.number().int().nonnegative(),
}).passthrough();

export type CancellationCommand = z.infer<typeof CancellationCommandSchema>;

// ─── Log Range Retrieval Query ──────────────────────────────────

/**
 * Query for authorized log range retrieval within retained ranges.
 * Requirements: 42.4
 */
export const LogRangeQuerySchema = z.object({
  entityId: IdentifierSchema,
  /** Start line (0-indexed). */
  startLine: z.number().int().nonnegative(),
  /** Maximum lines to retrieve. */
  maxLines: z.number().int().positive().finite(),
  /** Maximum bytes to retrieve. */
  maxBytes: z.number().int().positive().finite(),
  /** Authorization token from owning authority. */
  authorizationToken: IdentifierSchema.optional(),
}).passthrough();

export type LogRangeQuery = z.infer<typeof LogRangeQuerySchema>;
