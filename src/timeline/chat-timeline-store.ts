/**
 * ChatTimelineStore — an ordered, convergent, virtualized chat timeline.
 *
 * Integrates the TimelineService (persistence with deduplication),
 * the TimelineReducer (convergent ordering regardless of delivery),
 * and the VirtualizedTimelineRenderer (bounded rendering) into a single
 * store that manages the complete lifecycle of a chat session's events.
 *
 * Key behaviors:
 * - Persists messages, prose, reasoning, Tool_Events, approvals, artifacts,
 *   Change_Sets, Evidence, errors, and run states by stable ID and sequence.
 * - Deduplicates reload/reconnect events and tokens.
 * - Preserves user scroll position with "New Activity" indicator.
 * - Virtualizes long histories.
 * - Keeps approvals and failures visible when low-level tools collapse.
 * - Supports streaming with selectable text and semantically equivalent final render.
 * - Distinguishes terminal states: completed, stopped, cancelled, failed, disconnected.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9
 */

import { TimelineService } from './timeline-service.js';
import type { AppendResult } from './timeline-service.js';
import { TimelineReducer } from './timeline-reducer.js';
import { VirtualizedTimelineRenderer } from './virtualized-timeline-renderer.js';
import type { VirtualizedRendererConfig } from './virtualized-timeline-renderer.js';
import type {
  TimelineEvent,
  TimelineEventType,
  TimelineProjection,
  VisibleRange,
  RenderedTimelineItem,
  MilestoneAnnouncement,
} from './types.js';
import type {
  MessagePayload,
  MessageTerminalState,
  TimelineEventPayload,
} from './event-payloads.js';

// ─── Stream state ──────────────────────────────────────────────

/** Active streaming session for a message event */
export interface StreamingState {
  readonly eventId: string;
  readonly startedAt: number;
  buffer: string;
  terminalState: MessageTerminalState | null;
  codeBlockOpen: boolean;
  codeBlockLanguage: string;
}

// ─── Scroll state ──────────────────────────────────────────────

/** Scroll position tracking for the chat panel */
export interface ScrollState {
  /** Whether the user is currently near the bottom of the timeline */
  isNearBottom: boolean;
  /** Number of new events received while scrolled away */
  newActivityCount: number;
  /** Last known scroll offset (pixels) */
  scrollOffset: number;
}

// ─── Collapse state ────────────────────────────────────────────

/** Controls which tool events are collapsed */
export interface CollapseState {
  /** Set of event IDs that are explicitly expanded by the user */
  expandedIds: Set<string>;
  /** Whether tool events are collapsed by default */
  toolEventsCollapsedByDefault: boolean;
}

// ─── Store configuration ───────────────────────────────────────

export interface ChatTimelineStoreConfig {
  /** Session ID this store manages */
  sessionId: string;
  /** Renderer configuration */
  renderer?: Partial<VirtualizedRendererConfig>;
  /** Distance from bottom (px) to consider "near bottom" */
  nearBottomThreshold?: number;
  /** Whether tool events are collapsed by default */
  defaultCollapseToolEvents?: boolean;
}

// ─── Chat Timeline Store ───────────────────────────────────────

/**
 * ChatTimelineStore orchestrates persistence, convergent ordering,
 * virtualized rendering, streaming, scroll preservation, and collapse behavior.
 */
export class ChatTimelineStore {
  private readonly sessionId: string;
  private readonly service: TimelineService;
  private readonly reducer: TimelineReducer;
  private readonly renderer: VirtualizedTimelineRenderer;
  private readonly nearBottomThreshold: number;

  private projection: TimelineProjection | null = null;
  private scrollState: ScrollState;
  private collapseState: CollapseState;
  private activeStreams: Map<string, StreamingState> = new Map();
  /** Token deduplication: track seen token chunks per stream to avoid replay */
  private seenTokenKeys: Set<string> = new Set();

  constructor(config: ChatTimelineStoreConfig) {
    this.sessionId = config.sessionId;
    this.service = new TimelineService();
    this.reducer = new TimelineReducer(config.sessionId);
    this.renderer = new VirtualizedTimelineRenderer(config.renderer ?? {});
    this.nearBottomThreshold = config.nearBottomThreshold ?? 100;

    this.scrollState = {
      isNearBottom: true,
      newActivityCount: 0,
      scrollOffset: 0,
    };

    this.collapseState = {
      expandedIds: new Set(),
      toolEventsCollapsedByDefault: config.defaultCollapseToolEvents ?? true,
    };
  }

  // ─── Event ingestion ───────────────────────────────────────

