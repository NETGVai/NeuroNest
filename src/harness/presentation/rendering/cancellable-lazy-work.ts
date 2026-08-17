/**
 * Cancellable Lazy Work Manager
 *
 * Manages deferred heavy rendering work (Markdown, highlighting, Mermaid, diff,
 * image, terminal, web, spill) that is lazy within the configured viewport margin
 * and cancellable by ownership token or deadline.
 *
 * When deferred rendering leaves the viewport or becomes obsolete, owned work is
 * cancelled within the configured cancellation deadline from Settings_Service.
 *
 * Requirements: 47.5, 47.6, 47.14, 47.19, 47.21
 */

import type {
  LazyWorkDescriptor,
  LazyWorkKind,
  LazyWorkStatus,
  TrackedLazyWork,
  ResolvedRenderingBounds,
} from './types';

/**
 * Timer abstraction for testability.
 */
export interface LazyWorkTimer {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/**
 * Default timer implementation.
 */
export const defaultLazyWorkTimer: LazyWorkTimer = {
  now: () => Date.now(),
  schedule: (cb, delay) => setTimeout(cb, delay),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Callback invoked when lazy work should be executed.
 */
export type LazyWorkExecutor = (descriptor: LazyWorkDescriptor) => void;

/**
 * Callback invoked when lazy work is cancelled.
 */
export type LazyWorkCancelHandler = (descriptor: LazyWorkDescriptor, reason: 'left_viewport' | 'deadline' | 'token_revoked' | 'obsolete') => void;

/**
 * CancellableLazyWorkManager tracks and schedules heavy rendering work that is
 * deferred until content enters the viewport margin. Work is cancellable by:
 * - Ownership token revocation
 * - Deadline expiry
 * - Content leaving the viewport margin
 * - Becoming obsolete (newer content revision)
 *
 * All bounds are consumed from Settings_Service with source revisions.
 */
export class CancellableLazyWorkManager {
  private readonly work: Map<string, TrackedLazyWork> = new Map();
  private readonly deadlineHandles: Map<string, unknown> = new Map();
  private readonly revokedTokens: Set<string> = new Set();
  private viewportMarginPx: number;
  private cancellationDeadlineMs: number;
  private boundsSourceRevision: number;
  private timer: LazyWorkTimer;
  private executor: LazyWorkExecutor;
  private cancelHandler: LazyWorkCancelHandler;

  constructor(
    resolvedBounds: ResolvedRenderingBounds,
    executor: LazyWorkExecutor,
    cancelHandler: LazyWorkCancelHandler,
    timer: LazyWorkTimer = defaultLazyWorkTimer,
  ) {
    this.viewportMarginPx = resolvedBounds.bounds.viewportMarginPx;
    this.cancellationDeadlineMs = resolvedBounds.bounds.cancellationDeadlineMs;
    this.boundsSourceRevision = resolvedBounds.sourceRevision;
    this.executor = executor;
    this.cancelHandler = cancelHandler;
    this.timer = timer;
  }

  /**
   * Update bounds from a new Settings_Service revision (Req 47.21).
   */
  updateBounds(resolvedBounds: ResolvedRenderingBounds): void {
    this.viewportMarginPx = resolvedBounds.bounds.viewportMarginPx;
    this.cancellationDeadlineMs = resolvedBounds.bounds.cancellationDeadlineMs;
    this.boundsSourceRevision = resolvedBounds.sourceRevision;
  }

  /**
   * Register a lazy work unit. If the descriptor is within the viewport margin,
   * the work is scheduled immediately. Otherwise, it remains pending.
   */
  register(descriptor: LazyWorkDescriptor): void {
    // Check if ownership token is already revoked
    if (this.revokedTokens.has(descriptor.ownershipToken)) {
      this.cancelHandler(descriptor, 'token_revoked');
      return;
    }

    const tracked: TrackedLazyWork = {
      descriptor,
      status: 'pending',
    };
    this.work.set(descriptor.id, tracked);

    // Schedule deadline enforcement
    const now = this.timer.now();
    const timeToDeadline = descriptor.deadline - now;
    if (timeToDeadline <= 0) {
      // Already past deadline
      this.cancelWork(descriptor.id, 'deadline');
      return;
    }

    const handle = this.timer.schedule(
      () => this.cancelWork(descriptor.id, 'deadline'),
      timeToDeadline,
    );
    this.deadlineHandles.set(descriptor.id, handle);

    // If within viewport margin, start immediately
    if (descriptor.inViewportMargin) {
      this.startWork(descriptor.id);
    }
  }

  /**
   * Notify that a node has entered the viewport margin. Starts any pending
   * lazy work for nodes that match.
   */
  onEnterViewportMargin(stableKey: string): void {
    for (const [id, tracked] of this.work) {
      if (tracked.descriptor.stableKey === stableKey && tracked.status === 'pending') {
        this.startWork(id);
      }
    }
  }

  /**
   * Notify that a node has left the viewport margin. Cancels any pending or
   * active lazy work within the configured cancellation deadline.
   */
  onLeaveViewportMargin(stableKey: string): void {
    for (const [id, tracked] of this.work) {
      if (tracked.descriptor.stableKey === stableKey &&
          (tracked.status === 'pending' || tracked.status === 'active')) {
        this.cancelWork(id, 'left_viewport');
      }
    }
  }

  /**
   * Revoke an ownership token, cancelling all work owned by that token.
   */
  revokeToken(ownershipToken: string): void {
    this.revokedTokens.add(ownershipToken);
    for (const [id, tracked] of this.work) {
      if (tracked.descriptor.ownershipToken === ownershipToken &&
          (tracked.status === 'pending' || tracked.status === 'active')) {
        this.cancelWork(id, 'token_revoked');
      }
    }
  }

  /**
   * Mark a work item as obsolete (e.g., newer content revision for same node).
   */
  markObsolete(workId: string): void {
    this.cancelWork(workId, 'obsolete');
  }

  /**
   * Mark a work item as completed.
   */
  markCompleted(workId: string): void {
    const tracked = this.work.get(workId);
    if (!tracked) return;
    tracked.status = 'completed';
    tracked.resolvedAt = this.timer.now();
    this.clearDeadlineHandle(workId);
  }

  /**
   * Get the status of a specific work item.
   */
  getWorkStatus(workId: string): LazyWorkStatus | undefined {
    return this.work.get(workId)?.status;
  }

  /**
   * Get all tracked work items (for diagnostics).
   */
  getAllWork(): ReadonlyMap<string, TrackedLazyWork> {
    return this.work;
  }

  /**
   * Get the number of pending work items.
   */
  getPendingCount(): number {
    let count = 0;
    for (const tracked of this.work.values()) {
      if (tracked.status === 'pending') count++;
    }
    return count;
  }

  /**
   * Get the number of active work items.
   */
  getActiveCount(): number {
    let count = 0;
    for (const tracked of this.work.values()) {
      if (tracked.status === 'active') count++;
    }
    return count;
  }

  /**
   * Return the bounds source revision being used.
   */
  getBoundsSourceRevision(): number {
    return this.boundsSourceRevision;
  }

  /**
   * Dispose all tracked work and cancel pending deadlines.
   */
  dispose(): void {
    for (const [id] of this.deadlineHandles) {
      this.clearDeadlineHandle(id);
    }
    this.work.clear();
    this.revokedTokens.clear();
  }

  // ─── Private ────────────────────────────────────────────────────

  private startWork(workId: string): void {
    const tracked = this.work.get(workId);
    if (!tracked || tracked.status !== 'pending') return;

    tracked.status = 'active';
    tracked.startedAt = this.timer.now();
    this.executor(tracked.descriptor);
  }

  private cancelWork(workId: string, reason: 'left_viewport' | 'deadline' | 'token_revoked' | 'obsolete'): void {
    const tracked = this.work.get(workId);
    if (!tracked) return;
    if (tracked.status === 'completed' || tracked.status === 'cancelled') return;

    tracked.status = 'cancelled';
    tracked.resolvedAt = this.timer.now();
    this.clearDeadlineHandle(workId);
    this.cancelHandler(tracked.descriptor, reason);
  }

  private clearDeadlineHandle(workId: string): void {
    const handle = this.deadlineHandles.get(workId);
    if (handle !== undefined) {
      this.timer.cancel(handle);
      this.deadlineHandles.delete(workId);
    }
  }
}
