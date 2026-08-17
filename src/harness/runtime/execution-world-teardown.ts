/**
 * Execution World Teardown — Coordinates complete owner teardown of terminals,
 * process trees, watchers, language-service requests, and temporary resources
 * within the configured deadline.
 *
 * When an owner or session tears down, this coordinator closes all resources
 * owned by that owner in the given Execution_World within the configured deadline.
 *
 * Requirements: 23.7 (owner teardown)
 */

import type { TeardownRequest, TeardownResult } from './bounded-operations-schemas';
import { TeardownRequestSchema } from './bounded-operations-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Terminal operations port for teardown.
 */
export interface TeardownTerminalPort {
  /** Close all terminals owned by the given owner in the execution world. */
  teardownOwner(owner: string, executionWorldId: string): Promise<number>;
}

/**
 * Process tree port for teardown.
 */
export interface TeardownProcessPort {
  /** Terminate all process trees owned by the given owner in the execution world. */
  teardownOwner(owner: string, executionWorldId: string): Promise<number>;
}

/**
 * Language service port for teardown.
 */
export interface TeardownLanguagePort {
  /** Cancel all active language-service requests. */
  cancelAll(): Promise<number>;
}

/**
 * Watcher port for teardown (file watchers, etc.).
 */
export interface TeardownWatcherPort {
  /** Stop all watchers owned by the given owner in the execution world. */
  stopAll(owner: string, executionWorldId: string): Promise<number>;
}

/**
 * Temporary resource port for cleanup.
 */
export interface TeardownTemporaryResourcePort {
  /** Clean up temporary resources owned by the given owner in the execution world. */
  cleanup(owner: string, executionWorldId: string): Promise<number>;
}

export interface ExecutionWorldTeardownDeps {
  terminals: TeardownTerminalPort;
  processes: TeardownProcessPort;
  language: TeardownLanguagePort;
  watchers: TeardownWatcherPort;
  temporaryResources: TeardownTemporaryResourcePort;
}

// ─── Execution World Teardown Coordinator ───────────────────────

/**
 * Coordinates the complete teardown of an Execution_World's resources for a
 * given owner. Runs all teardown operations within the configured deadline.
 *
 * Requirement 23.7: When an owner or session tears down, close owned
 * pseudo-terminals, process trees, watchers, language-service requests,
 * and temporary resources within the configured deadline.
 */
export class ExecutionWorldTeardown {
  private readonly deps: ExecutionWorldTeardownDeps;

  constructor(deps: ExecutionWorldTeardownDeps) {
    this.deps = deps;
  }

  /**
   * Execute a complete teardown for the given owner/execution world.
   * Runs all teardown operations concurrently with a deadline timeout.
   */
  async teardown(request: TeardownRequest): Promise<TeardownResult> {
    // Validate request
    const validation = TeardownRequestSchema.safeParse(request);
    if (!validation.success) {
      return {
        executionWorldId: request.executionWorldId,
        owner: request.owner,
        terminalsClose: 0,
        processesTerminated: 0,
        watchersStopped: 0,
        languageRequestsCancelled: 0,
        temporaryResourcesCleaned: 0,
        completedWithinDeadline: false,
        durationMs: 0,
        schemaVersion: 1,
      };
    }

    const startTime = Date.now();

    // Run all teardown operations concurrently with deadline
    const result = await this.executeWithDeadline(request);

    const durationMs = Date.now() - startTime;
    const completedWithinDeadline = durationMs <= request.deadlineMs;

    return {
      executionWorldId: request.executionWorldId,
      owner: request.owner,
      terminalsClose: result.terminalsClose,
      processesTerminated: result.processesTerminated,
      watchersStopped: result.watchersStopped,
      languageRequestsCancelled: result.languageRequestsCancelled,
      temporaryResourcesCleaned: result.temporaryResourcesCleaned,
      completedWithinDeadline,
      durationMs,
      schemaVersion: 1,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private async executeWithDeadline(request: TeardownRequest): Promise<TeardownCounts> {
    const deadline = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), request.deadlineMs);
    });

    const teardownWork = this.performTeardown(request);

    const raceResult = await Promise.race([teardownWork, deadline]);
    if (raceResult === 'timeout') {
      // Deadline expired — return partial results
      return {
        terminalsClose: 0,
        processesTerminated: 0,
        watchersStopped: 0,
        languageRequestsCancelled: 0,
        temporaryResourcesCleaned: 0,
      };
    }

    return raceResult;
  }

  private async performTeardown(request: TeardownRequest): Promise<TeardownCounts> {
    // Execute all teardown operations concurrently
    const [
      terminalsClose,
      processesTerminated,
      watchersStopped,
      languageRequestsCancelled,
      temporaryResourcesCleaned,
    ] = await Promise.all([
      this.safeExecute(() =>
        this.deps.terminals.teardownOwner(request.owner, request.executionWorldId),
      ),
      this.safeExecute(() =>
        this.deps.processes.teardownOwner(request.owner, request.executionWorldId),
      ),
      this.safeExecute(() =>
        this.deps.watchers.stopAll(request.owner, request.executionWorldId),
      ),
      this.safeExecute(() =>
        this.deps.language.cancelAll(),
      ),
      this.safeExecute(() =>
        this.deps.temporaryResources.cleanup(request.owner, request.executionWorldId),
      ),
    ]);

    return {
      terminalsClose,
      processesTerminated,
      watchersStopped,
      languageRequestsCancelled,
      temporaryResourcesCleaned,
    };
  }

  /**
   * Execute a teardown operation safely — returns 0 on error.
   */
  private async safeExecute(fn: () => Promise<number>): Promise<number> {
    try {
      return await fn();
    } catch {
      return 0;
    }
  }
}

// ─── Internal Types ─────────────────────────────────────────────

interface TeardownCounts {
  terminalsClose: number;
  processesTerminated: number;
  watchersStopped: number;
  languageRequestsCancelled: number;
  temporaryResourcesCleaned: number;
}
