import type Database from 'better-sqlite3';

export const version = 53;
export const description = 'Feature Gate Store: centralized flag overrides and change audit trail';

export function up(db: Database.Database): void {
  db.exec(`
    -- Persisted feature gate configuration overrides
    CREATE TABLE IF NOT EXISTS feature_gate_config (
      flag TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      project_id TEXT NOT NULL DEFAULT '',
      value INTEGER NOT NULL CHECK (value IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (flag, scope, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_fgc_flag ON feature_gate_config(flag);
    CREATE INDEX IF NOT EXISTS idx_fgc_project ON feature_gate_config(project_id);

    -- Feature gate change audit trail
    CREATE TABLE IF NOT EXISTS feature_gate_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flag TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      project_id TEXT,
      prev_value INTEGER,
      new_value INTEGER NOT NULL CHECK (new_value IN (0, 1)),
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'user'
    );

    CREATE INDEX IF NOT EXISTS idx_fga_flag ON feature_gate_audit(flag);
    CREATE INDEX IF NOT EXISTS idx_fga_timestamp ON feature_gate_audit(timestamp);
    CREATE INDEX IF NOT EXISTS idx_fga_project ON feature_gate_audit(project_id);
  `);
}
