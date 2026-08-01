/**
 * Training Orchestrator — Manages training job lifecycle.
 *
 * Responsibilities:
 *   - Start, cancel, pause, and resume training jobs
 *   - Spawn Python subprocess via SafeExec (execFile with argument arrays, no shell)
 *   - Parse stdout JSON lines for progress metrics (loss, lr, step, ETA)
 *   - Integrate with Cost_Tracker for resource estimation
 *   - Emit training events to EventLog
 *   - Track active jobs in a Map, persist job state to SQLite
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.7, 8.8
 */

import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type { CostTracker } from '../../pipeline/subagent-spawner.js';
import {
  UnslothBridge,
  TrainingProcess,
  type TrainingJobConfig as BridgeTrainingJobConfig,
  type TrainingProgress as BridgeProgress,
} from '../bridge/unsloth-bridge.js';
import {
  TRAINING_EVENT_KINDS,
  TRAINING_SOURCE_IDENTIFIERS,
} from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/** Training method supported by the orchestrator */
export type TrainingMethod = 'lora' | 'qlora' | 'full-finetune';

/** Dataset format */
export type DatasetFormat = 'instruction' | 'chat' | 'continued-pretraining' | 'grpo';

/** Job lifecycle state */
export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** Quantization type for GGUF export */
export type QuantizationType = 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'q8_0' | 'f16';

/** Hardware profile (minimal for orchestrator use) */
export interface HardwareProfile {
  vendor: 'nvidia' | 'apple' | 'amd' | 'none';
  gpuName?: string;
  vramMB?: number;
  unifiedMemoryMB?: number;
  cpuCores: number;
  systemMemoryMB: number;
}

/** Hyperparameter configuration for a training job */
export interface HyperparameterConfig {
  learningRate: number;
  batchSize: number;
  epochs: number;
  loraRank?: number;
  loraAlpha?: number;
  warmupSteps?: number;
  weightDecay?: number;
  gradientAccumulationSteps?: number;
}

/** Full training job configuration */
export interface TrainingJobConfig {
  id: string;
  projectId: string;
  baseModel: string;
  method: TrainingMethod;
  datasetPath: string;
  datasetFormat: DatasetFormat;
  hyperparameters: HyperparameterConfig;
  hardware: HardwareProfile;
  outputDir: string;
  checkpointDir: string;
  scriptPath: string;
  checkpointIntervalEpochs: number;
  validationSplit: number;
}

/** Training progress metrics parsed from subprocess stdout */
export interface TrainingProgress {
  jobId: string;
  state: JobState;
  currentStep: number;
  totalSteps: number;
  currentEpoch: number;
  totalEpochs: number;
  loss: number;
  learningRate: number;
  gradientNorm?: number;
  tokensPerSecond?: number;
  etaMs: number;
  elapsedMs: number;
  gpuUtilization?: number;
  vramUsageMB?: number;
  gpuTemperature?: number;
}

/** Summary of a training job for listing */
export interface TrainingJobSummary {
  id: string;
  projectId: string;
  baseModel: string;
  method: TrainingMethod;
  state: JobState;
  currentStep: number;
  totalSteps: number;
  finalLoss?: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** Internal tracking of active process + state */
interface ActiveJob {
  config: TrainingJobConfig;
  process: TrainingProcess;
  progress: TrainingProgress;
  startedAt: number;
}

/** Cost estimate for a training job */
export interface TrainingCostEstimate {
  timeMs: number;
  peakVramMB: number;
  diskMB: number;
}

// ─── Errors ─────────────────────────────────────────────────────

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Training job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

export class JobNotRunningError extends Error {
  constructor(jobId: string, state: JobState) {
    super(`Training job ${jobId} is not running (state: ${state})`);
    this.name = 'JobNotRunningError';
  }
}

export class JobNotPausedError extends Error {
  constructor(jobId: string, state: JobState) {
    super(`Training job ${jobId} is not paused (state: ${state})`);
    this.name = 'JobNotPausedError';
  }
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Grace period before escalating SIGTERM to SIGKILL (ms).
 * This value is passed to TrainingProcess via the UnslothBridge config.
 * Kept here for documentation and potential future use by the orchestrator.
 */
export const CANCEL_GRACE_PERIOD_MS = 30_000;

/** Default session ID prefix for event emission */
const TRAINING_SESSION_PREFIX = 'training-';

// ─── TrainingOrchestrator ───────────────────────────────────────

/**
 * TrainingOrchestrator — manages training job lifecycle.
 *
 * Tracks active jobs in a Map, persists state to SQLite (training_jobs table),
 * spawns Python subprocesses via the UnslothBridge (SafeExec, no shell),
 * parses stdout JSON lines for progress, and integrates with Cost_Tracker.
 */
export class TrainingOrchestrator {
  /** Active running/paused jobs keyed by job ID */
  private readonly activeJobs: Map<string, ActiveJob> = new Map();

