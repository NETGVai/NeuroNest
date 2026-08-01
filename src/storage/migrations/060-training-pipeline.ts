/**
 * Training Pipeline: SQLite schema for training jobs, checkpoints,
 * and per-step metrics telemetry.
 *
 * Creates:
 *   - `training_jobs` — training job configuration and lifecycle state
 *   - `training_checkpoints` — checkpoint snapshots per training job
 *   - `training_metrics` — per-step telemetry (loss, lr, GPU stats)
 *
 * Requirements: 28.2, 28.3, 28.4, 27.4
 */
import type Database from 'better-sqlite3';

export const version = 60;
export const description = 'Training pipeline tables (jobs, checkpoints, metrics)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Training Jobs
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      base_model TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('lora', 'qlora', 'full-finetune')),
      dataset_path TEXT NOT NULL,
      dataset_format TEXT NOT NULL CHECK(dataset_format IN ('instruction', 'chat', 'continued-pretraining', 'grpo')),
      config_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      queue_position INTEGER,
      current_step INTEGER DEFAULT 0,
      total_steps INTEGER,
      current_epoch INTEGER DEFAULT 0,
      total_epochs INTEGER,
      final_loss REAL,
      error_message TEXT,
      output_dir TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      estimated_cost_json TEXT,
      parent_job_id TEXT,
      FOREIGN KEY (parent_job_id) REFERENCES training_jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_training_jobs_project ON training_jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_training_jobs_state ON training_jobs(state);
    CREATE INDEX IF NOT EXISTS idx_training_jobs_queue ON training_jobs(state, queue_position) WHERE state = 'queued';

    -- ═══════════════════════════════════════════════════════════════
    -- Training Checkpoints
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_checkpoints (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      step INTEGER NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      learning_rate REAL NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES training_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_training_checkpoints_job ON training_checkpoints(job_id, created_at);

    -- ═══════════════════════════════════════════════════════════════
    -- Training Metrics (per-step telemetry)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      loss REAL NOT NULL,
      learning_rate REAL NOT NULL,
      gradient_norm REAL,
      tokens_per_second REAL,
      gpu_utilization REAL,
      vram_usage_mb REAL,
      gpu_temperature REAL,
      recorded_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES training_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_training_metrics_job ON training_metrics(job_id, step);
  `);
}
