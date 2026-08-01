/**
 * Training Observability Panel — Comprehensive monitoring of training jobs
 * with customizable metrics and historical comparison.
 *
 * Responsibilities:
 *   - Collect per-step metrics: loss, gradient norm, lr schedule, GPU util,
 *     VRAM usage, tokens/sec, ETA
 *   - Persist metrics to SQLite (training_metrics + training_effectiveness tables)
 *   - Support user-configurable graph layouts (select metrics, arrange panels)
 *   - Display historical comparison across training runs
 *   - Record pre/post-training performance metrics (response quality,
 *     task completion, retrieval precision)
 *   - Display delta vs base model in training history
 *
 * Requirements: 23.1, 23.2, 23.3, 37.1, 37.2, 37.3, 37.4
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EventLog } from '../../pipeline/event-log.js';

// ─── Types: Per-Step Metrics ────────────────────────────────────

/**
 * A single per-step training metric record.
 * Mirrors the `training_metrics` SQLite table (migration 060).
 */
export interface TrainingMetricRecord {
  id?: number;
  jobId: string;
  step: number;
  epoch: number;
  loss: number;
  learningRate: number;
  gradientNorm: number | null;
  tokensPerSecond: number | null;
  gpuUtilization: number | null;
  vramUsageMB: number | null;
  gpuTemperature: number | null;
  recordedAt: number;
}

/**
 * Input for recording a metric step (from the orchestrator's progress events).
 */
export interface MetricStepInput {
  jobId: string;
  step: number;
  epoch: number;
  loss: number;
  learningRate: number;
  gradientNorm?: number;
  tokensPerSecond?: number;
  gpuUtilization?: number;
  vramUsageMB?: number;
  gpuTemperature?: number;
}

// ─── Types: Effectiveness Metrics ───────────────────────────────

/**
 * Type of effectiveness metric measured pre/post training.
 * Corresponds to training_effectiveness.metric_type CHECK constraint.
 */
export type EffectivenessMetricType =
  | 'response_quality'
  | 'task_completion'
  | 'retrieval_precision';

/**
 * A single effectiveness metric record.
 * Mirrors the `training_effectiveness` SQLite table (migration 062).
 */
export interface EffectivenessRecord {
  id: string;
  projectId: string;
  modelId: string;
  metricType: EffectivenessMetricType;
  value: number;
  baselineValue: number | null;
  measuredAt: number;
}

/**
 * Input for recording an effectiveness metric.
 */
export interface EffectivenessInput {
  projectId: string;
  modelId: string;
  metricType: EffectivenessMetricType;
  value: number;
  baselineValue?: number;
}

// ─── Types: Graph Layout Configuration ──────────────────────────

/**
 * A metric that can be displayed in the observability panel.
 */
export type ObservableMetric =
  | 'loss'
  | 'learning_rate'
  | 'gradient_norm'
  | 'tokens_per_second'
  | 'gpu_utilization'
  | 'vram_usage_mb'
  | 'gpu_temperature'
  | 'eta_ms';

/**
 * Configuration for a single graph panel in the observability layout.
 */
export interface GraphPanelConfig {
  /** Unique panel identifier */
  id: string;
  /** Metrics to display on this panel */
  metrics: ObservableMetric[];
  /** Panel title (user-customizable) */
  title: string;
  /** Position in the grid (row, column) */
  position: { row: number; col: number };
  /** Panel size (in grid units) */
  size: { width: number; height: number };
}

/**
 * Full user-configurable graph layout for the observability panel.
 */
export interface ObservabilityLayout {
  /** Project ID this layout belongs to */
  projectId: string;
  /** Ordered list of panels */
  panels: GraphPanelConfig[];
  /** Grid dimensions (columns) */
  gridColumns: number;
}

// ─── Types: Historical Comparison ───────────────────────────────

/**
 * Summary of metrics for a completed training run, used for comparison.
 */
export interface TrainingRunSummary {
  jobId: string;
  baseModel: string;
  method: string;
  finalLoss: number | null;
  totalSteps: number;
  startedAt: number | null;
  completedAt: number | null;
  avgTokensPerSecond: number | null;
  avgGpuUtilization: number | null;
  peakVramUsageMB: number | null;
}

