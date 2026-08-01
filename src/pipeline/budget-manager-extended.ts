/**
 * Extended Budget Manager — Per-run and daily stop-loss cost controls.
 *
 * Extends NeuroNest's budget tracking with:
 * - Per-run cost limits that terminate runs when exceeded
 * - Daily aggregate stop-loss that blocks new runs until next UTC day
 * - Model-specific pricing via a pricing table
 * - Audit Chain integration for termination events
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import type Database from 'better-sqlite3';
import type { AuditChainInterface } from '../devops-engine/audit-chain';

// ─── Interfaces ─────────────────────────────────────────────────

export interface RunBudget {
  runId: string;
  agentId: string;
  maxCostUSD: number;
  currentCostUSD: number;
  startedAt: number;
}

export interface DailyBudget {
  date: string; // YYYY-MM-DD UTC
  totalCostUSD: number;
  stopLossUSD: number;
  blocked: boolean;
}

export interface BudgetStatus {
  run: RunBudget | null;
  daily: DailyBudget;
}

export interface ModelUsageResult {
  allowed: boolean;
  runExceeded: boolean;
  dailyExceeded: boolean;
  cost: number;
}

export interface ModelPricingEntry {
  inputPricePerToken: number;
  outputPricePerToken: number;
}

export interface PricingTable {
  [modelId: string]: ModelPricingEntry;
}

export interface ExtendedBudgetManager {
  /** Start tracking a new run with per-run limit */
  startRun(runId: string, agentId: string, maxCostUSD: number): RunBudget;

  /** Record model usage and check both run + daily limits */
  recordModelUsage(
    runId: string,
    tokens: { input: number; output: number },
    modelId: string,
  ): ModelUsageResult;

  /** Get current budget status */
  getStatus(runId?: string): BudgetStatus;

  /** Set daily stop-loss threshold */
  setDailyStopLoss(limitUSD: number): void;

  /** Check if daily limit allows new runs */
  canStartRun(): boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Get today's date in YYYY-MM-DD UTC format. */
function getUTCDateString(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Calculate cost from token counts and pricing entry. */
export function calculateTokenCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricingEntry,
): number {
  const input = Math.max(0, inputTokens);
  const output = Math.max(0, outputTokens);
  return input * pricing.inputPricePerToken + output * pricing.outputPricePerToken;
}

// ─── Default Pricing Table ──────────────────────────────────────

/**
 * Default pricing table mapping model IDs to per-token costs.
 * Prices are in USD per token (not per million tokens).
 */
const DEFAULT_PRICING_TABLE: PricingTable = {
  'gpt-4o': { inputPricePerToken: 0.0000025, outputPricePerToken: 0.00001 },
  'gpt-4o-mini': { inputPricePerToken: 0.00000015, outputPricePerToken: 0.0000006 },
  'gpt-4-turbo': { inputPricePerToken: 0.00001, outputPricePerToken: 0.00003 },
  'gpt-4': { inputPricePerToken: 0.00003, outputPricePerToken: 0.00006 },
  'gpt-3.5-turbo': { inputPricePerToken: 0.0000005, outputPricePerToken: 0.0000015 },
  'claude-3-5-sonnet': { inputPricePerToken: 0.000003, outputPricePerToken: 0.000015 },
  'claude-3-opus': { inputPricePerToken: 0.000015, outputPricePerToken: 0.000075 },
  'claude-3-haiku': { inputPricePerToken: 0.00000025, outputPricePerToken: 0.00000125 },
  'gemini-1.5-pro': { inputPricePerToken: 0.00000125, outputPricePerToken: 0.000005 },
  'gemini-1.5-flash': { inputPricePerToken: 0.000000075, outputPricePerToken: 0.0000003 },
  '_default': { inputPricePerToken: 0.000001, outputPricePerToken: 0.000003 },
};

// ─── Database Row Types ─────────────────────────────────────────

interface RunBudgetRow {
  run_id: string;
  agent_id: string;
  max_cost_usd: number;
  current_cost_usd: number;
  started_at: number;
  ended_at: number | null;
  terminated_reason: string | null;
}

interface DailyBudgetRow {
  date_utc: string;
  total_cost_usd: number;
  stop_loss_usd: number;
  blocked: number;
}

// ─── Factory ────────────────────────────────────────────────────

export interface CreateExtendedBudgetManagerOptions {
  db: Database.Database;
  pricingTable?: PricingTable;
  auditChain?: AuditChainInterface;
  /** Override for UTC date (testing only) */
  getDateUTC?: () => string;
}

/**
 * Creates an ExtendedBudgetManager instance backed by SQLite.
 * Requires the `run_budgets` and `daily_budgets` tables to already exist
 * (created by migration 063).
 */
