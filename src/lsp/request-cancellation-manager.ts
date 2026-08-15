/**
 * RequestCancellationManager — LSP request lifecycle and cancellation.
 *
 * Tracks active requests by requestId, cancels superseded requests
 * (same URI, newer request replaces older), cancels on token cancellation
 * and timeout, and sends protocol cancellation ($/cancelRequest) to server
 * when supported.
 *
 * Requirements: 3.5, 3.6
 */

import { StaleResponseFilter, type TrackedRequest } from './stale-response-filter.js';

// ─── Types ──────────────────────────────────────────────────────

/** Callback to send $/cancelRequest to the language server */
export type ServerCancelFn = (requestId: string) => void;

/** Configuration for the cancellation manager */
export interface CancellationManagerConfig {
  /** Default timeout for requests in ms (0 = no timeout) */
  defaultTimeoutMs: number;
  /** Whether the server supports $/cancelRequest */
  serverSupportsCancellation: boolean;
}

/** Information about a managed request */
export interface ManagedRequest {
  /** The tracked request metadata */
  tracked: TrackedRequest;
  /** The workspace this request belongs to */
  workspaceId: string;
  /** Whether cancel was sent to the server */
  serverCancelSent: boolean;
  /** Timer handle for timeout (if active) */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

/** Event emitted when a request is cancelled */
export interface CancellationEvent {
  requestId: string;
  canonicalUri: string;
  reason: 'superseded' | 'token_cancelled' | 'timed_out';
  serverNotified: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_CANCELLATION_CONFIG: CancellationManagerConfig = {
  defaultTimeoutMs: 10000,
  serverSupportsCancellation: true,
};

// ─── RequestCancellationManager ─────────────────────────────────

/**
 * RequestCancellationManager — Manages LSP request cancellation lifecycle.
 *
 * Responsibilities:
 * - Track active requests by requestId
 * - Cancel superseded requests (same URI, newer request replaces older)
 * - Cancel on token cancellation
 * - Cancel on timeout
 * - Send $/cancelRequest to server when supported
 *
 * Requirements: 3.5, 3.6
 */
export class RequestCancellationManager {
  private managedRequests: Map<string, ManagedRequest> = new Map();
  private filter: StaleResponseFilter;
  private config: CancellationManagerConfig;
  private serverCancelFn: ServerCancelFn | null = null;
  private cancellationHistory: CancellationEvent[] = [];
  private maxHistorySize = 100;

  constructor(
    filter: StaleResponseFilter,
    config?: Partial<CancellationManagerConfig>,
  ) {
    this.filter = filter;
    this.config = { ...DEFAULT_CANCELLATION_CONFIG, ...config };
  }

  // ─── Configuration ────────────────────────────────────────────

  /**
   * Set the function used to send $/cancelRequest to the server.
   */
  setServerCancelFn(fn: ServerCancelFn): void {
    this.serverCancelFn = fn;
  }

  /**
   * Update whether the server supports cancellation.
   */
  setServerSupportsCancellation(supported: boolean): void {
    this.config.serverSupportsCancellation = supported;
  }

  // ─── Request Registration ─────────────────────────────────────

  /**
   * Register a new request. Automatically supersedes older requests
   * for the same URI and cancels them.
   *
   * Requirements: 3.5
   */
  registerRequest(
    requestId: string,
    workspaceId: string,
    canonicalUri: string,
    documentVersion: number,
    timeoutMs?: number,
  ): ManagedRequest {
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;

    // Track in the response filter first (this increments the generation counter)
    const tracked = this.filter.trackRequest(requestId, canonicalUri, documentVersion, timeout);

    // Cancel any superseded requests for the same URI AFTER generation is incremented
    this.cancelSupersededForUri(canonicalUri);

    // Set up timeout if configured
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        this.handleTimeout(requestId);
      }, timeout);
    }

    const managed: ManagedRequest = {
      tracked,
      workspaceId,
      serverCancelSent: false,
      timeoutHandle,
    };

