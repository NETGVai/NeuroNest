/**
 * WorktreeManager — Git worktree lifecycle management for agent isolation.
 *
 * Creates, tracks, and manages isolated git worktrees for parallel agent tasks
 * in Ultra execution mode. Each agent operates in its own worktree to prevent
 * file conflicts during concurrent execution.
 *
 * Features:
 * - Creates git worktrees branched from HEAD with naming convention
 *   `neuronest/{agent-id}/{task-hash}`
 * - Limits concurrent worktrees to a configurable maximum (default: 5)
 * - Automatically cleans up abandoned worktrees older than 24 hours
 * - Copies environment files (.env, .env.local) and symlinks node_modules
 * - Tracks worktree lifecycle in SQLite (worktree_sessions table)
 *   with status transitions: created → active → merging → merged/discarded
 *
 * Follows NeuroNest's lazy-initialized TypeScript singleton pattern.
 *
 * Requirements: 3.1, 3.2, 3.4, 3.5, 3.6
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { rm, access, copyFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

/** Status lifecycle for a worktree session (Req 3.5) */
export type WorktreeStatus = 'created' | 'active' | 'merging' | 'merged' | 'discarded';

/** Diff statistics for a worktree */
export interface WorktreeDiffStats {
  added: number;
  modified: number;
  deleted: number;
  insertions: number;
  deletions: number;
}

/** A tracked worktree session record */
export interface WorktreeSession {
  id: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  branchName: string;
  worktreePath: string;
  status: WorktreeStatus;
  diffStats: WorktreeDiffStats | null;
  createdAt: number;
  completedAt: number | null;
}

/** Configuration for the WorktreeManager */
export interface WorktreeManagerConfig {
  /** Maximum concurrent worktrees (Req 3.2, default: 5) */
  maxConcurrentWorktrees: number;
  /** Abandoned worktree cleanup threshold in ms (Req 3.2, default: 24 hours) */
  abandonedThresholdMs: number;
  /** Environment files to copy into new worktrees (Req 3.4) */
  envFiles: string[];
  /** Whether to symlink node_modules (Req 3.4) */
  symlinkNodeModules: boolean;
  /** Project root directory */
  projectDir: string;
  /** Project ID for SQLite tracking */
  projectId: string;
}

/** Database row shape from worktree_sessions table */
interface WorktreeSessionRow {
  id: string;
  project_id: string;
  session_id: string;
  agent_id: string;
  branch_name: string;
  worktree_path: string;
  status: string;
  diff_stats: string | null;
  created_at: number;
  completed_at: number | null;
}

/** Interface for git operations (thin wrapper for testability) */
export interface WorktreeGitClient {
  /** Get the current HEAD SHA */
  getHeadSha(cwd: string): Promise<string>;
  /** Create a git worktree */
  addWorktree(cwd: string, branch: string, path: string, baseSha: string): Promise<void>;
  /** Remove a git worktree */
  removeWorktree(cwd: string, path: string): Promise<void>;
  /** Prune worktree references */
  pruneWorktrees(cwd: string): Promise<void>;
  /** Delete a branch */
  deleteBranch(cwd: string, branch: string): Promise<void>;
  /** List existing worktrees */
  listWorktrees(cwd: string): Promise<string[]>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default configuration values */
export const DEFAULT_WORKTREE_CONFIG: Omit<WorktreeManagerConfig, 'projectDir' | 'projectId'> = {
  maxConcurrentWorktrees: 5,
  abandonedThresholdMs: 24 * 60 * 60 * 1000, // 24 hours
  envFiles: ['.env', '.env.local'],
  symlinkNodeModules: true,
};

/** Branch name prefix for worktree branches (Req 3.1) */
export const BRANCH_PREFIX = 'neuronest';

// ─── Default Git Client ─────────────────────────────────────────

/**
 * Default git client using child_process execFile.
 * Provides a testable wrapper around git commands.
 */
export class DefaultWorktreeGitClient implements WorktreeGitClient {
  async getHeadSha(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  }

