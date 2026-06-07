/**
 * WorkflowCanvas — Stub for drag-and-drop canvas rendering.
 *
 * Provides data structures and stubs for visual workflow canvas:
 * node rendering, zoom, pan, minimap, auto-layout.
 *
 * Requirements: 23.3–23.8, 23.11–23.12
 */

import type { WorkflowDesign, WorkflowNode, WorkflowEdge } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface NodeRenderData {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  agentAvatar?: string;
  estimatedCost?: number;
  pattern?: string;
  status?: string;
  tokenUsage?: number;
  duration?: number;
  outputPreview?: string;
}

export interface MinimapData {
  nodes: Array<{ x: number; y: number; width: number; height: number }>;
  viewport: CanvasViewport;
  totalBounds: { width: number; height: number };
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
}

// ─── WorkflowCanvas ────────────────────────────────────────────

export class WorkflowCanvas {
  private viewport: CanvasViewport = { x: 0, y: 0, zoom: 1, width: 1200, height: 800 };
  private selectedNodeId: string | null = null;
  private dragState: { nodeId: string; offsetX: number; offsetY: number } | null = null;

  /**
   * Render node data for the canvas.
   * Requirements: 23.4
   */
  getNodeRenderData(design: WorkflowDesign): NodeRenderData[] {
    return design.nodes.map((node) => ({
      nodeId: node.id,
      x: node.position.x,
      y: node.position.y,
      width: 200,
      height: 80,
      label: node.description,
      agentAvatar: node.assignedAgentId,
      estimatedCost: node.estimatedTokenCost,
      status: node.status,
    }));
  }

  /**
   * Zoom the canvas.
   * Requirements: 23.8
   */
  zoom(delta: number): CanvasViewport {
    this.viewport.zoom = Math.max(0.1, Math.min(3, this.viewport.zoom + delta));
    return { ...this.viewport };
  }

  /**
   * Pan the canvas.
   * Requirements: 23.8
   */
  pan(dx: number, dy: number): CanvasViewport {
    this.viewport.x += dx;
    this.viewport.y += dy;
    return { ...this.viewport };
  }

  /**
   * Get minimap data.
   * Requirements: 23.8
   */
  getMinimap(design: WorkflowDesign): MinimapData {
    const nodes = design.nodes.map((n) => ({
      x: n.position.x,
      y: n.position.y,
      width: 200,
      height: 80,
    }));

    const maxX = Math.max(...nodes.map((n) => n.x + n.width), 0);
    const maxY = Math.max(...nodes.map((n) => n.y + n.height), 0);

    return {
      nodes,
      viewport: { ...this.viewport },
      totalBounds: { width: maxX, height: maxY },
    };
  }

  /**
   * Auto-layout nodes in a top-down DAG arrangement.
   * Requirements: 23.8
   */
  autoLayout(design: WorkflowDesign): LayoutResult {
    const positions = new Map<string, { x: number; y: number }>();
    const nodeCount = design.nodes.length;

    // Simple grid layout stub
    design.nodes.forEach((node, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      positions.set(node.id, { x: 100 + col * 250, y: 100 + row * 150 });
    });

    return { positions };
  }

  /**
   * Get current viewport.
   */
  getViewport(): CanvasViewport {
    return { ...this.viewport };
  }

  /**
   * Select a node.
   */
  selectNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
  }

  /**
   * Get selected node ID.
   */
  getSelectedNode(): string | null {
    return this.selectedNodeId;
  }

  /**
   * Start dragging a node.
   * Requirements: 23.3
   */
  startDrag(nodeId: string, offsetX: number, offsetY: number): void {
    this.dragState = { nodeId, offsetX, offsetY };
  }

  /**
   * End dragging.
   */
  endDrag(): { nodeId: string; offsetX: number; offsetY: number } | null {
    const state = this.dragState;
    this.dragState = null;
    return state;
  }
}
