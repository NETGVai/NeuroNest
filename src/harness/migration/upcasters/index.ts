/**
 * Legacy Data Upcasters and Compatibility Views
 *
 * Provides pure version-to-version upcasters for transforming legacy session data
 * to canonical SessionEventV1 format, and explicit downcast views for backward
 * compatibility. Source payloads are NEVER overwritten.
 *
 * Requirements: 3.3, 28.4–28.9, 31.9, 32.4, 44.13
 */

// Types
export type {
  LegacyTimelineRecord,
  LegacyMessage,
  LegacyBranchRecord,
  LegacyBranchEvent,
  LegacySessionMetadata,
  UpcastResult,
  DowncastView,
  TimelineRecordUpcaster,
  MessageUpcaster,
  BranchEventUpcaster,
  TimelineRecordDowncaster,
  MessageDowncaster,
  BranchEventDowncaster,
  LegacyDataUpcasterRegistry,
} from './types.js';

// Upcasters (legacy → canonical)
export { upcastTimelineRecord } from './timeline-record-upcaster.js';
export { upcastMessage } from './message-upcaster.js';
export { upcastBranchEvent } from './branch-event-upcaster.js';

// Downcast views (canonical → legacy, read-only)
export {
  downcastToTimelineRecord,
  downcastToMessage,
  downcastToBranchEvent,
} from './downcast-views.js';

// Adapter (full read pipeline)
export {
  LegacySessionAdapter,
  type LegacySessionAdapterConfig,
  type LegacyReadResult,
  type LegacyExportResult,
} from './legacy-session-adapter.js';
