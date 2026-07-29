/**
 * Semantic Search Index — Local embedding-based vector search for code symbols.
 *
 * Uses a TF-IDF bag-of-words approach to generate embedding vectors locally
 * without any network access. Embeddings are stored as binary blobs in the
 * gcf_embeddings table and persist across application restarts.
 *
 * Features:
 *   - Cosine similarity search with configurable threshold (default 0.7)
 *   - Incremental re-indexing for changed symbols only
 *   - Approximate nearest neighbor via inverted index for >50,000 symbols
 *   - Results ordered by descending similarity score
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
 */

import type Database from 'better-sqlite3';
import type { SymbolInfo, ScoredSnippet } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default similarity threshold below which results are excluded. */
const DEFAULT_THRESHOLD = 0.7;

/** Default number of top results to return. */
const DEFAULT_TOP_K = 10;

/** Dimension of embedding vectors (vocabulary size for bag-of-words). */
const EMBEDDING_DIM = 512;

/** Threshold at which approximate nearest neighbor is used. */
const ANN_THRESHOLD = 50_000;

/** Maximum candidates to evaluate in ANN narrowing phase. */
const ANN_MAX_CANDIDATES = 2000;

// ---------------------------------------------------------------------------
// Utility: Text tokenization and embedding
// ---------------------------------------------------------------------------

/**
 * Tokenizes code text into normalized terms for embedding.
 * Splits on camelCase, snake_case, punctuation, and whitespace.
 */
function tokenize(text: string): string[] {
  // Split camelCase: insert space before uppercase letters preceded by lowercase
  const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Split on non-alphanumeric, underscores, and whitespace
  const tokens = expanded.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  return tokens;
}

/**
 * Simple hash function to map a token to a bucket index within the embedding dimension.
 * Uses FNV-1a style hashing for distribution.
 */
function hashToken(token: string, dim: number): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % dim);
}

/**
 * Generates a normalized TF-IDF-like embedding vector for the given text.
 * Uses hashed bag-of-words with L2 normalization to unit length.
 */
function generateEmbedding(text: string): Float32Array {
  const tokens = tokenize(text);
  const vector = new Float32Array(EMBEDDING_DIM);

  // Count token frequencies mapped to buckets
  for (const token of tokens) {
    const bucket = hashToken(token, EMBEDDING_DIM);
    vector[bucket]! += 1;
  }

  // Apply sub-linear TF scaling: 1 + log(tf) for tf > 0
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    if (vector[i]! > 0) {
      vector[i] = 1 + Math.log(vector[i]!);
    }
  }

  // L2 normalize to unit length for cosine similarity
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    norm += vector[i]! * vector[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      vector[i] = vector[i]! / norm;
    }
  }

  return vector;
}

/**
 * Computes cosine similarity between two unit-normalized vectors.
 * Since vectors are already L2-normalized, this is simply the dot product.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/**
 * Builds a text representation of a symbol for embedding.
 * Combines name, kind, signature, parameters, and return type.
 */
function symbolToText(symbol: SymbolInfo): string {
  const parts: string[] = [
    symbol.name,
    symbol.kind,
    symbol.signature,
  ];
  if (symbol.parameters && symbol.parameters.length > 0) {
    parts.push(symbol.parameters.join(' '));
  }
  if (symbol.returnType) {
    parts.push(symbol.returnType);
  }
  return parts.join(' ');
}

/**
 * Serializes a Float32Array to a Buffer for SQLite BLOB storage.
 */
function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserializes a Buffer (from SQLite BLOB) back to a Float32Array.
 */
function bufferToEmbedding(buf: Buffer): Float32Array {
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(arrayBuffer);
}

// ---------------------------------------------------------------------------
// Inverted Index for Approximate Nearest Neighbor
// ---------------------------------------------------------------------------

/**
 * Simple inverted index mapping non-zero embedding dimensions to symbol IDs.
 * Used to narrow candidate set before full cosine similarity computation.
 */
class InvertedIndex {
  /** Maps bucket index → set of symbol IDs with non-zero values in that bucket. */
  private readonly buckets = new Map<number, Set<string>>();

  add(symbolId: string, embedding: Float32Array): void {
    for (let i = 0; i < embedding.length; i++) {
      if (embedding[i]! > 0) {
        let bucket = this.buckets.get(i);
        if (!bucket) {
          bucket = new Set();
          this.buckets.set(i, bucket);
        }
        bucket.add(symbolId);
      }
    }
  }

  remove(symbolId: string): void {
    for (const bucket of this.buckets.values()) {
      bucket.delete(symbolId);
    }
  }

