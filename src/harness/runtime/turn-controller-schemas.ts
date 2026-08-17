/**
 * Turn Controller Schemas
 *
 * Defines the legal turn/step lifecycle state machine, transition records,
 * owned-work tracking, cancellation convergence, and teardown completeness.
 *
 * Requirements: 15.1, 15.3–15.6, 36.1–36.8, 36.13–36.17
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SchemaVersionSchema } from '../contracts/primitives';

// ─── Turn Activity States ───────────────────────────────────────

/**
 * All legal turn activity states per the design state machine (Requirement 36.1).
 *
 * Terminal states: completed, interrupted, failed
 * All others are nonterminal.
 */
export const TurnActivityStateSchema = z.enum([
  'queued',
  'assembling',
  'awaiting_first_token',
  'reasoning',
  'streaming',
  'tool_running',
  'retrying',
  'waiting_for_user',
  'cancelling',
  'reconnecting',
  'completed',
  'interrupted',
  'failed',
]);

export type TurnActivityState = z.infer<typeof TurnActivityStateSchema>;

/**
 * Terminal states are irreversible (Requirement 36.13, 36.15).
 * Once a turn reaches a terminal state, no further transitions are allowed.
 */
export const TERMINAL_STATES: ReadonlySet<TurnActivityState> = new Set([
  'completed',
  'interrupted',
  'failed',
]);

/**
 * The legal transition map. Each key is a source state, and the value is
 * the set of valid destination states reachable from it.
 * Derived from the design.md Mermaid state diagram.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<TurnActivityState, ReadonlySet<TurnActivityState>>> = {
  queued: new Set(['assembling', 'waiting_for_user', 'cancelling', 'reconnecting', 'failed']),
  assembling: new Set(['awaiting_first_token', 'waiting_for_user', 'cancelling', 'reconnecting', 'failed']),
  awaiting_first_token: new Set(['reasoning', 'streaming', 'retrying', 'cancelling', 'reconnecting', 'failed']),
  reasoning: new Set(['tool_running', 'streaming', 'waiting_for_user', 'cancelling', 'reconnecting', 'completed', 'failed']),
  streaming: new Set(['tool_running', 'retrying', 'cancelling', 'reconnecting', 'completed', 'failed']),
  tool_running: new Set(['reasoning', 'streaming', 'waiting_for_user', 'retrying', 'cancelling', 'reconnecting', 'completed', 'failed']),
  retrying: new Set(['awaiting_first_token', 'cancelling', 'failed']),
  waiting_for_user: new Set(['assembling', 'cancelling', 'failed']),
  cancelling: new Set(['interrupted']),
  reconnecting: new Set(['awaiting_first_token', 'interrupted']),
  // Terminal states have no outgoing transitions
  completed: new Set(),
  interrupted: new Set(),
  failed: new Set(),
};

// ─── Transition Cause ───────────────────────────────────────────

/**
 * Cause categories for a state transition (Requirement 15.1).
 */
export const TransitionCauseSchema = z.enum([
  'provider_event',
  'tool_event',
  'user_action',
  'system_policy',
  'cancellation_request',
  'cancellation_convergence',
  'connection_event',
  'retry_decision',
  'plugin_failure',
  'budget_exhausted',
  'assembly_complete',
  'reconnection_success',
  'teardown_complete',
]);

export type TransitionCause = z.infer<typeof TransitionCauseSchema>;

// ─── Turn Transition Record ─────────────────────────────────────

/**
 * Every transition carries turnId, stepId?, prior state, new state, cause event,
 * owner, attempt, timestamp, and schema version (design.md specification).
 *
 * This is the durable record appended to Session_Log per Requirement 15.1.
 */
export const TurnTransitionRecordSchema = z.object({
  /** Unique transition record identity. */
  transitionId: IdentifierSchema,

  /** Turn this transition belongs to. */
  turnId: IdentifierSchema,

  /** Step within the turn, if applicable. */
  stepId: IdentifierSchema.optional(),

  /** State before this transition. */
  priorState: TurnActivityStateSchema,

  /** State after this transition. */
  newState: TurnActivityStateSchema,

  /** What caused this transition. */
  cause: TransitionCauseSchema,

  /** Detailed cause event reference (e.g., event ID that triggered it). */
  causeEventId: IdentifierSchema.optional(),

  /** Owner identity (session or agent that owns this turn). */
  owner: IdentifierSchema,

  /** Current attempt number for retryable flows. */
  attempt: z.number().int().nonnegative(),

  /** When this transition occurred. */
  timestamp: TimestampSchema,

  /** Schema version for forward compatibility. */
  schemaVersion: z.literal(1),
}).passthrough();

export type TurnTransitionRecord = z.infer<typeof TurnTransitionRecordSchema>;

// ─── Owned Work ─────────────────────────────────────────────────

/**
 * Types of work owned by a turn that must reach terminal state
 * before cancellation convergence (Requirement 15.5).
 */
export const OwnedWorkKindSchema = z.enum([
  'provider_stream',
  'tool_call',
  'subagent',
  'job',
  'timer',
  'process',
  'plugin_callback',
]);

export type OwnedWorkKind = z.infer<typeof OwnedWorkKindSchema>;

/**
 * Terminal status of a single piece of owned work.
 */
