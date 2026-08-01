/**
 * KB Vector Store — LanceDB-backed vector persistence for the Knowledge Base subsystem.
 *
 * Provides per-project vector storage using LanceDB tables named `kb_chunks_{project_id_hash}`
 * to avoid collisions with existing `gcf_` prefixed tables used by the GCF SemanticSearchIndex.
 *
 * Features:
 *   - Per-project table isolation via hashed project ID table names
 *   - Upsert semantics based on content_hash deduplication
 *   - Cosine similarity search for retrieval
 *   - Bulk deletion by source_id for source removal
 *   - In-memory fallback when LanceDB is unavailable (dev/testing)
 *
 * Requirements: 2.3, 36.3, 38.4
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────

/** A vector record stored in the KB LanceDB table */
export interface KBVectorRecord {
  /** Unique chunk identifier (uuidv7) */
  id: string;
  /** Project namespace identifier */
  project_id: string;
  /** Foreign key to kb_sources table */
  source_id: string;
  /** Original source URI */
  source_uri: string;
  /** Zero-based index of chunk within source document */
  chunk_index: number;
  /** Raw chunk text content */
  content: string;
  /** SHA-256 hash of content for deduplication */
  content_hash: string;
  /** Float32 embedding vector */
  embedding: Float32Array;
  /** Links chunks that were split from an oversized atomic unit */
  continuation_group_id?: string;
}

/** Search result from KB vector similarity search */
export interface KBVectorSearchResult {
  /** Chunk identifier */
  id: string;
  /** Source ID (FK to kb_sources) */
  source_id: string;
  /** Original source URI */
  source_uri: string;
  /** Chunk index within source */
  chunk_index: number;
  /** Raw chunk text content */
  content: string;
  /** Content hash */
  content_hash: string;
  /** Cosine similarity score (0 to 1) */
  similarity: number;
  /** Continuation group ID if part of a split */
  continuation_group_id?: string;
}

/** Configuration for the KB vector store */
export interface KBVectorStoreConfig {
  /** Project ID for table isolation */
  projectId: string;
  /** Base directory for LanceDB storage (default: ~/.neuronest/projects) */
  baseDir?: string;
  /** Embedding vector dimensions (default: 384) */
  dimensions?: number;
  /** Default number of search results (default: 10) */
  defaultTopK?: number;
}

/** Interface for KB vector store backends (allows swapping implementations) */
export interface KBVectorStoreBackend {
  /** Insert or update vector records (upsert by content_hash) */
  upsert(records: KBVectorRecord[]): Promise<{ inserted: number; updated: number }>;
  /** Delete all records for a given source_id */
  deleteBySourceId(sourceId: string): Promise<number>;
  /** Search for similar vectors with cosine similarity */
  search(queryVector: Float32Array, topK: number): Promise<KBVectorSearchResult[]>;
  /** Get total record count */
  count(): Promise<number>;
  /** Close the backend and release resources */
  close(): Promise<void>;
}

// ─── Cosine Similarity ──────────────────────────────────────────

/**
 * Compute cosine similarity between two Float32Array vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function kbCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
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
  if (magnitude === 0) return 0;

  return dot / magnitude;
}

// ─── Table Naming ───────────────────────────────────────────────

/**
 * Generate a LanceDB table name for a project's KB chunks.
 * Uses `kb_chunks_{first_12_chars_of_sha256(project_id)}` to:
 *   1. Avoid collisions with existing `gcf_` prefixed tables
 *   2. Keep table names filesystem-safe and bounded in length
 *   3. Provide per-project isolation
 */
export function getKBTableName(projectId: string): string {
  const hash = createHash('sha256').update(projectId, 'utf-8').digest('hex').slice(0, 12);
  return `kb_chunks_${hash}`;
}

// ─── In-Memory Backend (Fallback / Testing) ─────────────────────

/**
 * In-memory KB vector store backend using brute-force cosine similarity.
 * Used as a fallback when LanceDB is not available, and for unit testing.
 */
export class KBInMemoryVectorBackend implements KBVectorStoreBackend {
  private records: Map<string, KBVectorRecord> = new Map();

