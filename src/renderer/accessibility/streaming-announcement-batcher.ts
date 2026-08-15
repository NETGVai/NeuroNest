/**
 * StreamingAnnouncementBatcher — Batches streaming text updates for
 * screen reader announcements to avoid overwhelming users.
 *
 * Instead of announcing every token, the batcher accumulates text
 * and announces at sentence boundaries or after a configurable interval.
 * This provides useful updates without reading every token.
 *
 * Requirements: 23.2
 */

import type { LiveRegionManager, LiveRegionPriority } from './live-region-manager';

/** Configuration for the announcement batcher */
export interface BatchConfig {
  /** Maximum ms to wait before announcing accumulated text */
  readonly maxIntervalMs: number;
  /** Minimum characters before considering a boundary flush */
  readonly minCharsBeforeFlush: number;
  /** Maximum characters to accumulate before forced flush */
  readonly maxCharsBeforeFlush: number;
  /** Priority for the streaming region */
  readonly priority: LiveRegionPriority;
}

const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxIntervalMs: 2000,
  minCharsBeforeFlush: 40,
  maxCharsBeforeFlush: 200,
  priority: 'polite',
};

/** Sentence-ending punctuation for natural break points */
const SENTENCE_ENDINGS = /[.!?]\s*$/;

/**
 * StreamingAnnouncementBatcher accumulates streaming text and announces
 * meaningful chunks to a live region at natural boundaries.
 *
 * It uses a strategy that announces at sentence boundaries or after
 * a timeout, whichever comes first. This avoids both per-token noise
 * and stale silence during long streaming responses.
 */
export class StreamingAnnouncementBatcher {
  private readonly config: BatchConfig;
  private readonly liveRegionManager: LiveRegionManager;
  private readonly regionId: string;

  private buffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private totalAnnounced = 0;
  private announcementCount = 0;
  private isActive = false;

  constructor(
    liveRegionManager: LiveRegionManager,
    regionId: string,
    config: Partial<BatchConfig> = {},
  ) {
    this.liveRegionManager = liveRegionManager;
    this.regionId = regionId;
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
  }

  /**
   * Start a new streaming session. Resets internal state.
   */
  start(): void {
    this.reset();
    this.isActive = true;
  }

  /**
   * Append streaming tokens. May trigger an announcement
   * if a natural boundary or max buffer is reached.
   */
  append(text: string): void {
    if (!this.isActive) return;

    this.buffer += text;

    // Check for forced flush at max buffer
    if (this.buffer.length >= this.config.maxCharsBeforeFlush) {
      this.flush();
      return;
    }

    // Check for sentence boundary flush
    if (
      this.buffer.length >= this.config.minCharsBeforeFlush &&
      SENTENCE_ENDINGS.test(this.buffer)
    ) {
      this.flush();
      return;
    }

    // Schedule a timeout flush if not already scheduled
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.buffer.length > 0) {
          this.flush();
        }
      }, this.config.maxIntervalMs);
    }
  }

  /**
   * Complete the streaming session. Flushes any remaining buffer
   * and announces completion.
   */
  complete(): void {
    if (!this.isActive) return;

    if (this.buffer.length > 0) {
      this.flush();
    }

    this.liveRegionManager.announce(
      this.regionId,
      'Response complete.',
    );
    this.announcementCount++;
    this.isActive = false;
    this.clearTimer();
  }

  /**
   * Cancel the streaming session without a completion announcement.
   */
  cancel(): void {
    this.isActive = false;
    this.clearTimer();
    this.buffer = '';
  }

  /**
   * Get the number of announcements made in this session.
   */
  getAnnouncementCount(): number {
    return this.announcementCount;
  }

  /**
   * Get total characters announced in this session.
   */
  getTotalAnnounced(): number {
    return this.totalAnnounced;
  }

  /**
   * Check if the batcher is currently active.
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * Get current buffer content (for testing/debugging).
   */
  getBufferContent(): string {
    return this.buffer;
  }

  // ─── Private ───────────────────────────────────────────────────

  private flush(): void {
    if (this.buffer.length === 0) return;

    const text = this.buffer.trim();
    this.buffer = '';
    this.clearTimer();

    if (text.length > 0) {
      this.liveRegionManager.announce(this.regionId, text);
      this.totalAnnounced += text.length;
      this.announcementCount++;
    }
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private reset(): void {
    this.buffer = '';
    this.totalAnnounced = 0;
    this.announcementCount = 0;
    this.clearTimer();
  }
}
