/**
 * Observation Tracker: SQLite schema for data-flow provenance recording
 * and access-level policy enforcement.
 *
 * Creates:
 *   - `observations` — records of data accessed by agents/gadgets
 *   - `data_flow_policies` — policies governing data movement between access levels
 *
 * Requirements: 5.1
 */
import type Database from 'better-sqlite3';

export const version = 68;
export const description = 'Observation tracker tables (observations, data_flow_policies)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Observations (data-flow provenance)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      data_scope TEXT NOT NULL,
      access_level TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_obs_actor ON observations(actor_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Data Flow Policies
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS data_flow_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_access_level TEXT NOT NULL,
      allowed_destinations TEXT NOT NULL,
      blocked_operations TEXT NOT NULL
    );
  `);
}
