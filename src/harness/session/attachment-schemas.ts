/**
 * Attachment Schemas — Zod contracts for private content-addressed attachment lifecycle.
 *
 * Defines:
 * - Draft state machine (selected → validating → uploading → scanning → ready → committing → committed)
 * - Immutable attachment metadata
 * - Commit, retrieval, and retention contracts
 * - Path/locator-free public types
 *
 * Requirements: 21.1–21.7, 41.1–41.3, 41.6–41.15
 */

import { z } from 'zod';
import {
  IdentifierSchema,
  TimestampSchema,
  IntegrityHashSchema,
  RetentionDescriptorSchema,
} from '../contracts/primitives.js';
import { ScopeDescriptorV1Schema } from '../contracts/scope.js';
import { IdempotencyKeySchema } from '../contracts/idempotency.js';

// ─── Draft State Machine ────────────────────────────────────────

/**
 * All valid draft processing states.
 * Error is reachable from any processing stage.
 * Retry returns only to the failed stage.
 */
export const AttachmentDraftStateSchema = z.enum([
  'selected',
  'validating',
  'uploading',
  'scanning',
  'ready',
  'committing',
  'committed',
  'error',
]);

export type AttachmentDraftState = z.infer<typeof AttachmentDraftStateSchema>;

/**
 * Valid transitions per stage. Error is reachable from all non-terminal states.
 * Retry from error returns to the failed stage (stored in failedStage).
 */
export const VALID_TRANSITIONS: Record<AttachmentDraftState, AttachmentDraftState[]> = {
  selected: ['validating', 'error'],
  validating: ['uploading', 'error'],
  uploading: ['scanning', 'error'],
  scanning: ['ready', 'error'],
  ready: ['committing', 'error'],
  committing: ['committed', 'error'],
  committed: [],     // terminal
  error: ['selected', 'validating', 'uploading', 'scanning', 'ready', 'committing'],
};

// ─── Media Dimensions ───────────────────────────────────────────

export const ImageDimensionsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type ImageDimensions = z.infer<typeof ImageDimensionsSchema>;

// ─── Attachment Metadata (Immutable after commit) ───────────────

export const AttachmentMetadataSchema = z.object({
  attachmentId: IdentifierSchema,
  contentHash: IntegrityHashSchema,
  mediaType: z.string().min(1),
  declaredMediaType: z.string().min(1),
  detectedMediaType: z.string().min(1).optional(),
  declaredFilename: z.string().optional(),
  sizeBytes: z.number().int().positive(),
  dimensions: ImageDimensionsSchema.optional(),
  duration: z.number().positive().optional(),
  scope: ScopeDescriptorV1Schema,
  createdAt: TimestampSchema,
  committedAt: TimestampSchema.optional(),
  schemaVersion: z.literal(1),
}).passthrough();

export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

// ─── Draft Record ───────────────────────────────────────────────

