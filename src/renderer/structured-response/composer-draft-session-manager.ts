/**
 * ComposerDraftSessionManager
 *
 * Mounts one DraftTransactionStore per session, provides the
 * ComposerGlobalsShim for backward compatibility with legacy renderer code,
 * manages IME composition state, auto-resize bounds from SettingsBoundsService,
 * and handles session lifecycle (creation, switching, disposal).
 *
 * Key invariants:
 * - Exactly one DraftTransactionStore per sessionId at any time
 * - Session isolation: changes in one session never affect another
 * - ComposerGlobalsShim proxies to the active session store without
 *   duplicating state
 * - IME composition is tracked as ephemeral state, not persisted in
 *   the undo journal
 * - Auto-resize bounds come from SettingsBoundsService, never hard-coded
 * - Export/restore provides recoverable persistence across failures
 *
 * Requirements: 15.1, 15.6–15.9
 */

import {
  DraftTransactionStore,
} from '../../harness/presentation/composer/draft-transaction-store';
import type {
  DraftChange,
  DraftRevision,
  SubmissionContext,
  SubmissionResult,
  SettlementResult,
  AsyncResolutionResult,
  ContextItem,
  AttachmentDraft,
} from '../../harness/presentation/composer/draft-transaction-store';
import type {
  DraftTransactionStoreConfig,
  DraftRetentionPolicy,
} from '../../harness/presentation/composer/types';
import { DEFAULT_RETENTION_POLICY } from '../../harness/presentation/composer/types';

// ─── IME Composition State ──────────────────────────────────────

/**
 * Tracks active Input Method Editor (IME) composition state.
 * IME is ephemeral — not stored in the undo journal — because
 * composition text is provisional until committed.
 */
export interface IMECompositionState {
  /** Whether an IME composition session is active. */
  isComposing: boolean;
  /** The provisional composition text (not yet committed). */
  compositionText: string;
  /** The cursor offset where composition started in the draft text. */
  compositionStart: number;
  /** The cursor offset where composition ends. */
  compositionEnd: number;
}

const EMPTY_IME_STATE: IMECompositionState = Object.freeze({
  isComposing: false,
  compositionText: '',
  compositionStart: 0,
  compositionEnd: 0,
});

// ─── Auto-Resize Bounds ─────────────────────────────────────────

/**
 * Auto-resize configuration bounds resolved from SettingsBoundsService.
 * All values in device-independent pixels (dip) or lines.
 */
export interface ComposerResizeBounds {
  /** Minimum height in dip. */
  minHeightDip: number;
  /** Maximum height in dip. */
  maxHeightDip: number;
  /** Minimum number of visible lines. */
  minLines: number;
  /** Maximum number of visible lines before scroll. */
  maxLines: number;
  /** Line height in dip for calculation. */
  lineHeightDip: number;
}

export const DEFAULT_RESIZE_BOUNDS: ComposerResizeBounds = Object.freeze({
  minHeightDip: 40,
  maxHeightDip: 320,
  minLines: 1,
  maxLines: 12,
  lineHeightDip: 24,
});

// ─── Per-Session Store Entry ────────────────────────────────────

interface SessionStoreEntry {
  store: DraftTransactionStore;
  ime: IMECompositionState;
  resizeBounds: ComposerResizeBounds;
  /** Whether the session is the currently active one. */
  active: boolean;
  /** Monotonic creation order for deterministic disposal. */
  createdAt: number;
}

// ─── Session Manager Configuration ─────────────────────────────

export interface ComposerDraftSessionManagerConfig {
  /** Default retention policy for new session stores. */
  retentionPolicy?: DraftRetentionPolicy;
  /** Default resize bounds (can be overridden per session). */
  defaultResizeBounds?: ComposerResizeBounds;
  /** Maximum number of inactive sessions to keep (LRU eviction). */
  maxInactiveSessions?: number;
}

// ─── Exported State Snapshot ────────────────────────────────────

export interface SessionDraftExport {
  sessionId: string;
  journal: DraftRevision[];
  cursor: number;
  ime: IMECompositionState;
}

