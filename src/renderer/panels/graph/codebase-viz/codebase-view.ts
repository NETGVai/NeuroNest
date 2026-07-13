/**
 * Codebase View — Cytoscape.js adapter for dependency graph visualization.
 *
 * Converts analysis-side DependencyGraph data into Cytoscape.js elements,
 * handles node selection with neighbor highlighting, applies color mode
 * strategies, renders tooltips, and manages edge styling by confidence level.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.9, 10.2, 10.4
 */

import type {
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  EdgeConfidence,
  RelationshipType,
} from '../../../../analysis/types';
import { SUPPORTED_EXTENSIONS } from '../../../../analysis/types';
import type {
  CodebaseGraphData,
  CytoscapeNode,
  CytoscapeEdge,
  ColorMode,
} from './types';
import { getColorModeStrategy, type CytoscapeStyleOverride } from './color-modes';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Opacity applied to unselected/dimmed nodes and edges during selection highlighting. */
const DIMMED_OPACITY = 0.3;

/** CSS class for edges with EXTRACTED confidence (solid line). */
const EDGE_CLASS_EXTRACTED = 'extracted';

/** CSS class for edges with INFERRED confidence (dashed line). */
const EDGE_CLASS_INFERRED = 'inferred';

// ─── CodebaseView Class ──────────────────────────────────────────────────────

/**
 * Adapter between the analysis-side DependencyGraph and the Cytoscape.js
 * renderer. Responsible for:
 * - Converting DependencyGraph → CodebaseGraphData (Cytoscape elements)
 * - Applying color mode strategies
 * - Handling node click selection with neighbor highlighting
 * - Determining edge CSS classes (solid/dashed)
 * - Providing tooltip content for nodes and edges
 * - Returning an empty state message when no source files exist
 *
 * Cytoscape default interactions (drag-to-reposition, scroll-to-zoom, pan)
 * are supported natively by the Cytoscape.js instance and do not require
 * explicit implementation here — they are enabled by default.
 */
export class CodebaseView {
  // ─── Graph Conversion ────────────────────────────────────────────────────

  /**
   * Convert a DependencyGraph (analysis output) into Cytoscape.js elements.
   *
   * Each file becomes a CytoscapeNode with metadata for coloring, tooltips,
   * and badge annotations. Each edge becomes a CytoscapeEdge with confidence
   * class and relationship label.
   *
   * @param graph - The full dependency graph from the analyzer.
   * @returns CodebaseGraphData ready for Cytoscape.js consumption.
   */
  convertGraph(graph: DependencyGraph): CodebaseGraphData {
    const nodes: CytoscapeNode[] = [];
    const edges: CytoscapeEdge[] = [];

    // Convert nodes
    for (const [id, node] of graph.nodes) {
      const degree = this.computeDegree(id, graph);

      nodes.push({
        data: {
          id: node.id,
          label: node.label,
          filePath: node.filePath,
          degree,
        },
      });
    }

    // Convert edges
    for (const edge of graph.edges) {
      edges.push({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          confidence: edge.confidence,
          relationshipType: edge.relationshipType,
          label: this.formatRelationshipLabel(edge.relationshipType),
        },
        classes: this.getEdgeClasses(edge.confidence),
      });
    }

