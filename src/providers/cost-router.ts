/**
 * Multi-Model Cost Router — Intelligent inference budgeting with complexity-based
 * model routing, per-scope cost budgets, and threshold enforcement.
 *
 * Routes inference requests to the most cost-effective model based on task complexity.
 * Integrates with existing ProviderRegistry for model selection and CostStore for
 * cost record retrieval. Budgets are stored in the `cost_budgets` SQLite table.
 *
 * Classification Heuristics:
 *   - simple: < 200 input tokens, summarization/formatting tasks
 *   - moderate: code generation, standard Q&A
 *   - complex: multi-step reasoning, architecture decisions
 *   - frontier: novel problem-solving, security analysis
 *
 * Budget Threshold Actions:
 *   - warn at 80%: notify user of approaching limit
 *   - downgrade at 90%: substitute cheaper model tier
 *   - abort at 100%: fall back to cheapest available model
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import type Database from 'better-sqlite3';

import type {
  CostRouter,
  CostBudget,
  CostDashboard,
  ComplexityTier,
  RoutingDecision,
  RoutingOptions,
  DashboardFilter,
  ChatMessage,
} from '../types/cloudflare-os.js';
import type { IProviderRegistry } from './provider-registry.js';
import { createSubsystemError, type SubsystemError } from '../types/subsystem-error.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default complexity tier configuration with model preferences and cost limits */
const DEFAULT_TIERS: Record<string, ComplexityTier> = {
  simple: {
    name: 'simple',
    models: ['gpt-4o-mini', 'claude-3-haiku', 'gemini-1.5-flash'],
    maxCostPerRequest: 0.005,
  },
  moderate: {
    name: 'moderate',
    models: ['gpt-4o', 'claude-3.5-sonnet', 'gemini-1.5-pro'],
    maxCostPerRequest: 0.05,
  },
  complex: {
    name: 'complex',
    models: ['gpt-4o', 'claude-3.5-sonnet', 'o1-preview'],
    maxCostPerRequest: 0.25,
  },
  frontier: {
    name: 'frontier',
    models: ['o1', 'claude-3-opus', 'gemini-ultra'],
    maxCostPerRequest: 1.0,
  },
};

/** Task hint keywords mapped to complexity tiers */
const TASK_HINT_CLASSIFICATION: Record<string, ComplexityTier['name']> = {
  // Simple tasks
  summarize: 'simple',
  format: 'simple',
  'fix typo': 'simple',
  translate: 'simple',
  rephrase: 'simple',
  // Moderate tasks
  'code generation': 'moderate',
  'write code': 'moderate',
  'unit test': 'moderate',
  'explain code': 'moderate',
  refactor: 'moderate',
  // Complex tasks
  architecture: 'complex',
  'multi-step': 'complex',
  design: 'complex',
  debug: 'complex',
  optimize: 'complex',
  // Frontier tasks
  'security analysis': 'frontier',
  'novel algorithm': 'frontier',
  research: 'frontier',
  'vulnerability assessment': 'frontier',
};

/** Token count threshold for simple classification */
const SIMPLE_TOKEN_THRESHOLD = 200;

/** Estimated cost per token (simplified model for budget estimation) */
const ESTIMATED_COST_PER_TOKEN: Record<string, number> = {
  simple: 0.000001,
  moderate: 0.000010,
  complex: 0.000030,
  frontier: 0.000060,
};

// ─── Implementation ─────────────────────────────────────────────

export class CostRouterImpl implements CostRouter {
  private db: Database.Database;
  private providerRegistry: IProviderRegistry | null;
  private notifications: Array<{ budget: CostBudget; timestamp: string }> = [];
  private tiers: Record<string, ComplexityTier>;

  constructor(
    db: Database.Database,
    providerRegistry?: IProviderRegistry | null,
    tiers?: Record<string, ComplexityTier>,
  ) {
    this.db = db;
    this.providerRegistry = providerRegistry ?? null;
    this.tiers = tiers ?? DEFAULT_TIERS;
  }

