/**
 * IPC handler registration for the AuthR Drift Management System.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (trace-ipc.ts, artifact-ipc.ts).
 *
 * Channels:
 *   drift:get-state    — retrieve current DriftDashboardState
 *
 * Real-time streaming pushes (main → renderer):
 *   drift:signal       — pushed to renderer on critical drift signals
 *   drift:state-update — pushed to renderer on state changes
 *
 * Requirements: 6.5, 8.5, 8.7
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { DriftMonitor } from '../drift/drift-monitor.js';
import type { DriftDashboardState } from '../shared/feature-integration-types.js';
import type { DriftSignal } from '../drift/drift-signal.js';
import type { StoredAgentRunSnapshot } from '../metrics/agent-loop-metrics.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface DriftIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

export interface DriftDashboardResponse extends DriftDashboardState {
  latestCompleted?: StoredAgentRunSnapshot | null;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): DriftIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Default inactive state ─────────────────────────────────────

const INACTIVE_STATE: DriftDashboardState = {
  active: false,
  confidence: 1.0,
  signals: [],
  scope: {
    toolsUsed: 0,
    toolsAllowed: 0,
    pathsModified: 0,
    pathsAllowed: 0,
  },
  staleCountdownMs: 0,
  anchor: null,
};

// ─── Registration ───────────────────────────────────────────────

export interface DriftIPCOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Returns only a monitor associated with the requested project, when supplied. */
  getDriftMonitor: (projectId?: string) => DriftMonitor | null;
  /** Returns durable evidence from the most recently completed project run. */
  getLatestCompletedRun?: (projectId: string) => StoredAgentRunSnapshot | null;
}

/**
 * Registers IPC handlers for drift dashboard communication.
 *
 * The renderer process can request state via 'drift:get-state'.
 * The main process pushes updates via 'drift:signal' and 'drift:state-update'.
 */
export function registerDriftIPC(options: DriftIPCOptions): void {
  const { getDriftMonitor, getLatestCompletedRun } = options;

  // ── drift:get-state ──
  // Requirement 8.5: Dashboard updates within 100ms via IPC handle pattern
  // Requirement 8.7: Follow existing renderer panel patterns for IPC communication
  ipcMain.handle('drift:get-state', (_event, args?: { projectId?: string }): DriftDashboardResponse | DriftIPCErrorResponse => {
    try {
      const requestedProjectId = typeof args?.projectId === 'string' && args.projectId.length > 0
        ? args.projectId
        : undefined;
      const monitor = getDriftMonitor(requestedProjectId);
      const latestCompleted = requestedProjectId && getLatestCompletedRun
        ? getLatestCompletedRun(requestedProjectId)
        : null;

      if (!monitor || !monitor.isActive()) {
        return latestCompleted ? { ...INACTIVE_STATE, latestCompleted } : INACTIVE_STATE;
      }

      const liveState = monitor.getState();
      return latestCompleted ? { ...liveState, latestCompleted } : liveState;
    } catch (err) {
      return makeError('DRIFT_STATE_FAILED', err);
    }
  });
}

// ─── Push functions (main → renderer) ───────────────────────────

/**
 * Push a critical drift signal to the renderer process.
 *
 * Called by the DriftMonitor when a critical signal is emitted.
 * Requirement 6.5: Critical signals sent via IPC to renderer for user notification.
 */
export function pushDriftSignal(
  mainWindow: BrowserWindow | null,
  signal: DriftSignal,
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('drift:signal', signal);
  }
}

/**
 * Push a state update to the renderer process.
 *
 * Called when drift state changes and the dashboard needs to refresh.
 * Requirement 8.5: Dashboard updates within 100ms of signal emission.
 */
export function pushDriftStateUpdate(
  mainWindow: BrowserWindow | null,
  state: DriftDashboardState,
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('drift:state-update', state);
  }
}
