/**
 * Knowledge Base System: SQLite schema for source configuration,
 * chunk metadata, freshness tracking, and embedding model config.
 *
 * Creates:
 *   - `kb_sources` — knowledge source configuration and status
 *   - `kb_chunk_metadata` — chunk metadata (embeddings stored in LanceDB)
 *   - `kb_freshness` — source freshness/staleness tracking
 *   - `kb_embedding_config` — per-project embedding model configuration
 *
 * Requirements: 28.1, 28.3, 28.4, 27.4
 */
import type Database from 'better-sqlite3';

export const version = 59;
export const description = 'Knowledge Base system tables and indexes';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Knowledge Source Configuration
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS kb_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'local-files', 'git-repository', 'url-website', 'pdf-document',
        'docx-document', 'csv-file', 'json-file', 'markdown-wiki'
      )),
      uri TEXT NOT NULL,
      label TEXT,
      config_json TEXT NOT NULL,
      security_profile_json TEXT NOT NULL,
      schedule TEXT NOT NULL DEFAULT 'manual' CHECK(schedule IN ('manual', 'on-change', 'hourly', 'daily')),
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'indexing', 'error', 'auth-failed')),
      auth_credential_id TEXT,
      last_synced_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, uri)
    );

    CREATE INDEX IF NOT EXISTS idx_kb_sources_project ON kb_sources(project_id);
    CREATE INDEX IF NOT EXISTS idx_kb_sources_status ON kb_sources(project_id, status);

    -- ═══════════════════════════════════════════════════════════════
    -- Chunk Metadata (LanceDB stores embeddings; SQLite stores metadata)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS kb_chunk_metadata (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      llm_token_count INTEGER NOT NULL,
      source_uri TEXT NOT NULL,
      heading TEXT,
      language TEXT,
      line_start INTEGER,
      line_end INTEGER,
      continuation_group_id TEXT,
      indexed_at INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunk_metadata(source_id);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_project ON kb_chunk_metadata(project_id);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_hash ON kb_chunk_metadata(content_hash);

    -- ═══════════════════════════════════════════════════════════════
    -- Freshness Tracking
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS kb_freshness (
      source_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'fresh' CHECK(state IN ('fresh', 'stale', 're-indexing')),
      detection_method TEXT NOT NULL,
      previous_hash TEXT,
      current_hash TEXT,
      last_checked_at INTEGER NOT NULL,
      last_changed_at INTEGER,
      FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Embedding Model Config (per project)
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS kb_embedding_config (
      project_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('ollama', 'openai', 'onnx-local')),
      dimensions INTEGER NOT NULL DEFAULT 384,
      updated_at INTEGER NOT NULL
    );
  `);
}
