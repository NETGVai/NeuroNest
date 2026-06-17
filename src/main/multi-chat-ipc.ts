/**
 * Multi-Chat IPC handlers — enables multiple independent chat sessions
 * within the same project via Electron IPC.
 *
 * Registers three channels:
 *   - `create-chat-session`  — creates a new chat session for a project
 *   - `list-chat-sessions`   — lists all chat sessions for a project
 *   - `switch-chat-session`  — switches the active chat session
 *
 * After mutations (create/switch), the updated session list is pushed to
 * the renderer via the `chat-sessions-updated` event so the sidebar stays
 * in sync without polling.
 *
 * Requirements: 7.4
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { SessionManager, ChatSession } from '../session/session-manager';

/**
 * Dependencies injected by the main IPC registration so this module
 * stays independently testable.
 */
export interface MultiChatIPCDeps {
  /** The main BrowserWindow to send renderer events to. */
  mainWindow: BrowserWindow;
  /** The SessionManager instance with multi-chat methods. */
  sessionManager: SessionManager;
}

/**
 * Generates a preview string from a message: first ~50 characters,
 * trimmed and ellipsized if truncated.
 */
export function generatePreview(message: string | null | undefined): string {
  if (!message) return '';
  const trimmed = message.trim();
  if (trimmed.length <= 50) return trimmed;
  return trimmed.slice(0, 50) + '…';
}

/**
 * Sends the updated session list (with preview text) to the renderer.
 * Called after create/switch operations to keep the UI sidebar in sync.
 */
function sendSessionListUpdate(
  mainWindow: BrowserWindow,
  sessionManager: SessionManager,
  projectId: string,
): void {
  if (mainWindow.isDestroyed()) return;

  const sessions = sessionManager.listChatSessions(projectId);
  mainWindow.webContents.send('chat-sessions-updated', sessions);
}

/**
 * Registers multi-chat IPC handlers on ipcMain.
 *
 * Call this once during IPC initialization, passing the shared
 * BrowserWindow and SessionManager references.
 */
export function registerMultiChatIPC(deps: MultiChatIPCDeps): void {
  const { mainWindow, sessionManager } = deps;

  ipcMain.handle(
    'create-chat-session',
    async (_ev: any, args: { projectId: string; title?: string }) => {
      try {
        if (!args || typeof args.projectId !== 'string' || !args.projectId) {
          return { error: 'projectId is required' };
        }

        const session = sessionManager.createChatSession(args.projectId, args.title);

        // Push updated list to renderer
        sendSessionListUpdate(mainWindow, sessionManager, args.projectId);

        return session;
      } catch (e: any) {
        return { error: e.message || 'Failed to create chat session' };
      }
    },
  );

  ipcMain.handle(
    'list-chat-sessions',
    async (_ev: any, args: { projectId: string }) => {
      try {
        if (!args || typeof args.projectId !== 'string' || !args.projectId) {
          return { error: 'projectId is required' };
        }

        const sessions = sessionManager.listChatSessions(args.projectId);
        return sessions;
      } catch (e: any) {
        return { error: e.message || 'Failed to list chat sessions' };
      }
    },
  );

  ipcMain.handle(
    'switch-chat-session',
    async (_ev: any, args: { sessionId: string; projectId: string }) => {
      try {
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId) {
          return { error: 'sessionId is required' };
        }
        if (typeof args.projectId !== 'string' || !args.projectId) {
          return { error: 'projectId is required' };
        }

        sessionManager.switchChatSession(args.sessionId);

        // Push updated list to renderer so active session indicator updates
        sendSessionListUpdate(mainWindow, sessionManager, args.projectId);

        return { success: true, activeSessionId: args.sessionId };
      } catch (e: any) {
        return { error: e.message || 'Failed to switch chat session' };
      }
    },
  );
}
