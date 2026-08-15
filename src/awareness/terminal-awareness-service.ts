/**
 * TerminalAwarenessService — Surfaces terminal state scoped to a workspace.
 *
 * Tracks terminal processes (PID, command, status), recent commands with exit codes,
 * working directories per terminal, and provides bounded output. All state is scoped
 * to a specific workspace — terminal sessions belong to a workspace, not global state.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7
 */

// ─── Types ──────────────────────────────────────────────────────

/** Status of a terminal process */
export type TerminalProcessStatus = 'running' | 'exited' | 'killed' | 'unknown';

/** A tracked terminal process */
export interface TerminalProcess {
  /** Process ID */
  pid: number;
  /** Command that was executed */
  command: string;
  /** Current status */
  status: TerminalProcessStatus;
  /** Exit code (null if still running) */
  exitCode: number | null;
  /** Working directory of the process */
  cwd: string;
  /** Timestamp when the process started */
  startedAt: string;
  /** Timestamp when the process exited (null if still running) */
  exitedAt: string | null;
  /** Workspace this process belongs to */
  workspaceId: string;
}

/** A recorded command execution */
export interface CommandRecord {
  /** Unique record ID */
  id: string;
  /** Command string that was executed */
  command: string;
  /** Exit code */
  exitCode: number;
  /** Working directory at time of execution */
  cwd: string;
  /** Timestamp when command started */
  startedAt: string;
  /** Timestamp when command completed */
  completedAt: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Bounded output (truncated to max lines) */
  output: string;
  /** Whether output was truncated */
  outputTruncated: boolean;
  /** Workspace this command belongs to */
  workspaceId: string;
}

/** Configuration for the TerminalAwarenessService */
export interface TerminalAwarenessConfig {
  /** Maximum number of output lines to retain per command (default: 200) */
  maxOutputLines: number;
  /** Maximum number of recent commands to track (default: 50) */
  maxRecentCommands: number;
  /** Maximum number of processes to track (default: 100) */
  maxTrackedProcesses: number;
}

/** Complete terminal state snapshot for a workspace */
export interface TerminalState {
  /** Workspace ID this state is bound to */
  workspaceId: string;
  /** Currently tracked processes */
  processes: TerminalProcess[];
  /** Number of running processes */
  runningCount: number;
  /** Recent command records */
  recentCommands: CommandRecord[];
  /** Distinct working directories across active terminals */
  workingDirectories: string[];
  /** Timestamp when this state was captured */
  capturedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_LINES = 200;
const DEFAULT_MAX_RECENT_COMMANDS = 50;
const DEFAULT_MAX_TRACKED_PROCESSES = 100;

// ─── TerminalAwarenessService ───────────────────────────────────

/**
 * Service that surfaces terminal awareness state scoped to a specific workspace.
 * Tracks terminal processes, recent commands, exit codes, and bounded output.
 * All state belongs to the workspace — never exposes global terminal state.
 */
export class TerminalAwarenessService {
  private workspaceId: string;
  private config: TerminalAwarenessConfig;
  private processes: Map<number, TerminalProcess> = new Map();
  private recentCommands: CommandRecord[] = [];
  private commandIdCounter = 0;

  constructor(workspaceId: string, config?: Partial<TerminalAwarenessConfig>) {
    this.workspaceId = workspaceId;
    this.config = {
      maxOutputLines: config?.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES,
      maxRecentCommands: config?.maxRecentCommands ?? DEFAULT_MAX_RECENT_COMMANDS,
      maxTrackedProcesses: config?.maxTrackedProcesses ?? DEFAULT_MAX_TRACKED_PROCESSES,
    };
  }

  /** Get the workspace ID this service is bound to */
  getWorkspaceId(): string {
    return this.workspaceId;
  }

  /** Get the configuration */
  getConfig(): Readonly<TerminalAwarenessConfig> {
    return { ...this.config };
  }

  // ─── Process Tracking ───────────────────────────────────────────

  /**
   * Register a terminal process for tracking.
   * The process is scoped to this service's workspace.
   */
  trackProcess(pid: number, command: string, cwd: string): TerminalProcess {
    // Evict oldest exited processes if at capacity
    if (this.processes.size >= this.config.maxTrackedProcesses) {
      this.evictOldestExitedProcess();
    }

    const process: TerminalProcess = {
      pid,
      command,
      status: 'running',
      exitCode: null,
      cwd,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      workspaceId: this.workspaceId,
    };

    this.processes.set(pid, process);
    return process;
  }

  /**
   * Update a process's status when it exits.
   */
  markProcessExited(pid: number, exitCode: number): boolean {
    const process = this.processes.get(pid);
    if (!process) return false;

    process.status = 'exited';
    process.exitCode = exitCode;
    process.exitedAt = new Date().toISOString();
    return true;
  }

  /**
   * Update a process's status when it's killed.
   */
  markProcessKilled(pid: number): boolean {
    const process = this.processes.get(pid);
    if (!process) return false;

    process.status = 'killed';
    process.exitCode = null;
    process.exitedAt = new Date().toISOString();
    return true;
  }

