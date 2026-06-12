/**
 * Token Budget Enforcer — Per-swarm token and cost budget enforcement.
 *
 * Tracks cumulative token usage per swarm, issues a warning callback at 80%
 * budget consumption (retroactively if a single request jumps past), pauses
 * execution at 100% requiring user approval to continue, and calculates
 * cumulative cost for display in the user's configured currency.
 *
 * Persists per-swarm usage to the `swarm_token_usage` SQLite table.
 *
 * Design: see `.kiro/specs/codebase-hardening/design.md` (Pillar 4, §14)
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5
 */

export interface TokenBudgetConfig {
  /** Maximum tokens allowed per swarm (default: 500,000) */
  maxTokens: number;
  /** Fraction at which to issue a warning (default: 0.8) */
  warningThreshold: number;
  /** User's preferred currency code for display */
  currencyCode: string;
  /** Cost per token from active model config */
  perTokenPrice: number;
}

export interface BudgetStatus {
  /** Total tokens consumed so far */
  consumed: number;
  /** Remaining tokens before budget limit */
  remaining: number;
  /** Consumption as a fraction of budget (0.0 to 1.0+) */
  percentage: number;
  /** Estimated cost = consumed × perTokenPrice */
  estimatedCost: number;
  /** Whether a warning has already been issued for this swarm */
  warningIssued: boolean;
  /** Whether execution is paused (at 100% budget) */
  paused: boolean;
}

export interface SwarmTokenUsageRecord {
  swarmId: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  budgetLimit: number;
  warningIssued: boolean;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export type WarningCallback = (swarmId: string, status: BudgetStatus) => void;
export type PauseCallback = (swarmId: string, status: BudgetStatus) => void;

const DEFAULT_MAX_TOKENS = 500_000;
const DEFAULT_WARNING_THRESHOLD = 0.8;

export class TokenBudgetEnforcer {
  private config: TokenBudgetConfig;
  private swarmUsage: Map<string, { totalTokens: number; promptTokens: number; completionTokens: number; warningIssued: boolean; paused: boolean }>;
  private onWarning: WarningCallback | null;
  private onPause: PauseCallback | null;

  constructor(config?: Partial<TokenBudgetConfig>) {
    this.config = {
      maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS,
      warningThreshold: config?.warningThreshold ?? DEFAULT_WARNING_THRESHOLD,
      currencyCode: config?.currencyCode ?? 'USD',
      perTokenPrice: config?.perTokenPrice ?? 0,
    };
    this.swarmUsage = new Map();
    this.onWarning = null;
    this.onPause = null;
  }

  /**
   * Register a callback invoked when a swarm crosses the warning threshold.
   */
  setWarningCallback(cb: WarningCallback): void {
    this.onWarning = cb;
  }

  /**
   * Register a callback invoked when a swarm reaches 100% budget and is paused.
   */
  setPauseCallback(cb: PauseCallback): void {
    this.onPause = cb;
  }

  /**
   * Update the budget configuration.
   */
  updateConfig(config: Partial<TokenBudgetConfig>): void {
    if (config.maxTokens !== undefined) this.config.maxTokens = config.maxTokens;
    if (config.warningThreshold !== undefined) this.config.warningThreshold = config.warningThreshold;
    if (config.currencyCode !== undefined) this.config.currencyCode = config.currencyCode;
    if (config.perTokenPrice !== undefined) this.config.perTokenPrice = config.perTokenPrice;
  }

  /**
   * Get the current budget configuration.
   */
  getConfig(): Readonly<TokenBudgetConfig> {
    return { ...this.config };
  }

  /**
   * Record token consumption for a swarm. Returns the updated BudgetStatus.
   *
   * This method:
   * 1. Adds the consumed tokens to the running total
   * 2. Issues a warning (exactly once) when cumulative consumption first crosses warningThreshold × maxTokens
   *    — retroactively if a single request jumps past
   * 3. Pauses (sets paused=true) when cumulative consumption reaches or exceeds maxTokens
   */
  recordUsage(swarmId: string, promptTokens: number, completionTokens: number): BudgetStatus {
    let usage = this.swarmUsage.get(swarmId);
    if (!usage) {
      usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, warningIssued: false, paused: false };
      this.swarmUsage.set(swarmId, usage);
    }

    const tokensConsumed = promptTokens + completionTokens;
    usage.totalTokens += tokensConsumed;
    usage.promptTokens += promptTokens;
    usage.completionTokens += completionTokens;

    const status = this.computeStatus(swarmId);

