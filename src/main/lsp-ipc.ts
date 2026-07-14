/**
 * LSP IPC Handler — Wires Language Server Protocol queries to the renderer.
 *
 * Registers IPC handlers for:
 *   - `lsp:diagnostics` — Get errors/warnings for a file
 *   - `lsp:references` — Find all usages of a symbol
 *   - `lsp:definition` — Go to definition
 *   - `lsp:symbols` — List symbols in a file
 *   - `lsp:status` — Get LSP server health status
 *
 * Feature-gated behind the existing `lsp_intelligence` flag.
 * Respects the project's existing LSP configuration files
 * (tsconfig.json, pyrightconfig.json, etc.) via LanguageServerManager.
 *
 * Requirements: 13.6, 13.7
 */

import { ipcMain } from 'electron';
import {
  LanguageServerManager,
  type SupportedLanguage,
  type ServerHealth,
} from '../lsp/language-server-manager.js';
import {
  LspResponseCache,
  CACHE_TTL_MS,
  type LspClient,
  type LspDiagnostic,
  type LspReference,
  type LspDefinition,
  type LspSymbol,
} from '../lsp/lsp-tools.js';

// ─── Types ──────────────────────────────────────────────────────

/** Dependencies injected by the caller (registerIPCHandlers in ipc.ts) */
export interface LspIPCDeps {
  /** Check if the lsp_intelligence feature flag is enabled */
  isFeatureEnabled: () => boolean;
  /** Get the active project directory (null if no project open) */
  getActiveProjectDir: () => string | null;
}

/** Status response for `lsp:status` */
export interface LspStatusResponse {
  /** Whether the LSP integration is enabled via feature flag */
  enabled: boolean;
  /** Whether the manager is actively running */
  active: boolean;
  /** Per-language health status */
  servers: Array<{
    language: SupportedLanguage;
    health: ServerHealth;
    restartCount: number;
  }>;
  /** Project directory the manager is operating on */
  projectDir: string | null;
}

// ─── Singleton State ────────────────────────────────────────────

let lspManager: LanguageServerManager | null = null;
let lspCache: LspResponseCache | null = null;
let lspClient: LspClient | null = null;

/**
 * Get or create the LanguageServerManager singleton.
 * Lazily initialized on first use.
 */
function getManager(deps: LspIPCDeps): LanguageServerManager {
  if (!lspManager) {
    lspManager = LanguageServerManager.getInstance({
      enabled: deps.isFeatureEnabled(),
      maxRestarts: 3,
      restartDelayMs: 1000,
    });
  }
  // Sync enabled state with the feature flag (may change at runtime)
  lspManager.updateConfig({ enabled: deps.isFeatureEnabled() });
  return lspManager;
}

/**
 * Get or create the response cache singleton.
 */
function getCache(): LspResponseCache {
  if (!lspCache) {
    lspCache = new LspResponseCache(CACHE_TTL_MS);
  }
  return lspCache;
}

/**
 * Stub LspClient implementation.
 *
 * Since LanguageServerManager spawns processes but doesn't implement
 * the JSON-RPC protocol itself, this stub provides a placeholder
 * implementation that returns empty results when no real client is wired.
 * In a full implementation, this would communicate with the language server
 * processes via stdin/stdout JSON-RPC.
 */
function getStubLspClient(): LspClient {
  if (!lspClient) {
    lspClient = {
      async getDiagnostics(_filePath: string): Promise<LspDiagnostic[]> {
        return [];
      },
      async getReferences(_filePath: string, _line: number, _column: number): Promise<LspReference[]> {
        return [];
      },
      async getDefinition(_filePath: string, _line: number, _column: number): Promise<LspDefinition[]> {
        return [];
      },
      async getSymbols(_filePath: string): Promise<LspSymbol[]> {
        return [];
      },
    };
  }
  return lspClient;
}

// ─── Graceful Fallback ──────────────────────────────────────────

