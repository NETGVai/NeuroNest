/**
 * Lightbox Surface
 *
 * Implements focus-trapped image lightbox presentation with:
 * - Escape to close (Requirement 46.3)
 * - Focus containment within the modal (Requirement 46.3)
 * - Zoom controls and image label (Requirement 41.5)
 * - Focus restoration to invoking preview on close (Requirement 46.4)
 * - Path-free labels and accessibility text (Requirement 41.11, 46.9)
 *
 * Requirements: 41.5, 41.11, 46.3-46.4, 46.9
 */

import { z } from 'zod';
import { IdentifierSchema } from '../../contracts/primitives';
import type { LightboxSurface } from './types';

// ─── Configuration ──────────────────────────────────────────────

export const LightboxConfigSchema = z.object({
  /** Minimum zoom level. */
  minZoom: z.number().positive().default(0.25),
  /** Maximum zoom level. */
  maxZoom: z.number().positive().default(4.0),
  /** Zoom step per increment/decrement action. */
  zoomStep: z.number().positive().default(0.25),
  /** Whether Escape closes the lightbox (Requirement 46.3). */
  escapeCloseEnabled: z.boolean().default(true),
});

export type LightboxConfig = z.infer<typeof LightboxConfigSchema>;

export const DEFAULT_LIGHTBOX_CONFIG: LightboxConfig = {
  minZoom: 0.25,
  maxZoom: 4.0,
  zoomStep: 0.25,
  escapeCloseEnabled: true,
};

// ─── Lightbox Actions ───────────────────────────────────────────

/** Actions available within the lightbox. */
export type LightboxAction =
  | 'close'
  | 'zoom_in'
  | 'zoom_out'
  | 'zoom_reset'
  | 'zoom_fit';

// ─── Focus Trap State ───────────────────────────────────────────

/**
 * Focus trap state for the lightbox modal.
 *
 * Requirement 46.3: When focus enters a modal/lightbox, trap focus
 * within until close. Provide Escape close action.
 */
export const FocusTrapStateSchema = z.object({
  /** Whether focus is currently trapped. */
  active: z.boolean(),

  /** Ordered focusable control IDs within the lightbox. */
  focusableControls: z.array(IdentifierSchema),

  /** Currently focused control index (cycles within bounds). */
  focusedIndex: z.number().int().nonnegative(),

  /** The invoking control to restore focus to on close (Requirement 46.4). */
  returnFocusTarget: IdentifierSchema.optional(),
});

export type FocusTrapState = z.infer<typeof FocusTrapStateSchema>;

// ─── Lightbox Open/Close ────────────────────────────────────────

/**
 * Input for opening the lightbox.
 */
export interface LightboxOpenRequest {
  /** Attachment identity to display. */
  attachmentId: string;
  /** Authorized image reference (never private path). */
  imageReference: string;
  /** Accessible label for the image (path-free). */
  imageLabel: string;
  /** ID of the control that invoked the lightbox (for focus restoration). */
  invokingControlId: string;
}

/**
 * Derive the lightbox surface state when opening.
 *
 * Requirements 41.5, 46.3-46.4, 46.9
 */
export function openLightbox(
  request: LightboxOpenRequest,
  config: LightboxConfig = DEFAULT_LIGHTBOX_CONFIG,
): LightboxSurface {
  return {
    open: true,
    attachmentId: request.attachmentId,
    imageReference: request.imageReference,
    imageLabel: request.imageLabel,
    zoomLevel: 1.0,
    escapeClosePermitted: config.escapeCloseEnabled,
    invokingControlId: request.invokingControlId,
  };
}

/**
 * Derive the lightbox surface state when closed.
 *
 * Returns a closed state. The caller is responsible for using
 * `invokingControlId` to restore focus (Requirement 46.4).
 */
export function closeLightbox(): LightboxSurface {
  return {
    open: false,
    attachmentId: undefined,
    imageReference: undefined,
    imageLabel: undefined,
    zoomLevel: undefined,
    escapeClosePermitted: true,
    invokingControlId: undefined,
  };
}

// ─── Zoom Controls ──────────────────────────────────────────────

/**
 * Apply a zoom action to the current lightbox state.
 *
 * Requirement 41.5: Provide close and zoom controls.
 */
export function applyZoomAction(
  current: LightboxSurface,
  action: 'zoom_in' | 'zoom_out' | 'zoom_reset' | 'zoom_fit',
  config: LightboxConfig = DEFAULT_LIGHTBOX_CONFIG,
): LightboxSurface {
  if (!current.open) return current;

  const currentZoom = current.zoomLevel ?? 1.0;
  let newZoom: number;

  switch (action) {
    case 'zoom_in':
      newZoom = Math.min(currentZoom + config.zoomStep, config.maxZoom);
      break;
    case 'zoom_out':
      newZoom = Math.max(currentZoom - config.zoomStep, config.minZoom);
      break;
    case 'zoom_reset':
      newZoom = 1.0;
      break;
    case 'zoom_fit':
      newZoom = 1.0;
      break;
  }

  return { ...current, zoomLevel: newZoom };
}

