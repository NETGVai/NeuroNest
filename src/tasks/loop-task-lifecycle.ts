/**
 * Loop Task Lifecycle — integrates background tasks with the Loop Engine.
 *
 * Responsibilities:
 *   - Kill all session background tasks when Loop reaches a terminal state
 *   - Build a cost-free running-task summary injected at pass start
 *   - Provide hook/integration points for Loop Runner calls
 *
 * Requirements: 15.13, 15.14, 15.15
 */

import type { BackgroundTaskRegistry, TaskRecord } from './background-task-registry.js';
import type { TerminalState } from '../loop-engine/index.js';

// ─── Types ──────────────────────────────────────────────────────

/** Terminal states that trigger session task cleanup */
export const LOOP_TERMINAL_STATES: readonly TerminalState[] = [
  'SUCCEEDED',
  'NO_OP',
  'BLOCKED',
  'LIMIT_EXHAUSTED',
  'STALLED',
] as const;

/** Summary message injected at pass start */
export interface RunningTaskSummaryMessage {
  /** Role: always 'system' for cost-free injection */
  role: 'system';
  /** Formatted summary content */
  content: string;
  /** Metadata marking this as cost-free */
  metadata: {
    type: 'running-task-summary';
    costFree: true;
    taskCount: number;
    sessionId: string;
    timestamp: number;
  };
}

/** Options for building the summary */
export interface SummaryOptions {
  /** Max output lines to include per task (default: 3) */
  maxOutputLines?: number;
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Kill all running/pending background tasks for a session.
 * Called when the Loop Engine enters any terminal state or crash path.
 *
 * Requirement 15.13: All tasks killed on every terminal state and crash path.
 */
export async function killSessionTasksOnTerminal(
  registry: BackgroundTaskRegistry,
  sessionId: string,
): Promise<{ killedCount: number; taskIds: string[] }> {
  const activeTasks = registry
    .listTasks(sessionId)
    .filter((t) => t.state === 'running' || t.state === 'pending');

  if (activeTasks.length === 0) {
    return { killedCount: 0, taskIds: [] };
  }

  const taskIds = activeTasks.map((t) => t.taskId);

  // Kill all active tasks in parallel
  await registry.killAll(sessionId);

  return { killedCount: taskIds.length, taskIds };
}

/**
 * Build a formatted summary of currently running background tasks.
 * Returns an empty string if no tasks are running for the session.
 *
 * Requirement 15.14: Inject running-task summary into context at pass start.
 *
 * Format:
 *   [Running Background Tasks: N]
 *   • task-id (command): running for Xs, last output: "..."
 *   • task-id (command): running for Xs, last output: "..."
 */
export function buildRunningTaskSummary(
  registry: BackgroundTaskRegistry,
  sessionId: string,
  options: SummaryOptions = {},
): string {
  const { maxOutputLines = 3 } = options;

  const activeTasks = registry
    .listTasks(sessionId)
    .filter((t) => t.state === 'running' || t.state === 'pending');

  if (activeTasks.length === 0) {
    return '';
  }

  const lines: string[] = [`[Running Background Tasks: ${activeTasks.length}]`];

  for (const task of activeTasks) {
    const duration = formatDuration(Date.now() - task.startTime);
    const command = formatCommand(task);
    const lastOutput = getLastOutput(registry, task.taskId, maxOutputLines);
    const shortId = task.taskId.slice(0, 8);

    lines.push(`\u2022 ${shortId} (${command}): running for ${duration}, last output: "${lastOutput}"`);
  }

  return lines.join('\n');
}

/**
 * Build a RunningTaskSummaryMessage suitable for injection into the
 * conversation context at pass start. The message is marked as cost-free.
 *
 * Requirement 15.15: Summary is cost-free (not counted against token budget).
 *
 * Returns null if there are no running tasks (nothing to inject).
 */
export function buildRunningTaskSummaryMessage(
  registry: BackgroundTaskRegistry,
  sessionId: string,
  options: SummaryOptions = {},
): RunningTaskSummaryMessage | null {
  const content = buildRunningTaskSummary(registry, sessionId, options);

  if (!content) {
    return null;
  }

  const activeTasks = registry
    .listTasks(sessionId)
    .filter((t) => t.state === 'running' || t.state === 'pending');

  return {
    role: 'system',
    content,
    metadata: {
      type: 'running-task-summary',
      costFree: true,
      taskCount: activeTasks.length,
      sessionId,
      timestamp: Date.now(),
    },
  };
}

// ─── Loop Lifecycle Hooks ───────────────────────────────────────

/**
 * LoopTaskLifecycleHooks provides integration points for the Loop Runner
 * to call at key lifecycle moments.
 *
 * Usage in Loop Runner:
 *   - On terminal state transition: call `onTerminalState()`
 *   - On pass start: call `onPassStart()` and inject the returned message
 */
export class LoopTaskLifecycleHooks {
  private registry: BackgroundTaskRegistry;
  private sessionId: string;
  private summaryOptions: SummaryOptions;

  constructor(
    registry: BackgroundTaskRegistry,
    sessionId: string,
    summaryOptions: SummaryOptions = {},
  ) {
    this.registry = registry;
    this.sessionId = sessionId;
    this.summaryOptions = summaryOptions;
  }

  /**
   * Called when Loop Engine enters a terminal state.
   * Kills all background tasks for this session.
   *
   * Requirement 15.13
   */
  async onTerminalState(
    _state: TerminalState,
  ): Promise<{ killedCount: number; taskIds: string[] }> {
    return killSessionTasksOnTerminal(this.registry, this.sessionId);
  }

  /**
   * Called at the start of each Loop pass.
   * Returns a cost-free summary message to inject into context, or null
   * if no background tasks are running.
   *
   * Requirements 15.14, 15.15
   */
  onPassStart(): RunningTaskSummaryMessage | null {
    return buildRunningTaskSummaryMessage(this.registry, this.sessionId, this.summaryOptions);
  }

  /**
   * Called on crash recovery path to ensure all tasks are cleaned up.
   * Same behavior as terminal state cleanup.
   */
  async onCrash(): Promise<{ killedCount: number; taskIds: string[] }> {
    return killSessionTasksOnTerminal(this.registry, this.sessionId);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "2s", "45s", "2m 30s", "1h 5m"
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Format a task's command for display.
 * Combines command and first few args for a concise label.
 */
function formatCommand(task: TaskRecord): string {
  if (task.args.length === 0) {
    return task.command;
  }
  const fullCommand = `${task.command} ${task.args.join(' ')}`;
  // Truncate to 50 chars for readability
  if (fullCommand.length > 50) {
    return fullCommand.slice(0, 47) + '...';
  }
  return fullCommand;
}

/**
 * Get the last N lines of combined output for a task.
 * Returns a single line string suitable for the summary.
 */
function getLastOutput(
  registry: BackgroundTaskRegistry,
  taskId: string,
  maxLines: number,
): string {
  const output = registry.getOutput(taskId);
  if (!output) {
    return '(no output)';
  }

  // Combine stdout and stderr, take last N lines
  const combined = [...output.stdout, ...output.stderr];
  if (combined.length === 0) {
    return '(no output)';
  }

  const lastLines = combined.slice(-maxLines);
  const result = lastLines.join(' | ');

  // Truncate if too long
  if (result.length > 100) {
    return result.slice(0, 97) + '...';
  }
  return result;
}
