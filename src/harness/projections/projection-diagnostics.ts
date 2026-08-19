import { z } from 'zod';

/** Version of the renderer/release-gate projection diagnostic contract. */
export const PROJECTION_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export const PROJECTION_DIAGNOSTIC_BOUND_NAMES = [
  'mountedNodeBound',
  'overscanAllowance',
  'focusRetentionAllowance',
  'pageSize',
  'updateRateMs',
  'viewportMarginPx',
  'previewSizeLimitBytes',
  'cancellationDeadlineMs',
  'latencyBudgetMs',
  'memoryBudgetBytes',
] as const;

export type ProjectionDiagnosticBoundName =
  typeof PROJECTION_DIAGNOSTIC_BOUND_NAMES[number];

export const PROJECTION_FAILURE_REASON_CODES = [
  'bounds_exceeded',
  'cancelled',
  'checkpoint_unavailable',
  'invalid_checkpoint_hash',
  'invalid_metric',
  'missing_bounds',
  'no_projection',
  'projection_failed',
  'query_failed',
  'stale_revision',
  'unsupported_schema',
] as const;

export type ProjectionFailureReasonCode =
  typeof PROJECTION_FAILURE_REASON_CODES[number];

export const ProjectionFailureReasonCodeSchema = z.enum(
  PROJECTION_FAILURE_REASON_CODES,
);

export const PROJECTION_BOUNDS_PROVENANCE = [
  'default',
  'global',
  'workspace',
  'project',
  'session',
  'last_valid',
] as const;

export type ProjectionBoundsProvenance =
  typeof PROJECTION_BOUNDS_PROVENANCE[number];

export interface ProjectionDiagnosticBoundsInput {
  readonly mountedNodeBound?: number;
  readonly overscanAllowance?: number;
  readonly focusRetentionAllowance?: number;
  readonly pageSize?: number;
  readonly updateRateMs?: number;
  readonly viewportMarginPx?: number;
  readonly previewSizeLimitBytes?: number;
  readonly cancellationDeadlineMs?: number;
  readonly latencyBudgetMs?: number;
  readonly memoryBudgetBytes?: number;
}

export interface ProjectionCoalescingObservationV1 {
  /** Number of durable deltas accepted by the projection. */
  readonly durableDeltaCount: number;
  /** Number of visual deltas actually published after coalescing. */
  readonly publishedDeltaCount: number;
  readonly flushCount: number;
  readonly cancelledDeltaCount: number;
}

/**
 * One metadata-only projection observation. Extra runtime properties are ignored
 * and operationId is used only for idempotent aggregation; neither is exported.
 */
export interface ProjectionDiagnosticObservationV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly projectionDurationMs: number;
  readonly projectionRevision: number;
  readonly sourceRevision: number;
  readonly sourceSequence: number;
  readonly checkpointHash: string | null;
  readonly pageCount: number;
  readonly nodeCount: number;
  readonly blockCount: number;
  readonly configuredBounds?: ProjectionDiagnosticBoundsInput;
  readonly effectiveBounds?: ProjectionDiagnosticBoundsInput;
  readonly boundsSourceRevision?: number;
  readonly boundsResolvedFrom?: ProjectionBoundsProvenance;
  readonly coalescing?: Partial<ProjectionCoalescingObservationV1>;
  readonly failureReason?: ProjectionFailureReasonCode;
  readonly cancelled?: boolean;
}

export interface ProjectionDiagnosticBoundsV1 {
  readonly configured: Readonly<Record<ProjectionDiagnosticBoundName, number | null>>;
  readonly effective: Readonly<Record<ProjectionDiagnosticBoundName, number | null>>;
  readonly sourceRevision: number | null;
  readonly resolvedFrom: ProjectionBoundsProvenance | 'unavailable';
  readonly missing: readonly ProjectionDiagnosticBoundName[];
}

export interface ProjectionFailureCountV1 {
  readonly reason: ProjectionFailureReasonCode;
  readonly count: number;
}

