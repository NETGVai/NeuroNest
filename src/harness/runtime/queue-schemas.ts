/**
 * Queue Schemas — Revision-guarded follow-up, steer, and inject queues.
 *
 * Defines schemas for the Turn_Controller's inbox queue system (Queue_Dock)
 * including stable entry identities, revision-guarded mutations, replayable
 * mutation events, busy-enter policies, placement, owner scoping, and
 * projection-confirmed command outcomes.
 *
 * Requirements: 15.2, 39.1–39.18
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../contracts/primitives';

// ─── Queue Types ────────────────────────────────────────────────

/**
 * The three queue types managed by Turn_Controller inbox (Requirement 15.2).
 *
 * - follow_up: user messages waiting for the current turn to complete
 * - steer: messages that can interrupt/redirect the current turn
 * - inject: system-injected context or commands
 */
export const QueueTypeSchema = z.enum([
  'follow_up',
  'steer',
  'inject',
]);

export type QueueType = z.infer<typeof QueueTypeSchema>;

// ─── Entry Delivery State ───────────────────────────────────────

/**
 * Delivery lifecycle of a queue entry (Requirement 39.1, 39.12).
 *
 * - queued: entry is waiting for delivery
 * - pending: mutation is awaiting projection confirmation
 * - delivered: entry has been consumed by the turn
 * - cancelled: entry was removed before delivery
 */
export const EntryDeliveryStateSchema = z.enum([
  'queued',
  'pending',
  'delivered',
  'cancelled',
]);

export type EntryDeliveryState = z.infer<typeof EntryDeliveryStateSchema>;

// ─── Entry Placement ────────────────────────────────────────────

/**
 * Configurable placement for new entries (Requirement 39.1, 39.3).
 *
 * - end: append at the end of the queue
 * - after_current: insert after the currently processing entry
 * - beginning: insert at the start of the queue
 */
export const EntryPlacementSchema = z.enum([
  'end',
  'after_current',
  'beginning',
]);

export type EntryPlacement = z.infer<typeof EntryPlacementSchema>;

// ─── Busy-Enter Policy ──────────────────────────────────────────

/**
 * Policy for Enter behavior when a compatible turn is active (Requirement 39.5, 39.6).
 *
 * - queue: submit as a queued follow-up
 * - steer: submit as steering input
 * - reject: reject the submission with a reason
 */
export const BusyEnterPolicySchema = z.enum([
  'queue',
  'steer',
  'reject',
]);

export type BusyEnterPolicy = z.infer<typeof BusyEnterPolicySchema>;

// ─── Queue Entry ────────────────────────────────────────────────

/**
 * A single queue entry with stable identity, revision, ordering, owner,
 * and delivery state (Requirement 39.1).
 *
 * Each entry is immutable once committed; mutations create new revisions.
 */
export const QueueEntrySchema = z.object({
  /** Stable entry identity — survives edits/reorders. */
  entryId: IdentifierSchema,

  /** Queue this entry belongs to. */
  queueType: QueueTypeSchema,

  /** Monotonically increasing revision for this entry (Requirement 39.4). */
  revision: z.number().int().nonnegative(),

  /** Ordering position within the queue. Lower values deliver first. */
  position: z.number().int().nonnegative(),

  /** Owner/session that created this entry (Requirement 39.1). */
  owner: IdentifierSchema,

  /** Session this entry belongs to. */
  sessionId: IdentifierSchema,

  /** Turn this entry is associated with, if any. */
  turnId: IdentifierSchema.optional(),

  /** Current delivery state. */
  deliveryState: EntryDeliveryStateSchema,

  /** Placement policy used when this entry was added. */
  placement: EntryPlacementSchema,

  /** Content of the entry (message text, command, context). */
  content: z.string(),

  /** Optional metadata attached to the entry. */
  metadata: z.record(z.string(), z.unknown()).optional(),

  /** When this entry was created. */
  createdAt: TimestampSchema,

  /** When this entry was last modified. */
  modifiedAt: TimestampSchema,

  /** Schema version for forward compatibility. */
  schemaVersion: z.literal(1),
}).passthrough();

export type QueueEntry = z.infer<typeof QueueEntrySchema>;

// ─── Mutation Types ─────────────────────────────────────────────

/**
 * All supported queue mutation operations (Requirement 39.2).
 */
export const QueueMutationKindSchema = z.enum([
  'add',
  'edit',
  'remove',
  'reorder',
  'promote',
]);

export type QueueMutationKind = z.infer<typeof QueueMutationKindSchema>;

// ─── Mutation Commands ──────────────────────────────────────────

/**
 * Base fields shared by all mutation commands.
 * Every mutation includes entry identity and expected revision for
 * optimistic concurrency control (Requirement 39.4, 39.14).
 */
