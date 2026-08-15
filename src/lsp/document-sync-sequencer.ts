/**
 * DocumentSyncSequencer — Ordered document lifecycle event sequencing.
 *
 * Guarantees ordered didOpen, versioned incremental didChange,
 * didSave, and didClose messages using canonical URIs and Document_Versions.
 * Prevents out-of-order events from reaching the language server.
 *
 * Requirements: 3.2
 */

// ─── Types ──────────────────────────────────────────────────────

/** Document lifecycle event types */
export type DocumentEventType = 'didOpen' | 'didChange' | 'didSave' | 'didClose';

/** A document sync event with version tracking */
export interface DocumentSyncEvent {
  /** Event type */
  type: DocumentEventType;
  /** Canonical workspace URI */
  canonicalUri: string;
  /** Document version (monotonically increasing) */
  documentVersion: number;
  /** Workspace this document belongs to */
  workspaceId: string;
  /** Timestamp when the event was created */
  timestamp: number;
  /** Content for open/change events (optional) */
  content?: string;
  /** Incremental changes for didChange events */
  changes?: DocumentChange[];
}

/** An incremental document change */
export interface DocumentChange {
  /** Start offset of the change */
  rangeOffset: number;
  /** Length of the replaced text */
  rangeLength: number;
  /** The replacement text */
  text: string;
}

/** State tracked per open document */
export interface DocumentState {
  /** Canonical URI */
  canonicalUri: string;
  /** Current known document version */
  currentVersion: number;
  /** Whether the document is currently open */
  isOpen: boolean;
  /** Timestamp of last event processed */
  lastEventAt: number;
}

/** Result of attempting to sequence an event */
export interface SequenceResult {
  /** Whether the event was accepted */
  accepted: boolean;
  /** Reason for rejection (if not accepted) */
  reason?: string;
  /** The event if accepted */
  event?: DocumentSyncEvent;
}

// ─── DocumentSyncSequencer ──────────────────────────────────────

/**
 * DocumentSyncSequencer — Sequences document lifecycle events.
 *
 * Ensures:
 * - didOpen precedes any didChange/didSave/didClose for a document
 * - didChange events are versioned and only accepted if version > current
 * - didSave can only occur for an open document
 * - didClose only occurs for an open document and resets state
 * - No duplicate lifecycle events for the same version
 *
 * Requirements: 3.2
 */
export class DocumentSyncSequencer {
  private documents: Map<string, DocumentState> = new Map();
  private workspaceId: string;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  // ─── Event Sequencing ───────────────────────────────────────────

  /**
   * Attempt to sequence a didOpen event.
   * Fails if the document is already open.
   *
   * Requirements: 3.2
   */
  sequenceOpen(canonicalUri: string, version: number, content?: string): SequenceResult {
    const state = this.documents.get(canonicalUri);

    if (state && state.isOpen) {
      return {
        accepted: false,
        reason: `Document already open: ${canonicalUri}`,
      };
    }

    const event: DocumentSyncEvent = {
      type: 'didOpen',
      canonicalUri,
      documentVersion: version,
      workspaceId: this.workspaceId,
      timestamp: Date.now(),
      content,
    };

    this.documents.set(canonicalUri, {
      canonicalUri,
      currentVersion: version,
      isOpen: true,
      lastEventAt: event.timestamp,
    });

    return { accepted: true, event };
  }

  /**
   * Attempt to sequence a didChange event.
   * Fails if the document is not open or the version is not greater than current.
   *
   * Requirements: 3.2
   */
  sequenceChange(
    canonicalUri: string,
    version: number,
    changes?: DocumentChange[],
    content?: string,
  ): SequenceResult {
    const state = this.documents.get(canonicalUri);

    if (!state || !state.isOpen) {
      return {
        accepted: false,
        reason: `Document not open: ${canonicalUri}`,
      };
    }

    if (version <= state.currentVersion) {
      return {
        accepted: false,
        reason: `Version ${version} is not greater than current version ${state.currentVersion} for ${canonicalUri}`,
      };
    }

    const event: DocumentSyncEvent = {
      type: 'didChange',
      canonicalUri,
      documentVersion: version,
      workspaceId: this.workspaceId,
      timestamp: Date.now(),
      content,
      changes,
    };

    state.currentVersion = version;
    state.lastEventAt = event.timestamp;

    return { accepted: true, event };
  }

