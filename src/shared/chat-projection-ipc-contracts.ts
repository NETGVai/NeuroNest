/**
 * Shared wire-level contracts for the versioned chat projection IPC boundary.
 *
 * These types describe the exact envelopes the main-process query registrar
 * emits and the renderer preload bridge consumes. They live in `src/shared`
 * because both process boundaries depend on them: the main handler builds
 * responses shaped exactly like this, and the renderer typing surface exposes
 * the same union so consumers can discriminate `ok` results from unavailable
 * fallbacks without touching internal projection types.
 *
 * Requirements: 9.1, 9.6, 11.7, 13.9, 15.4, 15.7
 */

import type {
  ProjectionDiagnosticSnapshotV1,
  StructuredProjectionUnavailableReason,
} from '../harness/projections/index.js';

/**
 * Every reason code that may appear in a versioned chat projection IPC
 * response. Combines the canonical projection reasons (stale revisions,
 * malformed cursor, cancellation) with the extra IPC-boundary reasons that
 * describe transport-level failures.
 */
export type ProjectionQueryIPCUnavailableReasonV1 =
  | StructuredProjectionUnavailableReason
  | 'malformed_request'
  | 'no_projection'
  | 'invalid_response'
  | 'query_failed';

/**
 * Wire-level unavailable envelope shared by every fixed chat projection read.
 * The `projectionRevision`/`sourceRevision` pair reports the projection's
 * current position even when the query itself is refused, so renderer state
 * can decide whether to invalidate cached data.
 */
export interface ProjectionQueryIPCUnavailableV1 {
  readonly ok: false;
  readonly unavailable: true;
  readonly reasonCode: ProjectionQueryIPCUnavailableReasonV1;
  readonly projectionRevision: number;
  readonly sourceRevision: number;
  readonly schemaVersion: 1;
}

/**
 * Successful diagnostic-status envelope. The projection/source revision pair
 * mirrors the underlying projection's position; consumers reconcile scoped
 * subscriptions against this pair to avoid rendering stale state.
 */
export interface RenderStatusResultV1 {
  readonly ok: true;
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly branchId: string;
  readonly projectionRevision: number;
  readonly sourceRevision: number;
  readonly value: ProjectionDiagnosticSnapshotV1;
}
