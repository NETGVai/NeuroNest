/**
 * ResponsiveUI state machine — pure logic module for managing responsive
 * UI behavior during agent execution.
 *
 * Ensures the renderer remains interactive while the agent works:
 * - Chat history scroll, file tree browse, and file open stay functional
 * - Cancel button is visible during execution
 * - Progress events are batched via requestAnimationFrame
 * - Messages queued while agent is busy, processed FIFO on idle
 * - 60fps scroll maintained during streaming updates
 *
 * Feature-gated via `production_ux_responsive_ui`
 *
 * This module is framework-agnostic and can be tested without DOM dependencies.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

import type { EnhancedLoopProgress, ToolLifecycleEvent } from '../shared/production-ux-types.js';

// ─── Types ──────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'thinking' | 'tool_executing';

export interface QueuedMessage {
  id: string;
  content: string;
  timestamp: number;
}

export interface ResponsiveUIState {
  /** Whether the agent is currently executing */
  agentBusy: boolean;
  /** Current agent execution status */
  agentStatus: AgentStatus;
  /** Whether the cancel button should be visible */
  cancelButtonVisible: boolean;
  /** FIFO queue of messages submitted while agent is busy */
  messageQueue: QueuedMessage[];
  /** Whether UI interactions (scroll, file tree, file open) are enabled */
  uiInteractive: boolean;
  /** Number of pending progress events awaiting RAF batch */
  pendingEventCount: number;
  /** Whether a cancel request has been sent (prevents double-cancel) */
  cancelRequested: boolean;
}

export type ResponsiveUIEvent =
  | { type: 'agent_started' }
  | { type: 'agent_idle' }
  | { type: 'progress_update'; payload: EnhancedLoopProgress }
  | { type: 'tool_event'; payload: ToolLifecycleEvent }
  | { type: 'message_submitted'; message: QueuedMessage }
  | { type: 'message_dequeued' }
  | { type: 'cancel_requested' }
  | { type: 'cancel_acknowledged' }
  | { type: 'events_flushed'; count: number }
  | { type: 'events_batched'; count: number }
  | { type: 'reset' };

// ─── Initial State ──────────────────────────────────────────────

export const INITIAL_RESPONSIVE_UI_STATE: ResponsiveUIState = {
  agentBusy: false,
  agentStatus: 'idle',
  cancelButtonVisible: false,
  messageQueue: [],
  uiInteractive: true,
  pendingEventCount: 0,
  cancelRequested: false,
};

// ─── State Machine Reducer ──────────────────────────────────────

/**
 * Pure reducer for responsive UI state.
 *
 * Key invariants:
 * - uiInteractive is ALWAYS true (Req 14.1) — scrolling, browsing, file open never blocked
 * - cancelButtonVisible is true whenever agentBusy is true (Req 14.2)
 * - Messages submitted during busy state are queued, not discarded (Req 14.4)
 * - Messages are processed FIFO when agent goes idle (Req 14.4)
 * - Progress events tracked for RAF batching (Req 14.3, 14.5)
 */
export function responsiveUIReducer(
  state: ResponsiveUIState,
  event: ResponsiveUIEvent,
): ResponsiveUIState {
  switch (event.type) {
    case 'agent_started': {
      return {
        ...state,
        agentBusy: true,
        agentStatus: 'thinking',
        cancelButtonVisible: true,
        cancelRequested: false,
        // UI remains interactive — never set uiInteractive to false
        uiInteractive: true,
      };
    }

    case 'agent_idle': {
      return {
        ...state,
        agentBusy: false,
        agentStatus: 'idle',
        cancelButtonVisible: false,
        cancelRequested: false,
        pendingEventCount: 0,
        uiInteractive: true,
      };
    }

    case 'progress_update': {
      const { payload } = event;
      let agentStatus: AgentStatus = state.agentStatus;

      if (payload.status === 'thinking') {
        agentStatus = 'thinking';
      } else if (payload.status === 'tool_executing') {
        agentStatus = 'tool_executing';
      } else if (payload.status === 'complete') {
        // Will be handled by 'agent_idle' event
        agentStatus = 'idle';
      }

      return {
        ...state,
        agentStatus,
        agentBusy: agentStatus !== 'idle',
        cancelButtonVisible: agentStatus !== 'idle',
        // UI always stays interactive
        uiInteractive: true,
      };
    }

    case 'tool_event': {
      // Tool events don't change interactivity — just track agent is busy
      return {
        ...state,
        agentBusy: true,
        agentStatus: 'tool_executing',
        cancelButtonVisible: true,
        uiInteractive: true,
      };
    }

    case 'message_submitted': {
      if (!state.agentBusy) {
        // Agent is idle — message should be processed immediately, not queued
        return state;
      }

      // Agent is busy — queue the message (FIFO)
      return {
        ...state,
        messageQueue: [...state.messageQueue, event.message],
        uiInteractive: true,
      };
    }

    case 'message_dequeued': {
      if (state.messageQueue.length === 0) {
        return state;
      }

      // Remove the first message (FIFO order)
      return {
        ...state,
        messageQueue: state.messageQueue.slice(1),
      };
    }

    case 'cancel_requested': {
      if (!state.agentBusy || state.cancelRequested) {
        return state;
      }

      return {
        ...state,
        cancelRequested: true,
      };
    }

    case 'cancel_acknowledged': {
      return {
        ...state,
        agentBusy: false,
        agentStatus: 'idle',
        cancelButtonVisible: false,
        cancelRequested: false,
        pendingEventCount: 0,
        uiInteractive: true,
      };
    }

    case 'events_batched': {
      // Track events waiting for next RAF flush
      return {
        ...state,
        pendingEventCount: state.pendingEventCount + event.count,
      };
    }

    case 'events_flushed': {
      // Events have been rendered in the current animation frame
      const remaining = Math.max(0, state.pendingEventCount - event.count);
      return {
        ...state,
        pendingEventCount: remaining,
      };
    }

    case 'reset': {
      return { ...INITIAL_RESPONSIVE_UI_STATE };
    }

    default:
      return state;
  }
}

