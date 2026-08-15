/**
 * CrossSurfaceLinkRegistry — Stores typed bidirectional links between surfaces.
 *
 * Links connect entities across editor, chat, and planning surfaces.
 * Each link has a source surface, source URI/ID, target surface, target URI/ID,
 * and a typed relationship. Links survive renames through stable IDs and URI updates
 * triggered by rename events.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5
 */

/**
 * Surface types that can participate in cross-surface links.
 */
export type Surface = 'editor' | 'chat' | 'planning';

/**
 * Relationship types for cross-surface links.
 */
export type LinkRelationship =
  | 'citation'        // chat cites editor location
  | 'implementation'  // planning artifact links to editor code
  | 'diagnostic'      // diagnostic links to editor location
  | 'diff-hunk'       // diff hunk links to editor location
  | 'context-item'    // editor selection sent to chat
  | 'task-file'       // planning task references a file
  | 'evidence'        // evidence links to code location
  | 'artifact'        // artifact links across surfaces
  | 'reference';      // general reference

/**
 * A cross-surface link endpoint.
 */
export interface LinkEndpoint {
  surface: Surface;
  uri: string;
  stableId: string;
  position?: { lineNumber: number; column: number };
  label?: string;
}

/**
 * A bidirectional link between two surface entities.
 */
export interface CrossSurfaceLink {
  id: string;
  source: LinkEndpoint;
  target: LinkEndpoint;
  relationship: LinkRelationship;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/**
 * Rename event describing a URI change.
 */
export interface RenameEvent {
  oldUri: string;
  newUri: string;
  surface: Surface;
}

/**
 * Options for querying links.
 */
export interface LinkQuery {
  surface?: Surface;
  uri?: string;
  stableId?: string;
  relationship?: LinkRelationship;
}

/**
 * Registry that stores and manages bidirectional links between surfaces.
 */
export class CrossSurfaceLinkRegistry {
  private readonly links = new Map<string, CrossSurfaceLink>();
  private readonly bySourceId = new Map<string, Set<string>>();
  private readonly byTargetId = new Map<string, Set<string>>();
  private readonly byUri = new Map<string, Set<string>>();
  private nextId = 1;

  /**
   * Create a bidirectional link between two surface entities.
   */
  createLink(
    source: LinkEndpoint,
    target: LinkEndpoint,
    relationship: LinkRelationship,
    metadata?: Record<string, unknown>,
  ): CrossSurfaceLink {
    const id = `link-${this.nextId++}`;
    const link: CrossSurfaceLink = {
      id,
      source,
      target,
      relationship,
      createdAt: Date.now(),
      metadata,
    };

    this.links.set(id, link);
    this.indexLink(link);
    return link;
  }

  /**
   * Remove a link by its ID.
   */
  removeLink(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link) return false;

    this.deindexLink(link);
    this.links.delete(linkId);
    return true;
  }

  /**
   * Get a link by ID.
   */
  getLink(linkId: string): CrossSurfaceLink | undefined {
    return this.links.get(linkId);
  }

  /**
   * Find all links where the given entity is the source (forward lookup).
   */
  getLinksFromSource(stableId: string): CrossSurfaceLink[] {
    const linkIds = this.bySourceId.get(stableId);
    if (!linkIds) return [];
    return [...linkIds].map(id => this.links.get(id)!).filter(Boolean);
  }

  /**
   * Find all links where the given entity is the target (reverse lookup).
   */
  getLinksToTarget(stableId: string): CrossSurfaceLink[] {
    const linkIds = this.byTargetId.get(stableId);
    if (!linkIds) return [];
    return [...linkIds].map(id => this.links.get(id)!).filter(Boolean);
  }

  /**
   * Find all links involving a given URI (both directions).
   */
  getLinksByUri(uri: string): CrossSurfaceLink[] {
    const linkIds = this.byUri.get(uri);
    if (!linkIds) return [];
    return [...linkIds].map(id => this.links.get(id)!).filter(Boolean);
  }

  /**
   * Query links matching the given criteria.
   */
  queryLinks(query: LinkQuery): CrossSurfaceLink[] {
    let results = [...this.links.values()];

    if (query.surface) {
      results = results.filter(
        link => link.source.surface === query.surface || link.target.surface === query.surface,
      );
    }

    if (query.uri) {
      results = results.filter(
        link => link.source.uri === query.uri || link.target.uri === query.uri,
      );
    }

    if (query.stableId) {
      results = results.filter(
        link => link.source.stableId === query.stableId || link.target.stableId === query.stableId,
      );
    }

    if (query.relationship) {
      results = results.filter(link => link.relationship === query.relationship);
    }

    return results;
  }

  /**
   * Handle a rename event — updates all link URIs that reference the old URI.
   * Stable IDs remain unchanged, only the URI is updated.
   */
  handleRename(event: RenameEvent): number {
    const { oldUri, newUri, surface } = event;
    const affectedLinkIds = this.byUri.get(oldUri);
    if (!affectedLinkIds || affectedLinkIds.size === 0) return 0;

    let updatedCount = 0;
    for (const linkId of [...affectedLinkIds]) {
      const link = this.links.get(linkId);
      if (!link) continue;

      // Remove old index entries
      this.deindexLink(link);

      let updated = false;
      if (link.source.uri === oldUri && link.source.surface === surface) {
        link.source = { ...link.source, uri: newUri };
        updated = true;
      }
      if (link.target.uri === oldUri && link.target.surface === surface) {
        link.target = { ...link.target, uri: newUri };
        updated = true;
      }

      // Re-index with new URIs
      this.indexLink(link);

      if (updated) updatedCount++;
    }

    return updatedCount;
  }

  /**
   * Get all links in the registry.
   */
  getAllLinks(): CrossSurfaceLink[] {
    return [...this.links.values()];
  }

  /**
   * Get the total count of links.
   */
  get size(): number {
    return this.links.size;
  }

  /**
   * Clear all links.
   */
  clear(): void {
    this.links.clear();
    this.bySourceId.clear();
    this.byTargetId.clear();
    this.byUri.clear();
  }

  private indexLink(link: CrossSurfaceLink): void {
    // Index by source stable ID
    if (!this.bySourceId.has(link.source.stableId)) {
      this.bySourceId.set(link.source.stableId, new Set());
    }
    this.bySourceId.get(link.source.stableId)!.add(link.id);

    // Index by target stable ID
    if (!this.byTargetId.has(link.target.stableId)) {
      this.byTargetId.set(link.target.stableId, new Set());
    }
    this.byTargetId.get(link.target.stableId)!.add(link.id);

    // Index by source URI
    if (!this.byUri.has(link.source.uri)) {
      this.byUri.set(link.source.uri, new Set());
    }
    this.byUri.get(link.source.uri)!.add(link.id);

    // Index by target URI
    if (!this.byUri.has(link.target.uri)) {
      this.byUri.set(link.target.uri, new Set());
    }
    this.byUri.get(link.target.uri)!.add(link.id);
  }

  private deindexLink(link: CrossSurfaceLink): void {
    this.bySourceId.get(link.source.stableId)?.delete(link.id);
    this.byTargetId.get(link.target.stableId)?.delete(link.id);
    this.byUri.get(link.source.uri)?.delete(link.id);
    this.byUri.get(link.target.uri)?.delete(link.id);
  }
}
