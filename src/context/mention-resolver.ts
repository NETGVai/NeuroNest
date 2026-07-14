/**
 * MentionResolver — Parses @-mention syntax and resolves each mention to content.
 *
 * Supports mention types:
 *   @file:<path>     — reads file content (truncated at 100KB)
 *   @folder:<path>   — lists folder entries (tree-only beyond 50 entries)
 *   @url:<url>       — fetches URL content
 *   @git-diff        — gets current git diff
 *   @problems        — gets workspace diagnostics
 *   @terminal        — gets terminal buffer content
 *   @selection       — gets current editor selection
 *
 * All resolved content passes through FirewallEngine for secrets scanning.
 * Blocked mentions are silently excluded. Failed injections are abandoned
 * (no retry).
 *
 * Follows NeuroNest's lazy-initialized TypeScript singleton pattern.
 *
 * Requirements: 14.1, 14.4, 14.6
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────

/** Maximum file size before truncation (100KB) */
export const MAX_FILE_SIZE_BYTES = 100 * 1024;

/** Maximum folder entries before switching to tree-only display */
export const MAX_FOLDER_ENTRIES = 50;

/** URL fetch timeout in milliseconds */
export const URL_FETCH_TIMEOUT_MS = 10_000;

// ─── Types ──────────────────────────────────────────────────────

/** Supported mention types */
export type MentionType =
  | 'file'
  | 'folder'
  | 'url'
  | 'git-diff'
  | 'problems'
  | 'terminal'
  | 'selection';

/** A parsed mention extracted from user input */
export interface ParsedMention {
  /** The mention type */
  type: MentionType;
  /** The raw value (path, url, or empty for keyword mentions) */
  value: string;
  /** The full original match string from the message */
  raw: string;
}

/** A resolved mention with content ready for context injection */
export interface ResolvedMention {
  /** The original parsed mention */
  mention: ParsedMention;
  /** Resolved content (empty string if blocked/failed) */
  content: string;
  /** Whether the mention was successfully resolved */
  resolved: boolean;
  /** Whether the mention was blocked by the firewall */
  blocked: boolean;
  /** Whether the content was truncated */
  truncated: boolean;
  /** Error message if resolution failed */
  error?: string;
  /** Estimated token count (content length / 4) */
  tokenEstimate: number;
}

/** Result of resolving all mentions in a message */
export interface MentionResolutionResult {
  /** The message with mention tokens removed */
  cleanMessage: string;
  /** All resolved mentions */
  resolvedMentions: ResolvedMention[];
  /** Total estimated tokens across all resolved mentions */
  totalTokenEstimate: number;
}

/** Interface for FirewallEngine integration (secrets scanning) */
export interface MentionFirewallEvaluator {
  evaluate(input: string, opts?: { agentId?: string; projectId?: string }): {
    passed: boolean;
    blocked: boolean;
    sanitized: string;
  };
}

/** Interface for git operations */
export interface GitProvider {
  /** Get the current git diff (staged + unstaged) */
  getDiff(): Promise<string>;
}

/** Interface for diagnostics provider */
export interface DiagnosticsProvider {
  /** Get current workspace problems/diagnostics */
  getProblems(): string;
}

/** Interface for terminal buffer provider */
export interface TerminalBufferProvider {
  /** Get the current terminal buffer content */
  getBuffer(): string;
}

/** Interface for editor selection provider */
export interface EditorSelectionProvider {
  /** Get the current editor selection text */
  getSelection(): string;
}

/** Interface for URL fetching (injectable for testing) */
export interface UrlFetcher {
  /** Fetch URL content as text */
  fetch(url: string): Promise<string>;
}

// ─── Mention Parsing ────────────────────────────────────────────

/**
 * Regex patterns for each mention type.
 *
 * File/folder/url take a colon-separated argument.
 * git-diff, problems, terminal, selection are keyword-only.
 */
