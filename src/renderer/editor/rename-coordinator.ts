/**
 * RenameCoordinator — Coordinated file rename/move across all surfaces.
 *
 * Rename is one coordinated operation: path reservation, model URI rebinding,
 * tab/context/change reference updates, disk mutation, and language-service
 * rename lifecycle.
 *
 * Requirements: 1.7
 */

import { canonicalizeUri } from './uri-canonicalization';
import type { EditorModelStore } from './editor-model-store';
import type { EditorGroupStateManager } from './editor-group-state';

/** Lifecycle events emitted during rename. */
export type RenameLifecycleEventType =
  | 'renameStarted'
  | 'pathReserved'
  | 'modelRebound'
  | 'tabsUpdated'
  | 'diagnosticsUpdated'
  | 'contextItemsUpdated'
  | 'changeSetsUpdated'
  | 'renameCompleted'
  | 'renameFailed';

export interface RenameLifecycleEvent {
  type: RenameLifecycleEventType;
  oldUri: string;
  newUri: string;
  timestamp: number;
}

export type RenameLifecycleListener = (event: RenameLifecycleEvent) => void;

/** Registry for diagnostics that can be updated by URI. */
export interface DiagnosticsReferenceUpdater {
  updateUri(oldUri: string, newUri: string): void;
}

/** Registry for context items that reference files. */
export interface ContextItemReferenceUpdater {
  updateUri(oldUri: string, newUri: string): void;
}

/** Registry for pending change sets referencing target URIs. */
export interface ChangeSetReferenceUpdater {
  updateTargetUri(oldUri: string, newUri: string): void;
}

/** Path reservation service to ensure no conflict at the new URI. */
export interface PathReservationService {
  reserve(newUri: string): boolean;
  release(newUri: string): void;
}

/** Result of a rename operation. */
export interface RenameResult {
  success: boolean;
  oldUri: string;
  newUri: string;
  error?: string;
}

/**
 * RenameCoordinator performs coordinated renames across all editor surfaces.
 *
 * Steps:
 * 1. Reserve the new path
 * 2. Rebind the model URI in EditorModelStore
 * 3. Update all EditorGroupState tabs referencing the old URI
 * 4. Update diagnostics references
 * 5. Update Context_Item references
 * 6. Update pending Change_Set target URIs
 * 7. Emit rename lifecycle events (for LSP notification)
 */
export class RenameCoordinator {
  private readonly store: EditorModelStore;
  private readonly groupManager: EditorGroupStateManager;
  private readonly diagnosticsUpdater: DiagnosticsReferenceUpdater;
  private readonly contextItemUpdater: ContextItemReferenceUpdater;
  private readonly changeSetUpdater: ChangeSetReferenceUpdater;
  private readonly pathReservation: PathReservationService;
  private readonly listeners: Set<RenameLifecycleListener> = new Set();

  constructor(
    store: EditorModelStore,
    groupManager: EditorGroupStateManager,
    diagnosticsUpdater: DiagnosticsReferenceUpdater,
    contextItemUpdater: ContextItemReferenceUpdater,
    changeSetUpdater: ChangeSetReferenceUpdater,
    pathReservation: PathReservationService,
  ) {
    this.store = store;
    this.groupManager = groupManager;
    this.diagnosticsUpdater = diagnosticsUpdater;
    this.contextItemUpdater = contextItemUpdater;
    this.changeSetUpdater = changeSetUpdater;
    this.pathReservation = pathReservation;
  }

