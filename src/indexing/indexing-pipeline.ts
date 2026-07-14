/**
 * Indexing Pipeline — Incremental indexing orchestrator for SemanticIndex
 *
 * Implements file hash comparison for change detection (only re-index modified files).
 * Parallelizes chunking and embedding with progress tracking (emits percentage via IPC).
 * Targets 10,000 files within 5 minutes using 4 parallel workers.
 * Triggers on project open and file save events.
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 *
 * Requirements: 2.5, 2.7, 2.8
 */

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { TreeSitterChunker, type TreeSitterChunkerOptions } from './tree-sitter-chunker.js';
import { EmbeddingService, type EmbeddingServiceConfig } from './embedding-service.js';
import { VectorStore, type VectorStoreConfig } from './vector-store.js';

// ─── Types ──────────────────────────────────────────────────────

/** Indexing pipeline configuration */
export interface IndexingPipelineConfig {
  /** Project root directory */
  projectRoot: string;
  /** Project identifier for isolated storage */
  projectId: string;
  /** Number of parallel workers for chunking/embedding (default: 4) */
  workerCount: number;
  /** Batch size for parallel file processing (default: 20) */
  batchSize: number;
  /** Embedding service configuration overrides */
  embeddingConfig?: Partial<EmbeddingServiceConfig>;
  /** Vector store configuration overrides */
  vectorStoreConfig?: Partial<VectorStoreConfig>;
  /** TreeSitter chunker options overrides */
  chunkerOptions?: Partial<TreeSitterChunkerOptions>;
  /** IPC sender function for progress events */
  ipcSender?: (channel: string, data: unknown) => void;
}

/** Status of the indexing pipeline */
export interface IndexingStatus {
  /** Whether indexing is currently running */
  isRunning: boolean;
  /** Total files discovered for indexing */
  totalFiles: number;
  /** Files processed so far */
  processedFiles: number;
  /** Files that were skipped (unchanged) */
  skippedFiles: number;
  /** Files that encountered errors */
  errorFiles: number;
  /** Progress percentage (0-100) */
  progressPercent: number;
  /** Estimated time remaining in milliseconds */
  estimatedTimeRemainingMs: number | null;
  /** Timestamp when indexing started */
  startedAt: number | null;
  /** Timestamp when indexing completed */
  completedAt: number | null;
  /** Last error message */
  lastError: string | null;
}

/** Progress event emitted via IPC */
export interface IndexingProgressEvent {
  /** Progress percentage (0-100) */
  percent: number;
  /** Total files to process */
  totalFiles: number;
  /** Files processed so far */
  processedFiles: number;
  /** Files skipped (unchanged) */
  skippedFiles: number;
  /** Estimated time remaining in milliseconds */
  estimatedTimeRemainingMs: number | null;
  /** Current status message */
  message: string;
}

/** Result of indexing a single file */
export interface FileIndexResult {
  filePath: string;
  status: 'indexed' | 'skipped' | 'error';
  chunksGenerated: number;
  error?: string;
}

/** Stored file hash for change detection */
export interface FileHashRecord {
  filePath: string;
  hash: string;
  indexedAt: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default number of parallel workers */
const DEFAULT_WORKER_COUNT = 4;

/** Default batch size for file processing */
const DEFAULT_BATCH_SIZE = 20;

/** Directories to skip during file collection */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.neuronest',
  '.kiro',
  '.DS_Store',
]);

/** IPC channels for progress reporting */
const IPC_PROGRESS_CHANNEL = 'semantic:index-progress';
const IPC_STATUS_CHANNEL = 'semantic:index-status';

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Compute SHA-256 hash of file content for change detection.
 */
export function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Calculate estimated time remaining based on elapsed time and progress.
 */
export function estimateTimeRemaining(
  startTime: number,
  processedCount: number,
  totalCount: number
): number | null {
  if (processedCount === 0 || totalCount === 0) return null;

  const elapsed = Date.now() - startTime;
  const ratePerFile = elapsed / processedCount;
  const remaining = totalCount - processedCount;
  return Math.round(ratePerFile * remaining);
}

// ─── IndexingPipeline Class ─────────────────────────────────────

