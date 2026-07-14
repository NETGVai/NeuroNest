/**
 * CostBudgetEnforcer — Session Budget Enforcement with Model Downgrade.
 *
 * Builds on top of the existing CostTrackingService to provide:
 * - Real-time accumulated cost tracking per session
 * - Execution abort when per-session limit is reached (default: $5.00, configurable)
 * - Warning emission at 80% of budget with user-facing alert
 * - Automatic model downgrade to cheaper tier when >90% of budget used
 * - Subagent cost propagation to parent session budget
 *
 * Follows NeuroNest's lazy-initialized TypeScript singleton pattern.
 * Feature-gated behind `cost_controls` (requires `cost_tracking`).
 *
 * Requirements: 22.1, 22.3, 22.4, 22.6
 */

import type { CostTrackingService } from './cost-tracking-service.js';
import type { TaskTier } from '../pipeline/tier-router.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** Configuration for the cost budget enforcer */
export interface CostBudgetConfig {
  /** Per-session USD limit. Execution aborts when reached. Default: $5.00. */
  sessionLimitUsd: number;
  /** Threshold (0.0–1.0) at which a warning alert is emitted. Default: 0.80. */
  warningThreshold: number;
  /** Threshold (0.0–1.0) at which model downgrade activates. Default: 0.90. */
  downgradeThreshold: number;
  /** Model to downgrade to when budget threshold is exceeded. */
  downgradeModel: ModelIdentifier;
}

/** Model identifier for routing */
export interface ModelIdentifier {
  provider: string;
  model: string;
}

/** Budget status snapshot returned after each cost event */
export interface BudgetStatus {
  /** Accumulated session cost in USD */
  sessionCostUsd: number;
  /** Configured session limit in USD */
  sessionLimitUsd: number;
  /** Percentage of budget used (0.0–1.0) */
  usageRatio: number;
  /** Whether the warning threshold has been reached */
  warningReached: boolean;
  /** Whether the downgrade threshold has been reached */
  downgradeActive: boolean;
  /** Whether the budget has been fully exhausted */
  budgetExhausted: boolean;
  /** The currently recommended model tier or override */
  activeModel: ModelIdentifier | null;
}

/** Event types emitted by the budget enforcer */
export type BudgetEventType =
  | 'budget-warning'
  | 'budget-exhausted'
  | 'model-downgraded'
  | 'subagent-cost-propagated';

/** Budget event payload */
export interface BudgetEvent {
  type: BudgetEventType;
  sessionId: string;
  message: string;
  sessionCostUsd: number;
  sessionLimitUsd: number;
  usageRatio: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Listener callback type for budget events */
export type BudgetEventListener = (event: BudgetEvent) => void;

/** Error thrown when budget is exhausted and execution should abort */
export class BudgetExhaustedError extends Error {
  public readonly sessionCostUsd: number;
  public readonly sessionLimitUsd: number;

  constructor(sessionCostUsd: number, sessionLimitUsd: number) {
    super(
      `Session budget exhausted: $${sessionCostUsd.toFixed(4)} spent of $${sessionLimitUsd.toFixed(2)} limit. Execution aborted.`,
    );
    this.name = 'BudgetExhaustedError';
    this.sessionCostUsd = sessionCostUsd;
    this.sessionLimitUsd = sessionLimitUsd;
  }
}

// ─── Default Configuration ──────────────────────────────────────

export const DEFAULT_BUDGET_CONFIG: CostBudgetConfig = {
  sessionLimitUsd: 5.0,
  warningThreshold: 0.8,
  downgradeThreshold: 0.9,
  downgradeModel: {
    provider: 'openai',
    model: 'gpt-4o-mini',
  },
};

// ─── CostBudgetEnforcer ─────────────────────────────────────────

export class CostBudgetEnforcer {
  private sessionCostUsd = 0;
  private config: CostBudgetConfig;
  private warningEmitted = false;
  private downgradeActivated = false;
  private listeners: BudgetEventListener[] = [];
  private sessionId: string;
  private readonly costTrackingService: CostTrackingService | null;

  constructor(
    sessionId: string,
    config?: Partial<CostBudgetConfig>,
    costTrackingService?: CostTrackingService | null,
  ) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
    this.costTrackingService = costTrackingService ?? null;
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Get the underlying CostTrackingService reference (if configured).
   * Useful for deeper cost analytics integration.
   */
  getCostTrackingService(): CostTrackingService | null {
    return this.costTrackingService;
  }

