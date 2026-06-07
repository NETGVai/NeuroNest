/**
 * Cost Tracker — Session-level cost and token tracking with budget enforcement.
 *
 * Records LLM call costs and tool call cost attributions, aggregates per-session
 * totals, enforces budget limits, and integrates with SessionTelemetryService.
 * Persists to SQLite with in-memory fallback on write failure.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.10, 4.11, 4.12
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { EventBus } from '../events/event-bus.js';
import { ModelPricingTable, roundHalfUp } from './model-pricing.js';
import { SessionTelemetryService } from './session-telemetry.js';
import { logger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface LLMCostEntry {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;        // 6 decimal places, half-up rounding
  isEstimated: boolean;
  traceId?: string;
}

export interface BudgetLimit {
  hardCapUsd: number;     // default $10.00
  warningPct: number;     // default 0.80 (80%)
}

export interface SessionCostSummary {
  sessionId: string;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  perModelBreakdown: ModelCostBreakdown[];
  perToolBreakdown: ToolCostBreakdown[];
  budgetStatus: 'ok' | 'warning' | 'exceeded';
}

export interface ModelCostBreakdown {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  callCount: number;
}

export interface ToolCostBreakdown {
  toolName: string;
  costUsd: number;
  callCount: number;
}

/**
 * Internal cost record stored in memory and SQLite.
 */
interface CostRecord {
  id: string;
  sessionId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  isEstimated: boolean;
  toolName: string | null;
  traceId: string | null;
  recordedAt: string;
}

// ─── Default Constants ───────────────────────────────────────────────────────

const DEFAULT_HARD_CAP_USD = 10.00;
const DEFAULT_WARNING_PCT = 0.80;
const CHARS_PER_TOKEN = 4;

// ─── CostTracker Options ─────────────────────────────────────────────────────

export interface CostTrackerOptions {
  db: Database.Database;
  eventBus?: EventBus;
  pricingTable?: ModelPricingTable;
  telemetryService?: SessionTelemetryService;
}

// ─── CostTracker Implementation ──────────────────────────────────────────────

/**
 * Tracks LLM and tool call costs per session, enforces budget limits,
 * and persists records to SQLite with in-memory fallback.
 */
export class CostTracker {
  private db: Database.Database;
  private eventBus?: EventBus;
  private pricingTable: ModelPricingTable;
  private telemetryService?: SessionTelemetryService;

  // In-memory cache for fast aggregation (< 100ms)
  private sessionRecords: Map<string, CostRecord[]> = new Map();
  // Budget limits per session
  private budgetLimits: Map<string, BudgetLimit> = new Map();
  // Track whether warning has been emitted for a session
  private warningEmitted: Set<string> = new Set();
  // Track whether exceeded has been emitted for a session
  private exceededEmitted: Set<string> = new Set();
  // Records pending SQLite persistence (in-memory fallback)
  private pendingRecords: CostRecord[] = [];

  // Prepared statements
  private stmtInsertRecord!: Database.Statement;
  private stmtGetSessionRecords!: Database.Statement;
  private stmtUpsertBudget!: Database.Statement;
  private stmtGetBudget!: Database.Statement;

  constructor(options: CostTrackerOptions) {
    this.db = options.db;
    this.eventBus = options.eventBus;
    this.pricingTable = options.pricingTable || new ModelPricingTable();
    this.telemetryService = options.telemetryService;

    this.initializePreparedStatements();
    this.loadExistingBudgets();
  }

  /**
   * Record an LLM call's cost for a session.
   *
   * If token usage data is unavailable (tokensIn/tokensOut are 0 and text is provided),
   * estimates tokens at 4 chars/token and marks the entry as estimated.
   */
  recordLLMCall(sessionId: string, data: LLMCostEntry): void {
    if (this.isBudgetExceeded(sessionId)) {
      logger.warn('Budget exceeded, blocking new LLM call recording', { sessionId });
      return;
    }

    const record: CostRecord = {
      id: randomUUID(),
      sessionId,
      model: data.model,
      tokensIn: data.tokensIn,
      tokensOut: data.tokensOut,
      costUsd: roundHalfUp(data.costUsd, 6),
      isEstimated: data.isEstimated,
      toolName: null,
      traceId: data.traceId || null,
      recordedAt: new Date().toISOString(),
    };

    // Add to in-memory cache
    this.addToMemoryCache(record);

    // Persist to SQLite (with fallback)
    this.persistRecord(record);

    // Update budget status and emit events if needed
    this.checkBudgetThresholds(sessionId);

    // Integrate with SessionTelemetryService
    this.recordToTelemetry(sessionId, record);
  }

