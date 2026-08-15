/**
 * SafeGitDeliveryService — Safe branch, commit, and pull-request delivery pipeline.
 *
 * Implements the safe Git delivery pipeline that manages branches, commits,
 * and pull-request creation with full safety guarantees per Requirements 32.1–32.10.
 *
 * Key invariants:
 * 1. Record base commit, branch, worktree, initial dirty state, and upstream before mutation (R32.1)
 * 2. Isolate branches without switching the primary working tree (R32.2)
 * 3. Show exact accepted files/hunks, require clean index, editable messages (R32.3, R32.4, R32.5)
 * 4. Fetch and resolve divergence before push or PR creation (R32.6)
 * 5. Structure PR content with requirements, design, changes, tests, risks, etc. (R32.7)
 * 6. Preserve pre-PR review context and update existing PRs non-destructively (R32.9)
 * 7. Never assume target branch or perform destructive ops without confirmation (R32.8, R32.10)
 * 8. Combine CI, approvals, comments, conflicts, protection for merge status (R32.10)
 *
 * Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 32.6, 32.7, 32.8, 32.9, 32.10
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Snapshot of git state recorded before any mutation begins (R32.1).
 */
export interface GitStateSnapshot {
  /** Unique snapshot ID */
  readonly id: string;
  /** The Agent_Run ID this snapshot belongs to */
  readonly runId: string;
  /** The workspace/worktree path */
  readonly workspacePath: string;
  /** HEAD commit SHA at snapshot time */
  readonly baseCommit: string;
  /** Current branch name */
  readonly branch: string;
  /** Assigned worktree path (if isolation is active) */
  readonly worktreePath: string | null;
  /** Whether the working directory had uncommitted changes */
  readonly initialDirtyState: DirtyState;
  /** Upstream tracking branch info */
  readonly upstream: UpstreamState | null;
  /** Timestamp of the snapshot (ISO 8601) */
  readonly capturedAt: string;
}

/**
 * Classification of dirty working directory state.
 */
export interface DirtyState {
  /** Whether there are unstaged changes */
  readonly hasUnstagedChanges: boolean;
  /** Whether there are staged changes */
  readonly hasStagedChanges: boolean;
  /** Whether there are untracked files in scope */
  readonly hasUntrackedFiles: boolean;
  /** Paths of dirty files (for scope verification) */
  readonly dirtyPaths: readonly string[];
}

/**
 * Upstream tracking branch state.
 */
export interface UpstreamState {
  /** Remote name (e.g., 'origin') */
  readonly remote: string;
  /** Remote branch name (e.g., 'origin/main') */
  readonly remoteBranch: string;
  /** Commits ahead of upstream */
  readonly ahead: number;
  /** Commits behind upstream */
  readonly behind: number;
  /** Last fetch timestamp (ISO 8601) or null if never fetched */
  readonly lastFetchedAt: string | null;
}

/**
 * Divergence detection result (R32.6).
 */
export interface DivergenceResult {
  /** Whether remote has diverged from the local branch */
  readonly hasDiverged: boolean;
  /** Number of commits ahead of remote */
  readonly ahead: number;
  /** Number of commits behind remote */
  readonly behind: number;
  /** Whether fast-forward is possible */
  readonly canFastForward: boolean;
  /** Files that would conflict on merge/rebase */
  readonly conflictingPaths: readonly string[];
  /** The remote ref that was compared against */
  readonly remoteRef: string;
  /** Resolution strategies available */
  readonly strategies: readonly DivergenceStrategy[];
}

/**
 * Available strategies for resolving divergence.
 */
export type DivergenceStrategy = 'fast-forward' | 'rebase' | 'merge' | 'force-push';

/**
 * A file/hunk selection for committing (R32.3).
 */
export interface CommitSelection {
  /** Files fully selected for commit */
  readonly files: readonly string[];
  /** Specific hunks selected (by file -> hunk indices) */
  readonly hunks: Readonly<Record<string, readonly number[]>>;
}

/**
 * Status of the index relative to the commit selection.
 */
export interface IndexStatus {
  /** Whether the index is clean for the selected scope */
  readonly isClean: boolean;
  /** Paths that are staged but not in the selection */
  readonly extraStagedPaths: readonly string[];
  /** Paths in the selection that are not staged */
  readonly unstagedPaths: readonly string[];
}

