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
  type ProjectionCheckpoint,
  type ProjectionEvent,
  type ProjectionState,
  type ProjectionServiceConfig,
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
  type UnreadMetadata,
  type TimelineDelta,
  type TimelinePageV1,
} from './canonical-timeline.js';