/**
 * Effectiveness delta between a fine-tuned model and its base model.
 */
export interface EffectivenessDelta {
  modelId: string;
  metricType: EffectivenessMetricType;
  value: number;
  baselineValue: number;
  delta: number;
  deltaPercent: number;
  measuredAt: number;
}

/**
 * Timeline entry for the training history panel.
 * Shows model versions with associated effectiveness scores.
 */
export interface ModelVersionTimeline {
  modelId: string;
  modelName: string;
  baseModel: string;
  jobId: string;
  createdAt: number;
  effectiveness: EffectivenessRecord[];
  deltas: EffectivenessDelta[];
}

// ─── Constants ──────────────────────────────────────────────────

/** All available observable metrics */
export const ALL_OBSERVABLE_METRICS: readonly ObservableMetric[] = [
  'loss',
  'learning_rate',
  'gradient_norm',
  'tokens_per_second',
  'gpu_utilization',
  'vram_usage_mb',
  'gpu_temperature',
  'eta_ms',
] as const;

/** Default graph layout for a new project */
export const DEFAULT_LAYOUT: Omit<ObservabilityLayout, 'projectId'> = {
  gridColumns: 2,
  panels: [
    {
      id: 'panel-loss',
      metrics: ['loss'],
      title: 'Training Loss',
      position: { row: 0, col: 0 },
      size: { width: 1, height: 1 },
    },
    {
      id: 'panel-lr',
      metrics: ['learning_rate'],
      title: 'Learning Rate Schedule',
      position: { row: 0, col: 1 },
      size: { width: 1, height: 1 },
    },
    {
      id: 'panel-gpu',
      metrics: ['gpu_utilization', 'vram_usage_mb'],
      title: 'GPU Metrics',
      position: { row: 1, col: 0 },
      size: { width: 1, height: 1 },
    },
    {
      id: 'panel-throughput',
      metrics: ['tokens_per_second'],
      title: 'Throughput',
      position: { row: 1, col: 1 },
      size: { width: 1, height: 1 },
    },
  ],
};

// ─── SQLite Row Types ───────────────────────────────────────────

interface TrainingMetricRow {
  id: number;
  job_id: string;
  step: number;
  epoch: number;
  loss: number;
  learning_rate: number;
  gradient_norm: number | null;
  tokens_per_second: number | null;
  gpu_utilization: number | null;
  vram_usage_mb: number | null;
  gpu_temperature: number | null;
  recorded_at: number;
}

interface EffectivenessRow {
  id: string;
  project_id: string;
  model_id: string;
  metric_type: string;
  value: number;
  baseline_value: number | null;
  measured_at: number;
}

interface TrainingJobRow {
  id: string;
  base_model: string;
  method: string;
  final_loss: number | null;
  total_steps: number | null;
  started_at: number | null;
  completed_at: number | null;
}

interface TrainingModelRow {
  id: string;
  model_name: string;
  base_model: string;
  job_id: string;
  created_at: number;
}

// ─── TrainingObservability Class ────────────────────────────────

/**
 * Training Observability — collects, persists, and queries training metrics
 * for real-time monitoring and historical comparison.
 *
 * This module is the data backbone for the observability panel. It:
 *   1. Receives per-step metrics from the Training Orchestrator's progress events
 *   2. Persists them to the `training_metrics` table for historical access
 *   3. Records pre/post-training effectiveness metrics
 *   4. Provides query APIs for historical comparison across runs
 *   5. Manages user-configurable graph layout preferences
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 37.1, 37.2, 37.3, 37.4
 */
export class TrainingObservability {
  constructor(
    private readonly db: Database.Database,
    // EventLog reserved for future metric threshold alerting events
    readonly eventLog: EventLog,
  ) {}

  // ─── Per-Step Metric Collection (Req 23.1, 23.2) ────────────

