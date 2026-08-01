/**
 * Training Scheduler — Cron-based automatic retraining.
 *
 * Manages scheduled retraining jobs using cron expressions and the existing
 * NeuroNest cron infrastructure (parseCronExpression, cronMatchesTime).
 *
 * Responsibilities:
 *   - Parse and validate cron expressions for retraining schedules
 *   - Evaluate which schedules are due based on current time
 *   - Generate fresh datasets from latest KB state using last successful config
 *   - Execute training via TrainingOrchestrator
 *   - Emit structured events on completion/failure
 *   - Retry on failure (default: 1 retry after 1 hour)
 *   - Preserve previous model version on failure
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import {
  parseCronExpression,
  cronMatchesTime,
} from '../../durability/scheduler-service.js';
import {
  TRAINING_EVENT_KINDS,
  TRAINING_SOURCE_IDENTIFIERS,
} from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for a scheduled retraining job */
export interface TrainingScheduleConfig {
  /** Project ID this schedule belongs to */
  projectId: string;
  /** Cron expression (5-field: minute hour dayOfMonth month dayOfWeek) */
  cronExpression: string;
  /** Last successful training configuration (serialized JSON) */
  lastConfigJson: string;
  /** Maximum number of retries on failure (default: 1) */
  maxRetries?: number;
  /** Whether this schedule is enabled (default: true) */
  enabled?: boolean;
}

/** Persisted training schedule record from SQLite */
export interface TrainingScheduleRecord {
  id: string;
  projectId: string;
  cronExpression: string;
  lastConfigJson: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  retryCount: number;
  maxRetries: number;
  enabled: boolean;
  createdAt: number;
}

/** Result of evaluating and potentially executing a scheduled run */
export interface ScheduledRunResult {
  scheduleId: string;
  projectId: string;
  success: boolean;
  jobId?: string;
  error?: string;
  retriedAt?: number;
}

/** Interface for generating datasets from KB state */
export interface KBDatasetProvider {
  /** Retrieve all current chunks for a project */
  getProjectChunks(projectId: string): Promise<KBChunkSummary[]>;
}

/** Minimal chunk info needed for dataset generation trigger */
export interface KBChunkSummary {
  id: string;
  sourceUri: string;
  content: string;
  tokenCount: number;
}

/** Interface for the training orchestrator (decoupled for testability) */
export interface TrainingOrchestratorLike {
  startJob(config: TrainingJobConfigLike): Promise<string>;
}

/** Minimal training job config interface for scheduler use */
export interface TrainingJobConfigLike {
  id: string;
  projectId: string;
  baseModel: string;
  method: string;
  datasetPath: string;
  datasetFormat: string;
  hyperparameters: Record<string, unknown>;
  hardware: Record<string, unknown>;
  outputDir: string;
  checkpointDir: string;
  scriptPath: string;
  checkpointIntervalEpochs: number;
  validationSplit: number;
}

/** Interface for dataset generation (decoupled for testability) */
export interface DatasetGeneratorLike {
  generate(config: DatasetGenerationConfigLike): Promise<GeneratedDatasetLike>;
}

/** Minimal dataset generation config for scheduler use */
export interface DatasetGenerationConfigLike {
  format: string;
  sourceChunks: KBChunkSummary[];
  outputPath: string;
  extractionStrategy?: string;
  documentSeparator?: string;
}

/** Minimal generated dataset result */
export interface GeneratedDatasetLike {
  path: string;
  format: string;
  sampleCount: number;
  totalTokens: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default retry count for failed scheduled runs */
export const DEFAULT_MAX_RETRIES = 1;

/** Default retry delay in milliseconds (1 hour) */
export const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;

/** Event kind for scheduled training completion */
const SCHEDULE_EVENT_KIND = 'training.schedule.complete' as EventKind;

/** Event kind for scheduled training failure */
const SCHEDULE_FAILURE_EVENT_KIND = 'training.schedule.failed' as EventKind;

// ─── SQLite Row Type ────────────────────────────────────────────

interface TrainingScheduleRow {
  id: string;
  project_id: string;
  cron_expression: string;
  last_config_json: string;
  last_run_at: number | null;
  next_run_at: number | null;
  retry_count: number;
  max_retries: number;
  enabled: number; // SQLite boolean (0/1)
  created_at: number;
}

// ─── TrainingScheduler Class ────────────────────────────────────

/**
 * Cron-based training scheduler that evaluates registered schedules,
 * generates fresh datasets from the latest KB state, and invokes the
 * Training Orchestrator with the last successful configuration.
 *
 * Uses the existing NeuroNest cron infrastructure (parseCronExpression,
 * cronMatchesTime) from the SchedulerService module.
 */
export class TrainingScheduler {
  constructor(
    private readonly db: Database.Database,
    private readonly eventLog: EventLog,
    private readonly orchestrator: TrainingOrchestratorLike,
    private readonly datasetGenerator: DatasetGeneratorLike,
    private readonly kbProvider: KBDatasetProvider,
  ) {}

