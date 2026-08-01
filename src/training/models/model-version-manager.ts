/**
 * Model Version Manager — Maintains version history of exported models
 * and supports rollback to previous versions.
 *
 * Responsibilities:
 *   - Track version history of exported models (config, metrics, timestamp)
 *   - Rollback to a previous model version: re-register GGUF with Ollama, update Provider_Registry
 *   - Enforce max 5 versions per project (delete oldest GGUF + DB record when exceeded)
 *   - Provide data for rendering rollback UI (training history with confirmation)
 *
 * Requirements: 41.1, 41.2, 41.3, 41.4, 41.5
 */

import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { IProviderRegistry } from '../../providers/provider-registry.js';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import {
  TRAINING_EVENT_KINDS,
  TRAINING_SOURCE_IDENTIFIERS,
} from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/** Metadata stored per model version in the training_models table */
export interface ModelVersion {
  id: string;
  projectId: string;
  jobId: string;
  modelName: string;
  baseModel: string;
  ggufPath: string;
  quantization: string;
  sizeBytes: number;
  validationPassed: boolean | null;
  validationMetrics: ValidationMetrics | null;
  isActive: boolean;
  createdAt: number;
}

/** Validation metrics persisted alongside a model version */
export interface ValidationMetrics {
  perplexity: number;
  coherence: number;
  baselinePerplexity: number;
  baselineCoherence?: number;
}

/** Information displayed in the rollback confirmation dialog */
export interface RollbackInfo {
  /** The version to roll back to */
  targetVersion: ModelVersion;
  /** The currently active version (if any) */
  currentVersion: ModelVersion | null;
  /** Differences between current and target */
  differences: RollbackDifference[];
}

/** A single difference between two model versions */
export interface RollbackDifference {
  field: string;
  currentValue: string;
  targetValue: string;
}

/** Result of a rollback operation */
export interface RollbackResult {
  success: boolean;
  /** The version that is now active */
  activeVersion: ModelVersion | null;
  /** Indicates whether Ollama registration succeeded */
  ollamaRegistered: boolean;
  /** Indicates whether Provider_Registry was updated */
  providerRegistered: boolean;
  /** Error message if rollback failed */
  error?: string;
}

/** Type signature for the SafeExec async function */
export type SafeExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

// ─── Constants ──────────────────────────────────────────────────

/** Maximum number of model versions retained per project */
const MAX_VERSIONS_PER_PROJECT = 5;

/** Default Ollama API endpoint */
const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/** Provider ID prefix used for fine-tuned models */
const FINETUNED_PROVIDER_PREFIX = 'ollama-finetuned';

// ─── ModelVersionManager ────────────────────────────────────────

/**
 * Manages model version history and rollback for the training pipeline.
 *
 * Stores model version metadata in SQLite (training_models table).
 * Enforces at most 5 versions per project by deleting the oldest when exceeded.
 * Supports rollback by re-registering a previous GGUF with Ollama and updating
 * the Provider_Registry — no retraining or re-export required.
 */
export class ModelVersionManager {
  /** Maximum versions retained per project */
  readonly maxVersionsPerProject: number = MAX_VERSIONS_PER_PROJECT;
  private readonly ollamaEndpoint: string;

  constructor(
    private readonly db: Database.Database,
    private readonly safeExec: SafeExecFn,
    private readonly providerRegistry: IProviderRegistry,
    private readonly eventLog: EventLog,
    options?: {
      ollamaEndpoint?: string;
      maxVersions?: number;
    },
  ) {
    this.ollamaEndpoint = options?.ollamaEndpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    if (options?.maxVersions !== undefined && options.maxVersions > 0) {
      this.maxVersionsPerProject = options.maxVersions;
    }
  }

  // ─── Record New Model Version ─────────────────────────────────

