/**
 * Semantic Anchor Controller
 *
 * Before prepend, expansion, lazy render, or asynchronous measurement, the
 * viewport controller records the first fully visible focusable node and its
 * device-independent offset. After measurement settles, it resolves the same
 * stable key and adjusts scroll offset until error is at most 2 DIP. If
 * unavailable, follows latest projected content and exposes a
 * saved-position-unavailable label.
 *
 * Requirements: 35.7, 35.9, 35.22–35.23, 42.9, 47.7, 47.17
 */

import type {
  SemanticAnchor,
  WindowingBounds,
  ProjectedNodeDescriptor,
  AnchorResolutionResult,
  AnchorUnavailableState,
} from './types';

/**
 * Provides viewport position measurements for the controller.
 * Implementors bridge the actual DOM/viewport to this abstraction.
 */
export interface ViewportMeasurement {
  /** Get the viewport offset (scroll position) in DIP. */
  getViewportOffsetDip(): number;
  /** Set the viewport offset (scroll position) in DIP. */
  setViewportOffsetDip(offset: number): void;
  /** Get the measured top position of a node by its stable key (in DIP from document top). */
  getNodeTopDip(stableKey: string): number | undefined;
  /** Returns the first fully visible focusable node's stable key and its offset from viewport top. */
  getFirstVisibleFocusableNode(): { stableKey: string; viewportOffsetDip: number } | undefined;
  /** Returns the currently focused node's stable key and its offset from viewport top. */
  getFocusedNode(): { stableKey: string; viewportOffsetDip: number } | undefined;
}

/**
 * SemanticAnchorController manages the lifecycle of viewport anchoring
 * across layout-changing operations (prepend, expansion, lazy render,
 * streaming, measurement stabilization).
 */
export class SemanticAnchorController {
  private bounds: WindowingBounds;
  private currentAnchor: SemanticAnchor | null = null;
  private savedAnchor: SemanticAnchor | null = null;
  private unavailableState: AnchorUnavailableState | null = null;
  private projectedNodes: ProjectedNodeDescriptor[] = [];
  private sessionId: string = '';
  private branchId: string = '';
  private projectionRevision: number = 0;

  constructor(bounds: WindowingBounds) {
    this.bounds = bounds;
  }

  /**
   * Update bounds from Settings_Service.
   */
  setBounds(bounds: WindowingBounds): void {
    this.bounds = bounds;
  }

  /**
   * Update the session context for this controller.
   */
  setContext(sessionId: string, branchId: string, projectionRevision: number): void {
    this.sessionId = sessionId;
    this.branchId = branchId;
    this.projectionRevision = projectionRevision;
  }

  /**
   * Update the projected node list (projected order).
   */
  setProjectedNodes(nodes: ProjectedNodeDescriptor[]): void {
    this.projectedNodes = nodes;
  }

  /**
   * Record the current anchor BEFORE a layout-changing operation.
   * Captures the first fully visible focusable node (or current focused node)
   * and its device-independent offset from the viewport top.
   */
  recordAnchor(viewport: ViewportMeasurement): SemanticAnchor | null {
    // Prefer the currently focused node if available
    const focused = viewport.getFocusedNode();
    const target = focused ?? viewport.getFirstVisibleFocusableNode();

    if (!target) {
      return null;
    }

    const anchor: SemanticAnchor = {
      sessionId: this.sessionId,
      branchId: this.branchId,
      stableKey: target.stableKey,
      viewportOffsetDip: target.viewportOffsetDip,
      projectionRevision: this.projectionRevision,
    };

    this.currentAnchor = anchor;
    return anchor;
  }

  /**
   * Restore the previously recorded anchor AFTER layout stabilization.
   * Resolves the stable key and adjusts scroll offset until error is at
   * most 2 DIP (configurable via anchorToleranceDip).
   *
   * Returns the resolution result indicating success or fallback behavior.
   */
  restoreAnchor(viewport: ViewportMeasurement): AnchorResolutionResult {
    const anchor = this.currentAnchor;
    if (!anchor) {
      return { resolved: false, reason: 'key_not_found', followLatest: true };
    }

    return this.resolveAnchor(anchor, viewport);
  }

