/**
 * GitAwarenessService — Surfaces Git state scoped to a workspace/worktree.
 *
 * Provides branch, commit status (ahead/behind/clean/dirty), dirty files,
 * conflict state, remote tracking, and per-file blame information.
 * All state is bound to a specific workspace path — never reads global Git state.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7
 */

// ─── Types ──────────────────────────────────────────────────────

/** Commit status relative to remote tracking branch */
export type CommitStatus = 'clean' | 'dirty' | 'ahead' | 'behind' | 'diverged';

/** File status in the working tree */
export type FileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted';

/** A dirty file entry */
export interface DirtyFile {
  /** Path relative to workspace root */
  path: string;
  /** File status */
  status: FileStatus;
  /** Staged status (if different from working tree) */
  staged: boolean;
}

/** Conflict state for a file */
export interface ConflictEntry {
  /** Path relative to workspace root */
  path: string;
  /** Conflict type */
  conflictType: 'both-modified' | 'added-by-us' | 'added-by-them' | 'deleted-by-us' | 'deleted-by-them';
}

/** Remote tracking information */
export interface RemoteTracking {
  /** Remote name (e.g. 'origin') */
  remote: string;
  /** Remote branch name */
  remoteBranch: string;
  /** Number of commits ahead of remote */
  ahead: number;
  /** Number of commits behind remote */
  behind: number;
}

/** Blame information for a line */
export interface BlameLine {
  /** Commit SHA */
  commitHash: string;
  /** Author name */
  author: string;
  /** Author email */
  authorEmail: string;
  /** Commit timestamp (ISO 8601) */
  timestamp: string;
  /** Line number (1-based) */
  lineNumber: number;
  /** Line content */
  content: string;
}

/** Complete Git state snapshot for a workspace */
export interface GitState {
  /** Workspace path this state is bound to */
  workspacePath: string;
  /** Current branch name (null if detached HEAD) */
  branch: string | null;
  /** HEAD commit SHA */
  headCommit: string | null;
  /** Whether the working tree has uncommitted changes */
  isDirty: boolean;
  /** Commit status relative to upstream */
  commitStatus: CommitStatus;
  /** List of dirty files */
  dirtyFiles: DirtyFile[];
  /** Whether there are unresolved merge conflicts */
  hasConflicts: boolean;
  /** List of conflicting files */
  conflicts: ConflictEntry[];
  /** Remote tracking info (null if no upstream) */
  remoteTracking: RemoteTracking | null;
  /** Whether this is a worktree (not the main working tree) */
  isWorktree: boolean;
  /** Timestamp when this state was captured */
  capturedAt: string;
}

/** Interface for git command execution (allows testability) */
export interface GitCommandRunner {
  /** Execute a git command in the given workspace directory */
  exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ─── GitAwarenessService ────────────────────────────────────────

/**
 * Service that surfaces Git awareness state scoped to a specific workspace/worktree.
 * Binds all operations to the workspace path provided at construction — never
 * reads global Git state or other workspace paths.
 */
export class GitAwarenessService {
  private workspacePath: string;
  private gitRunner: GitCommandRunner;
  private cachedState: GitState | null = null;
  private cacheTimestamp: number = 0;
  private readonly cacheTtlMs: number;

  constructor(workspacePath: string, gitRunner: GitCommandRunner, cacheTtlMs: number = 5000) {
    this.workspacePath = workspacePath;
    this.gitRunner = gitRunner;
    this.cacheTtlMs = cacheTtlMs;
  }

  /** Get the workspace path this service is bound to */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Get the full Git state for the bound workspace.
   * Uses a short-lived cache to avoid excessive git operations.
   */
  async getState(forceRefresh = false): Promise<GitState> {
    const now = Date.now();
    if (!forceRefresh && this.cachedState && (now - this.cacheTimestamp) < this.cacheTtlMs) {
      return this.cachedState;
    }

    const state = await this.captureState();
    this.cachedState = state;
    this.cacheTimestamp = now;
    return state;
  }

