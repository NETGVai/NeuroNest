/**
 * Security Remediation IPC handlers — exposes remediation success rate metrics
 * per finding category to the renderer process for dashboard display.
 *
 * Registers one channel:
 *   - `security:remediation-stats` — returns per-category remediation stats
 *
 * Validates: Requirement 22.5
 */

import { ipcMain } from 'electron';
import type { SecurityRemediationBridge, RemediationStats } from '../pipeline/security-remediation-bridge.js';

/**
 * Dependencies injected by the main IPC registration so this module
 * stays independently testable.
 */
export interface SecurityRemediationIPCDeps {
  /** Returns the active SecurityRemediationBridge instance, or undefined if not wired. */
  getRemediationBridge: () => SecurityRemediationBridge | undefined;
}

/**
 * Serializable remediation stats returned via IPC.
 * Converts the Map from getAllStats() into a plain object for JSON serialization.
 */
export interface SerializedRemediationStats {
  [category: string]: RemediationStats;
}

/**
 * Registers security remediation IPC handlers on ipcMain.
 *
 * Call this once during IPC initialization, passing a getter for the
 * SecurityRemediationBridge reference (which may be initialized lazily).
 */
export function registerSecurityRemediationIPC(deps: SecurityRemediationIPCDeps): void {
  const { getRemediationBridge } = deps;

  ipcMain.handle(
    'security:remediation-stats',
    async (_ev: unknown) => {
      try {
        const bridge = getRemediationBridge();
        if (!bridge) {
          return { stats: {} };
        }

        const statsMap = bridge.getAllStats();
        const serialized: SerializedRemediationStats = {};
        for (const [category, stats] of statsMap) {
          serialized[category] = stats;
        }

        return { stats: serialized };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to retrieve remediation stats';
        return { error: message };
      }
    },
  );
}
