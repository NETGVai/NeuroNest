/**
 * Types for the Loop Run Panel renderer component.
 * Defines state shapes and event payloads consumed by the panel UI.
 */

// ─── State Enums ────────────────────────────────────────────────

export type LoopState =
  | 'IDLE'
  | 'PLANNING_PASS'
  | 'EXECUTING_PASS'
  | 'VERIFYING'
  | 'APPLYING_FEEDBACK'
  | 'SUCCEEDED'
  | 'NO_OP'
  | 'AWAITING_APPROVAL'
  | 'BLOCKED'
  | 'LIMIT_EXHAUSTED'
  | 'STALLED';

export type TerminalState = 'SUCCEEDED' | 'NO_OP' | 'BLOCKED' | 'LIMIT_EXHAUSTED' | 'STALLED';

export const ACTIVE_STATES: LoopState[] = [
  'PLANNING_PASS',
  'EXECUTING_PASS',
  'VERIFYING',
  'APPLYING_FEEDBACK',
];

export const TERMINAL_STATES: TerminalState[] = [
  'SUCCEEDED',
  'NO_OP',
  'BLOCKED',
  'LIMIT_EXHAUSTED',
  'STALLED',
];

// ─── Verify Check Result ────────────────────────────────────────

export interface VerifyCheckResult {
  checkId: string;
  type: 'command' | 'llmJudge' | 'metric' | 'file';
  passed: boolean;
  output: string;
}

// ─── Pass Entry ─────────────────────────────────────────────────

export interface PassEntry {
  passNumber: number;
  actionSummary: string;
  verifyResults: VerifyCheckResult[];
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
}

// ─── Evidence ───────────────────────────────────────────────────

export interface EvidenceEntry {
  type: 'file' | 'inline';
  ref: string;
}

// ─── Panel State ────────────────────────────────────────────────

export interface LoopRunPanelState {
  runId: string | null;
  state: LoopState;
  passes: PassEntry[];
  evidence: EvidenceEntry[];
  costUsd: number;
  approvalReason: string | null;
  stopReason: string | null;
  timelineCollapsed: boolean;
}

// ─── IPC Events ─────────────────────────────────────────────────

export interface LoopPassStartEvent {
  run_id: string;
  pass_number: number;
  timestamp: string;
  action_summary: string;
}

export interface LoopVerifyResultEvent {
  run_id: string;
  pass_number: number;
  timestamp: string;
  results: VerifyCheckResult[];
}

export interface LoopStopEvent {
  run_id: string;
  final_status: TerminalState;
  stop_reason: string;
  timestamp: string;
  passes_completed: number;
}

export interface LoopAwaitingApprovalEvent {
  run_id: string;
  pass_number: number;
  timestamp: string;
  reason: string;
}

export interface LoopStatusUpdateEvent {
  state: LoopState;
  costUsd: number;
  evidence: EvidenceEntry[];
}
