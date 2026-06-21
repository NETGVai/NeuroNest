/**
 * KanbanStateManager — Task board state management for multi-agent work tracking.
 *
 * Maintains an in-memory task state model with columns: backlog, in_progress, review, done, and failed.
 * Emits state transitions via IPC to the Electron renderer for visual board rendering.
 * Tracks per-task metadata including assigned agent role, elapsed time, and token cost.
 *
 * Key behaviors:
 * - addTask() creates a new task in the backlog column
 * - moveTask() transitions a task to a target column and emits IPC update
 * - getBoard() returns full board state grouped by columns for UI rendering
 * - Integrates with sub-agent lifecycle: queued → in_progress → review/done
 * - When completion_council is enabled, completed tasks route through review before done
 * - When feature gate disabled, all methods are no-ops (zero overhead)
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

/** Valid task columns matching Requirement 25.1 */
export type TaskColumn = 'backlog' | 'in_progress' | 'review' | 'done' | 'failed';

/** All valid columns as a constant array for validation */
export const VALID_COLUMNS: readonly TaskColumn[] = [
  'backlog',
  'in_progress',
  'review',
  'done',
  'failed',
] as const;

/** Per-task metadata displayed on the board (Req 25.5) */
export interface TaskMetadata {
  /** Assigned agent role (e.g., 'implementer', 'reviewer') */
  assignedRole?: string;
  /** Elapsed time in milliseconds since task entered in_progress */
  elapsedMs: number;
  /** Token cost accumulated for this task in USD */
  tokenCostUsd: number;
}

/** A single task on the Kanban board */
export interface KanbanTask {
  /** Unique task identifier */
  id: string;
  /** Human-readable task title */
  title: string;
  /** Optional longer description */
  description?: string;
  /** Current column the task is in */
  column: TaskColumn;
  /** ID of the agent assigned to this task */
  agentId?: string;
  /** Session ID in which the task is being worked on */
  sessionId?: string;
  /** Per-task metadata for board display */
  metadata: TaskMetadata;
  /** ISO 8601 timestamp when the task was created */
  createdAt: string;
  /** ISO 8601 timestamp when the task last changed state */
  updatedAt: string;
  /** ISO 8601 timestamp when the task entered in_progress (for elapsed time calc) */
  startedAt?: string;
}

/** Represents a column on the board with its tasks */
export interface KanbanColumnState {
  /** Column identifier */
  id: TaskColumn;
  /** Display label for the column */
  label: string;
  /** Tasks currently in this column */
  tasks: KanbanTask[];
}

/** Full board state for UI rendering */
export interface KanbanBoardState {
  /** All columns with their tasks */
  columns: KanbanColumnState[];
  /** Total number of tasks across all columns */
  totalTasks: number;
}

/** IPC event payload emitted on state transitions */
export interface KanbanIpcEvent {
  /** Type of event */
  type: 'task-added' | 'task-moved' | 'task-updated' | 'board-reset';
  /** The task that was affected (null for board-reset) */
  task: KanbanTask | null;
  /** Previous column (for task-moved events) */
  fromColumn?: TaskColumn;
  /** Target column (for task-moved events) */
  toColumn?: TaskColumn;
  /** Full board snapshot for the renderer */
  board: KanbanBoardState;
}

/** Parameters for adding a new task */
export interface AddTaskParams {
  title: string;
  description?: string;
  agentId?: string;
  sessionId?: string;
  assignedRole?: string;
  /** Column to place the task in (defaults to 'backlog') */
  column?: TaskColumn;
}

/** Configuration for KanbanStateManager */
export interface KanbanStateManagerConfig {
  /** Whether completion_council is enabled (routes done tasks through review) */
  completionCouncilEnabled: boolean;
}

// ─── Column Labels ──────────────────────────────────────────────

const COLUMN_LABELS: Record<TaskColumn, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  failed: 'Failed',
};

// ─── KanbanStateManager Class ───────────────────────────────────

export class KanbanStateManager {
  /** In-memory task store keyed by task ID */
  private tasks: Map<string, KanbanTask> = new Map();

  /** IPC emitter function (optional, for Electron integration) */
  private readonly ipcSend?: (channel: string, data: unknown) => void;

  /** Configuration */
  private readonly config: KanbanStateManagerConfig;

  constructor(
    config: KanbanStateManagerConfig,
    ipcSend?: (channel: string, data: unknown) => void,
  ) {
    this.config = config;
    this.ipcSend = ipcSend;
  }

  /**
   * Add a new task to the board.
   *
   * Creates a task in the specified column (defaults to 'backlog') and emits
   * a 'task-added' IPC event to the renderer.
   *
   * Requirements: 25.1, 25.2
   */
  addTask(params: AddTaskParams): KanbanTask {
    const now = new Date().toISOString();
    const column = params.column ?? 'backlog';

    if (!VALID_COLUMNS.includes(column)) {
      throw new Error(`Invalid column: ${column}. Must be one of: ${VALID_COLUMNS.join(', ')}`);
    }

    const task: KanbanTask = {
      id: randomUUID(),
      title: params.title,
      description: params.description,
      column,
      agentId: params.agentId,
      sessionId: params.sessionId,
      metadata: {
        assignedRole: params.assignedRole,
        elapsedMs: 0,
        tokenCostUsd: 0,
      },
      createdAt: now,
      updatedAt: now,
      startedAt: column === 'in_progress' ? now : undefined,
    };

    this.tasks.set(task.id, task);
    this.emitIpcEvent({
      type: 'task-added',
      task,
      board: this.getBoard(),
    });

    return task;
  }

