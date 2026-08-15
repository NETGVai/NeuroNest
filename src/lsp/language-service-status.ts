/**
 * LanguageServiceStatus — Status reporting for language services.
 *
 * Publishes actual capability, latency, pending-count, last-success,
 * and recent-error status while keeping protocol and diagnostics work
 * off the renderer thread.
 *
 * Requirements: 3.9, 3.10
 */

import type { ServiceKey, ServiceLifecycleState } from './language-service-gateway.js';

// ─── Types ──────────────────────────────────────────────────────

/** A recent error entry */
export interface RecentError {
  /** Error message */
  message: string;
  /** When the error occurred */
  timestamp: number;
  /** Error category (if available) */
  category?: string;
}

/** Latency statistics */
export interface LatencyStats {
  /** Average latency in ms */
  average: number;
  /** Minimum latency in ms */
  min: number;
  /** Maximum latency in ms */
  max: number;
  /** Most recent latency in ms */
  last: number;
  /** Number of samples */
  sampleCount: number;
}

/** A snapshot of the language service status */
export interface LanguageServiceStatusSnapshot {
  /** The workspace/language key */
  key: ServiceKey;
  /** Current lifecycle state */
  state: ServiceLifecycleState;
  /** Latency statistics for requests */
  latency: LatencyStats | null;
  /** Number of currently pending requests */
  pendingCount: number;
  /** Timestamp of last successful response */
  lastSuccessAt: number | null;
  /** Recent errors (most recent first, capped) */
  recentErrors: RecentError[];
  /** Timestamp of the snapshot */
  snapshotAt: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Maximum number of recent errors to retain */
const MAX_RECENT_ERRORS = 10;

/** Maximum number of latency samples for moving average */
const MAX_LATENCY_SAMPLES = 100;

// ─── LanguageServiceStatus ──────────────────────────────────────

/**
 * LanguageServiceStatus — Tracks health metrics for a language service.
 *
 * Records:
 * - Request latency (average, min, max, last)
 * - Pending request count
 * - Last successful response timestamp
 * - Recent errors (capped circular buffer)
 * - State change history
 *
 * Requirements: 3.9, 3.10
 */
export class LanguageServiceStatus {
  private key: ServiceKey;
  private state: ServiceLifecycleState = 'stopped';
  private latencySamples: number[] = [];
  private pendingCount: number = 0;
  private lastSuccessAt: number | null = null;
  private recentErrors: RecentError[] = [];

  constructor(key: ServiceKey) {
    this.key = key;
  }

  // ─── Recording ──────────────────────────────────────────────────

  /**
   * Record a successful request with its latency.
   *
   * Requirements: 3.9
   */
  recordSuccess(latencyMs: number): void {
    this.lastSuccessAt = Date.now();

    // Add latency sample with bounded window
    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) {
      this.latencySamples.shift();
    }
  }

  /**
   * Record an error.
   *
   * Requirements: 3.9
   */
  recordError(error: Error, category?: string): void {
    const entry: RecentError = {
      message: error.message,
      timestamp: Date.now(),
      category,
    };

    this.recentErrors.unshift(entry);
    if (this.recentErrors.length > MAX_RECENT_ERRORS) {
      this.recentErrors.pop();
    }
  }

  /**
   * Record a state change.
   */
  recordStateChange(newState: ServiceLifecycleState): void {
    this.state = newState;
  }

  /**
   * Increment the pending request count.
   */
  incrementPending(): void {
    this.pendingCount++;
  }

  /**
   * Decrement the pending request count.
   */
  decrementPending(): void {
    if (this.pendingCount > 0) {
      this.pendingCount--;
    }
  }

  // ─── Queries ────────────────────────────────────────────────────

  /**
   * Get a complete status snapshot.
   *
   * Requirements: 3.9
   */
  getSnapshot(): LanguageServiceStatusSnapshot {
    return {
      key: { ...this.key },
      state: this.state,
      latency: this.getLatencyStats(),
      pendingCount: this.pendingCount,
      lastSuccessAt: this.lastSuccessAt,
      recentErrors: [...this.recentErrors],
      snapshotAt: Date.now(),
    };
  }

  /**
   * Get latency statistics.
   */
  getLatencyStats(): LatencyStats | null {
    if (this.latencySamples.length === 0) return null;

    const sum = this.latencySamples.reduce((a, b) => a + b, 0);
    return {
      average: sum / this.latencySamples.length,
      min: Math.min(...this.latencySamples),
      max: Math.max(...this.latencySamples),
      last: this.latencySamples[this.latencySamples.length - 1],
      sampleCount: this.latencySamples.length,
    };
  }

  /**
   * Get the current pending request count.
   */
  getPendingCount(): number {
    return this.pendingCount;
  }

  /**
   * Get the timestamp of the last successful response.
   */
  getLastSuccessAt(): number | null {
    return this.lastSuccessAt;
  }

  /**
   * Get recent errors.
   */
  getRecentErrors(): RecentError[] {
    return [...this.recentErrors];
  }

  /**
   * Get the current state.
   */
  getState(): ServiceLifecycleState {
    return this.state;
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  /**
   * Reset all status tracking.
   */
  reset(): void {
    this.state = 'stopped';
    this.latencySamples = [];
    this.pendingCount = 0;
    this.lastSuccessAt = null;
    this.recentErrors = [];
  }
}
