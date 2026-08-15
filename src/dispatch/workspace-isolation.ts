/**
 * WorkspaceIsolationService — Dependency scheduling and guarded workspace isolation.
 *
 * Implements the four-level isolation strategy (R14.4):
 *   Level 1: Git worktrees (strongest isolation)
 *   Level 2: Scope serialization (queue overlapping runs)
 *   Level 3: Explicit edit locks
 *   Level 4: Guarded unprotected overlap (LAST RESORT) with mandatory risk surfacing
 *
 * Also provides:
 * - DependencyScheduler: checks blocking deps are completed/waived before dispatch
 * - ScopeOverlapDetector: compares declared+inferred scopes for overlap
 * - RunWorkspaceResolver: resolves operations against run workspace, not global path
 * - Evidence persistence for guarded-fallback engagement
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Dependency status for scheduling decisions.
 */
export type DependencyStatus = 'completed' | 'waived' | 'pending' | 'failed' | 'cancelled';

/**
 * A task dependency record used for scheduling.
 */
export interface TaskDependency {
  readonly taskId: string;
  readonly status: DependencyStatus;
}

/**
 * File scope declaration for a run — may be declared up front or inferred.
 */
export interface FileScope {
  /** File paths that may be written */
  readonly writePaths: readonly string[];
  /** File paths that are read-only */
  readonly readPaths: readonly string[];
  /** Whether this scope was declared or inferred */
  readonly source: 'declared' | 'inferred';
}

/**
 * Overlap detection result between two scopes.
 */
export interface ScopeOverlap {
  readonly runIdA: string;
  readonly runIdB: string;
  readonly overlappingPaths: readonly string[];
  readonly severity: 'write-write' | 'write-read';
}

/**
 * The isolation level applied to a run.
 */
export type IsolationLevel = 'worktree' | 'serialized' | 'locked' | 'guarded-unprotected';

/**
 * A workspace lease assigned to a run.
 */
export interface WorkspaceLease {
  readonly leaseId: string;
  readonly runId: string;
  readonly isolationLevel: IsolationLevel;
  /** Worktree path when level=worktree; otherwise the serialized/locked workspace path */
  readonly workspacePath: string;
  /** Branch name when worktree is used */
  readonly branch: string | null;
  readonly acquiredAt: string;
  readonly releasedAt: string | null;
  /** Scope that this lease covers */
  readonly scope: FileScope;
}

/**
 * Evidence recorded when guarded-unprotected fallback is engaged.
 */
export interface GuardedFallbackEvidence {
  readonly evidenceId: string;
  readonly affectedRunIds: readonly string[];
  readonly overlappingScopes: readonly ScopeOverlap[];
  readonly unavailabilityReasons: readonly UnavailabilityReason[];
  readonly timestamp: string;
  readonly workspaceRevision: string | null;
  readonly riskSurfaced: boolean;
}

/**
 * Why a particular isolation level was unavailable.
 */
export interface UnavailabilityReason {
  readonly level: 'worktree' | 'serialization' | 'lock';
  readonly reason: string;
}

/**
 * Project policy for workspace isolation behavior.
 */
export interface WorkspaceIsolationPolicy {
  /** Whether Git worktrees are enabled for this project */
  readonly worktreesEnabled: boolean;
  /** Whether Git is available in this workspace */
  readonly gitAvailable: boolean;
  /** Whether serialization fallback is available */
  readonly serializationAvailable: boolean;
  /** Whether explicit edit locks are available */
  readonly locksAvailable: boolean;
}

/**
 * Result of a dependency scheduling check.
 */
export interface SchedulingResult {
  readonly canDispatch: boolean;
  readonly blockedBy: readonly string[];
  readonly waivedDependencies: readonly string[];
}

/**
 * Result of requesting workspace isolation for a run.
 */
export interface IsolationResult {
  readonly success: boolean;
  readonly lease: WorkspaceLease | null;
  readonly isolationLevel: IsolationLevel | null;
  readonly evidence: GuardedFallbackEvidence | null;
  readonly error: string | null;
}

/**
 * Resolved workspace for a run — all operations resolve against this.
 */
export interface ResolvedRunWorkspace {
  readonly runId: string;
  readonly basePath: string;
  readonly branch: string | null;
  readonly isolationLevel: IsolationLevel;
  readonly leaseId: string;
}

/**
 * Risk notification surfaced when guarded fallback is used.
 */
export interface RiskNotification {
  readonly type: 'guarded-unprotected-overlap';
  readonly message: string;
  readonly affectedRunIds: readonly string[];
  readonly overlappingPaths: readonly string[];
  readonly evidenceId: string;
  readonly targets: readonly ('chat' | 'taskbar' | 'run-detail')[];
}

