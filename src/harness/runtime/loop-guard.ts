/**
 * Loop Guard — Bounded runtime monitor for repeated calls, stalled progress,
 * and exhausted turn budgets.
 *
 * Detects equivalent tool calls exceeding configured consecutive-call threshold,
 * appends advisory evidence, enforces progress/token/cost/time/continuation budgets,
 * applies per-tool and per-route thresholds from validated settings, and records
 * triggering evidence, selected policy, and resulting action in Session_Log.
 *
 * Requirements: 7.1–7.5
 */

import { createHash } from 'crypto';
import {
  type LoopGuardConfig,
  type ToolCallIdentity,
  type LoopAdvisory,
  type LoopEscalationEvidence,
  type LoopGuardTerminalOutcome,
  type LoopGuardCheckResult,
  type BudgetUsage,
  type BudgetKind,
  type EscalationAction,
  type PerToolThreshold,
  LoopGuardConfigSchema,
} from './loop-guard-schemas';
import type { ContractRef } from '../contracts/primitives';

// ─── Errors ─────────────────────────────────────────────────────

export class LoopGuardError extends Error {
  constructor(
    message: string,
    public readonly code: LoopGuardErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LoopGuardError';
  }
}

export type LoopGuardErrorCode =
  | 'INVALID_CONFIG'
  | 'MODEL_STEPS_BLOCKED'
  | 'BUDGET_EXHAUSTED';

// ─── Session Log Port (dependency injection) ────────────────────

/**
 * Minimal port for appending loop-guard evidence to Session_Log.
 * Requirement 7.5: record triggering evidence, selected policy, and resulting action.
 */
export interface LoopGuardLogPort {
  appendAdvisory(advisory: LoopAdvisory): void;
  appendEscalation(evidence: LoopEscalationEvidence): void;
  appendTerminalOutcome(outcome: LoopGuardTerminalOutcome): void;
}

// ─── Budget Reporter Port ───────────────────────────────────────

/**
 * Port for querying current budget usage from external accounting services.
 */
export interface BudgetReporterPort {
  getUsage(kind: BudgetKind): number;
}

// ─── Loop Guard State (per-turn) ────────────────────────────────

interface ConsecutiveCallState {
  /** The most recently tracked tool call identity. */
  lastIdentity: ToolCallIdentity;
  /** How many consecutive equivalent calls have been observed. */
  count: number;
  /** Whether an advisory has been issued for this streak. */
  advisoryIssued: boolean;
  /** Calls after advisory was issued. */
  postAdvisoryCount: number;
}

// ─── Loop Guard ─────────────────────────────────────────────────

/**
 * Loop_Guard: the bounded runtime monitor that detects repeated equivalent
 * tool calls, monitors budgets, and escalates when configured thresholds
 * are exceeded.
 *
 * Requirements: 7.1–7.5
 */
export class LoopGuard {
  private readonly config: LoopGuardConfig;
  private readonly logPort: LoopGuardLogPort;
  private readonly budgetReporter: BudgetReporterPort;
  private readonly sessionId: string;
  private readonly turnId: string;

  /** Consecutive call tracking state. */
  private consecutiveState: ConsecutiveCallState | null = null;

  /** Whether model steps have been blocked (terminal). */
  private modelStepsBlocked = false;

  /** Counter for generating unique IDs. */
  private idCounter = 0;

  constructor(params: {
    config: LoopGuardConfig;
    logPort: LoopGuardLogPort;
    budgetReporter: BudgetReporterPort;
    sessionId: string;
    turnId: string;
  }) {
    // Validate configuration
    const parseResult = LoopGuardConfigSchema.safeParse(params.config);
    if (!parseResult.success) {
      throw new LoopGuardError(
        `Invalid Loop_Guard configuration: ${parseResult.error.message}`,
        'INVALID_CONFIG',
        { issues: parseResult.error.issues },
      );
    }

    this.config = parseResult.data;
    this.logPort = params.logPort;
    this.budgetReporter = params.budgetReporter;
    this.sessionId = params.sessionId;
    this.turnId = params.turnId;
  }

  /**
   * Check whether a tool call should proceed, issue an advisory,
   * escalate, or terminate the turn.
   *
   * Call this AFTER each tool call completes.
   *
   * Requirements:
   * - 7.1: Detect equivalent tool calls exceeding threshold → advisory
   * - 7.2: Grace count exhausted → escalate
   * - 7.3: Budget exhausted → stop + terminal outcome
   * - 7.4: Per-tool/route thresholds from settings
   * - 7.5: Record evidence to Session_Log
   */
  checkAfterToolCall(callIdentity: ToolCallIdentity): LoopGuardCheckResult {
    if (this.modelStepsBlocked) {
      throw new LoopGuardError(
        'Model steps are blocked — turn has been terminated by Loop_Guard',
        'MODEL_STEPS_BLOCKED',
      );
    }

    // 1. Check budgets first (Req 7.3)
    const budgetResult = this.checkBudgets();
    if (budgetResult) {
      return budgetResult;
    }

    // 2. Track consecutive equivalent calls (Req 7.1, 7.4)
    return this.trackConsecutiveCalls(callIdentity);
  }