    return { nodes, edges };
  }

  // ─── Color Mode Application ──────────────────────────────────────────────

  /**
   * Apply a coloring strategy to the graph data.
   * Delegates to the color-modes module which computes per-node style overrides.
   *
   * @param mode - The selected ColorMode.
   * @param graphData - The Cytoscape-formatted graph data.
   * @returns Array of style overrides to apply to the Cytoscape instance.
   */
  applyColorMode(mode: ColorMode, graphData: CodebaseGraphData): CytoscapeStyleOverride[] {
    const strategy = getColorModeStrategy(mode);
    return strategy(graphData);
  }

  // ─── Node Click Handling ─────────────────────────────────────────────────

  /**
   * Handle a node click event by computing style overrides that:
   * - Highlight the selected node at full opacity
   * - Highlight direct neighbors at full opacity
   * - Dim all other nodes and edges to ≤0.3 opacity
   *
   * @param nodeId - The ID of the clicked node.
   * @param graphData - The full graph data for neighbor lookup.
   * @returns Array of CytoscapeStyleOverride entries to apply.
   */
  handleNodeClick(nodeId: string, graphData: CodebaseGraphData): CytoscapeStyleOverride[] {
    const overrides: CytoscapeStyleOverride[] = [];

    // Collect neighbor IDs (nodes connected by any edge to/from the selected node)
    const neighborIds = new Set<string>();
    const connectedEdgeIds = new Set<string>();

    for (const edge of graphData.edges) {
      if (edge.data.source === nodeId) {
        neighborIds.add(edge.data.target);
        connectedEdgeIds.add(edge.data.id);
      } else if (edge.data.target === nodeId) {
        neighborIds.add(edge.data.source);
        connectedEdgeIds.add(edge.data.id);
      }
    }

    // Apply full opacity to the selected node
    overrides.push({
      selector: `node[id="${nodeId}"]`,
      style: { opacity: 1.0 },
    });

    // Apply full opacity to neighbor nodes
    for (const neighborId of neighborIds) {
      overrides.push({
        selector: `node[id="${neighborId}"]`,
        style: { opacity: 1.0 },
      });
    }

    // Apply full opacity to connected edges
    for (const edgeId of connectedEdgeIds) {
      overrides.push({
        selector: `edge[id="${edgeId}"]`,
        style: { opacity: 1.0 },
      });
    }

    // Dim all other nodes
    for (const node of graphData.nodes) {
      if (node.data.id !== nodeId && !neighborIds.has(node.data.id)) {
        overrides.push({
          selector: `node[id="${node.data.id}"]`,
          style: { opacity: DIMMED_OPACITY },
        });
      }
    }

    // Dim all other edges
    for (const edge of graphData.edges) {
      if (!connectedEdgeIds.has(edge.data.id)) {
        overrides.push({
          selector: `edge[id="${edge.data.id}"]`,
          style: { opacity: DIMMED_OPACITY },
        });
      }
    }

    return overrides;
  }

  // ─── Edge Styling ────────────────────────────────────────────────────────

  /**
   * Returns the CSS class string for an edge based on its confidence level.
   * - EXTRACTED → 'extracted' (renders as solid line)
   * - INFERRED → 'inferred' (renders as dashed line)
   *
   * @param confidence - The EdgeConfidence tag for the edge.
   * @returns The CSS class name to apply.
   */
  getEdgeClasses(confidence: EdgeConfidence): string {
    return confidence === 'EXTRACTED' ? EDGE_CLASS_EXTRACTED : EDGE_CLASS_INFERRED;
  }

  // ─── Empty State ─────────────────────────────────────────────────────────

  /**
   * Returns a user-friendly message for projects with no parseable source files.
   * Lists the supported extensions so users know what file types are analyzed.
   *
   * @returns The empty state message string.
   */
  getEmptyStateMessage(): string {
    const extensions = SUPPORTED_EXTENSIONS.join(', ');
    return `No source files found in this project. The dependency analyzer supports the following extensions: ${extensions}`;
  }

  // ─── Tooltip Rendering ───────────────────────────────────────────────────

  /**
   * Generate tooltip content for a node.
   * Shows file path, degree (connections), and any metrics available.
   *
   * @param node - The CytoscapeNode to generate a tooltip for.
   * @returns Formatted tooltip string.
   */
  getNodeTooltip(node: CytoscapeNode): string {
    const lines: string[] = [node.data.filePath];

    if (node.data.degree != null) {
      lines.push(`Connections: ${node.data.degree}`);
    }

    if (node.data.layer) {
      lines.push(`Layer: ${node.data.layer}`);
    }

    if (node.data.commitCount != null) {
      lines.push(`Commits: ${node.data.commitCount}`);
    }

    if (node.data.percentile != null) {
      lines.push(`Activity percentile: ${node.data.percentile.toFixed(0)}%`);
    }

    if (node.data.community != null) {
      lines.push(`Community: ${node.data.community}`);
    }

    if (node.data.isGodNode) {
      lines.push('⚠️ God Node (high connectivity)');
    }

    if (node.data.patternBadges && node.data.patternBadges.length > 0) {
      lines.push(`Patterns: ${node.data.patternBadges.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Generate tooltip content for an edge.
   * Shows source file, target file, relationship type, and confidence.
   *
   * @param edge - The CytoscapeEdge to generate a tooltip for.
   * @param graphData - The full graph data for looking up file paths.
   * @returns Formatted tooltip string.
   */
  getEdgeTooltip(edge: CytoscapeEdge, graphData: CodebaseGraphData): string {
    const sourceNode = graphData.nodes.find((n) => n.data.id === edge.data.source);
    const targetNode = graphData.nodes.find((n) => n.data.id === edge.data.target);

    const sourcePath = sourceNode?.data.filePath ?? edge.data.source;
    const targetPath = targetNode?.data.filePath ?? edge.data.target;

    const lines: string[] = [
      `Source: ${sourcePath}`,
      `Target: ${targetPath}`,
      `Relationship: ${this.formatRelationshipLabel(edge.data.relationshipType)}`,
      `Confidence: ${edge.data.confidence}`,
    ];

    return lines.join('\n');
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Compute total degree (in + out) for a node in the graph.
   */
  private computeDegree(nodeId: string, graph: DependencyGraph): number {
    const outDegree = graph.adjacency.get(nodeId)?.length ?? 0;
    const inDegree = graph.reverseAdjacency.get(nodeId)?.length ?? 0;
    return outDegree + inDegree;
  }

  /**
   * Format a relationship type into a human-readable label.
   */
  private formatRelationshipLabel(type: RelationshipType): string {
    switch (type) {
      case 'imports':
        return 'imports';
      case 'calls':
        return 'calls';
      case 'inherits':
        return 'inherits from';
      case 'implements':
        return 'implements';
      case 'mixes_in':
        return 'mixes in';
      case 're_exports':
        return 're-exports';
      case 'references':
        return 'references';
      default:
        return type;
    }
  }
}
