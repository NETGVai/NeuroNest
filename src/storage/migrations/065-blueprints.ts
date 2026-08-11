/**
 * Blueprint Registry: SQLite schema for shareable application templates
 * with versioning support.
 *
 * Creates:
 *   - `blueprints` — blueprint metadata and current version tracking
 *   - `blueprint_versions` — versioned archives of blueprint source
 *
 * Requirements: 2.1, 2.2
 */
import type Database from 'better-sqlite3';

export const version = 65;
export const description = 'Blueprint registry tables (blueprints, blueprint_versions)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Blueprint Metadata
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS blueprints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      author TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Blueprint Version History
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS blueprint_versions (
      blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      archive_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blueprint_id, version)
    );
  `);
}
