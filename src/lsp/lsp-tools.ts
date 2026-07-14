/**
 * LSP Tools — Agent-facing Language Server Protocol tools.
 *
 * Registers tools: `lsp_diagnostics`, `lsp_references`, `lsp_definition`, `lsp_symbols`
 * that agents can use to query language servers for compiler-grade intelligence.
 *
 * Implements a 5-second response cache to avoid redundant queries during
 * multi-step agent operations, and falls back gracefully when no language
 * server is available (tools return empty results with a note).
 *
 * Requirements: 13.2, 13.3, 13.4
 */

import type { ToolContext, ToolResult } from '../shared/types.js';
import type { ExecutableToolDefinition } from '../tools/tool-system.js';
import { safeExecute, type FieldSchema } from '../tools/built-in/input-validator.js';
import type { LanguageServerManager } from './language-server-manager.js';

// ─── Types ──────────────────────────────────────────────────────

/** A diagnostic (error/warning) from the language server */
export interface LspDiagnostic {
  /** File path the diagnostic applies to */
  filePath: string;
  /** Start line (1-indexed) */
  startLine: number;
  /** Start column (1-indexed) */
  startColumn: number;
  /** End line (1-indexed) */
  endLine: number;
  /** End column (1-indexed) */
  endColumn: number;
  /** Severity: error, warning, info, hint */
  severity: 'error' | 'warning' | 'info' | 'hint';
  /** Diagnostic message */
  message: string;
  /** Source of the diagnostic (e.g., "typescript", "pyright") */
  source?: string;
  /** Diagnostic code (e.g., "TS2322") */
  code?: string | number;
}

/** A reference location returned by lsp_references */
export interface LspReference {
  /** File path containing the reference */
  filePath: string;
  /** Line number (1-indexed) */
  line: number;
  /** Column number (1-indexed) */
  column: number;
  /** Preview of the line containing the reference */
  linePreview: string;
}

/** A definition location returned by lsp_definition */
export interface LspDefinition {
  /** File path containing the definition */
  filePath: string;
  /** Start line (1-indexed) */
  startLine: number;
  /** Start column (1-indexed) */
  startColumn: number;
  /** End line (1-indexed) */
  endLine: number;
  /** End column (1-indexed) */
  endColumn: number;
  /** Preview of the definition */
  preview: string;
}

/** A symbol returned by lsp_symbols */
export interface LspSymbol {
  /** Symbol name */
  name: string;
  /** Symbol kind: function, class, method, variable, interface, etc. */
  kind: string;
  /** Start line (1-indexed) */
  startLine: number;
  /** End line (1-indexed) */
  endLine: number;
  /** Container name (e.g., class name for methods) */
  containerName?: string;
}

/** Input for lsp_diagnostics tool */
export interface LspDiagnosticsInput {
  /** File path to get diagnostics for */
  filePath: string;
  /** Filter by severity (optional) */
  severity?: 'error' | 'warning' | 'info' | 'hint';
}

/** Input for lsp_references tool */
export interface LspReferencesInput {
  /** File path containing the symbol */
  filePath: string;
  /** Line number of the symbol (1-indexed) */
  line: number;
  /** Column number of the symbol (1-indexed) */
  column: number;
}

/** Input for lsp_definition tool */
export interface LspDefinitionInput {
  /** File path containing the symbol */
  filePath: string;
  /** Line number of the symbol (1-indexed) */
  line: number;
  /** Column number of the symbol (1-indexed) */
  column: number;
}

/** Input for lsp_symbols tool */
export interface LspSymbolsInput {
  /** File path to list symbols for */
  filePath: string;
  /** Optional filter by symbol kind */
  kind?: string;
}

// ─── Cache ──────────────────────────────────────────────────────

/** Cache entry storing a response with its expiry time */
export interface CacheEntry<T> {
  /** Cached response data */
  data: T;
  /** Timestamp (ms) when this entry expires */
  expiresAt: number;
}

/** Default cache TTL in milliseconds (5 seconds per Requirement 13.3) */
export const CACHE_TTL_MS = 5000;

/**
 * Simple in-memory response cache with TTL-based expiration.
 * Avoids redundant LSP queries during multi-step agent operations.
 *
 * Requirements: 13.3
 */