export const AttachmentDraftSchema = z.object({
  attachmentId: IdentifierSchema,
  sessionId: IdentifierSchema,
  contentHash: IntegrityHashSchema,
  state: AttachmentDraftStateSchema,
  failedStage: AttachmentDraftStateSchema.optional(),
  errorReason: z.string().optional(),
  mediaType: z.string().min(1),
  declaredMediaType: z.string().min(1),
  detectedMediaType: z.string().min(1).optional(),
  declaredFilename: z.string().optional(),
  sizeBytes: z.number().int().positive(),
  dimensions: ImageDimensionsSchema.optional(),
  duration: z.number().positive().optional(),
  safetyResult: z.string().optional(),
  scope: ScopeDescriptorV1Schema,
  idempotencyKey: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type AttachmentDraft = z.infer<typeof AttachmentDraftSchema>;

// ─── Commands ───────────────────────────────────────────────────

/**
 * Command to prepare a new attachment draft.
 * Content bytes are provided separately to the CAS; this only carries metadata.
 */
export const PrepareAttachmentCommandSchema = z.object({
  sessionId: IdentifierSchema,
  contentHash: IntegrityHashSchema,
  mediaType: z.string().min(1),
  declaredFilename: z.string().optional(),
  sizeBytes: z.number().int().positive(),
  dimensions: ImageDimensionsSchema.optional(),
  duration: z.number().positive().optional(),
  scope: ScopeDescriptorV1Schema,
  idempotencyKey: z.string().optional(),
});

export type PrepareAttachmentCommand = z.infer<typeof PrepareAttachmentCommandSchema>;

/**
 * Command to transition a draft to the next stage.
 */
export const TransitionDraftCommandSchema = z.object({
  attachmentId: IdentifierSchema,
  targetState: AttachmentDraftStateSchema,
  /** Required when transitioning to 'error' */
  errorReason: z.string().optional(),
  /** Detected media type after scanning/upload */
  detectedMediaType: z.string().optional(),
  /** Safety scan result after scanning completes */
  safetyResult: z.string().optional(),
});

export type TransitionDraftCommand = z.infer<typeof TransitionDraftCommandSchema>;

/**
 * Command to commit a ready attachment — creates an immutable event.
 */
export const CommitAttachmentCommandSchema = z.object({
  attachmentId: IdentifierSchema,
  idempotencyKey: IdempotencyKeySchema,
  scope: ScopeDescriptorV1Schema,
});

export type CommitAttachmentCommand = z.infer<typeof CommitAttachmentCommandSchema>;

// ─── Retrieval ──────────────────────────────────────────────────

/**
 * Authorized range retrieval request.
 * Uses byte-range semantics (inclusive start, exclusive end).
 */
export const RangeRetrievalRequestSchema = z.object({
  attachmentId: IdentifierSchema,
  scope: ScopeDescriptorV1Schema,
  /** Start byte (inclusive). Defaults to 0. */
  rangeStart: z.number().int().nonnegative().optional(),
  /** End byte (exclusive). Defaults to sizeBytes. */
  rangeEnd: z.number().int().positive().optional(),
});

export type RangeRetrievalRequest = z.infer<typeof RangeRetrievalRequestSchema>;

/**
 * Authorized retrieval result. Contains metadata and authorized reference only.
 * NEVER contains private storage paths.
 */
export const RetrievalResultSchema = z.object({
  attachmentId: IdentifierSchema,
  contentHash: IntegrityHashSchema,
  mediaType: z.string().min(1),
  declaredFilename: z.string().optional(),
  sizeBytes: z.number().int().positive(),
  dimensions: ImageDimensionsSchema.optional(),
  duration: z.number().positive().optional(),
  authorizedReference: IdentifierSchema,
  rangeStart: z.number().int().nonnegative(),
  rangeEnd: z.number().int().positive(),
  retentionStatus: z.enum(['active', 'expiring', 'expired']),
});

export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

// ─── Retention Policy ───────────────────────────────────────────

export const RetentionPolicySchema = z.object({
  maxAgeMs: z.number().int().positive(),
  retainAuditMetadata: z.boolean(),
});

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

// ─── Commit Event Payload ───────────────────────────────────────

/**
 * The model-visible attachment event payload appended to Session_Log on commit.
 * Contains identity, media metadata, content digest, and authorized reference.
 * Requirement 21.4: model-visible attachment event.
 */
export const AttachmentCommittedPayloadSchema = z.object({
  type: z.literal('attachment.committed'),
  attachmentId: IdentifierSchema,
  contentHash: IntegrityHashSchema,
  mediaType: z.string().min(1),
  declaredFilename: z.string().optional(),
  sizeBytes: z.number().int().positive(),
  dimensions: ImageDimensionsSchema.optional(),
  duration: z.number().positive().optional(),
  authorizedReference: IdentifierSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type AttachmentCommittedPayload = z.infer<typeof AttachmentCommittedPayloadSchema>;

// ─── Service Result Types ───────────────────────────────────────

export type AttachmentServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AttachmentError };

export interface AttachmentError {
  code: AttachmentErrorCode;
  message: string;
  /** Redacted reason — never exposes private paths */
  details?: Record<string, unknown>;
}

export type AttachmentErrorCode =
  | 'VALIDATION_FAILED'
  | 'SIZE_EXCEEDED'
  | 'COUNT_EXCEEDED'
  | 'INVALID_TRANSITION'
  | 'NOT_FOUND'
  | 'ALREADY_COMMITTED'
  | 'UNAUTHORIZED'
  | 'RETENTION_EXPIRED'
  | 'RANGE_INVALID'
  | 'SAFETY_REJECTED'
  | 'DUPLICATE_CONTENT';
