/**
 * Training Event Zod Schemas — structured event definitions for the Training subsystem.
 *
 * Defines Zod-validated schemas for all training event kinds:
 *   - training.job.start / training.job.progress / training.job.checkpoint
 *   - training.job.complete / training.job.failed / training.job.cancelled
 *   - training.export.start / training.export.complete
 *
 * Source identifiers registered with EventLogRateLimiter:
 *   - `kb-training` — all training job-related events
 *   - `kb-export`   — all model export-related events
 *
 * Requirements: 26.2, 26.3, 26.4, 8.5, 8.6
 */

import { z } from 'zod';
import type { EventLog, EventKind } from '../../pipeline/event-log';

// ─── Source Identifiers ────────────────────────────────────────

/**
 * Source identifiers used for EventLogRateLimiter per-source sliding-window
 * enforcement (100 events/second per source).
 */
export const TRAINING_SOURCE_IDENTIFIERS = {
  TRAINING: 'kb-training',
  EXPORT: 'kb-export',
} as const;

// ─── Training Event Kinds ──────────────────────────────────────

/**
 * All event kinds emitted by the Training subsystem.
 * These extend the base EventKind union at runtime registration.
 */
export const TRAINING_EVENT_KINDS = {
  JOB_START: 'training.job.start' as EventKind,
  JOB_PROGRESS: 'training.job.progress' as EventKind,
  JOB_CHECKPOINT: 'training.job.checkpoint' as EventKind,
  JOB_COMPLETE: 'training.job.complete' as EventKind,
  JOB_FAILED: 'training.job.failed' as EventKind,
  JOB_CANCELLED: 'training.job.cancelled' as EventKind,
  EXPORT_START: 'training.export.start' as EventKind,
  EXPORT_COMPLETE: 'training.export.complete' as EventKind,
} as const;

// ─── Training Job Event Schemas ────────────────────────────────

/**
 * Emitted when a training job begins execution.
 * Source identifier: `kb-training`
 */
export const TrainingJobStartSchema = z.object({
  jobId: z.string().min(1),
  projectId: z.string().min(1),
  baseModel: z.string().min(1),
  method: z.enum(['lora', 'qlora', 'full-finetune']),
  datasetFormat: z.enum(['instruction', 'chat', 'continued-pretraining', 'grpo']),
});
export type TrainingJobStartPayload = z.infer<typeof TrainingJobStartSchema>;

/**
 * Emitted periodically during training to report step-level progress.
 * Source identifier: `kb-training`
 */
export const TrainingJobProgressSchema = z.object({
  jobId: z.string().min(1),
  step: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  totalEpochs: z.number().int().positive(),
  loss: z.number(),
  learningRate: z.number().nonnegative(),
  etaMs: z.number().nonnegative(),
});
export type TrainingJobProgressPayload = z.infer<typeof TrainingJobProgressSchema>;

/**
 * Emitted when a training checkpoint is saved.
 * Source identifier: `kb-training`
 */
export const TrainingJobCheckpointSchema = z.object({
  jobId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type TrainingJobCheckpointPayload = z.infer<typeof TrainingJobCheckpointSchema>;

/**
 * Emitted when a training job completes successfully.
 * Source identifier: `kb-training`
 */
export const TrainingJobCompleteSchema = z.object({
  jobId: z.string().min(1),
  finalLoss: z.number(),
  totalSteps: z.number().int().positive(),
  durationMs: z.number().nonnegative(),
});
export type TrainingJobCompletePayload = z.infer<typeof TrainingJobCompleteSchema>;

/**
 * Emitted when a training job fails.
 * Source identifier: `kb-training`
 */
export const TrainingJobFailedSchema = z.object({
  jobId: z.string().min(1),
  error: z.string().min(1),
  step: z.number().int().nonnegative().optional(),
  epoch: z.number().int().nonnegative().optional(),
});
export type TrainingJobFailedPayload = z.infer<typeof TrainingJobFailedSchema>;

/**
 * Emitted when a training job is cancelled by the user.
 * Source identifier: `kb-training`
 */
export const TrainingJobCancelledSchema = z.object({
  jobId: z.string().min(1),
  step: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
export type TrainingJobCancelledPayload = z.infer<typeof TrainingJobCancelledSchema>;

// ─── Export Event Schemas ──────────────────────────────────────

/**
 * Emitted when GGUF model export begins.
 * Source identifier: `kb-export`
 */
export const TrainingExportStartSchema = z.object({
  jobId: z.string().min(1),
  modelPath: z.string().min(1),
  quantization: z.enum(['q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_0', 'f16']),
});
export type TrainingExportStartPayload = z.infer<typeof TrainingExportStartSchema>;

/**
 * Emitted when GGUF model export completes and is registered with Ollama.
 * Source identifier: `kb-export`
 */
export const TrainingExportCompleteSchema = z.object({
  jobId: z.string().min(1),
  ggufPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  ollamaRegistered: z.boolean(),
});
export type TrainingExportCompletePayload = z.infer<typeof TrainingExportCompleteSchema>;

// ─── Schema Registry Map ───────────────────────────────────────

/**
 * Maps each training event kind to its corresponding Zod schema.
 * Used by `registerTrainingEventSchemas()` to register all schemas with the EventLog.
 */
export const TRAINING_EVENT_SCHEMA_MAP: ReadonlyMap<EventKind, z.ZodType> = new Map<EventKind, z.ZodType>([
  [TRAINING_EVENT_KINDS.JOB_START, TrainingJobStartSchema as z.ZodType],
  [TRAINING_EVENT_KINDS.JOB_PROGRESS, TrainingJobProgressSchema as z.ZodType],
  [TRAINING_EVENT_KINDS.JOB_CHECKPOINT, TrainingJobCheckpointSchema as z.ZodType],
  [TRAINING_EVENT_KINDS.JOB_COMPLETE, TrainingJobCompleteSchema as z.ZodType],
  [TRAINING_EVENT_KINDS.JOB_FAILED, TrainingJobFailedSchema as z.ZodType],
  [TRAINING_EVENT_KINDS.JOB_CANCELLED, TrainingJobCancelledSchema as z.ZodType],
  [TRAINING_EVENT_KINDS.EXPORT_START, TrainingExportStartSchema as z.ZodType],
  [TRAINING_EVENT_KINDS.EXPORT_COMPLETE, TrainingExportCompleteSchema as z.ZodType],
]);

// ─── Registration Helper ───────────────────────────────────────

/**
 * Register all training event Zod schemas with an EventLog instance.
 * Call this during Training subsystem initialization (gated behind NEURONEST_TRAINING_PIPELINE).
 *
 * This ensures that:
 *   - All emitted training events are validated against their Zod schema before persistence
 *   - Invalid payloads are rejected (not dispatched) per Requirement 26.3
 *   - Events are rate-limited via the appropriate source identifier per Requirement 26.4
 *     (`kb-training` for job events, `kb-export` for export events)
 */
export function registerTrainingEventSchemas(eventLog: EventLog): void {
  for (const [kind, schema] of TRAINING_EVENT_SCHEMA_MAP) {
    eventLog.registerSchema(kind, schema);
  }
}
