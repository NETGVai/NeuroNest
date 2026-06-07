import type Database from 'better-sqlite3';

export const version = 14;
export const description = 'P2P sharing, embedded browser, AI readiness, session inspector, kanban board';

export function up(db: Database.Database): void {
  db.exec(`
    -- AI Readiness Score: project-level readiness assessments
    CREATE TABLE IF NOT EXISTS ai_readiness_scores (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      overall_score INTEGER NOT NULL DEFAULT 0,
      categories TEXT NOT NULL DEFAULT '{}',
      issues TEXT NOT NULL DEFAULT '[]',
      scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_readiness_project ON ai_readiness_scores(project_id);

    -- Session Inspector: per-session telemetry snapshots
    CREATE TABLE IF NOT EXISTS session_telemetry (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      context_pct REAL NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_breakdown TEXT NOT NULL DEFAULT '{}',
      recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_session ON session_telemetry(session_id);

    -- Kanban Board: columns and cards for task management
    CREATE TABLE IF NOT EXISTS kanban_columns (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_col_project ON kanban_columns(project_id);

    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES kanban_columns(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      agent_id TEXT,
      session_id TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
      labels TEXT DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_card_col ON kanban_cards(column_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_card_project ON kanban_cards(project_id);

    -- P2P Sharing: session share records
    CREATE TABLE IF NOT EXISTS shared_sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'read-only' CHECK(mode IN ('read-only', 'read-write')),
      peer_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_shared_session ON shared_sessions(session_id);

    -- Embedded Browser: saved browser tabs per project
    CREATE TABLE IF NOT EXISTS browser_tabs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_browser_project ON browser_tabs(project_id);
  `);
}
