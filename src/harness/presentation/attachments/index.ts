/**
 * Attachment Presentation Module
 *
 * Provides the accessible attachment rail for Composer_Workbench,
 * focus-trapped lightbox for image viewing, and immutable committed
 * attachment nodes for Canonical_Timeline rendering.
 *
 * All public labels, accessibility text, logs, clipboard data, and
 * exported diagnostics use permitted filename/metadata and authorized
 * references. Never exposes host paths or secret locators.
 *
 * Requirements: 41.1-41.15, 46.3-46.4, 46.9
 */

// ─── Types and Schemas ──────────────────────────────────────────

export type {
  AttachmentRailItem,
  AttachmentRailSurface,
  AttachmentDraftAction,
  CommittedAttachmentNode,
  CommittedAttachmentAction,
  DownloadPolicy,
  LightboxSurface,
  AttachmentPreviewConfig,
} from './types';

export {
  AttachmentRailItemSchema,
  AttachmentRailSurfaceSchema,
  AttachmentPreviewConfigSchema,
  CommittedAttachmentNodeSchema,
  DownloadPolicySchema,
  LightboxSurfaceSchema,
  STAGE_LABELS,
  STAGE_PROGRESS,
  DEFAULT_PREVIEW_CONFIG,
} from './types';

// ─── Attachment Rail ────────────────────────────────────────────

export {
  deriveAttachmentRailSurface,
  resolveAvailableActions,
  isPreviewPermitted,
  buildAccessibilityLabel,
  computeReorder,
  announceReorder,
  formatByteSize,
  formatDuration,
  DEFAULT_RAIL_CONFIG,
  AttachmentRailConfigSchema,
} from './attachment-rail';

export type {
  AttachmentRailConfig,
  AttachmentRailProjection,
} from './attachment-rail';

// ─── Lightbox ───────────────────────────────────────────────────

export {
  openLightbox,
  closeLightbox,
  applyZoomAction,
  initFocusTrap,
  moveFocusInTrap,
  releaseFocusTrap,
  buildLightboxAccessibilityLabel,
  getLightboxAvailableActions,
  handleLightboxKeyboard,
  DEFAULT_LIGHTBOX_CONFIG,
  LightboxConfigSchema,
} from './lightbox';

export type {
  LightboxConfig,
  LightboxAction,
  LightboxOpenRequest,
  FocusTrapState,
} from './lightbox';

// ─── Committed Attachment Node ──────────────────────────────────

export {
  deriveCommittedAttachmentNode,
  resolveCommittedActions,
  deriveAvailability,
  buildCommittedAccessibilityLabel,
  buildClipboardData,
  buildDiagnosticData,
  isIdempotentDuplicate,
} from './committed-node';

export type {
  CommittedAttachmentProjection,
} from './committed-node';