  /**
   * Finds candidate symbol IDs that share non-zero dimensions with the query.
   * Returns candidates sorted by number of shared dimensions (descending).
   */
  getCandidates(queryEmbedding: Float32Array, maxCandidates: number): string[] {
    const scores = new Map<string, number>();

    // Find non-zero dimensions in query and check corresponding buckets
    for (let i = 0; i < queryEmbedding.length; i++) {
      if (queryEmbedding[i]! > 0) {
        const bucket = this.buckets.get(i);
        if (bucket) {
          for (const symbolId of bucket) {
            scores.set(symbolId, (scores.get(symbolId) ?? 0) + 1);
          }
        }
      }
    }

    // Sort by shared dimension count descending and take top candidates
    const entries = [...scores.entries()];
    entries.sort((a, b) => b[1]! - a[1]!);
    return entries.slice(0, maxCandidates).map(([id]) => id);
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    const allIds = new Set<string>();
    for (const bucket of this.buckets.values()) {
      for (const id of bucket) {
        allIds.add(id);
      }
    }
    return allIds.size;
  }
}

// ---------------------------------------------------------------------------
// Semantic Search Index
// ---------------------------------------------------------------------------

export interface SemanticSearchOptions {
  embeddingModel: string;
  persistPath: string;
  db: Database.Database;
  maxSymbols: number;
}

export class SemanticSearchIndex {
  private readonly db: Database.Database;
  private readonly modelVersion: string;
  private readonly maxSymbols: number;

  /** In-memory cache of embeddings keyed by symbol name. */
  private readonly embeddings = new Map<string, Float32Array>();

  /** In-memory cache of symbol info keyed by symbol name. */
  private readonly symbols = new Map<string, SymbolInfo>();

  /** Inverted index for approximate nearest neighbor search. */
  private readonly invertedIndex = new InvertedIndex();

  // Prepared statements
  private readonly stmtUpsertEmbedding: Database.Statement;
  private readonly stmtUpsertSymbol: Database.Statement;
  private readonly stmtDeleteEmbedding: Database.Statement;
  private readonly stmtDeleteSymbol: Database.Statement;
  private readonly stmtGetAllEmbeddings: Database.Statement;

  constructor(options: SemanticSearchOptions) {
    this.db = options.db;
    this.modelVersion = options.embeddingModel;
    this.maxSymbols = options.maxSymbols;

    // Prepare SQL statements for gcf_symbols (required by foreign key on gcf_embeddings)
    this.stmtUpsertSymbol = this.db.prepare(`
      INSERT INTO gcf_symbols (id, file_path, name, kind, line_start, line_end, parameters_json, return_type, exported, signature, session_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        name = excluded.name,
        kind = excluded.kind,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        parameters_json = excluded.parameters_json,
        return_type = excluded.return_type,
        exported = excluded.exported,
        signature = excluded.signature,
        updated_at = excluded.updated_at
    `);

    this.stmtDeleteSymbol = this.db.prepare(`
      DELETE FROM gcf_symbols WHERE id = ?
    `);

    // Prepare SQL statements for gcf_embeddings
    this.stmtUpsertEmbedding = this.db.prepare(`
      INSERT INTO gcf_embeddings (symbol_id, embedding, model_version, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol_id) DO UPDATE SET
        embedding = excluded.embedding,
        model_version = excluded.model_version,
        updated_at = excluded.updated_at
    `);

    this.stmtDeleteEmbedding = this.db.prepare(`
      DELETE FROM gcf_embeddings WHERE symbol_id = ?
    `);

    this.stmtGetAllEmbeddings = this.db.prepare(`
      SELECT symbol_id, embedding, model_version, updated_at
      FROM gcf_embeddings
    `);

    // Load persisted embeddings into memory
    this.loadFromDatabase();
  }

  /**
   * Returns the configured maximum number of symbols this index supports.
   */
  getMaxSymbols(): number {
    return this.maxSymbols;
  }

  /**
   * Loads all persisted embeddings from SQLite into memory and rebuilds
   * the inverted index for ANN search.
   */
  private loadFromDatabase(): void {
    const rows = this.stmtGetAllEmbeddings.all() as Array<{
      symbol_id: string;
      embedding: Buffer;
      model_version: string;
      updated_at: number;
    }>;

    for (const row of rows) {
      const embedding = bufferToEmbedding(row.embedding);
      this.embeddings.set(row.symbol_id, embedding);
      this.invertedIndex.add(row.symbol_id, embedding);
    }
  }