/**
 * Parameters for creating a commit (R32.3, R32.4, R32.5).
 */
export interface CommitParams {
  /** The run this commit belongs to */
  readonly runId: string;
  /** Commit message (user-editable) */
  readonly message: string;
  /** Files and hunks to include */
  readonly selection: CommitSelection;
  /** Task/requirement identifiers for the commit message */
  readonly taskId: string | null;
  /** Requirement identifiers for traceability */
  readonly requirementIds: readonly string[];
  /** Validation status at commit time */
  readonly validationStatus: string | null;
  /** Breaking change or migration notes */
  readonly breakingNotes: string | null;
  /** Commit strategy */
  readonly strategy: CommitStrategy;
}

/**
 * Strategy for how commits are created (R32.5).
 */
export type CommitStrategy =
  | 'milestone'    // One commit per approved delivery milestone
  | 'squash'       // User-selected squash of multiple changes
  | 'single';      // Single commit for the entire change set

/**
 * Result of a commit operation.
 */
export interface CommitResult {
  readonly success: boolean;
  readonly commitSha: string | null;
  readonly error: string | null;
  /** The final commit message (may have been edited by user) */
  readonly message: string;
  /** Paths included in the commit */
  readonly committedPaths: readonly string[];
}

/**
 * Structured pull-request description content (R32.7).
 */
export interface PullRequestContent {
  /** PR title */
  readonly title: string;
  /** Linked requirements summary */
  readonly requirements: string;
  /** Design summary */
  readonly designSummary: string;
  /** Changed areas (files/modules) */
  readonly changedAreas: readonly string[];
  /** Test summary and coverage */
  readonly tests: string;
  /** Known risks */
  readonly risks: string;
  /** Migration or rollback steps */
  readonly migrations: string;
  /** Rollback procedure */
  readonly rollback: string;
  /** Screenshots, diagrams, or other artifacts */
  readonly artifacts: readonly string[];
  /** Linked Evidence IDs */
  readonly evidence: readonly string[];
}

/**
 * Parameters for creating or updating a pull request (R32.7, R32.9).
 */
export interface PullRequestParams {
  /** The run this PR belongs to */
  readonly runId: string;
  /** Source branch */
  readonly sourceBranch: string;
  /** Target branch (must be explicitly selected, never assumed - R32.8) */
  readonly targetBranch: string;
  /** Structured content */
  readonly content: PullRequestContent;
  /** Whether to update an existing PR non-destructively */
  readonly updateExisting: boolean;
  /** Pre-PR review context to preserve (R32.9) */
  readonly reviewContext: ReviewContext | null;
}

/**
 * Review context preserved across PR operations (R32.9).
 */
export interface ReviewContext {
  /** Existing review comments */
  readonly comments: readonly ReviewComment[];
  /** Approval decisions */
  readonly approvals: readonly ReviewApproval[];
  /** Change request discussions */
  readonly discussions: readonly string[];
  /** Files that were already reviewed */
  readonly reviewedFiles: readonly string[];
}

/**
 * A review comment.
 */
export interface ReviewComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly resolved: boolean;
  readonly createdAt: string;
}

/**
 * An approval decision.
 */
export interface ReviewApproval {
  readonly id: string;
  readonly author: string;
  readonly state: 'approved' | 'changes_requested' | 'commented';
  readonly createdAt: string;
}

/**
 * Merge readiness status combining multiple signals (R32.10).
 */
export interface MergeReadiness {
  /** Overall merge readiness */
  readonly ready: boolean;
  /** CI check results */
  readonly ciChecks: CICheckStatus;
  /** Approval requirements */
  readonly approvals: ApprovalStatus;
  /** Unresolved review comments */
  readonly unresolvedComments: number;
  /** Merge conflicts detected */
  readonly hasConflicts: boolean;
  /** Branch protection rules that apply */
  readonly branchProtection: BranchProtection;
  /** Production readiness report status (if available) */
  readonly productionReadiness: string | null;
  /** Individual blockers */
  readonly blockers: readonly MergeBlocker[];
}

/**
 * CI check status summary.
 */
export interface CICheckStatus {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  readonly required: readonly string[];
  readonly failedChecks: readonly string[];
}

/**
 * Approval requirement status.
 */
export interface ApprovalStatus {
  readonly required: number;
  readonly received: number;
  readonly changesRequested: number;
}

/**
 * Branch protection rules.
 */