// ─── Session Manager ────────────────────────────────────────────

export class ComposerDraftSessionManager {
  private readonly sessions = new Map<string, SessionStoreEntry>();
  private activeSessionId: string | null = null;
  private readonly retentionPolicy: DraftRetentionPolicy;
  private readonly defaultResizeBounds: ComposerResizeBounds;
  private readonly maxInactiveSessions: number;
  private creationCounter = 0;

  constructor(config: ComposerDraftSessionManagerConfig = {}) {
    this.retentionPolicy = config.retentionPolicy ?? DEFAULT_RETENTION_POLICY;
    this.defaultResizeBounds = config.defaultResizeBounds ?? DEFAULT_RESIZE_BOUNDS;
    this.maxInactiveSessions = config.maxInactiveSessions ?? 10;
  }

  // ─── Session Lifecycle ──────────────────────────────────────────

  /**
   * Mount a DraftTransactionStore for the given session. If already mounted,
   * returns the existing store. If switching from another session, deactivates
   * the previous one.
   */
  mountSession(sessionId: string, resizeBounds?: ComposerResizeBounds): DraftTransactionStore {
    // Deactivate current active session
    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      const prev = this.sessions.get(this.activeSessionId);
      if (prev) {
        prev.active = false;
      }
    }

    let entry = this.sessions.get(sessionId);
    if (!entry) {
      const config: DraftTransactionStoreConfig = {
        sessionId,
        draftId: `draft-${sessionId}`,
        retentionPolicy: this.retentionPolicy,
      };
      const store = new DraftTransactionStore(config);
      entry = {
        store,
        ime: { ...EMPTY_IME_STATE },
        resizeBounds: resizeBounds ?? { ...this.defaultResizeBounds },
        active: true,
        createdAt: this.creationCounter++,
      };
      this.sessions.set(sessionId, entry);
      this.evictInactiveSessions();
    } else {
      entry.active = true;
      if (resizeBounds) {
        entry.resizeBounds = resizeBounds;
      }
    }

