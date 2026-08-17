/**
 * Trajectory Projector — Projects durable trajectory records into compact summaries.
 *
 * Responsibilities:
 * - Render one keyed summary per durable entity identity (deduplicated)
 * - Derive state exclusively from durable Session_Log and owning-service records
 * - Never infer completion from incomplete or incompatible records
 * - Preserve last verified nonterminal state when records are incomplete
 * - Cancellation remains pending (nonterminal) until owning authority's terminal projection arrives
 * - Update keyed summaries without changing the reader's Semantic_Anchor
 *
 * Requirements: 42.1–42.3, 42.8–42.14
 */

import type {
  TrajectorySummaryV1,
  TrajectoryProjectionV1,
  TrajectoryEntityKind,
  TrajectoryEntityState,
  ProgressIndicator,
  ResultInjectionStatus,
  CancellationAvailability,
  UnavailableReason,
} from './trajectory-schemas';
import { isTerminalState } from './trajectory-schemas';

// ─── Input Types ────────────────────────────────────────────────

/**
 * Raw trajectory record from durable projection data source.
 * This is the minimal data needed to build a summary.
 */
export interface RawTrajectoryRecord {
  /** Durable entity identity — the deduplication key. */
  entityId: string;
  /** Entity kind. */
  entityKind: TrajectoryEntityKind;
  /** Current lifecycle state as projected by owning authority. */
  state: TrajectoryEntityState;
  /** Owner identity. */
  owner: string;
  /** Progress indicator (optional). */
  progress?: ProgressIndicator;
  /** Terminal outcome label when state is terminal. */
  terminalOutcome?: string;
  /** Result injection status when applicable. */
  resultInjectionStatus?: ResultInjectionStatus;
  /** Whether cancellation is available for this entity. */
  cancellationAvailable: boolean;
  /** Authority that owns cancellation routing. */
  cancellationAuthority: string;
  /** Reason cancellation is unavailable. */
  cancellationUnavailableReason?: string;
  /** Content revision for this record. */
  contentRevision: number;
  /** Source sequence that produced this record. */
  sourceSequence: number;
  /** Timestamp of last verified state. */
  lastVerifiedAt: string;
  /** Whether the record is from a complete projection. */
  projectionComplete: boolean;
  /** Schema version compatibility flag. */
  schemaCompatible: boolean;
}

// ─── Projector Configuration ────────────────────────────────────

export interface TrajectoryProjectorConfig {
  /** Maximum summaries to include in a single projection. Default: 100. */
  maxSummaries: number;
}

const DEFAULT_CONFIG: TrajectoryProjectorConfig = {
  maxSummaries: 100,
};

// ─── Trajectory Projector ───────────────────────────────────────

/**
 * Projects raw trajectory records into a deduplicated, keyed summary projection.
 *
 * Algorithm:
 * 1. Deduplicate by entityId — latest contentRevision wins
 * 2. Validate each record for completeness and compatibility
 * 3. For incomplete/incompatible records, preserve last verified nonterminal state
 * 4. For cancelling entities, keep nonterminal until a terminal projection arrives
 * 5. Never infer success/completion from absence or incompleteness
 * 6. Bound output to configured maxSummaries
 */
export class TrajectoryProjector {
  private readonly config: TrajectoryProjectorConfig;