  // ─── Schedule CRUD ──────────────────────────────────────────

  /**
   * Register a new training schedule.
   *
   * Validates the cron expression and persists the schedule to SQLite.
   * Computes the next_run_at timestamp based on the cron expression.
   */
  createSchedule(config: TrainingScheduleConfig): TrainingScheduleRecord {
    const parsed = parseCronExpression(config.cronExpression);
    if (!parsed) {
      throw new Error(
        `Invalid cron expression: "${config.cronExpression}". ` +
        'Expected 5-field format: minute hour dayOfMonth month dayOfWeek',
      );
    }

    const id = randomUUID();
    const now = Date.now();
    const nextRunAt = this.computeNextRunAt(config.cronExpression, new Date(now));
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const enabled = config.enabled ?? true;

    const stmt = this.db.prepare(`
      INSERT INTO training_schedules (id, project_id, cron_expression, last_config_json, last_run_at, next_run_at, retry_count, max_retries, enabled, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)
    `);

    stmt.run(
      id,
      config.projectId,
      config.cronExpression,
      config.lastConfigJson,
      nextRunAt,
      maxRetries,
      enabled ? 1 : 0,
      now,
    );

    return {
      id,
      projectId: config.projectId,
      cronExpression: config.cronExpression,
      lastConfigJson: config.lastConfigJson,
      lastRunAt: null,
      nextRunAt,
      retryCount: 0,
      maxRetries,
      enabled,
      createdAt: now,
    };
  }

  /**
   * Update the configuration for an existing schedule.
   */
  updateSchedule(
    scheduleId: string,
    updates: Partial<Pick<TrainingScheduleConfig, 'cronExpression' | 'lastConfigJson' | 'maxRetries' | 'enabled'>>,
  ): TrainingScheduleRecord | null {
    const existing = this.getSchedule(scheduleId);
    if (!existing) return null;

    const cronExpression = updates.cronExpression ?? existing.cronExpression;
    const lastConfigJson = updates.lastConfigJson ?? existing.lastConfigJson;
    const maxRetries = updates.maxRetries ?? existing.maxRetries;
    const enabled = updates.enabled ?? existing.enabled;

    // Validate cron expression if changed
    if (updates.cronExpression) {
      const parsed = parseCronExpression(updates.cronExpression);
      if (!parsed) {
        throw new Error(
          `Invalid cron expression: "${updates.cronExpression}". ` +
          'Expected 5-field format: minute hour dayOfMonth month dayOfWeek',
        );
      }
    }

    // Recompute next_run_at if cron expression changed
    const nextRunAt = updates.cronExpression
      ? this.computeNextRunAt(cronExpression, new Date())
      : existing.nextRunAt;

    const stmt = this.db.prepare(`
      UPDATE training_schedules
      SET cron_expression = ?, last_config_json = ?, next_run_at = ?, max_retries = ?, enabled = ?
      WHERE id = ?
    `);

    stmt.run(cronExpression, lastConfigJson, nextRunAt, maxRetries, enabled ? 1 : 0, scheduleId);

    return {
      ...existing,
      cronExpression,
      lastConfigJson,
      nextRunAt,
      maxRetries,
      enabled,
    };
  }

  /**
   * Remove a schedule by ID.
   */
  removeSchedule(scheduleId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM training_schedules WHERE id = ?');
    const result = stmt.run(scheduleId);
    return result.changes > 0;
  }

