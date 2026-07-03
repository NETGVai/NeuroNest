/**
 * Approval Gate IPC bridge — connects the ApprovalGate service to
 * the renderer's approval UI via Electron IPC.
 *
 * Handles the `approval:respond` send channel from the renderer.
 * The main process emits `agent:approval-request` to the renderer
 * when a task completes with file modifications.
 *
 * Uses `ipcMain.on` for fire-and-forget messages from renderer (SEND_CHANNELS).
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */

import { ipcMain } from 'electron';
import type { ApprovalGate } from '../services/approval-gate.js';
import type { ApprovalDecision } from '../shared/production-ux-types.js';

// ─── IPC Registration ───────────────────────────────────────────

/**
 * Register the `approval:respond` IPC handler that processes
 * user approval decisions from the renderer.
 *
 * Call this once during IPC initialization, passing the shared
 * ApprovalGate service instance.
 *
 * @param approvalGate - The ApprovalGate service instance
 */
export function registerApprovalGateIPC(approvalGate: ApprovalGate): void {
  ipcMain.on(
    'approval:respond',
    (_event, arg: ApprovalDecision) => {
      if (!arg || typeof arg !== 'object' || !('action' in arg)) {
        console.warn('[ApprovalGateIPC] Received invalid approval response:', arg);
        return;
      }

      // Validate the decision structure
      const validActions = ['approve_all', 'reject_all', 'selective'];
      if (!validActions.includes(arg.action)) {
        console.warn('[ApprovalGateIPC] Invalid action in approval response:', arg.action);
        return;
      }

      // For selective decisions, validate arrays are present
      if (arg.action === 'selective') {
        if (!Array.isArray(arg.approved) || !Array.isArray(arg.rejected)) {
          console.warn('[ApprovalGateIPC] Selective decision missing approved/rejected arrays:', arg);
          return;
        }
      }

      // Delegate to the ApprovalGate service
      approvalGate.handleDecision(arg);
    },
  );
}
