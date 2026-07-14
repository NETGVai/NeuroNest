/**
 * Cost Controls IPC — Renderer communication for budget enforcement, alerts, and spending summaries.
 *
 * Wires IPC channels: `cost:budget-set`, `cost:budget-status`, `cost:alert-config`, `cost:session-summary`
 *
 * Gated behind `cost_controls` feature flag (requires `cost_tracking`).
 *
 * Requirements: 22.2, 22.3, 22.5, 22.7, 22.8
 */

import { ipcMain, type BrowserWindow } from 'electron';
import {
  getCostBudgetEnforcer,
  type CostBudgetConfig,
  type BudgetStatus,
  type BudgetEvent,
} from '../observability/cost-budget-enforcer.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CostIPCDependencies {
  mainWindow: BrowserWindow;
  featureGate: FeatureGateSystem;
  getDb: () => any;
  getActiveSessionId: () => string | null;
}

export interface AlertConfig {
  warningThreshold: number;
  downgradeThreshold: number;
  downgradeModel: { provider: string; model: string };
  notifyOnWarning: boolean;
  notifyOnExhausted: boolean;
}

export interface SessionSummary {
  sessionId: string;
  sessionCostUsd: number;
  sessionLimitUsd: number;
  usageRatio: number;
  warningReached: boolean;
  downgradeActive: boolean;
  budgetExhausted: boolean;
  monthlySummary: MonthlySummary | null;
}

export interface MonthlySummary {
  totalCostUsd: number;
  byProvider: Array<{ provider: string; costUsd: number; callCount: number }>;
  byModel: Array<{ model: string; costUsd: number; callCount: number }>;
  byTask: Array<{ taskType: string; costUsd: number; callCount: number }>;
}

// ─── Registration ───────────────────────────────────────────────

