/**
 * Ingest Pipeline Orchestrator — Wires chunking → embedding → LanceDB upsert → SQLite metadata insert.
 *
 * Features:
 *   - Full ingest of documents from connectors (async iterable)
 *   - Incremental ingest (re-index only changed content using content hash comparison)
 *   - Skip corrupt/unparseable documents with warning events
 *   - Yield to event loop every 50ms to avoid blocking the UI
 *   - Bound memory to 256 MB via batched processing
 *   - Emit structured events (ingest.start, ingest.complete, ingest.error)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 5.4, 34.2, 34.3, 34.4
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log';
import type { KBEmbeddingService, KBBatchEmbeddingResult } from './embedding-service';
import type { RawDocument } from '../connectors/types';
import {
  type ChunkingConfig,
  type KBChunk,
  createChunkingStrategy,
  hashContent,
} from './chunking';
import { KB_EVENT_KINDS } from '../events/kb-event-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Interface for the KB vector store used by the ingest pipeline.
 * Abstracts LanceDB operations to allow testing with in-memory backends.
 */
export interface KBVectorStore {
  /** Upsert embedding records into the vector store */
  upsert(records: KBVectorRecord[]): Promise<void>;
  /** Delete records by source URI */
  deleteBySourceUri(sourceUri: string): Promise<number>;
}

/** A record stored in the KB vector store */
export interface KBVectorRecord {
  /** Chunk UUID */
  id: string;
  /** Project identifier */
  projectId: string;
  /** Source identifier (FK to kb_sources) */
  sourceId: string;
  /** Original source URI */
  sourceUri: string;
  /** Chunk index within source */
  chunkIndex: number;
  /** Raw chunk text content */
  content: string;
  /** SHA-256 content hash */
  contentHash: string;
  /** Float32 embedding vector */
  embedding: Float32Array;
  /** Continuation group ID for oversized split chunks */
  continuationGroupId?: string;
}

/** Result of a full or incremental ingest operation */
export interface IngestResult {
  /** Source URI processed */
  sourceUri: string;
  /** Total documents processed */
  totalDocuments: number;
  /** Total chunks produced */
  totalChunks: number;
  /** Total tokens across all chunks */
  totalTokens: number;
  /** Errors encountered (skipped documents) */
  errors: IngestError[];
  /** Total duration of the ingest operation in milliseconds */
  durationMs: number;
}

/** An error encountered during ingest */
export interface IngestError {
  /** URI of the document that failed */
  documentUri: string;
  /** Error message */
  message: string;
  /** Phase in which the error occurred */
  phase: 'fetch' | 'chunk' | 'embed' | 'index' | 'validate';
}

/** Configuration for the ingest pipeline */
export interface IngestPipelineConfig {
  /** Project identifier for namespace isolation */
  projectId: string;
  /** Source identifier (FK to kb_sources) */
  sourceId: string;
  /** Session ID for EventLog emission */
  sessionId: string;
  /** Maximum batch size for embedding (controls memory usage) */
  embeddingBatchSize?: number;
  /** Maximum memory budget in bytes (default: 256 MB) */
  maxMemoryBytes?: number;
  /** Yield interval in ms (default: 50ms) */
  yieldIntervalMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default embedding batch size */
const DEFAULT_EMBEDDING_BATCH_SIZE = 32;

/** Default memory budget: 256 MB */
const DEFAULT_MAX_MEMORY_BYTES = 256 * 1024 * 1024;

/** Default yield interval: 50ms */
const DEFAULT_YIELD_INTERVAL_MS = 50;

/** Approximate bytes per chunk for memory estimation (content + metadata overhead) */
const ESTIMATED_BYTES_PER_CHUNK = 4096;

// ─── IngestPipeline ─────────────────────────────────────────────

/**
 * IngestPipeline orchestrates the full ingest flow:
 *   1. Takes RawDocuments from connectors
 *   2. Chunks them using the configured strategy
 *   3. Generates embeddings for each chunk via the EmbeddingService
 *   4. Stores vectors in LanceDB (via a KBVectorStore interface)
 *   5. Stores chunk metadata in SQLite (kb_chunk_metadata table)
 *   6. Supports incremental ingest by comparing content hashes
 *   7. Emits structured events (ingest.start, ingest.complete, ingest.error)
 *   8. Yields to event loop every 50ms to avoid blocking
 *   9. Skips corrupt documents and continues processing
 */
export class IngestPipeline {
  private readonly embeddingService: KBEmbeddingService;
  private readonly vectorStore: KBVectorStore;
  private readonly db: Database.Database;
  private readonly eventLog: EventLog;
  private readonly chunkingConfig: ChunkingConfig;

