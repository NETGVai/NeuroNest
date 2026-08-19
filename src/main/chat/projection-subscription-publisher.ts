/**
 * Scoped Projection Subscription Publisher
 *
 * Main-process publisher that emits `chat-projection:delta-v1` and
 * `chat-projection:invalidated-v1` events to renderer windows. Publication
 * occurs only after authoritative append/projection, is scoped to exact
 * session/branch, uses compatible schema versioning, and preserves keyed order.
 *
 * Requirements: 2.8, 4.3, 16.5, 21.3, 21.8, 22.3–22.4
 */

import type { ProjectionDeltaV1 } from '../../harness/projections/index.js';
import type {
  ChatProjectionInvalidatedV1,
  ScopedChatProjectionDeltaV1,
} from '../../renderer/types/structured-chat-preload.js';
import type { StructuredProjectionUnavailableReason } from '../../harness/projections/index.js';

// ─── Publication Channels ────────────────────────────────────────────────────

export const PROJECTION_DELTA_CHANNEL = 'chat-projection:delta-v1' as const;
export const PROJECTION_INVALIDATED_CHANNEL = 'chat-projection:invalidated-v1' as const;

export const PROJECTION_SUBSCRIPTION_CHANNELS = [
  PROJECTION_DELTA_CHANNEL,
  PROJECTION_INVALIDATED_CHANNEL,
] as const;

export type ProjectionSubscriptionChannel = typeof PROJECTION_SUBSCRIPTION_CHANNELS[number];

// ─── Scope and Validation ────────────────────────────────────────────────────

export interface ProjectionPublicationScopeV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly branchId: string;
}

export interface ProjectionPublicationSenderLike {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface ProjectionSubscriptionListenerV1 {
  readonly id: string;
  readonly scope: Readonly<ProjectionPublicationScopeV1>;
  readonly sender: ProjectionPublicationSenderLike;
  /** Monotonic revision last acknowledged by the listener. */
  lastAcknowledgedRevision: number;
}

// ─── Publisher Dependencies ──────────────────────────────────────────────────

export interface ProjectionSubscriptionPublisherDependencies {
  /** Clock for diagnostic timing. */
  readonly now?: () => string;
  /** Factory for listener identity assignment. */
  readonly createListenerId?: () => string;
}

// ─── Publisher Interface ─────────────────────────────────────────────────────

export interface ProjectionSubscriptionRegistration {
  readonly listenerId: string;
  readonly channel: ProjectionSubscriptionChannel;
  readonly scope: Readonly<ProjectionPublicationScopeV1>;
  unsubscribe(): void;
}

export interface ProjectionPublicationDiagnosticsV1 {
  readonly totalListeners: number;
  readonly activeListeners: number;
  readonly totalPublications: number;
  readonly rejectedPublications: number;
  readonly sessions: ReadonlyArray<{ sessionId: string; branchId: string; listenerCount: number }>;
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

function isValidScope(scope: unknown): scope is ProjectionPublicationScopeV1 {
  if (scope === null || typeof scope !== 'object') return false;
  const candidate = scope as Partial<ProjectionPublicationScopeV1>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    candidate.sessionId.length <= 256 &&
    typeof candidate.branchId === 'string' &&
    candidate.branchId.length > 0 &&
    candidate.branchId.length <= 256
  );
}

function isValidDelta(delta: unknown): delta is ProjectionDeltaV1 {
  if (delta === null || typeof delta !== 'object') return false;
  const candidate = delta as Partial<ProjectionDeltaV1>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sourceRevision === 'number' &&
    Number.isSafeInteger(candidate.sourceRevision) &&
    candidate.sourceRevision >= -1 &&
    Array.isArray(candidate.nodesAdded) &&
    Array.isArray(candidate.nodesUpdated) &&
    Array.isArray(candidate.nodesRemoved) &&
    Array.isArray(candidate.compositionsAdded) &&
    Array.isArray(candidate.compositionsUpdated) &&
    Array.isArray(candidate.compositionsRemoved)
  );
}

