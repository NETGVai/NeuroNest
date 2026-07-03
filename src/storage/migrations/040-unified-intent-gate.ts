/**
 * Unified Intent Gate: intent decisions telemetry, interview transcripts,
 * synthesized specs, learned patterns, stuck events, condensation log,
 * efficiency KPIs, and trajectory exports.
 *
 * Requirements: 14.4, 25.5
 */
import type Database from 'better-sqlite3';

export const version = 40;
export const description = 'Unified Intent Gate: intent decisions, interview transcripts, synthesized specs, learned patterns, stuck events, condensation log, efficiency KPIs, trajectories';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Intent classification telemetry
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS intent_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      intent TEXT NOT NULL CHECK(intent IN ('conversation','quick_action','build','ambiguous')),
      confidence REAL NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('pattern','llm','context_prior','user_override')),
      complexity TEXT CHECK(complexity IN ('trivial','medium','complex')),
      signals TEXT NOT NULL DEFAULT '[]',
      latency_ms REAL NOT NULL,
      override_intent TEXT,
      outcome_success INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(session_id, message_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_intent_decisions_session
      ON intent_decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_intent_decisions_hash
      ON intent_decisions(message_hash);

    -- ═══════════════════════════════════════════════════════════════
    -- Interview persistence
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS interview_transcripts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      complexity TEXT NOT NULL CHECK(complexity IN ('trivial','medium','complex')),
      status TEXT NOT NULL DEFAULT 'pending',
      turns TEXT NOT NULL DEFAULT '[]',
      original_message TEXT NOT NULL,
      max_questions INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_interviews_session
      ON interview_transcripts(session_id);
    CREATE INDEX IF NOT EXISTS idx_interviews_status
      ON interview_transcripts(status);

    -- ═══════════════════════════════════════════════════════════════
    -- Synthesized specs
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS synthesized_specs (
      id TEXT PRIMARY KEY,
      interview_id TEXT REFERENCES interview_transcripts(id),
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      overview TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      implementation_plan TEXT NOT NULL DEFAULT '[]',
      files_to_change TEXT NOT NULL DEFAULT '[]',
      testing_strategy TEXT NOT NULL DEFAULT '',
      suggested_mode TEXT NOT NULL DEFAULT 'standard',
      cost_estimate TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Override learning
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS learned_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      regex TEXT NOT NULL,
      intent TEXT NOT NULL,
      weight REAL NOT NULL CHECK(weight <= 0.6),
      source TEXT NOT NULL DEFAULT 'learned',
      project_id TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Stuck events log
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS stuck_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      action_hashes TEXT NOT NULL DEFAULT '[]',
      intervention_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_stuck_events_task
      ON stuck_events(task_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Condensation audit log
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS condensation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      events_condensed INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      summary_tokens INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ═══════════════════════════════════════════════════════════════
    -- KPI metrics per session
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS efficiency_kpis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      task_id TEXT,
      tokens_per_task INTEGER,
      llm_round_trips INTEGER,
      wall_time_ms INTEGER,
      wasted_tokens INTEGER,
      mechanism_flags TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_kpis_session
      ON efficiency_kpis(session_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Trajectory exports
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS trajectories (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      config_fingerprint TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      exported_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