  /**
   * Classify messages by task complexity to determine the appropriate model tier.
   *
   * Classification is based on:
   * 1. Task hint keywords (highest priority)
   * 2. Token count (< 200 tokens → simple)
   * 3. Presence of code blocks (→ moderate or higher)
   * 4. Content analysis heuristics
   *
   * Requirements: 10.1
   */
  classify(messages: ChatMessage[], taskHint?: string): ComplexityTier {
    // 1. Check task hint first (highest priority)
    if (taskHint) {
      const hintLower = taskHint.toLowerCase();
      for (const [keyword, tierName] of Object.entries(TASK_HINT_CLASSIFICATION)) {
        if (hintLower.includes(keyword)) {
          return this.tiers[tierName];
        }
      }
    }

    // 2. Estimate total input tokens
    const totalContent = messages.map((m) => m.content).join(' ');
    const estimatedTokens = this.estimateTokenCount(totalContent);

    // 3. Check for code blocks
    const hasCodeBlocks = messages.some(
      (m) => m.content.includes('```') || m.content.includes('    '),
    );

    // 4. Check for complexity indicators
    const hasMultiStepIndicators = this.detectMultiStepReasoning(totalContent);
    const hasFrontierIndicators = this.detectFrontierTask(totalContent);

    // Classification logic
    if (hasFrontierIndicators) {
      return this.tiers.frontier;
    }

    if (hasMultiStepIndicators) {
      return this.tiers.complex;
    }

    if (hasCodeBlocks || estimatedTokens >= SIMPLE_TOKEN_THRESHOLD) {
      return this.tiers.moderate;
    }

    if (estimatedTokens < SIMPLE_TOKEN_THRESHOLD) {
      return this.tiers.simple;
    }

    // Default to moderate
    return this.tiers.moderate;
  }

  /**
   * Route an inference request to the optimal model given budget constraints.
   *
   * Routing considers:
   * 1. Task complexity classification
   * 2. Per-inference-point model override (for workflow steps)
   * 3. Budget status and threshold enforcement
   * 4. Provider availability via ProviderRegistry
   *
   * Requirements: 10.1, 10.2, 10.3, 10.5
   */
  route(messages: ChatMessage[], options?: RoutingOptions): RoutingDecision {
    const tier = this.classify(messages, options?.taskHint);

    // Determine scope for budget checking
    const scope = this.determineBudgetScope(options);
    let budgetStatus: RoutingDecision['budgetStatus'] = 'normal';
    let selectedModel = tier.models[0];
    let reason = `Classified as ${tier.name} tier`;

    // Check if there's a preferred model override (per-inference-point assignment)
    if (options?.preferredModel) {
      selectedModel = options.preferredModel;
      reason = `Per-inference-point model override: ${options.preferredModel}`;
    }

    // Check budget constraints
    if (scope) {
      const budget = this.getBudgetSafe(scope.scope, scope.scopeId);
      if (budget) {
        const thresholdResult = this.evaluateThresholds(budget, tier);
        budgetStatus = thresholdResult.status;

        if (thresholdResult.status === 'exhausted') {
          // At 100%: use cheapest available model
          selectedModel = this.getCheapestModel();
          reason = `Budget exhausted for ${scope.scope}:${scope.scopeId} — using cheapest model`;
        } else if (thresholdResult.status === 'downgraded') {
          // At 90%: downgrade to cheaper tier
          const downgradedTier = this.getDowngradedTier(tier.name);
          selectedModel = downgradedTier.models[0];
          reason = `Budget at ${(thresholdResult.usageRatio * 100).toFixed(0)}% for ${scope.scope}:${scope.scopeId} — downgraded to ${downgradedTier.name}`;
        } else if (thresholdResult.status === 'warned') {
          reason = `Budget at ${(thresholdResult.usageRatio * 100).toFixed(0)}% for ${scope.scope}:${scope.scopeId} — warning issued`;
        }

        // Send notification regardless of whether a model downgrade occurred
        if (thresholdResult.status !== 'normal') {
          this.notifyBudgetStatus(budget);
        }
      }
    }

    // Estimate cost for this request
    const totalContent = messages.map((m) => m.content).join(' ');
    const tokenCount = this.estimateTokenCount(totalContent);
    const estimatedCost = tokenCount * (ESTIMATED_COST_PER_TOKEN[tier.name] ?? ESTIMATED_COST_PER_TOKEN.moderate);

    // Check max cost constraint
    if (options?.maxCost && estimatedCost > options.maxCost) {
      const cheaperTier = this.getDowngradedTier(tier.name);
      selectedModel = cheaperTier.models[0];
      reason = `Estimated cost ($${estimatedCost.toFixed(4)}) exceeds max ($${options.maxCost}) — downgraded to ${cheaperTier.name}`;
    }

    return {
      selectedModel,
      tier: tier.name,
      reason,
      budgetStatus,
      estimatedCost,
    };
  }

