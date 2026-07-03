/**
 * FocusMode state machine — pure logic module for managing the
 * Agent Focus Mode state transitions.
 *
 * Focus Mode provides a full-width layout with chat, progress panel,
 * and change summary (no code editor pane). Supports split-view with
 * file tree on one side.
 *
 * Key invariants:
 * - Chat scroll position is preserved across mode switches
 * - Progress panel state is preserved across mode switches
 * - Feature-gated via `production_ux_focus_mode`
 *
 * This module is framework-agnostic and can be tested without DOM dependencies.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5
 */

// ─── Types ──────────────────────────────────────────────────────

export interface ProgressPanelState {
  visible: boolean;
  collapsed: boolean;
  steps: ProgressStep[];
  currentIteration: number;
  maxIterations: number;
}

export interface ProgressStep {
  id: string;
  toolName: string;
  target: string;
  outcome: 'success' | 'failure' | 'pending' | 'executing';
  durationMs?: number;
}

export interface FocusModeState {
  active: boolean;
  splitView: boolean;
  chatScrollPosition: number;
  progressPanelState: ProgressPanelState;
}

export interface FilePreview {
  filePath: string;
  language: string;
  content: string;
  operation: 'created' | 'modified' | 'deleted' | 'referenced';
}

export type FocusModeEvent =
  | { type: 'toggle' }
  | { type: 'activate' }
  | { type: 'deactivate' }
  | { type: 'toggle_split_view' }
  | { type: 'save_scroll_position'; position: number }
  | { type: 'update_progress'; progressState: ProgressPanelState }
  | { type: 'reset' };

// ─── Initial State ──────────────────────────────────────────────

export const INITIAL_PROGRESS_STATE: ProgressPanelState = {
  visible: false,
  collapsed: false,
  steps: [],
  currentIteration: 0,
  maxIterations: 25,
};

export const INITIAL_FOCUS_MODE_STATE: FocusModeState = {
  active: false,
  splitView: false,
  chatScrollPosition: 0,
  progressPanelState: { ...INITIAL_PROGRESS_STATE },
};

// ─── State Machine Reducer ──────────────────────────────────────

/**
 * Pure reducer that computes the next FocusMode state given
 * the current state and an incoming event.
 *
 * Transition rules:
 * - toggle: flips active state (preserving all other state)
 * - activate: sets active = true (no-op if already active)
 * - deactivate: sets active = false (no-op if already inactive)
 * - toggle_split_view: flips splitView (only effective when active)
 * - save_scroll_position: stores chat scroll position for restoration
 * - update_progress: updates the progress panel state snapshot
 * - reset: returns to initial state
 *
 * INVARIANT: On toggle/activate/deactivate, chatScrollPosition and
 * progressPanelState are ALWAYS preserved (Requirement 20.5).
 */
export function focusModeReducer(
  state: FocusModeState,
  event: FocusModeEvent,
): FocusModeState {
  switch (event.type) {
    case 'toggle': {
      return {
        ...state,
        active: !state.active,
      };
    }

    case 'activate': {
      if (state.active) return state;
      return {
        ...state,
        active: true,
      };
    }

    case 'deactivate': {
      if (!state.active) return state;
      return {
        ...state,
        active: false,
      };
    }

    case 'toggle_split_view': {
      // Split view toggle only meaningful when focus mode is active
      if (!state.active) return state;
      return {
        ...state,
        splitView: !state.splitView,
      };
    }

    case 'save_scroll_position': {
      return {
        ...state,
        chatScrollPosition: event.position,
      };
    }

    case 'update_progress': {
      return {
        ...state,
        progressPanelState: { ...event.progressState },
      };
    }

    case 'reset': {
      return { ...INITIAL_FOCUS_MODE_STATE };
    }

    default:
      return state;
  }
}

/**
 * Applies a sequence of events to compute the final state.
 * Useful for testing multi-step transitions.
 */
export function applyFocusModeEvents(
  events: FocusModeEvent[],
  initialState: FocusModeState = INITIAL_FOCUS_MODE_STATE,
): FocusModeState {
  return events.reduce(focusModeReducer, initialState);
}

/**
 * Determines if the given file reference should produce an inline
 * file preview within the chat during focus mode.
 *
 * Requirement 20.3: Display file previews inline within chat when
 * the agent references or modifies files.
 */
export function shouldShowFilePreview(
  focusModeActive: boolean,
  filePath: string | undefined,
): boolean {
  if (!focusModeActive) return false;
  if (!filePath || filePath.trim().length === 0) return false;
  return true;
}

/**
 * Computes the CSS layout class names for the current focus mode state.
 * Returns layout configuration for the renderer to apply.
 */
export function computeLayout(state: FocusModeState): {
  containerClass: string;
  showEditor: boolean;
  showFileTree: boolean;
  showChat: boolean;
  showProgressPanel: boolean;
  showChangeSummary: boolean;
} {
  if (!state.active) {
    return {
      containerClass: 'layout-editor-view',
      showEditor: true,
      showFileTree: true,
      showChat: true,
      showProgressPanel: false,
      showChangeSummary: false,
    };
  }

  return {
    containerClass: state.splitView
      ? 'layout-focus-split'
      : 'layout-focus-full',
    showEditor: false,
    showFileTree: state.splitView,
    showChat: true,
    showProgressPanel: true,
    showChangeSummary: true,
  };
}
