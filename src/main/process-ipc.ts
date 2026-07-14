/**
 * Background Process Manager IPC Handler Registration
 *
 * Registers IPC channels for the background process management feature:
 *   - `process:start`   — Start a named background process
 *   - `process:stop`    — Stop a running process by ID
 *   - `process:list`    — List all managed processes
 *   - `process:logs`    — Get captured stdout/stderr for a process
 *   - `process:status`  — Get status of a specific process
 *
 * All handlers are gated behind the `background_processes` feature flag.
 *
 * Requirements: 11.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import {
  BackgroundProcessManager,
  type ManagedProcess,
  type ProcessStartOptions,
} from '../runtime/background-process-manager.js';
import { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ProcessIPCDeps {
  /** Main browser window for sending push events */
  mainWindow: BrowserWindow;
  /** Feature gate system for checking background_processes flag */
  featureGate?: FeatureGateSystem;
}

export interface ProcessStartResult {
  success: boolean;
  process?: ManagedProcess;
  error?: string;
  flagDisabled?: boolean;
}

export interface ProcessStopResult {
  success: boolean;
  error?: string;
  flagDisabled?: boolean;
}

export interface ProcessListResult {
  success: boolean;
  processes?: ManagedProcess[];
  error?: string;
  flagDisabled?: boolean;
}

export interface ProcessLogsResult {
  success: boolean;
  logs?: string[];
  error?: string;
  flagDisabled?: boolean;
}

export interface ProcessStatusResult {
  success: boolean;
  process?: ManagedProcess;
  error?: string;
  flagDisabled?: boolean;
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register background process manager IPC handlers.
 *
 * Channels registered:
 * - `process:start` — Start a named background process.
 *   Args: ProcessStartOptions
 *   Returns: ProcessStartResult
 *
 * - `process:stop` — Stop a running process by ID.
 *   Args: { id: string }
 *   Returns: ProcessStopResult
 *
 * - `process:list` — List all managed processes.
 *   Args: none
 *   Returns: ProcessListResult
 *
 * - `process:logs` — Get captured stdout/stderr for a process.
 *   Args: { id: string, lineCount?: number }
 *   Returns: ProcessLogsResult
 *
 * - `process:status` — Get status of a specific process.
 *   Args: { id: string }
 *   Returns: ProcessStatusResult
 *
 * All channels are gated behind the `background_processes` feature flag.
 * When the flag is disabled, handlers return early with appropriate responses.
 */
export function registerProcessIPC(deps: ProcessIPCDeps): void {
  const { mainWindow, featureGate } = deps;

  /** Check if the feature flag is enabled */
  function isEnabled(): boolean {
    if (!featureGate) return true;
    return featureGate.isEnabled('background_processes');
  }

  /** Get or create the BackgroundProcessManager singleton */
  function getManager(): BackgroundProcessManager {
    return BackgroundProcessManager.getInstance();
  }

  // ── process:start ───────────────────────────────────────────────
  // Start a named background process with specified command and cwd.
  ipcMain.handle('process:start', async (_ev, args?: any): Promise<ProcessStartResult> => {
    try {
      if (!isEnabled()) {
        return { success: false, flagDisabled: true, error: 'background_processes feature flag is disabled' };
      }

      if (!args || !args.name || !args.command || !args.cwd) {
        return { success: false, error: 'Missing required fields: name, command, cwd' };
      }

      const options: ProcessStartOptions = {
        name: String(args.name),
        command: String(args.command),
        cwd: String(args.cwd),
        ...(args.port != null ? { port: Number(args.port) } : {}),
        ...(args.env ? { env: args.env } : {}),
        ...(args.autoRestart != null ? { autoRestart: Boolean(args.autoRestart) } : {}),
        ...(args.maxRestarts != null ? { maxRestarts: Number(args.maxRestarts) } : {}),
      };

      const manager = getManager();
      const proc = await manager.startProcess(options);

      // Notify renderer of new process started
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('process:status-update', { event: 'started', process: proc });
      }

      return { success: true, process: proc };
    } catch (e: any) {
      console.error('[ProcessIPC] process:start error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error starting process' };
    }
  });

