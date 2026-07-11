/**
 * TaskCreate Tool — Inserts a new task record into the agent_tasks table.
 *
 * Factory function pattern: `createTaskCreateExecute(deps)` returns the execute function
 * so that the database dependency is injected at wiring time.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8
 */

import crypto from 'node:crypto';
import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ToolDependencies } from './tool-dependencies.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Input Interface ────────────────────────────────────────────

export interface TaskCreateInput {
  description: string;
  assignee?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

// ─── Constants ──────────────────────────────────────────────────

const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const TASK_CREATE_SCHEMA: FieldSchema[] = [
  { name: 'description', type: 'string', required: true },
  { name: 'assignee', type: 'string', required: false },
  { name: 'priority', type: 'string', required: false },
];

// ─── Factory Function ───────────────────────────────────────────

/**
 * Creates the TaskCreate tool execute function with injected database dependency.
 *
 * @param deps - Object containing the `db` (better-sqlite3 Database instance)
 * @returns A standard tool execute function `(input, context) => Promise<ToolResult>`
 */
export function createTaskCreateExecute(
  deps: Pick<ToolDependencies, 'db'>,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  const { db } = deps;

  return safeExecute<TaskCreateInput>(TASK_CREATE_SCHEMA, async (input, context) => {
    const { description, assignee, priority } = input;

    // Validate priority if provided
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority as typeof VALID_PRIORITIES[number])) {
      return {
        success: false,
        output: null,
        error: `Invalid priority: "${priority}". Valid values: ${VALID_PRIORITIES.join(', ')}`,
      };
    }

    // Resolve defaults
    const taskId = crypto.randomUUID();
    const sessionId = context.sessionId;
    const title = description;
    const status = 'queued';
    const resolvedAssignee = assignee || context.agentId;
    const resolvedPriority = priority || 'medium';

    // Insert into agent_tasks
    const stmt = db.prepare(`
      INSERT INTO agent_tasks (id, session_id, title, description, assignee_type, assignee_id, assignee_name, status, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      taskId,
      sessionId,
      title,
      description,
      'agent',
      resolvedAssignee,
      resolvedAssignee,
      status,
      resolvedPriority,
    );

    return {
      success: true,
      output: {
        id: taskId,
        title,
        status,
        assignee: resolvedAssignee,
      },
    };
  });
}
