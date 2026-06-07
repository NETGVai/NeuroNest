import type Database from 'better-sqlite3';

export const version = 26;
export const description = 'Chat messages overflow table for BoundedMessageStore persistence';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages_overflow (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent TEXT,
      is_cmd INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_overflow_session_ts
      ON chat_messages_overflow(session_id, timestamp DESC);
  `);
}
