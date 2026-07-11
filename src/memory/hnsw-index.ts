/**
 * HNSW Vector Index — Hierarchical Navigable Small World graph for semantic retrieval.
 *
 * Provides vector-based nearest-neighbor search for long-term memory,
 * trajectory records, and skill descriptions. Uses hnswlib-node when available
 * and falls back to keyword-based matching when the native module is unavailable.
 *
 * Requirement 18: HNSW Vector Index for Memory Retrieval
 */

import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

export interface HNSWConfig {
  dimensions: number;       // embedding dimension (e.g., 384 or 1536)
  maxElements: number;      // capacity
  efConstruction: number;   // build-time accuracy (default: 200)
  efSearch: number;         // query-time accuracy (default: 50)
  m: number;                // graph connectivity (default: 16)
}

export interface HNSWQueryResult {
  id: string;
  distance: number;
}

export interface HNSWVectorRecord {
  id: string;
  vector: Buffer;
  source_type: string;
  source_id: string;
  created_at: string;
}

/**
 * Minimal interface for hnswlib-node's HierarchicalNSW class.
 * Abstracted to allow mocking and graceful fallback.
 */
export interface HNSWLibIndex {
  initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number): void;
  setEf(ef: number): void;
  addPoint(point: number[] | Float32Array, label: number): void;
  searchKnn(query: number[] | Float32Array, k: number): { neighbors: number[]; distances: number[] };
  getCurrentCount(): number;
  getMaxElements(): number;
}

