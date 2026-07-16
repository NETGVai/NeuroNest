/**
 * @neuronest/native-fast-worktree TypeScript declarations.
 *
 * Provides native-speed git worktree operations for the Ultra execution mode:
 * creation, removal, promotion (atomic rename), and garbage collection.
 */

/**
 * Result returned by `createWorktree`.
 */
export interface WorktreeResult {
  /** Absolute path to the created worktree directory */
  worktreePath: string;
  /** The worktree identifier */
  worktreeId: string;
  /** The branch checked out in the worktree */
  branch: string;
  /** Whether the creation used the native git2 path */
  native: boolean;
}

/**
 * Result returned by `collectGarbage`.
 */
export interface GcResult {
  /** Number of stale worktrees removed */
  removed: number;
  /** Approximate bytes freed */
  freedBytes: number;
  /** Number of worktrees skipped (still in use or not expired) */
  skipped: number;
}

/**
 * Creates a new git worktree using libgit2.
 *
 * The worktree is created at `.neuronest/worktrees/<worktreeId>` relative
 * to the repository root. A new branch named `neuronest/wt/<worktreeId>`
 * is created from `baseBranch`.
 *
 * @param repoPath - Absolute path to the git repository
 * @param worktreeId - Unique identifier for the worktree
 * @param baseBranch - Branch name to base the worktree on
 * @returns WorktreeResult with path, id, branch, and native flag
 * @throws {Error} If the repository cannot be opened or worktree creation fails
 */
export function createWorktree(
  repoPath: string,
  worktreeId: string,
  baseBranch: string
): WorktreeResult;

/**
 * Removes a worktree and cleans up associated refs.
 *
 * Prunes the worktree from git's internal tracking and removes the
 * worktree directory and its branch ref.
 *
 * @param repoPath - Absolute path to the git repository
 * @param worktreeId - Identifier of the worktree to remove
 * @throws {Error} If the repository cannot be opened or removal fails
 */
export function removeWorktree(repoPath: string, worktreeId: string): void;

/**
 * Promotes a worktree directory's content into the target directory.
 *
 * Uses atomic `rename()` when source and target are on the same filesystem.
 * Falls back to recursive copy + delete when a cross-filesystem rename fails
 * (EXDEV error).
 *
 * @param worktreeDir - Absolute path to the source worktree directory
 * @param targetDir - Absolute path to the promotion target directory
 * @throws {Error} If the source doesn't exist or the operation fails
 */
export function promoteWorktree(worktreeDir: string, targetDir: string): void;

/**
 * Scans for stale worktrees older than the TTL and removes them.
 *
 * Iterates `.neuronest/worktrees/` under `baseDir`, checks each entry's
 * modification time, and removes entries that exceed `ttlSeconds`.
 * Entries with a `.git/lock` file are considered in-use and skipped.
 *
 * @param baseDir - Base directory containing `.neuronest/worktrees/`
 * @param ttlSeconds - Time-to-live in seconds; entries older are removed
 * @returns GcResult with removed count, freed bytes, and skipped count
 */
export function collectGarbage(baseDir: string, ttlSeconds: number): GcResult;

/** Whether the native fast-worktree module loaded successfully */
export const __notSupported: boolean | undefined;

/** Load error message if the module failed to load */
export const loadError: string | undefined;
