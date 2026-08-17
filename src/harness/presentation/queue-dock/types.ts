/**
 * Queue_Dock Presentation Types
 *
 * Types and schemas for the Queue_Dock keyed authority projection.
 * Queue_Dock projects Turn_Controller inbox records as revisioned entries
 * with eligible controls, preserving focus/order/edit input across
 * pending/failure states. Each entry carries stable identity, revision,
 * order, placement, owner, and delivery status.
 *
 * Mutations are routed through Turn_Controller with entry identity plus
 * expected revision. Pending presentation is separate from committed order.
 * Stale/rejected/timeout outcomes restore the latest compatible projection
 * and retain edit text.
 *
 * Requirements: 39.1–39.18
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../../contracts/primitives';
import {
  QueueTypeSchema,
  EntryDeliveryStateSchema,
  EntryPlacementSchema,
  BusyEnterPolicySchema,
  QueueMutationKindSchema,
  type QueueType,
  type EntryDeliveryState,
  type EntryPlacement,
  type BusyEnterPolicy,
  type QueueMutationKind,
  type QueueEntry,
  type QueueProjection,
  type MutationOutcome,
  type BusyEnterConfig,
} from '../../runtime/queue-schemas';

// ─── IME Composition State ──────────────────────────────────────

/**
 * Input-method composition state for a queue editor (Requirements 39.8, 39.18).
 *
 * While an IME composition is active, Enter is treated as composition
 * input and queue/steer/command/mutation shortcuts are deferred.
 */
export const IMECompositionStateSchema = z.object({
  /** Whether an IME composition session is currently active. */
  active: z.boolean(),

  /** The editor identity where composition is active (entry or composer). */
  editorId: IdentifierSchema.optional(),
});

export type IMECompositionState = z.infer<typeof IMECompositionStateSchema>;

// ─── Entry Mutation Status ──────────────────────────────────────

/**
 * Per-entry mutation status within Queue_Dock presentation.
 *
 * - idle: no pending mutation
 * - pending: mutation awaiting projection confirmation (Requirement 39.15)
 * - failed: mutation was rejected/stale/timed-out (Requirement 39.9, 39.17)
 */
export const EntryMutationStatusSchema = z.enum([
  'idle',
  'pending',
  'failed',
]);

export type EntryMutationStatus = z.infer<typeof EntryMutationStatusSchema>;

// ─── Entry Mutation Failure ─────────────────────────────────────

/**
 * Details about a failed mutation for a specific entry (Requirement 39.9).
 * Preserves the failed action and exposes eligible retry or refresh.
 */
export const EntryMutationFailureSchema = z.object({
  /** The kind of mutation that failed. */
  failedAction: QueueMutationKindSchema,

  /** Reason for the failure. */
  reason: z.string().min(1),

  /** Whether a retry action is eligible. */
  retryEligible: z.boolean(),

  /** Whether a refresh action is eligible (re-fetch current state). */
  refreshEligible: z.boolean(),

  /** When the failure was determined. */
  failedAt: TimestampSchema,
});

export type EntryMutationFailure = z.infer<typeof EntryMutationFailureSchema>;

// ─── Entry Control Eligibility ──────────────────────────────────

/**
 * Eligible controls for a single queue entry (Requirement 39.2, 39.10, 39.11).
 *
 * Each control is either available or disabled with an authority-derived
 * reason accessible to pointer, keyboard, and screen-reader users.
 */
export const EntryControlSchema = z.object({
  /** Whether the edit action is available. */
  editAvailable: z.boolean(),
  editUnavailableReason: z.string().optional(),

  /** Whether the remove action is available. */
  removeAvailable: z.boolean(),
  removeUnavailableReason: z.string().optional(),

  /** Whether the reorder action is available. */
  reorderAvailable: z.boolean(),
  reorderUnavailableReason: z.string().optional(),

  /** Whether the promote-to-steer action is available. */
  promoteAvailable: z.boolean(),
  promoteUnavailableReason: z.string().optional(),
});

export type EntryControl = z.infer<typeof EntryControlSchema>;

// ─── Queue Dock Entry View ──────────────────────────────────────

/**
 * Presentation view of a single queue entry in Queue_Dock.
 * Keyed by entryId for stable identity through all state changes
 * (Requirement 39.12).
 */
export const QueueDockEntryViewSchema = z.object({
  /** Stable entry identity. */
  entryId: IdentifierSchema,

  /** Queue type (follow_up, steer, inject). */
  queueType: QueueTypeSchema,

  /** Current entry revision. */
  revision: z.number().int().nonnegative(),

  /** Committed order position. */
  position: z.number().int().nonnegative(),

  /** Entry owner identity (Requirement 39.1). */
  owner: IdentifierSchema,

  /** Current delivery state. */
  deliveryState: EntryDeliveryStateSchema,

  /** Placement used when this entry was added. */
  placement: EntryPlacementSchema,

  /** Display content. */
  content: z.string(),

  /** Per-entry mutation status. */
  mutationStatus: EntryMutationStatusSchema,

  /** Failure details when mutationStatus is 'failed'. */
  mutationFailure: EntryMutationFailureSchema.optional(),

  /** Eligible controls for this entry. */
  controls: EntryControlSchema,

  /** Whether this entry is focused in the queue list. */
  focused: z.boolean(),

  /** Retained edit input text (preserved on failure — Requirement 39.17). */
  retainedEditInput: z.string().optional(),

  /** Accessibility label for this entry. */
  accessibilityLabel: z.string(),
});

