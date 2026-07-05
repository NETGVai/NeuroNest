/**
 * Loop Run Panel — Pure state/logic functions for the Loop Run Panel.
 *
 * All functions are pure (no DOM, no side effects) so they can be
 * unit tested independently of the renderer.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.6, 18.7
 */

import type {
  LoopState,
  TerminalState,
  LoopRunPanelState,
  PassTimelineEntry,
  VerifyCheckResult,
  EvidenceItem,
  LoopPassStartEvent,
  LoopVerifyResultEvent,
  LoopStopEvent,
  LoopAwaitingApprovalEvent,
} from './loop-run-panel-types';

import { ACTIVE_STATES, TERMINAL_STATES } from './loop-run-panel-types';

// ─── State predicates ───────────────────────────────────────────

/**
 * Returns true if the loop is in an active (working) state.
 * Active states: PLANNING_PASS, EXECUTING_PASS, VERIFYING, APPLYING_FEEDBACK
 *
 * Requirement 18.2: Evidence and cost displayed continuously during active states.
 * Requirement 18.3: Stop button enabled only during active states.
 */
export function isActiveState(state: LoopState): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(state);
}

/**
 * Returns true if the loop is in a terminal (final) state.
 *
 * Requirement 18.7: Display final status and stop_reason in terminal states.
 */