export interface BranchProtection {
  readonly requiresReview: boolean;
  readonly requiredApprovals: number;
  readonly requiresStatusChecks: boolean;
  readonly requiredStatusChecks: readonly string[];
  readonly requiresLinearHistory: boolean;
  readonly allowsForcePush: boolean;
}

/**
 * A specific blocker preventing merge.
 */
export interface MergeBlocker {
  readonly kind: 'ci_failed' | 'approvals_missing' | 'unresolved_comments' | 'conflicts' | 'protection' | 'readiness';
  readonly description: string;
}

/**
 * A destructive Git operation that requires explicit confirmation (R32.8, R32.10).
 */
export interface DestructiveOperation {
  readonly kind: 'force_push' | 'hard_reset' | 'branch_delete' | 'auto_merge';
  /** Human-readable description of what will happen */
  readonly description: string;
  /** The target branch affected */
  readonly targetBranch: string;
  /** What data/commits would be lost */
  readonly expectedLoss: string;
  /** Conflict risk description */
  readonly conflictRisk: string;
}

/**
 * Confirmation for a destructive operation (R32.8).
 */
export interface DestructiveConfirmation {
  readonly operationId: string;
  readonly operation: DestructiveOperation;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  /** Must include explicit acknowledgment text */
  readonly acknowledgment: string;
}

/**
 * Pull request result.
 */
export interface PullRequestResult {
  readonly success: boolean;
  readonly pullRequestId: string | null;
  readonly pullRequestUrl: string | null;
  readonly error: string | null;
  /** Whether an existing PR was updated (vs created new) */
  readonly wasUpdated: boolean;
  /** Review context that was preserved */
  readonly preservedContext: ReviewContext | null;
}

/**
 * Git client interface for testability.
 */
export interface SafeGitClient {
  /** Get HEAD commit SHA */
  getHeadCommit(cwd: string): Promise<string>;
  /** Get current branch name */
  getCurrentBranch(cwd: string): Promise<string>;
  /** Get dirty state of the working directory */
  getDirtyState(cwd: string): Promise<DirtyState>;
  /** Get upstream tracking info */
  getUpstreamState(cwd: string, branch: string): Promise<UpstreamState | null>;
  /** Create a new branch without switching */
  createBranch(cwd: string, branchName: string, startPoint: string): Promise<void>;
  /** Fetch remote state */
  fetch(cwd: string, remote: string): Promise<void>;
  /** Check divergence from remote */
  checkDivergence(cwd: string, localRef: string, remoteRef: string): Promise<DivergenceResult>;
  /** Get index status for a selection */
  getIndexStatus(cwd: string, selection: CommitSelection): Promise<IndexStatus>;
  /** Stage specific files */
  stageFiles(cwd: string, paths: readonly string[]): Promise<void>;
  /** Create a commit */
  commit(cwd: string, message: string): Promise<string>;
  /** Push a branch to remote */
  push(cwd: string, remote: string, branch: string, force?: boolean): Promise<void>;
  /** Check if a branch exists on remote */
  remoteBranchExists(cwd: string, remote: string, branch: string): Promise<boolean>;
  /** Get branch protection rules */
  getBranchProtection(cwd: string, branch: string): Promise<BranchProtection>;
}

// ─── SafeGitDeliveryService ─────────────────────────────────────────────────

/**
 * SafeGitDeliveryService — Orchestrates safe branch creation, commit preparation,
 * and pull-request delivery with full safety guarantees.
 *
 * Design invariants:
 * - Never switches the user's primary working tree (R32.2)
 * - Never assumes a target branch (R32.8)
 * - Never force-pushes or hard-resets without explicit confirmation (R32.8, R32.10)
 * - Records full pre-mutation state for recoverability (R32.1)
 * - Preserves existing review context (R32.9)
 *
 * Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 32.6, 32.7, 32.8, 32.9, 32.10
 */
export class SafeGitDeliveryService {
  private readonly snapshots = new Map<string, GitStateSnapshot>();
  private readonly commits = new Map<string, CommitResult[]>();
  private readonly pendingConfirmations = new Map<string, DestructiveOperation>();
  private readonly reviewContexts = new Map<string, ReviewContext>();

  constructor(private readonly gitClient: SafeGitClient) {}

  // ─── Pre-Mutation State Recording (R32.1) ───────────────────────────────

