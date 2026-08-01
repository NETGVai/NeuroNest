/**
 * Data Retention and Cleanup Module — Manages artifact lifecycle and disk usage.
 *
 * Responsibilities:
 *   - Delete all artifacts when a training job is deleted (checkpoints, weights, datasets, logs)
 *   - Delete chunks from LanceDB + metadata from SQLite when a source is removed (coordinated transaction)
 *   - Display storage usage summary (chunks, checkpoints, models, datasets)
 *   - Emit warning when total training artifact storage exceeds a configurable threshold (default: 10 GB)
 *   - Support manual cleanup trigger from UI
 *
 * Requirements: 35.1, 35.2, 35.3, 35.4, 35.5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type { KBVectorStore } from '../../knowledge/ingest/vector-store.js';
import {
  TRAINING_EVENT_KINDS,
  TRAINING_SOURCE_IDENTIFIERS,
} from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/** Storage usage summary broken down by artifact type */
export interface StorageUsageSummary {
  /** Total disk space used by KB chunks/embeddings (bytes) */
  chunksBytes: number;
  /** Number of chunks stored */
  chunksCount: number;
  /** Total disk space used by training checkpoints (bytes) */
  checkpointsBytes: number;
  /** Number of checkpoints stored */
  checkpointsCount: number;
  /** Total disk space used by exported GGUF models (bytes) */
  modelsBytes: number;
  /** Number of models stored */
  modelsCount: number;
  /** Total disk space used by generated datasets (bytes) */
  datasetsBytes: number;
  /** Number of datasets stored */
  datasetsCount: number;
  /** Total disk space across all artifacts (bytes) */
  totalBytes: number;
  /** Whether the total exceeds the configured threshold */
  exceedsThreshold: boolean;
  /** Configured threshold in bytes */
  thresholdBytes: number;
}

/** Configuration for the data retention module */
export interface DataRetentionConfig {
  /** Maximum total artifact storage before emitting a warning (bytes). Default: 10 GB */
  storageThresholdBytes: number;
  /** Project ID scope for cleanup operations */
  projectId: string;
}

/** Result of a job deletion operation */
export interface JobDeletionResult {
  /** Job ID that was deleted */
  jobId: string;
  /** Number of checkpoints removed */
  checkpointsRemoved: number;
  /** Number of datasets removed */
  datasetsRemoved: number;
  /** Number of models removed */
  modelsRemoved: number;
  /** Number of metric records removed */
  metricsRemoved: number;
  /** Total bytes freed from disk */
  bytesFreed: number;
}

/** Result of a source removal operation */
export interface SourceRemovalResult {
  /** Source ID that was removed */
  sourceId: string;
  /** Number of chunks removed from LanceDB */
  chunksRemovedFromVector: number;
  /** Number of metadata records removed from SQLite */
  metadataRecordsRemoved: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default storage threshold: 10 GB */
const DEFAULT_STORAGE_THRESHOLD_BYTES = 10 * 1024 * 1024 * 1024;

/** Event kind for storage warning */
const STORAGE_WARNING_EVENT_KIND = 'training.storage.warning' as EventKind;

// ─── DataRetentionManager ───────────────────────────────────────

/**
 * DataRetentionManager — orchestrates cleanup and disk usage monitoring
 * for training and knowledgebase artifacts.
 *
 * Integrates with:
 *   - SQLite for metadata queries and transactional deletion
 *   - KBVectorStore (LanceDB) for vector data deletion
 *   - EventLog for emitting storage threshold warnings
 *   - Filesystem for artifact file deletion
 */
export class DataRetentionManager {
  private readonly config: DataRetentionConfig;

  constructor(
    private readonly db: Database.Database,
    private readonly vectorStore: KBVectorStore,
    private readonly eventLog: EventLog,
    config: Partial<DataRetentionConfig> & { projectId: string },
  ) {
    this.config = {
      storageThresholdBytes: config.storageThresholdBytes ?? DEFAULT_STORAGE_THRESHOLD_BYTES,
      projectId: config.projectId,
    };
  }

  // ─── Job Deletion ───────────────────────────────────────────

