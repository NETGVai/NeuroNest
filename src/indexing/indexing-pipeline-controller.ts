/**
 * Indexing Pipeline Controller
 *
 * Central orchestrator that coordinates all indexing subsystems. Receives file
 * change events from FileEventEmitter, computes content hashes, and drives the
 * parse → chunk → embed → call graph → lineage → merge pipeline.
 *
 * All subsystem calls are wrapped in try/catch for error isolation — no
 * subsystem error propagates to the Electron main process.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 9.6
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

import type { FileCreatedEvent, FileEventEmitter } from '../main/file-event-emitter.js';
import type { GraphManager } from '../graph/graph-manager.js';
import type { ASTChunker, Chunk, CallEdge } from './ast-chunker.js';
import type { EmbeddingStore } from './embedding-store.js';
import type { CallGraphEngine, CallGraphNode } from './call-graph-engine.js';
import type { TransformationCache } from './transformation-cache.js';
import type { EmbeddingDaemonClient } from './embedding-daemon.js';
import type { LineageTracker } from './lineage-tracker.js';
import type { Connector } from './connectors/connector-interface.js';

// ─── Configuration ──────────────────────────────────────────────

export interface IndexingConfig {
  enabled: boolean;
  incrementalIndexing: boolean;
  vectorSearch: boolean;
  callGraph: boolean;
  connectors: { git: boolean; documentation: boolean };
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingProvider: 'ollama' | 'openai' | 'local';
  embeddingEndpoint: string;
  maxCacheSize: number;
  cacheTTLDays: number;
  callGraphDepth: number;
  gitCommitLimit: number;
}

// ─── File Provenance ────────────────────────────────────────────

export interface FileProvenance {
  filePath: string;
  contentHash: string;
  lastIndexedAt: number;
  chunkCount: number;
  status: 'indexed' | 'pending' | 'error';
}

// ─── Pipeline Status ────────────────────────────────────────────

export interface PipelineStatus {
  running: boolean;
  filesIndexed: number;
  filesInQueue: number;
  lastError: string | null;
  lastIndexedAt: number | null;
}

// ─── Controller ─────────────────────────────────────────────────

export class IndexingPipelineController {
  private running = false;
  private filesIndexed = 0;
  private filesInQueue = 0;
  private lastError: string | null = null;
  private lastIndexedAt: number | null = null;
  private fileEventEmitter: FileEventEmitter | null = null;
  private connectors: Connector[] = [];

  private static readonly HANDLER_ID = 'indexing-pipeline-controller';

  constructor(
    private db: Database.Database,
    private config: IndexingConfig,
    private graphManager: GraphManager,
    private astChunker: ASTChunker,
    private embeddingStore: EmbeddingStore,
    private callGraphEngine: CallGraphEngine,
    private transformationCache: TransformationCache,
    private embeddingDaemon: EmbeddingDaemonClient,
    private lineageTracker: LineageTracker
  ) {}

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Register with FileEventEmitter to receive file change events.
   * Starts the pipeline in listening mode.
   */
  start(fileEventEmitter?: FileEventEmitter): void {
    if (this.running) return;

    this.running = true;

    if (fileEventEmitter) {
      this.fileEventEmitter = fileEventEmitter;
      this.fileEventEmitter.onFileCreated(
        IndexingPipelineController.HANDLER_ID,
        (event: FileCreatedEvent) => {
          // Fire-and-forget to avoid blocking the main process
          this.processFileChange(event).catch((err) => {
            this.lastError = `[processFileChange] ${String(err)}`;
            console.error('[IndexingPipeline:Controller] Unhandled error in processFileChange:', err);
          });
        }
      );
    }
  }

  /**
   * Graceful shutdown — unregister event handlers and stop processing.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.fileEventEmitter) {
      this.fileEventEmitter.removeHandler(IndexingPipelineController.HANDLER_ID);
      this.fileEventEmitter = null;
    }
  }

  /**
   * Register a connector for multi-source ingestion.
   */
  registerConnector(connector: Connector): void {
    this.connectors.push(connector);
  }

  // ─── File Change Processing ─────────────────────────────────

  /**
   * Process a single file change event.
   * Computes content hash, compares against file_provenance, and orchestrates
   * the full indexing pipeline if the file has changed.
   */
  async processFileChange(event: FileCreatedEvent): Promise<void> {
    if (!this.running || !this.config.enabled) return;

    const { filePath, projectId } = event;
    this.filesInQueue++;

    try {
      // 1. Read file content
      const content = await this.readFileContent(filePath);
      if (content === null) {
        this.filesInQueue--;
        return;
      }

      // 2. Compute content hash (SHA-256)
      const contentHash = this.computeContentHash(content);

      // 3. Compare against stored hash in file_provenance
      const existingProvenance = this.getProvenance(filePath);
      if (existingProvenance && existingProvenance.contentHash === contentHash) {
        // Hash matches — skip reprocessing (no-op)
        this.filesInQueue--;
        return;
      }

      // 4. Mark as pending
      this.upsertProvenance(filePath, projectId, contentHash, 0, 'pending');

      // 5. Parse → Chunk
      let chunks: Chunk[] = [];
      let callEdges: CallEdge[] = [];
      try {
        const parseResult = this.astChunker.parseFile(filePath, content);
        chunks = parseResult.chunks;
        callEdges = parseResult.callEdges;
      } catch (err) {
        console.error('[IndexingPipeline:ASTChunker] Error parsing file:', filePath, err);
        this.lastError = `[ASTChunker] ${String(err)}`;
        // Continue with empty chunks — file-level fallback should be handled by chunker
      }

      // 6. Store chunks in DB
      try {
        this.storeChunks(chunks, projectId);
      } catch (err) {
        console.error('[IndexingPipeline:ChunkStore] Error storing chunks:', filePath, err);
        this.lastError = `[ChunkStore] ${String(err)}`;
      }

      // 7. Invalidate transformation cache entries for changed chunks
      try {
        for (const chunk of chunks) {
          this.transformationCache.invalidateByChunk(chunk.id);
        }
      } catch (err) {
        console.error('[IndexingPipeline:TransformationCache] Error invalidating cache:', err);
        this.lastError = `[TransformationCache] ${String(err)}`;
      }

      // 8. Embed chunks (if vector search is enabled)
      if (this.config.vectorSearch && chunks.length > 0) {
        try {
          const texts = chunks.map((c) => c.content);
          const vectors = await this.embeddingDaemon.embedBatch(texts);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const vector = vectors[i];
            if (vector) {
              this.embeddingStore.upsert({
                chunkId: chunk.id,
                filePath: chunk.filePath,
                vector,
                contentHash: chunk.contentHash,
                createdAt: Math.floor(Date.now() / 1000),
              });
            }
          }
        } catch (err) {
          console.error('[IndexingPipeline:EmbeddingDaemon] Error embedding chunks:', err);
          this.lastError = `[EmbeddingDaemon] ${String(err)}`;
        }
      }

      // 9. Update call graph (if enabled)
      if (this.config.callGraph && callEdges.length > 0) {
        try {
          const callGraphNodes: CallGraphNode[] = chunks
            .filter((c) => c.kind === 'function' || c.kind === 'method')
            .map((c) => ({
              id: c.id,
              filePath: c.filePath,
              name: c.name,
              signature: `${c.kind}:${c.name}`,
              startLine: c.startLine,
              endLine: c.endLine,
            }));

          this.callGraphEngine.updateFile(filePath, callGraphNodes, callEdges);
        } catch (err) {
          console.error('[IndexingPipeline:CallGraphEngine] Error updating call graph:', err);
          this.lastError = `[CallGraphEngine] ${String(err)}`;
        }
      }

      // 10. Update lineage records
      try {
        const fileSize = Buffer.byteLength(content, 'utf8');
        // Mark stale records whose byte range exceeds current file size
        this.lineageTracker.markStale(filePath, fileSize);

        // Create/update lineage records for each chunk
        const updatedChunks = chunks.map((c) => ({
          nodeId: c.id,
          startByte: c.startByte,
          endByte: c.endByte,
          startLine: c.startLine,
          endLine: c.endLine,
          commitHash: null,
        }));

        this.lineageTracker.updateRecordsForFile(filePath, updatedChunks);

        // Create new lineage records for chunks that don't have one yet
        for (const chunk of chunks) {
          const existing = this.lineageTracker.getByNodeId(chunk.id);
          if (existing.length === 0) {
            this.lineageTracker.createRecord({
              nodeId: chunk.id,
              projectId,
              filePath: chunk.filePath,
              startByte: chunk.startByte,
              endByte: chunk.endByte,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              commitHash: null,
            });
          }
        }
      } catch (err) {
        console.error('[IndexingPipeline:LineageTracker] Error updating lineage:', err);
        this.lastError = `[LineageTracker] ${String(err)}`;
      }

      // 11. Merge to GraphManager
      try {
        const connectorNodes = chunks.map((c) => ({
          id: c.id,
          label: c.name,
          type: 'section' as const,
          content: c.content,
          metadata: {
            filePath: c.filePath,
            kind: c.kind,
            startLine: String(c.startLine),
            endLine: String(c.endLine),
            language: c.language,
          },
        }));

        const connectorEdges = chunks
          .filter((c) => c.parentScope !== null)
          .map((c) => ({
            source: c.parentScope!,
            target: c.id,
            relation: 'contains',
          }));

        if (typeof (this.graphManager as any).mergeIncrementalNodes === 'function') {
          (this.graphManager as any).mergeIncrementalNodes(connectorNodes, connectorEdges);
        }
      } catch (err) {
        console.error('[IndexingPipeline:GraphManager] Error merging nodes:', err);
        this.lastError = `[GraphManager] ${String(err)}`;
      }

      // 12. Update file_provenance record
      this.upsertProvenance(filePath, projectId, contentHash, chunks.length, 'indexed');
      this.filesIndexed++;
      this.lastIndexedAt = Date.now();
    } catch (err) {
      console.error('[IndexingPipeline:Controller] Unexpected error processing file:', filePath, err);
      this.lastError = `[Controller] ${String(err)}`;
      this.upsertProvenance(filePath, event.projectId, '', 0, 'error');
    } finally {
      this.filesInQueue--;
    }
  }

  /**
   * Process a file deletion — remove all associated records.
   */
  async processFileDeletion(filePath: string): Promise<void> {
    if (!this.running || !this.config.enabled) return;

    try {
      // Remove chunks
      try {
        this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
      } catch (err) {
        console.error('[IndexingPipeline:ChunkStore] Error deleting chunks:', err);
        this.lastError = `[ChunkStore:delete] ${String(err)}`;
      }

      // Remove embeddings
      try {
        this.embeddingStore.removeByFile(filePath);
      } catch (err) {
        console.error('[IndexingPipeline:EmbeddingStore] Error removing embeddings:', err);
        this.lastError = `[EmbeddingStore:delete] ${String(err)}`;
      }

      // Remove call graph nodes/edges
      try {
        this.callGraphEngine.removeFile(filePath);
      } catch (err) {
        console.error('[IndexingPipeline:CallGraphEngine] Error removing call graph:', err);
        this.lastError = `[CallGraphEngine:delete] ${String(err)}`;
      }

      // Remove lineage records
      try {
        this.lineageTracker.removeByFile(filePath);
      } catch (err) {
        console.error('[IndexingPipeline:LineageTracker] Error removing lineage:', err);
        this.lastError = `[LineageTracker:delete] ${String(err)}`;
      }

      // Remove file_provenance record
      try {
        this.db.prepare('DELETE FROM file_provenance WHERE file_path = ?').run(filePath);
      } catch (err) {
        console.error('[IndexingPipeline:Provenance] Error removing provenance:', err);
        this.lastError = `[Provenance:delete] ${String(err)}`;
      }
    } catch (err) {
      console.error('[IndexingPipeline:Controller] Error in processFileDeletion:', err);
      this.lastError = `[Controller:deletion] ${String(err)}`;
    }
  }

  /**
   * Process a file rename — update all references from oldPath to newPath.
   */
  async processFileRename(oldPath: string, newPath: string): Promise<void> {
    if (!this.running || !this.config.enabled) return;

    try {
      // Update chunks
      try {
        this.db.prepare('UPDATE chunks SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
      } catch (err) {
        console.error('[IndexingPipeline:ChunkStore] Error renaming chunks:', err);
        this.lastError = `[ChunkStore:rename] ${String(err)}`;
      }

      // Update embeddings
      try {
        this.db.prepare('UPDATE embeddings SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
      } catch (err) {
        console.error('[IndexingPipeline:EmbeddingStore] Error renaming embeddings:', err);
        this.lastError = `[EmbeddingStore:rename] ${String(err)}`;
      }

      // Update call graph nodes
      try {
        this.db.prepare('UPDATE call_graph_nodes SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
      } catch (err) {
        console.error('[IndexingPipeline:CallGraphEngine] Error renaming call graph nodes:', err);
        this.lastError = `[CallGraphEngine:rename] ${String(err)}`;
      }

      // Update lineage records
      try {
        this.db.prepare('UPDATE lineage SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
      } catch (err) {
        console.error('[IndexingPipeline:LineageTracker] Error renaming lineage:', err);
        this.lastError = `[LineageTracker:rename] ${String(err)}`;
      }

      // Update file_provenance
      try {
        this.db.prepare('UPDATE file_provenance SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
      } catch (err) {
        console.error('[IndexingPipeline:Provenance] Error renaming provenance:', err);
        this.lastError = `[Provenance:rename] ${String(err)}`;
      }
    } catch (err) {
      console.error('[IndexingPipeline:Controller] Error in processFileRename:', err);
      this.lastError = `[Controller:rename] ${String(err)}`;
    }
  }

  /**
   * Run a full reindex of all files in the project directory.
   * Replaces the batch-mode "Generate Knowledge Graph" for indexing purposes.
   */
  async fullReindex(projectPath: string): Promise<void> {
    if (!this.config.enabled) return;

    const wasRunning = this.running;
    if (!wasRunning) {
      this.running = true;
    }

    try {
      const files = await this.collectProjectFiles(projectPath);

      for (const filePath of files) {
        const event: FileCreatedEvent = {
          type: 'file-created',
          projectId: this.extractProjectId(projectPath),
          filePath,
          timestamp: Date.now(),
        };

        await this.processFileChange(event);
      }

      // Run connectors
      for (const connector of this.connectors) {
        try {
          await connector.initialize(projectPath, {
            gitCommitLimit: this.config.gitCommitLimit,
          });
          const { nodes, edges } = await connector.ingest();

          if (typeof (this.graphManager as any).mergeIncrementalNodes === 'function') {
            (this.graphManager as any).mergeIncrementalNodes(nodes, edges);
          }
        } catch (err) {
          console.error(`[IndexingPipeline:Connector:${connector.name}] Error during ingestion:`, err);
          this.lastError = `[Connector:${connector.name}] ${String(err)}`;
        }
      }

      // Resolve unresolved call graph edges after full reindex
      if (this.config.callGraph) {
        try {
          this.callGraphEngine.resolveEdges();
        } catch (err) {
          console.error('[IndexingPipeline:CallGraphEngine] Error resolving edges:', err);
          this.lastError = `[CallGraphEngine:resolve] ${String(err)}`;
        }
      }
    } catch (err) {
      console.error('[IndexingPipeline:Controller] Error in fullReindex:', err);
      this.lastError = `[Controller:fullReindex] ${String(err)}`;
    } finally {
      if (!wasRunning) {
        this.running = false;
      }
    }
  }

  // ─── Status ─────────────────────────────────────────────────

  /**
   * Get current pipeline status.
   */
  getStatus(): PipelineStatus {
    return {
      running: this.running,
      filesIndexed: this.filesIndexed,
      filesInQueue: this.filesInQueue,
      lastError: this.lastError,
      lastIndexedAt: this.lastIndexedAt,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Compute SHA-256 content hash for a file's content.
   */
  computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Read file content, returning null if the file cannot be read.
   */
  private async readFileContent(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Get the stored provenance record for a file.
   */
  private getProvenance(filePath: string): FileProvenance | null {
    const row = this.db.prepare(
      'SELECT file_path, content_hash, last_indexed_at, chunk_count, status FROM file_provenance WHERE file_path = ?'
    ).get(filePath) as {
      file_path: string;
      content_hash: string;
      last_indexed_at: number;
      chunk_count: number;
      status: string;
    } | undefined;

    if (!row) return null;

    return {
      filePath: row.file_path,
      contentHash: row.content_hash,
      lastIndexedAt: row.last_indexed_at,
      chunkCount: row.chunk_count,
      status: row.status as FileProvenance['status'],
    };
  }

  /**
   * Insert or update a file_provenance record.
   */
  private upsertProvenance(
    filePath: string,
    projectId: string,
    contentHash: string,
    chunkCount: number,
    status: FileProvenance['status']
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO file_provenance (file_path, project_id, content_hash, last_indexed_at, chunk_count, status, file_size)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(file_path) DO UPDATE SET
        project_id = excluded.project_id,
        content_hash = excluded.content_hash,
        last_indexed_at = excluded.last_indexed_at,
        chunk_count = excluded.chunk_count,
        status = excluded.status
    `).run(filePath, projectId, contentHash, now, chunkCount, status);
  }

  /**
   * Store chunks in the chunks table.
   */
  private storeChunks(chunks: Chunk[], projectId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, file_path, project_id, content, content_hash, start_line, end_line, start_byte, end_byte, kind, name, parent_scope, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const chunk of chunks) {
        stmt.run(
          chunk.id,
          chunk.filePath,
          projectId,
          chunk.content,
          chunk.contentHash,
          chunk.startLine,
          chunk.endLine,
          chunk.startByte,
          chunk.endByte,
          chunk.kind,
          chunk.name,
          chunk.parentScope,
          chunk.language
        );
      }
    });

    transaction();
  }

  /**
   * Recursively collect all files in a project directory, skipping
   * common non-source directories (node_modules, .git, dist, etc.).
   */
  private async collectProjectFiles(projectPath: string): Promise<string[]> {
    const SKIP_DIRS = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
      'coverage', '__pycache__', '.venv', 'venv', 'target',
    ]);

    const files: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            await walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          files.push(path.join(dir, entry.name));
        }
      }
    };

    await walk(projectPath);
    return files;
  }

  /**
   * Extract a project ID from a project path.
   * Uses the last directory component as a simple project identifier.
   */
  private extractProjectId(projectPath: string): string {
    return path.basename(projectPath);
  }
}