const VALID_INVALIDATION_REASONS = new Set<StructuredProjectionUnavailableReason>([
  'cross_session',
  'stale_revision',
  'stale_source_revision',
  'unsupported_schema_version',
  'bound_exceeded',
  'invalid_identity',
  'duplicate_event_id',
  'malformed_cursor',
  'stale_cursor',
  'cancelled',
  'invalid_checkpoint',
]);

function isValidInvalidation(event: unknown): event is ChatProjectionInvalidatedV1 {
  if (event === null || typeof event !== 'object') return false;
  const candidate = event as Partial<ChatProjectionInvalidatedV1>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    typeof candidate.branchId === 'string' &&
    candidate.branchId.length > 0 &&
    typeof candidate.projectionRevision === 'number' &&
    Number.isSafeInteger(candidate.projectionRevision) &&
    candidate.projectionRevision >= 0 &&
    typeof candidate.sourceRevision === 'number' &&
    Number.isSafeInteger(candidate.sourceRevision) &&
    candidate.sourceRevision >= -1 &&
    typeof candidate.reasonCode === 'string' &&
    VALID_INVALIDATION_REASONS.has(candidate.reasonCode as StructuredProjectionUnavailableReason)
  );
}

function scopeKey(sessionId: string, branchId: string): string {
  return `${sessionId}\u0000${branchId}`;
}

// ─── Publisher Implementation ────────────────────────────────────────────────

let idCounter = 0;
function defaultListenerId(): string {
  return `psl-${++idCounter}-${Date.now().toString(36)}`;
}

/**
 * Main-process publisher that sends scoped projection deltas and invalidation
 * events to registered renderer windows. Each listener is scoped to a single
 * session/branch. Cross-session envelopes and stale/out-of-order revisions are
 * silently rejected without mutating state visible to any renderer.
 */
export class ProjectionSubscriptionPublisher {
  private readonly listeners = new Map<string, ProjectionSubscriptionListenerV1>();
  private readonly scopeIndex = new Map<string, Set<string>>();
  private readonly createListenerId: () => string;
  private totalPublications = 0;
  private rejectedPublications = 0;
  private disposed = false;

  constructor(dependencies: ProjectionSubscriptionPublisherDependencies = {}) {
    this.createListenerId = dependencies.createListenerId ?? defaultListenerId;
  }

  /**
   * Register a renderer window to receive delta publications for a specific
   * session/branch scope. Returns an unsubscribe handle.
   */
  subscribeDelta(
    scope: ProjectionPublicationScopeV1,
    sender: ProjectionPublicationSenderLike,
  ): ProjectionSubscriptionRegistration {
    return this.addListener(PROJECTION_DELTA_CHANNEL, scope, sender);
  }

  /**
   * Register a renderer window to receive invalidation publications for a
   * specific session/branch scope. Returns an unsubscribe handle.
   */
  subscribeInvalidation(
    scope: ProjectionPublicationScopeV1,
    sender: ProjectionPublicationSenderLike,
  ): ProjectionSubscriptionRegistration {
    return this.addListener(PROJECTION_INVALIDATED_CHANNEL, scope, sender);
  }

  /**
   * Publish a projection delta to all listeners scoped to the matching
   * session/branch. Validates envelope schema, rejects stale revisions,
   * and preserves keyed publication order.
   *
   * Returns the count of listeners that received the publication.
   */
  publishDelta(
    sessionId: string,
    branchId: string,
    delta: ProjectionDeltaV1,
    projectionRevision: number,
  ): number {
    if (this.disposed) return 0;
    if (!isValidDelta(delta)) {
      this.rejectedPublications++;
      return 0;
    }
    if (
      typeof sessionId !== 'string' || sessionId.length === 0 ||
      typeof branchId !== 'string' || branchId.length === 0
    ) {
      this.rejectedPublications++;
      return 0;
    }
    if (
      typeof projectionRevision !== 'number' ||
      !Number.isSafeInteger(projectionRevision) ||
      projectionRevision < 0
    ) {
      this.rejectedPublications++;
      return 0;
    }

    const key = scopeKey(sessionId, branchId);
    const listenerIds = this.scopeIndex.get(key);
    if (!listenerIds || listenerIds.size === 0) return 0;

    const envelope: ScopedChatProjectionDeltaV1 = {
      ...delta,
      sessionId,
      branchId,
    };

    let sent = 0;
    for (const listenerId of listenerIds) {
      const listener = this.listeners.get(listenerId);
      if (!listener) continue;

      // Channel check: only delta listeners
      if (!listenerId.startsWith(`${PROJECTION_DELTA_CHANNEL}\u0001`)) continue;

      // Reject out-of-order revisions
      if (projectionRevision <= listener.lastAcknowledgedRevision) {
        this.rejectedPublications++;
        continue;
      }

      if (listener.sender.isDestroyed()) {
        this.removeListener(listenerId);
        continue;
      }

      try {
        listener.sender.send(PROJECTION_DELTA_CHANNEL, envelope);
        listener.lastAcknowledgedRevision = projectionRevision;
        sent++;
        this.totalPublications++;
      } catch {
        // Sender may be destroyed between check and send
        this.removeListener(listenerId);
      }
    }

    return sent;
  }