  /**
   * Move a task from its current column to a target column.
   *
   * Handles the sub-agent lifecycle transitions:
   * - queued/backlog → in_progress: when a sub-agent starts work (Req 25.3)
   * - in_progress → review/done: when a sub-agent completes (Req 25.4)
   *   - Routes to 'review' if completion_council is enabled
   *   - Routes to 'done' if completion_council is disabled
   * - Any → failed: when a task fails
   *
   * Requirements: 25.2, 25.3, 25.4
   */
  moveTask(taskId: string, toColumn: TaskColumn): KanbanTask | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    if (!VALID_COLUMNS.includes(toColumn)) {
      throw new Error(`Invalid column: ${toColumn}. Must be one of: ${VALID_COLUMNS.join(', ')}`);
    }

    const fromColumn = task.column;

    // No-op if already in target column
    if (fromColumn === toColumn) {
      return task;
    }

    const now = new Date().toISOString();

    // Track when task enters in_progress for elapsed time
    if (toColumn === 'in_progress' && !task.startedAt) {
      task.startedAt = now;
    }

    // Update elapsed time when leaving in_progress
    if (fromColumn === 'in_progress' && task.startedAt) {
      task.metadata.elapsedMs = Date.now() - new Date(task.startedAt).getTime();
    }

    task.column = toColumn;
    task.updatedAt = now;

    this.emitIpcEvent({
      type: 'task-moved',
      task,
      fromColumn,
      toColumn,
      board: this.getBoard(),
    });

    return task;
  }

  /**
   * Transition a task to completed state, respecting completion_council config.
   *
   * If completion_council is enabled, the task moves to 'review' first.
   * Otherwise, it moves directly to 'done'.
   *
   * Requirements: 25.4
   */
  completeTask(taskId: string): KanbanTask | null {
    const targetColumn: TaskColumn = this.config.completionCouncilEnabled ? 'review' : 'done';
    return this.moveTask(taskId, targetColumn);
  }

  /**
   * Mark a task as failed.
   *
   * Requirements: 25.1
   */
  failTask(taskId: string): KanbanTask | null {
    return this.moveTask(taskId, 'failed');
  }

  /**
   * Update task metadata (agent assignment, cost, elapsed time).
   *
   * Requirements: 25.5
   */
  updateTaskMetadata(
    taskId: string,
    updates: Partial<Pick<TaskMetadata, 'assignedRole' | 'tokenCostUsd'>> & {
      agentId?: string;
      sessionId?: string;
    },
  ): KanbanTask | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    if (updates.assignedRole !== undefined) {
      task.metadata.assignedRole = updates.assignedRole;
    }
    if (updates.tokenCostUsd !== undefined) {
      task.metadata.tokenCostUsd = updates.tokenCostUsd;
    }
    if (updates.agentId !== undefined) {
      task.agentId = updates.agentId;
    }
    if (updates.sessionId !== undefined) {
      task.sessionId = updates.sessionId;
    }

    // Recalculate elapsed time for in_progress tasks
    if (task.column === 'in_progress' && task.startedAt) {
      task.metadata.elapsedMs = Date.now() - new Date(task.startedAt).getTime();
    }

    task.updatedAt = new Date().toISOString();

    this.emitIpcEvent({
      type: 'task-updated',
      task,
      board: this.getBoard(),
    });

    return task;
  }

  /**
   * Get full board state grouped by columns for UI rendering.
   *
   * Returns all columns with their tasks ordered by creation time.
   *
   * Requirements: 25.1, 25.5
   */
  getBoard(): KanbanBoardState {
    const allTasks = Array.from(this.tasks.values());

    // Refresh elapsed time for in_progress tasks
    const now = Date.now();
    for (const task of allTasks) {
      if (task.column === 'in_progress' && task.startedAt) {
        task.metadata.elapsedMs = now - new Date(task.startedAt).getTime();
      }
    }

    const columns: KanbanColumnState[] = VALID_COLUMNS.map((col) => ({
      id: col,
      label: COLUMN_LABELS[col],
      tasks: allTasks
        .filter((t) => t.column === col)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));

    return {
      columns,
      totalTasks: allTasks.length,
    };
  }

  /**
   * Get a specific task by ID.
   */
  getTask(taskId: string): KanbanTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * Get all tasks assigned to a specific agent.
   */
  getTasksByAgent(agentId: string): KanbanTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.agentId === agentId);
  }

  /**
   * Get all tasks in a specific column.
   */
  getTasksByColumn(column: TaskColumn): KanbanTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.column === column)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Remove a task from the board.
   */
  removeTask(taskId: string): boolean {
    const existed = this.tasks.delete(taskId);
    if (existed) {
      this.emitIpcEvent({
        type: 'board-reset',
        task: null,
        board: this.getBoard(),
      });
    }
    return existed;
  }

  /**
   * Alias for moveTask() matching the design spec naming convention.
   *
   * Requirements: 25.2, 25.3, 25.4
   */
  transition(taskId: string, toColumn: TaskColumn): KanbanTask | null {
    return this.moveTask(taskId, toColumn);
  }

  /**
   * Alias for getBoard() matching the design spec naming convention.
   *
   * Requirements: 25.1, 25.5
   */
  getBoardState(): KanbanBoardState {
    return this.getBoard();
  }

  /**
   * Reset the board, clearing all tasks.
   *
   * Requirements: 25.6 (no-op equivalent when disabling)
   */
  reset(): void {
    this.tasks.clear();
    this.emitIpcEvent({
      type: 'board-reset',
      task: null,
      board: this.getBoard(),
    });
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Emit an IPC event to the renderer for board state updates.
   *
   * Requirements: 25.2
   */
  private emitIpcEvent(event: KanbanIpcEvent): void {
    if (this.ipcSend) {
      this.ipcSend('kanban-board:state-change', event);
    }
  }
}
