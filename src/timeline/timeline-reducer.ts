/**
 * TimelineReducer — deterministic convergent reduction of timeline events.
 *
 * Takes any delivery order of deduplicated sequenced events and produces
 * the same final timeline projection regardless of arrival order.
 *
 * Handles out-of-order delivery, late arrivals, and duplicate transports.
 * Converges to a deterministic final state by sorting on sequence number.
 *
 * Requirements: 15.6, 15.7
 */

import type { TimelineEvent, TimelineProjection } from './types.js';

/**
 * TimelineReducer accepts events in any order and produces a convergent
 * timeline projection sorted by sequence number.
 *
 * The core invariant: given the same set of unique events (identified by ID),
 * regardless of the order they are fed into the reducer, the final projection
 * is identical.
 */
export class TimelineReducer {
  /** Internal event map keyed by event ID for deduplication */
  private eventMap: Map<string, TimelineEvent> = new Map();
  /** Session ID this reducer operates on */
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Ingest an event. Duplicates (same ID) are silently ignored.
   * Events may arrive in any order.
   *
   * Returns true if the event was new, false if it was a duplicate.
   */
  ingest(event: TimelineEvent): boolean {
    if (event.sessionId !== this.sessionId) {
      return false;
    }

    if (this.eventMap.has(event.id)) {
      return false; // duplicate transport
    }

    this.eventMap.set(event.id, event);
    return true;
  }

  /**
   * Ingest multiple events at once. Returns the count of new events accepted.
   */
  ingestBatch(events: TimelineEvent[]): number {
    let accepted = 0;
    for (const event of events) {
      if (this.ingest(event)) {
        accepted++;
      }
    }
    return accepted;
  }

  /**
   * Produce the final timeline projection.
   *
   * The projection is deterministically sorted by sequence number.
   * For events with equal sequence (which shouldn't normally happen),
   * we fall back to stable ID comparison for determinism.
   *
   * This is the convergent output — any permutation of the same input
   * events produces the same projection.
   */
  project(): TimelineProjection {
    const events = Array.from(this.eventMap.values());

    // Deterministic sort: primary by sequence, secondary by ID for stability
    events.sort((a, b) => {
      if (a.sequence !== b.sequence) {
        return a.sequence - b.sequence;
      }
      return a.id.localeCompare(b.id);
    });

    const lastSequence = events.length > 0
      ? events[events.length - 1]!.sequence
      : -1;

    return {
      sessionId: this.sessionId,
      events,
      lastSequence,
    };
  }

  /**
   * Get the number of unique events currently held.
   */
  getEventCount(): number {
    return this.eventMap.size;
  }

  /**
   * Check if a specific event ID has been ingested.
   */
  hasEvent(eventId: string): boolean {
    return this.eventMap.has(eventId);
  }

  /**
   * Reset the reducer state.
   */
  reset(): void {
    this.eventMap.clear();
  }
}
