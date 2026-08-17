/**
 * Composer Globals Shim
 *
 * Provides narrow compatibility shims that expose the same interface
 * as the legacy mutable renderer globals (_cieAttachedFiles, slash command
 * state, processing indicators, selection state, and prompt history)
 * while delegating all state to the per-session DraftTransactionStore.
 *
 * These shims create NO durable renderer state themselves. All state
 * lives in the DraftTransactionStore. They exist solely to allow
 * incremental migration: legacy call sites continue using the old API
 * while state management is unified in the transactional store.
 *
 * Once all legacy call sites are retired (task 11.7), these shims
 * can be removed.
 *
 * Requirements: 35.13, 40.1-40.24
 */

import type {
  DraftTransactionStore,
  AttachmentDraft,
  DraftChange,
  Selection,
  DraftRevision,
} from '../presentation/composer/draft-transaction-store.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Minimal file descriptor matching the legacy renderer contract.
 * Legacy code expects { name, size, type? } objects in the attached files list.
 */
export interface LegacyFileDescriptor {
  name: string;
  size: number;
  type?: string | undefined;
}

/**
 * Slash command definition matching the legacy renderer contract.
 */
export interface SlashCommandDef {
  name: string;
  description: string;
}

/**
 * Slash state exposed by the shim. The legacy renderer reads these
 * to drive the autocomplete dropdown.
 */
export interface SlashState {
  visible: boolean;
  index: number;
  filtered: SlashCommandDef[];
}

/**
 * Prompt history entry for the history navigation shim.
 */
export interface HistoryEntry {
  text: string;
  mode?: string | undefined;
  sessionId?: string | undefined;
}

/**
 * Configuration for the ComposerGlobalsShim.
 */
export interface ComposerGlobalsShimConfig {
  store: DraftTransactionStore;
  commands?: SlashCommandDef[] | undefined;
  maxHistorySize?: number | undefined;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_HISTORY = 100;

const DEFAULT_COMMANDS: SlashCommandDef[] = [
  { name: '/new', description: 'Start a new conversation' },
  { name: '/clear', description: 'Clear chat history' },
  { name: '/plan', description: 'Enter plan mode' },
  { name: '/loop', description: 'Start an automation loop' },
  { name: '/help', description: 'Show available commands' },
];

// ─── Shim Implementation ────────────────────────────────────────

/**
 * ComposerGlobalsShim wraps a DraftTransactionStore and exposes the
 * same interface as the legacy mutable globals. All state is delegated
 * to the store; no state is held independently in this shim beyond
 * ephemeral presentation concerns (slash dropdown index, processing flag).
 *
 * Ephemeral-only state kept here:
 * - slash dropdown visibility/index/filter (presentation-only, not durable)
 * - processing flag (turn lifecycle, not draft state)
 * - history navigation index (ephemeral cursor into submitted snapshots)
 * - current draft saved before history navigation (ephemeral)
 *
 * These are NOT durable renderer state; they are transient UI concerns
 * that exist only while the shim is alive.
 */
export class ComposerGlobalsShim {
  private readonly store: DraftTransactionStore;
  private readonly commands: SlashCommandDef[];
  private readonly maxHistorySize: number;

  // Ephemeral presentation state (not durable, not persisted)
  private slashVisible: boolean = false;
  private slashIndex: number = 0;
  private slashFiltered: SlashCommandDef[] = [];
  private processing: boolean = false;
  private historyIndex: number = -1;
  private savedDraftBeforeHistory: string = '';

  constructor(config: ComposerGlobalsShimConfig) {
    this.store = config.store;
    this.commands = config.commands ?? DEFAULT_COMMANDS;
    this.maxHistorySize = config.maxHistorySize ?? DEFAULT_MAX_HISTORY;
  }

  // ─── Attached Files Shim ────────────────────────────────────────

  /**
   * Get the current attached files list.
   * Reads from DraftTransactionStore attachment drafts.
   * Equivalent to legacy: `cieGetAttachedFiles()`
   */
  getAttachedFiles(): LegacyFileDescriptor[] {
    const revision = this.store.getCurrentRevision();
    return revision.attachmentDrafts.map((draft) => ({
      name: draft.filename,
      size: draft.byteSize,
      type: draft.mediaType,
    }));
  }

