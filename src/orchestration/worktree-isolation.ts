/**
 * WorktreeIsolation — Git worktree lifecycle management for sub-agent isolation.
 *
 * Creates, validates, merges, and cleans up dedicated git worktrees so that
 * each parallel sub-agent operates in its own isolated directory without
 * creating file conflicts during concurrent execution.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

export interface WorktreeHandle {
  id: string;
  path: string;
  branch: string;
  agentId: string;
  createdAt: string;
}

export interface ValidateResult {
  valid: boolean;
  conflicts?: string[];
}

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
}

// ─── Implementation ─────────────────────────────────────────────

export class WorktreeIsolation {
  private activeWorktrees: Map<string, WorktreeHandle> = new Map();

  constructor(private projectDir: string) {}

  /**
   * Create an isolated git worktree for a sub-agent.
   *
   * Spawns a new worktree with a unique branch name following the pattern
   * `agent/{agentId}/{timestamp}` and returns a handle for lifecycle management.
   */
  async create(agentId: string): Promise<WorktreeHandle> {
    const id = randomUUID();
    const timestamp = Date.now();
    const branch = `agent/${agentId}/${timestamp}`;
    const worktreePath = join(this.projectDir, '.worktrees', id);

    // Get the current HEAD ref to base the new branch on
    const { stdout: headRef } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: this.projectDir },
    );

    // Create a new worktree with a new branch based on current HEAD
    await execFileAsync(
      'git',
      ['worktree', 'add', '-b', branch, worktreePath, headRef.trim()],
      { cwd: this.projectDir },
    );

    const handle: WorktreeHandle = {
      id,
      path: worktreePath,
      branch,
      agentId,
      createdAt: new Date().toISOString(),
    };

    this.activeWorktrees.set(id, handle);
    return handle;
  }

  /**
   * Validate worktree changes by attempting a dry-run merge and checking for conflicts.
   *
   * Returns `{ valid: true }` if the worktree branch can be cleanly merged
   * back to the main branch. Returns `{ valid: false, conflicts }` if there
   * are merge conflicts.
   */
  async validate(handle: WorktreeHandle): Promise<ValidateResult> {
    // Get the current main branch name
    const mainBranch = await this.getMainBranch();

    try {
      // Attempt a dry-run merge: merge --no-commit --no-ff, then abort
      await execFileAsync(
        'git',
        ['merge', '--no-commit', '--no-ff', handle.branch],
        { cwd: this.projectDir },
      );

      // If merge succeeded without conflicts, abort it (dry-run)
      await execFileAsync(
        'git',
        ['merge', '--abort'],
        { cwd: this.projectDir },
      );

      return { valid: true };
    } catch (error: unknown) {
      // Merge failed — extract conflict information
      const conflicts = await this.getConflictedFiles();

      // Always abort the in-progress merge to restore clean state
      try {
        await execFileAsync(
          'git',
          ['merge', '--abort'],
          { cwd: this.projectDir },
        );
      } catch {
        // merge --abort may fail if there's nothing to abort; ignore
      }

      return { valid: false, conflicts };
    }
  }

  /**
   * Merge worktree branch changes back to the main working directory.
   *
   * Performs a real merge of the worktree's branch into the current branch.
   * Reports conflicts if the merge cannot be completed cleanly.
   */
  async merge(handle: WorktreeHandle): Promise<MergeResult> {
    try {
      await execFileAsync(
        'git',
        ['merge', '--no-ff', handle.branch, '-m', `Merge agent work: ${handle.agentId}`],
        { cwd: this.projectDir },
      );

      return { success: true };
    } catch (error: unknown) {
      // Merge produced conflicts
      const conflicts = await this.getConflictedFiles();

      // Abort the merge to leave the repository in a clean state
      try {
        await execFileAsync(
          'git',
          ['merge', '--abort'],
          { cwd: this.projectDir },
        );
      } catch {
        // Ignore abort failures
      }

      return { success: false, conflicts };
    }
  }

  /**
   * Clean up a worktree on agent completion or failure.
   *
   * Removes the worktree directory, prunes git's worktree tracking,
   * and deletes the temporary branch.
   */
  async cleanup(handle: WorktreeHandle): Promise<void> {
    // Remove the worktree from git's tracking
    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', handle.path, '--force'],
        { cwd: this.projectDir },
      );
    } catch {
      // Worktree may already be removed; try manual cleanup
      try {
        await rm(handle.path, { recursive: true, force: true });
        await execFileAsync(
          'git',
          ['worktree', 'prune'],
          { cwd: this.projectDir },
        );
      } catch {
        // Best-effort cleanup
      }
    }

    // Delete the temporary branch
    try {
      await execFileAsync(
        'git',
        ['branch', '-D', handle.branch],
        { cwd: this.projectDir },
      );
    } catch {
      // Branch may already be deleted or not exist; ignore
    }

    // Remove from active tracking
    this.activeWorktrees.delete(handle.id);
  }

  /**
   * Get all currently active worktree handles.
   */
  getActiveWorktrees(): WorktreeHandle[] {
    return Array.from(this.activeWorktrees.values());
  }

  /**
   * Get a specific worktree handle by ID.
   */
  getWorktree(id: string): WorktreeHandle | undefined {
    return this.activeWorktrees.get(id);
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Get the name of the current branch in the main project directory.
   */
  private async getMainBranch(): Promise<string> {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: this.projectDir },
    );
    return stdout.trim();
  }

  /**
   * List files that have merge conflicts in the main project directory.
   */
  private async getConflictedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: this.projectDir },
      );
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
