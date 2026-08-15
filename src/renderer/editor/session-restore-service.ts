/**
 * SessionRestoreService — Restores persisted session state on startup.
 *
 * Restores open tabs, active tabs, groups, and per-group view states.
 * Restoration takes precedence over a zero-groups request:
 * persisted state is restored first, then the user may explicitly change layout.
 *
 * Requirements: 2.5, 2.6
 */

import type { ViewState } from './types';
import type { EditorGroupStateManager } from './editor-group-state';
import type { EditorLayoutManager } from './editor-layout-manager';

/**
 * Serialized per-group state for persistence.
 */
export interface PersistedGroupState {
  groupId: string;
  tabs: Array<{ uri: string; viewState: ViewState }>;
  activeUri: string | null;
}

/**
 * Complete persisted session layout state.
 */
export interface PersistedSessionState {
  groups: PersistedGroupState[];
  layoutArrangement: string;
  timestamp: number;
}

/**
 * Result of a session restoration.
 */
export interface SessionRestoreResult {
  success: boolean;
  restoredGroupCount: number;
  restoredTabCount: number;
  /** True if persisted state took precedence over zero-groups request. */
  precedenceApplied: boolean;
  missingFiles: string[];
}

/**
 * Storage adapter for persisting/loading session state.
 */
export interface SessionStorageAdapter {
  load(): PersistedSessionState | null;
  save(state: PersistedSessionState): void;
}

/**
 * File existence checker used during restoration.
 */
export type FileExistsChecker = (uri: string) => boolean;

/**
 * SessionRestoreService coordinates restoration of persisted tabs,
 * groups, and view states, ensuring persisted state takes precedence
 * over a current zero-groups request.
 */
export class SessionRestoreService {
  private readonly storageAdapter: SessionStorageAdapter;
  private readonly groupStateManager: EditorGroupStateManager;
  private readonly layoutManager: EditorLayoutManager;
  private readonly fileExistsChecker: FileExistsChecker;
  private lastRestoredState: PersistedSessionState | null = null;

  constructor(
    storageAdapter: SessionStorageAdapter,
    groupStateManager: EditorGroupStateManager,
    layoutManager: EditorLayoutManager,
    fileExistsChecker: FileExistsChecker,
  ) {
    this.storageAdapter = storageAdapter;
    this.groupStateManager = groupStateManager;
    this.layoutManager = layoutManager;
    this.fileExistsChecker = fileExistsChecker;
  }

  /**
   * Restore persisted session state.
   * When a current request would display zero groups, persisted state takes precedence.
   *
   * @param currentRequestedGroupCount — the group count that would otherwise be shown (e.g. 0 on fresh startup)
   */
  restore(currentRequestedGroupCount: number = 0): SessionRestoreResult {
    const persisted = this.storageAdapter.load();

    if (!persisted || persisted.groups.length === 0) {
      return {
        success: false,
        restoredGroupCount: 0,
        restoredTabCount: 0,
        precedenceApplied: false,
        missingFiles: [],
      };
    }

    this.lastRestoredState = persisted;
    const missingFiles: string[] = [];
    let totalTabCount = 0;
    const groupIds: string[] = [];

    // Restore group states
    for (const groupState of persisted.groups) {
      this.groupStateManager.createGroup(groupState.groupId);
      groupIds.push(groupState.groupId);

      const tabMap = new Map<string, ViewState>();
      for (const tab of groupState.tabs) {
        if (!this.fileExistsChecker(tab.uri)) {
          missingFiles.push(tab.uri);
        }
        tabMap.set(tab.uri, tab.viewState);
        totalTabCount++;
      }

      this.groupStateManager.restoreGroupState(
        groupState.groupId,
        tabMap,
        groupState.activeUri,
      );
    }

    // Restoration takes precedence over zero-groups request
    const precedenceApplied = currentRequestedGroupCount === 0 && groupIds.length > 0;

    // Set up layout with restored groups
    this.layoutManager.setGroupCount(groupIds);

    return {
      success: true,
      restoredGroupCount: groupIds.length,
      restoredTabCount: totalTabCount,
      precedenceApplied,
      missingFiles,
    };
  }

  /**
   * Persist the current session state.
   */
  save(): void {
    const serializedGroups = this.groupStateManager.serializeAllGroups();
    const groups: PersistedGroupState[] = serializedGroups.map((g) => ({
      groupId: g.groupId,
      tabs: g.tabs.map(([uri, viewState]) => ({ uri, viewState })),
      activeUri: g.activeUri,
    }));

    const state: PersistedSessionState = {
      groups,
      layoutArrangement: this.layoutManager.arrangement,
      timestamp: Date.now(),
    };

    this.storageAdapter.save(state);
  }

  /**
   * Get the last restored state (for diagnostics or UI display).
   */
  getLastRestoredState(): PersistedSessionState | null {
    return this.lastRestoredState;
  }
}