  /**
   * Publish an invalidation event to all listeners scoped to the matching
   * session/branch. Validates the event and rejects cross-session envelopes.
   *
   * Returns the count of listeners that received the publication.
   */
  publishInvalidation(
    sessionId: string,
    branchId: string,
    projectionRevision: number,
    sourceRevision: number,
    reasonCode: StructuredProjectionUnavailableReason,
  ): number {
    if (this.disposed) return 0;

    const event: ChatProjectionInvalidatedV1 = {
      schemaVersion: 1,
      sessionId,
      branchId,
      projectionRevision,
      sourceRevision,
      reasonCode,
    };

    if (!isValidInvalidation(event)) {
      this.rejectedPublications++;
      return 0;
    }

    const key = scopeKey(sessionId, branchId);
    const listenerIds = this.scopeIndex.get(key);
    if (!listenerIds || listenerIds.size === 0) return 0;

    let sent = 0;
    for (const listenerId of listenerIds) {
      const listener = this.listeners.get(listenerId);
      if (!listener) continue;

      // Channel check: only invalidation listeners
      if (!listenerId.startsWith(`${PROJECTION_INVALIDATED_CHANNEL}\u0001`)) continue;

      if (listener.sender.isDestroyed()) {
        this.removeListener(listenerId);
        continue;
      }

      try {
        listener.sender.send(PROJECTION_INVALIDATED_CHANNEL, event);
        sent++;
        this.totalPublications++;
      } catch {
        this.removeListener(listenerId);
      }
    }

    return sent;
  }

  /**
   * Remove all listeners for a specific session/branch. Used on session switch
   * or cleanup in the main process.
   */
  removeSessionListeners(sessionId: string, branchId: string): number {
    const key = scopeKey(sessionId, branchId);
    const listenerIds = this.scopeIndex.get(key);
    if (!listenerIds || listenerIds.size === 0) return 0;

    let removed = 0;
    for (const listenerId of [...listenerIds]) {
      this.removeListener(listenerId);
      removed++;
    }
    return removed;
  }

