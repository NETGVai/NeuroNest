/**
 * EditorToChatBridge — Sends editor selections, symbols, diagnostics, files,
 * and Hunks to chat as structured Context_Items.
 *
 * This module converts editor state (active selection, symbol under cursor,
 * diagnostics, file references, diff hunks) into typed Context_Items that
 * the chat composer can consume without ambiguity.
 *
 * Requirements: 19.1
 */

import type { LinkEndpoint, CrossSurfaceLink } from './cross-surface-link-registry';
import type { CrossSurfaceLinkRegistry } from './cross-surface-link-registry';

/**
 * Types of content that can be sent from the editor to chat.
 */
export type ContextItemKind =
  | 'selection'
  | 'symbol'
  | 'diagnostic'
  | 'file'
  | 'hunk';

/**
 * A structured Context_Item produced from editor state.
 */
export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  uri: string;
  workspaceId: string;
  /** Workspace-relative path (no absolute local paths) */
  relativePath: string;
  /** Line range for selections or hunks */
  range?: { startLine: number; endLine: number; startColumn?: number; endColumn?: number };
  /** Symbol name for symbol references */
  symbolName?: string;
  /** Symbol kind for symbol references */
  symbolKind?: string;
  /** Diagnostic severity and message */
  diagnosticInfo?: { severity: 'error' | 'warning' | 'info' | 'hint'; message: string; code?: string };
  /** Hunk metadata for diff hunks */
  hunkInfo?: { operation: 'add' | 'modify' | 'delete'; addedLines: number; removedLines: number };
  /** Content snippet (bounded) */
  content?: string;
  /** Document version at the time of capture */
  documentVersion?: number;
  /** Timestamp of creation */
  createdAt: number;
}

/**
 * Input for creating a selection context item.
 */
export interface SelectionInput {
  uri: string;
  workspaceId: string;
  relativePath: string;
  range: { startLine: number; endLine: number; startColumn: number; endColumn: number };
  content: string;
  documentVersion: number;
}

/**
 * Input for creating a symbol context item.
 */
export interface SymbolInput {
  uri: string;
  workspaceId: string;
  relativePath: string;
  symbolName: string;
  symbolKind: string;
  range: { startLine: number; endLine: number };
  content?: string;
  documentVersion: number;
}

/**
 * Input for creating a diagnostic context item.
 */
export interface DiagnosticInput {
  uri: string;
  workspaceId: string;
  relativePath: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code?: string;
  range: { startLine: number; endLine: number; startColumn?: number; endColumn?: number };
  documentVersion: number;
}

/**
 * Input for creating a file context item.
 */
export interface FileInput {
  uri: string;
  workspaceId: string;
  relativePath: string;
  documentVersion?: number;
}

/**
 * Input for creating a hunk context item.
 */
export interface HunkInput {
  uri: string;
  workspaceId: string;
  relativePath: string;
  range: { startLine: number; endLine: number };
  operation: 'add' | 'modify' | 'delete';
  addedLines: number;
  removedLines: number;
  content?: string;
  documentVersion?: number;
}

/** Maximum content snippet size (characters). */
const MAX_CONTENT_LENGTH = 4096;

/**
 * EditorToChatBridge converts editor state into structured Context_Items
 * and registers them with the cross-surface link registry.
 */
export class EditorToChatBridge {
  private nextItemId = 1;

  constructor(
    private readonly linkRegistry: CrossSurfaceLinkRegistry,
    private readonly chatSessionResolver: () => string,
  ) {}

  /**
   * Send an active text selection to chat as a Context_Item.
   */
  sendSelection(input: SelectionInput): ContextItem {
    const item: ContextItem = {
      id: `ctx-${this.nextItemId++}`,
      kind: 'selection',
      uri: input.uri,
      workspaceId: input.workspaceId,
      relativePath: input.relativePath,
      range: input.range,
      content: this.truncateContent(input.content),
      documentVersion: input.documentVersion,
      createdAt: Date.now(),
    };

    this.registerLink(item);
    return item;
  }

  /**
   * Send a symbol reference to chat as a Context_Item.
   */
  sendSymbol(input: SymbolInput): ContextItem {
    const item: ContextItem = {
      id: `ctx-${this.nextItemId++}`,
      kind: 'symbol',
      uri: input.uri,
      workspaceId: input.workspaceId,
      relativePath: input.relativePath,
      range: input.range,
      symbolName: input.symbolName,
      symbolKind: input.symbolKind,
      documentVersion: input.documentVersion,
      createdAt: Date.now(),
    };
    if (input.content) {
      item.content = this.truncateContent(input.content);
    }

    this.registerLink(item);
    return item;
  }

  /**
   * Send a diagnostic to chat as a Context_Item.
   */
  sendDiagnostic(input: DiagnosticInput): ContextItem {
    const diagInfo: { severity: 'error' | 'warning' | 'info' | 'hint'; message: string; code?: string } = {
      severity: input.severity,
      message: input.message,
    };
    if (input.code) {
      diagInfo.code = input.code;
    }

    const item: ContextItem = {
      id: `ctx-${this.nextItemId++}`,
      kind: 'diagnostic',
      uri: input.uri,
      workspaceId: input.workspaceId,
      relativePath: input.relativePath,
      range: input.range,
      diagnosticInfo: diagInfo,
      documentVersion: input.documentVersion,
      createdAt: Date.now(),
    };

    this.registerLink(item);
    return item;
  }

  /**
   * Send a file reference to chat as a Context_Item.
   */
  sendFile(input: FileInput): ContextItem {
    const item: ContextItem = {
      id: `ctx-${this.nextItemId++}`,
      kind: 'file',
      uri: input.uri,
      workspaceId: input.workspaceId,
      relativePath: input.relativePath,
      createdAt: Date.now(),
    };
    if (input.documentVersion !== undefined) {
      item.documentVersion = input.documentVersion;
    }

    this.registerLink(item);
    return item;
  }

  /**
   * Send a diff hunk to chat as a Context_Item.
   */
  sendHunk(input: HunkInput): ContextItem {
    const item: ContextItem = {
      id: `ctx-${this.nextItemId++}`,
      kind: 'hunk',
      uri: input.uri,
      workspaceId: input.workspaceId,
      relativePath: input.relativePath,
      range: input.range,
      hunkInfo: { operation: input.operation, addedLines: input.addedLines, removedLines: input.removedLines },
      createdAt: Date.now(),
    };
    if (input.content) {
      item.content = this.truncateContent(input.content);
    }
    if (input.documentVersion !== undefined) {
      item.documentVersion = input.documentVersion;
    }

    this.registerLink(item);
    return item;
  }

  private registerLink(item: ContextItem): CrossSurfaceLink {
    const source: LinkEndpoint = {
      surface: 'editor',
      uri: item.uri,
      stableId: item.id,
      label: item.symbolName ?? item.relativePath,
    };
    if (item.range) {
      source.position = { lineNumber: item.range.startLine, column: item.range.startColumn ?? 1 };
    }

    const chatSessionId = this.chatSessionResolver();
    const target: LinkEndpoint = {
      surface: 'chat',
      uri: chatSessionId,
      stableId: `${chatSessionId}/${item.id}`,
    };

    return this.linkRegistry.createLink(source, target, 'context-item', {
      contextItemKind: item.kind,
      relativePath: item.relativePath,
    });
  }

  private truncateContent(content: string): string {
    if (content.length <= MAX_CONTENT_LENGTH) return content;
    return content.slice(0, MAX_CONTENT_LENGTH) + '\n… [truncated]';
  }
}
