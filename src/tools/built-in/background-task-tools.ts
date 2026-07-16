/**
 * Background Task Tools — `get_task_output`, `wait_tasks`, and `kill_task` tool definitions.
 *
 * Registered through ToolSystem.register() (Req 15.3).
 * All three tools use getBackgroundTaskRegistry() to access the registry.
 *
 * - get_task_output: Returns last N lines of stdout/stderr + current task state (Req 15.6)
 * - wait_tasks: Blocks until all specified tasks reach terminal state or timeout (Req 15.7)
 * - kill_task: Sends SIGTERM then SIGKILL after grace period (Req 15.8, 15.9)
 *
 * Requirements: 15.3, 15.4, 15.6, 15.7, 15.8, 15.9
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ExecutableToolDefinition } from '../tool-system.js';
import {
  getBackgroundTaskRegistry,
  type TaskState,
  type WaitResult,
} from '../../tasks/background-task-registry.js';

// ─── Constants ──────────────────────────────────────────────────

/** Maximum number of task IDs per wait_tasks call (Req 15.4) */
const MAX_WAIT_TASK_IDS = 20;

/** Default timeout for wait_tasks in milliseconds */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** Default grace period for kill_task SIGTERM → SIGKILL in milliseconds */
const DEFAULT_KILL_GRACE_MS = 5_000;

// ─── get_task_output ────────────────────────────────────────────

/**
 * Execute function for get_task_output tool.
 * Returns the current state, exit code, and last N lines of stdout/stderr for a task.
 */
async function getTaskOutputExecute(input: unknown, _context: ToolContext): Promise<ToolResult> {
  if (!input || typeof input !== 'object') {
    return { success: false, output: null, error: 'Invalid input: expected an object with taskId' };
  }

  const { taskId } = input as { taskId?: string };

  if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
    return { success: false, output: null, error: 'Missing or invalid required parameter: taskId' };
  }

  const registry = getBackgroundTaskRegistry();
  const record = registry.getTask(taskId);

  if (!record) {
    return { success: false, output: null, error: `Task not found: ${taskId}` };
  }

  const output = registry.getOutput(taskId);

  return {
    success: true,
    output: {
      taskId: record.taskId,
      state: record.state,
      exitCode: record.exitCode ?? null,
      stdout: output?.stdout ?? [],
      stderr: output?.stderr ?? [],
    },
  };
}

// ─── wait_tasks ─────────────────────────────────────────────────

/**
 * Execute function for wait_tasks tool.
 * Blocks until all specified tasks reach a terminal state or timeout is reached.
 */
async function waitTasksExecute(input: unknown, _context: ToolContext): Promise<ToolResult> {
  if (!input || typeof input !== 'object') {
    return { success: false, output: null, error: 'Invalid input: expected an object with taskIds' };
  }

  const { taskIds, timeoutMs } = input as { taskIds?: string[]; timeoutMs?: number };

  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return { success: false, output: null, error: 'Missing or invalid required parameter: taskIds (non-empty array)' };
  }

  if (taskIds.length > MAX_WAIT_TASK_IDS) {
    return {
      success: false,
      output: null,
      error: `Too many task IDs: ${taskIds.length} exceeds maximum of ${MAX_WAIT_TASK_IDS}`,
    };
  }

  // Validate all IDs are strings
  for (const id of taskIds) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { success: false, output: null, error: 'Invalid taskId in array: each must be a non-empty string' };
    }
  }

  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
  const registry = getBackgroundTaskRegistry();

  // Verify all tasks exist before waiting
  for (const id of taskIds) {
    const record = registry.getTask(id);
    if (!record) {
      return { success: false, output: null, error: `Task not found: ${id}` };
    }
  }

  // Wait for all tasks, collecting results
  const results: Array<{ taskId: string; state: TaskState; exitCode: number | null; timedOut: boolean }> = [];

  try {
    const waitPromises = taskIds.map((id) =>
      registry
        .waitTask(id, timeout)
        .then((result: WaitResult) => ({
          taskId: result.taskId,
          state: result.state,
          exitCode: result.exitCode ?? null,
          timedOut: false,
        }))
        .catch((err: Error) => {
          // Timeout or other error — report per-task
          if (err.message.includes('Timeout')) {
            const record = registry.getTask(id);
            return {
              taskId: id,
              state: (record?.state ?? 'running') as TaskState,
              exitCode: null,
              timedOut: true,
            };
          }
          throw err;
        }),
    );

    const settled = await Promise.all(waitPromises);
    results.push(...settled);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown wait error';
    return { success: false, output: null, error: `Wait failed: ${message}` };
  }

  const anyTimedOut = results.some((r) => r.timedOut);

  return {
    success: true,
    output: {
      results,
      allCompleted: !anyTimedOut,
    },
  };
}

