/**
 * Loop Run Panel — Barrel export for the Loop Run Panel component.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.6, 18.7
 */

// Component
export { LoopRunPanel, createLoopRunPanel } from './LoopRunPanel';

// Types
export type {
  LoopState,
  TerminalState,
  VerifyCheckType,
  VerifyCheckResult,
  PassTimelineEntry,
  EvidenceItem,
  LoopRunPanelProps,
  LoopRunPanelState,
  LoopPassStartEvent,
  LoopVerifyResultEvent,
  LoopStopEvent,
  LoopAwaitingApprovalEvent,
  LoopRunStatusResponse,
} from './loop-run-panel-types';

export { ACTIVE_STATES, TERMINAL_STATES } from './loop-run-panel-types';

// Pure state/logic functions (for external consumers and testing)
export {
  isActiveState,
  isTerminalState,
  isAwaitingApproval,
  isStopButtonEnabled,
  isApproveButtonEnabled,
  shouldShowApprovalBanner,
  shouldShowEvidenceAndCost,
  isLlmJudgeCheck,
  getCheckIcon,
  getStatusLabel,
  getStatusColor,
  formatCost,
  createInitialState,
  handlePassStart,
  handleVerifyResult,
  handleLoopStop,
  handleAwaitingApproval,
  handleStatusUpdate,
  computeTotalChecksPassed,
  computeTotalChecks,
  getStateDisplayLabel,
} from './loop-run-panel-state';
