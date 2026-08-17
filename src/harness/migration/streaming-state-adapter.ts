/**
 * Streaming State Adapter
 *
 * Replaces duplicate streaming state with durable partial-output projections.
 * Ingests provider/runtime stream deltas (content blocks, reasoning blocks, tool calls)
 * and converts them into durable partial-output Session_Log events.
 *
 * A transient cache (keyed by stableKey + contentRevision) buffers streaming
 * content for immediate display while the durable event path confirms.
 * Once a durable partial event is projected, the transient cache entry is
 * invalidated — the projected value becomes authoritative.
 *
 * The adapter does NOT create any renderer-owned source of truth. All durable
 * state lives in Session_Log events projected through Projection_Service.
 * During recovery/reconnection, retained partial output comes from durable
 * records (not the transient cache).
 *
 * Requirements: 3.1, 16.1, 35.13, 36.6, 36.16, 45.8–45.9
 */

import type { SessionEventPayloadV1 } from '../contracts/event.js';

// ─── Stream Delta Types ─────────────────────────────────────────

/**
 * A provider/runtime stream delta representing a chunk of output.
 */
export interface StreamDelta {
  /** Unique delta identity for idempotency */
  deltaId: string;
  /** The session context */
  sessionId: string;
  /** The turn context */
  turnId: string;
  /** Type of stream block */
  blockKind: StreamBlockKind;
  /** The content fragment */
  content: string;
  /** Block index within the stream (ordered) */
  blockIndex: number;
  /** Whether this is the final delta for this block */
  isFinal: boolean;
  /** Timestamp of delta creation */
  timestamp: string;
  /** Optional request identity for correlation */
  requestId?: string;
}

export type StreamBlockKind =
  | 'text_content'
  | 'code_content'
  | 'markdown_content'
  | 'reasoning'
  | 'tool_call_delta'
  | 'tool_call_completion';

// ─── Durable Partial Output Event ───────────────────────────────

/**
 * Canonical event payload for a durable partial output.
 * Persisted to Session_Log as the authoritative streaming record.
 */
export interface DurablePartialOutputPayload extends SessionEventPayloadV1 {
  type: 'session.partial_output';
  /** Stable key for the node this partial belongs to */
  stableKey: string;
  /** Monotonic content revision (within the stableKey) */
  contentRevision: number;
  /** The block kind being streamed */
  blockKind: StreamBlockKind;
  /** Accumulated content up to this revision */
  accumulatedContent: string;
  /** Block index in the turn's output sequence */
  blockIndex: number;
  /** Whether this revision represents the final content */
  isFinal: boolean;
  /** Turn identity for correlation */
  turnId: string;
  /** Source delta ID(s) that produced this revision */
  sourceDeltaIds: string[];
  /** Timestamp of the durable event */
  occurredAt: string;
}

// ─── Transient Cache ────────────────────────────────────────────

/**
 * Key for the transient streaming cache.
 * Composed of stableKey + contentRevision for unique addressing.
 */
export interface TransientCacheKey {
  stableKey: string;
  contentRevision: number;
}

/**
 * Transient cache entry for immediate display.
 * Invalidated once the durable projection confirms the same revision.
 */
export interface TransientCacheEntry {
  /** Cache key */
  key: TransientCacheKey;
  /** Current accumulated content for display */
  content: string;
  /** Block kind */
  blockKind: StreamBlockKind;
  /** Block index */
  blockIndex: number;
  /** Whether invalidated by projection */
  invalidated: boolean;
  /** Timestamp of last update */
  updatedAt: string;
  /** Source delta IDs */
  sourceDeltaIds: string[];
}

// ─── Projected Partial Output ───────────────────────────────────

/**
 * A projected partial output from Projection_Service.
 * When received, the corresponding transient cache entry is invalidated.
 */
export interface ProjectedPartialOutput {
  /** The stable key */
  stableKey: string;
  /** The content revision that was projected */
  contentRevision: number;
  /** Projected content (authoritative) */
  content: string;
  /** Projection revision for ordering */
  projectionRevision: number;
}

// ─── Adapter Configuration ──────────────────────────────────────

export interface StreamingStateAdapterConfig {
  /** Session ID being adapted */
  sessionId: string;
  /** Branch ID (defaults to 'main') */
  branchId?: string;
  /** Maximum transient cache entries before eviction of oldest */
  maxCacheEntries?: number;
  /** Whether durable write is enabled (false = shadow/dry-run) */
  durableWriteEnabled: boolean;
}

// ─── Adapter Statistics ─────────────────────────────────────────

