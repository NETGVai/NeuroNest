/**
 * LSPBridge — Language Server Protocol code intelligence for agents.
 *
 * Provides go-to-definition, find-references, and diagnostics capabilities
 * with graceful fallback to grep-based search when no LSP server is available.
 * Results are cached per session to reduce redundant queries.
 *
 * Key behaviors:
 * - When LSP server is not available → graceful fallback to grep-based search
 * - Per-session caching of results to avoid redundant queries
 * - Results compatible with ToolSystem interface format (ToolResult shape)
 * - isAvailable() checks if an LSP server can be connected to
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat, access } from 'node:fs/promises';
import { join, resolve, extname, relative } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface LSPQueryResult {
  symbol: string;
  location: { file: string; line: number; column: number };
  kind: 'definition' | 'reference' | 'type' | 'implementation';
}

export interface DiagnosticResult {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
}

/**
 * ToolSystem-compatible result format for LSP operations.
 * Conforms to the ToolResult interface shape { success, output, error? }.
 */
export interface LSPToolResult {
  success: boolean;
  output: LSPQueryResult | LSPQueryResult[] | DiagnosticResult[] | null;
  error?: string;
}

// ─── LSP Server Connector Interface ─────────────────────────────────────────

/**
 * Injectable LSP server connector for testing.
 * Real implementation would communicate via JSON-RPC with an LSP server process.
 */
export interface LSPServerConnector {
  isConnected(): boolean;
  goToDefinition(file: string, line: number, column: number): Promise<LSPQueryResult | null>;
  findReferences(file: string, line: number, column: number): Promise<LSPQueryResult[]>;
  getDiagnostics(file: string): Promise<DiagnosticResult[]>;
}

// ─── Grep-based Fallback ─────────────────────────────────────────────────────

/**
 * Grep-based fallback for symbol resolution when no LSP server is available.
 * Uses ripgrep (rg) if available, otherwise falls back to node:fs directory scan.
 */
class GrepFallback {
  constructor(private projectDir: string) {}

  /**
   * Search for a symbol definition using grep patterns.
   * Looks for common definition patterns: function, class, const, let, var,
   * export, interface, type, def, impl.
   */
  async findDefinition(symbol: string): Promise<LSPQueryResult | null> {
    const results = await this.grepForSymbol(symbol, this.getDefinitionPatterns(symbol));
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Search for all references to a symbol using grep.
   */
  async findReferences(symbol: string): Promise<LSPQueryResult[]> {
    const pattern = `\\b${this.escapeRegex(symbol)}\\b`;
    return this.grepForSymbol(symbol, [pattern], 'reference');
  }

  private getDefinitionPatterns(symbol: string): string[] {
    const escaped = this.escapeRegex(symbol);
    return [
      // TypeScript/JavaScript patterns
      `(function|class|interface|type|enum|namespace)\\s+${escaped}\\b`,
      `(const|let|var|export)\\s+${escaped}\\s*[=:]`,
      `(export\\s+default\\s+)?(function|class)\\s+${escaped}`,
      // Python patterns
      `(def|class)\\s+${escaped}\\s*[\\(:]`,
      // Rust patterns
      `(fn|struct|enum|trait|impl|type|const|static)\\s+${escaped}\\b`,
      // Go patterns
      `func\\s+(\\([^)]*\\)\\s+)?${escaped}\\s*\\(`,
      `type\\s+${escaped}\\s+`,
    ];
  }

  private async grepForSymbol(
    symbol: string,
    patterns: string[],
    kind: LSPQueryResult['kind'] = 'definition'
  ): Promise<LSPQueryResult[]> {
    const results: LSPQueryResult[] = [];
    const combinedPattern = patterns.join('|');

    // Try ripgrep first (faster)
    const rgResult = await this.tryRipgrep(combinedPattern);
    if (rgResult !== null) {
      return rgResult.map((match) => ({
        symbol,
        location: match,
        kind,
      }));
    }

    // Fallback: scan files with node:fs
    const matches = await this.scanFiles(combinedPattern);
    for (const match of matches) {
      results.push({ symbol, location: match, kind });
    }

    return results;
  }

  private async tryRipgrep(
    pattern: string
  ): Promise<Array<{ file: string; line: number; column: number }> | null> {
    try {
      const { stdout } = await execFileAsync('rg', [
        '--line-number',
        '--column',
        '--no-heading',
        '--color=never',
        '--max-count=20',
        '--type-add', 'code:*.{ts,tsx,js,jsx,py,rs,go,java,c,cpp,h,hpp,rb,swift}',
        '--type', 'code',
        '-e', pattern,
        this.projectDir,
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 });

      return this.parseRipgrepOutput(stdout);
    } catch {
      // ripgrep not available or no matches — return null to signal fallback
      return null;
    }
  }

  private parseRipgrepOutput(
    stdout: string
  ): Array<{ file: string; line: number; column: number }> {
    const results: Array<{ file: string; line: number; column: number }> = [];
    const lines = stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      // ripgrep format: file:line:column:content
      const match = line.match(/^(.+?):(\d+):(\d+):/);
      if (match) {
        results.push({
          file: relative(this.projectDir, match[1]),
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
        });
      }
    }

    return results;
  }

