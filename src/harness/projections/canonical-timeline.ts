/**
 * Canonical_Timeline — Stable-keyed projection reducers for the chat timeline.
 *
 * Derives typed Chat_Nodes exclusively from compatible Session_Log records.
 * Enforces:
 * - Unique stable business keys per session
 * - Deterministic projection order (sessionSequence, intraEventOrdinal, stableKey)
 * - Prefix equivalence (same event prefix → same nodes/keys)
 * - Page cursors for bounded windowed retrieval
 * - Unread metadata tracking
 * - Keyed incremental deltas for efficient UI updates
 *
 * Requirements: 35.1–35.4, 35.16–35.18, 47.3, 47.17
 */

import crypto from 'node:crypto';
import type { SessionEventV1 } from '../contracts/event.js';
import type { ChatNodeV1, ChatNodeBaseV1 } from '../contracts/chat-node.js';
import type { ProjectionEnvelopeV1 } from '../contracts/projection.js';

// ─── Stable Key Computation ─────────────────────────────────────

/**
 * Derive a stable key from immutable business identity and node role.
 *
 * stableKey = versionedHash(sessionId, branchId, primaryEntityKind, primaryEntityId, nodeRole)
 *
 * The key remains unchanged across incremental updates, paging, compaction,
 * reconnection, and compatible replay. (Req 35.2, 35.16)
 */