  async upsert(records: KBVectorRecord[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;

    for (const record of records) {
      // Check if a record with same content_hash already exists
      let existingId: string | null = null;
      for (const [id, existing] of this.records) {
        if (existing.content_hash === record.content_hash && existing.project_id === record.project_id) {
          existingId = id;
          break;
        }
      }

      if (existingId && existingId !== record.id) {
        // Update: remove old record, insert new one
        this.records.delete(existingId);
        this.records.set(record.id, record);
        updated++;
      } else if (this.records.has(record.id)) {
        // Update existing record by same ID
        this.records.set(record.id, record);
        updated++;
      } else {
        // Insert new record
        this.records.set(record.id, record);
        inserted++;
      }
    }

    return { inserted, updated };
  }

  async deleteBySourceId(sourceId: string): Promise<number> {
    let deleted = 0;
    for (const [id, record] of this.records) {
      if (record.source_id === sourceId) {
        this.records.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async search(queryVector: Float32Array, topK: number): Promise<KBVectorSearchResult[]> {
    const scored: KBVectorSearchResult[] = [];

    for (const record of this.records.values()) {
      const similarity = kbCosineSimilarity(queryVector, record.embedding);
      scored.push({
        id: record.id,
        source_id: record.source_id,
        source_uri: record.source_uri,
        chunk_index: record.chunk_index,
        content: record.content,
        content_hash: record.content_hash,
        similarity,
        continuation_group_id: record.continuation_group_id,
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async close(): Promise<void> {
    this.records.clear();
  }
}

// ─── LanceDB Backend ────────────────────────────────────────────

/**
 * LanceDB-backed KB vector store backend.
 * Uses per-project table naming `kb_chunks_{hash}` for isolation.
 *
 * Database is initialized lazily at the project-specific path:
 * `~/.neuronest/projects/{projectId}/index/`
 */
export class KBLanceDBVectorBackend implements KBVectorStoreBackend {
  private db: any = null;
  private table: any = null;
  private dbPath: string;
  private dimensions: number;
  private tableName: string;
  private initPromise: Promise<void> | null = null;

  constructor(dbPath: string, dimensions: number, tableName: string) {
    this.dbPath = dbPath;
    this.dimensions = dimensions;
    this.tableName = tableName;
  }

  /**
   * Lazily initialize the LanceDB connection and table.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.db && this.table) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    if (!existsSync(this.dbPath)) {
      mkdirSync(this.dbPath, { recursive: true });
    }

    try {
      const lancedb = await import('lancedb');
      this.db = await lancedb.connect(this.dbPath);

      const tableNames = await this.db.tableNames();
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
      } else {
        // Create table with schema via a dummy record
        this.table = await this.db.createTable(this.tableName, [
          {
            id: '__schema_init__',
            project_id: '',
            source_id: '',
            source_uri: '',
            chunk_index: 0,
            content: '',
            content_hash: '',
            embedding: new Array(this.dimensions).fill(0),
            continuation_group_id: '',
          },
        ]);
        // Remove schema init record
        await this.table.delete('id = "__schema_init__"');
      }
    } catch (error) {
      throw new Error(
        `Failed to initialize KB LanceDB at ${this.dbPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async upsert(records: KBVectorRecord[]): Promise<{ inserted: number; updated: number }> {
    await this.ensureInitialized();

    if (records.length === 0) return { inserted: 0, updated: 0 };

    let updated = 0;

    // Delete existing records with matching content_hash (deduplication)
    for (const record of records) {
      try {
        const escapedHash = record.content_hash.replace(/'/g, "''");
        await this.table.delete(`content_hash = '${escapedHash}'`);
        // If we deleted something, it's an update
        // Note: we can't perfectly track insert vs update in LanceDB without extra queries,
        // so we approximate — new inserts may also match on ID
      } catch {
        // Record may not exist, that's fine
      }
    }

    // Also delete by ID to handle re-inserts of same chunk ID with different content
    for (const record of records) {
      try {
        await this.table.delete(`id = '${record.id}'`);
        updated++;
      } catch {
        // Record may not exist
      }
    }

    // Convert records to LanceDB row format
    const rows = records.map((record) => ({
      id: record.id,
      project_id: record.project_id,
      source_id: record.source_id,
      source_uri: record.source_uri,
      chunk_index: record.chunk_index,
      content: record.content,
      content_hash: record.content_hash,
      embedding: Array.from(record.embedding),
      continuation_group_id: record.continuation_group_id ?? '',
    }));

    await this.table.add(rows);

    // Approximate: anything we deleted by ID was an update
    const inserted = records.length - updated;
    return { inserted: Math.max(inserted, 0), updated };
  }

  async deleteBySourceId(sourceId: string): Promise<number> {
    await this.ensureInitialized();

    const beforeCount = await this.count();
    const escapedSourceId = sourceId.replace(/'/g, "''");
    await this.table.delete(`source_id = '${escapedSourceId}'`);
    const afterCount = await this.count();

    return beforeCount - afterCount;
  }

  async search(queryVector: Float32Array, topK: number): Promise<KBVectorSearchResult[]> {
    await this.ensureInitialized();

    const count = await this.count();
    if (count === 0) return [];

    try {
      const results = await this.table
        .search(Array.from(queryVector))
        .metricType('cosine')
        .limit(topK)
        .toArray();

      return results.map((row: any) => ({
        id: row.id,
        source_id: row.source_id,
        source_uri: row.source_uri,
        chunk_index: row.chunk_index,
        content: row.content,
        content_hash: row.content_hash,
        // LanceDB returns _distance (cosine distance). Similarity = 1 - distance.
        similarity: 1 - (row._distance ?? 0),
        continuation_group_id: row.continuation_group_id || undefined,
      }));
    } catch (error) {
      console.warn('[KBVectorStore] LanceDB search failed, returning empty:', error);
      return [];
    }
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    try {
      return await this.table.countRows();
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}

// ─── KBVectorStore Class ────────────────────────────────────────

/**
 * KBVectorStore — Main vector persistence class for the Knowledge Base subsystem.
 *
 * Manages per-project vector databases using LanceDB tables named `kb_chunks_{hash}`.
 * This naming convention avoids collisions with existing `gcf_` prefixed tables
 * used by the GCF SemanticSearchIndex.
 *
 * Features:
 *   - Upsert semantics: records with matching content_hash are updated
 *   - Cosine similarity search
 *   - Deletion by source_id for full source removal
 *   - In-memory fallback when LanceDB is unavailable
 *
 * Usage:
 *   const store = new KBVectorStore({ projectId: 'my-project' });
 *   await store.upsert([...records]);
 *   const results = await store.search(queryEmbedding, 10);
 *   await store.deleteBySourceId('source-123');
 */
export class KBVectorStore {
  private backend: KBVectorStoreBackend;
  private config: Required<KBVectorStoreConfig>;
  private tableName: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: KBVectorStoreConfig) {
    this.config = {
      projectId: config.projectId,
      baseDir: config.baseDir ?? path.join(homedir(), '.neuronest', 'projects'),
      dimensions: config.dimensions ?? 384,
      defaultTopK: config.defaultTopK ?? 10,
    };

    this.tableName = getKBTableName(this.config.projectId);

    // Start with in-memory backend; will attempt upgrade to LanceDB on first use
    this.backend = new KBInMemoryVectorBackend();
  }

  /**
   * Lazily initialize the store, attempting to connect to LanceDB.
   * Falls back to in-memory if LanceDB is unavailable.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const dbPath = this.getDbPath();

    try {
      const lanceBackend = new KBLanceDBVectorBackend(dbPath, this.config.dimensions, this.tableName);
      // Test the connection
      await lanceBackend.count();
      this.backend = lanceBackend;
    } catch {
      // LanceDB not available; keep using in-memory backend
      console.warn(
        '[KBVectorStore] LanceDB not available, using in-memory fallback. ' +
          'Install lancedb for persistent KB vector storage.',
      );
    }

    this.initialized = true;
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Upsert chunk vectors into the store.
   * Records with matching content_hash are updated; new records are inserted.
   *
   * @param records - Array of KB vector records to upsert
   * @returns Counts of inserted and updated records
   */
  async upsert(records: KBVectorRecord[]): Promise<{ inserted: number; updated: number }> {
    await this.ensureInitialized();

    if (records.length === 0) return { inserted: 0, updated: 0 };

    // Validate embedding dimensions
    for (const record of records) {
      if (record.embedding.length !== this.config.dimensions) {
        throw new Error(
          `Embedding dimension mismatch for chunk ${record.id}: expected ${this.config.dimensions}, got ${record.embedding.length}`,
        );
      }
    }

    return this.backend.upsert(records);
  }

  /**
   * Delete all vector records associated with a given source ID.
   * Used when a knowledge source is removed from the project.
   *
   * @param sourceId - The source_id (FK to kb_sources) to delete by
   * @returns Number of records deleted
   */
  async deleteBySourceId(sourceId: string): Promise<number> {
    await this.ensureInitialized();
    return this.backend.deleteBySourceId(sourceId);
  }

  /**
   * Search for the most similar chunks to a query embedding vector.
   * Returns top-K results sorted by descending cosine similarity.
   *
   * @param queryVector - The embedding vector for the search query
   * @param topK - Number of results to return (default: config.defaultTopK)
   * @returns Array of search results sorted by similarity
   */
  async search(queryVector: Float32Array, topK?: number): Promise<KBVectorSearchResult[]> {
    await this.ensureInitialized();

    const k = topK ?? this.config.defaultTopK;

    if (queryVector.length !== this.config.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.config.dimensions}, got ${queryVector.length}`,
      );
    }

    return this.backend.search(queryVector, k);
  }

  /**
   * Get the total number of stored vectors in this project's table.
   */
  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.backend.count();
  }

  /**
   * Close the vector store and release resources.
   */
  async close(): Promise<void> {
    await this.backend.close();
    this.initialized = false;
    this.initPromise = null;
  }

  /**
   * Get the database path for this project's KB vectors.
   */
  getDbPath(): string {
    return path.join(this.config.baseDir, this.config.projectId, 'index');
  }

  /**
   * Get the LanceDB table name for this project.
   */
  getTableName(): string {
    return this.tableName;
  }

  /**
   * Get the configured dimensions.
   */
  getDimensions(): number {
    return this.config.dimensions;
  }

  /**
   * Get the underlying backend (for testing purposes).
   */
  getBackend(): KBVectorStoreBackend {
    return this.backend;
  }

  /**
   * Check if the store is using LanceDB or the in-memory fallback.
   */
  isUsingLanceDB(): boolean {
    return this.backend instanceof KBLanceDBVectorBackend;
  }
}

// ─── Singleton Management ───────────────────────────────────────

/** Map of project IDs to KBVectorStore instances */
const kbInstances: Map<string, KBVectorStore> = new Map();

/**
 * Get or create a KBVectorStore instance for a given project.
 * Each project gets its own isolated KB vector table.
 * Follows NeuroNest's lazy-initialized singleton pattern.
 */
export function getKBVectorStore(config: KBVectorStoreConfig): KBVectorStore {
  const existing = kbInstances.get(config.projectId);
  if (existing) return existing;

  const store = new KBVectorStore(config);
  kbInstances.set(config.projectId, store);
  return store;
}

/**
 * Close and remove a specific project's KB vector store.
 */
export async function closeKBVectorStore(projectId: string): Promise<void> {
  const store = kbInstances.get(projectId);
  if (store) {
    await store.close();
    kbInstances.delete(projectId);
  }
}

/**
 * Close all KB vector store instances.
 */
export async function closeAllKBVectorStores(): Promise<void> {
  for (const [id, store] of kbInstances) {
    await store.close();
    kbInstances.delete(id);
  }
}

/**
 * Reset all KB vector store singletons (for testing purposes).
 */
export function resetKBVectorStores(): void {
  kbInstances.clear();
}
