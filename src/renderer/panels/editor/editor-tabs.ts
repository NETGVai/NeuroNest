/**
 * Editor tab bar — manages multiple open file tabs.
 * Handles tab rendering, activation, closing, and dirty state indication.
 * Uses vanilla DOM for rendering.
 */

import type { EditorTab, FileState, TabId } from './types';
import { getFileName } from './editor-service';

/** Callback when a tab is selected by the user. */
export type OnTabSelectCallback = (tabId: TabId) => void;

/** Callback when a tab is closed by the user. */
export type OnTabCloseCallback = (tabId: TabId) => void;

/** Configuration for the tab bar component. */
export interface TabBarConfig {
  onSelect: OnTabSelectCallback;
  onClose: OnTabCloseCallback;
}

/**
 * EditorTabBar manages the visual tab strip for open editor files.
 * Renders tabs with file names, dirty indicators, and close buttons.
 */
export class EditorTabBar {
  private container: HTMLElement | null = null;
  private tabsElement: HTMLElement | null = null;
  private tabs: Map<TabId, EditorTab> = new Map();
  private activeTabId: TabId | null = null;
  private config: TabBarConfig;

  constructor(config: TabBarConfig) {
    this.config = config;
  }

  /**
   * Mounts the tab bar into the provided container element.
   */
  mount(container: HTMLElement): void {
    this.container = container;
    this.tabsElement = document.createElement('div');
    this.tabsElement.className = 'editor-tab-bar';
    this.tabsElement.setAttribute('role', 'tablist');
    this.tabsElement.setAttribute('aria-label', 'Open files');
    this.applyStyles();
    this.container.appendChild(this.tabsElement);
    this.render();
  }

  /**
   * Unmounts the tab bar and cleans up DOM elements.
   */
  unmount(): void {
    if (this.tabsElement && this.container) {
      this.container.removeChild(this.tabsElement);
    }
    this.tabsElement = null;
    this.container = null;
  }

  /**
   * Opens a new tab or activates an existing one for the given file.
   */
  openTab(fileState: FileState): void {
    const tabId = fileState.filePath;
    const existing = this.tabs.get(tabId);

    if (existing) {
      this.setActiveTab(tabId);
      return;
    }

    const tab: EditorTab = {
      id: tabId,
      label: getFileName(fileState.filePath),
      filePath: fileState.filePath,
      isDirty: fileState.isDirty,
      isActive: false,
    };

    this.tabs.set(tabId, tab);
    this.setActiveTab(tabId);
  }

  /**
   * Closes a tab and removes it from the tab bar.
   * Returns the ID of the tab that should become active (or null if none remain).
   */
  closeTab(tabId: TabId): TabId | null {
    if (!this.tabs.has(tabId)) return this.activeTabId;

    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      // Activate the most recently added remaining tab
      const remaining = Array.from(this.tabs.keys());
      this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      if (this.activeTabId) {
        const tab = this.tabs.get(this.activeTabId);
        if (tab) tab.isActive = true;
      }
    }

