import type {
  CommandEnvelopeV1,
  CommandTransportReceiptV1,
  ResponseCompositionV1,
} from '../../harness/contracts/index.js';
import type {
  ProjectionDeltaV1,
  ProjectionDiagnosticSnapshotV1,
  StructuredCompositionQuery,
  StructuredProjectionQueryResult,
  StructuredProjectionUnavailableReason,
  StructuredTimelinePageQuery,
  TimelinePageV1,
} from '../../harness/projections/index.js';
import type {
  ProjectionQueryIPCUnavailableReasonV1,
  ProjectionQueryIPCUnavailableV1,
  RenderStatusResultV1,
} from '../../shared/chat-projection-ipc-contracts.js';

/**
 * Distributive `Omit` variant that preserves discriminated-union members.
 *
 * The plain built-in `Omit<A | B, K>` reduces the union to its common keys
 * only, which drops the `position` (initial) and `cursor` (cursor) branches
 * of {@link StructuredTimelinePageQuery}. The distributive variant applies
 * `Omit` to each constituent independently so both variants survive.
 */
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/** Cloneable page query accepted by the versioned preload bridge. */
export type ChatProjectionPageQueryV1 = DistributiveOmit<
  StructuredTimelinePageQuery,
  'signal'
>;

/** Cloneable composition query accepted by the versioned preload bridge. */
export type ChatProjectionCompositionQueryV1 = DistributiveOmit<
  StructuredCompositionQuery,
  'signal'
>;

/** Exact canonical scope used by diagnostics and pushed projection events. */
export interface ChatProjectionScopeV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly branchId: string;
}

/**
 * Envelope wrapping a projection delta with the canonical scope keys the
 * publisher attaches on the main side. Renderer subscribers filter incoming
 * events against their captured scope before dispatching to the callback.
 */
export interface ScopedChatProjectionDeltaV1 extends ProjectionDeltaV1 {
  readonly sessionId: string;
  readonly branchId: string;
}

/**
 * Union of every invalidation reason legally emitted by the main-process
 * publisher. Renderer consumers switch on `reasonCode` to decide whether to
 * re-fetch or purge state; codes outside the canonical projection vocabulary
 * are rejected before reaching subscribers.
 */
export type ChatProjectionInvalidationReasonV1 = StructuredProjectionUnavailableReason;

export interface ChatProjectionInvalidatedV1 extends ChatProjectionScopeV1 {
  readonly projectionRevision: number;
  readonly sourceRevision: number;
  readonly reasonCode: ChatProjectionInvalidationReasonV1;
}

/**
 * Read-envelope union for the paged timeline query. Combines the canonical
 * unavailable variants surfaced by the projection service (stale revisions,
 * malformed cursors, cancellation) with the IPC-boundary variants added by
 * the main-process query registrar (malformed request, no projection
 * service, invalid response, query failed).
 */
export type ChatProjectionPageResultV1 =
  | StructuredProjectionQueryResult<TimelinePageV1>
  | ProjectionQueryIPCUnavailableV1;

/** Read-envelope union for the response-composition query. */
export type ChatProjectionCompositionResultV1 =
  | StructuredProjectionQueryResult<ResponseCompositionV1>
  | ProjectionQueryIPCUnavailableV1;

/**
 * Diagnostic-status envelope returned by the fixed render-status method.
 * Carries the projection/source revision pair at the envelope level and the
 * validated diagnostic snapshot under `value`. Unavailable results reuse the
 * same reason vocabulary as the other read envelopes.
 */
export type ChatRenderStatusResultV1 =
  | RenderStatusResultV1
  | ProjectionQueryIPCUnavailableV1;

/** Union of every reason code the fixed read/subscribe surface may surface. */
export type ChatProjectionUnavailableReasonV1 = ProjectionQueryIPCUnavailableReasonV1;

export type ChatProjectionUnsubscribe = () => void;

/** Renderer-visible, fixed-channel methods exposed by the Electron preload. */
export interface StructuredChatPreloadBridge {
  getChatProjectionPage(
    query: ChatProjectionPageQueryV1,
  ): Promise<ChatProjectionPageResultV1>;
  getChatProjectionComposition(
    query: ChatProjectionCompositionQueryV1,
  ): Promise<ChatProjectionCompositionResultV1>;
  /**
   * Retrieve the diagnostic snapshot for a scoped chat projection. Returns a
   * versioned envelope carrying the projection/source revision pair; the raw
   * {@link ProjectionDiagnosticSnapshotV1} is nested under `value` when the
   * result is available.
   */
  getChatRenderStatus(
    scope: ChatProjectionScopeV1,
  ): Promise<ChatRenderStatusResultV1>;
  submitChatCommand(
    command: CommandEnvelopeV1,
  ): Promise<CommandTransportReceiptV1>;
  onChatProjectionDelta(
    scope: ChatProjectionScopeV1,
    callback: (delta: ScopedChatProjectionDeltaV1) => void,
  ): ChatProjectionUnsubscribe;
  onChatProjectionInvalidated(
    scope: ChatProjectionScopeV1,
    callback: (event: ChatProjectionInvalidatedV1) => void,
  ): ChatProjectionUnsubscribe;
}

export type {
  ProjectionDiagnosticSnapshotV1,
  ProjectionQueryIPCUnavailableV1,
  ProjectionQueryIPCUnavailableReasonV1,
  RenderStatusResultV1,
};