  /**
   * Check budgets without a tool call (e.g., before starting a model step).
   * Requirement 7.3: Stop additional model steps when budgets exhausted.
   */
  checkBudgets(): LoopGuardCheckResult | null {
    if (this.modelStepsBlocked) {
      throw new LoopGuardError(
        'Model steps are blocked — turn has been terminated by Loop_Guard',
        'MODEL_STEPS_BLOCKED',
      );
    }

    for (const budget of this.config.budgets) {
      const currentUsage = this.budgetReporter.getUsage(budget.kind);
      if (currentUsage >= budget.limit) {
        return this.emitTerminalOutcome('budget_exhausted', budget.kind, currentUsage, budget.limit);
      }
    }

    return null;
  }

  /**
   * Query current budget usage snapshots.
   */
  getBudgetUsage(): BudgetUsage[] {
    return this.config.budgets.map((budget) => {
      const currentUsage = this.budgetReporter.getUsage(budget.kind);
      return {
        kind: budget.kind,
        currentUsage,
        limit: budget.limit,
        unit: budget.unit,
        exhausted: currentUsage >= budget.limit,
      };
    });
  }

  /**
   * Whether model steps have been permanently blocked for this turn.
   */
  isBlocked(): boolean {
    return this.modelStepsBlocked;
  }

  /**
   * Reset consecutive call tracking (e.g., when the model produces a
   * non-equivalent call, breaking the streak).
   */
  resetConsecutiveTracking(): void {
    this.consecutiveState = null;
  }

  // ─── Private: Consecutive Call Tracking ─────────────────────────

  /**
   * Track consecutive equivalent calls and determine advisory/escalation.
   */
  private trackConsecutiveCalls(callIdentity: ToolCallIdentity): LoopGuardCheckResult {
    const isEquivalent = this.isEquivalentCall(callIdentity);

    if (!isEquivalent) {
      // Non-equivalent call breaks the streak
      this.consecutiveState = {
        lastIdentity: callIdentity,
        count: 1,
        advisoryIssued: false,
        postAdvisoryCount: 0,
      };
      return { status: 'ok' };
    }

    // Equivalent call — increment count
    this.consecutiveState!.count++;

    const threshold = this.resolveThreshold(callIdentity);

    // Check if we need to issue an advisory (Req 7.1)
    if (
      !this.consecutiveState!.advisoryIssued &&
      this.consecutiveState!.count >= threshold.consecutiveCallThreshold
    ) {
      return this.emitAdvisory(callIdentity, threshold);
    }

    // Check if advisory grace count is exhausted (Req 7.2)
    if (this.consecutiveState!.advisoryIssued) {
      this.consecutiveState!.postAdvisoryCount++;

      if (this.consecutiveState!.postAdvisoryCount >= threshold.advisoryGraceCount) {
        return this.emitEscalation(callIdentity, threshold);
      }
    }

    return { status: 'ok' };
  }

  /**
   * Determine if a call is equivalent to the previous one.
   * Equivalence is based on tool contract + argument digest.
   */
  private isEquivalentCall(callIdentity: ToolCallIdentity): boolean {
    if (!this.consecutiveState) {
      return false;
    }

    const last = this.consecutiveState.lastIdentity;
    return (
      last.toolContract.name === callIdentity.toolContract.name &&
      last.toolContract.version === callIdentity.toolContract.version &&
      last.argumentDigest === callIdentity.argumentDigest
    );
  }

  /**
   * Resolve the threshold configuration for a specific tool/route.
   * Requirement 7.4: per-tool and per-route thresholds.
   */
  private resolveThreshold(callIdentity: ToolCallIdentity): PerToolThreshold {
    // Look for exact tool+route match
    const exactMatch = this.config.perToolThresholds.find(
      (t) =>
        t.toolContract &&
        t.toolContract.name === callIdentity.toolContract.name &&
        t.toolContract.version === callIdentity.toolContract.version &&
        (!t.routeId || t.routeId === callIdentity.routeId),
    );
    if (exactMatch) return exactMatch;

    // Look for tool-only match (any route)
    const toolMatch = this.config.perToolThresholds.find(
      (t) =>
        t.toolContract &&
        t.toolContract.name === callIdentity.toolContract.name &&
        t.toolContract.version === callIdentity.toolContract.version &&
        !t.routeId,
    );
    if (toolMatch) return toolMatch;

    // Look for route-only match (any tool)
    const routeMatch = this.config.perToolThresholds.find(
      (t) => !t.toolContract && t.routeId === callIdentity.routeId,
    );
    if (routeMatch) return routeMatch;

    // Default threshold
    return {
      consecutiveCallThreshold: this.config.defaultConsecutiveCallThreshold,
      advisoryGraceCount: this.config.defaultAdvisoryGraceCount,
      escalationAction: this.config.defaultEscalationAction,
    };
  }

  // ─── Private: Advisory Emission ─────────────────────────────────

