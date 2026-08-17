/**
 * Turn Status Row Island — Typed adapter for turn activity state rendering.
 *
 * Routes turn lifecycle state rendering through the typed Turn_Activity_State
 * projection. Produces row island output that replaces legacy status indicators
 * with exact projected state labels, elapsed time, partial output retention,
 * cancellation/reconnection details, and terminal outcomes.
 *
 * The row island is keyed by turnId and uses the deriveTurnActivitySurface
 * reducer to project the current surface state. It never infers cancellation
 * completion from a button click or disconnected stream.
 *
 * Requirements: 36.1–36.17
 */

import {
  deriveTurnActivitySurface,
  getMotionAdjustedPresentation,
  retainPartialOutput,
  DEFAULT_TURN_ACTIVITY_SURFACE_CONFIG,
  DEFAULT_STATUS_LABELS,
  type TurnActivitySurfaceConfig,
  type TurnActivityProjection,
  type TurnActivitySurface,
} from '../../presentation/turn-activity/turn-activity-surface';
import { TERMINAL_STATES, type TurnActivityState } from '../../runtime/turn-controller-schemas';
import { sanitizeContent } from '../../presentation/sanitize';
import type { PresentationOutput, ContentBlock } from '../../presentation/types';
import type {
  RowIsland,
  RowIslandOutput,
  TurnStatusRowIslandInput,
  LegacyTurnStatusData,
} from './types';

// ─── Status Content Block Builders ──────────────────────────────

/**
 * Builds a status label content block for the current turn state.
 */
function buildStatusBlock(
  state: TurnActivityState,
  isTerminal: boolean,
  elapsedMs?: number,
): ContentBlock {
  const label = DEFAULT_STATUS_LABELS[state] || state;
  const elapsedLabel = elapsedMs != null
    ? ` (${formatElapsed(elapsedMs)})`
    : '';

  return {
    kind: 'generic_card',
    content: `${label}${elapsedLabel}`,
    accessibilityLabel: `Turn status: ${label}${elapsedLabel}`,
    metadata: {
      turnState: state,
      isTerminal,
      elapsedMs,
    },
  };
}

/**
 * Builds a cancellation detail block.
 */
function buildCancellationBlock(detail: TurnStatusRowIslandInput['cancellationDetail']): ContentBlock | null {
  if (!detail) return null;

  const deadlineLabel = detail.pendingWorkCount > 0
    ? `Waiting for ${detail.pendingWorkCount} work items to stop`
    : 'Cancellation in progress';

  return {
    kind: 'generic_card',
    content: deadlineLabel,
    accessibilityLabel: `Cancellation: ${deadlineLabel}`,
    metadata: {
      cause: detail.cause,
      pendingWorkCount: detail.pendingWorkCount,
      deadlineMs: detail.deadlineMs,
    },
  };
}

/**
 * Builds a reconnection detail block.
 */
function buildReconnectionBlock(detail: TurnStatusRowIslandInput['reconnectionDetail']): ContentBlock | null {
  if (!detail) return null;

  const attemptLabel = `Reconnection attempt ${detail.attempt} of ${detail.maxAttempts}`;

  return {
    kind: 'generic_card',
    content: attemptLabel,
    accessibilityLabel: attemptLabel,
    metadata: {
      attempt: detail.attempt,
      maxAttempts: detail.maxAttempts,
      disconnectedAt: detail.disconnectedAt,
    },
  };
}

/**
 * Builds a terminal outcome block.
 */
