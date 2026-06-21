/**
 * ParallelAgentExecutor — Orchestrates concurrent sub-agent execution with
 * conflict detection and merge validation.
 *
 * Spawns multiple sub-agents to work on scoped tasks concurrently, detects
 * file and symbol boundary overlaps before execution, and merges results
 * back after validation. Uses WorktreeIsolation for git-level isolation and
 * optionally ASTLockManager for fine-grained symbol locking.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */

import { WorktreeIsolation, type WorktreeHandle } from './worktree-isolation.js';
import { ASTLockManager } from './ast-lock-manager.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SubAgentTask {
  id: string;
  description: string;
  fileBoundaries: string[];     // allowed file paths
  symbolBoundaries: string[];   // allowed symbols
  role?: string;
}

export interface SubAgentResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'conflict';
  worktreeHandle?: WorktreeHandle;
  output: unknown;
  error?: string;
}

// ─── Implementation ─────────────────────────────────────────────

export class ParallelAgentExecutor {
  private maxConcurrent: number;

  constructor(
    private worktreeIsolation: WorktreeIsolation,
    private astLockManager: ASTLockManager | null,
    maxConcurrent: number = 4,
  ) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Execute a set of sub-agent tasks concurrently with conflict detection.
   *
   * 1. Detects overlapping file/symbol boundaries upfront.
   * 2. Tasks with conflicts are marked with status 'conflict' immediately.
   * 3. Non-conflicting tasks are executed concurrently (up to maxConcurrent).
   * 4. Results are merged and validated before returning.
   *
   * Sequential fallback: When only a single task is provided, it executes
   * directly without parallel overhead.
   */
  async execute(tasks: SubAgentTask[]): Promise<SubAgentResult[]> {
    if (tasks.length === 0) {
      return [];
    }

    // Sequential fallback for single task (Req 13.7)
    if (tasks.length === 1) {
      return [await this.executeTask(tasks[0]!)];
    }

    // Detect conflicts upfront (Req 13.3)
    const conflictGroups = this.detectConflicts(tasks);
    const conflictingTaskIds = new Set<string>();

    // For each conflict group, mark all but the first task as conflicting
    for (const group of conflictGroups) {
      for (let i = 1; i < group.length; i++) {
        conflictingTaskIds.add(group[i]!);
      }
    }

    // Separate tasks into executable and conflicting
    const executableTasks: SubAgentTask[] = [];
    const conflictResults: SubAgentResult[] = [];

    for (const task of tasks) {
      if (conflictingTaskIds.has(task.id)) {
        conflictResults.push({
          taskId: task.id,
          agentId: `agent-${task.id}`,
          status: 'conflict',
          output: null,
          error: 'Task has overlapping file boundaries with another task',
        });
      } else {
        executableTasks.push(task);
      }
    }

    // Execute non-conflicting tasks concurrently (Req 13.6 — limit concurrency)
    const executionResults = await this.executeWithConcurrencyLimit(executableTasks);

    // Merge and validate results (Req 13.4, 13.5)
    const allResults = [...executionResults, ...conflictResults];
    await this.mergeResults(executionResults);

    return allResults;
  }

  /**
   * Detect overlapping file boundaries between tasks.
   *
   * Returns groups of task IDs that share at least one overlapping file path.
   * When ASTLockManager is available, also checks symbol-level overlaps.
   */
  detectConflicts(tasks: SubAgentTask[]): string[][] {
    const conflictGroups: string[][] = [];
    const visited = new Set<string>();

    for (let i = 0; i < tasks.length; i++) {
      if (visited.has(tasks[i]!.id)) continue;

      const group: string[] = [tasks[i]!.id];

      for (let j = i + 1; j < tasks.length; j++) {
        if (visited.has(tasks[j]!.id)) continue;

        if (this.hasOverlap(tasks[i]!, tasks[j]!)) {
          group.push(tasks[j]!.id);
          visited.add(tasks[j]!.id);
        }
      }

      if (group.length > 1) {
        visited.add(tasks[i]!.id);
        conflictGroups.push(group);
      }
    }

    return conflictGroups;
  }