export function isTerminalState(state: LoopState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Returns true if the loop is awaiting user approval.
 *
 * Requirement 18.3: Approve button enabled only in AWAITING_APPROVAL.
 * Requirement 18.4: Non-dismissible banner shown in AWAITING_APPROVAL.
 */
export function isAwaitingApproval(state: LoopState): boolean {
  return state === 'AWAITING_APPROVAL';
}

// ─── Button state computations ──────────────────────────────────

/**
 * Determines if the Stop button should be enabled.
 * Enabled only during active states (not terminal, not awaiting approval, not idle).
 *
 * Requirement 18.3: Stop button enabled only while in active state.
 */
export function isStopButtonEnabled(state: LoopState): boolean {
  return isActiveState(state);
}

/**
 * Determines if the Approve button should be enabled.
 * Enabled only in AWAITING_APPROVAL state.
 *
 * Requirement 18.3: Approve button enabled only in AWAITING_APPROVAL.
 */
export function isApproveButtonEnabled(state: LoopState): boolean {
  return state === 'AWAITING_APPROVAL';
}

/**
 * Determines if the approval banner should be shown.
 * Shown only when in AWAITING_APPROVAL state.
 *
 * Requirement 18.4: Non-dismissible banner in AWAITING_APPROVAL.
 */
export function shouldShowApprovalBanner(state: LoopState): boolean {
  return state === 'AWAITING_APPROVAL';
}

/**
 * Determines whether evidence and cost meter should be displayed.
 * Shown continuously during active states per REQ-18.2.
 * Both appear together — cost meter doesn't appear independently.
 *
 * Requirement 18.2: Continuously display evidence and cost during active states.
 */
export function shouldShowEvidenceAndCost(state: LoopState): boolean {
  return isActiveState(state);
}

// ─── Verify result formatting ───────────────────────────────────

/**
 * Determines if a verify check result should be badged as "soft verification".
 * llmJudge checks get an amber badge per Requirement 18.6.
 *
 * Requirement 18.6: Badge llmJudge checks with amber "soft verification" indicator.
 */
export function isLlmJudgeCheck(check: VerifyCheckResult): boolean {
  return check.type === 'llmJudge';
}

/**
 * Returns a display icon for a verify check result.
 * ✅ for pass, ❌ for fail.
 */
export function getCheckIcon(passed: boolean): string {
  return passed ? '✅' : '❌';
}

/**
 * Returns a human-readable label for the terminal status.
 *
 * Requirement 18.7: Display final status on terminal state.
 */
export function getStatusLabel(status: TerminalState): string {
  switch (status) {
    case 'SUCCEEDED':
      return 'Succeeded';
    case 'NO_OP':
      return 'No-Op (nothing to do)';
    case 'BLOCKED':
      return 'Blocked';
    case 'LIMIT_EXHAUSTED':
      return 'Limit Exhausted';
    case 'STALLED':
      return 'Stalled (no progress)';
  }
}

/**
 * Returns a CSS color variable for the terminal status.
 */
export function getStatusColor(status: TerminalState): string {
  switch (status) {
    case 'SUCCEEDED':
      return 'var(--green, #22c55e)';
    case 'NO_OP':
      return 'var(--text-dim, #888)';
    case 'BLOCKED':
      return 'var(--red, #ef4444)';
    case 'LIMIT_EXHAUSTED':
      return 'var(--yellow, #f59e0b)';
    case 'STALLED':
      return 'var(--yellow, #f59e0b)';
  }
}

// ─── Cost formatting ────────────────────────────────────────────

/**
 * Formats a cost value (in USD) for display.
 * Shows appropriate precision based on magnitude.
 */
export function formatCost(costUsd: number): string {
  if (costUsd === 0) return '$0.00';
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

// ─── State update reducers ──────────────────────────────────────

/**
 * Creates a fresh initial state for the panel.
 */
export function createInitialState(): LoopRunPanelState {
  return {
    runId: null,
    state: 'IDLE',
    passes: [],
    evidence: [],
    costUsd: 0,
    approvalReason: null,
    stopReason: null,
    timelineCollapsed: false,
  };
}

/**
 * Handles a loop:pass:start event — adds a new in-progress pass to timeline.
 *
 * Requirement 18.1: Display pass timeline with action summary.
 */
export function handlePassStart(
  state: LoopRunPanelState,
  event: LoopPassStartEvent,
): LoopRunPanelState {
  if (state.runId !== null && state.runId !== event.run_id) return state;

  const newPass: PassTimelineEntry = {
    passNumber: event.pass_number,
    actionSummary: event.action_summary,
    verifyResults: [],
    costUsd: 0,
    startedAt: event.timestamp,
    endedAt: null,
  };

  return {
    ...state,
    runId: event.run_id,
    state: 'EXECUTING_PASS',
    passes: [...state.passes, newPass],
  };
}

/**
 * Handles a loop:verify:result event — updates the latest pass with verify results.
 *
 * Requirement 18.1: Display verify result (pass/fail per check) for each completed pass.
 */
export function handleVerifyResult(
  state: LoopRunPanelState,
  event: LoopVerifyResultEvent,
): LoopRunPanelState {
  if (state.runId !== event.run_id) return state;

  const passes = state.passes.map((pass) => {
    if (pass.passNumber === event.pass_number) {
      return {
        ...pass,
        verifyResults: event.results.map((r) => ({
          checkId: r.checkId,
          type: r.type,
          passed: r.passed,
          output: r.output,
        })),
        endedAt: event.timestamp,
      };
    }
    return pass;
  });

  return {
    ...state,
    state: 'VERIFYING',
    passes,
  };
}

/**
 * Handles a loop:stop event — transition to terminal state.
 *
 * Requirement 18.7: Display final status and stop_reason, retain timeline.
 */
export function handleLoopStop(
  state: LoopRunPanelState,
  event: LoopStopEvent,
): LoopRunPanelState {
  if (state.runId !== event.run_id) return state;

  return {
    ...state,
    state: event.final_status,
    stopReason: event.stop_reason || null,
  };
}

/**
 * Handles a loop:awaiting-approval event — show approval banner.
 *
 * Requirement 18.4: Non-dismissible banner with approval reason.
 */
export function handleAwaitingApproval(
  state: LoopRunPanelState,
  event: LoopAwaitingApprovalEvent,
): LoopRunPanelState {
  if (state.runId !== event.run_id) return state;

  return {
    ...state,
    state: 'AWAITING_APPROVAL',
    approvalReason: event.reason,
  };
}

/**
 * Updates the running cost and evidence during active states.
 * Called on polling updates (within 2 seconds of state transitions per REQ-18.2).
 *
 * Requirement 18.2: Continuously display evidence and running cost meter.
 */
export function handleStatusUpdate(
  state: LoopRunPanelState,
  update: { state: LoopState; costUsd: number; evidence: EvidenceItem[] },
): LoopRunPanelState {
  return {
    ...state,
    state: update.state,
    costUsd: update.costUsd,
    evidence: update.evidence,
  };
}

/**
 * Computes the total number of checks passed across all passes.
 */
export function computeTotalChecksPassed(passes: PassTimelineEntry[]): number {
  return passes.reduce(
    (total, pass) => total + pass.verifyResults.filter((r) => r.passed).length,
    0,
  );
}

/**
 * Computes the total number of checks across all passes.
 */
export function computeTotalChecks(passes: PassTimelineEntry[]): number {
  return passes.reduce((total, pass) => total + pass.verifyResults.length, 0);
}

/**
 * Determines the state label for display in the header.
 */
export function getStateDisplayLabel(state: LoopState): string {
  switch (state) {
    case 'IDLE': return 'Idle';
    case 'PLANNING_PASS': return 'Planning…';
    case 'EXECUTING_PASS': return 'Executing…';
    case 'VERIFYING': return 'Verifying…';
    case 'APPLYING_FEEDBACK': return 'Applying Feedback…';
    case 'AWAITING_APPROVAL': return 'Awaiting Approval';
    case 'SUCCEEDED': return 'Succeeded';
    case 'NO_OP': return 'No-Op';
    case 'BLOCKED': return 'Blocked';
    case 'LIMIT_EXHAUSTED': return 'Limit Exhausted';
    case 'STALLED': return 'Stalled';
  }
}
