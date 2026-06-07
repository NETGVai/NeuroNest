/**
 * Workspace Checkpoints — Full workspace snapshots with compare & restore.
 *
 * Takes a snapshot of the project directory at each significant step.
 * Users can compare any snapshot against current state and restore.
 *
 * Pipeline_Event emission (12-factor-agent-improvements task 15):
 *   - `takeSnapshot` → `checkpoint.created` { checkpointId, ref, turnId? }
 *   - `restore`      → `checkpoint.restored` { checkpointId, turnId }
 *
 * Both emits are gated on `PERF_FLAGS.UNIFIED_EVENT_LOG ||
 * PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW` and are fail-soft: a logging
 * regression cannot tear down a snapshot or restore call. The EventLog
 * and the per-call `sessionId` (and optional `turnId`) are injected via
 * the constructor so this file stays free of any IPC / database-singleton
 * import that would form a cycle.
 *
 * Audit (per task 15 second checklist item — "audit for any code paths
 * that write `refs/neuronest/turn/*` directly without going through the
 * manager"):
 *   - Codebase grep for `refs/neuronest` and for `git update-ref` against
 *     a `refs/neuronest/...` path returns ZERO matches outside of the spec
 *     documents themselves. The spec's `refs/neuronest/turn/*` ref space
 *     is forward-looking and is reserved for the Dual_Write_Reconciler
 *     (task 28) to enumerate when it lands. Today the manager stores
 *     snapshots under `~/.neuronest/snapshots/<id>` (not git refs), so
 *     there is nothing to migrate. New callers that begin writing
 *     `refs/neuronest/turn/*` MUST route through this manager so the
 *     `checkpoint.created` Pipeline_Event lands automatically.
 *
 * Validates: Requirements 2.8
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  emitCheckpointCreated,
  emitCheckpointRestored,
  type EventLogEmitter,
} from './checkpoint-event-emitter.js';

export interface WorkspaceSnapshot {
  id: string;
  projectId: string;
  label: string;
  files: Array<{ path: string; hash: string; size: number }>;
  timestamp: number;
  agentId?: string;
  stepDescription?: string;
}

export interface FileDiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'unchanged';
  oldHash?: string;
  newHash?: string;
}

/**
 * Optional per-call correlation supplied by callers that have a session
 * id (and possibly a turn id) on hand. Both fields are optional — the
 * manager works exactly as before when neither is provided; the only
 * difference is that the corresponding Pipeline_Event is skipped.
 */
export interface CheckpointEmitContext {
  /** Active pipeline session id. Required for Pipeline_Event emission. */
  sessionId?: string;
  /** Turn correlation id (optional even on `restored` per the helper). */
  turnId?: string;
}

/**
 * Optional dependencies surfaced as a constructor option object. Kept
 * additive so existing callers that pass only `db` continue to compile.
 */
export interface WorkspaceCheckpointManagerOptions {
  /**
   * EventLog the manager should emit Pipeline_Events through. Pass the
   * main-process singleton (or any structural emitter) here. Omit for
   * test/CLI contexts that don't care about the event log.
   */
  eventLog?: EventLogEmitter | null;
}

export class WorkspaceCheckpointManager {
  private db: any;
  private snapshotDir: string;
  private eventLog: EventLogEmitter | null;

  constructor(db: any, options: WorkspaceCheckpointManagerOptions = {}) {
    this.db = db;
    this.eventLog = options.eventLog ?? null;
    const os = require('node:os');
    this.snapshotDir = path.join(os.homedir(), '.neuronest', 'snapshots');
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    this.ensureTable();
  }

