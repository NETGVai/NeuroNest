/**
 * Composer Draft Transaction Types
 *
 * Zod schemas and TypeScript types for the per-session transactional
 * Composer_Workbench draft store. Each undoable revision captures text,
 * mode, command claim, Context_Items, attachment drafts, queue placement,
 * selection, and undo cursor.
 *
 * Submission creates one immutable snapshot including route, profile,
 * permission preset, and committed attachment identities.
 *
 * Requirements: 40.1, 40.3–40.6, 40.10–40.15, 40.19–40.24
 */

import { z } from 'zod';
import {
  IdentifierSchema,
  SequenceSchema,
  TimestampSchema,
  RetentionDescriptorSchema,
} from '../../contracts/primitives';

// ─── Context Item ───────────────────────────────────────────────

/**
 * A typed context item referenced within the draft. Carries provenance,
 * version, staleness, and estimated token impact.
 */
export const ContextItemKindSchema = z.enum([
  'file',
  'folder',
  'range',
  'symbol',
  'diagnostic',
  'terminal',
  'git',
  'planning',
  'run',
  'artifact',
  'image',
  'web',
]);

export const ContextItemStatusSchema = z.enum([
  'included',
  'unavailable',
  'redacted',
  'omitted',
  'condensed',
  'resolving',
  'cancelled',
  'failed',
]);

export const ContextItemSchema = z.object({
  itemId: IdentifierSchema,
  kind: ContextItemKindSchema,
  label: z.string().min(1),
  provenance: z.string().min(1),
  version: z.string().optional(),
  staleness: z.enum(['fresh', 'stale', 'unknown']).default('unknown'),
  tokenEstimate: z.number().int().nonnegative().optional(),
  status: ContextItemStatusSchema.default('included'),
  pinned: z.boolean().default(false),
}).passthrough();

export type ContextItem = z.infer<typeof ContextItemSchema>;

// ─── Attachment Draft ───────────────────────────────────────────

export const AttachmentDraftStateSchema = z.enum([
  'validating',
  'uploading',
  'scanning',
  'ready',
  'error',
  'committed',
]);

export const AttachmentDraftSchema = z.object({
  draftAttachmentId: IdentifierSchema,
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  state: AttachmentDraftStateSchema.default('validating'),
  description: z.string().optional(),
  committedIdentity: IdentifierSchema.optional(),
  contentDigest: z.string().optional(),
  errorReason: z.string().optional(),
}).passthrough();

export type AttachmentDraft = z.infer<typeof AttachmentDraftSchema>;

// ─── Selection ──────────────────────────────────────────────────

export const SelectionSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  direction: z.enum(['forward', 'backward', 'none']).default('none'),
});

export type Selection = z.infer<typeof SelectionSchema>;

// ─── Draft Revision ─────────────────────────────────────────────

export const ComposerModeSchema = z.enum([
  'chat',
  'command',
  'edit',
  'agent',
  'plan',
]);

export const QueuePlacementSchema = z.object({
  position: z.enum(['append', 'prepend', 'after']),
  afterEntryId: IdentifierSchema.optional(),
}).passthrough();

export type QueuePlacement = z.infer<typeof QueuePlacementSchema>;

/**
 * A single undoable draft revision. Each mutation in the Composer_Workbench
 * produces a new revision that can be undone/redone within the session.
 */
export const DraftRevisionSchema = z.object({
  revision: SequenceSchema,
  text: z.string(),
  mode: ComposerModeSchema,
  commandClaim: z.string().optional(),
  contextItems: z.array(ContextItemSchema),
  attachmentDrafts: z.array(AttachmentDraftSchema),
  queuePlacement: QueuePlacementSchema.optional(),
  selection: SelectionSchema,
  createdAt: TimestampSchema,
}).passthrough();

export type DraftRevision = z.infer<typeof DraftRevisionSchema>;

// ─── Submission Snapshot ────────────────────────────────────────

/**
 * An immutable submission snapshot created atomically at submission time.
 * Includes the committed draft revision plus route, profile, permission
 * preset, and committed attachment identities.
 */
export const SubmissionSnapshotSchema = z.object({
  snapshotId: IdentifierSchema,
  sessionId: IdentifierSchema,
  draftRevision: SequenceSchema,
  text: z.string(),
  mode: ComposerModeSchema,
  commandClaim: z.string().optional(),
  contextItems: z.array(ContextItemSchema),
  committedAttachmentIds: z.array(IdentifierSchema),
  queuePlacement: QueuePlacementSchema.optional(),
  route: IdentifierSchema,
  profile: IdentifierSchema,
  permissionPreset: IdentifierSchema,
  submittedAt: TimestampSchema,
}).passthrough();

export type SubmissionSnapshot = z.infer<typeof SubmissionSnapshotSchema>;

// ─── Async Resolution Request ───────────────────────────────────

/**
 * Captures the state at the time an async resolution was initiated.
 * A settlement may only apply if all fields still match the current draft.
 */
export const AsyncResolutionRequestSchema = z.object({
  requestId: IdentifierSchema,
  draftId: IdentifierSchema,
  originRevision: SequenceSchema,
  exactRange: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
});

export type AsyncResolutionRequest = z.infer<typeof AsyncResolutionRequestSchema>;

/**
 * The result of an async resolution to be applied to the draft.
 */
export const AsyncResolutionResultSchema = z.object({
  requestId: IdentifierSchema,
  draftId: IdentifierSchema,
  originRevision: SequenceSchema,
  exactRange: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  resolvedText: z.string().optional(),
  resolvedContextItem: ContextItemSchema.optional(),
  resolvedAttachment: AttachmentDraftSchema.optional(),
});

export type AsyncResolutionResult = z.infer<typeof AsyncResolutionResultSchema>;

// ─── Retention Policy ───────────────────────────────────────────

/**
 * Controls how many undo revisions and sessions are retained.
 */
export const DraftRetentionPolicySchema = z.object({
  maxUndoDepth: z.number().int().positive(),
  retainOnValidationFailure: z.boolean().default(true),
  retainOnPrecommitFailure: z.boolean().default(true),
  sessionRetention: RetentionDescriptorSchema,
});

export type DraftRetentionPolicy = z.infer<typeof DraftRetentionPolicySchema>;

// ─── Store Configuration ────────────────────────────────────────

export const DraftTransactionStoreConfigSchema = z.object({
  sessionId: IdentifierSchema,
  draftId: IdentifierSchema,
  retentionPolicy: DraftRetentionPolicySchema,
});

export type DraftTransactionStoreConfig = z.infer<typeof DraftTransactionStoreConfigSchema>;

// ─── Default Configuration ──────────────────────────────────────

export const DEFAULT_RETENTION_POLICY: DraftRetentionPolicy = {
  maxUndoDepth: 100,
  retainOnValidationFailure: true,
  retainOnPrecommitFailure: true,
  sessionRetention: { policy: 'session' },
};

export const DEFAULT_SELECTION: Selection = { start: 0, end: 0, direction: 'none' };
