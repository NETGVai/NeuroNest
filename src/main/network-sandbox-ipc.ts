/**
 * IPC handler registration for the Network Sandbox system.
 *
 * Channels:
 *   sandbox:policy-get   — retrieve the current network policy configuration
 *   sandbox:policy-set   — update the network policy (preset or custom rules)
 *   sandbox:log          — get recent network request log entries for a session
 *   sandbox:activity     — get real-time network activity summary (counts, top domains)
 *
 * Uses the lazy-singleton pattern matching existing NeuroNest IPC modules.
 * Gated behind the `network_sandbox` feature flag.
 *
 * Requirements: 10.1, 10.2, 10.4, 10.7
 */

import { ipcMain } from 'electron';
import {
  NetworkSandbox,
  type NetworkPolicy,
  type NetworkPolicyPreset,
  type NetworkRequestLog,
} from '../security/network-sandbox.js';

// ─── Types ──────────────────────────────────────────────────────

export interface NetworkSandboxIPCOptions {
  /** Function to check if the network_sandbox feature flag is enabled */
  isFeatureEnabled: () => boolean;
}

interface PolicySetPayload {
  preset?: NetworkPolicyPreset;
  strictAllowlist?: string[];
  customPolicy?: NetworkPolicy;
}

interface LogQueryPayload {
  sessionId: string;
  limit?: number;
  /** Filter by action: 'allowed' | 'blocked' */
  action?: 'allowed' | 'blocked';
  /** Filter by domain substring */
  domain?: string;
  /** Filter by agent ID */
  agentId?: string;
}

interface ActivitySummary {
  totalRequests: number;
  allowedCount: number;
  blockedCount: number;
  topDomains: Array<{ domain: string; count: number; blocked: number }>;
  recentRequests: NetworkRequestLog[];
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register network sandbox IPC handlers with the main process.
 */
export function registerNetworkSandboxIPC(options: NetworkSandboxIPCOptions): void {
  const { isFeatureEnabled } = options;

  // ── sandbox:policy-get ────────────────────────────────────────
  ipcMain.handle('sandbox:policy-get', () => {
    if (!isFeatureEnabled()) {
      return { error: true, code: 'FEATURE_DISABLED', message: 'network_sandbox feature is disabled' };
    }
    try {
      const sandbox = NetworkSandbox.getInstance();
      const policy = sandbox.getPolicy();
      return { success: true, policy };
    } catch (err: unknown) {
      return { error: true, code: 'POLICY_GET_FAILED', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── sandbox:policy-set ────────────────────────────────────────
  ipcMain.handle('sandbox:policy-set', (_ev, payload: PolicySetPayload) => {
    if (!isFeatureEnabled()) {
      return { error: true, code: 'FEATURE_DISABLED', message: 'network_sandbox feature is disabled' };
    }
    try {
      const sandbox = NetworkSandbox.getInstance();

      if (payload.customPolicy) {
        sandbox.setPolicy(payload.customPolicy);
      } else if (payload.preset) {
        sandbox.setPreset(payload.preset, payload.strictAllowlist);
      } else {
        return { error: true, code: 'INVALID_PAYLOAD', message: 'Must provide preset or customPolicy' };
      }

      return { success: true, policy: sandbox.getPolicy() };
    } catch (err: unknown) {
      return { error: true, code: 'POLICY_SET_FAILED', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── sandbox:log ───────────────────────────────────────────────
  ipcMain.handle('sandbox:log', (_ev, payload: LogQueryPayload) => {
    if (!isFeatureEnabled()) {
      return { error: true, code: 'FEATURE_DISABLED', message: 'network_sandbox feature is disabled' };
    }
    try {
      const sandbox = NetworkSandbox.getInstance();
      const sessionId = payload.sessionId || 'unknown';
      let entries = sandbox.getRequestLog(sessionId, payload.limit || 200);

      // Apply optional filters
      if (payload.action) {
        entries = entries.filter(e => e.action === payload.action);
      }
      if (payload.domain) {
        const domainFilter = payload.domain.toLowerCase();
        entries = entries.filter(e => e.domain.toLowerCase().includes(domainFilter));
      }
      if (payload.agentId) {
        entries = entries.filter(e => e.agentId === payload.agentId);
      }

      return { success: true, entries };
    } catch (err: unknown) {
      return { error: true, code: 'LOG_QUERY_FAILED', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── sandbox:activity ──────────────────────────────────────────
  ipcMain.handle('sandbox:activity', (_ev, payload?: { sessionId?: string; limit?: number }) => {
    if (!isFeatureEnabled()) {
      return { error: true, code: 'FEATURE_DISABLED', message: 'network_sandbox feature is disabled' };
    }
    try {
      const sandbox = NetworkSandbox.getInstance();
      const sessionId = payload?.sessionId || 'unknown';
      const entries = sandbox.getRequestLog(sessionId);

      // Build activity summary
      const allowedCount = entries.filter(e => e.action === 'allowed').length;
      const blockedCount = entries.filter(e => e.action === 'blocked').length;

      // Compute top domains
      const domainMap: Record<string, { count: number; blocked: number }> = {};
      for (const entry of entries) {
        if (!domainMap[entry.domain]) {
          domainMap[entry.domain] = { count: 0, blocked: 0 };
        }
        domainMap[entry.domain]!.count++;
        if (entry.action === 'blocked') {
          domainMap[entry.domain]!.blocked++;
        }
      }

      const topDomains = Object.entries(domainMap)
        .map(([domain, stats]) => ({ domain, count: stats.count, blocked: stats.blocked }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      // Return recent requests (most recent N)
      const recentLimit = payload?.limit || 50;
      const recentRequests = entries.slice(-recentLimit);

      const summary: ActivitySummary = {
        totalRequests: entries.length,
        allowedCount,
        blockedCount,
        topDomains,
        recentRequests,
      };

      return { success: true, ...summary };
    } catch (err: unknown) {
      return { error: true, code: 'ACTIVITY_QUERY_FAILED', message: err instanceof Error ? err.message : String(err) };
    }
  });
}
