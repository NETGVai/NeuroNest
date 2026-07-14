/**
 * Commit Message Generator IPC Handler Registration
 *
 * Registers IPC channels for the smart commit message generation feature:
 *   - `commit:generate` — Generate a commit message from staged changes
 *   - `commit:config`   — Get/set commit message generator configuration
 *
 * All handlers are gated behind the `commit_message_gen` feature flag.
 * The generator uses the 'fast' tier from the provider registry for cost efficiency.
 *
 * Requirements: 7.5
 */

import { ipcMain } from 'electron';
import {
  CommitMessageGenerator,
  type CommitMessage,
  type CommitMessageGeneratorConfig,
  type CommitLLMClient,
} from '../git/commit-message-generator.js';
import { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommitIPCDeps {
  /** Feature gate system for checking commit_message_gen flag */
  featureGate?: FeatureGateSystem;
  /** Resolver for the active LLM client (cheapest/fast tier preferred) */
  resolveLLMClient?: () => CommitLLMClient | null;
}

export interface CommitGenerateResult {
  success: boolean;
  message?: CommitMessage;
  error?: string;
  flagDisabled?: boolean;
}

export interface CommitConfigResult {
  config: Partial<CommitMessageGeneratorConfig>;
  enabled: boolean;
  flagDisabled?: boolean;
  error?: string;
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register commit message generator IPC handlers.
 *
 * Channels registered:
 * - `commit:generate` — Invoke to generate a commit message from staged changes.
 *   Args: { cwd?: string }
 *   Returns: CommitGenerateResult
 *
 * - `commit:config` — Invoke to get or update commit generator configuration.
 *   Args: { updates?: Partial<CommitMessageGeneratorConfig> }
 *   Returns: CommitConfigResult
 *
 * All channels are gated behind the `commit_message_gen` feature flag.
 * When the flag is disabled, handlers return early with appropriate responses.
 */
export function registerCommitIPC(deps: CommitIPCDeps): void {
  const { featureGate, resolveLLMClient } = deps;

  // ── commit:generate ─────────────────────────────────────────────
  // Generate a commit message from the currently staged changes.
  ipcMain.handle('commit:generate', async (_ev, args?: any): Promise<CommitGenerateResult> => {
    try {
      // Feature flag gate
      if (featureGate && !featureGate.isEnabled('commit_message_gen')) {
        return { success: false, flagDisabled: true, error: 'commit_message_gen feature flag is disabled' };
      }

      // Resolve working directory
      const cwd = args?.cwd || process.cwd();

      // Get/create the generator singleton with the provided cwd
      const generator = CommitMessageGenerator.getInstance({ cwd });
      generator.updateConfig({ cwd });

      // Inject LLM client from the 'fast' tier
      if (resolveLLMClient) {
        const client = resolveLLMClient();
        generator.setLLMClient(client);
      }

      // Generate the commit message
      const message = await generator.generate();

      if (!message) {
        return { success: false, error: 'No staged changes found. Stage files with `git add` first.' };
      }

      return { success: true, message };
    } catch (e: any) {
      console.error('[CommitIPC] commit:generate error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error generating commit message' };
    }
  });

  // ── commit:config ───────────────────────────────────────────────
  // Get or update commit generator configuration.
  ipcMain.handle('commit:config', async (_ev, args?: any): Promise<CommitConfigResult> => {
    try {
      // Feature flag gate (always allow reads, gate writes)
      const isEnabled = !featureGate || featureGate.isEnabled('commit_message_gen');

      const generator = CommitMessageGenerator.getInstance();

      // Apply config updates if provided and feature is enabled
      if (args?.updates && isEnabled) {
        generator.updateConfig(args.updates);
      } else if (args?.updates && !isEnabled) {
        return {
          config: {},
          enabled: false,
          flagDisabled: true,
          error: 'commit_message_gen feature flag is disabled',
        };
      }

      // Return current config state
      // Note: We expose a subset of config relevant to the renderer
      return {
        config: {
          maxDiffSize: 8000,
          generateBody: true,
          ...(args?.updates || {}),
        },
        enabled: isEnabled,
      };
    } catch (e: any) {
      console.error('[CommitIPC] commit:config error:', e?.message);
      return { config: {}, enabled: false, error: e?.message || 'Unknown error' };
    }
  });

  console.log('[IPC] Commit Message Generator IPC handlers registered (commit:generate, commit:config)');
}
