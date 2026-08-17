/**
 * Legacy Session Adapter
 *
 * Reads legacy session/timeline inputs through a compatibility adapter.
 * Translates TimelineEvent records from the existing timeline reducer/store
 * into canonical SessionEventV1 structures suitable for Session_Log.
 *
 * This adapter sits at the boundary between the legacy path (timeline reducer,
 * chat-timeline-store) and the new canonical event path (Session_Log,
 * Projection_Service). It does NOT mutate or replace the legacy rendering path;
 * the existing reducer continues to drive visible output.
 *
 * Requirements: 1.3–1.5, 3.1–3.7, 35.1–35.4
 */

import type { TimelineEvent, TimelineProjection } from '../../timeline/types.js';
import type { SessionEventV1, SessionEventPayloadV1 } from '../contracts/event.js';
import type { ActorRef } from '../contracts/actor.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';

// ─── Adapter Configuration ──────────────────────────────────────

export interface LegacySessionAdapterConfig {
  /** Session ID being adapted */
  sessionId: string;
  /** Branch ID (defaults to 'main') */
  branchId?: string;
  /** Actor representing the migration system */
  migrationActor: ActorRef;
  /** Scope for migrated events */
  scope: ScopeDescriptorV1;
}

// ─── Adapted Event ──────────────────────────────────────────────

/**
 * Result of adapting a legacy timeline event to canonical form.
 */
export interface AdaptedEvent {
  /** The canonical event payload derived from the legacy event */
  canonicalPayload: SessionEventPayloadV1;
  /** The canonical event type derived from the legacy type */
  canonicalEventType: string;
  /** Original legacy event for audit/parity comparison */
  legacyEvent: TimelineEvent;
  /** Whether this event could be fully translated (false = partial/lossy) */
  fullyTranslated: boolean;
  /** Diagnostic notes about the translation */
  translationNotes: string[];
}

// ─── Type Mapping ───────────────────────────────────────────────

/**
 * Maps legacy TimelineEventType to canonical event type identifiers.
 */
const LEGACY_TO_CANONICAL_TYPE: Record<string, string> = {
  message: 'session.message',
  tool_event: 'session.tool_call',
  approval: 'session.collaboration_decision',
  artifact: 'session.artifact_reference',
  change_set: 'session.change_set',
  evidence: 'session.evidence',
  run_transition: 'session.turn_transition',
  error: 'session.error',
};

// ─── Legacy Session Adapter ─────────────────────────────────────

/**
 * LegacySessionAdapter translates legacy timeline events into canonical
 * SessionEventV1 structures. It provides read-only compatibility between
 * the existing timeline path and the new Session_Log event path.
 *
 * Usage:
 * 1. Feed legacy events through `adaptEvent()` or `adaptBatch()`
 * 2. Receive canonical payloads suitable for Session_Log append
 * 3. Compare adapted output with Projection_Service output via ShadowProjectionRunner
 */
export class LegacySessionAdapter {
  private readonly config: LegacySessionAdapterConfig;
  private adaptedCount = 0;
  private partialCount = 0;
  private lastAdaptedSequence = -1;

  constructor(config: LegacySessionAdapterConfig) {
    this.config = config;
  }

  /**
   * Adapt a single legacy timeline event to canonical form.
   *
   * Returns the adapted payload or null if the event cannot be translated
   * (e.g., unknown event type with no reasonable mapping).
   */
  adaptEvent(event: TimelineEvent): AdaptedEvent | null {
    if (event.sessionId !== this.config.sessionId) {
      return null;
    }

    const canonicalType = LEGACY_TO_CANONICAL_TYPE[event.type];
    const translationNotes: string[] = [];
    let fullyTranslated = true;

    if (!canonicalType) {
      translationNotes.push(`Unknown legacy event type '${event.type}' mapped to generic`);
      fullyTranslated = false;
    }

    const effectiveType = canonicalType ?? 'session.unknown_legacy';

    const canonicalPayload: SessionEventPayloadV1 = {
      type: effectiveType,
      // Preserve the legacy payload reference for reconstruction
      legacyPayloadRef: event.payloadRef,
      legacyType: event.type,
      legacyId: event.id,
      legacyTimestamp: event.timestamp,
      collapsible: event.collapsible,
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    };

    this.adaptedCount++;
    if (!fullyTranslated) {
      this.partialCount++;
    }
    this.lastAdaptedSequence = Math.max(this.lastAdaptedSequence, event.sequence);

    return {
      canonicalPayload,
      canonicalEventType: effectiveType,
      legacyEvent: event,
      fullyTranslated,
      translationNotes,
    };
  }

  /**
   * Adapt a batch of legacy events in order.
   * Skips null results from events that cannot be adapted.
   */
  adaptBatch(events: TimelineEvent[]): AdaptedEvent[] {
    const results: AdaptedEvent[] = [];
    for (const event of events) {
      const adapted = this.adaptEvent(event);
      if (adapted) {
        results.push(adapted);
      }
    }
    return results;
  }

  /**
   * Adapt a full legacy TimelineProjection into a batch of canonical events.
   */
  adaptProjection(projection: TimelineProjection): AdaptedEvent[] {
    if (projection.sessionId !== this.config.sessionId) {
      return [];
    }
    return this.adaptBatch(projection.events);
  }

  /**
   * Get redacted statistics about adaptation progress.
   * Suitable for diagnostics without leaking content.
   */
  getAdaptationStats(): AdaptationStats {
    return {
      sessionId: this.config.sessionId,
      branchId: this.config.branchId ?? 'main',
      totalAdapted: this.adaptedCount,
      partiallyTranslated: this.partialCount,
      lastAdaptedSequence: this.lastAdaptedSequence,
      fullyTranslatedRatio: this.adaptedCount > 0
        ? (this.adaptedCount - this.partialCount) / this.adaptedCount
        : 1,
    };
  }

  /**
   * Get the migration actor used for adapted events.
   */
  getMigrationActor(): ActorRef {
    return this.config.migrationActor;
  }

  /**
   * Get the scope descriptor for adapted events.
   */
  getScope(): ScopeDescriptorV1 {
    return this.config.scope;
  }

  /**
   * Reset adapter statistics (useful for new comparison runs).
   */
  reset(): void {
    this.adaptedCount = 0;
    this.partialCount = 0;
    this.lastAdaptedSequence = -1;
  }
}

// ─── Types ──────────────────────────────────────────────────────

export interface AdaptationStats {
  sessionId: string;
  branchId: string;
  totalAdapted: number;
  partiallyTranslated: number;
  lastAdaptedSequence: number;
  fullyTranslatedRatio: number;
}
