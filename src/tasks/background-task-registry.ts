/**
 * Background Task Registry — manages lifecycle of shell commands and subagent
 * tasks running in the background during agent sessions.
 *
 * Responsibilities:
 *   - Assign unique UUID-based taskId to each registered task
 *   - Enforce a configurable concurrent-task cap (default 8 per session)
 *   - Track task states: pending → running → completed/failed/killed
 *   - Maintain ring buffers per task: last 200 lines stdout, last 50 lines stderr
 *   - Emit lifecycle events for notification integration
 *   - Provide APIs: spawn, getTask, listTasks, killTask, getOutput, waitTask
 *
 * Requirements: 15.1, 15.3, 15.5, 15.11
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

/** Possible states for a background task */
export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

/** Options for spawning a background task */
export interface SpawnOptions {
  /** Working directory */
  cwd?: string;
  /** Environment variables (merged with process.env) */
  env?: Record<string, string>;
  /** Session ID for scoping concurrency limits */
  sessionId?: string;
}

/** Metadata stored for each background task */
export interface TaskRecord {
  /** Unique task identifier */
  taskId: string;
  /** Command that was executed */
  command: string;
  /** Arguments passed to the command */
  args: string[];
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Current lifecycle state */
  state: TaskState;
  /** Process ID (set once running) */
  pid: number | undefined;
  /** When the task was started */
  startTime: number;
  /** When the task completed/failed/killed (undefined if still active) */
  endTime: number | undefined;
  /** Exit code (undefined if not yet exited) */
  exitCode: number | undefined;
  /** Session scope for concurrency limits */
  sessionId: string;
}

/** Output snapshot from a task's ring buffers */
export interface TaskOutput {
  /** Last N lines of stdout (up to 200) */
  stdout: string[];
  /** Last N lines of stderr (up to 50) */
  stderr: string[];
}

/** Events emitted by the registry on state transitions */
export interface TaskRegistryEvents {
  'task:spawned': { taskId: string; command: string; sessionId: string };
  'task:running': { taskId: string; pid: number };
  'task:completed': { taskId: string; exitCode: number };
  'task:failed': { taskId: string; error: string };
  'task:killed': { taskId: string };
}

/** Result from waitTask */
export interface WaitResult {
  taskId: string;
  state: TaskState;
  exitCode: number | undefined;
}

/** Configuration for the task registry */
export interface TaskRegistryConfig {
  /** Maximum concurrent running tasks (default: 8) */
  maxConcurrent: number;
  /** Maximum stdout ring buffer lines (default: 200) */
  stdoutBufferSize: number;
  /** Maximum stderr ring buffer lines (default: 50) */
  stderrBufferSize: number;
}

// ─── Ring Buffer ────────────────────────────────────────────────

/**
 * Fixed-capacity ring buffer for storing the most recent N lines.
 * Overwrites the oldest entry when capacity is reached.
 */
