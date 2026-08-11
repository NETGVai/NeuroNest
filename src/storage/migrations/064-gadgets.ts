/**
 * Gadget Engine: SQLite schema for sandboxed personal application
 * lifecycle management and capability bindings.
 *
 * Creates:
 *   - `gadgets` — gadget instance metadata and lifecycle state
 *   - `gadget_capabilities` — capability bindings associated with each gadget
 *
 * Requirements: 1.1, 1.6
 */
import type Database from 'better-sqlite3';

export const version = 64;
export const description = 'Gadget engine tables (gadgets, gadget_capabilities)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Gadget Instances
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gadgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      has_client INTEGER NOT NULL DEFAULT 0,
      has_server INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'stopped',
      server_port INTEGER,
      db_path TEXT NOT NULL,
      source_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Gadget Capability Bindings (junction table)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gadget_capabilities (
      gadget_id TEXT NOT NULL REFERENCES gadgets(id) ON DELETE CASCADE,
      capability_id TEXT NOT NULL REFERENCES capability_bindings(id),
      PRIMARY KEY (gadget_id, capability_id)
    );
  `);
}
