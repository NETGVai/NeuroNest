import type Database from 'better-sqlite3';

export const version = 28;
export const description =
  'Placeholder error_size_samples table for the observation-only error-size tap (task 0 of 12-factor-agent-improvements). Dropped in task 4 after backfill into metric_samples.';

/**
 * Schema (per spec task 0):
 *   error_size_samples (id, session_id, value, recorded_at)
 *
 *   - id          TEXT PRIMARY KEY (UUIDv4 from crypto.randomUUID)
 *   - session_id  TEXT (nullable — fallback path may lack a session)
 *   - value       INTEGER (estimateTokens(JSON.stringify(error)))
 *   - recorded_at INTEGER (UNIX ms)
 *
 * This table is intentionally minimal. It exists to set the empirical floor
 * for `errors.compaction.maxTokens` (default 800) before the Error_Compactor
 * ships. After Metrics_Sink lands (task 4), values are backfilled into
 * `metric_samples` under key `errors.raw_estimated_tokens` and this table
 * is dropped.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS error_size_samples (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      value INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ess_recorded_at ON error_size_samples(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_ess_session_id ON error_size_samples(session_id);
  `);
}