// ─── WorkspaceIsolationService ──────────────────────────────────────────────

/**
 * WorkspaceIsolationService orchestrates dependency scheduling,
 * scope overlap detection, workspace lease assignment, and evidence persistence.
 */
export class WorkspaceIsolationService {
  private readonly leases = new Map<string, WorkspaceLease>();
  private readonly leasesByRun = new Map<string, string>();
  private readonly evidence: GuardedFallbackEvidence[] = [];
  private readonly riskNotifications: RiskNotification[] = [];
  private readonly serializationQueue: string[] = [];
  private readonly editLocks = new Map<string, string>(); // path -> runId

  constructor(private readonly defaultWorkspacePath: string) {}

  // ─── Dependency Scheduling ──────────────────────────────────────────────

  /**
   * Check whether a task's blocking dependencies are all completed or waived.
   * Only allows dispatch when all blocking deps satisfy this criterion (R14.1).
   */
  checkDependencies(dependencies: readonly TaskDependency[]): SchedulingResult {
    const blockedBy: string[] = [];
    const waivedDependencies: string[] = [];

    for (const dep of dependencies) {
      if (dep.status === 'completed') {
        // OK — completed
        continue;
      }
      if (dep.status === 'waived') {
        waivedDependencies.push(dep.taskId);
        continue;
      }
      // pending, failed, cancelled — these block
      blockedBy.push(dep.taskId);
    }

    return {
      canDispatch: blockedBy.length === 0,
      blockedBy,
      waivedDependencies,
    };
  }

  // ─── Scope Overlap Detection ────────────────────────────────────────────

  /**
   * Compare declared + inferred scopes to detect overlapping writes (R14.2).
   */
  detectOverlaps(
    runId: string,
    scope: FileScope,
    existingLeases: readonly WorkspaceLease[],
  ): ScopeOverlap[] {
    const overlaps: ScopeOverlap[] = [];

    for (const lease of existingLeases) {
      // Skip released leases
      if (lease.releasedAt !== null) continue;
      // Skip same run
      if (lease.runId === runId) continue;

      // Check write-write overlaps
      const writeWriteOverlap = this.intersect(scope.writePaths, lease.scope.writePaths);
      if (writeWriteOverlap.length > 0) {
        overlaps.push({
          runIdA: runId,
          runIdB: lease.runId,
          overlappingPaths: writeWriteOverlap,
          severity: 'write-write',
        });
      }

      // Check write-read overlaps (new run writes, existing reads)
      const writeReadOverlap = this.intersect(scope.writePaths, lease.scope.readPaths);
      if (writeReadOverlap.length > 0) {
        overlaps.push({
          runIdA: runId,
          runIdB: lease.runId,
          overlappingPaths: writeReadOverlap,
          severity: 'write-read',
        });
      }

      // Check read-write overlaps (new run reads, existing writes)
      const readWriteOverlap = this.intersect(scope.readPaths, lease.scope.writePaths);
      if (readWriteOverlap.length > 0) {
        overlaps.push({
          runIdA: runId,
          runIdB: lease.runId,
          overlappingPaths: readWriteOverlap,
          severity: 'write-read',
        });
      }
    }

    return overlaps;
  }

  // ─── Workspace Lease Assignment ─────────────────────────────────────────

