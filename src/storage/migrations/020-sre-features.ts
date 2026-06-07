import type Database from 'better-sqlite3';

export const version = 20;
export const description = 'Evidence-backed analysis, runbooks, predictive detection, investigation reports, integration validation';

export function up(db: Database.Database): void {
  db.exec(`
    -- Evidence Citations: link AI claims to specific code locations
    CREATE TABLE IF NOT EXISTS evidence_citations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      claim TEXT NOT NULL,
      file_path TEXT,
      line_start INTEGER,
      line_end INTEGER,
      snippet TEXT,
      evidence_type TEXT NOT NULL DEFAULT 'code' CHECK(evidence_type IN ('code', 'metric', 'log', 'config', 'test', 'dependency')),
      confidence REAL DEFAULT 0.8,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence_citations(session_id);

    -- Runbooks: step-by-step procedures the AI follows
    CREATE TABLE IF NOT EXISTS runbooks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      trigger_pattern TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      is_builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      times_used INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_runbooks_project ON runbooks(project_id);

    -- Predictive Alerts: trend-based warnings
    CREATE TABLE IF NOT EXISTS predictive_alerts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      alert_type TEXT NOT NULL CHECK(alert_type IN ('quality_declining', 'test_coverage_dropping', 'dependency_growing', 'complexity_rising', 'cost_increasing')),
      severity TEXT NOT NULL DEFAULT 'warning',
      message TEXT NOT NULL,
      trend_data TEXT DEFAULT '{}',
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_predictive_project ON predictive_alerts(project_id);

    -- Investigation Reports: structured AI analysis output
    CREATE TABLE IF NOT EXISTS investigation_reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      root_cause TEXT,
      evidence TEXT DEFAULT '[]',
      recommendations TEXT DEFAULT '[]',
      next_steps TEXT DEFAULT '[]',
      severity TEXT DEFAULT 'info',
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'dismissed')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_report_project ON investigation_reports(project_id);

    -- Integration Validations: track which integrations are verified working
    CREATE TABLE IF NOT EXISTS integration_validations (
      id TEXT PRIMARY KEY,
      integration_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'untested' CHECK(status IN ('untested', 'passed', 'failed', 'warning')),
      last_tested_at DATETIME,
      error_message TEXT,
      details TEXT DEFAULT '{}'
    );
  `);
}