  /**
   * Add files to the draft.
   * Equivalent to legacy: `_cieAddFiles(files)`
   * Deduplicates by name+size matching the legacy behavior.
   */
  addFiles(files: LegacyFileDescriptor[]): void {
    const current = this.store.getCurrentRevision();
    const existingDrafts = [...current.attachmentDrafts];

    const newDrafts: AttachmentDraft[] = [];
    for (const file of files) {
      const isDuplicate = existingDrafts.some(
        (d) => d.filename === file.name && d.byteSize === file.size,
      );
      if (!isDuplicate) {
        newDrafts.push({
          draftAttachmentId: `draft-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: file.name,
          mediaType: file.type ?? 'application/octet-stream',
          byteSize: file.size,
          state: 'validating',
        });
      }
    }

    if (newDrafts.length > 0) {
      this.store.applyChange({
        attachmentDrafts: [...existingDrafts, ...newDrafts],
      });
    }
  }

  /**
   * Remove a file at the given index.
   * Equivalent to legacy: `_cieRemoveFile(index)`
   */
  removeFile(index: number): void {
    const current = this.store.getCurrentRevision();
    const drafts = [...current.attachmentDrafts];
    if (index >= 0 && index < drafts.length) {
      drafts.splice(index, 1);
      this.store.applyChange({ attachmentDrafts: drafts });
    }
  }

  /**
   * Clear all attached files.
   * Equivalent to legacy: `cieClearAttachedFiles()`
   */
  clearAttachedFiles(): void {
    this.store.applyChange({ attachmentDrafts: [] });
  }

  // ─── Slash Command Shim ─────────────────────────────────────────

  /**
   * Get the current slash autocomplete state.
   */
  getSlashState(): SlashState {
    return {
      visible: this.slashVisible,
      index: this.slashIndex,
      filtered: this.slashFiltered,
    };
  }

  /**
   * Show slash autocomplete with the given filter.
   * Equivalent to legacy: `_cieShowSlash(filter)`
   */
  showSlash(filter?: string): void {
    const term = (filter ?? '').toLowerCase();
    this.slashFiltered = this.commands.filter(
      (cmd) => cmd.name.indexOf(term) === 0 || cmd.name.indexOf('/' + term) === 0,
    );

    if (this.slashFiltered.length === 0) {
      this.hideSlash();
      return;
    }

    this.slashIndex = 0;
    this.slashVisible = true;
  }

  /**
   * Hide slash autocomplete.
   * Equivalent to legacy: `_cieHideSlash()`
   */
  hideSlash(): void {
    this.slashVisible = false;
    this.slashIndex = 0;
    this.slashFiltered = [];
  }

  /**
   * Move slash selection up/down.
   */
  moveSlashSelection(direction: 'up' | 'down'): void {
    if (!this.slashVisible) return;
    if (direction === 'down') {
      this.slashIndex = Math.min(this.slashIndex + 1, this.slashFiltered.length - 1);
    } else {
      this.slashIndex = Math.max(this.slashIndex - 1, 0);
    }
  }

  /**
   * Select the current slash command and apply it to the draft.
   * Equivalent to legacy: `_cieSelectSlashCommand(index)`
   */
  selectSlashCommand(index?: number): void {
    const idx = index ?? this.slashIndex;
    if (idx < 0 || idx >= this.slashFiltered.length) return;

    const cmd = this.slashFiltered[idx]!;
    this.store.applyChange({
      text: cmd.name + ' ',
      commandClaim: cmd.name,
      mode: 'command',
    });
    this.hideSlash();
  }

  // ─── Processing State Shim ──────────────────────────────────────

  /**
   * Set the processing state.
   * Equivalent to legacy: `cieSetProcessing(isProcessing)`
   *
   * Note: Processing state is a turn lifecycle concern, not draft state.
   * It is kept as an ephemeral presentation flag in the shim only.
   */
  setProcessing(isProcessing: boolean): void {
    this.processing = isProcessing;
  }

  /**
   * Get the processing state.
   * Equivalent to legacy: `cieIsProcessing()`
   */
  isProcessing(): boolean {
    return this.processing;
  }

  // ─── Selection Shim ─────────────────────────────────────────────

  /**
   * Get the current selection from the store.
   */
  getSelection(): Selection {
    return this.store.getCurrentRevision().selection;
  }

  /**
   * Update the selection in the store.
   * Applies as a draft change for proper undo/redo tracking.
   */
  setSelection(selection: Selection): void {
    this.store.applyChange({ selection });
  }

  // ─── History / Undo Shim ────────────────────────────────────────

  /**
   * Get the prompt history from the store's submitted snapshots.
   * Equivalent to legacy: reading from localStorage promptHistory.
   */
  getHistory(): HistoryEntry[] {
    const submissions = this.store.getSubmissions();
    return submissions
      .slice(-this.maxHistorySize)
      .map((snap) => ({
        text: snap.text,
        mode: snap.mode,
        sessionId: snap.sessionId,
      }));
  }

  /**
   * Get the current history navigation index.
   * -1 means not navigating history.
   */
  getHistoryIndex(): number {
    return this.historyIndex;
  }

  /**
   * Navigate to the previous history entry (Up arrow behavior).
   * Equivalent to legacy: ArrowUp handler in index.ts.
   * Preserves the current draft before entering history navigation.
   */
  navigateHistoryUp(): string | null {
    const history = this.getHistory();
    if (history.length === 0) return null;

    if (this.historyIndex === -1) {
      // Save current draft before entering history
      this.savedDraftBeforeHistory = this.store.getCurrentRevision().text;
      this.historyIndex = history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    }

    const entry = history[this.historyIndex];
    return entry?.text ?? null;
  }

  /**
   * Navigate to the next history entry (Down arrow behavior).
   * Returns to the saved draft when reaching the end.
   */
  navigateHistoryDown(): string | null {
    const history = this.getHistory();
    if (this.historyIndex === -1) return null;

    if (this.historyIndex < history.length - 1) {
      this.historyIndex++;
      return history[this.historyIndex]?.text ?? null;
    } else {
      // Return to current draft
      this.historyIndex = -1;
      return this.savedDraftBeforeHistory;
    }
  }

  /**
   * Exit history navigation and restore the saved draft.
   */
  exitHistoryNavigation(): void {
    this.historyIndex = -1;
    this.savedDraftBeforeHistory = '';
  }

  /**
   * Add a prompt to history by submitting through the store.
   * Equivalent to legacy: localStorage-based history push.
   * The store's submit() creates an immutable snapshot that serves as history.
   */
  addToHistory(text: string): void {
    // History is derived from submissions; ensure the draft matches
    // then submit. This is the migration path: legacy code calls
    // addToHistory after sending, we route through the store.
    const current = this.store.getCurrentRevision();
    if (current.text !== text) {
      this.store.applyChange({ text });
    }
    // Note: actual submission should be done by the caller via
    // store.submit(). This method exists only for backward compat
    // with code that managed history separately from submission.
  }

  // ─── Undo / Redo ────────────────────────────────────────────────

  /**
   * Undo the last draft change.
   * Delegates directly to DraftTransactionStore.
   */
  undo(): DraftRevision | null {
    return this.store.undo();
  }

  /**
   * Redo a previously undone change.
   * Delegates directly to DraftTransactionStore.
   */
  redo(): DraftRevision | null {
    return this.store.redo();
  }

  /**
   * Whether undo is available.
   */
  canUndo(): boolean {
    return this.store.canUndo();
  }

  /**
   * Whether redo is available.
   */
  canRedo(): boolean {
    return this.store.canRedo();
  }

  // ─── Draft Text ─────────────────────────────────────────────────

  /**
   * Get the current draft text.
   * Equivalent to legacy: reading textarea.value
   */
  getText(): string {
    return this.store.getCurrentRevision().text;
  }

  /**
   * Set the draft text.
   * Equivalent to legacy: textarea.value assignment with undo tracking.
   */
  setText(text: string): void {
    this.store.applyChange({ text });
  }

  // ─── Store Access ───────────────────────────────────────────────

  /**
   * Get the underlying DraftTransactionStore.
   * Used when callers need direct store access during migration.
   */
  getStore(): DraftTransactionStore {
    return this.store;
  }

  /**
   * Get the current full revision from the store.
   */
  getCurrentRevision(): DraftRevision {
    return this.store.getCurrentRevision();
  }
}
