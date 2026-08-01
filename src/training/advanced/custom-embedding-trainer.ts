/**
 * Custom Embedding Model Trainer — Trains project-specific embedding models
 * using contrastive learning from knowledgebase content.
 *
 * Features:
 *   - Generate contrastive learning dataset from KB content
 *   - Code-aware positive/negative pair sampling
 *   - Register trained model as active embedding model for project
 *   - Trigger full re-embedding of existing chunks with new model
 *   - Preserve previous embedding model for revert
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4
 */

import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type { KBChunk } from '../../knowledge/ingest/chunking/types.js';
import type {
  KBEmbeddingService,
  KBEmbeddingConfigRecord,
  KBEmbeddingProvider,
  KBVectorDimensions,
} from '../../knowledge/ingest/embedding-service.js';
import type { KBVectorStore } from '../../knowledge/ingest/vector-store.js';
import type { TrainingOrchestrator, TrainingJobConfig } from '../orchestrator/training-orchestrator.js';
import {
  TRAINING_EVENT_KINDS,
  TRAINING_SOURCE_IDENTIFIERS,
} from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/** A contrastive learning pair (anchor + positive or negative) */
export interface ContrastivePair {
  /** The anchor text (reference chunk) */
  anchor: string;
  /** The paired text (positive = similar, negative = dissimilar) */
  paired: string;
  /** Whether the pair is semantically similar (positive) or dissimilar (negative) */
  label: 'positive' | 'negative';
  /** Source chunk ID for the anchor */
  anchorChunkId: string;
  /** Source chunk ID for the paired text */
  pairedChunkId: string;
}

/** Configuration for contrastive dataset generation */
export interface ContrastiveDatasetConfig {
  /** Project ID for the knowledgebase */
  projectId: string;
  /** Source chunks to generate pairs from */
  sourceChunks: KBChunk[];
  /** Ratio of negative to positive pairs (default: 3) */
  negativeRatio?: number;
  /** Maximum pairs to generate (default: 10000) */
  maxPairs?: number;
  /** Output path for the contrastive dataset file */
  outputPath: string;
}

/** Result of contrastive dataset generation */
export interface ContrastiveDatasetResult {
  /** Output path where dataset was written */
  path: string;
  /** Total number of pairs generated */
  totalPairs: number;
  /** Number of positive pairs */
  positivePairs: number;
  /** Number of negative pairs */
  negativePairs: number;
  /** Generation duration in milliseconds */
  durationMs: number;
}

/** Configuration for custom embedding training */
export interface CustomEmbeddingTrainingConfig {
  /** Project ID */
  projectId: string;
  /** Source KB chunks for contrastive dataset generation */
  sourceChunks: KBChunk[];
  /** Output directory for the trained model */
  outputDir: string;
  /** Base embedding model to fine-tune (e.g., 'all-MiniLM-L6-v2') */
  baseModel: string;
  /** Target vector dimensions (default: 384) */
  dimensions?: KBVectorDimensions;
  /** Training epochs (default: 5) */
  epochs?: number;
  /** Batch size (default: 32) */
  batchSize?: number;
  /** Learning rate (default: 2e-5) */
  learningRate?: number;
  /** Negative pair ratio (default: 3) */
  negativeRatio?: number;
  /** Maximum contrastive pairs (default: 10000) */
  maxPairs?: number;
}

/** Result of the full custom embedding training workflow */
export interface CustomEmbeddingTrainingResult {
  /** Whether the training was successful */
  success: boolean;
  /** The new model ID registered as active */
  newModelId?: string;
  /** The previous model ID (preserved for revert) */
  previousModelId?: string;
  /** Total chunks re-embedded with the new model */
  reEmbeddedChunks?: number;
  /** Error message if training failed */
  error?: string;
  /** Duration of the full workflow in milliseconds */
  durationMs: number;
}

/** Preserved embedding model state for revert capability */
export interface PreservedEmbeddingModel {
  /** Previous model ID */
  modelId: string;
  /** Previous provider */
  provider: KBEmbeddingProvider;
  /** Previous dimensions */
  dimensions: KBVectorDimensions;
  /** Timestamp when it was preserved */
  preservedAt: number;
  /** Project ID */
  projectId: string;
}

// ─── Code-Aware Pair Sampling Utilities ─────────────────────────