/**
 * Applies a sequence of events to compute the final state.
 * Useful for testing multi-step transitions.
 */
export function applyResponsiveUIEvents(
  events: ResponsiveUIEvent[],
  initialState: ResponsiveUIState = INITIAL_RESPONSIVE_UI_STATE,
): ResponsiveUIState {
  return events.reduce(responsiveUIReducer, initialState);
}

// ─── Message Queue Helpers ──────────────────────────────────────

/**
 * Returns the next message to process from the queue (FIFO),
 * or null if the queue is empty.
 */
export function peekNextMessage(state: ResponsiveUIState): QueuedMessage | null {
  return state.messageQueue.length > 0 ? state.messageQueue[0] : null;
}

/**
 * Returns true if there are queued messages waiting to be processed.
 */
export function hasQueuedMessages(state: ResponsiveUIState): boolean {
  return state.messageQueue.length > 0;
}

/**
 * Returns the count of queued messages.
 */
export function getQueuedMessageCount(state: ResponsiveUIState): number {
  return state.messageQueue.length;
}

// ─── RAF Event Batcher ──────────────────────────────────────────

/**
 * Creates a requestAnimationFrame-based event batcher.
 * Batches progress events and flushes them once per frame to maintain 60fps.
 *
 * This is a factory function that returns the batch interface.
 * The actual RAF scheduling is handled by the caller's environment.
 *
 * Requirements: 14.3, 14.5
 */
export interface EventBatcher<T> {
  /** Add an event to the current batch */
  push(event: T): void;
  /** Flush all batched events (called from RAF callback) */
  flush(): T[];
  /** Get the number of pending events */
  pending(): number;
  /** Clear all pending events without processing */
  clear(): void;
}

export function createEventBatcher<T>(): EventBatcher<T> {
  let batch: T[] = [];

  return {
    push(event: T): void {
      batch.push(event);
    },

    flush(): T[] {
      const flushed = batch;
      batch = [];
      return flushed;
    },

    pending(): number {
      return batch.length;
    },

    clear(): void {
      batch = [];
    },
  };
}

// ─── Scroll Performance Helper ──────────────────────────────────

/**
 * Determines whether auto-scroll should be applied based on user scroll position.
 * Maintains 60fps by only scrolling when user is at or near the bottom.
 *
 * Requirements: 14.5
 *
 * @param scrollTop Current scroll position
 * @param scrollHeight Total scrollable height
 * @param clientHeight Visible height of the container
 * @param threshold Distance from bottom to consider "at bottom" (default 80px)
 * @returns true if auto-scroll should be applied
 */
export function shouldAutoScroll(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = 80,
): boolean {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  return distanceFromBottom <= threshold;
}

/**
 * Computes whether the cancel button should be visible.
 * Visible whenever the agent is actively executing.
 *
 * Requirements: 14.2
 */
export function isCancelVisible(state: ResponsiveUIState): boolean {
  return state.agentBusy && !state.cancelRequested;
}

/**
 * Determines if a submitted message should be queued or processed immediately.
 *
 * Requirements: 14.4
 */
export function shouldQueueMessage(state: ResponsiveUIState): boolean {
  return state.agentBusy;
}
