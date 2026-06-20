/**
 * Confidence decay model — pure computation functions.
 *
 * All functions are stateless and side-effect-free, making them easy to
 * test with property-based and unit tests.
 */

export interface ConfidenceState {
  currentScore: number;
  timeDecayFactor: number;
  toolMismatchPenalty: number;
  failureRatePenalty: number;
  burnRatePenalty: number;
  consecutiveFailures: number;
  outOfScopeToolCalls: number;
}

export interface ConfidenceInputs {
  elapsedMs: number;
  staleAfterMs: number;
  currentIteration: number;
  expectedIterations: number;
  outOfScopeToolCalls: number;
  consecutiveFailures: number;
}

/**
 * Computes the time decay factor.
 * Returns max(0, 1 - (elapsedMs / (staleAfterMs * 2))).
 * Result is in [0.0, 1.0] for non-negative inputs with staleAfterMs > 0.
 */
export function computeTimeDecay(elapsedMs: number, staleAfterMs: number): number {
  return Math.max(0, 1 - elapsedMs / (staleAfterMs * 2));
}

/**
 * Computes the burn rate penalty.
 * Returns max(0, (currentIteration / expectedIterations) - 1.0) * 0.2.
 * Only applies a penalty when iterations exceed the expected count.
 */
export function computeBurnRate(currentIteration: number, expectedIterations: number): number {
  return Math.max(0, (currentIteration / expectedIterations) - 1.0) * 0.2;
}

/**
 * Composes all confidence factors into a clamped [0.0, 1.0] result.
 *
 * Formula:
 *   timeDecay = max(0, 1 - (elapsedMs / (staleAfterMs * 2)))
 *   burnRate = max(0, (currentIteration / expectedIterations) - 1.0) * 0.2
 *   toolPenalty = outOfScopeToolCalls * params.toolMismatchPenalty
 *   failurePenalty = consecutiveFailures * params.failurePenalty
 *   final = clamp(1.0 * timeDecay - toolPenalty - failurePenalty - burnRate, 0.0, 1.0)
 */
export function computeConfidence(
  inputs: ConfidenceInputs,
  params: { toolMismatchPenalty: number; failurePenalty: number }
): ConfidenceState {
  const timeDecayFactor = computeTimeDecay(inputs.elapsedMs, inputs.staleAfterMs);
  const burnRatePenalty = computeBurnRate(inputs.currentIteration, inputs.expectedIterations);
  const toolMismatchPenalty = inputs.outOfScopeToolCalls * params.toolMismatchPenalty;
  const failureRatePenalty = inputs.consecutiveFailures * params.failurePenalty;

  const raw = 1.0 * timeDecayFactor - toolMismatchPenalty - failureRatePenalty - burnRatePenalty;
  const currentScore = Math.min(1.0, Math.max(0.0, raw));

  return {
    currentScore,
    timeDecayFactor,
    toolMismatchPenalty,
    failureRatePenalty,
    burnRatePenalty,
    consecutiveFailures: inputs.consecutiveFailures,
    outOfScopeToolCalls: inputs.outOfScopeToolCalls,
  };
}