    this.managedRequests.set(requestId, managed);
    return managed;
  }

  // ─── Cancellation ─────────────────────────────────────────────

  /**
   * Cancel a request due to token cancellation.
   * Sends $/cancelRequest to server when supported.
   *
   * Requirements: 3.5
   */
  cancelByToken(requestId: string): boolean {
    const managed = this.managedRequests.get(requestId);
    if (!managed) return false;

    this.filter.cancelRequest(requestId);
    this.sendServerCancel(requestId, managed);
    this.clearTimeout(managed);

    this.recordCancellation({
      requestId,
      canonicalUri: managed.tracked.canonicalUri,
      reason: 'token_cancelled',
      serverNotified: managed.serverCancelSent,
    });

    return true;
  }

  /**
   * Cancel all superseded requests for a given URI.
   * Called automatically when a new request is registered for the same URI.
   *
   * Requirements: 3.5
   */
  cancelSupersededForUri(canonicalUri: string): string[] {
    const superseded = this.filter.getSupersededRequests(canonicalUri);
    const cancelled: string[] = [];

    for (const requestId of superseded) {
      const managed = this.managedRequests.get(requestId);
      if (managed && !managed.tracked.cancelled) {
        this.filter.cancelRequest(requestId);
        this.sendServerCancel(requestId, managed);
        this.clearTimeout(managed);

        this.recordCancellation({
          requestId,
          canonicalUri,
          reason: 'superseded',
          serverNotified: managed.serverCancelSent,
        });

        cancelled.push(requestId);
      }
    }

    return cancelled;
  }

  /**
   * Handle a request timeout.
   *
   * Requirements: 3.5
   */
  private handleTimeout(requestId: string): void {
    const managed = this.managedRequests.get(requestId);
    if (!managed) return;

    // Only handle if not already cancelled
    if (managed.tracked.cancelled) return;

    this.filter.cancelRequest(requestId);
    this.sendServerCancel(requestId, managed);
    managed.timeoutHandle = null;

    this.recordCancellation({
      requestId,
      canonicalUri: managed.tracked.canonicalUri,
      reason: 'timed_out',
      serverNotified: managed.serverCancelSent,
    });
  }

  /**
   * Cancel all active requests (e.g., on service shutdown).
   */
  cancelAll(): void {
    for (const [requestId, managed] of this.managedRequests) {
      if (!managed.tracked.cancelled) {
        this.filter.cancelRequest(requestId);
        this.sendServerCancel(requestId, managed);
        this.clearTimeout(managed);
      }
    }
  }

  // ─── Request Completion ───────────────────────────────────────

  /**
   * Mark a request as completed (response received and processed).
   * Removes it from tracking.
   */
  completeRequest(requestId: string): void {
    const managed = this.managedRequests.get(requestId);
    if (managed) {
      this.clearTimeout(managed);
      this.managedRequests.delete(requestId);
      this.filter.removeRequest(requestId);
    }
  }

  // ─── Server Communication ─────────────────────────────────────

  /**
   * Send $/cancelRequest to the language server if supported.
   */
  private sendServerCancel(requestId: string, managed: ManagedRequest): void {
    if (
      this.config.serverSupportsCancellation &&
      this.serverCancelFn &&
      !managed.serverCancelSent
    ) {
      this.serverCancelFn(requestId);
      managed.serverCancelSent = true;
    }
  }

  // ─── Timeout Management ───────────────────────────────────────

  /**
   * Clear the timeout timer for a managed request.
   */
  private clearTimeout(managed: ManagedRequest): void {
    if (managed.timeoutHandle !== null) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = null;
    }
  }

  // ─── Queries ──────────────────────────────────────────────────

  /**
   * Get a managed request by ID.
   */
  getManagedRequest(requestId: string): ManagedRequest | null {
    return this.managedRequests.get(requestId) ?? null;
  }

  /**
   * Get all active (non-cancelled) request IDs.
   */
  getActiveRequestIds(): string[] {
    const active: string[] = [];
    for (const [id, managed] of this.managedRequests) {
      if (!managed.tracked.cancelled) {
        active.push(id);
      }
    }
    return active;
  }

  /**
   * Get the count of managed requests.
   */
  getManagedCount(): number {
    return this.managedRequests.size;
  }

  /**
   * Check if a request is currently being managed.
   */
  isManaged(requestId: string): boolean {
    return this.managedRequests.has(requestId);
  }

  /**
   * Get the cancellation history.
   */
  getCancellationHistory(): readonly CancellationEvent[] {
    return this.cancellationHistory;
  }

  // ─── History ──────────────────────────────────────────────────

  /**
   * Record a cancellation event in history.
   */
  private recordCancellation(event: CancellationEvent): void {
    this.cancellationHistory.push(event);
    if (this.cancellationHistory.length > this.maxHistorySize) {
      this.cancellationHistory.shift();
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Dispose of all resources and clear state.
   */
  dispose(): void {
    for (const managed of this.managedRequests.values()) {
      this.clearTimeout(managed);
    }
    this.managedRequests.clear();
    this.filter.reset();
    this.cancellationHistory = [];
    this.serverCancelFn = null;
  }
}
