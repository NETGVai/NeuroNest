/**
 * Blast radius view overlay for codebase visualization.
 *
 * Renders blast radius results by applying opacity-based styling:
 * - Source node: full opacity
 * - Direct dependents (depth 1): full opacity
 * - Transitive dependents (depth >= 2): decreasing opacity proportional to depth
 * - Non-affected nodes: dimmed to 0.15 opacity
 *
 * Also provides summary statistics and handles the zero blast radius case.
 */

import type { BlastRadiusResult } from '../../../../analysis/types';
import type { CodebaseGraphData } from './types';
import type { CytoscapeStyleOverride } from './color-modes';

// --- Types ---

/** Summary statistics for a blast radius computation. */
export interface BlastRadiusSummary {
  /** Total number of affected files (direct + transitive) */
  totalAffected: number;
  /** Number of direct dependents (depth 1) */
  directCount: number;
  /** Number of transitive dependents (depth >= 2) */
  transitiveCount: number;
  /** The source file from which blast radius was computed */
  sourceFile: string;
}

/** Combined result of applying blast radius overlay. */
export interface BlastRadiusOverlayResult {
  /** Cytoscape style overrides to apply to the graph */
  overrides: CytoscapeStyleOverride[];
  /** Summary statistics for display */
  summary: BlastRadiusSummary;
}

// --- Constants ---

/** Opacity for the source node itself. */
const SOURCE_OPACITY = 1.0;

/** Opacity for direct dependents (depth 1). */
const DIRECT_DEPENDENT_OPACITY = 1.0;

/** Minimum opacity for the deepest transitive dependents. */
const MIN_TRANSITIVE_OPACITY = 0.3;

/** Opacity for nodes not in the blast radius. */
const NON_AFFECTED_OPACITY = 0.15;

/** Maximum depth used for opacity calculation. */
const MAX_DEPTH_FOR_OPACITY = 20;

// --- BlastRadiusView class ---

/**
 * Manages the blast radius view overlay for the codebase dependency graph.
 *
 * Applies visual styles to nodes based on their relationship to a selected
 * source file: direct dependents at full opacity, transitive dependents at
 * decreasing opacity, and unaffected nodes dimmed.
 */
export class BlastRadiusView {
  /**
   * Apply blast radius results to the graph data, producing style overrides
   * and a summary.
   *
   * @param result - The blast radius computation result from the analysis engine.
   * @param graphData - The full Cytoscape graph data to apply overrides to.
   * @returns Style overrides and summary statistics.
   */
  applyBlastRadius(
    result: BlastRadiusResult,
    graphData: CodebaseGraphData
  ): BlastRadiusOverlayResult {
    const overrides: CytoscapeStyleOverride[] = [];

    // Build a set of all affected node IDs for quick lookup
    const affectedNodeIds = new Set<string>();
    affectedNodeIds.add(result.sourceFile);

    for (const node of result.directDependents) {
      affectedNodeIds.add(node.fileId);
    }
    for (const node of result.transitiveDependents) {
      affectedNodeIds.add(node.fileId);
    }

    // Apply style to the source node
    overrides.push({
      selector: `node[id="${result.sourceFile}"]`,
      style: { opacity: SOURCE_OPACITY, 'border-width': 3, 'border-color': '#f59e0b' },
    });

    // Apply full opacity to direct dependents (depth 1)
    for (const node of result.directDependents) {
      overrides.push({
        selector: `node[id="${node.fileId}"]`,
        style: { opacity: DIRECT_DEPENDENT_OPACITY },
      });
    }

    // Apply decreasing opacity to transitive dependents (depth >= 2)
    for (const node of result.transitiveDependents) {
      const opacity = node.opacity ?? this.computeTransitiveOpacity(node.depth);
      overrides.push({
        selector: `node[id="${node.fileId}"]`,
        style: { opacity },
      });
    }

    // Dim all non-affected nodes
    for (const graphNode of graphData.nodes) {
      if (!affectedNodeIds.has(graphNode.data.id)) {
        overrides.push({
          selector: `node[id="${graphNode.data.id}"]`,
          style: { opacity: NON_AFFECTED_OPACITY },
        });
      }
    }

    // Build summary
    const summary: BlastRadiusSummary = {
      totalAffected: result.totalAffected,
      directCount: result.directDependents.length,
      transitiveCount: result.transitiveDependents.length,
      sourceFile: result.sourceFile,
    };

    return { overrides, summary };
  }

  /**
   * Returns a message to display when the selected file has zero blast radius
   * (no dependents found).
   *
   * @returns A user-facing message string.
   */
  getZeroBlastRadiusMessage(): string {
    return 'This file has zero blast radius — no other files depend on it directly or transitively.';
  }

  /**
   * Compute opacity for a transitive dependent based on its BFS depth.
   * Depth 2 gets slightly less than full opacity, with linear decay
   * down to MIN_TRANSITIVE_OPACITY at MAX_DEPTH_FOR_OPACITY.
   *
   * @param depth - The BFS depth of the node (must be >= 2 for transitive).
   * @returns Opacity value between MIN_TRANSITIVE_OPACITY and just below 1.0.
   */
  private computeTransitiveOpacity(depth: number): number {
    if (depth <= 1) return DIRECT_DEPENDENT_OPACITY;
    const clampedDepth = Math.min(depth, MAX_DEPTH_FOR_OPACITY);
    // Linear decay from 1.0 at depth 1 to MIN_TRANSITIVE_OPACITY at MAX_DEPTH_FOR_OPACITY
    const decayRange = 1.0 - MIN_TRANSITIVE_OPACITY; // 0.7
    return Math.max(
      MIN_TRANSITIVE_OPACITY,
      1.0 - ((clampedDepth - 1) * decayRange) / (MAX_DEPTH_FOR_OPACITY - 1)
    );
  }
}
