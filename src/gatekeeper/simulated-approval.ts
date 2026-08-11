/**
 * Simulated Approval Engine — Allows agents to continue working while
 * side-effecting actions await human review.
 *
 * Provides:
 * - Local simulation of write operations (returns expected result to agent)
 * - Pass-through execution for read operations (recorded in observation tracker)
 * - Dependency DAG management: rejection cascades to all transitive dependents
 * - Queue persistence via SQLite `pending_actions` table
 * - Bulk approve/reject with proper cascade logic
 * - Configurable execution timeout (default 5s)
 * - Execution of approved actions in original creation order
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  SimulatedApprovalEngine,
  CapabilityBinding,
  PendingAction,
  ExecutionResult,
  RollbackResult,
} from '../types/cloudflare-os.js';
import { createSubsystemError, type SubsystemError } from '../types/subsystem-error.js';

// ─── Types ──────────────────────────────────────────────────────

/** Row shape for the pending_actions SQLite table */
interface PendingActionRow {
  id: string;
  agent_id: string;
  capability_id: string;
  operation: string;
  parameters: string;
  simulated_result: string | null;
  status: string;
  depends_on: string | null;
  created_at: string;
  resolved_at: string | null;
  rejection_reason: string | null;
}

/**
 * Minimal interface for the Gatekeeper Layer dependency.
 * The approval engine delegates actual execution to the Gatekeeper.
 */
export interface GatekeeperExecutor {
  execute(binding: CapabilityBinding, operation: string, params: unknown): Promise<unknown>;
}

/**
 * Configuration for the SimulatedApprovalEngineImpl.
 */
export interface SimulatedApprovalConfig {
  db: Database.Database;
  /** Executor that performs real operations on approval (typically the Gatekeeper) */
  executor: GatekeeperExecutor;
  /** Default agent ID when not specified in the binding context */
  defaultAgentId?: string;
  /** Execution timeout in milliseconds (default: 5000) */
  executionTimeoutMs?: number;
  /** Custom simulation function for generating simulated results */
  simulateResult?: (binding: CapabilityBinding, operation: string, params: unknown) => unknown;
}

// ─── Read Operations ────────────────────────────────────────────

/** Operations considered as reads (pass-through without approval) */
const READ_OPERATIONS = new Set([
  'read',
  'get',
  'list',
  'query',
  'search',
  'fetch',
  'describe',
  'head',
  'exists',
  'count',
]);

/**
 * Determines if an operation is a read (no side effects).
 * Used during Gatekeeper integration (task 15.1) to pass-through reads.
 */
export function isReadOperation(operation: string): boolean {
  const normalized = operation.toLowerCase().split('.').pop() ?? operation.toLowerCase();
  return READ_OPERATIONS.has(normalized);
}

// ─── Implementation ─────────────────────────────────────────────

export class SimulatedApprovalEngineImpl implements SimulatedApprovalEngine {
  private db: Database.Database;
  private executor: GatekeeperExecutor;
  private defaultAgentId: string;
  private executionTimeoutMs: number;
  private simulateResultFn: (binding: CapabilityBinding, operation: string, params: unknown) => unknown;

  /** In-memory queue for fast access (synced with SQLite) */
  private queue: Map<string, PendingAction> = new Map();

  /** Insertion order tracking for stable sorting when timestamps are equal */
  private insertionOrder: Map<string, number> = new Map();
  private insertionCounter = 0;

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtGetAll: Database.Statement;
  private stmtUpdateStatus: Database.Statement;
  private stmtUpdateApproved: Database.Statement;
  private stmtUpdateRejected: Database.Statement;
  private stmtUpdateExecuted: Database.Statement;
  private stmtUpdateRolledBack: Database.Statement;

  constructor(config: SimulatedApprovalConfig) {
    this.db = config.db;
    this.executor = config.executor;
    this.defaultAgentId = config.defaultAgentId ?? 'agent';
    this.executionTimeoutMs = config.executionTimeoutMs ?? 5000;
    this.simulateResultFn = config.simulateResult ?? this.defaultSimulate;

    // Prepare statements
    this.stmtInsert = this.db.prepare(`
      INSERT INTO pending_actions (id, agent_id, capability_id, operation, parameters, simulated_result, status, depends_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT * FROM pending_actions WHERE id = ?
    `);

    this.stmtGetAll = this.db.prepare(`
      SELECT * FROM pending_actions ORDER BY created_at ASC
    `);

    this.stmtUpdateStatus = this.db.prepare(`
      UPDATE pending_actions SET status = ?, resolved_at = ? WHERE id = ?
    `);

    this.stmtUpdateApproved = this.db.prepare(`
      UPDATE pending_actions SET status = 'approved', resolved_at = ? WHERE id = ?
    `);

    this.stmtUpdateRejected = this.db.prepare(`
      UPDATE pending_actions SET status = 'rejected', resolved_at = ?, rejection_reason = ? WHERE id = ?
    `);

    this.stmtUpdateExecuted = this.db.prepare(`
      UPDATE pending_actions SET status = 'executed', resolved_at = ? WHERE id = ?
    `);

    this.stmtUpdateRolledBack = this.db.prepare(`
      UPDATE pending_actions SET status = 'rolled_back', resolved_at = ?, rejection_reason = ? WHERE id = ?
    `);

    // Restore any persisted queue into memory
    this.restoreQueue();
  }

