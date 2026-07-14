/**
 * Monaco InlineCompletionsProvider integration for NeuroNest autocomplete.
 *
 * Registers as a Monaco InlineCompletionsProvider to deliver ghost-text
 * suggestions. Coordinates the IPC client, ghost-text decorator, and status
 * bar indicator into a unified autocomplete experience.
 *
 * Flow:
 * 1. Monaco calls `provideInlineCompletions` on cursor activity
 * 2. Provider sends request to main process via IPC (debounced server-side)
 * 3. Main process returns completion → Provider renders ghost-text
 * 4. Tab accepts, Escape dismisses
 *
 * Requirements: 1.2, 1.3, 1.7
 */

import {
  AutocompleteIpcClient,
  getAutocompleteIpcClient,
  type CompletionRequestPayload,
  type AutocompleteStatus,
} from './autocomplete-ipc-client';
import { GhostTextDecorator, GHOST_TEXT_STYLES, type MonacoEditor, type MonacoKeyCodes } from './ghost-text-decorator';
import { StatusBarIndicator, STATUS_BAR_STYLES } from './status-bar-indicator';

// ─── Types ──────────────────────────────────────────────────────

/** Monaco-compatible inline completion item */
export interface InlineCompletionItem {
  /** The text to insert */
  insertText: string;
  /** Range to replace (if applicable) */
  range?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

/** Monaco-compatible inline completions result */
export interface InlineCompletions {
  items: InlineCompletionItem[];
}

/** Context passed by Monaco to the inline completions provider */
export interface InlineCompletionContext {
  /** Trigger kind: 0 = Automatic, 1 = Explicit */
  triggerKind: number;
  /** The character that triggered the completion (if explicit) */
  selectedSuggestionInfo?: unknown;
}

/** Monaco-compatible cancellation token */
export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose: () => void };
}

/** Configuration for the inline completions provider */
export interface InlineCompletionsProviderConfig {
  /** Minimum typing pause before requesting (handled server-side, but used for client-side dedup) */
  debounceMs: number;
  /** Languages to provide completions for (empty = all) */
  languages: string[];
}

// ─── InlineCompletionsProvider ──────────────────────────────────

/**
 * InlineCompletionsProvider — Monaco provider registration and coordination.
 *
 * Acts as the central coordinator between:
 * - Monaco editor (source of cursor events and decoration target)
 * - AutocompleteIpcClient (communication with main process)
 * - GhostTextDecorator (visual ghost-text rendering)
 * - StatusBarIndicator (status display in status bar)
 *
 * Implements a simplified InlineCompletionsProvider interface that can be
 * registered with Monaco's `registerInlineCompletionsProvider`.
 */
export class InlineCompletionsProvider {
  private ipcClient: AutocompleteIpcClient;
  private ghostText: GhostTextDecorator;
  private statusBar: StatusBarIndicator;
  private editor: MonacoEditor | null = null;
  private config: InlineCompletionsProviderConfig;
  private currentRequest: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  private stylesInjected = false;

  constructor(config?: Partial<InlineCompletionsProviderConfig>) {
    this.config = {
      debounceMs: 300,
      languages: [],
      ...config,
    };
    this.ipcClient = getAutocompleteIpcClient();
    this.ghostText = new GhostTextDecorator();
    this.statusBar = new StatusBarIndicator();
  }

  /**
   * Initialize the provider with a Monaco editor instance.
   *
   * Sets up key bindings, decorations, status bar, and IPC listeners.
   *
   * @param editor - The Monaco editor instance
   * @param keyCodes - Monaco KeyCode constants
   * @param statusBarContainer - DOM element to mount the status bar indicator
   */
  initialize(editor: MonacoEditor, keyCodes: MonacoKeyCodes, statusBarContainer: HTMLElement): void {
    this.editor = editor;

    // Inject CSS styles if not already done
    this.injectStyles();

    // Attach ghost-text decorator to the editor
    this.ghostText.attach(editor, keyCodes);

    // Set up accept/dismiss callbacks
    this.ghostText.onAccept((text) => {
      this.ipcClient.requestCompletion({
        content: '',
        lineNumber: 0,
        column: 0,
        filePath: '',
        language: '',
        currentLineText: '',
        cursorOffset: 0,
      }).catch(() => {}); // Fire acceptance telemetry (best effort)
    });

    this.ghostText.onDismiss(() => {
      this.ipcClient.cancelRequest().catch(() => {});
    });

    // Mount status bar indicator
    this.statusBar.mount(statusBarContainer);
    this.statusBar.onClick(() => {
      this.ipcClient.toggleEnabled().then((enabled) => {
        this.statusBar.setStatus(enabled ? 'enabled' : 'disabled');
      }).catch(() => {});
    });

    // Subscribe to status changes from main process
    this.statusUnsubscribe = this.ipcClient.onStatusChange((status) => {
      this.statusBar.setStatus(status);
    });
  }