  /** Get the current branch name */
  async getBranch(): Promise<string | null> {
    const result = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.exitCode !== 0) return null;
    const branch = result.stdout.trim();
    return branch === 'HEAD' ? null : branch;
  }

  /** Get the HEAD commit SHA */
  async getHeadCommit(): Promise<string | null> {
    const result = await this.git(['rev-parse', 'HEAD']);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  }

  /** Get dirty files in the working tree */
  async getDirtyFiles(): Promise<DirtyFile[]> {
    const result = await this.git(['status', '--porcelain=v1', '-z']);
    if (result.exitCode !== 0) return [];
    return this.parsePorcelainStatus(result.stdout);
  }

  /** Get conflict state */
  async getConflicts(): Promise<ConflictEntry[]> {
    const result = await this.git(['status', '--porcelain=v1', '-z']);
    if (result.exitCode !== 0) return [];
    return this.parseConflicts(result.stdout);
  }

  /** Get remote tracking information */
  async getRemoteTracking(): Promise<RemoteTracking | null> {
    const branch = await this.getBranch();
    if (!branch) return null;

    // Get upstream reference
    const upstreamResult = await this.git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
    if (upstreamResult.exitCode !== 0) return null;

    const upstream = upstreamResult.stdout.trim();
    if (!upstream) return null;

    // Parse remote/branch
    const slashIdx = upstream.indexOf('/');
    const remote = slashIdx > 0 ? upstream.slice(0, slashIdx) : 'origin';
    const remoteBranch = slashIdx > 0 ? upstream.slice(slashIdx + 1) : upstream;

    // Get ahead/behind counts
    const revListResult = await this.git(['rev-list', '--left-right', '--count', `${branch}...${upstream}`]);
    if (revListResult.exitCode !== 0) return { remote, remoteBranch, ahead: 0, behind: 0 };

    const parts = revListResult.stdout.trim().split(/\s+/);
    const ahead = parseInt(parts[0] ?? '0', 10) || 0;
    const behind = parseInt(parts[1] ?? '0', 10) || 0;

    return { remote, remoteBranch, ahead, behind };
  }

  /** Get blame information for a file */
  async getBlame(relativePath: string): Promise<BlameLine[]> {
    const result = await this.git(['blame', '--porcelain', relativePath]);
    if (result.exitCode !== 0) return [];
    return this.parsePorcelainBlame(result.stdout);
  }

  /** Check if this workspace is a git worktree */
  async isWorktree(): Promise<boolean> {
    const result = await this.git(['rev-parse', '--git-common-dir']);
    if (result.exitCode !== 0) return false;
    const commonDir = result.stdout.trim();
    const gitDirResult = await this.git(['rev-parse', '--git-dir']);
    if (gitDirResult.exitCode !== 0) return false;
    const gitDir = gitDirResult.stdout.trim();
    // If git-dir != git-common-dir, this is a linked worktree
    return commonDir !== gitDir && commonDir !== '.';
  }

  /** Invalidate the cached state */
  invalidateCache(): void {
    this.cachedState = null;
    this.cacheTimestamp = 0;
  }

  // ─── Private Methods ──────────────────────────────────────────

  private async git(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.gitRunner.exec(args, this.workspacePath);
  }

  private async captureState(): Promise<GitState> {
    const [branch, headCommit, dirtyFiles, conflicts, remoteTracking, worktree] = await Promise.all([
      this.getBranch(),
      this.getHeadCommit(),
      this.getDirtyFiles(),
      this.getConflicts(),
      this.getRemoteTracking(),
      this.isWorktree(),
    ]);

    const isDirty = dirtyFiles.length > 0;
    const hasConflicts = conflicts.length > 0;

    let commitStatus: CommitStatus = 'clean';
    if (isDirty) {
      commitStatus = 'dirty';
    } else if (remoteTracking) {
      if (remoteTracking.ahead > 0 && remoteTracking.behind > 0) {
        commitStatus = 'diverged';
      } else if (remoteTracking.ahead > 0) {
        commitStatus = 'ahead';
      } else if (remoteTracking.behind > 0) {
        commitStatus = 'behind';
      }
    }

    return {
      workspacePath: this.workspacePath,
      branch,
      headCommit,
      isDirty,
      commitStatus,
      dirtyFiles,
      hasConflicts,
      conflicts,
      remoteTracking,
      isWorktree: worktree,
      capturedAt: new Date().toISOString(),
    };
  }

