/**
 * Vector Store — LanceDB-backed vector persistence for SemanticIndex
 *
 * Initializes a LanceDB database per project at `~/.neuronest/projects/{projectId}/index/`.
 * Implements CRUD: insert chunks, delete by file path, search by query vector.
 * Provides cosine similarity search with top-K results (default K=10).
 *
 * Falls back to an in-memory brute-force implementation when LanceDB is unavailable,
 * allowing the module to work during development and testing without the native dependency.
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 *
 * Requirements: 2.3
 */

import * as path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

import type { SemanticChunk } from './tree-sitter-chunker.js';

// ─── Types ──────────────────────────────────────────────────────

/** A record stored in the vector database */
export interface VectorRecord {
  /** Unique identifier for the chunk */
  id: string;
  /** Project identifier */
  projectId: string;
  /** Absolute path to the source file */
  filePath: string;
  /** SHA-256 hash of the file content */
  fileHash: string;
  /** Type of semantic unit: function, class, method, block */
  chunkType: string;
  /** Name of the semantic unit */
  chunkName: string;
  /** 1-indexed start line */
  startLine: number;
  /** 1-indexed end line */
  endLine: number;
  /** The source code content */
  content: string;
  /** Float32 embedding vector */
  embedding: Float32Array;
}

/** Search result returned from vector similarity search */
export interface VectorSearchResult {
  /** Chunk identifier */
  id: string;
  /** File path of the chunk */
  filePath: string;
  /** Source code content */
  content: string;
  /** Chunk name (function/class/method name) */
  chunkName: string;
  /** Chunk type */
  chunkType: string;
  /** 1-indexed start line */
  startLine: number;
  /** 1-indexed end line */
  endLine: number;
  /** Cosine similarity score (0 to 1) */
  similarity: number;
}

/** Configuration for the vector store */
export interface VectorStoreConfig {
  /** Project ID for database isolation */
  projectId: string;
  /** Base directory for index storage (default: ~/.neuronest/projects) */
  baseDir?: string;
  /** Embedding vector dimensions (default: 384) */
  dimensions?: number;
  /** Default number of results for search (default: 10) */
  defaultTopK?: number;
}

/** Interface for the vector store backend (allows swapping implementations) */
export interface VectorStoreBackend {
  /** Insert or update vector records */
  upsert(records: VectorRecord[]): Promise<void>;
  /** Delete all records for a given file path */
  deleteByFilePath(filePath: string): Promise<number>;
  /** Search for similar vectors and return top-K results */
  search(queryVector: Float32Array, topK: number): Promise<VectorSearchResult[]>;
  /** Get total record count */
  count(): Promise<number>;
  /** Close the database connection */
  close(): Promise<void>;
}

// ─── Cosine Similarity ──────────────────────────────────────────

/**
 * Compute cosine similarity between two Float32Array vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

// ─── In-Memory Backend (Fallback) ───────────────────────────────

/**
 * In-memory vector store backend using brute-force cosine similarity.
 * Used as a fallback when LanceDB is not available, and for testing.
 */