export const OwnedWorkTerminalStatusSchema = z.enum([
  'completed',
  'aborted',
  'failed',
  'timed_out',
]);

export type OwnedWorkTerminalStatus = z.infer<typeof OwnedWorkTerminalStatusSchema>;

/**
 * Registration of a piece of work owned by a turn (Requirement 15.4–15.5).
 */
export const OwnedWorkEntrySchema = z.object({
  /** Unique work identity. */
  workId: IdentifierSchema,

  /** Kind of owned work. */
  kind: OwnedWorkKindSchema,

  /** The turn that owns this work. */
  turnId: IdentifierSchema,

  /** Optional step within the turn. */
  stepId: IdentifierSchema.optional(),

  /** When the work was registered. */
  registeredAt: TimestampSchema,

  /** Terminal status once work completes (undefined while active). */
  terminalStatus: OwnedWorkTerminalStatusSchema.optional(),

  /** When terminal status was recorded. */
  terminatedAt: TimestampSchema.optional(),

  /** AbortController for cancellation propagation. */
  // Not serialized — runtime-only reference.
}).passthrough();

export type OwnedWorkEntry = z.infer<typeof OwnedWorkEntrySchema>;

// ─── Plugin Failure Record ──────────────────────────────────────

/**
 * Structured record of a contained plugin failure (Requirement 15.6).
 */
export const PluginFailureRecordSchema = z.object({
  /** Unique failure identity. */
  failureId: IdentifierSchema,

  /** Turn where the failure occurred. */
  turnId: IdentifierSchema,

  /** Step where the failure occurred, if applicable. */
  stepId: IdentifierSchema.optional(),

  /** The work that failed. */
  workId: IdentifierSchema,

  /** Plugin/callback identity that failed. */
  pluginId: IdentifierSchema,

  /** Error message (may be redacted). */
  errorMessage: z.string(),

  /** Error code if available. */
  errorCode: z.string().optional(),

  /** Whether convergence continued after containment. */
  convergenceContinued: z.boolean(),

  /** When the failure was recorded. */
  recordedAt: TimestampSchema,

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type PluginFailureRecord = z.infer<typeof PluginFailureRecordSchema>;

// ─── Teardown Completeness ──────────────────────────────────────

/**
 * Record of teardown completeness for a turn (Requirement 15.5, design recovery).
 * Documents which resources were cleaned up and which timed out.
 */
export const TeardownRecordSchema = z.object({
  /** Unique teardown record identity. */
  teardownId: IdentifierSchema,

  /** Turn being torn down. */
  turnId: IdentifierSchema,

  /** Total owned work items at teardown start. */
  totalOwnedWork: z.number().int().nonnegative(),

  /** Work items that completed normally or were aborted. */
  cleanedUp: z.array(z.object({
    workId: IdentifierSchema,
    kind: OwnedWorkKindSchema,
    status: OwnedWorkTerminalStatusSchema,
    durationMs: z.number().nonnegative().finite(),
  })),

  /** Work items that timed out during teardown. */
  timedOut: z.array(z.object({
    workId: IdentifierSchema,
    kind: OwnedWorkKindSchema,
    deadlineMs: z.number().nonnegative().finite(),
    elapsedMs: z.number().nonnegative().finite(),
  })),

  /** Whether all owned work reached terminal state. */
  allTerminal: z.boolean(),

  /** When teardown started. */
  startedAt: TimestampSchema,

  /** When teardown completed (or timed out). */
  completedAt: TimestampSchema,

  /** Total teardown duration in milliseconds. */
  durationMs: z.number().nonnegative().finite(),

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type TeardownRecord = z.infer<typeof TeardownRecordSchema>;

// ─── Cancellation Request ───────────────────────────────────────

/**
 * A cancellation request targeting a turn (Requirement 15.3).
 */
export const CancellationRequestSchema = z.object({
  /** Unique request identity. */
  requestId: IdentifierSchema,

  /** Turn to cancel. */
  turnId: IdentifierSchema,

  /** Who requested cancellation (user, system, parent). */
  requestedBy: IdentifierSchema,

  /** When cancellation was requested. */
  requestedAt: TimestampSchema,

  /** Configured convergence deadline in milliseconds. */
  convergenceDeadlineMs: z.number().positive().finite(),
}).passthrough();

export type CancellationRequest = z.infer<typeof CancellationRequestSchema>;

// ─── Turn Configuration ─────────────────────────────────────────

/**
 * Configuration for turn lifecycle management.
 */
export const TurnControllerConfigSchema = z.object({
  /** Default convergence deadline for cancellation in milliseconds. */
  defaultConvergenceDeadlineMs: z.number().positive().finite().default(30_000),

  /** Teardown timeout per work item in milliseconds. */
  perWorkTeardownTimeoutMs: z.number().positive().finite().default(10_000),

  /** Maximum overall teardown duration in milliseconds. */
  maxTeardownDurationMs: z.number().positive().finite().default(60_000),
}).passthrough();

export type TurnControllerConfig = z.infer<typeof TurnControllerConfigSchema>;

/**
 * Default turn controller configuration.
 */
export const DEFAULT_TURN_CONTROLLER_CONFIG: TurnControllerConfig = {
  defaultConvergenceDeadlineMs: 30_000,
  perWorkTeardownTimeoutMs: 10_000,
  maxTeardownDurationMs: 60_000,
};
