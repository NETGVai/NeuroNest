/**
 * Autocomplete IPC Handler Registration
 *
 * Registers IPC channels for the inline autocomplete (ghost-text) feature:
 *   - `autocomplete:request`  — Trigger a completion from the renderer
 *   - `autocomplete:cancel`   — Cancel an in-flight completion request
 *   - `autocomplete:config`   — Get/set autocomplete configuration and toggle state
 *
 * All handlers are gated behind the `inline_autocomplete` feature flag.
 * The service uses the 'fast' tier from the provider registry for model selection
 * and routes all completion context through the FirewallEngine before sending.
 *
 * Requirements: 1.7
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { AutocompleteService, type AutocompleteStatus } from '../autocomplete/autocomplete-service.js';
import { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AutocompleteIPCDeps {
  /** The main BrowserWindow for sending status updates */
  mainWindow: BrowserWindow;
  /** Feature gate system for checking inline_autocomplete flag */
  featureGate?: FeatureGateSystem;
  /** Optional firewall evaluator to inject into the autocomplete service */
  firewallEvaluator?: {
    evaluate(input: string, opts?: { agentId?: string; projectId?: string }): {
      passed: boolean;
      blocked: boolean;
      sanitized: string;
    };
  };
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register autocomplete IPC handlers.
 *
 * Channels registered:
 * - `autocomplete:request` — Invoke to request a completion. Returns the autocomplete result.
 * - `autocomplete:cancel` — Invoke to cancel any pending/in-flight completion.
 * - `autocomplete:config` — Invoke to get or update autocomplete configuration.
 *
 * All channels are gated behind the `inline_autocomplete` feature flag.
 * When the flag is disabled, handlers return early with appropriate responses.
 */
export function registerAutocompleteIPC(deps: AutocompleteIPCDeps): void {
  const { mainWindow, featureGate, firewallEvaluator } = deps;

  // Get the singleton autocomplete service
  const service = AutocompleteService.getInstance();

  // Inject the firewall evaluator if provided
  if (firewallEvaluator) {
    service.setFirewall(firewallEvaluator);
  }

  // Set up status bar notifier to push status changes to the renderer
  service.setStatusBarNotifier({
    notifyStatusChange(status: AutocompleteStatus): void {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('autocomplete:status', { status });
      }
    },
  });

  // ── autocomplete:request ────────────────────────────────────────
  // Trigger a completion request from the renderer.
  // Args: { editorState: EditorState, lineContext: LineContext }
  // Returns: AutocompleteResult
  ipcMain.handle('autocomplete:request', async (_ev, args: any) => {
    try {
      // Feature flag gate
      if (featureGate && !featureGate.isEnabled('inline_autocomplete')) {
        return { success: false, skipReason: 'disabled', skipDetail: 'inline_autocomplete feature flag is disabled' };
      }

      if (!args || !args.editorState || !args.lineContext) {
        return { success: false, skipReason: 'cancelled', skipDetail: 'Invalid request arguments' };
      }

      const result = await service.requestCompletion(args.editorState, args.lineContext);
      return result;
    } catch (e: any) {
      console.error('[AutocompleteIPC] autocomplete:request error:', e?.message);
      return { success: false, skipReason: 'cancelled', skipDetail: e?.message || 'Unknown error' };
    }
  });

  // ── autocomplete:cancel ─────────────────────────────────────────
  // Cancel any pending or in-flight completion request.
  // Returns: { success: boolean }
  ipcMain.handle('autocomplete:cancel', async () => {
    try {
      service.cancelPending();
      return { success: true };
    } catch (e: any) {
      console.error('[AutocompleteIPC] autocomplete:cancel error:', e?.message);
      return { success: false, error: e?.message };
    }
  });

  // ── autocomplete:config ─────────────────────────────────────────
  // Get or update autocomplete configuration.
  // Args (optional): { updates?: Partial<AutocompleteServiceConfig> }
  // Returns: { config: AutocompleteServiceConfig, status: AutocompleteStatus }
  ipcMain.handle('autocomplete:config', async (_ev, args?: any) => {
    try {
      // Feature flag gate for mutations
      if (args?.updates && featureGate && !featureGate.isEnabled('inline_autocomplete')) {
        return {
          config: service.getConfig(),
          status: 'disabled' as AutocompleteStatus,
          flagDisabled: true,
        };
      }

      // Apply updates if provided
      if (args?.updates) {
        // Handle toggle specially
        if ('enabled' in args.updates) {
          if (args.updates.enabled) {
            service.enable();
          } else {
            service.disable();
          }
          // Remove 'enabled' from updates since we handled it via enable/disable
          const { enabled, ...rest } = args.updates;
          if (Object.keys(rest).length > 0) {
            service.updateConfig(rest);
          }
        } else {
          service.updateConfig(args.updates);
        }
      }

      return {
        config: service.getConfig(),
        status: service.status,
      };
    } catch (e: any) {
      console.error('[AutocompleteIPC] autocomplete:config error:', e?.message);
      return { config: service.getConfig(), status: service.status, error: e?.message };
    }
  });

  console.log('[IPC] Autocomplete IPC handlers registered (autocomplete:request, autocomplete:cancel, autocomplete:config)');
}
