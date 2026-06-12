/**
 * Editor panel module — implements PanelModule.
 * Orchestrates the Monaco editor core, tab bar, and file service
 * to provide a complete multi-tab file editing experience.
 */

import type { PanelModule } from '../../types';
import type { EditorCoreEvent } from './types';
import type { FileState, TabId } from './types';
import { EditorCore } from './editor-core';
import { EditorService, detectLanguage } from './editor-service';
import { EditorTabBar } from './editor-tabs';

/** State of all open files managed by the editor panel. */
const fileStates: Map<TabId, FileState> = new Map();

/** Shared editor service instance for IPC file operations. */
const editorService = new EditorService();

/** The editor core instance managing Monaco. */
let editorCore: EditorCore | null = null;

/** The tab bar instance. */
let tabBar: EditorTabBar | null = null;

/** Root container element. */
let rootContainer: HTMLElement | null = null;

/** Cleanup functions for event subscriptions. */
const cleanups: (() => void)[] = [];

/**
 * Creates the initial file state for a newly opened file.
 */
function createFileState(filePath: string, content: string): FileState {
  return {
    filePath,
    content,
    savedContent: content,
    language: detectLanguage(filePath),
    isDirty: false,
    cursorLine: 1,
    cursorColumn: 1,
    scrollTop: 0,
  };
}

/**
 * Opens a file in the editor panel.
 * If the file is already open, switches to its tab.
 */
async function openFile(filePath: string): Promise<void> {
  // If already open, just switch to it
  if (fileStates.has(filePath)) {
    tabBar?.setActiveTab(filePath);
    editorCore?.switchToModel(filePath);
    return;
  }

  // Request file content from main process
  const response = await editorService.openFile({ filePath });
  if (!response.success || response.content === undefined) {
    return;
  }

  // Create file state
  const state = createFileState(filePath, response.content);
  fileStates.set(filePath, state);

  // Open in tab bar and editor
  tabBar?.openTab(state);
  editorCore?.openFile(state);
}

/**
 * Saves the currently active file.
 */
async function saveActiveFile(): Promise<void> {
  const activeId = tabBar?.getActiveTabId();
  if (!activeId) return;

  const state = fileStates.get(activeId);
  if (!state || !state.isDirty) return;

  const content = editorCore?.getFileContent(activeId) ?? state.content;

  const response = await editorService.saveFile({
    filePath: activeId,
    content,
  });

  if (response.success) {
    state.savedContent = content;
    state.content = content;
    state.isDirty = false;
    tabBar?.setDirty(activeId, false);
  }
}

/**
 * Handles tab selection — switches editor model.
 */
function handleTabSelect(tabId: TabId): void {
  // Save cursor position of previous file
  const prevId = tabBar?.getActiveTabId();
  if (prevId && prevId !== tabId) {
    const prevState = fileStates.get(prevId);
    if (prevState && editorCore) {
      const pos = editorCore.getCursorPosition();
      if (pos) {
        prevState.cursorLine = pos.line;
        prevState.cursorColumn = pos.column;
      }
      prevState.scrollTop = editorCore.getScrollTop();
    }
  }

  tabBar?.setActiveTab(tabId);

  const state = fileStates.get(tabId);
  if (state) {
    editorCore?.openFile(state);
  }
}

/**
 * Handles tab close — disposes model and updates state.
 */
function handleTabClose(tabId: TabId): void {
  // Close in tab bar and get next active
  const nextActive = tabBar?.closeTab(tabId) ?? null;

  // Close in editor core
  editorCore?.closeFile(tabId);

  // Clean up state
  fileStates.delete(tabId);
  editorService.unwatchFile(tabId);

  // Switch to next active if available
  if (nextActive) {
    const state = fileStates.get(nextActive);
    if (state) {
      editorCore?.openFile(state);
    }
  }
}

/**
 * Handles editor core events (content changes, cursor moves).
 */
