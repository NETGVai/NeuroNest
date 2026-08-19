/**
 * Meaningful Loading Controller — Structured Response Renderer
 *
 * Manages loading placeholders and block status presentation to ensure:
 * - Known layout space is reserved for pending content
 * - Status text/omission is used rather than false completed skeletons
 * - No decorative skeletons appear for indeterminate semantic content
 * - Progress updates are communicated through state text/icons
 * - Insertion and disclosure do not depend solely on animation
 *
 * Requirements: 4.9, 17.5–17.7, 18.1, 22.5
 *
 * @vitest-environment jsdom
 */

// ─── Constants ──────────────────────────────────────────────────

export const LOADING_PLACEHOLDER_CLASS = 'nn-loading-placeholder';
export const LOADING_STATUS_CLASS = 'nn-loading-status';
export const LOADING_RESERVED_CLASS = 'nn-loading-reserved';
export const LOADING_INDETERMINATE_CLASS = 'nn-loading-indeterminate';
export const LOADING_PROGRESS_CLASS = 'nn-loading-progress';
export const LOADING_OMITTED_CLASS = 'nn-loading-omitted';
export const PLACEHOLDER_ROLE = 'status';

// ─── Types ──────────────────────────────────────────────────────

/**
 * The known state of a block's loading status.
 */
export type LoadingState =
  | 'pending'          // Block exists but content not ready
  | 'streaming'        // Block is actively receiving content
  | 'indeterminate'    // Content shape/size is unknown
  | 'reserved'         // Known layout space is reserved
  | 'ready'            // Content is fully loaded
  | 'omitted'          // Block is intentionally hidden/omitted
  | 'failed';          // Block failed to load

/**
 * Describes a loading placeholder for a response block.
 */
export interface LoadingPlaceholderDescriptor {
  /** Stable key of the block this placeholder represents */
  readonly blockKey: string;
  /** Current loading state */
  readonly state: LoadingState;
  /** Human-readable status text for accessibility */
  readonly statusText: string;
  /** Expected height in pixels if layout space is known */
  readonly reservedHeightPx?: number;
  /** Expected width in pixels if layout space is known */
  readonly reservedWidthPx?: number;
  /** Block kind (for selecting appropriate status messages) */
  readonly blockKind?: string;
  /** Whether progress is numerically meaningful */
  readonly progressPercent?: number;
}

/**
 * Handle for a rendered loading placeholder element.
 */
export interface LoadingPlaceholderHandle {
  /** The DOM element representing this placeholder */
  readonly element: HTMLElement;
  /** The current block key */
  readonly blockKey: string;
  /** Update the placeholder state without remounting */
  update(descriptor: LoadingPlaceholderDescriptor): void;
  /** Remove the placeholder from DOM and release resources */
  dispose(): void;
}

/**
 * Options for the MeaningfulLoadingController.
 */
export interface MeaningfulLoadingControllerOptions {
  /** Whether reduced motion is active (affects animation on placeholders) */
  readonly reducedMotion?: boolean;
}

/**
 * Controller handle for managing all loading placeholders.
 */
export interface MeaningfulLoadingControllerHandle {
  /** Create a new loading placeholder for a block */
  createPlaceholder(descriptor: LoadingPlaceholderDescriptor): LoadingPlaceholderHandle;
  /** Update reduced motion preference across all placeholders */
  setReducedMotion(reduced: boolean): void;
  /** Whether reduced motion is active */
  readonly isReducedMotion: boolean;
  /** Get all currently active placeholder block keys */
  getActivePlaceholders(): readonly string[];
  /** Dispose all active placeholders */
  dispose(): void;
}

// ─── Placeholder Rendering ──────────────────────────────────────

/**
 * Creates a DOM element representing a loading placeholder.
 * Does NOT use decorative shimmer/skeleton for indeterminate content.
 * Uses status text and reserved dimensions instead.
 */
function renderPlaceholder(
  descriptor: LoadingPlaceholderDescriptor,
  reducedMotion: boolean,
): HTMLElement {
  const el = document.createElement('div');
  el.className = LOADING_PLACEHOLDER_CLASS;
  el.setAttribute('role', PLACEHOLDER_ROLE);
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.dataset.blockKey = descriptor.blockKey;
  el.dataset.loadingState = descriptor.state;

  if (descriptor.blockKind) {
    el.dataset.blockKind = descriptor.blockKind;
  }

  // Apply state-specific class
  applyStateClass(el, descriptor.state);

  // Reserve known layout space
  if (descriptor.reservedHeightPx !== undefined && descriptor.reservedHeightPx > 0) {
    el.style.minHeight = `${descriptor.reservedHeightPx}px`;
    el.classList.add(LOADING_RESERVED_CLASS);
  }
  if (descriptor.reservedWidthPx !== undefined && descriptor.reservedWidthPx > 0) {
    el.style.minWidth = `${descriptor.reservedWidthPx}px`;
  }

  // Status text (always present for accessibility)
  const statusEl = document.createElement('span');
  statusEl.className = LOADING_STATUS_CLASS;
  statusEl.textContent = descriptor.statusText;
  statusEl.setAttribute('aria-label', descriptor.statusText);
  el.appendChild(statusEl);

  // Progress indicator (text-based, no decorative animation)
  if (descriptor.progressPercent !== undefined && descriptor.state !== 'indeterminate') {
    const progressEl = document.createElement('span');
    progressEl.className = LOADING_PROGRESS_CLASS;
    progressEl.setAttribute('role', 'progressbar');
    progressEl.setAttribute('aria-valuenow', String(descriptor.progressPercent));
    progressEl.setAttribute('aria-valuemin', '0');
    progressEl.setAttribute('aria-valuemax', '100');
    progressEl.textContent = `${descriptor.progressPercent}%`;
    el.appendChild(progressEl);
  }

  // Ensure no animation under reduced motion
  if (reducedMotion) {
    el.style.setProperty('animation', 'none');
    el.style.setProperty('transition', 'none');
  }

  return el;
}

