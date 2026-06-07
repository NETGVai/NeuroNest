import type Database from 'better-sqlite3';

export const version = 11;
export const description = 'Visual diff review system for AI-proposed changes';

export function up(db: Database.Database): void {
  db.exec(`
    -- Diff review records: tracks AI-proposed file changes for accept/reject workflow
    CREATE TABLE IF NOT EXISTS diff_reviews (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      original_content TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'partial')),
      agent_id TEXT,
      description TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_diff_reviews_session ON diff_reviews(session_id);
    CREATE INDEX IF NOT EXISTS idx_diff_reviews_status ON diff_reviews(status);
    CREATE INDEX IF NOT EXISTS idx_diff_reviews_file ON diff_reviews(file_path);
  `);
}
