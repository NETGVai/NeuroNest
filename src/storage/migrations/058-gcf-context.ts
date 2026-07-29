/**
 * Global Context Framework (GCF): SQLite schema for context persistence,
 * drift reconciliation, AST symbol indexing, code graph, edit history,
 * semantic embeddings, and incremental dependency tracking.
 *
 * Creates:
 *   - `gcf_context_entries` — core context entries with priority and status
 *   - `gcf_drift_events` — drift conflict log between agents
 *   - `gcf_symbols` — AST symbol index (functions, classes, etc.)
 *   - `gcf_code_edges` — code graph dependency edges
 *   - `gcf_edit_history` — rolling edit history with diffs
 *   - `gcf_embeddings` — semantic embedding vectors for symbols
 *   - `gcf_dependency_map` — incremental context dependency tracking
 *
 * Requirements: 4.1, 4.3, 4.5, 6.4, 11.6, 16.5
 */
import type Database from 'better-sqlite3';

export const version = 58;
export const description = 'Global Context Framework tables and indexes';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Core context entries
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gcf_context_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('file', 'url', 'agent_generated')),
      source TEXT NOT NULL,
      content TEXT,
      hash TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'active' CHECK(priority IN ('pinned', 'active', 'background')),
      producer_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stale', 'parse_error')),
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      prompts_since_access INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, source)
    );

    CREATE INDEX IF NOT EXISTS idx_gcf_entries_session ON gcf_context_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_gcf_entries_type ON gcf_context_entries(session_id, type);
    CREATE INDEX IF NOT EXISTS idx_gcf_entries_priority ON gcf_context_entries(session_id, priority);
    CREATE INDEX IF NOT EXISTS idx_gcf_entries_accessed ON gcf_context_entries(last_accessed_at);

    -- ═══════════════════════════════════════════════════════════════
    -- Drift conflict log
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gcf_drift_events (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      agent1_id TEXT NOT NULL,
      agent2_id TEXT NOT NULL,
      value1_hash TEXT NOT NULL,
      value2_hash TEXT NOT NULL,
      resolved_value TEXT NOT NULL DEFAULT 'latest',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES gcf_context_entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gcf_drift_entry ON gcf_drift_events(entry_id);
    CREATE INDEX IF NOT EXISTS idx_gcf_drift_time ON gcf_drift_events(timestamp);

    -- ═══════════════════════════════════════════════════════════════
    -- AST symbol index
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gcf_symbols (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      parameters_json TEXT,
      return_type TEXT,
      exported INTEGER NOT NULL DEFAULT 0,
      signature TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gcf_symbols_file ON gcf_symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_gcf_symbols_name ON gcf_symbols(name);
    CREATE INDEX IF NOT EXISTS idx_gcf_symbols_session ON gcf_symbols(session_id);

    -- ═══════════════════════════════════════════════════════════════
    -- Code graph edges
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gcf_code_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_symbol TEXT NOT NULL,
      to_symbol TEXT NOT NULL,
      edge_type TEXT NOT NULL CHECK(edge_type IN ('import', 'call', 'inherit', 'type_ref')),
      session_id TEXT NOT NULL,
      FOREIGN KEY (from_symbol) REFERENCES gcf_symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (to_symbol) REFERENCES gcf_symbols(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gcf_edges_from ON gcf_code_edges(from_symbol);
    CREATE INDEX IF NOT EXISTS idx_gcf_edges_to ON gcf_code_edges(to_symbol);

    -- ═══════════════════════════════════════════════════════════════
    -- Edit history
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gcf_edit_history (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      diff TEXT NOT NULL,
      actor TEXT NOT NULL,
      reverted INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      diff_size_bytes INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gcf_edits_session ON gcf_edit_history(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_gcf_edits_file ON gcf_edit_history(file_path);

    -- ═══════════════════════════════════════════════════════════════
    -- Semantic embeddings (vector store)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gcf_embeddings (
      symbol_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model_version TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (symbol_id) REFERENCES gcf_symbols(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Incremental context dependency map
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS gcf_dependency_map (
      source_file TEXT NOT NULL,
      dependent_entry_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (source_file, dependent_entry_id),
      FOREIGN KEY (dependent_entry_id) REFERENCES gcf_context_entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gcf_deps_file ON gcf_dependency_map(source_file);
  `);
}
