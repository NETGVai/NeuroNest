/**
 * Continued Pre-Training — Assembles the full indexed KB as a raw text corpus
 * and trains the model using CPT-specific hyperparameters.
 *
 * Responsibilities:
 *   - Query all KB chunks for a project from SQLite (kb_chunk_metadata table)
 *   - Assemble chunks into a raw text corpus with configurable separators
 *   - Configure training with CPT-specific hyperparameters:
 *     • Lower learning rate (~5e-5 vs 2e-4 for fine-tuning)
 *     • More epochs (~5-10 vs 3 for fine-tuning)
 *     • No instruction formatting (raw text only)
 *   - Trigger standard training + export pipeline via Training_Orchestrator
 *   - Export and register via standard GGUF pipeline
 *
 * Requirements: 16.1, 16.2, 16.3
 */

import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type {
  TrainingOrchestrator,
  TrainingJobConfig,
  HyperparameterConfig,
  HardwareProfile,
  QuantizationType,
} from '../orchestrator/training-orchestrator.js';
import type {
  DatasetGenerator,
  DatasetGenerationConfig,
  GeneratedDataset,
} from '../dataset/dataset-generator.js';
import type { GGUFExporter, GGUFExportConfig, ExportResult } from '../export/gguf-exporter.js';
import type { KBChunk } from '../../knowledge/ingest/chunking/types.js';
import { TRAINING_EVENT_KINDS, TRAINING_SOURCE_IDENTIFIERS } from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Configuration for a continued pre-training run.
 */
export interface ContinuedPretrainingConfig {
  /** Project identifier to query KB chunks for */
  projectId: string;
  /** Base model to train on (e.g., 'llama-3.1-8b') */
  baseModel: string;
  /** Document separator for corpus assembly (default: '\n\n===\n\n') */
  documentSeparator?: string;
  /** Learning rate for CPT (default: 5e-5) */
  learningRate?: number;
  /** Number of training epochs (default: 5) */
  epochs?: number;
  /** Batch size (default: 2) */
  batchSize?: number;
  /** Warmup steps (default: 50) */
  warmupSteps?: number;
  /** Weight decay (default: 0.01) */
  weightDecay?: number;
  /** Gradient accumulation steps (default: 8) */
  gradientAccumulationSteps?: number;
  /** Output directory for training artifacts */
  outputDir: string;
  /** Checkpoint directory for saving training state */
  checkpointDir: string;
  /** Path to the training script */
  scriptPath: string;
  /** Hardware profile for the training run */
  hardware: HardwareProfile;
  /** Quantization type for GGUF export (default: 'q4_0') */
  quantization?: QuantizationType;
  /** Ollama model name for registration after export */
  ollamaModelName?: string;
  /** Checkpoint interval in epochs (default: 1) */
  checkpointIntervalEpochs?: number;
  /** Whether to skip GGUF export after training (default: false) */
  skipExport?: boolean;
  /** Optional ordering for corpus assembly: 'source' | 'chronological' (default: 'source') */
  corpusOrdering?: 'source' | 'chronological';
}

/**
 * Result of a continued pre-training run.
 */
export interface ContinuedPretrainingResult {
  /** Training job ID from the orchestrator */
  jobId: string;
  /** Dataset that was generated for CPT */
  dataset: GeneratedDataset;
  /** GGUF export result (null if export was skipped or training not yet complete) */
  exportResult: ExportResult | null;
  /** Number of KB chunks assembled into the corpus */
  chunkCount: number;
  /** Total tokens in the assembled corpus */
  totalTokens: number;
  /** The hyperparameters used for training */
  hyperparameters: HyperparameterConfig;
}

/**
 * Summary of the corpus assembled from KB chunks.
 */