  constructor(
    embeddingService: KBEmbeddingService,
    vectorStore: KBVectorStore,
    db: Database.Database,
    eventLog: EventLog,
    chunkingConfig: ChunkingConfig,
  ) {
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
    this.db = db;
    this.eventLog = eventLog;
    this.chunkingConfig = chunkingConfig;
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Full ingest: process all documents from an async iterable.
   * Chunks, embeds, and indexes each document; skips corrupt ones.
   */
  async ingest(
    documents: AsyncIterable<RawDocument>,
    config: IngestPipelineConfig,
  ): Promise<IngestResult> {
    const startTime = Date.now();
    const errors: IngestError[] = [];
    let totalDocuments = 0;
    let totalChunks = 0;
    let totalTokens = 0;
    let sourceUri = '';

    const embeddingBatchSize = config.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
    const maxMemoryBytes = config.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
    const yieldIntervalMs = config.yieldIntervalMs ?? DEFAULT_YIELD_INTERVAL_MS;

    // Calculate max chunks per batch based on memory budget
    const maxChunksPerBatch = Math.max(
      1,
      Math.floor(maxMemoryBytes / ESTIMATED_BYTES_PER_CHUNK),
    );

    // Emit ingest start event
    this.emitEvent(config.sessionId, KB_EVENT_KINDS.INGEST_START, {
      sourceUri: config.sourceId,
      sourceId: config.sourceId,
      projectId: config.projectId,
    });

    let lastYieldTime = Date.now();
    let pendingChunks: KBChunk[] = [];

    for await (const doc of documents) {
      totalDocuments++;
      sourceUri = sourceUri || doc.sourceUri;

      // Yield to event loop if needed
      lastYieldTime = await this.maybeYield(lastYieldTime, yieldIntervalMs);

      // Attempt to chunk the document
      let chunks: KBChunk[];
      try {
        chunks = this.chunkDocument(doc);
      } catch (err) {
        const error: IngestError = {
          documentUri: doc.sourceUri,
          message: err instanceof Error ? err.message : String(err),
          phase: 'chunk',
        };
        errors.push(error);
        this.emitErrorEvent(config, doc.sourceUri, error);
        continue; // Skip corrupt document
      }

      if (chunks.length === 0) {
        continue;
      }

      pendingChunks.push(...chunks);

      // Process in batches to bound memory
      while (pendingChunks.length >= embeddingBatchSize || pendingChunks.length >= maxChunksPerBatch) {
        const batch = pendingChunks.splice(0, Math.min(embeddingBatchSize, maxChunksPerBatch));
        const batchResult = await this.processBatch(batch, config, errors);
        totalChunks += batchResult.chunksStored;
        totalTokens += batchResult.tokensStored;

        // Yield after each batch
        lastYieldTime = await this.maybeYield(lastYieldTime, yieldIntervalMs);
      }
    }

    // Process remaining chunks
    if (pendingChunks.length > 0) {
      const batchResult = await this.processBatch(pendingChunks, config, errors);
      totalChunks += batchResult.chunksStored;
      totalTokens += batchResult.tokensStored;
    }

    const durationMs = Date.now() - startTime;

    // Emit ingest complete event
    this.emitEvent(config.sessionId, KB_EVENT_KINDS.INGEST_COMPLETE, {
      sourceUri: sourceUri || config.sourceId,
      sourceId: config.sourceId,
      projectId: config.projectId,
      chunkCount: totalChunks,
      embedCount: totalChunks,
      durationMs,
    });

    return {
      sourceUri: sourceUri || config.sourceId,
      totalDocuments,
      totalChunks,
      totalTokens,
      errors,
      durationMs,
    };
  }

  /**
   * Incremental ingest: re-index only documents whose content hashes
   * have changed compared to what's stored in SQLite.
   */
  async ingestIncremental(
    sourceUri: string,
    changedDocs: RawDocument[],
    config: IngestPipelineConfig,
  ): Promise<IngestResult> {
    const startTime = Date.now();
    const errors: IngestError[] = [];
    let totalChunks = 0;
    let totalTokens = 0;
    let processedDocuments = 0;

    const embeddingBatchSize = config.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
    const yieldIntervalMs = config.yieldIntervalMs ?? DEFAULT_YIELD_INTERVAL_MS;

    // Emit ingest start event
    this.emitEvent(config.sessionId, KB_EVENT_KINDS.INGEST_START, {
      sourceUri,
      sourceId: config.sourceId,
      projectId: config.projectId,
    });

    let lastYieldTime = Date.now();

    for (const doc of changedDocs) {
      // Yield to event loop if needed
      lastYieldTime = await this.maybeYield(lastYieldTime, yieldIntervalMs);

      // Check if content hash has changed
      const existingHash = this.getExistingContentHash(doc.sourceUri, config.sourceId);
      if (existingHash === doc.contentHash) {
        // Content unchanged — skip
        continue;
      }

      processedDocuments++;

      // Remove old chunks for this document
      this.deleteChunksForDocument(doc.sourceUri, config.sourceId);

      // Chunk the document
      let chunks: KBChunk[];
      try {
        chunks = this.chunkDocument(doc);
      } catch (err) {
        const error: IngestError = {
          documentUri: doc.sourceUri,
          message: err instanceof Error ? err.message : String(err),
          phase: 'chunk',
        };
        errors.push(error);
        this.emitErrorEvent(config, doc.sourceUri, error);
        continue;
      }

      if (chunks.length === 0) {
        continue;
      }

      // Process in batches
      for (let i = 0; i < chunks.length; i += embeddingBatchSize) {
        const batch = chunks.slice(i, i + embeddingBatchSize);
        const batchResult = await this.processBatch(batch, config, errors);
        totalChunks += batchResult.chunksStored;
        totalTokens += batchResult.tokensStored;

        lastYieldTime = await this.maybeYield(lastYieldTime, yieldIntervalMs);
      }
    }

    const durationMs = Date.now() - startTime;

    // Emit ingest complete event
    this.emitEvent(config.sessionId, KB_EVENT_KINDS.INGEST_COMPLETE, {
      sourceUri,
      sourceId: config.sourceId,
      projectId: config.projectId,
      chunkCount: totalChunks,
      embedCount: totalChunks,
      durationMs,
    });

    return {
      sourceUri,
      totalDocuments: processedDocuments,
      totalChunks,
      totalTokens,
      errors,
      durationMs,
    };
  }

  // ─── Private: Batch Processing ──────────────────────────────

  /**
   * Process a batch of chunks: generate embeddings, store in vector DB,
   * and persist metadata in SQLite.
   */
  private async processBatch(
    chunks: KBChunk[],
    config: IngestPipelineConfig,
    errors: IngestError[],
  ): Promise<{ chunksStored: number; tokensStored: number }> {
    if (chunks.length === 0) {
      return { chunksStored: 0, tokensStored: 0 };
    }

    // Generate embeddings for all chunks in the batch
    const texts = chunks.map((c) => c.content);
    let embeddingResult: KBBatchEmbeddingResult;
    try {
      embeddingResult = await this.embeddingService.embedBatch(texts);
    } catch (err) {
      // Embedding service failure — record error for all chunks in batch
      for (const chunk of chunks) {
        errors.push({
          documentUri: chunk.sourceUri,
          message: `Embedding failed: ${err instanceof Error ? err.message : String(err)}`,
          phase: 'embed',
        });
      }
      return { chunksStored: 0, tokensStored: 0 };
    }

    // Track successfully embedded chunks
    const successfulChunks: Array<{ chunk: KBChunk; embedding: Float32Array }> = [];

    // Map successful embeddings to chunks
    let embeddingIdx = 0;
    for (let i = 0; i < chunks.length; i++) {
      // Check if this index had an error
      const errorEntry = embeddingResult.errors.find((e) => e.index === i);
      if (errorEntry) {
        errors.push({
          documentUri: chunks[i]!.sourceUri,
          message: `Embedding failed for chunk ${i}: ${errorEntry.error}`,
          phase: 'embed',
        });
        continue;
      }

      const result = embeddingResult.results[embeddingIdx];
      if (result) {
        successfulChunks.push({ chunk: chunks[i]!, embedding: result.vector });
        embeddingIdx++;
      }
    }

    if (successfulChunks.length === 0) {
      return { chunksStored: 0, tokensStored: 0 };
    }

    // Store vectors in LanceDB
    try {
      const vectorRecords: KBVectorRecord[] = successfulChunks.map(({ chunk, embedding }) => ({
        id: chunk.id,
        projectId: config.projectId,
        sourceId: config.sourceId,
        sourceUri: chunk.sourceUri,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentHash: chunk.contentHash,
        embedding,
        continuationGroupId: chunk.continuationGroupId,
      }));

      await this.vectorStore.upsert(vectorRecords);
    } catch (err) {
      for (const { chunk } of successfulChunks) {
        errors.push({
          documentUri: chunk.sourceUri,
          message: `Vector store upsert failed: ${err instanceof Error ? err.message : String(err)}`,
          phase: 'index',
        });
      }
      return { chunksStored: 0, tokensStored: 0 };
    }

    // Store metadata in SQLite
    let chunksStored = 0;
    let tokensStored = 0;

    try {
      const insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO kb_chunk_metadata
          (id, source_id, project_id, chunk_index, content_hash, byte_size,
           token_count, llm_token_count, source_uri, heading, language,
           line_start, line_end, continuation_group_id, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = this.db.transaction(
        (items: Array<{ chunk: KBChunk; embedding: Float32Array }>) => {
          for (const { chunk } of items) {
            insertStmt.run(
              chunk.id,
              config.sourceId,
              config.projectId,
              chunk.chunkIndex,
              chunk.contentHash,
              Buffer.byteLength(chunk.content, 'utf-8'),
              chunk.tokenCount,
              chunk.llmTokenCount,
              chunk.sourceUri,
              chunk.metadata.heading ?? null,
              chunk.metadata.language ?? null,
              chunk.metadata.lineStart ?? null,
              chunk.metadata.lineEnd ?? null,
              chunk.continuationGroupId ?? null,
              Date.now(),
            );
            chunksStored++;
            tokensStored += chunk.tokenCount;
          }
        },
      );

      insertMany(successfulChunks);
    } catch (err) {
      // SQLite failure — record error but vectors are already stored
      for (const { chunk } of successfulChunks) {
        errors.push({
          documentUri: chunk.sourceUri,
          message: `SQLite metadata insert failed: ${err instanceof Error ? err.message : String(err)}`,
          phase: 'index',
        });
      }
      return { chunksStored: 0, tokensStored: 0 };
    }

    return { chunksStored, tokensStored };
  }

  // ─── Private: Chunking ──────────────────────────────────────

  /**
   * Chunk a raw document into KBChunk pieces using the configured strategy.
   * Throws if the document is corrupt or unparseable.
   */
  private chunkDocument(doc: RawDocument): KBChunk[] {
    // Decode content from Buffer to string
    let content: string;
    try {
      content = doc.content.toString('utf-8');
    } catch (err) {
      throw new Error(
        `Failed to decode document content: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Validate content is not empty
    if (content.trim().length === 0) {
      return [];
    }

    // Create chunking strategy and produce chunks
    const strategy = createChunkingStrategy(this.chunkingConfig);
    return strategy.chunk(content, doc.sourceUri, this.chunkingConfig);
  }

  // ─── Private: Incremental Ingest Helpers ────────────────────

  /**
   * Get the existing content hash for a document from SQLite.
   * Returns the content hash of the first chunk for the given source URI,
   * or null if no chunks exist.
   */
  private getExistingContentHash(documentUri: string, sourceId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT content_hash FROM kb_chunk_metadata
         WHERE source_uri = ? AND source_id = ?
         LIMIT 1`,
      )
      .get(documentUri, sourceId) as { content_hash: string } | undefined;

    return row?.content_hash ?? null;
  }

  /**
   * Delete all existing chunks for a document (by source URI and source ID).
   * Used during incremental ingest to remove stale data before re-indexing.
   */
  private deleteChunksForDocument(documentUri: string, sourceId: string): void {
    this.db
      .prepare(
        `DELETE FROM kb_chunk_metadata
         WHERE source_uri = ? AND source_id = ?`,
      )
      .run(documentUri, sourceId);
  }

  // ─── Private: Event Emission ────────────────────────────────

  /**
   * Emit a structured event to the EventLog.
   */
  private emitEvent(sessionId: string, kind: EventKind, payload: unknown): void {
    try {
      this.eventLog.emit({ sessionId, kind, payload });
    } catch {
      // EventLog emission failure should never crash the pipeline
    }
  }

  /**
   * Emit an ingest error event.
   */
  private emitErrorEvent(config: IngestPipelineConfig, documentUri: string, error: IngestError): void {
    this.emitEvent(config.sessionId, KB_EVENT_KINDS.INGEST_ERROR, {
      sourceUri: documentUri,
      sourceId: config.sourceId,
      projectId: config.projectId,
      error: error.message,
      phase: error.phase,
    });
  }

  // ─── Private: Event Loop Yielding ───────────────────────────

  /**
   * Yield to the event loop if more than `intervalMs` has elapsed
   * since the last yield. Returns the updated timestamp.
   */
  private async maybeYield(lastYieldTime: number, intervalMs: number): Promise<number> {
    const now = Date.now();
    if (now - lastYieldTime >= intervalMs) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return Date.now();
    }
    return lastYieldTime;
  }
}
