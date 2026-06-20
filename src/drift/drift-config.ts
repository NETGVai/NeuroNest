/**
 * Drift Configuration Types, Validation, and Sensitivity Presets
 *
 * Provides type definitions for drift management configuration and
 * functions to resolve sensitivity presets into numeric parameters
 * and validate configuration at construction time.
 */

import { FeatureError } from '../shared/feature-integration-errors.js';

// ─── Types ──────────────────────────────────────────────────────

export type DriftSensitivity = 'aggressive' | 'balanced' | 'permissive';
export type ScopeViolationMode = 'warn' | 'block';

export interface ConfidenceThresholds {
  warning: number;
  critical: number;
}

export interface DriftConfig {
  enabled: boolean;
  sensitivity?: DriftSensitivity;
  scopeViolationMode?: ScopeViolationMode;
  driftPauseOnCritical?: boolean;
  staleAfterOverrideMs?: number;
  confidenceThresholds?: ConfidenceThresholds;
}

export interface ResolvedDriftParams {
  warningThreshold: number;
  criticalThreshold: number;
  toolMismatchPenalty: number;
  failurePenalty: number;
  scopeViolationMode: ScopeViolationMode;
  driftPauseOnCritical: boolean;
}

// ─── Sensitivity Preset Lookup Table ────────────────────────────

export const SENSITIVITY_PRESETS: Record<DriftSensitivity, Omit<ResolvedDriftParams, 'scopeViolationMode' | 'driftPauseOnCritical'>> = {
  aggressive: {
    warningThreshold: 0.8,
    criticalThreshold: 0.5,
    toolMismatchPenalty: 0.15,
    failurePenalty: 0.2,
  },
  balanced: {
    warningThreshold: 0.7,
    criticalThreshold: 0.4,
    toolMismatchPenalty: 0.1,
    failurePenalty: 0.15,
  },
  permissive: {
    warningThreshold: 0.5,
    criticalThreshold: 0.25,
    toolMismatchPenalty: 0.05,
    failurePenalty: 0.1,
  },
};

const VALID_SENSITIVITIES: readonly string[] = ['aggressive', 'balanced', 'permissive'];
const VALID_SCOPE_VIOLATION_MODES: readonly string[] = ['warn', 'block'];

// ─── Resolution ─────────────────────────────────────────────────

/**
 * Resolves a DriftConfig into numeric parameters for the drift monitor.
 * Uses sensitivity presets as defaults, with explicit confidenceThresholds
 * overriding the preset's threshold values.
 *
 * Defaults to "balanced" sensitivity when none is specified.
 */
export function resolveDriftParams(config: DriftConfig): ResolvedDriftParams {
  const sensitivity = config.sensitivity ?? 'balanced';
  const preset = SENSITIVITY_PRESETS[sensitivity];

  const warningThreshold = config.confidenceThresholds?.warning ?? preset.warningThreshold;
  const criticalThreshold = config.confidenceThresholds?.critical ?? preset.criticalThreshold;

  return {
    warningThreshold,
    criticalThreshold,
    toolMismatchPenalty: preset.toolMismatchPenalty,
    failurePenalty: preset.failurePenalty,
    scopeViolationMode: config.scopeViolationMode ?? 'warn',
    driftPauseOnCritical: config.driftPauseOnCritical ?? false,
  };
}

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validates a DriftConfig, throwing FeatureError with category "infrastructure"
 * and code "INVALID_DRIFT_CONFIG" if any field has an invalid value.
 *
 * Validation rules:
 * - Thresholds must not be negative
 * - Warning threshold must be greater than critical threshold
 * - Sensitivity must be one of the valid preset values
 * - scopeViolationMode must be "warn" or "block"
 * - staleAfterOverrideMs must be a positive number when provided
 */
export function validateDriftConfig(config: DriftConfig): void {
  // Validate sensitivity
  if (config.sensitivity !== undefined && !VALID_SENSITIVITIES.includes(config.sensitivity)) {
    throw new FeatureError({
      message: `Invalid drift sensitivity: "${config.sensitivity}". Must be one of: ${VALID_SENSITIVITIES.join(', ')}`,
      category: 'infrastructure',
      code: 'INVALID_DRIFT_CONFIG',
      details: { field: 'sensitivity', value: config.sensitivity },
    });
  }

  // Validate scopeViolationMode
  if (config.scopeViolationMode !== undefined && !VALID_SCOPE_VIOLATION_MODES.includes(config.scopeViolationMode)) {
    throw new FeatureError({
      message: `Invalid scope violation mode: "${config.scopeViolationMode}". Must be "warn" or "block"`,
      category: 'infrastructure',
      code: 'INVALID_DRIFT_CONFIG',
      details: { field: 'scopeViolationMode', value: config.scopeViolationMode },
    });
  }

  // Validate staleAfterOverrideMs
  if (config.staleAfterOverrideMs !== undefined) {
    if (typeof config.staleAfterOverrideMs !== 'number' || config.staleAfterOverrideMs <= 0 || !Number.isFinite(config.staleAfterOverrideMs)) {
      throw new FeatureError({
        message: `Invalid staleAfterOverrideMs: must be a positive finite number, got ${config.staleAfterOverrideMs}`,
        category: 'infrastructure',
        code: 'INVALID_DRIFT_CONFIG',
        details: { field: 'staleAfterOverrideMs', value: config.staleAfterOverrideMs },
      });
    }
  }

  // Validate confidenceThresholds
  if (config.confidenceThresholds !== undefined) {
    const { warning, critical } = config.confidenceThresholds;

    if (typeof warning !== 'number' || !Number.isFinite(warning)) {
      throw new FeatureError({
        message: `Invalid confidence warning threshold: must be a finite number, got ${warning}`,
        category: 'infrastructure',
        code: 'INVALID_DRIFT_CONFIG',
        details: { field: 'confidenceThresholds.warning', value: warning },
      });
    }

    if (typeof critical !== 'number' || !Number.isFinite(critical)) {
      throw new FeatureError({
        message: `Invalid confidence critical threshold: must be a finite number, got ${critical}`,
        category: 'infrastructure',
        code: 'INVALID_DRIFT_CONFIG',
        details: { field: 'confidenceThresholds.critical', value: critical },
      });
    }

    if (warning < 0) {
      throw new FeatureError({
        message: `Confidence warning threshold must not be negative, got ${warning}`,
        category: 'infrastructure',
        code: 'INVALID_DRIFT_CONFIG',
        details: { field: 'confidenceThresholds.warning', value: warning },
      });
    }

    if (critical < 0) {
      throw new FeatureError({
        message: `Confidence critical threshold must not be negative, got ${critical}`,
        category: 'infrastructure',
        code: 'INVALID_DRIFT_CONFIG',
        details: { field: 'confidenceThresholds.critical', value: critical },
      });
    }

    if (warning <= critical) {
      throw new FeatureError({
        message: `Confidence warning threshold (${warning}) must be greater than critical threshold (${critical})`,
        category: 'infrastructure',
        code: 'INVALID_DRIFT_CONFIG',
        details: { field: 'confidenceThresholds', warning, critical },
      });
    }
  }
}
