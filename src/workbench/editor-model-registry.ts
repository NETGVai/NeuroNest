/**
 * EditorModelRegistry — the canonical, workspace-relative editor-model owner
 * (FUT-PKG-07-EXPERIENCE/T-003, NN-WORKSPACE-011).
 *
 * Monaco models are canonical per workspace-relative URI/version: there is
 * EXACTLY ONE model per workspace-relative path, no matter how many tabs/groups
 * reference it (NN-WORKSPACE-011 "canonical per workspace-relative URI/version",
 * "avoid duplicate lifecycle events"). This registry is the single owner of
 * that model lifecycle:
 *
 *   - {@link acquire} returns the SAME model for a given workspace-relative URI
 *     and emits a `created` lifecycle event only on first acquisition; a second
 *     acquisition of the same URI increments a reference count and emits NO
 *     duplicate `created` (duplicate model lifecycle is PROHIBITED).
 *   - Paths are workspace-relative POSIX only; an absolute host path is REFUSED
 *     (typed FORBIDDEN) so no absolute path is ever disclosed (NN-INV-004).
 *   - Save/change versions coordinate with the canonical ChangeService and LSP:
 *     {@link recordEdit} advances the in-memory content version, and a save is
 *     proposed as a ChangeSet through the injected ChangeService — the registry
 *     is NEVER a durable file writer (NN-INV-008). A stale base is surfaced from
 *     ChangeService verbatim (STALE_REVISION) with the model retained.
 *   - {@link release} decrements the reference count and disposes (emits
 *     `disposed`) exactly once when the last holder releases — again no
 *     duplicate lifecycle event.
 *
 * The registry holds NO durable file state: models are an in-memory view; the
 * only durable writer is the ChangeService (D-04/D-12). Recovery: after a crash
 * a model is re-acquired from the workspace bytes and re-synced to the committed
 * workspace revision, so a recovered model coordinates its version rather than
 * duplicating the lifecycle (NN-WORKSPACE-011, D-14).
 *
 * Design anchors: D-03, D-04, D-12, D-14. Requirements: NN-WORKSPACE-011,
 * NN-UI-001/003, NN-INV-004/008.
 */

import {
  CONTRACT_WRITE_VERSION,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';
import { normalizeWorkspaceRelative } from './deep-link.js';

/** The owner id for the editor-model authority (stamped on errors/events). */
export const EDITOR_MODEL_OWNER = 'authority-editor-model';

/** A model lifecycle event (NN-WORKSPACE-011 "avoid duplicate lifecycle events"). */
export type ModelLifecycleKind = 'created' | 'attached' | 'detached' | 'disposed';

export interface ModelLifecycleEvent {
  readonly kind: ModelLifecycleKind;
  readonly uri: string;
  /** Reference count AFTER applying this event. */
  readonly refCount: number;
  /** The model content version at the time of the event. */
  readonly version: number;
}

/**
 * A canonical editor model: exactly one exists per workspace-relative URI.
 * `contentVersion` advances on every edit; `savedVersion`/`baseWorkspaceRevision`
 * coordinate saves with the ChangeService and LSP (NN-WORKSPACE-011).
 */
export interface EditorModel {
  readonly uri: string;
  content: string;
  /** Monotonic in-memory content version (advances on each edit). */
  contentVersion: number;
  /** The content version last persisted through a ChangeSet promotion. */
  savedVersion: number;
  /** The workspace revision the model's saved bytes were authored against. */
  baseWorkspaceRevision: number;
  /** SHA-256 of the last saved bytes (optimistic-concurrency base for saves). */
  savedHash: string | null;
}

/** A typed editor-model failure (e.g. an absolute-path acquisition). */
export class EditorModelError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'EditorModelError';
    this.error = error;
  }
}

function modelError(code: ErrorCode, message: string, correlationId: string): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: EDITOR_MODEL_OWNER,
    operation: 'editor-model',
    correlationId,
    retryable: false,
    redaction: 'internal',
  };
}

interface RegistryEntry {
  readonly model: EditorModel;
  refCount: number;
}

/**
 * The single owner of the canonical editor-model lifecycle. Emitted lifecycle
 * events are appended in order to an internal log the caller can drain, so a
 * test/observer can assert exactly one `created`/`disposed` per URI.
 */
