/**
 * ModelClosureService — Per-attempt confirmation flow for model disposal.
 *
 * Every closure pathway (user close, shutdown, memory pressure, system cleanup)
 * requires a fresh per-attempt confirmation token. Auto-save, prior responses,
 * or stale tokens never bypass the confirmation gate.
 *
 * Requirements: 1.5, 1.6
 */

import { canonicalizeUri } from './uri-canonicalization';
import type { EditorModelStore } from './editor-model-store';

/** Classification of a model's current state for closure purposes. */
export type ModelClosureClassification =
  | 'clean'
  | 'dirty'
  | 'pending-change'
  | 'final-reference'
  | 'already-closed'
  | 'never-created';

/** The pathway initiating the closure request. */
export type ClosurePathway =
  | 'user-close'
  | 'shutdown'
  | 'memory-pressure'
  | 'system-cleanup';

/** Confirmation options presented to the user. */
export type ClosureOption = 'Close' | 'Cancel' | 'Save' | 'Discard';

/** Result of resolving a confirmation token. */
export type ClosureResolution = 'Close' | 'Save' | 'Discard' | 'Cancel';

/** Result of attempting a model closure. */
export interface ClosureResult {
  disposed: boolean;
  lspCloseEmitted: boolean;
  noop: boolean;
  reason?: string;
}

/** A pending closure request with its confirmation token. */
export interface ClosureRequest {
  token: string;
  canonicalUri: string;
  classification: ModelClosureClassification;
  pathway: ClosurePathway;
  options: ClosureOption[];
  createdAt: number;
  resolved: boolean;
  resolution: ClosureResolution | null;
}

export type LspCloseListener = (canonicalUri: string, documentVersion: number) => void;

/**
 * ModelClosureService enforces fresh per-attempt confirmation for every model
 * disposal pathway. It blocks disposal until the token is explicitly resolved.
 */
export class ModelClosureService {
  private readonly pendingRequests: Map<string, ClosureRequest> = new Map();
  private readonly lspCloseListeners: Set<LspCloseListener> = new Set();
  private readonly closedModels: Set<string> = new Set();
  private tokenCounter = 0;

  /** Callback to check if a model is dirty. */
  private readonly isDirty: (canonicalUri: string) => boolean;
  /** Callback to check if a model has pending change sets. */
  private readonly hasPendingChanges: (canonicalUri: string) => boolean;

  private readonly store: EditorModelStore;

  constructor(
    store: EditorModelStore,
    options: {
      isDirty: (canonicalUri: string) => boolean;
      hasPendingChanges: (canonicalUri: string) => boolean;
    },
  ) {
    this.store = store;
    this.isDirty = options.isDirty;
    this.hasPendingChanges = options.hasPendingChanges;
  }

  /**
   * Subscribe to LSP close notifications.
   */
  onLspClose(listener: LspCloseListener): { dispose(): void } {
    this.lspCloseListeners.add(listener);
    return {
      dispose: () => {
        this.lspCloseListeners.delete(listener);
      },
    };
  }

  /**
   * Request closure of a model. Returns a ClosureRequest with a fresh token.
   * The token must be resolved via `resolveToken()` before disposal proceeds.
   *
   * Every call generates a new token; old tokens for the same URI are invalidated.
   */
  requestClosure(uri: string, pathway: ClosurePathway): ClosureRequest {
    const canonicalUri = canonicalizeUri(uri);
    const classification = this.classifyModel(canonicalUri);
    const options = this.deriveOptions(classification);
    const token = this.generateToken();

    // Invalidate any prior pending request for this URI
    for (const [existingToken, req] of this.pendingRequests) {
      if (req.canonicalUri === canonicalUri && !req.resolved) {
        this.pendingRequests.delete(existingToken);
      }
    }

    const request: ClosureRequest = {
      token,
      canonicalUri,
      classification,
      pathway,
      options,
      createdAt: Date.now(),
      resolved: false,
      resolution: null,
    };

    this.pendingRequests.set(token, request);
    return request;
  }

