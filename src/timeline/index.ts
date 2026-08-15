/**
 * Timeline module — unified ordered event stream for chat sessions.
 *
 * Exports:
 * - ChatTimelineStore: integrated store with persistence, convergence, streaming, scroll, and collapse
 * - TimelineService: persists ordered events with deduplication
 * - TimelineReducer: convergent reduction regardless of delivery order
 * - VirtualizedTimelineRenderer: virtualized rendering with streaming and a11y
 * - Event payloads: typed payload discriminators for each timeline event type
 * - Types: all timeline event and projection types
 */

export { ChatTimelineStore } from './chat-timeline-store.js';
export type {
  ChatTimelineStoreConfig,
  StreamingState,
  ScrollState,
  CollapseState,
} from './chat-timeline-store.js';
export { TimelineService } from './timeline-service.js';
export type { AppendResult } from './timeline-service.js';
export { TimelineReducer } from './timeline-reducer.js';
export { VirtualizedTimelineRenderer } from './virtualized-timeline-renderer.js';
export type { VirtualizedRendererConfig } from './virtualized-timeline-renderer.js';
export type {
  TimelineEvent,
  TimelineEventType,
  TimelineProjection,
  TimelineQuery,
  VisibleRange,
  RenderedTimelineItem,
  MilestoneAnnouncement,
} from './types.js';
export type {
  MessagePayload,
  MessageRole,
  MessageTerminalState,
  CodeBlockRef,
  ToolEventPayload,
  ToolEventState,
  ApprovalPayload,
  ApprovalStatus,
  ArtifactPayload,
  ChangeSetPayload,
  EvidencePayload,
  RunTransitionPayload,
  ErrorPayload,
  ErrorSeverity,
  TimelineEventPayload,
} from './event-payloads.js';