  /**
   * Record a cost event and enforce budget rules.
   *
   * Tracks accumulated cost, emits warnings at 80%, activates model downgrade
   * at 90%, and throws BudgetExhaustedError at 100%.
   *
   * Requirements: 22.1, 22.3, 22.4
   */
  recordCost(costUsd: number, _model?: string, _provider?: string, _callId?: string): BudgetStatus {
    this.sessionCostUsd += costUsd;

    const status = this.computeStatus();

    // Emit warning at 80% threshold (once)
    if (status.warningReached && !this.warningEmitted) {
      this.warningEmitted = true;
      this.emitEvent({
        type: 'budget-warning',
        sessionId: this.sessionId,
        message: `Session cost ($${this.sessionCostUsd.toFixed(4)}) has reached ${Math.round(this.config.warningThreshold * 100)}% of the $${this.config.sessionLimitUsd.toFixed(2)} budget. Consider increasing the limit or aborting.`,
        sessionCostUsd: this.sessionCostUsd,
        sessionLimitUsd: this.config.sessionLimitUsd,
        usageRatio: status.usageRatio,
        timestamp: new Date().toISOString(),
      });
    }

    // Activate model downgrade at 90% threshold (once)
    if (status.downgradeActive && !this.downgradeActivated) {
      this.downgradeActivated = true;
      this.emitEvent({
        type: 'model-downgraded',
        sessionId: this.sessionId,
        message: `Session cost ($${this.sessionCostUsd.toFixed(4)}) exceeds ${Math.round(this.config.downgradeThreshold * 100)}% of budget. Switching to cheaper model: ${this.config.downgradeModel.provider}/${this.config.downgradeModel.model}.`,
        sessionCostUsd: this.sessionCostUsd,
        sessionLimitUsd: this.config.sessionLimitUsd,
        usageRatio: status.usageRatio,
        timestamp: new Date().toISOString(),
        metadata: {
          downgradeModel: this.config.downgradeModel,
        },
      });
    }

    // Abort execution at 100% budget
    if (status.budgetExhausted) {
      this.emitEvent({
        type: 'budget-exhausted',
        sessionId: this.sessionId,
        message: `Session budget exhausted: $${this.sessionCostUsd.toFixed(4)} of $${this.config.sessionLimitUsd.toFixed(2)}. Aborting execution.`,
        sessionCostUsd: this.sessionCostUsd,
        sessionLimitUsd: this.config.sessionLimitUsd,
        usageRatio: status.usageRatio,
        timestamp: new Date().toISOString(),
      });

      throw new BudgetExhaustedError(this.sessionCostUsd, this.config.sessionLimitUsd);
    }

    return status;
  }

  /**
   * Check budget before an LLM call. Returns the status without recording cost.
   * Useful for pre-flight budget checks.
   *
   * Requirements: 22.1
   */
  checkBudget(): BudgetStatus {
    return this.computeStatus();
  }

  /**
   * Propagate subagent cost to the parent session budget.
   * Called when a subagent completes and reports its total cost.
   *
   * Requirements: 22.6
   */
  propagateSubagentCost(subagentSessionId: string, costUsd: number): BudgetStatus {
    this.sessionCostUsd += costUsd;

    this.emitEvent({
      type: 'subagent-cost-propagated',
      sessionId: this.sessionId,
      message: `Subagent ${subagentSessionId} cost ($${costUsd.toFixed(4)}) propagated to parent session. Total: $${this.sessionCostUsd.toFixed(4)}.`,
      sessionCostUsd: this.sessionCostUsd,
      sessionLimitUsd: this.config.sessionLimitUsd,
      usageRatio: this.computeUsageRatio(),
      timestamp: new Date().toISOString(),
      metadata: {
        subagentSessionId,
        subagentCostUsd: costUsd,
      },
    });

    // Re-check thresholds after propagation
    const status = this.computeStatus();

    if (status.warningReached && !this.warningEmitted) {
      this.warningEmitted = true;
      this.emitEvent({
        type: 'budget-warning',
        sessionId: this.sessionId,
        message: `Session cost ($${this.sessionCostUsd.toFixed(4)}) has reached ${Math.round(this.config.warningThreshold * 100)}% of the $${this.config.sessionLimitUsd.toFixed(2)} budget after subagent cost propagation.`,
        sessionCostUsd: this.sessionCostUsd,
        sessionLimitUsd: this.config.sessionLimitUsd,
        usageRatio: status.usageRatio,
        timestamp: new Date().toISOString(),
      });
    }

    if (status.downgradeActive && !this.downgradeActivated) {
      this.downgradeActivated = true;
      this.emitEvent({
        type: 'model-downgraded',
        sessionId: this.sessionId,
        message: `Session cost exceeds ${Math.round(this.config.downgradeThreshold * 100)}% of budget after subagent costs. Switching to cheaper model.`,
        sessionCostUsd: this.sessionCostUsd,
        sessionLimitUsd: this.config.sessionLimitUsd,
        usageRatio: status.usageRatio,
        timestamp: new Date().toISOString(),
        metadata: { downgradeModel: this.config.downgradeModel },
      });
    }

    if (status.budgetExhausted) {
      this.emitEvent({
        type: 'budget-exhausted',
        sessionId: this.sessionId,
        message: `Session budget exhausted after subagent cost propagation. Aborting.`,
        sessionCostUsd: this.sessionCostUsd,
        sessionLimitUsd: this.config.sessionLimitUsd,
        usageRatio: status.usageRatio,
        timestamp: new Date().toISOString(),
      });

      throw new BudgetExhaustedError(this.sessionCostUsd, this.config.sessionLimitUsd);
    }

    return status;
  }

