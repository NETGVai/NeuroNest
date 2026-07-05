/**
 * Loop Run Panel — Type definitions for the renderer Loop Run Panel component.
 *
 * These types model the panel's internal state, props, and data transformations.
 * Separated from the DOM component for testability.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.6, 18.7
 */

// ─── Loop State (mirrored from loop-engine/index.ts for renderer use) ───

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

// ─── Active states where the loop is doing work ─────────────────

export const ACTIVE_STATES: readonly LoopState[] = [
  'PLANNING_PASS',
  'EXECUTING_PASS',
  'VERIFYING',
  'APPLYING_FEEDBACK',
] as const;

export const TERMINAL_STATES: readonly TerminalState[] = [
  'SUCCEEDED',
  'NO_OP',
  'BLOCKED',
  'LIMIT_EXHAUSTED',
  'STALLED',
] as const;

// ─── Verify Check Result ────────────────────────────────────────

export type VerifyCheckType = 'command' | 'metric' | 'file' | 'llmJudge';

export interface VerifyCheckResult {
  checkId: string;
  type: VerifyCheckType;
  passed: boolean;
  output: string;
}

// ─── Pass Entry (timeline item) ─────────────────────────────────

export interface PassTimelineEntry {
  passNumber: number;
  actionSummary: string;
  verifyResults: VerifyCheckResult[];
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
}

// ─── Evidence ───────────────────────────────────────────────────

export interface EvidenceItem {
  type: 'file' | 'inline';
  ref: string;
}

// ─── Panel Props (data flowing into the panel) ──────────────────

export interface LoopRunPanelProps {
  runId: string | null;
  state: LoopState;
  passes: PassTimelineEntry[];
  evidence: EvidenceItem[];
  costUsd: number;
  approvalReason: string | null;
  stopReason: string | null;
}

// ─── Panel Internal State ───────────────────────────────────────

export interface LoopRunPanelState {
  runId: string | null;
  state: LoopState;
  passes: PassTimelineEntry[];
  evidence: EvidenceItem[];
  costUsd: number;
  approvalReason: string | null;
  stopReason: string | null;
  timelineCollapsed: boolean;
}

// ─── IPC event payloads from main process ───────────────────────

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
  results: Array<{
    checkId: string;
    type: VerifyCheckType;
    passed: boolean;
    output: string;
  }>;
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

export interface LoopRunStatusResponse {
  state: LoopState;
  passesCompleted: number;
  costUsd: number;
  currentPass: number | null;
  evidence: EvidenceItem[];
}
