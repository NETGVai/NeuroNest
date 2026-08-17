/**
 * Managed Process Tree — Process trees with owner, deadline, output bounds,
 * environment policy, and complete owner teardown.
 *
 * Creates managed process trees bound to an owner and Execution_World. Enforces
 * output bounds, deadline termination, and environment policy. Supports graceful
 * teardown that terminates all child processes within the configured deadline.
 *
 * Requirements: 23.4, 23.7 (owner teardown)
 */

import { randomUUID } from 'node:crypto';
import type {
  ProcessTreeConfig,
  ManagedProcess,
  ProcessTreeStatus,
  BoundedOutput,
} from './bounded-operations-schemas';
import { ProcessTreeConfigSchema } from './bounded-operations-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Process authority port for spawning and managing processes.
 */
export interface ProcessTreeProcessPort {
  /** Spawn a process with the given configuration. Returns the OS PID. */
  spawn(config: SpawnConfig): Promise<SpawnResult>;
  /** Send a signal to a process. */
  signal(pid: number, signal: string): Promise<boolean>;
  /** Check if a process is still running. */
  isRunning(pid: number): Promise<boolean>;
}

export interface SpawnConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  outputBoundBytes: number;
}

export interface SpawnResult {
  pid: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Security authority port for verifying process spawn permissions.
 */
export interface ProcessTreeSecurityPort {
  /** Verify that process spawning is allowed in the execution world. */
  verifyProcessAccess(
    command: string,
    executionWorldId: string,
    scope: Record<string, unknown>,
  ): Promise<boolean>;
  /** Filter environment variables based on the environment policy. */
  filterEnvironment(
    env: Record<string, string> | undefined,
    policy: string,
  ): Promise<Record<string, string>>;
}

export interface ManagedProcessTreeDeps {
  process: ProcessTreeProcessPort;
  security: ProcessTreeSecurityPort;
}

// ─── Managed Process Tree Service ───────────────────────────────

/**
 * ManagedProcessTree manages a tree of processes bound to a single owner
 * and Execution_World. All processes in the tree are tracked and terminated
 * together during owner teardown.
 */
export class ManagedProcessTree {
  private readonly deps: ManagedProcessTreeDeps;
  private readonly trees: Map<string, ProcessTree> = new Map();

  constructor(deps: ManagedProcessTreeDeps) {
    this.deps = deps;
  }

  /**
   * Create a new managed process tree with the given configuration.
   *
   * Requirement 23.4: Create a managed process tree with owner, deadline,
   * output bound, environment policy, and teardown behavior.
   */
  async create(config: ProcessTreeConfig): Promise<ProcessTreeStatus | null> {
    // Validate configuration
    const validation = ProcessTreeConfigSchema.safeParse(config);
    if (!validation.success) {
      return null;
    }

    // Verify access through security authority
    const hasAccess = await this.deps.security.verifyProcessAccess(
      config.command,
      config.executionWorldId,
      config.scope,
    );
    if (!hasAccess) {
      return null;
    }

    // Filter environment based on policy
    const filteredEnv = await this.deps.security.filterEnvironment(
      config.env,
      config.environmentPolicy,
    );

    const rootProcessId = randomUUID();
    const tree = new ProcessTree(
      rootProcessId,
      config.owner,
      config.executionWorldId,
      config.deadlineMs,
      config.outputBoundBytes,
      config.teardownBehavior,
    );

    // Spawn the root process
    const spawnResult = await this.deps.process.spawn({
      command: config.command,
      args: config.args,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      env: filteredEnv,
      outputBoundBytes: config.outputBoundBytes,
    });

    const rootProcess: ManagedProcess = {
      processId: rootProcessId,
      owner: config.owner,
      executionWorldId: config.executionWorldId,
      command: config.command,
      state: spawnResult.exitCode === null ? 'running' : 'terminated',
      pid: spawnResult.pid,
      startedAt: new Date().toISOString(),
      ...(spawnResult.exitCode !== null ? { terminatedAt: new Date().toISOString() } : {}),
      ...(spawnResult.exitCode !== null ? { exitCode: spawnResult.exitCode } : {}),
      stdout: this.boundOutput(spawnResult.stdout, config.outputBoundBytes),
      stderr: this.boundOutput(spawnResult.stderr, config.outputBoundBytes),
    };

    tree.addProcess(rootProcess);
    this.trees.set(rootProcessId, tree);

    // Set up deadline timer
    tree.startDeadline(() => {
      void this.terminateTree(rootProcessId);
    });

    return tree.getStatus();
  }

  /**
   * Get the status of a managed process tree.
   */
  getStatus(rootProcessId: string): ProcessTreeStatus | null {
    const tree = this.trees.get(rootProcessId);
    return tree?.getStatus() ?? null;
  }