  /**
   * Emit an advisory and append to Session_Log.
   * Requirement 7.1: append advisory with repeated call identities and remaining budgets.
   * Requirement 7.5: record to Session_Log.
   */
  private emitAdvisory(
    callIdentity: ToolCallIdentity,
    threshold: PerToolThreshold,
  ): LoopGuardCheckResult {
    this.consecutiveState!.advisoryIssued = true;
    this.consecutiveState!.postAdvisoryCount = 0;

    const advisory: LoopAdvisory = {
      type: 'loop_advisory',
      advisoryId: this.generateId('adv'),
      sessionId: this.sessionId,
      turnId: this.turnId,
      toolContract: callIdentity.toolContract,
      repeatedCallIdentities: [callIdentity],
      consecutiveCount: this.consecutiveState!.count,
      configuredThreshold: threshold.consecutiveCallThreshold,
      remainingBudgets: this.getBudgetUsage().map((b) => ({
        kind: b.kind,
        remaining: b.limit - b.currentUsage,
        limit: b.limit,
        unit: b.unit,
      })),
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.logPort.appendAdvisory(advisory);

    return { status: 'advisory', advisory };
  }

  // ─── Private: Escalation Emission ─────────────────────────────

  /**
   * Emit escalation when grace count is exhausted.
   * Requirement 7.2: request user intervention, enter Plan_Mode, or stop.
   * Requirement 7.5: record triggering evidence, selected policy, and resulting action.
   */
  private emitEscalation(
    callIdentity: ToolCallIdentity,
    threshold: PerToolThreshold,
  ): LoopGuardCheckResult {
    const action = threshold.escalationAction;

    const evidence: LoopEscalationEvidence = {
      type: 'loop_escalation',
      escalationId: this.generateId('esc'),
      sessionId: this.sessionId,
      turnId: this.turnId,
      reason: 'equivalent_calls_exhausted_grace',
      toolContract: callIdentity.toolContract,
      selectedPolicy: action,
      resultingAction: action,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.logPort.appendEscalation(evidence);

    // If escalation action is 'stop', also emit terminal outcome
    if (action === 'stop') {
      return this.emitTerminalFromEscalation(evidence);
    }

    return { status: 'escalation', evidence, action };
  }

  // ─── Private: Terminal Outcome Emission ─────────────────────────

  /**
   * Emit terminal outcome for budget exhaustion.
   * Requirement 7.3: stop additional model steps and emit structured terminal outcome.
   * Requirement 7.5: record to Session_Log.
   */
  private emitTerminalOutcome(
    reason: 'budget_exhausted',
    budgetKind: BudgetKind,
    currentUsage: number,
    configuredLimit: number,
  ): LoopGuardCheckResult {
    this.modelStepsBlocked = true;

    const evidence: LoopEscalationEvidence = {
      type: 'loop_escalation',
      escalationId: this.generateId('esc'),
      sessionId: this.sessionId,
      turnId: this.turnId,
      reason: 'budget_exhausted',
      exhaustedBudget: budgetKind,
      currentUsage,
      configuredLimit,
      selectedPolicy: 'stop',
      resultingAction: 'stop',
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.logPort.appendEscalation(evidence);

    const outcome: LoopGuardTerminalOutcome = {
      type: 'loop_guard_terminal',
      outcomeId: this.generateId('term'),
      sessionId: this.sessionId,
      turnId: this.turnId,
      reason: 'budget_exhausted',
      evidence,
      modelStepsBlocked: true,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.logPort.appendTerminalOutcome(outcome);

    return { status: 'terminal', outcome };
  }

  /**
   * Emit terminal outcome after an escalation action of 'stop'.
   */
  private emitTerminalFromEscalation(evidence: LoopEscalationEvidence): LoopGuardCheckResult {
    this.modelStepsBlocked = true;

    const outcome: LoopGuardTerminalOutcome = {
      type: 'loop_guard_terminal',
      outcomeId: this.generateId('term'),
      sessionId: this.sessionId,
      turnId: this.turnId,
      reason: evidence.reason,
      evidence,
      modelStepsBlocked: true,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.logPort.appendTerminalOutcome(outcome);

    return { status: 'terminal', outcome };
  }

  // ─── Private: Utility ─────────────────────────────────────────

  private generateId(prefix: string): string {
    this.idCounter++;
    return `${prefix}_${this.sessionId}_${this.turnId}_${this.idCounter}`;
  }
}

// ─── Utility: Compute Tool Call Identity ────────────────────────

/**
 * Compute a normalized argument digest for tool call equivalence comparison.
 * Uses deterministic JSON serialization + SHA-256.
 */
export function computeArgumentDigest(args: unknown): string {
  const normalized = JSON.stringify(args, Object.keys(args as Record<string, unknown>).sort());
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Create a ToolCallIdentity from a tool call's arguments and contract.
 */
export function createToolCallIdentity(
  toolContract: ContractRef,
  args: unknown,
  routeId?: string,
): ToolCallIdentity {
  return {
    toolContract,
    argumentDigest: computeArgumentDigest(args),
    routeId,
  };
}
