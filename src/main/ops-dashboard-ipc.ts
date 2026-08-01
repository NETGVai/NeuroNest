/**
 * Operations Dashboard IPC Handler — Main-process IPC handlers for the
 * Operations Dashboard panel.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, cost-ipc.ts, benchmark-ipc.ts).
 *
 * Channels:
 *   ops:get-active-runs       — Query active agent runs
 *   ops:get-pending-approvals — Query pending capability grant approvals
 *   ops:get-cost-status       — Query budget/cost status
 *   ops:get-policy-decisions  — Query recent policy evaluation decisions
 *   ops:approve-grant         — Process a grant approval/denial decision
 *   ops:subscribe-updates     — Register renderer for push-based state updates
 *
 * Requirements: 15.5, 15.6
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import type { ExtendedBudgetManager } from '../pipeline/budget-manager-extended';
import type { CapabilityGrantSystem } from '../devops-engine/capability-grant';
import type { AuditChainInterface } from '../devops-engine/audit-chain';

import { getAgentById } from '../agents/agent-registry';

// ─── Types ──────────────────────────────────────────────────────

/** Active run as presented to the Operations Dashboard renderer. */
export interface OpsActiveRun {
  runId: string;
  agentId: string;
  agentName: string;
  agentEmoji: string;
  status: 'running' | 'paused' | 'awaiting-approval' | 'terminated';
  startedAt: number;
  accumulatedCostUSD: number;
}

/** Pending approval as presented to the Operations Dashboard renderer. */
export interface OpsPendingApproval {
  grantId: string;
  requestingAgentId: string;
  requestingAgentName: string;
  requestingAgentEmoji: string;
  capability: string;
  target: string;
  requestedAt: number;
  timeoutAt: number;
}

/** Cost status as presented to the Operations Dashboard renderer. */
export interface OpsCostStatus {
  dailyTotalUSD: number;
  dailyStopLossUSD: number;
  perModelSpend: Array<{ modelId: string; costUSD: number }>;
  dataPoints: Array<{ timestamp: number; costUSD: number; modelId: string }>;
}

/** Policy decision as presented to the Operations Dashboard renderer. */
export interface OpsPolicyDecision {
  correlationId: string;
  decision: 'allow' | 'deny' | 'escalate';
  matchedRule: string | null;
  toolName: string;
  agentId: string;
  timestamp: number;
  reason?: string;
}

/** Push update event sent to the renderer. */
export interface OpsUpdateEvent {
  type: 'active-runs' | 'pending-approvals' | 'cost-status' | 'policy-decisions';
  data: unknown;
}

// ─── Error Response ─────────────────────────────────────────────

interface OpsIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

function makeError(code: string, err: unknown): OpsIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

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

interface GrantRow {
  id: string;
  environment: string;
  capability_type: string;
  target_set_json: string;
  reason: string;
  proposed_by: string;
  approved_by: string | null;
  lifetime_ms: number;
  max_executions: number;
  remaining_executions: number;
  dry_run_required: number;
  status: string;
  created_at: number;
  expires_at: number;
  activated_at: number | null;
}

// ─── Dependencies ───────────────────────────────────────────────

export interface OpsDashboardIPCDependencies {
  mainWindow: BrowserWindow;
  db: Database.Database;
  budgetManager?: ExtendedBudgetManager;
  capabilityGrantSystem?: CapabilityGrantSystem;
  auditChain?: AuditChainInterface;
}

// ─── Subscription State ─────────────────────────────────────────

/** Tracks subscribed renderer windows and recent policy decisions in-memory. */
let subscribedWindow: BrowserWindow | null = null;
let recentPolicyDecisions: OpsPolicyDecision[] = [];
const MAX_POLICY_DECISIONS = 100;

// ─── Push Update Helpers ────────────────────────────────────────

/**
 * Push an update event to the subscribed renderer window.
 * Data must be pushed within 3 seconds of state changes (Req 15.6).
 */
function pushUpdate(event: OpsUpdateEvent): void {
  if (!subscribedWindow || subscribedWindow.isDestroyed()) return;
  try {
    subscribedWindow.webContents.send('ops:subscribe-updates', event);
  } catch {
    // Best-effort push — don't crash if renderer is unavailable
  }
}

/**
 * Record a policy decision and push it to the subscribed renderer.
 * Exported for use by the policy engine integration.
 */
export function recordPolicyDecision(decision: OpsPolicyDecision): void {
  recentPolicyDecisions.unshift(decision);
  if (recentPolicyDecisions.length > MAX_POLICY_DECISIONS) {
    recentPolicyDecisions.pop();
  }
  pushUpdate({ type: 'policy-decisions', data: recentPolicyDecisions });
}

