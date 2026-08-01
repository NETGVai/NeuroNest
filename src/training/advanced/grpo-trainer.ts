/**
 * GRPO Trainer — Group Relative Policy Optimization from user preference feedback.
 *
 * Collects prompt-response pairs with preference signals (thumbs-up/down),
 * manages a rolling window of preference data, generates alternative responses
 * for incomplete preference pairs, and notifies the user when sufficient data
 * has accumulated for a GRPO training run.
 *
 * Also provides `startGRPOTraining()` to generate a preference-pair dataset
 * from accumulated feedback and invoke the Training_Orchestrator with
 * GRPO-specific configuration.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

import type Database from 'better-sqlite3';
import type { IProviderRegistry, ChatMessage } from '../../providers/provider-registry.js';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type {
  TrainingOrchestrator,
  TrainingJobConfig,
  HyperparameterConfig,
  HardwareProfile,
} from '../orchestrator/training-orchestrator.js';
import type {
  DatasetGenerator,
  DatasetGenerationConfig,
  GeneratedDataset,
} from '../dataset/dataset-generator.js';
import { TRAINING_SOURCE_IDENTIFIERS } from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/** Source of a preference pair */
export type PreferenceSource = 'user-feedback' | 'comparison-panel' | 'auto-generated';

/** A single GRPO preference pair stored in the database */
export interface PreferencePair {
  id: string;
  projectId: string;
  prompt: string;
  chosenResponse: string;
  rejectedResponse: string;
  source: PreferenceSource;
  createdAt: number;
}

/** Configuration for the GRPO Trainer */
export interface GRPOTrainerConfig {
  /** Maximum number of preference pairs to retain (rolling window). Default: 1000 */
  maxPairs: number;
  /** Minimum pairs required before notifying user of training availability. Default: 50 */
  notificationThreshold: number;
  /** Project ID scope */
  projectId: string;
}

/** Configuration for starting a GRPO training run */
export interface GRPOTrainingConfig {
  /** Base model to fine-tune (e.g., 'llama-3.1-8b') */
  baseModel: string;
  /** Output directory for training artifacts */
  outputDir: string;
  /** Checkpoint directory for saving training state */
  checkpointDir: string;
  /** Path to the GRPO training script */
  scriptPath: string;
  /** Hardware profile for the training run */
  hardware: HardwareProfile;
  /** Learning rate for GRPO (default: 1e-5, lower than standard fine-tuning) */
  learningRate?: number;
  /** Number of training epochs (default: 3) */
  epochs?: number;
  /** Batch size (default: 2) */
  batchSize?: number;
  /** Warmup steps (default: 20) */
  warmupSteps?: number;
  /** Weight decay (default: 0.01) */
  weightDecay?: number;
  /** Gradient accumulation steps (default: 4) */
  gradientAccumulationSteps?: number;
  /** Checkpoint interval in epochs (default: 1) */
  checkpointIntervalEpochs?: number;
  /** Maximum number of preference pairs to include in the dataset (optional) */
  maxPairs?: number;
}

/** Result of a GRPO training run */
export interface GRPOTrainingResult {
  /** Training job ID from the orchestrator */
  jobId: string;
  /** Generated dataset metadata */
  dataset: GeneratedDataset;
  /** Number of preference pairs used in training */
  pairsUsed: number;
  /** The hyperparameters used for training */
  hyperparameters: HyperparameterConfig;
}

/** Result of storing a preference pair */
export interface StorePreferenceResult {
  stored: boolean;
  id: string;
  /** Number of preference pairs currently stored for this project */
  totalPairs: number;
  /** Whether the notification threshold has been reached */
  thresholdReached: boolean;
  /** Number of pairs evicted due to rolling window */
  evicted: number;
}

/** Callback invoked when the preference threshold is reached */
export type ThresholdNotifier = (projectId: string, pairCount: number) => void;