  /**
   * Record a per-step training metric from the orchestrator's progress event.
   *
   * Called by the training orchestrator whenever a new step's metrics are
   * available (loss, gradient norm, lr, GPU util, VRAM, tokens/sec).
   * Persists to `training_metrics` table for historical retrieval.
   */
  recordMetricStep(input: MetricStepInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO training_metrics
        (job_id, step, epoch, loss, learning_rate, gradient_norm,
         tokens_per_second, gpu_utilization, vram_usage_mb, gpu_temperature, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.jobId,
      input.step,
      input.epoch,
      input.loss,
      input.learningRate,
      input.gradientNorm ?? null,
      input.tokensPerSecond ?? null,
      input.gpuUtilization ?? null,
      input.vramUsageMB ?? null,
      input.gpuTemperature ?? null,
      Date.now(),
    );
  }

  /**
   * Record multiple metric steps in a single transaction for batch efficiency.
   * Useful when importing metrics from a completed run or backfilling data.
   */
  recordMetricStepsBatch(inputs: MetricStepInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO training_metrics
        (job_id, step, epoch, loss, learning_rate, gradient_norm,
         tokens_per_second, gpu_utilization, vram_usage_mb, gpu_temperature, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const insertMany = this.db.transaction((items: MetricStepInput[]) => {
      for (const input of items) {
        stmt.run(
          input.jobId,
          input.step,
          input.epoch,
          input.loss,
          input.learningRate,
          input.gradientNorm ?? null,
          input.tokensPerSecond ?? null,
          input.gpuUtilization ?? null,
          input.vramUsageMB ?? null,
          input.gpuTemperature ?? null,
          now,
        );
      }
    });

    insertMany(inputs);
  }

  /**
   * Query metrics for a specific job, optionally filtered by step range.
   * Returns records ordered by step ascending.
   */
  getMetricsForJob(
    jobId: string,
    options?: { fromStep?: number; toStep?: number; limit?: number },
  ): TrainingMetricRecord[] {
    let query = 'SELECT * FROM training_metrics WHERE job_id = ?';
    const params: (string | number)[] = [jobId];

    if (options?.fromStep !== undefined) {
      query += ' AND step >= ?';
      params.push(options.fromStep);
    }
    if (options?.toStep !== undefined) {
      query += ' AND step <= ?';
      params.push(options.toStep);
    }

    query += ' ORDER BY step ASC';

    if (options?.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = this.db.prepare(query).all(...params) as TrainingMetricRow[];
    return rows.map((row) => this.metricRowToRecord(row));
  }

  /**
   * Get the latest metric for a specific job (most recent step).
   */
  getLatestMetric(jobId: string): TrainingMetricRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM training_metrics WHERE job_id = ? ORDER BY step DESC LIMIT 1',
    ).get(jobId) as TrainingMetricRow | undefined;

    return row ? this.metricRowToRecord(row) : null;
  }

  /**
   * Get a downsampled set of metrics for a job (for graph display).
   * Returns approximately `targetPoints` evenly-spaced metric records.
   */
  getMetricsSampled(jobId: string, targetPoints: number = 100): TrainingMetricRecord[] {
    // First get total count
    const countRow = this.db.prepare(
      'SELECT COUNT(*) as count FROM training_metrics WHERE job_id = ?',
    ).get(jobId) as { count: number } | undefined;

    const total = countRow?.count ?? 0;
    if (total === 0) return [];

    if (total <= targetPoints) {
      return this.getMetricsForJob(jobId);
    }

    // Calculate sampling interval
    const interval = Math.max(1, Math.floor(total / targetPoints));

    // Use modulo-based sampling for even distribution
    const rows = this.db.prepare(
      `SELECT * FROM training_metrics
       WHERE job_id = ? AND (
         (SELECT COUNT(*) FROM training_metrics t2
          WHERE t2.job_id = training_metrics.job_id AND t2.step <= training_metrics.step) - 1
       ) % ? = 0
       ORDER BY step ASC`,
    ).all(jobId, interval) as TrainingMetricRow[];

    // Fallback: if the modulo query is too slow or returns nothing,
    // just use LIMIT with offset stepping
    if (rows.length === 0) {
      const allRows = this.db.prepare(
        'SELECT * FROM training_metrics WHERE job_id = ? ORDER BY step ASC',
      ).all(jobId) as TrainingMetricRow[];

      const sampled: TrainingMetricRow[] = [];
      for (let i = 0; i < allRows.length; i += interval) {
        const row = allRows[i];
        if (row) sampled.push(row);
      }
      return sampled.map((row) => this.metricRowToRecord(row));
    }

    return rows.map((row) => this.metricRowToRecord(row));
  }