  /**
   * Append a new event to the timeline.
   * Handles deduplication at both the service and reducer layers.
   * Returns whether the event was accepted (not a duplicate).
   */
  appendEvent(event: TimelineEvent): boolean {
    // Service-level persistence with monotonic sequence enforcement
    const result: AppendResult = this.service.append(event);
    if (!result.ok) {
      // If it's a duplicate, it's already in the service — skip
      // If sequence violation in service, still feed to reducer for convergence
      if (result.reason === 'duplicate') {
        return false;
      }
    }

    // Reducer-level ingestion (handles any order, deduplicates by ID)
    const accepted = this.reducer.ingest(event);
    if (!accepted) {
      return false;
    }

    // Reproject after accepting a new event
    this.reproject();

    // Track scroll state — if user is not at bottom, increment activity count
    if (!this.scrollState.isNearBottom) {
      this.scrollState.newActivityCount++;
    }

    return true;
  }

  /**
   * Ingest a batch of events (e.g., after reconnection or reload).
   * Deduplicates automatically — safe to call with overlapping event sets.
   * Returns the number of genuinely new events accepted.
   */
  ingestBatch(events: TimelineEvent[]): number {
    let accepted = 0;
    for (const event of events) {
      if (this.appendEvent(event)) {
        accepted++;
      }
    }
    return accepted;
  }

  /**
   * Rehydrate the store from persisted events (e.g., on session restore).
   * Feeds all events through the reducer for convergent ordering.
   */
  rehydrate(events: TimelineEvent[]): void {
    for (const event of events) {
      this.reducer.ingest(event);
    }
    this.reproject();
  }

  // ─── Streaming lifecycle ───────────────────────────────────

  /**
   * Begin streaming a message event. The event must already be appended.
   * Streaming produces selectable text during generation.
   */
  startStream(eventId: string): void {
    if (this.activeStreams.has(eventId)) {
      return; // already streaming
    }

    this.activeStreams.set(eventId, {
      eventId,
      startedAt: Date.now(),
      buffer: '',
      terminalState: null,
      codeBlockOpen: false,
      codeBlockLanguage: '',
    });
  }

  /**
   * Append streaming tokens to an active stream.
   * Deduplicates tokens using a content-keyed deduplication set.
   *
   * Returns the flushed batch text if the renderer buffer reached batch size,
   * or null if buffering continues.
   */
  appendStreamingTokens(eventId: string, tokens: string[], deduplicationKey?: string): string | null {
    const stream = this.activeStreams.get(eventId);
    if (!stream) {
      return null;
    }

    // Token-level deduplication for reconnect scenarios
    if (deduplicationKey) {
      if (this.seenTokenKeys.has(deduplicationKey)) {
        return null; // duplicate token batch
      }
      this.seenTokenKeys.add(deduplicationKey);
    }

    // Accumulate to stream buffer
    const text = tokens.join('');
    stream.buffer += text;

    // Track code block state for deferred highlighting
    this.updateCodeBlockState(stream, text);

    // Feed to virtualized renderer for batched flushing
    return this.renderer.appendStreamingChunk(eventId, tokens);
  }

  /**
   * Complete a streaming message with a terminal state.
   * The final content should be semantically equivalent to the stream.
   */
  completeStream(eventId: string, terminalState: MessageTerminalState): string {
    const stream = this.activeStreams.get(eventId);
    if (!stream) {
      return '';
    }

    stream.terminalState = terminalState;

    // Flush any remaining buffer from the renderer
    const remaining = this.renderer.flushStreamingBuffer(eventId);
    const finalContent = stream.buffer;

    // Remove the active stream
    this.activeStreams.delete(eventId);

    return finalContent;
  }

  /**
   * Stop/cancel an active stream (user clicked Stop).
   */
  stopStream(eventId: string): string {
    return this.completeStream(eventId, 'stopped');
  }

  /**
   * Check if a given event ID is currently streaming.
   */
  isStreaming(eventId: string): boolean {
    return this.activeStreams.has(eventId);
  }

  /**
   * Get the current buffer content for a streaming event.
   */
  getStreamBuffer(eventId: string): string {
    return this.activeStreams.get(eventId)?.buffer ?? '';
  }

  /**
   * Get the terminal state of a stream (null if still active).
   */
  getStreamTerminalState(eventId: string): MessageTerminalState | null {
    return this.activeStreams.get(eventId)?.terminalState ?? null;
  }

  // ─── Scroll management ────────────────────────────────────

  /**
   * Update the user's scroll position.
   * Determines whether auto-scroll and "New Activity" indicator apply.
   */
  updateScrollPosition(scrollOffset: number, scrollHeight: number, clientHeight: number): void {
    const distFromBottom = scrollHeight - scrollOffset - clientHeight;
    const wasNearBottom = this.scrollState.isNearBottom;

    this.scrollState.scrollOffset = scrollOffset;
    this.scrollState.isNearBottom = distFromBottom <= this.nearBottomThreshold;

    // If user scrolled back to bottom, clear new activity count
    if (this.scrollState.isNearBottom && !wasNearBottom) {
      this.scrollState.newActivityCount = 0;
    }
  }

