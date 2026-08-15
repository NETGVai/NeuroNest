/**
 * EditorGroupState — Independent view state management per editor group.
 *
 * Each editor group maintains its own cursor, selection, scroll, and fold state
 * for each open model. Multiple groups can reference the same model without
 * merging view states.
 *
 * Requirements: 1.2, 1.3
 */

import { canonicalizeUri } from './uri-canonicalization';
import type { EditorGroupDescriptor, ViewState } from './types';

/**
 * Default view state for a newly opened file in a group.
 */
export function createDefaultViewState(): ViewState {
  return {
    cursorPosition: { lineNumber: 1, column: 1 },
    selection: null,
    scrollTop: 0,
    scrollLeft: 0,
    foldedRegions: [],
  };
}

/**
 * Manages independent view state for multiple editor groups.
 * Each group tracks its own cursor, selection, scroll, and fold state
 * per opened model URI.
 */
export class EditorGroupStateManager {
  private readonly groups: Map<string, EditorGroupDescriptor> = new Map();

  /**
   * Register a new editor group.
   */
  createGroup(groupId: string): EditorGroupDescriptor {
    if (this.groups.has(groupId)) {
      return this.groups.get(groupId)!;
    }
    const group: EditorGroupDescriptor = {
      groupId,
      tabs: new Map(),
      activeUri: null,
    };
    this.groups.set(groupId, group);
    return group;
  }

  /**
   * Remove an editor group.
   */
  removeGroup(groupId: string): boolean {
    return this.groups.delete(groupId);
  }

  /**
   * Get a group descriptor.
   */
  getGroup(groupId: string): EditorGroupDescriptor | undefined {
    return this.groups.get(groupId);
  }

  /**
   * Get all group IDs.
   */
  getGroupIds(): string[] {
    return [...this.groups.keys()];
  }

  /**
   * Open a model in a specific group with initial view state.
   * Does not merge with any other group's view state.
   */
  openInGroup(groupId: string, uri: string, initialViewState?: ViewState): ViewState {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} does not exist`);
    }

    const canonicalUri = canonicalizeUri(uri);

    // If already open in this group, return existing view state
    const existing = group.tabs.get(canonicalUri);
    if (existing) {
      group.activeUri = canonicalUri;
      return existing;
    }

    const viewState = initialViewState ?? createDefaultViewState();
    group.tabs.set(canonicalUri, viewState);
    group.activeUri = canonicalUri;
    return viewState;
  }

  /**
   * Close a model tab in a specific group.
   * Returns the removed view state or undefined if not found.
   */
  closeInGroup(groupId: string, uri: string): ViewState | undefined {
    const group = this.groups.get(groupId);
    if (!group) return undefined;

    const canonicalUri = canonicalizeUri(uri);
    const viewState = group.tabs.get(canonicalUri);
    if (!viewState) return undefined;

    group.tabs.delete(canonicalUri);

    // Clear active URI if it was the closed tab
    if (group.activeUri === canonicalUri) {
      // Set to first remaining tab or null
      const remaining = [...group.tabs.keys()];
      group.activeUri = remaining.length > 0 ? remaining[0]! : null;
    }

    return viewState;
  }

  /**
   * Update the view state for a model in a specific group.
   * Preserves independence — does not affect other groups.
   */
  updateViewState(groupId: string, uri: string, update: Partial<ViewState>): ViewState | undefined {
    const group = this.groups.get(groupId);
    if (!group) return undefined;

    const canonicalUri = canonicalizeUri(uri);
    const existing = group.tabs.get(canonicalUri);
    if (!existing) return undefined;

    const updated: ViewState = {
      ...existing,
      ...update,
    };
    group.tabs.set(canonicalUri, updated);
    return updated;
  }

  /**
   * Get the view state for a model in a specific group.
   */
  getViewState(groupId: string, uri: string): ViewState | undefined {
    const group = this.groups.get(groupId);
    if (!group) return undefined;

    const canonicalUri = canonicalizeUri(uri);
    return group.tabs.get(canonicalUri);
  }

  /**
   * Switch the active tab in a group.
   * Restores the persisted view state for that tab.
   * Returns the view state to restore, or undefined if not found.
   *
   * Requirement 1.3: restore view state without model recreation.
   */
  switchTab(groupId: string, uri: string): ViewState | undefined {
    const group = this.groups.get(groupId);
    if (!group) return undefined;

    const canonicalUri = canonicalizeUri(uri);
    const viewState = group.tabs.get(canonicalUri);
    if (!viewState) return undefined;

    group.activeUri = canonicalUri;
    return viewState;
  }

  /**
   * Get all URIs open in a group.
   */
  getOpenUris(groupId: string): string[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    return [...group.tabs.keys()];
  }

  /**
   * Restore view states from persisted session data.
   * This re-establishes view state without recreating models.
   *
   * Requirement 1.3: Session restoration stores URIs and view state,
   * not duplicate model content.
   */
  restoreGroupState(groupId: string, tabs: Map<string, ViewState>, activeUri: string | null): void {
    let group = this.groups.get(groupId);
    if (!group) {
      group = this.createGroup(groupId);
    }

    // Restore all tabs with their view states
    for (const [uri, viewState] of tabs) {
      const canonicalUri = canonicalizeUri(uri);
      group.tabs.set(canonicalUri, viewState);
    }

    // Restore active URI
    if (activeUri) {
      const canonicalActive = canonicalizeUri(activeUri);
      if (group.tabs.has(canonicalActive)) {
        group.activeUri = canonicalActive;
      }
    }
  }

  /**
   * Serialize the state of all groups for session persistence.
   */
  serializeAllGroups(): Array<{ groupId: string; tabs: Array<[string, ViewState]>; activeUri: string | null }> {
    const result: Array<{ groupId: string; tabs: Array<[string, ViewState]>; activeUri: string | null }> = [];
    for (const [groupId, group] of this.groups) {
      result.push({
        groupId,
        tabs: [...group.tabs.entries()],
        activeUri: group.activeUri,
      });
    }
    return result;
  }
}
