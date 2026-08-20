/**
 * Metrics Dashboard IPC handlers — exposes agent loop metrics to the
 * renderer process for display in the metrics dashboard panel.
 *
 * Registers two channels:
 *   - `get-session-metrics`    — returns per-session agent loop metrics
 *   - `get-cumulative-metrics` — returns aggregate metrics across all sessions
 *
 * Validates: Requirements 15.1, 15.2, 15.3
 */

import { ipcMain } from 'electron';
import type { AgentLoopMetricsStore } from '../metrics/agent-loop-metrics';

/**
 * Dependencies injected by the main IPC registration so this module
 * stays independently testable.
 */
export interface MetricsIPCDeps {
  /** The AgentLoopMetricsStore instance for querying metrics data. */
  metricsStore: AgentLoopMetricsStore;
}

/**
 * Registers metrics dashboard IPC handlers on ipcMain.
 *
 * Call this once during IPC initialization, passing the shared
 * AgentLoopMetricsStore reference.
 */
export function registerMetricsIPC(deps: MetricsIPCDeps): void {
  const { metricsStore } = deps;

  ipcMain.handle(
    'get-session-metrics',
    async (_ev: any, args: { sessionId: string }) => {
      try {
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId) {
          return { error: 'sessionId is required' };
        }

        const metrics = metricsStore.getSessionMetrics(args.sessionId);
        return metrics;
      } catch (e: any) {
        return { error: e.message || 'Failed to retrieve session metrics' };
      }
    },
  );

  ipcMain.handle(
    'get-cumulative-metrics',
    async (_ev: any, args?: { projectId?: string }) => {
      try {
        if (args?.projectId) {
          return metricsStore.getProjectCumulativeMetrics(args.projectId);
        }
        return metricsStore.getCumulativeMetrics();
      } catch (e: any) {
        return { error: e.message || 'Failed to retrieve cumulative metrics' };
      }
    },
  );
}
