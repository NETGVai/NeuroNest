/**
 * Training Checkpoint Manager — Manages training checkpoint persistence and crash recovery.
 *
 * Responsibilities:
 *   - Persist training state (weights, optimizer, epoch, step) at configurable intervals
 *   - Enforce rolling window (max 3 checkpoints per job, delete oldest)
 *   - Detect interrupted jobs on restart for crash recovery
 *   - Restore exact training state (epoch, step, lr schedule position) on resume
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

/** Checkpoint metadata stored in SQLite */
export interface Checkpoint {
  id: string;
  jobId: string;
  epoch: number;
  step: number;
  path: string;
  sizeBytes: number;
  createdAt: number;
  learningRateAtCheckpoint: number;
}

/** Information about an interrupted training job for crash recovery */
export interface InterruptedJob {
  jobId: string;
  projectId: string;
  baseModel: string;
  method: string;
  state: string;
  currentEpoch: number;
  currentStep: number;
  lastCheckpoint: Checkpoint | null;
  startedAt: number;
}

/** Resume state to restore exact training position */
export interface ResumeState {
  jobId: string;
  epoch: number;
  step: number;
  learningRate: number;
  checkpointPath: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Maximum number of checkpoints retained per job (rolling window) */
const MAX_CHECKPOINTS_PER_JOB = 3;

// ─── TrainingCheckpointManager ──────────────────────────────────

/**
 * Manages training checkpoints with a rolling window policy and crash recovery.
 *
 * Stores checkpoint metadata in SQLite (training_checkpoints table).
 * Enforces at most 3 checkpoints per job by deleting the oldest when exceeded.
 * Supports crash recovery by detecting interrupted jobs and restoring training state.
 */
export class TrainingCheckpointManager {
  /** Maximum checkpoints per job (rolling window). */
  readonly maxCheckpointsPerJob: number = MAX_CHECKPOINTS_PER_JOB;

  constructor(private readonly db: Database.Database) {}

  // ─── Save ─────────────────────────────────────────────────────

