/**
 * ProcessLifecycleManager — Negotiated lifecycle, readiness, health, progress,
 * cancellation, and graceful drain for harness MCP processes.
 *
 * Tracks process state: initializing → ready → draining → stopped
 * Reports: process version, protocol version, uptime, draining state
 * Database connectivity check (can open + query SharedDatabase)
 * Migration state check (all migrations applied, no pending/failed)
 * Schema compatibility check (via FencedMigrationCoordinator)
 * Authority availability (all required extension ports healthy)
 * Negotiated protocol capabilities (cancellation, progress, logging)
 * Progress notifications for long-running operations
 * Per-operation drain policy (cancel-immediate vs wait-for-completion)
 * Outbox flush and checkpoint commit during graceful shutdown
 *
 * Requirements: 30.8–30.12, 32.1, 32.5–32.7
 */

import type { SharedDatabase } from '../../database/shared-database.js';
import type { FencedMigrationCoordinator } from '../../database/fenced-coordinator.js';
import type { MigrationRunner } from '../../database/migration-runner.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Process lifecycle state machine: initializing → ready → draining → stopped
 */
export type ProcessState = 'initializing' | 'ready' | 'draining' | 'stopped';

/**
 * Health status for individual components.
 */
export type ComponentHealth = 'healthy' | 'degraded' | 'unavailable';

/**
 * Negotiated protocol capabilities for the MCP connection.
 * Requirement 32.1: Negotiate protocol version, tools, resources, prompts,
 * cancellation, progress, and logging capabilities.
 */
export interface NegotiatedCapabilities {
  /** Protocol version that was negotiated */
  protocolVersion: string;
  /** Whether the client supports cancellation requests */
  cancellation: boolean;
  /** Whether the client supports progress notifications */
  progress: boolean;
  /** Whether the client supports logging notifications */
  logging: boolean;
  /** Whether the client supports tool list change notifications */
  toolsListChanged: boolean;
  /** Whether the client supports resource subscriptions */
  resourceSubscriptions: boolean;
  /** Whether the client supports prompt list change notifications */
  promptsListChanged: boolean;
}

/**
 * Drain policy for an operation — determines behavior during graceful shutdown.
 * Requirement 32.6: cancel or drain in-flight work according to operation policy.
 */
export type DrainPolicy = 'cancel-immediate' | 'wait-for-completion';

/**
 * Progress notification emitted for long-running operations.
 * Requirement 30.10: emit progress notifications when negotiated.
 */
export interface ProgressNotification {
  /** Operation ID this progress is for */
  operationId: string;
  /** Progress value (0 to total) */
  progress: number;
  /** Total expected value */
  total: number;
  /** Optional descriptive message */
  message?: string;
}

/**
 * Listener for progress notifications.
 */
export type ProgressListener = (notification: ProgressNotification) => void;

/**
 * Outbox flusher interface for graceful shutdown.
 * Requirement 32.6: flush committed outbox state during shutdown.
 */
export interface OutboxFlusher {
  /** Flush any pending outbox records and advance checkpoints */
  flush(): void;
  /** Get count of unflushed pending outbox records */
  getPendingCount(): number;
}

/**
 * Structured health status for the process.
 */
export interface HealthStatus {
  processVersion: string;
  protocolVersion: string;
  state: ProcessState;
  uptime: number;
  draining: boolean;
  negotiatedCapabilities: NegotiatedCapabilities | null;
  database: {
    connected: boolean;
    compatible: boolean;
    health: ComponentHealth;
    reason?: string;
  };
  migration: {
    allApplied: boolean;
    pending: number;
    failed: number;
    health: ComponentHealth;
    reason?: string;
  };
  schema: {
    compatible: boolean;
    observedVersion: number;
    readRange: [number, number];
    writeRange: [number, number];
    health: ComponentHealth;
    reason?: string;
  };
  authorities: {
    allAvailable: boolean;
    available: string[];
    unavailable: string[];
    health: ComponentHealth;
    reason?: string;
  };
  overall: ComponentHealth;
  timestamp: string;
}

