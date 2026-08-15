/**
 * WorkspaceStatusService — Run workspace status projection, explicit promotion
 * controls, and cancellation isolation.
 *
 * Implements:
 *   1. RunWorkspaceStatusProjection: Projects workspace/branch/base revision/dirty
 *      state/divergence/merge readiness for each run from owning services (R14.6).
 *   2. PromotionControls: Requires explicit user selection of merge/rebase/squash/discard
 *      with conflict preview before any promotion (R14.7).
 *   3. CancellationIsolation: Proves that cancelling one run cannot terminate unrelated
 *      runs or discard their Change_Sets (R14.8).
 *   4. ConflictPreview: Before merge, shows what conflicts would result.
 *
 * Design notes:
 * - WorkspaceLeaseService owns worktree lifecycle
 * - Persisted WorktreeManager and promotion services handle worktree lifecycle
 * - Process-local worktree helpers become execution adapters, not state authorities
 * - Run workspace status is projected from owning services
 *
 * Requirements: 14.6, 14.7, 14.8
 */

import type { WorkspaceLease, IsolationLevel } from './workspace-isolation.js';
import type { AgentRun, RunState } from './run-coordinator.js';
import { TERMINAL_RUN_STATES } from './run-coordinator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Promotion strategy the user must explicitly select before merging run output.
 */
export type PromotionStrategy = 'merge' | 'rebase' | 'squash' | 'discard';

/**
 * Conflict severity for conflict preview.
 */
export type ConflictSeverity = 'content' | 'rename' | 'delete-modify' | 'add-add';

/**
 * A single conflict entry in the conflict preview.
 */
export interface ConflictEntry {
  readonly filePath: string;
  readonly severity: ConflictSeverity;
  readonly description: string;
  /** The base revision content (if available) */
  readonly baseContent: string | null;
  /** The run's version of the content */
  readonly runContent: string | null;
  /** The target branch content */
  readonly targetContent: string | null;
}

/**
 * Conflict preview result before promotion.
 */
export interface ConflictPreview {
  readonly runId: string;
  readonly strategy: PromotionStrategy;
  readonly conflicts: readonly ConflictEntry[];
  readonly hasConflicts: boolean;
  readonly conflictCount: number;
  readonly affectedFiles: readonly string[];
  readonly previewedAt: string;
}

/**
 * Workspace status projection for a single run.
 * Projected from the owning services (WorkspaceLeaseService, WorktreeManager).
 */
export interface RunWorkspaceStatus {
  readonly runId: string;
  /** The workspace path where the run operates */
  readonly workspacePath: string;
  /** Branch name (null for non-worktree isolation) */
  readonly branch: string | null;
  /** Base revision the run started from */
  readonly baseRevision: string | null;
  /** Whether there are uncommitted changes in the run workspace */
  readonly isDirty: boolean;
  /** Number of commits ahead of the target branch */
  readonly commitsAhead: number;
  /** Number of commits behind the target branch */
  readonly commitsBehind: number;
  /** Whether this run's output is ready for merge (no conflicts, validation passed) */
  readonly mergeReady: boolean;
  /** Isolation level for this run */
  readonly isolationLevel: IsolationLevel;
  /** The current run state */
  readonly runState: RunState;
  /** Timestamp of last status update */
  readonly updatedAt: string;
}

/**
 * A promotion request initiated by the user.
 */
export interface PromotionRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly strategy: PromotionStrategy;
  readonly requestedAt: string;
  readonly requestedBy: string;
  /** Conflict preview must be generated before promotion executes */
  readonly conflictPreview: ConflictPreview | null;
  /** Whether the user has explicitly confirmed after seeing the preview */
  readonly confirmed: boolean;
  /** Whether the promotion has been executed */
  readonly executed: boolean;
  /** Error if promotion failed */
  readonly error: string | null;
}

/**
 * A Change_Set owned by a run.
 */