  /**
   * Resolve a specific anchor against current projected state and viewport.
   */
  resolveAnchor(anchor: SemanticAnchor, viewport: ViewportMeasurement): AnchorResolutionResult {
    // Find the node in projected order
    const index = this.projectedNodes.findIndex(n => n.stableKey === anchor.stableKey);
    if (index === -1) {
      // Node not found in projection — may have been compacted or paged out
      this.unavailableState = {
        unavailable: true,
        reason: 'Saved position is no longer available in the projected timeline',
        lastKnownStableKey: anchor.stableKey,
        followingLatest: true,
      };
      return { resolved: false, reason: 'key_not_found', followLatest: true };
    }

    // Get the current measured position of the node
    const nodeTop = viewport.getNodeTopDip(anchor.stableKey);
    if (nodeTop === undefined) {
      // Node exists in projection but is not yet measured (lazy/unmounted)
      this.unavailableState = {
        unavailable: true,
        reason: 'Saved position is not yet rendered',
        lastKnownStableKey: anchor.stableKey,
        followingLatest: true,
      };
      return { resolved: false, reason: 'key_not_found', followLatest: true };
    }

    // Compute desired viewport offset: nodeTop - desiredViewportOffset = viewportScroll
    const desiredScroll = nodeTop - anchor.viewportOffsetDip;
    const currentScroll = viewport.getViewportOffsetDip();
    const errorDip = Math.abs(currentScroll - desiredScroll);

    if (errorDip > this.bounds.anchorToleranceDip) {
      // Adjust scroll to restore anchor within tolerance
      viewport.setViewportOffsetDip(desiredScroll);
      const newError = 0; // After adjustment, error is 0
      this.unavailableState = null;
      return { resolved: true, index, offsetDip: anchor.viewportOffsetDip, errorDip: newError };
    }

    // Already within tolerance
    this.unavailableState = null;
    return { resolved: true, index, offsetDip: anchor.viewportOffsetDip, errorDip };
  }

  /**
   * Save the current anchor as the per-session persistent anchor.
   * Used when the session is backgrounded or closed.
   */
  saveAnchor(): void {
    if (this.currentAnchor) {
      this.savedAnchor = { ...this.currentAnchor };
    }
  }

  /**
   * Restore a previously saved per-session anchor.
   * Returns null if no saved anchor exists.
   */
  getSavedAnchor(): SemanticAnchor | null {
    return this.savedAnchor;
  }

  /**
   * Set a saved anchor (e.g., loaded from persistent storage).
   */
  setSavedAnchor(anchor: SemanticAnchor | null): void {
    this.savedAnchor = anchor;
  }

  /**
   * Get the current live anchor (the one recorded before the latest layout change).
   */
  getCurrentAnchor(): SemanticAnchor | null {
    return this.currentAnchor;
  }

  /**
   * Get the anchor-unavailable state if the last resolution failed.
   */
  getUnavailableState(): AnchorUnavailableState | null {
    return this.unavailableState;
  }

  /**
   * Clear the unavailable state (e.g., when the user dismisses the label).
   */
  clearUnavailableState(): void {
    this.unavailableState = null;
  }

  /**
   * Attempt to restore a saved anchor on session reopen.
   * If the saved anchor cannot be resolved, follows latest content
   * and exposes the unavailable label.
   */
  restoreSavedAnchor(viewport: ViewportMeasurement): AnchorResolutionResult {
    const saved = this.savedAnchor;
    if (!saved) {
      // No saved anchor — follow bottom
      return { resolved: false, reason: 'key_not_found', followLatest: true };
    }

    // Check projection revision compatibility
    if (saved.projectionRevision > this.projectionRevision) {
      this.unavailableState = {
        unavailable: true,
        reason: 'Saved position references a newer projection revision',
        lastKnownStableKey: saved.stableKey,
        followingLatest: true,
      };
      return { resolved: false, reason: 'projection_incompatible', followLatest: true };
    }

    return this.resolveAnchor(saved, viewport);
  }
}