  /**
   * Save a checkpoint for a training job.
   *
   * Persists checkpoint metadata to SQLite, then enforces the rolling window
   * policy by deleting the oldest checkpoints if count exceeds max.
   *
   * @param jobId - Training job identifier
   * @param epoch - Current epoch number
   * @param step - Current step number
   * @param checkpointPath - Path to checkpoint directory on disk
   * @param sizeBytes - Size of checkpoint in bytes (optional, defaults to 0)
   * @param learningRate - Learning rate at this checkpoint (optional, defaults to 0)
   * @returns The saved Checkpoint metadata
   */
  async save(
    jobId: string,
    epoch: number,
    step: number,
    checkpointPath: string,
    sizeBytes: number = 0,
    learningRate: number = 0,
  ): Promise<Checkpoint> {
    const id = `chk-${jobId}-e${epoch}-s${step}-${Date.now()}`;
    const createdAt = Date.now();

    // Compute actual size if not provided and path exists
    let actualSize = sizeBytes;
    if (actualSize === 0 && checkpointPath) {
      actualSize = this.getDirectorySize(checkpointPath);
    }

    const checkpoint: Checkpoint = {
      id,
      jobId,
      epoch,
      step,
      path: checkpointPath,
      sizeBytes: actualSize,
      createdAt,
      learningRateAtCheckpoint: learningRate,
    };

    // Persist to SQLite
    this.db.prepare(
      `INSERT INTO training_checkpoints
        (id, job_id, epoch, step, path, size_bytes, learning_rate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpoint.id,
      checkpoint.jobId,
      checkpoint.epoch,
      checkpoint.step,
      checkpoint.path,
      checkpoint.sizeBytes,
      checkpoint.learningRateAtCheckpoint,
      checkpoint.createdAt,
    );

    // Enforce rolling window
    await this.cleanup(jobId);

    return checkpoint;
  }

  // ─── Get Latest ───────────────────────────────────────────────

  /**
   * Return the most recent checkpoint for a job.
   *
   * @param jobId - Training job identifier
   * @returns The latest Checkpoint or null if none exist
   */
  async getLatest(jobId: string): Promise<Checkpoint | null> {
    const row = this.db.prepare(
      `SELECT id, job_id, epoch, step, path, size_bytes, learning_rate, created_at
       FROM training_checkpoints
       WHERE job_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(jobId) as CheckpointRow | undefined;

    if (!row) return null;

    return this.rowToCheckpoint(row);
  }

  // ─── List ─────────────────────────────────────────────────────

  /**
   * Return all checkpoints for a job, ordered by creation time (oldest first).
   *
   * @param jobId - Training job identifier
   * @returns Array of Checkpoint objects
   */
  async list(jobId: string): Promise<Checkpoint[]> {
    const rows = this.db.prepare(
      `SELECT id, job_id, epoch, step, path, size_bytes, learning_rate, created_at
       FROM training_checkpoints
       WHERE job_id = ?
       ORDER BY created_at ASC`,
    ).all(jobId) as CheckpointRow[];

    return rows.map((row) => this.rowToCheckpoint(row));
  }

  // ─── Cleanup (Rolling Window) ─────────────────────────────────

  /**
   * Enforce the rolling window: max 3 checkpoints per job.
   * Deletes the oldest checkpoint files and their DB records when exceeded.
   *
   * @param jobId - Training job identifier
   */
  async cleanup(jobId: string): Promise<void> {
    const checkpoints = await this.list(jobId);

    if (checkpoints.length <= this.maxCheckpointsPerJob) {
      return;
    }

    // Determine how many to delete (oldest first since list is sorted ASC)
    const toDelete = checkpoints.slice(0, checkpoints.length - this.maxCheckpointsPerJob);

    for (const checkpoint of toDelete) {
      // Attempt to remove checkpoint files from disk
      this.deleteCheckpointFiles(checkpoint.path);

      // Remove from database
      this.db.prepare(
        `DELETE FROM training_checkpoints WHERE id = ?`,
      ).run(checkpoint.id);
    }
  }

  // ─── Crash Recovery ───────────────────────────────────────────

  /**
   * Detect interrupted training jobs on startup.
   *
   * Queries for jobs with state='running' that have no active process.
   * Since we cannot check for active processes from the DB layer alone,
   * this returns all jobs in 'running' state — the caller (orchestrator)
   * knows which processes are actually active.
   *
   * @returns Array of InterruptedJob info for the system to offer resume
   */
  async detectInterruptedJobs(): Promise<InterruptedJob[]> {
    const rows = this.db.prepare(
      `SELECT id, project_id, base_model, method, state, current_epoch, current_step, started_at
       FROM training_jobs
       WHERE state = 'running'
       ORDER BY started_at DESC`,
    ).all() as InterruptedJobRow[];

    const results: InterruptedJob[] = [];

    for (const row of rows) {
      const lastCheckpoint = await this.getLatest(row.id);

      results.push({
        jobId: row.id,
        projectId: row.project_id,
        baseModel: row.base_model,
        method: row.method,
        state: row.state,
        currentEpoch: row.current_epoch ?? 0,
        currentStep: row.current_step ?? 0,
        lastCheckpoint,
        startedAt: row.started_at ?? 0,
      });
    }

    return results;
  }

  // ─── State Restoration ────────────────────────────────────────

  /**
   * Get the resume state for a training job from its latest checkpoint.
   *
   * Returns epoch, step, and learning rate position so that training can
   * resume from the exact point without repeating completed work.
   *
   * @param jobId - Training job identifier
   * @returns ResumeState or null if no checkpoint exists
   */
  async getResumeState(jobId: string): Promise<ResumeState | null> {
    const latest = await this.getLatest(jobId);

    if (!latest) return null;

    return {
      jobId,
      epoch: latest.epoch,
      step: latest.step,
      learningRate: latest.learningRateAtCheckpoint,
      checkpointPath: latest.path,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Convert a SQLite row to a Checkpoint object.
   */
  private rowToCheckpoint(row: CheckpointRow): Checkpoint {
    return {
      id: row.id,
      jobId: row.job_id,
      epoch: row.epoch,
      step: row.step,
      path: row.path,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      learningRateAtCheckpoint: row.learning_rate,
    };
  }

  /**
   * Attempt to delete checkpoint files from disk.
   * Non-fatal: if deletion fails, we still remove the DB record.
   */
  private deleteCheckpointFiles(checkpointPath: string): void {
    if (!checkpointPath) return;

    try {
      if (fs.existsSync(checkpointPath)) {
        const stat = fs.statSync(checkpointPath);
        if (stat.isDirectory()) {
          fs.rmSync(checkpointPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(checkpointPath);
        }
      }
    } catch {
      // Non-fatal: checkpoint file cleanup is best-effort
    }
  }

  /**
   * Calculate the total size of a directory or file.
   * Returns 0 if path doesn't exist or on error.
   */
  private getDirectorySize(dirPath: string): number {
    try {
      if (!fs.existsSync(dirPath)) return 0;

      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) return stat.size;

      let totalSize = 0;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isFile()) {
          totalSize += fs.statSync(entryPath).size;
        } else if (entry.isDirectory()) {
          totalSize += this.getDirectorySize(entryPath);
        }
      }
      return totalSize;
    } catch {
      return 0;
    }
  }
}

// ─── Internal Row Types ─────────────────────────────────────────

/** SQLite row shape for training_checkpoints table */
interface CheckpointRow {
  id: string;
  job_id: string;
  epoch: number;
  step: number;
  path: string;
  size_bytes: number;
  learning_rate: number;
  created_at: number;
}

/** SQLite row shape for interrupted job queries */
interface InterruptedJobRow {
  id: string;
  project_id: string;
  base_model: string;
  method: string;
  state: string;
  current_epoch: number | null;
  current_step: number | null;
  started_at: number | null;
}
