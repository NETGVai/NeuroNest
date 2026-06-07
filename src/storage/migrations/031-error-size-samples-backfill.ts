import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export const version = 31;
export const description =
  'Backfill error_size_samples into metric_samples (key=errors.raw_estimated_tokens) then drop the placeholder table (12-factor-agent-improvements task 4).';

/**
 * Task 4 of 12-factor-agent-improvements: the placeholder table
 * `error_size_samples` (created by migration 028) was a temporary holding
 * area for the observation-only error-size tap shipped in task 0. Now that
 * Metrics_Sink (`metric_samples`, migration 030) exists and the tap has
 * been rewired to write through `SessionTelemetryService.recordMetric`,
 * the placeholder is dropped.
 *
 * This migration is fully idempotent:
 *   - If `error_size_samples` does not exist (fresh installs that ran
 *     migration 030 after this one was added) the entire body is a no-op.
 *   - If `error_size_samples` exists with rows, every row is copied into
 *     `metric_samples` under key `errors.raw_estimated_tokens` with a
 *     fresh UUIDv4 id, then the placeholder table is dropped.
 *   - Re-running after a partial failure replays cleanly because the row
 *     copy uses fresh UUIDs and the table drop is `DROP TABLE IF EXISTS`.
 *
 * The data is non-destructively preserved: every value lands in its
 * permanent home (`metric_samples`) before the placeholder goes away.
 */
export function up(db: Database.Database): void {
  // Detect whether the placeholder table exists. If not, the work has
  // already been done (or this is a fresh install) — exit cleanly.
  const placeholder = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='error_size_samples'",
    )
    .get() as { name: string } | undefined;

  if (!placeholder) {
    return;
  }

  // Read existing rows. We page in memory because the placeholder table
  // is bounded (≥ 7 days of error observations from a single dev/CI
  // environment) — well under the few-thousand-rows scale where streaming
  // would matter.
  interface PlaceholderRow {
    id: string;
    session_id: string | null;
    value: number;
    recorded_at: number;
  }

  const rows = db
    .prepare(
      'SELECT id, session_id, value, recorded_at FROM error_size_samples',
    )
    .all() as PlaceholderRow[];

  if (rows.length > 0) {
    const insert = db.prepare(
      'INSERT INTO metric_samples (id, session_id, key, value, recorded_at) VALUES (?, ?, ?, ?, ?)',
    );

    for (const row of rows) {
      // Generate a new UUID for metric_samples so we never collide with
      // any id another caller may already have written under
      // metric_samples (defensive — there is no overlap by construction).
      insert.run(
        randomUUID(),
        row.session_id,
        'errors.raw_estimated_tokens',
        row.value,
        row.recorded_at,
      );
    }
  }

  db.exec('DROP TABLE IF EXISTS error_size_samples');
}
