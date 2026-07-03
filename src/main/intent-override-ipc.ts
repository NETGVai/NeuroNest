/**
 * IPC handler for intent override requests.
 *
 * Handles the `intent:override-request` channel from the renderer process.
 * On override:
 *   1. Calls IntentGate.applyOverride() to reclassify with stage='user_override'
 *   2. Sends updated `intent:decision` back to the renderer
 *   3. Triggers rerouting via the provided routing callback (rerouting never without reclassification)
 *
 * Gated behind the `intent_chip_ux` feature flag.
 *
 * Requirements: 4.3, 4.5
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { IIntentGate, IntentDecision, IntentLabel } from '../pipeline/intent-gate.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface OverrideRequestPayload {
  messageHash: string;
  newIntent: IntentLabel;
}

/**
 * Callback invoked after a successful override reclassification.
 * The router should use the new IntentDecision to reroute the message.
 * Rerouting SHALL never occur without a preceding reclassification step (Req 4.5).
 */
export type OverrideRouteCallback = (decision: IntentDecision) => void;

export interface IntentOverrideIPCDeps {
  /** Reference to the main BrowserWindow for sending IPC back to renderer */
  mainWindow: BrowserWindow;
  /** The IntentGate instance to call applyOverride on */
  intentGate: IIntentGate;
  /** Feature gate system to check `intent_chip_ux` flag */
  featureGate: FeatureGateSystem;
  /** Optional callback invoked after reclassification to trigger rerouting */
  onOverrideRoute?: OverrideRouteCallback;
}

// ─── IPC Channel Constants ──────────────────────────────────────

export const IPC_CHANNELS = {
  /** Renderer → Main: user requests an intent override */
  OVERRIDE_REQUEST: 'intent:override-request',
  /** Main → Renderer: updated IntentDecision */
  DECISION: 'intent:decision',
} as const;

// ─── Registration ───────────────────────────────────────────────

/**
 * Register the `intent:override-request` IPC handler.
 *
 * Flow (Requirement 4.5):
 *   1. Renderer sends `intent:override-request` with { messageHash, newIntent }
 *   2. Handler checks `intent_chip_ux` feature flag
 *   3. Calls IntentGate.applyOverride(messageHash, newIntent)
 *      → creates new IntentDecision with stage='user_override'
 *   4. Sends updated `intent:decision` back to the renderer
 *   5. Invokes the routing callback (rerouting happens AFTER reclassification)
 *
 * Uses `ipcMain.on` (fire-and-forget from renderer) rather than `ipcMain.handle`
 * because the renderer doesn't await the response — it listens for `intent:decision`
 * broadcast instead.
 */
export function registerIntentOverrideIPC(deps: IntentOverrideIPCDeps): void {
  const { mainWindow, intentGate, featureGate, onOverrideRoute } = deps;

  ipcMain.on(IPC_CHANNELS.OVERRIDE_REQUEST, async (_event, payload: OverrideRequestPayload) => {
    // Gate behind `intent_chip_ux` feature flag
    if (!featureGate.isEnabled('intent_chip_ux')) {
      return;
    }

    // Validate payload
    if (!payload || !payload.messageHash || !payload.newIntent) {
      return;
    }

    const validIntents: IntentLabel[] = ['conversation', 'quick_action', 'build'];
    if (!validIntents.includes(payload.newIntent)) {
      return;
    }

    try {
      // Step 1: Reclassify — create a new IntentDecision with stage='user_override'
      // This is the reclassification step that MUST precede any rerouting (Req 4.5)
      const overriddenDecision = await intentGate.applyOverride(
        payload.messageHash,
        payload.newIntent,
      );

      // Step 2: Send the updated decision back to the renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.DECISION, overriddenDecision);
      }

      // Step 3: Trigger rerouting AFTER reclassification (never without it)
      // Requirement 4.5: rerouting SHALL never occur without a preceding reclassification step
      if (onOverrideRoute) {
        onOverrideRoute(overriddenDecision);
      }
    } catch (error) {
      // Silently fail — don't crash on override errors.
      // The chip will remain in its current state.
      // In production, this would be logged to telemetry.
    }
  });
}

/**
 * Send an IntentDecision to the renderer via IPC.
 * Utility for broadcasting decisions from any main-process context.
 */
export function sendIntentDecision(mainWindow: BrowserWindow, decision: IntentDecision): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.DECISION, decision);
  }
}
