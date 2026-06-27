import type Database from 'better-sqlite3';

export const version = 38;
export const description = 'NeuroNest Enhanced: orchestration, testing, and drift management tables';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Category A: Orchestration
    -- ═══════════════════════════════════════════════════════════════

    -- Race execution records
    CREATE TABLE IF NOT EXISTS races (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'all-failed', 'timed-out')),
      winner_participant_id TEXT,
      total_duration_ms INTEGER,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    -- Individual race participants
    CREATE TABLE IF NOT EXISTS race_participants (
      id TEXT PRIMARY KEY,
      race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'timed-out')),
      quality_score REAL DEFAULT 0,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_race_participants_race ON race_participants(race_id);

    -- Worktree snapshots
    CREATE TABLE IF NOT EXISTS worktree_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      label TEXT,
      git_ref TEXT NOT NULL,
      staged_files TEXT NOT NULL,
      unstaged_files TEXT NOT NULL,
      untracked_files TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_worktree_snapshots_session ON worktree_snapshots(session_id);
    CREATE INDEX idx_worktree_snapshots_label ON worktree_snapshots(label);

    -- Diff annotations
    CREATE TABLE IF NOT EXISTS diff_annotations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('comment', 'request-change', 'approve-section')),
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_diff_annotations_session ON diff_annotations(session_id);

    -- Provider usage tracking
    CREATE TABLE IF NOT EXISTS provider_usage (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      rate_limited INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX idx_provider_usage_provider ON provider_usage(provider_id);
    CREATE INDEX idx_provider_usage_timestamp ON provider_usage(timestamp);

    -- ═══════════════════════════════════════════════════════════════
    -- Category B: Testing
    -- ═══════════════════════════════════════════════════════════════

    -- Test plans
    CREATE TABLE IF NOT EXISTS test_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_spec TEXT,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Generated test file tracking
    CREATE TABLE IF NOT EXISTS generated_tests (
      id TEXT PRIMARY KEY,
      plan_id TEXT REFERENCES test_plans(id),
      file_path TEXT NOT NULL,
      source_module TEXT NOT NULL,
      test_type TEXT NOT NULL CHECK(test_type IN ('unit', 'integration', 'property-based', 'end-to-end')),
      last_run_status TEXT CHECK(last_run_status IN ('pass', 'fail', 'pending')),
      generated_at TEXT NOT NULL
    );

    CREATE INDEX idx_generated_tests_plan ON generated_tests(plan_id);

    -- Test execution history (for health analytics)
    CREATE TABLE IF NOT EXISTS test_executions (
      id TEXT PRIMARY KEY,
      test_file_path TEXT NOT NULL,
      test_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pass', 'fail', 'skip')),
      duration_ms INTEGER NOT NULL,
      suite_run_id TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX idx_test_executions_test ON test_executions(test_file_path, test_name);
    CREATE INDEX idx_test_executions_timestamp ON test_executions(timestamp);
    CREATE INDEX idx_test_executions_suite ON test_executions(suite_run_id);

    -- Test drift classifications
    CREATE TABLE IF NOT EXISTS test_drift_classifications (
      id TEXT PRIMARY KEY,
      test_file_path TEXT NOT NULL,
      test_name TEXT NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('test-drift', 'real-regression')),
      confidence REAL NOT NULL,
      evidence_json TEXT NOT NULL,
      suggested_fix TEXT,
      classified_at TEXT NOT NULL
    );

    CREATE INDEX idx_test_drift_test ON test_drift_classifications(test_file_path, test_name);

    -- ═══════════════════════════════════════════════════════════════
    -- Category C: Drift Management
    -- ═══════════════════════════════════════════════════════════════

    -- Drift recovery attempts
    CREATE TABLE IF NOT EXISTS drift_recovery_attempts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      forked_session_id TEXT,
      checkpoint_id TEXT,
      category TEXT NOT NULL CHECK(category IN ('agent-drift', 'test-drift', 'specification-drift', 'context-drift')),
      outcome TEXT NOT NULL CHECK(outcome IN ('pending', 'success', 'failed', 'skipped')),
      timestamp TEXT NOT NULL
    );

    CREATE INDEX idx_drift_recovery_session ON drift_recovery_attempts(session_id);
  `);
}
