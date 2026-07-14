/**
 * Interactive Terminal IPC Handler — Wires PTY-based agent terminal to the renderer.
 *
 * Registers IPC handlers for:
 *   - `terminal:create` — Create a new interactive terminal session
 *   - `terminal:write` — Write input to a terminal session
 *   - `terminal:read` — Read output from a terminal session
 *   - `terminal:close` — Close a terminal session
 *
 * Feature-gated behind the `interactive_terminal` flag.
 * The InteractiveTerminal class (task 16.1) provides the backend PTY management.
 *
 * Requirements: 19.5
 */

import { ipcMain, type BrowserWindow } from 'electron';
import {
  InteractiveTerminal,
  type InteractiveTerminalConfig,
  type PtySpawnFn,
} from '../terminal/interactive-terminal.js';

// ─── Types ──────────────────────────────────────────────────────

/** Dependencies injected by the caller (registerIPCHandlers in ipc.ts) */
export interface TerminalIPCDeps {
  /** Check if the interactive_terminal feature flag is enabled */
  isFeatureEnabled: () => boolean;
  /** The main BrowserWindow (for sending push events) */
  mainWindow?: BrowserWindow;
  /** Optional PTY spawn function override (for testing or custom spawners) */
  spawnPty?: PtySpawnFn;
  /** Optional terminal configuration overrides */
  terminalConfig?: Partial<InteractiveTerminalConfig>;
  /** Get the active workspace/project ID */
  getActiveWorkspaceId?: () => string | null;
  /** Get the active project directory (used as CWD for new terminals) */
  getActiveProjectDir?: () => string | null;
}

// ─── Singleton State ────────────────────────────────────────────

let terminalInstance: InteractiveTerminal | null = null;

/**
 * Get or create the InteractiveTerminal singleton.
 * Lazily initialized on first use when the feature flag is enabled.
 */
function getTerminal(deps: TerminalIPCDeps): InteractiveTerminal | null {
  if (!deps.isFeatureEnabled()) {
    return null;
  }

  if (!terminalInstance) {
    const spawnPty = deps.spawnPty || getDefaultPtySpawn();
    if (!spawnPty) {
      return null;
    }

    terminalInstance = new InteractiveTerminal(
      deps.terminalConfig || {},
      spawnPty,
      null, // CredentialProvider — wired separately when available
      null, // ApprovalCallback — wired via approval system
    );
  }

  return terminalInstance;
}

/**
 * Attempt to load node-pty and return a spawn function.
 * Returns null if node-pty is not available.
 */
function getDefaultPtySpawn(): PtySpawnFn | null {
  try {
    // node-pty is an optional native dependency
    const nodePty = require('node-pty');
    return (shell: string, args: string[], options: { cols: number; rows: number; cwd?: string; env?: Record<string, string> }) => {
      return nodePty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
      });
    };
  } catch {
    console.warn('[Terminal IPC] node-pty not available — interactive terminal will be disabled');
    return null;
  }
}

// ─── Error Constants ────────────────────────────────────────────

const FEATURE_DISABLED_ERROR = 'Interactive terminal is disabled. Enable the interactive_terminal feature flag.';
const PTY_UNAVAILABLE_ERROR = 'node-pty is not available. Install node-pty to use the interactive terminal.';

// ─── Registration ───────────────────────────────────────────────

/**
 * Register Interactive Terminal IPC handlers.
 *
 * Channels:
 *   - `terminal:create` — Create a new PTY session
 *   - `terminal:write` — Send input to a terminal session
 *   - `terminal:read` — Read buffered output from a terminal session
 *   - `terminal:close` — Close and cleanup a terminal session
 *
 * All handlers check the `interactive_terminal` feature flag first.
 * When disabled, they return appropriate error messages.
 *
 * Requirements: 19.5
 */
export function registerTerminalIPC(deps: TerminalIPCDeps): void {

  // ── terminal:create ─────────────────────────────────────────────
  ipcMain.handle('terminal:create', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const terminal = getTerminal(deps);
      if (!terminal) {
        return { success: false, error: PTY_UNAVAILABLE_ERROR };
      }

      const workspaceId = args?.workspaceId
        || (deps.getActiveWorkspaceId ? deps.getActiveWorkspaceId() : null)
        || 'default';

      const cwd = args?.cwd
        || (deps.getActiveProjectDir ? deps.getActiveProjectDir() : null)
        || process.cwd();

      const env = args?.env || undefined;

      const result = terminal.createSession(workspaceId, cwd, env);

      if ('error' in result) {
        return { success: false, error: result.error };
      }

      return {
        success: true,
        sessionId: result.sessionId,
        workspaceId,
      };
    } catch (e: any) {
      return { success: false, error: `terminal:create failed: ${e?.message || String(e)}` };
    }
  });

  // ── terminal:write ──────────────────────────────────────────────
  ipcMain.handle('terminal:write', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const terminal = getTerminal(deps);
      if (!terminal) {
        return { success: false, error: PTY_UNAVAILABLE_ERROR };
      }

      const sessionId = args?.sessionId;
      const input = args?.input;

      if (!sessionId || typeof sessionId !== 'string') {
        return { success: false, error: 'sessionId is required' };
      }
      if (input === undefined || input === null) {
        return { success: false, error: 'input is required' };
      }

      const result = await terminal.terminalWrite(sessionId, String(input));
      return result;
    } catch (e: any) {
      return { success: false, error: `terminal:write failed: ${e?.message || String(e)}` };
    }
  });

  // ── terminal:read ───────────────────────────────────────────────
  ipcMain.handle('terminal:read', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const terminal = getTerminal(deps);
      if (!terminal) {
        return { success: false, error: PTY_UNAVAILABLE_ERROR };
      }

      const sessionId = args?.sessionId;
      const timeout = args?.timeout;

      if (!sessionId || typeof sessionId !== 'string') {
        return { success: false, error: 'sessionId is required' };
      }

      const result = await terminal.terminalRead(
        sessionId,
        typeof timeout === 'number' ? timeout : undefined,
      );
      return result;
    } catch (e: any) {
      return { success: false, error: `terminal:read failed: ${e?.message || String(e)}` };
    }
  });

  // ── terminal:close ──────────────────────────────────────────────
  ipcMain.handle('terminal:close', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const terminal = getTerminal(deps);
      if (!terminal) {
        return { success: false, error: PTY_UNAVAILABLE_ERROR };
      }

      const sessionId = args?.sessionId;

      if (!sessionId || typeof sessionId !== 'string') {
        return { success: false, error: 'sessionId is required' };
      }

      const result = terminal.closeSession(sessionId);
      return result;
    } catch (e: any) {
      return { success: false, error: `terminal:close failed: ${e?.message || String(e)}` };
    }
  });

  console.log('[IPC] Interactive Terminal IPC handlers registered (terminal:create, terminal:write, terminal:read, terminal:close)');
}

/**
 * Get the current terminal instance (for use by other modules).
 * Returns null if not initialized or feature is disabled.
 */
export function getTerminalInstance(): InteractiveTerminal | null {
  return terminalInstance;
}

/**
 * Dispose the terminal instance (for app shutdown).
 */
export function disposeTerminalIPC(): void {
  if (terminalInstance) {
    terminalInstance.dispose();
    terminalInstance = null;
  }
}

/**
 * Reset the terminal singleton (for testing only).
 * @internal
 */
export function _resetTerminalInstance(): void {
  if (terminalInstance) {
    terminalInstance.dispose();
  }
  terminalInstance = null;
}
