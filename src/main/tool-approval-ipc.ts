/**
 * Tool Approval IPC bridge — connects BashTool's approvalHandler to
 * the renderer's approval dialog via Electron IPC.
 *
 * The factory function `createApprovalHandler` returns an approvalHandler
 * compatible with ToolContext that:
 *   1. Sends a `tool-approval-request` event to the renderer
 *   2. Returns a promise that resolves when the renderer replies via
 *      `tool-approval-response`
 *
 * The `registerToolApprovalIPC` function sets up the response listener
 * on ipcMain.
 *
 * Requirements: 4.1, 4.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';

// ── Pending approval promise map ────────────────────────────────────

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Map of requestId → pending promise resolver. Keyed by unique request ID. */
const pendingApprovals = new Map<string, PendingApproval>();

/** Timeout for an approval request before auto-denying (5 minutes). */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// ── Factory: createApprovalHandler ──────────────────────────────────

/**
 * Creates an approvalHandler function compatible with ToolContext.approvalHandler.
 *
 * When called, it sends a `tool-approval-request` event to the renderer
 * and returns a promise that resolves to `true` (approved) or `false` (denied)
 * once the user responds via the approval dialog.
 *
 * @param mainWindow - The BrowserWindow to send IPC events to
 * @returns An approvalHandler function `(command: string) => Promise<boolean>`
 */
export function createApprovalHandler(
  mainWindow: BrowserWindow,
): (command: string) => Promise<boolean> {
  return (command: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();

      // Set up a timeout that auto-denies if the user doesn't respond
      const timer = setTimeout(() => {
        const pending = pendingApprovals.get(requestId);
        if (pending) {
          pendingApprovals.delete(requestId);
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);

      // Store the pending approval
      pendingApprovals.set(requestId, { resolve, timer });

      // Send the approval request to the renderer
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tool-approval-request', {
          requestId,
          command,
          toolName: 'BashTool',
        });
      } else {
        // Window destroyed — auto-deny
        clearTimeout(timer);
        pendingApprovals.delete(requestId);
        resolve(false);
      }
    });
  };
}

// ── IPC handler registration ────────────────────────────────────────

/**
 * Registers the `tool-approval-response` IPC handler that resolves
 * pending approval promises when the user responds in the UI.
 *
 * Call this once during IPC initialization.
 */
export function registerToolApprovalIPC(): void {
  ipcMain.on(
    'tool-approval-response',
    (_event, arg: { requestId: string; approved: boolean }) => {
      if (!arg || typeof arg.requestId !== 'string') {
        console.warn('[ToolApproval] Received invalid approval response:', arg);
        return;
      }

      const pending = pendingApprovals.get(arg.requestId);
      if (!pending) {
        console.warn('[ToolApproval] No pending approval for requestId:', arg.requestId);
        return;
      }

      // Clean up and resolve
      clearTimeout(pending.timer);
      pendingApprovals.delete(arg.requestId);
      pending.resolve(!!arg.approved);
    },
  );
}

// ── Utilities ───────────────────────────────────────────────────────

/**
 * Returns the number of currently pending approval requests.
 * Useful for diagnostics and testing.
 */
export function getPendingApprovalCount(): number {
  return pendingApprovals.size;
}

/**
 * Clears all pending approvals (auto-denies them).
 * Used during cleanup/shutdown.
 */
export function clearPendingApprovals(): void {
  pendingApprovals.forEach((pending, id) => {
    clearTimeout(pending.timer);
    pending.resolve(false);
  });
  pendingApprovals.clear();
}
