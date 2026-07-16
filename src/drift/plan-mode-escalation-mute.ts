/**
 * Plan Mode Escalation Mute — mutes drift escalation while Plan Mode is active.
 *
 * During Plan Mode exploration, scope-envelope drift signals are still RECORDED
 * (they continue to be logged and stored), but escalation behavior (warning →
 * critical → pause) is muted. When Plan Mode exits, escalation resumes normally.
 *
 * This utility wraps around the DriftMonitor's evaluation to intercept
 * escalation actions while preserving signal recording.
 *
 * Requirements: 11.12
 */

import type { PlanModeState } from '../session/plan-mode-state.js';
import type { DriftEvaluationResult, DriftSignal } from './drift-monitor.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * Configuration for the escalation mute behavior.
 */
export interface EscalationMuteConfig {
  /** The session's PlanModeState instance to query active status */
  planModeState: PlanModeState;
}

/**
 * Result of processing a drift evaluation through the escalation mute layer.
 */
export interface MutedEvaluationResult {
  /** Original confidence value (unchanged) */
  confidence: number;
  /** All signals (still recorded regardless of mute state) */
  signals: DriftSignal[];
  /** Whether execution should pause — always false when muted */
  paused: boolean;
  /** Whether escalation is currently muted */
  escalationMuted: boolean;
}

// ─── PlanModeEscalationMute ─────────────────────────────────────

/**
 * PlanModeEscalationMute — intercepts drift evaluation results and mutes
 * escalation when Plan Mode is active.
 *
 * Signals are always recorded (returned in the result), but the `paused`
 * flag is forced to `false` when Plan Mode is active. This ensures that
 * the agent can continue exploring during planning without being interrupted
 * by drift-triggered pauses, while still maintaining a record of all
 * drift activity for review after Plan Mode exits.
 */
export class PlanModeEscalationMute {
  private readonly planModeState: PlanModeState;

  constructor(config: EscalationMuteConfig) {
    this.planModeState = config.planModeState;
  }

  /**
   * Returns whether escalation is currently muted (Plan Mode is active).
   */
  isEscalationMuted(): boolean {
    return this.planModeState.isActive();
  }

  /**
   * Process a drift evaluation result through the mute layer.
   *
   * - Signals are always passed through (recorded regardless of mute state)
   * - Confidence is always passed through unchanged
   * - `paused` is forced to false when Plan Mode is active
   *
   * @param evaluation - The raw DriftEvaluationResult from DriftMonitor
   * @returns MutedEvaluationResult with escalation state
   */
  processEvaluation(evaluation: DriftEvaluationResult): MutedEvaluationResult {
    const muted = this.isEscalationMuted();

    return {
      confidence: evaluation.confidence,
      signals: evaluation.signals,
      paused: muted ? false : evaluation.paused,
      escalationMuted: muted,
    };
  }

  /**
   * Determine if a signal should trigger escalation behavior.
   *
   * During Plan Mode:
   * - Signals are still recorded (this method does not suppress recording)
   * - But escalation actions (notifications, pausing, critical alerts to UI)
   *   are suppressed
   *
   * @param signal - The drift signal to evaluate
   * @returns true if the signal should trigger escalation, false if muted
   */
  shouldEscalate(signal: DriftSignal): boolean {
    if (this.planModeState.isActive()) {
      return false;
    }
    // When Plan Mode is not active, all signals escalate normally
    return signal.severity === 'warning' || signal.severity === 'critical';
  }
}
