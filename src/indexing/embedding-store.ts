/**
 * Embedding Store
 *
 * Manages vector storage and cosine similarity search in SQLite.
 * Serializes Float32Array vectors to Buffer for BLOB storage and
 * deserializes them back on read. Implements brute-force cosine
 * similarity search returning top-K results sorted by descending similarity.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.7
 */

import type Database from 'better-sqlite3';

export interface EmbeddingRecord {
  chunkId: string;
  filePath: string;
  vector: Float32Array;
  contentHash: string;
  createdAt: number;
}

export interface SearchResult {
  chunkId: string;
  filePath: string;
  content: string;
  similarity: number;
  startLine: number;
  endLine: number;
}

export class EmbeddingStore {
  constructor(
    private db: Database.Database,
    private dimensions: number = 384
  ) {}

  /**
   * Store or update an embedding vector for a chunk.
   * Serializes the Float32Array to a raw byte Buffer for SQLite BLOB storage.
   */
  upsert(record: EmbeddingRecord): void {
    if (record.vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${record.vector.length}`
      );
    }

    const vectorBuffer = Buffer.from(record.vector.buffer, record.vector.byteOffset, record.vector.byteLength);

    const stmt = this.db.prepare(`
      INSERT INTO embeddings (chunk_id, file_path, project_id, vector, content_hash, dimensions, created_at)
      VALUES (?, ?, '', ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        file_path = excluded.file_path,
        vector = excluded.vector,
        content_hash = excluded.content_hash,
        dimensions = excluded.dimensions,
        created_at = excluded.created_at
    `);

    stmt.run(
      record.chunkId,
      record.filePath,
      vectorBuffer,
      record.contentHash,
      this.dimensions,
      record.createdAt
    );
  }

  /**
   * Remove all embeddings for a given file path.
   */
  removeByFile(filePath: string): void {
    const stmt = this.db.prepare('DELETE FROM embeddings WHERE file_path = ?');
    stmt.run(filePath);
  }

  /**
   * Semantic search: compute cosine similarity between the query vector
   * and all stored embeddings, return top-K results sorted by descending similarity.
   * Joins with the chunks table to retrieve content, startLine, and endLine.
   */
  search(queryVector: Float32Array, topK: number, projectId?: string): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }

    let query: string;
    let params: unknown[];

    if (projectId) {
      query = 'SELECT chunk_id, file_path, vector FROM embeddings WHERE project_id = ?';
      params = [projectId];
    } else {
      query = 'SELECT chunk_id, file_path, vector FROM embeddings';
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      chunk_id: string;
      file_path: string;
      vector: Buffer;
    }>;

    // Compute cosine similarity for each stored vector
    const scored: Array<{ chunkId: string; filePath: string; similarity: number }> = [];

    for (const row of rows) {
      const storedVector = this.deserializeVector(row.vector);
      const similarity = this.cosineSimilarity(queryVector, storedVector);
      scored.push({
        chunkId: row.chunk_id,
        filePath: row.file_path,
        similarity,
      });
    }

    // Sort by descending similarity and take top-K
    scored.sort((a, b) => b.similarity - a.similarity);
    const topResults = scored.slice(0, topK);

    // Fetch chunk details for the top results
    const results: SearchResult[] = [];
    const chunkStmt = this.db.prepare(
      'SELECT content, start_line, end_line FROM chunks WHERE id = ?'
    );

    for (const item of topResults) {
      const chunk = chunkStmt.get(item.chunkId) as
        | { content: string; start_line: number; end_line: number }
        | undefined;

      results.push({
        chunkId: item.chunkId,
        filePath: item.filePath,
        content: chunk?.content ?? '',
        similarity: item.similarity,
        startLine: chunk?.start_line ?? 0,
        endLine: chunk?.end_line ?? 0,
      });
    }

    return results;
  }

  /**
   * Compute cosine similarity between two vectors.
   * Formula: dot(a, b) / (||a|| * ||b||)
   * Returns 0 if either vector has zero magnitude.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(
        `Vector length mismatch: ${a.length} vs ${b.length}`
      );
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) {
      return 0;
    }

    return dot / magnitude;
  }

  /**
   * Get the total number of stored embeddings.
   */
  getCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };
    return row.count;
  }

  /**
   * Deserialize a Buffer (SQLite BLOB) back to a Float32Array.
   */
  private deserializeVector(buffer: Buffer): Float32Array {
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    return new Float32Array(arrayBuffer);
  }
}
