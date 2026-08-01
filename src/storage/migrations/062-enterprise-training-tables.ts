/**
 * Enterprise Training Tables: SQLite schema for scheduled retraining,
 * training effectiveness metrics, and cloud training job tracking.
 *
 * Creates:
 *   - `training_schedules` — cron-based scheduled retraining configuration
 *   - `training_effectiveness` — pre/post-training performance metrics
 *   - `training_cloud_jobs` — cloud training job offload tracking
 *
 * Requirements: 28.2, 28.3, 28.4
 */
import type Database from 'better-sqlite3';

export const version = 62;
export const description = 'Enterprise training tables (schedules, effectiveness, cloud jobs)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Scheduled Retraining
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      last_config_json TEXT NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_training_schedules_next ON training_schedules(next_run_at) WHERE enabled = 1;

    -- ═══════════════════════════════════════════════════════════════
    -- Training Effectiveness Metrics
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_effectiveness (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      metric_type TEXT NOT NULL CHECK(metric_type IN ('response_quality', 'task_completion', 'retrieval_precision')),
      value REAL NOT NULL,
      baseline_value REAL,
      measured_at INTEGER NOT NULL,
      FOREIGN KEY (model_id) REFERENCES training_models(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_training_effectiveness_model ON training_effectiveness(model_id, measured_at);

    -- ═══════════════════════════════════════════════════════════════
    -- Cloud Training Jobs
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_cloud_jobs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      remote_job_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_polled_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES training_jobs(id) ON DELETE CASCADE
    );
  `);
}
