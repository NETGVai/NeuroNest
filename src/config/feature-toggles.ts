/**
 * Feature Toggle Manager for Runtime Sandbox Guardrails
 * 
 * Provides unified configuration for enabling/disabling guardrail features
 * independently. Supports auto-disable on error with EventBus event emission,
 * runtime toggle changes without restart, and graceful degradation.
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import { EventBus } from '../events/event-bus.js';
import { logger } from '../utils/logger.js';

/**
 * All guardrail features that can be independently toggled.
 */
export type GuardrailFeature =
  | 'sandbox-isolation'
  | 'command-policy'
  | 'cost-tracking'
  | 'trace-recording'
  | 'prompt-rewind';

/**
 * Configuration interface for feature toggle defaults.
 */
export interface FeatureToggleConfig {
  'sandbox-isolation': boolean;
  'command-policy': boolean;
  'cost-tracking': boolean;
  'trace-recording': boolean;
  'prompt-rewind': boolean;
}

/**
 * Event emitted when a feature is auto-disabled due to an error.
 */
export interface FeatureDisabledEvent {
  feature: GuardrailFeature;
  reason: string;
  error: string;
  timestamp: number;
}

/**
 * All valid guardrail feature names.
 */
export const GUARDRAIL_FEATURES: GuardrailFeature[] = [
  'sandbox-isolation',
  'command-policy',
  'cost-tracking',
  'trace-recording',
  'prompt-rewind',
];

/**
 * Default feature toggle configuration.
 * cost-tracking and trace-recording are enabled by default for new installations.
 * All other features are disabled by default.
 */
export const DEFAULT_FEATURE_CONFIG: FeatureToggleConfig = {
  'sandbox-isolation': false,
  'command-policy': false,
  'cost-tracking': true,
  'trace-recording': true,
  'prompt-rewind': false,
};

/**
 * Options for creating a FeatureToggleManager instance.
 */
export interface FeatureToggleManagerOptions {
  eventBus?: EventBus;
  initialConfig?: Partial<Record<string, unknown>>;
}

/**
 * Manages feature toggles for guardrail subsystems.
 * 
 * Features can be enabled/disabled at runtime without restart.
 * If a feature encounters an error, it is auto-disabled and an event
 * is emitted on the EventBus. The feature remains disabled until
 * explicitly re-enabled by the user.
 */
export class FeatureToggleManager {
  private states: FeatureToggleConfig;
  private autoDisabled: Set<GuardrailFeature> = new Set();
  private eventBus?: EventBus;

  constructor(options: FeatureToggleManagerOptions = {}) {
    this.eventBus = options.eventBus;
    this.states = { ...DEFAULT_FEATURE_CONFIG };

    // Apply initial config if provided
    if (options.initialConfig) {
      this.applyConfig(options.initialConfig);
    }
  }

  /**
   * Check if a feature is currently enabled.
   * Returns false if the feature has been auto-disabled due to an error.
   */
  isEnabled(feature: GuardrailFeature): boolean {
    if (!this.isValidFeature(feature)) {
      logger.warn('Invalid feature name queried', { feature });
      return false;
    }

    if (this.autoDisabled.has(feature)) {
      return false;
    }

    return this.states[feature];
  }

  /**
   * Enable or disable a feature at runtime.
   * Changes take effect immediately (within 2 seconds for next operation).
   */
  setEnabled(feature: GuardrailFeature, enabled: boolean): void {
    if (!this.isValidFeature(feature)) {
      logger.warn('Attempted to set invalid feature', { feature, enabled });
      return;
    }

    this.states[feature] = enabled;

    // If explicitly enabling, clear auto-disabled state
    if (enabled) {
      this.autoDisabled.delete(feature);
    }

    logger.info('Feature toggle changed', { feature, enabled });
  }

  /**
   * Get the current state of all feature toggles.
   * Reflects auto-disabled states (auto-disabled features show as false).
   */
  getAllStates(): Record<GuardrailFeature, boolean> {
    const result = { ...this.states };

    // Override with auto-disabled states
    for (const feature of this.autoDisabled) {
      result[feature] = false;
    }

    return result;
  }

  /**
   * Report an error for a feature. This auto-disables the feature
   * for the remainder of the session and emits an event on the EventBus.
   * The feature remains disabled until explicitly re-enabled.
   */
  reportError(feature: GuardrailFeature, error: Error): void {
    if (!this.isValidFeature(feature)) {
      logger.warn('Error reported for invalid feature', { feature });
      return;
    }

    // Auto-disable the feature
    this.autoDisabled.add(feature);

    const reason = `Feature '${feature}' auto-disabled due to error: ${error.message}`;
    logger.error('Guardrail feature auto-disabled', {
      feature,
      error: error.message,
      stack: error.stack,
    });

    // Emit event on EventBus
    this.emitFeatureDisabledEvent(feature, reason, error.message);
  }

  /**
   * Re-enable a previously auto-disabled feature.
   * This clears the auto-disabled state and restores the feature
   * to its configured enabled state.
   */
  reEnable(feature: GuardrailFeature): void {
    if (!this.isValidFeature(feature)) {
      logger.warn('Attempted to re-enable invalid feature', { feature });
      return;
    }

    if (this.autoDisabled.has(feature)) {
      this.autoDisabled.delete(feature);
      logger.info('Feature re-enabled by user', { feature });
    }
  }

  /**
   * Check if a feature has been auto-disabled due to an error.
   */
  isAutoDisabled(feature: GuardrailFeature): boolean {
    return this.autoDisabled.has(feature);
  }

  /**
   * Apply a configuration object to the feature toggles.
   * Invalid values (non-boolean) are treated as disabled and logged.
   */
  private applyConfig(config: Partial<Record<string, unknown>>): void {
    for (const key of Object.keys(config)) {
      if (!this.isValidFeature(key as GuardrailFeature)) {
        logger.warn('Unrecognized feature toggle in config, treating as disabled', { key });
        continue;
      }

      const value = config[key];
      if (typeof value !== 'boolean') {
        logger.warn('Invalid non-boolean value for feature toggle, treating as disabled', {
          feature: key,
          value,
        });
        this.states[key as GuardrailFeature] = false;
      } else {
        this.states[key as GuardrailFeature] = value;
      }
    }
  }

  /**
   * Validate that a string is a valid GuardrailFeature name.
   */
  private isValidFeature(feature: string): feature is GuardrailFeature {
    return GUARDRAIL_FEATURES.includes(feature as GuardrailFeature);
  }

  /**
   * Emit a feature-disabled event on the EventBus.
   */
  private emitFeatureDisabledEvent(feature: GuardrailFeature, reason: string, errorMessage: string): void {
    if (!this.eventBus) {
      return;
    }

    const eventData: FeatureDisabledEvent = {
      feature,
      reason,
      error: errorMessage,
      timestamp: Date.now(),
    };

    // Fire and forget - don't let event emission failure affect the caller
    this.eventBus.publish('guardrail.feature.disabled', {
      type: 'feature_disabled',
      data: eventData,
    }).catch((err) => {
      logger.error('Failed to emit feature-disabled event', {
        feature,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