export class LspResponseCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private ttlMs: number;

  constructor(ttlMs: number = CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Generate a cache key from the tool name and input parameters.
   */
  buildKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(input)}`;
  }

  /**
   * Get a cached value if it exists and hasn't expired.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Store a value in the cache with TTL.
   */
  set<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached entries (including potentially expired ones).
   */
  get size(): number {
    return this.cache.size;
  }
}

// ─── LSP Client Interface ───────────────────────────────────────

/**
 * Interface for the LSP client that communicates with language servers.
 * The actual implementation will use the JSON-RPC protocol to talk to
 * running language server processes managed by LanguageServerManager.
 */
export interface LspClient {
  /** Get diagnostics for a file */
  getDiagnostics(filePath: string): Promise<LspDiagnostic[]>;
  /** Find all references to a symbol at the given position */
  getReferences(filePath: string, line: number, column: number): Promise<LspReference[]>;
  /** Go to definition of a symbol at the given position */
  getDefinition(filePath: string, line: number, column: number): Promise<LspDefinition[]>;
  /** List all symbols in a file */
  getSymbols(filePath: string): Promise<LspSymbol[]>;
}

// ─── Dependencies ───────────────────────────────────────────────

/**
 * Dependencies injected into LSP tools at registration time.
 */
export interface LspToolDeps {
  /** Get the LanguageServerManager instance (or null if unavailable) */
  getManager: () => LanguageServerManager | null;
  /** Get the LSP client (or null if no server is running) */
  getLspClient: () => LspClient | null;
  /** Check if the lsp_intelligence feature flag is enabled */
  isFeatureEnabled: () => boolean;
}

// ─── Input Schemas ──────────────────────────────────────────────

const diagnosticsSchema: FieldSchema[] = [
  { name: 'filePath', type: 'string' },
  { name: 'severity', type: 'string', required: false },
];

const referencesSchema: FieldSchema[] = [
  { name: 'filePath', type: 'string' },
  { name: 'line', type: 'number' },
  { name: 'column', type: 'number' },
];

const definitionSchema: FieldSchema[] = [
  { name: 'filePath', type: 'string' },
  { name: 'line', type: 'number' },
  { name: 'column', type: 'number' },
];

const symbolsSchema: FieldSchema[] = [
  { name: 'filePath', type: 'string' },
  { name: 'kind', type: 'string', required: false },
];

// ─── Graceful Fallback ──────────────────────────────────────────

/** Message returned when no language server is available (Req 13.4) */
const NO_SERVER_NOTE = 'No language server is currently available. Results may be incomplete.';

/**
 * Create a graceful fallback result when the LSP is unavailable.
 * Returns empty results with a note explaining the situation.
 *
 * Requirements: 13.4
 */
function createFallbackResult(toolName: string): ToolResult {
  return {
    success: true,
    output: {
      results: [],
      totalResults: 0,
      note: NO_SERVER_NOTE,
      tool: toolName,
    },
  };
}

// ─── Execute Function Factories ─────────────────────────────────

/**
 * Create the lsp_diagnostics execute function.
 * Returns errors/warnings from the language server for a given file.
 *
 * Requirements: 13.2, 13.3, 13.4
 */
export function createLspDiagnosticsExecute(
  deps: LspToolDeps,
  cache: LspResponseCache,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<LspDiagnosticsInput>(
    diagnosticsSchema,
    async (input: LspDiagnosticsInput, _context: ToolContext): Promise<ToolResult> => {
      if (!deps.isFeatureEnabled()) {
        return { success: false, output: null, error: 'LSP integration is disabled. Enable the lsp_intelligence feature flag.' };
      }

      const { filePath, severity } = input;

      if (!filePath.trim()) {
        return { success: false, output: null, error: 'filePath cannot be empty' };
      }

      // Check cache first
      const cacheKey = cache.buildKey('lsp_diagnostics', { filePath, severity });
      const cached = cache.get<LspDiagnostic[]>(cacheKey);
      if (cached !== null) {
        const filtered = severity ? cached.filter(d => d.severity === severity) : cached;
        return {
          success: true,
          output: { diagnostics: filtered, totalCount: filtered.length, cached: true },
        };
      }

      // Check if LSP client is available
      const client = deps.getLspClient();
      if (!client) {
        return createFallbackResult('lsp_diagnostics');
      }

      // Query the language server
      let diagnostics: LspDiagnostic[];
      try {
        diagnostics = await client.getDiagnostics(filePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: `LSP diagnostics query failed: ${message}` };
      }

      // Cache the full result
      cache.set(cacheKey, diagnostics);

      // Apply severity filter if specified
      const filtered = severity ? diagnostics.filter(d => d.severity === severity) : diagnostics;

      return {
        success: true,
        output: { diagnostics: filtered, totalCount: filtered.length, cached: false },
      };
    },
  );
}

/**
 * Create the lsp_references execute function.
 * Finds all references (usages) of a symbol at a given position.
 *
 * Requirements: 13.2, 13.3, 13.4
 */
export function createLspReferencesExecute(
  deps: LspToolDeps,
  cache: LspResponseCache,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<LspReferencesInput>(
    referencesSchema,
    async (input: LspReferencesInput, _context: ToolContext): Promise<ToolResult> => {
      if (!deps.isFeatureEnabled()) {
        return { success: false, output: null, error: 'LSP integration is disabled. Enable the lsp_intelligence feature flag.' };
      }

      const { filePath, line, column } = input;

      if (!filePath.trim()) {
        return { success: false, output: null, error: 'filePath cannot be empty' };
      }
      if (line < 1) {
        return { success: false, output: null, error: 'line must be >= 1' };
      }
      if (column < 1) {
        return { success: false, output: null, error: 'column must be >= 1' };
      }

      // Check cache
      const cacheKey = cache.buildKey('lsp_references', { filePath, line, column });
      const cached = cache.get<LspReference[]>(cacheKey);
      if (cached !== null) {
        return {
          success: true,
          output: { references: cached, totalCount: cached.length, cached: true },
        };
      }

      // Check if LSP client is available
      const client = deps.getLspClient();
      if (!client) {
        return createFallbackResult('lsp_references');
      }

      // Query the language server
      let references: LspReference[];
      try {
        references = await client.getReferences(filePath, line, column);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: `LSP references query failed: ${message}` };
      }

      // Cache the result
      cache.set(cacheKey, references);

      return {
        success: true,
        output: { references, totalCount: references.length, cached: false },
      };
    },
  );
}

/**
 * Create the lsp_definition execute function.
 * Navigates to the definition of a symbol at a given position.
 *
 * Requirements: 13.2, 13.3, 13.4
 */
export function createLspDefinitionExecute(
  deps: LspToolDeps,
  cache: LspResponseCache,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<LspDefinitionInput>(
    definitionSchema,
    async (input: LspDefinitionInput, _context: ToolContext): Promise<ToolResult> => {
      if (!deps.isFeatureEnabled()) {
        return { success: false, output: null, error: 'LSP integration is disabled. Enable the lsp_intelligence feature flag.' };
      }

      const { filePath, line, column } = input;

      if (!filePath.trim()) {
        return { success: false, output: null, error: 'filePath cannot be empty' };
      }
      if (line < 1) {
        return { success: false, output: null, error: 'line must be >= 1' };
      }
      if (column < 1) {
        return { success: false, output: null, error: 'column must be >= 1' };
      }

      // Check cache
      const cacheKey = cache.buildKey('lsp_definition', { filePath, line, column });
      const cached = cache.get<LspDefinition[]>(cacheKey);
      if (cached !== null) {
        return {
          success: true,
          output: { definitions: cached, totalCount: cached.length, cached: true },
        };
      }

      // Check if LSP client is available
      const client = deps.getLspClient();
      if (!client) {
        return createFallbackResult('lsp_definition');
      }

      // Query the language server
      let definitions: LspDefinition[];
      try {
        definitions = await client.getDefinition(filePath, line, column);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: `LSP definition query failed: ${message}` };
      }

      // Cache the result
      cache.set(cacheKey, definitions);

      return {
        success: true,
        output: { definitions, totalCount: definitions.length, cached: false },
      };
    },
  );
}

/**
 * Create the lsp_symbols execute function.
 * Lists all symbols (functions, classes, variables, etc.) in a file.
 *
 * Requirements: 13.2, 13.3, 13.4
 */
export function createLspSymbolsExecute(
  deps: LspToolDeps,
  cache: LspResponseCache,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<LspSymbolsInput>(
    symbolsSchema,
    async (input: LspSymbolsInput, _context: ToolContext): Promise<ToolResult> => {
      if (!deps.isFeatureEnabled()) {
        return { success: false, output: null, error: 'LSP integration is disabled. Enable the lsp_intelligence feature flag.' };
      }

      const { filePath, kind } = input;

      if (!filePath.trim()) {
        return { success: false, output: null, error: 'filePath cannot be empty' };
      }

      // Check cache
      const cacheKey = cache.buildKey('lsp_symbols', { filePath, kind });
      const cached = cache.get<LspSymbol[]>(cacheKey);
      if (cached !== null) {
        const filtered = kind ? cached.filter(s => s.kind === kind) : cached;
        return {
          success: true,
          output: { symbols: filtered, totalCount: filtered.length, cached: true },
        };
      }

      // Check if LSP client is available
      const client = deps.getLspClient();
      if (!client) {
        return createFallbackResult('lsp_symbols');
      }

      // Query the language server
      let symbols: LspSymbol[];
      try {
        symbols = await client.getSymbols(filePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: `LSP symbols query failed: ${message}` };
      }

      // Cache the full result
      cache.set(cacheKey, symbols);

      // Apply kind filter if specified
      const filtered = kind ? symbols.filter(s => s.kind === kind) : symbols;

      return {
        success: true,
        output: { symbols: filtered, totalCount: filtered.length, cached: false },
      };
    },
  );
}

// ─── Tool Definitions ───────────────────────────────────────────

/**
 * Create the lsp_diagnostics tool definition.
 */
export function createLspDiagnosticsTool(deps: LspToolDeps, cache: LspResponseCache): ExecutableToolDefinition {
  return {
    id: 'lsp_diagnostics',
    name: 'LspDiagnosticsTool',
    description:
      'Get errors, warnings, and other diagnostics from the language server for a given file. ' +
      'Returns compiler/linter diagnostics with severity, location, and message.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the file to get diagnostics for',
        },
        severity: {
          type: 'string',
          description: 'Optional filter by severity: error, warning, info, or hint',
        },
      },
      required: ['filePath'],
    },
    riskLevel: 'read-only',
    execute: createLspDiagnosticsExecute(deps, cache),
  };
}

/**
 * Create the lsp_references tool definition.
 */
export function createLspReferencesTool(deps: LspToolDeps, cache: LspResponseCache): ExecutableToolDefinition {
  return {
    id: 'lsp_references',
    name: 'LspReferencesTool',
    description:
      'Find all references (usages) of a symbol at a given position in the codebase. ' +
      'Returns file paths, line numbers, and line previews for each reference.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the file containing the symbol',
        },
        line: {
          type: 'number',
          description: 'Line number of the symbol (1-indexed)',
        },
        column: {
          type: 'number',
          description: 'Column number of the symbol (1-indexed)',
        },
      },
      required: ['filePath', 'line', 'column'],
    },
    riskLevel: 'read-only',
    execute: createLspReferencesExecute(deps, cache),
  };
}

/**
 * Create the lsp_definition tool definition.
 */
export function createLspDefinitionTool(deps: LspToolDeps, cache: LspResponseCache): ExecutableToolDefinition {
  return {
    id: 'lsp_definition',
    name: 'LspDefinitionTool',
    description:
      'Go to the definition of a symbol at a given position. ' +
      'Returns the definition location(s) with file path, line range, and preview.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the file containing the symbol',
        },
        line: {
          type: 'number',
          description: 'Line number of the symbol (1-indexed)',
        },
        column: {
          type: 'number',
          description: 'Column number of the symbol (1-indexed)',
        },
      },
      required: ['filePath', 'line', 'column'],
    },
    riskLevel: 'read-only',
    execute: createLspDefinitionExecute(deps, cache),
  };
}

/**
 * Create the lsp_symbols tool definition.
 */
export function createLspSymbolsTool(deps: LspToolDeps, cache: LspResponseCache): ExecutableToolDefinition {
  return {
    id: 'lsp_symbols',
    name: 'LspSymbolsTool',
    description:
      'List all symbols (functions, classes, methods, variables, interfaces, etc.) in a file. ' +
      'Returns symbol names, kinds, line ranges, and container names.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the file to list symbols for',
        },
        kind: {
          type: 'string',
          description: 'Optional filter by symbol kind (e.g., function, class, method, variable)',
        },
      },
      required: ['filePath'],
    },
    riskLevel: 'read-only',
    execute: createLspSymbolsExecute(deps, cache),
  };
}

// ─── Registration Helper ────────────────────────────────────────

/**
 * Register all LSP tools with a ToolSystem instance.
 *
 * Creates a shared LspResponseCache (5-second TTL) used by all four tools
 * to avoid redundant queries during multi-step agent operations.
 *
 * Requirements: 13.2, 13.3, 13.4
 *
 * @param toolSystem - The ToolSystem instance to register with
 * @param deps - Dependencies providing access to the LSP infrastructure
 */
export function registerLspTools(
  toolSystem: { register: (tool: ExecutableToolDefinition) => void },
  deps: LspToolDeps,
): void {
  const cache = new LspResponseCache(CACHE_TTL_MS);

  toolSystem.register(createLspDiagnosticsTool(deps, cache));
  toolSystem.register(createLspReferencesTool(deps, cache));
  toolSystem.register(createLspDefinitionTool(deps, cache));
  toolSystem.register(createLspSymbolsTool(deps, cache));
}