const MENTION_PATTERNS: Array<{ type: MentionType; pattern: RegExp }> = [
  { type: 'file', pattern: /@file:([^\s]+)/g },
  { type: 'folder', pattern: /@folder:([^\s]+)/g },
  { type: 'url', pattern: /@url:(https?:\/\/[^\s]+)/g },
  { type: 'git-diff', pattern: /@git-diff\b/g },
  { type: 'problems', pattern: /@problems\b/g },
  { type: 'terminal', pattern: /@terminal\b/g },
  { type: 'selection', pattern: /@selection\b/g },
];

/**
 * Parse all @-mentions from a message string.
 *
 * @param message - The user's chat message
 * @returns Array of parsed mentions in order of appearance
 */
export function parseMentions(message: string): ParsedMention[] {
  const mentions: Array<ParsedMention & { index: number }> = [];

  for (const { type, pattern } of MENTION_PATTERNS) {
    // Clone the regex to avoid shared state issues
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(message)) !== null) {
      mentions.push({
        type,
        value: match[1] ?? '',
        raw: match[0],
        index: match.index,
      });
    }
  }

  // Sort by position in original message
  mentions.sort((a, b) => a.index - b.index);

  // Return without the index field
  return mentions.map(({ type, value, raw }) => ({ type, value, raw }));
}

/**
 * Remove all mention tokens from the message, returning the clean text.
 *
 * @param message - The original message with @-mentions
 * @param mentions - Parsed mentions to remove
 * @returns Clean message text with mentions stripped
 */
export function stripMentions(message: string, mentions: ParsedMention[]): string {
  let clean = message;
  for (const mention of mentions) {
    clean = clean.replace(mention.raw, '');
  }
  // Collapse multiple spaces and trim
  return clean.replace(/\s{2,}/g, ' ').trim();
}

// ─── MentionResolver ────────────────────────────────────────────

/**
 * MentionResolver — Resolves @-mentions to their content.
 *
 * Lazy-initialized singleton that integrates with:
 * - FirewallEngine for secrets scanning (Req 14.6)
 * - File system for file/folder mentions (Req 14.1, 14.4)
 * - Git for diff mentions
 * - Diagnostics for problems mentions
 * - Terminal buffer for terminal mentions
 * - Editor state for selection mentions
 */
export class MentionResolver {
  private static instance: MentionResolver | null = null;

  private firewall: MentionFirewallEvaluator | null = null;
  private gitProvider: GitProvider | null = null;
  private diagnosticsProvider: DiagnosticsProvider | null = null;
  private terminalBufferProvider: TerminalBufferProvider | null = null;
  private editorSelectionProvider: EditorSelectionProvider | null = null;
  private urlFetcher: UrlFetcher | null = null;
  private projectPath: string = '';

  private constructor() {}

  /** Get or create the singleton instance */
  static getInstance(): MentionResolver {
    if (!MentionResolver.instance) {
      MentionResolver.instance = new MentionResolver();
    }
    return MentionResolver.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    MentionResolver.instance = null;
  }

  // ─── Dependency Injection ─────────────────────────────────────

  /** Set the project root path for resolving relative file/folder paths */
  setProjectPath(projectPath: string): void {
    this.projectPath = projectPath;
  }

  /** Inject the firewall evaluator for secrets scanning */
  setFirewall(firewall: MentionFirewallEvaluator): void {
    this.firewall = firewall;
  }

  /** Inject the git provider for @git-diff */
  setGitProvider(provider: GitProvider): void {
    this.gitProvider = provider;
  }

  /** Inject the diagnostics provider for @problems */
  setDiagnosticsProvider(provider: DiagnosticsProvider): void {
    this.diagnosticsProvider = provider;
  }

  /** Inject the terminal buffer provider for @terminal */
  setTerminalBufferProvider(provider: TerminalBufferProvider): void {
    this.terminalBufferProvider = provider;
  }

  /** Inject the editor selection provider for @selection */
  setEditorSelectionProvider(provider: EditorSelectionProvider): void {
    this.editorSelectionProvider = provider;
  }