export interface CorpusSummary {
  /** Total number of chunks assembled */
  chunkCount: number;
  /** Total estimated tokens in the corpus */
  totalTokens: number;
  /** Distinct source URIs represented */
  sourceCount: number;
  /** Total byte size of the assembled text */
  totalBytes: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default document separator for corpus assembly */
const DEFAULT_DOCUMENT_SEPARATOR = '\n\n===\n\n';

/**
 * CPT-specific hyperparameter defaults.
 * These differ from fine-tuning defaults:
 *   - Lower learning rate (5e-5 vs 2e-4) to avoid catastrophic forgetting
 *   - More epochs (5 vs 3) for deeper knowledge integration
 *   - Higher gradient accumulation (8 vs 4) for effective larger batch sizes
 */
const CPT_DEFAULT_HYPERPARAMETERS: HyperparameterConfig = {
  learningRate: 5e-5,
  batchSize: 2,
  epochs: 5,
  warmupSteps: 50,
  weightDecay: 0.01,
  gradientAccumulationSteps: 8,
};

/** Default quantization for CPT model export */
const DEFAULT_QUANTIZATION: QuantizationType = 'q4_0';

/** Default checkpoint interval for CPT (every epoch) */
const DEFAULT_CHECKPOINT_INTERVAL_EPOCHS = 1;

// ─── Row Type ───────────────────────────────────────────────────

/** SQLite row shape from kb_chunk_metadata */
interface ChunkMetadataRow {
  id: string;
  source_id: string;
  project_id: string;
  chunk_index: number;
  content_hash: string;
  byte_size: number;
  token_count: number;
  llm_token_count: number;
  source_uri: string;
  heading: string | null;
  language: string | null;
  line_start: number | null;
  line_end: number | null;
  continuation_group_id: string | null;
  indexed_at: number;
}

// ─── ContinuedPretrainer Class ──────────────────────────────────

/**
 * ContinuedPretrainer — orchestrates continued pre-training on the full
 * project knowledgebase.
 *
 * Flow:
 * 1. Query all KB chunks for the project from SQLite
 * 2. Assemble them into a raw text corpus with configurable separators
 * 3. Generate the CPT dataset via the DatasetGenerator
 * 4. Configure CPT-specific hyperparameters
 * 5. Start training via the TrainingOrchestrator
 * 6. After training completes, export via standard GGUF pipeline
 */
export class ContinuedPretrainer {
  constructor(
    private readonly db: Database.Database,
    private readonly datasetGenerator: DatasetGenerator,
    private readonly orchestrator: TrainingOrchestrator,
    private readonly ggufExporter: GGUFExporter,
    private readonly eventLog: EventLog | null,
  ) {}

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Get a summary of the corpus that would be assembled for the given project.
   * Useful for displaying to the user before initiating CPT.
   */
  getCorpusSummary(projectId: string): CorpusSummary {
    const chunks = this.queryProjectChunks(projectId);
    const sourceUris = new Set(chunks.map((c) => c.source_uri));
    const totalTokens = chunks.reduce((sum, c) => sum + c.llm_token_count, 0);
    const totalBytes = chunks.reduce((sum, c) => sum + c.byte_size, 0);

    return {
      chunkCount: chunks.length,
      totalTokens,
      sourceCount: sourceUris.size,
      totalBytes,
    };
  }

  /**
   * Initiate continued pre-training on the full project knowledgebase.
   *
   * Steps:
   * 1. Query all KB chunks for the project
   * 2. Assemble the raw text corpus via DatasetGenerator (continued-pretraining format)
   * 3. Configure CPT-specific hyperparameters
   * 4. Start the training job via TrainingOrchestrator
   * 5. Return the job ID and dataset metadata
   *
   * GGUF export is triggered separately after training completes (via the orchestrator's
   * standard post-training pipeline), or can be explicitly triggered with `exportModel()`.
   *
   * Requirements: 16.1, 16.2, 16.3
   */
  async startPretraining(config: ContinuedPretrainingConfig): Promise<ContinuedPretrainingResult> {
    const {
      projectId,
      baseModel,
      documentSeparator = DEFAULT_DOCUMENT_SEPARATOR,
      outputDir,
      checkpointDir,
      scriptPath,
      hardware,
      checkpointIntervalEpochs = DEFAULT_CHECKPOINT_INTERVAL_EPOCHS,
      corpusOrdering = 'source',
    } = config;

    // Step 1: Query all KB chunks for the project
    const chunkRows = this.queryProjectChunks(projectId);

    if (chunkRows.length === 0) {
      throw new ContinuedPretrainingError(
        `No KB chunks found for project ${projectId}. ` +
        'Index knowledgebase content before starting continued pre-training.',
      );
    }

    // Step 2: Convert rows to KBChunk format and order them
    const kbChunks = this.rowsToKBChunks(chunkRows, corpusOrdering);

    // Step 3: Generate the CPT dataset using DatasetGenerator
    const datasetOutputPath = `${outputDir}/cpt-dataset.jsonl`;
    const datasetConfig: DatasetGenerationConfig = {
      format: 'continued-pretraining',
      sourceChunks: kbChunks,
      outputPath: datasetOutputPath,
      documentSeparator,
    };

    const dataset = await this.datasetGenerator.generate(datasetConfig);

    // Step 4: Build CPT-specific hyperparameters
    const hyperparameters = this.buildCPTHyperparameters(config);

    // Step 5: Create and start the training job
    const jobId = this.generateJobId();
    const trainingConfig: TrainingJobConfig = {
      id: jobId,
      projectId,
      baseModel,
      method: 'full-finetune', // CPT uses full fine-tune (no LoRA for pretraining)
      datasetPath: datasetOutputPath,
      datasetFormat: 'continued-pretraining',
      hyperparameters,
      hardware,
      outputDir,
      checkpointDir,
      scriptPath,
      checkpointIntervalEpochs,
      validationSplit: 0, // CPT typically doesn't use validation split
    };

    await this.orchestrator.startJob(trainingConfig);

    // Emit CPT-specific event
    this.emitEvent('training.job.start', {
      jobId,
      projectId,
      baseModel,
      method: 'full-finetune',
      datasetFormat: 'continued-pretraining',
      chunkCount: chunkRows.length,
      totalTokens: dataset.totalTokens,
      hyperparameters,
    });

    return {
      jobId,
      dataset,
      exportResult: null, // Export happens after training completes
      chunkCount: chunkRows.length,
      totalTokens: dataset.totalTokens,
      hyperparameters,
    };
  }

