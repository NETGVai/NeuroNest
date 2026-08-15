/**
 * StaleResponseFilter — Discards stale LSP responses and diagnostics.
 *
 * Validates that incoming responses match the expected URI, Document_Version,
 * and request generation. Discards BOTH diagnostics and responses on any
 * mismatch, cancelled token, or timed-out request.
 *
 * Requirements: 3.5, 3.6
 */

// ─── Types ──────────────────────────────────────────────────────

/** Metadata for a tracked request */
export interface TrackedRequest {
  /** Unique identifier for this request */
  requestId: string;
  /** The canonical URI this request targets */
  canonicalUri: string;
  /** The document version at the time of the request */
  documentVersion: number;
  /** The request generation (increments on supersession) */
  requestGeneration: number;
  /** Whether the request's cancellation token has been triggered */
  cancelled: boolean;
  /** Timestamp when the request was created */
  createdAt: number;
  /** Timeout in milliseconds (0 = no timeout) */
  timeoutMs: number;
}

/** An incoming response to be validated */
export interface IncomingResponse {
  /** The request ID this response is for */
  requestId: string;
  /** The URI the response claims to target */
  canonicalUri: string;
  /** The document version the response was computed against */
  documentVersion: number;
}

/** The reason a response was discarded */
export type DiscardReason =
  | 'uri_mismatch'
  | 'version_mismatch'
  | 'cancelled'
  | 'timed_out'
  | 'superseded'
  | 'unknown_request';

/** Result of filtering a response */
export interface FilterResult {
  /** Whether the response should be accepted */
  accepted: boolean;
  /** Reason for discarding (if not accepted) */
  reason?: DiscardReason;
}

// ─── StaleResponseFilter ────────────────────────────────────────

/**
 * StaleResponseFilter — Guards Monaco from stale or invalid LSP responses.
 *
 * Every response and diagnostic is checked against:
 * 1. URI match — response URI must match the request URI
 * 2. Version match — response version must match or exceed the current model version
 * 3. Cancellation — request token must not be cancelled
 * 4. Timeout — request must not have exceeded its timeout
 * 5. Supersession — request generation must be current
 *
 * BOTH diagnostics and responses are discarded on any mismatch.
 *
 * Requirements: 3.5, 3.6
 */
export class StaleResponseFilter {
  private activeRequests: Map<string, TrackedRequest> = new Map();
  private currentGenerations: Map<string, number> = new Map();

  // ─── Request Tracking ─────────────────────────────────────────

  /**
   * Track a new request for later response validation.
   * Automatically supersedes previous requests for the same URI.
   */
  trackRequest(
    requestId: string,
    canonicalUri: string,
    documentVersion: number,
    timeoutMs: number = 0,
  ): TrackedRequest {
    // Increment generation for this URI (marks older requests superseded)
    const currentGen = (this.currentGenerations.get(canonicalUri) ?? 0) + 1;
    this.currentGenerations.set(canonicalUri, currentGen);

    const tracked: TrackedRequest = {
      requestId,
      canonicalUri,
      documentVersion,
      requestGeneration: currentGen,
      cancelled: false,
      createdAt: Date.now(),
      timeoutMs,
    };

    this.activeRequests.set(requestId, tracked);
    return tracked;
  }

  /**
   * Mark a request as cancelled by its token.
   */
  cancelRequest(requestId: string): boolean {
    const tracked = this.activeRequests.get(requestId);
    if (!tracked) return false;
    tracked.cancelled = true;
    return true;
  }

  /**
   * Remove a request from tracking (after processing or discarding).
   */
  removeRequest(requestId: string): void {
    this.activeRequests.delete(requestId);
  }

  /**
   * Get a tracked request by ID.
   */
  getTrackedRequest(requestId: string): TrackedRequest | null {
    return this.activeRequests.get(requestId) ?? null;
  }

  // ─── Response Filtering ───────────────────────────────────────