  /** Inject the URL fetcher for @url */
  setUrlFetcher(fetcher: UrlFetcher): void {
    this.urlFetcher = fetcher;
  }

  // ─── Core Resolution ──────────────────────────────────────────

  /**
   * Resolve all @-mentions in a message.
   *
   * Parses mentions, resolves each to content, applies size limits,
   * and passes through firewall. Blocked or failed mentions are excluded
   * silently (Req 14.6).
   *
   * @param message - The user's chat message containing @-mentions
   * @returns Resolution result with clean message and resolved content
   */
  async resolveAll(message: string): Promise<MentionResolutionResult> {
    const mentions = parseMentions(message);
    const cleanMessage = stripMentions(message, mentions);

    const resolvedMentions: ResolvedMention[] = [];
    let totalTokenEstimate = 0;

    for (const mention of mentions) {
      const resolved = await this.resolveSingle(mention);
      resolvedMentions.push(resolved);
      if (resolved.resolved && !resolved.blocked) {
        totalTokenEstimate += resolved.tokenEstimate;
      }
    }

    return {
      cleanMessage,
      resolvedMentions,
      totalTokenEstimate,
    };
  }

  /**
   * Resolve a single mention to its content.
   *
   * @param mention - The parsed mention to resolve
   * @returns Resolved mention with content or error info
   */
  async resolveSingle(mention: ParsedMention): Promise<ResolvedMention> {
    let content: string;
    let truncated = false;

    try {
      switch (mention.type) {
        case 'file':
          ({ content, truncated } = await this.resolveFile(mention.value));
          break;
        case 'folder':
          ({ content, truncated } = await this.resolveFolder(mention.value));
          break;
        case 'url':
          content = await this.resolveUrl(mention.value);
          break;
        case 'git-diff':
          content = await this.resolveGitDiff();
          break;
        case 'problems':
          content = this.resolveProblems();
          break;
        case 'terminal':
          content = this.resolveTerminal();
          break;
        case 'selection':
          content = this.resolveSelection();
          break;
        default:
          content = '';
      }
    } catch (error: unknown) {
      // Abandon the mention on failure (Req 14.6 — no retry)
      return {
        mention,
        content: '',
        resolved: false,
        blocked: false,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
        tokenEstimate: 0,
      };
    }

    // If content is empty, nothing to scan
    if (!content) {
      return {
        mention,
        content: '',
        resolved: true,
        blocked: false,
        truncated,
        tokenEstimate: 0,
      };
    }

    // Pass through FirewallEngine for secrets scanning (Req 14.6)
    if (this.firewall) {
      const firewallResult = this.firewall.evaluate(content);
      if (firewallResult.blocked) {
        // Silently exclude blocked mentions (Req 14.6)
        return {
          mention,
          content: '',
          resolved: false,
          blocked: true,
          truncated: false,
          tokenEstimate: 0,
        };
      }
      // Use sanitized content (tier-0 cleaning applied)
      content = firewallResult.sanitized;
    }

    const tokenEstimate = Math.ceil(content.length / 4);

    return {
      mention,
      content,
      resolved: true,
      blocked: false,
      truncated,
      tokenEstimate,
    };
  }

  // ─── Individual Resolvers ─────────────────────────────────────

  /**
   * Resolve @file:<path> — reads file content with truncation at 100KB.
   */
  private async resolveFile(filePath: string): Promise<{ content: string; truncated: boolean }> {
    const fullPath = this.resolveFilePath(filePath);

    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    let truncated = false;
    let content: string;

    if (fileStat.size > MAX_FILE_SIZE_BYTES) {
      // Read only the first 100KB and add truncation note
      const buffer = Buffer.alloc(MAX_FILE_SIZE_BYTES);
      const { open } = await import('node:fs/promises');
      const fh = await open(fullPath, 'r');
      try {
        await fh.read(buffer, 0, MAX_FILE_SIZE_BYTES, 0);
      } finally {
        await fh.close();
      }
      content = buffer.toString('utf-8');
      truncated = true;
      content += `\n\n[Truncated: file exceeds 100KB limit (${(fileStat.size / 1024).toFixed(1)}KB total)]`;
    } else {
      content = await readFile(fullPath, 'utf-8');
    }

    return {
      content: `--- file: ${filePath} ---\n${content}`,
      truncated,
    };
  }

