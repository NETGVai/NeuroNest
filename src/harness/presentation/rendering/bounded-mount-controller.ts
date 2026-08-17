/**
 * Bounded Mount Controller
 *
 * Enforces that at most Settings_Service-selected node bound + overscan +
 * focus-retention allowance nodes are mounted at any time. All bounds are
 * consumed from Settings_Service with source revisions — never hard-coded.
 *
 * Requirements: 35.10, 47.1–47.5, 47.14–47.21
 */

import type {
  RenderingBounds,
  ResolvedRenderingBounds,
  BoundedMountResult,
} from './types';
import { RenderingBoundsSchema } from './types';
import type { ProjectedNodeDescriptor } from '../windowing/types';

/**
 * BoundedMountController computes which projected nodes should be mounted
 * based on Settings_Service bounds with source revision provenance.
 *
 * The maximum mounted count is:
 *   mountedNodeBound + overscanAllowance * 2 + focusRetentionAllowance
 *
 * Focused nodes outside the primary window are pinned within the focus-retention
 * allowance. All bounds come from Settings_Service and are never hard-coded.
 */
export class BoundedMountController {
  private resolvedBounds: ResolvedRenderingBounds;
  private nodes: ProjectedNodeDescriptor[] = [];
  private viewportCenterIndex: number = 0;

  constructor(resolvedBounds: ResolvedRenderingBounds) {
    const parseResult = RenderingBoundsSchema.safeParse(resolvedBounds.bounds);
    if (!parseResult.success) {
      throw new Error(
        `BoundedMountController: invalid bounds from Settings_Service revision ${resolvedBounds.sourceRevision}: ` +
        parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      );
    }
    this.resolvedBounds = resolvedBounds;
  }

  /**
   * Update bounds from a new Settings_Service revision.
   * Consumes the exact authority-selected value and source revision (Req 47.21).
   */
  updateBounds(resolvedBounds: ResolvedRenderingBounds): void {
    const parseResult = RenderingBoundsSchema.safeParse(resolvedBounds.bounds);
    if (!parseResult.success) {
      throw new Error(
        `BoundedMountController: invalid bounds from Settings_Service revision ${resolvedBounds.sourceRevision}: ` +
        parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      );
    }
    this.resolvedBounds = resolvedBounds;
  }

  /**
   * Return the current resolved bounds with provenance.
   */
  getResolvedBounds(): ResolvedRenderingBounds {
    return this.resolvedBounds;
  }

  /**
   * Return the active bounds configuration.
   */
  getBounds(): RenderingBounds {
    return this.resolvedBounds.bounds;
  }

  /**
   * Set the projected node list. Operates on projected order (not DOM siblings).
   */
  setProjectedNodes(nodes: ProjectedNodeDescriptor[]): void {
    this.nodes = nodes;
  }

  /**
   * Set the viewport center index for window computation.
   */
  setViewportCenter(index: number): void {
    this.viewportCenterIndex = Math.max(0, Math.min(index, this.nodes.length - 1));
  }

  /**
   * Compute the bounded mount result. Returns exactly which indices should be
   * mounted, respecting the configured bounds from Settings_Service.
   *
   * The algorithm:
   * 1. Compute primary window of `mountedNodeBound` nodes centered at viewport
   * 2. Add `overscanAllowance` on each side
   * 3. Pin focused nodes outside window up to `focusRetentionAllowance`
   * 4. Total never exceeds maxAllowedMounts()
   */
  computeMountedIndices(): BoundedMountResult {
    const totalProjectedCount = this.nodes.length;
    if (totalProjectedCount === 0) {
      return {
        mountedIndices: [],
        totalProjectedCount: 0,
        atBound: false,
        boundsSourceRevision: this.resolvedBounds.sourceRevision,
      };
    }

    const { mountedNodeBound, overscanAllowance, focusRetentionAllowance } = this.resolvedBounds.bounds;

    // Primary window centered around viewport center
    const halfWindow = Math.floor(mountedNodeBound / 2);
    let rawStart = this.viewportCenterIndex - halfWindow;
    let rawEnd = rawStart + mountedNodeBound;

    // Clamp to total range
    if (rawStart < 0) {
      rawStart = 0;
      rawEnd = Math.min(mountedNodeBound, totalProjectedCount);
    }
    if (rawEnd > totalProjectedCount) {
      rawEnd = totalProjectedCount;
      rawStart = Math.max(0, rawEnd - mountedNodeBound);
    }

    // Apply overscan
    const windowStart = Math.max(0, rawStart - overscanAllowance);
    const windowEnd = Math.min(totalProjectedCount, rawEnd + overscanAllowance);

    // Collect primary window indices
    const mountedSet = new Set<number>();
    for (let i = windowStart; i < windowEnd; i++) {
      mountedSet.add(i);
    }

    // Pin focused nodes outside window (up to focusRetentionAllowance)
    let pinnedCount = 0;
    for (let i = 0; i < totalProjectedCount && pinnedCount < focusRetentionAllowance; i++) {
      if (this.nodes[i]!.focused && !mountedSet.has(i)) {
        mountedSet.add(i);
        pinnedCount++;
      }
    }

    // Enforce hard maximum
    const maxAllowed = this.maxAllowedMounts();
    const mountedIndices = Array.from(mountedSet).sort((a, b) => a - b);
    const boundedIndices = mountedIndices.slice(0, maxAllowed);

    // atBound is true when the timeline exceeds the mount budget and we're
    // not mounting everything (i.e., bounded/virtualized rendering is active)
    const atBound = totalProjectedCount > boundedIndices.length;

    return {
      mountedIndices: boundedIndices,
      totalProjectedCount,
      atBound,
      boundsSourceRevision: this.resolvedBounds.sourceRevision,
    };
  }

  /**
   * Return the maximum number of nodes that may be mounted simultaneously.
   * This is the configured bound, never a hard-coded value.
   */
  maxAllowedMounts(): number {
    const { mountedNodeBound, overscanAllowance, focusRetentionAllowance } = this.resolvedBounds.bounds;
    return mountedNodeBound + (overscanAllowance * 2) + focusRetentionAllowance;
  }

  /**
   * Verify the mount bound invariant: the computed mount count never exceeds
   * the configured maximum from Settings_Service.
   */
  verifyMountInvariant(): boolean {
    const result = this.computeMountedIndices();
    return result.mountedIndices.length <= this.maxAllowedMounts();
  }

  /**
   * Check whether the timeline exceeds the mounted-node budget, triggering
   * bounded/virtualized rendering (Req 35.10).
   */
  exceedsMountBudget(): boolean {
    return this.nodes.length > this.resolvedBounds.bounds.mountedNodeBound;
  }
}