function handleEditorEvent(event: EditorCoreEvent): void {
  switch (event.type) {
    case 'content-changed': {
      const state = fileStates.get(event.filePath);
      if (state) {
        state.content = event.content;
        const isDirty = state.content !== state.savedContent;
        if (state.isDirty !== isDirty) {
          state.isDirty = isDirty;
          tabBar?.setDirty(event.filePath, isDirty);
        }
      }
      break;
    }
    case 'cursor-changed': {
      const activeId = tabBar?.getActiveTabId();
      if (activeId) {
        const state = fileStates.get(activeId);
        if (state) {
          state.cursorLine = event.position.line;
          state.cursorColumn = event.position.column;
        }
      }
      break;
    }
  }
}

/**
 * Sets up keyboard shortcuts for the editor panel.
 */
function setupKeyboardShortcuts(): void {
  const handler = (e: KeyboardEvent): void => {
    const isMod = e.metaKey || e.ctrlKey;

    // Ctrl/Cmd + S — Save
    if (isMod && e.key === 's') {
      e.preventDefault();
      saveActiveFile();
    }

    // Ctrl/Cmd + W — Close tab
    if (isMod && e.key === 'w') {
      e.preventDefault();
      const activeId = tabBar?.getActiveTabId();
      if (activeId) handleTabClose(activeId);
    }
  };

  document.addEventListener('keydown', handler);
  cleanups.push(() => document.removeEventListener('keydown', handler));
}

/**
 * The editor panel module implementing PanelModule.
 */
export const editorPanel: PanelModule = {
  mount(container: HTMLElement): void {
    rootContainer = container;

    // Set up container layout
    Object.assign(container.style, {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
    });

    // Create tab bar container
    const tabBarContainer = document.createElement('div');
    tabBarContainer.className = 'editor-panel__tabs';
    container.appendChild(tabBarContainer);

    // Create editor content container
    const editorContainer = document.createElement('div');
    editorContainer.className = 'editor-panel__content';
    Object.assign(editorContainer.style, {
      flex: '1',
      position: 'relative',
      overflow: 'hidden',
    });
    container.appendChild(editorContainer);

    // Initialize tab bar
    tabBar = new EditorTabBar({
      onSelect: handleTabSelect,
      onClose: handleTabClose,
    });
    tabBar.mount(tabBarContainer);

    // Initialize editor core
    editorCore = new EditorCore();
    editorCore.mount(editorContainer);

    // Subscribe to editor events
    const editorCleanup = editorCore.on(handleEditorEvent);
    cleanups.push(editorCleanup);

    // Subscribe to service events (external file changes)
    const serviceCleanup = editorService.on((event) => {
      if (event.type === 'file-changed-externally') {
        // Could reload file content here
      } else if (event.type === 'file-deleted-externally') {
        // Could close the tab or mark as deleted
      }
    });
    cleanups.push(serviceCleanup);

    // Setup keyboard shortcuts
    setupKeyboardShortcuts();
  },

  unmount(): void {
    // Run all cleanup functions
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.length = 0;

    // Dispose components
    editorCore?.dispose();
    editorCore = null;

    tabBar?.unmount();
    tabBar = null;

    editorService.dispose();
    fileStates.clear();

    // Clear container
    if (rootContainer) {
      rootContainer.innerHTML = '';
    }
    rootContainer = null;
  },

  onFocus(): void {
    editorCore?.focus();
    editorCore?.layout();
  },

  onBlur(): void {
    // Persist cursor positions for all open files
    const activeId = tabBar?.getActiveTabId();
    if (activeId && editorCore) {
      const state = fileStates.get(activeId);
      if (state) {
        const pos = editorCore.getCursorPosition();
        if (pos) {
          state.cursorLine = pos.line;
          state.cursorColumn = pos.column;
        }
        state.scrollTop = editorCore.getScrollTop();
      }
    }
  },
};

// Re-export for external use
export { openFile, saveActiveFile };
export type { FileState, EditorTab, EditorConfig } from './types';
