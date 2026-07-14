import type Database from 'better-sqlite3';

export const version = 43;
export const description = 'Semantic index: vector embedding-based codebase search (semantic_chunks table)';

export function up(db: Database.Database): void {
  db.exec(`
    -- Semantic Index: stores AST-chunked code with vector embeddings for semantic search
    -- Requirements: 2.3, 2.7
    CREATE TABLE IF NOT EXISTS semantic_chunks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      chunk_name TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sc_project_file ON semantic_chunks(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_sc_project_hash ON semantic_chunks(project_id, file_hash);
  `);
}
