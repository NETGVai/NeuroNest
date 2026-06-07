import type Database from 'better-sqlite3';

export const version = 7;
export const description = 'Long-term memory and compression stats tables';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS long_term_memory (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      category    TEXT NOT NULL CHECK(category IN ('profile', 'preference', 'knowledge')),
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      relevance_score REAL NOT NULL DEFAULT 1.0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ltm_user_key
      ON long_term_memory(user_id, key);
    CREATE INDEX IF NOT EXISTS idx_ltm_user_category
      ON long_term_memory(user_id, category);
    CREATE INDEX IF NOT EXISTS idx_ltm_user_relevance
      ON long_term_memory(user_id, relevance_score DESC);

    CREATE TABLE IF NOT EXISTS compression_stats (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      turns_compressed  INTEGER NOT NULL,
      tokens_saved      INTEGER NOT NULL,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cs_session
      ON compression_stats(session_id);
  `);
}
