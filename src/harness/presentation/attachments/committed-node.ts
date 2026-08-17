/**
 * Committed Attachment Node
 *
 * Renders immutable committed attachment details in the Canonical_Timeline.
 * Shows identity, media metadata, availability, retention status, content
 * digest, source sequence, and policy-routed download actions.
 *
 * All labels and clipboard data use authorized references only.
 * Never exposes private host paths or secret locators.
 *
 * Requirements: 41.6-41.9, 41.11-41.14, 46.9
 */

import { z } from 'zod';
import { IdentifierSchema, IntegrityHashSchema } from '../../contracts/primitives';
import type { AttachmentMetadata } from '../../session/attachment-schemas';
import { formatByteSize } from './attachment-rail';
import type {
  CommittedAttachmentNode,
  CommittedAttachmentAction,
  DownloadPolicy,
} from './types';

// ─── Projection Input ───────────────────────────────────────────

/**
 * Input from Projection_Service for a committed attachment event.
 *
 * Contains the immutable event and attachment data projected from
 * Session_Log (Requirement 41.14).
 */
export interface CommittedAttachmentProjection {
  /** Event identity from Session_Log (Requirement 41.14). */
  eventId: string;
  /** Source sequence in Session_Log (Requirement 41.14). */
  sourceSequence: number;
  /** Immutable attachment metadata (Requirement 41.12). */
  metadata: AttachmentMetadata;
  /** Authorized reference for preview/download (Requirement 41.11). */
  authorizedReference: string;
  /** Retention status from Projection_Service (Requirement 41.12). */
  retentionStatus: 'active' | 'expiring' | 'expired';
  /** Download policy resolved by Attachment_Service (Requirements 41.6-41.7). */
  downloadPolicy: DownloadPolicy;
}

// ─── Availability Derivation ────────────────────────────────────

/**
 * Derive availability from retention status.
 *
 * Requirement 41.12: Display availability and retention status.
 */
export function deriveAvailability(
  retentionStatus: 'active' | 'expiring' | 'expired',
): 'available' | 'expiring' | 'expired' | 'unavailable' {
  switch (retentionStatus) {
    case 'active':
      return 'available';
    case 'expiring':
      return 'expiring';
    case 'expired':
      return 'expired';
    default:
      return 'unavailable';
  }
}

// ─── Action Resolution ──────────────────────────────────────────

/**
 * Resolve available actions for a committed attachment node.
 *
 * Requirements 41.6-41.7: Download action exposed when permitted,
 * omitted when denied (with policy reason in details).
 */
export function resolveCommittedActions(
  downloadPolicy: DownloadPolicy,
  mediaType: string,
  retentionStatus: 'active' | 'expiring' | 'expired',
): CommittedAttachmentAction[] {
  const actions: CommittedAttachmentAction[] = ['inspect'];

  // Only provide lightbox for available image attachments
  if (retentionStatus !== 'expired' && isImageMediaType(mediaType)) {
    actions.push('open_lightbox');
  }

  // Requirement 41.6: Download action routed through policy
  // Requirement 41.7: Omit download action when denied
  if (downloadPolicy.permitted && retentionStatus !== 'expired') {
    actions.push('download');
  }

  return actions;
}

/**
 * Check if a media type supports lightbox viewing.
 */
function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

// ─── Accessibility Label ────────────────────────────────────────

/**
 * Build a path-free accessibility label for a committed attachment node.
 *
 * Requirements 41.11, 46.9: Labels use permitted filename and metadata.
 * Never expose host paths, secret locators, or internal references.
 */
export function buildCommittedAccessibilityLabel(
  metadata: AttachmentMetadata,
  retentionStatus: 'active' | 'expiring' | 'expired',
  downloadPolicy: DownloadPolicy,
): string {
  const name = metadata.declaredFilename ?? 'Attachment';
  const size = formatByteSize(metadata.sizeBytes);
  const availability = retentionStatus === 'active'
    ? 'available'
    : retentionStatus === 'expiring'
      ? 'expiring'
      : 'expired';

  let label = `${name}, ${metadata.mediaType}, ${size}, ${availability}`;

  if (metadata.dimensions) {
    label += `, ${metadata.dimensions.width}\u00D7${metadata.dimensions.height} pixels`;
  }
  if (metadata.duration) {
    const mins = Math.floor(metadata.duration / 60);
    const secs = Math.round(metadata.duration % 60);
    label += `, duration ${mins}:${secs.toString().padStart(2, '0')}`;
  }

  if (!downloadPolicy.permitted && downloadPolicy.deniedReason) {
    label += `, download unavailable: ${downloadPolicy.deniedReason}`;
  }

  return label;
}

// ─── Clipboard Data ─────────────────────────────────────────────

/**
 * Build path-free clipboard content for a committed attachment.
 *
 * Requirement 41.11: Clipboard content uses authorized references only.
 * Never includes private host paths or secret-bearing locators.
 */
export function buildClipboardData(
  metadata: AttachmentMetadata,
  authorizedReference: string,
): string {
  const name = metadata.declaredFilename ?? 'Attachment';
  return `${name} (${metadata.mediaType}, ${formatByteSize(metadata.sizeBytes)}) [ref:${authorizedReference}]`;
}

/**
 * Build path-free log/diagnostic data for a committed attachment.
 *
 * Requirement 41.11: Log data uses authorized references only.
 */
export function buildDiagnosticData(
  metadata: AttachmentMetadata,
  eventId: string,
  sourceSequence: number,
): Record<string, unknown> {
  return {
    attachmentId: metadata.attachmentId,
    eventId,
    sourceSequence,
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    contentHash: metadata.contentHash,
    declaredFilename: metadata.declaredFilename,
    dimensions: metadata.dimensions,
    duration: metadata.duration,
    // Never includes: private paths, storage locations, internal URLs
  };
}

// ─── Node Derivation ────────────────────────────────────────────

/**
 * Derive a committed attachment node presentation from projection data.
 *
 * This is the primary function for rendering committed attachments in the
 * Canonical_Timeline. Produces a path-free, immutable representation.
 *
 * Requirements: 41.6-41.9, 41.11-41.14, 46.9
 */
export function deriveCommittedAttachmentNode(
  projection: CommittedAttachmentProjection,
): CommittedAttachmentNode {
  const { eventId, sourceSequence, metadata, authorizedReference, retentionStatus, downloadPolicy } = projection;

  return {
    attachmentId: metadata.attachmentId,
    contentDigest: metadata.contentHash,
    mediaType: metadata.mediaType,
    displayName: metadata.declaredFilename ?? null,
    formattedSize: formatByteSize(metadata.sizeBytes),
    dimensions: metadata.dimensions,
    durationSeconds: metadata.duration,
    availability: deriveAvailability(retentionStatus),
    retentionStatus,
    eventId,
    sourceSequence,
    downloadPolicy,
    accessibilityLabel: buildCommittedAccessibilityLabel(metadata, retentionStatus, downloadPolicy),
    availableActions: resolveCommittedActions(downloadPolicy, metadata.mediaType, retentionStatus),
  };
}

// ─── Idempotent Commit Detection ────────────────────────────────

/**
 * Check if two committed projections represent the same committed attachment
 * via idempotent commit (Requirement 41.9, 41.13).
 *
 * Returns true if the attachment identity and content hash match, meaning
 * repeated commit attempts produced one committed attachment.
 */
export function isIdempotentDuplicate(
  a: CommittedAttachmentProjection,
  b: CommittedAttachmentProjection,
): boolean {
  return (
    a.metadata.attachmentId === b.metadata.attachmentId &&
    a.metadata.contentHash === b.metadata.contentHash
  );
}