export type QueueDockEntryView = z.infer<typeof QueueDockEntryViewSchema>;

// ─── Subagent Ownership Unavailability ──────────────────────────

/**
 * Subagent ownership information that makes queue mutations unavailable
 * (Requirement 39.11).
 */
export const SubagentOwnershipSchema = z.object({
  /** Whether incompatible subagent ownership is active. */
  active: z.boolean(),

  /** Identity of the owning subagent. */
  subagentId: IdentifierSchema.optional(),

  /** Reason for incompatibility. */
  incompatibilityReason: z.string().optional(),
});

export type SubagentOwnership = z.infer<typeof SubagentOwnershipSchema>;

// ─── Busy-Enter Shortcut State ──────────────────────────────────

/**
 * Presentation state for busy-Enter behavior and alternate shortcuts
 * (Requirements 39.5, 39.6, 39.7).
 */
export const BusyEnterStateSchema = z.object({
  /** Whether a compatible turn is currently active. */
  turnActive: z.boolean(),

  /** The default Enter behavior policy. */
  defaultPolicy: BusyEnterPolicySchema,

  /** Label for the default Enter action. */
  defaultActionLabel: z.string(),

  /** The alternate shortcut policy (non-default action). */
  alternatePolicy: BusyEnterPolicySchema.optional(),

  /** Label for the alternate shortcut action. */
  alternateActionLabel: z.string().optional(),

  /** Keyboard shortcut hint for the alternate action. */
  alternateShortcutHint: z.string().optional(),
});

export type BusyEnterState = z.infer<typeof BusyEnterStateSchema>;

// ─── Queue Dock Surface ─────────────────────────────────────────

/**
 * The full Queue_Dock presentation surface.
 *
 * Represents the visible projection and authority-routed controls for
 * queued, steering, and injected Turn_Controller inbox entries.
 * Keyed by sessionId (and optionally turnId) for stable projection identity.
 *
 * Requirements: 39.1–39.18
 */
export const QueueDockSurfaceSchema = z.object({
  /** Session this dock projects. */
  sessionId: IdentifierSchema,

  /** Turn scope (if applicable). */
  turnId: IdentifierSchema.optional(),

  /** Projection revision (monotonically increasing). */
  projectionRevision: z.number().int().nonnegative(),

  /** Entries in committed display order. */
  entries: z.array(QueueDockEntryViewSchema),

  /** IDs of entries currently in pending mutation state. */
  pendingEntryIds: z.array(IdentifierSchema),

  /** Whether the add action is available. */
  addAvailable: z.boolean(),
  addUnavailableReason: z.string().optional(),

  /** Subagent ownership state (Requirement 39.11). */
  subagentOwnership: SubagentOwnershipSchema,

  /** Busy-Enter shortcut state (Requirements 39.5–39.7). */
  busyEnterState: BusyEnterStateSchema,

  /** IME composition state for this dock (Requirements 39.8, 39.18). */
  imeComposition: IMECompositionStateSchema,

  /** Focused entry ID, if any. */
  focusedEntryId: IdentifierSchema.optional(),

  /** When this surface was last derived. */
  derivedAt: TimestampSchema,
});

export type QueueDockSurface = z.infer<typeof QueueDockSurfaceSchema>;

// ─── Queue Dock Configuration ───────────────────────────────────

/**
 * Configuration for the Queue_Dock surface derivation.
 * All values are positive/finite per Settings_Service contract.
 */
export const QueueDockConfigSchema = z.object({
  /** Busy-enter behavior configuration. */
  busyEnter: z.object({
    defaultPolicy: BusyEnterPolicySchema,
    alternatePolicy: BusyEnterPolicySchema.optional(),
    defaultPlacement: EntryPlacementSchema.default('end'),
  }),

  /** Mutation confirmation timeout in ms. */
  mutationTimeoutMs: z.number().positive().finite(),

  /** Maximum queue size per type. */
  maxQueueSize: z.number().int().positive().finite(),
});

export type QueueDockConfig = z.infer<typeof QueueDockConfigSchema>;

export const DEFAULT_QUEUE_DOCK_CONFIG: QueueDockConfig = {
  busyEnter: {
    defaultPolicy: 'queue',
    defaultPlacement: 'end',
  },
  mutationTimeoutMs: 10_000,
  maxQueueSize: 100,
};

// ─── Busy-Enter Action Labels ───────────────────────────────────

/**
 * Localized labels for busy-enter actions.
 */
export const BUSY_ENTER_ACTION_LABELS: Readonly<Record<BusyEnterPolicy, string>> = {
  queue: 'Queue follow-up',
  steer: 'Send as steering',
  reject: 'Unavailable',
};

/**
 * Keyboard shortcut hints for alternate actions.
 */
export const ALTERNATE_SHORTCUT_HINTS: Readonly<Record<BusyEnterPolicy, string>> = {
  queue: 'Shift+Enter to queue',
  steer: 'Shift+Enter to steer',
  reject: '',
};
