import type Database from 'better-sqlite3';

export const version = 25;
export const description = 'Incremental indexing tables';

export function up(db: Database.Database): void {
  db.exec(`
    -- File provenance: tracks per-file indexing state
    CREATE TABLE IF NOT EXISTS file_provenance (
      file_path TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      last_indexed_at INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'indexed',
      file_size INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_file_provenance_project ON file_provenance(project_id);
    CREATE INDEX IF NOT EXISTS idx_file_provenance_hash ON file_provenance(content_hash);

    -- Semantic chunks: AST-derived code units
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      project_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_scope TEXT,
      language TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_kind ON chunks(kind);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

    -- Embeddings: vector storage for semantic search
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      project_id TEXT NOT NULL,
      vector BLOB NOT NULL,
      content_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL DEFAULT 384,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_file ON embeddings(file_path);
    CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id);

    -- Call graph nodes: functions/methods in the project
    CREATE TABLE IF NOT EXISTS call_graph_nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      signature TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_file ON call_graph_nodes(file_path);
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_project ON call_graph_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_name ON call_graph_nodes(name);

    -- Call graph edges: caller -> callee relationships
    CREATE TABLE IF NOT EXISTS call_graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id TEXT NOT NULL REFERENCES call_graph_nodes(id) ON DELETE CASCADE,
      callee_id TEXT NOT NULL REFERENCES call_graph_nodes(id) ON DELETE CASCADE,
      call_site_line INTEGER NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'RESOLVED',
      project_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cg_edges_caller ON call_graph_edges(caller_id);
    CREATE INDEX IF NOT EXISTS idx_cg_edges_callee ON call_graph_edges(callee_id);
    CREATE INDEX IF NOT EXISTS idx_cg_edges_project ON call_graph_edges(project_id);

    -- Data lineage: source traceability for every graph node
    CREATE TABLE IF NOT EXISTS lineage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      commit_hash TEXT,
      is_stale INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_lineage_node ON lineage(node_id);
    CREATE INDEX IF NOT EXISTS idx_lineage_file ON lineage(file_path);
    CREATE INDEX IF NOT EXISTS idx_lineage_project ON lineage(project_id);
    CREATE INDEX IF NOT EXISTS idx_lineage_stale ON lineage(is_stale) WHERE is_stale = 1;

    -- Transformation cache: memoized agent results
    CREATE TABLE IF NOT EXISTS transformation_cache (
      cache_key TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      result_blob TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_accessed INTEGER NOT NULL DEFAULT (unixepoch()),
      source_chunk_ids TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      is_stale INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tcache_project ON transformation_cache(project_id);
    CREATE INDEX IF NOT EXISTS idx_tcache_accessed ON transformation_cache(last_accessed);
    CREATE INDEX IF NOT EXISTS idx_tcache_stale ON transformation_cache(is_stale);
  `);
}