/** User feedback input (from thumbs-up/down in the UI) */
export interface UserFeedback {
  /** The original prompt sent to the model */
  prompt: string;
  /** The response that received user feedback */
  response: string;
  /** Whether the user approved (thumbs-up) or rejected (thumbs-down) */
  approved: boolean;
  /** Optional chosen response for thumbs-down (if user provided a preferred alternative) */
  preferredResponse?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_PAIRS = 1000;
const DEFAULT_NOTIFICATION_THRESHOLD = 50;

/** Event kind for GRPO-related notifications */
const GRPO_THRESHOLD_EVENT = 'training.grpo.threshold-reached' as EventKind;
const GRPO_TRAINING_START_EVENT = 'training.grpo.training-started' as EventKind;

/**
 * GRPO-specific hyperparameter defaults.
 * GRPO uses lower learning rate than standard fine-tuning to prevent
 * catastrophic forgetting while optimizing for user preferences.
 */
const GRPO_DEFAULT_HYPERPARAMETERS: HyperparameterConfig = {
  learningRate: 1e-5,
  batchSize: 2,
  epochs: 3,
  warmupSteps: 20,
  weightDecay: 0.01,
  gradientAccumulationSteps: 4,
};

/** Default checkpoint interval for GRPO training */
const DEFAULT_GRPO_CHECKPOINT_INTERVAL = 1;

// ─── GRPOTrainer ────────────────────────────────────────────────

/**
 * Manages GRPO preference data collection from user feedback.
 *
 * Responsibilities:
 *   - Store preference pairs from thumbs-up/down feedback
 *   - Maintain a rolling window (default 1000 pairs, evict oldest)
 *   - Generate alternative responses for thumbs-down without a chosen response
 *   - Notify the user when sufficient pairs accumulate (default 50)
 */
export class GRPOTrainer {
  private readonly config: GRPOTrainerConfig;
  private thresholdNotifier: ThresholdNotifier | null = null;
  private thresholdNotified = false;