  /**
   * Export a completed CPT model via the standard GGUF pipeline.
   *
   * Call this after training completes to export the model to GGUF format
   * and register it with Ollama and the Provider_Registry.
   *
   * Requirements: 16.3
   */
  async exportModel(
    modelPath: string,
    config: ContinuedPretrainingConfig,
  ): Promise<ExportResult> {
    const {
      projectId,
      baseModel,
      quantization = DEFAULT_QUANTIZATION,
      ollamaModelName,
    } = config;

    const modelName = ollamaModelName ?? `${baseModel}-cpt-${projectId.slice(0, 8)}`;

    const exportConfig: GGUFExportConfig = {
      modelPath,
      outputPath: `${config.outputDir}/${modelName}.gguf`,
      quantization,
      ollamaModelName: modelName,
    };

    const result = await this.ggufExporter.export(exportConfig);

    // Emit export complete event
    this.emitEvent('training.export.complete', {
      projectId,
      modelName,
      ggufPath: result.ggufPath,
      quantization,
      sizeBytes: result.sizeBytes,
      ollamaRegistered: result.ollamaRegistered,
    });

    return result;
  }

  // ─── Private: KB Chunk Querying ─────────────────────────────

  /**
   * Query all KB chunk metadata for a project from SQLite.
   * Returns chunks ordered by source_uri and chunk_index for consistent
   * corpus assembly.
   */
  private queryProjectChunks(projectId: string): ChunkMetadataRow[] {
    const rows = this.db.prepare(
      `SELECT id, source_id, project_id, chunk_index, content_hash, byte_size,
              token_count, llm_token_count, source_uri, heading, language,
              line_start, line_end, continuation_group_id, indexed_at
       FROM kb_chunk_metadata
       WHERE project_id = ?
       ORDER BY source_uri ASC, chunk_index ASC`,
    ).all(projectId) as ChunkMetadataRow[];

    return rows;
  }

  /**
   * Convert SQLite rows to KBChunk format for the DatasetGenerator.
   * Applies the requested corpus ordering.
   */
  private rowsToKBChunks(
    rows: ChunkMetadataRow[],
    ordering: 'source' | 'chronological',
  ): KBChunk[] {
    // Apply ordering
    const orderedRows = ordering === 'chronological'
      ? [...rows].sort((a, b) => a.indexed_at - b.indexed_at)
      : rows; // Already ordered by source_uri, chunk_index from the query

    return orderedRows.map((row) => ({
      id: row.id,
      sourceUri: row.source_uri,
      chunkIndex: row.chunk_index,
      content: '', // Content is stored in LanceDB; metadata row is used for assembly reference
      contentHash: row.content_hash,
      tokenCount: row.token_count,
      llmTokenCount: row.llm_token_count,
      continuationGroupId: row.continuation_group_id ?? undefined,
      metadata: {
        heading: row.heading ?? undefined,
        language: row.language ?? undefined,
        lineStart: row.line_start ?? undefined,
        lineEnd: row.line_end ?? undefined,
      },
    }));
  }

  // ─── Private: Hyperparameter Configuration ──────────────────

  /**
   * Build CPT-specific hyperparameters from user config and defaults.
   *
   * CPT hyperparameters differ from fine-tuning:
   * - Learning rate: ~5e-5 (vs 2e-4 for LoRA fine-tuning)
   * - Epochs: 5-10 (vs 3 for fine-tuning)
   * - No instruction formatting — raw text only
   * - Higher gradient accumulation for effective larger batches
   *
   * Requirements: 16.2
   */
  private buildCPTHyperparameters(config: ContinuedPretrainingConfig): HyperparameterConfig {
    return {
      learningRate: config.learningRate ?? CPT_DEFAULT_HYPERPARAMETERS.learningRate,
      batchSize: config.batchSize ?? CPT_DEFAULT_HYPERPARAMETERS.batchSize,
      epochs: config.epochs ?? CPT_DEFAULT_HYPERPARAMETERS.epochs,
      warmupSteps: config.warmupSteps ?? CPT_DEFAULT_HYPERPARAMETERS.warmupSteps,
      weightDecay: config.weightDecay ?? CPT_DEFAULT_HYPERPARAMETERS.weightDecay,
      gradientAccumulationSteps:
        config.gradientAccumulationSteps ??
        CPT_DEFAULT_HYPERPARAMETERS.gradientAccumulationSteps,
    };
  }

  // ─── Private: Job ID Generation ─────────────────────────────

  /**
   * Generate a unique job ID for the CPT training run.
   * Uses a timestamp-based ID with 'cpt-' prefix for easy identification.
   */
  private generateJobId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `cpt-${timestamp}-${random}`;
  }

  // ─── Private: EventLog ──────────────────────────────────────

  /**
   * Emit a structured event to the EventLog.
   */
  private emitEvent(kind: string, payload: Record<string, unknown>): void {
    if (!this.eventLog) return;
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.TRAINING,
        kind: kind as EventKind,
        payload,
      });
    } catch {
      // EventLog emission is best-effort
    }
  }
}

// ─── Errors ─────────────────────────────────────────────────────

export class ContinuedPretrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContinuedPretrainingError';
  }
}
