/**
 * WorkflowIntegration — Wire Swarm and Orchestrator to Workflow Builder.
 *
 * Connects Swarm task initiation to Workflow_Builder visual review,
 * connects Orchestrator TaskGraph display to Workflow_Builder,
 * and ensures no workflow executes without user finalization.
 *
 * Requirements: 5.6, 6.4, 23.5
 */

import type { TaskGraph, WorkflowDesign } from '../shared/types.js';
import { WorkflowBuilder, type FinalizedWorkflow } from '../workflow/workflow-builder.js';
import { SwarmManager, type Swarm } from '../swarm/swarm-manager.js';
import { OrchestratorManager } from '../orchestrator/orchestrator-manager.js';

// ─── Types ──────────────────────────────────────────────────────

export interface WorkflowReviewResult {
  approved: boolean;
  design: WorkflowDesign;
  finalized?: FinalizedWorkflow;
}

// ─── WorkflowIntegration ────────────────────────────────────────

export class WorkflowIntegration {
  private workflowBuilder: WorkflowBuilder;
  private swarmManager: SwarmManager;
  private orchestratorManager: OrchestratorManager;
  private pendingReviews = new Map<string, WorkflowDesign>();

  constructor(
    workflowBuilder: WorkflowBuilder,
    swarmManager: SwarmManager,
    orchestratorManager: OrchestratorManager,
  ) {
    this.workflowBuilder = workflowBuilder;
    this.swarmManager = swarmManager;
    this.orchestratorManager = orchestratorManager;
  }

  /**
   * Present a Swarm task plan through the Workflow_Builder for review.
   * Requirements: 5.6
   */
  presentSwarmForReview(swarm: Swarm): WorkflowDesign {
    // Convert swarm workers to a task graph
    const taskGraph: TaskGraph = {
      nodes: swarm.workers.map((w) => ({
        id: w.workerId,
        description: `Worker: ${w.agentId}`,
        assignedAgent: w.agentId,
        status: 'pending' as const,
      })),
      edges: [],
    };

    const design = this.workflowBuilder.createFromTaskGraph(taskGraph);
    this.pendingReviews.set(design.id, design);
    return design;
  }

  /**
   * Present an Orchestrator TaskGraph through the Workflow_Builder.
   * Requirements: 6.4
   */
  presentOrchestratorForReview(orchestratorId: string): WorkflowDesign {
    const orchestrator = this.orchestratorManager.getOrchestrator(orchestratorId);
    if (!orchestrator) throw new Error(`Orchestrator not found: ${orchestratorId}`);

    const design = this.workflowBuilder.createFromTaskGraph(orchestrator.taskGraph);
    this.pendingReviews.set(design.id, design);
    return design;
  }

  /**
   * Finalize and approve a workflow for execution.
   * Requirements: 23.5
   */
  finalizeWorkflow(workflowId: string): FinalizedWorkflow {
    const design = this.pendingReviews.get(workflowId);
    if (!design) throw new Error(`No pending review for workflow: ${workflowId}`);

    const finalized = this.workflowBuilder.finalize(design);
    this.pendingReviews.delete(workflowId);
    return finalized;
  }

  /**
   * Check if a workflow is pending review (not yet finalized).
   */
  isPendingReview(workflowId: string): boolean {
    return this.pendingReviews.has(workflowId);
  }

  /**
   * Attempt to execute — blocked if not finalized.
   * Requirements: 23.5
   */
  executeWorkflow(workflowId: string): void {
    if (this.pendingReviews.has(workflowId)) {
      throw new Error('Workflow must be finalized before execution. Please review and approve.');
    }
    this.workflowBuilder.execute(workflowId);
  }

  /**
   * Get all pending reviews.
   */
  getPendingReviews(): WorkflowDesign[] {
    return Array.from(this.pendingReviews.values());
  }
}