export class InMemoryVectorBackend implements VectorStoreBackend {
  private records: Map<string, VectorRecord> = new Map();

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    let deleted = 0;
    for (const [id, record] of this.records) {
      if (record.filePath === filePath) {
        this.records.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async search(queryVector: Float32Array, topK: number): Promise<VectorSearchResult[]> {
    const scored: VectorSearchResult[] = [];

    for (const record of this.records.values()) {
      const similarity = cosineSimilarity(queryVector, record.embedding);
      scored.push({
        id: record.id,
        filePath: record.filePath,
        content: record.content,
        chunkName: record.chunkName,
        chunkType: record.chunkType,
        startLine: record.startLine,
        endLine: record.endLine,
        similarity,
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
 * LanceDB-backed vector store backend.
 * Uses LanceDB's native vector search with cosine distance metric.
 *
 * Database is initialized lazily at the project-specific path:
 * `~/.neuronest/projects/{projectId}/index/`
 */
export class LanceDBVectorBackend implements VectorStoreBackend {
  private db: any = null;
  private table: any = null;
  private dbPath: string;
  private dimensions: number;
  private tableName = 'semantic_chunks';
  private initPromise: Promise<void> | null = null;

  constructor(dbPath: string, dimensions: number) {
    this.dbPath = dbPath;
    this.dimensions = dimensions;
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
    // Ensure the directory exists
    if (!existsSync(this.dbPath)) {
      mkdirSync(this.dbPath, { recursive: true });
    }

    try {
      // Dynamic import for lancedb (may not be installed)
      const lancedb = await import('lancedb');
      this.db = await lancedb.connect(this.dbPath);

      // Check if table exists, create if not
      const tableNames = await this.db.tableNames();
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
      } else {
        // Create table with initial schema by inserting a dummy record and deleting it
        // LanceDB requires at least one record to create a table with schema
        this.table = await this.db.createTable(this.tableName, [
          {
            id: '__schema_init__',
            project_id: '',
            file_path: '',
            file_hash: '',
            chunk_type: '',
            chunk_name: '',
            start_line: 0,
            end_line: 0,
            content: '',
            embedding: new Array(this.dimensions).fill(0),
          },
        ]);
        // Delete the schema init record
        await this.table.delete('id = "__schema_init__"');
      }
    } catch (error) {
      // If LanceDB import fails, this backend cannot function
      throw new Error(
        `Failed to initialize LanceDB at ${this.dbPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    await this.ensureInitialized();

    if (records.length === 0) return;

    // Convert VectorRecord to LanceDB row format
    const rows = records.map((record) => ({
      id: record.id,
      project_id: record.projectId,
      file_path: record.filePath,
      file_hash: record.fileHash,
      chunk_type: record.chunkType,
      chunk_name: record.chunkName,
      start_line: record.startLine,
      end_line: record.endLine,
      content: record.content,
      embedding: Array.from(record.embedding),
    }));

    // Delete existing records by ID to handle upsert
    const ids = records.map((r) => r.id);
    for (const id of ids) {
      try {
        await this.table.delete(`id = "${id}"`);
      } catch {
        // Record may not exist, that's fine
      }
    }

    // Insert new records
    await this.table.add(rows);
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    await this.ensureInitialized();

    // Count records before deletion
    const beforeCount = await this.count();

    // LanceDB uses SQL-like filter expressions
    const escapedPath = filePath.replace(/'/g, "''");
    await this.table.delete(`file_path = '${escapedPath}'`);

    const afterCount = await this.count();
    return beforeCount - afterCount;
  }

  async search(queryVector: Float32Array, topK: number): Promise<VectorSearchResult[]> {
    await this.ensureInitialized();

    const count = await this.count();
    if (count === 0) return [];

    try {
      // LanceDB native vector search with cosine distance
      const results = await this.table
        .search(Array.from(queryVector))
        .metricType('cosine')
        .limit(topK)
        .toArray();

      return results.map((row: any) => ({
        id: row.id,
        filePath: row.file_path,
        content: row.content,
        chunkName: row.chunk_name,
        chunkType: row.chunk_type,
        startLine: row.start_line,
        endLine: row.end_line,
        // LanceDB returns _distance (cosine distance). Similarity = 1 - distance.
        similarity: 1 - (row._distance ?? 0),
      }));
    } catch (error) {
      console.warn('[VectorStore] LanceDB search failed, falling back to empty:', error);
      return [];
    }
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    try {
      const result = await this.table.countRows();
      return result;
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

// ─── VectorStore Class ──────────────────────────────────────────

/**
 * VectorStore — Main vector persistence class for the SemanticIndex.
 *
 * Manages per-project vector databases at `~/.neuronest/projects/{projectId}/index/`.
 * Provides CRUD operations (insert chunks, delete by file path) and cosine
 * similarity search with configurable top-K results.
 *
 * Attempts to use LanceDB for production. Falls back to an in-memory backend
 * when LanceDB is not available (development/testing).
 */
export class VectorStore {
  private backend: VectorStoreBackend;
  private config: Required<VectorStoreConfig>;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: VectorStoreConfig) {
    this.config = {
      projectId: config.projectId,
      baseDir: config.baseDir ?? path.join(homedir(), '.neuronest', 'projects'),
      dimensions: config.dimensions ?? 384,
      defaultTopK: config.defaultTopK ?? 10,
    };

    // Initialize with in-memory backend by default;
    // will attempt to upgrade to LanceDB on first use
    this.backend = new InMemoryVectorBackend();
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
      const lanceBackend = new LanceDBVectorBackend(dbPath, this.config.dimensions);
      // Test the connection by attempting to get count
      await lanceBackend.count();
      this.backend = lanceBackend;
    } catch {
      // LanceDB not available; keep using in-memory backend
      console.warn(
        '[VectorStore] LanceDB not available, using in-memory fallback. ' +
          'Install lancedb for persistent vector storage.'
      );
    }

    this.initialized = true;
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Insert semantic chunks with their embeddings into the vector store.
   * Existing records with the same ID are overwritten (upsert semantics).
   */
  async insertChunks(
    chunks: SemanticChunk[],
    embeddings: Map<string, Float32Array>
  ): Promise<{ inserted: number; skipped: number }> {
    await this.ensureInitialized();

    const records: VectorRecord[] = [];
    let skipped = 0;

    for (const chunk of chunks) {
      const embedding = embeddings.get(chunk.id);
      if (!embedding) {
        skipped++;
        continue;
      }

      if (embedding.length !== this.config.dimensions) {
        skipped++;
        continue;
      }

      records.push({
        id: chunk.id,
        projectId: this.config.projectId,
        filePath: chunk.filePath,
        fileHash: chunk.fileHash,
        chunkType: chunk.chunkType,
        chunkName: chunk.chunkName,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        embedding,
      });
    }

    if (records.length > 0) {
      await this.backend.upsert(records);
    }

    return { inserted: records.length, skipped };
  }

  /**
   * Delete all vector records associated with a given file path.
   * Used during incremental re-indexing when a file has changed.
   * Returns the number of records deleted.
   */
  async deleteByFilePath(filePath: string): Promise<number> {
    await this.ensureInitialized();
    return this.backend.deleteByFilePath(filePath);
  }

  /**
   * Search for the most similar chunks to a query vector.
   * Returns top-K results sorted by descending cosine similarity.
   *
   * @param queryVector - The embedding vector for the search query
   * @param topK - Number of results to return (default: config.defaultTopK, usually 10)
   */
  async search(queryVector: Float32Array, topK?: number): Promise<VectorSearchResult[]> {
    await this.ensureInitialized();

    const k = topK ?? this.config.defaultTopK;

    if (queryVector.length !== this.config.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.config.dimensions}, got ${queryVector.length}`
      );
    }

    return this.backend.search(queryVector, k);
  }

  /**
   * Get the total number of stored vectors.
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
   * Get the database path for this project.
   */
  getDbPath(): string {
    return path.join(this.config.baseDir, this.config.projectId, 'index');
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
  getBackend(): VectorStoreBackend {
    return this.backend;
  }

  /**
   * Check if the store is using LanceDB or the in-memory fallback.
   */
  isUsingLanceDB(): boolean {
    return this.backend instanceof LanceDBVectorBackend;
  }
}

// ─── Singleton Management ───────────────────────────────────────

/** Map of project IDs to VectorStore instances */
const instances: Map<string, VectorStore> = new Map();

/**
 * Get or create a VectorStore instance for a given project.
 * Each project gets its own isolated vector database.
 * Follows NeuroNest's lazy-initialized singleton pattern.
 */
export function getVectorStore(config: VectorStoreConfig): VectorStore {
  const existing = instances.get(config.projectId);
  if (existing) return existing;

  const store = new VectorStore(config);
  instances.set(config.projectId, store);
  return store;
}

/**
 * Close and remove a specific project's vector store.
 */
export async function closeVectorStore(projectId: string): Promise<void> {
  const store = instances.get(projectId);
  if (store) {
    await store.close();
    instances.delete(projectId);
  }
}

/**
 * Close all vector store instances.
 */
export async function closeAllVectorStores(): Promise<void> {
  for (const [id, store] of instances) {
    await store.close();
    instances.delete(id);
  }
}

/**
 * Reset all singletons (for testing purposes).
 */
export function resetVectorStores(): void {
  instances.clear();
}