/**
 * Readiness report returned by getReadiness().
 * Requirement 32.7: Reports protocol initialization, database compatibility,
 * migration state, required authority availability, and draining state.
 */
export interface ReadinessReport {
  ready: boolean;
  state: ProcessState;
  protocolNegotiated: boolean;
  checks: {
    protocol: boolean;
    database: boolean;
    migration: boolean;
    schema: boolean;
    authorities: boolean;
  };
  reason?: string;
}

/**
 * Configuration for ProcessLifecycleManager.
 */
export interface ProcessLifecycleConfig {
  processName: string;
  processVersion: string;
  protocolVersion: string;
  /** Required authority port names that must be healthy for readiness */
  requiredAuthorities: string[];
  /** Grace period in ms for drain to complete before forced stop */
  drainDeadlineMs: number;
  /** Interval in ms between health checks */
  healthCheckIntervalMs?: number;
}

/**
 * Authority port health checker interface.
 */
export interface AuthorityHealthChecker {
  /** Returns names of currently available authority ports */
  getAvailableAuthorities(): string[];
}

/**
 * Pending operation tracked for graceful drain and cancellation.
 */
export interface PendingOperation {
  id: string;
  description: string;
  abortController: AbortController;
  drainPolicy: DrainPolicy;
  startedAt: number;
}

// ─── ProcessLifecycleManager ────────────────────────────────────

export class ProcessLifecycleManager {
  private state: ProcessState = 'initializing';
  private readonly startTime: number;
  private readonly config: ProcessLifecycleConfig;
  private readonly pendingOperations = new Map<string, PendingOperation>();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealthStatus: HealthStatus | null = null;

  private database: SharedDatabase | null = null;
  private coordinator: FencedMigrationCoordinator | null = null;
  private migrationRunner: MigrationRunner | null = null;
  private authorityChecker: AuthorityHealthChecker | null = null;
  private outboxFlusher: OutboxFlusher | null = null;

  private negotiatedCapabilities: NegotiatedCapabilities | null = null;
  private progressListeners: ProgressListener[] = [];

  constructor(config: ProcessLifecycleConfig) {
    this.config = config;
    this.startTime = Date.now();
  }

  // ─── Dependencies ─────────────────────────────────────────────

  /**
   * Attach database dependency for health and readiness checks.
   */
  attachDatabase(db: SharedDatabase): void {
    this.database = db;
  }

  /**
   * Attach fenced migration coordinator for schema compatibility checks.
   */
  attachCoordinator(coordinator: FencedMigrationCoordinator): void {
    this.coordinator = coordinator;
  }

  /**
   * Attach migration runner for migration state checks.
   */
  attachMigrationRunner(runner: MigrationRunner): void {
    this.migrationRunner = runner;
  }

  /**
   * Attach authority health checker for extension port availability.
   */
  attachAuthorityChecker(checker: AuthorityHealthChecker): void {
    this.authorityChecker = checker;
  }

  /**
   * Attach outbox flusher for graceful shutdown.
   * Requirement 32.6: flush committed outbox state before closing database.
   */
  attachOutboxFlusher(flusher: OutboxFlusher): void {
    this.outboxFlusher = flusher;
  }

  // ─── Protocol Negotiation ─────────────────────────────────────

  /**
   * Record negotiated protocol capabilities after MCP initialize handshake.
   * Requirement 30.8: Negotiate protocol capabilities before reporting readiness.
   * Requirement 32.1: Negotiate protocol version, tools, resources, prompts,
   * cancellation, progress, and logging capabilities.
   */
  setNegotiatedCapabilities(capabilities: NegotiatedCapabilities): void {
    this.negotiatedCapabilities = capabilities;
  }