  // ─── Effectiveness Metrics (Req 37.1, 37.2, 37.3) ────────────

  /**
   * Record a pre/post-training performance metric.
   *
   * Used to track how fine-tuning affects:
   *   - Response quality (from user feedback scores)
   *   - Task completion rate
   *   - Retrieval precision (for embedding models)
   *
   * The baselineValue represents the base model's performance on the same
   * metric, enabling delta computation for comparison panels.
   */
  recordEffectivenessMetric(input: EffectivenessInput): EffectivenessRecord {
    const id = randomUUID();
    const measuredAt = Date.now();

    this.db.prepare(`
      INSERT INTO training_effectiveness
        (id, project_id, model_id, metric_type, value, baseline_value, measured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.modelId,
      input.metricType,
      input.value,
      input.baselineValue ?? null,
      measuredAt,
    );

    return {
      id,
      projectId: input.projectId,
      modelId: input.modelId,
      metricType: input.metricType,
      value: input.value,
      baselineValue: input.baselineValue ?? null,
      measuredAt,
    };
  }

  /**
   * Get all effectiveness metrics for a specific model.
   */
  getEffectivenessForModel(modelId: string): EffectivenessRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM training_effectiveness WHERE model_id = ? ORDER BY measured_at DESC',
    ).all(modelId) as EffectivenessRow[];

    return rows.map((row) => this.effectivenessRowToRecord(row));
  }

  /**
   * Get effectiveness metrics for a project, across all models.
   */
  getEffectivenessForProject(projectId: string): EffectivenessRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM training_effectiveness WHERE project_id = ? ORDER BY measured_at DESC',
    ).all(projectId) as EffectivenessRow[];

    return rows.map((row) => this.effectivenessRowToRecord(row));
  }

  /**
   * Compute the delta between a fine-tuned model's metrics and its baseline.
   *
   * Returns the difference for each metric type that has a recorded baseline
   * value, enabling "delta vs base model" display in the training history panel.
   *
   * Requirements: 37.2
   */
  getEffectivenessDeltas(modelId: string): EffectivenessDelta[] {
    const metrics = this.getEffectivenessForModel(modelId);
    const deltas: EffectivenessDelta[] = [];

    for (const metric of metrics) {
      if (metric.baselineValue !== null) {
        const delta = metric.value - metric.baselineValue;
        const deltaPercent = metric.baselineValue !== 0
          ? (delta / metric.baselineValue) * 100
          : 0;

        deltas.push({
          modelId: metric.modelId,
          metricType: metric.metricType,
          value: metric.value,
          baselineValue: metric.baselineValue,
          delta: Math.round(delta * 10000) / 10000,
          deltaPercent: Math.round(deltaPercent * 100) / 100,
          measuredAt: metric.measuredAt,
        });
      }
    }

    return deltas;
  }

  // ─── Historical Comparison (Req 23.4, 37.4) ──────────────────

  /**
   * Get a summary of all training runs for a project, including aggregate
   * metrics for comparison. Used by the historical comparison panel.
   *
   * Requirements: 23.4
   */
  getTrainingRunSummaries(projectId: string): TrainingRunSummary[] {
    const jobs = this.db.prepare(
      `SELECT id, base_model, method, final_loss, total_steps, started_at, completed_at
       FROM training_jobs
       WHERE project_id = ? AND state = 'completed'
       ORDER BY completed_at DESC`,
    ).all(projectId) as TrainingJobRow[];

    return jobs.map((job) => {
      // Get aggregate metrics for this job
      const aggRow = this.db.prepare(
        `SELECT
           AVG(tokens_per_second) as avg_tps,
           AVG(gpu_utilization) as avg_gpu,
           MAX(vram_usage_mb) as peak_vram
         FROM training_metrics
         WHERE job_id = ?`,
      ).get(job.id) as { avg_tps: number | null; avg_gpu: number | null; peak_vram: number | null } | undefined;

      return {
        jobId: job.id,
        baseModel: job.base_model,
        method: job.method,
        finalLoss: job.final_loss,
        totalSteps: job.total_steps ?? 0,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        avgTokensPerSecond: aggRow?.avg_tps ?? null,
        avgGpuUtilization: aggRow?.avg_gpu ?? null,
        peakVramUsageMB: aggRow?.peak_vram ?? null,
      };
    });
  }

  /**
   * Compare metrics between two training runs side-by-side.
   * Returns aligned metric arrays for chart overlay display.
   */
  compareRuns(
    jobIdA: string,
    jobIdB: string,
    _metric: ObservableMetric = 'loss',
    targetPoints: number = 100,
  ): { runA: TrainingMetricRecord[]; runB: TrainingMetricRecord[] } {
    const runA = this.getMetricsSampled(jobIdA, targetPoints);
    const runB = this.getMetricsSampled(jobIdB, targetPoints);
    return { runA, runB };
  }

  /**
   * Get the model version timeline for a project.
   *
   * Displays model versions with associated effectiveness scores,
   * enabling the user to identify the most effective training run.
   *
   * Requirements: 37.4
   */
  getModelVersionTimeline(projectId: string): ModelVersionTimeline[] {
    const models = this.db.prepare(
      `SELECT id, model_name, base_model, job_id, created_at
       FROM training_models
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    ).all(projectId) as TrainingModelRow[];

    return models.map((model) => {
      const effectiveness = this.getEffectivenessForModel(model.id);
      const deltas = this.getEffectivenessDeltas(model.id);

      return {
        modelId: model.id,
        modelName: model.model_name,
        baseModel: model.base_model,
        jobId: model.job_id,
        createdAt: model.created_at,
        effectiveness,
        deltas,
      };
    });
  }

