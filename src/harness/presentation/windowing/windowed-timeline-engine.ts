/**
 * Windowed Timeline Engine
 *
 * Mounts at most Settings_Service-selected node bound plus documented overscan
 * and focus-retention allowance. Uses projected order rather than DOM siblings.
 * A focused node is pinned until focus moves.
 *
 * Requirements: 35.10, 47.2–47.5, 47.17
 */

import type {
  WindowingBounds,
  ProjectedNodeDescriptor,
  WindowedRange,
} from './types';

/**
 * Computes the bounded window of nodes to mount in the DOM based on
 * projected order, configured bounds, and focus retention.
 */
export class WindowedTimelineEngine {
  private bounds: WindowingBounds;
  private nodes: ProjectedNodeDescriptor[] = [];
  private viewportCenter: number = 0;

  constructor(bounds: WindowingBounds) {
    this.bounds = bounds;
  }

  /**
   * Update the windowing bounds (e.g., from a Settings_Service revision).
   */
  setBounds(bounds: WindowingBounds): void {
    this.bounds = bounds;
  }

  /**
   * Return the current bounds configuration.
   */
  getBounds(): WindowingBounds {
    return this.bounds;
  }

  /**
   * Replace the full projected node list. The engine operates on projected
   * order, not DOM siblings or source order.
   */
  setProjectedNodes(nodes: ProjectedNodeDescriptor[]): void {
    this.nodes = nodes;
  }

  /**
   * Return the projected node list.
   */
  getProjectedNodes(): readonly ProjectedNodeDescriptor[] {
    return this.nodes;
  }

  /**
   * Set the current viewport center index (the approximate center of what
   * the user sees). This drives the windowed range computation.
   */
  setViewportCenter(index: number): void {
    this.viewportCenter = Math.max(0, Math.min(index, this.nodes.length - 1));
  }

  /**
   * Compute the windowed range of nodes to mount. The total mounted count
   * is at most `mountedNodeBound + focusRetentionAllowance`, including
   * overscan nodes on each side plus any pinned focused nodes.
   *
   * Focused nodes are pinned even if outside the normal window, consuming
   * from the focus-retention allowance.
   */
  computeWindowedRange(): WindowedRange {
    const totalCount = this.nodes.length;
    if (totalCount === 0) {
      return { startIndex: 0, endIndex: 0, totalCount: 0, pinnedIndices: [] };
    }

    const { mountedNodeBound, overscan, focusRetentionAllowance } = this.bounds;

    // The base window: mountedNodeBound nodes centered around viewportCenter,
    // plus overscan on each side — capped at mountedNodeBound total for the
    // primary window.
    const halfWindow = Math.floor(mountedNodeBound / 2);
    let rawStart = this.viewportCenter - halfWindow;
    let rawEnd = rawStart + mountedNodeBound;

    // Clamp to bounds
    if (rawStart < 0) {
      rawStart = 0;
      rawEnd = Math.min(mountedNodeBound, totalCount);
    }
    if (rawEnd > totalCount) {
      rawEnd = totalCount;
      rawStart = Math.max(0, rawEnd - mountedNodeBound);
    }

    // Apply overscan
    const startIndex = Math.max(0, rawStart - overscan);
    const endIndex = Math.min(totalCount, rawEnd + overscan);

    // Find focused nodes that are outside the computed window
    const pinnedIndices: number[] = [];
    let pinnedCount = 0;
    for (let i = 0; i < totalCount; i++) {
      if (this.nodes[i]!.focused && (i < startIndex || i >= endIndex)) {
        if (pinnedCount < focusRetentionAllowance) {
          pinnedIndices.push(i);
          pinnedCount++;
        }
      }
    }

    return { startIndex, endIndex, totalCount, pinnedIndices };
  }

  /**
   * Return whether a node at the given index is within the mounted range
   * (either the primary window or pinned).
   */
  isMounted(index: number): boolean {
    const range = this.computeWindowedRange();
    if (index >= range.startIndex && index < range.endIndex) {
      return true;
    }
    return range.pinnedIndices.includes(index);
  }

  /**
   * Return the total number of mounted nodes (window + pinned).
   * This should never exceed mountedNodeBound + focusRetentionAllowance.
   */
  getMountedCount(): number {
    const range = this.computeWindowedRange();
    return (range.endIndex - range.startIndex) + range.pinnedIndices.length;
  }

  /**
   * Verify the invariant: mounted count does not exceed the configured maximum.
   */
  verifyBoundInvariant(): boolean {
    const { mountedNodeBound, overscan, focusRetentionAllowance } = this.bounds;
    const maxAllowed = mountedNodeBound + (overscan * 2) + focusRetentionAllowance;
    return this.getMountedCount() <= maxAllowed;
  }

  /**
   * Find a node by stable key in projected order.
   * Returns the index or -1 if not found.
   */
  findByStableKey(stableKey: string): number {
    return this.nodes.findIndex(n => n.stableKey === stableKey);
  }

  /**
   * Get the node descriptor at a projected index.
   */
  getNodeAt(index: number): ProjectedNodeDescriptor | undefined {
    return this.nodes[index];
  }
}