  /**
   * Record a tool call's cost attribution for a session.
   */
  recordToolCall(sessionId: string, toolName: string, associatedLLMCost: number): void {
    const record: CostRecord = {
      id: randomUUID(),
      sessionId,
      model: '',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: roundHalfUp(associatedLLMCost, 6),
      isEstimated: false,
      toolName,
      traceId: null,
      recordedAt: new Date().toISOString(),
    };

    // Add to in-memory cache
    this.addToMemoryCache(record);

    // Persist to SQLite (with fallback)
    this.persistRecord(record);

    // Update budget status
    this.checkBudgetThresholds(sessionId);
  }

  /**
   * Get the running session total (< 100ms response time).
   * Uses in-memory cache for fast aggregation.
   */
  getSessionTotal(sessionId: string): SessionCostSummary {
    const records = this.sessionRecords.get(sessionId) || [];

    let totalCostUsd = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    const modelMap = new Map<string, ModelCostBreakdown>();
    const toolMap = new Map<string, ToolCostBreakdown>();

    for (const record of records) {
      totalCostUsd += record.costUsd;
      totalTokensIn += record.tokensIn;
      totalTokensOut += record.tokensOut;

      // Per-model breakdown (only for LLM calls, not tool attributions)
      if (record.model) {
        const existing = modelMap.get(record.model);
        if (existing) {
          existing.tokensIn += record.tokensIn;
          existing.tokensOut += record.tokensOut;
          existing.costUsd += record.costUsd;
          existing.callCount += 1;
        } else {
          modelMap.set(record.model, {
            model: record.model,
            tokensIn: record.tokensIn,
            tokensOut: record.tokensOut,
            costUsd: record.costUsd,
            callCount: 1,
          });
        }
      }

      // Per-tool breakdown
      if (record.toolName) {
        const existing = toolMap.get(record.toolName);
        if (existing) {
          existing.costUsd += record.costUsd;
          existing.callCount += 1;
        } else {
          toolMap.set(record.toolName, {
            toolName: record.toolName,
            costUsd: record.costUsd,
            callCount: 1,
          });
        }
      }
    }

    // Round aggregated totals to 6 decimal places
    totalCostUsd = roundHalfUp(totalCostUsd, 6);

    const perModelBreakdown = Array.from(modelMap.values()).map(m => ({
      ...m,
      costUsd: roundHalfUp(m.costUsd, 6),
    }));

    const perToolBreakdown = Array.from(toolMap.values()).map(t => ({
      ...t,
      costUsd: roundHalfUp(t.costUsd, 6),
    }));

    return {
      sessionId,
      totalCostUsd,
      totalTokensIn,
      totalTokensOut,
      perModelBreakdown,
      perToolBreakdown,
      budgetStatus: this.getBudgetStatus(sessionId, totalCostUsd),
    };
  }

  /**
   * Get per-model breakdown for a session.
   */
  getModelBreakdown(sessionId: string): ModelCostBreakdown[] {
    return this.getSessionTotal(sessionId).perModelBreakdown;
  }

  /**
   * Check if the budget has been exceeded for a session.
   */
  isBudgetExceeded(sessionId: string): boolean {
    const records = this.sessionRecords.get(sessionId) || [];
    const totalCost = records.reduce((sum, r) => sum + r.costUsd, 0);
    const limit = this.budgetLimits.get(sessionId);
    const hardCap = limit?.hardCapUsd ?? DEFAULT_HARD_CAP_USD;
    return totalCost >= hardCap;
  }