  /**
   * Attempt to sequence a didSave event.
   * Fails if the document is not open.
   *
   * Requirements: 3.2
   */
  sequenceSave(canonicalUri: string, version: number): SequenceResult {
    const state = this.documents.get(canonicalUri);

    if (!state || !state.isOpen) {
      return {
        accepted: false,
        reason: `Document not open: ${canonicalUri}`,
      };
    }

    if (version < state.currentVersion) {
      return {
        accepted: false,
        reason: `Save version ${version} is less than current version ${state.currentVersion} for ${canonicalUri}`,
      };
    }

    const event: DocumentSyncEvent = {
      type: 'didSave',
      canonicalUri,
      documentVersion: version,
      workspaceId: this.workspaceId,
      timestamp: Date.now(),
    };

    state.currentVersion = version;
    state.lastEventAt = event.timestamp;

    return { accepted: true, event };
  }

  /**
   * Attempt to sequence a didClose event.
   * Fails if the document is not open.
   *
   * Requirements: 3.2
   */
  sequenceClose(canonicalUri: string): SequenceResult {
    const state = this.documents.get(canonicalUri);

    if (!state || !state.isOpen) {
      return {
        accepted: false,
        reason: `Document not open: ${canonicalUri}`,
      };
    }

    const event: DocumentSyncEvent = {
      type: 'didClose',
      canonicalUri,
      documentVersion: state.currentVersion,
      workspaceId: this.workspaceId,
      timestamp: Date.now(),
    };

    state.isOpen = false;
    state.lastEventAt = event.timestamp;

    return { accepted: true, event };
  }

  // ─── State Queries ──────────────────────────────────────────────

  /**
   * Check if a document is currently open.
   */
  isDocumentOpen(canonicalUri: string): boolean {
    const state = this.documents.get(canonicalUri);
    return state?.isOpen ?? false;
  }

  /**
   * Get the current version of a document.
   * Returns null if the document has never been opened.
   */
  getDocumentVersion(canonicalUri: string): number | null {
    const state = this.documents.get(canonicalUri);
    return state?.currentVersion ?? null;
  }

  /**
   * Get the state of a document.
   */
  getDocumentState(canonicalUri: string): DocumentState | null {
    return this.documents.get(canonicalUri) ?? null;
  }

  /**
   * Get all currently open document URIs.
   */
  getOpenDocuments(): string[] {
    const open: string[] = [];
    for (const [uri, state] of this.documents) {
      if (state.isOpen) {
        open.push(uri);
      }
    }
    return open;
  }

  /**
   * Get the count of currently open documents.
   */
  getOpenDocumentCount(): number {
    let count = 0;
    for (const state of this.documents.values()) {
      if (state.isOpen) count++;
    }
    return count;
  }

  /**
   * Check if a version would be accepted for a change event.
   * Useful for pre-validation without emitting an event.
   */
  wouldAcceptVersion(canonicalUri: string, version: number): boolean {
    const state = this.documents.get(canonicalUri);
    if (!state || !state.isOpen) return false;
    return version > state.currentVersion;
  }

  /**
   * Get the workspace ID this sequencer operates on.
   */
  getWorkspaceId(): string {
    return this.workspaceId;
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  /**
   * Reset all document state (e.g., on server restart).
   */
  reset(): void {
    this.documents.clear();
  }

  /**
   * Remove tracking for a specific document (e.g., after close).
   */
  removeDocument(canonicalUri: string): void {
    this.documents.delete(canonicalUri);
  }
}
