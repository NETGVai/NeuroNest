/**
 * ChatEntityOpener — Opens cited implementation and planning entities from chat.
 *
 * When chat cites files, symbols, diagnostics, diff Hunks, Tasks, requirements,
 * Design_Nodes, Agent_Runs, or Evidence, this service resolves the citation target
 * and opens it in the appropriate surface without losing the user's current chat position.
 *
 * Requirements: 19.2
 */

import type { BidirectionalNavigator, ResolvedNavigationTarget } from './bidirectional-navigator';
import type { CrossSurfaceLinkRegistry, LinkEndpoint, Surface } from './cross-surface-link-registry';
import type { DeepLinkService } from './deep-link-service';

/**
 * Types of entities that can be cited in chat and opened.
 */
export type CitedEntityKind =
  | 'file'
  | 'symbol'
  | 'diagnostic'
  | 'diff-hunk'
  | 'task'
  | 'requirement'
  | 'design-node'
  | 'agent-run'
  | 'evidence';

/**
 * A citation from a chat message that can be opened.
 */
export interface ChatCitation {
  /** Unique citation ID */
  id: string;
  /** Chat session and message context */
  sessionId: string;
  messageId: string;
  /** What kind of entity is cited */
  entityKind: CitedEntityKind;
  /** Stable ID of the cited entity */
  entityId: string;
  /** URI or path to the cited entity */
  uri: string;
  /** Position within the entity (for file-based citations) */
  position?: { lineNumber: number; column: number };
  /** Human-readable label */
  label?: string;
}

/**
 * Result of attempting to open a cited entity.
 */
export interface OpenCitationResult {
  success: boolean;
  citation: ChatCitation;
  openedSurface?: Surface;
  reason?: string;
}

/**
 * Scroll state to preserve when navigating from chat.
 */
export interface ChatScrollState {
  sessionId: string;
  scrollTop: number;
  focusedMessageId?: string;
}

/** Callback to save/restore chat scroll state */
export type ChatScrollPreserver = {
  save(): ChatScrollState;
  restore(state: ChatScrollState): void;
};

/**
 * ChatEntityOpener resolves citations from chat messages and opens the
 * corresponding entities in the editor or planning view while preserving
 * the user's current chat scroll and focus state.
 */
export class ChatEntityOpener {
  constructor(
    private readonly navigator: BidirectionalNavigator,
    private readonly linkRegistry: CrossSurfaceLinkRegistry,
    _deepLinkService: DeepLinkService,
    private readonly scrollPreserver: ChatScrollPreserver,
  ) {
    // deepLinkService is accepted for future URI resolution extensions
    void _deepLinkService;
  }

  /**
   * Open a cited entity from a chat message.
   * Preserves chat scroll/focus state before navigating away.
   */
  openCitation(citation: ChatCitation): OpenCitationResult {
    // Save chat scroll state before navigation
    const savedState = this.scrollPreserver.save();

    const targetSurface = this.resolveSurface(citation.entityKind);
    const target = this.resolveTarget(citation, targetSurface);

    if (!target) {
      // Restore scroll state if navigation fails
      this.scrollPreserver.restore(savedState);
      return {
        success: false,
        citation,
        reason: `Unable to resolve target for citation: ${citation.entityId}`,
      };
    }

    const result = this.navigator.navigateTo(target);

    if (!result.success) {
      // Restore scroll state if navigation fails
      this.scrollPreserver.restore(savedState);
      return {
        success: false,
        citation,
        reason: result.reason ?? 'Navigation failed',
      };
    }

    // Register the citation link if not already present
    this.ensureCitationLink(citation, targetSurface);

    return {
      success: true,
      citation,
      openedSurface: targetSurface,
    };
  }

  /**
   * Open multiple cited entities (e.g., all citations in a message).
   * Returns results for each citation attempt.
   */
  openMultipleCitations(citations: ChatCitation[]): OpenCitationResult[] {
    return citations.map((citation) => this.openCitation(citation));
  }

  /**
   * Check whether a citation target is resolvable without opening it.
   */
  canOpen(citation: ChatCitation): boolean {
    const targetSurface = this.resolveSurface(citation.entityKind);
    const target = this.resolveTarget(citation, targetSurface);
    return target !== null;
  }