function buildTerminalOutcomeBlock(outcome: TurnStatusRowIslandInput['terminalOutcome']): ContentBlock | null {
  if (!outcome) return null;

  const reason = outcome.reason ? `: ${outcome.reason}` : '';
  const duration = outcome.durationMs != null
    ? ` in ${formatElapsed(outcome.durationMs)}`
    : '';

  const label = `${capitalize(outcome.kind)}${reason}${duration}`;

  return {
    kind: 'generic_card',
    content: label,
    accessibilityLabel: `Turn outcome: ${label}`,
    metadata: {
      outcomeKind: outcome.kind,
      reason: outcome.reason,
      durationMs: outcome.durationMs,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Format elapsed milliseconds as a human-readable string.
 * Uses 1-second precision per Requirement 36.4.
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Turn Status Row Island Implementation ──────────────────────

/**
 * Typed turn status row island adapter.
 *
 * Renders all projected lifecycle states from Turn_Activity_State.
 * Produces RowIslandOutput keyed by turnId with accessible labels,
 * elapsed duration, partial output retention, cancellation/reconnection
 * details, and exact terminal outcomes.
 *
 * Never infers completion from UI events — all state comes from the
 * durable projection.
 */
export class TurnStatusRowIslandAdapter implements RowIsland<TurnStatusRowIslandInput> {
  readonly kind = 'turn_status' as const;

  /**
   * Render a turn status row from projected Turn_Activity_State.
   */
  render(input: TurnStatusRowIslandInput): RowIslandOutput {
    const blocks: ContentBlock[] = [];

    // Primary status block
    blocks.push(buildStatusBlock(input.state, input.isTerminal, input.elapsedMs));

    // Cancellation detail (only while in cancelling state)
    if (input.state === 'cancelling' && input.cancellationDetail) {
      const cancelBlock = buildCancellationBlock(input.cancellationDetail);
      if (cancelBlock) blocks.push(cancelBlock);
    }

    // Reconnection detail (only while reconnecting)
    if (input.state === 'reconnecting' && input.reconnectionDetail) {
      const reconnectBlock = buildReconnectionBlock(input.reconnectionDetail);
      if (reconnectBlock) blocks.push(reconnectBlock);
    }

    // Terminal outcome (only when terminal)
    if (input.isTerminal && input.terminalOutcome) {
      const outcomeBlock = buildTerminalOutcomeBlock(input.terminalOutcome);
      if (outcomeBlock) blocks.push(outcomeBlock);
    }

    // Partial output retention
    if (input.partialOutput) {
      const sanitized = sanitizeContent(input.partialOutput);
      blocks.push({
        kind: 'generic_card',
        content: sanitized.text,
        accessibilityLabel: 'Retained partial output',
        expandable: sanitized.text.length > 500,
        truncated: sanitized.text.length > 500,
        metadata: {
          isPartialOutput: true,
        },
      });
    }

    const statusLabel = DEFAULT_STATUS_LABELS[input.state] || input.state;
    const accessibilityLabel = input.isTerminal
      ? `Turn ${input.turnId}: ${statusLabel} (terminal)`
      : `Turn ${input.turnId}: ${statusLabel}`;

    const presentation: PresentationOutput = {
      dispatchedKind: 'generic',
      blocks,
      isFallback: false,
      sanitizationReasons: [],
      callId: input.turnId,
    };

    return {
      islandKind: 'turn_status',
      presentation,
      stableKey: `turn-status:${input.turnId}`,
      accessibilityLabel,
      usedFallback: false,
    };
  }

  /**
   * Adapt a legacy turn status indicator to a TurnStatusRowIslandInput.
   *
   * Maps legacy status text and activity state into the typed
   * Turn_Activity_State model.
   */
  adaptLegacy(legacy: LegacyTurnStatusData, turnId: string): TurnStatusRowIslandInput {
    const state = mapLegacyStatusToState(legacy.statusText, legacy.isActive);

    return {
      turnId,
      state,
      isTerminal: TERMINAL_STATES.has(state),
      partialOutput: undefined,
      stopAvailable: legacy.isActive,
      elapsedMs: undefined,
    };
  }
}

/**
 * Maps legacy status text to a Turn_Activity_State.
 * This is a best-effort compatibility mapping.
 */
function mapLegacyStatusToState(statusText: string, isActive: boolean): TurnActivityState {
  const normalized = statusText.toLowerCase().trim();

  if (normalized.includes('complet') || normalized.includes('done')) return 'completed';
  if (normalized.includes('fail') || normalized.includes('error')) return 'failed';
  if (normalized.includes('cancel') || normalized.includes('interrupt')) return 'interrupted';
  if (normalized.includes('think') || normalized.includes('reason')) return 'reasoning';
  if (normalized.includes('stream') || normalized.includes('writ')) return 'streaming';
  if (normalized.includes('tool') || normalized.includes('run')) return 'tool_running';
  if (normalized.includes('wait') || normalized.includes('input')) return 'waiting_for_user';
  if (normalized.includes('retry')) return 'retrying';
  if (normalized.includes('reconnect')) return 'reconnecting';
  if (normalized.includes('queue')) return 'queued';
  if (normalized.includes('assembl') || normalized.includes('prepar')) return 'assembling';

  // Default: active means streaming, inactive means completed
  return isActive ? 'streaming' : 'completed';
}

/**
 * Singleton instance for convenience. Turn status row islands are
 * stateless pure adapters so a single instance is safe.
 */
export const turnStatusRowIsland = new TurnStatusRowIslandAdapter();