  // ─── Graph Layout Configuration (Req 23.3) ───────────────────

  /**
   * Get the user's graph layout configuration for a project.
   * Returns the default layout if no custom layout has been saved.
   */
  getLayout(projectId: string): ObservabilityLayout {
    const layoutRow = this.getStoredLayout(projectId);
    if (layoutRow) {
      return layoutRow;
    }

    return {
      projectId,
      ...DEFAULT_LAYOUT,
    };
  }

  /**
   * Save a user-configurable graph layout for the observability panel.
   *
   * Users can select which metrics to display and how panels are arranged.
   */
  saveLayout(layout: ObservabilityLayout): void {
    const json = JSON.stringify(layout);
    // Store in a simple key-value pattern using a known key per project
    const existing = this.getStoredLayout(layout.projectId);

    if (existing) {
      this.db.prepare(
        `UPDATE training_schedules
         SET last_config_json = ?
         WHERE id = ? AND project_id = ?`,
      ).run(json, `__layout_${layout.projectId}__`, layout.projectId);
    } else {
      // Insert a layout record using the schedules table as a generic store
      // won't conflict since id is prefixed with __layout_
      this.db.prepare(
        `INSERT OR REPLACE INTO training_schedules
          (id, project_id, cron_expression, last_config_json, retry_count, max_retries, enabled, created_at)
         VALUES (?, ?, '__layout__', ?, 0, 0, 0, ?)`,
      ).run(`__layout_${layout.projectId}__`, layout.projectId, json, Date.now());
    }
  }

  /**
   * Reset the layout to defaults for a project.
   */
  resetLayout(projectId: string): ObservabilityLayout {
    this.db.prepare(
      `DELETE FROM training_schedules WHERE id = ?`,
    ).run(`__layout_${projectId}__`);

    return {
      projectId,
      ...DEFAULT_LAYOUT,
    };
  }

