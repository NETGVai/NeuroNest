/**
 * Background Process Manager
 *
 * Manages long-running background processes (dev servers, watchers, test runners)
 * that persist across agent message turns. Tracks process lifecycle, captures output,
 * detects port conflicts, and exposes status as agent context.
 *
 * Requirements: 11.1, 11.2, 11.4, 11.5, 11.6, 11.7
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import { EventEmitter } from 'events';

// ─── Types ──────────────────────────────────────────────────────

/** Process lifecycle status */
export type ProcessStatus = 'running' | 'stopped' | 'crashed' | 'restarting';

/** Configuration for starting a background process */
export interface ProcessStartOptions {
  /** Human-readable process name (e.g., "dev-server", "test-watcher") */
  name: string;
  /** Shell command to execute */
  command: string;
  /** Working directory for the process */
  cwd: string;
  /** Optional port the process is expected to listen on */
  port?: number;
  /** Optional environment variables to merge with process.env */
  env?: Record<string, string>;
  /** Whether to auto-restart on crash (default: false) */
  autoRestart?: boolean;
  /** Maximum restart attempts before giving up (default: 3) */
  maxRestarts?: number;
}

/** Tracked state of a managed process */
export interface ManagedProcess {
  /** Unique process identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Shell command that was executed */
  command: string;
  /** Working directory */
  cwd: string;
  /** OS process ID (null if not running) */
  pid: number | null;
  /** Port the process is listening on (null if not applicable) */
  port: number | null;
  /** Current lifecycle status */
  status: ProcessStatus;
  /** Timestamp when process was started */
  startedAt: number | null;
  /** Timestamp when process stopped or crashed */
  stoppedAt: number | null;
  /** Number of restarts that have occurred */
  restartCount: number;
  /** Auto-restart enabled */
  autoRestart: boolean;
  /** Maximum restart attempts */
  maxRestarts: number;
}

/** Resource usage snapshot for a process */
export interface ProcessResourceUsage {
  /** CPU usage percentage (0-100) */
  cpuPercent: number;
  /** Resident memory in bytes */
  memoryBytes: number;
  /** Process uptime in milliseconds */
  uptimeMs: number;
}

/** Process status context exposed to agents */
export interface ProcessContextEntry {
  name: string;
  status: ProcessStatus;
  port: number | null;
  pid: number | null;
  uptimeMs: number;
  /** Human-readable summary (e.g., "dev server running on port 3000") */
  summary: string;
}

/** Events emitted by the BackgroundProcessManager */
export interface ProcessManagerEvents {
  'process:started': (process: ManagedProcess) => void;
  'process:stopped': (process: ManagedProcess) => void;
  'process:crashed': (process: ManagedProcess) => void;
  'process:restarting': (process: ManagedProcess) => void;
  'process:output': (id: string, line: string, stream: 'stdout' | 'stderr') => void;
  'port:conflict': (requestedPort: number, suggestedPort: number) => void;
}

// ─── Log Buffer ─────────────────────────────────────────────────

/**
 * Ring buffer that retains the last N lines of output.
 * Used to capture stdout/stderr per process for agent inspection.
 */
export class LogBuffer {
  private readonly lines: string[] = [];
  private readonly maxLines: number;

  constructor(maxLines: number = 1000) {
    this.maxLines = maxLines;
  }

  append(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
  }

  getLines(count?: number): string[] {
    if (count === undefined || count >= this.lines.length) {
      return [...this.lines];
    }
    return this.lines.slice(-count);
  }

  clear(): void {
    this.lines.length = 0;
  }

  get size(): number {
    return this.lines.length;
  }
}

// ─── Background Process Manager ─────────────────────────────────

/**
 * Singleton orchestrator for background process lifecycle management.
 * Lazy-initialized following NeuroNest's established patterns.
 *
 * Manages named processes that persist across agent message turns,
 * tracks their status, captures output, detects port conflicts,
 * and auto-stops everything on project close or app exit.
 */
export class BackgroundProcessManager extends EventEmitter {
  private static instance: BackgroundProcessManager | null = null;