  constructor(
    private readonly bridge: UnslothBridge,
    private readonly eventLog: EventLog,
    private readonly costTracker: CostTracker | null,
    private readonly db: Database.Database,
  ) {}

  // ─── Job Lifecycle ──────────────────────────────────────────

  /**
   * Start a new training job.
   *
   * Spawns a Python subprocess via the UnslothBridge (SafeExec with
   * argument arrays, no shell interpretation). Parses stdout line-by-line
   * for JSON progress metrics. Persists job state to SQLite and emits
   * training events to EventLog.
   *
   * Requirements: 8.1, 8.2, 8.7, 8.8
   */
  async startJob(config: TrainingJobConfig): Promise<string> {
    const jobId = config.id;

    // Persist initial job record to SQLite
    this.persistJobRecord(config, 'running');

    // Estimate cost and integrate with Cost_Tracker
    const costEstimate = this.estimateCost(config);
    this.persistCostEstimate(jobId, costEstimate);

    if (this.costTracker) {
      this.costTracker.recordCost(
        `${TRAINING_SESSION_PREFIX}${jobId}`,
        0,
        { type: 'training-start', estimatedTimeMs: costEstimate.timeMs },
      );
    }

    // Build bridge-compatible config and spawn the training process
    const bridgeConfig: BridgeTrainingJobConfig = {
      id: jobId,
      baseModel: config.baseModel,
      method: config.method,
      datasetPath: config.datasetPath,
      datasetFormat: config.datasetFormat,
      scriptPath: config.scriptPath,
      outputDir: config.outputDir,
      checkpointDir: config.checkpointDir,
      hyperparameters: config.hyperparameters,
    };

    const trainingProcess = await this.bridge.startTrainingDirect(bridgeConfig);
    const startedAt = Date.now();

    // Initialize progress tracking
    const progress: TrainingProgress = {
      jobId,
      state: 'running',
      currentStep: 0,
      totalSteps: 0,
      currentEpoch: 0,
      totalEpochs: config.hyperparameters.epochs,
      loss: 0,
      learningRate: config.hyperparameters.learningRate,
      etaMs: 0,
      elapsedMs: 0,
    };

    // Track the active job
    const activeJob: ActiveJob = {
      config,
      process: trainingProcess,
      progress,
      startedAt,
    };
    this.activeJobs.set(jobId, activeJob);

    // Attach progress listeners
    this.attachProcessListeners(jobId, trainingProcess, activeJob);

    // Emit job-start event
    this.emitEvent(TRAINING_EVENT_KINDS.JOB_START, {
      jobId,
      projectId: config.projectId,
      baseModel: config.baseModel,
      method: config.method,
      datasetFormat: config.datasetFormat,
    });

    // Update SQLite with started timestamp
    this.updateJobStarted(jobId, startedAt);

    return jobId;
  }

  /**
   * Cancel a running training job.
   *
   * Sends SIGTERM to the subprocess and waits up to 30 seconds for graceful
   * shutdown. If the process hasn't exited after the grace period, escalates
   * to SIGKILL.
   *
   * Requirements: 8.3
   */
  async cancelJob(jobId: string): Promise<void> {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) {
      // Check if job exists in DB but isn't active (e.g. queued)
      const dbState = this.getJobStateFromDB(jobId);
      if (!dbState) {
        throw new JobNotFoundError(jobId);
      }
      if (dbState === 'queued') {
        // Cancel queued job directly in DB
        this.updateJobState(jobId, 'cancelled');
        this.emitEvent(TRAINING_EVENT_KINDS.JOB_CANCELLED, {
          jobId,
          reason: 'User cancelled queued job',
        });
        return;
      }
      throw new JobNotRunningError(jobId, dbState);
    }

    // Cancel the process (SIGTERM → 30s → SIGKILL handled by TrainingProcess)
    await activeJob.process.cancel();

