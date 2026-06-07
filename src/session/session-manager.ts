import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { exportSession, importSession } from '../serializers/session.js';
import type { Session, Message } from '../shared/types.js';

// ─── Session Manager Types ─────────────────────────────────────

export interface SessionConfig {
  name: string;
  projectDir?: string;
  agentTemplates?: string[];
}

export interface SessionSummary {
  id: string;
  name: string;
  projectDir?: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export interface SessionFilter {
  projectDir?: string;
  since?: Date;
  until?: Date;
}

// ─── SessionManager ────────────────────────────────────────────

export class SessionManager {
  constructor(private db: Database.Database) {}

  /**
   * Create a new session and persist it to SQLite.
   * Requirements: 11.1
   */
  create(config: SessionConfig): Session {
    const id = randomUUID();
    const now = new Date();

    this.db
      .prepare(
        'INSERT INTO sessions (id, name, project_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, config.name, config.projectDir ?? null, now.toISOString(), now.toISOString());

    return {
      id,
      name: config.name,
      projectDir: config.projectDir,
      messages: [],
      activeAgentIds: config.agentTemplates ?? [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Open an existing session by ID, loading all messages.
   * Requirements: 11.2
   */
  async open(sessionId: string): Promise<Session> {
    const row = this.db
      .prepare('SELECT id, name, project_dir, created_at, updated_at FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { id: string; name: string; project_dir: string | null; created_at: string; updated_at: string }
      | undefined;

    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messageRows = this.db
      .prepare(
        'SELECT id, session_id, role, content, tool_calls, token_usage, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      )
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      role: string;
      content: string;
      tool_calls: string | null;
      token_usage: string | null;
      created_at: string;
    }>;

    const messages: Message[] = messageRows.map((m) => ({
      id: m.id,
      sessionId: m.session_id,
      role: m.role as Message['role'],
      content: m.content,
      toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
      tokenUsage: m.token_usage ? JSON.parse(m.token_usage) : undefined,
      createdAt: new Date(m.created_at),
    }));

    return {
      id: row.id,
      name: row.name,
      projectDir: row.project_dir ?? undefined,
      messages,
      activeAgentIds: [],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Rename a session.
   * Requirements: 11.1
   */
  rename(sessionId: string, name: string): void {
    const result = this.db
      .prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, new Date().toISOString(), sessionId);

    if (result.changes === 0) {
      throw new Error(`Session not found: ${sessionId}`);
    }
  }

  /**
   * Delete a session and its messages (CASCADE).
   * Requirements: 11.1
   */
  delete(sessionId: string): void {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    if (result.changes === 0) {
      throw new Error(`Session not found: ${sessionId}`);
    }
  }

  /**
   * List sessions with optional filtering by projectDir and date range.
   * Requirements: 11.5
   */
  list(filter?: SessionFilter): SessionSummary[] {
    let sql =
      'SELECT s.id, s.name, s.project_dir, s.created_at, s.updated_at, COUNT(m.id) as message_count FROM sessions s LEFT JOIN messages m ON s.id = m.session_id';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.projectDir) {
      conditions.push('s.project_dir = ?');
      params.push(filter.projectDir);
    }
    if (filter?.since) {
      conditions.push('s.created_at >= ?');
      params.push(filter.since.toISOString());
    }
    if (filter?.until) {
      conditions.push('s.created_at <= ?');
      params.push(filter.until.toISOString());
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' GROUP BY s.id ORDER BY s.updated_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      name: string;
      project_dir: string | null;
      created_at: string;
      updated_at: string;
      message_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      projectDir: r.project_dir ?? undefined,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      messageCount: r.message_count,
    }));
  }

  /**
   * Search sessions by keyword across session name and message content.
   * Requirements: 11.5
   */
  search(query: string): SessionSummary[] {
    const likeQuery = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.id, s.name, s.project_dir, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
         FROM sessions s
         LEFT JOIN messages m ON s.id = m.session_id
         WHERE s.name LIKE ? OR m.content LIKE ?
         ORDER BY s.updated_at DESC`,
      )
      .all(likeQuery, likeQuery) as Array<{
      id: string;
      name: string;
      project_dir: string | null;
      created_at: string;
      updated_at: string;
      message_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      projectDir: r.project_dir ?? undefined,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      messageCount: r.message_count,
    }));
  }

  /**
   * Export a session as a tar.gz archive buffer.
   * Requirements: 11.3, 11.9
   */
  async exportSession(sessionId: string): Promise<Buffer> {
    const session = await this.open(sessionId);
    return exportSession(session);
  }

  /**
   * Import a session from a tar.gz archive buffer and persist it.
   * Requirements: 11.3, 11.9
   */
  async importSession(archive: Buffer): Promise<Session> {
    const session = await importSession(archive);

    // Persist the imported session
    this.db
      .prepare(
        'INSERT OR REPLACE INTO sessions (id, name, project_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        session.id,
        session.name,
        session.projectDir ?? null,
        session.createdAt.toISOString(),
        session.updatedAt.toISOString(),
      );

    // Persist messages
    const insertMsg = this.db.prepare(
      'INSERT OR REPLACE INTO messages (id, session_id, role, content, tool_calls, token_usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    const insertAll = this.db.transaction((messages: Message[]) => {
      for (const m of messages) {
        insertMsg.run(
          m.id,
          m.sessionId,
          m.role,
          m.content,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.tokenUsage ? JSON.stringify(m.tokenUsage) : null,
          m.createdAt.toISOString(),
        );
      }
    });

    insertAll(session.messages);
    return session;
  }
}