  /**
   * Get the negotiated protocol capabilities, or null if not yet negotiated.
   */
  getNegotiatedCapabilities(): NegotiatedCapabilities | null {
    return this.negotiatedCapabilities;
  }

  /**
   * Check if protocol has been negotiated (required for readiness).
   */
  isProtocolNegotiated(): boolean {
    return this.negotiatedCapabilities !== null;
  }

  // ─── Progress Notifications ───────────────────────────────────

  /**
   * Register a progress listener. Notifications are only emitted if
   * the negotiated capabilities include progress support.
   * Requirement 30.10: emit progress notifications when negotiated.
   */
  addProgressListener(listener: ProgressListener): () => void {
    this.progressListeners.push(listener);
    return () => {
      this.progressListeners = this.progressListeners.filter(l => l !== listener);
    };
  }

  /**
   * Emit a progress notification for a tracked operation.
   * Only emits if progress capability was negotiated.
   */
  emitProgress(operationId: string, progress: number, total: number, message?: string): void {
    if (!this.negotiatedCapabilities?.progress) return;
    if (!this.pendingOperations.has(operationId)) return;

    const notification: ProgressNotification = message !== undefined
      ? { operationId, progress, total, message }
      : { operationId, progress, total };
    for (const listener of this.progressListeners) {
      try {
        listener(notification);
      } catch {
        // Listeners must not throw; swallow silently
      }
    }
  }

  // ─── State Transitions ────────────────────────────────────────

  /**
   * Get the current process state.
   */
  getState(): ProcessState {
    return this.state;
  }

  /**
   * Transition to ready state. Only valid from 'initializing'.
   * Starts periodic health checks if configured.
   */
  markReady(): boolean {
    if (this.state !== 'initializing') {
      return false;
    }
    this.state = 'ready';

    if (this.config.healthCheckIntervalMs && this.config.healthCheckIntervalMs > 0) {
      this.healthCheckTimer = setInterval(() => {
        this.lastHealthStatus = this.computeHealth();
      }, this.config.healthCheckIntervalMs);
    }

    return true;
  }

  /**
   * Transition to draining state. Only valid from 'ready'.
   * Stops accepting new work.
   */
  startDrain(): boolean {
    if (this.state !== 'ready') {
      return false;
    }
    this.state = 'draining';
    return true;
  }

  /**
   * Transition to stopped state. Only valid from 'draining' or 'initializing'.
   * Closes database connection.
   */
  markStopped(): boolean {
    if (this.state !== 'draining' && this.state !== 'initializing') {
      return false;
    }
    this.state = 'stopped';

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    return true;
  }

  // ─── Admission Control ────────────────────────────────────────

  /**
   * Check if the process is accepting new work.
   * Returns true only in 'ready' state.
   */
  isAcceptingWork(): boolean {
    return this.state === 'ready';
  }

  // ─── Operation Tracking ───────────────────────────────────────

  /**
   * Register a pending operation for tracking and cancellation support.
   * Returns an AbortSignal the caller should pass to its work.
   * Returns null if the process is not accepting work.
   *
   * @param id - Unique operation identifier
   * @param description - Human-readable description
   * @param drainPolicy - How this operation behaves during graceful drain.
   *   'cancel-immediate' (default): aborted as soon as drain starts.
   *   'wait-for-completion': allowed to complete within drain deadline.
   */
  registerOperation(id: string, description: string, drainPolicy: DrainPolicy = 'cancel-immediate'): AbortSignal | null {
    if (!this.isAcceptingWork()) {
      return null;
    }

    const abortController = new AbortController();
    this.pendingOperations.set(id, {
      id,
      description,
      abortController,
      drainPolicy,
      startedAt: Date.now(),
    });

    return abortController.signal;
  }

  /**
   * Mark an operation as complete and remove it from tracking.
   */
  completeOperation(id: string): boolean {
    return this.pendingOperations.delete(id);
  }

