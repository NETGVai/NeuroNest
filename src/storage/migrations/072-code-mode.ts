/**
 * Code Mode Agent: SQLite schema for tracking agent-generated code
 * snippet execution history in sandboxed V8 isolates.
 *
 * Creates:
 *   - `code_snippets` — executed code snippets with results, errors, and timing
 *
 * Requirements: 8.6
 */
import type Database from 'better-sqlite3';

export const version = 72;
export const description = 'Code mode agent table (code_snippets)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Code Snippets
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS code_snippets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      code TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      result TEXT,
      error TEXT,
      duration_ms INTEGER,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snippets_session ON code_snippets(session_id);
  `);
}
