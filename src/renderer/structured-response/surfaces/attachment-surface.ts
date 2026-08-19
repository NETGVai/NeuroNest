/**
 * AttachmentSurface — Typed attachment/artifact surface for images, Mermaid
 * diagrams, file attachments, and generated artifacts.
 *
 * Adapts rich-response/attachment behavior from existing modules behind typed
 * metadata, authority policy, consent, cancellation, and private-path redaction.
 *
 * Key behaviors:
 * - Model-authored remote resources remain inert (non-fetching text/placeholder)
 * - Only typed authorized Image Artifact_Surface may request remote images under policy
 * - Remote resources require explicit consent before fetching
 * - Shows processing, ready, failed, cancelled, and unavailable states
 * - Mermaid diagrams render safely without executing arbitrary code
 * - Lightbox for image preview with focus containment (dialog semantics)
 * - Private-path redaction in visual labels, accessibility text, clipboard, diagnostics
 * - Semantic alternatives (alt text) required for images; missing = render without image
 *
 * Requirements: 5.10, 10.8–10.9, 18.7, 18.12, 20.1–20.5
 */

import type { AttachmentBlockV1 } from '../../../harness/contracts/response-composition';
import { redactForOutput } from '../output-redaction-service';

/** Re-export for backward compatibility — use output-redaction-service directly for new code. */
export const redactPrivatePaths = redactForOutput;

// ─── Constants ──────────────────────────────────────────────────

const CSS_PREFIX = 'nn-attachment-surface';

/** Maximum Mermaid source length (bytes) to prevent denial of service. */
const MAX_MERMAID_SOURCE_LENGTH = 8_192;

/** Maximum preview image dimension in pixels. */
const MAX_PREVIEW_DIMENSION = 600;

/** Maximum number of attachments to render in one surface. */
const MAX_DISPLAYED_ATTACHMENTS = 50;

/** Mermaid graph types that are safe to render. */
const SAFE_MERMAID_GRAPH_TYPES = Object.freeze([
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'erDiagram', 'journey', 'gantt', 'pie', 'mindmap', 'timeline',
  'gitGraph', 'quadrantChart', 'sankey',
]);

/**
 * Pattern for dangerous SVG/Mermaid content.
 * Blocks script, event handlers, external references, and data URIs.
 */
