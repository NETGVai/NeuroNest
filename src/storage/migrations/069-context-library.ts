/**
 * Context Library: SQLite schema for curated organizational knowledge
 * that is injected into agent prompts.
 *
 * Creates:
 *   - `context_entries` — scoped context snippets with priority-based budget trimming
 *
 * Requirements: 6.1
 */
import type Database from 'better-sqlite3';

export const version = 69;
export const description = 'Context library table (context_entries)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Context Entries
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS context_entries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ctx_scope ON context_entries(scope, scope_id);
  `);
}
