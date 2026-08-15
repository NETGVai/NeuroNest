/**
 * MissingFileHandler — Detects and manages missing file recovery.
 *
 * When a file referenced by an Editor_Group or restored session is missing,
 * shows a recoverable state with three options:
 * - Locate (browse for the file at a new path)
 * - Remove Tab (close the tab)
 * - Restore from Checkpoint (restore from a prior checkpoint)
 *
 * Works both during startup restoration and during later operation.
 *
 * Requirements: 2.5, 2.6
 */

import { canonicalizeUri } from './uri-canonicalization';

/**
 * Recovery options available for a missing file.
 */
export type MissingFileRecoveryAction = 'locate' | 'remove-tab' | 'restore-from-checkpoint';

/**
 * State record for a missing file.
 */
export interface MissingFileState {
  uri: string;
  groupId: string;
  detectedAt: number;
  detectedDuring: 'startup' | 'operation';
  resolved: boolean;
  resolutionAction?: MissingFileRecoveryAction;
  newUri?: string;
}

/**
 * Listener notified when a missing file is detected or resolved.
 */
export type MissingFileListener = (state: MissingFileState) => void;

/**
 * Adapter to check if a file exists on the filesystem.
 */
export type FileExistenceChecker = (uri: string) => boolean;

/**
 * Adapter to locate a file (e.g., open file dialog).
 */
export type FileLocator = (originalUri: string) => string | null;

/**
 * Adapter to restore a file from a checkpoint.
 */
export type CheckpointRestorer = (uri: string) => boolean;

/**
 * Adapter to remove a tab from a group.
 */
export type TabRemover = (groupId: string, uri: string) => boolean;

/**
 * MissingFileHandler detects and recovers from missing files
 * during startup restoration and normal operation.
 */
export class MissingFileHandler {
  private readonly missingFiles: Map<string, MissingFileState> = new Map();
  private readonly listeners: Set<MissingFileListener> = new Set();
  private readonly fileExistsChecker: FileExistenceChecker;
  private readonly fileLocator: FileLocator;
  private readonly checkpointRestorer: CheckpointRestorer;
  private readonly tabRemover: TabRemover;

  constructor(
    fileExistsChecker: FileExistenceChecker,
    fileLocator: FileLocator,
    checkpointRestorer: CheckpointRestorer,
    tabRemover: TabRemover,
  ) {
    this.fileExistsChecker = fileExistsChecker;
    this.fileLocator = fileLocator;
    this.checkpointRestorer = checkpointRestorer;
    this.tabRemover = tabRemover;
  }

  /**
   * Subscribe to missing file detection and resolution events.
   */
  onMissingFile(listener: MissingFileListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Check a set of URIs for missing files (e.g. during startup restoration).
   * Returns the URIs that are missing.
   */
  checkFiles(
    uris: Array<{ uri: string; groupId: string }>,
    during: 'startup' | 'operation' = 'operation',
  ): string[] {
    const missing: string[] = [];

    for (const { uri, groupId } of uris) {
      const canonicalUri = canonicalizeUri(uri);
      if (!this.fileExistsChecker(canonicalUri)) {
        const state: MissingFileState = {
          uri: canonicalUri,
          groupId,
          detectedAt: Date.now(),
          detectedDuring: during,
          resolved: false,
        };
        const key = `${groupId}:${canonicalUri}`;
        this.missingFiles.set(key, state);
        this.notifyListeners(state);
        missing.push(canonicalUri);
      }
    }

    return missing;
  }

  /**
   * Detect if a single file is missing (during normal operation).
   */
  detectMissing(uri: string, groupId: string): boolean {
    const canonicalUri = canonicalizeUri(uri);
    if (!this.fileExistsChecker(canonicalUri)) {
      const state: MissingFileState = {
        uri: canonicalUri,
        groupId,
        detectedAt: Date.now(),
        detectedDuring: 'operation',
        resolved: false,
      };
      const key = `${groupId}:${canonicalUri}`;
      this.missingFiles.set(key, state);
      this.notifyListeners(state);
      return true;
    }
    return false;
  }

  /**
   * Get all unresolved missing file states.
   */
  getUnresolved(): MissingFileState[] {
    return [...this.missingFiles.values()].filter((s) => !s.resolved);
  }

  /**
   * Get the missing file state for a specific file in a group.
   */
  getState(uri: string, groupId: string): MissingFileState | undefined {
    const canonicalUri = canonicalizeUri(uri);
    const key = `${groupId}:${canonicalUri}`;
    return this.missingFiles.get(key);
  }

  /**
   * Get available recovery actions for a missing file.
   */
  getRecoveryActions(): MissingFileRecoveryAction[] {
    return ['locate', 'remove-tab', 'restore-from-checkpoint'];
  }

  /**
   * Execute a recovery action for a missing file.
   */
  recover(
    uri: string,
    groupId: string,
    action: MissingFileRecoveryAction,
  ): { success: boolean; newUri?: string; reason?: string } {
    const canonicalUri = canonicalizeUri(uri);
    const key = `${groupId}:${canonicalUri}`;
    const state = this.missingFiles.get(key);

    if (!state) {
      return { success: false, reason: 'No missing file record found.' };
    }

    if (state.resolved) {
      return { success: false, reason: 'File already resolved.' };
    }

    switch (action) {
      case 'locate': {
        const newUri = this.fileLocator(canonicalUri);
        if (newUri) {
          state.resolved = true;
          state.resolutionAction = 'locate';
          state.newUri = canonicalizeUri(newUri);
          this.notifyListeners(state);
          return { success: true, newUri: state.newUri };
        }
        return { success: false, reason: 'File not found at new location.' };
      }

      case 'remove-tab': {
        const removed = this.tabRemover(groupId, canonicalUri);
        if (removed) {
          state.resolved = true;
          state.resolutionAction = 'remove-tab';
          this.notifyListeners(state);
          return { success: true };
        }
        return { success: false, reason: 'Failed to remove tab.' };
      }

      case 'restore-from-checkpoint': {
        const restored = this.checkpointRestorer(canonicalUri);
        if (restored) {
          state.resolved = true;
          state.resolutionAction = 'restore-from-checkpoint';
          this.notifyListeners(state);
          return { success: true };
        }
        return { success: false, reason: 'Failed to restore from checkpoint.' };
      }

      default:
        return { success: false, reason: `Unknown action: ${action}` };
    }
  }

  /**
   * Check if a URI is currently in missing state for any group.
   */
  isMissing(uri: string): boolean {
    const canonicalUri = canonicalizeUri(uri);
    for (const [key, state] of this.missingFiles) {
      if (key.endsWith(`:${canonicalUri}`) && !state.resolved) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clear all resolved records.
   */
  clearResolved(): void {
    for (const [key, state] of this.missingFiles) {
      if (state.resolved) {
        this.missingFiles.delete(key);
      }
    }
  }

  private notifyListeners(state: MissingFileState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
