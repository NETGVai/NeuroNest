import type Database from 'better-sqlite3';

export const version = 52;
export const description = 'Diff turns: Turn-level file change tracking for DiffViewer (diff_turns, diff_turn_files tables)';

export function up(db: Database.Database): void {
  db.exec(`
    -- Diff Turns: tracks file modifications grouped by conversation turn
    -- Requirements: 15.1, 15.2, 15.5
    CREATE TABLE IF NOT EXISTS diff_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      agent_id TEXT,
      files_added INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0,
      files_deleted INTEGER DEFAULT 0,
      lines_added INTEGER DEFAULT 0,
      lines_removed INTEGER DEFAULT 0,
      checkpoint_id TEXT,
      created_at INTEGER NOT NULL
    );

    -- Diff Turn Files: individual file changes within a turn
    -- Requirements: 15.2, 15.4
    CREATE TABLE IF NOT EXISTS diff_turn_files (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES diff_turns(id),
      file_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      before_content TEXT,
      after_content TEXT,
      patch TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dtf_turn ON diff_turn_files(turn_id);
  `);
}
