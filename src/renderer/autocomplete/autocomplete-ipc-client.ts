/**
 * Renderer-side IPC client for autocomplete communication with the main process.
 *
 * Provides typed wrappers around the autocomplete IPC channels:
 * - `autocomplete:request` — Request a completion from the main process
 * - `autocomplete:cancel` — Cancel an in-flight completion request
 * - `autocomplete:config` — Get/set autocomplete configuration
 *
 * Requirements: 1.2, 1.3, 1.7
 */

import { ipcInvoke, ipcOn, type IpcUnsubscribe } from '../services/ipc-client';

// ─── Types ──────────────────────────────────────────────────────

/** Editor context sent with a completion request */
export interface CompletionRequestPayload {
  /** Full content of the active file */
  content: string;
  /** Cursor line number (1-indexed) */
  lineNumber: number;
  /** Cursor column (1-indexed) */
  column: number;
  /** File path of the active editor */
  filePath: string;
  /** Language identifier (e.g., 'typescript', 'python') */
  language: string;
  /** Current line text (for contextual skip analysis) */
  currentLineText: string;
  /** Character offset of cursor in the current line */
  cursorOffset: number;
}

/** Response from a completion request */
export interface CompletionResponse {
  /** Whether a completion was returned */
  success: boolean;
  /** The completion text (if successful) */
  text?: string;
  /** Provider that generated the completion */
  providerId?: string;
  /** Model used */
  model?: string;
  /** Latency in milliseconds */
  latencyMs?: number;
  /** Reason for skip/failure (if unsuccessful) */
  skipReason?: string;
  /** Additional detail about the skip */
  skipDetail?: string;
}

/** Autocomplete status pushed from main process */
export type AutocompleteStatus = 'enabled' | 'disabled' | 'loading' | 'backoff';

/** Autocomplete configuration */
export interface AutocompleteConfig {
  /** Whether autocomplete is enabled */
  enabled: boolean;
  /** Debounce delay in milliseconds */
  debounceMs: number;
  /** Provider ID */
  providerId: string;
  /** Model name */
  model?: string;
}

// ─── IPC Client ─────────────────────────────────────────────────

/**
 * AutocompleteIpcClient — Renderer-side IPC communication for autocomplete.
 *
 * Wraps the raw IPC channels with typed request/response interfaces.
 * Follows the existing ipc-client pattern from src/renderer/services/ipc-client.ts.
 */
export class AutocompleteIpcClient {
  private statusListeners: Set<(status: AutocompleteStatus) => void> = new Set();
  private statusUnsubscribe: IpcUnsubscribe | null = null;

  /**
   * Request a completion from the main process.
   *
   * @param payload - Editor state and context for the completion
   * @returns The completion response from the main process
   */
  async requestCompletion(payload: CompletionRequestPayload): Promise<CompletionResponse> {
    try {
      const result = await ipcInvoke<CompletionResponse, CompletionRequestPayload>(
        'autocomplete:request',
        payload,
      );
      return result;
    } catch (error) {
      return {
        success: false,
        skipReason: 'ipc_error',
        skipDetail: error instanceof Error ? error.message : 'Unknown IPC error',
      };
    }
  }

  /**
   * Cancel an in-flight completion request.
   * Fire-and-forget — no response expected.
   */
  async cancelRequest(): Promise<void> {
    try {
      await ipcInvoke<void>('autocomplete:cancel');
    } catch {
      // Silently ignore cancel failures
    }
  }

  /**
   * Get the current autocomplete configuration from the main process.
   */
  async getConfig(): Promise<AutocompleteConfig> {
    return ipcInvoke<AutocompleteConfig>('autocomplete:config', { action: 'get' });
  }

  /**
   * Update autocomplete configuration on the main process.
   *
   * @param config - Partial configuration to update
   */
  async setConfig(config: Partial<AutocompleteConfig>): Promise<void> {
    await ipcInvoke<void>('autocomplete:config', { action: 'set', config });
  }

  /**
   * Toggle autocomplete enabled/disabled state.
   *
   * @returns The new enabled state
   */
  async toggleEnabled(): Promise<boolean> {
    const result = await ipcInvoke<{ enabled: boolean }>('autocomplete:config', { action: 'toggle' });
    return result.enabled;
  }

  /**
   * Subscribe to autocomplete status changes pushed from the main process.
   *
   * @param callback - Called when status changes (enabled/disabled/loading/backoff)
   * @returns Unsubscribe function
   */
  onStatusChange(callback: (status: AutocompleteStatus) => void): () => void {
    this.statusListeners.add(callback);

    // Set up the IPC listener on first subscriber
    if (!this.statusUnsubscribe) {
      this.statusUnsubscribe = ipcOn<AutocompleteStatus>(
        'autocomplete:status',
        (status) => {
          for (const listener of this.statusListeners) {
            listener(status);
          }
        },
      );
    }

    return () => {
      this.statusListeners.delete(callback);
      // Clean up IPC listener when no subscribers remain
      if (this.statusListeners.size === 0 && this.statusUnsubscribe) {
        this.statusUnsubscribe();
        this.statusUnsubscribe = null;
      }
    };
  }

  /**
   * Dispose the client and clean up all listeners.
   */
  dispose(): void {
    this.statusListeners.clear();
    if (this.statusUnsubscribe) {
      this.statusUnsubscribe();
      this.statusUnsubscribe = null;
    }
  }
}

/** Singleton instance */
let instance: AutocompleteIpcClient | null = null;

/**
 * Get the singleton AutocompleteIpcClient instance.
 */
export function getAutocompleteIpcClient(): AutocompleteIpcClient {
  if (!instance) {
    instance = new AutocompleteIpcClient();
  }
  return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetAutocompleteIpcClient(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