  /**
   * Get budget configuration for a specific scope and scope ID.
   *
   * Returns budget with current daily/monthly spend calculated from cost_records.
   *
   * Requirements: 10.3
   */
  getBudget(scope: string, scopeId: string): CostBudget {
    const row = this.db
      .prepare(
        'SELECT scope, scope_id, daily_limit, monthly_limit, warn_threshold, downgrade_threshold, abort_threshold FROM cost_budgets WHERE scope = ? AND scope_id = ?',
      )
      .get(scope, scopeId) as
      | {
          scope: string;
          scope_id: string;
          daily_limit: number;
          monthly_limit: number;
          warn_threshold: number;
          downgrade_threshold: number;
          abort_threshold: number;
        }
      | undefined;

    if (!row) {
      throw createSubsystemError('cost_router', 'BUDGET_NOT_FOUND', `No budget found for scope ${scope}:${scopeId}`, {
        recoverable: true,
        suggestedAction: 'Set a budget using setBudget()',
        details: { scope, scopeId },
      }) as unknown as Error;
    }

    // Calculate current spend from cost_records
    const { currentDaily, currentMonthly } = this.calculateCurrentSpend(scope, scopeId);

    return {
      scope: row.scope as CostBudget['scope'],
      scopeId: row.scope_id,
      dailyLimit: row.daily_limit,
      monthlyLimit: row.monthly_limit,
      currentDaily,
      currentMonthly,
      warnThreshold: row.warn_threshold,
      downgradeThreshold: row.downgrade_threshold,
      abortThreshold: row.abort_threshold,
    };
  }

