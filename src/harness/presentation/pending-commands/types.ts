/**
 * Pending Command Presentation Types
 *
 * Types and schemas for projection-confirmed pending command presentation.
 * Commands remain pending until a causally compatible projection revision
 * confirms them. Prior committed projections are retained while commands
 * are pending. Rejection, stale, and timeout outcomes preserve the prior
 * projection and user input.
 *
 * Chat_Interface never applies an optimistic durable mutation to committed
 * view state. Confirmation occurs only when Projection_Service emits
 * confirmedCommandIds or a projected entity revision causally linked to
 * that command.
 *
 * Requirements: 35.12–35.13, 35.19–35.21, 38.10–38.11, 39.15–39.17,
 *              43.13–43.16, 44.16, 45.6, 45.16
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../../contracts/primitives';

// ─── Pending Command Status ─────────────────────────────────────

/**
 * The lifecycle status of a pending command in the UI.
 * - pending: awaiting compatible projection confirmation
 * - committed: confirmed by a causally compatible projection revision
 * - rejected: authority rejected the command
 * - stale: command references an outdated revision
 * - timeout: authority-configured timeout reached without confirmation
 * - unavailable: owning authority or process is unavailable
 */
export const PendingCommandStatusSchema = z.enum([
  'pending',
  'committed',
  'rejected',
  'stale',
  'timeout',
  'unavailable',
]);

export type PendingCommandStatus = z.infer<typeof PendingCommandStatusSchema>;

// ─── Pending Command Outcome ────────────────────────────────────

/**
 * The typed outcome when a pending command resolves to a non-committed
 * terminal state. Includes the reason and relevant revision data so
 * the UI can display actionable information.
 */
export const PendingCommandOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('rejected'),
    reason: z.string().min(1),
    authorityTarget: IdentifierSchema,
    resolvedAt: TimestampSchema,
  }),
  z.object({
    status: z.literal('stale'),
    currentRevision: z.number().int().nonnegative(),
    expectedRevision: z.number().int().nonnegative(),
    resolvedAt: TimestampSchema,
  }),
  z.object({
    status: z.literal('timeout'),
    timeoutMs: z.number().positive().finite(),
    resolvedAt: TimestampSchema,
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.string().min(1),
    resolvedAt: TimestampSchema,
  }),
]);

export type PendingCommandOutcome = z.infer<typeof PendingCommandOutcomeSchema>;

// ─── Pending Command Entry ──────────────────────────────────────

/**
 * A tracked pending command with all data needed to maintain presentation.
 *
 * The entry records:
 * - The command identity and source
 * - The projection revision at which the command was issued
 * - The user input that produced the command (preserved on rejection/timeout)
 * - The authority-configured timeout
 * - The terminal outcome when resolved
 */
export const PendingCommandEntrySchema = z.object({
  /** Unique command identity. */
  commandId: IdentifierSchema,

  /** The type of command issued. */
  commandType: IdentifierSchema,

  /** Authority the command was routed to. */
  authorityTarget: IdentifierSchema,

  /** The committed projection revision at the time the command was issued. */
  sourceProjectionRevision: z.number().int().nonnegative(),

  /** Expected entity/projection revision for causal compatibility. */
  expectedRevision: z.number().int().nonnegative().optional(),

  /** User input content that produced this command (preserved on failure). */
  userInput: z.string().optional(),

  /** Authority-configured timeout in milliseconds. */
  timeoutMs: z.number().positive().finite(),

  /** When the command was issued. */
  issuedAt: TimestampSchema,

  /** Current status of the pending command. */
  status: PendingCommandStatusSchema,

  /** Terminal outcome details when resolved to a non-committed state. */
  outcome: PendingCommandOutcomeSchema.optional(),

  /** The confirming projection revision (set when committed). */
  confirmingRevision: z.number().int().positive().optional(),
});

export type PendingCommandEntry = z.infer<typeof PendingCommandEntrySchema>;

// ─── Pending Command Store State ────────────────────────────────

/**
 * The full state of the pending command store.
 * Holds the last committed projection revision and all tracked commands.
 */
export const PendingCommandStoreStateSchema = z.object({
  /** The last committed (confirmed) projection revision. */
  committedProjectionRevision: z.number().int().nonnegative(),

  /** All pending commands, keyed by commandId. */
  commands: z.map(IdentifierSchema, PendingCommandEntrySchema),
});

export type PendingCommandStoreState = z.infer<typeof PendingCommandStoreStateSchema>;

// ─── Projection Confirmation ────────────────────────────────────

/**
 * Input from Projection_Service for confirming or resolving pending commands.
 * Either carries confirmedCommandIds or a projected entity revision that
 * causally links to pending commands.
 */
export interface ProjectionConfirmation {
  /** The new projection revision. */
  projectionRevision: number;

  /** Command IDs explicitly confirmed by the projection. */
  confirmedCommandIds: string[];

  /** The entity revision from the projection (for causal linking). */
  entityRevision?: number;

  /** Timestamp of the projection. */
  projectedAt: string;
}

// ─── Command Submission Input ───────────────────────────────────

/**
 * Input required to register a new pending command in the store.
 */
export interface PendingCommandSubmission {
  commandId: string;
  commandType: string;
  authorityTarget: string;
  sourceProjectionRevision: number;
  expectedRevision?: number;
  userInput?: string;
  timeoutMs: number;
  issuedAt: string;
}

// ─── Pending Command View ───────────────────────────────────────

/**
 * The presentation view of a pending command for the Chat_Interface.
 * Contains only the data needed to render the pending/outcome state.
 */
export interface PendingCommandView {
  commandId: string;
  commandType: string;
  authorityTarget: string;
  status: PendingCommandStatus;
  /** User input preserved for display/recovery on failure. */
  userInput?: string;
  /** Terminal outcome details. */
  outcome?: PendingCommandOutcome;
  /** Elapsed time since command was issued (ms). */
  elapsedMs: number;
  /** Whether the timeout warning threshold has been reached. */
  timeoutWarning: boolean;
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the pending command store.
 * All values are positive finite per Settings_Service contract.
 */
export const PendingCommandConfigSchema = z.object({
  /** Default timeout in ms if not specified per-command. */
  defaultTimeoutMs: z.number().positive().finite(),

  /**
   * Fraction of timeout elapsed before showing a warning indicator.
   * Must be between 0 (exclusive) and 1 (inclusive).
   */
  timeoutWarningThreshold: z.number().gt(0).lte(1),

  /** Maximum number of resolved commands to retain for display. */
  maxResolvedRetention: z.number().int().positive().finite(),
});

export type PendingCommandConfig = z.infer<typeof PendingCommandConfigSchema>;

export const DEFAULT_PENDING_COMMAND_CONFIG: PendingCommandConfig = {
  defaultTimeoutMs: 30_000,
  timeoutWarningThreshold: 0.8,
  maxResolvedRetention: 50,
};
