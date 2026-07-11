/**
 * TaskUpdate Tool — Updates the status of an existing task in the agent_tasks table.
 *
 * Factory function pattern: `createTaskUpdateExecute(deps)` returns the execute function
 * so that the database dependency is injected at wiring time.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ToolDependencies } from './tool-dependencies.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Input Interface ────────────────────────────────────────────

export interface TaskUpdateInput {
  taskId: string;
  status: 'queued' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'blocked';
}

// ─── Constants ──────────────────────────────────────────────────

const VALID_STATUSES = ['queued', 'claimed', 'in_progress', 'completed', 'failed', 'blocked'] as const;

const TASK_UPDATE_SCHEMA: FieldSchema[] = [
  { name: 'taskId', type: 'string', required: true },
  { name: 'status', type: 'string', required: true },
];

// ─── Factory Function ───────────────────────────────────────────

/**
 * Creates the TaskUpdate tool execute function with injected database dependency.
 *
 * @param deps - Object containing the `db` (better-sqlite3 Database instance)
 * @returns A standard tool execute function `(input, context) => Promise<ToolResult>`
 */
export function createTaskUpdateExecute(
  deps: Pick<ToolDependencies, 'db'>,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  const { db } = deps;

  return safeExecute<TaskUpdateInput>(TASK_UPDATE_SCHEMA, async (input, _context) => {
    const { taskId, status } = input;

    // Validate status against VALID_STATUSES (Req 6.2, 6.3)
    if (!VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      return {
        success: false,
        output: null,
        error: `Invalid status: "${status}". Valid values: ${VALID_STATUSES.join(', ')}`,
      };
    }

    // Check that the task exists (Req 6.4)
    const existingTask = db.prepare('SELECT id FROM agent_tasks WHERE id = ?').get(taskId);
    if (!existingTask) {
      return {
        success: false,
        output: null,
        error: 'Task not found',
      };
    }

    // Build the UPDATE statement with appropriate timestamp fields
    const now = new Date().toISOString();

    if (status === 'completed') {
      // Req 6.5: set completed_at when status is "completed"
      db.prepare(
        'UPDATE agent_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
      ).run(status, now, now, taskId);
    } else if (status === 'failed') {
      // Req 6.6: set failed_at when status is "failed"
      db.prepare(
        'UPDATE agent_tasks SET status = ?, failed_at = ?, updated_at = ? WHERE id = ?',
      ).run(status, now, now, taskId);
    } else {
      // Req 6.7: always update updated_at on every successful change
      db.prepare(
        'UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?',
      ).run(status, now, taskId);
    }

    // Req 6.8: On success return taskId and new status
    return {
      success: true,
      output: {
        taskId,
        status,
      },
    };
  });
}
