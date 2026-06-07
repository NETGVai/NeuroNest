/**
 * Prompt Rewind Manager — Workspace checkpoint and undo system.
 *
 * Creates workspace checkpoints before each prompt execution and restores
 * workspace state on undo. Integrates with existing WorkspaceCheckpointManager
 * for file state management and CheckpointManager for recording rewind decisions.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.9, 8.10
 */

import type Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventBus } from '../events/event-bus.js';
import { WorkspaceCheckpointManager } from './workspace-checkpoint.js';
import { CheckpointManager } from './checkpoint-manager.js';
import { logger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface RewindCheckpoint {
  id: string;
  sessionId: string;
  promptText: string;
  timestamp: number;
  gitHead?: string;
  snapshotId: string;
}

export interface RewindResult {
  success: boolean;
  checkpointId: string;
  filesRestored: number;
  gitReset: boolean;
  errors: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_CHECKPOINT_DEPTH = 50;
const DEFAULT_RETENTION_HOURS = 24;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface PromptRewindManagerOptions {
  db: Database.Database;
  eventBus?: EventBus;
  workspaceCheckpointManager?: WorkspaceCheckpointManager;
  checkpointManager?: CheckpointManager;
}

// ─── PromptRewindManager Implementation ──────────────────────────────────────

/**
 * Manages workspace checkpoints for prompt-level undo/rewind operations.
 * Maintains a stack of checkpoints per session (max 50), integrates with
 * WorkspaceCheckpointManager for file snapshots and CheckpointManager for
 * recording rewind decisions.
 */
export class PromptRewindManager {
  private db: Database.Database;
  private eventBus?: EventBus;
  private workspaceCheckpointManager?: WorkspaceCheckpointManager;
  private checkpointManager?: CheckpointManager;

  // Prepared statements
  private stmtInsertCheckpoint!: Database.Statement;
  private stmtGetSessionCheckpoints!: Database.Statement;
  private stmtGetCheckpointById!: Database.Statement;
  private stmtDeleteCheckpoint!: Database.Statement;
  private stmtCountSessionCheckpoints!: Database.Statement;
  private stmtGetOldestCheckpoint!: Database.Statement;
  private stmtDeleteExpired!: Database.Statement;
  private stmtGetExpiredIds!: Database.Statement;

  constructor(options: PromptRewindManagerOptions) {
    this.db = options.db;
    this.eventBus = options.eventBus;
    this.workspaceCheckpointManager = options.workspaceCheckpointManager;
    this.checkpointManager = options.checkpointManager;

    this.ensureTable();
    this.initializePreparedStatements();
  }

  /**
   * Create a checkpoint before prompt execution.
   * Captures the current state of all project files and git HEAD reference.
   */
  createCheckpoint(sessionId: string, projectPath: string, promptText: string): string {
    const checkpointId = `rwcp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const timestamp = Date.now();

    // Capture git HEAD if available
    const gitHead = this.getGitHead(projectPath);

    // Take workspace snapshot using WorkspaceCheckpointManager
    let snapshotId: string;
    if (this.workspaceCheckpointManager) {
      const snapshot = this.workspaceCheckpointManager.takeSnapshot(
        projectPath,
        projectPath,
        `rewind-checkpoint-${checkpointId}`,
        undefined,
        `Checkpoint before prompt: ${promptText.slice(0, 100)}`
      );
      snapshotId = snapshot.id;
    } else {
      // Fallback: create a minimal snapshot reference
      snapshotId = `snap_fallback_${randomUUID().slice(0, 8)}`;
    }

    // Enforce max depth: discard oldest if at limit
    this.enforceMaxDepth(sessionId);

    // Persist checkpoint to SQLite
    try {
      this.stmtInsertCheckpoint.run(
        checkpointId,
        sessionId,
        promptText,
        timestamp,
        gitHead || null,
        snapshotId,
        new Date().toISOString()
      );
    } catch (err) {
      logger.error('Failed to persist rewind checkpoint', {
        checkpointId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit checkpoint creation event
    this.emitEvent('guardrail.rewind.checkpoint-created', {
      checkpointId,
      sessionId,
      timestamp,
      snapshotId,
    });

    logger.debug('Rewind checkpoint created', {
      checkpointId,
      sessionId,
      gitHead,
      snapshotId,
    });

    return checkpointId;
  }

  /**
   * Rewind to the most recent checkpoint for a session.
   */
  rewind(sessionId: string, projectPath: string): RewindResult {
    const checkpoints = this.getCheckpoints(sessionId);

    if (checkpoints.length === 0) {
      const result: RewindResult = {
        success: false,
        checkpointId: '',
        filesRestored: 0,
        gitReset: false,
        errors: ['No checkpoints available to rewind. Checkpoint stack is empty.'],
      };

      this.emitEvent('guardrail.rewind.failed', {
        sessionId,
        reason: 'empty_stack',
      });

      return result;
    }

    // Get the most recent checkpoint (first in the list, ordered by timestamp DESC)
    const latestCheckpoint = checkpoints[0];
    return this.rewindTo(latestCheckpoint.id, projectPath);
  }

  /**
   * Rewind to a specific checkpoint by ID.
   */
  rewindTo(checkpointId: string, projectPath: string): RewindResult {
    // Emit rewind initiation event
    this.emitEvent('guardrail.rewind.initiated', {
      checkpointId,
      projectPath,
    });

    const checkpoint = this.getCheckpointById(checkpointId);

    if (!checkpoint) {
      const result: RewindResult = {
        success: false,
        checkpointId,
        filesRestored: 0,
        gitReset: false,
        errors: [`Checkpoint not found: ${checkpointId}`],
      };

      this.emitEvent('guardrail.rewind.failed', {
        checkpointId,
        reason: 'checkpoint_not_found',
      });

      return result;
    }

    const errors: string[] = [];
    let filesRestored = 0;
    let gitReset = false;

    // Restore workspace files using WorkspaceCheckpointManager
    if (this.workspaceCheckpointManager) {
      const restoreResult = this.workspaceCheckpointManager.restore(
        checkpoint.snapshotId,
        projectPath
      );

      if (restoreResult.success) {
        filesRestored = restoreResult.filesRestored;
      } else {
        errors.push(`File restore failed: ${restoreResult.error || 'Unknown error'}`);
        if (restoreResult.filesRestored > 0) {
          filesRestored = restoreResult.filesRestored;
          errors.push(`Partial restore: ${restoreResult.filesRestored} files restored before failure`);
        }
      }
    } else {
      errors.push('WorkspaceCheckpointManager not available for file restoration');
    }

    // Reset git state if git HEAD was captured
    if (checkpoint.gitHead) {
      try {
        this.resetGitState(projectPath, checkpoint.gitHead);
        gitReset = true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Git reset failed: ${errorMsg}`);
      }
    }

    // Record rewind decision in CheckpointManager
    if (this.checkpointManager) {
      this.checkpointManager.recordDecision(
        `Rewind to checkpoint ${checkpointId} (prompt: "${checkpoint.promptText.slice(0, 50)}")`
      );
    }

    // Remove the checkpoint and all newer checkpoints from the stack
    this.removeCheckpointAndNewer(checkpoint.sessionId, checkpoint.timestamp);

    const success = errors.length === 0;
    const result: RewindResult = {
      success,
      checkpointId,
      filesRestored,
      gitReset,
      errors,
    };

    // Emit completion/failure event
    if (success) {
      this.emitEvent('guardrail.rewind.completed', {
        checkpointId,
        filesRestored,
        gitReset,
      });
    } else {
      this.emitEvent('guardrail.rewind.completed-with-errors', {
        checkpointId,
        filesRestored,
        gitReset,
        errors,
      });
    }

    logger.info('Rewind operation completed', {
      checkpointId,
      success,
      filesRestored,
      gitReset,
      errorCount: errors.length,
    });

    return result;
  }

  /**
   * Get checkpoint stack for a session (ordered by timestamp DESC — most recent first).
   */
  getCheckpoints(sessionId: string): RewindCheckpoint[] {
    try {
      const rows = this.stmtGetSessionCheckpoints.all(sessionId) as any[];
      return rows.map(this.rowToCheckpoint);
    } catch (err) {
      logger.error('Failed to get checkpoints', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Clean up expired checkpoints.
   * Deletes checkpoints older than the specified retention period.
   * Returns the number of checkpoints deleted.
   */
  pruneExpired(retentionHours: number = DEFAULT_RETENTION_HOURS): number {
    const cutoffTimestamp = Date.now() - (retentionHours * 3600 * 1000);

    try {
      // Get IDs of expired checkpoints to clean up their snapshots
      const expiredRows = this.stmtGetExpiredIds.all(cutoffTimestamp) as any[];

      // Delete associated workspace snapshots
      if (this.workspaceCheckpointManager) {
        for (const row of expiredRows) {
          try {
            this.workspaceCheckpointManager.deleteSnapshot(row.snapshot_id);
          } catch {
            // Best effort cleanup of snapshot files
          }
        }
      }

      // Delete expired checkpoints from DB
      const result = this.stmtDeleteExpired.run(cutoffTimestamp);
      const deletedCount = result.changes;

      if (deletedCount > 0) {
        logger.info('Pruned expired rewind checkpoints', {
          deletedCount,
          retentionHours,
          cutoffTimestamp,
        });
      }

      return deletedCount;
    } catch (err) {
      logger.error('Failed to prune expired checkpoints', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rewind_checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          prompt_text TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          git_head TEXT,
          snapshot_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_rc_session ON rewind_checkpoints(session_id, timestamp DESC)
      `);
    } catch (e) {
      logger.warn('[PromptRewindManager] Table creation failed:', { error: e });
    }
  }

  private initializePreparedStatements(): void {
    this.stmtInsertCheckpoint = this.db.prepare(`
      INSERT INTO rewind_checkpoints (id, session_id, prompt_text, timestamp, git_head, snapshot_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetSessionCheckpoints = this.db.prepare(`
      SELECT id, session_id, prompt_text, timestamp, git_head, snapshot_id, created_at
      FROM rewind_checkpoints
      WHERE session_id = ?
      ORDER BY timestamp DESC
    `);

    this.stmtGetCheckpointById = this.db.prepare(`
      SELECT id, session_id, prompt_text, timestamp, git_head, snapshot_id, created_at
      FROM rewind_checkpoints
      WHERE id = ?
    `);

    this.stmtDeleteCheckpoint = this.db.prepare(`
      DELETE FROM rewind_checkpoints WHERE id = ?
    `);

    this.stmtCountSessionCheckpoints = this.db.prepare(`
      SELECT COUNT(*) as count FROM rewind_checkpoints WHERE session_id = ?
    `);

    this.stmtGetOldestCheckpoint = this.db.prepare(`
      SELECT id, snapshot_id FROM rewind_checkpoints
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT 1
    `);

    this.stmtDeleteExpired = this.db.prepare(`
      DELETE FROM rewind_checkpoints WHERE timestamp < ?
    `);

    this.stmtGetExpiredIds = this.db.prepare(`
      SELECT id, snapshot_id FROM rewind_checkpoints WHERE timestamp < ?
    `);
  }

  /**
   * Enforce max checkpoint depth per session.
   * Discards the oldest checkpoint when the limit is exceeded.
   */
  private enforceMaxDepth(sessionId: string): void {
    try {
      const row = this.stmtCountSessionCheckpoints.get(sessionId) as any;
      const count = row?.count ?? 0;

      if (count >= MAX_CHECKPOINT_DEPTH) {
        const oldest = this.stmtGetOldestCheckpoint.get(sessionId) as any;
        if (oldest) {
          // Delete the associated workspace snapshot
          if (this.workspaceCheckpointManager) {
            try {
              this.workspaceCheckpointManager.deleteSnapshot(oldest.snapshot_id);
            } catch {
              // Best effort cleanup
            }
          }
          // Delete the oldest checkpoint
          this.stmtDeleteCheckpoint.run(oldest.id);
        }
      }
    } catch (err) {
      logger.warn('Failed to enforce max checkpoint depth', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get the current git HEAD reference for a project path.
   * Returns undefined if not a git repo or git is unavailable.
   */
  private getGitHead(projectPath: string): string | undefined {
    try {
      const head = execSync('git rev-parse HEAD', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      return head || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reset git working tree and HEAD to a specific commit.
   */
  private resetGitState(projectPath: string, gitHead: string): void {
    execSync(`git reset --hard ${gitHead}`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  }

  /**
   * Get a checkpoint by its ID.
   */
  private getCheckpointById(checkpointId: string): RewindCheckpoint | null {
    try {
      const row = this.stmtGetCheckpointById.get(checkpointId) as any;
      if (!row) return null;
      return this.rowToCheckpoint(row);
    } catch {
      return null;
    }
  }

  /**
   * Remove a checkpoint and all newer checkpoints from the stack.
   * When rewinding to a checkpoint, all checkpoints created after it are discarded.
   */
  private removeCheckpointAndNewer(sessionId: string, timestamp: number): void {
    try {
      // Get all checkpoints at or after this timestamp to clean up snapshots
      const rows = this.db.prepare(
        'SELECT id, snapshot_id FROM rewind_checkpoints WHERE session_id = ? AND timestamp >= ?'
      ).all(sessionId, timestamp) as any[];

      // Delete associated workspace snapshots
      if (this.workspaceCheckpointManager) {
        for (const row of rows) {
          try {
            this.workspaceCheckpointManager.deleteSnapshot(row.snapshot_id);
          } catch {
            // Best effort cleanup
          }
        }
      }

      // Delete the checkpoints
      this.db.prepare(
        'DELETE FROM rewind_checkpoints WHERE session_id = ? AND timestamp >= ?'
      ).run(sessionId, timestamp);
    } catch (err) {
      logger.warn('Failed to remove checkpoint and newer entries', {
        sessionId,
        timestamp,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Convert a database row to a RewindCheckpoint object.
   */
  private rowToCheckpoint(row: any): RewindCheckpoint {
    return {
      id: row.id,
      sessionId: row.session_id,
      promptText: row.prompt_text,
      timestamp: row.timestamp,
      gitHead: row.git_head || undefined,
      snapshotId: row.snapshot_id,
    };
  }

  /**
   * Emit an event on the EventBus.
   */
  private emitEvent(topic: string, data: Record<string, any>): void {
    if (!this.eventBus) return;

    this.eventBus.publish(topic, {
      type: topic.split('.').pop() || topic,
      data: {
        ...data,
        timestamp: Date.now(),
      },
    }).catch((err) => {
      logger.error('Failed to emit rewind event', {
        topic,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
