/**
 * Modal Focus Trap
 *
 * Implements focus containment within modal dialogs and lightboxes.
 * When focus enters a modal surface, it is trapped within until close.
 * Escape closes when policy permits. Close restores focus to the invoking
 * control or a deterministic surviving control.
 *
 * Requirements: 46.3–46.4, 46.14, 41.5
 */

import type {
  ModalTrapConfig,
  FocusRestorationTarget,
  FocusableItem,
} from './types';

/**
 * State of an active focus trap.
 */
export interface ActiveTrapState {
  config: ModalTrapConfig;
  /** Focusable items within the trapped modal. */
  items: FocusableItem[];
  /** Currently focused item within the trap. */
  focusedItemId: string | null;
  /** First focusable item (for wrapping). */
  firstFocusableId: string | null;
  /** Last focusable item (for wrapping). */
  lastFocusableId: string | null;
}

/**
 * Result of attempting to close a modal.
 */
export type ModalCloseResult =
  | { closed: true; modalId: string; restoreTarget: FocusRestorationTarget }
  | { closed: false; reason: 'escape_not_permitted' | 'no_active_trap' };

/**
 * ModalFocusTrap manages focus containment within modal surfaces.
 * Supports nested modals via a stack of traps.
 *
 * Focus behavior:
 * - Tab at end wraps to first focusable item
 * - Shift+Tab at beginning wraps to last focusable item
 * - Focus cannot escape the modal via keyboard
 * - Escape closes only when policy permits
 * - Close restores focus per the restoration target
 */
export class ModalFocusTrap {
  private trapStack: ActiveTrapState[] = [];

  /**
   * Activate a new focus trap for a modal surface.
   * Pushes onto the trap stack (supports nested modals).
   */
  activate(config: ModalTrapConfig, items: FocusableItem[]): void {
    const focusableItems = items.filter(i => i.focusable);
    const state: ActiveTrapState = {
      config,
      items: focusableItems,
      focusedItemId: focusableItems[0]?.itemId ?? null,
      firstFocusableId: focusableItems[0]?.itemId ?? null,
      lastFocusableId: focusableItems[focusableItems.length - 1]?.itemId ?? null,
    };
    this.trapStack.push(state);
  }

  /**
   * Update the items within the active trap (e.g., content changes).
   */
  updateItems(modalId: string, items: FocusableItem[]): void {
    const trap = this.trapStack.find(t => t.config.modalId === modalId);
    if (!trap) return;

    const focusableItems = items.filter(i => i.focusable);
    trap.items = focusableItems;
    trap.firstFocusableId = focusableItems[0]?.itemId ?? null;
    trap.lastFocusableId = focusableItems[focusableItems.length - 1]?.itemId ?? null;

    // Keep focused item if still present, otherwise move to first
    if (trap.focusedItemId && !focusableItems.find(i => i.itemId === trap.focusedItemId)) {
      trap.focusedItemId = trap.firstFocusableId;
    }
  }

  /**
   * Handle Tab key within the active trap (wraps around boundaries).
   * Returns the item ID that should receive focus.
   */
  handleTab(shift: boolean): string | null {
    const trap = this.getActiveTrap();
    if (!trap || trap.items.length === 0) return null;

    const currentIdx = trap.focusedItemId
      ? trap.items.findIndex(i => i.itemId === trap.focusedItemId)
      : -1;

    if (shift) {
      // Shift+Tab: go backward, wrap to last at boundary
      if (currentIdx <= 0) {
        trap.focusedItemId = trap.lastFocusableId;
      } else {
        trap.focusedItemId = trap.items[currentIdx - 1]!.itemId;
      }
    } else {
      // Tab: go forward, wrap to first at boundary
      if (currentIdx >= trap.items.length - 1) {
        trap.focusedItemId = trap.firstFocusableId;
      } else {
        trap.focusedItemId = trap.items[currentIdx + 1]!.itemId;
      }
    }

    return trap.focusedItemId;
  }

  /**
   * Handle Escape key. Returns close result.
   * Only closes if the active trap's policy permits Escape.
   */
  handleEscape(): ModalCloseResult {
    const trap = this.getActiveTrap();
    if (!trap) {
      return { closed: false, reason: 'no_active_trap' };
    }

    if (!trap.config.escapeCloses) {
      return { closed: false, reason: 'escape_not_permitted' };
    }

    // Close the modal
    this.trapStack.pop();
    return {
      closed: true,
      modalId: trap.config.modalId,
      restoreTarget: trap.config.restoreTarget,
    };
  }

  /**
   * Programmatically close a modal by ID (e.g., close button).
   */
  close(modalId: string): ModalCloseResult {
    const trapIdx = this.trapStack.findIndex(t => t.config.modalId === modalId);
    if (trapIdx === -1) {
      return { closed: false, reason: 'no_active_trap' };
    }

    const trap = this.trapStack[trapIdx]!;
    // Remove it and everything above it (nested modals)
    this.trapStack.splice(trapIdx);

    return {
      closed: true,
      modalId: trap.config.modalId,
      restoreTarget: trap.config.restoreTarget,
    };
  }

  /**
   * Set focus to a specific item within the active trap.
   */
  setFocusInTrap(itemId: string): boolean {
    const trap = this.getActiveTrap();
    if (!trap) return false;

    const item = trap.items.find(i => i.itemId === itemId);
    if (!item) return false;

    trap.focusedItemId = itemId;
    return true;
  }

  /**
   * Get the currently focused item within the active trap.
   */
  getFocusedItemInTrap(): string | null {
    return this.getActiveTrap()?.focusedItemId ?? null;
  }

  /**
   * Check whether a focus trap is currently active.
   */
  isTrapped(): boolean {
    return this.trapStack.length > 0;
  }

  /**
   * Get the active (topmost) trap.
   */
  getActiveTrap(): ActiveTrapState | undefined {
    return this.trapStack[this.trapStack.length - 1];
  }

  /**
   * Get the number of active traps (nested modal depth).
   */
  getDepth(): number {
    return this.trapStack.length;
  }

  /**
   * Get the configuration of the active trap.
   */
  getActiveConfig(): ModalTrapConfig | undefined {
    return this.getActiveTrap()?.config;
  }

  /**
   * Check if a specific modal is in the trap stack.
   */
  hasModal(modalId: string): boolean {
    return this.trapStack.some(t => t.config.modalId === modalId);
  }

  /**
   * Clear all traps (e.g., during teardown).
   */
  clearAll(): void {
    this.trapStack = [];
  }
}
