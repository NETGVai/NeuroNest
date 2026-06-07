/**
 * WorkflowBuilder — Visual DAG editing, workflow templates, execution.
 *
 * Stub implementation with in-memory state. Provides workflow creation
 * from task graphs and templates, node/edge CRUD, finalization for execution.
 *
 * Requirements: 23.1–23.3, 23.9–23.10, 23.13
 */

import { randomUUID } from 'node:crypto';
import type {
  TaskGraph,
  WorkflowDesign,
  WorkflowNode,
  WorkflowEdge,
  WorkflowMetadata,
  OrchestrationPattern,
  WorkflowNodeType,
} from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  design: WorkflowDesign;
}

export interface FinalizedWorkflow {
  design: WorkflowDesign;
  finalized: true;
  finalizedAt: Date;
}

// ─── WorkflowBuilder ───────────────────────────────────────────

export class WorkflowBuilder {
  private templates = new Map<string, WorkflowTemplate>();
  private finalizedWorkflows = new Set<string>(); // workflow IDs that are finalized

  constructor() {
    this.loadDefaultTemplates();
  }

  /**
   * Create a workflow design from a TaskGraph.
   * Requirements: 23.1, 23.2
   */
  createFromTaskGraph(graph: TaskGraph): WorkflowDesign {
    const nodes: WorkflowNode[] = graph.nodes.map((node, i) => ({
      id: node.id,
      type: 'task' as WorkflowNodeType,
      description: node.description,
      assignedAgentId: node.assignedAgent,
      estimatedTokenCost: node.estimatedTokens,
      position: { x: 100 + (i % 4) * 200, y: 100 + Math.floor(i / 4) * 150 },
      status: 'pending',
    }));

    const edges: WorkflowEdge[] = graph.edges.map((edge) => ({
      id: randomUUID(),
      from: edge.from,
      to: edge.to,
      pattern: edge.pattern,
      condition: edge.condition,
    }));

    return {
      id: randomUUID(),
      nodes,
      edges,
      metadata: {
        name: 'Workflow from TaskGraph',
        description: 'Auto-generated from task graph',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }

  /**
   * Create a workflow design from a template.
   * Requirements: 23.9
   */
  createFromTemplate(templateId: string): WorkflowDesign {
    const template = this.templates.get(templateId);
    if (!template) throw new Error(`Template not found: ${templateId}`);

    return {
      ...structuredClone(template.design),
      id: randomUUID(),
      metadata: {
        ...template.design.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }

  /**
   * Add a node to a workflow design.
   * Requirements: 23.3
   */
  addNode(design: WorkflowDesign, node: WorkflowNode): WorkflowDesign {
    this.ensureNotFinalized(design.id);
    return {
      ...design,
      nodes: [...design.nodes, node],
      metadata: { ...design.metadata, updatedAt: new Date() },
    };
  }

  /**
   * Remove a node and its connected edges.
   * Requirements: 23.3
   */
  removeNode(design: WorkflowDesign, nodeId: string): WorkflowDesign {
    this.ensureNotFinalized(design.id);
    return {
      ...design,
      nodes: design.nodes.filter((n) => n.id !== nodeId),
      edges: design.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
      metadata: { ...design.metadata, updatedAt: new Date() },
    };
  }

  /**
   * Add an edge to a workflow design.
   * Requirements: 23.3
   */
  addEdge(design: WorkflowDesign, edge: WorkflowEdge): WorkflowDesign {
    this.ensureNotFinalized(design.id);
    return {
      ...design,
      edges: [...design.edges, edge],
      metadata: { ...design.metadata, updatedAt: new Date() },
    };
  }

  /**
   * Remove an edge.
   */
  removeEdge(design: WorkflowDesign, edgeId: string): WorkflowDesign {
    this.ensureNotFinalized(design.id);
    return {
      ...design,
      edges: design.edges.filter((e) => e.id !== edgeId),
      metadata: { ...design.metadata, updatedAt: new Date() },
    };
  }

  /**
   * Update a node's properties.
   */
  updateNode(design: WorkflowDesign, nodeId: string, updates: Partial<WorkflowNode>): WorkflowDesign {
    this.ensureNotFinalized(design.id);
    return {
      ...design,
      nodes: design.nodes.map((n) => (n.id === nodeId ? { ...n, ...updates, id: nodeId } : n)),
      metadata: { ...design.metadata, updatedAt: new Date() },
    };
  }

  /**
   * Reassign an agent to a node.
   * Requirements: 23.3
   */
  reassignAgent(design: WorkflowDesign, nodeId: string, agentId: string): WorkflowDesign {
    return this.updateNode(design, nodeId, { assignedAgentId: agentId });
  }

  /**
   * Change the orchestration pattern on an edge.
   * Requirements: 23.3
   */
  changePattern(design: WorkflowDesign, edgeId: string, pattern: OrchestrationPattern): WorkflowDesign {
    this.ensureNotFinalized(design.id);
    return {
      ...design,
      edges: design.edges.map((e) => (e.id === edgeId ? { ...e, pattern } : e)),
      metadata: { ...design.metadata, updatedAt: new Date() },
    };
  }

  /**
   * Save a workflow design as a reusable template.
   * Requirements: 23.10
   */
  saveTemplate(design: WorkflowDesign, name: string): WorkflowTemplate {
    const template: WorkflowTemplate = {
      id: randomUUID(),
      name,
      description: design.metadata.description,
      design: structuredClone(design),
    };
    this.templates.set(template.id, template);
    return template;
  }

  /**
   * List all templates.
   */
  listTemplates(): WorkflowTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Export a workflow design as JSON.
   * Requirements: 23.13
   */
  exportDesign(design: WorkflowDesign): string {
    return JSON.stringify(design, null, 2);
  }

  /**
   * Import a workflow design from JSON.
   * Requirements: 23.13
   */
  importDesign(json: string): WorkflowDesign {
    const parsed = JSON.parse(json);
    // Basic validation
    if (!parsed.id || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('Invalid workflow design JSON');
    }
    return {
      ...parsed,
      metadata: {
        ...parsed.metadata,
        createdAt: new Date(parsed.metadata.createdAt),
        updatedAt: new Date(parsed.metadata.updatedAt),
      },
    };
  }

  /**
   * Finalize a workflow design, locking it for execution.
   * Requirements: 23.5
   */
  finalize(design: WorkflowDesign): FinalizedWorkflow {
    if (design.nodes.length === 0) {
      throw new Error('Cannot finalize an empty workflow');
    }
    this.finalizedWorkflows.add(design.id);
    return {
      design,
      finalized: true,
      finalizedAt: new Date(),
    };
  }

  /**
   * Check if a workflow is finalized.
   */
  isFinalized(workflowId: string): boolean {
    return this.finalizedWorkflows.has(workflowId);
  }

  /**
   * Attempt to execute a workflow — throws if not finalized.
   * Requirements: 23.5
   */
  execute(workflowId: string): void {
    if (!this.finalizedWorkflows.has(workflowId)) {
      throw new Error('Workflow must be finalized before execution');
    }
    // Stub: execution would be handled by orchestrator
  }

  // ── Private helpers ─────────────────────────────────────────

  private ensureNotFinalized(workflowId: string): void {
    if (this.finalizedWorkflows.has(workflowId)) {
      throw new Error('Cannot modify a finalized workflow');
    }
  }

  private loadDefaultTemplates(): void {
    const defaults: Array<{ name: string; description: string }> = [
      { name: 'MVP Build', description: 'Build a minimum viable product' },
      { name: 'Code Review Pipeline', description: 'Multi-stage code review' },
      { name: 'Feature Development', description: 'Full feature development cycle' },
      { name: 'Bug Investigation', description: 'Investigate and fix a bug' },
      { name: 'Performance Audit', description: 'Audit and optimize performance' },
    ];

    for (const tmpl of defaults) {
      const id = randomUUID();
      this.templates.set(id, {
        id,
        name: tmpl.name,
        description: tmpl.description,
        design: {
          id: randomUUID(),
          nodes: [
            {
              id: randomUUID(),
              type: 'task',
              description: `${tmpl.name} - Step 1`,
              position: { x: 100, y: 100 },
            },
          ],
          edges: [],
          metadata: {
            name: tmpl.name,
            description: tmpl.description,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      });
    }
  }
}
