/**
 * LoadingState — pure state machine for managing loading indicators
 * during long-running operations.
 *
 * Handles the timing-based visibility logic:
 * - Show loading indicator when operation exceeds 2 seconds
 * - Show elapsed time when operation exceeds 5 seconds
 * - Show timeout warning with cancel option at 30 seconds
 * - Multiple concurrent operations each track independently
 * - Does not block unrelated UI elements
 *
 * Feature-gated via `production_ux_loading_states`
 *
 * This module is framework-agnostic and can be tested without DOM dependencies.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

// ─── Types ──────────────────────────────────────────────────────

/** Categories of operations that display loading states */
export type OperationType =
  | 'project_initialization'
  | 'llm_api_call'
  | 'file_indexing'
  | 'tool_execution';

/** Visibility phase of a loading operation */
export type LoadingPhase =
  | 'hidden'       // < 2s elapsed, not yet visible
  | 'indicator'    // >= 2s, showing spinner
  | 'elapsed'      // >= 5s, showing elapsed time
  | 'timeout';     // >= 30s, showing timeout warning with cancel

/** A single tracked loading operation */
export interface LoadingOperation {
  id: string;
  type: OperationType;
  label: string;
  startedAt: number;
  phase: LoadingPhase;
  elapsedMs: number;
  cancelled: boolean;
}

/** Complete state of the loading system */
export interface LoadingStateModel {
  operations: Map<string, LoadingOperation>;
  /** IDs of operations that are visible (phase !== 'hidden') */
  visibleIds: Set<string>;
}

/** Events that drive state transitions */
export type LoadingEvent =
  | { type: 'start'; id: string; operationType: OperationType; label: string; timestamp: number }
  | { type: 'tick'; timestamp: number }
  | { type: 'complete'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'reset' };

// ─── Constants ──────────────────────────────────────────────────

/** Show loading indicator after this many milliseconds */
export const INDICATOR_THRESHOLD_MS = 2000;

/** Show elapsed time after this many milliseconds */
export const ELAPSED_THRESHOLD_MS = 5000;

/** Show timeout warning after this many milliseconds */
export const TIMEOUT_THRESHOLD_MS = 30000;

// ─── Initial State ──────────────────────────────────────────────

export const INITIAL_LOADING_STATE: LoadingStateModel = {
  operations: new Map(),
  visibleIds: new Set(),
};

// ─── Phase Computation ──────────────────────────────────────────

/**
 * Compute the phase for an operation based on elapsed time.
 */
export function computePhase(elapsedMs: number): LoadingPhase {
  if (elapsedMs >= TIMEOUT_THRESHOLD_MS) return 'timeout';
  if (elapsedMs >= ELAPSED_THRESHOLD_MS) return 'elapsed';
  if (elapsedMs >= INDICATOR_THRESHOLD_MS) return 'indicator';
  return 'hidden';
}

// ─── State Machine Reducer ──────────────────────────────────────

/**
 * Pure reducer that computes the next LoadingState given
 * the current state and an incoming event.
 *
 * Transition rules:
 * - start: registers a new operation in 'hidden' phase
 * - tick: updates elapsed time and phase for all active operations
 * - complete: removes the operation from tracking
 * - cancel: marks the operation as cancelled and removes it
 * - reset: clears all operations
 *
 * INVARIANT: An operation in 'hidden' phase is NOT in visibleIds.
 * INVARIANT: An operation in any other phase IS in visibleIds.
 * INVARIANT: Completed/cancelled operations are fully removed from state.
 * INVARIANT: Operations are independent — starting/completing one does not
 *            affect the visibility or phase of others (Requirement 10.4).
 */
