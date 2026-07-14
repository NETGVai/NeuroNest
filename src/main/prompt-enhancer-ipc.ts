/**
 * Prompt Enhancer IPC Handler Registration
 *
 * Registers IPC channels for the prompt enhancement feature:
 *   - `prompt:enhance`  — Enhance a user prompt via the PromptEnhancer
 *   - `prompt:config`   — Get/set prompt enhancement configuration (per-session toggle, auto-enhance)
 *
 * Integration:
 * - Runs before BrainstormMode check in message processing pipeline (Req 8.4)
 * - Shows enhanced prompt for confirmation unless auto-enhance is enabled (Req 8.2)
 * - Toggleable per-session via UI toggle and globally via settings (Req 8.5)
 * - Gated behind the `prompt_enhancement` feature flag
 *
 * Requirements: 8.2, 8.4, 8.5
 */

import { ipcMain } from 'electron';
import {
  PromptEnhancer,
  type PromptEnhancerConfig,
  type PromptEnhancementResult,
} from '../pipeline/prompt-enhancer.js';
import { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export interface PromptEnhancerIPCDeps {
  /** Feature gate system for checking prompt_enhancement flag */
  featureGate?: FeatureGateSystem;
  /** Resolves the active LLM client for the 'fast' tier */
  resolveLLMClient?: () => any | null;
}

/** Shape of the `prompt:config` set request */
export interface PromptConfigSetRequest {
  set: Partial<PromptEnhancerConfig>;
  sessionId?: string;
}

/** Shape of the `prompt:config` response */
export interface PromptConfigResponse {
  config: PromptEnhancerConfig;
  featureEnabled: boolean;
}

/** Shape of the `prompt:enhance` request */
export interface PromptEnhanceRequest {
  message: string;
  sessionId?: string;
}

// ─── Per-session state ──────────────────────────────────────────

/**
 * Per-session prompt enhancement toggle state.
 * Allows each session to independently enable/disable enhancement (Req 8.5).
 */
const sessionToggleState = new Map<string, boolean>();

// ─── Singleton enhancer instance ────────────────────────────────

let enhancerInstance: PromptEnhancer | null = null;
let globalConfig: PromptEnhancerConfig = {
  enabled: false,
  autoEnhance: false,
  tokenThreshold: 50,
};

// ─── Registration ───────────────────────────────────────────────

/**
 * Register prompt enhancer IPC handlers.
 *
 * Channels registered:
 * - `prompt:enhance` — Invoke to enhance a user prompt. Returns PromptEnhancementResult.
 * - `prompt:config` — Invoke to get or update prompt enhancement configuration.
 *
 * All channels are gated behind the `prompt_enhancement` feature flag.
 * When the flag is disabled, `prompt:enhance` returns the original prompt unmodified,
 * and `prompt:config` reports `featureEnabled: false`.
 */
export function registerPromptEnhancerIPC(deps: PromptEnhancerIPCDeps): void {
  const { featureGate, resolveLLMClient } = deps;

  // Reset module-level state on each registration (handles window recreate)
  enhancerInstance = null;
  globalConfig = { enabled: false, autoEnhance: false, tokenThreshold: 50 };
  sessionToggleState.clear();

  /**
   * Check if the prompt_enhancement feature flag is enabled.
   */
  function isFeatureEnabled(): boolean {
    if (!featureGate) return false;
    try {
      return featureGate.isEnabled('prompt_enhancement');
    } catch {
      return false;
    }
  }

  /**
   * Get or create the PromptEnhancer singleton.
   * Lazily initializes on first use to match NeuroNest's lazy-init pattern.
   */
  function getEnhancer(): PromptEnhancer | null {
    if (!isFeatureEnabled()) return null;

    if (!enhancerInstance) {
      const llmClient = resolveLLMClient?.() ?? null;
      // Wrap the generic LLM client to match PromptEnhancer's LLMClient interface
      const wrappedClient = llmClient
        ? {
            chat: async (
              messages: Array<{ role: string; content: string }>,
              options?: { temperature?: number; maxTokens?: number },
            ) => {
              const result = await llmClient.chat(messages, options);
              return { content: result?.content || '' };
            },
          }
        : null;

      enhancerInstance = new PromptEnhancer(wrappedClient as any, globalConfig);
    }

    // Update the LLM client on each call in case the provider changed
    if (enhancerInstance && resolveLLMClient) {
      const llmClient = resolveLLMClient();
      if (llmClient) {
        const wrappedClient = {
          chat: async (
            messages: Array<{ role: string; content: string }>,
            options?: { temperature?: number; maxTokens?: number },
          ) => {
            const result = await llmClient.chat(messages, options);
            return { content: result?.content || '' };
          },
        };
        enhancerInstance.setLLMClient(wrappedClient as any);
      }
    }

    return enhancerInstance;
  }

  /**
   * Determine if enhancement is enabled for a given session, considering
   * the global config and per-session toggle (Req 8.5).
   */
  function isEnabledForSession(sessionId?: string): boolean {
    if (!globalConfig.enabled) return false;
    if (sessionId && sessionToggleState.has(sessionId)) {
      return sessionToggleState.get(sessionId)!;
    }
    return true; // Default to global setting
  }

  // ── prompt:enhance ─────────────────────────────────────────────

  // Remove any previously registered handler (for window recreate safety)
  try { ipcMain.removeHandler('prompt:enhance'); } catch {}

  ipcMain.handle('prompt:enhance', async (_ev, arg: unknown): Promise<PromptEnhancementResult> => {
    const request = arg as PromptEnhanceRequest;
    const message = request?.message || '';
    const sessionId = request?.sessionId;

    // Gate: feature flag
    if (!isFeatureEnabled()) {
      return {
        enhanced: false,
        prompt: message,
        originalPrompt: message,
        skipReason: 'disabled',
      };
    }

    // Gate: per-session toggle (Req 8.5)
    if (!isEnabledForSession(sessionId)) {
      return {
        enhanced: false,
        prompt: message,
        originalPrompt: message,
        skipReason: 'disabled',
      };
    }

    const enhancer = getEnhancer();
    if (!enhancer) {
      return {
        enhanced: false,
        prompt: message,
        originalPrompt: message,
        skipReason: 'disabled',
      };
    }

    try {
      const result = await enhancer.enhance(message);
      return result;
    } catch (err: any) {
      console.warn('[PromptEnhancer] Enhancement failed (non-fatal):', err?.message);
      return {
        enhanced: false,
        prompt: message,
        originalPrompt: message,
        skipReason: 'enhancement_failed',
      };
    }
  });

  // ── prompt:config ──────────────────────────────────────────────

  try { ipcMain.removeHandler('prompt:config'); } catch {}

  ipcMain.handle('prompt:config', async (_ev, arg: unknown): Promise<PromptConfigResponse> => {
    const request = arg as PromptConfigSetRequest | undefined;

    // Apply updates if provided
    if (request && request.set) {
      const updates = request.set;

      // If sessionId is provided, route the enabled toggle to per-session state only (Req 8.5)
      if (request.sessionId !== undefined && updates.enabled !== undefined) {
        sessionToggleState.set(request.sessionId, updates.enabled);
      } else {
        // Update global config
        if (updates.enabled !== undefined) {
          globalConfig.enabled = updates.enabled;
        }
      }

      // These always update the global config regardless of sessionId
      if (updates.autoEnhance !== undefined) {
        globalConfig.autoEnhance = updates.autoEnhance;
      }
      if (updates.tokenThreshold !== undefined) {
        globalConfig.tokenThreshold = updates.tokenThreshold;
      }

      // Propagate config to the enhancer instance
      if (enhancerInstance) {
        enhancerInstance.setConfig(updates);
      }
    }

    return {
      config: { ...globalConfig },
      featureEnabled: isFeatureEnabled(),
    };
  });

  console.log('[IPC] Prompt Enhancer IPC handlers registered');
}

/**
 * Get the current per-session enhancement state.
 * Used by the pipeline to check if enhancement is active for the current session
 * before routing to BrainstormMode (Req 8.4).
 */
export function getSessionEnhancementState(sessionId: string): boolean {
  if (!globalConfig.enabled) return false;
  if (sessionToggleState.has(sessionId)) {
    return sessionToggleState.get(sessionId)!;
  }
  return globalConfig.enabled;
}

/**
 * Get the global auto-enhance setting.
 * When true, enhanced prompts are applied without user confirmation (Req 8.2).
 */
export function isAutoEnhanceEnabled(): boolean {
  return globalConfig.autoEnhance;
}
