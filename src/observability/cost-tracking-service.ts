/**
 * CostTrackingService — Per-session token cost attribution and budget alerts.
 *
 * Records prompt tokens, completion tokens, and computed cost for every LLM call
 * using a user-configurable pricing table. Supports per-session and per-day budgets,
 * warning threshold alerts (default 80%), and hot-reloadable pricing JSON.
 *
 * Cost formula:
 *   cost = (promptTokens × inputPer1M / 1_000_000) + (completionTokens × outputPer1M / 1_000_000)
 *
 * Requirements: 1.1, 1.2, 1.5, 1.6, 1.7
 */

import * as fs from 'node:fs';
import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type { ExecutionTraceService } from '../infrastructure/execution-trace-service.js';
import type { TokenUsage } from '../shared/types.js';
import {
  DEFAULT_PRICING_ENTRIES,
  buildPricingKey,
  buildPricingTable,
} from './pricing-table.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** A single entry in the pricing table */
export interface PricingEntry {
  model: string;
  provider: string;
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

/** Budget configuration for token cost limits */
export interface TokenBudgetConfig {
  sessionLimitUsd: number;
  dailyLimitUsd: number;
  warningThreshold: number; // 0.0–1.0, default 0.8
}

/** A persisted record of cost per LLM call */
export interface CostRecord {
  callId: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  timestamp: string;
}

/** Result returned from recordUsage() */
export interface CostRecordResult {
  cost: number;
  budgetWarning: boolean;
  budgetExceeded: boolean;
  dailyBudgetExceeded: boolean;
}

// ─── CostTrackingService ────────────────────────────────────────

export class CostTrackingService {
  private sessionCostUsd = 0;
  private dailyCostUsd = 0;
  private dailyCostDate: string; // YYYY-MM-DD for daily reset detection
  private pricingTable: Map<string, PricingEntry>;
  private records: CostRecord[] = [];
  private warningEmitted = false;
  private dailyExceededEmitted = false;

  constructor(
    private readonly pricingPath: string | null,
    private readonly budget: TokenBudgetConfig,
    private readonly callbackEngine: CallbackEngine | null,
    private readonly traceService: ExecutionTraceService | null,
  ) {
    this.dailyCostDate = this.getCurrentDateString();
    this.pricingTable = this.loadPricingTable();
  }

  /**
   * Record usage for a single LLM call. Computes cost from pricing table,
   * accumulates session and daily totals, and returns budget status.
   *
   * Requirements: 1.1, 1.3, 1.4
   */
  recordUsage(usage: TokenUsage, model: string, provider: string, callId?: string): CostRecordResult {
    // Check for daily reset
    this.checkDailyReset();

    // Look up pricing
    const key = buildPricingKey(provider, model);
    const pricing = this.pricingTable.get(key);

    // Compute cost using formula
    const inputCost = pricing ? (usage.promptTokens * pricing.inputPer1M / 1_000_000) : 0;
    const outputCost = pricing ? (usage.completionTokens * pricing.outputPer1M / 1_000_000) : 0;
    const cost = inputCost + outputCost;

    // Accumulate
    this.sessionCostUsd += cost;
    this.dailyCostUsd += cost;

    // Record
    const record: CostRecord = {
      callId: callId ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      model,
      provider,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: cost,
      timestamp: new Date().toISOString(),
    };
    this.records.push(record);

    // Determine budget status
    const warningThresholdUsd = this.budget.sessionLimitUsd * this.budget.warningThreshold;
    const budgetWarning = this.sessionCostUsd >= warningThresholdUsd && !this.warningEmitted;
    const budgetExceeded = this.sessionCostUsd >= this.budget.sessionLimitUsd;
    const dailyBudgetExceeded = this.dailyCostUsd >= this.budget.dailyLimitUsd && !this.dailyExceededEmitted;

    // Track that warning was emitted so we don't repeat
    if (budgetWarning) {
      this.warningEmitted = true;
      this.emitBudgetAlert('budget-warning', `Session cost ($${this.sessionCostUsd.toFixed(4)}) has reached ${Math.round(this.budget.warningThreshold * 100)}% of the $${this.budget.sessionLimitUsd.toFixed(2)} budget limit.`);
    }

    // Emit budget-exceeded signal for session or daily
    if (budgetExceeded) {
      this.emitBudgetAlert('budget-exceeded', `Session cost ($${this.sessionCostUsd.toFixed(4)}) has reached the $${this.budget.sessionLimitUsd.toFixed(2)} budget limit. Execution should be paused.`);
    }

    if (dailyBudgetExceeded) {
      this.dailyExceededEmitted = true;
      this.emitBudgetAlert('budget-exceeded', `Daily cost ($${this.dailyCostUsd.toFixed(4)}) has reached the $${this.budget.dailyLimitUsd.toFixed(2)} daily budget limit. Execution should be paused.`);
    }

    return { cost, budgetWarning, budgetExceeded: budgetExceeded || dailyBudgetExceeded, dailyBudgetExceeded };
  }

