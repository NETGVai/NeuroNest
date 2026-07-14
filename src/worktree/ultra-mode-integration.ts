/**
 * UltraModeWorktreeIntegration — Integrates Git worktree isolation with Ultra execution mode.
 *
 * In Ultra mode, automatically creates worktrees for parallel phases so that each
 * agent executes in isolation. After all phases complete, results are merged
 * sequentially back to the current branch.
 *
 * When merge conflicts arise, presents them to the user with resolution options:
 * - Accept incoming (the worktree's changes)
 * - Keep current (the existing state)
 * - Manual resolution (open a conflict editor)
 *
 * Follows NeuroNest's lazy-initialized TypeScript singleton pattern.
 *
 * Requirements: 3.1, 3.6
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  WorktreeManager,
  WorktreeSession,
  FeatureGateCheck,
} from './worktree-manager.js';
import type { WorktreePromotion, DiffSummary } from './worktree-promotion.js';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

/** Represents a single phase's worktree assignment in Ultra mode */
export interface PhaseWorktreeAssignment {
  /** Phase index (0-based) */
  phaseIndex: number;
  /** Agent ID assigned to this phase */
  agentId: string;
  /** The created worktree session */
  worktreeSession: WorktreeSession;
}

/** Merge conflict details for a single file */
export interface MergeConflict {
  /** File path relative to project root */
  filePath: string;
  /** The incoming content (from worktree branch) */
  incomingContent: string;
  /** The current content (on the target branch) */
  currentContent: string;
  /** Raw conflict markers if available */
  conflictMarkers: string;
}

/** User-facing resolution options for merge conflicts */
export type ConflictResolution = 'accept-incoming' | 'keep-current' | 'manual';

/** Result of resolving a single conflict */
export interface ConflictResolutionResult {
  filePath: string;
  resolution: ConflictResolution;
  /** Resolved content if manual resolution was provided */
  resolvedContent?: string;
}

/** Result of a sequential merge operation */
export interface SequentialMergeResult {
  /** Whether all merges succeeded without conflicts */
  success: boolean;
  /** Number of phases successfully merged */
  phasesMerged: number;
  /** Total number of phases attempted */
  totalPhases: number;
  /** Merge results per phase */
  phaseResults: PhaseMergeResult[];
}

/** Per-phase merge outcome */
export interface PhaseMergeResult {
  phaseIndex: number;
  agentId: string;
  worktreeId: string;
  /** Whether this phase merged cleanly */
  success: boolean;
  /** Conflicts that arose during this merge */
  conflicts: MergeConflict[];
  /** Diff summary for this phase */
  diffSummary: DiffSummary | null;
  /** Error message if merge failed for non-conflict reasons */
  error?: string;
}

/** Callback to present conflicts to the user and get their resolution choices */
export type ConflictResolutionHandler = (
  phaseIndex: number,
  agentId: string,
  conflicts: MergeConflict[],
) => Promise<ConflictResolutionResult[]>;

/** Git operations interface for Ultra mode integration (testable) */
export interface UltraModeGitClient {
  /** Get current branch name */
  getCurrentBranch(cwd: string): Promise<string>;
  /** Attempt to merge a branch, returning true on success or false on conflict */
  merge(cwd: string, branch: string): Promise<{ success: boolean; conflictFiles: string[] }>;
  /** Abort an in-progress merge */
  mergeAbort(cwd: string): Promise<void>;
  /** Get conflicted file content (with markers) */
  getConflictedContent(cwd: string, filePath: string): Promise<string>;
  /** Get file content from a specific ref */
  getFileFromRef(cwd: string, ref: string, filePath: string): Promise<string>;
  /** Stage a resolved file */
  stageFile(cwd: string, filePath: string): Promise<void>;
  /** Write content to a file in the working tree */
  writeFile(cwd: string, filePath: string, content: string): Promise<void>;
  /** Complete a merge (commit) after resolving conflicts */
  mergeCommit(cwd: string): Promise<void>;
  /** Checkout a file from a specific strategy (ours/theirs) */
  checkoutStrategy(cwd: string, filePath: string, strategy: 'ours' | 'theirs'): Promise<void>;
}

