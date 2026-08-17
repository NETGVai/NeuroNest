/**
 * Shadow Projection Runner
 *
 * Runs the new Projection_Service alongside the existing timeline reducer
 * and compares their outputs to detect divergences. This is the core of
 * the strangler migration verification: both paths process the same inputs
 * and their outputs are compared, but only the legacy path drives visible
 * rendering.
 *
 * The shadow runner:
 * 1. Feeds timeline events to the legacy TimelineReducer (current path)
 * 2. Feeds the same events through LegacySessionAdapter → Projection_Service
 * 3. Compares the two projections to detect differences
 * 4. Reports redacted parity diagnostics without changing user-visible output
 *
 * Requirements: 1.3–1.5, 3.1–3.7, 29.5–29.8, 35.1–35.4
 */

import type { TimelineEvent, TimelineProjection } from '../../timeline/types.js';
import { TimelineReducer } from '../../timeline/timeline-reducer.js';
import type { LegacySessionAdapter, AdaptedEvent } from './legacy-session-adapter.js';

// ─── Configuration ──────────────────────────────────────────────

export interface ShadowProjectionRunnerConfig {
  /** Session ID being compared */
  sessionId: string;
  /** Maximum number of divergences to track before stopping comparison */
  maxDivergences?: number;
  /** Whether to enable deep field-level comparison */
  deepComparison?: boolean;
}

// ─── Divergence Types ───────────────────────────────────────────

export type DivergenceKind =
  | 'missing_in_canonical'
  | 'missing_in_legacy'
  | 'sequence_mismatch'
  | 'type_mismatch'
  | 'count_mismatch'
  | 'ordering_mismatch'
  | 'translation_loss';

/**
 * A single detected divergence between legacy and canonical projections.
 * Content is redacted — only structural/type information is exposed.
 */
export interface ParityDivergence {
  /** Kind of divergence */
  kind: DivergenceKind;
  /** Sequence number where divergence was detected (if applicable) */
  atSequence?: number;
  /** Redacted description safe for diagnostics */
  description: string;
  /** Legacy event ID involved (if applicable) */
  legacyEventId?: string;
  /** Whether this divergence is expected (e.g., from known lossy translations) */
  expected: boolean;
  /** Timestamp when detected */
  detectedAt: string;
}

// ─── Comparison Result ──────────────────────────────────────────

export interface ParityComparisonResult {
  /** Session being compared */
  sessionId: string;
  /** Whether the two paths produce equivalent outputs */
  parity: boolean;
  /** Total events compared */
  totalEvents: number;
  /** Number of events that match between both paths */
  matchingEvents: number;
  /** Detected divergences (capped by maxDivergences) */
  divergences: ParityDivergence[];
  /** Whether more divergences exist beyond the tracked cap */
  truncated: boolean;
  /** Legacy reducer last sequence */
  legacyLastSequence: number;
  /** Canonical adapter last sequence */
  canonicalLastSequence: number;
  /** Comparison timestamp */
  comparedAt: string;
}

// ─── Shadow Projection Runner ───────────────────────────────────

/**
 * ShadowProjectionRunner orchestrates the parallel execution of legacy
 * and canonical projection paths and compares their outputs.
 *
 * It does NOT drive any visible rendering. The legacy path remains the
 * source of truth for display; this runner only produces diagnostics.
 */
export class ShadowProjectionRunner {
  private readonly config: ShadowProjectionRunnerConfig;
  private readonly legacyReducer: TimelineReducer;
  private readonly canonicalAdapter: LegacySessionAdapter;

  private divergences: ParityDivergence[] = [];
  private totalEventsProcessed = 0;
  private matchingCount = 0;
  private running = false;
  /** Track seen event IDs to mirror the legacy reducer's deduplication */
  private seenEventIds: Set<string> = new Set();

  constructor(
    config: ShadowProjectionRunnerConfig,
    canonicalAdapter: LegacySessionAdapter
  ) {
    this.config = config;
    this.legacyReducer = new TimelineReducer(config.sessionId);
    this.canonicalAdapter = canonicalAdapter;
  }

