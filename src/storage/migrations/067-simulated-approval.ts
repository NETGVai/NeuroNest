/**
 * Simulated Approval Workflow: SQLite schema for queuing side-effecting
 * actions that await human review while agents continue working.
 *
 * Creates:
 *   - `pending_actions` — queue of simulated actions awaiting approval/rejection
 *
 * Requirements: 4.6
 */
import type Database from 'better-sqlite3';

export const version = 67;
export const description = 'Simulated approval workflow table (pending_actions)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Pending Actions Queue
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS pending_actions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      parameters TEXT NOT NULL,
      simulated_result TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      depends_on TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      rejection_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_actions(status);
  `);
}
