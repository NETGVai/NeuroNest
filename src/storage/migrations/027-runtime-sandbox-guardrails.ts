import type Database from 'better-sqlite3';

export const version = 27;
export const description = 'Runtime sandbox guardrails schema: cost tracking, budget limits, trace entries, rewind checkpoints, command policy audit';

export function up(db: Database.Database): void {
  // Session cost records table for per-session LLM cost tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_cost_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      is_estimated INTEGER NOT NULL DEFAULT 0,
      tool_name TEXT,
      trace_id TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_scr_session ON session_cost_records(session_id);
    CREATE INDEX IF NOT EXISTS idx_scr_model ON session_cost_records(model);
  `);

  // Session budget limits table for per-session budget enforcement
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_budget_limits (
      session_id TEXT PRIMARY KEY,
      hard_cap_usd REAL NOT NULL DEFAULT 10.00,
      warning_pct REAL NOT NULL DEFAULT 0.80,
      current_spend_usd REAL NOT NULL DEFAULT 0.00,
      status TEXT NOT NULL DEFAULT 'ok',
      updated_at TEXT NOT NULL
    );
  `);

  // Ensure pipeline_traces table exists (normally created by PipelineTraceService,
  // but we need it here since pipeline_spans references it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_traces (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      total_duration_ms INTEGER
    )
  `);

  // Ensure pipeline_spans table exists (normally created by PipelineTraceService,
  // but we need it here for the ALTER TABLE columns and indexes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_spans (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      metadata TEXT,
      parent_span_id TEXT,
      FOREIGN KEY (trace_id) REFERENCES pipeline_traces(id)
    )
  `);

  // Extend pipeline_spans with trace entry columns (safe column addition)
  const columns = db.prepare("PRAGMA table_info(pipeline_spans)").all() as { name: string }[];
  const columnNames = new Set(columns.map((col) => col.name));

  if (!columnNames.has('entry_type')) {
    db.exec(`ALTER TABLE pipeline_spans ADD COLUMN entry_type TEXT`);
  }
  if (!columnNames.has('sequence_number')) {
    db.exec(`ALTER TABLE pipeline_spans ADD COLUMN sequence_number INTEGER`);
  }
  if (!columnNames.has('structured_data')) {
    db.exec(`ALTER TABLE pipeline_spans ADD COLUMN structured_data TEXT`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ps_entry_type ON pipeline_spans(entry_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ps_sequence ON pipeline_spans(trace_id, sequence_number)`);

  // Rewind checkpoints table for prompt-level undo
  // Ensure workspace_snapshots table exists (normally created by WorkspaceCheckpointManager,
  // but needed here for the foreign key reference)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      files_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      agent_id TEXT,
      step_description TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS rewind_checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      git_head TEXT,
      snapshot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots(id)
    );

    CREATE INDEX IF NOT EXISTS idx_rc_session ON rewind_checkpoints(session_id, timestamp DESC);
  `);

  // Command policy audit table for tracking command policy decisions
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_policy_audit (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      action TEXT NOT NULL,
      matched_rule_id TEXT,
      reason TEXT,
      user_decision TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cpa_session ON command_policy_audit(session_id);
  `);
}
