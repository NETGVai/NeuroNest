/**
 * ReviewNavigator — Navigate between hunks, files, and related planning entities.
 *
 * Provides navigation between hunks within a file, between files in a Change_Set,
 * and from review view to related planning entities (tasks, requirements).
 * Supports back/forward navigation history within the review.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import { ChangeSet, FileOperation } from '../change-set/types';
import { ReviewScopeService, ReviewHunk } from './review-scope-service';

// ─── Types ──────────────────────────────────────────────────────

/** The type of review navigation target. */
export type NavigationTargetKind = 'file' | 'hunk' | 'task' | 'requirement' | 'run';

/** A navigation target within the review system. */
export interface NavigationTarget {
  /** The kind of target being navigated to. */
  readonly kind: NavigationTargetKind;
  /** Unique identifier for the target. */
  readonly id: string;
  /** The Change_Set context. */
  readonly changeSetId: string;
  /** File URI for file/hunk targets. */
  readonly fileUri?: string;
  /** Hunk ID for hunk targets. */
  readonly hunkId?: string;
  /** Associated entity ID for planning targets (task, requirement, run). */
  readonly entityId?: string;
}

/** Navigation state within the review. */
export interface NavigationState {
  /** Currently active target. */
  readonly current: NavigationTarget | null;
  /** Whether back navigation is available. */
  readonly canGoBack: boolean;
  /** Whether forward navigation is available. */
  readonly canGoForward: boolean;
  /** Total history length. */
  readonly historyLength: number;
  /** Current position in history (0-indexed). */
  readonly historyPosition: number;
}

/** Related planning entity linked to a Change_Set. */
export interface RelatedEntity {
  /** The entity type. */
  readonly kind: 'task' | 'requirement' | 'run';
  /** Entity ID. */
  readonly id: string;
  /** Display label. */
  readonly label: string;
}

// ─── Service ────────────────────────────────────────────────────

/**
 * ReviewNavigator provides structured navigation within a Change_Set review.
 * Supports back/forward history, hunk-to-hunk traversal, and planning entity links.
 */
export class ReviewNavigator {
  private readonly history: NavigationTarget[] = [];
  private historyPosition = -1;
  private readonly maxHistorySize = 100;

  constructor(private readonly reviewScopeService: ReviewScopeService) {}