  /**
   * Delete all artifacts associated with a training job.
   *
   * Removes: checkpoints (files + DB records), intermediate weights,
   * generated datasets (files + DB records), training logs/metrics,
   * and exported models (files + DB records).
   *
   * All SQLite operations run within a single transaction for atomicity.
   *
   * Requirements: 35.1, 35.2
   */
  async deleteJobArtifacts(jobId: string): Promise<JobDeletionResult> {
    let checkpointsRemoved = 0;
    let datasetsRemoved = 0;
    let modelsRemoved = 0;
    let metricsRemoved = 0;
    let bytesFreed = 0;

    // Gather all file paths to delete before the transaction
    const checkpointPaths = this.getCheckpointPaths(jobId);
    const modelPaths = this.getModelPaths(jobId);
    const datasetPaths = this.getDatasetPaths(jobId);
    const outputDir = this.getJobOutputDir(jobId);

    // Calculate bytes to be freed
    for (const p of checkpointPaths) {
      bytesFreed += this.getPathSize(p);
    }
    for (const p of modelPaths) {
      bytesFreed += this.getPathSize(p);
    }
    for (const p of datasetPaths) {
      bytesFreed += this.getPathSize(p);
    }
    if (outputDir) {
      bytesFreed += this.getPathSize(outputDir);
    }

    // Run SQLite deletions in a transaction
    const transaction = this.db.transaction(() => {
      // Delete training metrics
      const metricsResult = this.db.prepare(
        `DELETE FROM training_metrics WHERE job_id = ?`,
      ).run(jobId);
      metricsRemoved = metricsResult.changes;

      // Delete checkpoints
      const checkpointsResult = this.db.prepare(
        `DELETE FROM training_checkpoints WHERE job_id = ?`,
      ).run(jobId);
      checkpointsRemoved = checkpointsResult.changes;

      // Delete exported models associated with this job
      const modelsResult = this.db.prepare(
        `DELETE FROM training_models WHERE job_id = ?`,
      ).run(jobId);
      modelsRemoved = modelsResult.changes;

      // Delete datasets associated with this job (by matching output_dir pattern)
      // Datasets reference the job indirectly via project scope; we delete those
      // whose path is under the job's output directory
      if (outputDir) {
        const datasetsResult = this.db.prepare(
          `DELETE FROM training_datasets WHERE path LIKE ? AND project_id = ?`,
        ).run(`${outputDir}%`, this.config.projectId);
        datasetsRemoved = datasetsResult.changes;
      }

      // Delete the job record itself
      this.db.prepare(
        `DELETE FROM training_jobs WHERE id = ?`,
      ).run(jobId);
    });

    transaction();

    // Delete files from disk (best-effort, non-fatal)
    for (const p of checkpointPaths) {
      this.deletePathSafely(p);
    }
    for (const p of modelPaths) {
      this.deletePathSafely(p);
    }
    for (const p of datasetPaths) {
      this.deletePathSafely(p);
    }
    if (outputDir) {
      this.deletePathSafely(outputDir);
    }

    // Check storage threshold after cleanup
    await this.checkStorageThreshold();

    return {
      jobId,
      checkpointsRemoved,
      datasetsRemoved,
      modelsRemoved,
      metricsRemoved,
      bytesFreed,
    };
  }

  // ─── Source Removal (Coordinated LanceDB + SQLite) ──────────