  // ─── Metric Deletion (for cleanup) ───────────────────────────

  /**
   * Delete all metrics for a specific job. Used when a job is deleted
   * as part of the data retention cleanup.
   */
  deleteMetricsForJob(jobId: string): number {
    const result = this.db.prepare(
      'DELETE FROM training_metrics WHERE job_id = ?',
    ).run(jobId);
    return result.changes;
  }

  /**
   * Delete all effectiveness records for a specific model.
   */
  deleteEffectivenessForModel(modelId: string): number {
    const result = this.db.prepare(
      'DELETE FROM training_effectiveness WHERE model_id = ?',
    ).run(modelId);
    return result.changes;
  }

  // ─── ETA Computation ──────────────────────────────────────────

  /**
   * Compute estimated time remaining based on recent metrics.
   * Uses a moving average of the last N steps' tokens/sec throughput
   * combined with remaining steps to estimate ETA.
   */
  computeETA(jobId: string, totalSteps: number): number {
    const recentMetrics = this.db.prepare(
      `SELECT step, tokens_per_second, recorded_at
       FROM training_metrics
       WHERE job_id = ? AND tokens_per_second IS NOT NULL
       ORDER BY step DESC
       LIMIT 10`,
    ).all(jobId) as { step: number; tokens_per_second: number; recorded_at: number }[];

    if (recentMetrics.length === 0) return 0;

    const firstMetric = recentMetrics[0]!;
    const currentStep = firstMetric.step;
    const remainingSteps = totalSteps - currentStep;
    if (remainingSteps <= 0) return 0;

    // Average tokens/sec from recent steps
    const avgTps = recentMetrics.reduce(
      (sum, m) => sum + m.tokens_per_second, 0,
    ) / recentMetrics.length;

    if (avgTps <= 0) return 0;

    // Estimate time per step from recent cadence
    if (recentMetrics.length >= 2) {
      const newest = recentMetrics[0]!;
      const oldest = recentMetrics[recentMetrics.length - 1]!;
      const elapsedMs = newest.recorded_at - oldest.recorded_at;
      const stepsCompleted = newest.step - oldest.step;

      if (stepsCompleted > 0 && elapsedMs > 0) {
        const msPerStep = elapsedMs / stepsCompleted;
        return Math.round(remainingSteps * msPerStep);
      }
    }

    // Fallback: rough estimate from tokens/sec
    // Assume average tokens_per_step ~ 512
    const tokensPerStep = 512;
    const msPerStep = (tokensPerStep / avgTps) * 1000;
    return Math.round(remainingSteps * msPerStep);
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Get stored layout from the database.
   */
  private getStoredLayout(projectId: string): ObservabilityLayout | null {
    try {
      const row = this.db.prepare(
        `SELECT last_config_json FROM training_schedules
         WHERE id = ? AND project_id = ?`,
      ).get(`__layout_${projectId}__`, projectId) as { last_config_json: string } | undefined;

      if (!row) return null;
      return JSON.parse(row.last_config_json) as ObservabilityLayout;
    } catch {
      return null;
    }
  }

  /**
   * Convert a training_metrics SQLite row to a TrainingMetricRecord.
   */
  private metricRowToRecord(row: TrainingMetricRow): TrainingMetricRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      step: row.step,
      epoch: row.epoch,
      loss: row.loss,
      learningRate: row.learning_rate,
      gradientNorm: row.gradient_norm,
      tokensPerSecond: row.tokens_per_second,
      gpuUtilization: row.gpu_utilization,
      vramUsageMB: row.vram_usage_mb,
      gpuTemperature: row.gpu_temperature,
      recordedAt: row.recorded_at,
    };
  }

  /**
   * Convert a training_effectiveness SQLite row to an EffectivenessRecord.
   */
  private effectivenessRowToRecord(row: EffectivenessRow): EffectivenessRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      modelId: row.model_id,
      metricType: row.metric_type as EffectivenessMetricType,
      value: row.value,
      baselineValue: row.baseline_value,
      measuredAt: row.measured_at,
    };
  }
}