export function loadingStateReducer(
  state: LoadingStateModel,
  event: LoadingEvent,
): LoadingStateModel {
  switch (event.type) {
    case 'start': {
      const operation: LoadingOperation = {
        id: event.id,
        type: event.operationType,
        label: event.label,
        startedAt: event.timestamp,
        phase: 'hidden',
        elapsedMs: 0,
        cancelled: false,
      };

      const newOperations = new Map(state.operations);
      newOperations.set(event.id, operation);

      // New operations start hidden (< 2s threshold)
      return {
        operations: newOperations,
        visibleIds: new Set(state.visibleIds),
      };
    }

    case 'tick': {
      const newOperations = new Map<string, LoadingOperation>();
      const newVisibleIds = new Set<string>();

      for (const [id, op] of state.operations) {
        if (op.cancelled) continue;

        const elapsedMs = event.timestamp - op.startedAt;
        const phase = computePhase(elapsedMs);

        const updatedOp: LoadingOperation = {
          ...op,
          elapsedMs,
          phase,
        };

        newOperations.set(id, updatedOp);

        if (phase !== 'hidden') {
          newVisibleIds.add(id);
        }
      }

      return {
        operations: newOperations,
        visibleIds: newVisibleIds,
      };
    }

    case 'complete': {
      const newOperations = new Map(state.operations);
      newOperations.delete(event.id);

      const newVisibleIds = new Set(state.visibleIds);
      newVisibleIds.delete(event.id);

      return {
        operations: newOperations,
        visibleIds: newVisibleIds,
      };
    }

    case 'cancel': {
      const newOperations = new Map(state.operations);
      const op = newOperations.get(event.id);

      if (op) {
        newOperations.delete(event.id);
      }

      const newVisibleIds = new Set(state.visibleIds);
      newVisibleIds.delete(event.id);

      return {
        operations: newOperations,
        visibleIds: newVisibleIds,
      };
    }

    case 'reset': {
      return {
        operations: new Map(),
        visibleIds: new Set(),
      };
    }

    default:
      return state;
  }
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Apply a sequence of events to compute the final state.
 * Useful for testing multi-step transitions.
 */
export function applyLoadingEvents(
  events: LoadingEvent[],
  initialState: LoadingStateModel = INITIAL_LOADING_STATE,
): LoadingStateModel {
  return events.reduce(loadingStateReducer, initialState);
}

/**
 * Get all visible loading operations sorted by start time (oldest first).
 */
export function getVisibleOperations(state: LoadingStateModel): LoadingOperation[] {
  const visible: LoadingOperation[] = [];
  for (const id of state.visibleIds) {
    const op = state.operations.get(id);
    if (op) visible.push(op);
  }
  return visible.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Check if any operation has reached timeout phase.
 */
export function hasTimeoutWarning(state: LoadingStateModel): boolean {
  for (const id of state.visibleIds) {
    const op = state.operations.get(id);
    if (op && op.phase === 'timeout') return true;
  }
  return false;
}

/**
 * Get the display text for an operation's elapsed time.
 * Returns formatted string like "5s", "1m 23s".
 */
export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Get operation-type-specific label for display.
 */
export function getOperationLabel(type: OperationType): string {
  switch (type) {
    case 'project_initialization':
      return 'Initializing project...';
    case 'llm_api_call':
      return 'Waiting for AI response...';
    case 'file_indexing':
      return 'Indexing files...';
    case 'tool_execution':
      return 'Executing tool...';
    default:
      return 'Loading...';
  }
}

/**
 * Determines if the loading overlay should block interaction.
 * Per Requirement 10.4: loading states should NOT block unrelated UI elements.
 * Returns false always — loading indicators are non-blocking.
 */
export function shouldBlockUI(_state: LoadingStateModel): boolean {
  return false;
}

/**
 * Compute the display properties for a loading operation
 * suitable for rendering in the UI.
 */
export function computeDisplayProps(op: LoadingOperation): {
  showSpinner: boolean;
  showElapsedTime: boolean;
  showTimeoutWarning: boolean;
  showCancelButton: boolean;
  elapsedText: string;
  label: string;
} {
  return {
    showSpinner: op.phase !== 'hidden',
    showElapsedTime: op.phase === 'elapsed' || op.phase === 'timeout',
    showTimeoutWarning: op.phase === 'timeout',
    showCancelButton: op.phase === 'timeout',
    elapsedText: formatElapsedTime(op.elapsedMs),
    label: op.label || getOperationLabel(op.type),
  };
}
