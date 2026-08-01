/**
 * File Tree Panel — Main panel component for the workspace file/folder hierarchy.
 * Registers with the panel registry, renders the toolbar (filter input, collapse-all,
 * expand-all, show/hide dotfiles buttons), and manages tree state.
 *
 * Uses IPC channels `filetree:get-tree` and `filetree:get-modified-files` to fetch data.
 * Integrates with the panel-registry system as a sidebar panel.
 *
 * Requirements: 23.6, 23.7, 23.8, 23.14
 */

import type { PanelModule } from '../../types';
import { TreeNode, type FileNode, type FileModification } from './tree-node';

/** CSS class names for the file tree panel. */
const CSS = {
  panel: 'nn-file-tree-panel',
  toolbar: 'nn-file-tree-panel__toolbar',
  filterInput: 'nn-file-tree-panel__filter-input',
  toolbarBtn: 'nn-file-tree-panel__toolbar-btn',
  toolbarBtnActive: 'nn-file-tree-panel__toolbar-btn--active',
  treeContainer: 'nn-file-tree-panel__tree',
  emptyState: 'nn-file-tree-panel__empty',
  resizeHandle: 'nn-file-tree-panel__resize-handle',
} as const;

/**
 * Typed wrapper for accessing the preload-exposed IPC bridge.
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    removeListener?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
    on: bridge?.on ?? (() => {}),
    removeListener: bridge?.removeListener ?? (() => {}),
  };
}

/** Inject panel-level CSS styles. */
function injectPanelStyles(): void {
  if (document.getElementById('nn-file-tree-panel-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-file-tree-panel-styles';
  style.textContent = `
    .${CSS.panel} {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--panel-bg, #1e1e1e);
      color: var(--panel-text, #cccccc);
      font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      overflow: hidden;
      position: relative;
    }
    .${CSS.toolbar} {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--panel-border, #333333);
      flex-shrink: 0;
    }
    .${CSS.filterInput} {
      flex: 1;
      min-width: 0;
      padding: 4px 8px;
      border: 1px solid var(--input-border, #3c3c3c);
      border-radius: 4px;
      background: var(--input-bg, #252526);
      color: var(--input-text, #cccccc);
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .${CSS.filterInput}:focus {
      border-color: var(--focus-ring, #007acc);
    }
    .${CSS.filterInput}::placeholder {
      color: var(--input-placeholder, #666666);
    }
    .${CSS.toolbarBtn} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--toolbar-btn-text, #888888);
      cursor: pointer;
      font-size: 14px;
      flex-shrink: 0;
      transition: background 0.1s ease, color 0.1s ease;
    }
    .${CSS.toolbarBtn}:hover {
      background: var(--toolbar-btn-hover-bg, rgba(255, 255, 255, 0.08));
      color: var(--toolbar-btn-hover-text, #cccccc);
    }
    .${CSS.toolbarBtn}:focus-visible {
      outline: 2px solid var(--focus-ring, #007acc);
      outline-offset: 1px;
    }
    .${CSS.toolbarBtnActive} {
      background: var(--toolbar-btn-active-bg, rgba(55, 148, 255, 0.15));
      color: var(--toolbar-btn-active-text, #3794ff);
    }
    .${CSS.treeContainer} {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 0;
    }
    .${CSS.treeContainer}::-webkit-scrollbar {
      width: 8px;
    }
    .${CSS.treeContainer}::-webkit-scrollbar-track {
      background: transparent;
    }
    .${CSS.treeContainer}::-webkit-scrollbar-thumb {
      background: var(--scrollbar-thumb, rgba(255, 255, 255, 0.15));
      border-radius: 4px;
    }
    .${CSS.emptyState} {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-size: 12px;
      color: var(--empty-state-text, #666666);
      text-align: center;
      padding: 16px;
    }
    .${CSS.resizeHandle} {
      position: absolute;
      top: 0;
      right: 0;
      width: 4px;
      height: 100%;
      cursor: col-resize;
      background: transparent;
      transition: background 0.15s ease;
    }
    .${CSS.resizeHandle}:hover {
      background: var(--resize-handle-hover, rgba(55, 148, 255, 0.5));
    }
  `;
  document.head.appendChild(style);
}

/**
 * FileTreePanel — Implements the PanelModule lifecycle.
 * Displays workspace file hierarchy with filtering, dotfile toggle, and modification badges.
 */
export class FileTreePanel implements PanelModule {
  private container: HTMLElement | null = null;
  private treeContainer: HTMLElement | null = null;
  private filterInput: HTMLInputElement | null = null;
  private dotfilesBtn: HTMLButtonElement | null = null;

  private treeData: FileNode[] = [];
  private modifications: Map<string, FileModification> = new Map();
  private rootNodes: TreeNode[] = [];
  private filterPattern = '';
  private showDotfiles = false;
  private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fileChangeHandler: ((...args: unknown[]) => void) | null = null;

  /** Mount the file tree panel into the given container. */
  mount(container: HTMLElement): void {
    injectPanelStyles();

    this.container = container;
    container.innerHTML = '';

    // Panel wrapper
    const panel = document.createElement('div');
    panel.className = CSS.panel;
    panel.setAttribute('role', 'tree');
    panel.setAttribute('aria-label', 'File Explorer');

    // Toolbar
    const toolbar = this.createToolbar();
    panel.appendChild(toolbar);

    // Tree container
    const treeContainer = document.createElement('div');
    treeContainer.className = CSS.treeContainer;
    treeContainer.setAttribute('role', 'group');
    this.treeContainer = treeContainer;
    panel.appendChild(treeContainer);

    // Resize handle for split-pane layout
    const resizeHandle = document.createElement('div');
    resizeHandle.className = CSS.resizeHandle;
    resizeHandle.setAttribute('aria-hidden', 'true');
    this.setupResizeHandle(resizeHandle, container);
    panel.appendChild(resizeHandle);

    container.appendChild(panel);

    // Fetch tree data and modifications
    this.fetchTreeData();
    this.fetchModifications();

    // Subscribe to file change updates
    const bridge = getIpcBridge();
    this.fileChangeHandler = () => {
      this.fetchModifications();
    };
    bridge.on('filetree:files-changed', this.fileChangeHandler);
  }

  /** Unmount the panel and clean up resources. */
  unmount(): void {
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
    }

    // Remove IPC listener
    if (this.fileChangeHandler) {
      const bridge = getIpcBridge();
      bridge.removeListener('filetree:files-changed', this.fileChangeHandler);
      this.fileChangeHandler = null;
    }

    // Destroy tree nodes
    for (const node of this.rootNodes) {
      node.destroy();
    }
    this.rootNodes = [];

    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
    this.treeContainer = null;
    this.filterInput = null;
    this.dotfilesBtn = null;
  }

  /** Optional focus handler. */
  onFocus(): void {
    if (this.filterInput) {
      this.filterInput.focus();
    }
  }

  /** Collapse all tree nodes. */
  collapseAll(): void {
    for (const node of this.rootNodes) {
      node.collapseAll();
    }
  }

  /** Expand all tree nodes. */
  expandAll(): void {
    for (const node of this.rootNodes) {
      node.expandAll();
    }
  }

  /** Update the filter pattern and re-render the tree. */
  setFilter(pattern: string): void {
    this.filterPattern = pattern.toLowerCase();
    this.renderTree();
  }

  /** Toggle dotfile visibility. */
  toggleDotfiles(): void {
    this.showDotfiles = !this.showDotfiles;
    if (this.dotfilesBtn) {
      if (this.showDotfiles) {
        this.dotfilesBtn.classList.add(CSS.toolbarBtnActive);
        this.dotfilesBtn.setAttribute('aria-pressed', 'true');
        this.dotfilesBtn.setAttribute('title', 'Hide dotfiles');
      } else {
        this.dotfilesBtn.classList.remove(CSS.toolbarBtnActive);
        this.dotfilesBtn.setAttribute('aria-pressed', 'false');
        this.dotfilesBtn.setAttribute('title', 'Show dotfiles');
      }
    }
    this.renderTree();
  }

  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = CSS.toolbar;

    // Filter input
    const filterInput = document.createElement('input');
    filterInput.className = CSS.filterInput;
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter files...';
    filterInput.setAttribute('aria-label', 'Filter files by name');
    filterInput.addEventListener('input', () => {
      if (this.filterDebounceTimer) {
        clearTimeout(this.filterDebounceTimer);
      }
      this.filterDebounceTimer = setTimeout(() => {
        this.setFilter(filterInput.value);
      }, 200);
    });
    this.filterInput = filterInput;
    toolbar.appendChild(filterInput);

    // Show/hide dotfiles button
    const dotfilesBtn = document.createElement('button');
    dotfilesBtn.className = CSS.toolbarBtn;
    dotfilesBtn.textContent = '.';
    dotfilesBtn.style.fontWeight = '700';
    dotfilesBtn.setAttribute('aria-label', 'Toggle dotfiles visibility');
    dotfilesBtn.setAttribute('aria-pressed', 'false');
    dotfilesBtn.setAttribute('title', 'Show dotfiles');
    dotfilesBtn.addEventListener('click', () => this.toggleDotfiles());
    this.dotfilesBtn = dotfilesBtn;
    toolbar.appendChild(dotfilesBtn);

    // Collapse all button
    const collapseBtn = document.createElement('button');
    collapseBtn.className = CSS.toolbarBtn;
    collapseBtn.textContent = '\u2796'; // ➖
    collapseBtn.setAttribute('aria-label', 'Collapse all folders');
    collapseBtn.setAttribute('title', 'Collapse all');
    collapseBtn.addEventListener('click', () => this.collapseAll());
    toolbar.appendChild(collapseBtn);

    // Expand all button
    const expandBtn = document.createElement('button');
    expandBtn.className = CSS.toolbarBtn;
    expandBtn.textContent = '\u2795'; // ➕
    expandBtn.setAttribute('aria-label', 'Expand all folders');
    expandBtn.setAttribute('title', 'Expand all');
    expandBtn.addEventListener('click', () => this.expandAll());
    toolbar.appendChild(expandBtn);

    return toolbar;
  }

  private async fetchTreeData(): Promise<void> {
    try {
      const bridge = getIpcBridge();
      const result = await bridge.invoke('filetree:get-tree') as FileNode[] | undefined;
      if (result && Array.isArray(result)) {
        this.treeData = result;
        this.renderTree();
      }
    } catch {
      this.showEmpty('Unable to load file tree');
    }
  }

  private async fetchModifications(): Promise<void> {
    try {
      const bridge = getIpcBridge();
      const result = await bridge.invoke('filetree:get-modified-files') as
        Array<{ path: string; changeCount: number }> | undefined;
      if (result && Array.isArray(result)) {
        this.modifications.clear();
        for (const mod of result) {
          this.modifications.set(mod.path, mod);
        }
        // Re-render to update badges
        this.renderTree();
      }
    } catch {
      // Non-critical — modifications badge won't show
    }
  }

  private renderTree(): void {
    if (!this.treeContainer) return;

    // Destroy existing nodes
    for (const node of this.rootNodes) {
      node.destroy();
    }
    this.rootNodes = [];
    this.treeContainer.innerHTML = '';

    if (this.treeData.length === 0) {
      this.showEmpty('No files in workspace');
      return;
    }

    // Create filter function
    const filterFn = this.createFilterFunction();

    // Sort: directories first, then alphabetical
    const sorted = [...this.treeData].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    let hasVisible = false;

    for (const fileNode of sorted) {
      if (!filterFn(fileNode)) continue;
      hasVisible = true;

      const treeNode = new TreeNode({
        node: fileNode,
        depth: 0,
        modifications: this.modifications,
        defaultExpanded: this.filterPattern.length > 0, // Auto-expand when filtering
        onPreview: (path) => this.handlePreview(path),
        onOpen: (path) => this.handleOpen(path),
        filter: filterFn,
      });

      this.rootNodes.push(treeNode);
      this.treeContainer.appendChild(treeNode.getElement());
    }

    if (!hasVisible) {
      this.showEmpty(this.filterPattern ? 'No matching files' : 'No files in workspace');
    }
  }

  private createFilterFunction(): (node: FileNode) => boolean {
    return (node: FileNode): boolean => {
      // Filter dotfiles
      if (!this.showDotfiles && node.name.startsWith('.')) {
        return false;
      }

      // Apply filename pattern filter
      if (this.filterPattern) {
        if (node.isDirectory) {
          // Show directory if any child matches
          return this.directoryHasMatch(node);
        }
        return node.name.toLowerCase().includes(this.filterPattern);
      }

      return true;
    };
  }

  private directoryHasMatch(dir: FileNode): boolean {
    if (!dir.children) return false;
    for (const child of dir.children) {
      if (!this.showDotfiles && child.name.startsWith('.')) continue;
      if (child.isDirectory) {
        if (this.directoryHasMatch(child)) return true;
      } else {
        if (child.name.toLowerCase().includes(this.filterPattern)) return true;
      }
    }
    return false;
  }

  private showEmpty(message: string): void {
    if (!this.treeContainer) return;
    const empty = document.createElement('div');
    empty.className = CSS.emptyState;
    empty.textContent = message;
    this.treeContainer.appendChild(empty);
  }

  private handlePreview(path: string): void {
    const bridge = getIpcBridge();
    bridge.invoke('filetree:open-file', { path, preview: true });
  }

  private handleOpen(path: string): void {
    const bridge = getIpcBridge();
    bridge.invoke('filetree:open-file', { path, preview: false });
  }

  private setupResizeHandle(handle: HTMLElement, container: HTMLElement): void {
    let startX = 0;
    let startWidth = 0;
    let isResizing = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      const newWidth = Math.max(150, Math.min(600, startWidth + delta));
      container.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      isResizing = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      isResizing = true;
      startX = e.clientX;
      startWidth = container.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

/** Create and export the file tree panel module. */
export function createFileTreePanel(): PanelModule {
  return new FileTreePanel();
}

/** Default export: a ready-to-use file tree panel instance. */
export const fileTreePanel: PanelModule = createFileTreePanel();