  /**
   * Merge and validate results from completed sub-agents.
   *
   * Validates each successful result's worktree changes can be merged cleanly.
   * Returns a summary of successes and failures.
   */
  async mergeResults(
    results: SubAgentResult[],
  ): Promise<{ success: boolean; failures: SubAgentResult[] }> {
    const failures: SubAgentResult[] = [];

    for (const result of results) {
      if (result.status !== 'completed') {
        failures.push(result);
        continue;
      }

      // Validate worktree changes can be merged
      if (result.worktreeHandle) {
        const validation = await this.worktreeIsolation.validate(result.worktreeHandle);

        if (!validation.valid) {
          result.status = 'conflict';
          result.error = `Merge conflict in files: ${(validation.conflicts ?? []).join(', ')}`;
          failures.push(result);
          continue;
        }

        // Merge the worktree back
        const mergeResult = await this.worktreeIsolation.merge(result.worktreeHandle);
        if (!mergeResult.success) {
          result.status = 'failed';
          result.error = `Merge failed: ${(mergeResult.conflicts ?? []).join(', ')}`;
          failures.push(result);
        }
      }
    }

    return {
      success: failures.length === 0,
      failures,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check if two tasks have overlapping file or symbol boundaries.
   */
  private hasOverlap(taskA: SubAgentTask, taskB: SubAgentTask): boolean {
    // Check file-level overlap
    const fileOverlap = taskA.fileBoundaries.some((file) =>
      taskB.fileBoundaries.includes(file),
    );

    if (fileOverlap) {
      return true;
    }

    // If ASTLockManager is available, also check symbol-level overlaps
    // on shared files (symbol boundaries are file-scoped)
    if (this.astLockManager) {
      const symbolOverlap = taskA.symbolBoundaries.some((symbol) =>
        taskB.symbolBoundaries.includes(symbol),
      );
      if (symbolOverlap) {
        return true;
      }
    }

    return false;
  }

  /**
   * Execute tasks with a concurrency limit using a sliding window.
   */
  private async executeWithConcurrencyLimit(
    tasks: SubAgentTask[],
  ): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];
    const executing: Promise<SubAgentResult>[] = [];

    for (const task of tasks) {
      const promise = this.executeTask(task);

      executing.push(promise);

      // When we hit the concurrency limit, wait for one to finish
      if (executing.length >= this.maxConcurrent) {
        const completed = await Promise.race(
          executing.map((p, idx) => p.then((result) => ({ result, idx }))),
        );
        results.push(completed.result);
        executing.splice(completed.idx, 1);
      }
    }

    // Wait for remaining tasks
    const remaining = await Promise.all(executing);
    results.push(...remaining);

    return results;
  }

  /**
   * Execute a single sub-agent task in an isolated worktree.
   *
   * Creates a worktree for isolation, acquires AST locks if available,
   * runs the task, and returns the result with the worktree handle.
   */
  private async executeTask(task: SubAgentTask): Promise<SubAgentResult> {
    const agentId = `agent-${task.id}`;

    try {
      // Create isolated worktree (Req 13.1 — requires worktree isolation)
      const worktreeHandle = await this.worktreeIsolation.create(agentId);

      // Acquire AST locks for symbol boundaries if ASTLockManager is available
      if (this.astLockManager) {
        for (const file of task.fileBoundaries) {
          for (const symbol of task.symbolBoundaries) {
            const acquired = await this.astLockManager.acquire(file, symbol, agentId);
            if (!acquired) {
              // Cannot acquire lock — another agent holds it
              await this.worktreeIsolation.cleanup(worktreeHandle);
              return {
                taskId: task.id,
                agentId,
                status: 'conflict',
                output: null,
                error: `Could not acquire AST lock for symbol "${symbol}" in "${file}"`,
              };
            }
          }
        }
      }

      // Task execution is delegated to the caller's agent logic.
      // The executor provides isolation; the actual work is performed
      // by the sub-agent within the worktree.
      return {
        taskId: task.id,
        agentId,
        status: 'completed',
        worktreeHandle,
        output: { worktreePath: worktreeHandle.path },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        taskId: task.id,
        agentId,
        status: 'failed',
        output: null,
        error: errorMessage,
      };
    } finally {
      // Release AST locks after execution
      if (this.astLockManager) {
        for (const file of task.fileBoundaries) {
          for (const symbol of task.symbolBoundaries) {
            this.astLockManager.release(file, symbol, agentId);
          }
        }
      }
    }
  }
}
