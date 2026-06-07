/**
 * ObservabilityDashboard — Token usage, cost, execution history, budget alerts.
 *
 * Stub implementation with in-memory state. Provides dashboard data
 * for monitoring agent activity, costs, and performance.
 *
 * Requirements: 13.1–13.6
 */

import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface UsageRecord {
  id: string;
  providerId: string;
  model: string;
  tokenUsage: TokenUsage;
  sessionId?: string;
  agentId?: string;
  timestamp: Date;
}

export interface ExecutionRecord {
  id: string;
  type: 'agent' | 'swarm' | 'orchestrator';
  sessionId?: string;
  agentIds: string[];
  task: string;
  status: 'running' | 'completed' | 'failed';
  tokensUsed: number;
  estimatedCost: number;
  durationMs: number;
  timestamp: Date;
}

export interface BudgetAlert {
  id: string;
  providerId?: string; // null for global
  threshold: number;
  enabled: boolean;
}

export interface DashboardFilter {
  dateFrom?: Date;
  dateTo?: Date;
  sessionId?: string;
  domain?: string;
  providerId?: string;
}

export interface DashboardSummary {
  totalTokens: number;
  totalCost: number;
  totalRequests: number;
  byProvider: Map<string, { tokens: number; cost: number; requests: number }>;
}

// ─── ObservabilityDashboard ─────────────────────────────────────

export class ObservabilityDashboard {
  private usageRecords: UsageRecord[] = [];
  private executionRecords: ExecutionRecord[] = [];
  private budgetAlerts = new Map<string, BudgetAlert>();
  private alertCallbacks: Array<(alert: BudgetAlert, currentCost: number) => void> = [];

  /**
   * Record token usage.
   * Requirements: 13.1
   */
  recordUsage(record: Omit<UsageRecord, 'id' | 'timestamp'>): UsageRecord {
    const entry: UsageRecord = {
      ...record,
      id: randomUUID(),
      timestamp: new Date(),
    };
    this.usageRecords.push(entry);
    this.checkBudgetAlerts(record.providerId);
    return entry;
  }

  /**
   * Record an execution event.
   * Requirements: 13.2
   */
  recordExecution(record: Omit<ExecutionRecord, 'id' | 'timestamp'>): ExecutionRecord {
    const entry: ExecutionRecord = {
      ...record,
      id: randomUUID(),
      timestamp: new Date(),
    };
    this.executionRecords.push(entry);
    return entry;
  }

  /**
   * Get dashboard summary with optional filtering.
   * Requirements: 13.1, 13.3
   */
  getSummary(filter?: DashboardFilter): DashboardSummary {
    let records = this.usageRecords;

    if (filter) {
      records = records.filter((r) => {
        if (filter.dateFrom && r.timestamp < filter.dateFrom) return false;
        if (filter.dateTo && r.timestamp > filter.dateTo) return false;
        if (filter.sessionId && r.sessionId !== filter.sessionId) return false;
        if (filter.providerId && r.providerId !== filter.providerId) return false;
        return true;
      });
    }

    const byProvider = new Map<string, { tokens: number; cost: number; requests: number }>();
    let totalTokens = 0;
    let totalCost = 0;

    for (const record of records) {
      totalTokens += record.tokenUsage.totalTokens;
      totalCost += record.tokenUsage.estimatedCost;

      const existing = byProvider.get(record.providerId) ?? { tokens: 0, cost: 0, requests: 0 };
      existing.tokens += record.tokenUsage.totalTokens;
      existing.cost += record.tokenUsage.estimatedCost;
      existing.requests += 1;
      byProvider.set(record.providerId, existing);
    }

    return {
      totalTokens,
      totalCost,
      totalRequests: records.length,
      byProvider,
    };
  }

  /**
   * Get execution history with optional filtering.
   * Requirements: 13.2, 13.3
   */
  getExecutionHistory(filter?: DashboardFilter): ExecutionRecord[] {
    let records = this.executionRecords;

    if (filter) {
      records = records.filter((r) => {
        if (filter.dateFrom && r.timestamp < filter.dateFrom) return false;
        if (filter.dateTo && r.timestamp > filter.dateTo) return false;
        if (filter.sessionId && r.sessionId !== filter.sessionId) return false;
        return true;
      });
    }

    return records;
  }

  /**
   * Configure a budget alert.
   * Requirements: 13.5
   */
  setBudgetAlert(alert: Omit<BudgetAlert, 'id'>): BudgetAlert {
    const entry: BudgetAlert = { ...alert, id: randomUUID() };
    this.budgetAlerts.set(entry.id, entry);
    return entry;
  }

  /**
   * Get all budget alerts.
   */
  getBudgetAlerts(): BudgetAlert[] {
    return Array.from(this.budgetAlerts.values());
  }

  /**
   * Register a budget alert callback.
   */
  onBudgetAlert(callback: (alert: BudgetAlert, currentCost: number) => void): void {
    this.alertCallbacks.push(callback);
  }

  // ── Private helpers ─────────────────────────────────────────

  private checkBudgetAlerts(providerId: string): void {
    for (const alert of this.budgetAlerts.values()) {
      if (!alert.enabled) continue;

      const filter: DashboardFilter = alert.providerId ? { providerId: alert.providerId } : {};
      const summary = this.getSummary(filter);

      if (summary.totalCost >= alert.threshold) {
        for (const cb of this.alertCallbacks) {
          cb(alert, summary.totalCost);
        }
      }
    }
  }
}