const BaseMutationCommandSchema = z.object({
  /** Command identity for idempotency. */
  commandId: IdentifierSchema,

  /** Actor performing the mutation. */
  actor: IdentifierSchema,

  /** Session scope. */
  sessionId: IdentifierSchema,

  /** Turn scope (if the mutation targets a specific turn's queue). */
  turnId: IdentifierSchema.optional(),

  /** When the command was issued. */
  issuedAt: TimestampSchema,
});

/**
 * Add a new entry to a queue (Requirement 39.2).
 */
export const AddEntryCommandSchema = BaseMutationCommandSchema.extend({
  kind: z.literal('add'),

  /** Which queue to add to. */
  queueType: QueueTypeSchema,

  /** Content to add. */
  content: z.string().min(1),

  /** Desired placement in the queue. */
  placement: EntryPlacementSchema,

  /** Optional metadata. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AddEntryCommand = z.infer<typeof AddEntryCommandSchema>;

/**
 * Edit an existing entry's content (Requirement 39.2).
 * Requires entry identity and expected revision.
 */
export const EditEntryCommandSchema = BaseMutationCommandSchema.extend({
  kind: z.literal('edit'),

  /** Target entry identity. */
  entryId: IdentifierSchema,

  /** Expected revision — reject if stale (Requirement 39.4). */
  expectedRevision: z.number().int().nonnegative(),

  /** New content. */
  content: z.string().min(1),

  /** Optional metadata update. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type EditEntryCommand = z.infer<typeof EditEntryCommandSchema>;

/**
 * Remove an entry from the queue (Requirement 39.2).
 * Requires entry identity and expected revision.
 */
export const RemoveEntryCommandSchema = BaseMutationCommandSchema.extend({
  kind: z.literal('remove'),

  /** Target entry identity. */
  entryId: IdentifierSchema,

  /** Expected revision (Requirement 39.4). */
  expectedRevision: z.number().int().nonnegative(),
});

export type RemoveEntryCommand = z.infer<typeof RemoveEntryCommandSchema>;

/**
 * Reorder an entry to a new position (Requirement 39.2).
 * Requires entry identity and expected revision.
 */
export const ReorderEntryCommandSchema = BaseMutationCommandSchema.extend({
  kind: z.literal('reorder'),

  /** Target entry identity. */
  entryId: IdentifierSchema,

  /** Expected revision (Requirement 39.4). */
  expectedRevision: z.number().int().nonnegative(),

  /** New desired position index. */
  newPosition: z.number().int().nonnegative(),
});

export type ReorderEntryCommand = z.infer<typeof ReorderEntryCommandSchema>;

/**
 * Promote a follow-up entry to steering (Requirement 39.2).
 * Requires entry identity and expected revision.
 */
export const PromoteEntryCommandSchema = BaseMutationCommandSchema.extend({
  kind: z.literal('promote'),

  /** Target entry identity. */
  entryId: IdentifierSchema,

  /** Expected revision (Requirement 39.4). */
  expectedRevision: z.number().int().nonnegative(),

  /** Target queue type to promote to (typically 'steer'). */
  targetQueueType: QueueTypeSchema,
});

export type PromoteEntryCommand = z.infer<typeof PromoteEntryCommandSchema>;

/**
 * Union of all mutation commands.
 */
export const QueueMutationCommandSchema = z.discriminatedUnion('kind', [
  AddEntryCommandSchema,
  EditEntryCommandSchema,
  RemoveEntryCommandSchema,
  ReorderEntryCommandSchema,
  PromoteEntryCommandSchema,
]);

export type QueueMutationCommand = z.infer<typeof QueueMutationCommandSchema>;

// ─── Mutation Event (Durable Record) ────────────────────────────

/**
 * Replayable mutation event persisted to Session_Log (Requirement 39.3).
 * Records the full mutation with prior and resulting revision for replay.
 */
export const QueueMutationEventSchema = z.object({
  /** Unique event identity. */
  eventId: IdentifierSchema,

  /** Command that caused this mutation. */
  commandId: IdentifierSchema,

  /** Kind of mutation applied. */
  mutationKind: QueueMutationKindSchema,

  /** Entry identity affected. */
  entryId: IdentifierSchema,

  /** Revision of the entry before this mutation. */
  priorRevision: z.number().int().nonnegative(),

  /** Revision of the entry after this mutation. */
  resultingRevision: z.number().int().nonnegative(),

  /** Actor who performed the mutation. */
  actor: IdentifierSchema,

  /** Session scope. */
  sessionId: IdentifierSchema,

  /** Turn scope if applicable. */
  turnId: IdentifierSchema.optional(),

  /** Queue type. */
  queueType: QueueTypeSchema,

  /** Placement used (for add/reorder). */
  placement: EntryPlacementSchema.optional(),

  /** Snapshot of the entry content after mutation. */
  contentSnapshot: z.string().optional(),

  /** Metadata snapshot after mutation. */
  metadataSnapshot: z.record(z.string(), z.unknown()).optional(),

  /** Position before and after. */
  priorPosition: z.number().int().nonnegative().optional(),
  resultingPosition: z.number().int().nonnegative().optional(),

  /** Queue type before promotion (for promote mutations). */
  priorQueueType: QueueTypeSchema.optional(),

  /** When this event was committed. */
  committedAt: TimestampSchema,

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type QueueMutationEvent = z.infer<typeof QueueMutationEventSchema>;

// ─── Mutation Outcome ───────────────────────────────────────────

/**
 * Outcome status for a mutation command (Requirement 39.9, 39.15–39.17).
 */
export const MutationOutcomeStatusSchema = z.enum([
  'committed',
  'pending',
  'rejected_stale',
  'rejected_unavailable',
  'rejected_incompatible_owner',
  'timed_out',
]);

export type MutationOutcomeStatus = z.infer<typeof MutationOutcomeStatusSchema>;

/**
 * Result returned after attempting a queue mutation.
 * Carries current revision for stale rejections (Requirement 39.4).
 */
export const MutationOutcomeSchema = z.object({
  /** Command that was attempted. */
  commandId: IdentifierSchema,

  /** Outcome status. */
  status: MutationOutcomeStatusSchema,

  /** Entry identity affected (if applicable). */
  entryId: IdentifierSchema.optional(),

  /** Resulting revision if committed. */
  resultingRevision: z.number().int().nonnegative().optional(),

  /** Current entry revision (returned on stale rejection for client refresh). */
  currentRevision: z.number().int().nonnegative().optional(),

  /** Reason for rejection or timeout. */
  reason: z.string().optional(),

  /** Owning subagent identity if rejected due to incompatible ownership (Req 39.11). */
  owningSubagentId: IdentifierSchema.optional(),

  /** Projection revision that confirmed this outcome (Req 39.16). */
  projectionRevision: z.number().int().nonnegative().optional(),

  /** When the outcome was determined. */
  determinedAt: TimestampSchema,
}).passthrough();

export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>;

// ─── Queue Projection (Read Model) ─────────────────────────────

/**
 * Projected queue state — the read model returned by Queue_Dock
 * for UI consumption (Requirement 39.1, 39.13).
 */
export const QueueProjectionSchema = z.object({
  /** Session this projection belongs to. */
  sessionId: IdentifierSchema,

  /** Turn this projection is scoped to (if any). */
  turnId: IdentifierSchema.optional(),

  /** Projection revision (monotonically increasing). */
  projectionRevision: z.number().int().nonnegative(),

  /** All entries in committed order. */
  entries: z.array(QueueEntrySchema),

  /** Entry IDs with pending (unconfirmed) mutations. */
  pendingEntryIds: z.array(IdentifierSchema),

  /** When this projection was computed. */
  projectedAt: TimestampSchema,

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type QueueProjection = z.infer<typeof QueueProjectionSchema>;

// ─── Busy-Enter Configuration ───────────────────────────────────

/**
 * Configuration for busy-enter behavior (Requirement 39.5, 39.6, 39.7).
 */
export const BusyEnterConfigSchema = z.object({
  /** Default Enter behavior while a compatible turn is active. */
  defaultPolicy: BusyEnterPolicySchema,

  /** Alternate shortcut policy (the non-default action — Requirement 39.7). */
  alternatePolicy: BusyEnterPolicySchema.optional(),

  /** Default placement for queued entries. */
  defaultPlacement: EntryPlacementSchema.default('end'),
}).passthrough();

export type BusyEnterConfig = z.infer<typeof BusyEnterConfigSchema>;

/**
 * Default busy-enter configuration.
 */
export const DEFAULT_BUSY_ENTER_CONFIG: BusyEnterConfig = {
  defaultPolicy: 'queue',
  defaultPlacement: 'end',
};

// ─── Queue Service Configuration ────────────────────────────────

/**
 * Configuration for the queue service.
 */
export const QueueServiceConfigSchema = z.object({
  /** Busy-enter behavior settings. */
  busyEnter: BusyEnterConfigSchema,

  /** Timeout in ms for mutation confirmation (Requirement 39.17). */
  mutationTimeoutMs: z.number().positive().finite().default(10_000),

  /** Maximum queue size per type (positive, no hard-coded product limit). */
  maxQueueSize: z.number().int().positive().finite().default(100),
}).passthrough();

export type QueueServiceConfig = z.infer<typeof QueueServiceConfigSchema>;

/**
 * Default queue service configuration.
 */
export const DEFAULT_QUEUE_SERVICE_CONFIG: QueueServiceConfig = {
  busyEnter: DEFAULT_BUSY_ENTER_CONFIG,
  mutationTimeoutMs: 10_000,
  maxQueueSize: 100,
};
