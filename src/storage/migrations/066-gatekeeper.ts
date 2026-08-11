/**
 * Gatekeeper Layer: SQLite schema for capability-based security bindings
 * and tamper-evident audit logging.
 *
 * Creates:
 *   - `capability_bindings` — unforgeable capability grants with rate limits and expiry
 *   - `audit_log` — complete audit trail of all operations through capability bindings
 *
 * Requirements: 3.4
 */
import type Database from 'better-sqlite3';

export const version = 66;
export const description = 'Gatekeeper layer tables (capability_bindings, audit_log)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Capability Bindings
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS capability_bindings (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      allowed_operations TEXT NOT NULL,
      scope_constraints TEXT NOT NULL,
      rate_limit_max INTEGER,
      rate_limit_window_ms INTEGER,
      expires_at TEXT,
      granted_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Audit Log
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      parameters TEXT,
      result_status TEXT NOT NULL,
      capability_id TEXT NOT NULL REFERENCES capability_bindings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_id, timestamp);
  `);
}
