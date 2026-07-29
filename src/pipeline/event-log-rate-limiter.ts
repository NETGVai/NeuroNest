/**
 * EventLog Rate Limiter — sliding-window rate limiter for the EventLog dispatch path.
 *
 * Uses a per-source circular buffer of timestamps. On each `allow()` call,
 * timestamps older than the window are evicted, and the remaining count is
 * checked against `maxEventsPerSecond`. Logs a warning when events are dropped.
 *
 * Requirements: 10.3, 10.4
 */

// ─── Configuration ─────────────────────────────────────────────

export interface RateLimiterConfig {
  /** Maximum events a single source may emit per window. Default: 100 */
  maxEventsPerSecond: number;
  /** Sliding window duration in milliseconds. Default: 1000 */
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxEventsPerSecond: 100,
  windowMs: 1000,
};

// ─── Per-source state ──────────────────────────────────────────

interface SourceWindow {
  /** Circular buffer of event timestamps (ms). */
  timestamps: number[];
  /** Total events dropped since last reset for this source. */
  dropped: number;
}

// ─── Rate Limiter ──────────────────────────────────────────────

/**
 * Sliding-window rate limiter that tracks per-source event rates.
 *
 * Each `allow(sourceId)` call:
 *   1. Evicts timestamps older than `now - windowMs`
 *   2. Checks if the remaining count >= `maxEventsPerSecond`
 *   3. If under the limit, records the timestamp and returns true
 *   4. If at/over the limit, increments the drop counter, logs a warning, returns false
 */
export class EventLogRateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly sources: Map<string, SourceWindow> = new Map();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check whether an event from the given source is allowed.
   * Returns `true` if the event may proceed, `false` if rate-limited.
   */
  allow(sourceId: string): boolean {
    const now = Date.now();
    const window = this.getOrCreateWindow(sourceId);

    // Evict timestamps outside the sliding window
    this.evictStale(window, now);

    // Check against limit
    if (window.timestamps.length >= this.config.maxEventsPerSecond) {
      window.dropped++;
      console.warn(
        `[event-log-rate-limiter] rate limit exceeded for source="${sourceId}" ` +
          `(dropped=${window.dropped}, limit=${this.config.maxEventsPerSecond}/${this.config.windowMs}ms)`,
      );
      return false;
    }

    // Record this event's timestamp
    window.timestamps.push(now);
    return true;
  }

  /** Reset rate-limit state for a specific source. */
  reset(sourceId: string): void {
    this.sources.delete(sourceId);
  }

  /** Reset all rate-limit state. */
  resetAll(): void {
    this.sources.clear();
  }

  /** Get the number of dropped events for a specific source. */
  getDroppedCount(sourceId: string): number {
    return this.sources.get(sourceId)?.dropped ?? 0;
  }

  /** Get the current event count in the window for a source. */
  getWindowCount(sourceId: string): number {
    const window = this.sources.get(sourceId);
    if (!window) return 0;
    this.evictStale(window, Date.now());
    return window.timestamps.length;
  }

  // ─── Internals ───────────────────────────────────────────────

  private getOrCreateWindow(sourceId: string): SourceWindow {
    let window = this.sources.get(sourceId);
    if (!window) {
      window = { timestamps: [], dropped: 0 };
      this.sources.set(sourceId, window);
    }
    return window;
  }

  /**
   * Remove timestamps older than the sliding window boundary.
   * Since timestamps are appended in order, we can efficiently
   * drop from the front of the array.
   */
  private evictStale(window: SourceWindow, now: number): void {
    const cutoff = now - this.config.windowMs;
    // Find the first index that's within the window
    let evictCount = 0;
    while (evictCount < window.timestamps.length && window.timestamps[evictCount]! <= cutoff) {
      evictCount++;
    }
    if (evictCount > 0) {
      window.timestamps.splice(0, evictCount);
    }
  }
}