/**
 * Notify the dashboard of active-runs state change.
 * Call this when a run starts, ends, or has cost updated.
 */
export function notifyActiveRunsChanged(runs: OpsActiveRun[]): void {
  pushUpdate({ type: 'active-runs', data: runs });
}

/**
 * Notify the dashboard of pending-approvals state change.
 * Call this when a grant is proposed or resolved.
 */
export function notifyPendingApprovalsChanged(approvals: OpsPendingApproval[]): void {
  pushUpdate({ type: 'pending-approvals', data: approvals });
}

/**
 * Notify the dashboard of cost status change.
 * Call this after model usage is recorded.
 */
export function notifyCostStatusChanged(costStatus: OpsCostStatus): void {
  pushUpdate({ type: 'cost-status', data: costStatus });
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register all Operations Dashboard IPC handlers with Electron's ipcMain.
 * Must be called once during main process initialization.
 */
export function registerOpsDashboardIPC(deps: OpsDashboardIPCDependencies): void {
  const { mainWindow, db, budgetManager, capabilityGrantSystem, auditChain } = deps;

  // ── ops:get-active-runs ──
  // Requirement 15.1: Query active agent runs
  ipcMain.handle('ops:get-active-runs', async () => {
    try {
      const rows = db.prepare(
        `SELECT * FROM run_budgets WHERE ended_at IS NULL ORDER BY started_at DESC`
      ).all() as RunBudgetRow[];

      const runs: OpsActiveRun[] = rows.map((row) => {
        const agent = getAgentById(row.agent_id);
        return {
          runId: row.run_id,
          agentId: row.agent_id,
          agentName: agent?.name ?? row.agent_id,
          agentEmoji: agent?.emoji ?? '🤖',
          status: 'running' as const,
          startedAt: row.started_at,
          accumulatedCostUSD: row.current_cost_usd,
        };
      });

      return runs;
    } catch (err) {
      return makeError('OPS_ACTIVE_RUNS_FAILED', err);
    }
  });

  // ── ops:get-pending-approvals ──
  // Requirement 15.2: Query pending capability grant approvals
  ipcMain.handle('ops:get-pending-approvals', async () => {
    try {
      const rows = db.prepare(
        `SELECT * FROM capability_grants WHERE status = 'proposed' ORDER BY created_at DESC`
      ).all() as GrantRow[];

      const approvals: OpsPendingApproval[] = rows.map((row) => {
        const agent = getAgentById(row.proposed_by);
        const targetSet = JSON.parse(row.target_set_json) as string[];
        return {
          grantId: row.id,
          requestingAgentId: row.proposed_by,
          requestingAgentName: agent?.name ?? row.proposed_by,
          requestingAgentEmoji: agent?.emoji ?? '🤖',
          capability: row.capability_type,
          target: targetSet.join(', '),
          requestedAt: row.created_at,
          timeoutAt: row.expires_at,
        };
      });

      return approvals;
    } catch (err) {
      return makeError('OPS_PENDING_APPROVALS_FAILED', err);
    }
  });

  // ── ops:get-cost-status ──
  // Requirement 15.3: Query budget/cost status
  ipcMain.handle('ops:get-cost-status', async () => {
    try {
      if (budgetManager) {
        const status = budgetManager.getStatus();
        // Build per-model spend and data points from cost records in run_budgets
        const perModelSpend: Array<{ modelId: string; costUSD: number }> = [];
        const dataPoints: Array<{ timestamp: number; costUSD: number; modelId: string }> = [];

        // Attempt to get per-model breakdown from daily cost data if available
        try {
          const today = new Date();
          const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
          const todayStart = new Date(todayStr + 'T00:00:00.000Z').getTime();

          // Query audit chain for cost events today to extract model breakdown
          if (auditChain) {
            const events = auditChain.query({ since: todayStart, limit: 500 });
            const modelCosts = new Map<string, number>();

            for (const event of events) {
              if (event.cost > 0) {
                const args = event.arguments as Record<string, unknown>;
                const modelId = (args['modelId'] as string) || 'unknown';
                modelCosts.set(modelId, (modelCosts.get(modelId) ?? 0) + event.cost);
                dataPoints.push({
                  timestamp: event.timestamp,
                  costUSD: event.cost,
                  modelId,
                });
              }
            }

            for (const [modelId, costUSD] of modelCosts.entries()) {
              perModelSpend.push({ modelId, costUSD });
            }
          }
        } catch {
          // Best-effort model breakdown; return what we have
        }

        const costStatus: OpsCostStatus = {
          dailyTotalUSD: status.daily.totalCostUSD,
          dailyStopLossUSD: status.daily.stopLossUSD === Number.MAX_SAFE_INTEGER
            ? 0
            : status.daily.stopLossUSD,
          perModelSpend,
          dataPoints,
        };

        return costStatus;
      }

      // Fallback when budget manager is not available
      return {
        dailyTotalUSD: 0,
        dailyStopLossUSD: 0,
        perModelSpend: [],
        dataPoints: [],
      } as OpsCostStatus;
    } catch (err) {
      return makeError('OPS_COST_STATUS_FAILED', err);
    }
  });

  // ── ops:get-policy-decisions ──
  // Requirement 15.4: Query recent policy decisions
  ipcMain.handle('ops:get-policy-decisions', async () => {
    try {
      return recentPolicyDecisions;
    } catch (err) {
      return makeError('OPS_POLICY_DECISIONS_FAILED', err);
    }
  });

  // ── ops:approve-grant ──
  // Requirement 15.5: Process approval/denial within 2 seconds
  ipcMain.handle(
    'ops:approve-grant',
    async (_event, args: { grantId: string; decision: 'approve' | 'deny' }) => {
      try {
        if (!args || !args.grantId || !args.decision) {
          return makeError(
            'OPS_APPROVE_INVALID_ARGS',
            new Error('Missing required fields: grantId, decision')
          );
        }

        if (args.decision !== 'approve' && args.decision !== 'deny') {
          return makeError(
            'OPS_APPROVE_INVALID_DECISION',
            new Error("Decision must be 'approve' or 'deny'")
          );
        }

        if (!capabilityGrantSystem) {
          return makeError(
            'OPS_APPROVE_UNAVAILABLE',
            new Error('Capability grant system is not available')
          );
        }

        if (args.decision === 'approve') {
          // Use 'ops-dashboard-user' as the approver identity for user-initiated approvals.
          // This satisfies proposer/approver separation since agents propose and users approve.
          capabilityGrantSystem.approve(args.grantId, 'ops-dashboard-user');
        } else {
          capabilityGrantSystem.revoke(args.grantId, 'Denied via Operations Dashboard');
        }

        // Push updated approvals list to renderer after processing
        const updatedRows = db.prepare(
          `SELECT * FROM capability_grants WHERE status = 'proposed' ORDER BY created_at DESC`
        ).all() as GrantRow[];

        const updatedApprovals: OpsPendingApproval[] = updatedRows.map((row) => {
          const agent = getAgentById(row.proposed_by);
          const targetSet = JSON.parse(row.target_set_json) as string[];
          return {
            grantId: row.id,
            requestingAgentId: row.proposed_by,
            requestingAgentName: agent?.name ?? row.proposed_by,
            requestingAgentEmoji: agent?.emoji ?? '🤖',
            capability: row.capability_type,
            target: targetSet.join(', '),
            requestedAt: row.created_at,
            timeoutAt: row.expires_at,
          };
        });

        pushUpdate({ type: 'pending-approvals', data: updatedApprovals });

        return { success: true, grantId: args.grantId, decision: args.decision };
      } catch (err) {
        return makeError('OPS_APPROVE_FAILED', err);
      }
    }
  );

  // ── ops:subscribe-updates ──
  // Requirement 15.6: Register renderer for push-based state updates
  ipcMain.handle('ops:subscribe-updates', async () => {
    try {
      subscribedWindow = mainWindow;

      // Send initial state snapshot immediately upon subscription
      // so the renderer has current data right away.
      const activeRunsRows = db.prepare(
        `SELECT * FROM run_budgets WHERE ended_at IS NULL ORDER BY started_at DESC`
      ).all() as RunBudgetRow[];

      const activeRuns: OpsActiveRun[] = activeRunsRows.map((row) => {
        const agent = getAgentById(row.agent_id);
        return {
          runId: row.run_id,
          agentId: row.agent_id,
          agentName: agent?.name ?? row.agent_id,
          agentEmoji: agent?.emoji ?? '🤖',
          status: 'running' as const,
          startedAt: row.started_at,
          accumulatedCostUSD: row.current_cost_usd,
        };
      });

      pushUpdate({ type: 'active-runs', data: activeRuns });
      pushUpdate({ type: 'pending-approvals', data: [] });
      pushUpdate({ type: 'policy-decisions', data: recentPolicyDecisions });

      return { subscribed: true };
    } catch (err) {
      return makeError('OPS_SUBSCRIBE_FAILED', err);
    }
  });
}