  private readonly processes = new Map<string, ManagedProcess>();
  private readonly childProcesses = new Map<string, ChildProcess>();
  private readonly logBuffers = new Map<string, LogBuffer>();
  private readonly resourceUsage = new Map<string, ProcessResourceUsage>();
  private cleanupHandler: (() => void) | null = null;
  private idCounter = 0;
  private disposed = false;

  private constructor() {
    super();
    this.setupShutdownHooks();
  }

  /** Lazy singleton accessor */
  static getInstance(): BackgroundProcessManager {
    if (!BackgroundProcessManager.instance) {
      BackgroundProcessManager.instance = new BackgroundProcessManager();
    }
    return BackgroundProcessManager.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (BackgroundProcessManager.instance) {
      BackgroundProcessManager.instance.dispose();
      BackgroundProcessManager.instance = null;
    }
  }

  // ─── Process Lifecycle ──────────────────────────────────────────

  /**
   * Start a named background process.
   * Detects port conflicts and suggests alternatives before spawning.
   *
   * Requirements: 11.1, 11.5
   */
  async startProcess(options: ProcessStartOptions): Promise<ManagedProcess> {
    if (this.disposed) {
      throw new Error('BackgroundProcessManager has been disposed');
    }

    // Check for duplicate name
    const existingByName = this.findByName(options.name);
    if (existingByName && existingByName.status === 'running') {
      throw new Error(`Process "${options.name}" is already running (id: ${existingByName.id})`);
    }

    // Port conflict detection and resolution
    let resolvedPort = options.port ?? null;
    if (resolvedPort !== null) {
      const portAvailable = await this.isPortAvailable(resolvedPort);
      if (!portAvailable) {
        const suggestedPort = await this.findAvailablePort(resolvedPort + 1);
        this.emit('port:conflict', resolvedPort, suggestedPort);
        throw new PortConflictError(
          `Port ${resolvedPort} is already in use`,
          resolvedPort,
          suggestedPort,
        );
      }
    }

    const id = this.generateId();
    const managedProcess: ManagedProcess = {
      id,
      name: options.name,
      command: options.command,
      cwd: options.cwd,
      pid: null,
      port: resolvedPort,
      status: 'running',
      startedAt: Date.now(),
      stoppedAt: null,
      restartCount: 0,
      autoRestart: options.autoRestart ?? false,
      maxRestarts: options.maxRestarts ?? 3,
    };

    this.processes.set(id, managedProcess);
    this.logBuffers.set(id, new LogBuffer(1000));

    this.spawnProcess(id, options);

    return { ...managedProcess };
  }

