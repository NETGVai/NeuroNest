/**
 * WorktreePromotion — Merge/PR/discard actions for completed worktree sessions.
 *
 * Generates a diff summary upon task completion and offers three promotion paths:
 * 1. Merge to current branch — fast-forward or merge commit into the working branch
 * 2. Create PR — push the worktree branch and open a PR via GitHub REST API
 * 3. Discard — remove the worktree and delete the branch without merging
 *
 * After promotion or discard, cleans up the worktree directory and temporary branch.
 *
 * Requirements: 3.3
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorktreeManager, WorktreeSession, WorktreeDiffStats } from './worktree-manager.js';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

/** Summary of changes in a worktree compared to the base branch */
export interface DiffSummary {
  /** Number of files added */
  filesAdded: number;
  /** Number of files modified */
  filesModified: number;
  /** Number of files deleted */
  filesDeleted: number;
  /** Total lines inserted across all files */
  linesAdded: number;
  /** Total lines deleted across all files */
  linesDeleted: number;
  /** List of changed file paths with their change type */
  changedFiles: Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }>;
}

/** Result of a promotion action */
export interface PromotionResult {
  /** Whether the promotion succeeded */
  success: boolean;
  /** The action that was performed */
  action: 'merge' | 'pr' | 'discard';
  /** Human-readable message describing the outcome */
  message: string;
  /** PR URL if action was 'pr' and succeeded */
  prUrl?: string;
}

/** Options for creating a PR */
export interface CreatePROptions {
  /** GitHub personal access token */
  token: string;
  /** Repository owner (e.g., "user" or "org") */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR title */
  title: string;
  /** PR body/description */
  body?: string;
  /** Base branch to merge into (default: current branch) */
  baseBranch?: string;
  /** Remote name (default: 'origin') */
  remote?: string;
}

/** Interface for git operations used in promotion (thin wrapper for testability) */
export interface PromotionGitClient {
  /** Get the current branch name */
  getCurrentBranch(cwd: string): Promise<string>;
  /** Get diff stat between two refs */
  getDiffStat(cwd: string, baseRef: string, headRef: string): Promise<string>;
  /** Get list of changed files between two refs with their status */
  getDiffNameStatus(cwd: string, baseRef: string, headRef: string): Promise<string>;
  /** Get the numstat (lines added/deleted per file) between two refs */
  getDiffNumstat(cwd: string, baseRef: string, headRef: string): Promise<string>;
  /** Merge a branch into the current branch */
  merge(cwd: string, branch: string): Promise<void>;
  /** Push a branch to a remote */
  push(cwd: string, remote: string, branch: string): Promise<void>;
  /** Get the merge base between two refs */
  getMergeBase(cwd: string, ref1: string, ref2: string): Promise<string>;
}

/** Interface for GitHub API interactions (testability) */
export interface GitHubApiClient {
  /** Create a pull request and return the PR URL */
  createPullRequest(options: {
    token: string;
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<string>;
}

// ─── Default Git Client ─────────────────────────────────────────

/**
 * Default git client using child_process execFile for promotion operations.
 */
export class DefaultPromotionGitClient implements PromotionGitClient {
  async getCurrentBranch(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return stdout.trim();
  }

  async getDiffStat(cwd: string, baseRef: string, headRef: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', '--stat', `${baseRef}...${headRef}`], { cwd });
    return stdout.trim();
  }

  async getDiffNameStatus(cwd: string, baseRef: string, headRef: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', '--name-status', `${baseRef}...${headRef}`], { cwd });
    return stdout.trim();
  }

  async getDiffNumstat(cwd: string, baseRef: string, headRef: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', '--numstat', `${baseRef}...${headRef}`], { cwd });
    return stdout.trim();
  }

  async merge(cwd: string, branch: string): Promise<void> {
    await execFileAsync('git', ['merge', branch, '--no-edit'], { cwd });
  }

  async push(cwd: string, remote: string, branch: string): Promise<void> {
    await execFileAsync('git', ['push', remote, branch], { cwd });
  }

  async getMergeBase(cwd: string, ref1: string, ref2: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['merge-base', ref1, ref2], { cwd });
    return stdout.trim();
  }
}

// ─── Default GitHub API Client ──────────────────────────────────

/**
 * Default GitHub API client using Node.js https module.
 * Creates a PR via the GitHub REST API.
 */
export class DefaultGitHubApiClient implements GitHubApiClient {
  async createPullRequest(options: {
    token: string;
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<string> {
    const { default: https } = await import('node:https');

    const payload = JSON.stringify({
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
    });

    return new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.github.com',
          path: `/repos/${options.owner}/${options.repo}/pulls`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${options.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': 'NeuroNest-WorktreePromotion',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed.html_url as string);
              } catch {
                reject(new Error('Failed to parse GitHub API response'));
              }
            } else {
              reject(new Error(`GitHub API error (${res.statusCode}): ${data}`));
            }
          });
        },
      );

      req.on('error', (err: Error) => reject(err));
      req.write(payload);
      req.end();
    });
  }
}

