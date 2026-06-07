import type Database from 'better-sqlite3';

export const version = 21;
export const description = 'AI Review Model config, Steer/Queue message mode';

export function up(db: Database.Database): void {
  db.exec(`
    -- AI Review Model: dedicated review configuration per project
    CREATE TABLE IF NOT EXISTS ai_review_config (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      review_model_provider TEXT,
      review_model_name TEXT,
      effort_level TEXT NOT NULL DEFAULT 'standard' CHECK(effort_level IN ('quick', 'standard', 'thorough')),
      fast_mode INTEGER NOT NULL DEFAULT 0,
      auto_review INTEGER NOT NULL DEFAULT 0,
      review_scope TEXT NOT NULL DEFAULT 'uncommitted' CHECK(review_scope IN ('uncommitted', 'branch', 'staged')),
      custom_instructions TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_config_project ON ai_review_config(project_id);

    -- AI Review runs: history of reviews performed
    CREATE TABLE IF NOT EXISTS ai_review_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      review_type TEXT NOT NULL DEFAULT 'manual' CHECK(review_type IN ('manual', 'auto')),
      scope TEXT NOT NULL DEFAULT 'uncommitted',
      files_reviewed INTEGER NOT NULL DEFAULT 0,
      issues_found INTEGER NOT NULL DEFAULT 0,
      effort_level TEXT NOT NULL DEFAULT 'standard',
      model_used TEXT,
      summary TEXT,
      findings TEXT DEFAULT '[]',
      duration_ms INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_review_runs_project ON ai_review_runs(project_id);

    -- Message queue: steer/queue mode for chat messages
    CREATE TABLE IF NOT EXISTS message_queue (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      message TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'send' CHECK(mode IN ('send', 'steer', 'queue')),
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'cancelled')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_msgqueue_project ON message_queue(project_id);
    CREATE INDEX IF NOT EXISTS idx_msgqueue_status ON message_queue(status);

    -- Message mode preference per project
    CREATE TABLE IF NOT EXISTS message_mode_config (
      project_id TEXT PRIMARY KEY,
      default_mode TEXT NOT NULL DEFAULT 'send' CHECK(default_mode IN ('send', 'steer', 'queue')),
      auto_process_queue INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