/**
 * Incremental indexing orchestrator for the SemanticIndex.
 *
 * Coordinates file discovery, change detection via hash comparison,
 * parallel chunking/embedding, and vector store persistence.
 * Emits progress events via IPC for UI display.
 *
 * Performance target: 10,000 files within 5 minutes using parallel workers.
 */
export class IndexingPipeline {
  private config: Required<Pick<IndexingPipelineConfig, 'projectRoot' | 'projectId' | 'workerCount' | 'batchSize'>>;
  private ipcSender: ((channel: string, data: unknown) => void) | null;
  private chunker: TreeSitterChunker;
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStore;

  /** In-memory file hash cache for incremental detection */
  private fileHashes: Map<string, FileHashRecord> = new Map();

  /** Current indexing status */
  private status: IndexingStatus = {
    isRunning: false,
    totalFiles: 0,
    processedFiles: 0,
    skippedFiles: 0,
    errorFiles: 0,
    progressPercent: 0,
    estimatedTimeRemainingMs: null,
    startedAt: null,
    completedAt: null,
    lastError: null,
  };

  /** Abort controller for cancellation support */
  private abortController: AbortController | null = null;

  constructor(config: IndexingPipelineConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      projectId: config.projectId,
      workerCount: config.workerCount ?? DEFAULT_WORKER_COUNT,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    };

    this.ipcSender = config.ipcSender ?? null;

    this.chunker = new TreeSitterChunker({
      projectRoot: config.projectRoot,
      ...config.chunkerOptions,
    });

    this.embeddingService = new EmbeddingService(config.embeddingConfig);

    this.vectorStore = new VectorStore({
      projectId: config.projectId,
      ...config.vectorStoreConfig,
    });
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Run incremental indexing of the entire project.
   * Discovers files, compares hashes for changes, and re-indexes only modified files.
   * Triggered on project open events.
   *
   * @returns Array of results per file
   */
  async indexProject(): Promise<FileIndexResult[]> {
    if (this.status.isRunning) {
      return [];
    }

    this.resetStatus();
    this.status.isRunning = true;
    this.status.startedAt = Date.now();
    this.abortController = new AbortController();

    try {
      // 1. Discover project files
      const filePaths = await this.collectProjectFiles(this.config.projectRoot);
      this.status.totalFiles = filePaths.length;
      this.emitProgress('Discovering files...');

      // 2. Process files in parallel batches
      const results = await this.processFilesInParallel(filePaths);

      // 3. Clean up records for deleted files
      await this.cleanupDeletedFiles(filePaths);

      this.status.isRunning = false;
      this.status.completedAt = Date.now();
      this.status.progressPercent = 100;
      this.emitProgress('Indexing complete');
      this.emitStatus();

      return results;
    } catch (error) {
      this.status.isRunning = false;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.emitStatus();
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Index a single file (triggered on file save events).
   * Compares hash to detect if re-indexing is needed.
   */
  async indexFile(filePath: string): Promise<FileIndexResult> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const hash = computeFileHash(content);

      // Check if file has changed
      const existing = this.fileHashes.get(filePath);
      if (existing && existing.hash === hash) {
        return { filePath, status: 'skipped', chunksGenerated: 0 };
      }

      // File has changed — re-index
      return await this.processFile(filePath, content, hash);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { filePath, status: 'error', chunksGenerated: 0, error: errorMsg };
    }
  }

  /**
   * Index multiple files (triggered on batch file save events).
   */
  async indexFiles(filePaths: string[]): Promise<FileIndexResult[]> {
    return this.processFilesInParallel(filePaths);
  }

  /**
   * Cancel a running indexing operation.
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Get the current indexing status.
   */
  getStatus(): Readonly<IndexingStatus> {
    return { ...this.status };
  }

  /**
   * Check if a file has changed since last indexing.
   */
  hasFileChanged(filePath: string, content: string): boolean {
    const hash = computeFileHash(content);
    const existing = this.fileHashes.get(filePath);
    return !existing || existing.hash !== hash;
  }

  /**
   * Get the number of indexed files.
   */
  getIndexedFileCount(): number {
    return this.fileHashes.size;
  }