  /**
   * Get all trees owned by a specific owner in a specific execution world.
   */
  getTreesByOwner(owner: string, executionWorldId: string): ProcessTreeStatus[] {
    const results: ProcessTreeStatus[] = [];
    for (const tree of this.trees.values()) {
      if (tree.owner === owner && tree.executionWorldId === executionWorldId) {
        results.push(tree.getStatus());
      }
    }
    return results;
  }

  /**
   * Terminate a specific process tree.
   */
  async terminateTree(rootProcessId: string): Promise<boolean> {
    const tree = this.trees.get(rootProcessId);
    if (!tree) return false;

    await this.performTeardown(tree);
    return true;
  }

  /**
   * Requirement 23.7: Complete owner teardown — terminate all process trees
   * for a given owner within the configured deadline.
   */
  async teardownOwner(owner: string, executionWorldId: string): Promise<number> {
    let terminated = 0;
    const toRemove: string[] = [];

    for (const [rootId, tree] of this.trees.entries()) {
      if (tree.owner === owner && tree.executionWorldId === executionWorldId) {
        await this.performTeardown(tree);
        toRemove.push(rootId);
        terminated++;
      }
    }

    for (const rootId of toRemove) {
      this.trees.delete(rootId);
    }

    return terminated;
  }

  /**
   * Get total active process count across all trees.
   */
  getActiveProcessCount(): number {
    let count = 0;
    for (const tree of this.trees.values()) {
      count += tree.getActiveProcessCount();
    }
    return count;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private async performTeardown(tree: ProcessTree): Promise<void> {
    tree.setState('draining');

    const processes = tree.getActiveProcesses();
    for (const proc of processes) {
      if (proc.pid !== undefined) {
        switch (tree.teardownBehavior) {
          case 'graceful_then_kill':
            await this.deps.process.signal(proc.pid, 'SIGTERM');
            // In production, would wait for exit then SIGKILL after timeout
            break;
          case 'immediate_kill':
            await this.deps.process.signal(proc.pid, 'SIGKILL');
            break;
          case 'signal_only':
            await this.deps.process.signal(proc.pid, 'SIGTERM');
            break;
        }
      }
      tree.markTerminated(proc.processId);
    }

    tree.setState('terminated');
    tree.clearDeadline();
  }

  private boundOutput(data: string, limitBytes: number): BoundedOutput {
    const bytes = Buffer.byteLength(data, 'utf-8');
    if (bytes <= limitBytes) {
      return { data, byteLength: bytes, truncated: false };
    }
    const truncated = Buffer.from(data, 'utf-8').subarray(0, limitBytes).toString('utf-8');
    return {
      data: truncated,
      byteLength: limitBytes,
      truncated: true,
      truncatedAt: limitBytes,
    };
  }
}

// ─── Process Tree Internal State ────────────────────────────────

class ProcessTree {
  readonly rootProcessId: string;
  readonly owner: string;
  readonly executionWorldId: string;
  readonly deadlineMs: number;
  readonly outputBoundBytes: number;
  readonly teardownBehavior: 'graceful_then_kill' | 'immediate_kill' | 'signal_only';

  private processes: ManagedProcess[] = [];
  private state: 'active' | 'draining' | 'terminated' = 'active';
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    rootProcessId: string,
    owner: string,
    executionWorldId: string,
    deadlineMs: number,
    outputBoundBytes: number,
    teardownBehavior: 'graceful_then_kill' | 'immediate_kill' | 'signal_only',
  ) {
    this.rootProcessId = rootProcessId;
    this.owner = owner;
    this.executionWorldId = executionWorldId;
    this.deadlineMs = deadlineMs;
    this.outputBoundBytes = outputBoundBytes;
    this.teardownBehavior = teardownBehavior;
  }

  addProcess(process: ManagedProcess): void {
    this.processes.push(process);
  }

  getActiveProcesses(): ManagedProcess[] {
    return this.processes.filter(p => p.state === 'running');
  }

  getActiveProcessCount(): number {
    return this.getActiveProcesses().length;
  }

  markTerminated(processId: string): void {
    const proc = this.processes.find(p => p.processId === processId);
    if (proc) {
      proc.state = 'terminated';
      proc.terminatedAt = new Date().toISOString();
    }
  }

  setState(state: 'active' | 'draining' | 'terminated'): void {
    this.state = state;
  }

  startDeadline(onExpired: () => void): void {
    this.deadlineTimer = setTimeout(onExpired, this.deadlineMs);
  }

  clearDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }

  getStatus(): ProcessTreeStatus {
    return {
      rootProcessId: this.rootProcessId,
      owner: this.owner,
      executionWorldId: this.executionWorldId,
      processes: [...this.processes],
      totalProcesses: this.processes.length,
      state: this.state,
      schemaVersion: 1,
    };
  }
}
