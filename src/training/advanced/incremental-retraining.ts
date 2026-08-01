/**
 * Incremental Retraining — Detects significant KB changes and supports
 * incremental model fine-tuning from the most recent checkpoint.
 *
 * Responsibilities:
 *   - Detect when >20% of chunks changed since the last training run
 *   - Notify user that incremental retraining is recommended
 *   - Generate dataset from only changed chunks
 *   - Fine-tune from the most recent checkpoint (not base model)
 *   - Track lineage (base -> checkpoint chain) via parent_job_id for rollback
 *
 * Requirements: 17.1, 17.2, 17.3
 */

import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type { KBChunk } from '../../knowledge/ingest/chunking/types.js';
import type { TrainingCheckpointManager, Checkpoint } from '../checkpoint/checkpoint-manager.js';
import type {
  DatasetGenerator,
  DatasetGenerationConfig,
  GeneratedDataset,
} from '../dataset/dataset-generator.js';

// ─── Types ──────────────────────────────────────────────────────

/** Result of a change detection run */
export interface ChangeDetectionResult {
  /** Total number of chunks in the current knowledgebase for this project */
  totalChunks: number;
  /** Number of chunks that have been added or modified since last training */
  changedChunks: number;
  /** Percentage of chunks changed (0-100) */
  changePercentage: number;
  /** Whether the change threshold has been exceeded */
  thresholdExceeded: boolean;
  /** Timestamp of the last training run used for comparison */
  lastTrainingTimestamp: number | null;
  /** IDs of the changed chunks (for dataset generation) */
  changedChunkIds: string[];
}

/** Configuration for the incremental retraining system */
export interface IncrementalRetrainingConfig {
  /** Project identifier for scoping queries */
  projectId: string;
  /** Percentage threshold above which retraining is recommended (default: 20) */
  changeThresholdPercent: number;
  /** Dataset format to use for incremental training (default: 'instruction') */
  datasetFormat: 'instruction' | 'chat' | 'continued-pretraining' | 'grpo';
  /** Output path for the generated dataset */
  datasetOutputPath: string;
  /** Extraction strategy for instruction datasets */
  extractionStrategy?: 'entity-based' | 'summary-based' | 'conversational';
}

/** Result of an incremental retraining preparation */
export interface IncrementalRetrainingPlan {
  /** The change detection analysis */
  changeDetection: ChangeDetectionResult;
  /** The most recent checkpoint to fine-tune from (null if none available) */
  latestCheckpoint: Checkpoint | null;
  /** The parent job ID for lineage tracking */
  parentJobId: string | null;
  /** The full lineage chain from base model to this job */
  lineage: TrainingLineageEntry[];
  /** Generated dataset (populated after generateIncrementalDataset is called) */
  dataset: GeneratedDataset | null;
}

/** An entry in the training lineage chain */
export interface TrainingLineageEntry {
  /** Job ID */
  jobId: string;
  /** Parent job ID (null for the first job in the chain) */
  parentJobId: string | null;
  /** Base model used */
  baseModel: string;
  /** Training method */
  method: string;
  /** Job state */
  state: string;
  /** When the job was created */
  createdAt: number;
  /** Final loss achieved (null if job is not completed) */
  finalLoss: number | null;
}

/** Notification event payload for retraining recommendation */
export interface RetrainingNotification {
  /** Type discriminator */
  type: 'incremental-retraining-recommended';
  /** Project ID */
  projectId: string;
  /** Percentage of chunks that have changed */
  changePercentage: number;
  /** Number of changed chunks */
  changedChunks: number;
  /** Total chunks */
  totalChunks: number;
  /** Recommended action */
  recommendation: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default change threshold: 20% of chunks must change to trigger recommendation */
const DEFAULT_CHANGE_THRESHOLD_PERCENT = 20;

/** Event kind for incremental retraining notification */
export const INCREMENTAL_RETRAINING_EVENT_KIND = 'training.incremental.recommended' as EventKind;

// ─── IncrementalRetrainingManager ───────────────────────────────

/**
 * Manages incremental retraining by detecting KB changes, generating
 * datasets from changed chunks, and tracking training lineage for
 * rollback support.
 *
 * Usage:
 *   const manager = new IncrementalRetrainingManager(db, eventLog, checkpointManager, datasetGenerator);
 *   const changes = await manager.detectChanges(config);
 *   if (changes.thresholdExceeded) {
 *     // Notify user, then:
 *     const plan = await manager.preparePlan(config);
 *     const dataset = await manager.generateIncrementalDataset(plan, config);
 *   }
 */
export class IncrementalRetrainingManager {
  constructor(
    private readonly db: Database.Database,
    private readonly eventLog: EventLog | null,
    private readonly checkpointManager: TrainingCheckpointManager,
    private readonly datasetGenerator: DatasetGenerator | null,
  ) {}