export class RingBuffer {
  private buffer: string[];
  private head: number = 0;
  private count: number = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('RingBuffer capacity must be positive');
    }
    this.capacity = capacity;
    this.buffer = new Array(capacity).fill('');
  }

  /** Push a new line into the buffer, evicting the oldest if full */
  push(line: string): void {
    this.buffer[this.head] = line;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Get all stored lines in insertion order (oldest first) */
  getLines(): string[] {
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Buffer is full: oldest is at head, wrap around
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  /** Current number of stored lines */
  size(): number {
    return this.count;
  }

  /** Clear all stored lines */
  clear(): void {
    this.buffer = new Array(this.capacity).fill('');
    this.head = 0;
    this.count = 0;
  }
}

// ─── Default Config ─────────────────────────────────────────────

const DEFAULT_CONFIG: TaskRegistryConfig = {
  maxConcurrent: 8,
  stdoutBufferSize: 200,
  stderrBufferSize: 50,
};

// ─── Background Task Registry ───────────────────────────────────

/**
 * Central registry for background shell processes.
 *
 * Emits typed events on state transitions for integration with
 * notification and conversation systems.
 */
export class BackgroundTaskRegistry extends EventEmitter {
  private tasks: Map<string, TaskRecord> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private stdoutBuffers: Map<string, RingBuffer> = new Map();
  private stderrBuffers: Map<string, RingBuffer> = new Map();
  private config: TaskRegistryConfig;

  constructor(config: Partial<TaskRegistryConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Spawn a new background task.
   *
   * Rejects if the concurrent-task limit is reached for the session.
   * Returns a unique taskId on success.
   */
  spawn(command: string, args: string[] = [], opts: SpawnOptions = {}): string {
    const sessionId = opts.sessionId || 'default';
    const runningCount = this.getRunningCount(sessionId);

    if (runningCount >= this.config.maxConcurrent) {
      throw new TaskCapError(
        `Concurrent task limit reached (${this.config.maxConcurrent}). ` +
          `Active tasks: ${runningCount}. Kill or wait for a task to finish before spawning more.`,
        this.config.maxConcurrent,
        runningCount,
      );
    }

    const taskId = randomUUID();
    const cwd = opts.cwd || process.cwd();
    const env = opts.env || {};

    const record: TaskRecord = {
      taskId,
      command,
      args,
      cwd,
      env,
      state: 'pending',
      pid: undefined,
      startTime: Date.now(),
      endTime: undefined,
      exitCode: undefined,
      sessionId,
    };

    this.tasks.set(taskId, record);
    this.stdoutBuffers.set(taskId, new RingBuffer(this.config.stdoutBufferSize));
    this.stderrBuffers.set(taskId, new RingBuffer(this.config.stderrBufferSize));

    // Spawn the process
    try {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      this.processes.set(taskId, child);
      record.pid = child.pid;
      record.state = 'running';

      this.emit('task:spawned', { taskId, command, sessionId });
      if (child.pid !== undefined) {
        this.emit('task:running', { taskId, pid: child.pid });
      }

      // Wire stdout ring buffer
      child.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        const buf = this.stdoutBuffers.get(taskId);
        if (buf) {
          for (const line of lines) {
            // Only push non-empty lines (split produces trailing empty)
            if (line.length > 0) {
              buf.push(line);
            }
          }
        }
      });

      // Wire stderr ring buffer
      child.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        const buf = this.stderrBuffers.get(taskId);
        if (buf) {
          for (const line of lines) {
            if (line.length > 0) {
              buf.push(line);
            }
          }
        }
      });

      // Handle process exit
      child.on('exit', (code, signal) => {
        record.endTime = Date.now();
        record.exitCode = code ?? undefined;

        if (record.state === 'killed') {
          // Already marked as killed via killTask
          return;
        }

        if (code === 0) {
          record.state = 'completed';
          this.emit('task:completed', { taskId, exitCode: 0 });
        } else {
          record.state = 'failed';
          record.exitCode = code ?? 1;
          this.emit('task:failed', {
            taskId,
            error: signal ? `Signal: ${signal}` : `Exit code: ${code}`,
          });
        }
      });

      // Handle spawn errors
      child.on('error', (err: Error) => {
        record.endTime = Date.now();
        record.state = 'failed';
        this.emit('task:failed', { taskId, error: err.message });
      });
    } catch (err: unknown) {
      record.state = 'failed';
      record.endTime = Date.now();
      const msg = err instanceof Error ? err.message : 'Unknown spawn error';
      this.emit('task:failed', { taskId, error: msg });
    }

    return taskId;
  }

  /**
   * Get the record for a task by ID.
   * Returns undefined if the task doesn't exist.
   */
  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * List all tasks, optionally filtered by session.
   */
  listTasks(sessionId?: string): TaskRecord[] {
    const all = Array.from(this.tasks.values());
    if (sessionId) {
      return all.filter((t) => t.sessionId === sessionId);
    }
    return all;
  }

  /**
   * Kill a running task. Sends SIGTERM first, then SIGKILL after grace period.
   */
  async killTask(taskId: string, gracePeriodMs: number = 5000): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (record.state !== 'running' && record.state !== 'pending') {
      // Already in a terminal state
      return;
    }

    const child = this.processes.get(taskId);
    if (!child) {
      record.state = 'killed';
      record.endTime = Date.now();
      this.emit('task:killed', { taskId });
      return;
    }

    record.state = 'killed';
    record.endTime = Date.now();

    // Attempt graceful termination
    child.kill('SIGTERM');

    // Wait for graceful exit or force kill
    const forceKill = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process may have already exited
        }
        resolve();
      }, gracePeriodMs);

      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await forceKill;
    this.emit('task:killed', { taskId });
  }

  /**
   * Get the output ring buffers for a task.
   */
  getOutput(taskId: string): TaskOutput | undefined {
    const stdoutBuf = this.stdoutBuffers.get(taskId);
    const stderrBuf = this.stderrBuffers.get(taskId);

    if (!stdoutBuf || !stderrBuf) {
      return undefined;
    }

    return {
      stdout: stdoutBuf.getLines(),
      stderr: stderrBuf.getLines(),
    };
  }

  /**
   * Wait for a task to reach a terminal state.
   * Returns the final state and exit code.
   * Rejects with timeout error if the task doesn't complete within timeoutMs.
   */
  waitTask(taskId: string, timeoutMs: number = 30_000): Promise<WaitResult> {
    const record = this.tasks.get(taskId);
    if (!record) {
      return Promise.reject(new Error(`Task not found: ${taskId}`));
    }

    // Already terminal
    if (record.state === 'completed' || record.state === 'failed' || record.state === 'killed') {
      return Promise.resolve({
        taskId,
        state: record.state,
        exitCode: record.exitCode,
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for task ${taskId} after ${timeoutMs}ms`));
      }, timeoutMs);

      const onCompleted = (evt: { taskId: string; exitCode: number }) => {
        if (evt.taskId === taskId) {
          cleanup();
          resolve({ taskId, state: 'completed', exitCode: evt.exitCode });
        }
      };

      const onFailed = (evt: { taskId: string }) => {
        if (evt.taskId === taskId) {
          cleanup();
          const rec = this.tasks.get(taskId);
          resolve({ taskId, state: 'failed', exitCode: rec?.exitCode });
        }
      };

      const onKilled = (evt: { taskId: string }) => {
        if (evt.taskId === taskId) {
          cleanup();
          resolve({ taskId, state: 'killed', exitCode: undefined });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off('task:completed', onCompleted);
        this.off('task:failed', onFailed);
        this.off('task:killed', onKilled);
      };

      this.on('task:completed', onCompleted);
      this.on('task:failed', onFailed);
      this.on('task:killed', onKilled);
    });
  }

  /**
   * Get the count of running tasks for a given session.
   */
  getRunningCount(sessionId: string = 'default'): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (record.sessionId === sessionId && (record.state === 'running' || record.state === 'pending')) {
        count++;
      }
    }
    return count;
  }

  /**
   * Kill all running tasks for a session (used on terminal states and crash recovery).
   */
  async killAll(sessionId?: string): Promise<void> {
    const targets = this.listTasks(sessionId).filter(
      (t) => t.state === 'running' || t.state === 'pending',
    );
    await Promise.allSettled(targets.map((t) => this.killTask(t.taskId)));
  }

  /**
   * Remove all records for terminated tasks (garbage collection).
   */
  cleanup(sessionId?: string): void {
    const terminalStates: TaskState[] = ['completed', 'failed', 'killed'];
    for (const [id, record] of this.tasks) {
      if (sessionId && record.sessionId !== sessionId) continue;
      if (terminalStates.includes(record.state)) {
        this.tasks.delete(id);
        this.processes.delete(id);
        this.stdoutBuffers.delete(id);
        this.stderrBuffers.delete(id);
      }
    }
  }
}

// ─── Error Types ────────────────────────────────────────────────

/**
 * Error thrown when the concurrent task cap is reached.
 * Provides actionable information about the limit and current count.
 */
export class TaskCapError extends Error {
  readonly maxConcurrent: number;
  readonly activeCount: number;

  constructor(message: string, maxConcurrent: number, activeCount: number) {
    super(message);
    this.name = 'TaskCapError';
    this.maxConcurrent = maxConcurrent;
    this.activeCount = activeCount;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let defaultInstance: BackgroundTaskRegistry | null = null;

/**
 * Get or create the default BackgroundTaskRegistry instance.
 */
export function getBackgroundTaskRegistry(config?: Partial<TaskRegistryConfig>): BackgroundTaskRegistry {
  if (!defaultInstance) {
    defaultInstance = new BackgroundTaskRegistry(config);
  }
  return defaultInstance;
}

/**
 * Reset the singleton (for testing purposes only).
 */
export function resetBackgroundTaskRegistry(): void {
  defaultInstance = null;
}
