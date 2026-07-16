/**
 * Checkpoint Timeline v2 IPC Handler Registration
 *
 * Registers IPC channels for the extended checkpoint timeline with
 * hunk attribution, per-call rewind, and Loop receipts:
 *   - `checkpoint:timeline-v2`    — Get extended timeline events with attribution
 *   - `checkpoint:rewind-preview` — Get rewind preview for a tool call
 *   - `checkpoint:rewind-execute` — Execute rewind (with optional force)
 *
 * All handlers are gated behind the `checkpoint_timeline` feature flag.
 *
 * Validates: Requirements 14.8, 14.9, 14.10, 14.11
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { HunkTracker } from '../editing/hunk-tracker.js';
import type { RewindService } from '../editing/rewind-service.js';
import type { RewindOperation } from '../editing/rewind-operation.js';
import type { LoopReceiptBuilder } from '../editing/loop-receipt.js';
import type {
  TimelineV2Event,
  TimelineV2Response,
} from '../editing/loop-receipt.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CheckpointTimelineV2IPCDeps {
  /** BrowserWindow reference for sending events to the renderer */
  mainWindow: BrowserWindow;
  /** FeatureGateSystem instance for checking flags */
  featureGate: FeatureGateSystem;
  /** Get the active session ID */
  getActiveSessionId: () => string | null;
  /** Get the HunkTracker instance */
  getHunkTracker: () => HunkTracker;
  /** Get the RewindService instance */
  getRewindService: () => RewindService;
  /** Get the RewindOperation instance */
  getRewindOperation: () => RewindOperation;
  /** Get the LoopReceiptBuilder for the current session (may be null) */
  getReceiptBuilder: (sessionId: string) => LoopReceiptBuilder | null;
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register checkpoint timeline v2 IPC handlers.
 *
 * Channels registered:
 * - `checkpoint:timeline-v2`    — Extended timeline events with hunk attribution
 * - `checkpoint:rewind-preview` — Preview rewind with conflict detection
 * - `checkpoint:rewind-execute` — Execute rewind operation
 *
 * Validates: Requirements 14.8, 14.9, 14.10, 14.11
 */