export interface ProjectionDiagnosticSnapshotV1 {
  readonly schemaVersion: 1;
  readonly status: 'ready' | 'degraded' | 'blocked' | 'cancelled' | 'unavailable';
  readonly observationCount: number;
  readonly projection: {
    readonly durationMs: number;
    readonly totalDurationMs: number;
    readonly averageDurationMs: number;
    readonly maximumDurationMs: number;
    readonly projectionRevision: number;
    readonly sourceRevision: number;
    readonly sourceSequence: number;
    readonly checkpointHash: string | null;
  };
  readonly counts: {
    readonly pageCount: number;
    readonly nodeCount: number;
    readonly blockCount: number;
  };
  readonly bounds: ProjectionDiagnosticBoundsV1;
  readonly coalescing: {
    readonly durableDeltaCount: number;
    readonly publishedDeltaCount: number;
    readonly coalescedDeltaCount: number;
    readonly flushCount: number;
    readonly cancelledDeltaCount: number;
  };
  readonly cancellationCount: number;
  readonly failures: readonly ProjectionFailureCountV1[];
}

interface SanitizedObservation {
  readonly operationId: string;
  readonly durationMs: number;
  readonly projectionRevision: number;
  readonly sourceRevision: number;
  readonly sourceSequence: number;
  readonly checkpointHash: string | null;
  readonly pageCount: number;
  readonly nodeCount: number;
  readonly blockCount: number;
  readonly configuredBounds: Readonly<Record<ProjectionDiagnosticBoundName, number | null>>;
  readonly effectiveBounds: Readonly<Record<ProjectionDiagnosticBoundName, number | null>>;
  readonly boundsSourceRevision: number | null;
  readonly boundsResolvedFrom: ProjectionBoundsProvenance | 'unavailable';
  readonly coalescing: ProjectionCoalescingObservationV1;
  readonly cancelled: boolean;
  readonly failures: readonly ProjectionFailureReasonCode[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BLOCKING_REASONS = new Set<ProjectionFailureReasonCode>([
  'bounds_exceeded',
  'invalid_checkpoint_hash',
  'invalid_metric',
  'missing_bounds',
  'stale_revision',
  'unsupported_schema',
]);

function safeNonnegative(value: unknown, integer: boolean, failures: Set<ProjectionFailureReasonCode>): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || (integer && !Number.isInteger(value))
  ) {
    failures.add('invalid_metric');
    return 0;
  }
  return value;
}

function safeSourceSequence(
  value: unknown,
  failures: Set<ProjectionFailureReasonCode>,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -1) {
    failures.add('invalid_metric');
    return 0;
  }
  return value;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  return Number.isFinite(total) ? total : Number.MAX_VALUE;
}