export function registerCostIPC(deps: CostIPCDependencies): void {
  const { mainWindow, featureGate, getDb, getActiveSessionId } = deps;

  // Helper: check feature gate
  function isEnabled(): boolean {
    try {
      return featureGate.isEnabled('cost_controls');
    } catch {
      return false;
    }
  }

  // Wire budget events to renderer as real-time cost updates
  const enforcer = getCostBudgetEnforcer();
  enforcer.onBudgetEvent((event: BudgetEvent) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Forward budget events to renderer for real-time UI updates
    mainWindow.webContents.send('cost:budget-event', {
      type: event.type,
      sessionId: event.sessionId,
      message: event.message,
      sessionCostUsd: event.sessionCostUsd,
      sessionLimitUsd: event.sessionLimitUsd,
      usageRatio: event.usageRatio,
      timestamp: event.timestamp,
      metadata: event.metadata,
    });
  });

  // ── cost:budget-set — Update session budget limit ──
  ipcMain.handle('cost:budget-set', async (_ev, args: any) => {
    if (!isEnabled()) {
      return { success: false, error: 'cost_controls feature is disabled' };
    }
    try {
      const limitUsd = typeof args?.limitUsd === 'number' ? args.limitUsd : undefined;
      if (limitUsd === undefined || limitUsd < 0) {
        return { success: false, error: 'Invalid budget limit. Provide a non-negative number.' };
      }

      const enforcer = getCostBudgetEnforcer();
      enforcer.updateConfig({ sessionLimitUsd: limitUsd });

      // Persist to DB config
      const db = getDb();
      if (db) {
        db.prepare(
          "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('cost-session-limit', ?, ?)",
        ).run(String(limitUsd), new Date().toISOString());
      }

      const status = enforcer.checkBudget();
      return { success: true, status };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to set budget' };
    }
  });

  // ── cost:budget-status — Get current session budget status ──
  ipcMain.handle('cost:budget-status', async () => {
    if (!isEnabled()) {
      return { success: false, error: 'cost_controls feature is disabled' };
    }
    try {
      const enforcer = getCostBudgetEnforcer();
      const status: BudgetStatus = enforcer.checkBudget();
      return {
        success: true,
        status: {
          sessionCostUsd: status.sessionCostUsd,
          sessionLimitUsd: status.sessionLimitUsd,
          usageRatio: status.usageRatio,
          warningReached: status.warningReached,
          downgradeActive: status.downgradeActive,
          budgetExhausted: status.budgetExhausted,
          activeModel: status.activeModel,
        },
      };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to get budget status' };
    }
  });

  // ── cost:alert-config — Get/Set alert thresholds and notification preferences ──
  ipcMain.handle('cost:alert-config', async (_ev, args: any) => {
    if (!isEnabled()) {
      return { success: false, error: 'cost_controls feature is disabled' };
    }
    try {
      const enforcer = getCostBudgetEnforcer();
      const currentConfig = enforcer.getConfig();

      // GET mode: no updates provided
      if (!args || !args.updates) {
        const db = getDb();
        let notifyOnWarning = true;
        let notifyOnExhausted = true;
        if (db) {
          try {
            const row = db
              .prepare("SELECT value FROM config WHERE key = 'cost-alert-config'")
              .get() as any;
            if (row) {
              const parsed = JSON.parse(row.value);
              notifyOnWarning = parsed.notifyOnWarning !== false;
              notifyOnExhausted = parsed.notifyOnExhausted !== false;
            }
          } catch {}
        }
        return {
          success: true,
          config: {
            warningThreshold: currentConfig.warningThreshold,
            downgradeThreshold: currentConfig.downgradeThreshold,
            downgradeModel: currentConfig.downgradeModel,
            notifyOnWarning,
            notifyOnExhausted,
          } as AlertConfig,
        };
      }

      // SET mode: apply updates
      const updates = args.updates as Partial<AlertConfig>;
      const configUpdates: Partial<CostBudgetConfig> = {};

      if (typeof updates.warningThreshold === 'number') {
        configUpdates.warningThreshold = Math.max(0, Math.min(1, updates.warningThreshold));
      }
      if (typeof updates.downgradeThreshold === 'number') {
        configUpdates.downgradeThreshold = Math.max(0, Math.min(1, updates.downgradeThreshold));
      }
      if (updates.downgradeModel && updates.downgradeModel.provider && updates.downgradeModel.model) {
        configUpdates.downgradeModel = {
          provider: updates.downgradeModel.provider,
          model: updates.downgradeModel.model,
        };
      }

      if (Object.keys(configUpdates).length > 0) {
        enforcer.updateConfig(configUpdates);
      }

      // Persist notification preferences
      const db = getDb();
      if (db) {
        const notifConfig = {
          notifyOnWarning: updates.notifyOnWarning !== false,
          notifyOnExhausted: updates.notifyOnExhausted !== false,
        };
        db.prepare(
          "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('cost-alert-config', ?, ?)",
        ).run(JSON.stringify(notifConfig), new Date().toISOString());
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to update alert config' };
    }
  });

  // ── cost:session-summary — Get session + monthly spending breakdown ──
  ipcMain.handle('cost:session-summary', async () => {
    if (!isEnabled()) {
      return { success: false, error: 'cost_controls feature is disabled' };
    }
    try {
      const enforcer = getCostBudgetEnforcer();
      const status = enforcer.checkBudget();
      const sessionId = getActiveSessionId() || 'unknown';

      // Build monthly summary from cost_records table
      let monthlySummary: MonthlySummary | null = null;
      const db = getDb();
      if (db) {
        try {
          // Get beginning of current month
          const now = new Date();
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

          // Total cost this month
          const totalRow = db
            .prepare(
              "SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE recorded_at >= ?",
            )
            .get(monthStart) as any;

          // By provider
          const byProvider = db
            .prepare(
              "SELECT provider, COALESCE(SUM(cost), 0) as costUsd, COUNT(*) as callCount FROM cost_records WHERE recorded_at >= ? GROUP BY provider ORDER BY costUsd DESC",
            )
            .all(monthStart) as any[];

          // By model
          const byModel = db
            .prepare(
              "SELECT model, COALESCE(SUM(cost), 0) as costUsd, COUNT(*) as callCount FROM cost_records WHERE recorded_at >= ? GROUP BY model ORDER BY costUsd DESC",
            )
            .all(monthStart) as any[];

          // By project (as proxy for task type)
          const byTask = db
            .prepare(
              "SELECT project_id as taskType, COALESCE(SUM(cost), 0) as costUsd, COUNT(*) as callCount FROM cost_records WHERE recorded_at >= ? GROUP BY project_id ORDER BY costUsd DESC LIMIT 10",
            )
            .all(monthStart) as any[];

          monthlySummary = {
            totalCostUsd: totalRow?.total || 0,
            byProvider: (byProvider || []).map((r: any) => ({
              provider: r.provider || 'unknown',
              costUsd: r.costUsd || 0,
              callCount: r.callCount || 0,
            })),
            byModel: (byModel || []).map((r: any) => ({
              model: r.model || 'unknown',
              costUsd: r.costUsd || 0,
              callCount: r.callCount || 0,
            })),
            byTask: (byTask || []).map((r: any) => ({
              taskType: r.taskType || 'unknown',
              costUsd: r.costUsd || 0,
              callCount: r.callCount || 0,
            })),
          };
        } catch (dbErr: any) {
          console.warn('[CostIPC] Monthly summary query failed:', dbErr?.message);
        }
      }

      const summary: SessionSummary = {
        sessionId,
        sessionCostUsd: status.sessionCostUsd,
        sessionLimitUsd: status.sessionLimitUsd,
        usageRatio: status.usageRatio,
        warningReached: status.warningReached,
        downgradeActive: status.downgradeActive,
        budgetExhausted: status.budgetExhausted,
        monthlySummary,
      };

      return { success: true, summary };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to get session summary' };
    }
  });
}
