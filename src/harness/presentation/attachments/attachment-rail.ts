/**
 * Attachment Rail Surface
 *
 * Derives the attachment rail presentation from draft projections.
 * Renders all processing stages, metadata, actions, bounded authorized
 * previews, and keyboard reordering. All labels and accessibility text
 * use permitted filename/metadata and authorized references only.
 *
 * Requirements: 41.1-41.4, 41.10-41.11, 41.15, 46.9
 */

import { z } from 'zod';
import type { AttachmentDraft } from '../../session/attachment-schemas';
import {
  STAGE_LABELS,
  STAGE_PROGRESS,
  DEFAULT_PREVIEW_CONFIG,
  type AttachmentRailItem,
  type AttachmentRailSurface,
  type AttachmentDraftAction,
  type AttachmentPreviewConfig,
} from './types';

// ─── Configuration ──────────────────────────────────────────────

export const AttachmentRailConfigSchema = z.object({
  /** Maximum number of attachments in the rail. */
  maxItems: z.number().int().positive(),
  /** Preview configuration bounds. */
  previewConfig: z.object({
    maxWidthDip: z.number().int().positive(),
    maxHeightDip: z.number().int().positive(),
    maxPreviewBytes: z.number().int().positive(),
  }),
  /** Media types that support visual preview. */
  previewableMediaTypes: z.array(z.string()),
});

export type AttachmentRailConfig = z.infer<typeof AttachmentRailConfigSchema>;

export const DEFAULT_RAIL_CONFIG: AttachmentRailConfig = {
  maxItems: 20,
  previewConfig: DEFAULT_PREVIEW_CONFIG,
  previewableMediaTypes: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
  ],
};

// ─── Draft Projection Input ─────────────────────────────────────

/**
 * Input from Projection_Service for deriving the rail surface.
 */
export interface AttachmentRailProjection {
  /** Ordered list of current session drafts. */
  drafts: AttachmentDraft[];
  /** ID of the currently focused item, if any. */
  focusedId?: string;
  /** Authorized preview references keyed by attachmentId. */
  previewReferences: Record<string, string>;
}

// ─── Formatting Helpers ─────────────────────────────────────────

/**
 * Format byte size to a human-readable string.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format duration in seconds to a readable string.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

// ─── Action Resolution ──────────────────────────────────────────

/**
 * Resolve available actions for a draft item based on current state and position.
 *
 * - inspect: always available
 * - retry: only when in error state (Requirement 41.10)
 * - remove: available in all non-committed states (Requirement 41.4)
 * - move_up/move_down: keyboard reordering (Requirement 41.4)
 *
 * Requirement 41.15: Preserve successful prior stages on error.
 */
export function resolveAvailableActions(
  state: string,
  position: number,
  totalCount: number,
): AttachmentDraftAction[] {
  const actions: AttachmentDraftAction[] = ['inspect'];

  if (state === 'error') {
    actions.push('retry');
  }

  if (state !== 'committed') {
    actions.push('remove');
  }

  // Keyboard reordering (Requirement 41.4)
  if (position > 1 && state !== 'committed') {
    actions.push('move_up');
  }
  if (position < totalCount && state !== 'committed') {
    actions.push('move_down');
  }

  return actions;
}

// ─── Preview Eligibility ────────────────────────────────────────

/**
 * Determine if a draft is eligible for bounded preview rendering.
 *
 * Preview is permitted when:
 * - Media type is in the previewable list
 * - Size is within preview byte limit
 * - State is past validation (not 'selected')
 * - An authorized reference exists
 *
 * Requirements 41.3, 41.11: Never expose private storage paths.
 */
export function isPreviewPermitted(
  draft: AttachmentDraft,
  config: AttachmentPreviewConfig,
  previewableMediaTypes: string[],
  hasAuthorizedReference: boolean,
): boolean {
  if (draft.state === 'selected') return false;
  if (draft.state === 'error') return false;
  if (!previewableMediaTypes.includes(draft.mediaType)) return false;
  if (draft.sizeBytes > config.maxPreviewBytes) return false;
  if (!hasAuthorizedReference) return false;
  return true;
}

// ─── Accessibility Label Builder ────────────────────────────────

/**
 * Build a path-free accessibility label for a rail item.
 *
 * Requirement 41.11: Labels use permitted filename/metadata and
 * authorized references. Never host paths or secret locators.
 */
