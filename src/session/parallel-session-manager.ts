/**
 * Parallel Session Manager — manages multiple concurrent AI agent sessions.
 *
 * Each parallel session runs independently within a project, with its own
 * task, agent assignment, message history, and status lifecycle.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface ParallelSession {
  id: string;
  projectId: string;
  name: string;
  agentId?: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  task?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface ParallelMessage {
  id: string;
  parallelSessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  agent?: string;
  createdAt: string;
}

export class ParallelSessionManager {
  private stmtCreate: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtList: Database.Statement;
  private stmtUpdate: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtAddMsg: Database.Statement;
  private stmtGetMsgs: Database.Statement;
  private stmtMsgCount: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtCreate = db.prepare(
      'INSERT INTO parallel_sessions (id, project_id, name, agent_id, status, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.stmtGet = db.prepare('SELECT * FROM parallel_sessions WHERE id = ?');
    this.stmtList = db.prepare('SELECT * FROM parallel_sessions WHERE project_id = ? ORDER BY created_at DESC');
    this.stmtUpdate = db.prepare(
      'UPDATE parallel_sessions SET name = COALESCE(?, name), agent_id = COALESCE(?, agent_id), status = COALESCE(?, status), task = COALESCE(?, task), result = COALESCE(?, result), updated_at = ? WHERE id = ?'
    );
    this.stmtDelete = db.prepare('DELETE FROM parallel_sessions WHERE id = ?');
    this.stmtAddMsg = db.prepare(
      'INSERT INTO parallel_messages (id, parallel_session_id, role, content, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.stmtGetMsgs = db.prepare('SELECT * FROM parallel_messages WHERE parallel_session_id = ? ORDER BY created_at ASC');
    this.stmtMsgCount = db.prepare('SELECT COUNT(*) as c FROM parallel_messages WHERE parallel_session_id = ?');
  }

  create(opts: { projectId: string; name: string; agentId?: string; task?: string }): ParallelSession {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.stmtCreate.run(id, opts.projectId, opts.name, opts.agentId || null, 'idle', opts.task || null, now, now);
    return {
      id, projectId: opts.projectId, name: opts.name,
      agentId: opts.agentId, status: 'idle', task: opts.task,
      createdAt: now, updatedAt: now, messageCount: 0,
    };
  }

  get(id: string): ParallelSession | null {
    const row = this.stmtGet.get(id) as any;
    if (!row) return null;
    const count = (this.stmtMsgCount.get(id) as any)?.c || 0;
    return { ...this.mapRow(row), messageCount: count };
  }

  list(projectId: string): ParallelSession[] {
    return (this.stmtList.all(projectId) as any[]).map(r => {
      const count = (this.stmtMsgCount.get(r.id) as any)?.c || 0;
      return { ...this.mapRow(r), messageCount: count };
    });
  }

  update(id: string, updates: Partial<Pick<ParallelSession, 'name' | 'agentId' | 'status' | 'task' | 'result'>>): boolean {
    const now = new Date().toISOString();
    const result = this.stmtUpdate.run(
      updates.name || null, updates.agentId || null, updates.status || null,
      updates.task || null, updates.result || null, now, id
    );
    return result.changes > 0;
  }

  delete(id: string): boolean {
    return this.stmtDelete.run(id).changes > 0;
  }

  addMessage(sessionId: string, role: string, content: string, agent?: string): ParallelMessage {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.stmtAddMsg.run(id, sessionId, role, content, agent || null, now);
    // Touch the session's updated_at
    this.db.prepare('UPDATE parallel_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    return { id, parallelSessionId: sessionId, role: role as any, content, agent, createdAt: now };
  }

  getMessages(sessionId: string): ParallelMessage[] {
    return (this.stmtGetMsgs.all(sessionId) as any[]).map(r => ({
      id: r.id,
      parallelSessionId: r.parallel_session_id,
      role: r.role,
      content: r.content,
      agent: r.agent || undefined,
      createdAt: r.created_at,
    }));
  }

  getStats(projectId: string): { total: number; running: number; completed: number; failed: number } {
    const sessions = this.list(projectId);
    return {
      total: sessions.length,
      running: sessions.filter(s => s.status === 'running').length,
      completed: sessions.filter(s => s.status === 'completed').length,
      failed: sessions.filter(s => s.status === 'failed').length,
    };
  }

  private mapRow(row: any): ParallelSession {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      agentId: row.agent_id || undefined,
      status: row.status,
      task: row.task || undefined,
      result: row.result || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
