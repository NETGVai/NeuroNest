import type Database from 'better-sqlite3';

export const version = 49;
export const description = 'Plugin system: no-op migration (plugins table already exists in 001-initial-schema)';

/**
 * No-op migration.
 *
 * The `plugins` table was created in migration 001 (initial-schema.ts) as part of
 * the original database design. This migration exists solely to close the numbering
 * gap between migrations 048 and 050.
 *
 * The plugin system (tasks 17.1-17.4) reuses the existing table and does not
 * require schema changes.
 */
export function up(_db: Database.Database): void {
  // Intentionally empty — plugins table already exists.
}