  /**
   * Indexes a symbol by generating its embedding and persisting it.
   * If the symbol already exists, its embedding is updated.
   */
  async index(symbol: SymbolInfo): Promise<void> {
    const text = symbolToText(symbol);
    const embedding = generateEmbedding(text);

    // Store symbol info in memory
    this.symbols.set(symbol.name, symbol);

    // Update in-memory embedding cache
    if (this.embeddings.has(symbol.name)) {
      this.invertedIndex.remove(symbol.name);
    }
    this.embeddings.set(symbol.name, embedding);
    this.invertedIndex.add(symbol.name, embedding);

    // Persist symbol to gcf_symbols (satisfies foreign key for gcf_embeddings)
    const now = Date.now();
    this.stmtUpsertSymbol.run(
      symbol.name,
      symbol.filePath,
      symbol.name,
      symbol.kind,
      symbol.lineStart,
      symbol.lineEnd,
      symbol.parameters ? JSON.stringify(symbol.parameters) : null,
      symbol.returnType ?? null,
      symbol.exported ? 1 : 0,
      symbol.signature,
      'semantic-search',
      now,
    );

    // Persist embedding to SQLite
    const buf = embeddingToBuffer(embedding);
    this.stmtUpsertEmbedding.run(symbol.name, buf, this.modelVersion, now);
  }

  /**
   * Removes a symbol from the index (both in-memory and persisted).
   */
  remove(symbolName: string): void {
    this.embeddings.delete(symbolName);
    this.symbols.delete(symbolName);
    this.invertedIndex.remove(symbolName);
    // Delete embedding first (references gcf_symbols via FK)
    this.stmtDeleteEmbedding.run(symbolName);
    // Then delete the symbol record
    this.stmtDeleteSymbol.run(symbolName);
  }

  /**
   * Searches for symbols most similar to the query text.
   * Returns top-K results above the threshold, ordered by descending similarity.
   *
   * For large indexes (>50,000 symbols), uses approximate nearest neighbor
   * via inverted index to narrow candidates before full cosine similarity.
   */
  async search(query: string, topK: number = DEFAULT_TOP_K, threshold: number = DEFAULT_THRESHOLD): Promise<ScoredSnippet[]> {
    if (this.embeddings.size === 0) {
      return [];
    }

    const queryEmbedding = generateEmbedding(query);

    let candidateIds: string[];

    // Use ANN narrowing for large indexes
    if (this.embeddings.size > ANN_THRESHOLD) {
      candidateIds = this.invertedIndex.getCandidates(queryEmbedding, ANN_MAX_CANDIDATES);
    } else {
      candidateIds = [...this.embeddings.keys()];
    }

    // Compute cosine similarity for each candidate
    const scored: Array<{ name: string; score: number }> = [];
    for (const symbolName of candidateIds) {
      const embedding = this.embeddings.get(symbolName);
      if (!embedding) continue;

      const score = cosineSimilarity(queryEmbedding, embedding);
      if (score >= threshold) {
        scored.push({ name: symbolName, score });
      }
    }

    // Sort by descending similarity score
    scored.sort((a, b) => b.score - a.score);

    // Take top K results
    const topResults = scored.slice(0, topK);

    // Build ScoredSnippet results
    const results: ScoredSnippet[] = [];
    for (const { name, score } of topResults) {
      const symbol = this.symbols.get(name);
      if (symbol) {
        results.push({
          symbol,
          score,
          snippet: symbol.signature,
        });
      }
    }

    return results;
  }

  /**
   * Re-indexes a batch of symbols incrementally.
   * Only symbols whose content has changed will have their embeddings recomputed.
   * Symbols not in the provided list but present in the index are left unchanged.
   */
  async reindex(symbols: SymbolInfo[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      for (const symbol of symbols) {
        const text = symbolToText(symbol);
        const newEmbedding = generateEmbedding(text);

        // Check if embedding actually changed (avoid unnecessary writes)
        const existing = this.embeddings.get(symbol.name);
        if (existing && arraysEqual(existing, newEmbedding)) {
          // Update symbol info in memory even if embedding unchanged
          this.symbols.set(symbol.name, symbol);
          continue;
        }

        // Update in-memory state
        this.symbols.set(symbol.name, symbol);
        if (this.embeddings.has(symbol.name)) {
          this.invertedIndex.remove(symbol.name);
        }
        this.embeddings.set(symbol.name, newEmbedding);
        this.invertedIndex.add(symbol.name, newEmbedding);

        // Persist symbol to gcf_symbols (satisfies foreign key)
        const now = Date.now();
        this.stmtUpsertSymbol.run(
          symbol.name,
          symbol.filePath,
          symbol.name,
          symbol.kind,
          symbol.lineStart,
          symbol.lineEnd,
          symbol.parameters ? JSON.stringify(symbol.parameters) : null,
          symbol.returnType ?? null,
          symbol.exported ? 1 : 0,
          symbol.signature,
          'semantic-search',
          now,
        );

        // Persist embedding to SQLite
        const buf = embeddingToBuffer(newEmbedding);
        this.stmtUpsertEmbedding.run(symbol.name, buf, this.modelVersion, now);
      }
    });

    transaction();
  }

  /**
   * Returns the current number of indexed symbols.
   */
  getIndexSize(): number {
    return this.embeddings.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks if two Float32Arrays are element-wise equal.
 */
function arraysEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