  /**
   * Hot-reload pricing table from disk without restart.
   * If the file is unreadable, the current table remains unchanged.
   *
   * Requirements: 1.7
   */
  reloadPricing(): void {
    this.pricingTable = this.loadPricingTable();
  }

  /** Get cumulative session cost in USD */
  getSessionCost(): number {
    return this.sessionCostUsd;
  }

  /** Get cumulative daily cost in USD */
  getDailyCost(): number {
    this.checkDailyReset();
    return this.dailyCostUsd;
  }

  /** Get all recorded cost entries */
  getRecords(): CostRecord[] {
    return [...this.records];
  }

  /** Get the current pricing table (for inspection/testing) */
  getPricingTable(): Map<string, PricingEntry> {
    return new Map(this.pricingTable);
  }

  /** Reset session tracking (e.g., on new session start) */
  resetSession(): void {
    this.sessionCostUsd = 0;
    this.warningEmitted = false;
    this.dailyExceededEmitted = false;
    this.records = [];
  }

  // ─── Private ────────────────────────────────────────────────

  /**
   * Emit a budget alert via CallbackEngine on the 'on-drift-signal' event.
   *
   * Follows the same fire-and-forget pattern as DriftMonitor.dispatchSignal().
   * The alert type is passed as `input` on the HookContext so that listeners
   * can distinguish 'budget-warning' from 'budget-exceeded'.
   *
   * Requirements: 1.3, 1.4
   */
  private emitBudgetAlert(type: 'budget-warning' | 'budget-exceeded', message: string): void {
    if (!this.callbackEngine) return;

    const budgetSignal = {
      type,
      message,
      sessionCostUsd: this.sessionCostUsd,
      dailyCostUsd: this.dailyCostUsd,
      sessionLimitUsd: this.budget.sessionLimitUsd,
      dailyLimitUsd: this.budget.dailyLimitUsd,
      timestamp: new Date().toISOString(),
    };

    // Fire-and-forget: emit is async but we don't await to stay within performance budget
    this.callbackEngine.emit({
      event: 'on-drift-signal',
      sessionId: '',
      iteration: 0,
      input: budgetSignal,
    }).catch(() => {
      // Graceful degradation: callback engine failure doesn't interrupt cost tracking
    });
  }

  /**
   * Load pricing from JSON file if path is provided and file exists.
   * Falls back to built-in defaults otherwise.
   */
  private loadPricingTable(): Map<string, PricingEntry> {
    if (this.pricingPath) {
      try {
        const raw = fs.readFileSync(this.pricingPath, 'utf-8');
        const entries: PricingEntry[] = JSON.parse(raw);
        if (Array.isArray(entries) && entries.length > 0) {
          return buildPricingTable(entries);
        }
      } catch {
        // File not found or invalid JSON — fall through to defaults
      }
    }
    return buildPricingTable(DEFAULT_PRICING_ENTRIES);
  }

  /**
   * Check if the calendar date has rolled over; if so, reset daily cost.
   */
  private checkDailyReset(): void {
    const today = this.getCurrentDateString();
    if (today !== this.dailyCostDate) {
      this.dailyCostUsd = 0;
      this.dailyCostDate = today;
      this.dailyExceededEmitted = false;
    }
  }

  /**
   * Get the current date as YYYY-MM-DD string.
   * Extracted for testability.
   */
  private getCurrentDateString(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

// ─── SQLite Table Creation (Feature-Gated) ──────────────────────

/**
 * SQL statement to create the cost_records table.
 * Should be executed conditionally when cost_tracking feature gate is enabled.
 *
 * Requirements: 1.5
 */
export const COST_RECORDS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS cost_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  trace_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_cost_records_session ON cost_records(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_timestamp ON cost_records(timestamp);
`.trim();

/**
 * Initialize the cost_records SQLite table if it doesn't exist.
 * Called conditionally when the cost_tracking feature gate is enabled.
 *
 * @param db - A database instance with an exec() method (e.g., better-sqlite3)
 */
export function initCostRecordsTable(db: { exec: (sql: string) => void }): void {
  db.exec(COST_RECORDS_TABLE_SQL);
}
