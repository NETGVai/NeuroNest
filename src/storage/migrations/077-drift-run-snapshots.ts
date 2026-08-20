import type Database from 'better-sqlite3';

export const version = 77;
export const description =
  'Persist project-scoped agent-loop reliability and completed drift snapshots';

/**
 * Stores one bounded, non-response snapshot per completed agent-loop run.
 * Prompt and model response content are intentionally excluded. The drift JSON
 * contains only the intent anchor, scope counters, thresholds, and signals that
 * are already exposed by the drift dashboard contract.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drift_run_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
      session_id TEXT NOT NULL CHECK(length(trim(session_id)) > 0),
      status TEXT NOT NULL CHECK(status IN ('completed', 'incomplete', 'failed')),
      source TEXT NOT NULL CHECK(source IN ('agent-loop', 'enhanced-swarm', 'standard-swarm')),
      loop_iterations INTEGER NOT NULL DEFAULT 0 CHECK(loop_iterations >= 0),
      phase_count INTEGER NOT NULL DEFAULT 0 CHECK(phase_count >= 0),
      tool_success_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_success_count >= 0),
      tool_failure_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_failure_count >= 0),
      task_completed_count INTEGER NOT NULL DEFAULT 0 CHECK(task_completed_count >= 0),
      task_failed_count INTEGER NOT NULL DEFAULT 0 CHECK(task_failed_count >= 0),
      task_blocked_count INTEGER NOT NULL DEFAULT 0 CHECK(task_blocked_count >= 0),
      agent_output_count INTEGER NOT NULL DEFAULT 0 CHECK(agent_output_count >= 0),
      tokens_consumed INTEGER NOT NULL DEFAULT 0 CHECK(tokens_consumed >= 0),
      drift_state_json TEXT,
      completed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_drift_run_snapshots_project_latest
      ON drift_run_snapshots(project_id, completed_at DESC);
  `);
}

export function down(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_drift_run_snapshots_project_latest;
    DROP TABLE IF EXISTS drift_run_snapshots;
  `);
}
