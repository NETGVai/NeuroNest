import type Database from 'better-sqlite3';

export const version = 45;
export const description = 'Code reviews: Automated code review pipeline with inline comments (code_reviews, review_comments tables)';

export function up(db: Database.Database): void {
  db.exec(`
    -- Code Reviews: tracks review pipeline executions and results
    -- Requirements: 4.1, 4.5
    CREATE TABLE IF NOT EXISTS code_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      score_security INTEGER,
      score_performance INTEGER,
      score_style INTEGER,
      score_test_coverage INTEGER,
      score_complexity INTEGER,
      overall_score INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    -- Review Comments: individual inline comments anchored to diff line ranges
    -- Requirements: 4.3
    CREATE TABLE IF NOT EXISTS review_comments (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES code_reviews(id),
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      suggested_fix TEXT,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}
