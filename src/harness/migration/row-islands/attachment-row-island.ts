/**
 * Attachment Row Island — Typed adapter for attachment rail rendering.
 *
 * Renders projected attachment states (draft and committed) as typed row
 * islands. Connects AttachmentService projections to attachment rail
 * command ports for the strangler migration.
 *
 * Key design:
 * - Routes through Attachment_Service projection/command ports (never mutates directly)
 * - Preserves old-session readability (legacy sessions can still display attachments)
 * - Maintains authority ownership (all mutations go through Attachment_Service)
 * - Renders both draft lifecycle states and committed immutable attachments
 * - Never exposes private storage paths or secret-bearing locators (Req 41.11)
 *
 * Requirements: 41.1–41.15
 */

import { sanitizeContent } from '../../presentation/sanitize';
import type { PresentationOutput, ContentBlock } from '../../presentation/types';
import type {
  RowIsland,
  RowIslandOutput,
  AttachmentRowIslandInput,
  LegacyAttachmentData,
} from './types';

// ─── State Labels ───────────────────────────────────────────────

const ATTACHMENT_STATE_LABELS: Record<string, string> = {
  selected: 'Selected',
  validating: 'Validating',
  uploading: 'Uploading',
  scanning: 'Scanning',
  ready: 'Ready',
  committing: 'Committing',
  committed: 'Committed',
  error: 'Error',
};

const ATTACHMENT_STATE_ACCESSIBILITY: Record<string, string> = {
  selected: 'Attachment has been selected for upload',
  validating: 'Attachment is being validated',
  uploading: 'Attachment is uploading',
  scanning: 'Attachment is being scanned for safety',
  ready: 'Attachment is ready for commit',
  committing: 'Attachment is being committed',
  committed: 'Attachment has been committed',
  error: 'Attachment processing encountered an error',
};

const RETENTION_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  expiring: 'Expiring',
  expired: 'Expired',
};

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Format file size in human-readable form.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Determine the content block kind for an attachment based on media type.
 */
function getBlockKind(mediaType: string): 'image' | 'generic_card' {
  if (mediaType.startsWith('image/')) return 'image';
  return 'generic_card';
}

// ─── Block Builders ─────────────────────────────────────────────

/**
 * Builds the primary attachment metadata block.
 */
function buildAttachmentMetadataBlock(input: AttachmentRowIslandInput): ContentBlock {
  const stateLabel = ATTACHMENT_STATE_LABELS[input.state] || input.state;
  const blockKind = getBlockKind(input.mediaType);

  const parts: string[] = [];

  if (input.declaredFilename) {
    parts.push(input.declaredFilename);
  }

  parts.push(`${input.mediaType} (${formatSize(input.sizeBytes)})`);

  if (input.dimensions) {
    parts.push(`${input.dimensions.width}x${input.dimensions.height}`);
  }

  if (input.duration != null) {
    parts.push(`${input.duration.toFixed(1)}s`);
  }

  const sanitized = sanitizeContent(parts.join(' \u2014 '));

  const accessParts: string[] = [];
  if (input.declaredFilename) {
    accessParts.push(input.declaredFilename);
  }
  accessParts.push(`${input.mediaType}, ${formatSize(input.sizeBytes)}`);
  accessParts.push(`Status: ${stateLabel}`);

  return {
    kind: blockKind,
    content: sanitized.text,
    accessibilityLabel: accessParts.join('. '),
    metadata: {
      attachmentId: input.attachmentId,
      state: input.state,
      stateLabel,
      mediaType: input.mediaType,
      declaredFilename: input.declaredFilename,
      sizeBytes: input.sizeBytes,
      dimensions: input.dimensions,
      duration: input.duration,
      isCommitted: input.isCommitted,
      contentHash: input.contentHash,
      sourceProjectionRevision: input.sourceProjectionRevision,
    },
  };
}

/**
 * Builds the state indicator block.
 */
function buildStateBlock(input: AttachmentRowIslandInput): ContentBlock {
  const stateLabel = ATTACHMENT_STATE_LABELS[input.state] || input.state;
  const stateAccess = ATTACHMENT_STATE_ACCESSIBILITY[input.state] || input.state;

  const parts: string[] = [stateLabel];

  if (input.retentionStatus && input.isCommitted) {
    const retLabel = RETENTION_STATUS_LABELS[input.retentionStatus] || input.retentionStatus;
    parts.push(`Retention: ${retLabel}`);
  }

  if (!input.authorityAvailable) {
    parts.push('(authority unavailable)');
  }

  return {
    kind: 'generic_card',
    content: parts.join(' \u2014 '),
    accessibilityLabel: `${stateAccess}${input.retentionStatus ? `, retention ${input.retentionStatus}` : ''}${!input.authorityAvailable ? ', authority unavailable' : ''}`,
    metadata: {
      isStateBlock: true,
      state: input.state,
      retentionStatus: input.retentionStatus,
      authorityAvailable: input.authorityAvailable,
    },
  };
}