  async addWorktree(cwd: string, branch: string, path: string, baseSha: string): Promise<void> {
    await execFileAsync('git', ['worktree', 'add', '-b', branch, path, baseSha], { cwd });
  }

  async removeWorktree(cwd: string, path: string): Promise<void> {
    await execFileAsync('git', ['worktree', 'remove', path, '--force'], { cwd });
  }

  async pruneWorktrees(cwd: string): Promise<void> {
    await execFileAsync('git', ['worktree', 'prune'], { cwd });
  }

  async deleteBranch(cwd: string, branch: string): Promise<void> {
    await execFileAsync('git', ['branch', '-D', branch], { cwd });
  }

  async listWorktrees(cwd: string): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd });
    const lines = stdout.split('\n');
    const paths: string[] = [];
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        paths.push(line.slice('worktree '.length));
      }
    }
    return paths;
  }
}

// ─── WorktreeManager ────────────────────────────────────────────

/**
 * WorktreeManager — Manages the full lifecycle of git worktrees for agent isolation.
 *
 * Lifecycle:
 * 1. create() — Creates a new worktree, copies env files, symlinks node_modules
 * 2. activate() — Transitions status from 'created' to 'active'
 * 3. complete() / discard() — Finishes the lifecycle
 * 4. cleanupAbandoned() — Removes stale worktrees older than threshold
 *
 * Lazy-initialized singleton following NeuroNest's established patterns.
 *
 * Requirements: 3.1, 3.2, 3.4, 3.5, 3.6
 */
export class WorktreeManager {
  private static instance: WorktreeManager | null = null;

  private config: WorktreeManagerConfig;
  private db: Database.Database | null = null;
  private gitClient: WorktreeGitClient;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(config: WorktreeManagerConfig, gitClient?: WorktreeGitClient) {
    this.config = config;
    this.gitClient = gitClient ?? new DefaultWorktreeGitClient();
  }

  /** Get or create the singleton instance */
  static getInstance(config: WorktreeManagerConfig, gitClient?: WorktreeGitClient): WorktreeManager {
    if (!WorktreeManager.instance) {
      WorktreeManager.instance = new WorktreeManager(config, gitClient);
    }
    return WorktreeManager.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (WorktreeManager.instance) {
      WorktreeManager.instance.dispose();
    }
    WorktreeManager.instance = null;
  }

  // ─── Dependency Injection ─────────────────────────────────────

  /** Inject the SQLite database for lifecycle tracking (Req 3.5) */
  setDatabase(db: Database.Database): void {
    this.db = db;
    this.ensureTable();
  }

  /** Inject a custom git client (for testing) */
  setGitClient(client: WorktreeGitClient): void {
    this.gitClient = client;
  }

