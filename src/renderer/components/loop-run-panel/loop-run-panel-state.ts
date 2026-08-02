/**
 * Pure state logic for the Loop Run Panel.
 * All functions are side-effect-free reducers operating on LoopRunPanelState.
 */

import type {
  LoopState,
  TerminalState,
  LoopRunPanelState,
  VerifyCheckResult,
  PassEntry,
  LoopPassStartEvent,
  LoopVerifyResultEvent,
  LoopStopEvent,
  LoopAwaitingApprovalEvent,
  LoopStatusUpdateEvent,
} from './loop-run-panel-types';

import { ACTIVE_STATES, TERMINAL_STATES } from './loop-run-panel-types';

// ─── State Predicates ───────────────────────────────────────────

export function isActiveState(state: LoopState): boolean {
  return (ACTIVE_STATES as string[]).includes(state);
}

export function isTerminalState(state: LoopState): boolean {
  return (TERMINAL_STATES as string[]).includes(state);
}

export function isAwaitingApproval(state: LoopState): boolean {
  return state === 'AWAITING_APPROVAL';
}

// ─── Button States ──────────────────────────────────────────────

export function isStopButtonEnabled(state: LoopState): boolean {
  return isActiveState(state);
}

export function isApproveButtonEnabled(state: LoopState): boolean {
  return isAwaitingApproval(state);
}

// ─── Visibility Logic ───────────────────────────────────────────

export function shouldShowApprovalBanner(state: LoopState): boolean {
  return isAwaitingApproval(state);
}

export function shouldShowEvidenceAndCost(state: LoopState): boolean {
  return isActiveState(state);
}

// ─── Verify Check Helpers ───────────────────────────────────────

export function isLlmJudgeCheck(check: VerifyCheckResult): boolean {
  return check.type === 'llmJudge';
}

export function getCheckIcon(passed: boolean): string {
  return passed ? '✅' : '❌';
}

// ─── Status Labels ──────────────────────────────────────────────

const STATUS_LABELS: Record<TerminalState, string> = {
  SUCCEEDED: 'Succeeded',
  NO_OP: 'No-Op (nothing to do)',
  BLOCKED: 'Blocked',
  LIMIT_EXHAUSTED: 'Limit Exhausted',
  STALLED: 'Stalled (no progress)',
};

export function getStatusLabel(state: TerminalState): string {
  return STATUS_LABELS[state] ?? state;
}

const STATUS_COLORS: Record<TerminalState, string> = {
  SUCCEEDED: '#22c55e',
  BLOCKED: '#ef4444',
  LIMIT_EXHAUSTED: '#f59e0b',
  STALLED: '#f59e0b',
  NO_OP: '#888',
};

export function getStatusColor(state: TerminalState): string {
  return STATUS_COLORS[state] ?? '#888';
}

// ─── Cost Formatting ────────────────────────────────────────────

export function formatCost(costUsd: number): string {
  if (costUsd === 0) return '$0.00';
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

// ─── State Display Labels ───────────────────────────────────────

const STATE_DISPLAY_LABELS: Record<LoopState, string> = {
  IDLE: 'Idle',
  PLANNING_PASS: 'Planning Pass',
  EXECUTING_PASS: 'Executing Pass',
  VERIFYING: 'Verifying',
  APPLYING_FEEDBACK: 'Applying Feedback',
  SUCCEEDED: 'Succeeded',
  NO_OP: 'No-Op',
  AWAITING_APPROVAL: 'Awaiting Approval',
  BLOCKED: 'Blocked',
  LIMIT_EXHAUSTED: 'Limit Exhausted',
  STALLED: 'Stalled',
};

export function getStateDisplayLabel(state: LoopState): string {
  return STATE_DISPLAY_LABELS[state] ?? state;
}

// ─── Initial State ──────────────────────────────────────────────

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

// ─── Event Handlers (Reducers) ──────────────────────────────────

export function handlePassStart(
  state: LoopRunPanelState,
  event: LoopPassStartEvent,
): LoopRunPanelState {
  // First event sets the runId
  const runId = state.runId ?? event.run_id;

  // Ignore events for a different run
  if (runId !== event.run_id) return state;

  const newPass: PassEntry = {
    passNumber: event.pass_number,
    actionSummary: event.action_summary,
    verifyResults: [],
    costUsd: 0,
    startedAt: event.timestamp,
    endedAt: null,
  };

  return {
    ...state,
    runId,
    passes: [...state.passes, newPass],
  };
}

export function handleVerifyResult(
  state: LoopRunPanelState,
  event: LoopVerifyResultEvent,
): LoopRunPanelState {
  if (state.runId !== event.run_id) return state;

  const passes = state.passes.map((pass) => {
    if (pass.passNumber === event.pass_number) {
      return {
        ...pass,
        verifyResults: event.results,
        endedAt: event.timestamp,
      };
    }
    return pass;
  });

  return { ...state, passes };
}

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

export function handleStatusUpdate(
  state: LoopRunPanelState,
  event: LoopStatusUpdateEvent,
): LoopRunPanelState {
  return {
    ...state,
    state: event.state,
    costUsd: event.costUsd,
    evidence: event.evidence,
  };
}

// ─── Computed Values ────────────────────────────────────────────

export function computeTotalChecksPassed(
  passes: Pick<PassEntry, 'verifyResults'>[],
): number {
  return passes.reduce(
    (total, pass) =>
      total + pass.verifyResults.filter((r) => r.passed).length,
    0,
  );
}

export function computeTotalChecks(
  passes: Pick<PassEntry, 'verifyResults'>[],
): number {
  return passes.reduce(
    (total, pass) => total + pass.verifyResults.length,
    0,
  );
}
