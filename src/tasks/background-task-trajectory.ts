/**
 * Background Task Trajectory — Records background-task lifecycle events
 * as trajectory entries for session replay and standing validation.
 *
 * Responsibilities:
 *   - Record spawn, completion, failure, kill, and checkpoint events
 *   - Store trajectory as a serializable JSON array per session
 *   - Support replay without live processes (entries contain full state)
 *   - Provide getTrajectory and exportTrajectory methods
 *
 * Requirements: 15.16, 29.1
 */

import type { TaskState } from './background-task-registry.js';

// ─── Types ──────────────────────────────────────────────────────

/** Event recorded when a background task spawns */
export interface TrajectorySpawnEvent {
  type: 'task:spawn';
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  sessionId: string;
  timestamp: number;
}

/** Event recorded when a background task reaches a terminal state */
export interface TrajectoryCompletionEvent {
  type: 'task:completed' | 'task:failed' | 'task:killed';
  taskId: string;
  exitCode: number | undefined;
  timestamp: number;
  outputTail: string[];
}

/** Event recorded at each Loop pass boundary (checkpoint) */
export interface TrajectoryCheckpointEvent {
  type: 'task:checkpoint';
  taskId: string;
  state: TaskState;
  outputTail: string[];
  timestamp: number;
}

/** Union type for all trajectory events */
export type TrajectoryEvent =
  | TrajectorySpawnEvent
  | TrajectoryCompletionEvent
  | TrajectoryCheckpointEvent;

/** Exported trajectory for a session */
export interface ExportedTrajectory {
  sessionId: string;
  events: TrajectoryEvent[];
  exportedAt: number;
  version: 1;
}

/** Replay state derived from trajectory events without live processes */
export interface ReplayedTaskState {
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  state: TaskState;
  exitCode: number | undefined;
  lastOutputTail: string[];
  checkpointCount: number;
}

// ─── Configuration ──────────────────────────────────────────────

export interface TrajectoryRecorderConfig {
  /** Maximum output tail lines to store per event (default: 20) */
  maxOutputTailLines: number;
}

const DEFAULT_CONFIG: TrajectoryRecorderConfig = {
  maxOutputTailLines: 20,
};

// ─── Trajectory Recorder ────────────────────────────────────────

/**
 * Records background-task lifecycle events as trajectory entries.
 *
 * Each session maintains an independent event log. Events are stored
 * in memory and can be exported as JSON for replay or validation.
 *
 * Replay support: Trajectory entries contain all information needed to
 * reconstruct task state transitions without live processes.
 */
export class BackgroundTaskTrajectoryRecorder {
  private trajectories: Map<string, TrajectoryEvent[]> = new Map();
  private config: TrajectoryRecorderConfig;

  constructor(config: Partial<TrajectoryRecorderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a task spawn event.
   */
  recordSpawn(params: {
    taskId: string;
    command: string;
    args: string[];
    cwd: string;
    sessionId: string;
    timestamp?: number;
  }): void {
    const event: TrajectorySpawnEvent = {
      type: 'task:spawn',
      taskId: params.taskId,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      sessionId: params.sessionId,
      timestamp: params.timestamp ?? Date.now(),
    };

    this.appendEvent(params.sessionId, event);
  }

  /**
   * Record a task completion event (completed, failed, or killed).
   */
  recordCompletion(params: {
    taskId: string;
    sessionId: string;
    type: 'task:completed' | 'task:failed' | 'task:killed';
    exitCode: number | undefined;
    outputTail: string[];
    timestamp?: number;
  }): void {
    const event: TrajectoryCompletionEvent = {
      type: params.type,
      taskId: params.taskId,
      exitCode: params.exitCode,
      outputTail: this.trimOutputTail(params.outputTail),
      timestamp: params.timestamp ?? Date.now(),
    };

    this.appendEvent(params.sessionId, event);
  }

  /**
   * Record a checkpoint event at a Loop pass boundary.
   */
  recordCheckpoint(params: {
    taskId: string;
    sessionId: string;
    state: TaskState;
    outputTail: string[];
    timestamp?: number;
  }): void {
    const event: TrajectoryCheckpointEvent = {
      type: 'task:checkpoint',
      taskId: params.taskId,
      state: params.state,
      outputTail: this.trimOutputTail(params.outputTail),
      timestamp: params.timestamp ?? Date.now(),
    };

    this.appendEvent(params.sessionId, event);
  }

  /**
   * Get the raw trajectory events for a session.
   * Returns an empty array if no events have been recorded.
   */
  getTrajectory(sessionId: string): TrajectoryEvent[] {
    return this.trajectories.get(sessionId) ?? [];
  }

  /**
   * Export a session's trajectory as a serializable JSON object.
   * Suitable for persistence, validation, and replay.
   */
  exportTrajectory(sessionId: string): ExportedTrajectory {
    return {
      sessionId,
      events: this.getTrajectory(sessionId),
      exportedAt: Date.now(),
      version: 1,
    };
  }

  /**
   * Replay a trajectory to reconstruct task states without live processes.
   * Processes events in order and produces the final state of each task.
   */
  static replayTrajectory(events: TrajectoryEvent[]): Map<string, ReplayedTaskState> {
    const states = new Map<string, ReplayedTaskState>();

    for (const event of events) {
      switch (event.type) {
        case 'task:spawn': {
          states.set(event.taskId, {
            taskId: event.taskId,
            command: event.command,
            args: event.args,
            cwd: event.cwd,
            state: 'running',
            exitCode: undefined,
            lastOutputTail: [],
            checkpointCount: 0,
          });
          break;
        }

        case 'task:completed':
        case 'task:failed':
        case 'task:killed': {
          const existing = states.get(event.taskId);
          if (existing) {
            existing.state = event.type === 'task:completed'
              ? 'completed'
              : event.type === 'task:failed'
                ? 'failed'
                : 'killed';
            existing.exitCode = event.exitCode;
            existing.lastOutputTail = event.outputTail;
          }
          break;
        }

        case 'task:checkpoint': {
          const existing = states.get(event.taskId);
          if (existing) {
            existing.state = event.state;
            existing.lastOutputTail = event.outputTail;
            existing.checkpointCount++;
          }
          break;
        }
      }
    }

    return states;
  }

  /**
   * Clear trajectory data for a session. Used during session cleanup.
   */
  clearSession(sessionId: string): void {
    this.trajectories.delete(sessionId);
  }

  /**
   * Get all session IDs that have trajectory data.
   */
  getSessionIds(): string[] {
    return Array.from(this.trajectories.keys());
  }

  // ─── Private ────────────────────────────────────────────────────

  private appendEvent(sessionId: string, event: TrajectoryEvent): void {
    let events = this.trajectories.get(sessionId);
    if (!events) {
      events = [];
      this.trajectories.set(sessionId, events);
    }
    events.push(event);
  }

  private trimOutputTail(lines: string[]): string[] {
    if (lines.length <= this.config.maxOutputTailLines) {
      return [...lines];
    }
    return lines.slice(-this.config.maxOutputTailLines);
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let defaultInstance: BackgroundTaskTrajectoryRecorder | null = null;

/**
 * Get or create the default BackgroundTaskTrajectoryRecorder instance.
 */
export function getTrajectoryRecorder(
  config?: Partial<TrajectoryRecorderConfig>,
): BackgroundTaskTrajectoryRecorder {
  if (!defaultInstance) {
    defaultInstance = new BackgroundTaskTrajectoryRecorder(config);
  }
  return defaultInstance;
}

/**
 * Reset the singleton (for testing purposes only).
 */
export function resetTrajectoryRecorder(): void {
  defaultInstance = null;
}