  private parsePorcelainStatus(output: string): DirtyFile[] {
    if (!output) return [];
    const files: DirtyFile[] = [];
    // porcelain v1 with -z uses NUL separators
    const entries = output.split('\0').filter(e => e.length > 0);

    for (const entry of entries) {
      if (entry.length < 4) continue;
      const indexStatus = entry[0] ?? ' ';
      const workTreeStatus = entry[1] ?? ' ';
      const path = entry.slice(3);

      // Skip conflict entries (handled separately)
      if (indexStatus === 'U' || workTreeStatus === 'U' ||
          (indexStatus === 'A' && workTreeStatus === 'A') ||
          (indexStatus === 'D' && workTreeStatus === 'D')) {
        continue;
      }

      const status = this.mapStatusChar(indexStatus !== ' ' ? indexStatus : workTreeStatus);
      const staged = indexStatus !== ' ' && indexStatus !== '?';

      if (status) {
        files.push({ path, status, staged });
      }
    }

    return files;
  }

  private parseConflicts(output: string): ConflictEntry[] {
    if (!output) return [];
    const conflicts: ConflictEntry[] = [];
    const entries = output.split('\0').filter(e => e.length > 0);

    for (const entry of entries) {
      if (entry.length < 4) continue;
      const indexStatus = entry[0] ?? ' ';
      const workTreeStatus = entry[1] ?? ' ';
      const path = entry.slice(3);

      let conflictType: ConflictEntry['conflictType'] | null = null;

      if (indexStatus === 'U' && workTreeStatus === 'U') {
        conflictType = 'both-modified';
      } else if (indexStatus === 'A' && workTreeStatus === 'A') {
        conflictType = 'both-modified';
      } else if (indexStatus === 'A' && workTreeStatus === 'U') {
        conflictType = 'added-by-us';
      } else if (indexStatus === 'U' && workTreeStatus === 'A') {
        conflictType = 'added-by-them';
      } else if (indexStatus === 'D' && workTreeStatus === 'U') {
        conflictType = 'deleted-by-us';
      } else if (indexStatus === 'U' && workTreeStatus === 'D') {
        conflictType = 'deleted-by-them';
      }

      if (conflictType) {
        conflicts.push({ path, conflictType });
      }
    }

    return conflicts;
  }

  private parsePorcelainBlame(output: string): BlameLine[] {
    if (!output) return [];
    const lines: BlameLine[] = [];
    const rawLines = output.split('\n');

    let currentHash = '';
    let currentAuthor = '';
    let currentEmail = '';
    let currentTimestamp = '';
    let currentLineNumber = 0;

    for (const line of rawLines) {
      // Commit header line: SHA orig-line final-line [num-lines]
      const commitMatch = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
      if (commitMatch) {
        currentHash = commitMatch[1] ?? '';
        currentLineNumber = parseInt(commitMatch[2] ?? '0', 10);
        continue;
      }

      if (line.startsWith('author ')) {
        currentAuthor = line.slice(7);
      } else if (line.startsWith('author-mail ')) {
        currentEmail = line.slice(12).replace(/[<>]/g, '');
      } else if (line.startsWith('author-time ')) {
        const epoch = parseInt(line.slice(12), 10);
        currentTimestamp = new Date(epoch * 1000).toISOString();
      } else if (line.startsWith('\t')) {
        // Content line
        lines.push({
          commitHash: currentHash,
          author: currentAuthor,
          authorEmail: currentEmail,
          timestamp: currentTimestamp,
          lineNumber: currentLineNumber,
          content: line.slice(1),
        });
      }
    }

    return lines;
  }

  private mapStatusChar(char: string): FileStatus | null {
    switch (char) {
      case 'M': return 'modified';
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      case 'C': return 'copied';
      case '?': return 'untracked';
      case 'U': return 'conflicted';
      default: return null;
    }
  }
}
