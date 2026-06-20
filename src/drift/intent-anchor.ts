/**
 * Intent Anchor — Captures the user's original intent as an immutable
 * structured reference point for drift detection.
 *
 * The IntentAnchor is created at agent loop start and frozen via
 * Object.freeze to ensure immutability for the lifetime of the execution.
 * The anchor includes the classified task purpose, user message, predicted
 * scope of tools/files, and a staleAfter timestamp derived from task type.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type { TaskType } from '../benchmark/auto-tuner.js';
import type { TaskClassification } from '../shared/feature-integration-types.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface PredictedScope {
  readonly toolNames: readonly string[];
  readonly filePathPatterns: readonly string[];
}

export interface IntentAnchor {
  readonly purpose: TaskType;
  readonly statement: string;
  readonly predictedScope: PredictedScope;
  readonly confidence: 1.0;
  readonly staleAfter: number; // absolute timestamp (ms since epoch)
  readonly createdAt: number;  // ms since epoch
}

// ─── Stale-After Duration Mapping ───────────────────────────────

/**
 * Maps task type to the number of seconds after which the intent is considered stale.
 */
export const STALE_AFTER_SECONDS: Readonly<Record<TaskType, number>> = {
  'code-generation': 120,
  'refactoring': 90,
  'analysis': 60,
  'debugging': 150,
  'creative': 180,
};

/**
 * Maps task type to the expected number of iterations for that task type.
 */
export const EXPECTED_ITERATIONS: Readonly<Record<TaskType, number>> = {
  'code-generation': 10,
  'refactoring': 8,
  'analysis': 5,
  'debugging': 12,
  'creative': 15,
};

// ─── Anchor Creation ────────────────────────────────────────────

/**
 * Creates an immutable IntentAnchor from a task classification and message.
 *
 * When the classification confidence is below 0.5, the predicted scope
 * includes all registered tools (permissive mode) to avoid false-positive
 * scope violations on uncertain classifications.
 *
 * The returned anchor is deeply frozen via Object.freeze.
 */
export function createIntentAnchor(params: {
  classification: TaskClassification;
  message: string;
  registeredTools: readonly string[];
  staleAfterMs: number;
}): Readonly<IntentAnchor> {
  const { classification, message, registeredTools, staleAfterMs } = params;
  const now = Date.now();

  // Low-confidence classification: include all registered tools in scope
  const toolNames: readonly string[] =
    classification.confidence < 0.5
      ? [...registeredTools]
      : [];

  const predictedScope: PredictedScope = Object.freeze({
    toolNames: Object.freeze(toolNames),
    filePathPatterns: Object.freeze([] as string[]),
  });

  const anchor: IntentAnchor = {
    purpose: classification.type,
    statement: message,
    predictedScope,
    confidence: 1.0 as 1.0,
    staleAfter: now + staleAfterMs,
    createdAt: now,
  };

  return Object.freeze(anchor);
}
