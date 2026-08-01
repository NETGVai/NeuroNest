/**
 * ModelValidator — Automated validation of trained models before deployment.
 *
 * Responsibilities:
 *   - Run inference on a held-out evaluation set (10% holdout from training data)
 *   - Compute perplexity metric for both trained and base model
 *   - Compute coherence metric (response quality scoring)
 *   - Compare trained model metrics against base model performance
 *   - Flag model as FAILED if perplexity increase > 20% or coherence decrease > 15%
 *   - Require user confirmation for failed validation before allowing export
 *   - Support "Export Without Validation" skip option
 *   - Persist validation results in training_models table
 *
 * All subprocess operations use SafeExec (execFile with argument arrays, no shell).
 *
 * Requirements: 40.1, 40.2, 40.3, 40.4, 40.5
 */

import type Database from 'better-sqlite3';
import type { SafeExecFn } from '../export/gguf-exporter.js';

// ─── Types ──────────────────────────────────────────────────────

/** Result of computing perplexity for a model on an evaluation set */
export interface PerplexityResult {
  /** Average perplexity across evaluation samples */
  perplexity: number;
  /** Number of samples evaluated */
  sampleCount: number;
}

/** Result of computing coherence for a model on an evaluation set */
export interface CoherenceResult {
  /** Average coherence score across evaluation samples (0-1 scale) */
  coherence: number;
  /** Number of samples scored */
  sampleCount: number;
}

/** Metrics computed for a single model (trained or base) */
export interface ModelMetrics {
  perplexity: number;
  coherence: number;
  sampleCount: number;
}

/** Comparison results between trained model and base model */
export interface ValidationMetrics {
  /** Trained model perplexity */
  trainedPerplexity: number;
  /** Base model perplexity */
  baselinePerplexity: number;
  /** Percentage change in perplexity (positive = worse) */
  perplexityChangePercent: number;
  /** Trained model coherence score (0-1) */
  trainedCoherence: number;
  /** Base model coherence score (0-1) */
  baselineCoherence: number;
  /** Percentage change in coherence (negative = worse) */
  coherenceChangePercent: number;
  /** Number of evaluation samples used */
  evalSampleCount: number;
}

/** Validation outcome after applying threshold checks */
export type ValidationStatus = 'passed' | 'failed';

/** Complete validation result */
export interface ValidationResult {
  /** Whether validation passed or failed */
  status: ValidationStatus;
  /** Detailed metrics comparison */
  metrics: ValidationMetrics;
  /** Human-readable reasons for failure (empty if passed) */
  failureReasons: string[];
}

/** Configuration for model validation */
export interface ModelValidationConfig {
  /** Path to the trained model weights */
  trainedModelPath: string;
  /** Base model name/path for comparison */
  baseModelName: string;
  /** Path to evaluation dataset (holdout set) */
  evalDatasetPath: string;
  /** Training job ID (for event correlation and persistence) */
  jobId: string;
  /** Project ID (for record keeping) */
  projectId: string;
  /** Perplexity increase threshold (default: 0.20 = 20%) */
  perplexityThreshold?: number;
  /** Coherence decrease threshold (default: 0.15 = 15%) */
  coherenceThreshold?: number;
}

/** Options for the export decision after validation */
export interface ExportDecision {
  /** Whether to proceed with export */
  proceed: boolean;
  /** Whether validation was skipped ("Export Without Validation") */
  skippedValidation: boolean;
  /** Whether user confirmed despite failed validation */
  userConfirmedDespiteFailure: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default threshold: flag as failed if perplexity increases by more than 20% */
const DEFAULT_PERPLEXITY_THRESHOLD = 0.20;

/** Default threshold: flag as failed if coherence decreases by more than 15% */
const DEFAULT_COHERENCE_THRESHOLD = 0.15;

/** Default holdout split for evaluation (10%) */
export const DEFAULT_VALIDATION_SPLIT = 0.10;

/** Timeout for inference subprocess (10 minutes per model) */
const INFERENCE_TIMEOUT_MS = 10 * 60 * 1000;

// ─── Errors ─────────────────────────────────────────────────────

export class ModelValidationError extends Error {
  constructor(message: string, public readonly modelPath?: string) {
    super(message);
    this.name = 'ModelValidationError';
  }
}

// ─── ModelValidator ─────────────────────────────────────────────

/**
 * Validates trained models before deployment by comparing performance
 * against the base model on a held-out evaluation set.
 *
 * The validation process:
 * 1. Run inference on eval set using the trained model → compute perplexity & coherence
 * 2. Run inference on eval set using the base model → compute perplexity & coherence
 * 3. Compare metrics: flag as failed if thresholds exceeded
 * 4. Persist results to training_models table
 *
 * Requirements: 40.1, 40.2, 40.3, 40.4, 40.5
 */
export class ModelValidator {
  private readonly perplexityThreshold: number;
  private readonly coherenceThreshold: number;