  constructor(
    private readonly db: Database.Database,
    private readonly providerRegistry: IProviderRegistry,
    private readonly eventLog: EventLog | null,
    config: Partial<GRPOTrainerConfig> & { projectId: string },
    private readonly orchestrator?: TrainingOrchestrator,
    private readonly datasetGenerator?: DatasetGenerator,
  ) {
    this.config = {
      maxPairs: config.maxPairs ?? DEFAULT_MAX_PAIRS,
      notificationThreshold: config.notificationThreshold ?? DEFAULT_NOTIFICATION_THRESHOLD,
      projectId: config.projectId,
    };
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Register a callback to be notified when the preference threshold is reached.
   * The callback receives the projectId and current pair count.
   */
  onThresholdReached(notifier: ThresholdNotifier): void {
    this.thresholdNotifier = notifier;
  }

  /**
   * Process user feedback on a model response.
   *
   * For thumbs-up: stores the response as "chosen" with no rejected response needed
   *   (pair is stored with the prompt and chosen response; a future thumbs-down on
   *   the same prompt or a generated alternative serves as the rejected side).
   *
   * For thumbs-down without a preferred alternative: generates an alternative response
   *   using the Provider Registry, forming a complete preference pair where the
   *   alternative is "chosen" and the thumbs-down response is "rejected".
   *
   * For thumbs-down with a preferred alternative provided by the user: stores the
   *   preferred alternative as "chosen" and the original response as "rejected".
   *
   * Requirements: 14.1, 14.5
   */
  async collectFeedback(feedback: UserFeedback): Promise<StorePreferenceResult> {
    const { prompt, response, approved, preferredResponse } = feedback;

    let chosenResponse: string;
    let rejectedResponse: string;
    let source: PreferenceSource;

    if (approved) {
      // Thumbs-up: the response is chosen. We generate an alternative as the rejected.
      chosenResponse = response;
      rejectedResponse = await this.generateAlternativeResponse(prompt);
      source = 'user-feedback';
    } else if (preferredResponse) {
      // Thumbs-down with user-provided preferred response
      chosenResponse = preferredResponse;
      rejectedResponse = response;
      source = 'user-feedback';
    } else {
      // Thumbs-down without preferred response — generate alternative
      // Requirement 14.5: Generate alternative response for thumbs-down without chosen
      chosenResponse = await this.generateAlternativeResponse(prompt);
      rejectedResponse = response;
      source = 'user-feedback';
    }

    return this.storePreferencePair({
      prompt,
      chosenResponse,
      rejectedResponse,
      source,
    });
  }

  /**
   * Store a preference pair directly (e.g. from the model comparison panel).
   * This is the low-level storage method used by both collectFeedback and
   * external sources (comparison panel, auto-generated pairs).
   *
   * Requirement 14.1
   */
  async storePreferencePair(pair: {
    prompt: string;
    chosenResponse: string;
    rejectedResponse: string;
    source: PreferenceSource;
  }): Promise<StorePreferenceResult> {
    const id = this.generateId();
    const createdAt = Date.now();
    const { prompt, chosenResponse, rejectedResponse, source } = pair;

    // Insert the new preference pair
    this.db.prepare(
      `INSERT INTO grpo_preferences (id, project_id, prompt, chosen_response, rejected_response, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, this.config.projectId, prompt, chosenResponse, rejectedResponse, source, createdAt);

    // Enforce rolling window — evict oldest pairs if over limit
    // Requirement 14.4
    const evicted = this.enforceRollingWindow();

    // Get current count
    const totalPairs = this.getPairCount();

    // Check threshold notification
    // Requirement 14.2
    const thresholdReached = totalPairs >= this.config.notificationThreshold;
    if (thresholdReached && !this.thresholdNotified) {
      this.thresholdNotified = true;
      this.notifyThresholdReached(totalPairs);
    }

    return {
      stored: true,
      id,
      totalPairs,
      thresholdReached,
      evicted,
    };
  }

  /**
   * Get the current number of preference pairs stored for this project.
   */
  getPairCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM grpo_preferences WHERE project_id = ?`,
    ).get(this.config.projectId) as { count: number };
    return row.count;
  }

  /**
   * Get all stored preference pairs for this project, ordered by creation time (newest first).
   */
  getPreferencePairs(limit?: number): PreferencePair[] {
    const query = limit
      ? `SELECT id, project_id, prompt, chosen_response, rejected_response, source, created_at
         FROM grpo_preferences WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, project_id, prompt, chosen_response, rejected_response, source, created_at
         FROM grpo_preferences WHERE project_id = ? ORDER BY created_at DESC`;

    const rows = limit
      ? this.db.prepare(query).all(this.config.projectId, limit) as PreferencePairRow[]
      : this.db.prepare(query).all(this.config.projectId) as PreferencePairRow[];

    return rows.map(this.rowToPreferencePair);
  }

  /**
   * Check whether enough preference data has accumulated for a GRPO training run.
   */
  isTrainingReady(): boolean {
    return this.getPairCount() >= this.config.notificationThreshold;
  }

  /**
   * Reset the threshold notification flag (e.g. after a training run consumes the data).
   */
  resetThresholdNotification(): void {
    this.thresholdNotified = false;
  }

  /**
   * Get the GRPO trainer configuration.
   */
  getConfig(): Readonly<GRPOTrainerConfig> {
    return { ...this.config };
  }

  /**
   * Start a GRPO training run using accumulated preference-pair data.
   *
   * Steps:
   * 1. Verify minimum pairs threshold is met
   * 2. Retrieve all preference pairs from the database
   * 3. Generate a GRPO-format dataset via the DatasetGenerator
   * 4. Invoke the Training_Orchestrator with GRPO-specific configuration
   * 5. Reset the threshold notification so future accumulation is tracked
   *
   * Requirements: 14.3
   *
   * @throws GRPOTrainingError if insufficient pairs or missing dependencies
   */
  async startGRPOTraining(config: GRPOTrainingConfig): Promise<GRPOTrainingResult> {
    // Validate that orchestrator and datasetGenerator are available
    if (!this.orchestrator) {
      throw new GRPOTrainingError(
        'Training Orchestrator is required for GRPO training. ' +
        'Ensure the Training Orchestrator is configured before starting GRPO training.',
      );
    }

    if (!this.datasetGenerator) {
      throw new GRPOTrainingError(
        'Dataset Generator is required for GRPO training. ' +
        'Ensure the Dataset Generator is configured before starting GRPO training.',
      );
    }

    // Step 1: Verify minimum pairs threshold
    const pairCount = this.getPairCount();
    if (pairCount < this.config.notificationThreshold) {
      throw new GRPOTrainingError(
        `Insufficient preference pairs for GRPO training. ` +
        `Have ${pairCount}, need at least ${this.config.notificationThreshold}. ` +
        `Continue providing feedback to accumulate more preference data.`,
      );
    }

    // Step 2: Retrieve accumulated preference pairs
    const maxPairs = config.maxPairs ?? pairCount;
    const preferencePairs = this.getPreferencePairs(maxPairs);

    // Step 3: Generate GRPO dataset via DatasetGenerator
    const datasetOutputPath = `${config.outputDir}/grpo-dataset.jsonl`;

    // Build synthetic KBChunks from preference pairs for the DatasetGenerator
    // The DatasetGenerator's GRPO mode uses its preferenceStore; we need to provide
    // sourceChunks for provenance. We create minimal chunk representations from the pairs.
    const sourceChunks = preferencePairs.map((pair, index) => ({
      id: pair.id,
      sourceUri: `grpo://preference-pair/${pair.id}`,
      chunkIndex: index,
      content: pair.prompt,
      contentHash: pair.id, // Use the pair ID as a unique hash
      tokenCount: this.estimateTokenCount(pair.prompt),
      llmTokenCount: this.estimateTokenCount(pair.prompt),
      metadata: {},
    }));

    const datasetConfig: DatasetGenerationConfig = {
      format: 'grpo',
      sourceChunks,
      outputPath: datasetOutputPath,
      maxSamples: maxPairs,
      sessionId: TRAINING_SOURCE_IDENTIFIERS.TRAINING,
    };

    const dataset = await this.datasetGenerator.generate(datasetConfig);

    // Step 4: Build GRPO-specific hyperparameters and invoke Training Orchestrator
    const hyperparameters = this.buildGRPOHyperparameters(config);
    const jobId = this.generateTrainingJobId();

    const trainingJobConfig: TrainingJobConfig = {
      id: jobId,
      projectId: this.config.projectId,
      baseModel: config.baseModel,
      method: 'lora', // GRPO uses LoRA for efficient preference optimization
      datasetPath: datasetOutputPath,
      datasetFormat: 'grpo',
      hyperparameters,
      hardware: config.hardware,
      outputDir: config.outputDir,
      checkpointDir: config.checkpointDir,
      scriptPath: config.scriptPath,
      checkpointIntervalEpochs: config.checkpointIntervalEpochs ?? DEFAULT_GRPO_CHECKPOINT_INTERVAL,
      validationSplit: 0.1, // 10% holdout for GRPO validation
    };

    await this.orchestrator.startJob(trainingJobConfig);

    // Step 5: Reset threshold notification for future accumulation tracking
    this.resetThresholdNotification();

    // Emit GRPO training started event
    this.emitGRPOTrainingEvent(jobId, preferencePairs.length, hyperparameters);

    return {
      jobId,
      dataset,
      pairsUsed: preferencePairs.length,
      hyperparameters,
    };
  }

  // ─── Private Methods ────────────────────────────────────────

  /**
   * Enforce the rolling window by evicting oldest pairs when the count
   * exceeds the configured maximum.
   *
   * Requirement 14.4: Maintain rolling window (default 1000 pairs, evict oldest)
   */
  private enforceRollingWindow(): number {
    const count = this.getPairCount();
    if (count <= this.config.maxPairs) {
      return 0;
    }

    const excess = count - this.config.maxPairs;

    // Delete the oldest `excess` pairs for this project
    this.db.prepare(
      `DELETE FROM grpo_preferences
       WHERE id IN (
         SELECT id FROM grpo_preferences
         WHERE project_id = ?
         ORDER BY created_at ASC
         LIMIT ?
       )`,
    ).run(this.config.projectId, excess);

    return excess;
  }

  /**
   * Generate an alternative response using the Provider Registry.
   *
   * Requirement 14.5: Generate alternative response for thumbs-down without
   * chosen response. Uses the current best available model via Provider Registry.
   */
  private async generateAlternativeResponse(prompt: string): Promise<string> {
    try {
      const provider = this.providerRegistry.getProvider();
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful coding assistant. Provide a clear, accurate, and well-structured response.',
        },
        { role: 'user', content: prompt },
      ];

      const result = await provider.chatCompletion(messages, {
        temperature: 0.7,
        maxTokens: 2048,
      });

      return result.content;
    } catch (error) {
      // If generation fails, use a placeholder indicating generation failure.
      // This ensures we still store the preference pair with the rejected response.
      return `[Alternative generation failed: ${error instanceof Error ? error.message : 'unknown error'}]`;
    }
  }

