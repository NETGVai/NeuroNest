/**
 * Production UX Audit: change tracking, task executions, steering files,
 * hook executions, and approval decisions tables.
 *
 * Requirements: 7.1, 7.2, 7.4, 11.1, 16.1, 17.1
 */
import type Database from 'better-sqlite3';

export const version = 39;
export const description = 'Production UX Audit: change tracking, task executions, steering files, hook executions, approval decisions';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Change tracking for task executions
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS change_tracking (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('created', 'modified', 'deleted')),
      tool_call_id TEXT NOT NULL,
      before_content TEXT,
      after_content TEXT,
      size_delta INTEGER,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_change_tracking_session
      ON change_tracking(session_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Task execution summaries
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS task_executions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      total_iterations INTEGER DEFAULT 0,
      total_tool_calls INTEGER DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
      execution_mode TEXT NOT NULL CHECK(execution_mode IN ('autopilot', 'supervised'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_executions_session
      ON task_executions(session_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Steering files metadata (content stored on disk)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS steering_files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      inclusion_mode TEXT NOT NULL CHECK(inclusion_mode IN ('always', 'file-match', 'manual')),
      file_patterns TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Hook executions
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS hook_executions (
      id TEXT PRIMARY KEY,
      hook_id TEXT NOT NULL,
      trigger_event TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failure')),
      output TEXT,
      error TEXT,
      duration_ms INTEGER,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hook_executions_hook
      ON hook_executions(hook_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Approval decisions history
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS approval_decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approve_all', 'reject_all', 'selective')),
      approved_files TEXT,
      rejected_files TEXT,
      decided_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
