/**
 * PTY Task Adapter — Integrates node-pty with the BackgroundTaskRegistry
 * for interactive terminal background tasks.
 *
 * When `pty: true` is specified in spawn options, this adapter uses node-pty
 * (or a provided PtySpawnFn) instead of `child_process.spawn`. It connects the
 * PTY output to the task's ring buffer AND forwards data to the terminal panel
 * via an IPC callback for live output display.
 *
 * Falls back gracefully if node-pty is not installed — returns an error indicating
 * PTY is unavailable and the caller should use standard spawn.
 *
 * Requirements: 15.8, 15.11, 15.12
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RingBuffer } from './background-task-registry.js';

// ─── Types ──────────────────────────────────────────────────────

/** Minimal PTY process interface (compatible with node-pty IPty) */
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  pid: number;
}

/** Factory function to spawn a PTY process */
export type PtySpawnFn = (
  shell: string,
  args: string[],
  options: { cols: number; rows: number; cwd?: string; env?: Record<string, string> },
) => PtyProcess;

/** Options for spawning a PTY task */
export interface PtyTaskOptions {
  /** Command to run */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables (merged with process.env) */
  env?: Record<string, string>;
  /** Session ID for scoping */
  sessionId?: string;
  /** Terminal columns (default: 120) */
  cols?: number;
  /** Terminal rows (default: 30) */
  rows?: number;
}

/** State of a PTY task */
export type PtyTaskState = 'running' | 'completed' | 'failed' | 'killed';

/** Record for a PTY task managed by the adapter */
export interface PtyTaskRecord {
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  state: PtyTaskState;
  pid: number | undefined;
  startTime: number;
  endTime: number | undefined;
  exitCode: number | undefined;
  sessionId: string;
}

/** IPC data callback for forwarding live PTY output to the renderer */
export type PtyOutputCallback = (channel: string, data: { taskId: string; output: string }) => void;

/** Configuration for the PTY task adapter */
export interface PtyTaskAdapterConfig {
  /** Ring buffer size for PTY output (default: 200 lines) */
  outputBufferSize: number;
  /** Default terminal columns */
  defaultCols: number;
  /** Default terminal rows */
  defaultRows: number;
}

/** Events emitted by the PTY task adapter */
export interface PtyTaskAdapterEvents {
  'pty-task:running': { taskId: string; pid: number };
  'pty-task:completed': { taskId: string; exitCode: number };
  'pty-task:failed': { taskId: string; exitCode: number };
  'pty-task:killed': { taskId: string };
  'pty-task:data': { taskId: string; data: string };
}

// ─── Default Config ─────────────────────────────────────────────

const DEFAULT_PTY_CONFIG: PtyTaskAdapterConfig = {
  outputBufferSize: 200,
  defaultCols: 120,
  defaultRows: 30,
};

// ─── PTY Availability Check ─────────────────────────────────────

/**
 * Attempt to load node-pty dynamically and return a spawn function.
 * Returns null if node-pty is not installed or cannot be loaded.
 */
export function loadNodePtySpawn(): PtySpawnFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePty = require('node-pty');
    return (shell: string, args: string[], options: { cols: number; rows: number; cwd?: string; env?: Record<string, string> }) => {
      return nodePty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
      });
    };
  } catch {
    return null;
  }
}

// ─── PTY Task Adapter ───────────────────────────────────────────

/**
 * Manages PTY-based background tasks as an extension to the BackgroundTaskRegistry.
 *
 * When a task requires PTY (interactive terminal features), this adapter:
 * 1. Spawns through node-pty instead of child_process
 * 2. Feeds output to a ring buffer (accessible via getOutput)
 * 3. Forwards live output via IPC to the terminal panel in the renderer
 * 4. Emits lifecycle events compatible with the registry pattern
 */
export class PtyTaskAdapter extends EventEmitter {
  private tasks: Map<string, PtyTaskRecord> = new Map();
  private processes: Map<string, PtyProcess> = new Map();
  private outputBuffers: Map<string, RingBuffer> = new Map();
  private disposables: Map<string, Array<{ dispose: () => void }>> = new Map();
  private spawnPty: PtySpawnFn | null;
  private ipcCallback: PtyOutputCallback | null;
  private config: PtyTaskAdapterConfig;

  constructor(
    spawnPty?: PtySpawnFn | null,
    ipcCallback?: PtyOutputCallback | null,
    config?: Partial<PtyTaskAdapterConfig>,
  ) {
    super();
    this.spawnPty = spawnPty ?? loadNodePtySpawn();
    this.ipcCallback = ipcCallback ?? null;
    this.config = { ...DEFAULT_PTY_CONFIG, ...config };
  }

  /**
   * Check if PTY support is available (node-pty is loaded).
   */
  isAvailable(): boolean {
    return this.spawnPty !== null;
  }

