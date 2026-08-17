/**
 * Attachment Presentation Types
 *
 * Types for rendering attachment drafts in the Composer_Workbench rail,
 * focus-trapped lightbox, committed attachment nodes in Canonical_Timeline,
 * and policy-routed download. All labels, accessibility text, logs, clipboard
 * content, and exported diagnostics use permitted filename/metadata and
 * authorized references - never host paths or secret locators.
 *
 * Requirements: 41.1-41.15, 46.3-46.4, 46.9
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, IntegrityHashSchema } from '../../contracts/primitives';
import { AttachmentDraftStateSchema, ImageDimensionsSchema } from '../../session/attachment-schemas';

// ─── Rail Item Stages ───────────────────────────────────────────

/**
 * Processing stage labels for the attachment rail.
 * Each draft item shows its current stage (Requirement 41.1).
 */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  selected: 'Selected',
  validating: 'Validating',
  uploading: 'Uploading',
  scanning: 'Scanning',
  ready: 'Ready',
  committing: 'Committing',
  committed: 'Committed',
  error: 'Error',
};

/**
 * Stage progress indicators for accessibility announcements.
 */
export const STAGE_PROGRESS: Readonly<Record<string, { current: number; total: number }>> = {
  selected: { current: 1, total: 6 },
  validating: { current: 2, total: 6 },
  uploading: { current: 3, total: 6 },
  scanning: { current: 4, total: 6 },
  ready: { current: 5, total: 6 },
  committing: { current: 6, total: 6 },
  committed: { current: 6, total: 6 },
  error: { current: 0, total: 6 },
};

// ─── Rail Item Actions ──────────────────────────────────────────

/** Actions available on an attachment draft rail item. */
export type AttachmentDraftAction =
  | 'inspect'
  | 'retry'
  | 'remove'
  | 'move_up'
  | 'move_down';

/** Actions available on a committed attachment node. */
export type CommittedAttachmentAction =
  | 'download'
  | 'open_lightbox'
  | 'inspect';

// ─── Preview Configuration ──────────────────────────────────────

/**
 * Bounded preview configuration for attachment rail items.
 * Previews never expose private storage paths (Requirement 41.3, 41.11).
 */
export const AttachmentPreviewConfigSchema = z.object({
  /** Maximum preview width in DIP. */
  maxWidthDip: z.number().int().positive(),
  /** Maximum preview height in DIP. */
  maxHeightDip: z.number().int().positive(),
  /** Maximum preview bytes to load. */
  maxPreviewBytes: z.number().int().positive(),
});

export type AttachmentPreviewConfig = z.infer<typeof AttachmentPreviewConfigSchema>;

export const DEFAULT_PREVIEW_CONFIG: AttachmentPreviewConfig = {
  maxWidthDip: 120,
  maxHeightDip: 80,
  maxPreviewBytes: 512_000,
};

// ─── Attachment Rail Item ───────────────────────────────────────

/**
 * Presentation model for one attachment draft in the composer rail.
 *
 * Renders processing stages, metadata, bounded previews, keyboard
 * reordering, and permitted actions (Requirements 41.1-41.4, 41.10, 41.15).
 */
export const AttachmentRailItemSchema = z.object({
  /** Stable attachment identity. */
  attachmentId: IdentifierSchema,

  /** Current processing state (Requirement 41.1). */
  state: AttachmentDraftStateSchema,

  /** Localized stage label. */
  stageLabel: z.string().min(1),

  /** Accessibility label (path-free, Requirement 41.11). */
  accessibilityLabel: z.string().min(1),

  /** Permitted filename or null if unavailable (Requirement 41.2). */
  displayName: z.string().nullable(),

  /** Media type (Requirement 41.2). */
  mediaType: z.string().min(1),

  /** Formatted byte size (Requirement 41.2). */
  formattedSize: z.string().min(1),

  /** Image dimensions if applicable (Requirement 41.2). */
  dimensions: ImageDimensionsSchema.optional(),

  /** Duration in seconds for audio/video (Requirement 41.2). */
  durationSeconds: z.number().positive().optional(),

  /** Accessible description from user or derived (Requirement 41.2). */
  accessibleDescription: z.string().optional(),

  /** Whether a bounded preview is permitted (Requirement 41.3). */
  previewPermitted: z.boolean(),

  /**
   * Authorized reference for preview rendering.
   * Never a private storage path (Requirement 41.3, 41.11).
   */
  previewReference: IdentifierSchema.optional(),

  /** Position in the rail (1-based, for accessibility, Requirement 41.4). */
  position: z.number().int().positive(),

  /** Total items in the rail (for accessibility). */
  totalCount: z.number().int().positive(),

  /** Available actions based on current state (Requirements 41.4, 41.10). */
  availableActions: z.array(z.enum(['inspect', 'retry', 'remove', 'move_up', 'move_down'])),

  /** Failed stage name if in error state (Requirement 41.10). */
  failedStage: z.string().optional(),

  /** Redacted error reason (Requirement 41.10, 41.11). */
  errorReason: z.string().optional(),

  /** Whether this item currently has keyboard focus. */
  focused: z.boolean(),
});

