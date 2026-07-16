/**
 * Hook Definitions v2: SQLite tables for the v2 hook schema and execution history.
 *
 * Creates:
 *   - `hook_definitions_v2` — persisted hook definitions in the v2 format
 *   - `hook_executions_v2` — execution history with verdict and duration tracking
 *
 * The existing `hooks` table (created by HooksManager) and `hook_executions`
 * table (migration 039) remain untouched; the migration module in
 * `src/events/hook-migration-v2.ts` handles lossless data transfer.
 *
 * Requirements: 17.5, 17.6
 */
import type Database from 'better-sqlite3';

export const version = 55;
export const description = 'Hook Definitions v2: structured hook definitions and execution history';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Hook definitions v2
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS hook_definitions_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('command', 'http')),
      events TEXT NOT NULL,
      matcher TEXT,
      timeout INTEGER NOT NULL DEFAULT 2000,
      enabled INTEGER NOT NULL DEFAULT 1,
      command TEXT,
      url TEXT,
      method TEXT,
      verdict TEXT CHECK (verdict IN ('deny', 'decline') OR verdict IS NULL),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      migrated_from TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_hdv2_project ON hook_definitions_v2(project_id);
    CREATE INDEX IF NOT EXISTS idx_hdv2_name ON hook_definitions_v2(name);
    CREATE INDEX IF NOT EXISTS idx_hdv2_enabled ON hook_definitions_v2(enabled);

    -- Unique constraint: one hook name per project
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hdv2_project_name
      ON hook_definitions_v2(project_id, name);

    -- ═══════════════════════════════════════════════════════════════
    -- Hook executions v2 (richer than migration 039 version)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS hook_executions_v2 (
      id TEXT PRIMARY KEY,
      hook_id TEXT NOT NULL,
      event TEXT NOT NULL,
      verdict TEXT CHECK (verdict IN ('allow', 'deny', 'pass', 'timeout', 'error')),
      duration_ms INTEGER,
      output TEXT,
      error TEXT,
      session_id TEXT,
      project_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hev2_hook ON hook_executions_v2(hook_id);
    CREATE INDEX IF NOT EXISTS idx_hev2_event ON hook_executions_v2(event);
    CREATE INDEX IF NOT EXISTS idx_hev2_timestamp ON hook_executions_v2(timestamp);
    CREATE INDEX IF NOT EXISTS idx_hev2_session ON hook_executions_v2(session_id);
  `);
}