    this.render();
    return this.activeTabId;
  }

  /**
   * Updates the dirty state indicator for a tab.
   */
  setDirty(tabId: TabId, isDirty: boolean): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.isDirty !== isDirty) {
      tab.isDirty = isDirty;
      this.render();
    }
  }

  /**
   * Sets the active tab and updates visual state.
   */
  setActiveTab(tabId: TabId): void {
    if (this.activeTabId === tabId) return;

    // Deactivate previous tab
    if (this.activeTabId) {
      const prevTab = this.tabs.get(this.activeTabId);
      if (prevTab) prevTab.isActive = false;
    }

    // Activate new tab
    const newTab = this.tabs.get(tabId);
    if (newTab) {
      newTab.isActive = true;
      this.activeTabId = tabId;
    }

    this.render();
  }

  /**
   * Returns the currently active tab ID.
   */
  getActiveTabId(): TabId | null {
    return this.activeTabId;
  }

  /**
   * Returns all open tab IDs in order.
   */
  getTabIds(): TabId[] {
    return Array.from(this.tabs.keys());
  }

  /**
   * Returns the number of open tabs.
   */
  getTabCount(): number {
    return this.tabs.size;
  }

  /**
   * Re-renders the tab bar DOM to reflect current state.
   */
  private render(): void {
    if (!this.tabsElement) return;

    // Clear existing DOM
    this.tabsElement.innerHTML = '';

    const tabs = Array.from(this.tabs.values());
    for (const tab of tabs) {
      const tabEl = this.createTabElement(tab);
      this.tabsElement.appendChild(tabEl);
    }
  }

  /**
   * Creates a DOM element for a single tab.
   */
  private createTabElement(tab: EditorTab): HTMLElement {
    const tabEl = document.createElement('div');
    tabEl.className = `editor-tab${tab.isActive ? ' editor-tab--active' : ''}`;
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-selected', String(tab.isActive));
    tabEl.setAttribute('aria-label', `${tab.label}${tab.isDirty ? ' (unsaved)' : ''}`);
    tabEl.setAttribute('title', tab.filePath);
    tabEl.dataset.tabId = tab.id;

    // Dirty indicator
    if (tab.isDirty) {
      const dirtyDot = document.createElement('span');
      dirtyDot.className = 'editor-tab__dirty';
      dirtyDot.textContent = '●';
      dirtyDot.setAttribute('aria-hidden', 'true');
      tabEl.appendChild(dirtyDot);
    }

    // Label
    const labelEl = document.createElement('span');
    labelEl.className = 'editor-tab__label';
    labelEl.textContent = tab.label;
    tabEl.appendChild(labelEl);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'editor-tab__close';
    closeBtn.setAttribute('aria-label', `Close ${tab.label}`);
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.config.onClose(tab.id);
    });
    tabEl.appendChild(closeBtn);

    // Tab selection click handler
    tabEl.addEventListener('click', () => {
      this.config.onSelect(tab.id);
    });

    return tabEl;
  }

  /**
   * Applies inline styles for the tab bar.
   * Styles are scoped to avoid conflicts with the rest of the application.
   */
  private applyStyles(): void {
    if (!this.tabsElement) return;

    Object.assign(this.tabsElement.style, {
      display: 'flex',
      flexDirection: 'row',
      overflowX: 'auto',
      overflowY: 'hidden',
      height: '36px',
      minHeight: '36px',
      backgroundColor: 'var(--editor-tab-bar-bg, #1e1e1e)',
      borderBottom: '1px solid var(--editor-tab-bar-border, #333)',
      userSelect: 'none',
    });

    // Add scoped CSS for tab items via a style element
    const styleId = 'editor-tab-bar-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .editor-tab {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 12px;
          height: 100%;
          cursor: pointer;
          font-size: 13px;
          color: var(--editor-tab-color, #999);
          background: var(--editor-tab-bg, transparent);
          border-right: 1px solid var(--editor-tab-border, #333);
          white-space: nowrap;
          transition: background 0.1s, color 0.1s;
        }
        .editor-tab:hover {
          background: var(--editor-tab-hover-bg, #2a2a2a);
          color: var(--editor-tab-hover-color, #ccc);
        }
        .editor-tab--active {
          background: var(--editor-tab-active-bg, #1e1e1e);
          color: var(--editor-tab-active-color, #fff);
          border-bottom: 2px solid var(--editor-tab-active-border, #007acc);
        }
        .editor-tab__dirty {
          color: var(--editor-tab-dirty-color, #e8a838);
          font-size: 10px;
        }
        .editor-tab__label {
          max-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .editor-tab__close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border: none;
          background: transparent;
          color: inherit;
          font-size: 14px;
          cursor: pointer;
          border-radius: 3px;
          opacity: 0.6;
        }
        .editor-tab__close:hover {
          opacity: 1;
          background: var(--editor-tab-close-hover-bg, #444);
        }
      `;
      document.head.appendChild(style);
    }
  }
}
