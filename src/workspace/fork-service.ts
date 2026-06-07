/**
 * Workspace Forking Service — Clone sessions with conversation history.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface WorkspaceFork {
  id: string; project_id: string; source_session_id: string; forked_session_id: string;
  fork_name: string; fork_branch: string | null; messages_copied: number;
  model_selection: string | null; created_at: string;
}

export class ForkService {
  constructor(private db: Database.Database) {}

  fork(projectId: string, data: { sourceSessionId: string; forkName: string; forkBranch?: string }): WorkspaceFork {
    const id = crypto.randomUUID();
    const forkedSessionId = crypto.randomUUID();
    // Copy messages from source session
    let messagesCopied = 0;
    try {
      const msgs = this.db.prepare('SELECT role, content, agent FROM messages WHERE session_id = ? ORDER BY created_at').all(data.sourceSessionId) as any[];
      for (const msg of msgs) {
        this.db.prepare('INSERT INTO messages (id, session_id, role, content, agent, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(crypto.randomUUID(), forkedSessionId, msg.role, msg.content, msg.agent);
        messagesCopied++;
      }
    } catch { /* messages table may not have these exact columns — best effort */ }

    this.db.prepare('INSERT INTO workspace_forks (id, project_id, source_session_id, forked_session_id, fork_name, fork_branch, messages_copied) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, projectId, data.sourceSessionId, forkedSessionId, data.forkName, data.forkBranch || null, messagesCopied);
    return this.db.prepare('SELECT * FROM workspace_forks WHERE id = ?').get(id) as WorkspaceFork;
  }

  list(projectId: string): WorkspaceFork[] {
    return this.db.prepare('SELECT * FROM workspace_forks WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as WorkspaceFork[];
  }

  get(forkId: string): WorkspaceFork | null {
    return this.db.prepare('SELECT * FROM workspace_forks WHERE id = ?').get(forkId) as WorkspaceFork | null;
  }

  delete(forkId: string): void {
    this.db.prepare('DELETE FROM workspace_forks WHERE id = ?').run(forkId);
  }

  getStats(projectId: string): { total: number; totalMessages: number } {
    const r = this.db.prepare('SELECT COUNT(*) as t, COALESCE(SUM(messages_copied),0) as m FROM workspace_forks WHERE project_id = ?').get(projectId) as any;
    return { total: r?.t || 0, totalMessages: r?.m || 0 };
  }
}