  /**
   * Set budget limits for a session.
   */
  setBudgetLimit(sessionId: string, limit: BudgetLimit): void {
    this.budgetLimits.set(sessionId, { ...limit });

    // Persist to SQLite
    try {
      const records = this.sessionRecords.get(sessionId) || [];
      const currentSpend = roundHalfUp(
        records.reduce((sum, r) => sum + r.costUsd, 0),
        6
      );
      const status = this.getBudgetStatus(sessionId, currentSpend);

      this.stmtUpsertBudget.run(
        sessionId,
        limit.hardCapUsd,
        limit.warningPct,
        currentSpend,
        status,
        new Date().toISOString()
      );
    } catch (err) {
      logger.error('Failed to persist budget limit to SQLite', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Re-check thresholds with new limits
    this.checkBudgetThresholds(sessionId);
  }

  /**
   * Estimate token count from character count.
   * Uses 4 characters per token ratio (default).
   */
  estimateTokens(charCount: number): number {
    return Math.ceil(charCount / CHARS_PER_TOKEN);
  }

  /**
   * Record an LLM call with token estimation from text content.
   * Used when token usage data is unavailable.
   */
  recordLLMCallWithEstimation(
    sessionId: string,
    model: string,
    inputText: string,
    outputText: string,
    traceId?: string
  ): void {
    const tokensIn = this.estimateTokens(inputText.length);
    const tokensOut = this.estimateTokens(outputText.length);
    const costUsd = this.pricingTable.calculateCost(model, tokensIn, tokensOut);

    logger.warn('Token usage data unavailable, using estimation (4 chars/token)', {
      sessionId,
      model,
      estimatedTokensIn: tokensIn,
      estimatedTokensOut: tokensOut,
    });

    this.recordLLMCall(sessionId, {
      model,
      tokensIn,
      tokensOut,
      costUsd,
      isEstimated: true,
      traceId,
    });
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private initializePreparedStatements(): void {
    this.stmtInsertRecord = this.db.prepare(`
      INSERT INTO session_cost_records (id, session_id, model, tokens_in, tokens_out, cost_usd, is_estimated, tool_name, trace_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetSessionRecords = this.db.prepare(`
      SELECT id, session_id, model, tokens_in, tokens_out, cost_usd, is_estimated, tool_name, trace_id, recorded_at
      FROM session_cost_records
      WHERE session_id = ?
      ORDER BY recorded_at ASC
    `);

    this.stmtUpsertBudget = this.db.prepare(`
      INSERT INTO session_budget_limits (session_id, hard_cap_usd, warning_pct, current_spend_usd, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        hard_cap_usd = excluded.hard_cap_usd,
        warning_pct = excluded.warning_pct,
        current_spend_usd = excluded.current_spend_usd,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);

    this.stmtGetBudget = this.db.prepare(`
      SELECT session_id, hard_cap_usd, warning_pct, current_spend_usd, status
      FROM session_budget_limits
      WHERE session_id = ?
    `);
  }

  /**
   * Load existing budget limits from SQLite on startup.
   */
  private loadExistingBudgets(): void {
    try {
      const rows = this.db.prepare('SELECT session_id, hard_cap_usd, warning_pct FROM session_budget_limits').all() as any[];
      for (const row of rows) {
        this.budgetLimits.set(row.session_id, {
          hardCapUsd: row.hard_cap_usd,
          warningPct: row.warning_pct,
        });
      }
    } catch (err) {
      logger.warn('Failed to load existing budget limits from SQLite', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Add a record to the in-memory cache.
   */
  private addToMemoryCache(record: CostRecord): void {
    if (!this.sessionRecords.has(record.sessionId)) {
      this.sessionRecords.set(record.sessionId, []);
    }
    this.sessionRecords.get(record.sessionId)!.push(record);
  }

  /**
   * Persist a record to SQLite. On failure, retain in memory and retry on next write.
   */
  private persistRecord(record: CostRecord): void {
    // First, try to flush any pending records
    this.flushPendingRecords();

    try {
      this.stmtInsertRecord.run(
        record.id,
        record.sessionId,
        record.model,
        record.tokensIn,
        record.tokensOut,
        record.costUsd,
        record.isEstimated ? 1 : 0,
        record.toolName,
        record.traceId,
        record.recordedAt
      );
    } catch (err) {
      logger.error('Failed to persist cost record to SQLite, retaining in memory', {
        recordId: record.id,
        sessionId: record.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.pendingRecords.push(record);
    }
  }

  /**
   * Attempt to flush pending records to SQLite (retry on next write).
   */
  private flushPendingRecords(): void {
    if (this.pendingRecords.length === 0) return;

    const stillPending: CostRecord[] = [];

    for (const record of this.pendingRecords) {
      try {
        this.stmtInsertRecord.run(
          record.id,
          record.sessionId,
          record.model,
          record.tokensIn,
          record.tokensOut,
          record.costUsd,
          record.isEstimated ? 1 : 0,
          record.toolName,
          record.traceId,
          record.recordedAt
        );
      } catch {
        stillPending.push(record);
      }
    }

    this.pendingRecords = stillPending;
  }

  /**
   * Check budget thresholds and emit events if needed.
   */
  private checkBudgetThresholds(sessionId: string): void {
    const records = this.sessionRecords.get(sessionId) || [];
    const totalCost = records.reduce((sum, r) => sum + r.costUsd, 0);
    const limit = this.budgetLimits.get(sessionId);
    const hardCap = limit?.hardCapUsd ?? DEFAULT_HARD_CAP_USD;
    const warningPct = limit?.warningPct ?? DEFAULT_WARNING_PCT;
    const warningThreshold = hardCap * warningPct;

    // Check exceeded
    if (totalCost >= hardCap && !this.exceededEmitted.has(sessionId)) {
      this.exceededEmitted.add(sessionId);
      this.emitBudgetExceededEvent(sessionId, totalCost, hardCap);
      this.updateBudgetStatus(sessionId, totalCost, 'exceeded');
    }
    // Check warning
    else if (totalCost >= warningThreshold && totalCost < hardCap && !this.warningEmitted.has(sessionId)) {
      this.warningEmitted.add(sessionId);
      this.emitBudgetWarningEvent(sessionId, totalCost, warningThreshold);
      this.updateBudgetStatus(sessionId, totalCost, 'warning');
    }
  }

  /**
   * Get the budget status for a session given its total cost.
   */
  private getBudgetStatus(sessionId: string, totalCost: number): 'ok' | 'warning' | 'exceeded' {
    const limit = this.budgetLimits.get(sessionId);
    const hardCap = limit?.hardCapUsd ?? DEFAULT_HARD_CAP_USD;
    const warningPct = limit?.warningPct ?? DEFAULT_WARNING_PCT;
    const warningThreshold = hardCap * warningPct;

    if (totalCost >= hardCap) return 'exceeded';
    if (totalCost >= warningThreshold) return 'warning';
    return 'ok';
  }

  /**
   * Update budget status in SQLite.
   */
  private updateBudgetStatus(sessionId: string, currentSpend: number, status: string): void {
    try {
      const limit = this.budgetLimits.get(sessionId);
      this.stmtUpsertBudget.run(
        sessionId,
        limit?.hardCapUsd ?? DEFAULT_HARD_CAP_USD,
        limit?.warningPct ?? DEFAULT_WARNING_PCT,
        roundHalfUp(currentSpend, 6),
        status,
        new Date().toISOString()
      );
    } catch (err) {
      logger.error('Failed to update budget status in SQLite', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Emit a budget warning event on the EventBus.
   */
  private emitBudgetWarningEvent(sessionId: string, currentSpend: number, threshold: number): void {
    if (!this.eventBus) return;

    this.eventBus.publish('guardrail.budget.warning', {
      type: 'budget_warning',
      data: {
        sessionId,
        currentSpendUsd: roundHalfUp(currentSpend, 6),
        thresholdUsd: roundHalfUp(threshold, 6),
        timestamp: Date.now(),
      },
      sessionId,
    }).catch((err) => {
      logger.error('Failed to emit budget warning event', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Emit a budget exceeded event on the EventBus.
   */
  private emitBudgetExceededEvent(sessionId: string, currentSpend: number, hardCap: number): void {
    if (!this.eventBus) return;

    this.eventBus.publish('guardrail.budget.exceeded', {
      type: 'budget_exceeded',
      data: {
        sessionId,
        currentSpendUsd: roundHalfUp(currentSpend, 6),
        hardCapUsd: hardCap,
        timestamp: Date.now(),
      },
      sessionId,
    }).catch((err) => {
      logger.error('Failed to emit budget exceeded event', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Integrate with SessionTelemetryService by recording cost data.
   */
  private recordToTelemetry(sessionId: string, record: CostRecord): void {
    if (!this.telemetryService) return;

    try {
      const toolBreakdown: Record<string, number> = {};
      if (record.toolName) {
        toolBreakdown[record.toolName] = 1;
      }

      this.telemetryService.record(sessionId, {
        tokensIn: record.tokensIn,
        tokensOut: record.tokensOut,
        costUsd: record.costUsd,
        contextPct: 0, // Not tracked by cost tracker
        toolCalls: record.toolName ? 1 : 0,
        toolBreakdown,
      });
    } catch (err) {
      logger.error('Failed to record to SessionTelemetryService', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
