/**
 * EditorModelStore — Canonical Monaco model registry.
 *
 * Maintains at most one live Monaco text model per canonical workspace file URI.
 * Tracks reference counts (how many editor groups have this model open).
 * Emits lifecycle events (modelCreated, modelDisposed) exactly once per version.
 * Increments documentVersion on content edits.
 *
 * Requirements: 1.1, 1.2, 1.9
 */

import { canonicalizeUri } from './uri-canonicalization';
import type {
  EditorModelRecord,
  ITextModel,
  ModelLifecycleEvent,
  ModelLifecycleEventType,
} from './types';

export type ModelLifecycleListener = (event: ModelLifecycleEvent) => void;

/** Factory function that creates an ITextModel from URI and content. */
export type ModelFactory = (uri: string, content: string) => ITextModel;

export class EditorModelStore {
  private readonly models: Map<string, EditorModelRecord> = new Map();
  private readonly listeners: Set<ModelLifecycleListener> = new Set();
  private readonly changeDisposables: Map<string, { dispose(): void }> = new Map();
  private readonly modelFactory: ModelFactory;

  /**
   * Track which lifecycle versions have already been emitted to prevent duplicates.
   * Key: `${canonicalUri}:${type}:${documentVersion}`
   */
  private readonly emittedEvents: Set<string> = new Set();

  constructor(modelFactory: ModelFactory) {
    this.modelFactory = modelFactory;
  }

  /**
   * Subscribe to lifecycle events.
   */
  onLifecycleEvent(listener: ModelLifecycleListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Get or create a model for the given URI.
   * If the model already exists, increments the reference count.
   * If it does not exist, creates one and emits a `modelCreated` event.
   *
   * Returns the EditorModelRecord.
   */
  acquireModel(uri: string, content: string): EditorModelRecord {
    const canonicalUri = canonicalizeUri(uri);
    const existing = this.models.get(canonicalUri);

    if (existing && !existing.disposed) {
      existing.referenceCount++;
      return existing;
    }

    // Create a new model
    const model = this.modelFactory(canonicalUri, content);
    const record: EditorModelRecord = {
      canonicalUri,
      model,
      documentVersion: 1,
      referenceCount: 1,
      disposed: false,
    };

    this.models.set(canonicalUri, record);

    // Listen for content changes to increment documentVersion
    const disposable = model.onDidChangeContent(() => {
      record.documentVersion++;
    });
    this.changeDisposables.set(canonicalUri, disposable);

    // Emit lifecycle event exactly once
    this.emitLifecycleEvent('modelCreated', canonicalUri, record.documentVersion);

    return record;
  }

  /**
   * Release a reference to a model. Decrements the reference count.
   * Does NOT dispose the model even at refcount 0.
   * Disposal requires explicit `disposeModel()` call after user confirmation.
   */
  releaseReference(uri: string): void {
    const canonicalUri = canonicalizeUri(uri);
    const record = this.models.get(canonicalUri);
    if (!record || record.disposed) return;

    record.referenceCount = Math.max(0, record.referenceCount - 1);
  }

  /**
   * Dispose a model after user confirmation.
   * Emits a `modelDisposed` event exactly once per version.
   * Only allowed when referenceCount is 0.
   *
   * Returns true if disposed, false if still has references or already disposed.
   */
  disposeModel(uri: string): boolean {
    const canonicalUri = canonicalizeUri(uri);
    const record = this.models.get(canonicalUri);
    if (!record || record.disposed) return false;

    if (record.referenceCount > 0) {
      return false;
    }

    record.disposed = true;

    // Clean up change listener
    const disposable = this.changeDisposables.get(canonicalUri);
    if (disposable) {
      disposable.dispose();
      this.changeDisposables.delete(canonicalUri);
    }

    // Dispose the underlying model
    record.model.dispose();

    // Emit lifecycle event exactly once
    this.emitLifecycleEvent('modelDisposed', canonicalUri, record.documentVersion);

    // Remove the record
    this.models.delete(canonicalUri);

    return true;
  }

  /**
   * Get a model record by URI without modifying reference count.
   */
  getModel(uri: string): EditorModelRecord | undefined {
    const canonicalUri = canonicalizeUri(uri);
    return this.models.get(canonicalUri);
  }

  /**
   * Check if a model exists for the given URI.
   */
  hasModel(uri: string): boolean {
    const canonicalUri = canonicalizeUri(uri);
    const record = this.models.get(canonicalUri);
    return record !== undefined && !record.disposed;
  }

  /**
   * Get the reference count for a model.
   */
  getReferenceCount(uri: string): number {
    const canonicalUri = canonicalizeUri(uri);
    const record = this.models.get(canonicalUri);
    if (!record || record.disposed) return 0;
    return record.referenceCount;
  }

  /**
   * Get the current document version for a model.
   */
  getDocumentVersion(uri: string): number | undefined {
    const canonicalUri = canonicalizeUri(uri);
    const record = this.models.get(canonicalUri);
    if (!record || record.disposed) return undefined;
    return record.documentVersion;
  }

  /**
   * Get all currently managed canonical URIs.
   */
  getActiveUris(): string[] {
    return [...this.models.keys()];
  }

  private emitLifecycleEvent(type: ModelLifecycleEventType, canonicalUri: string, documentVersion: number): void {
    const eventKey = `${canonicalUri}:${type}:${documentVersion}`;
    if (this.emittedEvents.has(eventKey)) {
      return; // Suppress duplicate
    }
    this.emittedEvents.add(eventKey);

    const event: ModelLifecycleEvent = {
      type,
      canonicalUri,
      documentVersion,
      timestamp: Date.now(),
    };

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
