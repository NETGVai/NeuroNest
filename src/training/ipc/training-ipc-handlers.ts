/**
 * Training IPC Handler Registration — registers ipcMain.handle() handlers for all
 * Training Pipeline IPC channels.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (kb-ipc-handlers.ts, artifact-ipc.ts, benchmark-ipc.ts).
 *
 * Channels (Renderer→Main):
 *   training:job-start       — start or queue a training job
 *   training:job-cancel      — cancel running/queued job
 *   training:job-pause       — pause at next checkpoint
 *   training:job-resume      — resume from checkpoint
 *   training:job-status      — get current job status
 *   training:jobs-list       — list all jobs
 *   training:config-get      — get default config for project
 *   training:config-validate — validate hyperparameters
 *   training:hardware-detect — detect hardware capabilities
 *   training:export-model    — manual GGUF export
 *
 * Renderer-bound events (Main→Renderer via webContents.send):
 *   training:progress-update    — real-time training metrics push
 *   training:job-state-changed  — job state transitions
 *   training:metrics-update     — GPU/loss metrics
 *   training:export-progress    — export progress
 *
 * Requirements: 29.2, 29.3, 29.4, 29.6, 27.6
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type {
  TrainingOrchestrator,
  TrainingJobConfig,
  TrainingProgress,
  HyperparameterConfig,
} from '../orchestrator/training-orchestrator';
import type { HardwareDetector, HardwareProfile } from '../hardware/hardware-detector';
import type { GGUFExporter, GGUFExportConfig, ExportResult } from '../export/gguf-exporter';
import type { DataRetentionManager } from '../cleanup/data-retention';

// ─── Zod Schemas for IPC Arguments ─────────────────────────────

/**
 * Schema for `training:job-start` channel arguments.
 * Validates the full training job configuration.
 */
export const TrainingJobStartArgsSchema = z.object({
  id: z.string().min(1, 'id is required'),
  projectId: z.string().min(1, 'projectId is required'),
  baseModel: z.string().min(1, 'baseModel is required'),
  method: z.enum(['lora', 'qlora', 'full-finetune']),
  datasetPath: z.string().min(1, 'datasetPath is required'),
  datasetFormat: z.enum(['instruction', 'chat', 'continued-pretraining', 'grpo']),
  hyperparameters: z.object({
    learningRate: z.number().positive('learningRate must be positive'),
    batchSize: z.number().int().positive('batchSize must be a positive integer'),
    epochs: z.number().int().positive('epochs must be a positive integer'),
    loraRank: z.number().int().positive().optional(),
    loraAlpha: z.number().int().positive().optional(),
    warmupSteps: z.number().int().nonnegative().optional(),
    weightDecay: z.number().nonnegative().optional(),
    gradientAccumulationSteps: z.number().int().positive().optional(),
  }),
  hardware: z.object({
    vendor: z.enum(['nvidia', 'apple', 'amd', 'none']),
    gpuName: z.string().optional(),
    vramMB: z.number().int().nonnegative().optional(),
    unifiedMemoryMB: z.number().int().nonnegative().optional(),
    cpuCores: z.number().int().positive(),
    systemMemoryMB: z.number().int().positive(),
  }),
  outputDir: z.string().min(1, 'outputDir is required'),
  checkpointDir: z.string().min(1, 'checkpointDir is required'),
  scriptPath: z.string().min(1, 'scriptPath is required'),
  checkpointIntervalEpochs: z.number().int().positive().default(1),
  validationSplit: z.number().min(0).max(1).default(0.1),
});

/**
 * Schema for `training:job-cancel` channel arguments.
 */
export const TrainingJobCancelArgsSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
});

/**
 * Schema for `training:job-pause` channel arguments.
 */
export const TrainingJobPauseArgsSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
});

/**
 * Schema for `training:job-resume` channel arguments.
 */
export const TrainingJobResumeArgsSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
});

/**
 * Schema for `training:job-status` channel arguments.
 */
export const TrainingJobStatusArgsSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
});

/**
 * Schema for `training:jobs-list` channel arguments.
 */
export const TrainingJobsListArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

/**
 * Schema for `training:config-get` channel arguments.
 */
export const TrainingConfigGetArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

/**
 * Schema for `training:config-validate` channel arguments.
 * Validates a HyperparameterConfig object for acceptable ranges.
 */
export const TrainingConfigValidateArgsSchema = z.object({
  learningRate: z.number().positive('learningRate must be positive'),
  batchSize: z.number().int().positive('batchSize must be a positive integer'),
  epochs: z.number().int().positive('epochs must be a positive integer'),
  loraRank: z.number().int().positive().optional(),
  loraAlpha: z.number().int().positive().optional(),
  warmupSteps: z.number().int().nonnegative().optional(),
  weightDecay: z.number().nonnegative().optional(),
  gradientAccumulationSteps: z.number().int().positive().optional(),
});

/**
 * Schema for `training:hardware-detect` channel arguments.
 */
export const TrainingHardwareDetectArgsSchema = z.object({
  force: z.boolean().optional(),
});

/**
 * Schema for `training:export-model` channel arguments.
 */
export const TrainingExportModelArgsSchema = z.object({
  modelPath: z.string().min(1, 'modelPath is required'),
  outputPath: z.string().min(1, 'outputPath is required'),
  quantization: z.enum(['q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_0', 'f16']),
  ollamaModelName: z.string().min(1, 'ollamaModelName is required'),
  jobId: z.string().optional(),
});

/**
 * Schema for `training:job-delete` channel arguments.
 * Deletes a job and all associated artifacts.
 */
export const TrainingJobDeleteArgsSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
});

/**
 * Schema for `training:storage-usage` channel arguments.
 * Returns storage usage summary for a project.
 */
export const TrainingStorageUsageArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

/**
 * Schema for `training:cleanup` channel arguments.
 * Triggers manual cleanup of orphaned artifacts.
 */
export const TrainingCleanupArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

/**
 * Schema for `training:compare-models` channel arguments.
 * Sends same prompt to two models for side-by-side comparison (Req 13.1, 13.2).
 */
export const TrainingCompareModelsArgsSchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  baseModel: z.string().min(1, 'baseModel is required'),
  fineTunedModel: z.string().min(1, 'fineTunedModel is required'),
  projectId: z.string().min(1, 'projectId is required'),
});

/**
 * Schema for `training:store-preference` channel arguments.
 * Stores preference data for GRPO training use (Req 13.3).
 */
export const TrainingStorePreferenceArgsSchema = z.object({
  id: z.string().min(1, 'id is required'),
  projectId: z.string().min(1, 'projectId is required'),
  prompt: z.string().min(1, 'prompt is required'),
  chosenResponse: z.string().min(1, 'chosenResponse is required'),
  rejectedResponse: z.string().min(1, 'rejectedResponse is required'),
  source: z.enum(['user-feedback', 'comparison-panel', 'auto-generated']),
});

// ─── IPCErrorResponse ───────────────────────────────────────────

/**
 * Structured error response returned by Training IPC handlers.
 * Conforms to the IPCErrorResponse pattern defined in the design document.
 */
export interface TrainingIPCErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    recoverable: boolean;
  };
}

/**
 * Structured success response wrapper.
 */
export interface TrainingIPCSuccessResponse<T = unknown> {
  success: true;
  data: T;
}

export type TrainingIPCResponse<T = unknown> = TrainingIPCSuccessResponse<T> | TrainingIPCErrorResponse;

// ─── Error Helpers ──────────────────────────────────────────────

/**
 * Create a structured validation error response from Zod parse errors.
 * Returns a descriptive error with validation failure details without throwing.
 */
function makeValidationError(zodError: z.ZodError): TrainingIPCErrorResponse {
  return {
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid arguments: ' + zodError.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      details: zodError.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
      recoverable: true,
    },
  };
}

