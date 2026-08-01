/**
 * Tree Node Component — Renders individual file/folder nodes in the file tree panel.
 * Handles expand/collapse, single-click preview, double-click open, and
 * modification badges for agent-changed files.
 *
 * Requirements: 23.6, 23.7
 */

import { getFileIcon, getFolderIcon } from './file-icons';

/** Represents a node in the file tree (file or directory). */
export interface FileNode {
  /** File or folder name (not full path) */
  name: string;
  /** Full path relative to workspace root */
  path: string;
  /** Whether this node is a directory */
  isDirectory: boolean;
  /** Child nodes (only for directories) */
  children?: FileNode[];
}

/** Modification info for a file changed by agent operations. */
export interface FileModification {
  /** File path relative to workspace root */
  path: string;
  /** Number of changes (additions + deletions) */
  changeCount: number;
}

/** CSS class names for tree node elements. */
const CSS = {
  node: 'nn-tree-node',
  nodeRow: 'nn-tree-node__row',
  nodeRowActive: 'nn-tree-node__row--active',
  nodeRowHover: 'nn-tree-node__row--hover',
  chevron: 'nn-tree-node__chevron',
  chevronExpanded: 'nn-tree-node__chevron--expanded',
  chevronHidden: 'nn-tree-node__chevron--hidden',
  icon: 'nn-tree-node__icon',
  label: 'nn-tree-node__label',
  badge: 'nn-tree-node__badge',
  children: 'nn-tree-node__children',
  childrenHidden: 'nn-tree-node__children--hidden',
} as const;