export function buildAccessibilityLabel(
  draft: AttachmentDraft,
  position: number,
  totalCount: number,
): string {
  const name = draft.declaredFilename ?? 'Unnamed attachment';
  const stage = STAGE_LABELS[draft.state] ?? draft.state;
  const progress = STAGE_PROGRESS[draft.state];
  const progressText = progress
    ? `, step ${progress.current} of ${progress.total}`
    : '';

  const errorSuffix = draft.state === 'error' && draft.errorReason
    ? `, error: ${draft.errorReason}`
    : '';

  return `${name}, ${draft.mediaType}, ${formatByteSize(draft.sizeBytes)}, ${stage}${progressText}, item ${position} of ${totalCount}${errorSuffix}`;
}

// ─── Rail Surface Derivation ────────────────────────────────────

/**
 * Derive the complete attachment rail surface from projection data.
 *
 * This is a pure function of projection state. It produces the
 * presentation model consumed by the Composer_Workbench UI.
 *
 * Requirements: 41.1-41.4, 41.10-41.11, 41.15
 */
export function deriveAttachmentRailSurface(
  projection: AttachmentRailProjection,
  config: AttachmentRailConfig = DEFAULT_RAIL_CONFIG,
): AttachmentRailSurface {
  const { drafts, focusedId, previewReferences } = projection;
  const totalCount = drafts.length;

  if (totalCount === 0) {
    return {
      items: [],
      visible: false,
      totalSizeFormatted: formatByteSize(0),
      announcement: undefined,
    };
  }

  const items: AttachmentRailItem[] = drafts.map((draft, index) => {
    const position = index + 1;
    const hasAuthorizedRef = draft.attachmentId in previewReferences;

    return {
      attachmentId: draft.attachmentId,
      state: draft.state,
      stageLabel: STAGE_LABELS[draft.state] ?? draft.state,
      accessibilityLabel: buildAccessibilityLabel(draft, position, totalCount),
      displayName: draft.declaredFilename ?? null,
      mediaType: draft.mediaType,
      formattedSize: formatByteSize(draft.sizeBytes),
      dimensions: draft.dimensions,
      durationSeconds: draft.duration,
      accessibleDescription: draft.declaredFilename
        ? `Attachment: ${draft.declaredFilename}`
        : undefined,
      previewPermitted: isPreviewPermitted(
        draft,
        config.previewConfig,
        config.previewableMediaTypes,
        hasAuthorizedRef,
      ),
      previewReference: hasAuthorizedRef
        ? previewReferences[draft.attachmentId]
        : undefined,
      position,
      totalCount,
      availableActions: resolveAvailableActions(draft.state, position, totalCount),
      failedStage: draft.failedStage,
      errorReason: draft.errorReason,
      focused: draft.attachmentId === focusedId,
    };
  });

  const totalBytes = drafts.reduce((sum, d) => sum + d.sizeBytes, 0);

  return {
    items,
    visible: true,
    totalSizeFormatted: formatByteSize(totalBytes),
    announcement: undefined,
  };
}

// ─── Keyboard Reorder ───────────────────────────────────────────

/**
 * Compute the new order after a keyboard reorder action.
 * Returns the new ordered list of attachment IDs and the updated focus target.
 *
 * Requirement 41.4: Keyboard selection, reordering with visible
 * focus and announced positions.
 */
export function computeReorder(
  currentOrder: string[],
  attachmentId: string,
  direction: 'move_up' | 'move_down',
): { newOrder: string[]; focusTarget: string } {
  const index = currentOrder.indexOf(attachmentId);
  if (index === -1) {
    return { newOrder: [...currentOrder], focusTarget: attachmentId };
  }

  const targetIndex = direction === 'move_up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= currentOrder.length) {
    return { newOrder: [...currentOrder], focusTarget: attachmentId };
  }

  const newOrder = [...currentOrder];
  [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];

  return { newOrder, focusTarget: attachmentId };
}

/**
 * Generate an accessibility announcement after a reorder action.
 *
 * Requirement 41.4: Announced positions.
 */
export function announceReorder(
  displayName: string | null,
  newPosition: number,
  totalCount: number,
): string {
  const name = displayName ?? 'Attachment';
  return `${name} moved to position ${newPosition} of ${totalCount}`;
}
