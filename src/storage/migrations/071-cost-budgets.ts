/**
 * Multi-Model Cost Router: SQLite schema for per-scope cost budget
 * configuration with threshold-based actions (warn, downgrade, abort).
 *
 * Creates:
 *   - `cost_budgets` — scope-bound budget limits and threshold configuration
 *
 * Requirements: 10.3
 */
import type Database from 'better-sqlite3';

export const version = 71;
export const description = 'Cost budget configuration table (cost_budgets)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Cost Budgets
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS cost_budgets (
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      daily_limit REAL NOT NULL,
      monthly_limit REAL NOT NULL,
      warn_threshold REAL NOT NULL DEFAULT 0.8,
      downgrade_threshold REAL NOT NULL DEFAULT 0.9,
      abort_threshold REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (scope, scope_id)
    );
  `);
}