const MALICIOUS_CONTENT_PATTERN =
  /(?:<script|on\w+\s*=|javascript:|data:text\/html|<iframe|<object|<embed|<link\s|<meta\s|xlink:href\s*=\s*["'](?:http|javascript|data))/i;

// ─── Types ──────────────────────────────────────────────────────

export type AttachmentState = 'processing' | 'ready' | 'unavailable' | 'failed' | 'redacted' | 'cancelled' | 'consent_required';

export type AttachmentArtifactKind = 'image' | 'mermaid' | 'file' | 'generated_artifact';

export interface AttachmentItemV1 {
  readonly attachmentId: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly state: AttachmentState;
  readonly alternativeText?: string;
  readonly detailIdentity?: string;
}

export interface AttachmentSurfaceOptions {
  /** Maximum preview height in pixels (Settings_Service). */
  readonly maxPreviewHeight: number;
  /** Whether remote image fetching requires consent (default: true). */
  readonly requireRemoteConsent: boolean;
  /** Callback when user grants consent for remote resource. */
  readonly onGrantConsent?: (attachmentId: string) => Promise<AttachmentActionResult>;
  /** Callback to open/download an attachment via authority. */
  readonly onOpen?: (target: AttachmentOpenTarget) => Promise<AttachmentActionResult>;
  /** Callback to download an attachment via authority. */
  readonly onDownload?: (target: AttachmentOpenTarget) => Promise<AttachmentActionResult>;
  /** Callback to cancel a processing attachment. */
  readonly onCancel?: (attachmentId: string) => Promise<AttachmentActionResult>;
  /** Owner document for element creation. */
  readonly ownerDocument?: Document;
}

export interface AttachmentOpenTarget {
  readonly attachmentId: string;
  readonly displayName: string;
  readonly mediaType: string;
}

export interface AttachmentActionResult {
  readonly success: boolean;
  readonly failureReason?: string;
}

export type AttachmentSurfaceActionKind = 'open' | 'download' | 'copy_alt' | 'grant_consent' | 'cancel' | 'lightbox_open' | 'lightbox_close';

export interface AttachmentSurfaceAction {
  readonly kind: AttachmentSurfaceActionKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly execute: () => Promise<AttachmentActionResult>;
}

export interface AttachmentSurfaceHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly semanticAnchor: string;
  readonly state: AttachmentState;
  readonly actions: readonly AttachmentSurfaceAction[];
  readonly isLightboxOpen: boolean;
  update(block: AttachmentBlockV1, options?: Partial<AttachmentSurfaceOptions>): void;
  dispose(): void;
}

// ─── Utilities ──────────────────────────────────────────────────

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Classify an attachment's artifact kind from its media type.
 */
export function classifyArtifactKind(mediaType: string): AttachmentArtifactKind {
  const lower = mediaType.toLowerCase().trim();
  if (lower.startsWith('image/')) return 'image';
  if (lower === 'text/mermaid' || lower === 'application/mermaid') return 'mermaid';
  return 'file';
}

/**
 * Validate Mermaid source is safe to render.
 * Returns a sanitized version or null if dangerous.
 */
export function validateMermaidSource(source: string): string | null {
  if (!source || source.length > MAX_MERMAID_SOURCE_LENGTH) return null;
  if (MALICIOUS_CONTENT_PATTERN.test(source)) return null;

  // Check first non-whitespace token matches a known safe graph type
  const trimmed = source.trim();
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  const firstToken = firstLine.split(/[\s{(]/)[0]?.toLowerCase() ?? '';

  const isSafeType = SAFE_MERMAID_GRAPH_TYPES.some(
    (t) => t.toLowerCase() === firstToken,
  );
  if (!isSafeType) return null;

  // Strip any potential HTML/script injections from the source
  const sanitized = source
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:text\/html/gi, '');

  return sanitized;
}

/**
 * Check if a media type represents a previewable image type.
 */
export function isPreviewableImage(mediaType: string): boolean {
  const lower = mediaType.toLowerCase().trim();
  return (
    lower === 'image/png' ||
    lower === 'image/jpeg' ||
    lower === 'image/gif' ||
    lower === 'image/webp' ||
    lower === 'image/svg+xml'
  );
}

/**
 * State label for accessibility announcements.
 */
function getStateLabel(state: AttachmentState): string {
  switch (state) {
    case 'processing': return 'Processing';
    case 'ready': return 'Ready';
    case 'unavailable': return 'Unavailable';
    case 'failed': return 'Failed';
    case 'redacted': return 'Redacted';
    case 'cancelled': return 'Cancelled';
    case 'consent_required': return 'Consent required';
  }
}

/**
 * State non-color indicator character for accessibility.
 */
function getStateIndicator(state: AttachmentState): string {
  switch (state) {
    case 'processing': return '\u29D7'; // hourglass
    case 'ready': return '\u2713'; // check mark
    case 'unavailable': return '\u2014'; // em dash
    case 'failed': return '\u2717'; // cross
    case 'redacted': return '\u2588'; // full block
    case 'cancelled': return '\u2298'; // circle with minus
    case 'consent_required': return '\u26A0'; // warning sign
  }
}

// ─── Default options ────────────────────────────────────────────

const DEFAULT_OPTIONS: AttachmentSurfaceOptions = {
  maxPreviewHeight: MAX_PREVIEW_DIMENSION,
  requireRemoteConsent: true,
};

// ─── AttachmentSurface ──────────────────────────────────────────

export class AttachmentSurface {
  private readonly doc: Document;

  constructor(ownerDocument: Document = document) {
    this.doc = ownerDocument;
  }

  render(block: AttachmentBlockV1, options: Partial<AttachmentSurfaceOptions> = {}): AttachmentSurfaceHandle {
    const resolved: AttachmentSurfaceOptions = { ...DEFAULT_OPTIONS, ...options };
    const doc = resolved.ownerDocument ?? this.doc;

    // State
    let currentBlock = block;
    let currentOptions = resolved;
    let disposed = false;
    let lightboxOpen = false;
    let lightboxElement: HTMLElement | null = null;
    let previousFocusElement: Element | null = null;

    // ─── Root element ───────────────────────────────────────────

    const root = doc.createElement('section');
    root.className = CSS_PREFIX;
    root.setAttribute('role', 'region');
    root.setAttribute(
      'aria-label',
      buildAriaLabel(block),
    );
    root.dataset.stableKey = block.stableKey;
    root.dataset.semanticAnchor = block.semanticAnchor;
    root.dataset.status = block.status;

    // ─── Render attachment items ────────────────────────────────

    function buildAriaLabel(blk: AttachmentBlockV1): string {
      const count = blk.content.attachments.length;
      if (count === 0) return 'Attachments: none';
      if (count === 1) {
        const item = blk.content.attachments[0];
        const name = redactPrivatePaths(item.displayName);
        return `Attachment: ${name}, ${getStateLabel(item.state as AttachmentState)}`;
      }
      return `Attachments: ${count} items`;
    }

    function renderItems(): void {
      root.textContent = '';

      const attachments = currentBlock.content.attachments.slice(0, MAX_DISPLAYED_ATTACHMENTS);

      if (attachments.length === 0) {
        const emptyEl = doc.createElement('div');
        emptyEl.className = `${CSS_PREFIX}__empty`;
        emptyEl.textContent = 'No attachments';
        root.appendChild(emptyEl);
        return;
      }

      const list = doc.createElement('div');
      list.className = `${CSS_PREFIX}__list`;
      list.setAttribute('role', 'list');

      for (const item of attachments) {
        const itemEl = renderAttachmentItem(item as AttachmentItemV1);
        list.appendChild(itemEl);
      }

      root.appendChild(list);

      // Overflow indicator
      if (currentBlock.content.attachments.length > MAX_DISPLAYED_ATTACHMENTS) {
        const overflow = doc.createElement('div');
        overflow.className = `${CSS_PREFIX}__overflow`;
        overflow.textContent = `${currentBlock.content.attachments.length - MAX_DISPLAYED_ATTACHMENTS} more attachments`;
        overflow.setAttribute('aria-label', `${currentBlock.content.attachments.length - MAX_DISPLAYED_ATTACHMENTS} additional attachments not shown`);
        root.appendChild(overflow);
      }
    }

    function renderAttachmentItem(item: AttachmentItemV1): HTMLElement {
      const itemEl = doc.createElement('div');
      itemEl.className = `${CSS_PREFIX}__item`;
      itemEl.setAttribute('role', 'listitem');
      itemEl.dataset.attachmentId = item.attachmentId;
      itemEl.dataset.state = item.state;

      const kind = classifyArtifactKind(item.mediaType);
      itemEl.dataset.kind = kind;

      // State indicator
      const stateEl = doc.createElement('span');
      stateEl.className = `${CSS_PREFIX}__state-indicator`;
      stateEl.textContent = getStateIndicator(item.state as AttachmentState);
      stateEl.setAttribute('aria-hidden', 'true');
      itemEl.appendChild(stateEl);

      // Display name (redacted)
      const nameEl = doc.createElement('span');
      nameEl.className = `${CSS_PREFIX}__name`;
      nameEl.textContent = redactPrivatePaths(item.displayName);
      itemEl.appendChild(nameEl);

      // State label (non-color indicator)
      const stateLabel = doc.createElement('span');
      stateLabel.className = `${CSS_PREFIX}__state-label`;
      stateLabel.textContent = getStateLabel(item.state as AttachmentState);
      itemEl.appendChild(stateLabel);

      // Media type badge
      const typeBadge = doc.createElement('span');
      typeBadge.className = `${CSS_PREFIX}__type-badge`;
      typeBadge.textContent = item.mediaType;
      typeBadge.setAttribute('aria-label', `Type: ${item.mediaType}`);
      itemEl.appendChild(typeBadge);

      // Alternative text for images
      if (item.alternativeText && kind === 'image') {
        const altEl = doc.createElement('span');
        altEl.className = `${CSS_PREFIX}__alt-text`;
        altEl.textContent = redactPrivatePaths(item.alternativeText);
        altEl.setAttribute('aria-label', `Description: ${redactPrivatePaths(item.alternativeText)}`);
        itemEl.appendChild(altEl);
      } else if (kind === 'image' && !item.alternativeText) {
        // Missing alternative: render indicator, no image preview
        const missingAlt = doc.createElement('span');
        missingAlt.className = `${CSS_PREFIX}__missing-alt`;
        missingAlt.textContent = 'No description available';
        missingAlt.setAttribute('aria-label', 'Image description unavailable');
        itemEl.appendChild(missingAlt);
      }

      // Mermaid safe preview
      if (kind === 'mermaid' && item.state === 'ready') {
        const mermaidPreview = renderMermaidPreview(item);
        if (mermaidPreview) {
          itemEl.appendChild(mermaidPreview);
        }
      }

      // Image bounded preview (only for ready state with alt text and consent)
      if (kind === 'image' && item.state === 'ready' && item.alternativeText) {
        const preview = renderImagePreview(item);
        itemEl.appendChild(preview);
      }

      // Action buttons
      const actionsEl = renderItemActions(item, kind);
      itemEl.appendChild(actionsEl);

      return itemEl;
    }

    function renderMermaidPreview(item: AttachmentItemV1): HTMLElement | null {
      // Mermaid diagrams are rendered as safe SVG text, not executed
      const placeholder = doc.createElement('div');
      placeholder.className = `${CSS_PREFIX}__mermaid-preview`;
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute(
        'aria-label',
        item.alternativeText
          ? redactPrivatePaths(item.alternativeText)
          : `Mermaid diagram: ${redactPrivatePaths(item.displayName)}`,
      );

      // Show a safe representation indicator
      const label = doc.createElement('span');
      label.className = `${CSS_PREFIX}__mermaid-label`;
      label.textContent = 'Diagram';
      placeholder.appendChild(label);

      const desc = doc.createElement('span');
      desc.className = `${CSS_PREFIX}__mermaid-desc`;
      desc.textContent = item.alternativeText
        ? redactPrivatePaths(item.alternativeText)
        : redactPrivatePaths(item.displayName);
      placeholder.appendChild(desc);

      return placeholder;
    }

    function renderImagePreview(item: AttachmentItemV1): HTMLElement {
      const container = doc.createElement('div');
      container.className = `${CSS_PREFIX}__image-preview`;

      if (currentOptions.requireRemoteConsent) {
        // Consent required: show placeholder, not the image
        const consentEl = doc.createElement('div');
        consentEl.className = `${CSS_PREFIX}__consent-placeholder`;
        consentEl.setAttribute('role', 'status');
        consentEl.setAttribute('aria-label', 'Remote image requires consent to load');

        const consentText = doc.createElement('span');
        consentText.className = `${CSS_PREFIX}__consent-text`;
        consentText.textContent = 'Image available — consent required to load';
        consentEl.appendChild(consentText);

        const consentBtn = doc.createElement('button');
        consentBtn.className = `${CSS_PREFIX}__consent-btn`;
        consentBtn.textContent = 'Load image';
        consentBtn.setAttribute('aria-label', `Load image: ${redactPrivatePaths(item.displayName)}`);
        consentBtn.addEventListener('click', () => {
          handleGrantConsent(item.attachmentId);
        });
        consentEl.appendChild(consentBtn);

        container.appendChild(consentEl);
      } else {
        // No consent needed: show bounded placeholder (actual image loading
        // is delegated to the authority, we only show a safe placeholder)
        const imgPlaceholder = doc.createElement('div');
        imgPlaceholder.className = `${CSS_PREFIX}__image-bounded`;
        imgPlaceholder.style.maxHeight = `${currentOptions.maxPreviewHeight}px`;
        imgPlaceholder.setAttribute('role', 'img');
        imgPlaceholder.setAttribute(
          'aria-label',
          item.alternativeText
            ? redactPrivatePaths(item.alternativeText)
            : redactPrivatePaths(item.displayName),
        );

        // Lightbox trigger
        const lightboxBtn = doc.createElement('button');
        lightboxBtn.className = `${CSS_PREFIX}__lightbox-trigger`;
        lightboxBtn.textContent = 'Preview';
        lightboxBtn.setAttribute('aria-label', `Open preview: ${redactPrivatePaths(item.displayName)}`);
        lightboxBtn.addEventListener('click', () => {
          openLightbox(item);
        });
        imgPlaceholder.appendChild(lightboxBtn);

        container.appendChild(imgPlaceholder);
      }

      return container;
    }

    function renderItemActions(item: AttachmentItemV1, kind: AttachmentArtifactKind): HTMLElement {
      const actionsEl = doc.createElement('div');
      actionsEl.className = `${CSS_PREFIX}__item-actions`;
      actionsEl.setAttribute('role', 'toolbar');
      actionsEl.setAttribute('aria-label', `Actions for ${redactPrivatePaths(item.displayName)}`);

      // Open action (only for ready state with authority)
      if (item.state === 'ready' && currentOptions.onOpen) {
        const openBtn = doc.createElement('button');
        openBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__open-btn`;
        openBtn.textContent = 'Open';
        openBtn.setAttribute('aria-label', `Open: ${redactPrivatePaths(item.displayName)}`);
        openBtn.addEventListener('click', () => {
          handleOpen(item);
        });
        actionsEl.appendChild(openBtn);
      }

      // Download action (only for ready state with authority)
      if (item.state === 'ready' && currentOptions.onDownload) {
        const downloadBtn = doc.createElement('button');
        downloadBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__download-btn`;
        downloadBtn.textContent = 'Download';
        downloadBtn.setAttribute('aria-label', `Download: ${redactPrivatePaths(item.displayName)}`);
        downloadBtn.addEventListener('click', () => {
          handleDownload(item);
        });
        actionsEl.appendChild(downloadBtn);
      }

      // Copy alternative text action (for images with alt text)
      if (item.alternativeText && kind === 'image') {
        const copyAltBtn = doc.createElement('button');
        copyAltBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__copy-alt-btn`;
        copyAltBtn.textContent = 'Copy description';
        copyAltBtn.setAttribute('aria-label', `Copy image description`);
        copyAltBtn.addEventListener('click', () => {
          handleCopyAlt(item);
        });
        actionsEl.appendChild(copyAltBtn);
      }

      // Cancel action (only for processing state)
      if (item.state === 'processing' && currentOptions.onCancel) {
        const cancelBtn = doc.createElement('button');
        cancelBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__cancel-btn`;
        cancelBtn.textContent = 'Cancel';
        cancelBtn.setAttribute('aria-label', `Cancel: ${redactPrivatePaths(item.displayName)}`);
        cancelBtn.addEventListener('click', () => {
          handleCancel(item.attachmentId);
        });
        actionsEl.appendChild(cancelBtn);
      }

      // Disabled reasons for unavailable/failed states
      if (item.state === 'unavailable' || item.state === 'failed' || item.state === 'redacted') {
        const disabledInfo = doc.createElement('span');
        disabledInfo.className = `${CSS_PREFIX}__disabled-reason`;
        disabledInfo.textContent = item.state === 'redacted'
          ? 'Content redacted'
          : item.state === 'failed'
            ? 'Loading failed'
            : 'Unavailable';
        disabledInfo.setAttribute('aria-live', 'polite');
        actionsEl.appendChild(disabledInfo);
      }

      return actionsEl;
    }

    // ─── Lightbox ───────────────────────────────────────────────

    function openLightbox(item: AttachmentItemV1): void {
      if (lightboxOpen || disposed) return;
      lightboxOpen = true;

      previousFocusElement = doc.activeElement;

      lightboxElement = doc.createElement('div');
      lightboxElement.className = `${CSS_PREFIX}__lightbox`;
      lightboxElement.setAttribute('role', 'dialog');
      lightboxElement.setAttribute('aria-modal', 'true');
      lightboxElement.setAttribute(
        'aria-label',
        item.alternativeText
          ? `Image preview: ${redactPrivatePaths(item.alternativeText)}`
          : `Image preview: ${redactPrivatePaths(item.displayName)}`,
      );
      lightboxElement.tabIndex = -1;

      // Backdrop
      const backdrop = doc.createElement('div');
      backdrop.className = `${CSS_PREFIX}__lightbox-backdrop`;
      backdrop.addEventListener('click', () => closeLightbox());
      lightboxElement.appendChild(backdrop);

      // Content area
      const content = doc.createElement('div');
      content.className = `${CSS_PREFIX}__lightbox-content`;

      // Image description
      const descEl = doc.createElement('p');
      descEl.className = `${CSS_PREFIX}__lightbox-desc`;
      descEl.textContent = item.alternativeText
        ? redactPrivatePaths(item.alternativeText)
        : redactPrivatePaths(item.displayName);
      content.appendChild(descEl);

      // Placeholder for actual image (authority-managed display)
      const imgArea = doc.createElement('div');
      imgArea.className = `${CSS_PREFIX}__lightbox-image-area`;
      imgArea.setAttribute('role', 'img');
      imgArea.setAttribute(
        'aria-label',
        item.alternativeText
          ? redactPrivatePaths(item.alternativeText)
          : redactPrivatePaths(item.displayName),
      );
      imgArea.style.maxHeight = `${currentOptions.maxPreviewHeight}px`;
      content.appendChild(imgArea);

      lightboxElement.appendChild(content);

      // Close button
      const closeBtn = doc.createElement('button');
      closeBtn.className = `${CSS_PREFIX}__lightbox-close`;
      closeBtn.textContent = 'Close';
      closeBtn.setAttribute('aria-label', 'Close preview');
      closeBtn.addEventListener('click', () => closeLightbox());
      lightboxElement.appendChild(closeBtn);

      // Focus trap
      lightboxElement.addEventListener('keydown', handleLightboxKeydown);

      doc.body.appendChild(lightboxElement);
      // Focus the close button for keyboard accessibility
      closeBtn.focus();
    }

    function closeLightbox(): void {
      if (!lightboxOpen || !lightboxElement) return;
      lightboxOpen = false;

      lightboxElement.removeEventListener('keydown', handleLightboxKeydown);
      lightboxElement.remove();
      lightboxElement = null;

      // Restore focus
      if (previousFocusElement && previousFocusElement instanceof HTMLElement) {
        previousFocusElement.focus();
      }
      previousFocusElement = null;
    }

    function handleLightboxKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeLightbox();
        return;
      }

      // Focus containment: trap Tab within the lightbox
      if (event.key === 'Tab' && lightboxElement) {
        const focusable = lightboxElement.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && doc.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    // ─── Action handlers ────────────────────────────────────────

    async function handleOpen(item: AttachmentItemV1): Promise<AttachmentActionResult> {
      if (!currentOptions.onOpen) {
        return { success: false, failureReason: 'open_unavailable' };
      }
      try {
        return await currentOptions.onOpen({
          attachmentId: item.attachmentId,
          displayName: item.displayName,
          mediaType: item.mediaType,
        });
      } catch {
        return { success: false, failureReason: 'authority_error' };
      }
    }

    async function handleDownload(item: AttachmentItemV1): Promise<AttachmentActionResult> {
      if (!currentOptions.onDownload) {
        return { success: false, failureReason: 'download_unavailable' };
      }
      try {
        return await currentOptions.onDownload({
          attachmentId: item.attachmentId,
          displayName: item.displayName,
          mediaType: item.mediaType,
        });
      } catch {
        return { success: false, failureReason: 'authority_error' };
      }
    }

    async function handleCopyAlt(item: AttachmentItemV1): Promise<AttachmentActionResult> {
      if (!item.alternativeText) {
        return { success: false, failureReason: 'no_alternative_text' };
      }
      try {
        const redacted = redactPrivatePaths(item.alternativeText);
        await navigator.clipboard.writeText(redacted);
        return { success: true };
      } catch {
        return { success: false, failureReason: 'clipboard_unavailable' };
      }
    }

    async function handleGrantConsent(attachmentId: string): Promise<AttachmentActionResult> {
      if (!currentOptions.onGrantConsent) {
        return { success: false, failureReason: 'consent_handler_unavailable' };
      }
      try {
        return await currentOptions.onGrantConsent(attachmentId);
      } catch {
        return { success: false, failureReason: 'authority_error' };
      }
    }

    async function handleCancel(attachmentId: string): Promise<AttachmentActionResult> {
      if (!currentOptions.onCancel) {
        return { success: false, failureReason: 'cancel_unavailable' };
      }
      try {
        return await currentOptions.onCancel(attachmentId);
      } catch {
        return { success: false, failureReason: 'authority_error' };
      }
    }

    // ─── Build actions list ─────────────────────────────────────

    function buildActions(): AttachmentSurfaceAction[] {
      const actions: AttachmentSurfaceAction[] = [];
      const attachments = currentBlock.content.attachments;

      if (attachments.length === 0) return actions;

      // Aggregate actions based on first attachment state (simplified)
      const firstItem = attachments[0] as AttachmentItemV1;
      const kind = classifyArtifactKind(firstItem.mediaType);

      if (firstItem.state === 'ready' && currentOptions.onOpen) {
        actions.push({
          kind: 'open',
          label: `Open: ${redactPrivatePaths(firstItem.displayName)}`,
          disabled: false,
          execute: () => handleOpen(firstItem),
        });
      }

      if (firstItem.state === 'ready' && currentOptions.onDownload) {
        actions.push({
          kind: 'download',
          label: `Download: ${redactPrivatePaths(firstItem.displayName)}`,
          disabled: false,
          execute: () => handleDownload(firstItem),
        });
      }

      if (firstItem.alternativeText && kind === 'image') {
        actions.push({
          kind: 'copy_alt',
          label: 'Copy description',
          disabled: false,
          execute: () => handleCopyAlt(firstItem),
        });
      }

      if (currentOptions.requireRemoteConsent && kind === 'image' && firstItem.state === 'ready' && currentOptions.onGrantConsent) {
        actions.push({
          kind: 'grant_consent',
          label: 'Load remote image',
          disabled: false,
          execute: () => handleGrantConsent(firstItem.attachmentId),
        });
      }

      if (firstItem.state === 'processing' && currentOptions.onCancel) {
        actions.push({
          kind: 'cancel',
          label: 'Cancel',
          disabled: false,
          execute: () => handleCancel(firstItem.attachmentId),
        });
      }

      if (lightboxOpen) {
        actions.push({
          kind: 'lightbox_close',
          label: 'Close preview',
          disabled: false,
          execute: async () => { closeLightbox(); return { success: true }; },
        });
      }

      // Disabled actions for non-ready states
      if (firstItem.state === 'unavailable' || firstItem.state === 'failed' || firstItem.state === 'redacted') {
        actions.push({
          kind: 'open',
          label: `Open: ${redactPrivatePaths(firstItem.displayName)}`,
          disabled: true,
          disabledReason: getStateLabel(firstItem.state as AttachmentState),
          execute: async () => ({ success: false, failureReason: 'attachment_not_ready' }),
        });
      }

      return actions;
    }

    // ─── Compute aggregate state ────────────────────────────────

    function computeAggregateState(): AttachmentState {
      const attachments = currentBlock.content.attachments;
      if (attachments.length === 0) return 'unavailable';

      const states = attachments.map((a) => a.state as AttachmentState);

      // Any processing => processing
      if (states.includes('processing')) return 'processing';
      // Any failed => failed
      if (states.includes('failed')) return 'failed';
      // All ready => ready
      if (states.every((s) => s === 'ready')) return 'ready';
      // Any unavailable => unavailable
      if (states.includes('unavailable')) return 'unavailable';
      // Any redacted => redacted
      if (states.includes('redacted')) return 'redacted';

      return states[0] ?? 'unavailable';
    }

    // ─── Initial render ─────────────────────────────────────────

    renderItems();

    // ─── Handle ─────────────────────────────────────────────────

    const handle: AttachmentSurfaceHandle = {
      get element() { return root; },
      get stableKey() { return currentBlock.stableKey; },
      get semanticAnchor() { return currentBlock.semanticAnchor; },
      get state() { return computeAggregateState(); },
      get actions() { return buildActions(); },
      get isLightboxOpen() { return lightboxOpen; },

      update(nextBlock: AttachmentBlockV1, nextOptions?: Partial<AttachmentSurfaceOptions>): void {
        if (disposed) return;

        currentBlock = nextBlock;
        if (nextOptions) {
          currentOptions = { ...currentOptions, ...nextOptions };
        }

        root.dataset.stableKey = nextBlock.stableKey;
        root.dataset.semanticAnchor = nextBlock.semanticAnchor;
        root.dataset.status = nextBlock.status;
        root.setAttribute('aria-label', buildAriaLabel(nextBlock));

        renderItems();
      },

      dispose(): void {
        if (disposed) return;
        disposed = true;

        closeLightbox();
        root.remove();
      },
    };

    return handle;
  }
}
