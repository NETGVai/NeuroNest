import type Database from 'better-sqlite3';

export const version = 36;
export const description = 'Feature integration: artifacts, checkpoints, execution traces, benchmarks';

export function up(db: Database.Database): void {
  db.exec(`
    -- Artifacts table
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('code-bundle', 'document', 'spreadsheet-data', 'diagram', 'generated-app')),
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_dir);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);

    -- Artifact checkpoints (versions)
    CREATE TABLE IF NOT EXISTS artifact_checkpoints (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content BLOB NOT NULL,
      diff TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
      UNIQUE (artifact_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_artifact ON artifact_checkpoints(artifact_id);

    -- Execution traces
    CREATE TABLE IF NOT EXISTS execution_traces (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      total_duration_ms INTEGER,
      total_tokens INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Trace entries
    CREATE TABLE IF NOT EXISTS trace_entries (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('tool-call', 'llm-request', 'decision', 'result', 'error')),
      tool_name TEXT,
      parameters TEXT,
      token_count INTEGER,
      duration_ms INTEGER,
      result TEXT,
      error TEXT,
      FOREIGN KEY (trace_id) REFERENCES execution_traces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_trace_entries_trace ON trace_entries(trace_id);

    -- Benchmark runs
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    -- Benchmark results
    CREATE TABLE IF NOT EXISTS benchmark_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      configuration_id TEXT NOT NULL,
      tokens_consumed INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      tool_call_iterations INTEGER NOT NULL,
      quality_score REAL,
      output TEXT,
      FOREIGN KEY (run_id) REFERENCES benchmark_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_bench_results_run ON benchmark_results(run_id);
  `);
}
