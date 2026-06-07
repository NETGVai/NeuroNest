import type Database from 'better-sqlite3';

export const version = 12;
export const description = 'Multi-session parallel agent support';

export function up(db: Database.Database): void {
  db.exec(`
    -- Parallel sessions: tracks multiple concurrent agent sessions per project
    CREATE TABLE IF NOT EXISTS parallel_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'paused', 'completed', 'failed')),
      task TEXT,
      result TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_parallel_sessions_project ON parallel_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_parallel_sessions_status ON parallel_sessions(status);

    -- Messages for parallel sessions
    CREATE TABLE IF NOT EXISTS parallel_messages (
      id TEXT PRIMARY KEY,
      parallel_session_id TEXT NOT NULL REFERENCES parallel_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      agent TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_parallel_messages_session ON parallel_messages(parallel_session_id);
  `);
}