  /**
   * Validate an incoming response against the tracked request state.
   *
   * Discards BOTH diagnostics and responses when:
   * - URI does not match
   * - Document_Version does not match or exceed the current model version
   * - Request token has been cancelled
   * - Request has timed out
   * - Request has been superseded by a newer generation
   *
   * Requirements: 3.5, 3.6
   */
  filterResponse(
    response: IncomingResponse,
    currentModelVersion: number,
  ): FilterResult {
    const tracked = this.activeRequests.get(response.requestId);

    // Unknown request — discard
    if (!tracked) {
      return { accepted: false, reason: 'unknown_request' };
    }

    // URI mismatch — discard both response and diagnostics
    if (response.canonicalUri !== tracked.canonicalUri) {
      return { accepted: false, reason: 'uri_mismatch' };
    }

    // Version mismatch — response version must match or exceed current model version
    if (response.documentVersion < currentModelVersion) {
      return { accepted: false, reason: 'version_mismatch' };
    }

    // Cancelled token — discard
    if (tracked.cancelled) {
      return { accepted: false, reason: 'cancelled' };
    }

    // Timed out — discard
    if (this.isTimedOut(tracked)) {
      return { accepted: false, reason: 'timed_out' };
    }

    // Superseded — a newer request generation exists for this URI
    if (this.isSuperseded(tracked)) {
      return { accepted: false, reason: 'superseded' };
    }

    return { accepted: true };
  }

  /**
   * Validate incoming diagnostics against the current model state.
   * Uses the same rules as filterResponse — diagnostics are never
   * treated more leniently than responses.
   *
   * Requirements: 3.5, 3.6
   */
  filterDiagnostics(
    requestId: string,
    diagnosticUri: string,
    diagnosticVersion: number,
    currentModelVersion: number,
  ): FilterResult {
    return this.filterResponse(
      {
        requestId,
        canonicalUri: diagnosticUri,
        documentVersion: diagnosticVersion,
      },
      currentModelVersion,
    );
  }

  // ─── Supersession ─────────────────────────────────────────────

  /**
   * Get all superseded request IDs for a given URI.
   * These requests have been replaced by newer generations.
   */
  getSupersededRequests(canonicalUri: string): string[] {
    const currentGen = this.currentGenerations.get(canonicalUri) ?? 0;
    const superseded: string[] = [];

    for (const [id, tracked] of this.activeRequests) {
      if (tracked.canonicalUri === canonicalUri && tracked.requestGeneration < currentGen) {
        superseded.push(id);
      }
    }

    return superseded;
  }

  /**
   * Get the current generation for a URI.
   */
  getCurrentGeneration(canonicalUri: string): number {
    return this.currentGenerations.get(canonicalUri) ?? 0;
  }

  // ─── Timeout ──────────────────────────────────────────────────

  /**
   * Check if a tracked request has timed out.
   */
  isTimedOut(tracked: TrackedRequest): boolean {
    if (tracked.timeoutMs <= 0) return false;
    return Date.now() - tracked.createdAt > tracked.timeoutMs;
  }

  /**
   * Get all timed-out request IDs.
   */
  getTimedOutRequests(): string[] {
    const timedOut: string[] = [];
    for (const [id, tracked] of this.activeRequests) {
      if (this.isTimedOut(tracked)) {
        timedOut.push(id);
      }
    }
    return timedOut;
  }

  // ─── Queries ──────────────────────────────────────────────────

  /**
   * Check if a request has been superseded.
   */
  isSuperseded(tracked: TrackedRequest): boolean {
    const currentGen = this.currentGenerations.get(tracked.canonicalUri) ?? 0;
    return tracked.requestGeneration < currentGen;
  }

  /**
   * Get all active (non-superseded, non-cancelled, non-timed-out) request IDs.
   */
  getActiveRequestIds(): string[] {
    const active: string[] = [];
    for (const [id, tracked] of this.activeRequests) {
      if (!tracked.cancelled && !this.isTimedOut(tracked) && !this.isSuperseded(tracked)) {
        active.push(id);
      }
    }
    return active;
  }

  /**
   * Get the count of tracked requests.
   */
  getTrackedCount(): number {
    return this.activeRequests.size;
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Clear all tracked requests and generation state.
   */
  reset(): void {
    this.activeRequests.clear();
    this.currentGenerations.clear();
  }

  /**
   * Purge stale entries (superseded, cancelled, or timed-out).
   * Returns the number of entries removed.
   */
  purgeStale(): number {
    const toRemove: string[] = [];
    for (const [id, tracked] of this.activeRequests) {
      if (tracked.cancelled || this.isTimedOut(tracked) || this.isSuperseded(tracked)) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.activeRequests.delete(id);
    }
    return toRemove.length;
  }
}
