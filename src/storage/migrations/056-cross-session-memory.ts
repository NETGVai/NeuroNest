/**
 * Cross-Session Memory: FTS5 table for embedding-free keyword search
 * of captured session knowledge.
 *
 * Creates:
 *   - `cross_session_memory` — base table for memory entries
 *   - `cross_session_memory_fts` — FTS5 virtual table for keyword search
 *   - Triggers to keep FTS5 index in sync with base table
 *
 * Requirements: 19.1, 19.2, 19.3
 */
import type Database from 'better-sqlite3';

export const version = 56;
export const description = 'Cross-session memory with FTS5 keyword search';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Cross-session memory base table
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS cross_session_memory (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('error_fixed', 'preference_learned', 'context_discovered', 'explicit_remember')),
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      project_dir TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_csm_session ON cross_session_memory(session_id);
    CREATE INDEX IF NOT EXISTS idx_csm_type ON cross_session_memory(type);
    CREATE INDEX IF NOT EXISTS idx_csm_project ON cross_session_memory(project_dir);
    CREATE INDEX IF NOT EXISTS idx_csm_created ON cross_session_memory(created_at);

    -- ═══════════════════════════════════════════════════════════════
    -- FTS5 virtual table for keyword search (embedding-free)
    -- ═══════════════════════════════════════════════════════════════

    CREATE VIRTUAL TABLE IF NOT EXISTS cross_session_memory_fts USING fts5(
      content, tags,
      content='cross_session_memory',
      content_rowid='rowid'
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Triggers to keep FTS5 index synchronized
    -- ═══════════════════════════════════════════════════════════════

    CREATE TRIGGER IF NOT EXISTS csm_fts_ai AFTER INSERT ON cross_session_memory BEGIN
      INSERT INTO cross_session_memory_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS csm_fts_ad AFTER DELETE ON cross_session_memory BEGIN
      INSERT INTO cross_session_memory_fts(cross_session_memory_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS csm_fts_au AFTER UPDATE ON cross_session_memory BEGIN
      INSERT INTO cross_session_memory_fts(cross_session_memory_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO cross_session_memory_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
    END;
  `);
}