// ─── kill_task ──────────────────────────────────────────────────

/**
 * Execute function for kill_task tool.
 * Sends SIGTERM then SIGKILL after a grace period.
 */
async function killTaskExecute(input: unknown, _context: ToolContext): Promise<ToolResult> {
  if (!input || typeof input !== 'object') {
    return { success: false, output: null, error: 'Invalid input: expected an object with taskId' };
  }

  const { taskId, signal } = input as { taskId?: string; signal?: number };

  if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
    return { success: false, output: null, error: 'Missing or invalid required parameter: taskId' };
  }

  const registry = getBackgroundTaskRegistry();
  const record = registry.getTask(taskId);

  if (!record) {
    return { success: false, output: null, error: `Task not found: ${taskId}` };
  }

  // If already in terminal state, report current state
  if (record.state === 'completed' || record.state === 'failed' || record.state === 'killed') {
    return {
      success: true,
      output: {
        killed: false,
        state: record.state,
        reason: `Task already in terminal state: ${record.state}`,
      },
    };
  }

  // Determine grace period — use signal as grace period hint if provided
  const gracePeriodMs = typeof signal === 'number' && signal > 0 ? signal : DEFAULT_KILL_GRACE_MS;

  try {
    await registry.killTask(taskId, gracePeriodMs);

    // Re-read state after kill
    const updatedRecord = registry.getTask(taskId);

    return {
      success: true,
      output: {
        killed: true,
        state: updatedRecord?.state ?? 'killed',
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown kill error';
    return { success: false, output: null, error: `Kill failed: ${message}` };
  }
}

// ─── Tool Definitions ───────────────────────────────────────────

export const GetTaskOutputTool: ExecutableToolDefinition = {
  id: 'get_task_output',
  name: 'GetTaskOutput',
  description: 'Get the current output and state of a background task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The unique identifier of the background task' },
    },
    required: ['taskId'],
  },
  riskLevel: 'read-only',
  execute: getTaskOutputExecute,
};

export const WaitTasksTool: ExecutableToolDefinition = {
  id: 'wait_tasks',
  name: 'WaitTasks',
  description: 'Wait for background tasks to reach a terminal state (completed, failed, or killed)',
  inputSchema: {
    type: 'object',
    properties: {
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of task IDs to wait for (max 20)',
      },
      timeoutMs: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default: 30000)',
      },
    },
    required: ['taskIds'],
  },
  riskLevel: 'read-only',
  execute: waitTasksExecute,
};

export const KillTaskTool: ExecutableToolDefinition = {
  id: 'kill_task',
  name: 'KillTask',
  description: 'Kill a running background task (SIGTERM then SIGKILL after grace period)',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The unique identifier of the background task to kill' },
      signal: {
        type: 'number',
        description: 'Grace period in ms before SIGKILL (default: 5000)',
      },
    },
    required: ['taskId'],
  },
  riskLevel: 'execute',
  execute: killTaskExecute,
};

// ─── Registration Function ──────────────────────────────────────

/**
 * Register all background task management tools with the ToolSystem.
 *
 * Tools registered:
 * - get_task_output: Read-only, returns stdout/stderr + state
 * - wait_tasks: Read-only, blocks until tasks complete or timeout
 * - kill_task: Execute-level, terminates running tasks
 *
 * @param toolSystem - The ToolSystem (or compatible register interface) to register tools with
 */
export function registerBackgroundTaskTools(
  toolSystem: { register: (tool: ExecutableToolDefinition) => void },
): void {
  toolSystem.register(GetTaskOutputTool);
  toolSystem.register(WaitTasksTool);
  toolSystem.register(KillTaskTool);
}
