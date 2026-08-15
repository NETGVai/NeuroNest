/**
 * VirtualizedTimelineRenderer — renders the timeline with virtualization,
 * buffered chunk streaming, and summarized milestone announcements.
 *
 * Only renders items within the visible range (virtualization).
 * Uses buffered chunk streaming for message content.
 * Announces summarized milestones for accessibility (not per-token).
 * Marks approval requests and failures as non-collapsible.
 *
 * Requirements: 15.5, 15.8, 15.9
 */

import type {
  TimelineEvent,
  TimelineProjection,
  VisibleRange,
  RenderedTimelineItem,
  MilestoneAnnouncement,
} from './types.js';

/** Configuration for the virtualized renderer */
export interface VirtualizedRendererConfig {
  /** Number of items to buffer above and below the visible range */
  overscan: number;
  /** Minimum number of tokens before a streaming batch is flushed */
  streamingBatchSize: number;
}

const DEFAULT_CONFIG: VirtualizedRendererConfig = {
  overscan: 5,
  streamingBatchSize: 10,
};

/** Non-collapsible event types that must always remain visible */
const NON_COLLAPSIBLE_TYPES: Set<string> = new Set(['approval', 'error']);

/**
 * VirtualizedTimelineRenderer handles rendering optimization for the
 * timeline by only materializing visible items, batching streaming
 * content, and providing accessibility-friendly announcements.
 */
export class VirtualizedTimelineRenderer {
  private config: VirtualizedRendererConfig;
  private projection: TimelineProjection | null = null;
  private visibleRange: VisibleRange = { startIndex: 0, endIndex: 0 };
  private streamingBuffer: Map<string, string[]> = new Map();
  private pendingAnnouncements: MilestoneAnnouncement[] = [];

  constructor(config: Partial<VirtualizedRendererConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update the projection that the renderer operates on.
   */
  setProjection(projection: TimelineProjection): void {
    this.projection = projection;
  }

  /**
   * Update the visible range (e.g., from scroll position).
   */
  setVisibleRange(range: VisibleRange): void {
    this.visibleRange = range;
  }

  /**
   * Get the items that should be rendered given the current visible range.
   * Includes overscan items for smooth scrolling.
   *
   * Only items within [startIndex - overscan, endIndex + overscan] are returned.
   */
  getRenderedItems(): RenderedTimelineItem[] {
    if (!this.projection) {
      return [];
    }

    const { events } = this.projection;
    const { overscan } = this.config;

    const start = Math.max(0, this.visibleRange.startIndex - overscan);
    const end = Math.min(events.length, this.visibleRange.endIndex + overscan);

    const items: RenderedTimelineItem[] = [];
    for (let i = start; i < end; i++) {
      const event = events[i]!;
      items.push({
        event,
        isStreaming: this.streamingBuffer.has(event.id),
        announcement: this.buildAnnouncementForEvent(event),
      });
    }

    return items;
  }

  /**
   * Get the total number of items in the timeline.
   */
  getTotalItemCount(): number {
    return this.projection?.events.length ?? 0;
  }

  /**
   * Append streaming tokens to a buffered chunk for an event.
   * Only flushes as a batch when the buffer reaches the configured size.
   */
  appendStreamingChunk(eventId: string, tokens: string[]): string | null {
    let buffer = this.streamingBuffer.get(eventId);
    if (!buffer) {
      buffer = [];
      this.streamingBuffer.set(eventId, buffer);
    }

    buffer.push(...tokens);

    if (buffer.length >= this.config.streamingBatchSize) {
      const flushed = buffer.join('');
      this.streamingBuffer.set(eventId, []);
      return flushed;
    }

    return null;
  }

  /**
   * Flush all remaining tokens for a streaming event (e.g., stream complete).
   */
  flushStreamingBuffer(eventId: string): string {
    const buffer = this.streamingBuffer.get(eventId) ?? [];
    this.streamingBuffer.delete(eventId);
    return buffer.join('');
  }

  /**
   * Check if an event is non-collapsible.
   * Approval requests and failures cannot be collapsed per design.
   */
  isNonCollapsible(event: TimelineEvent): boolean {
    return NON_COLLAPSIBLE_TYPES.has(event.type) || !event.collapsible;
  }

  /**
   * Generate a summarized milestone announcement for accessibility.
   * Uses summarized milestones rather than per-token updates.
   *
   * Returns null for events that don't warrant an announcement.
   */
  generateMilestoneAnnouncement(event: TimelineEvent): MilestoneAnnouncement | null {
    switch (event.type) {
      case 'run_transition':
        return {
          summary: `Run state changed`,
          priority: 'polite',
        };
      case 'approval':
        return {
          summary: `Approval requested`,
          priority: 'assertive',
        };
      case 'error':
        return {
          summary: `Error occurred`,
          priority: 'assertive',
        };
      case 'change_set':
        return {
          summary: `Change set available for review`,
          priority: 'polite',
        };
      case 'evidence':
        return {
          summary: `Validation evidence recorded`,
          priority: 'polite',
        };
      case 'tool_event':
        return {
          summary: `Tool activity`,
          priority: 'polite',
        };
      case 'artifact':
        return {
          summary: `Artifact produced`,
          priority: 'polite',
        };
      case 'message':
        // Messages use streaming — no per-token announcement
        return null;
      default:
        return null;
    }
  }

  /**
   * Consume and clear pending announcements for the live region.
   */
  consumeAnnouncements(): MilestoneAnnouncement[] {
    const announcements = [...this.pendingAnnouncements];
    this.pendingAnnouncements = [];
    return announcements;
  }

  /**
   * Queue a milestone announcement.
   */
  queueAnnouncement(announcement: MilestoneAnnouncement): void {
    this.pendingAnnouncements.push(announcement);
  }

  /**
   * Mark collapsibility on events based on type.
   * Approval requests and failures are always non-collapsible.
   */
  static markCollapsibility(event: Omit<TimelineEvent, 'collapsible'>): TimelineEvent {
    const collapsible = !NON_COLLAPSIBLE_TYPES.has(event.type);
    return { ...event, collapsible };
  }

  // --- Private helpers ---

  private buildAnnouncementForEvent(event: TimelineEvent): string | undefined {
    const announcement = this.generateMilestoneAnnouncement(event);
    if (announcement) {
      this.queueAnnouncement(announcement);
      return announcement.summary;
    }
    return undefined;
  }
}