  /**
   * Stop a running process by ID.
   *
   * Requirements: 11.6
   */
  async stopProcess(id: string): Promise<void> {
    const managed = this.processes.get(id);
    if (!managed) {
      throw new Error(`Process not found: ${id}`);
    }

    if (managed.status !== 'running' && managed.status !== 'restarting') {
      return; // Already stopped or crashed
    }

    // Disable auto-restart before killing
    managed.autoRestart = false;

    const child = this.childProcesses.get(id);
    if (child) {
      child.kill('SIGTERM');
      // Force kill after 5 seconds if not dead
      const forceKillTimeout = setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        } catch {
          // Process may already be gone
        }
      }, 5000);

      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          clearTimeout(forceKillTimeout);
          resolve();
        });
        // In case 'exit' never fires
        setTimeout(() => {
          clearTimeout(forceKillTimeout);
          resolve();
        }, 6000);
      });
    }

    managed.status = 'stopped';
    managed.stoppedAt = Date.now();
    managed.pid = null;
    this.childProcesses.delete(id);
    this.emit('process:stopped', { ...managed });
  }

  /**
   * Restart a process by stopping and re-spawning it.
   */
  async restartProcess(id: string): Promise<ManagedProcess> {
    const managed = this.processes.get(id);
    if (!managed) {
      throw new Error(`Process not found: ${id}`);
    }

    managed.status = 'restarting';
    this.emit('process:restarting', { ...managed });

    // Stop existing child
    const child = this.childProcesses.get(id);
    if (child) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
    }
    this.childProcesses.delete(id);

    // Clear log buffer for fresh start
    this.logBuffers.get(id)?.clear();

    // Re-spawn
    managed.startedAt = Date.now();
    managed.stoppedAt = null;
    managed.restartCount++;

    const options: ProcessStartOptions = {
      name: managed.name,
      command: managed.command,
      cwd: managed.cwd,
      ...(managed.port !== null ? { port: managed.port } : {}),
      autoRestart: managed.autoRestart,
      maxRestarts: managed.maxRestarts,
    };

    this.spawnProcess(id, options);

    return { ...managed };
  }

  /**
   * Stop all managed processes. Called on project close or app exit.
   *
   * Requirements: 11.6
   */
  async stopAll(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const [id, managed] of this.processes) {
      if (managed.status === 'running' || managed.status === 'restarting') {
        stopPromises.push(this.stopProcess(id));
      }
    }
    await Promise.allSettled(stopPromises);
  }

  // ─── Process Queries ──────────────────────────────────────────

  /**
   * Get the state of a specific process.
   *
   * Requirements: 11.2
   */
  getProcess(id: string): ManagedProcess | undefined {
    const managed = this.processes.get(id);
    return managed ? { ...managed } : undefined;
  }

  /**
   * List all managed processes.
   *
   * Requirements: 11.2
   */
  listProcesses(): ManagedProcess[] {
    return Array.from(this.processes.values()).map((p) => ({ ...p }));
  }

  /**
   * Find a process by name.
   */
  findByName(name: string): ManagedProcess | undefined {
    for (const managed of this.processes.values()) {
      if (managed.name === name) {
        return { ...managed };
      }
    }
    return undefined;
  }

  /**
   * Get the last N lines of stdout/stderr for a process.
   *
   * Requirements: 11.4
   */
  getProcessLogs(id: string, lineCount?: number): string[] {
    const buffer = this.logBuffers.get(id);
    if (!buffer) return [];
    return buffer.getLines(lineCount);
  }

  /**
   * Get resource usage estimate for a process.
   *
   * Requirements: 11.2
   */
  getResourceUsage(id: string): ProcessResourceUsage | undefined {
    const managed = this.processes.get(id);
    if (!managed || managed.status !== 'running' || !managed.startedAt) {
      return undefined;
    }

    // Return cached resource usage or estimate from uptime
    const cached = this.resourceUsage.get(id);
    if (cached) return { ...cached };

    return {
      cpuPercent: 0,
      memoryBytes: 0,
      uptimeMs: Date.now() - managed.startedAt,
    };
  }

  // ─── Agent Context ────────────────────────────────────────────

  /**
   * Expose all running process status as context for agent consumption.
   * Returns structured entries describing each active process.
   *
   * Requirements: 11.7
   */
  getAgentContext(): ProcessContextEntry[] {
    const entries: ProcessContextEntry[] = [];

    for (const managed of this.processes.values()) {
      if (managed.status === 'stopped') continue;

      const uptimeMs =
        managed.status === 'running' && managed.startedAt
          ? Date.now() - managed.startedAt
          : 0;

      const portInfo = managed.port ? ` on port ${managed.port}` : '';
      const statusLabel = managed.status === 'running' ? 'running' : managed.status;
      const summary = `${managed.name} ${statusLabel}${portInfo}`;

      entries.push({
        name: managed.name,
        status: managed.status,
        port: managed.port,
        pid: managed.pid,
        uptimeMs,
        summary,
      });
    }

    return entries;
  }

  /**
   * Get a human-readable summary of all process state for agent prompt injection.
   *
   * Requirements: 11.7
   */
  getContextSummary(): string {
    const entries = this.getAgentContext();
    if (entries.length === 0) {
      return 'No background processes are currently managed.';
    }

    const lines = entries.map((e) => `- ${e.summary}`);
    return `Background processes:\n${lines.join('\n')}`;
  }

  // ─── Port Utilities ───────────────────────────────────────────

  /**
   * Check if a port is available at the OS level.
   *
   * Requirements: 11.5
   */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
  }

  /**
   * Find the next available port starting from a given base.
   *
   * Requirements: 11.5
   */
  async findAvailablePort(startPort: number, maxAttempts: number = 100): Promise<number> {
    let port = startPort;
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
      port++;
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts}`);
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Dispose the manager and stop all processes.
   * Called on app exit.
   *
   * Requirements: 11.6
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Remove shutdown hooks to prevent listener leaks
    this.removeShutdownHooks();

    // Synchronously kill all child processes
    for (const [, child] of this.childProcesses) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may already be gone
      }
    }
    this.childProcesses.clear();

    // Mark all as stopped
    for (const managed of this.processes.values()) {
      if (managed.status === 'running' || managed.status === 'restarting') {
        managed.status = 'stopped';
        managed.stoppedAt = Date.now();
        managed.pid = null;
      }
    }

    this.removeAllListeners();
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private generateId(): string {
    return `bg-proc-${++this.idCounter}-${Date.now().toString(36)}`;
  }

  private spawnProcess(id: string, options: ProcessStartOptions): void {
    const managed = this.processes.get(id);
    if (!managed) return;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...options.env,
    };

    // Inject port into environment if specified
    if (managed.port !== null) {
      env['PORT'] = String(managed.port);
    }

    const child = spawn(options.command, [], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: true,
      detached: false,
    });

    managed.pid = child.pid ?? null;
    managed.status = 'running';
    this.childProcesses.set(id, child);

    const logBuffer = this.logBuffers.get(id)!;

    // Capture stdout
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          logBuffer.append(line);
          this.emit('process:output', id, line, 'stdout');
        }
      });
    }

    // Capture stderr
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          logBuffer.append(line);
          this.emit('process:output', id, line, 'stderr');
        }
      });
    }

    // Handle process exit
    child.on('exit', (code, signal) => {
      this.childProcesses.delete(id);
      managed.pid = null;

      if (managed.status === 'stopped' || this.disposed) {
        // Intentional stop — do nothing further
        return;
      }

      // Process crashed
      managed.status = 'crashed';
      managed.stoppedAt = Date.now();
      logBuffer.append(`[process] Exited with code ${code}, signal ${signal}`);
      this.emit('process:crashed', { ...managed });

      // Auto-restart logic
      if (managed.autoRestart && managed.restartCount < managed.maxRestarts) {
        managed.status = 'restarting';
        managed.restartCount++;
        this.emit('process:restarting', { ...managed });

        // Delay restart by 1 second to avoid tight restart loops
        setTimeout(() => {
          if (!this.disposed && managed.status === 'restarting') {
            managed.startedAt = Date.now();
            managed.stoppedAt = null;
            logBuffer.append(`[process] Auto-restarting (attempt ${managed.restartCount}/${managed.maxRestarts})`);
            this.spawnProcess(id, options);
          }
        }, 1000);
      }
    });

    // Handle spawn error
    child.on('error', (err) => {
      this.childProcesses.delete(id);
      managed.pid = null;
      managed.status = 'crashed';
      managed.stoppedAt = Date.now();
      logBuffer.append(`[process] Spawn error: ${err.message}`);
      this.emit('process:crashed', { ...managed });
    });
  }

  /**
   * Register process shutdown hooks to auto-stop all processes
   * when the application exits.
   *
   * Requirements: 11.6
   */
  private setupShutdownHooks(): void {
    this.cleanupHandler = (): void => {
      this.dispose();
    };

    process.once('exit', this.cleanupHandler);
    process.once('SIGINT', this.cleanupHandler);
    process.once('SIGTERM', this.cleanupHandler);
    process.once('beforeExit', this.cleanupHandler);
  }

  /**
   * Remove shutdown hooks to avoid listener leaks during testing.
   */
  private removeShutdownHooks(): void {
    if (this.cleanupHandler) {
      process.removeListener('exit', this.cleanupHandler);
      process.removeListener('SIGINT', this.cleanupHandler);
      process.removeListener('SIGTERM', this.cleanupHandler);
      process.removeListener('beforeExit', this.cleanupHandler);
    }
  }
}

// ─── Custom Errors ──────────────────────────────────────────────

/**
 * Error thrown when a requested port is already in use.
 * Includes the suggested alternative port.
 */
export class PortConflictError extends Error {
  readonly requestedPort: number;
  readonly suggestedPort: number;

  constructor(message: string, requestedPort: number, suggestedPort: number) {
    super(message);
    this.name = 'PortConflictError';
    this.requestedPort = requestedPort;
    this.suggestedPort = suggestedPort;
  }
}