/**
 * Create a structured operational error response.
 */
function makeError(code: string, err: unknown, recoverable = true): TrainingIPCErrorResponse {
  return {
    success: false,
    error: {
      code,
      message: err instanceof Error ? err.message : String(err),
      recoverable,
    },
  };
}

/**
 * Create a structured success response.
 */
function makeSuccess<T>(data: T): TrainingIPCSuccessResponse<T> {
  return {
    success: true,
    data,
  };
}

// ─── Dependencies Interface ─────────────────────────────────────

/**
 * Dependencies required by the Training IPC handlers.
 * Injected at registration time for testability.
 */
export interface TrainingIPCDependencies {
  /** The training orchestrator for job lifecycle management. */
  orchestrator: TrainingOrchestrator;
  /** The hardware detector for system probing. */
  hardwareDetector: HardwareDetector;
  /** The GGUF exporter for manual model export operations. */
  ggufExporter: GGUFExporter;
  /** The main BrowserWindow for emitting renderer-bound events. */
  mainWindow: BrowserWindow;
  /** Project ID for the current session. */
  projectId: string;
  /** SQLite database instance for storing preferences (optional for backward compat). */
  db?: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
  /** Provider Registry for model inference (optional for backward compat). */
  providerRegistry?: {
    invoke: (model: string, prompt: string) => Promise<string>;
  };
  /** Optional data retention manager for cleanup operations (Requirement 35). */
  dataRetentionManager?: DataRetentionManager;
}

// ─── Renderer-Bound Event Emitters ──────────────────────────────

/**
 * Emit training progress update to the renderer.
 * Channel: `training:progress-update`
 */
export function emitTrainingProgressUpdate(
  mainWindow: BrowserWindow,
  data: TrainingProgress,
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('training:progress-update', data);
  }
}

/**
 * Emit job state change to the renderer.
 * Channel: `training:job-state-changed`
 */
export function emitJobStateChanged(
  mainWindow: BrowserWindow,
  data: {
    jobId: string;
    state: string;
    error?: string;
  },
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('training:job-state-changed', data);
  }
}

/**
 * Emit metrics update to the renderer (GPU/loss snapshot).
 * Channel: `training:metrics-update`
 */
export function emitMetricsUpdate(
  mainWindow: BrowserWindow,
  data: {
    jobId: string;
    loss: number;
    learningRate: number;
    gpuUtilization?: number;
    vramUsageMB?: number;
    gpuTemperature?: number;
    tokensPerSecond?: number;
  },
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('training:metrics-update', data);
  }
}

/**
 * Emit export progress to the renderer.
 * Channel: `training:export-progress`
 */
export function emitExportProgress(
  mainWindow: BrowserWindow,
  data: {
    jobId: string;
    percent: number;
    stage: string;
  },
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('training:export-progress', data);
  }
}

// ─── Config Validation Helpers ──────────────────────────────────

/** Hyperparameter warnings for risky but valid configs */
interface ConfigValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Validate hyperparameters against acceptable ranges and provide warnings
 * for potentially problematic configurations.
 */
