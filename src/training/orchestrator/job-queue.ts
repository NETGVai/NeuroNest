/**
 * Job Queue — Enforces concurrency limits and FIFO dequeue order.
 *
 * Responsibilities:
 *   - Maintain a FIFO queue of pending training jobs
 *   - Enforce max concurrent running jobs (default: 1)
 *   - Enforce max queue depth (default: 5)
 *   - Auto-start queued jobs when resources become available
 *   - Track queue positions in the training_jobs table
 *   - Reject submissions when queue is full
 *
 * Requirements: 39.1, 39.2, 39.3, 39.4
 */

import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the job queue */
export interface JobQueueConfig {
  /** Maximum number of concurrently running jobs (default: 1) */
  maxConcurrent: number;
  /** Maximum number of jobs waiting in the queue (default: 5) */
  maxQueueDepth: number;
}

/** Result of a job submission attempt */
export type SubmitResult =
  | { status: 'started'; jobId: string }
  | { status: 'queued'; jobId: string; position: number }
  | { status: 'rejected'; reason: string };

/** A queued job entry */
export interface QueuedJob {
  jobId: string;
  enqueuedAt: number;
  position: number;
}

/** Callback invoked when a queued job should be started */
export type JobStartCallback = (jobId: string) => Promise<void>;

// ─── Errors ─────────────────────────────────────────────────────

export class QueueFullError extends Error {
  constructor(maxDepth: number) {
    super(
      `Training job queue is full (max ${maxDepth} queued jobs). ` +
      `Please wait for a running job to complete or cancel a queued job.`,
    );
    this.name = 'QueueFullError';
  }
}

// ─── Default Configuration ──────────────────────────────────────

export const DEFAULT_JOB_QUEUE_CONFIG: JobQueueConfig = {
  maxConcurrent: 1,
  maxQueueDepth: 5,
};

// ─── JobQueue ───────────────────────────────────────────────────

/**
 * JobQueue — manages training job concurrency and FIFO ordering.
 *
 * The queue tracks which jobs are running and which are waiting. When a
 * running job completes, fails, or is cancelled, the next queued job is
 * automatically started (FIFO order).
 *
 * Queue positions are persisted to the `training_jobs.queue_position` column
 * so the UI can display them.
 */
export class JobQueue {
  /** FIFO queue of job IDs waiting to be started */
  private readonly queue: string[] = [];

  /** Set of currently running job IDs */
  private readonly running: Set<string> = new Set();

  /** Configuration for concurrency and queue depth */
  private readonly config: JobQueueConfig;

  /** Database for persisting queue positions */
  private readonly db: Database.Database;

  /** Callback to start a job when it's dequeued */
  private onStartJob: JobStartCallback | null = null;

