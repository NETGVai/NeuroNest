/**
 * Drift signal types and factory.
 *
 * Defines the categorized signal types emitted by the DriftMonitor
 * when execution deviates from the IntentAnchor. Each signal carries
 * a unique identifier, category, severity, and contextual metadata.
 */

import { uuidv7 } from 'uuidv7';

// ─── Types ─────────────────────────────────────────────────────

export type DriftCategory =
  | 'scope_exceeded'
  | 'intent_divergence'
  | 'confidence_decay'
  | 'stale_intent'
  | 'tool_mismatch';

export type DriftSeverity = 'info' | 'warning' | 'critical';

export interface DriftSignal {
  readonly signalId: string;        // uuidv7
  readonly category: DriftCategory;
  readonly severity: DriftSeverity;
  readonly timestamp: string;        // ISO 8601
  readonly currentConfidence: number;
  readonly message: string;
  readonly iteration: number;
}

// ─── Validation helpers ────────────────────────────────────────

const VALID_CATEGORIES: readonly DriftCategory[] = [
  'scope_exceeded',
  'intent_divergence',
  'confidence_decay',
  'stale_intent',
  'tool_mismatch',
];

const VALID_SEVERITIES: readonly DriftSeverity[] = [
  'info',
  'warning',
  'critical',
];

// ─── Factory ───────────────────────────────────────────────────

/**
 * Creates a new DriftSignal with a unique signalId (uuidv7) and ISO timestamp.
 * Validates all input fields before construction.
 *
 * @throws {Error} if any field is invalid:
 *   - category must be one of the five defined DriftCategory values
 *   - severity must be one of the three defined DriftSeverity values
 *   - currentConfidence must be in [0, 1]
 *   - message must be a non-empty string
 *   - iteration must be >= 1
 */
export function createDriftSignal(params: {
  category: DriftCategory;
  severity: DriftSeverity;
  currentConfidence: number;
  message: string;
  iteration: number;
}): DriftSignal {
  // Validate category
  if (!VALID_CATEGORIES.includes(params.category)) {
    throw new Error(
      `Invalid drift signal category: "${params.category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }

  // Validate severity
  if (!VALID_SEVERITIES.includes(params.severity)) {
    throw new Error(
      `Invalid drift signal severity: "${params.severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`
    );
  }

  // Validate currentConfidence in [0, 1]
  if (
    typeof params.currentConfidence !== 'number' ||
    Number.isNaN(params.currentConfidence) ||
    params.currentConfidence < 0 ||
    params.currentConfidence > 1
  ) {
    throw new Error(
      `Invalid drift signal currentConfidence: ${params.currentConfidence}. Must be a number in [0, 1].`
    );
  }

  // Validate message is non-empty
  if (typeof params.message !== 'string' || params.message.trim().length === 0) {
    throw new Error('Invalid drift signal message: must be a non-empty string.');
  }

  // Validate iteration >= 1
  if (
    typeof params.iteration !== 'number' ||
    !Number.isInteger(params.iteration) ||
    params.iteration < 1
  ) {
    throw new Error(
      `Invalid drift signal iteration: ${params.iteration}. Must be an integer >= 1.`
    );
  }

  return {
    signalId: uuidv7(),
    category: params.category,
    severity: params.severity,
    timestamp: new Date().toISOString(),
    currentConfidence: params.currentConfidence,
    message: params.message,
    iteration: params.iteration,
  };
}
