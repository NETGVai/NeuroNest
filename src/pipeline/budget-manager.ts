/**
 * Budget Manager — Cost tracking and budget limits per project.
 *
 * Tracks token usage and estimated costs. Can enforce budget limits
 * that stop agent execution when exceeded.
 */

export interface BudgetConfig {
  projectId: string;
  maxCostUSD: number; // 0 = unlimited
  currentCostUSD: number;
  totalTokens: number;
  warningThreshold: number; // 0-1, e.g. 0.8 = warn at 80%
  enabled: boolean;
}

export class BudgetManager {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_budgets (
          project_id TEXT PRIMARY KEY,
          max_cost_usd REAL NOT NULL DEFAULT 0,
          current_cost_usd REAL NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          warning_threshold REAL NOT NULL DEFAULT 0.8,
          enabled INTEGER NOT NULL DEFAULT 0
        )
      `);
    } catch (e) { console.warn('[BudgetManager] Table creation failed:', e); }
  }

  getBudget(projectId: string): BudgetConfig {
    try {
      const row = this.db.prepare('SELECT * FROM project_budgets WHERE project_id = ?').get(projectId) as any;
      if (row) {
        return {
          projectId: row.project_id, maxCostUSD: row.max_cost_usd,
          currentCostUSD: row.current_cost_usd, totalTokens: row.total_tokens,
          warningThreshold: row.warning_threshold, enabled: !!row.enabled,
        };
      }
    } catch {}
    return { projectId, maxCostUSD: 0, currentCostUSD: 0, totalTokens: 0, warningThreshold: 0.8, enabled: false };
  }

  setBudget(projectId: string, maxCostUSD: number, warningThreshold: number = 0.8): void {
    try {
      this.db.prepare(
        'INSERT OR REPLACE INTO project_budgets (project_id, max_cost_usd, current_cost_usd, total_tokens, warning_threshold, enabled) VALUES (?, ?, COALESCE((SELECT current_cost_usd FROM project_budgets WHERE project_id = ?), 0), COALESCE((SELECT total_tokens FROM project_budgets WHERE project_id = ?), 0), ?, 1)'
      ).run(projectId, maxCostUSD, projectId, projectId, warningThreshold);
    } catch {}
  }

  recordUsage(projectId: string, tokens: number, costUSD: number): { allowed: boolean; warning: boolean; remaining: number } {
    const budget = this.getBudget(projectId);
    const newCost = budget.currentCostUSD + costUSD;
    const newTokens = budget.totalTokens + tokens;

    try {
      this.db.prepare(
        'INSERT OR REPLACE INTO project_budgets (project_id, max_cost_usd, current_cost_usd, total_tokens, warning_threshold, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, budget.maxCostUSD, newCost, newTokens, budget.warningThreshold, budget.enabled ? 1 : 0);
    } catch {}

    if (!budget.enabled || budget.maxCostUSD <= 0) {
      return { allowed: true, warning: false, remaining: Infinity };
    }

    const remaining = budget.maxCostUSD - newCost;
    const ratio = newCost / budget.maxCostUSD;

    return {
      allowed: newCost <= budget.maxCostUSD,
      warning: ratio >= budget.warningThreshold,
      remaining: Math.max(0, remaining),
    };
  }

  resetUsage(projectId: string): void {
    try {
      this.db.prepare('UPDATE project_budgets SET current_cost_usd = 0, total_tokens = 0 WHERE project_id = ?').run(projectId);
    } catch {}
  }

  disableBudget(projectId: string): void {
    try {
      this.db.prepare('UPDATE project_budgets SET enabled = 0 WHERE project_id = ?').run(projectId);
    } catch {}
  }
}
