/**
 * DeepLinkService — Generates and parses pasteable deep-link URIs for any surface entity.
 *
 * Deep links use the `neuronest://` scheme and can navigate to:
 * - Editor locations: `neuronest://editor/path/to/file.ts:10:5`
 * - Chat messages: `neuronest://chat/session-123/msg-456`
 * - Planning entities: `neuronest://plan/task-789`
 *
 * Deep links use workspace-relative paths (no absolute local paths by default).
 * Links resolve to current location even after renames, via stable IDs.
 *
 * Requirements: 19.7, 19.6
 */

import type { Surface } from './cross-surface-link-registry';

/**
 * A parsed deep link target.
 */
export interface DeepLinkTarget {
  surface: Surface;
  path: string;
  position?: { lineNumber: number; column: number };
  sessionId?: string;
  messageId?: string;
  entityId?: string;
  entityType?: string;
}

/**
 * Deep link history entry.
 */
export interface DeepLinkHistoryEntry {
  uri: string;
  target: DeepLinkTarget;
  timestamp: number;
  resolved: boolean;
}

/**
 * A URI alias map for handling renames.
 */
export type UriAliasResolver = (uri: string) => string | null;

/**
 * Options for deep link generation.
 */
export interface DeepLinkOptions {
  /** Include position in the link */
  includePosition?: boolean;
  /** Custom label for display */
  label?: string;
}

const DEEP_LINK_SCHEME = 'neuronest://';

/**
 * Service for generating, parsing, and resolving deep-link URIs.
 */
export class DeepLinkService {
  private readonly history: DeepLinkHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private aliasResolver: UriAliasResolver | null = null;

  constructor(options?: { maxHistorySize?: number }) {
    this.maxHistorySize = options?.maxHistorySize ?? 50;
  }

  /**
   * Register an alias resolver for handling renames.
   * Called when resolving a deep link that references a moved/renamed entity.
   */
  setAliasResolver(resolver: UriAliasResolver): void {
    this.aliasResolver = resolver;
  }

  /**
   * Generate a deep link URI for an editor location.
   * Uses workspace-relative paths, never absolute local paths.
   */
  generateEditorLink(
    relativePath: string,
    position?: { lineNumber: number; column: number },
  ): string {
    let uri = `${DEEP_LINK_SCHEME}editor/${relativePath}`;
    if (position) {
      uri += `:${position.lineNumber}:${position.column}`;
    }
    return uri;
  }

  /**
   * Generate a deep link URI for a chat message.
   */
  generateChatLink(sessionId: string, messageId?: string): string {
    let uri = `${DEEP_LINK_SCHEME}chat/${sessionId}`;
    if (messageId) {
      uri += `/${messageId}`;
    }
    return uri;
  }

  /**
   * Generate a deep link URI for a planning entity (task, requirement, design node).
   */
  generatePlanningLink(entityId: string, entityType?: string): string {
    let uri = `${DEEP_LINK_SCHEME}plan/${entityId}`;
    if (entityType) {
      uri += `?type=${entityType}`;
    }
    return uri;
  }

  /**
   * Parse a deep link URI into a navigation target.
   * Returns null if the URI is not a valid deep link.
   */
  parse(uri: string): DeepLinkTarget | null {
    if (!uri.startsWith(DEEP_LINK_SCHEME)) {
      return null;
    }

    const body = uri.slice(DEEP_LINK_SCHEME.length);
    const surfaceEnd = body.indexOf('/');
    if (surfaceEnd === -1) return null;

    const surfaceStr = body.slice(0, surfaceEnd);
    const rest = body.slice(surfaceEnd + 1);

    switch (surfaceStr) {
      case 'editor':
        return this.parseEditorLink(rest);
      case 'chat':
        return this.parseChatLink(rest);
      case 'plan':
        return this.parsePlanningLink(rest);
      default:
        return null;
    }
  }

  /**
   * Resolve a deep link to a current target, handling renames via alias resolver.
   * Records the resolution in deep link history.
   */
  resolve(uri: string): DeepLinkTarget | null {
    const target = this.parse(uri);
    if (!target) {
      this.recordHistory(uri, null, false);
      return null;
    }

    // Try alias resolution for editor paths that may have been renamed
    if (target.surface === 'editor' && this.aliasResolver) {
      const resolved = this.aliasResolver(target.path);
      if (resolved) {
        target.path = resolved;
      }
    }

    this.recordHistory(uri, target, true);
    return target;
  }

  /**
   * Get deep link history entries.
   */
  getHistory(): ReadonlyArray<DeepLinkHistoryEntry> {
    return this.history;
  }

  /**
   * Clear deep link history.
   */
  clearHistory(): void {
    this.history.length = 0;
  }

  private parseEditorLink(rest: string): DeepLinkTarget {
    // Format: path/to/file.ts:lineNumber:column or path/to/file.ts
    const positionMatch = rest.match(/^(.+?):(\d+):(\d+)$/);
    if (positionMatch) {
      return {
        surface: 'editor',
        path: positionMatch[1],
        position: {
          lineNumber: parseInt(positionMatch[2], 10),
          column: parseInt(positionMatch[3], 10),
        },
      };
    }

    // Path without position - check for trailing line number only (file:line)
    const lineOnlyMatch = rest.match(/^(.+?):(\d+)$/);
    if (lineOnlyMatch) {
      return {
        surface: 'editor',
        path: lineOnlyMatch[1],
        position: {
          lineNumber: parseInt(lineOnlyMatch[2], 10),
          column: 1,
        },
      };
    }

    return {
      surface: 'editor',
      path: rest,
    };
  }

  private parseChatLink(rest: string): DeepLinkTarget {
    // Format: session-id/message-id or session-id
    const parts = rest.split('/');
    const target: DeepLinkTarget = {
      surface: 'chat',
      path: rest,
      sessionId: parts[0],
    };
    if (parts.length > 1) {
      target.messageId = parts[1];
    }
    return target;
  }

  private parsePlanningLink(rest: string): DeepLinkTarget {
    // Format: entity-id or entity-id?type=task
    const [entityPart, queryPart] = rest.split('?');
    const target: DeepLinkTarget = {
      surface: 'planning',
      path: rest,
      entityId: entityPart,
    };

    if (queryPart) {
      const params = new URLSearchParams(queryPart);
      const typeParam = params.get('type');
      if (typeParam) {
        target.entityType = typeParam;
      }
    }

    return target;
  }

  private recordHistory(uri: string, target: DeepLinkTarget | null, resolved: boolean): void {
    const entry: DeepLinkHistoryEntry = {
      uri,
      target: target ?? { surface: 'editor', path: '' },
      timestamp: Date.now(),
      resolved,
    };

    this.history.push(entry);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }
}
