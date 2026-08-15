/**
 * BidirectionalNavigator — One-step navigation between any linked surface entities.
 *
 * Given any entity on any surface, finds all linked entities on other surfaces
 * and enables one-step navigation to them. Integrates with the existing
 * NavigationService for Back/Forward history.
 *
 * Handles:
 * - Chat citations → editor
 * - Planning artifacts → editor
 * - Diagnostics → editor
 * - Diff hunks → editor
 * - Editor → chat (as context items)
 * - Editor → planning (linked tasks/requirements)
 * - All reverse directions
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5
 */

import type { NavigationService } from '../renderer/editor/navigation-service';
import type { CrossSurfaceLinkRegistry, CrossSurfaceLink, Surface, LinkRelationship } from './cross-surface-link-registry';
import type { DeepLinkService, DeepLinkTarget } from './deep-link-service';

/**
 * Navigation target resolved from a linked entity.
 */
export interface ResolvedNavigationTarget {
  surface: Surface;
  uri: string;
  stableId: string;
  position?: { lineNumber: number; column: number };
  label?: string;
  relationship: LinkRelationship;
  linkId: string;
}

/**
 * Result of a navigation attempt through the bidirectional navigator.
 */
export interface BidirectionalNavigationResult {
  success: boolean;
  target?: ResolvedNavigationTarget;
  reason?: string;
}

/**
 * A handler that can navigate to a specific surface target.
 */
export type SurfaceNavigationHandler = (
  target: ResolvedNavigationTarget,
) => boolean;

/**
 * BidirectionalNavigator enables one-step navigation between
 * linked entities across editor, chat, and planning surfaces.
 */
export class BidirectionalNavigator {
  private readonly surfaceHandlers = new Map<Surface, SurfaceNavigationHandler>();

  constructor(
    private readonly linkRegistry: CrossSurfaceLinkRegistry,
    private readonly deepLinkService: DeepLinkService,
    private readonly navigationService: NavigationService,
  ) {}

  /**
   * Register a handler for navigating to a specific surface.
   */
  registerSurfaceHandler(surface: Surface, handler: SurfaceNavigationHandler): void {
    this.surfaceHandlers.set(surface, handler);
  }

  /**
   * Find all linked entities for a given entity (by stable ID).
   * Returns entities on all other surfaces that link to or from this entity.
   */
  getLinkedEntities(stableId: string): ResolvedNavigationTarget[] {
    const forwardLinks = this.linkRegistry.getLinksFromSource(stableId);
    const reverseLinks = this.linkRegistry.getLinksToTarget(stableId);

    const targets: ResolvedNavigationTarget[] = [];

    for (const link of forwardLinks) {
      targets.push(this.linkToTarget(link, 'target'));
    }

    for (const link of reverseLinks) {
      targets.push(this.linkToTarget(link, 'source'));
    }

    return targets;
  }

  /**
   * Find all linked entities for a given URI on a surface.
   */
  getLinkedEntitiesByUri(uri: string, surface?: Surface): ResolvedNavigationTarget[] {
    const links = this.linkRegistry.getLinksByUri(uri);
    const targets: ResolvedNavigationTarget[] = [];

    for (const link of links) {
      if (link.source.uri === uri) {
        if (!surface || link.source.surface === surface) {
          targets.push(this.linkToTarget(link, 'target'));
        }
      }
      if (link.target.uri === uri) {
        if (!surface || link.target.surface === surface) {
          targets.push(this.linkToTarget(link, 'source'));
        }
      }
    }

    return targets;
  }

  /**
   * Navigate to a linked entity in one step.
   * Records the navigation in history for Back/Forward support.
   */
  navigateTo(target: ResolvedNavigationTarget): BidirectionalNavigationResult {
    const handler = this.surfaceHandlers.get(target.surface);
    if (!handler) {
      return {
        success: false,
        reason: `No navigation handler registered for surface: ${target.surface}`,
      };
    }

    const success = handler(target);
    if (!success) {
      return {
        success: false,
        target,
        reason: `Navigation handler failed for target: ${target.uri}`,
      };
    }

    // Record in navigation history for Back/Forward support
    this.navigationService.recordNavigation(
      target.uri,
      target.position ?? { lineNumber: 1, column: 1 },
      this.relationshipToSurfaceType(target.relationship),
      { groupId: undefined, symbolName: target.label },
    );

    return { success: true, target };
  }

  /**
   * Navigate to a specific link target by link ID.
   * Direction: 'forward' navigates to the link's target, 'reverse' navigates to the source.
   */
  navigateByLinkId(
    linkId: string,
    direction: 'forward' | 'reverse' = 'forward',
  ): BidirectionalNavigationResult {
    const link = this.linkRegistry.getLink(linkId);
    if (!link) {
      return { success: false, reason: `Link not found: ${linkId}` };
    }

    const target = this.linkToTarget(link, direction === 'forward' ? 'target' : 'source');
    return this.navigateTo(target);
  }

  /**
   * Navigate to an entity using a deep link URI.
   * Resolves the deep link and navigates to the resolved target.
   */
  navigateByDeepLink(deepLinkUri: string): BidirectionalNavigationResult {
    const target = this.deepLinkService.resolve(deepLinkUri);
    if (!target) {
      return { success: false, reason: `Failed to resolve deep link: ${deepLinkUri}` };
    }

    return this.navigateToDeepLinkTarget(target);
  }

  /**
   * Generate a deep link for a given entity and copy to clipboard-ready format.
   */
  generateDeepLink(
    surface: Surface,
    options: {
      path?: string;
      position?: { lineNumber: number; column: number };
      sessionId?: string;
      messageId?: string;
      entityId?: string;
      entityType?: string;
    },
  ): string {
    switch (surface) {
      case 'editor':
        return this.deepLinkService.generateEditorLink(options.path ?? '', options.position);
      case 'chat':
        return this.deepLinkService.generateChatLink(
          options.sessionId ?? '',
          options.messageId,
        );
      case 'planning':
        return this.deepLinkService.generatePlanningLink(
          options.entityId ?? '',
          options.entityType,
        );
    }
  }

  private navigateToDeepLinkTarget(target: DeepLinkTarget): BidirectionalNavigationResult {
    const resolvedTarget: ResolvedNavigationTarget = {
      surface: target.surface,
      uri: target.path,
      stableId: target.entityId ?? target.sessionId ?? target.path,
      position: target.position,
      label: target.entityType,
      relationship: 'reference',
      linkId: '',
    };

    return this.navigateTo(resolvedTarget);
  }

  private linkToTarget(link: CrossSurfaceLink, side: 'source' | 'target'): ResolvedNavigationTarget {
    const endpoint = side === 'target' ? link.target : link.source;
    return {
      surface: endpoint.surface,
      uri: endpoint.uri,
      stableId: endpoint.stableId,
      position: endpoint.position,
      label: endpoint.label,
      relationship: link.relationship,
      linkId: link.id,
    };
  }

  private relationshipToSurfaceType(
    relationship: LinkRelationship,
  ): 'citation' | 'diagnostic' | 'task' | 'diff-hunk' | 'planning-artifact' | 'file' | 'reference' {
    switch (relationship) {
      case 'citation':
        return 'citation';
      case 'diagnostic':
        return 'diagnostic';
      case 'task-file':
        return 'task';
      case 'diff-hunk':
        return 'diff-hunk';
      case 'implementation':
      case 'evidence':
      case 'artifact':
        return 'planning-artifact';
      case 'context-item':
      case 'reference':
      default:
        return 'file';
    }
  }
}
