/**
 * Model Export and GRPO Tables: SQLite schema for exported model version
 * history, GRPO preference pairs, and dataset generation records.
 *
 * Creates:
 *   - `training_models` — exported model version history
 *   - `grpo_preferences` — GRPO preference pairs from user feedback
 *   - `training_datasets` — dataset generation records with provenance
 *
 * Requirements: 28.2, 28.3, 28.4
 */
import type Database from 'better-sqlite3';

export const version = 61;
export const description = 'Model export, GRPO preferences, and training datasets tables';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Exported Models (version history)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_models (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      base_model TEXT NOT NULL,
      gguf_path TEXT NOT NULL,
      quantization TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      validation_passed INTEGER,
      validation_metrics_json TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES training_jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_training_models_project ON training_models(project_id);
    CREATE INDEX IF NOT EXISTS idx_training_models_active ON training_models(project_id, is_active) WHERE is_active = 1;

    -- ═══════════════════════════════════════════════════════════════
    -- GRPO Preference Pairs
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS grpo_preferences (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      chosen_response TEXT NOT NULL,
      rejected_response TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('user-feedback', 'comparison-panel', 'auto-generated')),
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_grpo_preferences_project ON grpo_preferences(project_id, created_at);

    -- ═══════════════════════════════════════════════════════════════
    -- Dataset Generation Records
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS training_datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      format TEXT NOT NULL,
      path TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      generation_duration_ms INTEGER NOT NULL,
      provenance_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_training_datasets_project ON training_datasets(project_id, created_at);
  `);
}