  /**
   * Acquire workspace isolation for a run following the four-level fallback (R14.3, R14.4).
   *
   * Level 1: Worktree — when policy enables and Git is available
   * Level 2: Serialize — queue overlapping runs when worktrees unavailable
   * Level 3: Edit locks — explicit file locks when serialization unavailable/fails
   * Level 4: Guarded unprotected — LAST RESORT, surfaces risk and persists Evidence
   */
  acquireIsolation(
    runId: string,
    scope: FileScope,
    policy: WorkspaceIsolationPolicy,
    overlaps: readonly ScopeOverlap[],
    workspaceRevision: string | null = null,
  ): IsolationResult {
    const hasOverlaps = overlaps.length > 0;

    // If there are no overlaps, any isolation level is fine — use worktree if enabled
    if (!hasOverlaps) {
      if (policy.worktreesEnabled && policy.gitAvailable) {
        return this.assignWorktree(runId, scope);
      }
      // No overlaps, assign a standard serialized lease at the default workspace path
      const lease = this.createLease(runId, 'serialized', this.defaultWorkspacePath, null, scope);
      return { success: true, lease, isolationLevel: 'serialized', evidence: null, error: null };
    }

    // ─── Level 1: Try worktrees ──────────────────────────────────────────
    const unavailabilityReasons: UnavailabilityReason[] = [];

    if (policy.worktreesEnabled && policy.gitAvailable) {
      return this.assignWorktree(runId, scope);
    }

    if (!policy.worktreesEnabled) {
      unavailabilityReasons.push({
        level: 'worktree',
        reason: 'Worktrees not enabled by project policy',
      });
    } else if (!policy.gitAvailable) {
      unavailabilityReasons.push({
        level: 'worktree',
        reason: 'Git is not available in this workspace',
      });
    }

    // ─── Level 2: Try serialization ──────────────────────────────────────
    if (policy.serializationAvailable) {
      const serialized = this.trySerialization(runId, scope);
      if (serialized.success) {
        return serialized;
      }
      unavailabilityReasons.push({
        level: 'serialization',
        reason: 'Serialization failed: ' + (serialized.error ?? 'unknown'),
      });
    } else {
      unavailabilityReasons.push({
        level: 'serialization',
        reason: 'Serialization not available in this environment',
      });
    }

    // ─── Level 3: Try edit locks ─────────────────────────────────────────
    if (policy.locksAvailable) {
      const locked = this.tryEditLocks(runId, scope);
      if (locked.success) {
        return locked;
      }
      unavailabilityReasons.push({
        level: 'lock',
        reason: 'Edit lock acquisition failed: ' + (locked.error ?? 'unknown'),
      });
    } else {
      unavailabilityReasons.push({
        level: 'lock',
        reason: 'Edit locks not available in this environment',
      });
    }

    // ─── Level 4: Guarded unprotected overlap (LAST RESORT) ──────────────
    return this.engageGuardedFallback(
      runId,
      scope,
      overlaps,
      unavailabilityReasons,
      workspaceRevision,
    );
  }

  // ─── Run Workspace Resolution ──────────────────────────────────────────

  /**
   * Resolve operations against the run's assigned workspace (R14.5).
   * All file, shell, Git, LSP, context, and validation operations use this path.
   */
  resolveRunWorkspace(runId: string): ResolvedRunWorkspace | null {
    const leaseId = this.leasesByRun.get(runId);
    if (!leaseId) return null;

    const lease = this.leases.get(leaseId);
    if (!lease) return null;

    return {
      runId,
      basePath: lease.workspacePath,
      branch: lease.branch,
      isolationLevel: lease.isolationLevel,
      leaseId: lease.leaseId,
    };
  }

  /**
   * Resolve a file path against the run's workspace.
   * Prevents resolution against a global active path.
   */
  resolveFilePath(runId: string, relativePath: string): string | null {
    const workspace = this.resolveRunWorkspace(runId);
    if (!workspace) return null;
    // Normalize: strip leading slash for join
    const cleaned = relativePath.startsWith('/')
      ? relativePath
      : `${workspace.basePath}/${relativePath}`;
    return cleaned.startsWith(workspace.basePath) ? cleaned : `${workspace.basePath}/${relativePath}`;
  }

  // ─── Lease Management ──────────────────────────────────────────────────

  /**
   * Release a workspace lease when a run completes.
   */
  releaseLease(runId: string): boolean {
    const leaseId = this.leasesByRun.get(runId);
    if (!leaseId) return false;

    const lease = this.leases.get(leaseId);
    if (!lease) return false;

    const released: WorkspaceLease = {
      ...lease,
      releasedAt: new Date().toISOString(),
    };
    this.leases.set(leaseId, released);

    // Release any edit locks held by this run
    for (const [path, holdingRunId] of this.editLocks) {
      if (holdingRunId === runId) {
        this.editLocks.delete(path);
      }
    }

    // Remove from serialization queue
    const idx = this.serializationQueue.indexOf(runId);
    if (idx >= 0) {
      this.serializationQueue.splice(idx, 1);
    }

    return true;
  }

  /**
   * Get all active (unreleased) leases.
   */
  getActiveLeases(): WorkspaceLease[] {
    return [...this.leases.values()].filter((l) => l.releasedAt === null);
  }

  /**
   * Get the lease for a specific run.
   */
  getLeaseForRun(runId: string): WorkspaceLease | null {
    const leaseId = this.leasesByRun.get(runId);
    if (!leaseId) return null;
    return this.leases.get(leaseId) ?? null;
  }

  // ─── Evidence & Risk ────────────────────────────────────────────────────

  /**
   * Get all guarded-fallback evidence records.
   */
  getGuardedFallbackEvidence(): readonly GuardedFallbackEvidence[] {
    return this.evidence;
  }

  /**
   * Get all risk notifications.
   */
  getRiskNotifications(): readonly RiskNotification[] {
    return this.riskNotifications;
  }