  /**
   * Clear the hash cache (forces full re-index on next run).
   */
  clearHashCache(): void {
    this.fileHashes.clear();
  }

  /**
   * Close the pipeline and release resources.
   */
  async close(): Promise<void> {
    this.cancel();
    await this.vectorStore.close();
    this.fileHashes.clear();
  }

  /**
   * Get the underlying vector store (for use by search tool).
   */
  getVectorStore(): VectorStore {
    return this.vectorStore;
  }

  /**
   * Get the underlying embedding service (for use by search tool).
   */
  getEmbeddingService(): EmbeddingService {
    return this.embeddingService;
  }

  // ─── Private: File Processing ───────────────────────────────

  /**
   * Process files in parallel batches using configurable worker count.
   * Uses a worker pool pattern to process N files concurrently.
   */
  private async processFilesInParallel(filePaths: string[]): Promise<FileIndexResult[]> {
    const results: FileIndexResult[] = [];
    const workerCount = this.config.workerCount;
    const batchSize = this.config.batchSize;

    // Process files in batches, with `workerCount` files processed concurrently
    for (let i = 0; i < filePaths.length; i += batchSize) {
      // Check for cancellation
      if (this.abortController?.signal.aborted) {
        break;
      }

      const batch = filePaths.slice(i, i + batchSize);

      // Process each batch with bounded concurrency
      const batchResults = await this.processWithConcurrency(batch, workerCount);
      results.push(...batchResults);

      // Update progress
      this.status.processedFiles = Math.min(i + batchSize, filePaths.length);
      this.updateProgress();
    }

    return results;
  }

  /**
   * Process a batch of files with bounded concurrency.
   * Limits parallel execution to `maxConcurrency` active tasks.
   */
  private async processWithConcurrency(
    filePaths: string[],
    maxConcurrency: number
  ): Promise<FileIndexResult[]> {
    const results: FileIndexResult[] = [];
    const executing: Promise<void>[] = [];

    for (const filePath of filePaths) {
      if (this.abortController?.signal.aborted) break;

      const task = (async () => {
        const result = await this.processSingleFile(filePath);
        results.push(result);

        if (result.status === 'skipped') {
          this.status.skippedFiles++;
        } else if (result.status === 'error') {
          this.status.errorFiles++;
        }
      })();

      executing.push(task);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
        // Remove completed promises
        const stillExecuting: Promise<void>[] = [];
        for (const p of executing) {
          // Check if promise is settled by racing with an immediate resolve
          const settled = await Promise.race([
            p.then(() => true).catch(() => true),
            Promise.resolve(false),
          ]);
          if (!settled) {
            stillExecuting.push(p);
          }
        }
        executing.length = 0;
        executing.push(...stillExecuting);
      }
    }

    // Wait for remaining tasks to complete
    await Promise.allSettled(executing);