export interface RunChangeSet {
  readonly changeSetId: string;
  readonly runId: string;
  readonly files: readonly string[];
  readonly createdAt: string;
  /** Whether this change set is still active (not discarded) */
  readonly active: boolean;
}

/**
 * Cancellation result showing what was affected.
 */
export interface CancellationResult {
  readonly cancelledRunId: string;
  readonly success: boolean;
  /** Change sets that were discarded by this cancellation */
  readonly discardedChangeSets: readonly string[];
  /** Lease that was released */
  readonly releasedLeaseId: string | null;
  /** Unaffected runs that remain active */
  readonly unaffectedRunIds: readonly string[];
  /** Timestamp */
  readonly cancelledAt: string;
  /** Error if cancellation failed */
  readonly error: string | null;
}

/**
 * Input for the workspace status projection — data from owning services.
 */
export interface WorkspaceStatusInput {
  readonly runId: string;
  readonly workspacePath: string;
  readonly branch: string | null;
  readonly baseRevision: string | null;
  readonly isDirty: boolean;
  readonly commitsAhead: number;
  readonly commitsBehind: number;
  readonly isolationLevel: IsolationLevel;
  readonly runState: RunState;
  readonly validationPassed: boolean;
}

// ─── WorkspaceStatusService ─────────────────────────────────────────────────

/**
 * WorkspaceStatusService orchestrates run workspace status projection,
 * explicit promotion controls, and cancellation isolation.
 */
export class WorkspaceStatusService {
  /** Projected status for each run */
  private readonly statusByRun = new Map<string, RunWorkspaceStatus>();
  /** Promotion requests requiring explicit user selection */
  private readonly promotionRequests = new Map<string, PromotionRequest>();
  /** Change sets indexed by run */
  private readonly changeSetsByRun = new Map<string, RunChangeSet[]>();
  /** All active runs tracked for cancellation isolation */
  private readonly activeRunIds = new Set<string>();
  /** Leases indexed by run (for cancellation) */
  private readonly leasesByRun = new Map<string, string>();

  private requestCounter = 0;

  // ─── RunWorkspaceStatusProjection (R14.6) ──────────────────────────────

  /**
   * Project workspace status for a run from owning service data.
   * UI shows: workspace, branch, base revision, dirty state, divergence, merge readiness.
   */
  projectRunStatus(input: WorkspaceStatusInput): RunWorkspaceStatus {
    const mergeReady = this.computeMergeReadiness(input);

    const status: RunWorkspaceStatus = {
      runId: input.runId,
      workspacePath: input.workspacePath,
      branch: input.branch,
      baseRevision: input.baseRevision,
      isDirty: input.isDirty,
      commitsAhead: input.commitsAhead,
      commitsBehind: input.commitsBehind,
      mergeReady,
      isolationLevel: input.isolationLevel,
      runState: input.runState,
      updatedAt: new Date().toISOString(),
    };

    this.statusByRun.set(input.runId, status);
    this.activeRunIds.add(input.runId);

    return status;
  }

  /**
   * Get the projected workspace status for a run.
   */
  getRunStatus(runId: string): RunWorkspaceStatus | null {
    return this.statusByRun.get(runId) ?? null;
  }

  /**
   * Get all projected run statuses.
   */
  getAllRunStatuses(): RunWorkspaceStatus[] {
    return [...this.statusByRun.values()];
  }

  // ─── PromotionControls (R14.7) ────────────────────────────────────────

  /**
   * Request a promotion for a run's output. Requires explicit strategy selection.
   * The promotion will NOT execute until the user confirms after seeing the conflict preview.
   */
  requestPromotion(
    runId: string,
    strategy: PromotionStrategy,
    requestedBy: string,
  ): PromotionRequest {
    const requestId = `promo-${++this.requestCounter}`;

    const request: PromotionRequest = {
      requestId,
      runId,
      strategy,
      requestedAt: new Date().toISOString(),
      requestedBy,
      conflictPreview: null,
      confirmed: false,
      executed: false,
      error: null,
    };

    this.promotionRequests.set(requestId, request);
    return request;
  }