/**
 * Typed wrapper for accessing the preload-exposed IPC bridge.
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
  };
}

/** Inject tree node CSS styles if not already present. */
function injectTreeNodeStyles(): void {
  if (document.getElementById('nn-tree-node-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-tree-node-styles';
  style.textContent = `
    .${CSS.node} {
      user-select: none;
    }
    .${CSS.nodeRow} {
      display: flex;
      align-items: center;
      padding: 2px 4px 2px 0;
      cursor: pointer;
      border-radius: 4px;
      min-height: 24px;
      transition: background 0.1s ease;
    }
    .${CSS.nodeRow}:hover {
      background: var(--tree-node-hover-bg, rgba(255, 255, 255, 0.05));
    }
    .${CSS.nodeRowActive} {
      background: var(--tree-node-active-bg, rgba(55, 148, 255, 0.15)) !important;
    }
    .${CSS.chevron} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      font-size: 10px;
      color: var(--tree-node-chevron-color, #888);
      transition: transform 0.15s ease;
    }
    .${CSS.chevronExpanded} {
      transform: rotate(90deg);
    }
    .${CSS.chevronHidden} {
      visibility: hidden;
    }
    .${CSS.icon} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      font-size: 14px;
      margin-right: 4px;
    }
    .${CSS.label} {
      flex: 1;
      font-size: 13px;
      line-height: 1.4;
      color: var(--tree-node-text-color, #cccccc);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${CSS.badge} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      margin-left: 6px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
      background: var(--tree-node-badge-bg, rgba(55, 148, 255, 0.3));
      color: var(--tree-node-badge-text, #3794ff);
      flex-shrink: 0;
    }
    .${CSS.children} {
      padding-left: 12px;
    }
    .${CSS.childrenHidden} {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

/** Options for creating a tree node. */
export interface TreeNodeOptions {
  /** The file node data to render */
  node: FileNode;
  /** Depth level for indentation */
  depth: number;
  /** Map of file paths to modification info */
  modifications: Map<string, FileModification>;
  /** Whether the node starts expanded (directories only) */
  defaultExpanded?: boolean;
  /** Callback when a file is selected (single-click preview) */
  onPreview?: (path: string) => void;
  /** Callback when a file is opened (double-click) */
  onOpen?: (path: string) => void;
  /** Filter function: returns true if node should be visible */
  filter?: (node: FileNode) => boolean;
}

/**
 * TreeNode class — renders a single file/folder entry in the tree.
 * Directories are collapsible, files support single-click preview and double-click open.
 */
export class TreeNode {
  private element: HTMLElement;
  private childContainer: HTMLElement | null = null;
  private expanded: boolean;
  private options: TreeNodeOptions;
  private childNodes: TreeNode[] = [];
  private clickTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TreeNodeOptions) {
    this.options = options;
    this.expanded = options.defaultExpanded ?? false;
    this.element = this.render();
  }

  /** Get the root DOM element for this tree node. */
  getElement(): HTMLElement {
    return this.element;
  }

  /** Update the expanded state of this node. */
  setExpanded(expanded: boolean): void {
    if (!this.options.node.isDirectory) return;
    this.expanded = expanded;
    this.updateExpandedState();
  }

  /** Check if this node is currently expanded. */
  isExpanded(): boolean {
    return this.expanded;
  }

  /** Collapse this node and all descendant nodes. */
  collapseAll(): void {
    if (this.options.node.isDirectory) {
      this.expanded = false;
      this.updateExpandedState();
      for (const child of this.childNodes) {
        child.collapseAll();
      }
    }
  }

  /** Expand this node and all descendant nodes. */
  expandAll(): void {
    if (this.options.node.isDirectory) {
      this.expanded = true;
      this.updateExpandedState();
      for (const child of this.childNodes) {
        child.expandAll();
      }
    }
  }

  /** Destroy the node and remove from DOM. */
  destroy(): void {
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
    }
    for (const child of this.childNodes) {
      child.destroy();
    }
    this.childNodes = [];
    this.element.remove();
  }

  private render(): HTMLElement {
    injectTreeNodeStyles();

    const { node, depth, modifications } = this.options;
    const container = document.createElement('div');
    container.className = CSS.node;
    container.setAttribute('data-path', node.path);
    container.setAttribute('data-type', node.isDirectory ? 'directory' : 'file');

    // Row element (clickable line)
    const row = document.createElement('div');
    row.className = CSS.nodeRow;
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    row.setAttribute('role', node.isDirectory ? 'treeitem' : 'treeitem');
    row.setAttribute('aria-expanded', node.isDirectory ? String(this.expanded) : '');
    row.setAttribute('aria-label', node.name);
    row.setAttribute('tabindex', '0');

    // Chevron (expand/collapse indicator)
    const chevron = document.createElement('span');
    chevron.className = node.isDirectory
      ? `${CSS.chevron}${this.expanded ? ` ${CSS.chevronExpanded}` : ''}`
      : `${CSS.chevron} ${CSS.chevronHidden}`;
    chevron.textContent = '\u25B6'; // ▶
    chevron.setAttribute('aria-hidden', 'true');
    row.appendChild(chevron);

    // File/folder icon
    const icon = document.createElement('span');
    icon.className = CSS.icon;
    icon.setAttribute('aria-hidden', 'true');
    if (node.isDirectory) {
      icon.textContent = getFolderIcon(this.expanded);
    } else {
      icon.textContent = getFileIcon(node.name);
    }
    row.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = CSS.label;
    label.textContent = node.name;
    row.appendChild(label);

    // Modification badge
    const mod = modifications.get(node.path);
    if (mod && mod.changeCount > 0) {
      const badge = document.createElement('span');
      badge.className = CSS.badge;
      badge.textContent = String(mod.changeCount);
      badge.setAttribute('aria-label', `${mod.changeCount} changes`);
      badge.setAttribute('title', `${mod.changeCount} change${mod.changeCount === 1 ? '' : 's'}`);
      row.appendChild(badge);
    }

    // Event handlers
    if (node.isDirectory) {
      row.addEventListener('click', () => this.toggleExpand());
      row.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggleExpand();
        }
        if (e.key === 'ArrowRight' && !this.expanded) {
          e.preventDefault();
          this.setExpanded(true);
        }
        if (e.key === 'ArrowLeft' && this.expanded) {
          e.preventDefault();
          this.setExpanded(false);
        }
      });
    } else {
      // Single-click = preview, double-click = open
      row.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        if (this.clickTimeout) {
          // Double click detected — cancel preview, open instead
          clearTimeout(this.clickTimeout);
          this.clickTimeout = null;
          this.handleOpen();
        } else {
          // Start single-click timer
          this.clickTimeout = setTimeout(() => {
            this.clickTimeout = null;
            this.handlePreview();
          }, 250);
        }
      });
      row.addEventListener('dblclick', (e: MouseEvent) => {
        e.stopPropagation();
        // Already handled via click timeout logic above
      });
      row.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleOpen();
        }
        if (e.key === ' ') {
          e.preventDefault();
          this.handlePreview();
        }
      });
    }

    container.appendChild(row);

    // Children container (directories only)
    if (node.isDirectory && node.children) {
      const childContainer = document.createElement('div');
      childContainer.className = `${CSS.children}${!this.expanded ? ` ${CSS.childrenHidden}` : ''}`;
      childContainer.setAttribute('role', 'group');

      this.renderChildren(childContainer, node.children);
      this.childContainer = childContainer;
      container.appendChild(childContainer);
    }

    return container;
  }

  private renderChildren(container: HTMLElement, children: FileNode[]): void {
    // Sort: directories first, then alphabetical
    const sorted = [...children].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const child of sorted) {
      // Apply filter if provided
      if (this.options.filter && !this.options.filter(child)) {
        continue;
      }

      const childNode = new TreeNode({
        node: child,
        depth: this.options.depth + 1,
        modifications: this.options.modifications,
        defaultExpanded: false,
        onPreview: this.options.onPreview,
        onOpen: this.options.onOpen,
        filter: this.options.filter,
      });
      this.childNodes.push(childNode);
      container.appendChild(childNode.getElement());
    }
  }

  private toggleExpand(): void {
    this.expanded = !this.expanded;
    this.updateExpandedState();
  }

  private updateExpandedState(): void {
    const row = this.element.querySelector(`.${CSS.nodeRow}`) as HTMLElement | null;
    if (row) {
      row.setAttribute('aria-expanded', String(this.expanded));
    }

    // Update chevron
    const chevron = this.element.querySelector(`.${CSS.chevron}`) as HTMLElement | null;
    if (chevron) {
      if (this.expanded) {
        chevron.classList.add(CSS.chevronExpanded);
      } else {
        chevron.classList.remove(CSS.chevronExpanded);
      }
    }

    // Update folder icon
    const icon = this.element.querySelector(`.${CSS.icon}`) as HTMLElement | null;
    if (icon && this.options.node.isDirectory) {
      icon.textContent = getFolderIcon(this.expanded);
    }

    // Show/hide children
    if (this.childContainer) {
      if (this.expanded) {
        this.childContainer.classList.remove(CSS.childrenHidden);
      } else {
        this.childContainer.classList.add(CSS.childrenHidden);
      }
    }
  }

  private handlePreview(): void {
    if (this.options.onPreview) {
      this.options.onPreview(this.options.node.path);
    } else {
      // Default: invoke IPC preview
      const bridge = getIpcBridge();
      bridge.invoke('filetree:open-file', { path: this.options.node.path, preview: true });
    }
  }

  private handleOpen(): void {
    if (this.options.onOpen) {
      this.options.onOpen(this.options.node.path);
    } else {
      // Default: invoke IPC open
      const bridge = getIpcBridge();
      bridge.invoke('filetree:open-file', { path: this.options.node.path, preview: false });
    }
  }
}