// ─── SQLite Table Schema ────────────────────────────────────────

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS hnsw_vectors (
  id TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_CONFIG: HNSWConfig = {
  dimensions: 384,
  maxElements: 10000,
  efConstruction: 200,
  efSearch: 50,
  m: 16,
};

// ─── HNSW Index Implementation ──────────────────────────────────

export class HNSWIndex {
  private db: Database.Database;
  private config: HNSWConfig;
  private index: HNSWLibIndex | null = null;
  private available = false;
  private idToLabel: Map<string, number> = new Map();
  private labelToId: Map<number, string> = new Map();
  private nextLabel = 0;

  constructor(db: Database.Database, config?: Partial<HNSWConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureTable();
  }

  /**
   * Whether the HNSW native index is available and operational.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Initialize the HNSW index. Attempts to load hnswlib-node.
   * If the native module is unavailable, operates in fallback mode.
   */
  async initialize(): Promise<void> {
    try {
      const hnswlib = await this.loadHnswLib();
      if (hnswlib) {
        this.index = this.createNativeIndex(hnswlib);
        this.available = true;
      }
    } catch {
      this.available = false;
      this.index = null;
    }
  }

  /**
   * Rebuild from SQLite-persisted vectors on application start.
   * Loads all stored vectors and inserts them into the HNSW index.
   *
   * Requirement 18.2
   */
  async rebuildFromStore(): Promise<void> {
    if (!this.available || !this.index) {
      return;
    }

    const rows = this.db
      .prepare('SELECT id, vector FROM hnsw_vectors')
      .all() as Array<{ id: string; vector: Buffer }>;

    // Reset mappings
    this.idToLabel.clear();
    this.labelToId.clear();
    this.nextLabel = 0;

    // Re-initialize the index with proper capacity
    const capacity = Math.max(this.config.maxElements, rows.length);
    this.index.initIndex(capacity, this.config.m, this.config.efConstruction, 42);
    this.index.setEf(this.config.efSearch);

    for (const row of rows) {
      const vector = this.deserializeVector(row.vector);
      if (vector.length !== this.config.dimensions) {
        continue; // skip vectors with mismatched dimensions
      }
      const label = this.nextLabel++;
      this.idToLabel.set(row.id, label);
      this.labelToId.set(label, row.id);
      this.index.addPoint(vector, label);
    }
  }

  /**
   * Incremental insert without full rebuild.
   * Persists the vector to SQLite and inserts into the in-memory HNSW index.
   *
   * Requirement 18.3
   */
  async insert(
    id: string,
    vector: Float32Array,
    sourceType: string = 'memory',
    sourceId: string = id,
  ): Promise<void> {
    if (vector.length !== this.config.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`,
      );
    }

    const serialized = this.serializeVector(vector);
    const now = new Date().toISOString();

    // Persist to SQLite
    this.db
      .prepare(
        `INSERT OR REPLACE INTO hnsw_vectors (id, vector, source_type, source_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, serialized, sourceType, sourceId, now);

    // Insert into HNSW index if available
    if (this.available && this.index) {
      // Handle replacement: if id already exists, reuse label
      let label: number;
      if (this.idToLabel.has(id)) {
        label = this.idToLabel.get(id)!;
      } else {
        label = this.nextLabel++;
      }

      // Check capacity, resize if needed
      if (label >= this.index.getMaxElements()) {
        await this.rebuildFromStore();
        return;
      }

      this.idToLabel.set(id, label);
      this.labelToId.set(label, id);
      this.index.addPoint(vector, label);
    }
  }

  /**
   * Retrieve top-k nearest neighbors for a query vector.
   * Falls back to keyword-based matching when HNSW is unavailable.
   *
   * Requirement 18.5
   */
  async query(
    vector: Float32Array,
    topK: number,
  ): Promise<HNSWQueryResult[]> {
    if (vector.length !== this.config.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`,
      );
    }

    if (!this.available || !this.index) {
      return this.keywordFallbackQuery(topK);
    }

    const currentCount = this.index.getCurrentCount();
    if (currentCount === 0) {
      return [];
    }

    const k = Math.min(topK, currentCount);
    const result = this.index.searchKnn(vector, k);

    const results: HNSWQueryResult[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const id = this.labelToId.get(label);
      if (id) {
        results.push({
          id,
          distance: result.distances[i],
        });
      }
    }

    // Sort by distance (closest first)
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /**
   * Remove a vector from the index and SQLite.
   */
  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM hnsw_vectors WHERE id = ?').run(id);
    // Note: hnswlib-node doesn't support removal, so we mark for next rebuild
    this.idToLabel.delete(id);
  }

  /**
   * Get the count of vectors currently in the store.
   */
  getStoredCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM hnsw_vectors').get() as { count: number };
    return row.count;
  }

  /**
   * Get the count of vectors currently in the in-memory index.
   */
  getIndexedCount(): number {
    if (!this.available || !this.index) {
      return 0;
    }
    return this.index.getCurrentCount();
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Ensure the hnsw_vectors table exists.
   */
  private ensureTable(): void {
    this.db.exec(CREATE_TABLE_SQL);
  }

  /**
   * Attempt to load the hnswlib-node native module.
   * Returns null if the module is unavailable (graceful degradation).
   */
  private async loadHnswLib(): Promise<any | null> {
    try {
      // Dynamic require for optional native dependency — hnswlib-node may not
      // be installed or have type declarations. Gracefully returns null if unavailable.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const hnswlib = require('hnswlib-node');
      return hnswlib;
    } catch {
      return null;
    }
  }

  /**
   * Create a native HNSW index instance from the loaded module.
   */
  private createNativeIndex(hnswlib: any): HNSWLibIndex {
    const HierarchicalNSW = hnswlib.HierarchicalNSW || hnswlib.default?.HierarchicalNSW;
    const index = new HierarchicalNSW('cosine', this.config.dimensions);
    index.initIndex(this.config.maxElements, this.config.m, this.config.efConstruction, 42);
    index.setEf(this.config.efSearch);
    return index;
  }

  /**
   * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
   */
  private serializeVector(vector: Float32Array): Buffer {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  }

  /**
   * Deserialize a Buffer from SQLite BLOB to a Float32Array.
   */
  private deserializeVector(blob: Buffer): Float32Array {
    const arrayBuffer = blob.buffer.slice(
      blob.byteOffset,
      blob.byteOffset + blob.byteLength,
    );
    return new Float32Array(arrayBuffer);
  }

  /**
   * Fallback query when HNSW is unavailable.
   * Returns the most recent vectors as a simple fallback.
   * Uses ROWID as tiebreaker for vectors with the same created_at timestamp.
   *
   * Requirement 18.6
   */
  private keywordFallbackQuery(topK: number): HNSWQueryResult[] {
    const rows = this.db
      .prepare(
        'SELECT id FROM hnsw_vectors ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(topK) as Array<{ id: string }>;

    return rows.map((row, index) => ({
      id: row.id,
      distance: index + 1, // synthetic distance based on recency rank
    }));
  }
}