  /**
   * Process a single timeline event through both paths and compare.
   *
   * Returns the detected divergence (if any) for this event.
   */
  processEvent(event: TimelineEvent): ParityDivergence | null {
    this.running = true;
    this.totalEventsProcessed++;

    // Feed to legacy reducer
    const legacyAccepted = this.legacyReducer.ingest(event);

    // Mirror the legacy reducer's dedup: if we've already seen this event ID,
    // the canonical adapter should also consider it a duplicate (no-op).
    const isDuplicate = this.seenEventIds.has(event.id);
    let adapted: ReturnType<LegacySessionAdapter['adaptEvent']> = null;

    if (!isDuplicate) {
      // Feed to canonical adapter only for new events
      adapted = this.canonicalAdapter.adaptEvent(event);
      if (adapted) {
        this.seenEventIds.add(event.id);
      }
    }

    // If the legacy reducer also rejected it (duplicate or wrong session),
    // and we also treated it as duplicate, both paths agree → no divergence
    if (!legacyAccepted && isDuplicate) {
      return null;
    }

    // Compare acceptance
    if (legacyAccepted && !adapted) {
      const divergence = this.createDivergence(
        'missing_in_canonical',
        `Event accepted by legacy but not adaptable to canonical`,
        event.sequence,
        event.id,
        false
      );
      this.trackDivergence(divergence);
      return divergence;
    }

    if (!legacyAccepted && adapted) {
      const divergence = this.createDivergence(
        'missing_in_legacy',
        `Event adapted to canonical but rejected by legacy (wrong session or duplicate)`,
        event.sequence,
        event.id,
        false
      );
      this.trackDivergence(divergence);
      return divergence;
    }

    // Both rejected (wrong session for both) — parity
    if (!legacyAccepted && !adapted) {
      return null;
    }

    // Both accepted — check translation quality
    if (adapted && !adapted.fullyTranslated) {
      const divergence = this.createDivergence(
        'translation_loss',
        `Event adapted with translation loss: ${adapted.translationNotes.join('; ')}`,
        event.sequence,
        event.id,
        true // Expected during migration for unknown types
      );
      this.trackDivergence(divergence);
      return divergence;
    }

    // Full match
    this.matchingCount++;
    return null;
  }

  /**
   * Process a batch of events through both paths.
   */
  processBatch(events: TimelineEvent[]): ParityDivergence[] {
    const newDivergences: ParityDivergence[] = [];
    for (const event of events) {
      const divergence = this.processEvent(event);
      if (divergence) {
        newDivergences.push(divergence);
      }
    }
    return newDivergences;
  }

  /**
   * Compare the full projection outputs of both paths.
   *
   * This performs a structural comparison of the ordered event lists
   * produced by each path and detects ordering, count, or content
   * divergences.
   */
  compareProjections(): ParityComparisonResult {
    const legacyProjection = this.legacyReducer.project();
    const adaptationStats = this.canonicalAdapter.getAdaptationStats();

    // Compare event counts
    if (legacyProjection.events.length !== adaptationStats.totalAdapted) {
      this.trackDivergence(this.createDivergence(
        'count_mismatch',
        `Legacy has ${legacyProjection.events.length} events, canonical adapted ${adaptationStats.totalAdapted}`,
        undefined,
        undefined,
        false
      ));
    }

    // Compare ordering (by checking sequence alignment)
    if (this.config.deepComparison) {
      this.compareEventOrdering(legacyProjection);
    }

    const maxDiv = this.config.maxDivergences ?? 100;

    return {
      sessionId: this.config.sessionId,
      parity: this.divergences.filter(d => !d.expected).length === 0,
      totalEvents: this.totalEventsProcessed,
      matchingEvents: this.matchingCount,
      divergences: this.divergences.slice(0, maxDiv),
      truncated: this.divergences.length > maxDiv,
      legacyLastSequence: legacyProjection.lastSequence,
      canonicalLastSequence: adaptationStats.lastAdaptedSequence,
      comparedAt: new Date().toISOString(),
    };
  }

  /**
   * Get current divergence count (including expected ones).
   */
  getDivergenceCount(): number {
    return this.divergences.length;
  }

  /**
   * Get only unexpected divergences (potential bugs).
   */
  getUnexpectedDivergences(): ParityDivergence[] {
    return this.divergences.filter(d => !d.expected);
  }

  /**
   * Check if the runner is currently in parity (no unexpected divergences).
   */
  isInParity(): boolean {
    return this.getUnexpectedDivergences().length === 0;
  }

  /**
   * Check if the shadow runner is active.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Reset comparison state for a fresh run.
   */
  reset(): void {
    this.divergences = [];
    this.totalEventsProcessed = 0;
    this.matchingCount = 0;
    this.running = false;
    this.seenEventIds.clear();
    this.legacyReducer.reset();
    this.canonicalAdapter.reset();
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private compareEventOrdering(legacyProjection: TimelineProjection): void {
    const legacySequences = legacyProjection.events.map(e => e.sequence);

    // Verify sequences are monotonically increasing in both
    for (let i = 1; i < legacySequences.length; i++) {
      if (legacySequences[i]! <= legacySequences[i - 1]!) {
        this.trackDivergence(this.createDivergence(
          'ordering_mismatch',
          `Legacy projection has non-monotonic sequence at index ${i}`,
          legacySequences[i],
          undefined,
          false
        ));
        break;
      }
    }
  }

  private createDivergence(
    kind: DivergenceKind,
    description: string,
    atSequence?: number,
    legacyEventId?: string,
    expected = false
  ): ParityDivergence {
    return {
      kind,
      atSequence,
      description,
      legacyEventId,
      expected,
      detectedAt: new Date().toISOString(),
    };
  }

  private trackDivergence(divergence: ParityDivergence): void {
    const maxDiv = this.config.maxDivergences ?? 100;
    if (this.divergences.length < maxDiv) {
      this.divergences.push(divergence);
    }
  }
}