  constructor(db: Database.Database, config: Partial<JobQueueConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_JOB_QUEUE_CONFIG, ...config };
  }

  // ─── Configuration ────────────────────────────────────────────

  /** Set the callback invoked when a queued job should be started */
  setStartCallback(callback: JobStartCallback): void {
    this.onStartJob = callback;
  }

  /** Get the current queue configuration */
  getConfig(): Readonly<JobQueueConfig> {
    return { ...this.config };
  }

  /** Get the maximum concurrent jobs allowed */
  get maxConcurrent(): number {
    return this.config.maxConcurrent;
  }

  /** Get the maximum queue depth allowed */
  get maxQueueDepth(): number {
    return this.config.maxQueueDepth;
  }

  // ─── Submission ───────────────────────────────────────────────

  /**
   * Submit a job for execution.
   *
   * - If running jobs < maxConcurrent: job starts immediately
   * - If running jobs >= maxConcurrent but queue has space: job is enqueued (FIFO)
   * - If queue is full: submission is rejected with a structured error
   *
   * Requirements: 39.1, 39.3
   */
  submit(jobId: string): SubmitResult {
    // Can start immediately?
    if (this.running.size < this.config.maxConcurrent) {
      this.running.add(jobId);
      this.updateQueuePosition(jobId, null);
      return { status: 'started', jobId };
    }

    // Can queue?
    if (this.queue.length < this.config.maxQueueDepth) {
      this.queue.push(jobId);
      const position = this.queue.length; // 1-based position
      this.updateQueuePosition(jobId, position);
      this.persistQueueState(jobId, 'queued');
      return { status: 'queued', jobId, position };
    }

    // Queue is full — reject
    return {
      status: 'rejected',
      reason: `Training job queue is full (max ${this.config.maxQueueDepth} queued jobs). ` +
        `Please wait for a running job to complete or cancel a queued job.`,
    };
  }

  // ─── Job Lifecycle Events ─────────────────────────────────────

  /**
   * Mark a job as running directly (used when the orchestrator starts a job
   * that was already submitted via the queue).
   */
  markRunning(jobId: string): void {
    this.running.add(jobId);
    // Remove from queue if it was queued
    const idx = this.queue.indexOf(jobId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      this.recalculatePositions();
    }
    this.updateQueuePosition(jobId, null);
  }

  /**
   * Notify the queue that a job has completed, failed, or been cancelled.
   *
   * This triggers auto-start of the next queued job if resources are available.
   *
   * Requirements: 39.2
   */
  async onJobFinished(jobId: string): Promise<void> {
    this.running.delete(jobId);

    // Remove from queue if it was queued (e.g., cancelled while queued)
    const queueIdx = this.queue.indexOf(jobId);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
      this.recalculatePositions();
    }

    // Auto-start next queued job if resources available
    await this.tryStartNext();
  }

  // ─── Queue Queries ────────────────────────────────────────────

  /**
   * Get the queue position of a job.
   *
   * Returns the 1-based position in the queue, or null if the job
   * is not queued (it may be running, completed, etc.)
   */
  getQueuePosition(jobId: string): number | null {
    const idx = this.queue.indexOf(jobId);
    if (idx === -1) return null;
    return idx + 1; // 1-based position
  }

  /**
   * Get all queued jobs in FIFO order.
   */
  getQueuedJobs(): QueuedJob[] {
    return this.queue.map((jobId, idx) => ({
      jobId,
      enqueuedAt: this.getJobEnqueuedAt(jobId),
      position: idx + 1,
    }));
  }

  /**
   * Get the number of currently running jobs.
   */
  getRunningCount(): number {
    return this.running.size;
  }

  /**
   * Get the number of jobs currently in the queue.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue has capacity for another job.
   */
  hasCapacity(): boolean {
    return this.running.size < this.config.maxConcurrent ||
      this.queue.length < this.config.maxQueueDepth;
  }

  /**
   * Check if a new job can start immediately (running < maxConcurrent).
   */
  canStartImmediately(): boolean {
    return this.running.size < this.config.maxConcurrent;
  }

  // ─── Internal ─────────────────────────────────────────────────

  /**
   * Try to start the next queued job if there's capacity.
   */
  private async tryStartNext(): Promise<void> {
    while (this.running.size < this.config.maxConcurrent && this.queue.length > 0) {
      const nextJobId = this.queue.shift()!;
      this.running.add(nextJobId);
      this.updateQueuePosition(nextJobId, null);
      this.recalculatePositions();

      // Invoke the start callback
      if (this.onStartJob) {
        try {
          await this.onStartJob(nextJobId);
        } catch {
          // If the start callback fails, remove from running and try the next one
          this.running.delete(nextJobId);
          this.persistQueueState(nextJobId, 'failed');
        }
      }
    }
  }

  /**
   * Recalculate and persist queue positions for all queued jobs.
   */
  private recalculatePositions(): void {
    for (let i = 0; i < this.queue.length; i++) {
      this.updateQueuePosition(this.queue[i]!, i + 1);
    }
  }

  /**
   * Update queue_position in the training_jobs table.
   */
  private updateQueuePosition(jobId: string, position: number | null): void {
    try {
      this.db.prepare(
        `UPDATE training_jobs SET queue_position = ? WHERE id = ?`,
      ).run(position, jobId);
    } catch {
      // Non-fatal: position tracking is best-effort
    }
  }

  /**
   * Persist the job state to the training_jobs table.
   */
  private persistQueueState(jobId: string, state: string): void {
    try {
      this.db.prepare(
        `UPDATE training_jobs SET state = ? WHERE id = ?`,
      ).run(state, jobId);
    } catch {
      // Non-fatal: state persistence is best-effort during queue operations
    }
  }

  /**
   * Get the created_at timestamp for a job (used as enqueued time).
   */
  private getJobEnqueuedAt(jobId: string): number {
    try {
      const row = this.db.prepare(
        `SELECT created_at FROM training_jobs WHERE id = ?`,
      ).get(jobId) as { created_at: number } | undefined;
      return row?.created_at ?? Date.now();
    } catch {
      return Date.now();
    }
  }
}