  constructor(
    private readonly safeExec: SafeExecFn,
    private readonly db: Database.Database,
    options?: {
      perplexityThreshold?: number;
      coherenceThreshold?: number;
    },
  ) {
    this.perplexityThreshold = options?.perplexityThreshold ?? DEFAULT_PERPLEXITY_THRESHOLD;
    this.coherenceThreshold = options?.coherenceThreshold ?? DEFAULT_COHERENCE_THRESHOLD;
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Run full validation pipeline: evaluate trained model vs base model.
   *
   * Computes perplexity and coherence metrics for both models on the
   * held-out evaluation set, then applies threshold checks.
   *
   * Requirements: 40.1, 40.2, 40.3
   */
  async validate(config: ModelValidationConfig): Promise<ValidationResult> {
    const {
      trainedModelPath,
      baseModelName,
      evalDatasetPath,
      perplexityThreshold = this.perplexityThreshold,
      coherenceThreshold = this.coherenceThreshold,
    } = config;

    // Step 1: Compute metrics for the trained model
    const trainedMetrics = await this.computeModelMetrics(trainedModelPath, evalDatasetPath);

    // Step 2: Compute metrics for the base model
    const baseMetrics = await this.computeModelMetrics(baseModelName, evalDatasetPath);

    // Step 3: Compare and apply thresholds
    const metrics = this.compareMetrics(trainedMetrics, baseMetrics);
    const { status, failureReasons } = this.applyValidationGate(metrics, perplexityThreshold, coherenceThreshold);

    const result: ValidationResult = {
      status,
      metrics,
      failureReasons,
    };

    // Step 4: Persist validation results
    this.persistValidationResults(config.jobId, result);

    return result;
  }

  /**
   * Apply validation gate logic to computed metrics.
   *
   * Rules:
   *   - If perplexity increase > threshold (default 20%): FAILED
   *   - If coherence decrease > threshold (default 15%): FAILED
   *   - Otherwise: PASSED
   *
   * Requirements: 40.3
   */
  applyValidationGate(
    metrics: ValidationMetrics,
    perplexityThreshold: number = this.perplexityThreshold,
    coherenceThreshold: number = this.coherenceThreshold,
  ): { status: ValidationStatus; failureReasons: string[] } {
    const failureReasons: string[] = [];

    // Check perplexity increase (positive perplexityChangePercent = worse)
    if (metrics.perplexityChangePercent > perplexityThreshold * 100) {
      failureReasons.push(
        `Perplexity increased by ${metrics.perplexityChangePercent.toFixed(1)}% ` +
        `(threshold: ${(perplexityThreshold * 100).toFixed(0)}%). ` +
        `Trained: ${metrics.trainedPerplexity.toFixed(2)}, Base: ${metrics.baselinePerplexity.toFixed(2)}`,
      );
    }

    // Check coherence decrease (negative coherenceChangePercent = worse)
    if (metrics.coherenceChangePercent < -(coherenceThreshold * 100)) {
      failureReasons.push(
        `Coherence decreased by ${Math.abs(metrics.coherenceChangePercent).toFixed(1)}% ` +
        `(threshold: ${(coherenceThreshold * 100).toFixed(0)}%). ` +
        `Trained: ${metrics.trainedCoherence.toFixed(3)}, Base: ${metrics.baselineCoherence.toFixed(3)}`,
      );
    }

    const status: ValidationStatus = failureReasons.length > 0 ? 'failed' : 'passed';
    return { status, failureReasons };
  }

  /**
   * Check whether the export should proceed based on validation result
   * and user decision.
   *
   * If validation failed, this method requires explicit user confirmation.
   * The "Export Without Validation" skip option bypasses validation entirely.
   *
   * Requirements: 40.3, 40.5
   */
  shouldProceedWithExport(
    validationResult: ValidationResult | null,
    userConfirmed: boolean,
    skipValidation: boolean,
  ): ExportDecision {
    // "Export Without Validation" — skip option
    if (skipValidation) {
      return {
        proceed: true,
        skippedValidation: true,
        userConfirmedDespiteFailure: false,
      };
    }

    // No validation result means validation wasn't run — shouldn't proceed
    if (!validationResult) {
      return {
        proceed: false,
        skippedValidation: false,
        userConfirmedDespiteFailure: false,
      };
    }

    // Validation passed — proceed
    if (validationResult.status === 'passed') {
      return {
        proceed: true,
        skippedValidation: false,
        userConfirmedDespiteFailure: false,
      };
    }

    // Validation failed — require user confirmation
    return {
      proceed: userConfirmed,
      skippedValidation: false,
      userConfirmedDespiteFailure: userConfirmed,
    };
  }

  /**
   * Persist validation results to the training_models table.
   *
   * Updates validation_passed (INTEGER 0/1) and validation_metrics_json columns.
   *
   * Requirements: 40.4
   */
  persistValidationResults(jobId: string, result: ValidationResult): void {
    const validationPassed = result.status === 'passed' ? 1 : 0;
    const metricsJson = JSON.stringify({
      ...result.metrics,
      failureReasons: result.failureReasons,
    });

    // Update existing record in training_models if it exists
    const updateResult = this.db.prepare(
      `UPDATE training_models
       SET validation_passed = ?, validation_metrics_json = ?
       WHERE job_id = ?`,
    ).run(validationPassed, metricsJson, jobId);

    // If no row was updated (model record not yet created), store in training_jobs
    // as a fallback for later association when the model is exported
    if (updateResult.changes === 0) {
      this.db.prepare(
        `UPDATE training_jobs
         SET config_json = json_set(
           COALESCE(config_json, '{}'),
           '$.validationResult',
           json(?)
         )
         WHERE id = ?`,
      ).run(
        JSON.stringify({
          validationPassed,
          validationMetrics: result.metrics,
          failureReasons: result.failureReasons,
        }),
        jobId,
      );
    }
  }

  /**
   * Get validation results for a model/job from the database.
   *
   * Requirements: 40.4
   */
  getValidationResults(jobId: string): ValidationResult | null {
    // Try training_models first
    const modelRow = this.db.prepare(
      `SELECT validation_passed, validation_metrics_json
       FROM training_models
       WHERE job_id = ?`,
    ).get(jobId) as { validation_passed: number | null; validation_metrics_json: string | null } | undefined;

    if (modelRow?.validation_metrics_json) {
      try {
        const parsed = JSON.parse(modelRow.validation_metrics_json) as ValidationMetrics & { failureReasons?: string[] };
        return {
          status: modelRow.validation_passed === 1 ? 'passed' : 'failed',
          metrics: {
            trainedPerplexity: parsed.trainedPerplexity,
            baselinePerplexity: parsed.baselinePerplexity,
            perplexityChangePercent: parsed.perplexityChangePercent,
            trainedCoherence: parsed.trainedCoherence,
            baselineCoherence: parsed.baselineCoherence,
            coherenceChangePercent: parsed.coherenceChangePercent,
            evalSampleCount: parsed.evalSampleCount,
          },
          failureReasons: parsed.failureReasons ?? [],
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  // ─── Private: Metric Computation ──────────────────────────────

  /**
   * Compute perplexity and coherence metrics for a model on an evaluation set.
   *
   * Spawns a Python subprocess via SafeExec that:
   * 1. Loads the model (either from path or by name from Ollama)
   * 2. Runs inference on each sample in the eval dataset
   * 3. Outputs JSON with perplexity and coherence scores
   *
   * Requirements: 40.1, 40.2
   */
  private async computeModelMetrics(modelPathOrName: string, evalDatasetPath: string): Promise<ModelMetrics> {
    const result = await this.safeExec(
      'python',
      [
        '-m', 'neuronest_training.validate',
        '--model', modelPathOrName,
        '--eval-dataset', evalDatasetPath,
        '--output-format', 'json',
      ],
      { timeout: INFERENCE_TIMEOUT_MS },
    );

    if (result.exitCode !== 0) {
      throw new ModelValidationError(
        `Model validation inference failed (exit code ${result.exitCode}): ${result.stderr}`,
        modelPathOrName,
      );
    }

    // Parse the JSON output from the validation script
    try {
      const output = this.extractJsonFromOutput(result.stdout);
      const parsed = JSON.parse(output) as { perplexity: number; coherence: number; sampleCount: number };

      if (typeof parsed.perplexity !== 'number' || typeof parsed.coherence !== 'number') {
        throw new Error('Invalid validation output format');
      }

      return {
        perplexity: parsed.perplexity,
        coherence: parsed.coherence,
        sampleCount: parsed.sampleCount ?? 0,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ModelValidationError(
        `Failed to parse validation results: ${msg}. stdout: ${result.stdout.slice(0, 200)}`,
        modelPathOrName,
      );
    }
  }

  /**
   * Compare metrics between trained and base model.
   * Computes percentage changes for threshold comparison.
   */
  private compareMetrics(trained: ModelMetrics, base: ModelMetrics): ValidationMetrics {
    // Perplexity change: positive means worse (higher perplexity = worse)
    const perplexityChangePercent = base.perplexity > 0
      ? ((trained.perplexity - base.perplexity) / base.perplexity) * 100
      : 0;

    // Coherence change: negative means worse (lower coherence = worse)
    const coherenceChangePercent = base.coherence > 0
      ? ((trained.coherence - base.coherence) / base.coherence) * 100
      : 0;

    return {
      trainedPerplexity: trained.perplexity,
      baselinePerplexity: base.perplexity,
      perplexityChangePercent,
      trainedCoherence: trained.coherence,
      baselineCoherence: base.coherence,
      coherenceChangePercent,
      evalSampleCount: Math.min(trained.sampleCount, base.sampleCount),
    };
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /**
   * Extract JSON content from subprocess stdout.
   * The validation script may output additional text before/after the JSON.
   * We look for the last complete JSON object in the output.
   */
  private extractJsonFromOutput(stdout: string): string {
    // Try to find a JSON line in the output
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        return line;
      }
    }

    // If no single-line JSON found, try the entire output
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    throw new Error('No JSON found in validation output');
  }
}