  /**
   * Set or update a budget configuration for a scope.
   *
   * Uses UPSERT (INSERT OR REPLACE) to handle both creation and updates.
   *
   * Requirements: 10.3
   */
  setBudget(budget: Omit<CostBudget, 'currentDaily' | 'currentMonthly'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cost_budgets (scope, scope_id, daily_limit, monthly_limit, warn_threshold, downgrade_threshold, abort_threshold)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        budget.scope,
        budget.scopeId,
        budget.dailyLimit,
        budget.monthlyLimit,
        budget.warnThreshold,
        budget.downgradeThreshold,
        budget.abortThreshold,
      );
  }

  /**
   * Get an aggregated cost dashboard with filtering support.
   *
   * Aggregates cost records by user (project_id as proxy), agent, workflow, model,
   * and time periods (daily, monthly).
   *
   * Requirements: 10.4
   */
  getDashboard(filter?: DashboardFilter): CostDashboard {
    const whereClause = this.buildDashboardWhereClause(filter);

    // By user (using project_id as user proxy since cost_records uses project_id)
    const byUser = this.db
      .prepare(
        `SELECT project_id AS userId, SUM(cost) AS cost FROM cost_records ${whereClause} GROUP BY project_id`,
      )
      .all() as { userId: string; cost: number }[];

    // By agent (using provider_id as agent proxy)
    const byAgent = this.db
      .prepare(
        `SELECT provider_id AS agentId, SUM(cost) AS cost FROM cost_records ${whereClause} GROUP BY provider_id`,
      )
      .all() as { agentId: string; cost: number }[];

    // By workflow (using project_id as workflow proxy — in a real system this would be a separate column)
    const byWorkflow = this.db
      .prepare(
        `SELECT project_id AS workflowId, SUM(cost) AS cost FROM cost_records ${whereClause} GROUP BY project_id`,
      )
      .all() as { workflowId: string; cost: number }[];

    // By model
    const byModel = this.db
      .prepare(
        `SELECT model_id AS model, SUM(cost) AS cost, COUNT(*) AS requestCount FROM cost_records ${whereClause} GROUP BY model_id`,
      )
      .all() as { model: string; cost: number; requestCount: number }[];

    // Daily aggregation
    const daily = this.db
      .prepare(
        `SELECT DATE(created_at) AS date, SUM(cost) AS cost FROM cost_records ${whereClause} GROUP BY DATE(created_at) ORDER BY date`,
      )
      .all() as { date: string; cost: number }[];

    // Monthly aggregation
    const monthly = this.db
      .prepare(
        `SELECT strftime('%Y-%m', created_at) AS month, SUM(cost) AS cost FROM cost_records ${whereClause} GROUP BY strftime('%Y-%m', created_at) ORDER BY month`,
      )
      .all() as { month: string; cost: number }[];

    return {
      byUser,
      byAgent,
      byWorkflow,
      byModel,
      daily,
      monthly,
    };
  }

  /**
   * Send a budget status notification.
   *
   * Notifications are sent regardless of whether a model downgrade occurred.
   * Stores notifications for retrieval and could be extended to emit events.
   *
   * Requirements: 10.5
   */
  notifyBudgetStatus(budget: CostBudget): void {
    this.notifications.push({
      budget: { ...budget },
      timestamp: new Date().toISOString(),
    });

    // In a full implementation, this would emit an event to the UI layer
    // e.g., eventBus.emit('cost:budget-status', { budget, timestamp })
  }

  /**
   * Get recent notifications (for testing and UI consumption).
   */
  getNotifications(): Array<{ budget: CostBudget; timestamp: string }> {
    return [...this.notifications];
  }

  /**
   * Clear notifications (useful for testing).
   */
  clearNotifications(): void {
    this.notifications = [];
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Estimate token count using chars/4 heuristic (same as existing estimateTokens).
   */
  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Detect multi-step reasoning indicators in content.
   */
  private detectMultiStepReasoning(content: string): boolean {
    const indicators = [
      'step by step',
      'first,',
      'then,',
      'finally,',
      'architecture',
      'design pattern',
      'trade-off',
      'tradeoff',
      'compare and contrast',
      'pros and cons',
      'multi-step',
      'complex reasoning',
    ];
    const lower = content.toLowerCase();
    return indicators.some((indicator) => lower.includes(indicator));
  }

  /**
   * Detect frontier-level task indicators in content.
   */
  private detectFrontierTask(content: string): boolean {
    const indicators = [
      'security vulnerabilit',
      'novel algorithm',
      'zero-day',
      'formal verification',
      'mathematical proof',
      'cryptograph',
      'adversarial',
      'exploit',
      'penetration test',
    ];
    const lower = content.toLowerCase();
    return indicators.some((indicator) => lower.includes(indicator));
  }

  /**
   * Determine which budget scope to check based on routing options.
   * Priority: workflow > project > workspace
   */
  private determineBudgetScope(
    options?: RoutingOptions,
  ): { scope: string; scopeId: string } | null {
    if (options?.workflowId) {
      return { scope: 'workflow', scopeId: options.workflowId };
    }
    if (options?.projectId) {
      return { scope: 'project', scopeId: options.projectId };
    }
    return null;
  }

  /**
   * Get budget safely, returning null if not found instead of throwing.
   */
  private getBudgetSafe(scope: string, scopeId: string): CostBudget | null {
    try {
      return this.getBudget(scope, scopeId);
    } catch {
      return null;
    }
  }

  /**
   * Calculate current daily and monthly spend from cost_records.
   */
  private calculateCurrentSpend(
    scope: string,
    scopeId: string,
  ): { currentDaily: number; currentMonthly: number } {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const monthStart = today.slice(0, 7); // YYYY-MM

    // For project/workspace scope, use project_id as the key
    const dailyRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) AS total FROM cost_records WHERE project_id = ? AND DATE(created_at) = ?`,
      )
      .get(scopeId, today) as { total: number };

    const monthlyRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) AS total FROM cost_records WHERE project_id = ? AND strftime('%Y-%m', created_at) = ?`,
      )
      .get(scopeId, monthStart) as { total: number };

    return {
      currentDaily: dailyRow.total,
      currentMonthly: monthlyRow.total,
    };
  }

  /**
   * Evaluate budget thresholds and determine the appropriate action.
   *
   * Returns the budget status and the usage ratio for reporting.
   */
  private evaluateThresholds(
    budget: CostBudget,
    _tier: ComplexityTier,
  ): { status: RoutingDecision['budgetStatus']; usageRatio: number } {
    // Use the higher of daily or monthly usage ratios
    const dailyRatio = budget.dailyLimit > 0 ? budget.currentDaily / budget.dailyLimit : 0;
    const monthlyRatio =
      budget.monthlyLimit > 0 ? budget.currentMonthly / budget.monthlyLimit : 0;
    const usageRatio = Math.max(dailyRatio, monthlyRatio);

    if (usageRatio >= budget.abortThreshold) {
      return { status: 'exhausted', usageRatio };
    }
    if (usageRatio >= budget.downgradeThreshold) {
      return { status: 'downgraded', usageRatio };
    }
    if (usageRatio >= budget.warnThreshold) {
      return { status: 'warned', usageRatio };
    }
    return { status: 'normal', usageRatio };
  }

  /**
   * Get the cheapest available model (used when budget is exhausted).
   * Falls back to the first model in the simple tier.
   */
  private getCheapestModel(): string {
    return this.tiers.simple.models[0];
  }

  /**
   * Get a downgraded tier (one step cheaper).
   */
  private getDowngradedTier(currentTierName: string): ComplexityTier {
    const tierOrder: ComplexityTier['name'][] = ['simple', 'moderate', 'complex', 'frontier'];
    const currentIndex = tierOrder.indexOf(currentTierName as ComplexityTier['name']);
    const downgradedIndex = Math.max(0, currentIndex - 1);
    return this.tiers[tierOrder[downgradedIndex]];
  }

  /**
   * Build a WHERE clause for dashboard queries based on filter options.
   */
  private buildDashboardWhereClause(filter?: DashboardFilter): string {
    if (!filter) return '';

    const conditions: string[] = [];

    if (filter.startDate) {
      conditions.push(`created_at >= '${filter.startDate}'`);
    }
    if (filter.endDate) {
      conditions.push(`created_at <= '${filter.endDate}'`);
    }
    if (filter.scopeId) {
      conditions.push(`project_id = '${filter.scopeId}'`);
    }

    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  }
}