  /**
   * Record a new model version after export.
   *
   * Inserts the model into version history, deactivates any previously active
   * version for the project, marks the new version as active, and enforces
   * the retention policy (max 5 per project).
   *
   * @param version - Partial model version data (id, projectId, jobId, etc.)
   * @returns The complete ModelVersion record
   *
   * Requirements: 41.1, 41.3
   */
  recordVersion(version: Omit<ModelVersion, 'isActive'>): ModelVersion {
    const { id, projectId, jobId, modelName, baseModel, ggufPath, quantization, sizeBytes, validationPassed, validationMetrics, createdAt } = version;

    // Deactivate any currently active model for this project
    this.db.prepare(
      `UPDATE training_models SET is_active = 0 WHERE project_id = ? AND is_active = 1`,
    ).run(projectId);

    // Insert the new version as the active model
    this.db.prepare(
      `INSERT INTO training_models
        (id, project_id, job_id, model_name, base_model, gguf_path, quantization, size_bytes, validation_passed, validation_metrics_json, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      id,
      projectId,
      jobId,
      modelName,
      baseModel,
      ggufPath,
      quantization,
      sizeBytes,
      validationPassed == null ? null : validationPassed ? 1 : 0,
      validationMetrics ? JSON.stringify(validationMetrics) : null,
      createdAt,
    );

    // Enforce retention policy
    this.enforceRetention(projectId);

    return { ...version, isActive: true };
  }

  // ─── Query Version History ────────────────────────────────────

  /**
   * List all model versions for a project, ordered newest first.
   *
   * @param projectId - The project to query
   * @returns Array of ModelVersion objects
   *
   * Requirements: 41.1
   */
  listVersions(projectId: string): ModelVersion[] {
    const rows = this.db.prepare(
      `SELECT id, project_id, job_id, model_name, base_model, gguf_path,
              quantization, size_bytes, validation_passed, validation_metrics_json,
              is_active, created_at
       FROM training_models
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    ).all(projectId) as ModelRow[];

    return rows.map((row) => this.rowToModelVersion(row));
  }

  /**
   * Get the currently active model version for a project.
   *
   * @param projectId - The project to query
   * @returns The active ModelVersion, or null if none is active
   */
  getActiveVersion(projectId: string): ModelVersion | null {
    const row = this.db.prepare(
      `SELECT id, project_id, job_id, model_name, base_model, gguf_path,
              quantization, size_bytes, validation_passed, validation_metrics_json,
              is_active, created_at
       FROM training_models
       WHERE project_id = ? AND is_active = 1`,
    ).get(projectId) as ModelRow | undefined;

    return row ? this.rowToModelVersion(row) : null;
  }

  /**
   * Get a specific model version by ID.
   *
   * @param versionId - The version ID
   * @returns The ModelVersion, or null if not found
   */
  getVersion(versionId: string): ModelVersion | null {
    const row = this.db.prepare(
      `SELECT id, project_id, job_id, model_name, base_model, gguf_path,
              quantization, size_bytes, validation_passed, validation_metrics_json,
              is_active, created_at
       FROM training_models
       WHERE id = ?`,
    ).get(versionId) as ModelRow | undefined;

    return row ? this.rowToModelVersion(row) : null;
  }