  /**
   * Determine which surface should handle this entity kind.
   */
  private resolveSurface(entityKind: CitedEntityKind): Surface {
    switch (entityKind) {
      case 'file':
      case 'symbol':
      case 'diagnostic':
      case 'diff-hunk':
        return 'editor';
      case 'task':
      case 'requirement':
      case 'design-node':
      case 'agent-run':
      case 'evidence':
        return 'planning';
    }
  }

  /**
   * Resolve a citation into a navigation target.
   */
  private resolveTarget(citation: ChatCitation, targetSurface: Surface): ResolvedNavigationTarget | null {
    // First, try to resolve via existing cross-surface links
    const existingLinks = this.linkRegistry.queryLinks({
      stableId: citation.entityId,
      surface: targetSurface,
    });

    if (existingLinks.length > 0) {
      const link = existingLinks[0];
      if (!link) return this.buildFallbackTarget(citation, targetSurface);
      const endpoint = link.source.stableId === citation.entityId ? link.target : link.source;
      if (endpoint.surface === targetSurface) {
        const target: ResolvedNavigationTarget = {
          surface: endpoint.surface,
          uri: endpoint.uri,
          stableId: endpoint.stableId,
          relationship: link.relationship,
          linkId: link.id,
        };
        const resolvedPosition = citation.position ?? endpoint.position;
        if (resolvedPosition) target.position = resolvedPosition;
        const resolvedLabel = citation.label ?? endpoint.label;
        if (resolvedLabel) target.label = resolvedLabel;
        return target;
      }
    }

    // Fall back to constructing a target from citation data
    return this.buildFallbackTarget(citation, targetSurface);
  }

  private buildFallbackTarget(citation: ChatCitation, targetSurface: Surface): ResolvedNavigationTarget {
    const target: ResolvedNavigationTarget = {
      surface: targetSurface,
      uri: citation.uri,
      stableId: citation.entityId,
      relationship: this.entityKindToRelationship(citation.entityKind),
      linkId: '',
    };
    if (citation.position) target.position = citation.position;
    if (citation.label) target.label = citation.label;
    return target;
  }

  /**
   * Ensure a cross-surface link exists from the chat citation to the target entity.
   */
  private ensureCitationLink(citation: ChatCitation, targetSurface: Surface): void {
    // Check if link already exists
    const existingLinks = this.linkRegistry.queryLinks({
      stableId: citation.entityId,
    });

    const alreadyLinked = existingLinks.some(
      (link) =>
        (link.source.stableId === `${citation.sessionId}/${citation.messageId}` &&
          link.target.stableId === citation.entityId) ||
        (link.target.stableId === `${citation.sessionId}/${citation.messageId}` &&
          link.source.stableId === citation.entityId),
    );

    if (alreadyLinked) return;

    const chatEndpoint: LinkEndpoint = {
      surface: 'chat',
      uri: `${citation.sessionId}/${citation.messageId}`,
      stableId: `${citation.sessionId}/${citation.messageId}`,
    };
    if (citation.label) chatEndpoint.label = citation.label;

    const targetEndpoint: LinkEndpoint = {
      surface: targetSurface,
      uri: citation.uri,
      stableId: citation.entityId,
    };
    if (citation.position) targetEndpoint.position = citation.position;
    if (citation.label) targetEndpoint.label = citation.label;

    this.linkRegistry.createLink(
      chatEndpoint,
      targetEndpoint,
      this.entityKindToRelationship(citation.entityKind),
      { citationKind: citation.entityKind },
    );
  }

  private entityKindToRelationship(entityKind: CitedEntityKind) {
    switch (entityKind) {
      case 'file':
      case 'symbol':
        return 'citation' as const;
      case 'diagnostic':
        return 'diagnostic' as const;
      case 'diff-hunk':
        return 'diff-hunk' as const;
      case 'task':
      case 'requirement':
      case 'design-node':
        return 'implementation' as const;
      case 'agent-run':
      case 'evidence':
        return 'evidence' as const;
    }
  }
}