  // ── process:stop ────────────────────────────────────────────────
  // Stop a running process by its unique ID.
  ipcMain.handle('process:stop', async (_ev, args?: any): Promise<ProcessStopResult> => {
    try {
      if (!isEnabled()) {
        return { success: false, flagDisabled: true, error: 'background_processes feature flag is disabled' };
      }

      if (!args || !args.id) {
        return { success: false, error: 'Missing required field: id' };
      }

      const manager = getManager();
      await manager.stopProcess(String(args.id));

      // Notify renderer of process stop
      if (mainWindow && !mainWindow.isDestroyed()) {
        const proc = manager.getProcess(String(args.id));
        mainWindow.webContents.send('process:status-update', { event: 'stopped', process: proc });
      }

      return { success: true };
    } catch (e: any) {
      console.error('[ProcessIPC] process:stop error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error stopping process' };
    }
  });

  // ── process:list ────────────────────────────────────────────────
  // List all managed background processes.
  ipcMain.handle('process:list', async (): Promise<ProcessListResult> => {
    try {
      if (!isEnabled()) {
        return { success: false, flagDisabled: true, error: 'background_processes feature flag is disabled' };
      }

      const manager = getManager();
      const processes = manager.listProcesses();

      return { success: true, processes };
    } catch (e: any) {
      console.error('[ProcessIPC] process:list error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error listing processes' };
    }
  });

  // ── process:logs ────────────────────────────────────────────────
  // Get the captured stdout/stderr log lines for a specific process.
  ipcMain.handle('process:logs', async (_ev, args?: any): Promise<ProcessLogsResult> => {
    try {
      if (!isEnabled()) {
        return { success: false, flagDisabled: true, error: 'background_processes feature flag is disabled' };
      }

      if (!args || !args.id) {
        return { success: false, error: 'Missing required field: id' };
      }

      const manager = getManager();
      const lineCount = args.lineCount != null ? Number(args.lineCount) : undefined;
      const logs = manager.getProcessLogs(String(args.id), lineCount);

      return { success: true, logs };
    } catch (e: any) {
      console.error('[ProcessIPC] process:logs error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error fetching logs' };
    }
  });

  // ── process:status ──────────────────────────────────────────────
  // Get the current status of a specific process by ID.
  ipcMain.handle('process:status', async (_ev, args?: any): Promise<ProcessStatusResult> => {
    try {
      if (!isEnabled()) {
        return { success: false, flagDisabled: true, error: 'background_processes feature flag is disabled' };
      }

      if (!args || !args.id) {
        return { success: false, error: 'Missing required field: id' };
      }

      const manager = getManager();
      const proc = manager.getProcess(String(args.id));

      if (!proc) {
        return { success: false, error: `Process not found: ${args.id}` };
      }

      return { success: true, process: proc };
    } catch (e: any) {
      console.error('[ProcessIPC] process:status error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error fetching status' };
    }
  });

  // ── Event forwarding ────────────────────────────────────────────
  // Forward BackgroundProcessManager events to the renderer for real-time UI updates.
  try {
    const manager = getManager();

    manager.on('process:started', (proc: ManagedProcess) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('process:status-update', { event: 'started', process: proc });
      }
    });

    manager.on('process:stopped', (proc: ManagedProcess) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('process:status-update', { event: 'stopped', process: proc });
      }
    });

    manager.on('process:crashed', (proc: ManagedProcess) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('process:status-update', { event: 'crashed', process: proc });
      }
    });

    manager.on('process:restarting', (proc: ManagedProcess) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('process:status-update', { event: 'restarting', process: proc });
      }
    });
  } catch (eventErr: any) {
    console.warn('[ProcessIPC] Failed to set up event forwarding:', eventErr?.message);
  }

  console.log('[IPC] Background Process Manager IPC handlers registered (process:start, process:stop, process:list, process:logs, process:status)');
}