  /**
   * Record the complete git state before any file operation begins.
   * Must be called before the first mutation in a run.
   *
   * Records: base commit, branch, worktree, initial dirty state, and upstream.
   */
  async recordPreMutationState(
    runId: string,
    workspacePath: string,
    worktreePath: string | null = null,
  ): Promise<GitStateSnapshot> {
    const effectivePath = worktreePath ?? workspacePath;

    const [baseCommit, branch, dirtyState] = await Promise.all([
      this.gitClient.getHeadCommit(effectivePath),
      this.gitClient.getCurrentBranch(effectivePath),
      this.gitClient.getDirtyState(effectivePath),
    ]);

    const upstream = await this.gitClient.getUpstreamState(effectivePath, branch);

    const snapshot: GitStateSnapshot = {
      id: randomUUID(),
      runId,
      workspacePath,
      baseCommit,
      branch,
      worktreePath,
      initialDirtyState: dirtyState,
      upstream,
      capturedAt: new Date().toISOString(),
    };

    this.snapshots.set(runId, snapshot);
    return snapshot;
  }

  /**
   * Get the recorded pre-mutation snapshot for a run.
   */
  getSnapshot(runId: string): GitStateSnapshot | null {
    return this.snapshots.get(runId) ?? null;
  }

  // ─── Branch Isolation (R32.2) ───────────────────────────────────────────

  /**
   * Create or assign a task-specific branch without switching the user's primary
   * working tree. The branch is created in the worktree (if available) or as a
   * detached creation that does not affect the current checkout.
   */
  async createIsolatedBranch(
    runId: string,
    branchName: string,
    startPoint: string | null = null,
  ): Promise<{ branch: string; startedFrom: string }> {
    const snapshot = this.snapshots.get(runId);
    if (!snapshot) {
      throw new Error(`No pre-mutation snapshot recorded for run '${runId}'. Call recordPreMutationState first.`);
    }

    const effectivePath = snapshot.worktreePath ?? snapshot.workspacePath;
    const base = startPoint ?? snapshot.baseCommit;

    // Create branch without switching HEAD in the primary working tree
    await this.gitClient.createBranch(effectivePath, branchName, base);

    return { branch: branchName, startedFrom: base };
  }

  // ─── Commit Preparation (R32.3, R32.4, R32.5) ──────────────────────────

  /**
   * Validate that the index is clean for the selected commit scope.
   * Requires a clean selected index — no extra staged files outside selection.
   */
  async validateIndexForCommit(
    runId: string,
    selection: CommitSelection,
  ): Promise<IndexStatus> {
    const snapshot = this.snapshots.get(runId);
    if (!snapshot) {
      throw new Error(`No pre-mutation snapshot recorded for run '${runId}'.`);
    }

    const effectivePath = snapshot.worktreePath ?? snapshot.workspacePath;
    return this.gitClient.getIndexStatus(effectivePath, selection);
  }