  /**
   * Get a single schedule by ID.
   */
  getSchedule(scheduleId: string): TrainingScheduleRecord | null {
    const stmt = this.db.prepare('SELECT * FROM training_schedules WHERE id = ?');
    const row = stmt.get(scheduleId) as TrainingScheduleRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * List all schedules for a project.
   */
  listSchedules(projectId: string): TrainingScheduleRecord[] {
    const stmt = this.db.prepare('SELECT * FROM training_schedules WHERE project_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(projectId) as TrainingScheduleRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * List all enabled schedules across all projects.
   */
  listEnabledSchedules(): TrainingScheduleRecord[] {
    const stmt = this.db.prepare('SELECT * FROM training_schedules WHERE enabled = 1 ORDER BY next_run_at ASC');
    const rows = stmt.all() as TrainingScheduleRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  // ─── Schedule Evaluation ────────────────────────────────────

  /**
   * Evaluate all enabled schedules and return those that are due for execution.
   *
   * A schedule is due if:
   *   1. It is enabled
   *   2. Its next_run_at is <= now (or the cron expression matches the current time)
   *   3. It hasn't exceeded its retry limit (for retries)
   */
  evaluateDueSchedules(now: Date = new Date()): TrainingScheduleRecord[] {
    const nowMs = now.getTime();
    const enabled = this.listEnabledSchedules();
    const due: TrainingScheduleRecord[] = [];

    for (const schedule of enabled) {
      // Check if the schedule's next_run_at has been reached
      if (schedule.nextRunAt !== null && schedule.nextRunAt <= nowMs) {
        due.push(schedule);
        continue;
      }

      // Fallback: check if the cron expression matches the current time
      const parsed = parseCronExpression(schedule.cronExpression);
      if (parsed && cronMatchesTime(parsed, now)) {
        // Only consider it due if it hasn't run in the current minute
        if (!schedule.lastRunAt || nowMs - schedule.lastRunAt > 60_000) {
          due.push(schedule);
        }
      }
    }

    return due;
  }

  // ─── Schedule Execution ─────────────────────────────────────

  /**
   * Execute a scheduled training run.
   *
   * 1. Fetch latest KB state for the project
   * 2. Generate fresh dataset using last successful config
   * 3. Start training job via TrainingOrchestrator
   * 4. On success: emit completion event, update schedule, reset retry count
   * 5. On failure: preserve previous model, retry if within limits
   *
   * Requirements: 19.2, 19.3, 19.4
   */
  async executeScheduledRun(schedule: TrainingScheduleRecord): Promise<ScheduledRunResult> {
    const now = Date.now();

    try {
      // Parse the last successful config
      const lastConfig = JSON.parse(schedule.lastConfigJson) as TrainingJobConfigLike;

      // 1. Fetch latest KB chunks for the project
      const chunks = await this.kbProvider.getProjectChunks(schedule.projectId);

      if (chunks.length === 0) {
        const error = 'No KB chunks available for dataset generation';
        this.handleFailure(schedule, error, now);
        return { scheduleId: schedule.id, projectId: schedule.projectId, success: false, error };
      }

      // 2. Generate fresh dataset from latest KB state
      const datasetConfig: DatasetGenerationConfigLike = {
        format: lastConfig.datasetFormat,
        sourceChunks: chunks,
        outputPath: lastConfig.datasetPath,
        extractionStrategy: (lastConfig as unknown as Record<string, unknown>).extractionStrategy as string | undefined,
      };

      const dataset = await this.datasetGenerator.generate(datasetConfig);

      if (dataset.sampleCount === 0) {
        const error = 'Generated dataset contains zero samples';
        this.handleFailure(schedule, error, now);
        return { scheduleId: schedule.id, projectId: schedule.projectId, success: false, error };
      }

      // 3. Start training job with last successful config + fresh dataset
      const jobConfig: TrainingJobConfigLike = {
        ...lastConfig,
        id: randomUUID(),
        datasetPath: dataset.path,
      };

      const jobId = await this.orchestrator.startJob(jobConfig);

      // 4. Success: update schedule state
      this.markSuccess(schedule, now);

      // Emit structured completion event
      this.emitEvent(SCHEDULE_EVENT_KIND, {
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        jobId,
        datasetSamples: dataset.sampleCount,
        datasetTokens: dataset.totalTokens,
      });

      return {
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        success: true,
        jobId,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return this.handleFailure(schedule, error, now);
    }
  }

  /**
   * Execute all due schedules. Called periodically (e.g., every minute)
   * by the NeuroNest main process timer.
   */
  async tick(now: Date = new Date()): Promise<ScheduledRunResult[]> {
    const dueSchedules = this.evaluateDueSchedules(now);
    const results: ScheduledRunResult[] = [];

    for (const schedule of dueSchedules) {
      const result = await this.executeScheduledRun(schedule);
      results.push(result);
    }

    return results;
  }

  // ─── Retry Logic ────────────────────────────────────────────

  /**
   * Handle a failed scheduled run.
   *
   * If retry count < max retries:
   *   - Increment retry count
   *   - Schedule retry after DEFAULT_RETRY_DELAY_MS (1 hour)
   *   - Preserve previous model version (no changes to Provider_Registry)
   *
   * If retry count >= max retries:
   *   - Mark schedule as having exhausted retries
   *   - Emit failure event
   *   - Compute next regular run from cron expression
   *
   * Requirements: 19.4
   */
  private handleFailure(
    schedule: TrainingScheduleRecord,
    error: string,
    now: number,
  ): ScheduledRunResult {
    const newRetryCount = schedule.retryCount + 1;

    if (newRetryCount <= schedule.maxRetries) {
      // Schedule a retry after the delay period
      const retryAt = now + DEFAULT_RETRY_DELAY_MS;

      const stmt = this.db.prepare(`
        UPDATE training_schedules
        SET retry_count = ?, next_run_at = ?, last_run_at = ?
        WHERE id = ?
      `);
      stmt.run(newRetryCount, retryAt, now, schedule.id);

      // Emit failure event indicating retry is pending
      this.emitEvent(SCHEDULE_FAILURE_EVENT_KIND, {
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        error,
        retryCount: newRetryCount,
        maxRetries: schedule.maxRetries,
        nextRetryAt: retryAt,
        modelPreserved: true,
      });

      return {
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        success: false,
        error,
        retriedAt: retryAt,
      };
    }

    // Exhausted retries — reset retry count and schedule next regular run
    const nextRunAt = this.computeNextRunAt(schedule.cronExpression, new Date(now));

    const stmt = this.db.prepare(`
      UPDATE training_schedules
      SET retry_count = 0, next_run_at = ?, last_run_at = ?
      WHERE id = ?
    `);
    stmt.run(nextRunAt, now, schedule.id);

    // Emit final failure event
    this.emitEvent(SCHEDULE_FAILURE_EVENT_KIND, {
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      error,
      retryCount: newRetryCount,
      maxRetries: schedule.maxRetries,
      retriesExhausted: true,
      modelPreserved: true,
    });

    return {
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      success: false,
      error,
    };
  }

  // ─── State Updates ──────────────────────────────────────────

  /**
   * Mark a schedule as successfully executed.
   * Resets retry count, updates last_run_at, and computes next_run_at.
   */
  private markSuccess(schedule: TrainingScheduleRecord, now: number): void {
    const nextRunAt = this.computeNextRunAt(schedule.cronExpression, new Date(now));

    const stmt = this.db.prepare(`
      UPDATE training_schedules
      SET retry_count = 0, last_run_at = ?, next_run_at = ?
      WHERE id = ?
    `);
    stmt.run(now, nextRunAt, schedule.id);
  }

  // ─── Cron Utilities ─────────────────────────────────────────

  /**
   * Compute the next run timestamp from a cron expression,
   * starting from the given time. Scans forward minute-by-minute
   * up to 48 hours ahead. Returns null if no match found.
   */
  computeNextRunAt(cronExpression: string, from: Date): number | null {
    const parsed = parseCronExpression(cronExpression);
    if (!parsed) return null;

    // Start scanning from the next minute
    const candidate = new Date(from.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Scan up to 48 hours ahead (2880 minutes)
    const maxMinutes = 2880;
    for (let i = 0; i < maxMinutes; i++) {
      if (cronMatchesTime(parsed, candidate)) {
        return candidate.getTime();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    // No match in 48h window — return null (very restrictive cron)
    return null;
  }

  // ─── Event Emission ─────────────────────────────────────────

  /**
   * Emit a structured event to the EventLog.
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
      // EventLog emission is best-effort; don't crash the scheduler
    }
  }

  // ─── Row Mapping ────────────────────────────────────────────

  /**
   * Convert a SQLite row to a TrainingScheduleRecord.
   */
  private rowToRecord(row: TrainingScheduleRow): TrainingScheduleRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      cronExpression: row.cron_expression,
      lastConfigJson: row.last_config_json,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    };
  }
}
