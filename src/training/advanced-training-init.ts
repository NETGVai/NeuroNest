/**
 * Advanced Training Initialization
 *
 * Validates feature gate prerequisites for NEURONEST_ADVANCED_TRAINING (Phase 4)
 * at startup. If the prerequisite (NEURONEST_TRAINING_PIPELINE / Phase 3) is not
 * enabled, advanced training is disabled at runtime with a structured warning.
 *
 * Requirements: 25.1, 25.4
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AdvancedTrainingCapabilities {
  /** Whether advanced training features are available */
  enabled: boolean;
  /** Reason the subsystem is disabled, if applicable */
  disableReason?: string;
}

export interface AdvancedTrainingInitResult {
  capabilities: AdvancedTrainingCapabilities;
  warnings: string[];
}

// ─── Logger Interface ───────────────────────────────────────────

export interface AdvancedTrainingLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

// ─── Initialization Logic ───────────────────────────────────────

/**
 * Validate the NEURONEST_ADVANCED_TRAINING feature gate prerequisites and
 * determine whether advanced training features (GRPO, custom embeddings,
 * continued pretraining, vision fine-tuning) are available.
 *
 * This function should be called during application startup/initialization.
 *
 * Behavior:
 * - If NEURONEST_ADVANCED_TRAINING is disabled: returns disabled capabilities (no-op)
 * - If NEURONEST_ADVANCED_TRAINING is enabled but NEURONEST_TRAINING_PIPELINE is not:
 *   disables advanced training at runtime with a structured warning
 * - If both are enabled: full advanced training capabilities available
 *
 * @param featureGate - The feature gate system instance
 * @param logger - Logger for structured warnings
 * @returns Initialization result with capabilities and any warnings
 */
export function initAdvancedTraining(
  featureGate: FeatureGateSystem,
  logger: AdvancedTrainingLogger,
): AdvancedTrainingInitResult {
  const warnings: string[] = [];

  // Check if the advanced training flag is enabled
  if (!featureGate.isEnabled('neuronest_advanced_training')) {
    return {
      capabilities: {
        enabled: false,
        disableReason: 'NEURONEST_ADVANCED_TRAINING feature flag is disabled',
      },
      warnings: [],
    };
  }

  // Validate prerequisite: Phase 3 (Training Pipeline) must be enabled
  if (!featureGate.isEnabled('neuronest_training_pipeline')) {
    const reason =
      'NEURONEST_ADVANCED_TRAINING requires NEURONEST_TRAINING_PIPELINE to be enabled. ' +
      'Disabling advanced training features.';

    logger.warn(reason, {
      feature: 'neuronest_advanced_training',
      missingPrerequisite: 'neuronest_training_pipeline',
      action: 'disabled',
    });

    // Disable at runtime since the prerequisite is not met
    featureGate.disableAtRuntime('neuronest_advanced_training', reason);

    warnings.push(reason);

    return {
      capabilities: {
        enabled: false,
        disableReason: reason,
      },
      warnings,
    };
  }

  // All prerequisites met — advanced training is available
  logger.info('Advanced training initialized with full capabilities', {
    feature: 'neuronest_advanced_training',
    trainingPipelineEnabled: true,
  });

  return {
    capabilities: {
      enabled: true,
    },
    warnings: [],
  };
}