  /**
   * Cancel a specific pending operation.
   */
  cancelOperation(id: string): boolean {
    const op = this.pendingOperations.get(id);
    if (!op) return false;
    op.abortController.abort();
    this.pendingOperations.delete(id);
    return true;
  }

  /**
   * Get the count of pending operations.
   */
  getPendingCount(): number {
    return this.pendingOperations.size;
  }

  /**
   * Get a snapshot of all pending operations (for diagnostics).
   */
  getPendingOperations(): Array<{ id: string; description: string; startedAt: number; drainPolicy: DrainPolicy }> {
    return Array.from(this.pendingOperations.values()).map(op => ({
      id: op.id,
      description: op.description,
      startedAt: op.startedAt,
      drainPolicy: op.drainPolicy,
    }));
  }

  // ─── Graceful Drain ───────────────────────────────────────────

  /**
   * Perform graceful drain:
   * 1. Stop accepting new work (transition to draining)
   * 2. Cancel operations with 'cancel-immediate' policy
   * 3. Wait for 'wait-for-completion' operations within deadline
   * 4. Cancel remaining operations if deadline exceeded
   * 5. Flush committed outbox records and checkpoints
   * 6. Close SharedDatabase connection
   *
   * Requirement 32.6: stop accepting new work, cancel or drain in-flight
   * work according to operation policy, flush committed outbox state,
   * and close Shared_Database.
   *
   * Returns result of drain including cancelled and waited operations.
   */
  async gracefulDrain(): Promise<{
    completed: boolean;
    cancelledOps: string[];
    waitedOps: string[];
    timedOut: boolean;
    outboxFlushed: boolean;
  }> {
    // Transition to draining
    if (this.state === 'ready') {
      this.startDrain();
    }

    const cancelledOps: string[] = [];
    const waitedOps: string[] = [];
    const deadline = Date.now() + this.config.drainDeadlineMs;

    // Phase 1: Immediately cancel operations with 'cancel-immediate' policy
    for (const [id, op] of this.pendingOperations) {
      if (op.drainPolicy === 'cancel-immediate') {
        op.abortController.abort();
        cancelledOps.push(id);
        this.pendingOperations.delete(id);
      }
    }

    // Phase 2: Wait for 'wait-for-completion' operations within deadline
    let timedOut = false;
    while (this.pendingOperations.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        // Force cancel remaining operations
        for (const [id, op] of this.pendingOperations) {
          op.abortController.abort();
          cancelledOps.push(id);
        }
        this.pendingOperations.clear();
        break;
      }

      // Record which ops we're waiting for
      const waitingIds = Array.from(this.pendingOperations.keys());
      for (const id of waitingIds) {
        if (!waitedOps.includes(id)) {
          waitedOps.push(id);
        }
      }

      // Wait a short interval, then re-check
      await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 50)));

      // Remove ops that completed during the wait
      // (completeOperation may be called externally)
    }

    // Phase 3: Flush committed outbox records and checkpoints
    let outboxFlushed = false;
    if (this.outboxFlusher) {
      try {
        this.outboxFlusher.flush();
        outboxFlushed = true;
      } catch {
        // Best-effort flush; don't block shutdown on flush failure
        outboxFlushed = false;
      }
    } else {
      // No outbox attached — considered flushed
      outboxFlushed = true;
    }

    // Phase 4: Close database
    if (this.database && !this.database.isClosed) {
      this.database.close();
    }

    // Transition to stopped
    this.markStopped();

    return { completed: !timedOut, cancelledOps, waitedOps, timedOut, outboxFlushed };
  }

  // ─── Health ───────────────────────────────────────────────────

  /**
   * Get the current health status. Returns cached status if available,
   * otherwise computes fresh.
   * Requirement 30.11: Report process version, protocol version, uptime,
   * draining state, and database connectivity/compatibility.
   */
  getHealth(): HealthStatus {
    if (this.lastHealthStatus && (Date.now() - new Date(this.lastHealthStatus.timestamp).getTime()) < 1000) {
      return this.lastHealthStatus;
    }
    this.lastHealthStatus = this.computeHealth();
    return this.lastHealthStatus;
  }

  /**
   * Compute a fresh health status based on all dependencies.
   */
  private computeHealth(): HealthStatus {
    const dbHealth = this.checkDatabaseHealth();
    const migrationHealth = this.checkMigrationHealth();
    const schemaHealth = this.checkSchemaHealth();
    const authorityHealth = this.checkAuthorityHealth();

    const components = [dbHealth.health, migrationHealth.health, schemaHealth.health, authorityHealth.health];
    let overall: ComponentHealth = 'healthy';
    if (components.some(c => c === 'unavailable')) {
      overall = 'unavailable';
    } else if (components.some(c => c === 'degraded')) {
      overall = 'degraded';
    }

    return {
      processVersion: this.config.processVersion,
      protocolVersion: this.config.protocolVersion,
      state: this.state,
      uptime: Date.now() - this.startTime,
      draining: this.state === 'draining',
      negotiatedCapabilities: this.negotiatedCapabilities,
      database: dbHealth,
      migration: migrationHealth,
      schema: schemaHealth,
      authorities: authorityHealth,
      overall,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Readiness ────────────────────────────────────────────────

  /**
   * Check readiness. Reports ready ONLY when all checks pass
   * and the state allows accepting work.
   * Requirement 32.7: Report protocol initialization, database compatibility,
   * migration state, required authority availability, and draining state.
   */
  getReadiness(): ReadinessReport {
    const protocolCheck = this.isProtocolNegotiated();
    const dbCheck = this.checkDatabaseConnectivity();
    const migrationCheck = this.checkMigrationState();
    const schemaCheck = this.checkSchemaCompatibility();
    const authorityCheck = this.checkAuthorityAvailability();

    const allPassed = protocolCheck && dbCheck && migrationCheck && schemaCheck && authorityCheck;
    const ready = allPassed && this.state === 'ready';

    let reason: string | undefined;
    if (!allPassed) {
      const failures: string[] = [];
      if (!protocolCheck) failures.push('protocol negotiation');
      if (!dbCheck) failures.push('database connectivity');
      if (!migrationCheck) failures.push('migration state');
      if (!schemaCheck) failures.push('schema compatibility');
      if (!authorityCheck) failures.push('authority availability');
      reason = `Failed checks: ${failures.join(', ')}`;
    } else if (this.state !== 'ready') {
      reason = `Process state is '${this.state}', not 'ready'`;
    }

    return {
      ready,
      state: this.state,
      protocolNegotiated: protocolCheck,
      checks: {
        protocol: protocolCheck,
        database: dbCheck,
        migration: migrationCheck,
        schema: schemaCheck,
        authorities: authorityCheck,
      },
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  // ─── Individual Health Checks ─────────────────────────────────

  /**
   * Check if the database is connected and queryable.
   */
  private checkDatabaseConnectivity(): boolean {
    if (!this.database) return false;
    if (this.database.isClosed) return false;

    try {
      // Attempt a simple query to verify connectivity
      this.database.raw.pragma('integrity_check', { simple: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if all migrations are applied (none pending or failed).
   */
  private checkMigrationState(): boolean {
    if (!this.migrationRunner) return false;

    try {
      const status = this.migrationRunner.getStatus();
      return status.pending === 0 && status.failed === 0;
    } catch {
      return false;
    }
  }

  /**
   * Check schema compatibility via FencedMigrationCoordinator.
   */
  private checkSchemaCompatibility(): boolean {
    if (!this.coordinator) return false;

    try {
      const result = this.coordinator.checkStartupCompatibility(this.config.processName);
      return result.compatible;
    } catch {
      return false;
    }
  }

  /**
   * Check if all required authority extension ports are available.
   */
  private checkAuthorityAvailability(): boolean {
    if (!this.authorityChecker) {
      // If no checker is attached but no authorities are required, pass
      return this.config.requiredAuthorities.length === 0;
    }

    const available = new Set(this.authorityChecker.getAvailableAuthorities());
    return this.config.requiredAuthorities.every(auth => available.has(auth));
  }

  // ─── Structured Health Check Helpers ──────────────────────────

  private checkDatabaseHealth(): HealthStatus['database'] {
    if (!this.database) {
      return { connected: false, compatible: false, health: 'unavailable', reason: 'No database attached' };
    }
    if (this.database.isClosed) {
      return { connected: false, compatible: false, health: 'unavailable', reason: 'Database is closed' };
    }

    try {
      this.database.raw.pragma('integrity_check', { simple: true });
      return { connected: true, compatible: true, health: 'healthy' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { connected: false, compatible: false, health: 'unavailable', reason: message };
    }
  }

  private checkMigrationHealth(): HealthStatus['migration'] {
    if (!this.migrationRunner) {
      return { allApplied: false, pending: 0, failed: 0, health: 'unavailable', reason: 'No migration runner attached' };
    }

    try {
      const status = this.migrationRunner.getStatus();
      if (status.failed > 0) {
        return {
          allApplied: false,
          pending: status.pending,
          failed: status.failed,
          health: 'unavailable',
          reason: `${status.failed} migration(s) failed`,
        };
      }
      if (status.pending > 0) {
        return {
          allApplied: false,
          pending: status.pending,
          failed: 0,
          health: 'degraded',
          reason: `${status.pending} migration(s) pending`,
        };
      }
      return { allApplied: true, pending: 0, failed: 0, health: 'healthy' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { allApplied: false, pending: 0, failed: 0, health: 'unavailable', reason: message };
    }
  }

  private checkSchemaHealth(): HealthStatus['schema'] {
    if (!this.coordinator) {
      return {
        compatible: false,
        observedVersion: 0,
        readRange: [0, 0],
        writeRange: [0, 0],
        health: 'unavailable',
        reason: 'No coordinator attached',
      };
    }

    try {
      const result = this.coordinator.checkStartupCompatibility(this.config.processName);
      return {
        compatible: result.compatible,
        observedVersion: result.observedVersion,
        readRange: result.readRange,
        writeRange: result.writeRange,
        health: result.compatible ? 'healthy' : 'unavailable',
        ...(result.compatible ? {} : { reason: result.reason }),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        compatible: false,
        observedVersion: 0,
        readRange: [0, 0],
        writeRange: [0, 0],
        health: 'unavailable',
        reason: message,
      };
    }
  }

  private checkAuthorityHealth(): HealthStatus['authorities'] {
    if (!this.authorityChecker) {
      if (this.config.requiredAuthorities.length === 0) {
        return { allAvailable: true, available: [], unavailable: [], health: 'healthy' };
      }
      return {
        allAvailable: false,
        available: [],
        unavailable: [...this.config.requiredAuthorities],
        health: 'unavailable',
        reason: 'No authority checker attached',
      };
    }

    const available = this.authorityChecker.getAvailableAuthorities();
    const availableSet = new Set(available);
    const unavailable = this.config.requiredAuthorities.filter(a => !availableSet.has(a));
    const allAvailable = unavailable.length === 0;

    return {
      allAvailable,
      available,
      unavailable,
      health: allAvailable ? 'healthy' : (unavailable.length < this.config.requiredAuthorities.length ? 'degraded' : 'unavailable'),
      ...(allAvailable ? {} : { reason: `Unavailable authorities: ${unavailable.join(', ')}` }),
    };
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Dispose of resources. Safe to call multiple times.
   */
  dispose(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Cancel any remaining operations
    for (const [, op] of this.pendingOperations) {
      op.abortController.abort();
    }
    this.pendingOperations.clear();
    this.progressListeners = [];
  }
}