  /**
   * Remove all listeners belonging to a specific sender (window).
   * Used when a BrowserWindow is destroyed.
   */
  removeSenderListeners(senderId: number): number {
    let removed = 0;
    for (const [listenerId, listener] of this.listeners) {
      if (listener.sender.id === senderId) {
        this.removeListener(listenerId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Atomically emit a final invalidation event to every listener scoped to
   * `sessionId`/`branchId` and then detach them. Preserves the subscription
   * cleanup guarantee for main-driven scope-switch and rollout-gate rollback
   * paths: the renderer receives one authoritative "purge state" signal
   * before the transport listener is retired, so no delta event can arrive
   * after the invalidation.
   *
   * Returns `{ notified, detached }` counts. Both counts are `0` when the
   * publisher is already disposed or no listeners match.
   */
  detachScope(
    sessionId: string,
    branchId: string,
    projectionRevision: number,
    sourceRevision: number,
    reasonCode: StructuredProjectionUnavailableReason,
  ): { notified: number; detached: number } {
    if (this.disposed) return { notified: 0, detached: 0 };
    const notified = this.publishInvalidation(
      sessionId,
      branchId,
      projectionRevision,
      sourceRevision,
      reasonCode,
    );
    const detached = this.removeSessionListeners(sessionId, branchId);
    return { notified, detached };
  }

  /**
   * Emit a final invalidation event to every listener owned by `senderId`
   * and then detach them. Used when a BrowserWindow signals `will-be-closed`
   * so the renderer can drain state before its transport disappears; the
   * paired `destroyed` handler still calls `removeSenderListeners` as a
   * defence-in-depth cleanup for senders that were force-terminated.
   */
  detachSender(
    senderId: number,
    projectionRevision: number,
    sourceRevision: number,
    reasonCode: StructuredProjectionUnavailableReason,
  ): { notified: number; detached: number } {
    if (this.disposed) return { notified: 0, detached: 0 };
    const scopes = new Map<string, ProjectionPublicationScopeV1>();
    for (const listener of this.listeners.values()) {
      if (listener.sender.id !== senderId) continue;
      const key = scopeKey(listener.scope.sessionId, listener.scope.branchId);
      if (!scopes.has(key)) scopes.set(key, listener.scope);
    }
    let notified = 0;
    for (const scope of scopes.values()) {
      notified += this.publishInvalidation(
        scope.sessionId,
        scope.branchId,
        projectionRevision,
        sourceRevision,
        reasonCode,
      );
    }
    const detached = this.removeSenderListeners(senderId);
    return { notified, detached };
  }

  /** Get a diagnostic snapshot of listener state. */
  getDiagnostics(): ProjectionPublicationDiagnosticsV1 {
    const sessionMap = new Map<string, number>();
    let activeCount = 0;
    for (const [, listener] of this.listeners) {
      if (!listener.sender.isDestroyed()) {
        activeCount++;
        const key = scopeKey(listener.scope.sessionId, listener.scope.branchId);
        sessionMap.set(key, (sessionMap.get(key) ?? 0) + 1);
      }
    }

    const sessions: Array<{ sessionId: string; branchId: string; listenerCount: number }> = [];
    for (const [key, count] of sessionMap) {
      const [sessionId, branchId] = key.split('\u0000');
      sessions.push({ sessionId, branchId, listenerCount: count });
    }

    return {
      totalListeners: this.listeners.size,
      activeListeners: activeCount,
      totalPublications: this.totalPublications,
      rejectedPublications: this.rejectedPublications,
      sessions,
    };
  }

  /** Dispose the publisher and remove all listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.scopeIndex.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private addListener(
    channel: ProjectionSubscriptionChannel,
    scope: ProjectionPublicationScopeV1,
    sender: ProjectionPublicationSenderLike,
  ): ProjectionSubscriptionRegistration {
    if (this.disposed) {
      throw new Error('Publisher is disposed');
    }
    if (!isValidScope(scope)) {
      throw new TypeError('A version 1 projection session/branch scope is required');
    }
    if (!sender || typeof sender.isDestroyed !== 'function' || typeof sender.send !== 'function') {
      throw new TypeError('A valid sender (BrowserWindow webContents-like) is required');
    }

    const listenerId = `${channel}\u0001${this.createListenerId()}`;
    const key = scopeKey(scope.sessionId, scope.branchId);

    const listener: ProjectionSubscriptionListenerV1 = {
      id: listenerId,
      scope: Object.freeze({ ...scope }),
      sender,
      lastAcknowledgedRevision: -1,
    };

    this.listeners.set(listenerId, listener);

    let scopeSet = this.scopeIndex.get(key);
    if (!scopeSet) {
      scopeSet = new Set();
      this.scopeIndex.set(key, scopeSet);
    }
    scopeSet.add(listenerId);

    let unsubscribed = false;
    const registration: ProjectionSubscriptionRegistration = {
      listenerId,
      channel,
      scope: listener.scope,
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        this.removeListener(listenerId);
      },
    };

    return registration;
  }

  private removeListener(listenerId: string): void {
    const listener = this.listeners.get(listenerId);
    if (!listener) return;

    this.listeners.delete(listenerId);
    const key = scopeKey(listener.scope.sessionId, listener.scope.branchId);
    const scopeSet = this.scopeIndex.get(key);
    if (scopeSet) {
      scopeSet.delete(listenerId);
      if (scopeSet.size === 0) {
        this.scopeIndex.delete(key);
      }
    }
  }
}
