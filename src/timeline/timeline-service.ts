/**
 * TimelineService — persists one monotonically sequenced stream of events
 * scoped by session and optional run.
 *
 * Each event has a stable ID, session ID, optional task/run IDs,
 * monotonically increasing sequence, event type, payload reference, and timestamp.
 *
 * Deduplicates by event ID (rejects duplicates) and ensures monotonic
 * sequence ordering within a session.
 *
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.7, 15.8, 15.9
 */

import type { TimelineEvent, TimelineEventType, TimelineQuery } from './types.js';

/** Result of attempting to append an event */
export type AppendResult =
  | { ok: true; event: TimelineEvent }
  | { ok: false; reason: 'duplicate' | 'sequence_violation' };

/**
 * TimelineService stores and retrieves ordered timeline events.
 *
 * Design invariants:
 * - At most one event per ID (deduplication)
 * - Sequence numbers are monotonically increasing within a session
 * - Events are scoped by session and optionally by run
 */
export class TimelineService {
  /** Events indexed by session ID, ordered by sequence */
  private sessionEvents: Map<string, TimelineEvent[]> = new Map();
  /** Set of all known event IDs for deduplication */
  private knownIds: Set<string> = new Set();
  /** Track the highest sequence per session */
  private sessionMaxSequence: Map<string, number> = new Map();

  /**
   * Append a new event to the timeline.
   *
   * Rejects duplicates (same event ID) and sequence violations
   * (sequence <= current max for the session).
   */
  append(event: TimelineEvent): AppendResult {
    // Deduplication check
    if (this.knownIds.has(event.id)) {
      return { ok: false, reason: 'duplicate' };
    }

    // Monotonic sequence check
    const currentMax = this.sessionMaxSequence.get(event.sessionId) ?? -1;
    if (event.sequence <= currentMax) {
      return { ok: false, reason: 'sequence_violation' };
    }

    // Store the event
    this.knownIds.add(event.id);
    this.sessionMaxSequence.set(event.sessionId, event.sequence);

    const events = this.getOrCreateSessionEvents(event.sessionId);
    events.push(event);

    return { ok: true, event };
  }

  /**
   * Query events for a session with optional run filtering and pagination.
   */
  query(query: TimelineQuery): TimelineEvent[] {
    const events = this.sessionEvents.get(query.sessionId);
    if (!events) {
      return [];
    }

    let result = events;

    // Filter by run if specified
    if (query.runId !== undefined) {
      result = result.filter((e) => e.runId === query.runId);
    }

    // Filter events after a given sequence number
    if (query.afterSequence !== undefined) {
      result = result.filter((e) => e.sequence > query.afterSequence!);
    }

    // Apply limit
    if (query.limit !== undefined && query.limit > 0) {
      result = result.slice(0, query.limit);
    }

    return result;
  }

  /**
   * Get the last sequence number for a session.
   * Returns -1 if no events exist for the session.
   */
  getLastSequence(sessionId: string): number {
    return this.sessionMaxSequence.get(sessionId) ?? -1;
  }

  /**
   * Check if an event ID already exists in the timeline.
   */
  hasEvent(eventId: string): boolean {
    return this.knownIds.has(eventId);
  }

  /**
   * Get the total number of events for a session.
   */
  getEventCount(sessionId: string): number {
    return this.sessionEvents.get(sessionId)?.length ?? 0;
  }

  /**
   * Get all session IDs that have events.
   */
  getSessionIds(): string[] {
    return Array.from(this.sessionEvents.keys());
  }

  /**
   * Clear all events for a session.
   */
  clearSession(sessionId: string): void {
    this.sessionEvents.delete(sessionId);
    this.sessionMaxSequence.delete(sessionId);
    // Note: we keep known IDs to prevent re-insertion of cleared events
  }

  // --- Private helpers ---

  private getOrCreateSessionEvents(sessionId: string): TimelineEvent[] {
    let events = this.sessionEvents.get(sessionId);
    if (!events) {
      events = [];
      this.sessionEvents.set(sessionId, events);
    }
    return events;
  }
}
