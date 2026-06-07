/**
 * LSPManager — Language server lifecycle, code intelligence relay.
 *
 * Stub implementation with in-memory state. Manages LSP server lifecycle,
 * diagnostics, definitions, references, completions, hover info.
 * Supports crash recovery with automatic restart.
 *
 * Requirements: 20.1–20.8
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface Position {
  line: number;
  character: number;
}

export interface Location {
  filePath: string;
  range: { start: Position; end: Position };
}

export interface Diagnostic {
  filePath: string;
  range: { start: Position; end: Position };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source: string;
}

export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
  insertText?: string;
}

export interface HoverInfo {
  contents: string;
  range?: { start: Position; end: Position };
}

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'swift';

const LANGUAGE_SERVER_MAP: Record<SupportedLanguage, string> = {
  typescript: 'tsserver',
  javascript: 'tsserver',
  python: 'pyright',
  rust: 'rust-analyzer',
  go: 'gopls',
  swift: 'sourcekit-lsp',
};

interface LSPServerState {
  language: SupportedLanguage;
  projectDir: string;
  serverName: string;
  running: boolean;
  crashCount: number;
  maxRestarts: number;
}

// ─── LSPManager ─────────────────────────────────────────────────

export class LSPManager {
  private servers = new Map<string, LSPServerState>();
  private diagnosticsStore = new Map<string, Diagnostic[]>(); // filePath -> diagnostics
  private diagnosticsListeners: Array<(filePath: string, diagnostics: Diagnostic[]) => void> = [];

  /**
   * Start an LSP server for a language in a project directory.
   * Requirements: 20.1, 20.7
   */
  async startServer(language: string, projectDir: string): Promise<void> {
    const lang = language.toLowerCase() as SupportedLanguage;
    if (!LANGUAGE_SERVER_MAP[lang]) {
      throw new Error(`Unsupported language: ${language}. Supported: ${Object.keys(LANGUAGE_SERVER_MAP).join(', ')}`);
    }

    const key = `${lang}:${projectDir}`;
    if (this.servers.has(key) && this.servers.get(key)!.running) {
      return; // Already running
    }

    this.servers.set(key, {
      language: lang,
      projectDir,
      serverName: LANGUAGE_SERVER_MAP[lang],
      running: true,
      crashCount: 0,
      maxRestarts: 3,
    });
  }

  /**
   * Stop an LSP server for a language.
   * Requirements: 20.1
   */
  stopServer(language: string): void {
    const lang = language.toLowerCase() as SupportedLanguage;
    for (const [key, server] of this.servers) {
      if (server.language === lang) {
        server.running = false;
        this.servers.delete(key);
      }
    }
  }

  /**
   * Auto-detect languages in a project directory.
   * Requirements: 20.2
   */
  autoDetectLanguages(projectDir: string): string[] {
    // Stub: return common languages based on file extensions
    // In real impl, would scan projectDir for file types
    const detected: SupportedLanguage[] = [];
    const extensionMap: Record<string, SupportedLanguage> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.swift': 'swift',
    };

    // Stub: return all supported languages for the project
    // Real implementation would scan files
    return Object.keys(LANGUAGE_SERVER_MAP);
  }

  /**
   * Get diagnostics for a file.
   * Requirements: 20.3
   */
  getDiagnostics(filePath: string): Diagnostic[] {
    return [...(this.diagnosticsStore.get(filePath) ?? [])];
  }

  /**
   * Get definition location for a symbol at a position.
   * Requirements: 20.4
   */
  getDefinition(filePath: string, position: Position): Location | null {
    // Stub: return null (no real LSP server)
    const server = this.findServerForFile(filePath);
    if (!server || !server.running) return null;

    return null;
  }

  /**
   * Get references for a symbol at a position.
   * Requirements: 20.4
   */
  getReferences(filePath: string, position: Position): Location[] {
    const server = this.findServerForFile(filePath);
    if (!server || !server.running) return [];

    return [];
  }

  /**
   * Get completions at a position.
   * Requirements: 20.5
   */
  getCompletions(filePath: string, position: Position): CompletionItem[] {
    const server = this.findServerForFile(filePath);
    if (!server || !server.running) return [];

    return [];
  }

  /**
   * Get hover info at a position.
   * Requirements: 20.4
   */
  getHoverInfo(filePath: string, position: Position): HoverInfo | null {
    const server = this.findServerForFile(filePath);
    if (!server || !server.running) return null;

    return null;
  }

  /**
   * Register a diagnostics change listener.
   * Requirements: 20.6
   */
  onDiagnosticsChange(callback: (filePath: string, diagnostics: Diagnostic[]) => void): void {
    this.diagnosticsListeners.push(callback);
  }

  /**
   * Re-check diagnostics for a file (e.g., after modification).
   * Requirements: 20.6
   */
  async recheckFile(filePath: string): Promise<Diagnostic[]> {
    const server = this.findServerForFile(filePath);
    if (!server || !server.running) {
      return [];
    }

    // Stub: generate fresh diagnostics (in real impl, LSP server would analyze)
    const diagnostics = this.diagnosticsStore.get(filePath) ?? [];
    // Notify listeners
    for (const listener of this.diagnosticsListeners) {
      listener(filePath, diagnostics);
    }
    return diagnostics;
  }

  /**
   * Simulate setting diagnostics for a file (for testing).
   */
  setDiagnostics(filePath: string, diagnostics: Diagnostic[]): void {
    this.diagnosticsStore.set(filePath, diagnostics);
  }

  /**
   * Simulate a server crash for testing crash recovery.
   * Requirements: 20.8
   */
  simulateCrash(language: string): void {
    const lang = language.toLowerCase() as SupportedLanguage;
    for (const [, server] of this.servers) {
      if (server.language === lang) {
        server.running = false;
        server.crashCount++;
      }
    }
  }

  /**
   * Attempt crash recovery — restart crashed servers.
   * Requirements: 20.8
   */
  async recoverCrashedServers(): Promise<string[]> {
    const recovered: string[] = [];

    for (const [key, server] of this.servers) {
      if (!server.running && server.crashCount <= server.maxRestarts) {
        server.running = true;
        recovered.push(server.language);
      }
    }

    return recovered;
  }

  /**
   * Check if a server for a language is running.
   */
  isServerRunning(language: string): boolean {
    const lang = language.toLowerCase() as SupportedLanguage;
    for (const [, server] of this.servers) {
      if (server.language === lang && server.running) return true;
    }
    return false;
  }

  /**
   * Get all running server languages.
   */
  getRunningServers(): string[] {
    const running: string[] = [];
    for (const [, server] of this.servers) {
      if (server.running && !running.includes(server.language)) {
        running.push(server.language);
      }
    }
    return running;
  }

  // ── Private helpers ─────────────────────────────────────────

  private findServerForFile(filePath: string): LSPServerState | null {
    // Stub: find any running server (real impl would match by file extension)
    for (const [, server] of this.servers) {
      if (server.running) return server;
    }
    return null;
  }
}