  /**
   * Navigate to a specific target, pushing it onto the history stack.
   */
  navigateTo(target: NavigationTarget): void {
    // Truncate forward history when navigating from a mid-point
    if (this.historyPosition < this.history.length - 1) {
      this.history.splice(this.historyPosition + 1);
    }

    this.history.push(target);

    // Enforce max history size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    } else {
      this.historyPosition++;
    }
  }

  /**
   * Navigate back in history.
   * Returns the previous target, or null if at the beginning.
   */
  goBack(): NavigationTarget | null {
    if (this.historyPosition <= 0) return null;
    this.historyPosition--;
    return this.history[this.historyPosition];
  }

  /**
   * Navigate forward in history.
   * Returns the next target, or null if at the end.
   */
  goForward(): NavigationTarget | null {
    if (this.historyPosition >= this.history.length - 1) return null;
    this.historyPosition++;
    return this.history[this.historyPosition];
  }

  /**
   * Gets the current navigation state.
   */
  getState(): NavigationState {
    return {
      current: this.historyPosition >= 0 ? this.history[this.historyPosition] : null,
      canGoBack: this.historyPosition > 0,
      canGoForward: this.historyPosition < this.history.length - 1,
      historyLength: this.history.length,
      historyPosition: this.historyPosition,
    };
  }

  /**
   * Navigate to the next file in the Change_Set.
   * Returns the next file target, or null if at the last file.
   */
  nextFile(changeSet: ChangeSet): NavigationTarget | null {
    const files = this.getFileUris(changeSet);
    const currentFileUri = this.getCurrentFileUri();
    const currentIndex = currentFileUri ? files.indexOf(currentFileUri) : -1;
    const nextIndex = currentIndex + 1;

    if (nextIndex >= files.length) return null;

    const target: NavigationTarget = {
      kind: 'file',
      id: files[nextIndex],
      changeSetId: changeSet.id,
      fileUri: files[nextIndex],
    };

    this.navigateTo(target);
    return target;
  }

  /**
   * Navigate to the previous file in the Change_Set.
   * Returns the previous file target, or null if at the first file.
   */
  previousFile(changeSet: ChangeSet): NavigationTarget | null {
    const files = this.getFileUris(changeSet);
    const currentFileUri = this.getCurrentFileUri();
    const currentIndex = currentFileUri ? files.indexOf(currentFileUri) : files.length;
    const prevIndex = currentIndex - 1;

    if (prevIndex < 0) return null;

    const target: NavigationTarget = {
      kind: 'file',
      id: files[prevIndex],
      changeSetId: changeSet.id,
      fileUri: files[prevIndex],
    };

    this.navigateTo(target);
    return target;
  }

  /**
   * Navigate to the next hunk within the current file or across files.
   * Returns the next hunk target, or null if at the last hunk.
   */
  nextHunk(changeSet: ChangeSet): NavigationTarget | null {
    const allHunks = this.getAllHunksOrdered(changeSet);
    const currentHunkId = this.getCurrentHunkId();
    const currentIndex = currentHunkId
      ? allHunks.findIndex((h) => h.id === currentHunkId)
      : -1;
    const nextIndex = currentIndex + 1;

    if (nextIndex >= allHunks.length) return null;

    const hunk = allHunks[nextIndex];
    const target: NavigationTarget = {
      kind: 'hunk',
      id: hunk.id,
      changeSetId: changeSet.id,
      fileUri: hunk.fileUri,
      hunkId: hunk.id,
    };

    this.navigateTo(target);
    return target;
  }

  /**
   * Navigate to the previous hunk within the current file or across files.
   * Returns the previous hunk target, or null if at the first hunk.
   */
  previousHunk(changeSet: ChangeSet): NavigationTarget | null {
    const allHunks = this.getAllHunksOrdered(changeSet);
    const currentHunkId = this.getCurrentHunkId();
    const currentIndex = currentHunkId
      ? allHunks.findIndex((h) => h.id === currentHunkId)
      : allHunks.length;
    const prevIndex = currentIndex - 1;

    if (prevIndex < 0) return null;

    const hunk = allHunks[prevIndex];
    const target: NavigationTarget = {
      kind: 'hunk',
      id: hunk.id,
      changeSetId: changeSet.id,
      fileUri: hunk.fileUri,
      hunkId: hunk.id,
    };

    this.navigateTo(target);
    return target;
  }

  /**
   * Navigate to a related planning entity (task, requirement, or run).
   */
  navigateToEntity(
    changeSet: ChangeSet,
    entity: RelatedEntity
  ): NavigationTarget {
    const target: NavigationTarget = {
      kind: entity.kind,
      id: entity.id,
      changeSetId: changeSet.id,
      entityId: entity.id,
    };

    this.navigateTo(target);
    return target;
  }

  /**
   * Gets the list of related planning entities for a Change_Set.
   * Derived from the Change_Set's task and run metadata.
   */
  getRelatedEntities(changeSet: ChangeSet): RelatedEntity[] {
    const entities: RelatedEntity[] = [];

    if (changeSet.taskId) {
      entities.push({
        kind: 'task',
        id: changeSet.taskId,
        label: `Task: ${changeSet.taskId}`,
      });
    }

    if (changeSet.runId) {
      entities.push({
        kind: 'run',
        id: changeSet.runId,
        label: `Run: ${changeSet.runId}`,
      });
    }

    return entities;
  }

  /**
   * Navigate to the next pending hunk (skipping reviewed/accepted/rejected).
   */
  nextPendingHunk(changeSet: ChangeSet): NavigationTarget | null {
    const allHunks = this.getAllHunksOrdered(changeSet);
    const currentHunkId = this.getCurrentHunkId();
    const currentIndex = currentHunkId
      ? allHunks.findIndex((h) => h.id === currentHunkId)
      : -1;

    for (let i = currentIndex + 1; i < allHunks.length; i++) {
      const hunk = allHunks[i];
      const state = this.reviewScopeService.getReviewState(
        changeSet.id,
        'hunk',
        hunk.id
      );
      if (state === 'pending') {
        const target: NavigationTarget = {
          kind: 'hunk',
          id: hunk.id,
          changeSetId: changeSet.id,
          fileUri: hunk.fileUri,
          hunkId: hunk.id,
        };
        this.navigateTo(target);
        return target;
      }
    }

    return null;
  }

  /**
   * Navigate to the previous pending hunk.
   */
  previousPendingHunk(changeSet: ChangeSet): NavigationTarget | null {
    const allHunks = this.getAllHunksOrdered(changeSet);
    const currentHunkId = this.getCurrentHunkId();
    const currentIndex = currentHunkId
      ? allHunks.findIndex((h) => h.id === currentHunkId)
      : allHunks.length;

    for (let i = currentIndex - 1; i >= 0; i--) {
      const hunk = allHunks[i];
      const state = this.reviewScopeService.getReviewState(
        changeSet.id,
        'hunk',
        hunk.id
      );
      if (state === 'pending') {
        const target: NavigationTarget = {
          kind: 'hunk',
          id: hunk.id,
          changeSetId: changeSet.id,
          fileUri: hunk.fileUri,
          hunkId: hunk.id,
        };
        this.navigateTo(target);
        return target;
      }
    }

    return null;
  }

  /**
   * Clears all navigation history.
   */
  clear(): void {
    this.history.length = 0;
    this.historyPosition = -1;
  }

  // ─── Private helpers ────────────────────────────────────────────

  private getCurrentFileUri(): string | undefined {
    if (this.historyPosition < 0) return undefined;
    return this.history[this.historyPosition].fileUri;
  }

  private getCurrentHunkId(): string | undefined {
    if (this.historyPosition < 0) return undefined;
    return this.history[this.historyPosition].hunkId;
  }

  private getFileUris(changeSet: ChangeSet): string[] {
    return changeSet.operations.map((op) =>
      op.kind === 'rename' || op.kind === 'move' ? op.targetUri : op.targetUri
    );
  }

  private getAllHunksOrdered(changeSet: ChangeSet): ReviewHunk[] {
    const allHunks: ReviewHunk[] = [];
    const fileScope = this.reviewScopeService.getFileLevelScope(changeSet);

    for (const entry of fileScope) {
      allHunks.push(...entry.hunks);
    }

    return allHunks;
  }
}
