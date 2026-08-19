export type IpcCallback = (...args: unknown[]) => void;
export type IpcWrappedCallback = (_event: unknown, ...args: unknown[]) => void;

export interface IpcListenerBackend {
  on(channel: string, callback: IpcWrappedCallback): unknown;
  removeListener(channel: string, callback: IpcWrappedCallback): unknown;
}

export interface IpcSubscriptionScope {
  /** Session identity for listeners that must be retired on session switch. */
  sessionId?: string;
  branchId?: string;
  /** Rollout gate that owns this listener. Gate rollback retires the listener. */
  gateId?: string;
}

export type IpcCleanupReason =
  | 'session-switch'
  | 'renderer-unload'
  | 'window-destroyed'
  | 'gate-rollback';

export interface IpcSubscriptionSnapshot {
  listenerCount: number;
  leaseCount: number;
  activeSession: { sessionId: string; branchId: string } | null;
  closed: boolean;
}

/**
 * Notification emitted when a subscription record is disposed.
 * Allows external wrapper registries (e.g. scopedProjectionWrappers) to purge
 * stale entries and prevent retained payloads after cleanup.
 */
export interface IpcSubscriptionDisposal {
  channel: string;
  callback: IpcCallback;
  scope: Readonly<IpcSubscriptionScope> | undefined;
  reason: IpcCleanupReason | 'last-lease-released';
}

export type IpcDisposalListener = (disposal: IpcSubscriptionDisposal) => void;

interface SubscriptionRecord {
  channel: string;
  callback: IpcCallback | undefined;
  wrapper: IpcWrappedCallback;
  scope: Readonly<IpcSubscriptionScope> | undefined;
  scopeKey: string;
  leases: Set<symbol>;
  active: boolean;
}

const normalizeScopePart = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeScope = (
  scope: IpcSubscriptionScope | undefined,
): Readonly<IpcSubscriptionScope> | undefined => {
  if (!scope) return undefined;

  const normalized: IpcSubscriptionScope = {
    sessionId: normalizeScopePart(scope.sessionId),
    branchId: normalizeScopePart(scope.branchId),
    gateId: normalizeScopePart(scope.gateId),
  };

  if (!normalized.sessionId && !normalized.branchId && !normalized.gateId) {
    return undefined;
  }
  if (normalized.branchId && !normalized.sessionId) {
    throw new Error('A branch-scoped IPC subscription requires a sessionId');
  }

  return Object.freeze(normalized);
};

const scopeKeyOf = (scope: Readonly<IpcSubscriptionScope> | undefined): string =>
  scope
    ? `${scope.sessionId ?? ''}\u0000${scope.branchId ?? ''}\u0000${scope.gateId ?? ''}`
    : '';

/**
 * Owns only listeners installed through the preload bridge.
 *
 * One Electron wrapper is retained for each exact channel/callback/scope tuple.
 * Repeated subscriptions share that wrapper but receive independent idempotent
 * unsubscribe leases, preventing duplicate Electron registrations without making
 * one caller's cleanup invalidate another caller's lease.
 */
export class IpcSubscriptionRegistry {
  private readonly records = new Set<SubscriptionRecord>();
  private activeSession: { sessionId: string; branchId: string } | null = null;
  private closed = false;
  private disposalListeners = new Set<IpcDisposalListener>();
  private currentCleanupReason: IpcCleanupReason | undefined;

  constructor(private readonly backend: IpcListenerBackend) {}

  /** Register a listener invoked whenever a subscription record is disposed. */
  onDispose(listener: IpcDisposalListener): () => void {
    this.disposalListeners.add(listener);
    return () => { this.disposalListeners.delete(listener); };
  }