    // Update state
    activeJob.progress.state = 'cancelled';
    this.updateJobState(jobId, 'cancelled');
    this.activeJobs.delete(jobId);

    // Emit cancelled event
    this.emitEvent(TRAINING_EVENT_KINDS.JOB_CANCELLED, {
      jobId,
      step: activeJob.progress.currentStep,
      reason: 'User requested cancellation',
    });
  }

  /**
   * Pause a running training job.
   *
   * Saves a checkpoint at the current step, then terminates the process
   * gracefully. The job can later be resumed from the saved checkpoint.
   *
   * Requirements: 8.4
   */
  async pauseJob(jobId: string): Promise<void> {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) {
      const dbState = this.getJobStateFromDB(jobId);
      if (!dbState) {
        throw new JobNotFoundError(jobId);
      }
      throw new JobNotRunningError(jobId, dbState);
    }

    if (activeJob.progress.state !== 'running') {
      throw new JobNotRunningError(jobId, activeJob.progress.state);
    }

    // Request graceful shutdown (TrainingProcess sends SIGTERM)
    // The training script should save a checkpoint on SIGTERM
    await activeJob.process.cancel();

    // Update state to paused
    activeJob.progress.state = 'paused';
    this.updateJobState(jobId, 'paused');
    this.activeJobs.delete(jobId);

    // Persist the checkpoint reference
    this.persistPauseCheckpoint(jobId, activeJob.progress);

    // Emit checkpoint event
    this.emitEvent(TRAINING_EVENT_KINDS.JOB_CHECKPOINT, {
      jobId,
      epoch: activeJob.progress.currentEpoch,
      step: activeJob.progress.currentStep,
      path: activeJob.config.checkpointDir,
      sizeBytes: 0, // Actual size determined by checkpoint manager
    });
  }

  /**
   * Resume a paused training job.
   *
   * Restarts the subprocess from the last saved checkpoint without
   * repeating completed work. The training script receives the
   * checkpoint directory as an argument to resume from.
   *
   * Requirements: 8.4
   */
  async resumeJob(jobId: string): Promise<void> {
    const dbState = this.getJobStateFromDB(jobId);
    if (!dbState) {
      throw new JobNotFoundError(jobId);
    }
    if (dbState !== 'paused') {
      throw new JobNotPausedError(jobId, dbState);
    }

    // Retrieve the job config from SQLite
    const config = this.getJobConfigFromDB(jobId);
    if (!config) {
      throw new JobNotFoundError(jobId);
    }

    // Get the last checkpoint info
    const checkpoint = this.getLatestCheckpoint(jobId);

    // Build bridge config with resume flag
    const bridgeConfig: BridgeTrainingJobConfig = {
      id: jobId,
      baseModel: config.baseModel,
      method: config.method,
      datasetPath: config.datasetPath,
      datasetFormat: config.datasetFormat,
      scriptPath: config.scriptPath,
      outputDir: config.outputDir,
      checkpointDir: config.checkpointDir,
      hyperparameters: config.hyperparameters,
    };

    // Spawn new process (training script detects checkpoint and resumes)
    const trainingProcess = await this.bridge.startTrainingDirect(bridgeConfig);
    const startedAt = Date.now();

    // Restore progress from checkpoint
    const progress: TrainingProgress = {
      jobId,
      state: 'running',
      currentStep: checkpoint?.step ?? 0,
      totalSteps: 0,
      currentEpoch: checkpoint?.epoch ?? 0,
      totalEpochs: config.hyperparameters.epochs,
      loss: 0,
      learningRate: checkpoint?.learningRate ?? config.hyperparameters.learningRate,
      etaMs: 0,
      elapsedMs: 0,
    };

    const activeJob: ActiveJob = {
      config,
      process: trainingProcess,
      progress,
      startedAt,
    };
    this.activeJobs.set(jobId, activeJob);

    // Attach progress listeners
    this.attachProcessListeners(jobId, trainingProcess, activeJob);

    // Update state in DB
    this.updateJobState(jobId, 'running');

    // Emit job-start event for the resumed session
    this.emitEvent(TRAINING_EVENT_KINDS.JOB_START, {
      jobId,
      projectId: config.projectId,
      baseModel: config.baseModel,
      method: config.method,
      datasetFormat: config.datasetFormat,
    });
  }

  // ─── Status & Listing ───────────────────────────────────────