export type AttachmentRailItem = z.infer<typeof AttachmentRailItemSchema>;

// ─── Download Policy ────────────────────────────────────────────

/**
 * Download policy resolution result.
 * Routes through Attachment_Service policy (Requirements 41.6-41.7).
 */
export const DownloadPolicySchema = z.object({
  /** Whether download is permitted. */
  permitted: z.boolean(),
  /** Policy reason when denied (Requirement 41.7). */
  deniedReason: z.string().optional(),
  /** Authorized download reference when permitted (never a private path). */
  downloadReference: IdentifierSchema.optional(),
});

export type DownloadPolicy = z.infer<typeof DownloadPolicySchema>;

// ─── Lightbox Surface ───────────────────────────────────────────

/**
 * Lightbox presentation state.
 *
 * Focus-trapped modal with close (Escape), zoom controls, image label,
 * and focus restoration on close (Requirements 41.5, 46.3-46.4).
 */
export const LightboxSurfaceSchema = z.object({
  /** Whether the lightbox is open. */
  open: z.boolean(),

  /** Attachment identity being displayed. */
  attachmentId: IdentifierSchema.optional(),

  /** Authorized image reference (never a private path, Requirement 41.11). */
  imageReference: IdentifierSchema.optional(),

  /** Accessible image label (Requirement 41.5, 46.9). */
  imageLabel: z.string().min(1).optional(),

  /** Current zoom level (1.0 = fit). */
  zoomLevel: z.number().positive().optional(),

  /** Whether close via Escape is permitted (Requirement 46.3). */
  escapeClosePermitted: z.boolean(),

  /** The invoking control identity for focus restoration (Requirement 46.4). */
  invokingControlId: IdentifierSchema.optional(),
});

export type LightboxSurface = z.infer<typeof LightboxSurfaceSchema>;

// ─── Committed Attachment Node ──────────────────────────────────

/**
 * Immutable committed attachment presentation in Canonical_Timeline.
 *
 * Shows identity, media metadata, availability, retention status,
 * content digest, and source sequence (Requirements 41.8, 41.12, 41.14).
 */
export const CommittedAttachmentNodeSchema = z.object({
  /** Immutable attachment identity (Requirement 41.8). */
  attachmentId: IdentifierSchema,

  /** Content digest for integrity verification (Requirement 41.14). */
  contentDigest: IntegrityHashSchema,

  /** Media type (Requirement 41.12). */
  mediaType: z.string().min(1),

  /** Permitted display filename (Requirement 41.11). */
  displayName: z.string().nullable(),

  /** Formatted byte size. */
  formattedSize: z.string().min(1),

  /** Image dimensions if applicable (Requirement 41.12). */
  dimensions: ImageDimensionsSchema.optional(),

  /** Duration in seconds for audio/video (Requirement 41.12). */
  durationSeconds: z.number().positive().optional(),

  /** Availability status (Requirement 41.12). */
  availability: z.enum(['available', 'expiring', 'expired', 'unavailable']),

  /** Retention status from Projection_Service (Requirement 41.12). */
  retentionStatus: z.enum(['active', 'expiring', 'expired']),

  /** Event identity from Session_Log (Requirement 41.14). */
  eventId: IdentifierSchema,

  /** Source sequence in Session_Log (Requirement 41.14). */
  sourceSequence: z.number().int().nonnegative(),

  /** Download policy resolution (Requirements 41.6-41.7). */
  downloadPolicy: DownloadPolicySchema,

  /** Accessibility label (path-free, Requirement 41.11, 46.9). */
  accessibilityLabel: z.string().min(1),

  /** Available actions based on policy. */
  availableActions: z.array(z.enum(['download', 'open_lightbox', 'inspect'])),
});

export type CommittedAttachmentNode = z.infer<typeof CommittedAttachmentNodeSchema>;

// ─── Rail Surface ───────────────────────────────────────────────

/**
 * Complete attachment rail surface state for the Composer_Workbench.
 */
export const AttachmentRailSurfaceSchema = z.object({
  /** Ordered rail items. */
  items: z.array(AttachmentRailItemSchema),

  /** Whether the rail is currently visible (has items). */
  visible: z.boolean(),

  /** Total byte size of all attachments. */
  totalSizeFormatted: z.string(),

  /** Accessibility announcement for state changes. */
  announcement: z.string().optional(),
});

export type AttachmentRailSurface = z.infer<typeof AttachmentRailSurfaceSchema>;
