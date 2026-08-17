/**
 * Coalesced Render Scheduler
 *
 * Coalesces visual deltas to the configured update rate from Settings_Service.
 * After all coalesced updates settle, the rendered state MUST exactly match
 * the latest compatible projection (content equivalence guarantee).
 *
 * Requirements: 47.4, 47.16, 47.21
 */

import type {
  VisualDelta,
  CoalescedState,
  ResolvedRenderingBounds,
} from './types';

/**
 * Flush callback invoked when coalesced deltas are ready to render.
 * Receives the merged deltas representing the latest projection state.
 */
export type FlushCallback = (deltas: VisualDelta[], latestRevision: number) => void;

/**
 * Timer abstraction for testability (can be mocked in tests).
 */
export interface SchedulerTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  now(): number;
}

/**
 * Default timer using standard setTimeout/clearTimeout/Date.now.
 */
export const defaultTimer: SchedulerTimer = {
  schedule: (cb, delay) => setTimeout(cb, delay),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * CoalescedRenderScheduler accumulates visual deltas and flushes them at most
 * once per configured update rate. The content equivalence guarantee ensures
 * that after settling, the rendered state matches the latest projection.
 *
 * Key behaviors:
 * - Deltas arriving faster than updateRateMs are coalesced (last-write-wins per stableKey)
 * - On flush, only the latest delta per stableKey is emitted
 * - After all scheduled flushes complete, content equals the latest projection
 * - Update rate is sourced from Settings_Service with a source revision
 */
export class CoalescedRenderScheduler {
  private state: CoalescedState;
  private pendingMap: Map<string, VisualDelta> = new Map();
  private flushHandle: unknown = null;
  private flushCallback: FlushCallback;
  private timer: SchedulerTimer;
  private updateRateMs: number;
  private boundsSourceRevision: number;
  private settled: boolean = true;

  constructor(
    resolvedBounds: ResolvedRenderingBounds,
    flushCallback: FlushCallback,
    timer: SchedulerTimer = defaultTimer,
  ) {
    this.updateRateMs = resolvedBounds.bounds.updateRateMs;
    this.boundsSourceRevision = resolvedBounds.sourceRevision;
    this.flushCallback = flushCallback;
    this.timer = timer;
    this.state = {
      pendingDeltas: [],
      latestRevision: 0,
      flushScheduled: false,
      lastFlushAt: timer.now(), // Initialize to current time so first delta respects update rate
    };
  }

  /**
   * Update the coalescing rate from a new Settings_Service revision.
   * Consumes the exact selected value and source revision (Req 47.21).
   */
  updateBounds(resolvedBounds: ResolvedRenderingBounds): void {
    this.updateRateMs = resolvedBounds.bounds.updateRateMs;
    this.boundsSourceRevision = resolvedBounds.sourceRevision;
  }

  /**
   * Push a visual delta into the coalescing buffer.
   * If a delta for the same stableKey already exists, it is replaced (last-write-wins).
   * This ensures settled content equals the latest projection.
   */
  pushDelta(delta: VisualDelta): void {
    this.settled = false;
    this.pendingMap.set(delta.stableKey, delta);

    if (delta.projectionRevision > this.state.latestRevision) {
      this.state.latestRevision = delta.projectionRevision;
    }

    if (!this.state.flushScheduled) {
      this.scheduleFlush();
    }
  }

  /**
   * Push multiple deltas at once.
   */
  pushDeltas(deltas: VisualDelta[]): void {
    for (const delta of deltas) {
      this.pushDelta(delta);
    }
  }

  /**
   * Force an immediate flush of all pending deltas. Useful for testing
   * and for ensuring content equivalence when the scheduler is being torn down.
   */
  flushNow(): void {
    this.cancelPendingFlush();
    this.doFlush();
  }

  /**
   * Whether the scheduler has no pending deltas (settled state).
   * After settling, rendered content equals the latest projection.
   */
  isSettled(): boolean {
    return this.settled && this.pendingMap.size === 0;
  }

  /**
   * Return the latest projection revision seen across all deltas.
   */
  getLatestRevision(): number {
    return this.state.latestRevision;
  }

  /**
   * Return the number of pending coalesced deltas awaiting flush.
   */
  getPendingCount(): number {
    return this.pendingMap.size;
  }

  /**
   * Return the bounds source revision being used.
   */
  getBoundsSourceRevision(): number {
    return this.boundsSourceRevision;
  }

  /**
   * Return the configured update rate (from Settings_Service).
   */
  getUpdateRateMs(): number {
    return this.updateRateMs;
  }

  /**
   * Cancel any pending flush and clear all state. Used during teardown.
   */
  dispose(): void {
    this.cancelPendingFlush();
    this.pendingMap.clear();
    this.settled = true;
  }

  // ─── Private ────────────────────────────────────────────────────

  private scheduleFlush(): void {
    const now = this.timer.now();
    const elapsed = now - this.state.lastFlushAt;
    const delay = Math.max(0, this.updateRateMs - elapsed);

    this.flushHandle = this.timer.schedule(() => this.doFlush(), delay);
    this.state.flushScheduled = true;
  }

  private doFlush(): void {
    this.state.flushScheduled = false;
    this.flushHandle = null;

    if (this.pendingMap.size === 0) {
      this.settled = true;
      return;
    }

    // Collect the coalesced deltas (last-write-wins per stableKey)
    const deltas = Array.from(this.pendingMap.values());
    const latestRevision = this.state.latestRevision;

    // Clear pending before callback to allow re-entrant pushes
    this.pendingMap.clear();
    this.state.lastFlushAt = this.timer.now();

    // Invoke flush callback with the coalesced deltas
    this.flushCallback(deltas, latestRevision);

    // If new deltas arrived during the flush callback, schedule another flush
    if (this.pendingMap.size > 0) {
      this.scheduleFlush();
    } else {
      this.settled = true;
    }
  }

  private cancelPendingFlush(): void {
    if (this.flushHandle !== null) {
      this.timer.cancel(this.flushHandle);
      this.flushHandle = null;
      this.state.flushScheduled = false;
    }
  }
}
