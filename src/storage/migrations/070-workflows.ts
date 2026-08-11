/**
 * Deterministic Workflow Engine: SQLite schema for code-first workflow
 * definitions and execution tracking with token attribution.
 *
 * Creates:
 *   - `workflow_definitions` — workflow step DAGs with triggers
 *   - `workflow_executions` — execution history with per-step results and token usage
 *
 * Requirements: 7.7
 */
import type Database from 'better-sqlite3';

export const version = 70;
export const description = 'Workflow engine tables (workflow_definitions, workflow_executions)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Workflow Definitions
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      project_id TEXT NOT NULL,
      steps TEXT NOT NULL,
      triggers TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Workflow Executions
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      step_results TEXT,
      tokens_generation INTEGER NOT NULL DEFAULT 0,
      tokens_execution INTEGER NOT NULL DEFAULT 0
    );
  `);
}