    // Issue warning at threshold (retroactively if jumped past)
    if (!usage.warningIssued && status.percentage >= this.config.warningThreshold) {
      usage.warningIssued = true;
      status.warningIssued = true;
      if (this.onWarning) {
        this.onWarning(swarmId, { ...status });
      }
    }

    // Pause at 100% budget
    if (!usage.paused && usage.totalTokens >= this.config.maxTokens) {
      usage.paused = true;
      status.paused = true;
      if (this.onPause) {
        this.onPause(swarmId, { ...status });
      }
    }

    return status;
  }

  /**
   * Compute the current budget status for a swarm without recording any usage.
   */
  getStatus(swarmId: string): BudgetStatus {
    return this.computeStatus(swarmId);
  }

  /**
   * Check whether a swarm is currently paused (at or over budget).
   */
  isPaused(swarmId: string): boolean {
    const usage = this.swarmUsage.get(swarmId);
    return usage?.paused ?? false;
  }

  /**
   * Approve continuation after a pause — resets the paused flag so the swarm can continue.
   * Optionally increases the budget by additionalTokens.
   */
  approveResumption(swarmId: string, additionalTokens?: number): BudgetStatus {
    const usage = this.swarmUsage.get(swarmId);
    if (usage) {
      usage.paused = false;
    }
    if (additionalTokens && additionalTokens > 0) {
      this.config.maxTokens += additionalTokens;
    }
    return this.computeStatus(swarmId);
  }

  /**
   * Reset usage tracking for a swarm.
   */
  resetSwarm(swarmId: string): void {
    this.swarmUsage.delete(swarmId);
  }

  /**
   * Calculate cost for a given token count using the configured per-token price.
   */
  calculateCost(tokens: number): number {
    return tokens * this.config.perTokenPrice;
  }

  /**
   * Persist the current usage for a swarm to SQLite.
   * Uses the `swarm_token_usage` table schema from the design.
   */
  persistUsage(db: any, swarmId: string): void {
    const usage = this.swarmUsage.get(swarmId);
    if (!usage) return;

    const now = new Date().toISOString();
    const estimatedCost = this.calculateCost(usage.totalTokens);

    db.prepare(`
      INSERT OR REPLACE INTO swarm_token_usage
        (swarm_id, total_tokens, prompt_tokens, completion_tokens, estimated_cost_usd, budget_limit, warning_issued, paused, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM swarm_token_usage WHERE swarm_id = ?), ?), ?)
    `).run(
      swarmId,
      usage.totalTokens,
      usage.promptTokens,
      usage.completionTokens,
      estimatedCost,
      this.config.maxTokens,
      usage.warningIssued ? 1 : 0,
      usage.paused ? 1 : 0,
      swarmId,
      now,
      now,
    );
  }

  /**
   * Load persisted usage for a swarm from SQLite. Returns null if not found.
   */
  loadUsage(db: any, swarmId: string): SwarmTokenUsageRecord | null {
    const row = db.prepare('SELECT * FROM swarm_token_usage WHERE swarm_id = ?').get(swarmId) as any;
    if (!row) return null;

    return {
      swarmId: row.swarm_id,
      totalTokens: row.total_tokens,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      estimatedCostUsd: row.estimated_cost_usd,
      budgetLimit: row.budget_limit,
      warningIssued: !!row.warning_issued,
      paused: !!row.paused,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Restore in-memory state from a persisted record.
   */
  restoreFromRecord(record: SwarmTokenUsageRecord): void {
    this.swarmUsage.set(record.swarmId, {
      totalTokens: record.totalTokens,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      warningIssued: record.warningIssued,
      paused: record.paused,
    });
  }

  /**
   * Ensure the swarm_token_usage table exists in the given database.
   */
  static ensureTable(db: any): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_token_usage (
        swarm_id TEXT PRIMARY KEY,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
        budget_limit INTEGER NOT NULL,
        warning_issued INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  private computeStatus(swarmId: string): BudgetStatus {
    const usage = this.swarmUsage.get(swarmId);
    const consumed = usage?.totalTokens ?? 0;
    const remaining = Math.max(0, this.config.maxTokens - consumed);
    const percentage = this.config.maxTokens > 0 ? consumed / this.config.maxTokens : 0;
    const estimatedCost = this.calculateCost(consumed);

    return {
      consumed,
      remaining,
      percentage,
      estimatedCost,
      warningIssued: usage?.warningIssued ?? false,
      paused: usage?.paused ?? false,
    };
  }
}