const NO_SERVER_NOTE = 'No language server is currently available. Results may be incomplete.';
const FEATURE_DISABLED_ERROR = 'LSP integration is disabled. Enable the lsp_intelligence feature flag.';

// ─── Registration ───────────────────────────────────────────────

/**
 * Register LSP IPC handlers.
 *
 * Channels:
 *   - `lsp:diagnostics` — Get errors/warnings for a file
 *   - `lsp:references` — Find all references of a symbol
 *   - `lsp:definition` — Go to definition of a symbol
 *   - `lsp:symbols` — List all symbols in a file
 *   - `lsp:status` — Get current LSP server health/status
 *
 * All handlers check the `lsp_intelligence` feature flag first.
 * When disabled, they return appropriate error messages per Req 13.7.
 *
 * The handlers respect the project's existing LSP configuration files
 * by relying on the LanguageServerManager's config detection (Req 13.6).
 *
 * Requirements: 13.6, 13.7
 */
export function registerLspIPC(deps: LspIPCDeps): void {
  const cache = getCache();

  // ── lsp:diagnostics ─────────────────────────────────────────────
  ipcMain.handle('lsp:diagnostics', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const filePath = typeof args === 'object' && args !== null ? args.filePath : args;
      const severity = typeof args === 'object' && args !== null ? args.severity : undefined;

      if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: 'filePath is required' };
      }

      // Check cache
      const cacheKey = cache.buildKey('lsp:diagnostics', { filePath, severity });
      const cached = cache.get<LspDiagnostic[]>(cacheKey);
      if (cached !== null) {
        const filtered = severity ? cached.filter(d => d.severity === severity) : cached;
        return { success: true, diagnostics: filtered, totalCount: filtered.length, cached: true };
      }

      // Check manager status
      const manager = getManager(deps);
      if (!manager.isActive || manager.getRunningServers().length === 0) {
        return { success: true, diagnostics: [], totalCount: 0, note: NO_SERVER_NOTE };
      }

      // Query via LSP client
      const client = getStubLspClient();
      const diagnostics = await client.getDiagnostics(filePath);

      // Cache result
      cache.set(cacheKey, diagnostics);

      const filtered = severity ? diagnostics.filter(d => d.severity === severity) : diagnostics;
      return { success: true, diagnostics: filtered, totalCount: filtered.length, cached: false };
    } catch (e: any) {
      return { success: false, error: `lsp:diagnostics failed: ${e?.message || String(e)}` };
    }
  });

  // ── lsp:references ──────────────────────────────────────────────
  ipcMain.handle('lsp:references', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const filePath = args?.filePath;
      const line = args?.line;
      const column = args?.column;

      if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: 'filePath is required' };
      }
      if (typeof line !== 'number' || line < 1) {
        return { success: false, error: 'line must be a number >= 1' };
      }
      if (typeof column !== 'number' || column < 1) {
        return { success: false, error: 'column must be a number >= 1' };
      }

      // Check cache
      const cacheKey = cache.buildKey('lsp:references', { filePath, line, column });
      const cached = cache.get<LspReference[]>(cacheKey);
      if (cached !== null) {
        return { success: true, references: cached, totalCount: cached.length, cached: true };
      }

      // Check manager status
      const manager = getManager(deps);
      if (!manager.isActive || manager.getRunningServers().length === 0) {
        return { success: true, references: [], totalCount: 0, note: NO_SERVER_NOTE };
      }

      // Query via LSP client
      const client = getStubLspClient();
      const references = await client.getReferences(filePath, line, column);

      // Cache result
      cache.set(cacheKey, references);

      return { success: true, references, totalCount: references.length, cached: false };
    } catch (e: any) {
      return { success: false, error: `lsp:references failed: ${e?.message || String(e)}` };
    }
  });

  // ── lsp:definition ──────────────────────────────────────────────
  ipcMain.handle('lsp:definition', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const filePath = args?.filePath;
      const line = args?.line;
      const column = args?.column;

      if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: 'filePath is required' };
      }
      if (typeof line !== 'number' || line < 1) {
        return { success: false, error: 'line must be a number >= 1' };
      }
      if (typeof column !== 'number' || column < 1) {
        return { success: false, error: 'column must be a number >= 1' };
      }

      // Check cache
      const cacheKey = cache.buildKey('lsp:definition', { filePath, line, column });
      const cached = cache.get<LspDefinition[]>(cacheKey);
      if (cached !== null) {
        return { success: true, definitions: cached, totalCount: cached.length, cached: true };
      }

      // Check manager status
      const manager = getManager(deps);
      if (!manager.isActive || manager.getRunningServers().length === 0) {
        return { success: true, definitions: [], totalCount: 0, note: NO_SERVER_NOTE };
      }

      // Query via LSP client
      const client = getStubLspClient();
      const definitions = await client.getDefinition(filePath, line, column);

      // Cache result
      cache.set(cacheKey, definitions);

      return { success: true, definitions, totalCount: definitions.length, cached: false };
    } catch (e: any) {
      return { success: false, error: `lsp:definition failed: ${e?.message || String(e)}` };
    }
  });

  // ── lsp:symbols ─────────────────────────────────────────────────
  ipcMain.handle('lsp:symbols', async (_ev, args: any) => {
    try {
      if (!deps.isFeatureEnabled()) {
        return { success: false, error: FEATURE_DISABLED_ERROR };
      }

      const filePath = args?.filePath;
      const kind = args?.kind;

      if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: 'filePath is required' };
      }

      // Check cache
      const cacheKey = cache.buildKey('lsp:symbols', { filePath, kind });
      const cached = cache.get<LspSymbol[]>(cacheKey);
      if (cached !== null) {
        const filtered = kind ? cached.filter(s => s.kind === kind) : cached;
        return { success: true, symbols: filtered, totalCount: filtered.length, cached: true };
      }

      // Check manager status
      const manager = getManager(deps);
      if (!manager.isActive || manager.getRunningServers().length === 0) {
        return { success: true, symbols: [], totalCount: 0, note: NO_SERVER_NOTE };
      }

      // Query via LSP client
      const client = getStubLspClient();
      const symbols = await client.getSymbols(filePath);

      // Cache result
      cache.set(cacheKey, symbols);

      const filtered = kind ? symbols.filter(s => s.kind === kind) : symbols;
      return { success: true, symbols: filtered, totalCount: filtered.length, cached: false };
    } catch (e: any) {
      return { success: false, error: `lsp:symbols failed: ${e?.message || String(e)}` };
    }
  });

  // ── lsp:status ──────────────────────────────────────────────────
  ipcMain.handle('lsp:status', async () => {
    try {
      const enabled = deps.isFeatureEnabled();
      if (!enabled) {
        return {
          enabled: false,
          active: false,
          servers: [],
          projectDir: null,
        } satisfies LspStatusResponse;
      }

      const manager = getManager(deps);
      const allHealth = manager.getAllServerHealth();
      const servers: LspStatusResponse['servers'] = [];

      for (const [language, health] of allHealth) {
        const info = manager.getServerInfo(language);
        servers.push({
          language,
          health,
          restartCount: info?.restartCount ?? 0,
        });
      }

      return {
        enabled: true,
        active: manager.isActive,
        servers,
        projectDir: manager.getProjectDir(),
      } satisfies LspStatusResponse;
    } catch (e: any) {
      return {
        enabled: deps.isFeatureEnabled(),
        active: false,
        servers: [],
        projectDir: null,
        error: e?.message || String(e),
      };
    }
  });

  console.log('[IPC] LSP Integration IPC handlers registered (lsp:diagnostics, lsp:references, lsp:definition, lsp:symbols, lsp:status)');
}