  /** Update configuration at runtime */
  updateConfig(config: Partial<WorktreeManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Get current configuration */
  getConfig(): Readonly<WorktreeManagerConfig> {
    return { ...this.config };
  }

  // ─── Core Lifecycle Methods ───────────────────────────────────

  /**
   * Create a new git worktree for an agent task (Req 3.1, 3.4).
   *
   * Steps:
   * 1. Check concurrent worktree limit (Req 3.2)
   * 2. Generate branch name: neuronest/{agent-id}/{task-hash}
   * 3. Create git worktree branched from HEAD
   * 4. Copy environment files (.env, .env.local)
   * 5. Symlink node_modules
   * 6. Record in SQLite with status 'created'
   *
   * @param agentId - The agent identifier
   * @param taskDescription - Description used to generate the task hash
   * @param sessionId - The session this worktree belongs to
   * @returns The created worktree session record
   * @throws Error if concurrent worktree limit is reached
   */
  async create(agentId: string, taskDescription: string, sessionId: string): Promise<WorktreeSession> {
    // Step 1: Enforce concurrency limit (Req 3.2)
    const activeCount = this.getActiveWorktreeCount();
    if (activeCount >= this.config.maxConcurrentWorktrees) {
      throw new Error(
        `Concurrent worktree limit reached (${this.config.maxConcurrentWorktrees}). ` +
        `Cannot create new worktree for agent "${agentId}". ` +
        `Clean up existing worktrees or increase the limit.`
      );
    }

    // Step 2: Generate branch name (Req 3.1)
    const taskHash = this.generateTaskHash(taskDescription);
    const branchName = `${BRANCH_PREFIX}/${agentId}/${taskHash}`;

    // Step 3: Get current HEAD and create worktree
    const headSha = await this.gitClient.getHeadSha(this.config.projectDir);
    const worktreeId = randomUUID();
    const worktreePath = resolve(this.config.projectDir, '.worktrees', worktreeId);

    await this.gitClient.addWorktree(this.config.projectDir, branchName, worktreePath, headSha);

    // Step 4: Copy environment files (Req 3.4)
    await this.copyEnvFiles(worktreePath);

    // Step 5: Symlink node_modules (Req 3.4)
    if (this.config.symlinkNodeModules) {
      await this.symlinkNodeModules(worktreePath);
    }

    // Step 6: Record in SQLite (Req 3.5)
    const now = Date.now();
    const session: WorktreeSession = {
      id: worktreeId,
      projectId: this.config.projectId,
      sessionId,
      agentId,
      branchName,
      worktreePath,
      status: 'created',
      diffStats: null,
      createdAt: now,
      completedAt: null,
    };

    this.persistSession(session);
    return session;
  }

  /**
   * Transition worktree status from 'created' to 'active' (Req 3.5).
   *
   * Called when the agent begins working in the worktree.
   */
  activate(worktreeId: string): WorktreeSession | null {
    return this.updateStatus(worktreeId, 'active');
  }

  /**
   * Mark worktree as 'merging' — agent work is complete, preparing to merge (Req 3.5).
   */
  markMerging(worktreeId: string, diffStats?: WorktreeDiffStats): WorktreeSession | null {
    const session = this.updateStatus(worktreeId, 'merging');
    if (session && diffStats) {
      this.updateDiffStats(worktreeId, diffStats);
      session.diffStats = diffStats;
    }
    return session;
  }

  /**
   * Mark worktree as 'merged' — successfully merged back (Req 3.5).
   */
  markMerged(worktreeId: string): WorktreeSession | null {
    const session = this.updateStatus(worktreeId, 'merged');
    if (session) {
      this.updateCompletedAt(worktreeId, Date.now());
      session.completedAt = Date.now();
    }
    return session;
  }

  /**
   * Mark worktree as 'discarded' — changes were not kept (Req 3.5).
   */
  markDiscarded(worktreeId: string): WorktreeSession | null {
    const session = this.updateStatus(worktreeId, 'discarded');
    if (session) {
      this.updateCompletedAt(worktreeId, Date.now());
      session.completedAt = Date.now();
    }
    return session;
  }

  /**
   * Remove a worktree from disk and clean up its branch.
   *
   * Removes the worktree directory, prunes git worktree tracking,
   * and deletes the temporary branch.
   */
  async remove(worktreeId: string): Promise<void> {
    const session = this.getSession(worktreeId);
    if (!session) return;

    // Remove the worktree from git
    try {
      await this.gitClient.removeWorktree(this.config.projectDir, session.worktreePath);
    } catch {
      // Worktree may already be removed; try manual cleanup
      try {
        await rm(session.worktreePath, { recursive: true, force: true });
        await this.gitClient.pruneWorktrees(this.config.projectDir);
      } catch {
        // Best-effort cleanup
      }
    }

    // Delete the temporary branch
    try {
      await this.gitClient.deleteBranch(this.config.projectDir, session.branchName);
    } catch {
      // Branch may already be deleted; ignore
    }
  }

  // ─── Query Methods ────────────────────────────────────────────

  /** Get a specific worktree session by ID */
  getSession(worktreeId: string): WorktreeSession | null {
    if (!this.db) return null;

    const row = this.db.prepare(
      'SELECT * FROM worktree_sessions WHERE id = ?'
    ).get(worktreeId) as WorktreeSessionRow | undefined;

    return row ? this.rowToSession(row) : null;
  }

  /** Get all active worktree sessions for the current project */
  getActiveSessions(): WorktreeSession[] {
    if (!this.db) return [];

    const rows = this.db.prepare(
      `SELECT * FROM worktree_sessions 
       WHERE project_id = ? AND status IN ('created', 'active', 'merging')
       ORDER BY created_at DESC`
    ).all(this.config.projectId) as WorktreeSessionRow[];

    return rows.map(row => this.rowToSession(row));
  }

  /** Get all worktree sessions for the current project (any status) */
  getAllSessions(): WorktreeSession[] {
    if (!this.db) return [];

    const rows = this.db.prepare(
      `SELECT * FROM worktree_sessions WHERE project_id = ? ORDER BY created_at DESC`
    ).all(this.config.projectId) as WorktreeSessionRow[];

    return rows.map(row => this.rowToSession(row));
  }

  /** Count currently active worktrees (created, active, or merging) */
  getActiveWorktreeCount(): number {
    if (!this.db) return 0;

    const result = this.db.prepare(
      `SELECT COUNT(*) as count FROM worktree_sessions 
       WHERE project_id = ? AND status IN ('created', 'active', 'merging')`
    ).get(this.config.projectId) as { count: number } | undefined;

    return result?.count ?? 0;
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Clean up abandoned worktrees older than the configured threshold (Req 3.2).
   *
   * Finds worktrees in 'created' or 'active' status that are older than
   * `abandonedThresholdMs` and removes them.
   *
   * @returns Number of worktrees cleaned up
   */
  async cleanupAbandoned(): Promise<number> {
    if (!this.db) return 0;

    const cutoff = Date.now() - this.config.abandonedThresholdMs;

    const abandoned = this.db.prepare(
      `SELECT * FROM worktree_sessions 
       WHERE project_id = ? AND status IN ('created', 'active') AND created_at < ?`
    ).all(this.config.projectId, cutoff) as WorktreeSessionRow[];

    let cleaned = 0;
    for (const row of abandoned) {
      try {
        await this.remove(row.id);
        this.updateStatus(row.id, 'discarded');
        this.updateCompletedAt(row.id, Date.now());
        cleaned++;
      } catch {
        // Best-effort cleanup — log but continue
      }
    }

    return cleaned;
  }

  /**
   * Start periodic cleanup of abandoned worktrees.
   * Runs every hour to check for abandoned worktrees.
   */
  startPeriodicCleanup(): void {
    if (this.cleanupTimer) return;

    const ONE_HOUR = 60 * 60 * 1000;
    this.cleanupTimer = setInterval(() => {
      this.cleanupAbandoned().catch(() => {
        // Silently ignore cleanup errors
      });
    }, ONE_HOUR);

    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop periodic cleanup.
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Clean up resources */
  dispose(): void {
    this.stopPeriodicCleanup();
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Generate a short task hash from the task description (Req 3.1).
   * Uses first 8 chars of SHA-256 for a compact unique identifier.
   */
  private generateTaskHash(taskDescription: string): string {
    return createHash('sha256')
      .update(taskDescription)
      .digest('hex')
      .slice(0, 8);
  }

  /**
   * Copy environment files into the new worktree (Req 3.4).
   */
  private async copyEnvFiles(worktreePath: string): Promise<void> {
    for (const envFile of this.config.envFiles) {
      const sourcePath = join(this.config.projectDir, envFile);
      const destPath = join(worktreePath, envFile);

      try {
        await access(sourcePath);
        await copyFile(sourcePath, destPath);
      } catch {
        // File doesn't exist in source — skip silently
      }
    }
  }

  /**
   * Symlink node_modules from the project root into the worktree (Req 3.4).
   */
  private async symlinkNodeModules(worktreePath: string): Promise<void> {
    const sourceModules = join(this.config.projectDir, 'node_modules');
    const destModules = join(worktreePath, 'node_modules');

    try {
      await access(sourceModules);
      await symlink(sourceModules, destModules, 'junction');
    } catch {
      // node_modules doesn't exist or symlink failed — skip silently
    }
  }

  /**
   * Ensure the worktree_sessions table exists in the database (Req 3.5).
   */
  private ensureTable(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        diff_stats TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ws_project_status 
        ON worktree_sessions(project_id, status);
    `);
  }

  /**
   * Persist a worktree session to SQLite (Req 3.5).
   */
  private persistSession(session: WorktreeSession): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO worktree_sessions (id, project_id, session_id, agent_id, branch_name, worktree_path, status, diff_stats, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.projectId,
      session.sessionId,
      session.agentId,
      session.branchName,
      session.worktreePath,
      session.status,
      session.diffStats ? JSON.stringify(session.diffStats) : null,
      session.createdAt,
      session.completedAt
    );
  }

  /**
   * Update the status of a worktree session (Req 3.5).
   */
  private updateStatus(worktreeId: string, status: WorktreeStatus): WorktreeSession | null {
    if (!this.db) return null;

    this.db.prepare(
      'UPDATE worktree_sessions SET status = ? WHERE id = ?'
    ).run(status, worktreeId);

    return this.getSession(worktreeId);
  }

  /**
   * Update the diff stats of a worktree session.
   */
  private updateDiffStats(worktreeId: string, diffStats: WorktreeDiffStats): void {
    if (!this.db) return;

    this.db.prepare(
      'UPDATE worktree_sessions SET diff_stats = ? WHERE id = ?'
    ).run(JSON.stringify(diffStats), worktreeId);
  }

  /**
   * Update the completed_at timestamp of a worktree session.
   */
  private updateCompletedAt(worktreeId: string, timestamp: number): void {
    if (!this.db) return;

    this.db.prepare(
      'UPDATE worktree_sessions SET completed_at = ? WHERE id = ?'
    ).run(timestamp, worktreeId);
  }

  /**
   * Convert a database row to a WorktreeSession object.
   */
  private rowToSession(row: WorktreeSessionRow): WorktreeSession {
    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      branchName: row.branch_name,
      worktreePath: row.worktree_path,
      status: row.status as WorktreeStatus,
      diffStats: row.diff_stats ? JSON.parse(row.diff_stats) : null,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────

/** Interface for feature gate dependency injection */
export interface FeatureGateCheck {
  isEnabled(feature: string): boolean;
}

/**
 * Factory function to create a WorktreeManager for use in the pipeline.
 *
 * Checks the `worktree_agent_manager` feature flag (which requires `worktree_isolation`)
 * and configures the manager with the provided database and project info.
 *
 * @param featureGate - Feature gate system to check flag
 * @param db - SQLite database instance
 * @param projectDir - The project root directory
 * @param projectId - The project identifier
 * @param config - Optional configuration overrides
 * @returns A configured WorktreeManager, or null if the feature is disabled
 */
export function createWorktreeManager(
  featureGate: FeatureGateCheck | null,
  db: Database.Database | null,
  projectDir: string,
  projectId: string,
  config?: Partial<Omit<WorktreeManagerConfig, 'projectDir' | 'projectId'>>,
): WorktreeManager | null {
  const isEnabled = featureGate?.isEnabled('worktree_agent_manager') ?? false;

  if (!isEnabled) {
    return null;
  }

  const fullConfig: WorktreeManagerConfig = {
    ...DEFAULT_WORKTREE_CONFIG,
    ...config,
    projectDir,
    projectId,
  };

  const manager = WorktreeManager.getInstance(fullConfig);

  if (db) {
    manager.setDatabase(db);
  }

  manager.startPeriodicCleanup();
  return manager;
}