/**
 * Applies the appropriate state CSS class to a placeholder element.
 */
function applyStateClass(el: HTMLElement, state: LoadingState): void {
  // Remove all state classes first
  el.classList.remove(
    LOADING_INDETERMINATE_CLASS,
    LOADING_RESERVED_CLASS,
    LOADING_OMITTED_CLASS,
  );

  switch (state) {
    case 'indeterminate':
      el.classList.add(LOADING_INDETERMINATE_CLASS);
      break;
    case 'reserved':
      el.classList.add(LOADING_RESERVED_CLASS);
      break;
    case 'omitted':
      el.classList.add(LOADING_OMITTED_CLASS);
      break;
  }
}

/**
 * Updates a placeholder element in-place without remounting.
 */
function updatePlaceholder(
  el: HTMLElement,
  descriptor: LoadingPlaceholderDescriptor,
  reducedMotion: boolean,
): void {
  el.dataset.loadingState = descriptor.state;
  applyStateClass(el, descriptor.state);

  // Update reserved dimensions
  if (descriptor.reservedHeightPx !== undefined && descriptor.reservedHeightPx > 0) {
    el.style.minHeight = `${descriptor.reservedHeightPx}px`;
    el.classList.add(LOADING_RESERVED_CLASS);
  } else {
    el.style.removeProperty('min-height');
  }

  if (descriptor.reservedWidthPx !== undefined && descriptor.reservedWidthPx > 0) {
    el.style.minWidth = `${descriptor.reservedWidthPx}px`;
  } else {
    el.style.removeProperty('min-width');
  }

  // Update status text
  const statusEl = el.querySelector(`.${LOADING_STATUS_CLASS}`);
  if (statusEl) {
    statusEl.textContent = descriptor.statusText;
    statusEl.setAttribute('aria-label', descriptor.statusText);
  }

  // Update progress
  const existingProgress = el.querySelector(`.${LOADING_PROGRESS_CLASS}`);
  if (descriptor.progressPercent !== undefined && descriptor.state !== 'indeterminate') {
    if (existingProgress) {
      existingProgress.setAttribute('aria-valuenow', String(descriptor.progressPercent));
      existingProgress.textContent = `${descriptor.progressPercent}%`;
    } else {
      const progressEl = document.createElement('span');
      progressEl.className = LOADING_PROGRESS_CLASS;
      progressEl.setAttribute('role', 'progressbar');
      progressEl.setAttribute('aria-valuenow', String(descriptor.progressPercent));
      progressEl.setAttribute('aria-valuemin', '0');
      progressEl.setAttribute('aria-valuemax', '100');
      progressEl.textContent = `${descriptor.progressPercent}%`;
      el.appendChild(progressEl);
    }
  } else if (existingProgress) {
    existingProgress.remove();
  }

  // Enforce reduced motion
  if (reducedMotion) {
    el.style.setProperty('animation', 'none');
    el.style.setProperty('transition', 'none');
  }
}

// ─── Controller ─────────────────────────────────────────────────

/**
 * Creates a MeaningfulLoadingController that manages block-level
 * loading placeholders without decorative skeletons.
 *
 * Key behaviors:
 * - Reserves known layout space for pending blocks
 * - Uses status text/omission, never false completed skeletons
 * - No shimmer/gradient animation for indeterminate content
 * - State meaning preserved via text and icons at all times
 */
export function createMeaningfulLoadingController(
  options: MeaningfulLoadingControllerOptions = {},
): MeaningfulLoadingControllerHandle {
  let reducedMotion = options.reducedMotion ?? false;
  const activePlaceholders = new Map<string, LoadingPlaceholderHandle>();
  let disposed = false;

  return Object.freeze({
    createPlaceholder(descriptor: LoadingPlaceholderDescriptor): LoadingPlaceholderHandle {
      if (disposed) {
        throw new Error('MeaningfulLoadingController has been disposed');
      }

      const element = renderPlaceholder(descriptor, reducedMotion);
      let currentDescriptor = descriptor;
      let placeholderDisposed = false;

      const handle: LoadingPlaceholderHandle = Object.freeze({
        get element() {
          return element;
        },
        get blockKey() {
          return currentDescriptor.blockKey;
        },
        update(newDescriptor: LoadingPlaceholderDescriptor) {
          if (placeholderDisposed) return;
          currentDescriptor = newDescriptor;
          updatePlaceholder(element, newDescriptor, reducedMotion);
        },
        dispose() {
          if (placeholderDisposed) return;
          placeholderDisposed = true;
          element.remove();
          activePlaceholders.delete(descriptor.blockKey);
        },
      });

      activePlaceholders.set(descriptor.blockKey, handle);
      return handle;
    },

    setReducedMotion(reduced: boolean) {
      reducedMotion = reduced;
      // Update all active placeholders
      for (const [, handle] of activePlaceholders) {
        const el = handle.element;
        if (reduced) {
          el.style.setProperty('animation', 'none');
          el.style.setProperty('transition', 'none');
        } else {
          el.style.removeProperty('animation');
          el.style.removeProperty('transition');
        }
      }
    },

    get isReducedMotion() {
      return reducedMotion;
    },

    getActivePlaceholders(): readonly string[] {
      return Array.from(activePlaceholders.keys());
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [, handle] of activePlaceholders) {
        handle.dispose();
      }
      activePlaceholders.clear();
    },
  });
}