  /**
   * Late-bind an EventLog. Useful for the IPC layer which constructs the
   * manager inline before the EventLog singleton has been resolved.
   * Passing `null` disables emission.
   */
  setEventLog(log: EventLogEmitter | null): void {
    this.eventLog = log;
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_snapshots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          label TEXT NOT NULL,
          files_json TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          agent_id TEXT,
          step_description TEXT
        )
      `);
    } catch (e) { console.warn('[WorkspaceCheckpoint] Table creation failed:', e); }
  }

  /**
   * Take a snapshot of the current project state.
   *
   * When the optional `emitCtx.sessionId` is supplied, a
   * `checkpoint.created` Pipeline_Event is emitted with payload
   * `{ checkpointId, ref, turnId? }`. Emission is gated by
   * `PERF_FLAGS.UNIFIED_EVENT_LOG || PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW`
   * inside the helper and is fail-soft — a logging regression cannot
   * tear down the snapshot path.
   */
  takeSnapshot(
    projectId: string,
    projectPath: string,
    label: string,
    agentId?: string,
    stepDescription?: string,
    emitCtx?: CheckpointEmitContext,
  ): WorkspaceSnapshot {
    const files = this.scanDirectory(projectPath);
    const snapshot: WorkspaceSnapshot = {
      id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId, label, files, timestamp: Date.now(), agentId, stepDescription,
    };

    // Save file contents to snapshot directory
    const snapDir = path.join(this.snapshotDir, snapshot.id);
    fs.mkdirSync(snapDir, { recursive: true });
    for (const file of files) {
      const srcPath = path.join(projectPath, file.path);
      const destPath = path.join(snapDir, file.path);
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      } catch { /* skip unreadable files */ }
    }

    // Save metadata to DB
    try {
      this.db.prepare(
        'INSERT INTO workspace_snapshots (id, project_id, label, files_json, timestamp, agent_id, step_description) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(snapshot.id, snapshot.projectId, snapshot.label, JSON.stringify(snapshot.files), snapshot.timestamp, agentId || null, stepDescription || null);
    } catch (e) { console.warn('[WorkspaceCheckpoint] Insert failed:', e); }

    // Emit checkpoint.created Pipeline_Event (task 15). The helper is
    // fail-soft and gating-aware; we still wrap defensively because a
    // failure on the logging path must never affect the returned
    // snapshot. `ref` is the snapshot id — see file header for the
    // mapping rationale.
    if (emitCtx && emitCtx.sessionId) {
      try {
        const createdInput: {
          sessionId: string;
          checkpointId: string;
          ref: string;
          turnId?: string;
        } = {
          sessionId: emitCtx.sessionId,
          checkpointId: snapshot.id,
          ref: snapshot.id,
        };
        if (typeof emitCtx.turnId === 'string' && emitCtx.turnId.length > 0) {
          createdInput.turnId = emitCtx.turnId;
        }
        emitCheckpointCreated(this.eventLog, createdInput);
      } catch (emitErr) {
        // The helper itself swallows; this catch is belt-and-braces in
        // case a future change introduces a synchronous throw.
        console.warn(
          '[WorkspaceCheckpoint] checkpoint.created emit threw:',
          (emitErr as Error)?.message,
        );
      }
    }

    return snapshot;
  }

  /**
   * Compare a snapshot against the current workspace.
   */
  compare(snapshotId: string, projectPath: string): FileDiffEntry[] {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) return [];

    const currentFiles = this.scanDirectory(projectPath);
    const diffs: FileDiffEntry[] = [];

    const snapshotMap = new Map(snapshot.files.map(f => [f.path, f.hash]));
    const currentMap = new Map(currentFiles.map(f => [f.path, f.hash]));

    // Check for modified and deleted files
    for (const [filePath, oldHash] of snapshotMap) {
      const newHash = currentMap.get(filePath);
      if (!newHash) {
        diffs.push({ path: filePath, status: 'deleted', oldHash });
      } else if (newHash !== oldHash) {
        diffs.push({ path: filePath, status: 'modified', oldHash, newHash });
      }
    }

    // Check for added files
    for (const [filePath] of currentMap) {
      if (!snapshotMap.has(filePath)) {
        diffs.push({ path: filePath, status: 'added', newHash: currentMap.get(filePath) });
      }
    }

    return diffs;
  }

  /**
   * Restore workspace to a snapshot state.
   *
   * When the optional `emitCtx.sessionId` is supplied AND the restore
   * succeeds at least partially, a `checkpoint.restored` Pipeline_Event
   * is emitted with payload `{ checkpointId, turnId? }`. The reducer
   * treats `checkpoint.restored` as a cache-invalidation signal
   * (Requirement 6.9), so we only emit on a successful restore — a
   * complete failure (`success: false, filesRestored: 0`) means no
   * workspace change happened and the cache should not be flushed.
   */
  restore(
    snapshotId: string,
    projectPath: string,
    emitCtx?: CheckpointEmitContext,
  ): { success: boolean; filesRestored: number; error?: string } {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) return { success: false, filesRestored: 0, error: 'Snapshot not found' };

    const snapDir = path.join(this.snapshotDir, snapshotId);
    if (!fs.existsSync(snapDir)) return { success: false, filesRestored: 0, error: 'Snapshot files not found' };

    let restored = 0;
    let result: { success: boolean; filesRestored: number; error?: string };
    try {
      for (const file of snapshot.files) {
        const srcPath = path.join(snapDir, file.path);
        const destPath = path.join(projectPath, file.path);
        if (fs.existsSync(srcPath)) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          restored++;
        }
      }
      result = { success: true, filesRestored: restored };
    } catch (e: any) {
      result = { success: false, filesRestored: restored, error: e.message };
    }

    // Emit checkpoint.restored only on a non-empty restore. A full
    // failure (filesRestored: 0) means workspace state is unchanged and
    // the reducer cache must not be invalidated.
    if (emitCtx && emitCtx.sessionId && restored > 0) {
      try {
        const restoredInput: {
          sessionId: string;
          checkpointId: string;
          turnId?: string;
        } = {
          sessionId: emitCtx.sessionId,
          checkpointId: snapshotId,
        };
        if (typeof emitCtx.turnId === 'string' && emitCtx.turnId.length > 0) {
          restoredInput.turnId = emitCtx.turnId;
        }
        emitCheckpointRestored(this.eventLog, restoredInput);
      } catch (emitErr) {
        console.warn(
          '[WorkspaceCheckpoint] checkpoint.restored emit threw:',
          (emitErr as Error)?.message,
        );
      }
    }

    return result;
  }

  /**
   * Get all snapshots for a project.
   */
  getSnapshots(projectId: string, limit: number = 20): WorkspaceSnapshot[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM workspace_snapshots WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?'
      ).all(projectId, limit) as any[];
      return rows.map((r: any) => ({
        id: r.id, projectId: r.project_id, label: r.label,
        files: JSON.parse(r.files_json), timestamp: r.timestamp,
        agentId: r.agent_id, stepDescription: r.step_description,
      }));
    } catch { return []; }
  }

  /**
   * Delete a snapshot.
   */
  deleteSnapshot(snapshotId: string): void {
    try {
      const snapDir = path.join(this.snapshotDir, snapshotId);
      if (fs.existsSync(snapDir)) fs.rmSync(snapDir, { recursive: true, force: true });
      this.db.prepare('DELETE FROM workspace_snapshots WHERE id = ?').run(snapshotId);
    } catch {}
  }

  // ─── Private ────────────────────────────────────────────

  private getSnapshot(id: string): WorkspaceSnapshot | null {
    try {
      const row = this.db.prepare('SELECT * FROM workspace_snapshots WHERE id = ?').get(id) as any;
      if (!row) return null;
      return {
        id: row.id, projectId: row.project_id, label: row.label,
        files: JSON.parse(row.files_json), timestamp: row.timestamp,
        agentId: row.agent_id, stepDescription: row.step_description,
      };
    } catch { return null; }
  }

  private scanDirectory(dirPath: string, basePath?: string): Array<{ path: string; hash: string; size: number }> {
    const base = basePath || dirPath;
    const files: Array<{ path: string; hash: string; size: number }> = [];
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.neuronest']);

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(base, fullPath);

        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) {
            files.push(...this.scanDirectory(fullPath, base));
          }
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 5 * 1024 * 1024) continue; // Skip files > 5MB
            const content = fs.readFileSync(fullPath);
            const hash = crypto.createHash('md5').update(content).digest('hex');
            files.push({ path: relPath, hash, size: stat.size });
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip unreadable dirs */ }

    return files;
  }
}
