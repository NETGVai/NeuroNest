/**
 * Loop Storage: loop_specs, loop_runs, loop_passes tables for persisting
 * loop definitions and execution history.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
import type Database from 'better-sqlite3';

export const version = 41;
export const description = 'Loop Storage';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Loop Specifications
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS loop_specs (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      json TEXT NOT NULL,
      source TEXT NOT NULL,
      catalog_ref TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Loop Runs
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS loop_runs (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL REFERENCES loop_specs(id),
      spec_version TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
      stop_reason TEXT,
      passes_completed INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      started_at DATETIME NOT NULL,
      ended_at DATETIME,
      receipt_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_loop_runs_session ON loop_runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_loop_runs_spec ON loop_runs(spec_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Loop Passes
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS loop_passes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES loop_runs(id),
      pass_number INTEGER NOT NULL,
      action_summary TEXT,
      verify_results_json TEXT,
      evidence_json TEXT,
      cost_usd REAL DEFAULT 0,
      security_scan_id TEXT,
      started_at DATETIME NOT NULL,
      ended_at DATETIME,
      UNIQUE(run_id, pass_number)
    );

    CREATE INDEX IF NOT EXISTS idx_loop_passes_run ON loop_passes(run_id);
  `);
}
