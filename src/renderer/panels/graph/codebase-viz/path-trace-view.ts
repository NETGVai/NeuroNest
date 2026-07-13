/**
 * Path trace view overlay for codebase visualization.
 *
 * Provides visual highlighting for shortest-path results between two nodes
 * in the dependency graph. Highlights the path edges as bold colored lines,
 * intermediate nodes at full opacity, and dims everything else to ≤0.2 opacity.
 *
 * Also displays path summary information (hop count, intermediate node list)
 * and handles the not-found case with a disconnection message.
 */

import type { PathResult } from '../../../../analysis/types';
import type { CytoscapeStyleOverride } from './color-modes';
import type { CodebaseGraphData } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Summary of a traced path, including hop count and intermediate nodes.
 */
export interface PathTraceSummary {
  /** Number of hops (edges) in the path */
  hops: number;
  /** Ordered list of intermediate node IDs (excluding source and target) */
  intermediateNodes: string[];
  /** Display name or ID of the source file */
  sourceFile: string;
  /** Display name or ID of the target file */
  targetFile: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Color used for highlighted path edges and nodes. */
const PATH_HIGHLIGHT_COLOR = '#f59e0b';

/** Opacity for dimmed (non-path) elements. */
const DIMMED_OPACITY = 0.2;

/** Width for highlighted path edges. */
const PATH_EDGE_WIDTH = 4;

// ─── PathTraceView Class ─────────────────────────────────────────────────────

/**
 * Manages the visual overlay for path tracing results.
 *
 * Given a PathResult from the analysis layer, produces Cytoscape style overrides
 * that highlight the traced path and dim all other elements.
 */
export class PathTraceView {
  /**
   * Apply visual highlighting for a computed path result.
   *
   * When a path is found:
   * - Path edges are rendered bold and colored
   * - Source and target nodes are at full opacity
   * - Intermediate nodes are at full opacity
   * - All other nodes and edges are dimmed to ≤0.2 opacity
   *
   * When a path is not found (result.found === false), returns empty overrides
   * and a summary with zero hops. Use `getNotFoundMessage()` for UI messaging.
   *
   * @param result - The PathResult from the path tracer analysis
   * @param graphData - The full graph data for context
   * @returns Style overrides and a path summary
   */
  applyPathHighlight(
    result: PathResult,
    graphData: CodebaseGraphData
  ): { overrides: CytoscapeStyleOverride[]; summary: PathTraceSummary } {
    if (!result.found || result.path.length === 0) {
      return {
        overrides: [],
        summary: {
          hops: 0,
          intermediateNodes: [],
          sourceFile: '',
          targetFile: '',
        },
      };
    }

    const overrides: CytoscapeStyleOverride[] = [];
    const pathNodeIds = new Set(result.path.map((node) => node.fileId));

    // Build the set of edge IDs that are part of the path
    const pathEdgeIds = this.computePathEdgeIds(result, graphData);

    // --- Dim all nodes and edges first ---
    overrides.push({
      selector: 'node',
      style: { opacity: DIMMED_OPACITY },
    });

    overrides.push({
      selector: 'edge',
      style: {
        opacity: DIMMED_OPACITY,
        'line-color': '#999999',
        width: 1,
      },
    });

    // --- Highlight path nodes at full opacity ---
    for (const nodeId of pathNodeIds) {
      overrides.push({
        selector: `node[id="${nodeId}"]`,
        style: {
          opacity: 1.0,
          'border-color': PATH_HIGHLIGHT_COLOR,
          'border-width': 2,
        },
      });
    }

    // --- Highlight path edges as bold and colored ---
    for (const edgeId of pathEdgeIds) {
      overrides.push({
        selector: `edge[id="${edgeId}"]`,
        style: {
          opacity: 1.0,
          'line-color': PATH_HIGHLIGHT_COLOR,
          'target-arrow-color': PATH_HIGHLIGHT_COLOR,
          width: PATH_EDGE_WIDTH,
        },
      });
    }

    // --- Build summary ---
    const intermediateNodes = result.path
      .filter((node) => node.isIntermediate)
      .map((node) => node.fileId);

    const sourceFile = result.path.length > 0 ? result.path[0].fileId : '';
    const targetFile =
      result.path.length > 1
        ? result.path[result.path.length - 1].fileId
        : sourceFile;

    const summary: PathTraceSummary = {
      hops: result.hops,
      intermediateNodes,
      sourceFile,
      targetFile,
    };

    return { overrides, summary };
  }

  /**
   * Get a user-facing message when no path exists between two nodes.
   *
   * @param sourceId - The ID of the source node
   * @param targetId - The ID of the target node
   * @returns A descriptive disconnection message
   */
  getNotFoundMessage(sourceId: string, targetId: string): string {
    return `No path found: "${sourceId}" and "${targetId}" are not connected in the dependency graph.`;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Compute the set of edge IDs that form the traced path.
   *
   * Walks consecutive pairs of nodes in the path and finds matching edges
   * in the graph data. Since the graph may be treated as undirected for
   * path tracing, we check both directions (source→target and target→source).
   */
  private computePathEdgeIds(
    result: PathResult,
    graphData: CodebaseGraphData
  ): Set<string> {
    const pathEdgeIds = new Set<string>();

    for (let i = 0; i < result.path.length - 1; i++) {
      const currentId = result.path[i].fileId;
      const nextId = result.path[i + 1].fileId;

      // Find the edge connecting consecutive path nodes (either direction)
      for (const edge of graphData.edges) {
        const matchesForward =
          edge.data.source === currentId && edge.data.target === nextId;
        const matchesReverse =
          edge.data.source === nextId && edge.data.target === currentId;

        if (matchesForward || matchesReverse) {
          pathEdgeIds.add(edge.data.id);
          break;
        }
      }
    }

    return pathEdgeIds;
  }
}