  /**
   * Subscribe to rename lifecycle events.
   */
  onRenameEvent(listener: RenameLifecycleListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Perform a coordinated rename from oldUri to newUri.
   *
   * This operation:
   * 1. Reserves the new path
   * 2. Rebinds the model URI in the store
   * 3. Updates all group tabs referencing the old URI
   * 4. Updates diagnostics, context items, and change set references
   * 5. Emits lifecycle events for LSP and other consumers
   */
  rename(oldUri: string, newUri: string): RenameResult {
    const canonicalOld = canonicalizeUri(oldUri);
    const canonicalNew = canonicalizeUri(newUri);

    // Cannot rename to the same URI
    if (canonicalOld === canonicalNew) {
      return { success: false, oldUri: canonicalOld, newUri: canonicalNew, error: 'source-equals-target' };
    }

    // Model must exist
    if (!this.store.hasModel(canonicalOld)) {
      return { success: false, oldUri: canonicalOld, newUri: canonicalNew, error: 'model-not-found' };
    }

    // Target must not already exist in store
    if (this.store.hasModel(canonicalNew)) {
      return { success: false, oldUri: canonicalOld, newUri: canonicalNew, error: 'target-already-exists' };
    }

    this.emitEvent('renameStarted', canonicalOld, canonicalNew);

    // Step 1: Reserve the new path
    const reserved = this.pathReservation.reserve(canonicalNew);
    if (!reserved) {
      this.emitEvent('renameFailed', canonicalOld, canonicalNew);
      return { success: false, oldUri: canonicalOld, newUri: canonicalNew, error: 'path-reservation-failed' };
    }
    this.emitEvent('pathReserved', canonicalOld, canonicalNew);

    // Step 2: Rebind the model URI in EditorModelStore
    const rebound = this.rebindModelUri(canonicalOld, canonicalNew);
    if (!rebound) {
      this.pathReservation.release(canonicalNew);
      this.emitEvent('renameFailed', canonicalOld, canonicalNew);
      return { success: false, oldUri: canonicalOld, newUri: canonicalNew, error: 'model-rebind-failed' };
    }
    this.emitEvent('modelRebound', canonicalOld, canonicalNew);

    // Step 3: Update all group tabs
    this.updateGroupTabs(canonicalOld, canonicalNew);
    this.emitEvent('tabsUpdated', canonicalOld, canonicalNew);

    // Step 4: Update diagnostics references
    this.diagnosticsUpdater.updateUri(canonicalOld, canonicalNew);
    this.emitEvent('diagnosticsUpdated', canonicalOld, canonicalNew);

    // Step 5: Update context item references
    this.contextItemUpdater.updateUri(canonicalOld, canonicalNew);
    this.emitEvent('contextItemsUpdated', canonicalOld, canonicalNew);

    // Step 6: Update change set target URIs
    this.changeSetUpdater.updateTargetUri(canonicalOld, canonicalNew);
    this.emitEvent('changeSetsUpdated', canonicalOld, canonicalNew);

    // Step 7: Release old path reservation and emit completion
    this.emitEvent('renameCompleted', canonicalOld, canonicalNew);

    return { success: true, oldUri: canonicalOld, newUri: canonicalNew };
  }

  /**
   * Rebind the model from oldUri to newUri in the store.
   * This transfers the EditorModelRecord to the new key.
   */
  private rebindModelUri(oldUri: string, newUri: string): boolean {
    const record = this.store.getModel(oldUri);
    if (!record) return false;

    // Acquire a new model at the new URI using the existing model's content
    // Then transfer references appropriately
    const content = record.model.getValue();
    const refCount = record.referenceCount;

    // Release all references on old URI
    for (let i = 0; i < refCount; i++) {
      this.store.releaseReference(oldUri);
    }

    // Dispose the old model
    this.store.disposeModel(oldUri);

    // Acquire at new URI with same content
    const newRecord = this.store.acquireModel(newUri, content);

    // Set reference count to match original (acquireModel already adds 1)
    for (let i = 1; i < refCount; i++) {
      this.store.acquireModel(newUri, content);
    }

    return newRecord !== undefined;
  }

  /**
   * Update all group tabs that reference the old URI to point to the new URI.
   * Preserves view state during the transition.
   */
  private updateGroupTabs(oldUri: string, newUri: string): void {
    const groupIds = this.groupManager.getGroupIds();

    for (const groupId of groupIds) {
      const openUris = this.groupManager.getOpenUris(groupId);
      if (openUris.includes(oldUri)) {
        // Get the existing view state
        const viewState = this.groupManager.getViewState(groupId, oldUri);
        if (viewState) {
          // Close old tab
          this.groupManager.closeInGroup(groupId, oldUri);
          // Open new tab with preserved view state
          this.groupManager.openInGroup(groupId, newUri, viewState);
        }
      }
    }
  }

  private emitEvent(type: RenameLifecycleEventType, oldUri: string, newUri: string): void {
    const event: RenameLifecycleEvent = {
      type,
      oldUri,
      newUri,
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