  // ─── Private: Level 1 — Worktree Assignment ────────────────────────────

  private assignWorktree(runId: string, scope: FileScope): IsolationResult {
    const branch = `run/${runId}`;
    const worktreePath = `${this.defaultWorkspacePath}/.worktrees/${runId}`;

    const lease = this.createLease(runId, 'worktree', worktreePath, branch, scope);

    return {
      success: true,
      lease,
      isolationLevel: 'worktree',
      evidence: null,
      error: null,
    };
  }

  // ─── Private: Level 2 — Serialization ──────────────────────────────────

  private trySerialization(runId: string, scope: FileScope): IsolationResult {
    // Queue this run for serialized execution
    this.serializationQueue.push(runId);

    const lease = this.createLease(
      runId,
      'serialized',
      this.defaultWorkspacePath,
      null,
      scope,
    );

    return {
      success: true,
      lease,
      isolationLevel: 'serialized',
      evidence: null,
      error: null,
    };
  }

  // ─── Private: Level 3 — Edit Locks ─────────────────────────────────────

  private tryEditLocks(runId: string, scope: FileScope): IsolationResult {
    // Try to acquire locks on all write paths
    const lockedPaths: string[] = [];

    for (const path of scope.writePaths) {
      const holder = this.editLocks.get(path);
      if (holder && holder !== runId) {
        // Conflict — release what we acquired and fail
        for (const acquired of lockedPaths) {
          this.editLocks.delete(acquired);
        }
        return {
          success: false,
          lease: null,
          isolationLevel: null,
          evidence: null,
          error: `Path '${path}' is locked by run '${holder}'`,
        };
      }
      lockedPaths.push(path);
    }

    // Successfully acquired all locks
    for (const path of lockedPaths) {
      this.editLocks.set(path, runId);
    }

    const lease = this.createLease(
      runId,
      'locked',
      this.defaultWorkspacePath,
      null,
      scope,
    );

    return {
      success: true,
      lease,
      isolationLevel: 'locked',
      evidence: null,
      error: null,
    };
  }

  // ─── Private: Level 4 — Guarded Unprotected ────────────────────────────

  private engageGuardedFallback(
    runId: string,
    scope: FileScope,
    overlaps: readonly ScopeOverlap[],
    unavailabilityReasons: readonly UnavailabilityReason[],
    workspaceRevision: string | null,
  ): IsolationResult {
    const affectedRunIds = [
      runId,
      ...new Set(overlaps.flatMap((o) => [o.runIdA, o.runIdB])),
    ];

    const evidenceRecord: GuardedFallbackEvidence = {
      evidenceId: randomUUID(),
      affectedRunIds,
      overlappingScopes: overlaps,
      unavailabilityReasons: [...unavailabilityReasons],
      timestamp: new Date().toISOString(),
      workspaceRevision,
      riskSurfaced: true,
    };
    this.evidence.push(evidenceRecord);

    // Surface risk notification to chat/taskbar/run-detail
    const overlappingPaths = [...new Set(overlaps.flatMap((o) => o.overlappingPaths))];
    const notification: RiskNotification = {
      type: 'guarded-unprotected-overlap',
      message:
        `Unprotected concurrent write overlap detected. Worktrees, serialization, and locks ` +
        `were all unavailable. Runs ${affectedRunIds.join(', ')} share paths: ${overlappingPaths.join(', ')}`,
      affectedRunIds,
      overlappingPaths,
      evidenceId: evidenceRecord.evidenceId,
      targets: ['chat', 'taskbar', 'run-detail'],
    };
    this.riskNotifications.push(notification);

    // Still provide a lease so the run can proceed
    const lease = this.createLease(
      runId,
      'guarded-unprotected',
      this.defaultWorkspacePath,
      null,
      scope,
    );

    return {
      success: true,
      lease,
      isolationLevel: 'guarded-unprotected',
      evidence: evidenceRecord,
      error: null,
    };
  }

  // ─── Private: Helpers ──────────────────────────────────────────────────

  private createLease(
    runId: string,
    level: IsolationLevel,
    workspacePath: string,
    branch: string | null,
    scope: FileScope,
  ): WorkspaceLease {
    const lease: WorkspaceLease = {
      leaseId: randomUUID(),
      runId,
      isolationLevel: level,
      workspacePath,
      branch,
      acquiredAt: new Date().toISOString(),
      releasedAt: null,
      scope,
    };
    this.leases.set(lease.leaseId, lease);
    this.leasesByRun.set(runId, lease.leaseId);
    return lease;
  }

  private intersect(a: readonly string[], b: readonly string[]): string[] {
    const setB = new Set(b);
    return a.filter((item) => setB.has(item));
  }
}