  /**
   * Notify that the preference threshold has been reached.
   * Calls the registered notifier callback and emits an EventLog event.
   *
   * Requirement 14.2
   */
  private notifyThresholdReached(pairCount: number): void {
    // Call the registered notifier if present
    if (this.thresholdNotifier) {
      try {
        this.thresholdNotifier(this.config.projectId, pairCount);
      } catch {
        // Notifier errors are non-fatal
      }
    }

    // Emit event to EventLog
    if (this.eventLog) {
      try {
        void this.eventLog.emit({
          sessionId: TRAINING_SOURCE_IDENTIFIERS.TRAINING,
          kind: GRPO_THRESHOLD_EVENT,
          payload: {
            projectId: this.config.projectId,
            pairCount,
            threshold: this.config.notificationThreshold,
          },
        });
      } catch {
        // EventLog emission is best-effort
      }
    }
  }

  /**
   * Generate a unique identifier for a preference pair.
   * Uses a timestamp-based approach for ordering compatibility.
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `grpo-${timestamp}-${random}`;
  }

  /**
   * Generate a unique job ID for a GRPO training run.
   */
  private generateTrainingJobId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `grpo-train-${timestamp}-${random}`;
  }

  /**
   * Build GRPO-specific hyperparameters from user config and defaults.
   *
   * GRPO uses a lower learning rate than standard fine-tuning to
   * carefully optimize for user preferences without catastrophic forgetting.
   */
  private buildGRPOHyperparameters(config: GRPOTrainingConfig): HyperparameterConfig {
    return {
      learningRate: config.learningRate ?? GRPO_DEFAULT_HYPERPARAMETERS.learningRate,
      batchSize: config.batchSize ?? GRPO_DEFAULT_HYPERPARAMETERS.batchSize,
      epochs: config.epochs ?? GRPO_DEFAULT_HYPERPARAMETERS.epochs,
      warmupSteps: config.warmupSteps ?? GRPO_DEFAULT_HYPERPARAMETERS.warmupSteps,
      weightDecay: config.weightDecay ?? GRPO_DEFAULT_HYPERPARAMETERS.weightDecay,
      gradientAccumulationSteps:
        config.gradientAccumulationSteps ??
        GRPO_DEFAULT_HYPERPARAMETERS.gradientAccumulationSteps,
    };
  }

  /**
   * Estimate token count for a text string.
   * Uses a simple heuristic (chars/4) for consistency with the KB system.
   */
  private estimateTokenCount(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Emit a GRPO training started event to the EventLog.
   */
  private emitGRPOTrainingEvent(
    jobId: string,
    pairsUsed: number,
    hyperparameters: HyperparameterConfig,
  ): void {
    if (!this.eventLog) return;
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.TRAINING,
        kind: GRPO_TRAINING_START_EVENT,
        payload: {
          jobId,
          projectId: this.config.projectId,
          pairsUsed,
          threshold: this.config.notificationThreshold,
          learningRate: hyperparameters.learningRate,
          epochs: hyperparameters.epochs,
          batchSize: hyperparameters.batchSize,
        },
      });
    } catch {
      // EventLog emission is best-effort
    }
  }

  /**
   * Map a database row to a PreferencePair object.
   */
  private rowToPreferencePair(row: PreferencePairRow): PreferencePair {
    return {
      id: row.id,
      projectId: row.project_id,
      prompt: row.prompt,
      chosenResponse: row.chosen_response,
      rejectedResponse: row.rejected_response,
      source: row.source as PreferenceSource,
      createdAt: row.created_at,
    };
  }
}

// ─── Internal Row Type ──────────────────────────────────────────

/** SQLite row shape for grpo_preferences table */
interface PreferencePairRow {
  id: string;
  project_id: string;
  prompt: string;
  chosen_response: string;
  rejected_response: string;
  source: string;
  created_at: number;
}

// ─── Errors ─────────────────────────────────────────────────────

/**
 * Error thrown when GRPO training cannot proceed.
 */
export class GRPOTrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GRPOTrainingError';
  }
}
