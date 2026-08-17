/**
 * Focus Retention Controller
 *
 * Manages focused-row retention: a focused node remains pinned in the windowing
 * engine even when outside the normal window. Also handles deterministic focus
 * restoration when surfaces close.
 *
 * Requirements: 35.10, 46.4, 46.14–46.15
 */

import type {
  FocusRestorationTarget,
  FocusRestorationResult,
  FocusableItem,
} from './types';

/**
 * Describes a surviving control candidate for focus fallback.
 */
export interface SurvivingControlCandidate {
  itemId: string;
  widgetId: string;
  workflowId?: string;
  focusable: boolean;
}

/**
 * Configuration for the focus retention controller.
 */
export interface FocusRetentionConfig {
  /** ID of the primary composer input (final fallback target). */
  primaryComposerId: string;
  /** Widget ID containing the primary composer. */
  primaryComposerWidgetId: string;
}

/**
 * FocusRetentionController manages:
 * 1. Pinned focused nodes in the windowing engine
 * 2. Deterministic focus restoration when modals/overlays/editors close
 * 3. Focus fallback chain: invoking control → nearest surviving → primary composer
 */
export class FocusRetentionController {
  private config: FocusRetentionConfig;
  private pinnedStableKeys: Set<string> = new Set();
  private restorationStack: FocusRestorationTarget[] = [];
  private survivingControlsProvider: (() => SurvivingControlCandidate[]) | null = null;

  constructor(config: FocusRetentionConfig) {
    this.config = config;
  }

  // ─── Pinned Focus Retention ─────────────────────────────────────

  /**
   * Pin a node by stable key — it will remain mounted even outside the window.
   */
  pinFocusedNode(stableKey: string): void {
    this.pinnedStableKeys.add(stableKey);
  }

  /**
   * Unpin a node (when focus leaves it).
   */
  unpinNode(stableKey: string): void {
    this.pinnedStableKeys.delete(stableKey);
  }

  /**
   * Get all currently pinned stable keys.
   */
  getPinnedKeys(): ReadonlySet<string> {
    return this.pinnedStableKeys;
  }

  /**
   * Check if a node is pinned for focus retention.
   */
  isPinned(stableKey: string): boolean {
    return this.pinnedStableKeys.has(stableKey);
  }

  /**
   * Transfer pin from one key to another (e.g., when navigating).
   */
  transferPin(fromKey: string, toKey: string): void {
    if (this.pinnedStableKeys.has(fromKey)) {
      this.pinnedStableKeys.delete(fromKey);
      this.pinnedStableKeys.add(toKey);
    }
  }

  /**
   * Clear all pinned nodes (e.g., during cleanup).
   */
  clearAllPins(): void {
    this.pinnedStableKeys.clear();
  }

  // ─── Focus Restoration ──────────────────────────────────────────

  /**
   * Register a provider for surviving control candidates.
   * Used during focus restoration to find the nearest surviving control.
   */
  setSurvivingControlsProvider(provider: () => SurvivingControlCandidate[]): void {
    this.survivingControlsProvider = provider;
  }

  /**
   * Push a restoration target onto the stack before opening a surface.
   */
  pushRestorationTarget(target: FocusRestorationTarget): void {
    this.restorationStack.push(target);
  }

  /**
   * Pop the most recent restoration target (when closing a surface).
   */
  popRestorationTarget(): FocusRestorationTarget | undefined {
    return this.restorationStack.pop();
  }

  /**
   * Peek at the current top restoration target.
   */
  peekRestorationTarget(): FocusRestorationTarget | undefined {
    return this.restorationStack[this.restorationStack.length - 1];
  }

  /**
   * Get the current restoration stack depth.
   */
  getStackDepth(): number {
    return this.restorationStack.length;
  }

  /**
   * Resolve where focus should go when a surface closes.
   * Follows the deterministic fallback chain:
   * 1. The invoking control (if it still exists and is focusable)
   * 2. The nearest surviving logical control in the same workflow
   * 3. The primary composer input (final fallback)
   *
   * @param availableItems - Currently focusable items to check against
   */
  resolveRestoration(availableItems: FocusableItem[]): FocusRestorationResult {
    const target = this.restorationStack.pop();
    if (!target) {
      // No target — fall back to primary composer
      return {
        restored: true,
        targetId: this.config.primaryComposerId,
        method: 'primary_composer',
      };
    }

    // 1. Try the invoking control
    const invokingItem = availableItems.find(
      i => i.itemId === target.invokingControlId && i.focusable,
    );
    if (invokingItem) {
      return {
        restored: true,
        targetId: target.invokingControlId,
        method: 'invoking_control',
      };
    }

    // 2. Try the nearest surviving logical control in the same workflow
    if (target.workflowId && this.survivingControlsProvider) {
      const candidates = this.survivingControlsProvider();
      const sameWorkflow = candidates.filter(
        c => c.workflowId === target.workflowId && c.focusable,
      );

      if (sameWorkflow.length > 0) {
        // Pick the closest one (first in list = nearest)
        return {
          restored: true,
          targetId: sameWorkflow[0]!.itemId,
          method: 'nearest_surviving',
        };
      }
    }

    // Also try looking in the same widget
    if (this.survivingControlsProvider) {
      const candidates = this.survivingControlsProvider();
      const sameWidget = candidates.filter(
        c => c.widgetId === target.invokingWidgetId && c.focusable,
      );
      if (sameWidget.length > 0) {
        return {
          restored: true,
          targetId: sameWidget[0]!.itemId,
          method: 'nearest_surviving',
        };
      }
    }

    // 3. Final fallback: primary composer
    return {
      restored: true,
      targetId: this.config.primaryComposerId,
      method: 'primary_composer',
    };
  }

  /**
   * Resolve restoration by stable key (for windowed content where items
   * might not be in the current item list).
   */
  resolveRestorationByStableKey(
    availableStableKeys: Set<string>,
  ): FocusRestorationResult {
    const target = this.restorationStack.pop();
    if (!target) {
      return {
        restored: true,
        targetId: this.config.primaryComposerId,
        method: 'primary_composer',
      };
    }

    // Check if the invoking stable key is available
    if (target.invokingStableKey && availableStableKeys.has(target.invokingStableKey)) {
      return {
        restored: true,
        targetId: target.invokingControlId,
        method: 'invoking_control',
      };
    }

    // Fall through to primary composer
    return {
      restored: true,
      targetId: this.config.primaryComposerId,
      method: 'primary_composer',
    };
  }
}