  /**
   * Get a tracked process by PID.
   */
  getProcess(pid: number): TerminalProcess | undefined {
    return this.processes.get(pid);
  }

  /**
   * Get all tracked processes for this workspace.
   */
  getProcesses(): TerminalProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get only running processes.
   */
  getRunningProcesses(): TerminalProcess[] {
    return Array.from(this.processes.values()).filter(p => p.status === 'running');
  }

  /**
   * Remove a process from tracking.
   */
  removeProcess(pid: number): boolean {
    return this.processes.delete(pid);
  }

  // ─── Command Recording ──────────────────────────────────────────

  /**
   * Record a completed command execution.
   * Output is bounded to the configured maximum lines.
   */
  recordCommand(
    command: string,
    exitCode: number,
    cwd: string,
    startedAt: string,
    completedAt: string,
    output: string,
  ): CommandRecord {
    this.commandIdCounter++;
    const id = `cmd-${this.workspaceId}-${this.commandIdCounter}`;

    const { bounded, truncated } = this.boundOutput(output);

    const startTime = new Date(startedAt).getTime();
    const endTime = new Date(completedAt).getTime();
    const durationMs = Math.max(0, endTime - startTime);

    const record: CommandRecord = {
      id,
      command,
      exitCode,
      cwd,
      startedAt,
      completedAt,
      durationMs,
      output: bounded,
      outputTruncated: truncated,
      workspaceId: this.workspaceId,
    };

    this.recentCommands.push(record);

    // Evict oldest commands if over the limit
    while (this.recentCommands.length > this.config.maxRecentCommands) {
      this.recentCommands.shift();
    }

    return record;
  }

  /**
   * Get recent command records.
   * @param limit - Maximum number of records to return (defaults to all)
   */
  getRecentCommands(limit?: number): CommandRecord[] {
    if (limit === undefined || limit >= this.recentCommands.length) {
      return [...this.recentCommands];
    }
    return this.recentCommands.slice(-limit);
  }

  /**
   * Get the last N commands that exited with a non-zero code.
   */
  getFailedCommands(limit = 10): CommandRecord[] {
    return this.recentCommands
      .filter(c => c.exitCode !== 0)
      .slice(-limit);
  }

  /**
   * Get a specific command record by ID.
   */
  getCommand(id: string): CommandRecord | undefined {
    return this.recentCommands.find(c => c.id === id);
  }

  // ─── Working Directory Tracking ─────────────────────────────────

  /**
   * Get all distinct working directories across tracked processes.
   */
  getWorkingDirectories(): string[] {
    const dirs = new Set<string>();
    for (const process of this.processes.values()) {
      dirs.add(process.cwd);
    }
    return Array.from(dirs);
  }

  // ─── State Snapshot ─────────────────────────────────────────────

  /**
   * Get a complete terminal state snapshot for this workspace.
   */
  getState(): TerminalState {
    const processes = this.getProcesses();
    const runningCount = processes.filter(p => p.status === 'running').length;

    return {
      workspaceId: this.workspaceId,
      processes,
      runningCount,
      recentCommands: [...this.recentCommands],
      workingDirectories: this.getWorkingDirectories(),
      capturedAt: new Date().toISOString(),
    };
  }

  // ─── Bounded Output ─────────────────────────────────────────────

  /**
   * Bound output to the configured max lines.
   * Returns the bounded output and whether it was truncated.
   */
  boundOutput(output: string): { bounded: string; truncated: boolean } {
    if (!output) return { bounded: '', truncated: false };

    const lines = output.split('\n');
    if (lines.length <= this.config.maxOutputLines) {
      return { bounded: output, truncated: false };
    }

    const bounded = lines.slice(-this.config.maxOutputLines).join('\n');
    return { bounded, truncated: true };
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  /**
   * Clear all tracked state.
   */
  clear(): void {
    this.processes.clear();
    this.recentCommands = [];
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private evictOldestExitedProcess(): void {
    let oldestExitedPid: number | null = null;
    let oldestTime = Infinity;

    for (const [pid, process] of this.processes) {
      if (process.status !== 'running' && process.exitedAt) {
        const exitTime = new Date(process.exitedAt).getTime();
        if (exitTime < oldestTime) {
          oldestTime = exitTime;
          oldestExitedPid = pid;
        }
      }
    }

    if (oldestExitedPid !== null) {
      this.processes.delete(oldestExitedPid);
    } else {
      // If no exited processes, remove the oldest running one
      let oldestRunningPid: number | null = null;
      let oldestRunTime = Infinity;
      for (const [pid, process] of this.processes) {
        const startTime = new Date(process.startedAt).getTime();
        if (startTime < oldestRunTime) {
          oldestRunTime = startTime;
          oldestRunningPid = pid;
        }
      }
      if (oldestRunningPid !== null) {
        this.processes.delete(oldestRunningPid);
      }
    }
  }
}