export interface StreamingAdapterStats {
  sessionId: string;
  branchId: string;
  deltasIngested: number;
  durableEventsProduced: number;
  cacheEntries: number;
  cacheInvalidations: number;
  recoveryRestores: number;
}

// ─── Streaming State Adapter ────────────────────────────────────

/**
 * StreamingStateAdapter converts provider/runtime streaming deltas into
 * durable partial-output events for Session_Log. It maintains a transient
 * cache for immediate display that is invalidated once the durable projection
 * confirms.
 *
 * Usage:
 * 1. Ingest stream deltas via `ingestDelta()`
 * 2. Read transient cache for immediate display via `getTransientContent()`
 * 3. When Projection_Service confirms, call `onProjectionConfirmed()`
 * 4. During recovery, use `recoverFromDurable()` instead of the transient cache
 */
export class StreamingStateAdapter {
  private readonly config: StreamingStateAdapterConfig;

  /** Transient cache keyed by `${stableKey}:${contentRevision}` */
  private readonly cache = new Map<string, TransientCacheEntry>();

  /** Current content revision per stableKey (monotonically increasing) */
  private readonly revisions = new Map<string, number>();

  /** Accumulated content per stableKey (built from deltas) */
  private readonly accumulators = new Map<string, string>();

  /** Produced durable events (for inspection/writing) */
  private readonly durableEvents: DurablePartialOutputPayload[] = [];

  /** Statistics */
  private deltasIngested = 0;
  private durableEventsProduced = 0;
  private cacheInvalidations = 0;
  private recoveryRestores = 0;

  constructor(config: StreamingStateAdapterConfig) {
    this.config = config;
  }

  /**
   * Ingest a stream delta from the provider/runtime.
   *
   * Produces a durable partial-output event and updates the transient cache.
   * Returns the durable event payload suitable for Session_Log append.
   */
  ingestDelta(delta: StreamDelta): DurablePartialOutputPayload {
    if (delta.sessionId !== this.config.sessionId) {
      throw new Error(
        `Delta session mismatch: expected ${this.config.sessionId}, got ${delta.sessionId}`
      );
    }

    this.deltasIngested++;

    // Build stable key from turn + block identity
    const stableKey = this.buildStableKey(delta);

    // Increment revision
    const currentRevision = (this.revisions.get(stableKey) ?? 0) + 1;
    this.revisions.set(stableKey, currentRevision);

    // Accumulate content
    const previousContent = this.accumulators.get(stableKey) ?? '';
    const accumulatedContent = previousContent + delta.content;
    this.accumulators.set(stableKey, accumulatedContent);

    // Build durable event
    const durablePayload: DurablePartialOutputPayload = {
      type: 'session.partial_output',
      stableKey,
      contentRevision: currentRevision,
      blockKind: delta.blockKind,
      accumulatedContent,
      blockIndex: delta.blockIndex,
      isFinal: delta.isFinal,
      turnId: delta.turnId,
      sourceDeltaIds: [delta.deltaId],
      occurredAt: delta.timestamp,
    };

    if (this.config.durableWriteEnabled) {
      this.durableEvents.push(durablePayload);
      this.durableEventsProduced++;
    }

    // Update transient cache
    const cacheKeyStr = this.buildCacheKeyString(stableKey, currentRevision);
    const cacheEntry: TransientCacheEntry = {
      key: { stableKey, contentRevision: currentRevision },
      content: accumulatedContent,
      blockKind: delta.blockKind,
      blockIndex: delta.blockIndex,
      invalidated: false,
      updatedAt: delta.timestamp,
      sourceDeltaIds: [delta.deltaId],
    };
    this.cache.set(cacheKeyStr, cacheEntry);

    // Evict old entries if over limit
    this.evictIfNeeded();

    // Clear the final block's accumulator if complete
    if (delta.isFinal) {
      this.accumulators.delete(stableKey);
    }

    return durablePayload;
  }

