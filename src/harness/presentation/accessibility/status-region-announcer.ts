/**
 * Status Region Announcer
 *
 * Manages a polite ARIA live region for turn-state changes and streaming
 * content announcements. Coalesces streaming announcements to semantic
 * block completion or a configurable interval (never below 1 second).
 *
 * Requirements: 36.10–36.11, 46.5, 46.9
 */

import type { StatusAnnouncement } from './types';

/**
 * Configuration for the status region announcer.
 */
export interface StatusRegionConfig {
  /** Minimum interval between streaming content announcements in ms (min 1000). */
  streamingCoalesceIntervalMs: number;
  /** Maximum queue depth before oldest announcements are dropped. */
  maxQueueDepth: number;
}

/**
 * Validates and clamps status region configuration.
 */
export function validateStatusRegionConfig(config: StatusRegionConfig): StatusRegionConfig {
  return {
    streamingCoalesceIntervalMs: Math.max(1000, config.streamingCoalesceIntervalMs),
    maxQueueDepth: Math.max(1, Math.floor(config.maxQueueDepth)),
  };
}

/**
 * Callback interface for delivering announcements to the live region.
 */
export interface AnnouncementSink {
  announce(announcement: StatusAnnouncement): void;
}

/**
 * StatusRegionAnnouncer coordinates polite live-region announcements:
 * - Turn-state changes are announced immediately (polite)
 * - Streaming content is coalesced to semantic block completion or interval
 * - No announcement is duplicated within the coalesce window
 * - Queue depth is bounded to prevent overflow
 */
export class StatusRegionAnnouncer {
  private config: StatusRegionConfig;
  private sink: AnnouncementSink | null = null;
  private lastStreamingAnnounceTime: number = 0;
  private pendingStreamingMessage: string | null = null;
  private pendingStreamingSource: string | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private announcementHistory: StatusAnnouncement[] = [];
  private lastAnnouncedMessage: string = '';

  constructor(config: StatusRegionConfig) {
    this.config = validateStatusRegionConfig(config);
  }

  /**
   * Update configuration (e.g., from Settings_Service revision).
   */
  setConfig(config: StatusRegionConfig): void {
    this.config = validateStatusRegionConfig(config);
  }

  /**
   * Register the announcement sink (the live region element handler).
   */
  setSink(sink: AnnouncementSink): void {
    this.sink = sink;
  }

  /**
   * Announce a turn-state change immediately (polite priority).
   * These are not coalesced — each state change gets announced.
   */
  announceTurnState(message: string, source: string): void {
    if (!message || message === this.lastAnnouncedMessage) return;

    const announcement: StatusAnnouncement = {
      message,
      politeness: 'polite',
      source,
      timestamp: Date.now(),
    };

    this.deliverAnnouncement(announcement);
  }

  /**
   * Queue a streaming content announcement. These are coalesced:
   * only the latest message is announced at the configured interval.
   */
  announceStreamingContent(message: string, source: string): void {
    if (!message) return;

    this.pendingStreamingMessage = message;
    this.pendingStreamingSource = source;

    const now = Date.now();
    const elapsed = now - this.lastStreamingAnnounceTime;

    if (elapsed >= this.config.streamingCoalesceIntervalMs) {
      // Enough time has passed — announce immediately
      this.flushStreamingAnnouncement(now);
    } else if (!this.coalesceTimer) {
      // Schedule future announcement
      const remaining = this.config.streamingCoalesceIntervalMs - elapsed;
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        this.flushStreamingAnnouncement(Date.now());
      }, remaining);
    }
    // Otherwise: timer is already running, will pick up the latest message
  }

  /**
   * Announce a semantic block completion (e.g., a complete paragraph).
   * This resets the coalesce timer and announces immediately.
   */
  announceBlockCompletion(message: string, source: string): void {
    if (!message) return;

    // Cancel any pending coalesced announcement
    this.cancelCoalesceTimer();
    this.pendingStreamingMessage = null;
    this.pendingStreamingSource = null;

    const announcement: StatusAnnouncement = {
      message,
      politeness: 'polite',
      source,
      timestamp: Date.now(),
    };

    this.deliverAnnouncement(announcement);
    this.lastStreamingAnnounceTime = Date.now();
  }

  /**
   * Get the announcement history (for testing/debugging).
   */
  getHistory(): readonly StatusAnnouncement[] {
    return this.announcementHistory;
  }

  /**
   * Get the last announced message.
   */
  getLastAnnouncement(): string {
    return this.lastAnnouncedMessage;
  }

  /**
   * Check if there is a pending streaming announcement.
   */
  hasPendingAnnouncement(): boolean {
    return this.pendingStreamingMessage !== null;
  }

  /**
   * Clear all state and cancel pending timers.
   */
  dispose(): void {
    this.cancelCoalesceTimer();
    this.pendingStreamingMessage = null;
    this.pendingStreamingSource = null;
    this.announcementHistory = [];
    this.lastAnnouncedMessage = '';
  }

  // ─── Private ────────────────────────────────────────────────────

  private flushStreamingAnnouncement(now: number): void {
    if (!this.pendingStreamingMessage || !this.pendingStreamingSource) return;

    // Don't duplicate the last announced message
    if (this.pendingStreamingMessage === this.lastAnnouncedMessage) {
      this.pendingStreamingMessage = null;
      this.pendingStreamingSource = null;
      return;
    }

    const announcement: StatusAnnouncement = {
      message: this.pendingStreamingMessage,
      politeness: 'polite',
      source: this.pendingStreamingSource,
      timestamp: now,
    };

    this.deliverAnnouncement(announcement);
    this.lastStreamingAnnounceTime = now;
    this.pendingStreamingMessage = null;
    this.pendingStreamingSource = null;
  }

  private deliverAnnouncement(announcement: StatusAnnouncement): void {
    this.lastAnnouncedMessage = announcement.message;

    // Maintain bounded history
    this.announcementHistory.push(announcement);
    while (this.announcementHistory.length > this.config.maxQueueDepth) {
      this.announcementHistory.shift();
    }

    // Deliver to sink
    if (this.sink) {
      this.sink.announce(announcement);
    }
  }

  private cancelCoalesceTimer(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }
}
