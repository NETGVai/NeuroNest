/**
 * Checkpoint Timeline IPC Handler Registration
 *
 * Registers IPC channels for the visual checkpoint timeline feature:
 *   - `checkpoint:timeline` — Get all checkpoints for a session
 *   - `checkpoint:restore`  — Restore to a specific checkpoint (reverts all changes after)
 *   - `checkpoint:star`     — Toggle star/pin on a checkpoint to prevent pruning
 *
 * All handlers are gated behind the `checkpoint_timeline` feature flag
 * (which requires the `checkpoint` flag).
 *
 * Requirements: 16.1, 16.3, 16.4, 16.7
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { CheckpointTimeline, type CheckpointTimelineConfig, DEFAULT_CHECKPOINT_TIMELINE_CONFIG } from '../durability/checkpoint-timeline.js';
import { CheckpointService } from '../durability/checkpoint-service.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CheckpointTimelineIPCDeps {
  /** BrowserWindow reference for sending events to the renderer */
  mainWindow: BrowserWindow;
  /** FeatureGateSystem instance for checking flags */
  featureGate: FeatureGateSystem;
  /** Get the active session ID */
  getActiveSessionId: () => string | null;
  /** Get the checkpoint service instance (or create one) */
  getCheckpointService: () => CheckpointService;
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register checkpoint timeline IPC handlers.
 *
 * Channels registered:
 * - `checkpoint:timeline` — Get timeline checkpoints for a session
 * - `checkpoint:restore`  — Restore to a checkpoint (reverts changes after that point)
 * - `checkpoint:star`     — Toggle star/pin status on a checkpoint
 *
 * All channels are gated behind the `checkpoint_timeline` feature flag.
 * When the flag is disabled, handlers return early with an empty result or flagDisabled error.
 *
 * Requirements: 16.1, 16.3, 16.4, 16.7
 */
export function registerCheckpointTimelineIPC(deps: CheckpointTimelineIPCDeps): void {
  var { mainWindow, featureGate, getActiveSessionId, getCheckpointService } = deps;

  // Helper: check feature gate
  function isEnabled(): boolean {
    try {
      return featureGate.isEnabled('checkpoint_timeline');
    } catch {
      return false;
    }
  }

  // Lazily initialize the CheckpointTimeline singleton
  function getTimeline(): CheckpointTimeline {
    var checkpointService = getCheckpointService();
    var config: CheckpointTimelineConfig = {
      ...DEFAULT_CHECKPOINT_TIMELINE_CONFIG,
      featureEnabled: isEnabled(),
    };
    return CheckpointTimeline.getInstance(checkpointService, config);
  }

  // ── checkpoint:timeline ─────────────────────────────────────────
  // Returns the ordered list of checkpoints for the given session.
  // Used by the renderer timeline widget to populate the horizontal timeline.
  //
  // Requirement: 16.1 (timeline data for UI), 16.3 (metadata for hover)
  ipcMain.handle('checkpoint:timeline', async (_ev, arg?: { sessionId?: string }) => {
    try {
      if (!isEnabled()) {
        return [];
      }

      var sessionId = arg?.sessionId || getActiveSessionId() || 'default';
      var timeline = getTimeline();
      return timeline.getTimeline(sessionId);
    } catch (e: any) {
      console.warn('[CheckpointTimelineIPC] checkpoint:timeline error:', e?.message);
      return [];
    }
  });

  // ── checkpoint:restore ──────────────────────────────────────────
  // Restore to a specific checkpoint, reverting all changes made after it.
  // The renderer shows a confirmation dialog before calling this.
  //
  // Requirement: 16.4 (one-click restore with confirmation)
  ipcMain.handle('checkpoint:restore', async (_ev, arg?: { sessionId?: string; checkpointId?: string }) => {
    try {
      if (!isEnabled()) {
        return { success: false, error: 'checkpoint_timeline feature is disabled' };
      }

      var checkpointId = arg?.checkpointId;
      if (!checkpointId) {
        return { success: false, error: 'checkpointId is required' };
      }

      var sessionId = arg?.sessionId || getActiveSessionId() || 'default';
      var timeline = getTimeline();
      var checkpoint = timeline.getCheckpoint(checkpointId);

      if (!checkpoint) {
        return { success: false, error: 'Checkpoint not found' };
      }

      // Use the CheckpointService to restore the workspace state
      var checkpointService = getCheckpointService();
      var restored = await checkpointService.restore(sessionId);

      if (!restored) {
        return { success: false, error: 'Failed to restore checkpoint state' };
      }

      // Remove all checkpoints after the restored one in the timeline
      var allCheckpoints = timeline.getTimeline(sessionId);
      for (var i = 0; i < allCheckpoints.length; i++) {
        var cp = allCheckpoints[i];
        if (cp && cp.createdAt > checkpoint.createdAt) {
          timeline.removeCheckpoint(cp.id);
        }
      }

      // Notify renderer that the timeline has been updated
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('checkpoint:timeline-updated', { sessionId: sessionId });
      }

      return { success: true };
    } catch (e: any) {
      console.error('[CheckpointTimelineIPC] checkpoint:restore error:', e?.message);
      return { success: false, error: e?.message || 'Restore failed' };
    }
  });

  // ── checkpoint:star ─────────────────────────────────────────────
  // Toggle star/pin status on a checkpoint to prevent automatic LRU pruning.
  //
  // Requirement: 16.7 (star/pin toggle to prevent pruning)
  ipcMain.handle('checkpoint:star', async (_ev, arg?: { checkpointId?: string; starred?: boolean }) => {
    try {
      if (!isEnabled()) {
        return { success: false, error: 'checkpoint_timeline feature is disabled' };
      }

      var checkpointId = arg?.checkpointId;
      if (!checkpointId) {
        return { success: false, error: 'checkpointId is required' };
      }

      var starred = arg?.starred;
      var timeline = getTimeline();
      var result: boolean;

      if (starred) {
        result = timeline.starCheckpoint(checkpointId);
      } else {
        result = timeline.unstarCheckpoint(checkpointId);
      }

      if (!result) {
        return { success: false, error: 'Checkpoint not found' };
      }

      return { success: true };
    } catch (e: any) {
      console.error('[CheckpointTimelineIPC] checkpoint:star error:', e?.message);
      return { success: false, error: e?.message || 'Star toggle failed' };
    }
  });

  console.log('[IPC] Checkpoint Timeline IPC handlers registered (checkpoint:timeline, checkpoint:restore, checkpoint:star)');
}
