import type Database from 'better-sqlite3';

export const version = 16;
export const description = 'Inline completion, CI checks, OS mode, voice-to-code, auto lint/test';

export function up(db: Database.Database): void {
  db.exec(`
    -- Inline code completion: completion history and settings
    CREATE TABLE IF NOT EXISTS completion_history (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      file_path TEXT NOT NULL,
      prefix TEXT NOT NULL,
      completion TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0,
      provider TEXT,
      model TEXT,
      latency_ms INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_completion_session ON completion_history(session_id);

    -- CI/PR Checks: check definitions and run results
    CREATE TABLE IF NOT EXISTS ci_checks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      severity TEXT DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'error')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ci_checks_project ON ci_checks(project_id);

    CREATE TABLE IF NOT EXISTS ci_check_runs (
      id TEXT PRIMARY KEY,
      check_id TEXT NOT NULL REFERENCES ci_checks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'passed', 'failed')),
      result TEXT,
      suggested_fix TEXT,
      files_checked TEXT DEFAULT '[]',
      run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_ci_runs_check ON ci_check_runs(check_id);

    -- Auto Lint/Test: configuration and run history
    CREATE TABLE IF NOT EXISTS lint_test_config (
      project_id TEXT PRIMARY KEY,
      lint_enabled INTEGER NOT NULL DEFAULT 0,
      lint_command TEXT,
      test_enabled INTEGER NOT NULL DEFAULT 0,
      test_command TEXT,
      auto_fix INTEGER NOT NULL DEFAULT 0,
      run_on_ai_change INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lint_test_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('lint', 'test')),
      command TEXT NOT NULL,
      exit_code INTEGER,
      output TEXT,
      auto_fixed INTEGER NOT NULL DEFAULT 0,
      triggered_by TEXT DEFAULT 'manual',
      run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_lint_runs_project ON lint_test_runs(project_id);
  `);
}
