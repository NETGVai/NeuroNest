import type Database from 'better-sqlite3';

export const version = 6;
export const description = 'Security scan results and exceptions';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('minimal', 'extended', 'paranoid')),
      total_files INTEGER NOT NULL,
      total_findings INTEGER NOT NULL,
      findings_low INTEGER NOT NULL DEFAULT 0,
      findings_medium INTEGER NOT NULL DEFAULT 0,
      findings_high INTEGER NOT NULL DEFAULT 0,
      findings_critical INTEGER NOT NULL DEFAULT 0,
      suppressed_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_scan_results_project
      ON scan_results(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS scan_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      col INTEGER NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      remediation TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scan_findings_scan
      ON scan_findings(scan_id);

    CREATE TABLE IF NOT EXISTS scan_exceptions (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      file_pattern TEXT NOT NULL,
      reason TEXT NOT NULL,
      creator TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_scan_exceptions_rule
      ON scan_exceptions(rule_id);
  `);
}
