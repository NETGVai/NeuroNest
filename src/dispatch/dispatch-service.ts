/**
 * DispatchService — Handles single and bulk dispatch of tasks to agents.
 *
 * Responsibilities:
 * 1. Present a full dispatch plan (objective, criteria, context, agent, model,
 *    permissions, workspace/worktree, budget, timeout, validation plan) for
 *    confirmation before dispatch.
 * 2. On acceptance, create an immutable Agent_Run via RunCoordinator and
 *    transition the task to 'queued'.
 * 3. On rejection, create NO Agent_Run and leave the task untouched.
 * 4. Detect and reject duplicate dispatch commands for the same active task/run.
 * 5. Support dependency-safe bulk dispatch.
 *
 * Requirements: 13.1, 13.3, 13.4
 */

import { createHash } from 'crypto';
import {
  RunCoordinator,
  DuplicateRunError,
  type AgentRun,
  type CreateRunParams,
} from './run-coordinator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A dispatch plan presented to the user for confirmation.
 */
export interface DispatchPlan {
  /** Task identifier */
  readonly taskId: string;
  /** Human-readable task objective */
  readonly objective: string;
  /** Acceptance criteria for the task */
  readonly criteria: readonly string[];
  /** Context items attached to the dispatch */
  readonly context: readonly string[];
  /** Selected or auto-routed agent ID */
  readonly agentId: string;
  /** Model route for this dispatch */
  readonly modelRouteId: string;
  /** Permissions granted for this run */
  readonly permissions: readonly string[];
  /** Target workspace or worktree path */
  readonly workspace: string;
  /** Token/cost budget for the run */
  readonly budget: DispatchBudget;
  /** Maximum execution timeout (ms) */
  readonly timeoutMs: number;
  /** Validation plan to execute after implementation */
  readonly validationPlan: readonly string[];
}

/**
 * Budget for a dispatch execution.
 */
export interface DispatchBudget {
  /** Maximum input tokens */
  readonly maxInputTokens: number;
  /** Maximum output tokens */
  readonly maxOutputTokens: number;
  /** Maximum monetary cost (in cents) */
  readonly maxCostCents: number;
}

/**
 * The user's decision on a presented dispatch plan.
 */
export type DispatchDecision = 'accepted' | 'rejected';

/**
 * Result of a dispatch attempt.
 */
export interface DispatchResult {
  /** Whether the dispatch was accepted and executed */
  readonly accepted: boolean;
  /** The created Agent_Run (only when accepted) */
  readonly run: AgentRun | null;
  /** Task ID */
  readonly taskId: string;
  /** Reason for rejection or failure */
  readonly reason: string | null;
}

/**
 * Result of a bulk dispatch attempt.
 */
export interface BulkDispatchResult {
  /** Individual dispatch results in dependency order */
  readonly results: readonly DispatchResult[];
  /** Number of successfully dispatched tasks */
  readonly dispatched: number;
  /** Number of rejected or failed dispatches */
  readonly rejected: number;
  /** Tasks that were skipped due to blocked dependencies */
  readonly skippedDueToDependencies: readonly string[];
}

/**
 * Task information needed by the dispatch service.
 */
export interface DispatchableTask {
  readonly id: string;
  readonly status: string;
  readonly dependencies: readonly string[];
  readonly objective: string;
  readonly criteria: readonly string[];
  readonly context: readonly string[];
  readonly permissions: readonly string[];
  readonly workspace: string;
  readonly budget: DispatchBudget;
  readonly timeoutMs: number;
  readonly validationPlan: readonly string[];
}

/**
 * Callback to transition task status in the planning store.
 */
export type TaskStatusUpdater = (taskId: string, newStatus: 'queued') => void;

// ─── DispatchService ────────────────────────────────────────────────────────

/**
 * DispatchService handles presenting dispatch plans and creating runs.
 */
export class DispatchService {
  constructor(
    private readonly runCoordinator: RunCoordinator,
    private readonly taskStatusUpdater: TaskStatusUpdater,
  ) {}

  /**
   * Build a dispatch plan for a task. This is what gets presented to the user
   * for confirmation before any run is created.
   */
  buildDispatchPlan(
    task: DispatchableTask,
    agentId: string,
    modelRouteId: string,
  ): DispatchPlan {
    return {
      taskId: task.id,
      objective: task.objective,
      criteria: task.criteria,
      context: task.context,
      agentId,
      modelRouteId,
      permissions: task.permissions,
      workspace: task.workspace,
      budget: task.budget,
      timeoutMs: task.timeoutMs,
      validationPlan: task.validationPlan,
    };
  }