  /**
   * Provide inline completions for the current cursor position.
   *
   * This method is called by Monaco when it wants inline completions.
   * It debounces requests and communicates with the main process via IPC.
   *
   * @param model - The current text model
   * @param position - The cursor position
   * @param context - Completion context (trigger kind, etc.)
   * @param token - Cancellation token
   * @returns Inline completions result or null
   */
  async provideInlineCompletions(
    model: { getValue: () => string; getLineContent: (line: number) => string; uri?: { path?: string } },
    position: { lineNumber: number; column: number },
    context: InlineCompletionContext,
    token: CancellationToken,
  ): Promise<InlineCompletions | null> {
    // Cancel any previous pending request
    if (this.currentRequest) {
      this.currentRequest.abort();
    }
    this.currentRequest = new AbortController();

    // Check for cancellation
    if (token.isCancellationRequested) {
      return null;
    }

    // Clear existing ghost-text when starting a new request
    this.ghostText.dismiss();

    // Build request payload
    const currentLineText = model.getLineContent(position.lineNumber);
    const payload: CompletionRequestPayload = {
      content: model.getValue(),
      lineNumber: position.lineNumber,
      column: position.column,
      filePath: model.uri?.path ?? '',
      language: this.detectLanguage(model.uri?.path ?? ''),
      currentLineText,
      cursorOffset: position.column - 1,
    };

    // Set up cancellation listener
    const cancelDisposable = token.onCancellationRequested(() => {
      this.currentRequest?.abort();
      this.ipcClient.cancelRequest().catch(() => {});
    });

    try {
      // Request completion from main process
      const response = await this.ipcClient.requestCompletion(payload);

      // Clean up cancellation listener
      cancelDisposable.dispose();

      // Check if request was cancelled during await
      if (token.isCancellationRequested || this.currentRequest?.signal.aborted) {
        return null;
      }

      if (response.success && response.text) {
        // Show ghost-text decoration
        this.ghostText.show(response.text, position);

        return {
          items: [{
            insertText: response.text,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
          }],
        };
      }

      return null;
    } catch {
      cancelDisposable.dispose();
      return null;
    }
  }

  /**
   * Called by Monaco when inline completions are no longer needed.
   * Clean up any pending requests.
   */
  freeInlineCompletions(): void {
    // No-op: ghost-text handles its own lifecycle
  }

  /**
   * Dismiss the current ghost-text suggestion.
   */
  dismissSuggestion(): void {
    this.ghostText.dismiss();
  }

  /**
   * Accept the current ghost-text suggestion.
   */
  acceptSuggestion(): void {
    this.ghostText.accept();
  }

  /**
   * Get the current status displayed in the status bar.
   */
  getStatus(): AutocompleteStatus {
    return this.statusBar.getStatus();
  }

  /**
   * Check if a ghost-text suggestion is currently visible.
   */
  isSuggestionVisible(): boolean {
    return this.ghostText.isVisible();
  }

  /**
   * Get the ghost-text decorator instance (for testing).
   */
  getGhostTextDecorator(): GhostTextDecorator {
    return this.ghostText;
  }

  /**
   * Get the status bar indicator instance (for testing).
   */
  getStatusBarIndicator(): StatusBarIndicator {
    return this.statusBar;
  }

  /**
   * Dispose the provider and clean up all resources.
   */
  dispose(): void {
    // Cancel pending requests
    if (this.currentRequest) {
      this.currentRequest.abort();
      this.currentRequest = null;
    }

    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Unsubscribe from status updates
    if (this.statusUnsubscribe) {
      this.statusUnsubscribe();
      this.statusUnsubscribe = null;
    }

    // Detach ghost-text
    this.ghostText.detach();

    // Unmount status bar
    this.statusBar.unmount();

    this.editor = null;
  }

  // ─── Internal ─────────────────────────────────────────────────

  /**
   * Detect language from file path extension.
   */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      rb: 'ruby',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      sql: 'sql',
    };
    return languageMap[ext] ?? ext;
  }

  /**
   * Inject CSS styles for ghost-text and status bar into the document.
   */
  private injectStyles(): void {
    if (this.stylesInjected) return;

    const style = document.createElement('style');
    style.id = 'nn-autocomplete-styles';
    style.textContent = GHOST_TEXT_STYLES + STATUS_BAR_STYLES;
    document.head.appendChild(style);
    this.stylesInjected = true;
  }
}

/**
 * Create and return a new InlineCompletionsProvider instance.
 * Use this factory function for consistent initialization.
 */
export function createInlineCompletionsProvider(
  config?: Partial<InlineCompletionsProviderConfig>,
): InlineCompletionsProvider {
  return new InlineCompletionsProvider(config);
}