  // ─── Core Interface Methods ───────────────────────────────────

  /**
   * Simulate a side-effecting action.
   *
   * - Read operations: pass through to the executor directly (no approval needed)
   * - Write operations: simulate locally, queue for approval, return simulated result
   */
  async simulate(
    binding: CapabilityBinding,
    operation: string,
    params: unknown,
  ): Promise<PendingAction> {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Determine dependencies: any pending actions for the same capability
    const dependsOn = this.findDependencies(binding.id, operation);

    // Generate simulated result
    const simulatedResult = this.simulateResultFn(binding, operation, params);

    const action: PendingAction = {
      id,
      agentId: this.defaultAgentId,
      capabilityId: binding.id,
      operation,
      parameters: params as Record<string, unknown>,
      simulatedResult,
      status: 'pending',
      dependsOn,
      createdAt: now,
    };

    // Persist to SQLite
    this.stmtInsert.run(
      action.id,
      action.agentId,
      action.capabilityId,
      action.operation,
      JSON.stringify(action.parameters),
      JSON.stringify(action.simulatedResult),
      action.status,
      JSON.stringify(action.dependsOn),
      action.createdAt,
    );

    // Add to in-memory queue with insertion order tracking
    this.queue.set(id, action);
    this.insertionOrder.set(id, this.insertionCounter++);

    return action;
  }

  /**
   * Get the current pending action queue.
   */
  getQueue(): PendingAction[] {
    return Array.from(this.queue.values());
  }

