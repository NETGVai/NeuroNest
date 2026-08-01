/**
 * Training Pipeline Initialization
 *
 * Validates feature gate prerequisites for the NEURONEST_TRAINING_PIPELINE (Phase 3)
 * at startup. If the prerequisite (NEURONEST_UNSLOTH_BRIDGE) is not enabled, the
 * training pipeline is disabled at runtime with a structured warning.
 *
 * Supports "manual dataset mode": when NEURONEST_KB_SYSTEM (Phase 1) is disabled,
 * the training pipeline can still operate with user-provided datasets (JSONL, JSON, CSV)
 * but automatic dataset generation from the knowledgebase is unavailable.
 *
 * Requirements: 25.1, 25.4, 25.5
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface TrainingPipelineCapabilities {
  /** Whether the training pipeline is available */
  enabled: boolean;
  /** Whether automatic dataset generation from KB is available */
  autoDatasetGeneration: boolean;
  /** Whether manual dataset mode is active (user-provided JSONL/CSV/JSON) */
  manualDatasetMode: boolean;
  /** Reason the pipeline is disabled, if applicable */
  disableReason?: string;
}

export interface TrainingPipelineInitResult {
  capabilities: TrainingPipelineCapabilities;
  warnings: string[];
}

// ─── Logger Interface ───────────────────────────────────────────

export interface TrainingPipelineLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

// ─── Initialization Logic ───────────────────────────────────────

/**
 * Validate the NEURONEST_TRAINING_PIPELINE feature gate prerequisites and
 * determine the available capabilities for the training pipeline.
 *
 * This function should be called during application startup/initialization.
 *
 * Behavior:
 * - If NEURONEST_TRAINING_PIPELINE is disabled: returns disabled capabilities (no-op)
 * - If NEURONEST_TRAINING_PIPELINE is enabled but NEURONEST_UNSLOTH_BRIDGE is not:
 *   disables the pipeline at runtime with a structured warning
 * - If NEURONEST_TRAINING_PIPELINE is enabled and NEURONEST_UNSLOTH_BRIDGE is enabled:
 *   - If NEURONEST_KB_SYSTEM is also enabled: full capabilities (auto-dataset + manual)
 *   - If NEURONEST_KB_SYSTEM is disabled: manual dataset mode only
 *
 * @param featureGate - The feature gate system instance
 * @param logger - Logger for structured warnings
 * @returns Initialization result with capabilities and any warnings
 */
export function initTrainingPipeline(
  featureGate: FeatureGateSystem,
  logger: TrainingPipelineLogger,
): TrainingPipelineInitResult {
  const warnings: string[] = [];

  // Check if the training pipeline flag is enabled
  if (!featureGate.isEnabled('neuronest_training_pipeline')) {
    return {
      capabilities: {
        enabled: false,
        autoDatasetGeneration: false,
        manualDatasetMode: false,
        disableReason: 'NEURONEST_TRAINING_PIPELINE feature flag is disabled',
      },
      warnings: [],
    };
  }

  // Validate prerequisite: Phase 2 (Unsloth Bridge) must be enabled
  if (!featureGate.isEnabled('neuronest_unsloth_bridge')) {
    const reason =
      'NEURONEST_TRAINING_PIPELINE requires NEURONEST_UNSLOTH_BRIDGE to be enabled. ' +
      'Disabling training pipeline.';

    logger.warn(reason, {
      feature: 'neuronest_training_pipeline',
      missingPrerequisite: 'neuronest_unsloth_bridge',
      action: 'disabled',
    });

    // Disable at runtime since the prerequisite is not met
    featureGate.disableAtRuntime('neuronest_training_pipeline', reason);

    warnings.push(reason);

    return {
      capabilities: {
        enabled: false,
        autoDatasetGeneration: false,
        manualDatasetMode: false,
        disableReason: reason,
      },
      warnings,
    };
  }

  // Phase 2 is enabled — check Phase 1 for dataset generation mode
  const kbSystemEnabled = featureGate.isEnabled('neuronest_kb_system');

  if (!kbSystemEnabled) {
    const manualModeWarning =
      'NEURONEST_KB_SYSTEM is disabled. Training pipeline operating in manual dataset mode: ' +
      'automatic dataset generation from knowledgebase is unavailable. ' +
      'You can still train models using manually-provided datasets (JSONL, JSON, CSV).';

    logger.info(manualModeWarning, {
      feature: 'neuronest_training_pipeline',
      mode: 'manual-dataset',
      kbSystemEnabled: false,
    });

    warnings.push(manualModeWarning);

    return {
      capabilities: {
        enabled: true,
        autoDatasetGeneration: false,
        manualDatasetMode: true,
      },
      warnings,
    };
  }

  // Full capabilities: both Phase 1 and Phase 2 are enabled
  logger.info('Training pipeline initialized with full capabilities', {
    feature: 'neuronest_training_pipeline',
    mode: 'full',
    kbSystemEnabled: true,
    unslothBridgeEnabled: true,
  });

  return {
    capabilities: {
      enabled: true,
      autoDatasetGeneration: true,
      manualDatasetMode: true,
    },
    warnings: [],
  };
}
