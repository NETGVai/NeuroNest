/**
 * FileTreeLiveUpdates — Renderer module for real-time file tree updates.
 *
 * Provides both a pure state machine (for testability) and a DOM controller:
 * - Pure state: `fileTreeLiveReducer`, `applyFileTreeEvents`, helper selectors
 * - DOM controller: `FileTreeLiveUpdates` class (wires IPC to DOM)
 *
 * Listens for `agent:file-change` IPC events and updates the File_Tree DOM:
 * - Adds new entries when files are created
 * - Removes entries when files are deleted
 * - Visually distinguishes newly created files (highlight/badge)
 * - Displays modification indicator on modified files
 * - Removes highlighting when file creation activity completes
 *
 * All updates occur within 1 second of the operation completing.
 *
 * Feature-gated via `production_ux_file_tree_updates`
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import type { FileChangeEvent } from '../shared/production-ux-types.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ═══════════════════════════════════════════════════════════════════
// PURE STATE MACHINE (framework-agnostic, testable without DOM)
// ═══════════════════════════════════════════════════════════════════

// ─── Types ──────────────────────────────────────────────────────

/** A single entry tracked in the file tree live state. */
export interface FileTreeEntry {
  filePath: string;
  highlighted: boolean;
  modified: boolean;
  timestamp: number;
}

/** The full state for file tree live updates. */
export interface FileTreeLiveState {
  entries: Map<string, FileTreeEntry>;
  activityInProgress: boolean;
}

/** Events that can be dispatched to the reducer. */
export type FileTreeLiveEvent =
  | { type: 'file_change'; payload: FileChangeEvent }
  | { type: 'activity_complete' }
  | { type: 'reset' };

// ─── Initial State ──────────────────────────────────────────────

export const INITIAL_FILE_TREE_LIVE_STATE: FileTreeLiveState = {
  entries: new Map(),
  activityInProgress: false,
};

// ─── Reducer ────────────────────────────────────────────────────

/**
 * Pure reducer for file tree live update state transitions.
 *
 * - file_change(created): adds entry with highlighted=true, sets activityInProgress
 * - file_change(modified): adds/updates entry with modified=true (preserves highlight)
 * - file_change(deleted): removes entry
 * - activity_complete: clears all highlights, sets activityInProgress=false
 * - reset: returns to initial state
 */
export function fileTreeLiveReducer(
  state: FileTreeLiveState,
  event: FileTreeLiveEvent,
): FileTreeLiveState {
  switch (event.type) {
    case 'file_change':
      return handleFileChange(state, event.payload);
    case 'activity_complete':
      return handleActivityComplete(state);
    case 'reset':
      return { entries: new Map(), activityInProgress: false };
    default:
      return state;
  }
}

function handleFileChange(
  state: FileTreeLiveState,
  payload: FileChangeEvent,
): FileTreeLiveState {
  const newEntries = new Map(state.entries);

  switch (payload.type) {
    case 'created': {
      newEntries.set(payload.filePath, {
        filePath: payload.filePath,
        highlighted: true,
        modified: false,
        timestamp: payload.timestamp,
      });
      return { entries: newEntries, activityInProgress: true };
    }
    case 'modified': {
      const existing = newEntries.get(payload.filePath);
      if (existing) {
        newEntries.set(payload.filePath, {
          ...existing,
          modified: true,
          timestamp: payload.timestamp,
        });
      } else {
        newEntries.set(payload.filePath, {
          filePath: payload.filePath,
          highlighted: false,
          modified: true,
          timestamp: payload.timestamp,
        });
      }
      return { entries: newEntries, activityInProgress: state.activityInProgress };
    }
    case 'deleted': {
      newEntries.delete(payload.filePath);
      return { entries: newEntries, activityInProgress: state.activityInProgress };
    }
    default:
      return state;
  }
}