function validateHyperparameters(config: HyperparameterConfig): ConfigValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Learning rate checks
  if (config.learningRate > 1e-2) {
    warnings.push('Learning rate above 1e-2 may cause training instability');
  }
  if (config.learningRate < 1e-7) {
    warnings.push('Learning rate below 1e-7 may result in extremely slow convergence');
  }

  // Batch size checks
  if (config.batchSize > 64) {
    warnings.push('Batch size above 64 may exceed available VRAM');
  }

  // Epochs checks
  if (config.epochs > 20) {
    warnings.push('More than 20 epochs may lead to overfitting on small datasets');
  }

  // LoRA rank checks
  if (config.loraRank !== undefined) {
    if (config.loraRank > 128) {
      warnings.push('LoRA rank above 128 approaches full fine-tune memory usage');
    }
  }

  // LoRA alpha checks
  if (config.loraAlpha !== undefined && config.loraRank !== undefined) {
    if (config.loraAlpha < config.loraRank) {
      warnings.push('LoRA alpha less than rank may reduce adaptation strength');
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register all Training IPC handlers on ipcMain.
 * Called during Training subsystem initialization, gated behind NEURONEST_TRAINING_PIPELINE.
 *
 * All handlers:
 * 1. Validate inbound arguments using Zod schemas
 * 2. Return structured error responses for invalid arguments (no throwing)
 * 3. Delegate to Training subsystem components
 * 4. Emit renderer-bound events for real-time UI updates
 */
export function registerTrainingIPCHandlers(deps: TrainingIPCDependencies): void {
  const { orchestrator, hardwareDetector, ggufExporter, mainWindow } = deps;

  // ── training:job-start ──
  // Requirement 29.2: Start or queue a training job
  ipcMain.handle(
    'training:job-start',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingJobStartArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const config = parsed.data as TrainingJobConfig;
        const jobId = await orchestrator.startJob(config);

        // Emit state change to renderer
        emitJobStateChanged(mainWindow, {
          jobId,
          state: 'running',
        });

        return makeSuccess({ jobId });
      } catch (err) {
        return makeError('TRAINING_JOB_START_FAILED', err);
      }
    },
  );

  // ── training:job-cancel ──
  // Requirement 29.2: Cancel running/queued job
  ipcMain.handle(
    'training:job-cancel',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingJobCancelArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { jobId } = parsed.data;
        await orchestrator.cancelJob(jobId);

        // Emit state change to renderer
        emitJobStateChanged(mainWindow, {
          jobId,
          state: 'cancelled',
        });

        return makeSuccess({ cancelled: true });
      } catch (err) {
        return makeError('TRAINING_JOB_CANCEL_FAILED', err);
      }
    },
  );

  // ── training:job-pause ──
  // Requirement 29.2: Pause at next checkpoint
  ipcMain.handle(
    'training:job-pause',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingJobPauseArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { jobId } = parsed.data;
        await orchestrator.pauseJob(jobId);

        // Emit state change to renderer
        emitJobStateChanged(mainWindow, {
          jobId,
          state: 'paused',
        });

        return makeSuccess({ paused: true });
      } catch (err) {
        return makeError('TRAINING_JOB_PAUSE_FAILED', err);
      }
    },
  );

  // ── training:job-resume ──
  // Requirement 29.2: Resume from checkpoint
  ipcMain.handle(
    'training:job-resume',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingJobResumeArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { jobId } = parsed.data;
        await orchestrator.resumeJob(jobId);

        // Emit state change to renderer
        emitJobStateChanged(mainWindow, {
          jobId,
          state: 'running',
        });

        return makeSuccess({ resumed: true });
      } catch (err) {
        return makeError('TRAINING_JOB_RESUME_FAILED', err);
      }
    },
  );

  // ── training:job-status ──
  // Requirement 29.2: Get current job status
  ipcMain.handle(
    'training:job-status',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingJobStatusArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { jobId } = parsed.data;
        const status = orchestrator.getJobStatus(jobId);

        if (!status) {
          return makeError('TRAINING_JOB_NOT_FOUND', new Error(`Job not found: ${jobId}`));
        }

        return makeSuccess(status);
      } catch (err) {
        return makeError('TRAINING_JOB_STATUS_FAILED', err);
      }
    },
  );

  // ── training:jobs-list ──
  // Requirement 29.2: List all jobs for a project
  ipcMain.handle(
    'training:jobs-list',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingJobsListArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { projectId } = parsed.data;
        const jobs = orchestrator.listJobs(projectId);
        return makeSuccess(jobs);
      } catch (err) {
        return makeError('TRAINING_JOBS_LIST_FAILED', err);
      }
    },
  );

  // ── training:config-get ──
  // Requirement 29.2: Get default training config for a project
  ipcMain.handle(
    'training:config-get',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingConfigGetArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        // Detect hardware to provide sensible defaults
        const hardware = await hardwareDetector.detect();
        const suggestedConfig = hardwareDetector.suggestConfig(hardware, 7_000_000_000); // 7B default

        const defaults = {
          method: 'lora' as const,
          hyperparameters: {
            learningRate: suggestedConfig.learningRate ?? 2e-4,
            batchSize: suggestedConfig.batchSize ?? 4,
            epochs: suggestedConfig.epochs ?? 3,
            loraRank: suggestedConfig.loraRank ?? 16,
            loraAlpha: suggestedConfig.loraAlpha ?? 32,
            warmupSteps: suggestedConfig.warmupSteps ?? 10,
            weightDecay: suggestedConfig.weightDecay ?? 0.01,
            gradientAccumulationSteps: suggestedConfig.gradientAccumulationSteps ?? 4,
          },
          hardware,
          checkpointIntervalEpochs: 1,
          validationSplit: 0.1,
        };

        return makeSuccess(defaults);
      } catch (err) {
        return makeError('TRAINING_CONFIG_GET_FAILED', err);
      }
    },
  );

  // ── training:config-validate ──
  // Requirement 29.2: Validate hyperparameters against acceptable ranges
  ipcMain.handle(
    'training:config-validate',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingConfigValidateArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const validationResult = validateHyperparameters(parsed.data as HyperparameterConfig);
        return makeSuccess(validationResult);
      } catch (err) {
        return makeError('TRAINING_CONFIG_VALIDATE_FAILED', err);
      }
    },
  );

  // ── training:hardware-detect ──
  // Requirement 29.2: Detect hardware capabilities
  ipcMain.handle(
    'training:hardware-detect',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingHardwareDetectArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { force } = parsed.data;
        const hardware = await hardwareDetector.detect(force);
        return makeSuccess(hardware);
      } catch (err) {
        return makeError('TRAINING_HARDWARE_DETECT_FAILED', err);
      }
    },
  );

  // ── training:export-model ──
  // Requirement 29.2: Manual GGUF export
  ipcMain.handle(
    'training:export-model',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingExportModelArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const exportConfig = parsed.data as GGUFExportConfig;

        // Emit initial export progress
        emitExportProgress(mainWindow, {
          jobId: exportConfig.jobId ?? 'manual',
          percent: 0,
          stage: 'starting',
        });

        const result = await ggufExporter.export(exportConfig);

        // Emit completion progress
        emitExportProgress(mainWindow, {
          jobId: exportConfig.jobId ?? 'manual',
          percent: 100,
          stage: 'complete',
        });

        // Emit state change for the associated job if applicable
        if (exportConfig.jobId) {
          emitJobStateChanged(mainWindow, {
            jobId: exportConfig.jobId,
            state: 'completed',
          });
        }

        return makeSuccess(result);
      } catch (err) {
        return makeError('TRAINING_EXPORT_FAILED', err);
      }
    },
  );

  // ── training:compare-models ──
  // Requirements 13.1, 13.2: Send same prompt to both models via Provider_Registry
  ipcMain.handle(
    'training:compare-models',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingCompareModelsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { prompt, baseModel, fineTunedModel, projectId } = parsed.data;

        // Route inference through Provider_Registry for both models simultaneously
        const registry = deps.providerRegistry;
        if (!registry) {
          return makeError('PROVIDER_REGISTRY_UNAVAILABLE', new Error('Provider Registry not available for model comparison'));
        }

        const [baseResponse, fineTunedResponse] = await Promise.all([
          registry.invoke(baseModel, prompt).catch((err: Error) => `[Error: ${err.message}]`),
          registry.invoke(fineTunedModel, prompt).catch((err: Error) => `[Error: ${err.message}]`),
        ]);

        return makeSuccess({
          baseResponse,
          fineTunedResponse,
          prompt,
          baseModel,
          fineTunedModel,
          projectId,
        });
      } catch (err) {
        return makeError('TRAINING_COMPARE_MODELS_FAILED', err);
      }
    },
  );

  // ── training:store-preference ──
  // Requirement 13.3: Store preference data for GRPO training
  ipcMain.handle(
    'training:store-preference',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingStorePreferenceArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { id, projectId, prompt, chosenResponse, rejectedResponse, source } = parsed.data;
        const createdAt = Date.now();

        const db = deps.db;
        if (!db) {
          return makeError('DB_UNAVAILABLE', new Error('Database not available for storing preferences'));
        }

        const stmt = db.prepare(
          `INSERT INTO grpo_preferences (id, project_id, prompt, chosen_response, rejected_response, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        stmt.run(id, projectId, prompt, chosenResponse, rejectedResponse, source, createdAt);

        return makeSuccess({ stored: true, id });
      } catch (err) {
        return makeError('TRAINING_STORE_PREFERENCE_FAILED', err);
      }
    },
  );

  // ── training:job-delete ──
  // Requirement 35.1: Delete a job and all associated artifacts
  ipcMain.handle(
    'training:job-delete',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingJobDeleteArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { jobId } = parsed.data;
        const { dataRetentionManager } = deps;

        if (!dataRetentionManager) {
          return makeError('CLEANUP_UNAVAILABLE', new Error('Data retention manager not available'));
        }

        const result = await dataRetentionManager.deleteJobArtifacts(jobId);
        return makeSuccess(result);
      } catch (err) {
        return makeError('TRAINING_JOB_DELETE_FAILED', err);
      }
    },
  );

  // ── training:storage-usage ──
  // Requirement 35.3: Display storage usage summary
  ipcMain.handle(
    'training:storage-usage',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingStorageUsageArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { dataRetentionManager } = deps;

        if (!dataRetentionManager) {
          return makeError('CLEANUP_UNAVAILABLE', new Error('Data retention manager not available'));
        }

        const usage = await dataRetentionManager.getStorageUsage();
        return makeSuccess(usage);
      } catch (err) {
        return makeError('TRAINING_STORAGE_USAGE_FAILED', err);
      }
    },
  );

  // ── training:cleanup ──
  // Requirement 35.5: Manual cleanup trigger from UI
  ipcMain.handle(
    'training:cleanup',
    async (_event, args: unknown): Promise<TrainingIPCResponse> => {
      const parsed = TrainingCleanupArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { dataRetentionManager } = deps;

        if (!dataRetentionManager) {
          return makeError('CLEANUP_UNAVAILABLE', new Error('Data retention manager not available'));
        }

        const result = await dataRetentionManager.performManualCleanup();
        return makeSuccess(result);
      } catch (err) {
        return makeError('TRAINING_CLEANUP_FAILED', err);
      }
    },
  );
}

/**
 * Unregister all Training IPC handlers.
 * Call during subsystem teardown or when the feature gate is disabled.
 */
export function unregisterTrainingIPCHandlers(): void {
  ipcMain.removeHandler('training:job-start');
  ipcMain.removeHandler('training:job-cancel');
  ipcMain.removeHandler('training:job-pause');
  ipcMain.removeHandler('training:job-resume');
  ipcMain.removeHandler('training:job-status');
  ipcMain.removeHandler('training:jobs-list');
  ipcMain.removeHandler('training:config-get');
  ipcMain.removeHandler('training:config-validate');
  ipcMain.removeHandler('training:hardware-detect');
  ipcMain.removeHandler('training:export-model');
  ipcMain.removeHandler('training:compare-models');
  ipcMain.removeHandler('training:store-preference');
  ipcMain.removeHandler('training:job-delete');
  ipcMain.removeHandler('training:storage-usage');
  ipcMain.removeHandler('training:cleanup');
}
