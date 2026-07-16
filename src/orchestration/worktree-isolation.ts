/**
 * WorktreeIsolation — Git worktree lifecycle management for sub-agent isolation.
 *
 * Creates, validates, merges, and cleans up dedicated git worktrees so that
 * each parallel sub-agent operates in its own isolated directory without
 * creating file conflicts during concurrent execution.
 *
 * When the `fast_worktree` feature gate is enabled and the native module is
 * available, uses libgit2-based creation for ≤100ms latency. Otherwise falls
 * back to child_process git commands (~400ms).
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 13.1, 13.2, 13.3, 13.4, 13.5, 13.7
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeWorktreeAdapter, type WorktreeCreationMetadata } from './native-worktree-adapter.js';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

export interface WorktreeHandle {
  id: string;
  path: string;
  branch: string;
  agentId: string;
  createdAt: string;
  /** Metadata about how this worktree was created */
  metadata?: WorktreeCreationMetadata;
}

export interface ValidateResult {
  valid: boolean;
  conflicts?: string[];
}

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
}

export interface WorktreeIsolationOptions {
  /** Whether the fast_worktree feature gate is enabled */
  fastWorktreeEnabled?: boolean;
}

// ─── Implementation ─────────────────────────────────────────────

export class WorktreeIsolation {
  private activeWorktrees: Map<string, WorktreeHandle> = new Map();
  private nativeAdapter: NativeWorktreeAdapter;

  constructor(
    private projectDir: string,
    options?: WorktreeIsolationOptions,
  ) {
    this.nativeAdapter = new NativeWorktreeAdapter(options?.fastWorktreeEnabled ?? false);
  }

  /**
   * Create an isolated git worktree for a sub-agent.
   *
   * When the native fast-worktree module is available and the feature gate is
   * enabled, uses libgit2 for sub-100ms creation. Otherwise falls back to
   * shell git commands.
   */
  async create(agentId: string): Promise<WorktreeHandle> {
    const id = randomUUID();
    const timestamp = Date.now();
    const branch = `agent/${agentId}/${timestamp}`;

    if (this.nativeAdapter.isAvailable()) {
      return this.createNative(id, agentId, branch);
    }

    return this.createShell(id, agentId, branch);
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
    const _mainBranch = await this.getMainBranch();

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
   * Uses native removal when available, otherwise falls back to shell git.
   * Removes the worktree directory, prunes git's worktree tracking,
   * and deletes the temporary branch.
   */
  async cleanup(handle: WorktreeHandle): Promise<void> {
    if (this.nativeAdapter.isAvailable()) {
      await this.cleanupNative(handle);
    } else {
      await this.cleanupShell(handle);
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

  /**
   * Check whether native fast-worktree is active for this instance.
   */
  isNativeAvailable(): boolean {
    return this.nativeAdapter.isAvailable();
  }

  /**
   * Update the feature gate state at runtime.
   */
  setFastWorktreeEnabled(enabled: boolean): void {
    this.nativeAdapter.setFeatureGateEnabled(enabled);
  }

  // ─── Native Path ────────────────────────────────────────────────

  /**
   * Create a worktree using the native libgit2 module.
   */
  private async createNative(id: string, agentId: string, branch: string): Promise<WorktreeHandle> {
    const startTime = performance.now();

    // Get current branch to use as base
    const baseBranch = await this.getMainBranch();

    const result = this.nativeAdapter.createWorktree(this.projectDir, id, baseBranch);

    const durationMs = performance.now() - startTime;

    const handle: WorktreeHandle = {
      id,
      path: result.worktreePath,
      branch: result.branch || branch,
      agentId,
      createdAt: new Date().toISOString(),
      metadata: {
        engine: 'native',
        method: 'libgit2',
        sourceRef: baseBranch,
        dirty: false,
        durationMs,
      },
    };

    this.activeWorktrees.set(id, handle);
    return handle;
  }

  /**
   * Remove a worktree using the native libgit2 module.
   */
  private async cleanupNative(handle: WorktreeHandle): Promise<void> {
    try {
      this.nativeAdapter.removeWorktree(this.projectDir, handle.id);
    } catch {
      // If native removal fails, try shell fallback
      await this.cleanupShell(handle);
      return;
    }

    // Delete the temporary branch (native removeWorktree handles worktree cleanup
    // but we still need to delete the branch ref)
    try {
      await execFileAsync(
        'git',
        ['branch', '-D', handle.branch],
        { cwd: this.projectDir },
      );
    } catch {
      // Branch may already be deleted; ignore
    }
  }

  // ─── Shell Fallback Path ────────────────────────────────────────

  /**
   * Create a worktree using shell git commands (fallback path).
   */
  private async createShell(id: string, agentId: string, branch: string): Promise<WorktreeHandle> {
    const startTime = performance.now();
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

    const durationMs = performance.now() - startTime;

    const handle: WorktreeHandle = {
      id,
      path: worktreePath,
      branch,
      agentId,
      createdAt: new Date().toISOString(),
      metadata: {
        engine: 'shell',
        method: 'child_process',
        sourceRef: headRef.trim(),
        dirty: false,
        durationMs,
      },
    };

    this.activeWorktrees.set(id, handle);
    return handle;
  }

  /**
   * Clean up a worktree using shell git commands (fallback path).
   */
  private async cleanupShell(handle: WorktreeHandle): Promise<void> {
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
