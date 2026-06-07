import type Database from 'better-sqlite3';

export const version = 29;
export const description =
  'Pipeline_Event_Log storage: pipeline_events append-only event stream (12-factor-agent-improvements task 1).';

/**
 * Schema (per design.md "Data Models"):
 *   pipeline_events (
 *     id           TEXT PRIMARY KEY,   -- UUIDv7 (preferred) or UUIDv4 (fallback)
 *     session_id   TEXT NOT NULL,
 *     seq          INTEGER NOT NULL,   -- per-session monotonic, canonical order key
 *     kind         TEXT NOT NULL,      -- discriminated union (chat.*, tool.*, etc.)
 *     payload_json TEXT NOT NULL,      -- JSON-encoded payload
 *     created_at   INTEGER NOT NULL    -- UNIX ms (NOT used for ordering — seq is)
 *   )
 *
 * Indexes:
 *   (session_id, seq)        — ordered reads for the reducer's getEventsSince
 *   (kind, session_id)       — filter queries for cross-session debugging
 *   UNIQUE(session_id, seq)  — prevents seq collisions from concurrent writers
 *
 * The single-writer constraint (Event_Bus_Bridge in src/main/ipc.ts) plus the
 * UNIQUE index together make per-session seq allocation race-free. The writer
 * computes `MAX(seq)+1` and inserts inside the same SQLite transaction.
 *
 * This migration is idempotent: re-running is a no-op thanks to
 * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE UNIQUE
 * INDEX IF NOT EXISTS.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pe_session_seq ON pipeline_events(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_pe_kind_session ON pipeline_events(kind, session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pe_session_seq_unique ON pipeline_events(session_id, seq);
  `);
}
