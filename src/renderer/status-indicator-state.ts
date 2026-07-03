/**
 * StatusIndicator state machine — pure logic module for managing the
 * status indicator phase transitions.
 *
 * Phases: idle → thinking → tool_executing → complete/error/disconnected
 *
 * Key invariant: once in 'error' phase, the state SHALL NOT return to 'idle'
 * without an explicit completion or reset event.
 *
 * This module is framework-agnostic and can be tested without DOM dependencies.
 */

import type { AgentErrorEvent, EnhancedLoopProgress, TaskCompleteEvent } from '../shared/production-ux-types.js';

// ─── Types ──────────────────────────────────────────────────────

export type StatusPhase = 'idle' | 'thinking' | 'tool_executing' | 'error' | 'disconnected';

export interface StatusIndicatorState {
  active: boolean;
  phase: StatusPhase;
  label: string;
  errorMessage?: string;
}

export type StatusEvent =
  | { type: 'progress'; payload: EnhancedLoopProgress }
  | { type: 'error'; payload: AgentErrorEvent }
  | { type: 'task_complete'; payload: TaskCompleteEvent }
  | { type: 'disconnect' }
  | { type: 'reconnect' }
  | { type: 'reset' };

// ─── Initial State ──────────────────────────────────────────────

export const INITIAL_STATE: StatusIndicatorState = {
  active: false,
  phase: 'idle',
  label: '',
  errorMessage: undefined,
};

// ─── State Machine Reducer ──────────────────────────────────────

/**
 * Pure reducer that computes the next StatusIndicator state given
 * the current state and an incoming event.
 *
 * Transition rules:
 * - progress with status 'thinking' → phase 'thinking', active
 * - progress with status 'tool_executing' → phase 'tool_executing', active
 * - progress with status 'complete' → phase 'idle', inactive (reset)
 * - error event → phase 'error', preserves errorMessage
 * - task_complete → phase 'idle', inactive (reset)
 * - disconnect → phase 'disconnected'
 * - reconnect → restores to 'idle' (inactive)
 * - reset → phase 'idle', inactive
 *
 * INVARIANT: from 'error' phase, only 'task_complete', 'reset', or 'reconnect'
 * can transition the state away. A 'progress' event alone CANNOT move from
 * 'error' back to 'idle'.
 */
export function statusIndicatorReducer(
  state: StatusIndicatorState,
  event: StatusEvent,
): StatusIndicatorState {
  switch (event.type) {
    case 'progress': {
      // Error state is sticky — cannot be cleared by progress events alone
      if (state.phase === 'error') {
        return state;
      }

      const { payload } = event;

      if (payload.status === 'thinking') {
        return {
          active: true,
          phase: 'thinking',
          label: payload.phaseLabel || 'Thinking...',
          errorMessage: undefined,
        };
      }

      if (payload.status === 'tool_executing') {
        const toolTarget = payload.toolTarget ?? '';
        const label = payload.phaseLabel || (toolTarget ? `Running tool: ${toolTarget}` : 'Executing...');
        return {
          active: true,
          phase: 'tool_executing',
          label,
          errorMessage: undefined,
        };
      }

      if (payload.status === 'complete') {
        return {
          active: false,
          phase: 'idle',
          label: '',
          errorMessage: undefined,
        };
      }

      // Unknown status — keep current state
      return state;
    }

    case 'error': {
      const { payload } = event;
      return {
        active: true,
        phase: 'error',
        label: payload.message,
        errorMessage: payload.message,
      };
    }

    case 'task_complete': {
      // Explicit completion event — clears error state and resets to idle
      return {
        active: false,
        phase: 'idle',
        label: '',
        errorMessage: undefined,
      };
    }

    case 'disconnect': {
      return {
        active: true,
        phase: 'disconnected',
        label: 'Disconnected — attempting reconnection...',
        errorMessage: state.errorMessage,
      };
    }

    case 'reconnect': {
      // Reconnect resets to idle
      return {
        active: false,
        phase: 'idle',
        label: '',
        errorMessage: undefined,
      };
    }

    case 'reset': {
      // Explicit reset — always returns to idle regardless of current phase
      return { ...INITIAL_STATE };
    }

    default:
      return state;
  }
}

/**
 * Applies a sequence of events to compute the final state.
 * Useful for testing multi-step transitions.
 */
export function applyEvents(
  events: StatusEvent[],
  initialState: StatusIndicatorState = INITIAL_STATE,
): StatusIndicatorState {
  return events.reduce(statusIndicatorReducer, initialState);
}