export function computeStableKey(
  sessionId: string,
  branchId: string,
  primaryEntityKind: string,
  primaryEntityId: string,
  nodeRole: string,
): string {
  const input = `v1:${sessionId}:${branchId}:${primaryEntityKind}:${primaryEntityId}:${nodeRole}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

// ─── Sort Key ───────────────────────────────────────────────────

/**
 * Projection order tuple for deterministic sorting.
 * Order: (sessionSequence, intraEventOrdinal, stableKey)
 * Equal sequences without distinct ordinals are invalid. (Design doc)
 */
export interface ProjectionSortKey {
  sessionSequence: number;
  intraEventOrdinal: number;
  stableKey: string;
}

/**
 * Compare two projection sort keys. Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareProjectionSortKeys(a: ProjectionSortKey, b: ProjectionSortKey): number {
  if (a.sessionSequence !== b.sessionSequence) {
    return a.sessionSequence - b.sessionSequence;
  }
  if (a.intraEventOrdinal !== b.intraEventOrdinal) {
    return a.intraEventOrdinal - b.intraEventOrdinal;
  }
  return a.stableKey.localeCompare(b.stableKey);
}

// ─── Intermediate Node with Sort Key ────────────────────────────

interface IndexedNode {
  sortKey: ProjectionSortKey;
  node: ChatNodeV1;
}

// ─── Page Cursor ────────────────────────────────────────────────

/**
 * An opaque page cursor encoding the position in the projected timeline.
 * Used for bounded windowed retrieval. (Req 47.3)
 */
export interface PageCursor {
  /** Cursor contract version; must match the configured projection schema. */
  schemaVersion: 1;
  /** Scope prevents a cursor from being replayed against another timeline. */
  sessionId: string;
  branchId: string;
  /** The stable identity of the boundary node. */
  boundaryStableKey: string;
  /** The complete encoded sort tuple at the boundary. */
  boundarySequence: number;
  boundaryOrdinal: number;
  /** Direction: 'forward' fetches newer nodes, 'backward' fetches older. */
  direction: 'forward' | 'backward';
}

export interface TimelinePageInitialQuery {
  kind: 'initial';
  /** Initial paging must explicitly choose the oldest or latest edge. */
  position: 'oldest' | 'latest';
  pageSize?: number;
  schemaVersion: 1;
}

export interface TimelinePageCursorQuery {
  kind: 'cursor';
  /** Opaque value returned by a prior page from the same projection scope. */
  cursor: string;
  pageSize?: number;
  schemaVersion: 1;
}

export type TimelinePageQuery = TimelinePageInitialQuery | TimelinePageCursorQuery;

export type TimelinePageUnavailableReason =
  | 'malformed_cursor'
  | 'stale_cursor'
  | 'invalid_page_size'
  | 'unsupported_schema_version';

export type TimelinePageResult =
  | { ok: true; page: TimelinePageV1 }
  | {
      ok: false;
      unavailable: true;
      reasonCode: TimelinePageUnavailableReason;
      projectionRevision: number;
      sourceSequence: number;
      schemaVersion: 1;
    };

/**
 * Encode a page cursor to an opaque string.
 */
export function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/**
 * Decode a page cursor from an opaque string.
 * Returns null if the cursor is malformed. Timeline identity and sort-tuple
 * freshness are validated by the reducer that owns the projection.
 */
export function decodePageCursor(encoded: string): PageCursor | null {
  try {
    if (typeof encoded !== 'string' || encoded.length === 0) return null;
    const json = Buffer.from(encoded, 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      value.schemaVersion === 1 &&
      typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
      typeof value.branchId === 'string' && value.branchId.length > 0 &&
      typeof value.boundaryStableKey === 'string' && value.boundaryStableKey.length > 0 &&
      typeof value.boundarySequence === 'number' &&
      Number.isSafeInteger(value.boundarySequence) && value.boundarySequence >= 0 &&
      typeof value.boundaryOrdinal === 'number' &&
      Number.isSafeInteger(value.boundaryOrdinal) && value.boundaryOrdinal >= 0 &&
      (value.direction === 'forward' || value.direction === 'backward')
    ) {
      return value as unknown as PageCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Unread Metadata ────────────────────────────────────────────

/**
 * Tracks the unread boundary for a session timeline. (Req 35.8 related)
 */
export interface UnreadMetadata {
  /** The last stable key acknowledged by the reader */
  lastReadStableKey: string | null;
  /** Count of unread Chat_Nodes after the last read position */
  unreadCount: number;
  /** Whether the reader has explicit bottom-follow enabled */
  bottomFollow: boolean;
}

// ─── Incremental Delta ──────────────────────────────────────────

/**
 * A keyed incremental delta describing what changed between two
 * projection revisions. (Req 35.4, 47.3)
 */
export interface TimelineDelta {
  /** Nodes added since the previous revision, keyed by stableKey */
  added: ChatNodeV1[];
  /** Nodes updated (same stableKey, new contentRevision) */
  updated: ChatNodeV1[];
  /** Stable keys of nodes removed (e.g., from compaction) */
  removed: string[];
  /** The new projection revision */
  projectionRevision: number;
  /** Source sequence this delta covers through */
  sourceSequence: number;
}

// ─── Timeline Page ──────────────────────────────────────────────

/**
 * A bounded page of the canonical timeline with cursors for navigation.
 */
export interface TimelinePageV1 {
  /** Page contract version, aligned with the projection configuration. */
  schemaVersion: 1;
  /** Ordered Chat_Nodes for this page */
  nodes: ChatNodeV1[];
  /** Cursor for prepending older nodes (null if at the beginning). */
  beforeCursor: string | null;
  /** Cursor for fetching newer nodes (null if at the end). */
  afterCursor: string | null;
  /** Inclusive source sequence range represented by this page. */
  sourceRange: { fromSequence: number; toSequence: number } | null;
  /** Total projected node count for this session/branch */
  totalNodeCount: number;
  /** Unread tracking metadata */
  unread: UnreadMetadata;
}

// ─── Event-to-Node Mapping ──────────────────────────────────────

/**
 * Map a Session_Log event to zero or more Chat_Nodes.
 * A single event may produce multiple nodes (e.g., a batch tool execution).
 * Unknown event types produce no nodes (forward compatibility).
 *
 * Requirements: 35.1, 35.3
 */
export function mapEventToNodes(
  event: SessionEventV1,
): IndexedNode[] {
  const sessionId = event.sessionId;
  const branchId = event.branchId;
  const sequence = event.sequence;
  const payload = event.payload as Record<string, unknown>;
  const eventType = event.eventType;

  const nodes: IndexedNode[] = [];

  switch (eventType) {
    case 'message.user':
    case 'message.assistant':
    case 'message.system': {
      const role = eventType === 'message.user' ? 'user'
        : eventType === 'message.assistant' ? 'assistant'
          : 'system';
      const entityId = (payload['messageId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'message', entityId, role);
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'message',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `${role} message`,
          role,
          text: (payload['text'] as string) || '',
          attachmentIds: (payload['attachmentIds'] as string[]) || undefined,
        },
      });
      break;
    }

    case 'assistant.state': {
      const turnId = (payload['turnId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'assistant_state', turnId, 'state');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'assistant_state',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId,
          accessibilityLabel: `assistant ${(payload['activityState'] as string) || 'unknown'}`,
          activityState: (payload['activityState'] as string) || 'unknown',
          streamingText: (payload['streamingText'] as string) || undefined,
        },
      });
      break;
    }

    case 'tool.call': {
      const callId = (payload['callId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'tool_call', callId, 'tree');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'tool_tree',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `tool call ${(payload['toolName'] as string) || 'unknown'}`,
          callId,
          parentCallId: (payload['parentCallId'] as string) || undefined,
          toolName: (payload['toolName'] as string) || 'unknown',
          modelOrderIndex: (payload['modelOrderIndex'] as number) ?? 0,
          state: (payload['state'] as 'planned' | 'executing' | 'completed' | 'failed' | 'cancelled') || 'planned',
        },
      });
      break;
    }

    case 'retry': {
      const originalAnchorId = (payload['originalAnchorId'] as string) || event.eventId;
      const attempt = (payload['attempt'] as number) || 1;
      const entityId = `${originalAnchorId}:${attempt}`;
      const stableKey = computeStableKey(sessionId, branchId, 'retry', entityId, 'retry');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'retry',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `retry attempt ${attempt}`,
          originalAnchorId,
          attempt,
          reason: (payload['reason'] as string) || undefined,
        },
      });
      break;
    }

    case 'error': {
      const errorId = (payload['errorId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'error', errorId, 'error');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'error',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `error: ${(payload['errorClass'] as string) || 'unknown'}`,
          errorClass: (payload['errorClass'] as string) || 'unknown',
          message: (payload['message'] as string) || '',
          redacted: (payload['redacted'] as boolean) ?? false,
        },
      });
      break;
    }

    case 'compaction': {
      const compactionId = (payload['compactionId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'compaction', compactionId, 'compaction');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'compaction',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          accessibilityLabel: `compaction ${(payload['strategy'] as string) || 'unknown'}`,
          sourceRangeStart: (payload['sourceRangeStart'] as number) ?? 0,
          sourceRangeEnd: (payload['sourceRangeEnd'] as number) ?? sequence,
          strategy: (payload['strategy'] as string) || 'unknown',
        },
      });
      break;
    }

    case 'context.injection': {
      const injectionId = (payload['injectionId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'context_injection', injectionId, 'injection');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'context_injection',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `context injection: ${(payload['injectionKind'] as string) || 'unknown'}`,
          injectionKind: (payload['injectionKind'] as string) || 'unknown',
          label: (payload['label'] as string) || undefined,
        },
      });
      break;
    }

    case 'queue.entry': {
      const entryId = (payload['entryId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'queue', entryId, 'queue');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'queue',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `queue entry: ${(payload['queueKind'] as string) || 'follow_up'}`,
          entryId,
          queueKind: (payload['queueKind'] as 'follow_up' | 'steer' | 'inject') || 'follow_up',
        },
      });
      break;
    }

    case 'collaboration.wait': {
      const collaborationId = (payload['collaborationId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'collaboration', collaborationId, 'collaboration');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'collaboration',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `collaboration: ${(payload['collaborationKind'] as string) || 'question'}`,
          collaborationKind: (payload['collaborationKind'] as 'question' | 'approval' | 'plan_review') || 'question',
          status: (payload['status'] as 'pending' | 'decided' | 'expired') || 'pending',
        },
      });
      break;
    }

    case 'trajectory.summary': {
      const trajectoryId = (payload['trajectoryId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'trajectory', trajectoryId, 'summary');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'trajectory_summary',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId: (payload['turnId'] as string) || undefined,
          accessibilityLabel: `trajectory: ${(payload['kind'] as string) || 'unknown'}`,
          trajectoryId,
          kind: (payload['kind'] as string) || 'unknown',
          status: (payload['status'] as string) || 'unknown',
        },
      });
      break;
    }

    case 'turn.tail': {
      const turnId = (payload['turnId'] as string) || event.eventId;
      const stableKey = computeStableKey(sessionId, branchId, 'turn_tail', turnId, 'tail');
      nodes.push({
        sortKey: { sessionSequence: sequence, intraEventOrdinal: 0, stableKey },
        node: {
          stableKey,
          nodeKind: 'turn_tail',
          sessionId,
          branchId,
          sourceSequenceStart: sequence,
          sourceSequenceEnd: sequence,
          contentRevision: 0,
          turnId,
          accessibilityLabel: `turn ${(payload['outcome'] as string) || 'completed'}`,
          outcome: (payload['outcome'] as 'completed' | 'failed' | 'interrupted' | 'cancelled') || 'completed',
        },
      });
      break;
    }

    default:
      // Unknown event types produce no nodes (forward compatibility)
      break;
  }

  return nodes;
}

// ─── Canonical Timeline Reducer ─────────────────────────────────

/**
 * Configuration for the CanonicalTimelineReducer.
 */
export interface CanonicalTimelineConfig {
  /** Maximum nodes per page (for bounded retrieval) */
  pageSize: number;
  /** The current schema version for projection compatibility */
  schemaVersion: 1;
}

/**
 * CanonicalTimelineReducer — derives an ordered, typed Canonical_Timeline
 * from compatible Session_Log records.
 *
 * Invariants:
 * - Stable keys are unique within a session (Req 35.16)
 * - Same event prefix → same node order and keys (Req 35.17)
 * - Projection order is (sessionSequence, intraEventOrdinal, stableKey) (Design)
 * - Nodes are derived exclusively from Session_Log events (Req 35.1)
 *
 * Requirements: 35.1–35.4, 35.16–35.18, 47.3, 47.17
 */
export class CanonicalTimelineReducer {
  private readonly config: CanonicalTimelineConfig;
  private readonly sessionId: string;
  private readonly branchId: string;

  /** Keyed node storage — stableKey → IndexedNode */
  private nodeMap: Map<string, IndexedNode> = new Map();
  /** Sorted projection (invalidated on mutation) */
  private sortedNodes: IndexedNode[] | null = null;
  /** Current visible projection revision (incremented only on node mutations) */
  private projectionRevision: number = 0;
  /** Durable event identities already reduced; exact replay is a no-op. */
  private processedEventIds = new Set<string>();
  /** Highest source sequence ingested */
  private sourceSequence: number = -1;
  /** Unread tracking */
  private unread: UnreadMetadata = {
    lastReadStableKey: null,
    unreadCount: 0,
    bottomFollow: true,
  };

  constructor(sessionId: string, branchId: string, config: CanonicalTimelineConfig) {
    this.sessionId = sessionId;
    this.branchId = branchId;
    this.config = config;
  }

  /**
   * Reduce a batch of Session_Log events into the timeline.
   * Events must be compatible (same sessionId/branchId) and in sequence order.
   * Returns the incremental delta for this batch.
   *
   * Requirements: 35.1, 35.4, 35.17
   */
  reduce(events: SessionEventV1[]): TimelineDelta {
    const added: ChatNodeV1[] = [];
    const updated: ChatNodeV1[] = [];
    const removed: string[] = [];
    const acceptedEvents: SessionEventV1[] = [];

    for (const event of events) {
      if (event.sessionId !== this.sessionId || event.branchId !== this.branchId) {
        continue;
      }
      if (this.processedEventIds.has(event.eventId)) {
        continue;
      }

      // Session_Log is append-only and ordered. Remember unseen identities before
      // sequence validation so stale/conflicting replay cannot mutate the view later.
      this.processedEventIds.add(event.eventId);
      if (event.sequence <= this.sourceSequence) {
        continue;
      }

      acceptedEvents.push(event);
      this.sourceSequence = event.sequence;
      const indexedNodes = mapEventToNodes(event);

      for (const indexed of indexedNodes) {
        const existing = this.nodeMap.get(indexed.node.stableKey);
        if (existing) {
          const updatedNode = {
            ...indexed.node,
            contentRevision: existing.node.contentRevision + 1,
            sourceSequenceStart: (existing.node as ChatNodeBaseV1).sourceSequenceStart,
            sourceSequenceEnd: event.sequence,
          } as ChatNodeV1;
          this.nodeMap.set(indexed.node.stableKey, {
            sortKey: existing.sortKey,
            node: updatedNode,
          });
          updated.push(updatedNode);
        } else {
          this.nodeMap.set(indexed.node.stableKey, indexed);
          added.push(indexed.node);
        }
      }
    }

    // Apply removals only for newly accepted compaction facts. Replayed
    // compaction records therefore cannot remove a node restored by later facts.
    for (const event of acceptedEvents) {
      if (event.eventType !== 'compaction') continue;
      const payload = event.payload as Record<string, unknown>;
      const removedKeys = payload['removedStableKeys'] as string[] | undefined;
      if (!removedKeys) continue;
      for (const key of removedKeys) {
        if (this.nodeMap.has(key)) {
          this.nodeMap.delete(key);
          removed.push(key);
        }
      }
    }

    const hasVisibleMutation = added.length > 0 || updated.length > 0 || removed.length > 0;
    if (hasVisibleMutation) {
      this.sortedNodes = null;
      this.projectionRevision++;

      if (!this.unread.bottomFollow) {
        this.unread.unreadCount += added.length;
      }
    }

    return {
      added,
      updated,
      removed,
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceSequence,
    };
  }

  /**
   * Get the sorted projection of all nodes.
   * Deterministic: (sessionSequence, intraEventOrdinal, stableKey).
   *
   * Requirements: 35.17
   */
  getSortedNodes(): ChatNodeV1[] {
    return this.getSortedIndexedNodes().map(entry => entry.node);
  }

  /**
   * Execute a versioned page query. Initial callers must explicitly select the
   * oldest or latest edge; cursor callers receive typed unavailable outcomes
   * instead of silently moving to another position.
   *
   * Requirements: 19.3–19.4, 21.2, 22.4
   */
  queryPage(query: TimelinePageQuery): TimelinePageResult {
    if (!query || query.schemaVersion !== this.config.schemaVersion) {
      return this.pageUnavailable('unsupported_schema_version');
    }

    const limit = query.pageSize ?? this.config.pageSize;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.config.pageSize) {
      return this.pageUnavailable('invalid_page_size');
    }

    if (query.kind === 'initial') {
      if (query.position !== 'oldest' && query.position !== 'latest') {
        return this.pageUnavailable('unsupported_schema_version');
      }
      return { ok: true, page: this.buildPage(null, limit, query.position) };
    }

    if (query.kind !== 'cursor' || typeof query.cursor !== 'string') {
      return this.pageUnavailable('malformed_cursor');
    }

    const cursor = decodePageCursor(query.cursor);
    if (!cursor) {
      return this.pageUnavailable('malformed_cursor');
    }
    if (!this.isCurrentCursor(cursor)) {
      return this.pageUnavailable('stale_cursor');
    }

    return { ok: true, page: this.buildPage(cursor, limit, 'oldest') };
  }

  /**
   * Compatibility API for existing in-process callers. New projection/query
   * boundaries should use queryPage so malformed and stale cursors are typed.
   * A null cursor retains the historical oldest-page behavior.
   */
  getPage(query: TimelinePageQuery): TimelinePageResult;
  getPage(cursor?: PageCursor | null, pageSize?: number): TimelinePageV1;
  getPage(
    cursorOrQuery?: TimelinePageQuery | PageCursor | null,
    pageSize?: number,
  ): TimelinePageV1 | TimelinePageResult {
    if (
      cursorOrQuery &&
      typeof cursorOrQuery === 'object' &&
      ('kind' in cursorOrQuery)
    ) {
      return this.queryPage(cursorOrQuery as TimelinePageQuery);
    }
    const limit = pageSize ?? this.config.pageSize;
    return this.buildPage(
      (cursorOrQuery as PageCursor | null | undefined) ?? null,
      Math.min(Math.max(1, limit), this.config.pageSize),
      'oldest',
    );
  }

  private buildPage(
    cursor: PageCursor | null,
    limit: number,
    initialPosition: 'oldest' | 'latest',
  ): TimelinePageV1 {
    const allEntries = this.getSortedIndexedNodes();
    const totalNodeCount = allEntries.length;

    if (totalNodeCount === 0) {
      return {
        schemaVersion: this.config.schemaVersion,
        nodes: [],
        beforeCursor: null,
        afterCursor: null,
        sourceRange: null,
        totalNodeCount: 0,
        unread: { ...this.unread },
      };
    }

    let startIndex = initialPosition === 'latest' ? Math.max(totalNodeCount - limit, 0) : 0;
    let endIndex = initialPosition === 'latest'
      ? totalNodeCount
      : Math.min(limit, totalNodeCount);

    if (cursor) {
      const boundaryIndex = allEntries.findIndex(
        entry => entry.node.stableKey === cursor.boundaryStableKey,
      );
      // queryPage validates this first. The compatibility API returns an empty
      // page rather than silently jumping to a different timeline position.
      if (boundaryIndex < 0 || !this.cursorMatchesEntry(cursor, allEntries[boundaryIndex]!)) {
        startIndex = 0;
        endIndex = 0;
      } else if (cursor.direction === 'forward') {
        startIndex = boundaryIndex + 1;
        endIndex = Math.min(startIndex + limit, totalNodeCount);
      } else {
        endIndex = boundaryIndex;
        startIndex = Math.max(endIndex - limit, 0);
      }
    }

    const pageEntries = allEntries.slice(startIndex, endIndex);
    const pageNodes = pageEntries.map(entry => entry.node);

    const beforeCursor = startIndex > 0 && pageEntries.length > 0
      ? encodePageCursor(this.createPageCursor(pageEntries[0]!, 'backward'))
      : null;

    const afterCursor = endIndex < totalNodeCount && pageEntries.length > 0
      ? encodePageCursor(this.createPageCursor(pageEntries[pageEntries.length - 1]!, 'forward'))
      : null;

    const sourceRange = pageNodes.length > 0
      ? {
          fromSequence: Math.min(
            ...pageNodes.map(node => (node as ChatNodeBaseV1).sourceSequenceStart),
          ),
          toSequence: Math.max(
            ...pageNodes.map(node => (node as ChatNodeBaseV1).sourceSequenceEnd),
          ),
        }
      : null;

    return {
      schemaVersion: this.config.schemaVersion,
      nodes: pageNodes,
      beforeCursor,
      afterCursor,
      sourceRange,
      totalNodeCount,
      unread: { ...this.unread },
    };
  }

  /**
   * Produce a full projection envelope wrapping the timeline page.
   *
   * Requirements: 35.3
   */
  getProjectionEnvelope(
    cursor?: PageCursor | null,
    pageSize?: number,
    confirmedCommandIds?: string[],
  ): ProjectionEnvelopeV1<TimelinePageV1> {
    const page = this.getPage(cursor, pageSize);

    return {
      sessionId: this.sessionId,
      branchId: this.branchId,
      projectionKind: 'canonical_timeline',
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceSequence,
      schemaVersion: this.config.schemaVersion,
      checkpointHash: this.computeCheckpointHash(),
      generatedAt: new Date().toISOString(),
      stale: false,
      value: page,
      confirmedCommandIds: confirmedCommandIds ?? [],
    };
  }

  /**
   * Mark the reader's position for unread tracking.
   */
  markRead(stableKey: string): void {
    this.unread.lastReadStableKey = stableKey;
    // Recompute unread count
    const allNodes = this.getSortedNodes();
    const readIndex = allNodes.findIndex(n => n.stableKey === stableKey);
    if (readIndex >= 0) {
      this.unread.unreadCount = allNodes.length - readIndex - 1;
    }
  }

  /**
   * Toggle bottom-follow mode.
   */
  setBottomFollow(enabled: boolean): void {
    this.unread.bottomFollow = enabled;
    if (enabled) {
      this.unread.unreadCount = 0;
      const allNodes = this.getSortedNodes();
      if (allNodes.length > 0) {
        this.unread.lastReadStableKey = allNodes[allNodes.length - 1]!.stableKey;
      }
    }
  }

  /**
   * Get the current projection revision.
   */
  getProjectionRevision(): number {
    return this.projectionRevision;
  }

  /**
   * Get the current source sequence.
   */
  getSourceSequence(): number {
    return this.sourceSequence;
  }

  /**
   * Get the current unread metadata.
   */
  getUnreadMetadata(): UnreadMetadata {
    return { ...this.unread };
  }

  /**
   * Get total node count.
   */
  getNodeCount(): number {
    return this.nodeMap.size;
  }

  /**
   * Check if a stable key exists in the timeline.
   */
  hasNode(stableKey: string): boolean {
    return this.nodeMap.has(stableKey);
  }

  /**
   * Get a node by its stable key.
   */
  getNode(stableKey: string): ChatNodeV1 | undefined {
    return this.nodeMap.get(stableKey)?.node;
  }

  /**
   * Reset the reducer state.
   */
  reset(): void {
    this.nodeMap.clear();
    this.processedEventIds.clear();
    this.sortedNodes = null;
    this.projectionRevision = 0;
    this.sourceSequence = -1;
    this.unread = {
      lastReadStableKey: null,
      unreadCount: 0,
      bottomFollow: true,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private getSortedIndexedNodes(): IndexedNode[] {
    if (!this.sortedNodes) {
      const entries = Array.from(this.nodeMap.values());
      entries.sort((a, b) => compareProjectionSortKeys(a.sortKey, b.sortKey));
      this.sortedNodes = entries;
    }
    return this.sortedNodes;
  }

  private createPageCursor(
    entry: IndexedNode,
    direction: PageCursor['direction'],
  ): PageCursor {
    return {
      schemaVersion: this.config.schemaVersion,
      sessionId: this.sessionId,
      branchId: this.branchId,
      boundaryStableKey: entry.node.stableKey,
      boundarySequence: entry.sortKey.sessionSequence,
      boundaryOrdinal: entry.sortKey.intraEventOrdinal,
      direction,
    };
  }

  private cursorMatchesEntry(cursor: PageCursor, entry: IndexedNode): boolean {
    return cursor.boundaryStableKey === entry.node.stableKey &&
      cursor.boundaryStableKey === entry.sortKey.stableKey &&
      cursor.boundarySequence === entry.sortKey.sessionSequence &&
      cursor.boundaryOrdinal === entry.sortKey.intraEventOrdinal;
  }

  private isCurrentCursor(cursor: PageCursor): boolean {
    if (
      cursor.schemaVersion !== this.config.schemaVersion ||
      cursor.sessionId !== this.sessionId ||
      cursor.branchId !== this.branchId
    ) {
      return false;
    }
    const entry = this.nodeMap.get(cursor.boundaryStableKey);
    return entry !== undefined && this.cursorMatchesEntry(cursor, entry);
  }

  private pageUnavailable(reasonCode: TimelinePageUnavailableReason): TimelinePageResult {
    return {
      ok: false,
      unavailable: true,
      reasonCode,
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceSequence,
      schemaVersion: this.config.schemaVersion,
    };
  }

  private computeCheckpointHash(): string {
    // Include the complete ordered canonical node payload, not only identity and
    // revision counters, so independent replay checkpoints detect content loss.
    const content = JSON.stringify(this.getSortedNodes());
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
