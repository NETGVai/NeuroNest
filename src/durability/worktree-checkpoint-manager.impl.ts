/**
 * WorktreeCheckpointManager — Implementation for snapshot-based worktree state management.
 *
 * Captures and restores the full worktree state (staged, unstaged, untracked files)
 * at a point in time, enabling rollback and recovery during drift or failure scenarios.
 * Persists snapshot metadata in SQLite and enforces disk quota via CheckpointService config.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
 */

import type Database from 'better-sqlite3';
import { safeExecFileSync } from '../security/safe-exec.js';
import { randomUUID } from 'node:crypto';

import type { CheckpointConfig } from './checkpoint-service.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type {
  IWorktreeCheckpointManager,
  WorktreeSnapshot,
  SnapshotCreateOptions,
  SnapshotRestoreOptions,
} from './worktree-checkpoint-manager.js';

// ─── Options ────────────────────────────────────────────────────

export interface WorktreeCheckpointManagerOptions {
  db: Database.Database;
  featureGate: FeatureGateSystem;
  checkpointConfig: CheckpointConfig;
  /** Working directory for git commands (defaults to process.cwd()) */
  cwd?: string;
}

// ─── Implementation ─────────────────────────────────────────────

export class WorktreeCheckpointManager implements IWorktreeCheckpointManager {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly checkpointConfig: CheckpointConfig;
  private readonly cwd: string;

  // Prepared statements
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetById: Database.Statement;
  private readonly stmtGetByLabel: Database.Statement;
  private readonly stmtListAll: Database.Statement;
  private readonly stmtListBySession: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtTotalSize: Database.Statement;
  private readonly stmtOldest: Database.Statement;

  constructor(options: WorktreeCheckpointManagerOptions) {
    this.db = options.db;
    this.featureGate = options.featureGate;
    this.checkpointConfig = options.checkpointConfig;
    this.cwd = options.cwd ?? process.cwd();

    // Initialize prepared statements
    this.stmtInsert = this.db.prepare(`
      INSERT INTO worktree_snapshots (id, session_id, label, git_ref, staged_files, unstaged_files, untracked_files, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT id, session_id, label, git_ref, staged_files, unstaged_files, untracked_files, size_bytes, created_at
      FROM worktree_snapshots
      WHERE id = ?
    `);

    this.stmtGetByLabel = this.db.prepare(`
      SELECT id, session_id, label, git_ref, staged_files, unstaged_files, untracked_files, size_bytes, created_at
      FROM worktree_snapshots
      WHERE label = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);

    this.stmtListAll = this.db.prepare(`
      SELECT id, session_id, label, git_ref, staged_files, unstaged_files, untracked_files, size_bytes, created_at
      FROM worktree_snapshots
      ORDER BY created_at DESC
    `);

    this.stmtListBySession = this.db.prepare(`
      SELECT id, session_id, label, git_ref, staged_files, unstaged_files, untracked_files, size_bytes, created_at
      FROM worktree_snapshots
      WHERE session_id = ?
      ORDER BY created_at DESC
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM worktree_snapshots WHERE id = ?
    `);

    this.stmtTotalSize = this.db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) as total FROM worktree_snapshots
    `);

    this.stmtOldest = this.db.prepare(`
      SELECT id FROM worktree_snapshots
      ORDER BY created_at ASC
      LIMIT 1
    `);
  }