// ─── WorktreePromotion ──────────────────────────────────────────

/**
 * WorktreePromotion — Handles diff summarization and promotion actions for worktrees.
 *
 * Lifecycle:
 * 1. generateDiffSummary() — Computes diff stats between worktree branch and base
 * 2. mergeToCurrent() — Merges worktree branch into the current working branch
 *    OR createPR() — Pushes and opens a GitHub PR
 *    OR discard() — Removes worktree and branch without keeping changes
 *
 * Each action calls cleanup to remove the worktree directory and temporary branch.
 *
 * Requirements: 3.3
 */
export class WorktreePromotion {
  private worktreeManager: WorktreeManager;
  private gitClient: PromotionGitClient;
  private githubClient: GitHubApiClient;
  private projectDir: string;

  constructor(
    worktreeManager: WorktreeManager,
    projectDir: string,
    gitClient?: PromotionGitClient,
    githubClient?: GitHubApiClient,
  ) {
    this.worktreeManager = worktreeManager;
    this.projectDir = projectDir;
    this.gitClient = gitClient ?? new DefaultPromotionGitClient();
    this.githubClient = githubClient ?? new DefaultGitHubApiClient();
  }

  // ─── Diff Summary Generation ────────────────────────────────

  /**
   * Generate a diff summary for a completed worktree session (Req 3.3).
   *
   * Compares the worktree branch against the merge base (the point where
   * the worktree branched off) to show what the agent changed.
   *
   * @param session - The worktree session to summarize
   * @returns A DiffSummary with files changed, lines added/deleted
   */
  async generateDiffSummary(session: WorktreeSession): Promise<DiffSummary> {
    const currentBranch = await this.gitClient.getCurrentBranch(this.projectDir);
    const mergeBase = await this.gitClient.getMergeBase(
      this.projectDir,
      currentBranch,
      session.branchName,
    );

    // Get file-level change information
    const nameStatus = await this.gitClient.getDiffNameStatus(
      this.projectDir,
      mergeBase,
      session.branchName,
    );

    // Get line-level stats
    const numstat = await this.gitClient.getDiffNumstat(
      this.projectDir,
      mergeBase,
      session.branchName,
    );

    const changedFiles = this.parseNameStatus(nameStatus);
    const lineStats = this.parseNumstat(numstat);

    const summary: DiffSummary = {
      filesAdded: changedFiles.filter(f => f.changeType === 'added').length,
      filesModified: changedFiles.filter(f => f.changeType === 'modified').length,
      filesDeleted: changedFiles.filter(f => f.changeType === 'deleted').length,
      linesAdded: lineStats.added,
      linesDeleted: lineStats.deleted,
      changedFiles,
    };

    // Update the worktree session with diff stats
    const diffStats: WorktreeDiffStats = {
      added: summary.filesAdded,
      modified: summary.filesModified,
      deleted: summary.filesDeleted,
      insertions: summary.linesAdded,
      deletions: summary.linesDeleted,
    };
    this.worktreeManager.markMerging(session.id, diffStats);

    return summary;
  }

  // ─── Promotion Paths ────────────────────────────────────────

  /**
   * Merge the worktree branch into the current branch (Req 3.3).
   *
   * Performs a git merge (fast-forward when possible) of the worktree's
   * branch into the current working branch. After merging, cleans up the
   * worktree directory and deletes the temporary branch.
   *
   * @param session - The worktree session to merge
   * @returns PromotionResult indicating success or failure
   */
  async mergeToCurrent(session: WorktreeSession): Promise<PromotionResult> {
    try {
      await this.gitClient.merge(this.projectDir, session.branchName);

      // Mark as merged in the worktree manager
      this.worktreeManager.markMerged(session.id);

      // Clean up worktree and branch
      await this.cleanup(session);

      return {
        success: true,
        action: 'merge',
        message: `Successfully merged branch "${session.branchName}" into current branch.`,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        action: 'merge',
        message: `Merge failed: ${errorMessage}. You may need to resolve conflicts manually.`,
      };
    }
  }