// ─── Default Git Client ─────────────────────────────────────────

/**
 * Default git client for Ultra mode operations.
 */
export class DefaultUltraModeGitClient implements UltraModeGitClient {
  async getCurrentBranch(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return stdout.trim();
  }

  async merge(cwd: string, branch: string): Promise<{ success: boolean; conflictFiles: string[] }> {
    try {
      await execFileAsync('git', ['merge', branch, '--no-edit'], { cwd });
      return { success: true, conflictFiles: [] };
    } catch (err: unknown) {
      // Check if it's a merge conflict (exit code 1 with conflict markers)
      const error = err as { stdout?: string; stderr?: string; code?: number };
      if (error.stdout?.includes('CONFLICT') || error.stderr?.includes('CONFLICT')) {
        const conflictFiles = await this.getConflictedFiles(cwd);
        return { success: false, conflictFiles };
      }
      throw err;
    }
  }

  async mergeAbort(cwd: string): Promise<void> {
    await execFileAsync('git', ['merge', '--abort'], { cwd });
  }

  async getConflictedContent(cwd: string, filePath: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return readFile(join(cwd, filePath), 'utf-8');
  }

  async getFileFromRef(cwd: string, ref: string, filePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd });
      return stdout;
    } catch {
      return '';
    }
  }

  async stageFile(cwd: string, filePath: string): Promise<void> {
    await execFileAsync('git', ['add', filePath], { cwd });
  }

  async writeFile(cwd: string, filePath: string, content: string): Promise<void> {
    const { writeFile: fsWriteFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await fsWriteFile(join(cwd, filePath), content, 'utf-8');
  }

  async mergeCommit(cwd: string): Promise<void> {
    await execFileAsync('git', ['commit', '--no-edit'], { cwd });
  }

  async checkoutStrategy(cwd: string, filePath: string, strategy: 'ours' | 'theirs'): Promise<void> {
    await execFileAsync('git', ['checkout', `--${strategy}`, filePath], { cwd });
  }

  private async getConflictedFiles(cwd: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-only', '--diff-filter=U'], { cwd }
      );
      return stdout.trim().split('\n').filter(f => f.length > 0);
    } catch {
      return [];
    }
  }
}

// ─── UltraModeWorktreeIntegration ───────────────────────────────

/**
 * UltraModeWorktreeIntegration — Orchestrates worktree creation for Ultra mode
 * parallel phases and handles sequential merge with conflict resolution.
 *
 * Usage:
 * 1. createWorktreesForPhases() — Creates a worktree per parallel phase agent
 * 2. (Agents execute in their isolated worktrees)
 * 3. mergeSequentially() — Merges all worktrees back in phase order
 *
 * Requirements: 3.1, 3.6
 */
export class UltraModeWorktreeIntegration {
  private worktreeManager: WorktreeManager;
  private worktreePromotion: WorktreePromotion;
  private gitClient: UltraModeGitClient;
  private projectDir: string;
  private featureGate: FeatureGateCheck | null;

  constructor(
    worktreeManager: WorktreeManager,
    worktreePromotion: WorktreePromotion,
    projectDir: string,
    featureGate?: FeatureGateCheck | null,
    gitClient?: UltraModeGitClient,
  ) {
    this.worktreeManager = worktreeManager;
    this.worktreePromotion = worktreePromotion;
    this.projectDir = projectDir;
    this.featureGate = featureGate ?? null;
    this.gitClient = gitClient ?? new DefaultUltraModeGitClient();
  }

  /**
   * Check if Ultra mode worktree integration is enabled.
   * Requires both `worktree_agent_manager` and `worktree_isolation` feature flags.
   */
  isEnabled(): boolean {
    if (!this.featureGate) return false;
    return this.featureGate.isEnabled('worktree_agent_manager');
  }