export function registerCheckpointTimelineV2IPC(deps: CheckpointTimelineV2IPCDeps): void {
  const {
    mainWindow,
    featureGate,
    getActiveSessionId,
    getHunkTracker,
    getRewindService,
    getRewindOperation,
    getReceiptBuilder,
  } = deps;

  // Helper: check feature gate
  function isEnabled(): boolean {
    try {
      return featureGate.isEnabled('checkpoint_timeline');
    } catch {
      return false;
    }
  }

  // ── checkpoint:timeline-v2 ────────────────────────────────────────
  // Returns extended timeline events with hunk attribution and Loop receipts.
  //
  // Validates: Requirements 14.9 (attribution in timeline), 14.11 (receipts)
  ipcMain.handle(
    'checkpoint:timeline-v2',
    async (_ev, arg?: { sessionId?: string }): Promise<TimelineV2Response> => {
      try {
        if (!isEnabled()) {
          return { events: [], receipts: null };
        }

        const sessionId = arg?.sessionId || getActiveSessionId() || 'default';
        const hunkTracker = getHunkTracker();
        const rewindService = getRewindService();

        // Build timeline events from hunk records
        const sessionHunks = hunkTracker.getHunksBySession(sessionId);
        const events: TimelineV2Event[] = [];
        const seenCallIds = new Set<string>();

        for (const hunk of sessionHunks) {
          // Group by tool call ID to avoid duplicates
          const eventId = hunk.toolCallId || `ext-${hunk.timestamp}`;
          if (seenCallIds.has(eventId)) {
            // Append file to existing event
            const existing = events.find((e) => e.id === eventId);
            if (existing && !existing.filesAffected.includes(hunk.file)) {
              existing.filesAffected.push(hunk.file);
            }
            continue;
          }
          seenCallIds.add(eventId);

          // Determine kind
          let kind: TimelineV2Event['kind'] = 'tool-call';
          if (hunk.kind === 'external') kind = 'external';
          else if (hunk.passId) kind = 'pass';

          // Check rewind availability
          const hasSnapshot = hunk.toolCallId
            ? rewindService.getSnapshotsForCall(hunk.toolCallId).length > 0
            : false;

          events.push({
            id: eventId,
            kind,
            timestamp: hunk.timestamp,
            agentId: hunk.agentId,
            toolCallId: hunk.toolCallId,
            passNumber: hunk.passId ? parseInt(hunk.passId, 10) || null : null,
            filesAffected: [hunk.file],
            rewindAvailable: hasSnapshot,
            description: hunk.toolCallId
              ? `Tool call ${hunk.toolCallId.substring(0, 8)}`
              : 'External edit',
          });
        }

        // Sort events by timestamp (oldest first)
        events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        // Get Loop receipts if available
        const receiptBuilder = getReceiptBuilder(sessionId);
        const receipts = receiptBuilder ? receiptBuilder.build() : null;

        return { events, receipts };
      } catch (e: any) {
        console.warn('[CheckpointTimelineV2IPC] timeline-v2 error:', e?.message);
        return { events: [], receipts: null };
      }
    },
  );

  // ── checkpoint:rewind-preview ─────────────────────────────────────
  // Returns a rewind preview for a specific tool call, including
  // conflict detection for external hunks.
  //
  // Validates: Requirement 14.10 (per-call rewind with conflict check)
  ipcMain.handle(
    'checkpoint:rewind-preview',
    async (_ev, arg?: { sessionId?: string; toolCallId?: string }) => {
      try {
        if (!isEnabled()) {
          return { error: 'checkpoint_timeline feature is disabled' };
        }

        const toolCallId = arg?.toolCallId;
        if (!toolCallId) {
          return { error: 'toolCallId is required' };
        }

        const rewindOp = getRewindOperation();
        const preview = await rewindOp.previewRewind(toolCallId);

        return {
          callId: preview.callId,
          diffs: preview.diffs.map((d) => ({
            file: d.file,
            linesAffected: d.linesAffected,
            hasConflict: d.hasConflict,
          })),
          hasConflicts: preview.hasConflicts,
          conflictingFiles: preview.conflictingFiles,
        };
      } catch (e: any) {
        console.warn('[CheckpointTimelineV2IPC] rewind-preview error:', e?.message);
        return { error: e?.message || 'Preview failed' };
      }
    },
  );

  // ── checkpoint:rewind-execute ─────────────────────────────────────
  // Executes a rewind operation for a specific tool call.
  // Supports force mode to skip conflict confirmation.
  //
  // Validates: Requirement 14.10 (execute rewind with confirmation)
  ipcMain.handle(
    'checkpoint:rewind-execute',
    async (_ev, arg?: { sessionId?: string; toolCallId?: string; force?: boolean; confirmed?: boolean }) => {
      try {
        if (!isEnabled()) {
          return { applied: false, error: 'checkpoint_timeline feature is disabled' };
        }

        const toolCallId = arg?.toolCallId;
        if (!toolCallId) {
          return { applied: false, error: 'toolCallId is required' };
        }

        const rewindOp = getRewindOperation();
        const options: { force?: boolean; confirmation?: { callId: string; confirmed: boolean } } = {};
        if (arg?.force) options.force = true;
        if (arg?.confirmed) options.confirmation = { callId: toolCallId, confirmed: true };
        const result = await rewindOp.rewindCall(toolCallId, options);

        // Notify renderer that timeline has been updated after rewind
        if (result.applied && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('checkpoint:timeline-v2-updated', {
            sessionId: arg?.sessionId || getActiveSessionId() || 'default',
          });
        }

        return {
          applied: result.applied,
          confirmationRequired: result.confirmationRequired,
          conflictingFiles: result.preview.conflictingFiles,
          error: result.applied ? undefined : (result.confirmationRequired ? undefined : 'Rewind failed'),
        };
      } catch (e: any) {
        console.error('[CheckpointTimelineV2IPC] rewind-execute error:', e?.message);
        return { applied: false, error: e?.message || 'Rewind execution failed' };
      }
    },
  );

  console.log('[IPC] Checkpoint Timeline v2 IPC handlers registered (checkpoint:timeline-v2, checkpoint:rewind-preview, checkpoint:rewind-execute)');
}