  /**
   * Create a PR from the worktree branch (Req 3.3).
   *
   * Pushes the worktree branch to the remote and creates a pull request
   * via the GitHub REST API. After PR creation, cleans up the local
   * worktree directory (branch is preserved on remote).
   *
   * @param session - The worktree session to promote as a PR
   * @param options - GitHub API configuration and PR metadata
   * @returns PromotionResult with the PR URL on success
   */
  async createPR(session: WorktreeSession, options: CreatePROptions): Promise<PromotionResult> {
    const remote = options.remote ?? 'origin';

    try {
      // Push the branch to the remote
      await this.gitClient.push(this.projectDir, remote, session.branchName);

      // Determine the base branch
      const baseBranch = options.baseBranch
        ?? await this.gitClient.getCurrentBranch(this.projectDir);

      // Create the PR via GitHub API
      const prUrl = await this.githubClient.createPullRequest({
        token: options.token,
        owner: options.owner,
        repo: options.repo,
        title: options.title,
        body: options.body ?? `Automated PR from NeuroNest agent \`${session.agentId}\`.`,
        head: session.branchName,
        base: baseBranch,
      });

      // Mark as merged (PR created = promoted out of local)
      this.worktreeManager.markMerged(session.id);

      // Clean up local worktree (branch remains on remote)
      await this.cleanupWorktreeOnly(session);

      return {
        success: true,
        action: 'pr',
        message: `Pull request created successfully: ${prUrl}`,
        prUrl,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        action: 'pr',
        message: `PR creation failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Discard the worktree changes (Req 3.3).
   *
   * Removes the worktree directory and deletes the temporary branch
   * without merging any changes. The work is permanently lost.
   *
   * @param session - The worktree session to discard
   * @returns PromotionResult indicating success or failure
   */
  async discard(session: WorktreeSession): Promise<PromotionResult> {
    try {
      // Mark as discarded in the worktree manager
      this.worktreeManager.markDiscarded(session.id);

      // Clean up worktree and branch
      await this.cleanup(session);

      return {
        success: true,
        action: 'discard',
        message: `Worktree "${session.branchName}" has been discarded and cleaned up.`,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        action: 'discard',
        message: `Discard cleanup failed: ${errorMessage}. Manual cleanup may be required.`,
      };
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────

  /**
   * Full cleanup: remove worktree directory and delete the branch.
   * Used after merge and discard actions.
   */
  private async cleanup(session: WorktreeSession): Promise<void> {
    await this.worktreeManager.remove(session.id);
  }

  /**
   * Partial cleanup: remove worktree directory only, keep the branch.
   * Used after PR creation (branch needs to stay on the remote).
   */
  private async cleanupWorktreeOnly(session: WorktreeSession): Promise<void> {
    // Remove worktree from git tracking and delete the directory,
    // but don't delete the branch (it's on the remote for the PR)
    await this.worktreeManager.remove(session.id);
  }

  // ─── Parsing Helpers ────────────────────────────────────────

  /**
   * Parse `git diff --name-status` output into structured change records.
   *
   * Format: "A\tpath/to/file" or "M\tpath/to/file" or "D\tpath/to/file"
   */
  private parseNameStatus(output: string): Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }> {
    if (!output.trim()) return [];

    return output
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const [status, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t'); // Handle paths with tabs (unlikely but safe)
        const changeType = this.statusToChangeType(status.trim());
        return { path: filePath, changeType };
      });
  }

  /**
   * Parse `git diff --numstat` output to get total lines added/deleted.
   *
   * Format: "added\tdeleted\tpath/to/file"
   * Binary files show as "-\t-\tpath"
   */
  private parseNumstat(output: string): { added: number; deleted: number } {
    if (!output.trim()) return { added: 0, deleted: 0 };

    let totalAdded = 0;
    let totalDeleted = 0;

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const added = parseInt(parts[0], 10);
      const deleted = parseInt(parts[1], 10);

      // Binary files show "-" for stats; skip them
      if (!isNaN(added)) totalAdded += added;
      if (!isNaN(deleted)) totalDeleted += deleted;
    }

    return { added: totalAdded, deleted: totalDeleted };
  }

  /**
   * Map git status letter to a change type.
   */
  private statusToChangeType(status: string): 'added' | 'modified' | 'deleted' {
    switch (status.charAt(0)) {
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'M': return 'modified';
      case 'R': return 'modified'; // Rename treated as modification
      case 'C': return 'added';    // Copy treated as addition
      default: return 'modified';
    }
  }
}