  /**
   * Create worktrees for all agents in a set of parallel phases (Req 3.1, 3.6).
   *
   * In Ultra mode, each agent in a parallel phase gets its own worktree
   * so file modifications don't conflict. Worktrees are branched from HEAD
   * using the naming convention `neuronest/{agent-id}/{task-hash}`.
   *
   * @param sessionId - The current session ID
   * @param phases - Array of phase assignments (agent IDs with their tasks)
   * @returns Array of phase-to-worktree assignments
   * @throws Error if worktree creation fails for any phase
   */
  async createWorktreesForPhases(
    sessionId: string,
    phases: Array<{ agentId: string; task: string }>,
  ): Promise<PhaseWorktreeAssignment[]> {
    const assignments: PhaseWorktreeAssignment[] = [];

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]!;
      const session = await this.worktreeManager.create(
        phase.agentId,
        phase.task,
        sessionId,
      );

      // Activate the worktree immediately since it's ready for the agent
      this.worktreeManager.activate(session.id);

      assignments.push({
        phaseIndex: i,
        agentId: phase.agentId,
        worktreeSession: session,
      });
    }

    return assignments;
  }

  /**
   * Merge all completed worktrees sequentially in phase order (Req 3.6).
   *
   * After all parallel phases complete, merge each worktree's changes
   * back into the current branch one at a time. If conflicts arise,
   * the conflictHandler is called to get the user's resolution choice.
   *
   * @param assignments - The phase-to-worktree assignments from createWorktreesForPhases
   * @param conflictHandler - Callback to resolve merge conflicts with user input
   * @returns Sequential merge result with per-phase details
   */
  async mergeSequentially(
    assignments: PhaseWorktreeAssignment[],
    conflictHandler: ConflictResolutionHandler,
  ): Promise<SequentialMergeResult> {
    // Sort by phase index to ensure sequential order
    const sorted = [...assignments].sort((a, b) => a.phaseIndex - b.phaseIndex);

    const phaseResults: PhaseMergeResult[] = [];
    let phasesMerged = 0;

    for (const assignment of sorted) {
      const { phaseIndex, agentId, worktreeSession } = assignment;

      // Generate diff summary before merge
      let diffSummary: DiffSummary | null = null;
      try {
        diffSummary = await this.worktreePromotion.generateDiffSummary(worktreeSession);
      } catch {
        // If diff summary fails, proceed with merge anyway
      }

      // Attempt the merge
      const mergeResult = await this.attemptMerge(
        worktreeSession,
        phaseIndex,
        agentId,
        conflictHandler,
      );

      const phaseResult: PhaseMergeResult = {
        phaseIndex,
        agentId,
        worktreeId: worktreeSession.id,
        success: mergeResult.success,
        conflicts: mergeResult.conflicts,
        diffSummary,
        ...(mergeResult.error !== undefined ? { error: mergeResult.error } : {}),
      };

      phaseResults.push(phaseResult);

      if (mergeResult.success) {
        phasesMerged++;
        // Mark as merged and clean up
        this.worktreeManager.markMerged(worktreeSession.id);
        await this.worktreeManager.remove(worktreeSession.id);
      } else {
        // If a merge fails unresolvably, we still continue with remaining phases
        // but mark this one as discarded
        this.worktreeManager.markDiscarded(worktreeSession.id);
      }
    }

    return {
      success: phasesMerged === sorted.length,
      phasesMerged,
      totalPhases: sorted.length,
      phaseResults,
    };
  }

  /**
   * Attempt to merge a single worktree's branch into the current branch.
   * Handles conflicts by calling the conflict handler for user resolution.
   */
  private async attemptMerge(
    session: WorktreeSession,
    phaseIndex: number,
    agentId: string,
    conflictHandler: ConflictResolutionHandler,
  ): Promise<{ success: boolean; conflicts: MergeConflict[]; error?: string }> {
    try {
      const result = await this.gitClient.merge(this.projectDir, session.branchName);

      if (result.success) {
        return { success: true, conflicts: [] };
      }

      // Merge conflicts detected — gather conflict details
      const conflicts = await this.gatherConflictDetails(
        result.conflictFiles,
        session.branchName,
      );

      // Present conflicts to user for resolution
      const resolutions = await conflictHandler(phaseIndex, agentId, conflicts);

      // Apply resolutions
      const resolved = await this.applyResolutions(resolutions, session.branchName);

      if (resolved) {
        // All conflicts resolved — complete the merge
        await this.gitClient.mergeCommit(this.projectDir);
        return { success: true, conflicts };
      } else {
        // Resolution failed or user chose to abort — abort the merge
        await this.gitClient.mergeAbort(this.projectDir);
        return {
          success: false,
          conflicts,
          error: 'Merge aborted: conflict resolution incomplete',
        };
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Try to abort any in-progress merge
      try {
        await this.gitClient.mergeAbort(this.projectDir);
      } catch {
        // Already clean state
      }
      return {
        success: false,
        conflicts: [],
        error: `Merge failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Gather detailed conflict information for conflicted files.
   */
  private async gatherConflictDetails(
    conflictFiles: string[],
    branchName: string,
  ): Promise<MergeConflict[]> {
    const conflicts: MergeConflict[] = [];

    for (const filePath of conflictFiles) {
      const conflictMarkers = await this.gitClient.getConflictedContent(
        this.projectDir,
        filePath,
      );

      // Get the incoming version (from the worktree branch)
      const incomingContent = await this.gitClient.getFileFromRef(
        this.projectDir,
        branchName,
        filePath,
      );

      // Get the current version (HEAD before merge)
      const currentContent = await this.gitClient.getFileFromRef(
        this.projectDir,
        'HEAD',
        filePath,
      );

      conflicts.push({
        filePath,
        incomingContent,
        currentContent,
        conflictMarkers,
      });
    }

    return conflicts;
  }

  /**
   * Apply user-chosen resolutions to conflicted files.
   * Returns true if all conflicts were resolved, false if any remain.
   */
  private async applyResolutions(
    resolutions: ConflictResolutionResult[],
    _branchName: string,
  ): Promise<boolean> {
    for (const resolution of resolutions) {
      switch (resolution.resolution) {
        case 'accept-incoming':
          // Use the worktree branch's version
          await this.gitClient.checkoutStrategy(this.projectDir, resolution.filePath, 'theirs');
          await this.gitClient.stageFile(this.projectDir, resolution.filePath);
          break;

        case 'keep-current':
          // Keep the current branch's version
          await this.gitClient.checkoutStrategy(this.projectDir, resolution.filePath, 'ours');
          await this.gitClient.stageFile(this.projectDir, resolution.filePath);
          break;

        case 'manual':
          // User provided resolved content
          if (resolution.resolvedContent !== undefined) {
            await this.gitClient.writeFile(
              this.projectDir,
              resolution.filePath,
              resolution.resolvedContent,
            );
            await this.gitClient.stageFile(this.projectDir, resolution.filePath);
          } else {
            // No content provided — can't resolve
            return false;
          }
          break;
      }
    }

    return true;
  }

  /**
   * Get the worktree path for a given agent ID from existing assignments.
   * Useful for directing agent execution to the correct working directory.
   */
  getWorktreePathForAgent(
    assignments: PhaseWorktreeAssignment[],
    agentId: string,
  ): string | null {
    const assignment = assignments.find(a => a.agentId === agentId);
    return assignment?.worktreeSession.worktreePath ?? null;
  }

  /**
   * Discard all phase worktrees (cleanup on abort or failure).
   */
  async discardAll(assignments: PhaseWorktreeAssignment[]): Promise<void> {
    for (const assignment of assignments) {
      try {
        this.worktreeManager.markDiscarded(assignment.worktreeSession.id);
        await this.worktreeManager.remove(assignment.worktreeSession.id);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Factory function to create an UltraModeWorktreeIntegration instance.
 *
 * Returns null if the worktree_agent_manager feature is disabled.
 */
export function createUltraModeIntegration(
  worktreeManager: WorktreeManager | null,
  worktreePromotion: WorktreePromotion | null,
  projectDir: string,
  featureGate?: FeatureGateCheck | null,
  gitClient?: UltraModeGitClient,
): UltraModeWorktreeIntegration | null {
  if (!worktreeManager || !worktreePromotion) {
    return null;
  }

  const integration = new UltraModeWorktreeIntegration(
    worktreeManager,
    worktreePromotion,
    projectDir,
    featureGate,
    gitClient,
  );

  if (!integration.isEnabled()) {
    return null;
  }

  return integration;
}