function sanitizeBounds(
  input: ProjectionDiagnosticBoundsInput | undefined,
  failures: Set<ProjectionFailureReasonCode>,
): Readonly<Record<ProjectionDiagnosticBoundName, number | null>> {
  const result = {} as Record<ProjectionDiagnosticBoundName, number | null>;
  for (const name of PROJECTION_DIAGNOSTIC_BOUND_NAMES) {
    const value = input?.[name];
    if (value === undefined) {
      result[name] = null;
    } else if (!Number.isFinite(value) || value < 0) {
      failures.add('invalid_metric');
      result[name] = null;
    } else {
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

function sanitizeObservation(raw: ProjectionDiagnosticObservationV1): SanitizedObservation {
  const failures = new Set<ProjectionFailureReasonCode>();
  if (raw.schemaVersion !== PROJECTION_DIAGNOSTIC_SCHEMA_VERSION) {
    failures.add('unsupported_schema');
  }
  if (
    raw.failureReason !== undefined
    && PROJECTION_FAILURE_REASON_CODES.includes(raw.failureReason)
  ) {
    failures.add(raw.failureReason);
  } else if (raw.failureReason !== undefined) {
    failures.add('unsupported_schema');
  }
  if (raw.cancelled === true) failures.add('cancelled');

  const configuredBounds = sanitizeBounds(raw.configuredBounds, failures);
  const effectiveBounds = sanitizeBounds(raw.effectiveBounds, failures);
  if (PROJECTION_DIAGNOSTIC_BOUND_NAMES.some(
    (name) => configuredBounds[name] === null || effectiveBounds[name] === null,
  )) {
    failures.add('missing_bounds');
  }

  let checkpointHash: string | null = null;
  if (raw.checkpointHash === null) {
    failures.add('checkpoint_unavailable');
  } else if (SHA256_PATTERN.test(raw.checkpointHash)) {
    checkpointHash = raw.checkpointHash;
  } else {
    failures.add('invalid_checkpoint_hash');
  }

  const durableDeltaCount = safeNonnegative(
    raw.coalescing?.durableDeltaCount ?? 0,
    true,
    failures,
  );
  const publishedDeltaCount = safeNonnegative(
    raw.coalescing?.publishedDeltaCount ?? 0,
    true,
    failures,
  );

  return Object.freeze({
    operationId: typeof raw.operationId === 'string' ? raw.operationId : '',
    durationMs: safeNonnegative(raw.projectionDurationMs, false, failures),
    projectionRevision: safeNonnegative(raw.projectionRevision, true, failures),
    sourceRevision: safeNonnegative(raw.sourceRevision, true, failures),
    sourceSequence: safeSourceSequence(raw.sourceSequence, failures),
    checkpointHash,
    pageCount: safeNonnegative(raw.pageCount, true, failures),
    nodeCount: safeNonnegative(raw.nodeCount, true, failures),
    blockCount: safeNonnegative(raw.blockCount, true, failures),
    configuredBounds,
    effectiveBounds,
    boundsSourceRevision: raw.boundsSourceRevision === undefined
      ? null
      : safeNonnegative(raw.boundsSourceRevision, true, failures),
    boundsResolvedFrom: PROJECTION_BOUNDS_PROVENANCE.includes(
      raw.boundsResolvedFrom as ProjectionBoundsProvenance,
    ) ? raw.boundsResolvedFrom as ProjectionBoundsProvenance : 'unavailable',
    coalescing: Object.freeze({
      durableDeltaCount,
      publishedDeltaCount,
      flushCount: safeNonnegative(raw.coalescing?.flushCount ?? 0, true, failures),
      cancelledDeltaCount: safeNonnegative(
        raw.coalescing?.cancelledDeltaCount ?? 0,
        true,
        failures,
      ),
    }),
    cancelled: raw.cancelled === true || raw.failureReason === 'cancelled',
    failures: Object.freeze([...failures].sort()),
  });
}

function compareObservations(left: SanitizedObservation, right: SanitizedObservation): number {
  return left.projectionRevision - right.projectionRevision
    || left.sourceRevision - right.sourceRevision
    || left.sourceSequence - right.sourceSequence
    || left.operationId.localeCompare(right.operationId);
}

function canonicalObservation(observation: SanitizedObservation): string {
  return JSON.stringify(observation);
}

function emptyBounds(): Readonly<Record<ProjectionDiagnosticBoundName, number | null>> {
  return Object.freeze(Object.fromEntries(
    PROJECTION_DIAGNOSTIC_BOUND_NAMES.map((name) => [name, null]),
  ) as Record<ProjectionDiagnosticBoundName, number | null>);
}

function deepFreezeSnapshot(snapshot: ProjectionDiagnosticSnapshotV1): ProjectionDiagnosticSnapshotV1 {
  Object.freeze(snapshot.projection);
  Object.freeze(snapshot.counts);
  Object.freeze(snapshot.bounds.configured);
  Object.freeze(snapshot.bounds.effective);
  Object.freeze(snapshot.bounds.missing);
  Object.freeze(snapshot.bounds);
  Object.freeze(snapshot.coalescing);
  for (const failure of snapshot.failures) Object.freeze(failure);
  Object.freeze(snapshot.failures);
  return Object.freeze(snapshot);
}

/**
 * Deterministically aggregate metadata-only observations into a V1 read model.
 * Ordering and duplicate delivery do not affect the resulting snapshot.
 */
export function aggregateProjectionDiagnostics(
  observations: readonly ProjectionDiagnosticObservationV1[],
): ProjectionDiagnosticSnapshotV1 {
  const byOperation = new Map<string, SanitizedObservation>();
  for (const raw of observations) {
    const candidate = sanitizeObservation(raw);
    const existing = byOperation.get(candidate.operationId);
    if (
      existing === undefined
      || compareObservations(existing, candidate) < 0
      || (
        compareObservations(existing, candidate) === 0
        && canonicalObservation(existing).localeCompare(canonicalObservation(candidate)) < 0
      )
    ) {
      byOperation.set(candidate.operationId, candidate);
    }
  }

  const ordered = [...byOperation.values()].sort(compareObservations);
  const latest = ordered.at(-1);
  const failureCounts = new Map<ProjectionFailureReasonCode, number>();

  let totalDurationMs = 0;
  let maximumDurationMs = 0;
  let cancellationCount = 0;
  let durableDeltaCount = 0;
  let publishedDeltaCount = 0;
  let flushCount = 0;
  let cancelledDeltaCount = 0;

  for (const observation of ordered) {
    totalDurationMs = safeAdd(totalDurationMs, observation.durationMs);
    maximumDurationMs = Math.max(maximumDurationMs, observation.durationMs);
    if (observation.cancelled) cancellationCount++;
    durableDeltaCount = safeAdd(
      durableDeltaCount,
      observation.coalescing.durableDeltaCount,
    );
    publishedDeltaCount = safeAdd(
      publishedDeltaCount,
      observation.coalescing.publishedDeltaCount,
    );
    flushCount = safeAdd(flushCount, observation.coalescing.flushCount);
    cancelledDeltaCount = safeAdd(
      cancelledDeltaCount,
      observation.coalescing.cancelledDeltaCount,
    );
    for (const reason of observation.failures) {
      failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
    }
  }

  if (latest === undefined) failureCounts.set('no_projection', 1);
  const failures = [...failureCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count } as const));
  const missing = latest === undefined
    ? [...PROJECTION_DIAGNOSTIC_BOUND_NAMES]
    : PROJECTION_DIAGNOSTIC_BOUND_NAMES.filter(
      (name) => latest.configuredBounds[name] === null || latest.effectiveBounds[name] === null,
    );

  let status: ProjectionDiagnosticSnapshotV1['status'];
  if (latest === undefined) {
    status = 'unavailable';
  } else if (latest.cancelled) {
    status = 'cancelled';
  } else if (failures.some(({ reason }) => BLOCKING_REASONS.has(reason))) {
    status = 'blocked';
  } else if (failures.length > 0) {
    status = 'degraded';
  } else {
    status = 'ready';
  }

  const configured = latest?.configuredBounds ?? emptyBounds();
  const effective = latest?.effectiveBounds ?? emptyBounds();
  const averageDurationMs = ordered.length === 0 ? 0 : totalDurationMs / ordered.length;

  return deepFreezeSnapshot({
    schemaVersion: PROJECTION_DIAGNOSTIC_SCHEMA_VERSION,
    status,
    observationCount: ordered.length,
    projection: {
      durationMs: latest?.durationMs ?? 0,
      totalDurationMs,
      averageDurationMs: Number.isFinite(averageDurationMs) ? averageDurationMs : 0,
      maximumDurationMs,
      projectionRevision: latest?.projectionRevision ?? 0,
      sourceRevision: latest?.sourceRevision ?? 0,
      sourceSequence: latest?.sourceSequence ?? 0,
      checkpointHash: latest?.checkpointHash ?? null,
    },
    counts: {
      pageCount: latest?.pageCount ?? 0,
      nodeCount: latest?.nodeCount ?? 0,
      blockCount: latest?.blockCount ?? 0,
    },
    bounds: {
      configured,
      effective,
      sourceRevision: latest?.boundsSourceRevision ?? null,
      resolvedFrom: latest?.boundsResolvedFrom ?? 'unavailable',
      missing: Object.freeze(missing),
    },
    coalescing: {
      durableDeltaCount,
      publishedDeltaCount,
      coalescedDeltaCount: Math.max(0, durableDeltaCount - publishedDeltaCount),
      flushCount,
      cancelledDeltaCount,
    },
    cancellationCount,
    failures,
  });
}

/**
 * Idempotent diagnostics collector. It retains metadata observations only and
 * returns a new deeply frozen snapshot for renderer and release-gate readers.
 */
export class ProjectionDiagnosticsService {
  private readonly observations = new Map<string, ProjectionDiagnosticObservationV1>();

  record(observation: ProjectionDiagnosticObservationV1): void {
    const candidate = sanitizeObservation(observation);
    const existing = this.observations.get(candidate.operationId);
    if (existing === undefined) {
      this.observations.set(candidate.operationId, observation);
      return;
    }

    const sanitizedExisting = sanitizeObservation(existing);
    if (
      compareObservations(sanitizedExisting, candidate) < 0
      || (
        compareObservations(sanitizedExisting, candidate) === 0
        && canonicalObservation(sanitizedExisting).localeCompare(canonicalObservation(candidate)) < 0
      )
    ) {
      this.observations.set(candidate.operationId, observation);
    }
  }

  getSnapshot(): ProjectionDiagnosticSnapshotV1 {
    return aggregateProjectionDiagnostics([...this.observations.values()]);
  }
}