  /**
   * Generate a conflict preview for a promotion request.
   * Must be called before confirmation. Shows what conflicts would result.
   */
  generateConflictPreview(
    requestId: string,
    conflicts: ConflictEntry[],
  ): ConflictPreview | null {
    const request = this.promotionRequests.get(requestId);
    if (!request) return null;

    const preview: ConflictPreview = {
      runId: request.runId,
      strategy: request.strategy,
      conflicts,
      hasConflicts: conflicts.length > 0,
      conflictCount: conflicts.length,
      affectedFiles: [...new Set(conflicts.map((c) => c.filePath))],
      previewedAt: new Date().toISOString(),
    };

    // Update the request with the preview
    const updated: PromotionRequest = {
      ...request,
      conflictPreview: preview,
    };
    this.promotionRequests.set(requestId, updated);

    return preview;
  }

  /**
   * Confirm a promotion request after the user has reviewed the conflict preview.
   * Promotion will NOT execute without a preview first.
   */
  confirmPromotion(requestId: string): PromotionRequest | null {
    const request = this.promotionRequests.get(requestId);
    if (!request) return null;

    // Cannot confirm without a conflict preview
    if (!request.conflictPreview) {
      const errored: PromotionRequest = {
        ...request,
        error: 'Cannot confirm promotion without a conflict preview',
      };
      this.promotionRequests.set(requestId, errored);
      return errored;
    }

    // Cannot confirm if already executed
    if (request.executed) {
      return request;
    }

    const confirmed: PromotionRequest = {
      ...request,
      confirmed: true,
    };
    this.promotionRequests.set(requestId, confirmed);
    return confirmed;
  }

  /**
   * Execute a confirmed promotion. Only works if confirmed === true.
   */
  executePromotion(requestId: string): PromotionRequest | null {
    const request = this.promotionRequests.get(requestId);
    if (!request) return null;

    if (!request.confirmed) {
      const errored: PromotionRequest = {
        ...request,
        error: 'Promotion must be confirmed before execution',
      };
      this.promotionRequests.set(requestId, errored);
      return errored;
    }

    if (request.executed) {
      return request; // Idempotent
    }

    // Handle discard strategy: discard change sets for the run
    if (request.strategy === 'discard') {
      this.discardChangeSetsForRun(request.runId);
    }

    const executed: PromotionRequest = {
      ...request,
      executed: true,
    };
    this.promotionRequests.set(requestId, executed);
    return executed;
  }

  /**
   * Get a promotion request by ID.
   */
  getPromotionRequest(requestId: string): PromotionRequest | null {
    return this.promotionRequests.get(requestId) ?? null;
  }

  /**
   * Get all promotion requests for a run.
   */
  getPromotionRequestsForRun(runId: string): PromotionRequest[] {
    return [...this.promotionRequests.values()].filter((r) => r.runId === runId);
  }

  // ─── CancellationIsolation (R14.8) ────────────────────────────────────

  /**
   * Register a run's change sets for cancellation isolation tracking.
   */
  registerChangeSet(changeSet: RunChangeSet): void {
    const existing = this.changeSetsByRun.get(changeSet.runId) ?? [];
    existing.push(changeSet);
    this.changeSetsByRun.set(changeSet.runId, existing);
  }

  /**
   * Register a lease for a run (for cancellation tracking).
   */
  registerLease(runId: string, leaseId: string): void {
    this.leasesByRun.set(runId, leaseId);
    this.activeRunIds.add(runId);
  }