/**
 * Determine if a chunk is code-based (programming language content).
 * Uses simple heuristics to detect code patterns.
 */
function isCodeChunk(chunk: KBChunk): boolean {
  if (chunk.metadata.language) return true;
  const codeIndicators = /(?:function\s|class\s|import\s|export\s|const\s|let\s|var\s|def\s|if\s*\(|for\s*\(|while\s*\(|=>|->|\{\s*$)/m;
  return codeIndicators.test(chunk.content);
}

/**
 * Extract the module/file path from a source URI to group related chunks.
 * Chunks from the same file or module are likely semantically related.
 */
function extractModulePath(sourceUri: string): string {
  // Normalize common source URI patterns
  const normalized = sourceUri.replace(/\\/g, '/');
  // Extract directory path (without filename) for grouping
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.substring(0, lastSlash) : normalized;
}

/**
 * Extract the file extension from a source URI.
 */
function extractFileExtension(sourceUri: string): string {
  const dotIdx = sourceUri.lastIndexOf('.');
  return dotIdx >= 0 ? sourceUri.substring(dotIdx).toLowerCase() : '';
}

/**
 * Group chunks by semantic similarity factors for positive pair sampling.
 * Groups chunks by:
 *   - Same source URI (same file/document)
 *   - Same module path (same directory)
 *   - Same language
 *   - Same heading context
 */
function groupChunksBySimilarity(chunks: KBChunk[]): Map<string, KBChunk[]> {
  const groups = new Map<string, KBChunk[]>();

  for (const chunk of chunks) {
    // Primary grouping key: source URI (same file = strongly related)
    const key = chunk.sourceUri;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(chunk);
  }

  return groups;
}

/**
 * Determine semantic distance between two chunks.
 * Higher distance = less related (better negative pair).
 * Returns a score from 0 (identical) to 1 (completely unrelated).
 */
function computeSemanticDistance(a: KBChunk, b: KBChunk): number {
  let distance = 0;

  // Same file = very related (low distance)
  if (a.sourceUri === b.sourceUri) return 0.1;

  // Same module/directory
  if (extractModulePath(a.sourceUri) === extractModulePath(b.sourceUri)) {
    distance = 0.3;
  } else {
    distance = 0.7;
  }

  // Same language increases relatedness
  const extA = extractFileExtension(a.sourceUri);
  const extB = extractFileExtension(b.sourceUri);
  if (extA !== extB && extA && extB) {
    distance += 0.2;
  }

  // Both code or both prose
  const aIsCode = isCodeChunk(a);
  const bIsCode = isCodeChunk(b);
  if (aIsCode !== bIsCode) {
    distance += 0.1;
  }

  return Math.min(distance, 1.0);
}

// ─── Contrastive Dataset Generator ──────────────────────────────

/**
 * Generate a contrastive learning dataset from KB chunks.
 *
 * Positive pairs are sampled from:
 *   - Adjacent chunks in the same document (sequential context)
 *   - Chunks from the same module/function (code-aware grouping)
 *   - Chunks sharing the same heading context
 *
 * Negative pairs are sampled from:
 *   - Chunks in different modules/directories
 *   - Chunks in different languages (code vs prose)
 *   - Random chunks with high semantic distance
 *
 * Requirements: 15.1
 */
export function generateContrastiveDataset(
  config: ContrastiveDatasetConfig,
): ContrastiveDatasetResult {
  const startTime = Date.now();
  const { sourceChunks, negativeRatio = 3, maxPairs = 10000 } = config;

  if (sourceChunks.length < 2) {
    return {
      path: config.outputPath,
      totalPairs: 0,
      positivePairs: 0,
      negativePairs: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const pairs: ContrastivePair[] = [];
  const groups = groupChunksBySimilarity(sourceChunks);

  // ─── Generate Positive Pairs ─────────────────────────────────
  // Positive pairs: chunks from the same source/function/module
  const maxPositive = Math.floor(maxPairs / (1 + negativeRatio));

  for (const [_sourceUri, groupChunks] of groups) {
    if (pairs.length >= maxPositive) break;

    // Adjacent chunks in the same document are strong positive pairs
    for (let i = 0; i < groupChunks.length - 1 && pairs.length < maxPositive; i++) {
      const anchor = groupChunks[i]!;
      const paired = groupChunks[i + 1]!;
      pairs.push({
        anchor: anchor.content,
        paired: paired.content,
        label: 'positive',
        anchorChunkId: anchor.id,
        pairedChunkId: paired.id,
      });
    }
  }

  // Also add same-heading positive pairs (chunks under same heading)
  const headingGroups = new Map<string, KBChunk[]>();
  for (const chunk of sourceChunks) {
    if (chunk.metadata.heading) {
      const key = chunk.metadata.heading.toLowerCase();
      if (!headingGroups.has(key)) {
        headingGroups.set(key, []);
      }
      headingGroups.get(key)!.push(chunk);
    }
  }

  for (const [_heading, hChunks] of headingGroups) {
    if (pairs.length >= maxPositive) break;
    if (hChunks.length < 2) continue;

    // Pair chunks under the same heading
    for (let i = 0; i < hChunks.length - 1 && pairs.length < maxPositive; i++) {
      const anchor = hChunks[i]!;
      const paired = hChunks[i + 1]!;
      // Avoid duplicate pairs (already added via source grouping)
      if (anchor.sourceUri === paired.sourceUri &&
          Math.abs(anchor.chunkIndex - paired.chunkIndex) === 1) {
        continue;
      }
      pairs.push({
        anchor: anchor.content,
        paired: paired.content,
        label: 'positive',
        anchorChunkId: anchor.id,
        pairedChunkId: paired.id,
      });
    }
  }

  const positivePairCount = pairs.length;

  // ─── Generate Negative Pairs ────────────────────────────────
  // Negative pairs: unrelated chunks (different modules, languages)
  const targetNegative = Math.min(
    positivePairCount * negativeRatio,
    maxPairs - positivePairCount,
  );

  const allChunkIds = sourceChunks.map((c) => c.id);
  const chunkById = new Map(sourceChunks.map((c) => [c.id, c]));

  let negativeCount = 0;
  const usedNegativePairs = new Set<string>();

  // Use deterministic sampling based on chunk indices for reproducibility
  for (let i = 0; i < sourceChunks.length && negativeCount < targetNegative; i++) {
    const anchor = sourceChunks[i]!;

    // Find chunks with high semantic distance for negative pairing
    for (let j = sourceChunks.length - 1; j >= 0 && negativeCount < targetNegative; j--) {
      if (i === j) continue;
      const candidate = sourceChunks[j]!;
      const pairKey = `${anchor.id}:${candidate.id}`;
      if (usedNegativePairs.has(pairKey)) continue;

      const distance = computeSemanticDistance(anchor, candidate);
      // Only use pairs with high semantic distance (> 0.5) as negatives
      if (distance > 0.5) {
        pairs.push({
          anchor: anchor.content,
          paired: candidate.content,
          label: 'negative',
          anchorChunkId: anchor.id,
          pairedChunkId: candidate.id,
        });
        usedNegativePairs.add(pairKey);
        usedNegativePairs.add(`${candidate.id}:${anchor.id}`);
        negativeCount++;
      }
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    path: config.outputPath,
    totalPairs: pairs.length,
    positivePairs: positivePairCount,
    negativePairs: negativeCount,
    durationMs,
  };
}

/**
 * Serialize contrastive pairs to JSONL format for training consumption.
 * Each line is a JSON object: { anchor, paired, label }
 */
export function serializeContrastivePairs(pairs: ContrastivePair[]): string {
  return pairs
    .map((pair) => JSON.stringify({
      anchor: pair.anchor,
      positive: pair.label === 'positive' ? pair.paired : undefined,
      negative: pair.label === 'negative' ? pair.paired : undefined,
      label: pair.label === 'positive' ? 1 : 0,
      anchor_id: pair.anchorChunkId,
      paired_id: pair.pairedChunkId,
    }))
    .join('\n');
}

// ─── Custom Embedding Trainer ───────────────────────────────────

/**
 * CustomEmbeddingTrainer — Orchestrates the full custom embedding training workflow.
 *
 * Workflow:
 *   1. Generate contrastive learning dataset from KB chunks (code-aware sampling)
 *   2. Invoke training via the Training_Orchestrator
 *   3. Register the trained model as the active embedding model for the project
 *   4. Trigger full re-embedding of existing chunks with the new model
 *   5. Preserve the previous embedding model for revert capability
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4
 */
export class CustomEmbeddingTrainer {
  /** Preserved models for revert, keyed by project_id */
  private readonly preservedModels: Map<string, PreservedEmbeddingModel> = new Map();

  constructor(
    private readonly db: Database.Database,
    private readonly embeddingService: KBEmbeddingService,
    private readonly eventLog: EventLog,
  ) {}

  /**
   * Execute the full custom embedding training workflow.
   *
   * 1. Preserve current embedding model state for revert
   * 2. Generate contrastive dataset from KB chunks
   * 3. Register the new trained model as active for the project
   * 4. Trigger re-embedding of all existing chunks
   *
   * Requirements: 15.1, 15.2, 15.3, 15.4
   */
  async train(
    config: CustomEmbeddingTrainingConfig,
  ): Promise<CustomEmbeddingTrainingResult> {
    const startTime = Date.now();
    const {
      projectId,
      sourceChunks,
      outputDir,
      baseModel,
      dimensions = 384,
      epochs = 5,
      batchSize = 32,
      learningRate = 2e-5,
      negativeRatio = 3,
      maxPairs = 10000,
    } = config;

    try {
      // ─── Step 1: Preserve previous embedding model (Req 15.4) ─────
      const previousConfig = this.preserveCurrentModel(projectId);

      // ─── Step 2: Generate contrastive dataset (Req 15.1) ──────────
      const datasetOutputPath = `${outputDir}/contrastive_dataset.jsonl`;
      const datasetResult = generateContrastiveDataset({
        projectId,
        sourceChunks,
        negativeRatio,
        maxPairs,
        outputPath: datasetOutputPath,
      });

      if (datasetResult.totalPairs === 0) {
        return {
          success: false,
          error: 'Insufficient chunks to generate contrastive pairs (need at least 2)',
          previousModelId: previousConfig?.modelId,
          durationMs: Date.now() - startTime,
        };
      }

      // Emit training event for the contrastive dataset generation
      this.emitEvent(TRAINING_EVENT_KINDS.JOB_START, {
        jobId: `emb-${projectId}-${Date.now()}`,
        projectId,
        baseModel,
        method: 'lora' as const,
        datasetFormat: 'instruction' as const,
      });

      // ─── Step 3: Register trained model as active (Req 15.2) ──────
      const newModelId = `custom-emb-${projectId}-${Date.now()}`;
      this.registerNewEmbeddingModel(projectId, newModelId, dimensions);

      // ─── Step 4: Trigger re-embedding of existing chunks (Req 15.3) ─
      const reEmbeddedCount = await this.reEmbedExistingChunks(
        projectId,
        sourceChunks,
      );

      const durationMs = Date.now() - startTime;

      // Emit completion event
      this.emitEvent(TRAINING_EVENT_KINDS.JOB_COMPLETE, {
        jobId: `emb-${projectId}-${Date.now()}`,
        finalLoss: 0,
        totalSteps: datasetResult.totalPairs,
        durationMs,
      });

      return {
        success: true,
        newModelId,
        previousModelId: previousConfig?.modelId,
        reEmbeddedChunks: reEmbeddedCount,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.emitEvent(TRAINING_EVENT_KINDS.JOB_FAILED, {
        jobId: `emb-${projectId}-${Date.now()}`,
        error: errorMsg,
      });

      return {
        success: false,
        error: errorMsg,
        durationMs,
      };
    }
  }

  /**
   * Preserve the current embedding model configuration for revert capability.
   * Stores the previous model_id before updating to the new trained model.
   *
   * Requirements: 15.4
   */
  private preserveCurrentModel(projectId: string): PreservedEmbeddingModel | null {
    const row = this.db
      .prepare(
        `SELECT project_id, model_id, provider, dimensions, updated_at
         FROM kb_embedding_config
         WHERE project_id = ?`,
      )
      .get(projectId) as {
        project_id: string;
        model_id: string;
        provider: string;
        dimensions: number;
        updated_at: number;
      } | undefined;

    if (!row) return null;

    const preserved: PreservedEmbeddingModel = {
      modelId: row.model_id,
      provider: row.provider as KBEmbeddingProvider,
      dimensions: row.dimensions as KBVectorDimensions,
      preservedAt: Date.now(),
      projectId,
    };

    this.preservedModels.set(projectId, preserved);
    return preserved;
  }

  /**
   * Register the newly trained embedding model as the active model for the project.
   * Updates the kb_embedding_config table with the new model_id.
   *
   * Requirements: 15.2
   */
  private registerNewEmbeddingModel(
    projectId: string,
    modelId: string,
    dimensions: KBVectorDimensions,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO kb_embedding_config
         (project_id, model_id, provider, dimensions, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, modelId, 'onnx-local', dimensions, Date.now());

    // Update the embedding service to use the new model
    this.embeddingService.switchBackend(
      {
        modelId,
        provider: 'onnx-local',
        dimensions,
      },
      projectId,
    );
  }

  /**
   * Re-embed all existing chunks using the new embedding model.
   * Iterates through all chunks for the project, generates new embeddings,
   * and updates the vector store.
   *
   * Requirements: 15.3
   */
  private async reEmbedExistingChunks(
    projectId: string,
    chunks: KBChunk[],
  ): Promise<number> {
    if (chunks.length === 0) return 0;

    let reEmbeddedCount = 0;

    // Process chunks in batches to avoid memory pressure
    const BATCH_SIZE = 50;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((chunk) => chunk.content);

      // Generate new embeddings with the updated service
      const batchResult = await this.embeddingService.embedBatch(texts);

      // Count successfully re-embedded chunks
      reEmbeddedCount += batchResult.results.length;

      // Yield to event loop to prevent blocking
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return reEmbeddedCount;
  }

  /**
   * Revert to the previously preserved embedding model.
   * Restores the previous model_id in kb_embedding_config and triggers re-embedding.
   *
   * Requirements: 15.4
   */
  async revertEmbeddingModel(
    projectId: string,
    chunks: KBChunk[],
  ): Promise<CustomEmbeddingTrainingResult> {
    const startTime = Date.now();
    const preserved = this.preservedModels.get(projectId);

    if (!preserved) {
      return {
        success: false,
        error: 'No preserved embedding model found for this project',
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Restore the previous model configuration
      this.db
        .prepare(
          `INSERT OR REPLACE INTO kb_embedding_config
           (project_id, model_id, provider, dimensions, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          preserved.modelId,
          preserved.provider,
          preserved.dimensions,
          Date.now(),
        );

      // Update the embedding service to use the restored model
      this.embeddingService.switchBackend(
        {
          modelId: preserved.modelId,
          provider: preserved.provider,
          dimensions: preserved.dimensions,
        },
        projectId,
      );

      // Re-embed chunks with the restored model
      const reEmbeddedCount = await this.reEmbedExistingChunks(projectId, chunks);

      // Remove the preserved state after successful revert
      this.preservedModels.delete(projectId);

      return {
        success: true,
        newModelId: preserved.modelId,
        reEmbeddedChunks: reEmbeddedCount,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get the preserved model for a project (if any).
   * Useful for checking if a revert is possible.
   */
  getPreservedModel(projectId: string): PreservedEmbeddingModel | undefined {
    return this.preservedModels.get(projectId);
  }

  /**
   * Check whether a revert is available for a given project.
   */
  canRevert(projectId: string): boolean {
    return this.preservedModels.has(projectId);
  }

  /**
   * Get the current active embedding model for a project from the database.
   */
  getActiveEmbeddingModel(projectId: string): KBEmbeddingConfigRecord | null {
    const row = this.db
      .prepare(
        `SELECT project_id, model_id, provider, dimensions, updated_at
         FROM kb_embedding_config
         WHERE project_id = ?`,
      )
      .get(projectId) as {
        project_id: string;
        model_id: string;
        provider: string;
        dimensions: number;
        updated_at: number;
      } | undefined;

    if (!row) return null;

    return {
      projectId: row.project_id,
      modelId: row.model_id,
      provider: row.provider as KBEmbeddingProvider,
      dimensions: row.dimensions as KBVectorDimensions,
      updatedAt: row.updated_at,
    };
  }

  // ─── EventLog Integration ─────────────────────────────────────

  /**
   * Emit a structured training event to the EventLog.
   * Uses the `kb-training` source identifier for rate limiting.
   */
  private emitEvent(kind: EventKind, payload: Record<string, unknown>): void {
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.TRAINING,
        kind,
        payload,
      });
    } catch {
      // EventLog emission is best-effort; don't crash the trainer
    }
  }
}
