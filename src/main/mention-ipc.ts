/**
 * Main-process IPC handlers for @-mention system.
 *
 * Registers handlers for:
 * - `context:resolve-mention` — Resolve a mention to its content
 * - `context:list-mentionables` — Get autocomplete suggestions
 *
 * Integrates with MentionResolver and MentionAutocomplete from src/context/.
 * Feature-gated behind `context_mentions` flag.
 *
 * Requirements: 14.2, 14.3, 14.5, 14.7
 */

import { ipcMain } from 'electron';

// ─── Types ──────────────────────────────────────────────────────

/** Dependencies for the mention IPC handlers */
export interface MentionIPCDeps {
  /** Feature gate check — returns true if context_mentions is enabled */
  isFeatureEnabled: () => boolean;
}

/** Payload for context:resolve-mention */
interface ResolveMentionPayload {
  type: string;
  value: string;
}

/** Payload for context:list-mentionables */
interface ListMentionablesPayload {
  query: string;
}

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register mention IPC handlers.
 *
 * Called from registerIPCHandlers() in src/main/ipc.ts.
 * Both channels are guarded by the `context_mentions` feature flag.
 */
export function registerMentionIPC(deps: MentionIPCDeps): void {
  const { isFeatureEnabled } = deps;

  // Remove any previously registered handlers (idempotent registration)
  for (const ch of ['context:resolve-mention', 'context:list-mentionables']) {
    try { ipcMain.removeHandler(ch); } catch { /* noop */ }
  }

  // ── context:resolve-mention ──────────────────────────────────
  ipcMain.handle('context:resolve-mention', async (_event, payload: ResolveMentionPayload) => {
    if (!isFeatureEnabled()) {
      return {
        resolved: false,
        content: '',
        truncated: false,
        blocked: false,
        tokenEstimate: 0,
        error: 'context_mentions feature is disabled',
      };
    }

    try {
      // Lazy-load the MentionResolver to avoid circular imports and reduce startup cost
      const { MentionResolver } = await import('../context/mention-resolver.js');
      const resolver = MentionResolver.getInstance();

      const resolved = await resolver.resolveSingle({
        type: payload.type as any,
        value: payload.value,
        raw: `@${payload.type}${payload.value ? ':' + payload.value : ''}`,
      });

      return {
        resolved: resolved.resolved,
        content: resolved.content,
        truncated: resolved.truncated,
        blocked: resolved.blocked,
        tokenEstimate: resolved.tokenEstimate,
        error: resolved.error,
      };
    } catch (error: unknown) {
      return {
        resolved: false,
        content: '',
        truncated: false,
        blocked: false,
        tokenEstimate: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // ── context:list-mentionables ────────────────────────────────
  ipcMain.handle('context:list-mentionables', async (_event, payload: ListMentionablesPayload) => {
    if (!isFeatureEnabled()) {
      return [];
    }

    try {
      // Lazy-load the MentionAutocomplete
      const { MentionAutocomplete } = await import('../context/mention-autocomplete.js');
      const autocomplete = MentionAutocomplete.getInstance();

      return autocomplete.getSuggestions(payload.query);
    } catch {
      return [];
    }
  });

  console.log('[IPC] Mention IPC handlers registered (context:resolve-mention, context:list-mentionables)');
}