/**
 * Builds an error detail block when the attachment is in error state.
 */
function buildErrorBlock(input: AttachmentRowIslandInput): ContentBlock | null {
  if (input.state !== 'error') return null;

  const parts: string[] = [];
  if (input.failedStage) {
    parts.push(`Failed at: ${ATTACHMENT_STATE_LABELS[input.failedStage] || input.failedStage}`);
  }
  if (input.errorReason) {
    parts.push(input.errorReason);
  }

  if (parts.length === 0) {
    parts.push('Processing error (no details available)');
  }

  const sanitized = sanitizeContent(parts.join('. '));

  return {
    kind: 'error_card',
    content: sanitized.text,
    accessibilityLabel: `Attachment error: ${sanitized.text}`,
    metadata: {
      isErrorBlock: true,
      failedStage: input.failedStage,
    },
  };
}

// ─── Attachment Row Island Implementation ───────────────────────

/**
 * Typed attachment row island adapter.
 *
 * Renders draft and committed attachment states as typed row islands.
 * Routes through Attachment_Service projection/command ports — never
 * mutates attachment state directly.
 *
 * Produces RowIslandOutput keyed by attachmentId for stable timeline identity.
 * Never exposes private storage paths (Requirement 41.11).
 * Supports legacy attachment data from older sessions.
 */
export class AttachmentRowIslandAdapter implements RowIsland<AttachmentRowIslandInput> {
  readonly kind = 'attachment' as const;

  /**
   * Render an attachment as a typed row island.
   *
   * Dispatches based on state (draft lifecycle or committed).
   * Includes media metadata, state, retention, and availability.
   * Never includes private storage paths.
   */
  render(input: AttachmentRowIslandInput): RowIslandOutput {
    const blocks: ContentBlock[] = [];

    // Primary metadata block
    blocks.push(buildAttachmentMetadataBlock(input));

    // State indicator block (for non-committed draft states or when notable)
    if (!input.isCommitted || input.retentionStatus !== 'active' || !input.authorityAvailable) {
      blocks.push(buildStateBlock(input));
    }

    // Error detail block (only in error state)
    const errorBlock = buildErrorBlock(input);
    if (errorBlock) blocks.push(errorBlock);

    const stateLabel = ATTACHMENT_STATE_LABELS[input.state] || input.state;
    const fileLabel = input.declaredFilename || 'Attachment';
    const accessibilityLabel = `${fileLabel}: ${stateLabel}, ${formatSize(input.sizeBytes)}`;

    const presentation: PresentationOutput = {
      dispatchedKind: input.mediaType.startsWith('image/') ? 'image' : 'generic',
      blocks,
      isFallback: false,
      sanitizationReasons: [],
      callId: input.attachmentId,
    };

    return {
      islandKind: 'attachment',
      presentation,
      stableKey: `attachment:${input.attachmentId}`,
      accessibilityLabel,
      usedFallback: false,
    };
  }

  /**
   * Adapt a legacy attachment reference to an AttachmentRowIslandInput.
   *
   * Maps older session attachment records into the typed input format.
   * Preserves readability for old sessions by inferring state.
   */
  adaptLegacy(legacy: LegacyAttachmentData, attachmentId: string): AttachmentRowIslandInput {
    const state = inferAttachmentState(legacy.status);

    return {
      attachmentId,
      state,
      mediaType: legacy.mediaType || 'application/octet-stream',
      declaredFilename: legacy.filename,
      sizeBytes: legacy.sizeBytes || 0,
      sessionId: '',
      isCommitted: state === 'committed',
      retentionStatus: 'active',
      sourceProjectionRevision: 0,
      authorityAvailable: true,
    };
  }
}

/**
 * Infer attachment state from a legacy status string.
 */
function inferAttachmentState(
  status?: string,
): 'selected' | 'validating' | 'uploading' | 'scanning' | 'ready' | 'committing' | 'committed' | 'error' {
  const normalized = (status || '').toLowerCase().trim();
  if (normalized.includes('commit') || normalized.includes('done') || normalized.includes('complete')) return 'committed';
  if (normalized.includes('upload')) return 'uploading';
  if (normalized.includes('valid')) return 'validating';
  if (normalized.includes('scan')) return 'scanning';
  if (normalized.includes('ready')) return 'ready';
  if (normalized.includes('error') || normalized.includes('fail')) return 'error';
  if (normalized.includes('select')) return 'selected';
  // Default to committed for older sessions (most legacy items are already committed)
  return 'committed';
}

/**
 * Singleton instance. Attachment row islands are stateless pure adapters.
 */
export const attachmentRowIsland = new AttachmentRowIslandAdapter();
