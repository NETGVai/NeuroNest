/**
 * ExecutionModeController — manages Autopilot/Supervised execution modes for the agent loop.
 *
 * - Autopilot: execute all tool calls without pausing for user confirmation.
 * - Supervised: pause after each turn that contains file edits, presenting changes
 *   as diff hunks for accept/reject/discuss before continuing.
 *
 * Supports mid-execution mode switching without losing execution state.
 *
 * Feature gate: production_ux_execution_modes
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */

import type { ApprovalRequest, ApprovalDecision, DiffHunk, ChangeSummary, FileChangeRecord } from '../shared/production-ux-types.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export type ExecutionModeType = 'autopilot' | 'supervised';

export interface ModeToggleState {
  currentMode: ExecutionModeType;
}

export interface ExecutionModeSnapshot {
  iteration: number;
  toolCallsExecuted: number;
  filesModified: string[];
  conversationLength: number;
}

export interface SupervisedPauseContext {
  sessionId: string;
  iteration: number;
  filesModified: string[];
  hunks: DiffHunk[];
}

// ─── ExecutionModeController ────────────────────────────────────

export class ExecutionModeController {
  private currentMode: ExecutionModeType;
  private executionState: ExecutionModeSnapshot | null = null;
  private paused = false;
  private pendingApproval: ApprovalRequest | null = null;
  private approvalResolver: ((decision: ApprovalDecision) => void) | null = null;
  private readonly featureGate: FeatureGateSystem | null;

  constructor(
    initialMode: ExecutionModeType = 'autopilot',
    featureGate?: FeatureGateSystem | null,
  ) {
    this.currentMode = initialMode;
    this.featureGate = featureGate ?? null;
  }

  /**
   * Get the current execution mode.
   */
  getMode(): ExecutionModeType {
    return this.currentMode;
  }

  /**
   * Get the full toggle state for the renderer.
   */
  getState(): ModeToggleState {
    return { currentMode: this.currentMode };
  }

  /**
   * Whether the controller is currently paused waiting for approval.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Switch mode mid-execution. Preserves all execution state.
   *
   * Requirements: 15.5
   */
  switchMode(newMode: ExecutionModeType): ExecutionModeSnapshot | null {
    if (newMode === this.currentMode) return this.executionState;

    this.currentMode = newMode;

    // State is preserved — no mutation of execution state on switch
    return this.executionState;
  }

  /**
   * Update the execution state snapshot. Called by the agent loop on each iteration
   * to keep the controller informed of current progress.
   */
  updateExecutionState(snapshot: ExecutionModeSnapshot): void {
    this.executionState = { ...snapshot };
  }

  /**
   * Get the preserved execution state.
   */
  getExecutionState(): ExecutionModeSnapshot | null {
    return this.executionState ? { ...this.executionState } : null;
  }

  /**
   * Determine whether the agent loop should pause after a turn with file edits.
   *
   * In autopilot mode: never pause (Requirement 15.2).
   * In supervised mode: pause when file edits occurred in this turn (Requirement 15.3).
   *
   * Returns true if the loop should pause and request approval.
   */
  shouldPauseAfterTurn(turnHadFileEdits: boolean): boolean {
    if (!this.isEnabled()) return false;

    if (this.currentMode === 'autopilot') {
      return false;
    }

    // Supervised mode: pause only when file edits happened
    return turnHadFileEdits;
  }

  /**
   * Request approval from the user for file changes made in supervised mode.
   * Returns a promise that resolves when the user decides (accept/reject/selective).
   *
   * Requirements: 15.3, 15.4
   */
  async requestApproval(context: SupervisedPauseContext): Promise<ApprovalDecision> {
    this.paused = true;

    const changeSummary: ChangeSummary = {
      sessionId: context.sessionId,
      created: [],
      modified: context.filesModified.map((fp) => ({
        filePath: fp,
        timestamp: Date.now(),
        toolCallId: `turn-${context.iteration}`,
      })),
      deleted: [],
      totalToolCalls: 0,
      totalIterations: context.iteration,
      durationMs: 0,
    };

    this.pendingApproval = {
      sessionId: context.sessionId,
      changeSummary,
      hunks: context.hunks,
      mode: 'per-hunk',
    };

    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalResolver = resolve;
    });
  }

  /**
   * Resolve a pending approval request with the user's decision.
   * Called when the renderer sends back an approval response.
   */
  resolveApproval(decision: ApprovalDecision): boolean {
    if (!this.approvalResolver || !this.paused) return false;

    this.paused = false;
    this.pendingApproval = null;

    const resolver = this.approvalResolver;
    this.approvalResolver = null;
    resolver(decision);

    return true;
  }

  /**
   * Get the pending approval request (for the renderer to display).
   */
  getPendingApproval(): ApprovalRequest | null {
    return this.pendingApproval;
  }

  /**
   * Check whether the execution modes feature is enabled via the feature gate.
   */
  isEnabled(): boolean {
    if (!this.featureGate) return true; // If no gate, assume enabled
    return this.featureGate.isEnabled('production_ux_execution_modes');
  }

  /**
   * Reset controller state (for new task sessions).
   */
  reset(): void {
    this.executionState = null;
    this.paused = false;
    this.pendingApproval = null;
    this.approvalResolver = null;
  }
}