  /**
   * Get the model that should be used for the next LLM call.
   * Returns the downgrade model when budget exceeds 90%, null otherwise.
   *
   * Requirements: 22.4
   */
  getRecommendedModel(): ModelIdentifier | null {
    if (this.downgradeActivated || this.computeUsageRatio() >= this.config.downgradeThreshold) {
      return this.config.downgradeModel;
    }
    return null;
  }

  /**
   * Get the recommended task tier based on current budget state.
   * Returns 'fast' when model downgrade is active, null otherwise.
   *
   * Requirements: 22.4
   */
  getRecommendedTier(): TaskTier | null {
    if (this.downgradeActivated || this.computeUsageRatio() >= this.config.downgradeThreshold) {
      return 'fast';
    }
    return null;
  }

  /**
   * Get the current session cost in USD.
   */
  getSessionCost(): number {
    return this.sessionCostUsd;
  }

  /**
   * Get the current budget configuration.
   */
  getConfig(): Readonly<CostBudgetConfig> {
    return { ...this.config };
  }

  /**
   * Update the budget configuration at runtime (e.g., user increases limit).
   *
   * Requirements: 22.1 (configurable)
   */
  updateConfig(updates: Partial<CostBudgetConfig>): void {
    this.config = { ...this.config, ...updates };

    // Reset emission flags if the limit was increased past current thresholds
    const ratio = this.computeUsageRatio();
    if (ratio < this.config.warningThreshold) {
      this.warningEmitted = false;
    }
    if (ratio < this.config.downgradeThreshold) {
      this.downgradeActivated = false;
    }
  }

  /**
   * Reset the session (e.g., when starting a new session).
   */
  resetSession(newSessionId?: string): void {
    this.sessionCostUsd = 0;
    this.warningEmitted = false;
    this.downgradeActivated = false;
    if (newSessionId) {
      this.sessionId = newSessionId;
    }
  }

  /**
   * Register a listener for budget events.
   */
  onBudgetEvent(listener: BudgetEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Remove all listeners.
   */
  removeAllListeners(): void {
    this.listeners = [];
  }

  // ─── Private ────────────────────────────────────────────────

  private computeUsageRatio(): number {
    if (this.config.sessionLimitUsd <= 0) return 0;
    return this.sessionCostUsd / this.config.sessionLimitUsd;
  }

  private computeStatus(): BudgetStatus {
    const usageRatio = this.computeUsageRatio();
    const warningReached = usageRatio >= this.config.warningThreshold;
    const downgradeActive = usageRatio >= this.config.downgradeThreshold;
    const budgetExhausted = usageRatio >= 1.0;

    return {
      sessionCostUsd: this.sessionCostUsd,
      sessionLimitUsd: this.config.sessionLimitUsd,
      usageRatio,
      warningReached,
      downgradeActive,
      budgetExhausted,
      activeModel: downgradeActive ? this.config.downgradeModel : null,
    };
  }

  private emitEvent(event: BudgetEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Graceful degradation: listener failure doesn't interrupt budget enforcement
      }
    }
  }
}

// ─── Singleton Factory ──────────────────────────────────────────

let instance: CostBudgetEnforcer | null = null;

/**
 * Get or create the CostBudgetEnforcer singleton.
 * Follows lazy-initialization pattern used across NeuroNest.
 */
export function getCostBudgetEnforcer(
  sessionId?: string,
  config?: Partial<CostBudgetConfig>,
  costTrackingService?: CostTrackingService | null,
): CostBudgetEnforcer {
  if (!instance) {
    instance = new CostBudgetEnforcer(
      sessionId ?? `session_${Date.now()}`,
      config,
      costTrackingService,
    );
  }
  return instance;
}

/**
 * Reset the singleton (for testing or session boundaries).
 */
export function resetCostBudgetEnforcer(): void {
  if (instance) {
    instance.removeAllListeners();
  }
  instance = null;
}
