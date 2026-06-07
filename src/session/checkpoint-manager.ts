/**
 * Continuous Checkpoint / Crash Recovery — gstack-inspired session persistence.
 *
 * Auto-saves agent conversation state and decisions to SQLite every 30 seconds.
 * On restart, offers to resume where the agent left off.
 * Stores: decisions made, remaining work, failed approaches.
 */

export interface Checkpoint {
  id: string;
  sessionId: string;
  projectId: string;
  timestamp: number;
  state: CheckpointState;
}

export interface CheckpointState {
  lastMessage: string;
  decisions: string[];
  remainingWork: string[];
  failedApproaches: string[];
  activeAgents: string[];
  contextSummary: string;
  messageCount: number;
}

export class CheckpointManager {
  private db: any;
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null;
  private currentState: CheckpointState | null = null;
  private sessionId: string | null = null;
  private projectId: string | null = null;
  private dirty: boolean = false;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Keep only last 50 checkpoints per session
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, timestamp DESC)
      `);
    } catch (e) {
      console.warn('[CheckpointManager] Table creation failed:', e);
    }
  }

  /**
   * Start auto-saving for a session.
   */
  startAutoSave(sessionId: string, projectId: string, intervalMs: number = 30000): void {
    this.stopAutoSave();
    this.sessionId = sessionId;
    this.projectId = projectId;
    this.currentState = {
      lastMessage: '',
      decisions: [],
      remainingWork: [],
      failedApproaches: [],
      activeAgents: [],
      contextSummary: '',
      messageCount: 0,
    };

    this.autoSaveInterval = setInterval(() => {
      if (this.dirty) {
        this.save();
        this.dirty = false;
      }
    }, intervalMs);
  }

  /**
   * Stop auto-saving.
   */
  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
    // Final save
    if (this.dirty) {
      this.save();
      this.dirty = false;
    }
  }

  /**
   * Update the current state (called by the pipeline as things happen).
   */
  updateState(updates: Partial<CheckpointState>): void {
    if (!this.currentState) return;
    Object.assign(this.currentState, updates);
    this.dirty = true;
  }

  /**
   * Record a decision made during the session.
   */
  recordDecision(decision: string): void {
    if (!this.currentState) return;
    this.currentState.decisions.push(decision);
    if (this.currentState.decisions.length > 20) {
      this.currentState.decisions = this.currentState.decisions.slice(-20);
    }
    this.dirty = true;
  }

  /**
   * Record a failed approach.
   */
  recordFailedApproach(approach: string): void {
    if (!this.currentState) return;
    this.currentState.failedApproaches.push(approach);
    if (this.currentState.failedApproaches.length > 10) {
      this.currentState.failedApproaches = this.currentState.failedApproaches.slice(-10);
    }
    this.dirty = true;
  }

  /**
   * Save current state to SQLite.
   */
  private save(): void {
    if (!this.sessionId || !this.projectId || !this.currentState) return;

    try {
      const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      this.db.prepare(
        'INSERT INTO checkpoints (id, session_id, project_id, timestamp, state_json) VALUES (?, ?, ?, ?, ?)'
      ).run(id, this.sessionId, this.projectId, Date.now(), JSON.stringify(this.currentState));

      // Prune old checkpoints (keep last 50 per session)
      this.db.prepare(
        'DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (SELECT id FROM checkpoints WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50)'
      ).run(this.sessionId, this.sessionId);
    } catch (e) {
      console.warn('[CheckpointManager] Save failed:', e);
    }
  }

  /**
   * Get the latest checkpoint for a session.
   */
  getLatestCheckpoint(sessionId: string): Checkpoint | null {
    try {
      const row = this.db.prepare(
        'SELECT id, session_id, project_id, timestamp, state_json FROM checkpoints WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1'
      ).get(sessionId) as any;

      if (!row) return null;

      return {
        id: row.id,
        sessionId: row.session_id,
        projectId: row.project_id,
        timestamp: row.timestamp,
        state: JSON.parse(row.state_json),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get all checkpoints for a project (most recent first).
   */
  getProjectCheckpoints(projectId: string, limit: number = 10): Checkpoint[] {
    try {
      const rows = this.db.prepare(
        'SELECT id, session_id, project_id, timestamp, state_json FROM checkpoints WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?'
      ).all(projectId, limit) as any[];

      return rows.map(row => ({
        id: row.id,
        sessionId: row.session_id,
        projectId: row.project_id,
        timestamp: row.timestamp,
        state: JSON.parse(row.state_json),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Check if there's a recoverable session for a project.
   */
  hasRecoverableSession(projectId: string): boolean {
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) as count FROM checkpoints WHERE project_id = ? AND timestamp > ?'
      ).get(projectId, Date.now() - 24 * 60 * 60 * 1000) as any; // Last 24 hours
      return row && row.count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clear all checkpoints for a session.
   */
  clearSession(sessionId: string): void {
    try {
      this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
    } catch {}
  }
}