  subscribe(
    channel: string,
    callback: IpcCallback,
    scope?: IpcSubscriptionScope,
  ): () => void {
    if (this.closed) return () => undefined;
    if (typeof callback !== 'function') {
      throw new TypeError('IPC subscription callback must be a function');
    }

    const normalizedScope = normalizeScope(scope);
    const scopeKey = scopeKeyOf(normalizedScope);
    let record = [...this.records].find(
      (candidate) =>
        candidate.active &&
        candidate.channel === channel &&
        candidate.callback === callback &&
        candidate.scopeKey === scopeKey,
    );

    if (!record) {
      record = {
        channel,
        callback,
        scope: normalizedScope,
        scopeKey,
        leases: new Set<symbol>(),
        active: true,
        wrapper: () => undefined,
      };
      const ownedRecord = record;
      record.wrapper = (_event: unknown, ...args: unknown[]) => {
        if (!ownedRecord.active) return;
        ownedRecord.callback?.(...args);
      };
      this.records.add(record);
      this.backend.on(channel, record.wrapper);
    }

    const lease = Symbol(channel);
    record.leases.add(lease);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      record?.leases.delete(lease);
      if (record?.active && record.leases.size === 0) {
        this.disposeRecord(record);
      }
      record = undefined;
    };
  }

  /** Backward-compatible callback removal. Removes every scope for the callback. */
  remove(channel: string, callback: IpcCallback): number {
    return this.disposeWhere(
      (record) => record.channel === channel && record.callback === callback,
    );
  }

  /**
   * Sets the active projection scope and retires listeners owned by the prior
   * session/branch. Repeating the same switch is a no-op.
   */
  switchSession(sessionId: string, branchId = 'main'): number {
    const nextSessionId = normalizeScopePart(sessionId);
    const nextBranchId = normalizeScopePart(branchId);
    if (!nextSessionId || !nextBranchId) {
      throw new Error('Session and branch identities must be non-empty');
    }

    if (
      this.activeSession?.sessionId === nextSessionId &&
      this.activeSession.branchId === nextBranchId
    ) {
      return 0;
    }

    this.activeSession = { sessionId: nextSessionId, branchId: nextBranchId };
    this.currentCleanupReason = 'session-switch';
    const removed = this.disposeWhere((record) => {
      if (!record.scope?.sessionId) return false;
      return (
        record.scope.sessionId !== nextSessionId ||
        (record.scope.branchId ?? 'main') !== nextBranchId
      );
    });
    this.currentCleanupReason = undefined;
    return removed;
  }

  /** Retires listeners owned by a rolled-back gate without touching other owners. */
  rollbackGate(gateId: string): number {
    const normalizedGateId = normalizeScopePart(gateId);
    if (!normalizedGateId) throw new Error('Gate identity must be non-empty');
    this.currentCleanupReason = 'gate-rollback';
    const removed = this.disposeWhere((record) => record.scope?.gateId === normalizedGateId);
    this.currentCleanupReason = undefined;
    return removed;
  }

  cleanup(reason: Exclude<IpcCleanupReason, 'session-switch'>): number {
    this.currentCleanupReason = reason;
    const removed = this.disposeWhere(() => true);
    this.currentCleanupReason = undefined;
    this.activeSession = null;
    if (reason === 'window-destroyed') this.closed = true;
    return removed;
  }

  snapshot(): IpcSubscriptionSnapshot {
    let leaseCount = 0;
    for (const record of this.records) leaseCount += record.leases.size;
    return {
      listenerCount: this.records.size,
      leaseCount,
      activeSession: this.activeSession ? { ...this.activeSession } : null,
      closed: this.closed,
    };
  }

  private disposeWhere(predicate: (record: SubscriptionRecord) => boolean): number {
    let removed = 0;
    for (const record of [...this.records]) {
      if (!predicate(record)) continue;
      this.disposeRecord(record);
      removed += 1;
    }
    return removed;
  }

  private disposeRecord(record: SubscriptionRecord): void {
    if (!record.active) return;
    record.active = false;
    this.backend.removeListener(record.channel, record.wrapper);
    const reason = this.currentCleanupReason ?? 'last-lease-released';
    const disposal: IpcSubscriptionDisposal = {
      channel: record.channel,
      callback: record.callback!,
      scope: record.scope,
      reason,
    };
    record.leases.clear();
    record.callback = undefined;
    this.records.delete(record);
    for (const listener of this.disposalListeners) {
      try { listener(disposal); } catch { /* disposal listeners must not throw */ }
    }
  }
}
