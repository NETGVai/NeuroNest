/**
 * TabCommandService — Provides discoverable, keyboard-operable tab commands.
 *
 * Requirements: 2.1, 2.7
 *
 * Supports:
 * - Selection (select tab)
 * - Close, Close Others, Close to Right
 * - Reopen closed tab
 * - Pin/Unpin tab
 * - Preview mode (single preview tab)
 * - Reorder tabs within a group
 * - Move tab to another group
 * - All commands discoverable (command palette) and keyboard-operable
 */

import type { ViewState } from './types';
import { EditorGroupStateManager } from './editor-group-state';

/**
 * Represents a tab within the TabCommandService.
 */
export interface TabEntry {
  uri: string;
  isPinned: boolean;
  isPreview: boolean;
}

/**
 * A closed tab record for reopen functionality.
 */
export interface ClosedTabRecord {
  uri: string;
  groupId: string;
  viewState: ViewState;
  closedAt: number;
}

/**
 * A command descriptor for discoverable command palette integration.
 */
export interface TabCommand {
  id: string;
  label: string;
  keybindingSlot: string;
  category: string;
}

/**
 * Result of a tab command execution.
 */
export interface TabCommandResult {
  success: boolean;
  message?: string;
}

/**
 * List of all available tab commands for discoverability.
 */
export const TAB_COMMANDS: TabCommand[] = [
  { id: 'tab.select', label: 'Select Tab', keybindingSlot: 'ctrl+tab', category: 'Editor Tabs' },
  { id: 'tab.close', label: 'Close Tab', keybindingSlot: 'ctrl+w', category: 'Editor Tabs' },
  { id: 'tab.closeOthers', label: 'Close Other Tabs', keybindingSlot: 'ctrl+shift+alt+w', category: 'Editor Tabs' },
  { id: 'tab.closeToRight', label: 'Close Tabs to the Right', keybindingSlot: 'ctrl+shift+w', category: 'Editor Tabs' },
  { id: 'tab.reopen', label: 'Reopen Closed Tab', keybindingSlot: 'ctrl+shift+t', category: 'Editor Tabs' },
  { id: 'tab.pin', label: 'Pin Tab', keybindingSlot: 'ctrl+shift+p', category: 'Editor Tabs' },
  { id: 'tab.unpin', label: 'Unpin Tab', keybindingSlot: 'ctrl+shift+p', category: 'Editor Tabs' },
  { id: 'tab.preview', label: 'Toggle Preview Mode', keybindingSlot: 'ctrl+shift+v', category: 'Editor Tabs' },
  { id: 'tab.moveLeft', label: 'Move Tab Left', keybindingSlot: 'ctrl+shift+pageup', category: 'Editor Tabs' },
  { id: 'tab.moveRight', label: 'Move Tab Right', keybindingSlot: 'ctrl+shift+pagedown', category: 'Editor Tabs' },
  { id: 'tab.moveToGroup', label: 'Move Tab to Group', keybindingSlot: 'ctrl+alt+right', category: 'Editor Tabs' },
];

/**
 * TabCommandService manages tab-level operations within editor groups.
 */
export class TabCommandService {
  private readonly _groupManager: EditorGroupStateManager;
  private readonly _tabs: Map<string, Map<string, TabEntry>> = new Map(); // groupId -> (uri -> TabEntry)
  private readonly _tabOrder: Map<string, string[]> = new Map(); // groupId -> ordered URIs
  private readonly _closedTabs: ClosedTabRecord[] = [];
  private readonly _maxClosedHistory = 20;

  constructor(groupManager: EditorGroupStateManager) {
    this._groupManager = groupManager;
  }

  /**
   * Get all registered commands for discoverability.
   */
  getCommands(): TabCommand[] {
    return [...TAB_COMMANDS];
  }

  /**
   * Get the ordered tabs for a group.
   */
  getTabOrder(groupId: string): string[] {
    return [...(this._tabOrder.get(groupId) ?? [])];
  }

  /**
   * Get a specific tab entry.
   */
  getTab(groupId: string, uri: string): TabEntry | undefined {
    return this._tabs.get(groupId)?.get(uri);
  }

  /**
   * Initialize a group for tab management.
   */
  initGroup(groupId: string): void {
    if (!this._tabs.has(groupId)) {
      this._tabs.set(groupId, new Map());
      this._tabOrder.set(groupId, []);
    }
  }

  /**
   * Remove a group from tab management.
   */
  removeGroup(groupId: string): void {
    this._tabs.delete(groupId);
    this._tabOrder.delete(groupId);
  }

  /**
   * Open a tab in a group. If preview mode is active, replaces the existing preview tab.
   */
  openTab(groupId: string, uri: string, options?: { preview?: boolean }): TabCommandResult {
    this.initGroup(groupId);
    const groupTabs = this._tabs.get(groupId)!;
    const order = this._tabOrder.get(groupId)!;

    // If this is a preview open, close existing preview tab
    if (options?.preview) {
      const existingPreview = [...groupTabs.entries()].find(([, t]) => t.isPreview);
      if (existingPreview) {
        groupTabs.delete(existingPreview[0]);
        const idx = order.indexOf(existingPreview[0]);
        if (idx >= 0) order.splice(idx, 1);
      }
    }

    if (!groupTabs.has(uri)) {
      groupTabs.set(uri, { uri, isPinned: false, isPreview: options?.preview ?? false });
      order.push(uri);
    } else if (!options?.preview) {
      // Opening a preview tab permanently promotes it
      const tab = groupTabs.get(uri)!;
      if (tab.isPreview) {
        tab.isPreview = false;
      }
    }

    return { success: true };
  }