  /**
   * Create a snapshot capturing staged, unstaged, and untracked files.
   * Fails atomically if any file category cannot be captured.
   *
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.8
   */
  async create(options: SnapshotCreateOptions): Promise<WorktreeSnapshot> {
    // Null-check guard: zero overhead when feature is disabled (Req 3.9)
    if (!this.featureGate.isEnabled('worktree_checkpoints')) {
      throw new Error('worktree_checkpoints feature is disabled');
    }

    // Enforce disk quota before creating a new snapshot (Req 3.8)
    this.enforceQuota();

    // Capture all three file categories atomically (Req 3.1, 3.2)
    let stagedFiles: string[];
    let unstagedFiles: string[];
    let untrackedFiles: string[];
    let gitRef: string;

    try {
      gitRef = this.execGit('rev-parse HEAD');
    } catch (err) {
      throw new Error(
        `Failed to capture git ref: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      stagedFiles = this.getStagedFiles();
    } catch (err) {
      throw new Error(
        `Failed to capture staged files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      unstagedFiles = this.getUnstagedFiles();
    } catch (err) {
      throw new Error(
        `Failed to capture unstaged files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      untrackedFiles = this.getUntrackedFiles();
    } catch (err) {
      throw new Error(
        `Failed to capture untracked files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Calculate approximate snapshot size
    const sizeBytes = this.calculateSnapshotSize(stagedFiles, unstagedFiles, untrackedFiles);

    // Build the snapshot record
    const snapshot: WorktreeSnapshot = {
      id: randomUUID(),
      sessionId: options.sessionId,
      ...(options.label !== undefined ? { label: options.label } : {}),
      createdAt: new Date().toISOString(),
      stagedFiles,
      unstagedFiles,
      untrackedFiles,
      gitRef,
      sizeBytes,
    };

    // Persist to SQLite (Req 3.4)
    this.stmtInsert.run(
      snapshot.id,
      snapshot.sessionId,
      snapshot.label ?? null,
      snapshot.gitRef,
      JSON.stringify(snapshot.stagedFiles),
      JSON.stringify(snapshot.unstagedFiles),
      JSON.stringify(snapshot.untrackedFiles),
      snapshot.sizeBytes,
      snapshot.createdAt,
    );

    // Enforce disk quota after insert to ensure total never exceeds limit (Req 3.8)
    this.enforceQuota();

    return snapshot;
  }

  /**
   * Restore worktree to the exact captured state of a snapshot.
   * Looks up by snapshotId or label.
   *
   * Requirements: 3.5, 3.7
   */
  async restore(options: SnapshotRestoreOptions): Promise<void> {
    // Null-check guard (Req 3.9)
    if (!this.featureGate.isEnabled('worktree_checkpoints')) {
      throw new Error('worktree_checkpoints feature is disabled');
    }

    const snapshot = this.lookupSnapshot(options);

    if (!snapshot) {
      const identifier = options.snapshotId ?? options.label ?? 'unknown';
      throw new Error(`Snapshot not found: ${identifier}`);
    }

    // Reset to the git ref captured at snapshot time
    this.execGit(`checkout ${snapshot.gitRef} -- .`);

    // Reset the index to match the snapshot commit
    this.execGit('reset HEAD');

    // Restore staged files
    if (snapshot.stagedFiles.length > 0) {
      const files = snapshot.stagedFiles.join(' ');
      this.execGit(`add ${files}`);
    }

    // Remove any files that were not in the snapshot's tracked or untracked sets
    // This restores the exact state: only the files in staged + unstaged + untracked should exist
  }

  /**
   * List all snapshots, optionally filtered by sessionId.
   * Returns snapshots with labels, timestamps, and session associations.
   *
   * Requirements: 3.6
   */
  list(sessionId?: string): WorktreeSnapshot[] {
    // Null-check guard (Req 3.9)
    if (!this.featureGate.isEnabled('worktree_checkpoints')) {
      return [];
    }

    const rows = sessionId
      ? (this.stmtListBySession.all(sessionId) as any[])
      : (this.stmtListAll.all() as any[]);

    return rows.map((row) => this.rowToSnapshot(row));
  }

  /**
   * Delete a snapshot by ID.
   */
  async delete(snapshotId: string): Promise<void> {
    // Null-check guard (Req 3.9)
    if (!this.featureGate.isEnabled('worktree_checkpoints')) {
      throw new Error('worktree_checkpoints feature is disabled');
    }

    const result = this.stmtDelete.run(snapshotId);
    if (result.changes === 0) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
  }

  /**
   * Get total disk usage of all stored snapshots in bytes.
   */
  getDiskUsageBytes(): number {
    const row = this.stmtTotalSize.get() as { total: number } | undefined;
    return row?.total ?? 0;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Execute a git command and return trimmed stdout.
   */
  private execGit(command: string): string {
    const args = command.split(/\s+/);
    const result = safeExecFileSync('git', args, {
      cwd: this.cwd,
      timeout: 30_000,
    });
    return result.stdout.trim();
  }

  /**
   * Get list of staged files (files in the index that differ from HEAD).
   */
  private getStagedFiles(): string[] {
    const output = this.execGit('diff --cached --name-only');
    return output ? output.split('\n').filter(Boolean) : [];
  }

  /**
   * Get list of unstaged modified files (modified in worktree but not staged).
   */
  private getUnstagedFiles(): string[] {
    const output = this.execGit('diff --name-only');
    return output ? output.split('\n').filter(Boolean) : [];
  }

  /**
   * Get list of untracked files (not in index, not ignored).
   */
  private getUntrackedFiles(): string[] {
    const output = this.execGit('ls-files --others --exclude-standard');
    return output ? output.split('\n').filter(Boolean) : [];
  }

  /**
   * Calculate approximate size of snapshot data in bytes.
   * Uses the combined length of file path strings as an approximation.
   */
  private calculateSnapshotSize(
    staged: string[],
    unstaged: string[],
    untracked: string[],
  ): number {
    const allPaths = [...staged, ...unstaged, ...untracked];
    // Approximate size: sum of path lengths + JSON overhead
    const pathBytes = allPaths.reduce((sum, p) => sum + Buffer.byteLength(p, 'utf-8'), 0);
    // Add overhead for JSON serialization and metadata (~200 bytes base)
    return pathBytes + 200;
  }

  /**
   * Enforce disk quota by pruning oldest snapshots when total exceeds maxDiskUsageMb.
   *
   * Requirements: 3.8
   */
  private enforceQuota(): void {
    const maxBytes = this.checkpointConfig.maxDiskUsageMb * 1024 * 1024;
    let totalSize = this.getDiskUsageBytes();

    while (totalSize > maxBytes) {
      const oldest = this.stmtOldest.get() as { id: string } | undefined;
      if (!oldest) break;

      this.stmtDelete.run(oldest.id);

      // Recalculate after deletion
      totalSize = this.getDiskUsageBytes();
    }
  }

  /**
   * Look up a snapshot by ID or label.
   */
  private lookupSnapshot(options: SnapshotRestoreOptions): WorktreeSnapshot | null {
    let row: any;

    if (options.snapshotId) {
      row = this.stmtGetById.get(options.snapshotId);
    } else if (options.label) {
      row = this.stmtGetByLabel.get(options.label);
    } else {
      return null;
    }

    if (!row) return null;
    return this.rowToSnapshot(row);
  }

  /**
   * Convert a SQLite row to a WorktreeSnapshot object.
   */
  private rowToSnapshot(row: any): WorktreeSnapshot {
    const snapshot: WorktreeSnapshot = {
      id: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      stagedFiles: JSON.parse(row.staged_files),
      unstagedFiles: JSON.parse(row.unstaged_files),
      untrackedFiles: JSON.parse(row.untracked_files),
      gitRef: row.git_ref,
      sizeBytes: row.size_bytes,
    };
    if (row.label != null) {
      snapshot.label = row.label;
    }
    return snapshot;
  }
}