  /**
   * Get the current scroll state for the UI layer.
   */
  getScrollState(): Readonly<ScrollState> {
    return this.scrollState;
  }

  /**
   * Acknowledge new activity (user clicked "New Activity" / jump to bottom).
   */
  acknowledgeNewActivity(): void {
    this.scrollState.newActivityCount = 0;
    this.scrollState.isNearBottom = true;
  }

  /**
   * Whether new events have arrived while the user was scrolled away.
   */
  hasNewActivity(): boolean {
    return this.scrollState.newActivityCount > 0;
  }

  // ─── Collapse behavior ────────────────────────────────────

  /**
   * Toggle collapse state for a specific event.
   */
  toggleCollapse(eventId: string): void {
    if (this.collapseState.expandedIds.has(eventId)) {
      this.collapseState.expandedIds.delete(eventId);
    } else {
      this.collapseState.expandedIds.add(eventId);
    }
  }

  /**
   * Determine if an event should be rendered in collapsed state.
   *
   * Approvals and failures (errors) are NEVER collapsed, even when
   * tool events are collapsed by default (Requirement 15.9).
   */
  isCollapsed(event: TimelineEvent): boolean {
    // Non-collapsible types are never collapsed
    if (this.renderer.isNonCollapsible(event)) {
      return false;
    }

    // Check if user explicitly expanded this event
    if (this.collapseState.expandedIds.has(event.id)) {
      return false;
    }

    // Tool events collapse by default when configured
    if (event.type === 'tool_event' && this.collapseState.toolEventsCollapsedByDefault) {
      return true;
    }

    return false;
  }

  /**
   * Get all expanded event IDs.
   */
  getExpandedIds(): ReadonlySet<string> {
    return this.collapseState.expandedIds;
  }

  // ─── Virtualized rendering ────────────────────────────────

  /**
   * Update the visible range for virtualized rendering.
   */
  setVisibleRange(range: VisibleRange): void {
    this.renderer.setVisibleRange(range);
  }

  /**
   * Get the items currently visible (with overscan for smooth scrolling).
   * Filters out collapsed events.
   */
  getRenderedItems(): RenderedTimelineItem[] {
    const items = this.renderer.getRenderedItems();

    // Filter collapsed items but always keep approvals and errors
    return items.filter((item) => !this.isCollapsed(item.event));
  }

  /**
   * Get the total number of events in the timeline.
   */
  getTotalEventCount(): number {
    return this.renderer.getTotalItemCount();
  }

  /**
   * Get the current projection (full ordered event list).
   */
  getProjection(): TimelineProjection | null {
    return this.projection;
  }

  // ─── Announcements (accessibility) ────────────────────────

  /**
   * Consume pending milestone announcements for live-region updates.
   */
  consumeAnnouncements(): MilestoneAnnouncement[] {
    return this.renderer.consumeAnnouncements();
  }

  // ─── Queries ──────────────────────────────────────────────

  /**
   * Query events by run, after a sequence, or with a limit.
   */
  queryEvents(options: { runId?: string; afterSequence?: number; limit?: number }): TimelineEvent[] {
    return this.service.query({
      sessionId: this.sessionId,
      ...options,
    });
  }

  /**
   * Get the last sequence number for this session.
   */
  getLastSequence(): number {
    return this.service.getLastSequence(this.sessionId);
  }

  /**
   * Check whether a specific event ID exists in the timeline.
   */
  hasEvent(eventId: string): boolean {
    return this.service.hasEvent(eventId) || this.reducer.hasEvent(eventId);
  }

  /**
   * Get the session ID this store manages.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  // ─── Private helpers ──────────────────────────────────────

  /** Recompute the projection from the reducer and update the renderer. */
  private reproject(): void {
    this.projection = this.reducer.project();
    this.renderer.setProjection(this.projection);
  }

  /** Track whether we're inside a code block during streaming. */
  private updateCodeBlockState(stream: StreamingState, newText: string): void {
    // Count triple-backtick occurrences in the full buffer
    const matches = stream.buffer.match(/```/g);
    const count = matches ? matches.length : 0;

    // Odd count means we're inside a code block
    stream.codeBlockOpen = count % 2 === 1;

    // Extract language hint if we just opened a block
    if (stream.codeBlockOpen && !stream.codeBlockLanguage) {
      const langMatch = stream.buffer.match(/```(\w+)\s*\n/);
      if (langMatch) {
        stream.codeBlockLanguage = langMatch[1] ?? '';
      }
    }

    // Reset language tracking when block closes
    if (!stream.codeBlockOpen) {
      stream.codeBlockLanguage = '';
    }
  }
}