  /**
   * Select (activate) a tab in a group.
   */
  selectTab(groupId: string, uri: string): TabCommandResult {
    const groupTabs = this._tabs.get(groupId);
    if (!groupTabs?.has(uri)) {
      return { success: false, message: `Tab "${uri}" not found in group "${groupId}".` };
    }

    this._groupManager.switchTab(groupId, uri);
    return { success: true };
  }

  /**
   * Close a specific tab.
   */
  closeTab(groupId: string, uri: string): TabCommandResult {
    const groupTabs = this._tabs.get(groupId);
    if (!groupTabs?.has(uri)) {
      return { success: false, message: `Tab "${uri}" not found in group "${groupId}".` };
    }

    // Save to closed history
    const viewState = this._groupManager.getViewState(groupId, uri);
    if (viewState) {
      this._closedTabs.push({ uri, groupId, viewState, closedAt: Date.now() });
      if (this._closedTabs.length > this._maxClosedHistory) {
        this._closedTabs.shift();
      }
    }

    groupTabs.delete(uri);
    const order = this._tabOrder.get(groupId)!;
    const idx = order.indexOf(uri);
    if (idx >= 0) order.splice(idx, 1);

    this._groupManager.closeInGroup(groupId, uri);
    return { success: true };
  }

  /**
   * Close all tabs except the specified one.
   */
  closeOthers(groupId: string, keepUri: string): TabCommandResult {
    const groupTabs = this._tabs.get(groupId);
    if (!groupTabs) {
      return { success: false, message: `Group "${groupId}" not found.` };
    }

    const toClose = [...groupTabs.keys()].filter(
      (uri) => uri !== keepUri && !groupTabs.get(uri)!.isPinned
    );

    for (const uri of toClose) {
      this.closeTab(groupId, uri);
    }

    return { success: true };
  }

  /**
   * Close all tabs to the right of the specified tab.
   */
  closeToRight(groupId: string, uri: string): TabCommandResult {
    const order = this._tabOrder.get(groupId);
    if (!order) {
      return { success: false, message: `Group "${groupId}" not found.` };
    }

    const groupTabs = this._tabs.get(groupId)!;
    const idx = order.indexOf(uri);
    if (idx < 0) {
      return { success: false, message: `Tab "${uri}" not found in group "${groupId}".` };
    }

    const toClose = order.slice(idx + 1).filter(
      (u) => !groupTabs.get(u)?.isPinned
    );

    for (const u of toClose) {
      this.closeTab(groupId, u);
    }

    return { success: true };
  }

  /**
   * Reopen the most recently closed tab.
   */
  reopenClosed(): TabCommandResult {
    const record = this._closedTabs.pop();
    if (!record) {
      return { success: false, message: 'No recently closed tabs to reopen.' };
    }

    this.initGroup(record.groupId);
    this.openTab(record.groupId, record.uri);
    this._groupManager.openInGroup(record.groupId, record.uri, record.viewState);
    return { success: true };
  }

  /**
   * Pin a tab (pinned tabs cannot be closed by closeOthers/closeToRight).
   */
  pinTab(groupId: string, uri: string): TabCommandResult {
    const tab = this._tabs.get(groupId)?.get(uri);
    if (!tab) {
      return { success: false, message: `Tab "${uri}" not found in group "${groupId}".` };
    }
    tab.isPinned = true;
    tab.isPreview = false; // Pinning promotes from preview
    return { success: true };
  }

  /**
   * Unpin a tab.
   */
  unpinTab(groupId: string, uri: string): TabCommandResult {
    const tab = this._tabs.get(groupId)?.get(uri);
    if (!tab) {
      return { success: false, message: `Tab "${uri}" not found in group "${groupId}".` };
    }
    tab.isPinned = false;
    return { success: true };
  }

  /**
   * Reorder a tab within its group (move to a new index).
   */
  reorderTab(groupId: string, uri: string, newIndex: number): TabCommandResult {
    const order = this._tabOrder.get(groupId);
    if (!order) {
      return { success: false, message: `Group "${groupId}" not found.` };
    }

    const currentIdx = order.indexOf(uri);
    if (currentIdx < 0) {
      return { success: false, message: `Tab "${uri}" not found in group "${groupId}".` };
    }

    // Clamp newIndex
    const clampedIndex = Math.max(0, Math.min(newIndex, order.length - 1));
    order.splice(currentIdx, 1);
    order.splice(clampedIndex, 0, uri);

    return { success: true };
  }

  /**
   * Move a tab from one group to another.
   */
  moveToGroup(sourceGroupId: string, uri: string, targetGroupId: string): TabCommandResult {
    const sourceGroupTabs = this._tabs.get(sourceGroupId);
    if (!sourceGroupTabs?.has(uri)) {
      return { success: false, message: `Tab "${uri}" not found in source group "${sourceGroupId}".` };
    }

    // Get view state before removing from source
    const viewState = this._groupManager.getViewState(sourceGroupId, uri);
    const tabEntry = sourceGroupTabs.get(uri)!;

    // Remove from source group
    sourceGroupTabs.delete(uri);
    const sourceOrder = this._tabOrder.get(sourceGroupId)!;
    const idx = sourceOrder.indexOf(uri);
    if (idx >= 0) sourceOrder.splice(idx, 1);
    this._groupManager.closeInGroup(sourceGroupId, uri);

    // Add to target group
    this.initGroup(targetGroupId);
    const targetGroupTabs = this._tabs.get(targetGroupId)!;
    targetGroupTabs.set(uri, { ...tabEntry });
    this._tabOrder.get(targetGroupId)!.push(uri);
    this._groupManager.openInGroup(targetGroupId, uri, viewState ?? undefined);

    return { success: true };
  }

  /**
   * Get closed tab history.
   */
  getClosedHistory(): ReadonlyArray<ClosedTabRecord> {
    return [...this._closedTabs];
  }
}