  /**
   * Count model versions for a project.
   *
   * @param projectId - The project to query
   * @returns Number of stored versions
   */
  countVersions(projectId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM training_models WHERE project_id = ?`,
    ).get(projectId) as { cnt: number };
    return row.cnt;
  }

  // ─── Rollback ─────────────────────────────────────────────────

  /**
   * Get rollback information for a target version, including version differences.
   * Used to populate the confirmation dialog in the training history UI.
   *
   * @param targetVersionId - The model version to roll back to
   * @returns RollbackInfo with target, current, and differences
   *
   * Requirements: 41.4
   */
  getRollbackInfo(targetVersionId: string): RollbackInfo | null {
    const targetVersion = this.getVersion(targetVersionId);
    if (!targetVersion) return null;

    const currentVersion = this.getActiveVersion(targetVersion.projectId);

    const differences: RollbackDifference[] = [];

    if (currentVersion) {
      if (currentVersion.baseModel !== targetVersion.baseModel) {
        differences.push({
          field: 'Base Model',
          currentValue: currentVersion.baseModel,
          targetValue: targetVersion.baseModel,
        });
      }
      if (currentVersion.quantization !== targetVersion.quantization) {
        differences.push({
          field: 'Quantization',
          currentValue: currentVersion.quantization,
          targetValue: targetVersion.quantization,
        });
      }
      if (currentVersion.modelName !== targetVersion.modelName) {
        differences.push({
          field: 'Model Name',
          currentValue: currentVersion.modelName,
          targetValue: targetVersion.modelName,
        });
      }
      // Include timestamp difference
      differences.push({
        field: 'Export Date',
        currentValue: new Date(currentVersion.createdAt).toISOString(),
        targetValue: new Date(targetVersion.createdAt).toISOString(),
      });
      // Include validation status difference
      const currentValidation = currentVersion.validationPassed == null
        ? 'Not validated'
        : currentVersion.validationPassed ? 'Passed' : 'Failed';
      const targetValidation = targetVersion.validationPassed == null
        ? 'Not validated'
        : targetVersion.validationPassed ? 'Passed' : 'Failed';
      if (currentValidation !== targetValidation) {
        differences.push({
          field: 'Validation',
          currentValue: currentValidation,
          targetValue: targetValidation,
        });
      }
    }

    return {
      targetVersion,
      currentVersion,
      differences,
    };
  }

  /**
   * Perform a rollback to a previous model version.
   *
   * Steps:
   *   1. Verify the target version exists and its GGUF file is accessible
   *   2. Deactivate the current active model
   *   3. Re-register the target version's GGUF with Ollama
   *   4. Update the Provider_Registry
   *   5. Set the target version as active in the DB
   *   6. Emit a rollback event to the EventLog
   *
   * No retraining or re-export is required — uses the preserved GGUF artifact.
   *
   * @param targetVersionId - The version ID to roll back to
   * @returns RollbackResult indicating success/failure
   *
   * Requirements: 41.2, 41.3
   */
  async rollback(targetVersionId: string): Promise<RollbackResult> {
    const targetVersion = this.getVersion(targetVersionId);
    if (!targetVersion) {
      return {
        success: false,
        activeVersion: null,
        ollamaRegistered: false,
        providerRegistered: false,
        error: `Model version ${targetVersionId} not found`,
      };
    }

    // Verify the GGUF file still exists on disk
    if (!this.fileExists(targetVersion.ggufPath)) {
      return {
        success: false,
        activeVersion: null,
        ollamaRegistered: false,
        providerRegistered: false,
        error: `GGUF file not found at ${targetVersion.ggufPath}. Cannot rollback without the model artifact.`,
      };
    }

    // Deactivate current active version
    this.db.prepare(
      `UPDATE training_models SET is_active = 0 WHERE project_id = ? AND is_active = 1`,
    ).run(targetVersion.projectId);

    // Activate the target version
    this.db.prepare(
      `UPDATE training_models SET is_active = 1 WHERE id = ?`,
    ).run(targetVersionId);

    // Re-register with Ollama
    let ollamaRegistered = false;
    try {
      await this.registerWithOllama(targetVersion.ggufPath, targetVersion.modelName);
      ollamaRegistered = true;
    } catch {
      // Ollama registration failure is non-fatal
      // The model is still set as active in the DB; user can manually import
    }

    // Update Provider_Registry
    let providerRegistered = false;
    try {
      this.registerWithProviderRegistry(targetVersion.modelName);
      providerRegistered = true;
    } catch {
      // Provider registration failure is non-fatal
    }

    // Emit rollback event
    this.emitRollbackEvent(targetVersion);

    return {
      success: true,
      activeVersion: { ...targetVersion, isActive: true },
      ollamaRegistered,
      providerRegistered,
    };
  }

  // ─── Retention Policy ─────────────────────────────────────────

  /**
   * Enforce the max versions per project retention policy.
   * Deletes the oldest versions (and their GGUF files) when count exceeds max.
   *
   * Requirements: 41.3, 35.1
   */
  enforceRetention(projectId: string): void {
    const count = this.countVersions(projectId);
    if (count <= this.maxVersionsPerProject) return;

    const excess = count - this.maxVersionsPerProject;

    // Get oldest model IDs to delete (never delete the active version)
    const toDelete = this.db.prepare(
      `SELECT id, gguf_path FROM training_models
       WHERE project_id = ? AND is_active = 0
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(projectId, excess) as Array<{ id: string; gguf_path: string }>;

    for (const { id, gguf_path } of toDelete) {
      // Attempt to delete the GGUF file from disk
      this.deleteFile(gguf_path);

      // Remove from database
      this.db.prepare(`DELETE FROM training_models WHERE id = ?`).run(id);
    }
  }

  // ─── Delete Version ───────────────────────────────────────────

  /**
   * Delete a specific model version. Cannot delete the active version.
   *
   * @param versionId - The version to delete
   * @returns true if deleted, false if not found or is the active version
   */
  deleteVersion(versionId: string): boolean {
    const version = this.getVersion(versionId);
    if (!version) return false;
    if (version.isActive) return false;

    // Delete the GGUF file
    this.deleteFile(version.ggufPath);

    // Remove from DB
    this.db.prepare(`DELETE FROM training_models WHERE id = ?`).run(versionId);

    return true;
  }

  // ─── Private: Ollama Registration ─────────────────────────────

  /**
   * Re-register a GGUF file with Ollama for the rollback operation.
   * Uses the same pattern as GGUFExporter.registerWithOllama().
   *
   * Requirements: 41.2
   */
  private async registerWithOllama(ggufPath: string, modelName: string): Promise<void> {
    // Check Ollama availability
    const isAvailable = await this.checkOllamaAvailability();
    if (!isAvailable) {
      throw new Error('Ollama is not running or not reachable');
    }

    // Use Ollama HTTP API to create/re-register the model
    const response = await fetch(`${this.ollamaEndpoint}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: modelName,
        modelfile: `FROM ${ggufPath}`,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama API returned HTTP ${response.status}: ${body}`);
    }