    this.activeSessionId = sessionId;
    return entry.store;
  }

  /**
   * Get the store for a specific session without activating it.
   * Returns undefined if no store is mounted for that session.
   */
  getSessionStore(sessionId: string): DraftTransactionStore | undefined {
    return this.sessions.get(sessionId)?.store;
  }

  /**
   * Get the active session's store, or undefined if none is active.
   */
  getActiveStore(): DraftTransactionStore | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId)?.store;
  }

  /**
   * Get the active session ID.
   */
  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /**
   * Dispose of a specific session's store and all its state.
   */
  disposeSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    this.sessions.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
    return true;
  }

  /**
   * Dispose all sessions and reset the manager.
   */
  disposeAll(): void {
    this.sessions.clear();
    this.activeSessionId = null;
    this.creationCounter = 0;
  }

  /**
   * Get all mounted session IDs.
   */
  getMountedSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Check if a session has a mounted store.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ─── IME Composition ────────────────────────────────────────────

  /**
   * Signal the start of an IME composition in the active session.
   * The composition text is ephemeral and not part of the undo journal.
   */
  beginIMEComposition(compositionStart: number): void {
    const entry = this.getActiveEntry();
    if (!entry) return;
    entry.ime = {
      isComposing: true,
      compositionText: '',
      compositionStart,
      compositionEnd: compositionStart,
    };
  }

  /**
   * Update the provisional IME composition text.
   */
  updateIMEComposition(compositionText: string, compositionEnd: number): void {
    const entry = this.getActiveEntry();
    if (!entry || !entry.ime.isComposing) return;
    entry.ime = {
      ...entry.ime,
      compositionText,
      compositionEnd,
    };
  }

  /**
   * Commit the IME composition: apply the final text as a draft change
   * and clear the IME state. This creates an undoable revision.
   */
  commitIMEComposition(committedText: string): DraftRevision | null {
    const entry = this.getActiveEntry();
    if (!entry || !entry.ime.isComposing) return null;

    const { compositionStart } = entry.ime;
    const currentText = entry.store.getCurrentRevision().text;

    // Replace the composition range with the committed text
    const newText =
      currentText.slice(0, compositionStart) +
      committedText +
      currentText.slice(compositionStart);

    const newEnd = compositionStart + committedText.length;

    // Clear IME state
    entry.ime = { ...EMPTY_IME_STATE };

    // Apply as an undoable change
    return entry.store.applyChange({
      text: newText,
      selection: { start: newEnd, end: newEnd, direction: 'none' },
    });
  }

  /**
   * Cancel the IME composition without committing.
   */
  cancelIMEComposition(): void {
    const entry = this.getActiveEntry();
    if (!entry) return;
    entry.ime = { ...EMPTY_IME_STATE };
  }

  /**
   * Get the current IME state for the active session.
   */
  getIMEState(): IMECompositionState {
    const entry = this.getActiveEntry();
    if (!entry) return { ...EMPTY_IME_STATE };
    return { ...entry.ime };
  }

  /**
   * Get the IME state for a specific session.
   */
  getSessionIMEState(sessionId: string): IMECompositionState {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ...EMPTY_IME_STATE };
    return { ...entry.ime };
  }

  // ─── Auto-Resize Bounds ─────────────────────────────────────────

  /**
   * Update the auto-resize bounds for the active session.
   */
  setResizeBounds(bounds: ComposerResizeBounds): void {
    const entry = this.getActiveEntry();
    if (!entry) return;
    entry.resizeBounds = { ...bounds };
  }

  /**
   * Get the auto-resize bounds for the active session.
   */
  getResizeBounds(): ComposerResizeBounds {
    const entry = this.getActiveEntry();
    if (!entry) return { ...this.defaultResizeBounds };
    return { ...entry.resizeBounds };
  }

  /**
   * Calculate the effective height in dip based on content line count.
   * Clamps to the configured min/max bounds.
   */
  calculateEffectiveHeight(lineCount: number): number {
    const bounds = this.getResizeBounds();
    const clampedLines = Math.max(bounds.minLines, Math.min(lineCount, bounds.maxLines));
    const heightFromLines = clampedLines * bounds.lineHeightDip;
    return Math.max(bounds.minHeightDip, Math.min(heightFromLines, bounds.maxHeightDip));
  }

  /**
   * Get the auto-resize bounds for a specific session.
   */
  getSessionResizeBounds(sessionId: string): ComposerResizeBounds {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ...this.defaultResizeBounds };
    return { ...entry.resizeBounds };
  }

  // ─── Export/Restore ─────────────────────────────────────────────

  /**
   * Export the active session's draft state for recoverable persistence.
   * Requirements 15.8: recoverable drafts on failure/late response.
   */
  exportSession(sessionId: string): SessionDraftExport | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    const exported = entry.store.export();
    return {
      sessionId,
      journal: exported.journal,
      cursor: exported.cursor,
      ime: { ...entry.ime },
    };
  }

  /**
   * Restore a session's draft state from a previously exported snapshot.
   * Creates the session if it doesn't exist.
   */
  restoreSession(data: SessionDraftExport): DraftTransactionStore {
    let entry = this.sessions.get(data.sessionId);
    if (!entry) {
      // Mount first, then restore
      this.mountSession(data.sessionId);
      entry = this.sessions.get(data.sessionId)!;
    }
    entry.store.restore(data.journal, data.cursor);
    // Only restore IME if it was composing (edge case: crash during IME)
    if (data.ime.isComposing) {
      entry.ime = { ...data.ime };
    }
    return entry.store;
  }

  // ─── Private ────────────────────────────────────────────────────

  private getActiveEntry(): SessionStoreEntry | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  /**
   * Evict oldest inactive sessions when over the limit.
   */
  private evictInactiveSessions(): void {
    const inactive: Array<[string, SessionStoreEntry]> = [];
    for (const [id, entry] of this.sessions) {
      if (!entry.active) {
        inactive.push([id, entry]);
      }
    }

    if (inactive.length <= this.maxInactiveSessions) return;

    // Sort by creation time, evict oldest first
    inactive.sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toEvict = inactive.length - this.maxInactiveSessions;
    for (let i = 0; i < toEvict; i++) {
      this.sessions.delete(inactive[i][0]);
    }
  }
}