// ─── Focus Trap Logic ───────────────────────────────────────────

/** Standard focusable controls in the lightbox. */
const LIGHTBOX_CONTROLS = ['close-button', 'zoom-in-button', 'zoom-out-button', 'zoom-reset-button'] as const;

/**
 * Initialize focus trap state when the lightbox opens.
 *
 * Requirement 46.3: Trap focus within the modal surface.
 */
export function initFocusTrap(invokingControlId: string): FocusTrapState {
  return {
    active: true,
    focusableControls: [...LIGHTBOX_CONTROLS],
    focusedIndex: 0, // Start on the close button
    returnFocusTarget: invokingControlId,
  };
}

/**
 * Move focus within the trap (Tab / Shift+Tab cycling).
 *
 * Requirement 46.3: Focus stays within the modal.
 */
export function moveFocusInTrap(
  state: FocusTrapState,
  direction: 'forward' | 'backward',
): FocusTrapState {
  if (!state.active || state.focusableControls.length === 0) {
    return state;
  }

  const count = state.focusableControls.length;
  let newIndex: number;

  if (direction === 'forward') {
    newIndex = (state.focusedIndex + 1) % count;
  } else {
    newIndex = (state.focusedIndex - 1 + count) % count;
  }

  return { ...state, focusedIndex: newIndex };
}

/**
 * Release focus trap and provide the restoration target.
 *
 * Requirement 46.4: Restore focus to the invoking control on close.
 * If the invoking control no longer exists, the caller should use
 * a deterministic fallback (nearest surviving logical control).
 */
export function releaseFocusTrap(state: FocusTrapState): {
  released: true;
  returnFocusTarget: string | undefined;
} {
  return {
    released: true,
    returnFocusTarget: state.returnFocusTarget,
  };
}

// ─── Accessibility Label Builder ────────────────────────────────

/**
 * Build a path-free accessibility label for the lightbox.
 *
 * Requirements 41.5, 41.11, 46.9: Label the image accessibly,
 * never exposing host paths or secret locators.
 */
export function buildLightboxAccessibilityLabel(
  imageLabel: string,
  zoomLevel: number,
): string {
  const zoomPercent = Math.round(zoomLevel * 100);
  return `Image lightbox: ${imageLabel}, zoom ${zoomPercent}%`;
}

/**
 * Get the available actions for the lightbox surface.
 *
 * Requirement 41.5: Close, zoom in, zoom out controls.
 */
export function getLightboxAvailableActions(
  surface: LightboxSurface,
  config: LightboxConfig = DEFAULT_LIGHTBOX_CONFIG,
): LightboxAction[] {
  if (!surface.open) return [];

  const actions: LightboxAction[] = ['close'];
  const zoom = surface.zoomLevel ?? 1.0;

  if (zoom < config.maxZoom) actions.push('zoom_in');
  if (zoom > config.minZoom) actions.push('zoom_out');
  if (zoom !== 1.0) actions.push('zoom_reset');

  return actions;
}

/**
 * Handle keyboard events within the lightbox.
 *
 * Requirement 46.3: Escape closes, Tab cycles within trap.
 */
export function handleLightboxKeyboard(
  key: string,
  shiftKey: boolean,
  surface: LightboxSurface,
  focusTrap: FocusTrapState,
  config: LightboxConfig = DEFAULT_LIGHTBOX_CONFIG,
): { action: 'close' | 'focus_move' | 'zoom' | 'none'; newFocusTrap?: FocusTrapState; zoomAction?: 'zoom_in' | 'zoom_out' | 'zoom_reset' } {
  if (!surface.open) return { action: 'none' };

  switch (key) {
    case 'Escape':
      if (surface.escapeClosePermitted) {
        return { action: 'close' };
      }
      return { action: 'none' };

    case 'Tab':
      return {
        action: 'focus_move',
        newFocusTrap: moveFocusInTrap(focusTrap, shiftKey ? 'backward' : 'forward'),
      };

    case '+':
    case '=':
      return { action: 'zoom', zoomAction: 'zoom_in' };

    case '-':
      return { action: 'zoom', zoomAction: 'zoom_out' };

    case '0':
      return { action: 'zoom', zoomAction: 'zoom_reset' };

    default:
      return { action: 'none' };
  }
}