function handleActivityComplete(state: FileTreeLiveState): FileTreeLiveState {
  const newEntries = new Map<string, FileTreeEntry>();
  for (const [path, entry] of state.entries) {
    newEntries.set(path, { ...entry, highlighted: false });
  }
  return { entries: newEntries, activityInProgress: false };
}

// ─── Convenience: apply a sequence of events ────────────────────

/**
 * Apply a sequence of events to the initial state and return the final state.
 */
export function applyFileTreeEvents(events: FileTreeLiveEvent[]): FileTreeLiveState {
  return events.reduce(fileTreeLiveReducer, INITIAL_FILE_TREE_LIVE_STATE);
}

// ─── Selectors / Helpers ────────────────────────────────────────

/** Get all entries that are currently highlighted (newly created). */
export function getHighlightedEntries(state: FileTreeLiveState): FileTreeEntry[] {
  const result: FileTreeEntry[] = [];
  for (const entry of state.entries.values()) {
    if (entry.highlighted) result.push(entry);
  }
  return result;
}

/** Get all entries that have the modified indicator. */
export function getModifiedEntries(state: FileTreeLiveState): FileTreeEntry[] {
  const result: FileTreeEntry[] = [];
  for (const entry of state.entries.values()) {
    if (entry.modified) result.push(entry);
  }
  return result;
}

/** Check whether an entry exists for the given file path. */
export function hasEntry(state: FileTreeLiveState, filePath: string): boolean {
  return state.entries.has(filePath);
}