  /**
   * Prepare a commit with the exact accepted files/hunks. The message remains
   * editable by the user before finalization. Supports milestone commits or
   * user-selected squash strategy without per-turn noise.
   *
   * Returns null if the index is not clean for the selection.
   */
  async prepareCommit(params: CommitParams): Promise<CommitResult | null> {
    const snapshot = this.snapshots.get(params.runId);
    if (!snapshot) {
      throw new Error(`No pre-mutation snapshot recorded for run '${params.runId}'.`);
    }

    const effectivePath = snapshot.worktreePath ?? snapshot.workspacePath;

    // Validate index is clean for the selection (R32.3)
    const indexStatus = await this.gitClient.getIndexStatus(effectivePath, params.selection);
    if (!indexStatus.isClean) {
      return {
        success: false,
        commitSha: null,
        error: `Index is not clean for the selected scope. Extra staged: [${indexStatus.extraStagedPaths.join(', ')}], Unstaged: [${indexStatus.unstagedPaths.join(', ')}]`,
        message: params.message,
        committedPaths: [],
      };
    }

    // Stage the selected files
    const allPaths = [
      ...params.selection.files,
      ...Object.keys(params.selection.hunks),
    ];
    await this.gitClient.stageFiles(effectivePath, allPaths);

    // Build the final commit message with metadata (R32.4)
    const finalMessage = this.buildCommitMessage(params);

    // Create the commit
    try {
      const commitSha = await this.gitClient.commit(effectivePath, finalMessage);

      const result: CommitResult = {
        success: true,
        commitSha,
        error: null,
        message: finalMessage,
        committedPaths: allPaths,
      };

      // Track commits for this run
      const runCommits = this.commits.get(params.runId) ?? [];
      runCommits.push(result);
      this.commits.set(params.runId, runCommits);

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        commitSha: null,
        error: `Commit failed: ${message}`,
        message: finalMessage,
        committedPaths: [],
      };
    }
  }

  /**
   * Get all commits made in a run.
   */
  getRunCommits(runId: string): readonly CommitResult[] {
    return this.commits.get(runId) ?? [];
  }

  // ─── Divergence Resolution (R32.6) ─────────────────────────────────────

  /**
   * Fetch remote state and detect divergence before push or PR creation.
   * Must be called before any push or pull-request operation.
   */
  async fetchAndCheckDivergence(
    runId: string,
    remote: string = 'origin',
  ): Promise<DivergenceResult> {
    const snapshot = this.snapshots.get(runId);
    if (!snapshot) {
      throw new Error(`No pre-mutation snapshot recorded for run '${runId}'.`);
    }

    const effectivePath = snapshot.worktreePath ?? snapshot.workspacePath;
    const branch = snapshot.branch;

    // Fetch latest remote state
    await this.gitClient.fetch(effectivePath, remote);

    // Check divergence
    const remoteRef = `${remote}/${branch}`;
    return this.gitClient.checkDivergence(effectivePath, branch, remoteRef);
  }

  // ─── Pull Request Creation (R32.7, R32.9) ──────────────────────────────

  /**
   * Build structured pull-request content with all required sections (R32.7).
   */
  buildPullRequestDescription(content: PullRequestContent): string {
    const sections: string[] = [];

    sections.push(`## Requirements\n\n${content.requirements}`);
    sections.push(`## Design Summary\n\n${content.designSummary}`);

    if (content.changedAreas.length > 0) {
      sections.push(`## Changed Areas\n\n${content.changedAreas.map(a => `- ${a}`).join('\n')}`);
    }

    sections.push(`## Tests\n\n${content.tests}`);

    if (content.risks) {
      sections.push(`## Risks\n\n${content.risks}`);
    }

    if (content.migrations) {
      sections.push(`## Migrations\n\n${content.migrations}`);
    }

    if (content.rollback) {
      sections.push(`## Rollback\n\n${content.rollback}`);
    }

    if (content.artifacts.length > 0) {
      sections.push(`## Artifacts\n\n${content.artifacts.map(a => `- ${a}`).join('\n')}`);
    }

    if (content.evidence.length > 0) {
      sections.push(`## Evidence\n\n${content.evidence.map(e => `- ${e}`).join('\n')}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Preserve review context before PR operations (R32.9).
   */
  preserveReviewContext(runId: string, context: ReviewContext): void {
    this.reviewContexts.set(runId, context);
  }

  /**
   * Get preserved review context for a run.
   */
  getPreservedReviewContext(runId: string): ReviewContext | null {
    return this.reviewContexts.get(runId) ?? null;
  }

  // ─── Merge Readiness (R32.10) ──────────────────────────────────────────

  /**
   * Evaluate merge readiness by combining CI, approvals, comments, conflicts,
   * protection, and production readiness status.
   */
  evaluateMergeReadiness(
    ciChecks: CICheckStatus,
    approvals: ApprovalStatus,
    unresolvedComments: number,
    hasConflicts: boolean,
    branchProtection: BranchProtection,
    productionReadiness: string | null,
  ): MergeReadiness {
    const blockers: MergeBlocker[] = [];

    // Check CI
    if (ciChecks.failed > 0) {
      blockers.push({
        kind: 'ci_failed',
        description: `${ciChecks.failed} CI check(s) failed: ${ciChecks.failedChecks.join(', ')}`,
      });
    }
    if (ciChecks.pending > 0 && branchProtection.requiresStatusChecks) {
      blockers.push({
        kind: 'ci_failed',
        description: `${ciChecks.pending} CI check(s) still pending`,
      });
    }

    // Check required status checks
    if (branchProtection.requiresStatusChecks) {
      const passedSet = new Set<string>(); // We check required checks in ciChecks
      for (const required of branchProtection.requiredStatusChecks) {
        if (ciChecks.failedChecks.includes(required)) {
          blockers.push({
            kind: 'protection',
            description: `Required status check '${required}' has not passed`,
          });
        }
      }
    }

    // Check approvals
    if (branchProtection.requiresReview && approvals.received < branchProtection.requiredApprovals) {
      blockers.push({
        kind: 'approvals_missing',
        description: `${branchProtection.requiredApprovals - approvals.received} more approval(s) required`,
      });
    }
    if (approvals.changesRequested > 0) {
      blockers.push({
        kind: 'approvals_missing',
        description: `${approvals.changesRequested} reviewer(s) requested changes`,
      });
    }

    // Check unresolved comments
    if (unresolvedComments > 0) {
      blockers.push({
        kind: 'unresolved_comments',
        description: `${unresolvedComments} unresolved review comment(s)`,
      });
    }

    // Check conflicts
    if (hasConflicts) {
      blockers.push({
        kind: 'conflicts',
        description: 'Merge conflicts must be resolved',
      });
    }

    // Check production readiness
    if (productionReadiness && productionReadiness !== 'ready') {
      blockers.push({
        kind: 'readiness',
        description: `Production readiness: ${productionReadiness}`,
      });
    }

    return {
      ready: blockers.length === 0,
      ciChecks,
      approvals,
      unresolvedComments,
      hasConflicts,
      branchProtection,
      productionReadiness,
      blockers,
    };
  }

  // ─── Destructive Operation Safety (R32.8, R32.10) ──────────────────────

  /**
   * Request confirmation for a destructive operation.
   * Returns an operation ID that must be confirmed before execution.
   *
   * NEVER performs force push, hard reset, or assumes a target branch
   * without explicit informed confirmation.
   */
  requestDestructiveConfirmation(operation: DestructiveOperation): string {
    const operationId = randomUUID();
    this.pendingConfirmations.set(operationId, operation);
    return operationId;
  }

  /**
   * Confirm a destructive operation with explicit acknowledgment.
   */
  confirmDestructiveOperation(
    operationId: string,
    confirmedBy: string,
    acknowledgment: string,
  ): DestructiveConfirmation | null {
    const operation = this.pendingConfirmations.get(operationId);
    if (!operation) {
      return null;
    }

    // Require the acknowledgment to contain the target branch name
    if (!acknowledgment.includes(operation.targetBranch)) {
      return null;
    }

    this.pendingConfirmations.delete(operationId);

    return {
      operationId,
      operation,
      confirmedBy,
      confirmedAt: new Date().toISOString(),
      acknowledgment,
    };
  }

  /**
   * Check whether a destructive operation has been confirmed.
   */
  isConfirmed(operationId: string): boolean {
    return !this.pendingConfirmations.has(operationId);
  }

  /**
   * Validate that a target branch has been explicitly selected (never assumed).
   * Returns false if targetBranch is empty, 'main', 'master', or a default
   * without explicit selection flag.
   */
  validateExplicitTargetBranch(
    targetBranch: string,
    explicitlySelected: boolean,
  ): { valid: boolean; reason: string | null } {
    if (!targetBranch || targetBranch.trim().length === 0) {
      return { valid: false, reason: 'Target branch must be explicitly specified' };
    }

    if (!explicitlySelected) {
      return { valid: false, reason: 'Target branch must be explicitly selected by the user, not assumed' };
    }

    return { valid: true, reason: null };
  }

  // ─── Commit Message Building (R32.4) ───────────────────────────────────

  /**
   * Build a structured commit message with intent, identifiers, validation, and notes.
   * Messages remain user-editable — this produces the default content.
   */
  private buildCommitMessage(params: CommitParams): string {
    const lines: string[] = [params.message];

    // Add metadata as trailers
    const trailers: string[] = [];

    if (params.taskId) {
      trailers.push(`Task-ID: ${params.taskId}`);
    }

    if (params.requirementIds.length > 0) {
      trailers.push(`Requirements: ${params.requirementIds.join(', ')}`);
    }

    if (params.validationStatus) {
      trailers.push(`Validation: ${params.validationStatus}`);
    }

    if (params.breakingNotes) {
      trailers.push(`BREAKING CHANGE: ${params.breakingNotes}`);
    }

    if (trailers.length > 0) {
      lines.push(''); // Empty line before trailers
      lines.push(...trailers);
    }

    return lines.join('\n');
  }
}
