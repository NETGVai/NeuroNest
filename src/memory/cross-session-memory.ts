/**
 * Cross-Session Memory — captures and indexes key facts across sessions.
 *
 * Provides:
 *   - Automatic capture at session end (errors fixed, preferences learned, context discovered)
 *   - Explicit capture via `/remember` command
 *   - SQLite FTS5-based keyword search (embedding-free)
 *   - Project and session listing
 *
 * Requirements: 19.1, 19.2, 19.3
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export type MemoryEntryType =
  | 'error_fixed'
  | 'preference_learned'
  | 'context_discovered'
  | 'explicit_remember';

export interface MemoryEntry {
  id: string;
  sessionId: string;
  type: MemoryEntryType;
  content: string;
  tags: string[];
  createdAt: string;
  projectDir: string;
}

export interface SessionSummary {
  errorsFixed: string[];
  preferencesLearned: string[];
  contextDiscovered: string[];
}

export interface CaptureSessionEndOptions {
  sessionId: string;
  projectDir: string;
  summary: SessionSummary;
}

export interface SearchOptions {
  limit?: number;
}

// ─── Row shape from SQLite ──────────────────────────────────────

interface MemoryRow {
  id: string;
  session_id: string;
  type: MemoryEntryType;
  content: string;
  tags: string;
  created_at: string;
  project_dir: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function rowToEntry(row: MemoryRow): MemoryEntry {
  let tags: string[];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    content: row.content,
    tags,
    createdAt: row.created_at,
    projectDir: row.project_dir,
  };
}

// ─── CrossSessionMemory ─────────────────────────────────────────

export class CrossSessionMemory {
  private readonly db: Database.Database;

  // Prepared statements
  private readonly insertStmt: Database.Statement;
  private readonly searchStmt: Database.Statement;
  private readonly listByProjectStmt: Database.Statement;
  private readonly listBySessionStmt: Database.Statement;
  private readonly deleteByIdStmt: Database.Statement;
  private readonly purgeByProjectStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO cross_session_memory (id, session_id, type, content, tags, created_at, project_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.searchStmt = db.prepare(`
      SELECT csm.*
      FROM cross_session_memory csm
      JOIN cross_session_memory_fts fts ON csm.rowid = fts.rowid
      WHERE cross_session_memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.listByProjectStmt = db.prepare(`
      SELECT * FROM cross_session_memory WHERE project_dir = ? ORDER BY created_at DESC
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM cross_session_memory WHERE session_id = ? ORDER BY created_at DESC
    `);
    this.deleteByIdStmt = db.prepare(`
      DELETE FROM cross_session_memory WHERE id = ?
    `);
    this.purgeByProjectStmt = db.prepare(`
      DELETE FROM cross_session_memory WHERE project_dir = ?
    `);
  }

  /**
   * Capture key facts at session end.
   * Summarizes errors fixed, preferences learned, and context discovered.
   *
   * Requirement 19.2
   */
  captureSessionEnd(options: CaptureSessionEndOptions): MemoryEntry[] {
    const { sessionId, projectDir, summary } = options;
    const entries: MemoryEntry[] = [];

    for (const error of summary.errorsFixed) {
      if (error.trim()) {
        entries.push(this.insertEntry(sessionId, 'error_fixed', error, ['auto-capture'], projectDir));
      }
    }

    for (const pref of summary.preferencesLearned) {
      if (pref.trim()) {
        entries.push(this.insertEntry(sessionId, 'preference_learned', pref, ['auto-capture'], projectDir));
      }
    }

    for (const ctx of summary.contextDiscovered) {
      if (ctx.trim()) {
        entries.push(this.insertEntry(sessionId, 'context_discovered', ctx, ['auto-capture'], projectDir));
      }
    }

    return entries;
  }

  /**
   * Capture an explicit memory from `/remember` command.
   *
   * Requirement 19.2
   */
  captureExplicit(
    sessionId: string,
    content: string,
    projectDir: string,
    tags: string[] = [],
  ): MemoryEntry {
    return this.insertEntry(sessionId, 'explicit_remember', content, tags, projectDir);
  }

  /**
   * Search memories using FTS5 keyword search.
   * Uses SQLite FTS5 MATCH syntax for the query.
   *
   * Requirement 19.3
   */
  search(query: string, options?: SearchOptions): MemoryEntry[] {
    const limit = options?.limit ?? 20;

    if (!query.trim()) {
      return [];
    }

    // Sanitize query for FTS5: wrap terms for prefix matching
    const sanitizedQuery = this.sanitizeFtsQuery(query);

    try {
      const rows = this.searchStmt.all(sanitizedQuery, limit) as MemoryRow[];
      return rows.map(rowToEntry);
    } catch {
      // If FTS5 query syntax fails, fall back to LIKE search
      return this.fallbackSearch(query, limit);
    }
  }

  /**
   * List all memories for a given project directory.
   */
  listByProject(projectDir: string): MemoryEntry[] {
    const rows = this.listByProjectStmt.all(projectDir) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  /**
   * List all memories captured during a specific session.
   */
  listBySession(sessionId: string): MemoryEntry[] {
    const rows = this.listBySessionStmt.all(sessionId) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Delete a specific memory entry by ID.
   */
  delete(id: string): boolean {
    const result = this.deleteByIdStmt.run(id);
    return result.changes > 0;
  }

  /**
   * Purge all memories for a project.
   *
   * Requirement 19.1
   */
  purge(projectDir: string): number {
    const result = this.purgeByProjectStmt.run(projectDir);
    return result.changes;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private insertEntry(
    sessionId: string,
    type: MemoryEntryType,
    content: string,
    tags: string[],
    projectDir: string,
  ): MemoryEntry {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const tagsJson = JSON.stringify(tags);

    this.insertStmt.run(id, sessionId, type, content, tagsJson, createdAt, projectDir);

    return {
      id,
      sessionId,
      type,
      content,
      tags,
      createdAt,
      projectDir,
    };
  }

  /**
   * Sanitize a user query for FTS5.
   * Splits terms and wraps them with quotes for phrase matching,
   * or uses plain terms for keyword matching.
   */
  private sanitizeFtsQuery(query: string): string {
    // Split on whitespace, filter empty, join with AND-implicit FTS5 matching
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return '""';

    // For simple queries, just join with spaces (implicit AND in FTS5)
    // Escape any double quotes in terms
    return terms.map((t) => t.replace(/"/g, '""')).join(' ');
  }

  /**
   * Fallback search using LIKE when FTS5 query syntax fails.
   */
  private fallbackSearch(query: string, limit: number): MemoryEntry[] {
    const likePattern = `%${query}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM cross_session_memory
      WHERE content LIKE ? OR tags LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(likePattern, likePattern, limit) as MemoryRow[];
    return rows.map(rowToEntry);
  }
}

export default CrossSessionMemory;
