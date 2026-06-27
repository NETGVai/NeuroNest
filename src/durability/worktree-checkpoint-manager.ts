/**
 * Worktree Checkpoint Manager — Interfaces for snapshot-based worktree state management.
 *
 * Captures and restores the full worktree state (staged, unstaged, untracked files)
 * at a point in time, enabling rollback and recovery during drift or failure scenarios.
 *
 * Requirements: 3.1–3.9
 */

// Dependencies: CheckpointService, better-sqlite3 (used at implementation time)

// ─── Types ──────────────────────────────────────────────────────

/** Snapshot metadata persisted to SQLite */
export interface WorktreeSnapshot {
  id: string;
  sessionId: string;
  label?: string;
  createdAt: string;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  gitRef: string;              // commit SHA at snapshot time
  sizeBytes: number;
}

/** Options for creating a snapshot */
export interface SnapshotCreateOptions {
  sessionId: string;
  label?: string;
}

/** Options for restoring a snapshot */
export interface SnapshotRestoreOptions {
  snapshotId?: string;
  label?: string;             // alternative lookup by label
}

/** Worktree Checkpoint Manager interface */
export interface IWorktreeCheckpointManager {
  create(options: SnapshotCreateOptions): Promise<WorktreeSnapshot>;
  restore(options: SnapshotRestoreOptions): Promise<void>;
  list(sessionId?: string): WorktreeSnapshot[];
  delete(snapshotId: string): Promise<void>;
  getDiskUsageBytes(): number;
}