export function createExtendedBudgetManager(
  options: CreateExtendedBudgetManagerOptions,
): ExtendedBudgetManager {
  const { db, auditChain } = options;
  const pricingTable = options.pricingTable ?? DEFAULT_PRICING_TABLE;
  const getDateUTC = options.getDateUTC ?? getUTCDateString;

  // ─── Prepared Statements ──────────────────────────────────

  const insertRunStmt = db.prepare(`
    INSERT INTO run_budgets (run_id, agent_id, max_cost_usd, current_cost_usd, started_at)
    VALUES (?, ?, ?, 0, ?)
  `);

  const getRunStmt = db.prepare(`
    SELECT * FROM run_budgets WHERE run_id = ?
  `);

  const updateRunCostStmt = db.prepare(`
    UPDATE run_budgets SET current_cost_usd = ? WHERE run_id = ?
  `);

  const terminateRunStmt = db.prepare(`
    UPDATE run_budgets SET ended_at = ?, terminated_reason = ? WHERE run_id = ?
  `);

  const upsertDailyStmt = db.prepare(`
    INSERT INTO daily_budgets (date_utc, total_cost_usd, stop_loss_usd, blocked)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date_utc) DO UPDATE SET
      total_cost_usd = excluded.total_cost_usd,
      stop_loss_usd = excluded.stop_loss_usd,
      blocked = excluded.blocked
  `);

  const getDailyStmt = db.prepare(`
    SELECT * FROM daily_budgets WHERE date_utc = ?
  `);

  const updateDailyCostStmt = db.prepare(`
    UPDATE daily_budgets SET total_cost_usd = ?, blocked = ? WHERE date_utc = ?
  `);

  const setDailyStopLossStmt = db.prepare(`
    INSERT INTO daily_budgets (date_utc, total_cost_usd, stop_loss_usd, blocked)
    VALUES (?, 0, ?, 0)
    ON CONFLICT(date_utc) DO UPDATE SET stop_loss_usd = excluded.stop_loss_usd
  `);

  // ─── Helpers ──────────────────────────────────────────────

  function getOrCreateDailyBudget(): DailyBudget {
    const today = getDateUTC();
    const row = getDailyStmt.get(today) as DailyBudgetRow | undefined;
    if (row) {
      return {
        date: row.date_utc,
        totalCostUSD: row.total_cost_usd,
        stopLossUSD: row.stop_loss_usd,
        blocked: row.blocked === 1,
      };
    }
    // Create a default daily budget entry with no stop-loss limit (Infinity behavior via large number)
    upsertDailyStmt.run(today, 0, Number.MAX_SAFE_INTEGER, 0);
    return {
      date: today,
      totalCostUSD: 0,
      stopLossUSD: Number.MAX_SAFE_INTEGER,
      blocked: false,
    };
  }

  function getPricing(modelId: string): ModelPricingEntry {
    return pricingTable[modelId] ?? pricingTable['_default'] ?? { inputPricePerToken: 0, outputPricePerToken: 0 };
  }

  function recordAuditTermination(runId: string, agentId: string, cost: number, limitType: string): void {
    if (!auditChain) return;
    try {
      auditChain.append({
        timestamp: Date.now(),
        agentId,
        toolName: 'budget-manager:terminate',
        arguments: { runId, limitType, finalCostUSD: cost },
        resultSummary: `Run terminated: ${limitType} limit exceeded at $${cost.toFixed(6)}`,
        duration: 0,
        cost,
      });
    } catch {
      // Best-effort audit logging; do not fail budget enforcement if audit write fails
    }
  }

  // ─── Public Methods ───────────────────────────────────────

  function startRun(runId: string, agentId: string, maxCostUSD: number): RunBudget {
    const startedAt = Date.now();
    insertRunStmt.run(runId, agentId, maxCostUSD, startedAt);
    return {
      runId,
      agentId,
      maxCostUSD,
      currentCostUSD: 0,
      startedAt,
    };
  }

  function recordModelUsage(
    runId: string,
    tokens: { input: number; output: number },
    modelId: string,
  ): ModelUsageResult {
    const pricing = getPricing(modelId);
    const cost = calculateTokenCost(tokens.input, tokens.output, pricing);

    // Get current run state
    const runRow = getRunStmt.get(runId) as RunBudgetRow | undefined;
    if (!runRow) {
      // Run doesn't exist — treat as allowed but with no tracking
      return { allowed: true, runExceeded: false, dailyExceeded: false, cost };
    }

    // Update run cost
    const newRunCost = runRow.current_cost_usd + cost;
    updateRunCostStmt.run(newRunCost, runId);

    // Update daily cost
    const daily = getOrCreateDailyBudget();
    const newDailyCost = daily.totalCostUSD + cost;
    const dailyExceeded = newDailyCost > daily.stopLossUSD;
    updateDailyCostStmt.run(newDailyCost, dailyExceeded ? 1 : 0, daily.date);

    // Check run limit
    const runExceeded = newRunCost > runRow.max_cost_usd;

    // Determine overall allowance
    const allowed = !runExceeded && !dailyExceeded;

    // Record termination events if limits exceeded
    if (runExceeded) {
      terminateRunStmt.run(Date.now(), 'per-run limit exceeded', runId);
      recordAuditTermination(runId, runRow.agent_id, newRunCost, 'per-run');
    }
    if (dailyExceeded) {
      if (!runExceeded) {
        terminateRunStmt.run(Date.now(), 'daily stop-loss exceeded', runId);
      }
      recordAuditTermination(runId, runRow.agent_id, newDailyCost, 'daily-stop-loss');
    }

    return { allowed, runExceeded, dailyExceeded, cost };
  }

  function getStatus(runId?: string): BudgetStatus {
    const daily = getOrCreateDailyBudget();

    let run: RunBudget | null = null;
    if (runId) {
      const runRow = getRunStmt.get(runId) as RunBudgetRow | undefined;
      if (runRow) {
        run = {
          runId: runRow.run_id,
          agentId: runRow.agent_id,
          maxCostUSD: runRow.max_cost_usd,
          currentCostUSD: runRow.current_cost_usd,
          startedAt: runRow.started_at,
        };
      }
    }

    return { run, daily };
  }

  function setDailyStopLoss(limitUSD: number): void {
    const today = getDateUTC();
    setDailyStopLossStmt.run(today, limitUSD);
  }

  function canStartRun(): boolean {
    const daily = getOrCreateDailyBudget();
    return daily.totalCostUSD < daily.stopLossUSD && !daily.blocked;
  }

  return {
    startRun,
    recordModelUsage,
    getStatus,
    setDailyStopLoss,
    canStartRun,
  };
}