export class EditorModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly lifecycle: ModelLifecycleEvent[] = [];

  /**
   * Acquire the canonical model for a workspace-relative URI. First acquisition
   * creates the model (one `created` event); subsequent acquisitions of the
   * SAME URI return the SAME model instance, bump the reference count, and emit
   * `attached` — never a second `created` (no duplicate lifecycle).
   *
   * `initialContent`/`baseWorkspaceRevision`/`savedHash` seed the model from the
   * committed workspace bytes on first acquisition; they are IGNORED on reuse so
   * a re-acquire never resurrects a duplicate model or clobbers unsaved edits.
   */
  acquire(input: {
    readonly uri: string;
    readonly initialContent: string;
    readonly baseWorkspaceRevision: number;
    readonly savedHash?: string | null;
    readonly correlationId?: string;
  }): EditorModel {
    const uri = normalizeUri(input.uri, input.correlationId ?? 'corr-model');
    const existing = this.entries.get(uri);
    if (existing) {
      existing.refCount += 1;
      this.emit('attached', existing.model, existing.refCount);
      return existing.model;
    }
    const model: EditorModel = {
      uri,
      content: input.initialContent,
      contentVersion: 0,
      savedVersion: 0,
      baseWorkspaceRevision: input.baseWorkspaceRevision,
      savedHash: input.savedHash ?? null,
    };
    const entry: RegistryEntry = { model, refCount: 1 };
    this.entries.set(uri, entry);
    this.emit('created', model, 1);
    return model;
  }

  /** Whether a canonical model currently exists for a workspace-relative URI. */
  has(uri: string): boolean {
    return this.entries.has(normalizeUri(uri, 'corr-model'));
  }

  /** Peek the canonical model without changing its reference count. */
  peek(uri: string): EditorModel | undefined {
    return this.entries.get(normalizeUri(uri, 'corr-model'))?.model;
  }

  /** The live reference count for a URI (0 when absent). */
  refCount(uri: string): number {
    return this.entries.get(normalizeUri(uri, 'corr-model'))?.refCount ?? 0;
  }

  /**
   * Record an in-memory edit, advancing the content version (used to coordinate
   * save/change versions with the ChangeService and LSP). Editing a model that
   * is not open is a typed VALIDATION error (no implicit model creation).
   */
  recordEdit(uri: string, nextContent: string, correlationId = 'corr-model'): EditorModel {
    const entry = this.require(uri, correlationId);
    entry.model.content = nextContent;
    entry.model.contentVersion += 1;
    return entry.model;
  }

  /**
   * Mark the model saved at the given committed workspace revision after a
   * ChangeService promotion (the registry does NOT write files — the caller
   * routes the actual mutation through ChangeService). This aligns
   * `savedVersion`/`baseWorkspaceRevision`/`savedHash` with the committed
   * result so the next save uses a fresh optimistic base (NN-WORKSPACE-011).
   */
  markSaved(input: {
    readonly uri: string;
    readonly resultWorkspaceRevision: number;
    readonly savedHash: string;
    readonly correlationId?: string;
  }): EditorModel {
    const entry = this.require(input.uri, input.correlationId ?? 'corr-model');
    entry.model.savedVersion = entry.model.contentVersion;
    entry.model.baseWorkspaceRevision = input.resultWorkspaceRevision;
    entry.model.savedHash = input.savedHash;
    return entry.model;
  }

  /** Whether a model has unsaved in-memory edits (dirty). */
  isDirty(uri: string): boolean {
    const entry = this.entries.get(normalizeUri(uri, 'corr-model'));
    return entry ? entry.model.contentVersion !== entry.model.savedVersion : false;
  }

  /**
   * Release one holder of a model. When the last holder releases, the canonical
   * model is disposed and a single `disposed` event is emitted; earlier releases
   * emit `detached`. Releasing an unknown URI is a no-op (idempotent).
   */
  release(uri: string, correlationId = 'corr-model'): void {
    const key = normalizeUri(uri, correlationId);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.entries.delete(key);
      this.emit('disposed', entry.model, 0);
    } else {
      this.emit('detached', entry.model, entry.refCount);
    }
  }

  /**
   * Drain the ordered lifecycle event log accumulated since the last drain.
   * Used by observers/tests to assert exactly one `created`/`disposed` per URI.
   */
  drainLifecycle(): readonly ModelLifecycleEvent[] {
    const events = this.lifecycle.slice();
    this.lifecycle.length = 0;
    return events;
  }

  private require(uri: string, correlationId: string): RegistryEntry {
    const entry = this.entries.get(normalizeUri(uri, correlationId));
    if (!entry) {
      throw new EditorModelError(
        modelError('VALIDATION', `no open editor model for uri "${uri}"`, correlationId),
      );
    }
    return entry;
  }

  private emit(kind: ModelLifecycleKind, model: EditorModel, refCount: number): void {
    this.lifecycle.push({ kind, uri: model.uri, refCount, version: model.contentVersion });
  }
}

/** Normalize + validate a model URI as workspace-relative (no absolute host). */
function normalizeUri(uri: string, correlationId: string): string {
  try {
    return normalizeWorkspaceRelative(uri, correlationId);
  } catch (e) {
    // Re-stamp path failures as editor-model errors so callers see one taxonomy.
    const message = e instanceof Error ? e.message : 'invalid model uri';
    throw new EditorModelError(modelError('FORBIDDEN', message, correlationId));
  }
}
