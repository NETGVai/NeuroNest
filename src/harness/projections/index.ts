/**
 * Projections Module
 *
 * Provides projection checkpoints, scoped query/index, verifiable export
 * repositories, and the canonical timeline reducer for the harness Shared_Database.
 *
 * Requirements: 28.1–28.10, 35.1–35.4, 35.16–35.18, 47.3, 47.17
 */

export {
  ProjectionService,
  ProjectionCancelledError,
  StructuredChatProjectionService,
  type ProjectionCheckpoint,
  type ProjectionEvent,
  type ProjectionState,
  type ProjectionServiceConfig,
  type ProjectionDeltaV1,
  type ProjectionRecordRejectionV1,
  type StructuredChatCheckpointValueV1,
  type StructuredChatProjectionServiceConfig,
  type StructuredCompositionQuery,
  type StructuredProjectionEnvelopeV1,
  type StructuredProjectionMutationResult,
  type StructuredProjectionQueryContext,
  type StructuredProjectionQueryResult,
  type StructuredProjectionUnavailableReason,
  type StructuredProjectionUnavailableV1,
  type StructuredReadAcknowledgement,
  type StructuredTimelinePageQuery,
} from './projection-service.js';

export {
  ScopedQueryService,
  QueryCancelledError,
  type QueryParams,
  type ScopeFilter,
  type FilteredQueryParams,
  type QueryResult,
  type ScopedQueryServiceConfig,
} from './scoped-query-service.js';

export {
  ExportService,
  ExportCancelledError,
  type ExportRange,
  type ExportResult,
  type ExportManifest,
  type OmissionDeclaration,
  type ExportServiceConfig,
} from './export-service.js';

export {
  CanonicalTimelineReducer,
  computeStableKey,
  compareProjectionSortKeys,
  mapEventToNodes,
  encodePageCursor,
  decodePageCursor,
  type CanonicalTimelineConfig,
  type ProjectionSortKey,
  type PageCursor,
  type TimelinePageQuery,
  type TimelinePageInitialQuery,
  type TimelinePageCursorQuery,
  type TimelinePageResult,
  type TimelinePageUnavailableReason,
  type UnreadMetadata,
  type TimelineDelta,
  type TimelinePageV1,
} from './canonical-timeline.js';

export {
  RESPONSE_BLOCK_STABLE_KEY_VERSION,
  computeResponseBlockStableKey,
  type ResponseBlockStableIdentityInput,
} from './response-block-identity.js';

export {
  RESPONSE_COMPOSITION_EVENT_TYPES,
  ResponseCompositionProjector,
  type ResponseCompositionDeltaV1,
  type ResponseCompositionProjectionDiagnosticCode,
  type ResponseCompositionProjectionDiagnosticV1,
} from './response-composition-projector.js';

export {
  KeyedCompositionPublisher,
  type CompositionPublicationSink,
  type KeyedCompositionPublicationV1,
  type PublicationAcceptance,
  type StreamCoalesceSettingsSource,
} from './keyed-composition-publisher.js';

export {
  AuthorizedDetailPayloadV1Schema,
  AuthorizedDetailRecordV1Schema,
  DetailProjectionQueryV1Schema,
  DetailProjectionService,
  DetailProjectionCancelledError,
  type AuthorizedDetailPayloadV1,
  type AuthorizedDetailRecordV1,
  type DetailProjectionSource,
  type DetailProjectionBounds,
  type DetailProjectionQueryV1,
  type DetailProjectionRangeV1,
  type DetailProjectionResultV1,
  type DetailProjectionUnavailableReason,
  type RetainedOutputState,
} from './detail-projection-service.js';

export {
  PROJECTION_DIAGNOSTIC_SCHEMA_VERSION,
  PROJECTION_DIAGNOSTIC_BOUND_NAMES,
  PROJECTION_FAILURE_REASON_CODES,
  PROJECTION_BOUNDS_PROVENANCE,
  ProjectionFailureReasonCodeSchema,
  ProjectionDiagnosticsService,
  aggregateProjectionDiagnostics,
  type ProjectionDiagnosticBoundName,
  type ProjectionFailureReasonCode,
  type ProjectionBoundsProvenance,
  type ProjectionDiagnosticBoundsInput,
  type ProjectionCoalescingObservationV1,
  type ProjectionDiagnosticObservationV1,
  type ProjectionDiagnosticBoundsV1,
  type ProjectionFailureCountV1,
  type ProjectionDiagnosticSnapshotV1,
} from './projection-diagnostics.js';

export {
  PROJECTION_PARTICIPANTS,
  ProjectionOwnershipGuard,
  assertLegacyAdapterSurface,
  createLegacyAdapterEmission,
  getProjectionParticipantCapabilities,
  type AdapterSurfaceAssertion,
  type LegacyAdapterEmission,
  type ProjectionMutationResult,
  type ProjectionOwnerState,
  type ProjectionOwnershipScope,
  type ProjectionOwnershipSnapshot,
  type ProjectionParticipant,
  type ProjectionParticipantCapabilities,
  type ProjectionTransitionResult,
} from './projection-ownership.js';

export {
  ROLLOUT_STAGE_IDS,
  ROLLOUT_STAGE_NAMES,
  STAGE_OWNERSHIP,
  STAGE_TRANSITIONS,
  FORWARD_EVIDENCE_REQUIREMENTS,
  RolloutStageEnforcer,
  RolloutStageRegistry,
  validateStageGraphIntegrity,
  validateConcurrentOwnership,
  type RolloutStageId,
  type RolloutStageScope,
  type RolloutStageSnapshot,
  type StageEvidenceItem,
  type StageEvidenceKind,
  type StageOwnershipDeclaration,
  type StageTransitionResult,
  type StageTransitionRejectionReason,
  type StageMutationResult,
  type StageMutationRejectionReason,
} from './rollout-stage-graph.js';