  // ─── Change Detection ───────────────────────────────────────

  /**
   * Detect how many KB chunks have changed since the last completed training run
   * for the given project.
   *
   * Change detection logic:
   *   1. Find the most recent completed training job for the project
   *   2. Use its `completed_at` timestamp as the reference point
   *   3. Count chunks in kb_chunk_metadata where indexed_at > last_training_timestamp
   *   4. Compare changed count against total to determine percentage
   *
   * Requirements: 17.1
   *
   * @param config - Incremental retraining configuration
   * @returns Change detection result with statistics and changed chunk IDs
   */
  async detectChanges(config: IncrementalRetrainingConfig): Promise<ChangeDetectionResult> {
    const { projectId, changeThresholdPercent } = config;
    const threshold = changeThresholdPercent ?? DEFAULT_CHANGE_THRESHOLD_PERCENT;

    // Get the last completed training job's timestamp for this project
    const lastTrainingTimestamp = this.getLastTrainingTimestamp(projectId);

    // Count total chunks in the project
    const totalChunksRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM kb_chunk_metadata WHERE project_id = ?`,
    ).get(projectId) as { count: number } | undefined;
    const totalChunks = totalChunksRow?.count ?? 0;

    if (totalChunks === 0) {
      return {
        totalChunks: 0,
        changedChunks: 0,
        changePercentage: 0,
        thresholdExceeded: false,
        lastTrainingTimestamp,
        changedChunkIds: [],
      };
    }

    // Count chunks that changed since last training
    let changedChunks: number;
    let changedChunkIds: string[];

    if (lastTrainingTimestamp === null) {
      // No previous training run — all chunks are "new"
      changedChunks = totalChunks;
      const rows = this.db.prepare(
        `SELECT id FROM kb_chunk_metadata WHERE project_id = ?`,
      ).all(projectId) as Array<{ id: string }>;
      changedChunkIds = rows.map((r) => r.id);
    } else {
      // Find chunks indexed after the last training run
      const changedRows = this.db.prepare(
        `SELECT id FROM kb_chunk_metadata
         WHERE project_id = ? AND indexed_at > ?`,
      ).all(projectId, lastTrainingTimestamp) as Array<{ id: string }>;
      changedChunks = changedRows.length;
      changedChunkIds = changedRows.map((r) => r.id);
    }

    const changePercentage = totalChunks > 0
      ? (changedChunks / totalChunks) * 100
      : 0;

    const thresholdExceeded = changePercentage > threshold;

    return {
      totalChunks,
      changedChunks,
      changePercentage,
      thresholdExceeded,
      lastTrainingTimestamp,
      changedChunkIds,
    };
  }

  // ─── Notification ───────────────────────────────────────────

  /**
   * Emit a notification event that incremental retraining is recommended.
   * Called when change detection finds that the threshold is exceeded.
   *
   * Requirements: 17.1
   *
   * @param result - The change detection result
   * @param projectId - The project identifier
   * @returns The notification payload that was emitted
   */
  async notifyRetrainingRecommended(
    result: ChangeDetectionResult,
    projectId: string,
  ): Promise<RetrainingNotification> {
    const notification: RetrainingNotification = {
      type: 'incremental-retraining-recommended',
      projectId,
      changePercentage: Math.round(result.changePercentage * 100) / 100,
      changedChunks: result.changedChunks,
      totalChunks: result.totalChunks,
      recommendation:
        `${result.changedChunks} of ${result.totalChunks} chunks ` +
        `(${Math.round(result.changePercentage)}%) have changed since last training. ` +
        `Incremental retraining is recommended to keep the model current.`,
    };

    // Emit to EventLog for audit and UI consumption
    if (this.eventLog) {
      try {
        await this.eventLog.emit({
          sessionId: 'kb-training',
          kind: INCREMENTAL_RETRAINING_EVENT_KIND,
          payload: notification,
        });
      } catch {
        // EventLog emission is best-effort
      }
    }

    return notification;
  }

  // ─── Plan Preparation ───────────────────────────────────────

  /**
   * Prepare an incremental retraining plan with lineage information.
   *
   * Finds the most recent checkpoint and builds the lineage chain from
   * the base model through all incremental training runs.
   *
   * Requirements: 17.2, 17.3
   *
   * @param config - Incremental retraining configuration
   * @returns A retraining plan with checkpoint, lineage, and change detection info
   */
  async preparePlan(config: IncrementalRetrainingConfig): Promise<IncrementalRetrainingPlan> {
    const changeDetection = await this.detectChanges(config);

    // Find the most recent completed training job for the project
    const lastJob = this.getLastCompletedJob(config.projectId);
    const parentJobId = lastJob?.id ?? null;

    // Get the latest checkpoint from the most recent job
    let latestCheckpoint: Checkpoint | null = null;
    if (parentJobId) {
      latestCheckpoint = await this.checkpointManager.getLatest(parentJobId);
    }

    // Build the full lineage chain
    const lineage = this.getLineageChain(config.projectId);

    return {
      changeDetection,
      latestCheckpoint,
      parentJobId,
      lineage,
      dataset: null,
    };
  }

  // ─── Dataset Generation from Changed Chunks ─────────────────

  /**
   * Generate a training dataset from only the changed chunks.
   *
   * Requirements: 17.2
   *
   * @param plan - The prepared retraining plan (must have changeDetection.changedChunkIds)
   * @param config - Incremental retraining configuration
   * @returns The generated dataset
   */
  async generateIncrementalDataset(
    plan: IncrementalRetrainingPlan,
    config: IncrementalRetrainingConfig,
  ): Promise<GeneratedDataset> {
    if (!this.datasetGenerator) {
      throw new Error(
        'Dataset generator is required for incremental retraining. ' +
        'Ensure the training pipeline is properly initialized.',
      );
    }

    const { changedChunkIds } = plan.changeDetection;

    if (changedChunkIds.length === 0) {
      throw new Error(
        'No changed chunks to generate dataset from. ' +
        'Change detection found no modifications since last training.',
      );
    }

    // Retrieve the changed chunk content from the database
    const changedChunks = this.getChunksByIds(changedChunkIds, config.projectId);

    // Generate dataset from only the changed chunks
    const datasetConfig: DatasetGenerationConfig = {
      format: config.datasetFormat,
      sourceChunks: changedChunks,
      extractionStrategy: config.extractionStrategy ?? 'summary-based',
      outputPath: config.datasetOutputPath,
    };

    const dataset = await this.datasetGenerator.generate(datasetConfig);

    // Update the plan with the generated dataset
    plan.dataset = dataset;

    return dataset;
  }

  // ─── Lineage Tracking ───────────────────────────────────────

  /**
   * Get the full training lineage chain for a project.
   *
   * Walks back through parent_job_id references to build the complete
   * chain from the original base training to the most recent incremental run.
   *
   * Requirements: 17.3
   *
   * @param projectId - The project identifier
   * @returns Array of lineage entries ordered from oldest (base) to newest
   */
  getLineageChain(projectId: string): TrainingLineageEntry[] {
    // Get all completed or running jobs for this project, ordered by creation
    const rows = this.db.prepare(
      `SELECT id, parent_job_id, base_model, method, state, created_at, final_loss
       FROM training_jobs
       WHERE project_id = ?
       ORDER BY created_at ASC`,
    ).all(projectId) as Array<{
      id: string;
      parent_job_id: string | null;
      base_model: string;
      method: string;
      state: string;
      created_at: number;
      final_loss: number | null;
    }>;

    return rows.map((row) => ({
      jobId: row.id,
      parentJobId: row.parent_job_id,
      baseModel: row.base_model,
      method: row.method,
      state: row.state,
      createdAt: row.created_at,
      finalLoss: row.final_loss,
    }));
  }

  /**
   * Get the lineage chain for a specific job, walking backward through parents.
   *
   * @param jobId - Starting job ID
   * @returns Array of lineage entries from the root (base) to this job
   */
  getJobLineage(jobId: string): TrainingLineageEntry[] {
    const lineage: TrainingLineageEntry[] = [];
    let currentId: string | null = jobId;

    while (currentId) {
      const row = this.db.prepare(
        `SELECT id, parent_job_id, base_model, method, state, created_at, final_loss
         FROM training_jobs WHERE id = ?`,
      ).get(currentId) as {
        id: string;
        parent_job_id: string | null;
        base_model: string;
        method: string;
        state: string;
        created_at: number;
        final_loss: number | null;
      } | undefined;

      if (!row) break;

      lineage.unshift({
        jobId: row.id,
        parentJobId: row.parent_job_id,
        baseModel: row.base_model,
        method: row.method,
        state: row.state,
        createdAt: row.created_at,
        finalLoss: row.final_loss,
      });

      currentId = row.parent_job_id;
    }

    return lineage;
  }

  /**
   * Create a new training job record configured for incremental retraining.
   *
   * Sets parent_job_id to link to the previous job for lineage tracking,
   * and configures the job to start from the latest checkpoint rather than
   * the base model.
   *
   * Requirements: 17.2, 17.3
   *
   * @param plan - The prepared retraining plan
   * @param config - Job configuration for the incremental training run
   * @returns The job ID of the new incremental training job
   */
  createIncrementalJob(
    plan: IncrementalRetrainingPlan,
    jobConfig: {
      id: string;
      projectId: string;
      baseModel: string;
      method: string;
      datasetPath: string;
      datasetFormat: string;
      configJson: string;
      outputDir: string;
      totalEpochs: number;
    },
  ): string {
    const { parentJobId } = plan;

    this.db.prepare(
      `INSERT INTO training_jobs
        (id, project_id, base_model, method, dataset_path, dataset_format,
         config_json, state, total_epochs, output_dir, created_at, parent_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(
      jobConfig.id,
      jobConfig.projectId,
      jobConfig.baseModel,
      jobConfig.method,
      jobConfig.datasetPath,
      jobConfig.datasetFormat,
      jobConfig.configJson,
      jobConfig.totalEpochs,
      jobConfig.outputDir,
      Date.now(),
      parentJobId,
    );

    return jobConfig.id;
  }

  // ─── Rollback Support ───────────────────────────────────────

  /**
   * Find a specific ancestor job in the lineage chain for rollback.
   *
   * Given a job ID, walks back through the lineage to find the job
   * at the specified depth (0 = current, 1 = parent, 2 = grandparent, etc.)
   *
   * Requirements: 17.3
   *
   * @param jobId - Starting job ID
   * @param depth - How many steps back in the chain (0 = the job itself)
   * @returns The ancestor job ID or null if not found at that depth
   */
  findAncestorJob(jobId: string, depth: number): string | null {
    const lineage = this.getJobLineage(jobId);

    // Lineage is ordered [root, ..., current], so the target is at
    // (lineage.length - 1 - depth)
    const index = lineage.length - 1 - depth;
    if (index < 0 || index >= lineage.length) {
      return null;
    }

    return lineage[index]!.jobId;
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Get the timestamp of the most recently completed training job for a project.
   * Returns null if no completed training jobs exist.
   */
  private getLastTrainingTimestamp(projectId: string): number | null {
    const row = this.db.prepare(
      `SELECT completed_at FROM training_jobs
       WHERE project_id = ? AND state = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
    ).get(projectId) as { completed_at: number | null } | undefined;

    return row?.completed_at ?? null;
  }

  /**
   * Get the most recently completed training job for a project.
   */
  private getLastCompletedJob(
    projectId: string,
  ): { id: string; baseModel: string; method: string } | null {
    const row = this.db.prepare(
      `SELECT id, base_model, method FROM training_jobs
       WHERE project_id = ? AND state = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
    ).get(projectId) as { id: string; base_model: string; method: string } | undefined;

    if (!row) return null;
    return { id: row.id, baseModel: row.base_model, method: row.method };
  }

  /**
   * Retrieve chunk data by IDs from the kb_chunk_metadata table.
   * Returns KBChunk-compatible objects with content reconstructed from metadata.
   *
   * Note: The actual chunk content is stored in LanceDB. This method
   * retrieves metadata and uses a content placeholder. In production,
   * the full content would be fetched from LanceDB via the vector store.
   */
  private getChunksByIds(chunkIds: string[], projectId: string): KBChunk[] {
    if (chunkIds.length === 0) return [];

    // Build parameterized query for the chunk IDs
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, source_uri, chunk_index, content_hash, token_count,
              llm_token_count, heading, language, line_start, line_end,
              continuation_group_id
       FROM kb_chunk_metadata
       WHERE id IN (${placeholders}) AND project_id = ?`,
    ).all(...chunkIds, projectId) as Array<{
      id: string;
      source_uri: string;
      chunk_index: number;
      content_hash: string;
      token_count: number;
      llm_token_count: number;
      heading: string | null;
      language: string | null;
      line_start: number | null;
      line_end: number | null;
      continuation_group_id: string | null;
    }>;

    return rows.map((row): KBChunk => {
      const metadata: KBChunk['metadata'] = {};
      if (row.heading !== null) metadata.heading = row.heading;
      if (row.language !== null) metadata.language = row.language;
      if (row.line_start !== null) metadata.lineStart = row.line_start;
      if (row.line_end !== null) metadata.lineEnd = row.line_end;

      const chunk: KBChunk = {
        id: row.id,
        sourceUri: row.source_uri,
        chunkIndex: row.chunk_index,
        content: '', // Content must be fetched from LanceDB vector store
        contentHash: row.content_hash,
        tokenCount: row.token_count,
        llmTokenCount: row.llm_token_count,
        metadata,
      };
      if (row.continuation_group_id !== null) {
        chunk.continuationGroupId = row.continuation_group_id;
      }
      return chunk;
    });
  }
}