/** Get a specific entry by file path, or null if not found. */
export function getEntry(state: FileTreeLiveState, filePath: string): FileTreeEntry | null {
  return state.entries.get(filePath) ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// DOM CONTROLLER (wires pure state to actual DOM and IPC)
// ═══════════════════════════════════════════════════════════════════

// ─── Constants ──────────────────────────────────────────────────

/** CSS class for newly created file highlight */
const CLASS_CREATED = 'file-tree-created';
/** CSS class for modified file indicator */
const CLASS_MODIFIED = 'file-tree-modified';
/** Timeout before clearing created highlights after activity stops (ms) */
const HIGHLIGHT_CLEAR_DELAY_MS = 3000;

// ─── DOM Controller Types ───────────────────────────────────────

export interface FileTreeLiveUpdatesOptions {
  /** Whether the feature is enabled (from feature gate check) */
  enabled?: boolean;
  /** Optional container override for the file tree (defaults to #file-tree) */
  fileTreeContainer?: HTMLElement | null;
}

export interface FileTreeLiveUpdatesState {
  /** Whether the module is active and listening */
  active: boolean;
  /** Set of file paths currently highlighted as created */
  createdFiles: Set<string>;
  /** Set of file paths currently marked as modified */
  modifiedFiles: Set<string>;
  /** Whether file creation activity is currently ongoing */
  isCreationActive: boolean;
}

// ─── FileTreeLiveUpdates DOM Controller ─────────────────────────

export class FileTreeLiveUpdates {
  private state: FileTreeLiveState;
  private enabled: boolean;
  private active = false;
  private fileTreeContainer: HTMLElement | null;
  private fileChangeListener: ((...args: unknown[]) => void) | null = null;
  private taskCompleteListener: ((...args: unknown[]) => void) | null = null;
  private highlightClearTimer: ReturnType<typeof setTimeout> | null = null;
  private styleElement: HTMLStyleElement | null = null;

  constructor(options: FileTreeLiveUpdatesOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.fileTreeContainer = options.fileTreeContainer ?? null;
    this.state = { ...INITIAL_FILE_TREE_LIVE_STATE, entries: new Map() };
  }

  /**
   * Initialize the module: check feature gate, inject styles, set up listeners.
   */
  async init(): Promise<void> {
    if (!this.enabled) {
      this.enabled = await this.checkFeatureGate();
    }
    if (!this.enabled) return;

    if (!this.fileTreeContainer) {
      this.fileTreeContainer = document.getElementById('file-tree');
    }

    this.injectStyles();
    this.setupIPCListeners();
    this.active = true;
  }

  /**
   * Get the current state for external consumers / tests.
   */
  getState(): FileTreeLiveUpdatesState {
    const createdFiles = new Set<string>();
    const modifiedFiles = new Set<string>();
    for (const [path, entry] of this.state.entries) {
      if (entry.highlighted) createdFiles.add(path);
      if (entry.modified) modifiedFiles.add(path);
    }
    return {
      active: this.active,
      createdFiles,
      modifiedFiles,
      isCreationActive: this.state.activityInProgress,
    };
  }

  /**
   * Clean up all listeners and DOM modifications.
   */
  destroy(): void {
    if (this.fileChangeListener) {
      eapi().removeListener('agent:file-change', this.fileChangeListener);
      this.fileChangeListener = null;
    }
    if (this.taskCompleteListener) {
      eapi().removeListener('agent:task-complete', this.taskCompleteListener);
      this.taskCompleteListener = null;
    }
    if (this.highlightClearTimer) {
      clearTimeout(this.highlightClearTimer);
      this.highlightClearTimer = null;
    }
    if (this.styleElement && this.styleElement.parentNode) {
      this.styleElement.parentNode.removeChild(this.styleElement);
      this.styleElement = null;
    }
    this.clearAllIndicators();
    this.active = false;
  }

  // ─── Event Handling ─────────────────────────────────────────

  private setupIPCListeners(): void {
    this.fileChangeListener = (...args: unknown[]) => {
      const event = args[0] as FileChangeEvent | undefined;
      if (!event || !event.filePath || !event.type) return;
      this.dispatch({ type: 'file_change', payload: event });
    };

    this.taskCompleteListener = () => {
      this.dispatch({ type: 'activity_complete' });
    };

    eapi().on('agent:file-change', this.fileChangeListener);
    eapi().on('agent:task-complete', this.taskCompleteListener);
  }

  /**
   * Dispatch an event through the reducer and sync the DOM.
   */
  private dispatch(event: FileTreeLiveEvent): void {
    const prevState = this.state;
    this.state = fileTreeLiveReducer(prevState, event);
    this.syncDOM(prevState, this.state, event);
  }

  // ─── DOM Synchronization ────────────────────────────────────

  /**
   * Sync the DOM to reflect state changes after a reducer transition.
   */
  private syncDOM(
    prev: FileTreeLiveState,
    next: FileTreeLiveState,
    event: FileTreeLiveEvent,
  ): void {
    if (!this.fileTreeContainer) return;

    if (event.type === 'file_change') {
      const payload = event.payload;
      switch (payload.type) {
        case 'created':
          this.syncFileCreated(payload.filePath);
          this.resetHighlightClearTimer();
          break;
        case 'modified':
          this.syncFileModified(payload.filePath);
          break;
        case 'deleted':
          this.syncFileDeleted(payload.filePath);
          break;
      }
    } else if (event.type === 'activity_complete') {
      this.clearCreatedHighlights();
    } else if (event.type === 'reset') {
      this.clearAllIndicators();
    }
  }

  /**
   * Requirement 6.1: Update File_Tree to reflect new file within 1 second.
   * Requirement 6.3: Visually distinguish newly created files (highlight/badge).
   */
  private syncFileCreated(filePath: string): void {
    const existing = this.findFileEntry(filePath);
    if (existing) {
      existing.classList.add(CLASS_CREATED);
      existing.classList.remove(CLASS_MODIFIED);
      return;
    }
    this.addFileEntry(filePath);
  }

  /**
   * Requirement 6.4: Display modification indicator on modified files.
   */
  private syncFileModified(filePath: string): void {
    const entry = this.findFileEntry(filePath);
    if (entry) {
      entry.classList.add(CLASS_MODIFIED);
    }
  }

  /**
   * Requirement 6.2: Remove file entry from File_Tree within 1 second.
   */
  private syncFileDeleted(filePath: string): void {
    const entry = this.findFileEntry(filePath);
    if (entry) {
      const sibling = entry.nextElementSibling;
      if (sibling && sibling.classList.contains('file-tree-children')) {
        sibling.remove();
      }
      entry.remove();
    }
  }

  // ─── DOM Manipulation ───────────────────────────────────────

  private findFileEntry(filePath: string): HTMLElement | null {
    if (!this.fileTreeContainer) return null;
    return this.fileTreeContainer.querySelector(
      `[data-path="${CSS.escape(filePath)}"]`
    ) as HTMLElement | null;
  }

  private addFileEntry(filePath: string): void {
    if (!this.fileTreeContainer) return;

    const fileName = this.getFileName(filePath);
    const dirPath = this.getDirPath(filePath);

    const parentContainer = this.findParentContainer(dirPath);
    if (!parentContainer) return;

    const entry = document.createElement('div');
    entry.className = 'file-tree-entry file-tree-file ' + this.getFileIconClass(fileName);
    entry.setAttribute('data-path', filePath);

    const depth = this.calculateDepth(filePath);
    entry.style.paddingLeft = `calc(${depth} * 16px)`;

    const fileIcon = document.createElement('span');
    fileIcon.className = 'file-tree-icon';

    const fileLabel = document.createElement('span');
    fileLabel.className = 'file-tree-label';
    fileLabel.textContent = fileName;

    entry.appendChild(fileIcon);
    entry.appendChild(fileLabel);
    entry.classList.add(CLASS_CREATED);

    this.insertSorted(parentContainer, entry, fileName);

    entry.addEventListener('click', () => {
      const prev = document.querySelectorAll('.file-tree-active');
      for (let p = 0; p < prev.length; p++) {
        prev[p].classList.remove('file-tree-active');
      }
      entry.classList.add('file-tree-active');
    });
  }

  private findParentContainer(dirPath: string): HTMLElement | null {
    if (!this.fileTreeContainer) return null;

    if (!dirPath || dirPath === '/' || dirPath === '.') {
      return this.fileTreeContainer;
    }

    const dirEntry = this.fileTreeContainer.querySelector(
      `.file-tree-dir[data-path="${CSS.escape(dirPath)}"]`
    ) as HTMLElement | null;

    if (!dirEntry) {
      return this.fileTreeContainer;
    }

    const childContainer = dirEntry.nextElementSibling;
    if (childContainer && childContainer.classList.contains('file-tree-children')) {
      return childContainer as HTMLElement;
    }

    return this.fileTreeContainer;
  }

  private insertSorted(container: HTMLElement, entry: HTMLElement, fileName: string): void {
    const fileEntries = container.querySelectorAll(':scope > .file-tree-file');
    let insertBefore: Element | null = null;

    for (let i = 0; i < fileEntries.length; i++) {
      const label = fileEntries[i].querySelector('.file-tree-label');
      if (label && label.textContent && label.textContent.localeCompare(fileName) > 0) {
        insertBefore = fileEntries[i];
        break;
      }
    }

    if (insertBefore) {
      container.insertBefore(entry, insertBefore);
    } else {
      container.appendChild(entry);
    }
  }

  // ─── Highlight Management ───────────────────────────────────

  private clearCreatedHighlights(): void {
    if (!this.fileTreeContainer) return;
    const highlighted = this.fileTreeContainer.querySelectorAll('.' + CLASS_CREATED);
    for (let i = 0; i < highlighted.length; i++) {
      highlighted[i].classList.remove(CLASS_CREATED);
    }
  }

  private clearAllIndicators(): void {
    if (!this.fileTreeContainer) return;

    const created = this.fileTreeContainer.querySelectorAll('.' + CLASS_CREATED);
    for (let i = 0; i < created.length; i++) {
      created[i].classList.remove(CLASS_CREATED);
    }

    const modified = this.fileTreeContainer.querySelectorAll('.' + CLASS_MODIFIED);
    for (let i = 0; i < modified.length; i++) {
      modified[i].classList.remove(CLASS_MODIFIED);
    }
  }

  private resetHighlightClearTimer(): void {
    if (this.highlightClearTimer) {
      clearTimeout(this.highlightClearTimer);
    }
    this.highlightClearTimer = setTimeout(() => {
      this.dispatch({ type: 'activity_complete' });
      this.highlightClearTimer = null;
    }, HIGHLIGHT_CLEAR_DELAY_MS);
  }

  // ─── Utility Methods ────────────────────────────────────────

  private getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  private getDirPath(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash <= 0) return '';
    return filePath.substring(0, lastSlash);
  }

  private calculateDepth(filePath: string): number {
    const parts = filePath.split('/').filter(p => p.length > 0);
    return Math.max(0, parts.length - 1);
  }

  private getFileIconClass(fileName: string): string {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const iconMap: Record<string, string> = {
      ts: 'icon-ts', tsx: 'icon-tsx', js: 'icon-js', jsx: 'icon-jsx',
      py: 'icon-py', html: 'icon-html', css: 'icon-css',
      json: 'icon-json', md: 'icon-md', yml: 'icon-yml', yaml: 'icon-yml',
      sql: 'icon-sql', sh: 'icon-sh', bash: 'icon-sh',
      rs: 'icon-rs', go: 'icon-go', java: 'icon-java',
    };
    return iconMap[ext] || 'icon-file';
  }

  private async checkFeatureGate(): Promise<boolean> {
    try {
      const config = await eapi().invoke('get-config') as Record<string, unknown>;
      if (config && typeof config === 'object') {
        return (config as any).production_ux_file_tree_updates === true;
      }
    } catch {
      // Feature not available — disabled
    }
    return false;
  }

  // ─── Style Injection ────────────────────────────────────────

  private injectStyles(): void {
    if (this.styleElement) return;

    this.styleElement = document.createElement('style');
    this.styleElement.setAttribute('data-module', 'file-tree-live-updates');
    this.styleElement.textContent = `
      /* Newly created file highlight — green glow with badge */
      .file-tree-entry.${CLASS_CREATED} {
        background: rgba(166, 227, 161, 0.1);
        border-left: 2px solid #a6e3a1;
        position: relative;
        animation: ftree-created-pulse 1.5s ease-in-out 2;
      }
      .file-tree-entry.${CLASS_CREATED}::after {
        content: 'NEW';
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 9px;
        font-weight: 700;
        color: #a6e3a1;
        background: rgba(166, 227, 161, 0.15);
        padding: 1px 5px;
        border-radius: 3px;
        letter-spacing: 0.5px;
      }

      /* Modified file indicator — orange dot */
      .file-tree-entry.${CLASS_MODIFIED} {
        position: relative;
      }
      .file-tree-entry.${CLASS_MODIFIED}::before {
        content: '';
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #fab387;
      }
      /* When both created and modified, created takes priority */
      .file-tree-entry.${CLASS_CREATED}.${CLASS_MODIFIED}::before {
        display: none;
      }

      @keyframes ftree-created-pulse {
        0%, 100% { background: rgba(166, 227, 161, 0.1); }
        50% { background: rgba(166, 227, 161, 0.2); }
      }
    `;
    document.head.appendChild(this.styleElement);
  }
}

// ─── Factory / Convenience Export ───────────────────────────────

/**
 * Create and initialize a FileTreeLiveUpdates instance.
 * Feature-gated: will check `production_ux_file_tree_updates` before activating.
 */
export async function createFileTreeLiveUpdates(
  options: FileTreeLiveUpdatesOptions = {}
): Promise<FileTreeLiveUpdates> {
  const instance = new FileTreeLiveUpdates(options);
  await instance.init();
  return instance;
}