    // Consume the response stream
    await response.text();
  }

  /**
   * Check if Ollama is available by hitting its version endpoint.
   */
  private async checkOllamaAvailability(): Promise<boolean> {
    try {
      const result = await this.safeExec(
        'curl',
        ['--silent', '--fail', '--max-time', '5', `${this.ollamaEndpoint}/api/version`],
        { timeout: 10_000 },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // ─── Private: Provider Registry ───────────────────────────────

  /**
   * Update the Provider_Registry with the rolled-back model.
   * Unregisters any previously registered fine-tuned provider for this model
   * and registers the new one.
   *
   * Requirements: 41.2
   */
  private registerWithProviderRegistry(modelName: string): void {
    const providerId = `${FINETUNED_PROVIDER_PREFIX}-${modelName}`;

    // Unregister existing provider for this model (if any)
    try {
      this.providerRegistry.unregister(providerId);
    } catch {
      // Ignore if not registered
    }

    // Re-register with the standard adapter pattern
    this.providerRegistry.register(
      {
        id: providerId,
        name: `Fine-tuned: ${modelName}`,
        chatCompletion: async (messages, options) => {
          const response = await fetch(`${this.ollamaEndpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: modelName,
              messages,
              temperature: options?.temperature,
              max_tokens: options?.maxTokens,
              stop: options?.stopSequences,
            }),
          });

          if (!response.ok) {
            throw new Error(`Ollama inference failed: HTTP ${response.status}`);
          }

          const json = await response.json() as {
            choices: Array<{ message: { content: string }; finish_reason: string }>;
            usage: { prompt_tokens: number; completion_tokens: number };
          };

          const choice = json.choices[0];
          return {
            content: choice?.message?.content ?? '',
            tokensUsed: {
              prompt: json.usage?.prompt_tokens ?? 0,
              completion: json.usage?.completion_tokens ?? 0,
            },
            finishReason: (choice?.finish_reason as 'stop' | 'length' | 'tool_call') ?? 'stop',
          };
        },
        streamCompletion: async function* () {
          yield { content: '', done: true };
        },
        countTokens: (text: string) => Math.ceil(text.length / 4),
        isAvailable: async () => this.checkOllamaAvailability(),
      },
      45,
    );
  }

  // ─── Private: EventLog ────────────────────────────────────────

  /**
   * Emit a rollback event to the EventLog.
   */
  private emitRollbackEvent(targetVersion: ModelVersion): void {
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.EXPORT,
        kind: TRAINING_EVENT_KINDS.EXPORT_COMPLETE as EventKind,
        payload: {
          jobId: targetVersion.jobId,
          ggufPath: targetVersion.ggufPath,
          sizeBytes: targetVersion.sizeBytes,
          ollamaRegistered: true,
          rollback: true,
          rolledBackToVersion: targetVersion.id,
        },
      });
    } catch {
      // Best-effort event emission
    }
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /** Convert a SQLite row to a ModelVersion object */
  private rowToModelVersion(row: ModelRow): ModelVersion {
    let validationMetrics: ValidationMetrics | null = null;
    if (row.validation_metrics_json) {
      try {
        validationMetrics = JSON.parse(row.validation_metrics_json) as ValidationMetrics;
      } catch {
        validationMetrics = null;
      }
    }

    return {
      id: row.id,
      projectId: row.project_id,
      jobId: row.job_id,
      modelName: row.model_name,
      baseModel: row.base_model,
      ggufPath: row.gguf_path,
      quantization: row.quantization,
      sizeBytes: row.size_bytes,
      validationPassed: row.validation_passed == null ? null : row.validation_passed === 1,
      validationMetrics,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    };
  }

  /** Check if a file exists on disk */
  private fileExists(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Attempt to delete a file. Non-fatal on failure. */
  private deleteFile(filePath: string): void {
    if (!filePath) return;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Non-fatal: file cleanup is best-effort
    }
  }
}

// ─── Internal Row Type ──────────────────────────────────────────

/** SQLite row shape for the training_models table */
interface ModelRow {
  id: string;
  project_id: string;
  job_id: string;
  model_name: string;
  base_model: string;
  gguf_path: string;
  quantization: string;
  size_bytes: number;
  validation_passed: number | null;
  validation_metrics_json: string | null;
  is_active: number;
  created_at: number;
}