  /**
   * Resolve @folder:<path> — lists folder entries, tree-only beyond 50 entries.
   */
  private async resolveFolder(folderPath: string): Promise<{ content: string; truncated: boolean }> {
    const fullPath = this.resolveFilePath(folderPath);

    const folderStat = await stat(fullPath);
    if (!folderStat.isDirectory()) {
      throw new Error(`Not a directory: ${folderPath}`);
    }

    const entries = await readdir(fullPath, { withFileTypes: true });
    // Filter out hidden files
    const visibleEntries = entries.filter(e => !e.name.startsWith('.'));

    let truncated = false;
    let content: string;

    if (visibleEntries.length > MAX_FOLDER_ENTRIES) {
      // Tree-only mode: just list names and types (Req 14.4)
      truncated = true;
      const tree = visibleEntries
        .map(entry => {
          const icon = entry.isDirectory() ? '📁' : '📄';
          return `  ${icon} ${entry.name}`;
        })
        .join('\n');
      content = `--- folder: ${folderPath} (${visibleEntries.length} entries, tree only) ---\n${tree}`;
    } else {
      // Full listing with content preview for files
      const lines: string[] = [];
      for (const entry of visibleEntries) {
        if (entry.isDirectory()) {
          lines.push(`  📁 ${entry.name}/`);
        } else {
          lines.push(`  📄 ${entry.name}`);
        }
      }
      content = `--- folder: ${folderPath} (${visibleEntries.length} entries) ---\n${lines.join('\n')}`;
    }

    return { content, truncated };
  }

  /**
   * Resolve @url:<url> — fetches URL content.
   */
  private async resolveUrl(url: string): Promise<string> {
    let text: string;

    if (this.urlFetcher) {
      text = await this.urlFetcher.fetch(url);
    } else {
      // Default fetch with timeout
      const response = await fetch(url, {
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const html = await response.text();
      // Strip HTML tags for text extraction
      text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 30_000);
    }

    return `--- url: ${url} ---\n${text}`;
  }

  /**
   * Resolve @git-diff — gets current git diff.
   */
  private async resolveGitDiff(): Promise<string> {
    if (!this.gitProvider) {
      return '--- git-diff ---\nNo git provider available.';
    }

    const diff = await this.gitProvider.getDiff();
    return `--- git-diff ---\n${diff || 'No changes detected.'}`;
  }

  /**
   * Resolve @problems — gets workspace diagnostics.
   */
  private resolveProblems(): string {
    if (!this.diagnosticsProvider) {
      return '--- problems ---\nNo diagnostics provider available.';
    }

    const problems = this.diagnosticsProvider.getProblems();
    return `--- problems ---\n${problems || 'No problems detected.'}`;
  }

  /**
   * Resolve @terminal — gets terminal buffer content.
   */
  private resolveTerminal(): string {
    if (!this.terminalBufferProvider) {
      return '--- terminal ---\nNo terminal buffer available.';
    }

    const buffer = this.terminalBufferProvider.getBuffer();
    return `--- terminal ---\n${buffer || 'Terminal buffer is empty.'}`;
  }

  /**
   * Resolve @selection — gets current editor selection.
   */
  private resolveSelection(): string {
    if (!this.editorSelectionProvider) {
      return '--- selection ---\nNo editor selection available.';
    }

    const selection = this.editorSelectionProvider.getSelection();
    return `--- selection ---\n${selection || 'No text selected.'}`;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Resolve a file path relative to the project root.
   */
  private resolveFilePath(filePath: string): string {
    if (isAbsolute(filePath)) {
      return filePath;
    }
    return join(this.projectPath, filePath);
  }
}