  /**
   * Spawn a new PTY background task.
   *
   * Returns the taskId on success. Throws if PTY is not available.
   */
  spawn(opts: PtyTaskOptions): string {
    if (!this.spawnPty) {
      throw new PtyUnavailableError(
        'node-pty is not available. Install node-pty for PTY task support, ' +
        'or use standard background tasks without pty: true.',
      );
    }

    const taskId = randomUUID();
    const sessionId = opts.sessionId || 'default';
    const cwd = opts.cwd || process.cwd();
    const args = opts.args || [];
    const cols = opts.cols || this.config.defaultCols;
    const rows = opts.rows || this.config.defaultRows;

    const record: PtyTaskRecord = {
      taskId,
      command: opts.command,
      args,
      cwd,
      state: 'running',
      pid: undefined,
      startTime: Date.now(),
      endTime: undefined,
      exitCode: undefined,
      sessionId,
    };

    this.tasks.set(taskId, record);
    this.outputBuffers.set(taskId, new RingBuffer(this.config.outputBufferSize));

    try {
      const pty = this.spawnPty(opts.command, args, {
        cols,
        rows,
        cwd,
        env: { ...process.env, ...opts.env } as Record<string, string>,
      });

      this.processes.set(taskId, pty);
      record.pid = pty.pid;

      const disposers: Array<{ dispose: () => void }> = [];

      // Wire PTY data to ring buffer and IPC
      const dataDisposable = pty.onData((data: string) => {
        const buf = this.outputBuffers.get(taskId);
        if (buf) {
          // Split into lines for the ring buffer
          const lines = data.split('\n');
          for (const line of lines) {
            if (line.length > 0) {
              buf.push(line);
            }
          }
        }

        // Emit data event for consumers
        this.emit('pty-task:data', { taskId, data });

        // Forward to renderer terminal panel via IPC
        if (this.ipcCallback) {
          this.ipcCallback('pty-task:output', { taskId, output: data });
        }
      });
      disposers.push(dataDisposable);

      // Handle PTY exit
      const exitDisposable = pty.onExit((e: { exitCode: number; signal?: number }) => {
        record.endTime = Date.now();
        record.exitCode = e.exitCode;

        if (record.state === 'killed') {
          // Already marked killed via killTask
          return;
        }

        if (e.exitCode === 0) {
          record.state = 'completed';
          this.emit('pty-task:completed', { taskId, exitCode: 0 });
        } else {
          record.state = 'failed';
          this.emit('pty-task:failed', { taskId, exitCode: e.exitCode });
        }
      });
      disposers.push(exitDisposable);

      this.disposables.set(taskId, disposers);

      this.emit('pty-task:running', { taskId, pid: pty.pid });
    } catch (err: unknown) {
      record.state = 'failed';
      record.endTime = Date.now();
      const msg = err instanceof Error ? err.message : 'Unknown PTY spawn error';
      this.emit('pty-task:failed', { taskId, exitCode: 1 });
      throw new Error(`Failed to spawn PTY task: ${msg}`);
    }

    return taskId;
  }

  /**
   * Get the record for a PTY task by ID.
   */
  getTask(taskId: string): PtyTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get the output buffer lines for a PTY task.
   */
  getOutput(taskId: string): string[] | undefined {
    const buf = this.outputBuffers.get(taskId);
    return buf?.getLines();
  }

  /**
   * Write data to a running PTY task (for interactive input).
   */
  write(taskId: string, data: string): boolean {
    const pty = this.processes.get(taskId);
    if (!pty) return false;

    const record = this.tasks.get(taskId);
    if (!record || record.state !== 'running') return false;

    pty.write(data);
    return true;
  }

  /**
   * Resize a PTY task's terminal dimensions.
   */
  resize(taskId: string, cols: number, rows: number): boolean {
    const pty = this.processes.get(taskId);
    if (!pty) return false;

    const record = this.tasks.get(taskId);
    if (!record || record.state !== 'running') return false;

    pty.resize(cols, rows);
    return true;
  }

  /**
   * Kill a running PTY task.
   */
  kill(taskId: string): boolean {
    const record = this.tasks.get(taskId);
    if (!record) return false;

    if (record.state !== 'running') return false;

    const pty = this.processes.get(taskId);
    if (pty) {
      record.state = 'killed';
      record.endTime = Date.now();
      try {
        pty.kill();
      } catch {
        // PTY may already be dead
      }
      this.emit('pty-task:killed', { taskId });
    }

    // Cleanup disposables
    const disposers = this.disposables.get(taskId);
    if (disposers) {
      for (const d of disposers) {
        try { d.dispose(); } catch { /* ignore */ }
      }
      this.disposables.delete(taskId);
    }

    return true;
  }

  /**
   * List all PTY tasks, optionally filtered by session.
   */
  listTasks(sessionId?: string): PtyTaskRecord[] {
    const all = Array.from(this.tasks.values());
    if (sessionId) {
      return all.filter((t) => t.sessionId === sessionId);
    }
    return all;
  }

  /**
   * Kill all running PTY tasks and clean up resources.
   */
  dispose(): void {
    for (const [taskId] of this.tasks) {
      this.kill(taskId);
    }
    this.tasks.clear();
    this.processes.clear();
    this.outputBuffers.clear();
    this.disposables.clear();
  }
}

// ─── Error Types ────────────────────────────────────────────────

/**
 * Error thrown when PTY support is requested but node-pty is not available.
 */
export class PtyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtyUnavailableError';
  }
}