  /**
   * Resolve a confirmation token with the user's choice.
   * Returns the closure result. Only a valid, unresolved token is accepted.
   */
  resolveToken(token: string, resolution: ClosureResolution): ClosureResult {
    const request = this.pendingRequests.get(token);

    if (!request) {
      // Token not found — expired or never existed
      return { disposed: false, lspCloseEmitted: false, noop: true, reason: 'invalid-token' };
    }

    if (request.resolved) {
      // Token already used — per-attempt means no reuse
      return { disposed: false, lspCloseEmitted: false, noop: true, reason: 'token-already-resolved' };
    }

    // Mark resolved
    request.resolved = true;
    request.resolution = resolution;

    if (resolution === 'Cancel') {
      return { disposed: false, lspCloseEmitted: false, noop: false };
    }

    // Handle already-closed and never-created as no-ops after confirmation
    if (request.classification === 'already-closed' || request.classification === 'never-created') {
      return { disposed: false, lspCloseEmitted: false, noop: true, reason: request.classification };
    }

    // For Save/Discard/Close, attempt disposal
    if (resolution === 'Close' || resolution === 'Discard') {
      return this.performDisposal(request);
    }

    if (resolution === 'Save') {
      // Save flow: the caller is expected to save before calling this.
      // After save, proceed with disposal.
      return this.performDisposal(request);
    }

    return { disposed: false, lspCloseEmitted: false, noop: true, reason: 'unknown-resolution' };
  }

  /**
   * Validate whether a token is current and unresolved for a given URI.
   */
  isTokenValid(token: string): boolean {
    const request = this.pendingRequests.get(token);
    return request !== undefined && !request.resolved;
  }

  /**
   * Get the pending request for a token.
   */
  getRequest(token: string): ClosureRequest | undefined {
    return this.pendingRequests.get(token);
  }

  /**
   * Check whether a model has been confirmed-closed through this service.
   */
  isModelClosed(uri: string): boolean {
    const canonicalUri = canonicalizeUri(uri);
    return this.closedModels.has(canonicalUri);
  }

  /**
   * Classify a model's current state for closure decisions.
   */
  classifyModel(uri: string): ModelClosureClassification {
    const canonicalUri = canonicalizeUri(uri);

    // Already closed through this service
    if (this.closedModels.has(canonicalUri)) {
      return 'already-closed';
    }

    // Never created in the store
    if (!this.store.hasModel(canonicalUri)) {
      return 'never-created';
    }

    // Check if this is the final reference
    const refCount = this.store.getReferenceCount(canonicalUri);

    // Has pending agent change sets
    if (this.hasPendingChanges(canonicalUri)) {
      return 'pending-change';
    }

    // Content has been modified but not saved
    if (this.isDirty(canonicalUri)) {
      return 'dirty';
    }

    // Final reference (refcount will be 0 after this close)
    if (refCount <= 1) {
      return 'final-reference';
    }

    return 'clean';
  }

  /**
   * Derive the confirmation options based on model classification.
   * Clean models: Close/Cancel
   * Dirty or pending-change: Save/Discard/Cancel
   * Final-reference (clean): Close/Cancel
   * Already-closed / never-created: Close/Cancel (confirmation required, then no-op)
   */
  private deriveOptions(classification: ModelClosureClassification): ClosureOption[] {
    switch (classification) {
      case 'dirty':
      case 'pending-change':
        return ['Save', 'Discard', 'Cancel'];
      case 'clean':
      case 'final-reference':
      case 'already-closed':
      case 'never-created':
        return ['Close', 'Cancel'];
    }
  }

  /**
   * Perform actual model disposal after confirmation.
   * Emits exactly one LSP close notification for the final reference.
   */
  private performDisposal(request: ClosureRequest): ClosureResult {
    const { canonicalUri } = request;

    // Release the reference first
    this.store.releaseReference(canonicalUri);

    // Check if we can dispose (refcount should be 0)
    const refCount = this.store.getReferenceCount(canonicalUri);

    if (refCount === 0) {
      // Get document version before disposal for LSP notification
      const documentVersion = this.store.getDocumentVersion(canonicalUri);

      // Dispose the model
      const disposed = this.store.disposeModel(canonicalUri);

      if (disposed) {
        this.closedModels.add(canonicalUri);

        // Emit exactly one LSP close notification
        this.emitLspClose(canonicalUri, documentVersion ?? 0);

        return { disposed: true, lspCloseEmitted: true, noop: false };
      }
    }

    // Model still has references from other groups — just released our reference
    return { disposed: false, lspCloseEmitted: false, noop: false };
  }

  /**
   * Emit the LSP close notification to all listeners.
   */
  private emitLspClose(canonicalUri: string, documentVersion: number): void {
    for (const listener of this.lspCloseListeners) {
      listener(canonicalUri, documentVersion);
    }
  }

  /**
   * Generate a fresh unique token. Each request gets a unique token
   * to prevent reuse of prior confirmations.
   */
  private generateToken(): string {
    this.tokenCounter++;
    return `closure-token-${this.tokenCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
