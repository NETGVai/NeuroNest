import type Database from 'better-sqlite3';

export const version = 30;
export const description =
  'Metric_Sink storage: metric_samples table for arbitrary keyed numeric metrics (12-factor-agent-improvements task 2).';

/**
 * Schema (per design.md "Data Models"):
 *   metric_samples (
 *     id          TEXT PRIMARY KEY,   -- UUIDv4
 *     session_id  TEXT,               -- nullable; some metrics are global
 *     key         TEXT NOT NULL,      -- e.g. "unified_state.bytes"
 *     value       REAL NOT NULL,      -- numeric only
 *     recorded_at INTEGER NOT NULL    -- UNIX ms
 *   )
 *
 * Indexes:
 *   (key, recorded_at)   — time-series queries by metric key
 *   (session_id, key)    — per-session views
 *
 * Pruning: a daily cron job (task 3) drops rows older than 30 days.
 *
 * This migration is idempotent: re-running is a no-op thanks to
 * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_samples (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      key TEXT NOT NULL,
      value REAL NOT NULL,
      recorded_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ms_key_recorded_at ON metric_samples(key, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_ms_session_key ON metric_samples(session_id, key);
  `);
}
