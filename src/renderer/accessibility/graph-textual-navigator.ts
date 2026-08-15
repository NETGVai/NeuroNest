/**
 * GraphTextualNavigator — Provides a keyboard-operable textual equivalent
 * of the Visual_Taskbar dependency graph view.
 *
 * Assistive technology users navigate the graph as a structured tree of
 * entities and relationships. Each node exposes its incoming and outgoing
 * typed links, allowing equivalent navigation to the visual graph.
 *
 * Requirements: 23.4
 */

/** A graph node with textual navigation metadata */
export interface TextualGraphNode {
  /** Unique entity identifier */
  readonly id: string;
  /** Entity display label */
  readonly label: string;
  /** Entity kind (requirement, design_node, task, execution) */
  readonly kind: string;
  /** Current status */
  readonly status: string;
  /** IDs of nodes connected by incoming edges */
  readonly incomingIds: readonly string[];
  /** IDs of nodes connected by outgoing edges */
  readonly outgoingIds: readonly string[];
  /** Typed relationships (e.g., "implements", "depends_on") */
  readonly relationships: readonly TextualGraphEdge[];
}

/** A typed edge between two nodes */
export interface TextualGraphEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relationship: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
}

/** Navigator state exposed for rendering */
export interface GraphNavigatorState {
  readonly nodes: readonly TextualGraphNode[];
  readonly activeNodeId: string | null;
  readonly activeEdgeIndex: number;
  readonly navigationPath: readonly string[];
}

/**
 * GraphTextualNavigator provides tree-style keyboard navigation
 * over the dependency graph. Users can:
 * - Move between sibling nodes (ArrowUp/ArrowDown)
 * - Expand/follow edges (ArrowRight/Enter)
 * - Go back up the navigation path (ArrowLeft/Escape)
 * - Get full relationship descriptions announced
 */
export class GraphTextualNavigator {
  private nodes: TextualGraphNode[] = [];
  private nodeIndex = new Map<string, TextualGraphNode>();
  private activeNodeId: string | null = null;
  private activeEdgeIndex = -1;
  private navigationPath: string[] = [];
  private sortedRootIds: string[] = [];

  /**
   * Set the graph data for navigation.
   */
  setGraph(nodes: TextualGraphNode[]): void {
    this.nodes = nodes;
    this.nodeIndex.clear();
    for (const node of nodes) {
      this.nodeIndex.set(node.id, node);
    }
    // Root nodes have no incoming edges
    this.sortedRootIds = nodes
      .filter(n => n.incomingIds.length === 0)
      .map(n => n.id);
    if (this.sortedRootIds.length === 0 && nodes.length > 0) {
      // Fallback: use all nodes sorted by label
      this.sortedRootIds = nodes.map(n => n.id);
    }
  }

  /**
   * Get current navigator state (for rendering and ARIA attributes).
   */
  getState(): GraphNavigatorState {
    return {
      nodes: this.nodes,
      activeNodeId: this.activeNodeId,
      activeEdgeIndex: this.activeEdgeIndex,
      navigationPath: [...this.navigationPath],
    };
  }

  /**
   * Get the currently active node.
   */
  getActiveNode(): TextualGraphNode | null {
    if (!this.activeNodeId) return null;
    return this.nodeIndex.get(this.activeNodeId) ?? null;
  }

  /**
   * Move to the first navigable node.
   */
  moveToFirst(): TextualGraphNode | null {
    const firstId = this.sortedRootIds[0] ?? this.nodes[0]?.id;
    if (!firstId) return null;
    this.activeNodeId = firstId;
    this.activeEdgeIndex = -1;
    this.navigationPath = [];
    return this.getActiveNode();
  }

  /**
   * Move to the next sibling node in the current level.
   */
  moveNext(): TextualGraphNode | null {
    const siblings = this.getCurrentSiblings();
    if (siblings.length === 0) return null;

    const currentIndex = siblings.indexOf(this.activeNodeId ?? '');
    const nextIndex = currentIndex >= siblings.length - 1 ? 0 : currentIndex + 1;
    this.activeNodeId = siblings[nextIndex]!;
    this.activeEdgeIndex = -1;
    return this.getActiveNode();
  }

  /**
   * Move to the previous sibling node in the current level.
   */
  movePrevious(): TextualGraphNode | null {
    const siblings = this.getCurrentSiblings();
    if (siblings.length === 0) return null;

    const currentIndex = siblings.indexOf(this.activeNodeId ?? '');
    const prevIndex = currentIndex <= 0 ? siblings.length - 1 : currentIndex - 1;
    this.activeNodeId = siblings[prevIndex]!;
    this.activeEdgeIndex = -1;
    return this.getActiveNode();
  }

  /**
   * Expand/follow the current node: navigate into its outgoing edges.
   * If at an edge, follow it to the target node.
   */
  expand(): TextualGraphNode | null {
    const node = this.getActiveNode();
    if (!node) return null;

    if (node.outgoingIds.length === 0) return null;

    // Navigate to first outgoing node
    this.navigationPath.push(node.id);
    this.activeNodeId = node.outgoingIds[0]!;
    this.activeEdgeIndex = -1;
    return this.getActiveNode();
  }

  /**
   * Collapse/go back: return to the parent in the navigation path.
   */
  collapse(): TextualGraphNode | null {
    if (this.navigationPath.length === 0) return null;

    this.activeNodeId = this.navigationPath.pop()!;
    this.activeEdgeIndex = -1;
    return this.getActiveNode();
  }

  /**
   * Navigate to a specific node by ID.
   */
  navigateTo(nodeId: string): TextualGraphNode | null {
    if (!this.nodeIndex.has(nodeId)) return null;
    if (this.activeNodeId) {
      this.navigationPath.push(this.activeNodeId);
    }
    this.activeNodeId = nodeId;
    this.activeEdgeIndex = -1;
    return this.getActiveNode();
  }

  /**
   * Get the accessible description for the current node.
   * Includes kind, label, status, and relationship count.
   */
  getNodeDescription(node: TextualGraphNode): string {
    const parts: string[] = [
      `${node.kind}: ${node.label}`,
      `Status: ${node.status}`,
    ];

    if (node.incomingIds.length > 0) {
      parts.push(`${node.incomingIds.length} incoming relationship${node.incomingIds.length > 1 ? 's' : ''}`);
    }
    if (node.outgoingIds.length > 0) {
      parts.push(`${node.outgoingIds.length} outgoing relationship${node.outgoingIds.length > 1 ? 's' : ''}`);
    }

    return parts.join('. ') + '.';
  }

  /**
   * Get relationship descriptions for the current node.
   */
  getRelationshipDescriptions(node: TextualGraphNode): string[] {
    return node.relationships.map(edge => {
      if (edge.sourceId === node.id) {
        return `${edge.relationship} ${edge.targetLabel}`;
      }
      return `${edge.sourceLabel} ${edge.relationship} this`;
    });
  }

  // ─── Private ───────────────────────────────────────────────────

  private getCurrentSiblings(): string[] {
    if (this.navigationPath.length === 0) {
      return this.sortedRootIds.length > 0
        ? this.sortedRootIds
        : this.nodes.map(n => n.id);
    }

    const parentId = this.navigationPath[this.navigationPath.length - 1]!;
    const parent = this.nodeIndex.get(parentId);
    if (!parent) return [];
    return parent.outgoingIds as string[];
  }
}