  /**
   * Delete all chunks from LanceDB and metadata from SQLite when a source is removed.
   *
   * Coordination strategy:
   *   1. Delete metadata from SQLite within a transaction
   *   2. Delete vectors from LanceDB after SQLite commits
   *   (LanceDB doesn't support cross-store transactions, so SQLite is the
   *   source of truth; if LanceDB fails, metadata is already gone and
   *   orphaned vectors will be cleaned up on next reconciliation)
   *
   * Requirements: 35.2
   */
  async removeSourceData(sourceId: string): Promise<SourceRemovalResult> {
    let metadataRecordsRemoved = 0;

    // Step 1: Delete from SQLite in a transaction
    const transaction = this.db.transaction(() => {
      // Delete chunk metadata
      const chunkResult = this.db.prepare(
        `DELETE FROM kb_chunk_metadata WHERE source_id = ?`,
      ).run(sourceId);
      metadataRecordsRemoved = chunkResult.changes;

      // Delete freshness record
      this.db.prepare(
        `DELETE FROM kb_freshness WHERE source_id = ?`,
      ).run(sourceId);

      // Delete the source record itself
      this.db.prepare(
        `DELETE FROM kb_sources WHERE id = ?`,
      ).run(sourceId);
    });

    transaction();

    // Step 2: Delete vectors from LanceDB (after SQLite transaction commits)
    let chunksRemovedFromVector = 0;
    try {
      chunksRemovedFromVector = await this.vectorStore.deleteBySourceId(sourceId);
    } catch (err) {
      // Log but don't fail — SQLite is source of truth
      // Orphaned vectors will not be returned in queries since metadata is gone
      console.warn(
        `[DataRetention] Failed to delete vectors from LanceDB for source ${sourceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    return {
      sourceId,
      chunksRemovedFromVector,
      metadataRecordsRemoved,
    };
  }

  // ─── Storage Usage Summary ──────────────────────────────────

  /**
   * Calculate and return a storage usage summary for the current project.
   *
   * Queries SQLite for stored artifact metadata and sums up disk usage.
   * Checks against the configured threshold and returns whether it's exceeded.
   *
   * Requirements: 35.3
   */
  async getStorageUsage(): Promise<StorageUsageSummary> {
    // Chunks: count + estimated size from SQLite metadata
    const chunksRow = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(byte_size), 0) as total_bytes
       FROM kb_chunk_metadata WHERE project_id = ?`,
    ).get(this.config.projectId) as { count: number; total_bytes: number } | undefined;

    const chunksCount = chunksRow?.count ?? 0;
    const chunksBytes = chunksRow?.total_bytes ?? 0;

    // Checkpoints: sum sizes from training_checkpoints joined with training_jobs for project scoping
    const checkpointsRow = this.db.prepare(
      `SELECT COUNT(tc.id) as count, COALESCE(SUM(tc.size_bytes), 0) as total_bytes
       FROM training_checkpoints tc
       JOIN training_jobs tj ON tc.job_id = tj.id
       WHERE tj.project_id = ?`,
    ).get(this.config.projectId) as { count: number; total_bytes: number } | undefined;

    const checkpointsCount = checkpointsRow?.count ?? 0;
    const checkpointsBytes = checkpointsRow?.total_bytes ?? 0;

    // Models: sum sizes from training_models
    const modelsRow = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_bytes
       FROM training_models WHERE project_id = ?`,
    ).get(this.config.projectId) as { count: number; total_bytes: number } | undefined;

    const modelsCount = modelsRow?.count ?? 0;
    const modelsBytes = modelsRow?.total_bytes ?? 0;

    // Datasets: calculate from file sizes on disk
    const datasetsRows = this.db.prepare(
      `SELECT path FROM training_datasets WHERE project_id = ?`,
    ).all(this.config.projectId) as Array<{ path: string }>;

    let datasetsBytes = 0;
    const datasetsCount = datasetsRows.length;
    for (const row of datasetsRows) {
      datasetsBytes += this.getPathSize(row.path);
    }

    const totalBytes = chunksBytes + checkpointsBytes + modelsBytes + datasetsBytes;
    const exceedsThreshold = totalBytes > this.config.storageThresholdBytes;

    return {
      chunksBytes,
      chunksCount,
      checkpointsBytes,
      checkpointsCount,
      modelsBytes,
      modelsCount,
      datasetsBytes,
      datasetsCount,
      totalBytes,
      exceedsThreshold,
      thresholdBytes: this.config.storageThresholdBytes,
    };
  }

  // ─── Threshold Warning ──────────────────────────────────────

  /**
   * Check if total artifact storage exceeds the configured threshold.
   * Emits a warning event to EventLog if it does.
   *
   * Requirements: 35.4
   */
  async checkStorageThreshold(): Promise<boolean> {
    const usage = await this.getStorageUsage();

    if (usage.exceedsThreshold) {
      this.emitStorageWarning(usage);
      return true;
    }

    return false;
  }

  // ─── Manual Cleanup Trigger ─────────────────────────────────

  /**
   * Perform a manual cleanup pass on the project's training artifacts.
   *
   * This is triggered from the UI and applies the retention policies:
   *   - Remove orphaned checkpoints (job no longer exists)
   *   - Remove orphaned datasets (no associated job in completed/running state)
   *   - Remove orphaned model files (no DB record)
   *
   * Requirements: 35.5
   */
  async performManualCleanup(): Promise<{ bytesFreed: number; itemsRemoved: number }> {
    let bytesFreed = 0;
    let itemsRemoved = 0;

    // Find orphaned checkpoints (job doesn't exist or was deleted)
    const orphanedCheckpoints = this.db.prepare(
      `SELECT tc.id, tc.path, tc.size_bytes
       FROM training_checkpoints tc
       LEFT JOIN training_jobs tj ON tc.job_id = tj.id
       WHERE tj.id IS NULL`,
    ).all() as Array<{ id: string; path: string; size_bytes: number }>;

    for (const checkpoint of orphanedCheckpoints) {
      bytesFreed += checkpoint.size_bytes;
      this.deletePathSafely(checkpoint.path);
      this.db.prepare(`DELETE FROM training_checkpoints WHERE id = ?`).run(checkpoint.id);
      itemsRemoved++;
    }

    // Find orphaned models (job doesn't exist)
    const orphanedModels = this.db.prepare(
      `SELECT tm.id, tm.gguf_path, tm.size_bytes
       FROM training_models tm
       LEFT JOIN training_jobs tj ON tm.job_id = tj.id
       WHERE tj.id IS NULL AND tm.project_id = ?`,
    ).get(this.config.projectId) as { id: string; gguf_path: string; size_bytes: number } | undefined;

    if (orphanedModels) {
      bytesFreed += orphanedModels.size_bytes;
      this.deletePathSafely(orphanedModels.gguf_path);
      this.db.prepare(`DELETE FROM training_models WHERE id = ?`).run(orphanedModels.id);
      itemsRemoved++;
    }

    // Find orphaned datasets (no matching active job)
    const orphanedDatasets = this.db.prepare(
      `SELECT td.id, td.path
       FROM training_datasets td
       WHERE td.project_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM training_jobs tj
         WHERE tj.project_id = td.project_id
         AND tj.state IN ('running', 'paused', 'completed')
       )`,
    ).all(this.config.projectId) as Array<{ id: string; path: string }>;

    for (const dataset of orphanedDatasets) {
      const size = this.getPathSize(dataset.path);
      bytesFreed += size;
      this.deletePathSafely(dataset.path);
      this.db.prepare(`DELETE FROM training_datasets WHERE id = ?`).run(dataset.id);
      itemsRemoved++;
    }

    // Check threshold after cleanup
    await this.checkStorageThreshold();

    return { bytesFreed, itemsRemoved };
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Get all checkpoint paths for a training job.
   */
  private getCheckpointPaths(jobId: string): string[] {
    const rows = this.db.prepare(
      `SELECT path FROM training_checkpoints WHERE job_id = ?`,
    ).all(jobId) as Array<{ path: string }>;

    return rows.map((r) => r.path).filter(Boolean);
  }

  /**
   * Get all exported model GGUF paths for a training job.
   */
  private getModelPaths(jobId: string): string[] {
    const rows = this.db.prepare(
      `SELECT gguf_path FROM training_models WHERE job_id = ?`,
    ).all(jobId) as Array<{ gguf_path: string }>;

    return rows.map((r) => r.gguf_path).filter(Boolean);
  }

  /**
   * Get all dataset paths associated with a training job's output directory.
   */
  private getDatasetPaths(jobId: string): string[] {
    const outputDir = this.getJobOutputDir(jobId);
    if (!outputDir) return [];

    const rows = this.db.prepare(
      `SELECT path FROM training_datasets WHERE path LIKE ? AND project_id = ?`,
    ).all(`${outputDir}%`, this.config.projectId) as Array<{ path: string }>;

    return rows.map((r) => r.path).filter(Boolean);
  }

  /**
   * Get the output directory for a training job.
   */
  private getJobOutputDir(jobId: string): string | null {
    const row = this.db.prepare(
      `SELECT output_dir FROM training_jobs WHERE id = ?`,
    ).get(jobId) as { output_dir: string | null } | undefined;

    return row?.output_dir ?? null;
  }

  /**
   * Safely calculate the size of a path (file or directory).
   * Returns 0 if path doesn't exist or on error.
   */
  private getPathSize(targetPath: string): number {
    if (!targetPath) return 0;
    try {
      if (!fs.existsSync(targetPath)) return 0;
      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) return stat.size;

      let totalSize = 0;
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(targetPath, entry.name);
        if (entry.isFile()) {
          totalSize += fs.statSync(entryPath).size;
        } else if (entry.isDirectory()) {
          totalSize += this.getPathSize(entryPath);
        }
      }
      return totalSize;
    } catch {
      return 0;
    }
  }

  /**
   * Safely delete a path (file or directory) from disk.
   * Non-fatal: failures are silently ignored.
   */
  private deletePathSafely(targetPath: string): void {
    if (!targetPath) return;
    try {
      if (!fs.existsSync(targetPath)) return;
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }
    } catch {
      // Best-effort cleanup; non-fatal
    }
  }

  /**
   * Emit a storage threshold warning event to EventLog.
   */
  private emitStorageWarning(usage: StorageUsageSummary): void {
    try {
      const totalGB = (usage.totalBytes / (1024 * 1024 * 1024)).toFixed(2);
      const thresholdGB = (usage.thresholdBytes / (1024 * 1024 * 1024)).toFixed(2);

      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.TRAINING,
        kind: STORAGE_WARNING_EVENT_KIND,
        payload: {
          projectId: this.config.projectId,
          totalBytes: usage.totalBytes,
          thresholdBytes: usage.thresholdBytes,
          message: `Training artifact storage (${totalGB} GB) exceeds threshold (${thresholdGB} GB). Consider running cleanup.`,
          breakdown: {
            chunks: { bytes: usage.chunksBytes, count: usage.chunksCount },
            checkpoints: { bytes: usage.checkpointsBytes, count: usage.checkpointsCount },
            models: { bytes: usage.modelsBytes, count: usage.modelsCount },
            datasets: { bytes: usage.datasetsBytes, count: usage.datasetsCount },
          },
        },
      });
    } catch {
      // EventLog emission is best-effort
    }
  }
}