  constructor(config: Partial<TrajectoryProjectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Project raw trajectory records into a TrajectoryProjectionV1.
   *
   * Requirements:
   * - 42.1: One compact inline summary per durable entity identity
   * - 42.9: Update keyed summary without changing anchor
   * - 42.11: Incomplete/incompatible records show last verified + unavailable reason
   * - 42.12: One keyed summary for repeated compatible records referencing one entity
   * - 42.13: Cancellation stays nonterminal until owning authority provides terminal state
   * - 42.14: Failures preserve last verified state without inferring completion
   */
  project(
    records: readonly RawTrajectoryRecord[],
    sessionId: string,
    projectionRevision: number,
  ): TrajectoryProjectionV1 {
    if (records.length === 0) {
      return {
        sessionId,
        summaries: [],
        projectionRevision,
        sourceSequenceStart: 0,
        sourceSequenceEnd: 0,
        schemaVersion: 1,
      };
    }

    // 1. Deduplicate by entityId — latest contentRevision wins (Req 42.12)
    const deduped = this.deduplicateByEntity(records);

    // 2. Build summaries with verified-state-only derivation
    const summaries: TrajectorySummaryV1[] = [];

    for (const record of deduped) {
      const summary = this.buildSummary(record);
      summaries.push(summary);
    }

    // 3. Bound to configured maxSummaries
    const bounded = summaries.slice(0, this.config.maxSummaries);

    // 4. Compute source sequence range
    const sequences = deduped.map((r) => r.sourceSequence);
    const sourceSequenceStart = Math.min(...sequences);
    const sourceSequenceEnd = Math.max(...sequences);

    return {
      sessionId,
      summaries: bounded,
      projectionRevision,
      sourceSequenceStart,
      sourceSequenceEnd,
      schemaVersion: 1,
    };
  }

  /**
   * Deduplicate records by entityId. For repeated compatible records referencing
   * the same entity identity and revision, only one summary is produced.
   * The record with the highest contentRevision wins.
   *
   * Requirement 42.12
   */
  private deduplicateByEntity(records: readonly RawTrajectoryRecord[]): RawTrajectoryRecord[] {
    const entityMap = new Map<string, RawTrajectoryRecord>();

    for (const record of records) {
      const existing = entityMap.get(record.entityId);
      if (!existing || record.contentRevision > existing.contentRevision) {
        entityMap.set(record.entityId, record);
      }
    }

    // Sort by sourceSequence for stable ordering
    return [...entityMap.values()].sort((a, b) => a.sourceSequence - b.sourceSequence);
  }

  /**
   * Build a single summary from a raw record.
   *
   * Key invariants:
   * - Never infer completion from incomplete records (Req 42.11)
   * - Cancellation remains nonterminal until terminal projection (Req 42.13)
   * - Failures preserve last verified state (Req 42.14)
   */
  private buildSummary(record: RawTrajectoryRecord): TrajectorySummaryV1 {
    // Determine effective state and unavailable reason
    const { effectiveState, unavailableReason } = this.resolveEffectiveState(record);

    const cancellation: CancellationAvailability = {
      available: record.cancellationAvailable && !isTerminalState(effectiveState),
      authority: record.cancellationAuthority,
      unavailableReason: this.resolveCancellationReason(record, effectiveState),
    };

    return {
      entityId: record.entityId,
      entityKind: record.entityKind,
      state: effectiveState,
      owner: record.owner,
      progress: record.progress,
      terminalOutcome: isTerminalState(effectiveState) ? record.terminalOutcome : undefined,
      resultInjectionStatus: record.resultInjectionStatus,
      cancellation,
      contentRevision: record.contentRevision,
      sourceSequence: record.sourceSequence,
      lastVerifiedAt: record.lastVerifiedAt,
      unavailableReason,
      schemaVersion: 1,
    };
  }

  /**
   * Resolve the effective state based on record completeness and compatibility.
   *
   * CRITICAL: Never infer success/completion from incomplete or incompatible records.
   * - If projection is incomplete → preserve last verified nonterminal state
   * - If schema is incompatible → show last verified state + unavailable reason
   * - If cancelling → remain nonterminal until terminal projection arrives
   */
  private resolveEffectiveState(record: RawTrajectoryRecord): {
    effectiveState: TrajectoryEntityState;
    unavailableReason?: UnavailableReason;
  } {
    // Incompatible schema — cannot trust the state, show as last verified nonterminal
    if (!record.schemaCompatible) {
      return {
        effectiveState: this.safeNonterminalState(record.state),
        unavailableReason: {
          kind: 'incompatible',
          message: 'Trajectory record schema is incompatible with current projection version',
          lastVerifiedRevision: record.contentRevision,
          lastVerifiedAt: record.lastVerifiedAt,
        },
      };
    }

    // Incomplete projection — never infer completion
    if (!record.projectionComplete) {
      // If record claims terminal but projection is incomplete, do NOT trust it
      if (isTerminalState(record.state)) {
        return {
          effectiveState: this.safeNonterminalState(record.state),
          unavailableReason: {
            kind: 'incomplete',
            message: 'Trajectory projection is incomplete; terminal state not verified',
            lastVerifiedRevision: record.contentRevision,
            lastVerifiedAt: record.lastVerifiedAt,
          },
        };
      }
      // Nonterminal state from incomplete projection is safe to show
      return { effectiveState: record.state };
    }

    // Complete and compatible — use the projected state directly
    return { effectiveState: record.state };
  }

  /**
   * Map a potentially-terminal state back to a safe nonterminal representation.
   * Used when we cannot verify that a terminal state is accurate.
   *
   * Requirement 42.11: Display last verified revision without inferring success
   */
  private safeNonterminalState(state: TrajectoryEntityState): TrajectoryEntityState {
    if (state === 'completed') return 'active';
    if (state === 'cancelled') return 'cancelling';
    if (state === 'failed' || state === 'interrupted') return 'active';
    return state;
  }

  /**
   * Determine the cancellation unavailable reason.
   * Requirements: 42.6
   */
  private resolveCancellationReason(
    record: RawTrajectoryRecord,
    effectiveState: TrajectoryEntityState,
  ): string | undefined {
    if (isTerminalState(effectiveState)) {
      return `Entity is in terminal state: ${effectiveState}`;
    }
    if (!record.cancellationAvailable) {
      return record.cancellationUnavailableReason ?? 'Cancellation not authorized for current actor';
    }
    return undefined;
  }
}