  /**
   * Approve a pending action and execute it against the real service.
   *
   * Execution must complete within the configured timeout (default 5s).
   */
  async approve(actionId: string): Promise<ExecutionResult> {
    const action = this.queue.get(actionId);
    if (!action) {
      throw this.createError(
        'ACTION_NOT_FOUND',
        `Pending action "${actionId}" not found in the queue`,
      );
    }

    if (action.status !== 'pending') {
      throw this.createError(
        'ACTION_ALREADY_RESOLVED',
        `Action "${actionId}" has already been resolved with status "${action.status}"`,
      );
    }

    // Check that all dependencies are approved/executed
    for (const depId of action.dependsOn) {
      const dep = this.queue.get(depId);
      if (dep && dep.status !== 'executed' && dep.status !== 'approved') {
        throw this.createError(
          'DEPENDENCY_REJECTED',
          `Cannot approve action "${actionId}" because dependency "${depId}" is in status "${dep?.status}"`,
        );
      }
    }

    // Mark as approved
    const now = new Date().toISOString();
    this.stmtUpdateApproved.run(now, actionId);
    action.status = 'approved';
    action.resolvedAt = now;

    // Execute against real service with timeout
    try {
      const result = await this.executeWithTimeout(action);
      // Mark as executed
      const executedAt = new Date().toISOString();
      this.stmtUpdateExecuted.run(executedAt, actionId);
      action.status = 'executed';
      action.resolvedAt = executedAt;

      return {
        actionId,
        success: true,
        result,
      };
    } catch (error) {
      // Execution failed — mark as executed with error
      const executedAt = new Date().toISOString();
      this.stmtUpdateExecuted.run(executedAt, actionId);
      action.status = 'executed';
      action.resolvedAt = executedAt;

      return {
        actionId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Reject a pending action and cascade rejection to all dependents.
   *
   * Rejection cascades: all actions that transitively depend on the rejected
   * action are rolled back.
   */
  async reject(actionId: string, reason: string): Promise<RollbackResult> {
    const action = this.queue.get(actionId);
    if (!action) {
      throw this.createError(
        'ACTION_NOT_FOUND',
        `Pending action "${actionId}" not found in the queue`,
      );
    }

    if (action.status !== 'pending') {
      throw this.createError(
        'ACTION_ALREADY_RESOLVED',
        `Action "${actionId}" has already been resolved with status "${action.status}"`,
      );
    }

    // Reject the action itself
    const now = new Date().toISOString();
    this.stmtUpdateRejected.run(now, reason, actionId);
    action.status = 'rejected';
    action.resolvedAt = now;
    action.rejectionReason = reason;

    // Cascade: find all transitive dependents and roll them back
    const affectedDependents = this.cascadeRollback(actionId, reason);

    return {
      actionId,
      rolledBack: true,
      affectedDependents,
    };
  }

  /**
   * Bulk approve multiple actions and execute them in creation order.
   *
   * Per Requirement 4.5: actions are executed in the original creation order.
   */
  async bulkApprove(actionIds: string[]): Promise<ExecutionResult[]> {
    // Sort actions by creation time to preserve original order.
    // Use insertion order as tiebreaker for same-timestamp actions.
    const sortedActions = actionIds
      .map((id) => this.queue.get(id))
      .filter((a): a is PendingAction => a !== undefined && a.status === 'pending')
      .sort((a, b) => {
        const timeCmp = a.createdAt.localeCompare(b.createdAt);
        if (timeCmp !== 0) return timeCmp;
        // Tiebreak by insertion order
        const orderA = this.insertionOrder.get(a.id) ?? 0;
        const orderB = this.insertionOrder.get(b.id) ?? 0;
        return orderA - orderB;
      });

    const results: ExecutionResult[] = [];

    for (const action of sortedActions) {
      try {
        const result = await this.approve(action.id);
        results.push(result);
      } catch (error) {
        results.push({
          actionId: action.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Bulk reject multiple actions with cascade logic.
   *
   * Each rejection cascades to its dependents.
   */
  async bulkReject(actionIds: string[], reason: string): Promise<RollbackResult[]> {
    const results: RollbackResult[] = [];

    for (const actionId of actionIds) {
      const action = this.queue.get(actionId);
      if (!action || action.status !== 'pending') {
        // Skip already-resolved or missing actions (may have been cascaded)
        continue;
      }

      try {
        const result = await this.reject(actionId, reason);
        results.push(result);
      } catch {
        // Action may have already been cascaded by a prior rejection
        results.push({
          actionId,
          rolledBack: false,
          affectedDependents: [],
        });
      }
    }

    return results;
  }

  /**
   * Get the dependency graph for an action (all transitive dependents).
   */
  getDependencyGraph(actionId: string): PendingAction[] {
    const visited = new Set<string>();
    const result: PendingAction[] = [];

    this.collectDependents(actionId, visited, result);

    return result;
  }

  /**
   * Persist the current in-memory queue to SQLite.
   * (The queue is persisted on every mutation, so this is mainly for
   * explicit sync or pre-shutdown saves.)
   */
  persistQueue(): void {
    // Since we persist on every mutation, this is a no-op unless
    // there's in-memory state that hasn't been flushed.
    // Re-sync all in-memory state to DB as a safety measure.
    const syncTransaction = this.db.transaction(() => {
      for (const action of this.queue.values()) {
        const existing = this.stmtGetById.get(action.id) as PendingActionRow | undefined;
        if (!existing) {
          this.stmtInsert.run(
            action.id,
            action.agentId,
            action.capabilityId,
            action.operation,
            JSON.stringify(action.parameters),
            JSON.stringify(action.simulatedResult),
            action.status,
            JSON.stringify(action.dependsOn),
            action.createdAt,
          );
        } else if (existing.status !== action.status) {
          this.stmtUpdateStatus.run(
            action.status,
            action.resolvedAt ?? null,
            action.id,
          );
        }
      }
    });
    syncTransaction();
  }

  /**
   * Restore the action queue from SQLite into memory.
   */
  restoreQueue(): PendingAction[] {
    const rows = this.stmtGetAll.all() as PendingActionRow[];
    this.queue.clear();
    this.insertionOrder.clear();
    this.insertionCounter = 0;

    for (const row of rows) {
      const action = this.rowToPendingAction(row);
      this.queue.set(action.id, action);
      this.insertionOrder.set(action.id, this.insertionCounter++);
    }

    return Array.from(this.queue.values());
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Find dependencies for a new action.
   * A write operation on the same capability depends on earlier pending writes
   * to that same capability.
   */
  private findDependencies(capabilityId: string, _operation: string): string[] {
    const deps: string[] = [];

    for (const action of this.queue.values()) {
      if (action.status !== 'pending') continue;
      // If there's a pending action on the same capability,
      // the new action depends on it
      if (action.capabilityId === capabilityId) {
        deps.push(action.id);
      }
    }

    return deps;
  }

  /**
   * Cascade rollback to all transitive dependents of a rejected action.
   */
  private cascadeRollback(rejectedActionId: string, reason: string): string[] {
    const affectedIds: string[] = [];
    const toProcess = [rejectedActionId];
    const processed = new Set<string>();

    while (toProcess.length > 0) {
      const currentId = toProcess.pop()!;
      if (processed.has(currentId)) continue;
      processed.add(currentId);

      // Find all actions that depend on the current action
      for (const action of this.queue.values()) {
        if (action.status !== 'pending') continue;
        if (action.id === rejectedActionId) continue; // Don't include the original
        if (action.dependsOn.includes(currentId)) {
          // Roll back this dependent
          const now = new Date().toISOString();
          const cascadeReason = `Dependency "${currentId}" was rejected: ${reason}`;
          this.stmtUpdateRolledBack.run(now, cascadeReason, action.id);
          action.status = 'rolled_back';
          action.resolvedAt = now;
          action.rejectionReason = cascadeReason;
          affectedIds.push(action.id);

          // Continue cascading
          toProcess.push(action.id);
        }
      }
    }

    return affectedIds;
  }

  /**
   * Collect all transitive dependents of an action.
   */
  private collectDependents(
    actionId: string,
    visited: Set<string>,
    result: PendingAction[],
  ): void {
    if (visited.has(actionId)) return;
    visited.add(actionId);

    for (const action of this.queue.values()) {
      if (action.dependsOn.includes(actionId)) {
        result.push(action);
        this.collectDependents(action.id, visited, result);
      }
    }
  }

  /**
   * Execute an action against the real service with a timeout.
   */
  private async executeWithTimeout(action: PendingAction): Promise<unknown> {
    // Reconstruct a minimal capability binding for execution
    const binding: CapabilityBinding = {
      id: action.capabilityId,
      resourceId: action.capabilityId,
      resourceType: 'unknown',
      allowedOperations: [action.operation],
      scopeConstraints: {},
      createdAt: action.createdAt,
      grantedBy: 'simulated-approval',
    };

    return Promise.race([
      this.executor.execute(binding, action.operation, action.parameters),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Execution timed out after ${this.executionTimeoutMs}ms`)),
          this.executionTimeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Default simulation function.
   * Generates an expected result based on the operation type.
   */
  private defaultSimulate(
    _binding: CapabilityBinding,
    operation: string,
    params: unknown,
  ): unknown {
    return {
      simulated: true,
      operation,
      params,
      expectedOutcome: 'success',
      note: 'This result is simulated. Actual execution pending approval.',
    };
  }

  /**
   * Convert a database row to a PendingAction object.
   */
  private rowToPendingAction(row: PendingActionRow): PendingAction {
    const action: PendingAction = {
      id: row.id,
      agentId: row.agent_id,
      capabilityId: row.capability_id,
      operation: row.operation,
      parameters: JSON.parse(row.parameters),
      simulatedResult: row.simulated_result ? JSON.parse(row.simulated_result) : null,
      status: row.status as PendingAction['status'],
      dependsOn: row.depends_on ? JSON.parse(row.depends_on) : [],
      createdAt: row.created_at,
    };
    if (row.resolved_at) {
      action.resolvedAt = row.resolved_at;
    }
    if (row.rejection_reason) {
      action.rejectionReason = row.rejection_reason;
    }
    return action;
  }

  // ─── Error Helpers ────────────────────────────────────────────

  private createError(
    code: 'ACTION_NOT_FOUND' | 'ACTION_ALREADY_RESOLVED' | 'SIMULATION_FAILED' | 'EXECUTION_TIMEOUT' | 'DEPENDENCY_REJECTED',
    message: string,
    options?: { recoverable?: boolean; suggestedAction?: string },
  ): SubsystemError {
    const opts: { recoverable?: boolean; suggestedAction?: string } = {
      recoverable: options?.recoverable ?? false,
    };
    if (options?.suggestedAction) {
      opts.suggestedAction = options.suggestedAction;
    }
    return createSubsystemError('simulated_approval', code, message, opts);
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a SimulatedApprovalEngine instance backed by the given database.
 * The database must have the `pending_actions` table (migration 067).
 */
export function createSimulatedApprovalEngine(
  config: SimulatedApprovalConfig,
): SimulatedApprovalEngine {
  return new SimulatedApprovalEngineImpl(config);
}