  /**
   * Cancel a run with isolation guarantees.
   * Cancelling one run MUST NOT:
   * - Terminate any unrelated run
   * - Discard change sets belonging to other runs
   * - Release leases belonging to other runs
   *
   * Each run's cancellation is scoped only to its own workspace/lease/changes.
   */
  cancelRun(runId: string): CancellationResult {
    // Validate the run exists in our tracking
    if (!this.activeRunIds.has(runId)) {
      return {
        cancelledRunId: runId,
        success: false,
        discardedChangeSets: [],
        releasedLeaseId: null,
        unaffectedRunIds: this.getOtherActiveRunIds(runId),
        cancelledAt: new Date().toISOString(),
        error: `Run '${runId}' is not tracked as active`,
      };
    }

    // Discard only this run's change sets
    const runChangeSets = this.changeSetsByRun.get(runId) ?? [];
    const discardedIds: string[] = [];
    for (const cs of runChangeSets) {
      if (cs.active) {
        discardedIds.push(cs.changeSetId);
      }
    }
    // Mark them inactive
    const updatedChangeSets = runChangeSets.map((cs) => ({
      ...cs,
      active: false,
    }));
    this.changeSetsByRun.set(runId, updatedChangeSets);

    // Release only this run's lease
    const releasedLeaseId = this.leasesByRun.get(runId) ?? null;
    this.leasesByRun.delete(runId);

    // Remove from active runs
    this.activeRunIds.delete(runId);

    // Update status to reflect cancellation
    const status = this.statusByRun.get(runId);
    if (status) {
      this.statusByRun.set(runId, {
        ...status,
        runState: 'cancelled',
        updatedAt: new Date().toISOString(),
      });
    }

    // All OTHER active runs remain completely unaffected
    const unaffectedRunIds = this.getOtherActiveRunIds(runId);

    return {
      cancelledRunId: runId,
      success: true,
      discardedChangeSets: discardedIds,
      releasedLeaseId,
      unaffectedRunIds,
      cancelledAt: new Date().toISOString(),
      error: null,
    };
  }

  /**
   * Verify that a run's change sets are still intact (not affected by another run's cancellation).
   */
  verifyChangeSetsIntact(runId: string): boolean {
    const changeSets = this.changeSetsByRun.get(runId) ?? [];
    return changeSets.every((cs) => cs.active);
  }

  /**
   * Get all active change sets for a run.
   */
  getActiveChangeSetsForRun(runId: string): RunChangeSet[] {
    const changeSets = this.changeSetsByRun.get(runId) ?? [];
    return changeSets.filter((cs) => cs.active);
  }

  /**
   * Get all currently active run IDs.
   */
  getActiveRunIds(): string[] {
    return [...this.activeRunIds];
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  /**
   * Compute merge readiness from input data.
   * A run is merge-ready when:
   * - It is in a completed state (or at least not failed/cancelled)
   * - Validation has passed
   * - It is not behind (no divergence requiring rebase)
   */
  private computeMergeReadiness(input: WorkspaceStatusInput): boolean {
    // Not ready if run is in a terminal failed/cancelled state
    if (input.runState === 'failed' || input.runState === 'cancelled') {
      return false;
    }

    // Not ready if validation hasn't passed
    if (!input.validationPassed) {
      return false;
    }

    // Not ready if there's divergence (behind main branch)
    if (input.commitsBehind > 0) {
      return false;
    }

    // Ready if completed with no conflicts
    return input.runState === 'completed';
  }

  /**
   * Get IDs of all active runs other than the specified one.
   */
  private getOtherActiveRunIds(excludeRunId: string): string[] {
    return [...this.activeRunIds].filter((id) => id !== excludeRunId);
  }

  /**
   * Discard change sets for a run (used by discard promotion strategy).
   */
  private discardChangeSetsForRun(runId: string): void {
    const changeSets = this.changeSetsByRun.get(runId) ?? [];
    const updated = changeSets.map((cs) => ({
      ...cs,
      active: false,
    }));
    this.changeSetsByRun.set(runId, updated);
  }
}