// ─── ComposerGlobalsShim ────────────────────────────────────────

/**
 * ComposerGlobalsShim provides temporary backward compatibility for legacy
 * renderer code that expects a global mutable draft interface.
 *
 * It proxies all operations to the active session's DraftTransactionStore
 * without duplicating state. Legacy code should migrate to direct store
 * access; this shim is a migration bridge.
 *
 * Requirements: 15.1, 15.9
 */
export class ComposerGlobalsShim {
  private readonly manager: ComposerDraftSessionManager;

  constructor(manager: ComposerDraftSessionManager) {
    this.manager = manager;
  }

  // ─── Legacy-compatible accessors ────────────────────────────────

  /** Get the current draft text (legacy: was a global variable). */
  get text(): string {
    const store = this.manager.getActiveStore();
    return store ? store.getCurrentRevision().text : '';
  }

  /** Set the draft text (legacy: direct assignment). */
  set text(value: string) {
    const store = this.manager.getActiveStore();
    if (store) {
      store.applyChange({ text: value });
    }
  }

  /** Get the current mode. */
  get mode(): string {
    const store = this.manager.getActiveStore();
    return store ? store.getCurrentRevision().mode : 'chat';
  }

  /** Set the current mode. */
  set mode(value: string) {
    const store = this.manager.getActiveStore();
    if (store) {
      store.applyChange({ mode: value as any });
    }
  }

  /** Get current attachments. */
  get attachments(): readonly AttachmentDraft[] {
    const store = this.manager.getActiveStore();
    return store ? store.getCurrentRevision().attachmentDrafts : [];
  }

  /** Get current context items. */
  get contextItems(): readonly ContextItem[] {
    const store = this.manager.getActiveStore();
    return store ? store.getCurrentRevision().contextItems : [];
  }

  /** Whether undo is available. */
  get canUndo(): boolean {
    const store = this.manager.getActiveStore();
    return store ? store.canUndo() : false;
  }

  /** Whether redo is available. */
  get canRedo(): boolean {
    const store = this.manager.getActiveStore();
    return store ? store.canRedo() : false;
  }

  /** Get the current revision number. */
  get revision(): number {
    const store = this.manager.getActiveStore();
    return store ? store.getCurrentRevisionNumber() : 0;
  }

  /** Whether an IME composition is active. */
  get isComposing(): boolean {
    return this.manager.getIMEState().isComposing;
  }

  // ─── Legacy-compatible mutations ────────────────────────────────

  /** Apply a draft change (legacy: was scattered mutations). */
  applyChange(change: DraftChange): DraftRevision | null {
    const store = this.manager.getActiveStore();
    return store ? store.applyChange(change) : null;
  }

  /** Undo one step. */
  undo(): DraftRevision | null {
    const store = this.manager.getActiveStore();
    return store ? store.undo() : null;
  }

  /** Redo one step. */
  redo(): DraftRevision | null {
    const store = this.manager.getActiveStore();
    return store ? store.redo() : null;
  }

  /** Submit the current draft. */
  submit(context: SubmissionContext): SubmissionResult | null {
    const store = this.manager.getActiveStore();
    return store ? store.submit(context) : null;
  }

  /** Confirm a submission. */
  confirmSubmission(revision: number): boolean {
    const store = this.manager.getActiveStore();
    return store ? store.confirmSubmission(revision) : false;
  }

  /** Clear the active draft (new blank revision). */
  clear(): void {
    const store = this.manager.getActiveStore();
    if (store) {
      store.applyChange({
        text: '',
        mode: 'chat',
        contextItems: [],
        attachmentDrafts: [],
        selection: { start: 0, end: 0, direction: 'none' },
      });
    }
  }

  /** Get the underlying session manager (for migration code). */
  getManager(): ComposerDraftSessionManager {
    return this.manager;
  }

  /** Get the active session's store directly. */
  getActiveStore(): DraftTransactionStore | undefined {
    return this.manager.getActiveStore();
  }
}
