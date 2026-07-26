/**
 * Dispatch Source Attribution: adds `source` column to messages table
 * for distinguishing dashboard-dispatched messages from direct chat messages.
 *
 * Creates:
 *   - `source` TEXT column on `messages` (nullable, defaults to NULL)
 *   - `idx_messages_session_source` index on (session_id, source, created_at)
 *
 * Requirements: 1.3, 3.1
 */
import type Database from 'better-sqlite3';

export const version = 57;
export const description = 'Add source column to messages for dispatch attribution';

export function up(db: Database.Database): void {
  db.exec(`
    -- Add source column for dispatch attribution
    -- Values: NULL (direct chat), 'dashboard' (dispatched from Agent Dashboard)
    ALTER TABLE messages ADD COLUMN source TEXT DEFAULT NULL;

    -- Index for project-scoped queries that include dispatch messages
    CREATE INDEX IF NOT EXISTS idx_messages_session_source
      ON messages(session_id, source, created_at);
  `);
}