  /**
   * Node.js filesystem-based fallback when ripgrep is not available.
   * Scans source files in the project directory.
   */
  private async scanFiles(
    pattern: string
  ): Promise<Array<{ file: string; line: number; column: number }>> {
    const results: Array<{ file: string; line: number; column: number }> = [];
    const regex = new RegExp(pattern);
    const codeExtensions = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go',
      '.java', '.c', '.cpp', '.h', '.hpp', '.rb', '.swift',
    ]);

    const filesToScan = await this.collectSourceFiles(this.projectDir, codeExtensions, 4);

    for (const filePath of filesToScan) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(regex);
          if (match) {
            results.push({
              file: relative(this.projectDir, filePath),
              line: i + 1,
              column: (match.index ?? 0) + 1,
            });
            if (results.length >= 20) return results;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return results;
  }

  /**
   * Recursively collect source files up to a given depth.
   * Skips node_modules, .git, dist, build directories.
   */
  private async collectSourceFiles(
    dir: string,
    extensions: Set<string>,
    maxDepth: number,
    currentDepth = 0
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) return [];

    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__']);
    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          const subFiles = await this.collectSourceFiles(
            join(dir, entry.name), extensions, maxDepth, currentDepth + 1
          );
          files.push(...subFiles);
        } else if (entry.isFile() && extensions.has(extname(entry.name))) {
          files.push(join(dir, entry.name));
        }
      }
    } catch {
      // Skip unreadable directories
    }

    return files;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ─── LSPBridge Implementation ────────────────────────────────────────────────

/**
 * LSPBridge provides code intelligence capabilities (go-to-definition,
 * find-references, diagnostics) to the agent loop. When an LSP server
 * is connected, it uses the server for accurate results. Otherwise,
 * it falls back to grep-based search for symbol resolution.
 *
 * All results are cached per session to avoid redundant queries.
 */
export class LSPBridge {
  private sessionCache: Map<string, LSPQueryResult[]> = new Map();
  private diagnosticsCache: Map<string, DiagnosticResult[]> = new Map();
  private grepFallback: GrepFallback;
  private connector: LSPServerConnector | null;

  constructor(private projectDir: string, connector?: LSPServerConnector) {
    this.projectDir = resolve(projectDir);
    this.grepFallback = new GrepFallback(this.projectDir);
    this.connector = connector ?? null;

    logger.info('LSPBridge initialized', {
      projectDir: this.projectDir,
      lspAvailable: this.isAvailable(),
    });
  }

