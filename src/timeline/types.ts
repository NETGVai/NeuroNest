/**
 * Timeline types for the unified ordered event stream.
 *
 * Each event carries a stable ID, session scope, optional task/run scope,
 * a monotonically increasing sequence number, an event type discriminator,
 * a payload reference, and a timestamp.
 *
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.7, 15.8, 15.9
 */

/** Supported event types in the timeline */
export type TimelineEventType =
  | 'message'
  | 'tool_event'
  | 'approval'
  | 'artifact'
  | 'change_set'
  | 'evidence'
  | 'run_transition'
  | 'error';

/** A single event in the timeline stream */
export interface TimelineEvent {
  /** Stable unique event identifier */
  id: string;
  /** Session this event belongs to */
  sessionId: string;
  /** Optional task association */
  taskId?: string;
  /** Optional run association */
  runId?: string;
  /** Monotonically increasing sequence within the session */
  sequence: number;
  /** Discriminator for event kind */
  type: TimelineEventType;
  /** Reference to the payload (content hash or storage key) */
  payloadRef: string;
  /** ISO 8601 timestamp of event creation */
  timestamp: string;
  /** Whether this event can be collapsed in the UI */
  collapsible: boolean;
}

/** Projection of a timeline — the final reduced state */
export interface TimelineProjection {
  /** Session ID this projection belongs to */
  sessionId: string;
  /** Ordered events sorted by sequence */
  events: TimelineEvent[];
  /** Latest sequence number seen */
  lastSequence: number;
}

/** Options for querying the timeline */
export interface TimelineQuery {
  sessionId: string;
  runId?: string;
  afterSequence?: number;
  limit?: number;
}

/** Visible range for virtualized rendering */
export interface VisibleRange {
  startIndex: number;
  endIndex: number;
}

/** Rendered item in the virtualized timeline */
export interface RenderedTimelineItem {
  event: TimelineEvent;
  /** Whether this item uses buffered chunk streaming */
  isStreaming: boolean;
  /** Accessibility announcement text (summarized milestone) */
  announcement?: string;
}

/** Milestone announcement for accessibility */
export interface MilestoneAnnouncement {
  /** Summary text announced via live region */
  summary: string;
  /** Priority level for the live region */
  priority: 'polite' | 'assertive';
}
