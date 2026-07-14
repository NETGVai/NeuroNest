/**
 * Renderer-side IPC client for @-mention communication with the main process.
 *
 * Provides typed wrappers around the mention IPC channels:
 * - `context:resolve-mention` — Resolve a mention to its content
 * - `context:list-mentionables` — Get available mention suggestions
 *
 * Requirements: 14.2, 14.3, 14.5, 14.7
 */

import { ipcInvoke } from '../services/ipc-client';

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

/** A suggestion returned from the main process */
export interface MentionSuggestionItem {
  /** Display label shown in the dropdown */
  label: string;
  /** The text to insert when this suggestion is accepted */
  insertText: string;
  /** The mention type */
  type: MentionType;
  /** Category for grouping */
  category: 'mention-type' | 'file' | 'folder' | 'url';
  /** Relevance score (higher = better) */
  score: number;
  /** Optional description */
  description?: string;
  /** Whether this item is currently open in an editor */
  isOpenEditor?: boolean;
}

/** Payload for resolving a mention */
export interface ResolveMentionPayload {
  /** The mention type */
  type: MentionType;
  /** The value (path, url, or empty for keyword mentions) */
  value: string;
}

/** Resolved mention content from the main process */
export interface ResolvedMentionContent {
  /** Whether resolution succeeded */
  resolved: boolean;
  /** The resolved content (empty if blocked/failed) */
  content: string;
  /** Whether the content was truncated */
  truncated: boolean;
  /** Whether blocked by firewall */
  blocked: boolean;
  /** Estimated token count */
  tokenEstimate: number;
  /** Error message if failed */
  error?: string;
}

/** Payload for listing mentionables */
export interface ListMentionablesPayload {
  /** The query text after `@` */
  query: string;
}

// ─── IPC Client ─────────────────────────────────────────────────

/**
 * MentionIpcClient — Renderer-side IPC communication for @-mentions.
 *
 * Wraps the raw IPC channels with typed request/response interfaces.
 * Follows the existing AutocompleteIpcClient pattern.
 */
export class MentionIpcClient {
  /**
   * Resolve a mention to its content via the main process.
   *
   * @param payload - The mention type and value to resolve
   * @returns The resolved content from the main process
   */
  async resolveMention(payload: ResolveMentionPayload): Promise<ResolvedMentionContent> {
    try {
      return await ipcInvoke<ResolvedMentionContent, ResolveMentionPayload>(
        'context:resolve-mention',
        payload,
      );
    } catch (error) {
      return {
        resolved: false,
        content: '',
        truncated: false,
        blocked: false,
        tokenEstimate: 0,
        error: error instanceof Error ? error.message : 'Unknown IPC error',
      };
    }
  }

  /**
   * Get available mention suggestions for a given query.
   *
   * @param query - Text typed after `@` (e.g., "file:src/")
   * @returns Array of mention suggestions sorted by relevance
   */
  async listMentionables(query: string): Promise<MentionSuggestionItem[]> {
    try {
      return await ipcInvoke<MentionSuggestionItem[], ListMentionablesPayload>(
        'context:list-mentionables',
        { query },
      );
    } catch {
      return [];
    }
  }

  /**
   * Dispose the client (no persistent listeners to clean up).
   */
  dispose(): void {
    // No persistent state to clean up
  }
}

/** Singleton instance */
let instance: MentionIpcClient | null = null;

/**
 * Get the singleton MentionIpcClient instance.
 */
export function getMentionIpcClient(): MentionIpcClient {
  if (!instance) {
    instance = new MentionIpcClient();
  }
  return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetMentionIpcClient(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