  /**
   * Go-to-definition via LSP; falls back to grep if no server available.
   * Returns the definition location for a symbol, or null if not found.
   *
   * Requirements: 6.1, 6.3, 6.4
   */
  async goToDefinition(symbol: string, file: string, line: number): Promise<LSPQueryResult | null> {
    const cacheKey = `def:${symbol}:${file}:${line}`;

    // Check session cache
    const cached = this.sessionCache.get(cacheKey);
    if (cached && cached.length > 0) {
      logger.debug('goToDefinition cache hit', { symbol, file, line });
      return cached[0];
    }

    let result: LSPQueryResult | null = null;

    if (this.isAvailable()) {
      // Use LSP server
      try {
        result = await this.connector!.goToDefinition(file, line, 0);
        if (result) {
          result.symbol = symbol;
        }
      } catch (err) {
        logger.debug('LSP goToDefinition failed, falling back to grep', {
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        result = await this.grepFallback.findDefinition(symbol);
      }
    } else {
      // Grep-based fallback
      result = await this.grepFallback.findDefinition(symbol);
    }

    // Cache the result
    if (result) {
      this.sessionCache.set(cacheKey, [result]);
    }

    return result;
  }

  /**
   * Find all references to a symbol via LSP or grep fallback.
   *
   * Requirements: 6.1, 6.3, 6.4
   */
  async findReferences(symbol: string, file: string, line: number): Promise<LSPQueryResult[]> {
    const cacheKey = `refs:${symbol}:${file}:${line}`;

    // Check session cache
    const cached = this.sessionCache.get(cacheKey);
    if (cached) {
      logger.debug('findReferences cache hit', { symbol, file, line });
      return cached;
    }

    let results: LSPQueryResult[] = [];

    if (this.isAvailable()) {
      // Use LSP server
      try {
        results = await this.connector!.findReferences(file, line, 0);
        // Ensure symbol is set on all results
        results = results.map((r) => ({ ...r, symbol }));
      } catch (err) {
        logger.debug('LSP findReferences failed, falling back to grep', {
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        results = await this.grepFallback.findReferences(symbol);
      }
    } else {
      // Grep-based fallback
      results = await this.grepFallback.findReferences(symbol);
    }

    // Cache results
    this.sessionCache.set(cacheKey, results);

    return results;
  }

  /**
   * Get current diagnostics for a file via LSP or empty fallback.
   * Diagnostics are file-level and not symbol-based, so grep fallback
   * is not applicable — returns empty array when LSP is unavailable.
   *
   * Requirements: 6.1, 6.3
   */
  async getDiagnostics(file: string): Promise<DiagnosticResult[]> {
    const cacheKey = `diag:${file}`;

    // Check diagnostics cache
    const cached = this.diagnosticsCache.get(cacheKey);
    if (cached) {
      logger.debug('getDiagnostics cache hit', { file });
      return cached;
    }

    let results: DiagnosticResult[] = [];

    if (this.isAvailable()) {
      try {
        results = await this.connector!.getDiagnostics(file);
      } catch (err) {
        logger.debug('LSP getDiagnostics failed', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
        results = [];
      }
    }
    // No grep fallback for diagnostics — requires actual language analysis

    // Cache results
    this.diagnosticsCache.set(cacheKey, results);

    return results;
  }

  /**
   * Check if an LSP server is available and connected.
   *
   * Requirements: 6.3
   */
  isAvailable(): boolean {
    return this.connector !== null && this.connector.isConnected();
  }

  /**
   * Clear the session cache. Called when starting a new session
   * or when file changes invalidate cached results.
   */
  clearCache(): void {
    this.sessionCache.clear();
    this.diagnosticsCache.clear();
    logger.debug('LSPBridge session cache cleared');
  }

  /**
   * Invalidate cache entries for a specific file.
   * Useful when the file has been modified and cached results are stale.
   */
  invalidateFile(file: string): void {
    // Remove all cache entries related to this file
    const keysToDelete: string[] = [];
    this.sessionCache.forEach((_value, key) => {
      if (key.includes(file)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => this.sessionCache.delete(key));
    this.diagnosticsCache.delete(`diag:${file}`);
  }

  /**
   * Expose results in ToolSystem-compatible format.
   * Wraps LSP operations as ToolResult-shaped objects for integration
   * with the agent's tool dispatch system.
   *
   * Requirements: 6.5
   */
  toToolResult(
    action: 'goToDefinition' | 'findReferences' | 'getDiagnostics',
    result: LSPQueryResult | LSPQueryResult[] | DiagnosticResult[] | null
  ): LSPToolResult {
    if (result === null) {
      return {
        success: false,
        output: null,
        error: `No results found for ${action}`,
      };
    }

    if (Array.isArray(result) && result.length === 0) {
      return {
        success: true,
        output: [],
      };
    }

    return {
      success: true,
      output: result,
    };
  }

  /**
   * Execute an LSP action and return a ToolSystem-compatible result.
   * This is the primary method for ToolSystem integration.
   *
   * Requirements: 6.5
   */
  async executeToolAction(input: {
    action: 'goToDefinition' | 'findReferences' | 'getDiagnostics';
    symbol?: string;
    file: string;
    line?: number;
  }): Promise<LSPToolResult> {
    try {
      switch (input.action) {
        case 'goToDefinition': {
          if (!input.symbol || input.line === undefined) {
            return { success: false, output: null, error: 'symbol and line are required for goToDefinition' };
          }
          const result = await this.goToDefinition(input.symbol, input.file, input.line);
          return this.toToolResult('goToDefinition', result);
        }

        case 'findReferences': {
          if (!input.symbol || input.line === undefined) {
            return { success: false, output: null, error: 'symbol and line are required for findReferences' };
          }
          const results = await this.findReferences(input.symbol, input.file, input.line);
          return this.toToolResult('findReferences', results);
        }

        case 'getDiagnostics': {
          const results = await this.getDiagnostics(input.file);
          return this.toToolResult('getDiagnostics', results);
        }

        default:
          return { success: false, output: null, error: `Unknown action: ${input.action}` };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