    return results;
  }

  /**
   * Process a single file: read, hash, chunk, embed, store.
   */
  private async processSingleFile(filePath: string): Promise<FileIndexResult> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const hash = computeFileHash(content);

      // Change detection: skip if hash matches
      const existing = this.fileHashes.get(filePath);
      if (existing && existing.hash === hash) {
        return { filePath, status: 'skipped', chunksGenerated: 0 };
      }

      return await this.processFile(filePath, content, hash);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.status.lastError = errorMsg;
      return { filePath, status: 'error', chunksGenerated: 0, error: errorMsg };
    }
  }

  /**
   * Core processing logic for a single file.
   * Chunks the file, generates embeddings, and stores in vector DB.
   */
  private async processFile(
    filePath: string,
    content: string,
    hash: string
  ): Promise<FileIndexResult> {
    // 1. Delete old records for this file
    await this.vectorStore.deleteByFilePath(filePath);

    // 2. Chunk the file using tree-sitter
    const chunks = await this.chunker.chunkFile(filePath, content);
    if (chunks.length === 0) {
      // No semantic chunks (unsupported language, excluded, etc.)
      this.updateFileHash(filePath, hash);
      return { filePath, status: 'indexed', chunksGenerated: 0 };
    }

    // 3. Generate embeddings for all chunks
    const embeddingResult = await this.embeddingService.embedChunks(chunks);

    // 4. Build embedding map from results
    const embeddingMap = new Map<string, Float32Array>();
    for (const result of embeddingResult.results) {
      embeddingMap.set(result.chunkId, result.vector);
    }

    // 5. Store chunks with embeddings in vector store
    const { inserted } = await this.vectorStore.insertChunks(chunks, embeddingMap);

    // 6. Update file hash cache
    this.updateFileHash(filePath, hash);

    return { filePath, status: 'indexed', chunksGenerated: inserted };
  }

  // ─── Private: File Collection ───────────────────────────────

  /**
   * Recursively collect all indexable files in the project directory.
   * Skips common non-source directories and respects exclusion patterns.
   */
  async collectProjectFiles(projectPath: string): Promise<string[]> {
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
          if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
            await walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const filePath = path.join(dir, entry.name);
          // Only index files with supported languages
          if (this.chunker.isLanguageSupported(filePath)) {
            files.push(filePath);
          }
        }
      }
    };

    await walk(projectPath);
    return files;
  }

  // ─── Private: Hash Management ───────────────────────────────

  /**
   * Update the file hash cache after successful indexing.
   */
  private updateFileHash(filePath: string, hash: string): void {
    this.fileHashes.set(filePath, {
      filePath,
      hash,
      indexedAt: Date.now(),
    });
  }

  /**
   * Remove hash records for files that no longer exist.
   */
  private async cleanupDeletedFiles(currentFiles: string[]): Promise<void> {
    const currentSet = new Set(currentFiles);
    const toRemove: string[] = [];

    for (const [filePath] of this.fileHashes) {
      if (!currentSet.has(filePath)) {
        toRemove.push(filePath);
      }
    }

    for (const filePath of toRemove) {
      this.fileHashes.delete(filePath);
      await this.vectorStore.deleteByFilePath(filePath);
    }
  }

  // ─── Private: Progress Tracking ─────────────────────────────

  /**
   * Reset status for a new indexing run.
   */
  private resetStatus(): void {
    this.status = {
      isRunning: false,
      totalFiles: 0,
      processedFiles: 0,
      skippedFiles: 0,
      errorFiles: 0,
      progressPercent: 0,
      estimatedTimeRemainingMs: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
    };
  }

  /**
   * Update progress percentage and emit progress event.
   */
  private updateProgress(): void {
    const { totalFiles, processedFiles, startedAt } = this.status;

    if (totalFiles === 0) {
      this.status.progressPercent = 0;
      return;
    }

    this.status.progressPercent = Math.round((processedFiles / totalFiles) * 100);
    this.status.estimatedTimeRemainingMs = estimateTimeRemaining(
      startedAt!,
      processedFiles,
      totalFiles
    );

    this.emitProgress(`Indexing: ${processedFiles}/${totalFiles} files`);
  }

  /**
   * Emit a progress event via IPC.
   */
  private emitProgress(message: string): void {
    if (!this.ipcSender) return;

    const event: IndexingProgressEvent = {
      percent: this.status.progressPercent,
      totalFiles: this.status.totalFiles,
      processedFiles: this.status.processedFiles,
      skippedFiles: this.status.skippedFiles,
      estimatedTimeRemainingMs: this.status.estimatedTimeRemainingMs,
      message,
    };

    this.ipcSender(IPC_PROGRESS_CHANNEL, event);
  }

  /**
   * Emit a status update via IPC.
   */
  private emitStatus(): void {
    if (!this.ipcSender) return;
    this.ipcSender(IPC_STATUS_CHANNEL, this.getStatus());
  }
}

// ─── Singleton Instance ─────────────────────────────────────────

let instance: IndexingPipeline | null = null;

/**
 * Get or create the singleton IndexingPipeline instance.
 * Follows NeuroNest's lazy-initialized singleton pattern.
 */
export function getIndexingPipeline(config: IndexingPipelineConfig): IndexingPipeline {
  if (!instance || instance['config'].projectId !== config.projectId) {
    instance = new IndexingPipeline(config);
  }
  return instance;
}

/**
 * Reset the singleton (for testing purposes).
 */
export function resetIndexingPipeline(): void {
  instance = null;
}