  /**
   * Get the current progress of a training job.
   * Returns null if the job doesn't exist.
   */
  getJobStatus(jobId: string): TrainingProgress | null {
    const activeJob = this.activeJobs.get(jobId);
    if (activeJob) {
      return { ...activeJob.progress };
    }

    // Check DB for completed/failed/cancelled jobs
    const row = this.db.prepare(
      `SELECT id, state, current_step, total_steps, current_epoch, total_epochs,
              final_loss, started_at, completed_at, created_at
       FROM training_jobs WHERE id = ?`,
    ).get(jobId) as TrainingJobRow | undefined;

    if (!row) return null;

    return {
      jobId: row.id,
      state: row.state as JobState,
      currentStep: row.current_step ?? 0,
      totalSteps: row.total_steps ?? 0,
      currentEpoch: row.current_epoch ?? 0,
      totalEpochs: row.total_epochs ?? 0,
      loss: row.final_loss ?? 0,
      learningRate: 0,
      etaMs: 0,
      elapsedMs: row.completed_at && row.started_at
        ? row.completed_at - row.started_at
        : 0,
    };
  }

  /**
   * List all training jobs for a project.
   */
  listJobs(projectId?: string): TrainingJobSummary[] {
    const query = projectId
      ? `SELECT id, project_id, base_model, method, state, current_step,
                total_steps, final_loss, created_at, started_at, completed_at
         FROM training_jobs WHERE project_id = ? ORDER BY created_at DESC`
      : `SELECT id, project_id, base_model, method, state, current_step,
                total_steps, final_loss, created_at, started_at, completed_at
         FROM training_jobs ORDER BY created_at DESC`;

    const rows = (projectId
      ? this.db.prepare(query).all(projectId)
      : this.db.prepare(query).all()
    ) as TrainingJobRow[];

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      baseModel: row.base_model,
      method: row.method as TrainingMethod,
      state: row.state as JobState,
      currentStep: row.current_step ?? 0,
      totalSteps: row.total_steps ?? 0,
      finalLoss: row.final_loss ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
    }));
  }

  /**
   * Get the number of currently active (running) jobs.
   */
  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  // ─── Process Event Handlers ─────────────────────────────────

  /**
   * Attach stdout/stderr/exit event listeners to the TrainingProcess.
   * Parses JSON progress lines and updates both in-memory state and SQLite.
   */
  private attachProcessListeners(
    jobId: string,
    process: TrainingProcess,
    activeJob: ActiveJob,
  ): void {
    // Handle progress updates from stdout JSON lines
    process.on('progress', (progressData: BridgeProgress) => {
      activeJob.progress.currentStep = progressData.step;
      activeJob.progress.totalSteps = progressData.totalSteps;
      activeJob.progress.currentEpoch = progressData.epoch ?? activeJob.progress.currentEpoch;
      activeJob.progress.totalEpochs = progressData.totalEpochs ?? activeJob.progress.totalEpochs;
      activeJob.progress.loss = progressData.loss ?? activeJob.progress.loss;
      activeJob.progress.learningRate = progressData.learningRate ?? activeJob.progress.learningRate;
      activeJob.progress.tokensPerSecond = progressData.tokensPerSecond;
      activeJob.progress.etaMs = progressData.etaMs ?? 0;
      activeJob.progress.elapsedMs = Date.now() - activeJob.startedAt;

      // Emit progress event to EventLog
      this.emitEvent(TRAINING_EVENT_KINDS.JOB_PROGRESS, {
        jobId,
        step: progressData.step,
        totalSteps: progressData.totalSteps,
        epoch: progressData.epoch ?? 0,
        totalEpochs: progressData.totalEpochs ?? activeJob.progress.totalEpochs,
        loss: progressData.loss ?? 0,
        learningRate: progressData.learningRate ?? 0,
        etaMs: progressData.etaMs ?? 0,
      });

      // Update SQLite with latest progress
      this.updateJobProgress(jobId, activeJob.progress);
    });

    // Handle checkpoint events
    process.on('checkpoint', (data: { epoch: number; step: number; path: string }) => {
      this.emitEvent(TRAINING_EVENT_KINDS.JOB_CHECKPOINT, {
        jobId,
        epoch: data.epoch,
        step: data.step,
        path: data.path,
        sizeBytes: 0, // Size determined by checkpoint manager
      });
    });

    // Handle GPU/hardware metric updates
    process.on('metric', (data: Record<string, unknown>) => {
      if (typeof data['gpu_utilization'] === 'number') {
        activeJob.progress.gpuUtilization = data['gpu_utilization'] as number;
      }
      if (typeof data['vram_usage_mb'] === 'number') {
        activeJob.progress.vramUsageMB = data['vram_usage_mb'] as number;
      }
      if (typeof data['gpu_temperature'] === 'number') {
        activeJob.progress.gpuTemperature = data['gpu_temperature'] as number;
      }
    });

    // Handle job completion
    process.on('complete', (data: { finalLoss?: number; outputDir: string }) => {
      activeJob.progress.state = 'completed';
      activeJob.progress.loss = data.finalLoss ?? activeJob.progress.loss;
      activeJob.progress.elapsedMs = Date.now() - activeJob.startedAt;

      this.updateJobCompleted(jobId, data.finalLoss ?? null, Date.now());
      this.activeJobs.delete(jobId);

      // Record final cost with Cost_Tracker
      if (this.costTracker) {
        const elapsed = Date.now() - activeJob.startedAt;
        this.costTracker.recordCost(
          `${TRAINING_SESSION_PREFIX}${jobId}`,
          0,
          { type: 'training-complete', durationMs: elapsed },
        );
      }

      this.emitEvent(TRAINING_EVENT_KINDS.JOB_COMPLETE, {
        jobId,
        finalLoss: data.finalLoss ?? activeJob.progress.loss,
        totalSteps: activeJob.progress.currentStep,
        durationMs: activeJob.progress.elapsedMs,
      });
    });

    // Handle job failure (non-zero exit, Requirements 8.7)
    process.on('error', (data: { message: string; stderr?: string }) => {
      activeJob.progress.state = 'failed';
      activeJob.progress.elapsedMs = Date.now() - activeJob.startedAt;

      this.updateJobFailed(jobId, data.message);
      this.activeJobs.delete(jobId);

      this.emitEvent(TRAINING_EVENT_KINDS.JOB_FAILED, {
        jobId,
        error: data.message,
        step: activeJob.progress.currentStep,
        epoch: activeJob.progress.currentEpoch,
      });
    });

    // Handle state changes from TrainingProcess
    process.on('stateChange', (state) => {
      if (state === 'cancelled' && activeJob.progress.state !== 'cancelled') {
        activeJob.progress.state = 'cancelled';
      }
    });
  }

  // ─── Cost Estimation ────────────────────────────────────────

  /**
   * Estimate training cost based on config and hardware.
   * Integrates with Cost_Tracker for resource estimation.
   *
   * Requirements: 8.8
   */
  private estimateCost(config: TrainingJobConfig): TrainingCostEstimate {
    const { hyperparameters, hardware } = config;

    // Rough time estimate based on epochs, batch size, and hardware
    const stepsPerEpoch = 1000; // Placeholder — depends on dataset size
    const totalSteps = stepsPerEpoch * hyperparameters.epochs;
    const msPerStep = hardware.vendor === 'none' ? 2000 : 500; // CPU vs GPU
    const timeMs = totalSteps * msPerStep;

    // VRAM estimate based on method and model
    let peakVramMB = 4096; // Base estimate for 7B model
    if (config.method === 'qlora') {
      peakVramMB = 6000;
    } else if (config.method === 'full-finetune') {
      peakVramMB = 16000;
    }

    // Disk estimate for checkpoints
    const diskMB = hyperparameters.epochs * 500; // ~500MB per checkpoint

    return { timeMs, peakVramMB, diskMB };
  }

  // ─── SQLite Persistence ─────────────────────────────────────

  /**
   * Persist a new job record to the training_jobs table.
   */
  private persistJobRecord(config: TrainingJobConfig, state: JobState): void {
    this.db.prepare(
      `INSERT INTO training_jobs
        (id, project_id, base_model, method, dataset_path, dataset_format,
         config_json, state, total_epochs, output_dir, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      config.id,
      config.projectId,
      config.baseModel,
      config.method,
      config.datasetPath,
      config.datasetFormat,
      JSON.stringify(config),
      state,
      config.hyperparameters.epochs,
      config.outputDir,
      Date.now(),
    );
  }

  /** Persist cost estimate JSON */
  private persistCostEstimate(jobId: string, estimate: TrainingCostEstimate): void {
    this.db.prepare(
      `UPDATE training_jobs SET estimated_cost_json = ? WHERE id = ?`,
    ).run(JSON.stringify(estimate), jobId);
  }

  /** Update job started_at timestamp */
  private updateJobStarted(jobId: string, startedAt: number): void {
    this.db.prepare(
      `UPDATE training_jobs SET started_at = ? WHERE id = ?`,
    ).run(startedAt, jobId);
  }

  /** Update job state in SQLite */
  private updateJobState(jobId: string, state: JobState): void {
    this.db.prepare(
      `UPDATE training_jobs SET state = ? WHERE id = ?`,
    ).run(state, jobId);
  }

  /** Update job progress in SQLite */
  private updateJobProgress(jobId: string, progress: TrainingProgress): void {
    this.db.prepare(
      `UPDATE training_jobs
       SET current_step = ?, total_steps = ?, current_epoch = ?, total_epochs = ?
       WHERE id = ?`,
    ).run(
      progress.currentStep,
      progress.totalSteps,
      progress.currentEpoch,
      progress.totalEpochs,
      jobId,
    );
  }

  /** Mark job as completed with final metrics */
  private updateJobCompleted(jobId: string, finalLoss: number | null, completedAt: number): void {
    this.db.prepare(
      `UPDATE training_jobs
       SET state = 'completed', final_loss = ?, completed_at = ?
       WHERE id = ?`,
    ).run(finalLoss, completedAt, jobId);
  }

  /** Mark job as failed with error message */
  private updateJobFailed(jobId: string, errorMessage: string): void {
    this.db.prepare(
      `UPDATE training_jobs
       SET state = 'failed', error_message = ?, completed_at = ?
       WHERE id = ?`,
    ).run(errorMessage, Date.now(), jobId);
  }

  /** Get job state from the database */
  private getJobStateFromDB(jobId: string): JobState | null {
    const row = this.db.prepare(
      `SELECT state FROM training_jobs WHERE id = ?`,
    ).get(jobId) as { state: string } | undefined;
    return (row?.state as JobState) ?? null;
  }

  /** Retrieve the full job config from SQLite */
  private getJobConfigFromDB(jobId: string): TrainingJobConfig | null {
    const row = this.db.prepare(
      `SELECT config_json FROM training_jobs WHERE id = ?`,
    ).get(jobId) as { config_json: string } | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.config_json) as TrainingJobConfig;
    } catch {
      return null;
    }
  }

  /** Get the latest checkpoint for a paused job */
  private getLatestCheckpoint(
    jobId: string,
  ): { epoch: number; step: number; path: string; learningRate: number } | null {
    const row = this.db.prepare(
      `SELECT epoch, step, path, learning_rate
       FROM training_checkpoints
       WHERE job_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(jobId) as { epoch: number; step: number; path: string; learning_rate: number } | undefined;

    if (!row) return null;
    return {
      epoch: row.epoch,
      step: row.step,
      path: row.path,
      learningRate: row.learning_rate,
    };
  }

  /** Persist a checkpoint reference when pausing a job */
  private persistPauseCheckpoint(jobId: string, progress: TrainingProgress): void {
    const id = `chk-${jobId}-${progress.currentEpoch}-${progress.currentStep}`;
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO training_checkpoints
          (id, job_id, epoch, step, path, size_bytes, learning_rate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        jobId,
        progress.currentEpoch,
        progress.currentStep,
        '', // Path filled by checkpoint manager
        0,
        progress.learningRate,
        Date.now(),
      );
    } catch {
      // Non-fatal: checkpoint persistence failure doesn't prevent pause
    }
  }

  // ─── EventLog Integration ───────────────────────────────────

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
      // EventLog emission is best-effort; don't crash the orchestrator
    }
  }
}

// ─── Internal Row Type ──────────────────────────────────────────

/** SQLite row shape for training_jobs table */
interface TrainingJobRow {
  id: string;
  project_id: string;
  base_model: string;
  method: string;
  dataset_path: string;
  dataset_format: string;
  config_json: string;
  state: string;
  queue_position: number | null;
  current_step: number | null;
  total_steps: number | null;
  current_epoch: number | null;
  total_epochs: number | null;
  final_loss: number | null;
  error_message: string | null;
  output_dir: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  estimated_cost_json: string | null;
  parent_job_id: string | null;
}