  /**
   * Execute a single dispatch after the user's decision.
   *
   * - On 'accepted': creates exactly one Agent_Run in 'queued' state,
   *   transitions the task to 'queued', and returns the run.
   * - On 'rejected': creates NO Agent_Run and returns null.
   *
   * Handles duplicate detection and not-ready tasks gracefully:
   * - Accepted but not-ready: still creates the run and queues the task (per R13.4).
   * - Duplicate active run: returns error without creating a new run.
   */
  dispatch(plan: DispatchPlan, decision: DispatchDecision): DispatchResult {
    if (decision === 'rejected') {
      return {
        accepted: false,
        run: null,
        taskId: plan.taskId,
        reason: 'Dispatch rejected by user',
      };
    }

    // Compute fingerprint of the dispatch plan for immutability
    const fingerprint = this.computePlanFingerprint(plan);

    const createParams: CreateRunParams = {
      taskId: plan.taskId,
      workspaceId: plan.workspace,
      agentId: plan.agentId,
      modelRouteId: plan.modelRouteId,
      dispatchPlanFingerprint: fingerprint,
    };

    let run: AgentRun;
    try {
      // Create the immutable Agent_Run in 'queued' state BEFORE any backend
      run = this.runCoordinator.createRun(createParams);
    } catch (error) {
      if (error instanceof DuplicateRunError) {
        return {
          accepted: false,
          run: null,
          taskId: plan.taskId,
          reason: `Duplicate dispatch: active run '${error.existingRunId}' already exists for task '${plan.taskId}'`,
        };
      }
      throw error;
    }

    // Transition the task to 'queued' AFTER the Agent_Run is created
    this.taskStatusUpdater(plan.taskId, 'queued');

    return {
      accepted: true,
      run,
      taskId: plan.taskId,
      reason: null,
    };
  }

  /**
   * Bulk dispatch multiple tasks in dependency-safe order.
   *
   * Tasks are dispatched only if their dependencies are all in a completed
   * or dispatched (queued) state. Tasks whose dependencies haven't been
   * satisfied are skipped.
   */
  bulkDispatch(
    tasks: readonly DispatchableTask[],
    agentId: string,
    modelRouteId: string,
    decisions: ReadonlyMap<string, DispatchDecision>,
  ): BulkDispatchResult {
    // Build a dependency-safe ordering
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const ordered = this.topologicalSort(tasks);
    const dispatched = new Set<string>();
    const results: DispatchResult[] = [];
    const skippedDueToDependencies: string[] = [];

    for (const taskId of ordered) {
      const task = taskMap.get(taskId);
      if (!task) continue;

      const decision = decisions.get(taskId);
      if (!decision) {
        // No decision for this task, skip it
        skippedDueToDependencies.push(taskId);
        continue;
      }

      // Check dependencies: all must be completed or just dispatched
      const depsReady = task.dependencies.every(
        (depId) =>
          dispatched.has(depId) ||
          this.isTaskCompleted(depId, taskMap),
      );

      if (!depsReady) {
        skippedDueToDependencies.push(taskId);
        results.push({
          accepted: false,
          run: null,
          taskId,
          reason: 'Blocked: unresolved dependencies',
        });
        continue;
      }

      const plan = this.buildDispatchPlan(task, agentId, modelRouteId);
      const result = this.dispatch(plan, decision);
      results.push(result);

      if (result.accepted) {
        dispatched.add(taskId);
      }
    }

    return {
      results,
      dispatched: results.filter((r) => r.accepted).length,
      rejected: results.filter((r) => !r.accepted).length,
      skippedDueToDependencies,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private computePlanFingerprint(plan: DispatchPlan): string {
    const payload = JSON.stringify({
      taskId: plan.taskId,
      agentId: plan.agentId,
      modelRouteId: plan.modelRouteId,
      workspace: plan.workspace,
      criteria: plan.criteria,
      budget: plan.budget,
      timeoutMs: plan.timeoutMs,
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * Topological sort of tasks respecting dependency order.
   * Returns task IDs in a safe dispatch order.
   */
  private topologicalSort(tasks: readonly DispatchableTask[]): string[] {
    const ids = new Set(tasks.map((t) => t.id));
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const task of tasks) {
      inDegree.set(task.id, 0);
      adj.set(task.id, []);
    }

    for (const task of tasks) {
      for (const dep of task.dependencies) {
        if (ids.has(dep)) {
          adj.get(dep)!.push(task.id);
          inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    // If cycle detected, just return what we have (cycle handling is upstream)
    return sorted;
  }

  private isTaskCompleted(taskId: string, taskMap: Map<string, DispatchableTask>): boolean {
    const task = taskMap.get(taskId);
    return task?.status === 'completed';
  }
}