  /**
   * Get the current transient content for a stableKey.
   * Returns the latest non-invalidated entry or null if none available.
   */
  getTransientContent(stableKey: string): TransientCacheEntry | null {
    const currentRevision = this.revisions.get(stableKey);
    if (currentRevision === undefined) {
      return null;
    }

    // Walk backward to find the latest non-invalidated entry
    for (let rev = currentRevision; rev >= 1; rev--) {
      const keyStr = this.buildCacheKeyString(stableKey, rev);
      const entry = this.cache.get(keyStr);
      if (entry && !entry.invalidated) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Called when Projection_Service confirms a durable partial output.
   * Invalidates the corresponding transient cache entry — the projected
   * value becomes authoritative.
   */
  onProjectionConfirmed(projected: ProjectedPartialOutput): void {
    const keyStr = this.buildCacheKeyString(
      projected.stableKey,
      projected.contentRevision
    );
    const entry = this.cache.get(keyStr);
    if (entry && !entry.invalidated) {
      entry.invalidated = true;
      this.cacheInvalidations++;
    }

    // Also invalidate all earlier revisions for the same stableKey
    for (let rev = projected.contentRevision - 1; rev >= 1; rev--) {
      const olderKeyStr = this.buildCacheKeyString(projected.stableKey, rev);
      const olderEntry = this.cache.get(olderKeyStr);
      if (olderEntry && !olderEntry.invalidated) {
        olderEntry.invalidated = true;
        this.cacheInvalidations++;
      }
    }
  }

  /**
   * Recover partial output from durable records (for reconnection/recovery).
   * This replaces the transient cache with authoritative projected state.
   * The transient cache is NOT used for recovery — only durable records.
   */
  recoverFromDurable(durableRecords: ProjectedPartialOutput[]): Map<string, string> {
    this.recoveryRestores++;
    const recovered = new Map<string, string>();

    for (const record of durableRecords) {
      recovered.set(record.stableKey, record.content);
      // Update internal revision tracking to match durable state
      const existingRevision = this.revisions.get(record.stableKey) ?? 0;
      if (record.contentRevision > existingRevision) {
        this.revisions.set(record.stableKey, record.contentRevision);
      }
    }

    return recovered;
  }

  /**
   * Get all produced durable event payloads (for Session_Log writing).
   * Returns events in order of production.
   */
  getDurableEvents(): readonly DurablePartialOutputPayload[] {
    return this.durableEvents;
  }

  /**
   * Get the latest durable event for a stableKey.
   */
  getLatestDurableEvent(stableKey: string): DurablePartialOutputPayload | null {
    for (let i = this.durableEvents.length - 1; i >= 0; i--) {
      if (this.durableEvents[i].stableKey === stableKey) {
        return this.durableEvents[i];
      }
    }
    return null;
  }

  /**
   * Check whether a stableKey's transient cache is fully invalidated
   * (i.e., projection has confirmed all content and is authoritative).
   */
  isFullyProjected(stableKey: string): boolean {
    const currentRevision = this.revisions.get(stableKey);
    if (currentRevision === undefined) {
      return false;
    }

    for (let rev = 1; rev <= currentRevision; rev++) {
      const keyStr = this.buildCacheKeyString(stableKey, rev);
      const entry = this.cache.get(keyStr);
      if (entry && !entry.invalidated) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get redacted adapter statistics.
   */
  getStats(): StreamingAdapterStats {
    return {
      sessionId: this.config.sessionId,
      branchId: this.config.branchId ?? 'main',
      deltasIngested: this.deltasIngested,
      durableEventsProduced: this.durableEventsProduced,
      cacheEntries: this.cache.size,
      cacheInvalidations: this.cacheInvalidations,
      recoveryRestores: this.recoveryRestores,
    };
  }

  /**
   * Reset the adapter state (for new streaming sessions or tests).
   */
  reset(): void {
    this.cache.clear();
    this.revisions.clear();
    this.accumulators.clear();
    this.durableEvents.length = 0;
    this.deltasIngested = 0;
    this.durableEventsProduced = 0;
    this.cacheInvalidations = 0;
    this.recoveryRestores = 0;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Build a stable key from delta context.
   * Uses turnId + blockKind + blockIndex to uniquely identify a streaming node.
   */
  private buildStableKey(delta: StreamDelta): string {
    return `${delta.turnId}:${delta.blockKind}:${delta.blockIndex}`;
  }

  /**
   * Build a string key for the transient cache map.
   */
  private buildCacheKeyString(stableKey: string, contentRevision: number): string {
    return `${stableKey}:rev${contentRevision}`;
  }

  /**
   * Evict oldest entries if cache exceeds configured maximum.
   */
  private evictIfNeeded(): void {
    const maxEntries = this.config.maxCacheEntries ?? 1000;
    if (this.cache.size <= maxEntries) {
      return;
    }

    // Evict invalidated entries first, then oldest entries
    const invalidated: string[] = [];
    const valid: string[] = [];

    for (const [key, entry] of this.cache) {
      if (entry.invalidated) {
        invalidated.push(key);
      } else {
        valid.push(key);
      }
    }

    // Remove all invalidated first
    for (const key of invalidated) {
      this.cache.delete(key);
      if (this.cache.size <= maxEntries) return;
    }

    // If still over limit, evict oldest valid entries
    const toEvict = this.cache.size - maxEntries;
    let evicted = 0;
    for (const key of valid) {
      if (evicted >= toEvict) break;
      this.cache.delete(key);
      evicted++;
    }
  }
}
