/**
 * KeyboardReviewScope — Keyboard-operable review navigation for Change_Sets.
 *
 * Allows keyboard-only users to navigate among files and hunks in the
 * review queue, accept/reject with announced scope, and receive clear
 * focus boundary indicators.
 *
 * Requirements: 23.5
 */

/** State of the keyboard review navigation */
export interface ReviewScopeState {
  /** List of file URIs in the review scope */
  readonly fileUris: readonly string[];
  /** Currently focused file index */
  readonly activeFileIndex: number;
  /** Hunks for the currently focused file */
  readonly hunkCount: number;
  /** Currently focused hunk index within the active file */
  readonly activeHunkIndex: number;
  /** The scope of the current selection for announcements */
  readonly activeScope: 'change_set' | 'file' | 'hunk';
  /** Whether an accept/reject action is pending confirmation */
  readonly pendingAction: 'accept' | 'reject' | null;
}

/**
 * KeyboardReviewScope manages keyboard navigation within the Review_Queue.
 *
 * Navigation model:
 * - ArrowUp/ArrowDown: Navigate between files
 * - ArrowLeft/ArrowRight: Navigate between hunks within a file
 * - Enter/Space: Accept current scope
 * - Delete/Backspace: Reject current scope
 * - Tab: Cycle scope level (change_set → file → hunk)
 * - Escape: Clear pending action or collapse scope
 *
 * Every navigation and action generates an announcement describing
 * what the user is focused on and what scope acceptance/rejection applies to.
 */
export class KeyboardReviewScope {
  private state: ReviewScopeState = {
    fileUris: [],
    activeFileIndex: -1,
    hunkCount: 0,
    activeHunkIndex: -1,
    activeScope: 'file',
    pendingAction: null,
  };

  /**
   * Set the files available for review.
   */
  setFiles(fileUris: string[], hunkCounts: number[]): void {
    this.state = {
      ...this.state,
      fileUris,
      activeFileIndex: fileUris.length > 0 ? 0 : -1,
      hunkCount: hunkCounts[0] ?? 0,
      activeHunkIndex: hunkCounts[0] && hunkCounts[0] > 0 ? 0 : -1,
      pendingAction: null,
    };
    this.hunkCounts = hunkCounts;
  }

  private hunkCounts: number[] = [];

  /**
   * Get the current review scope state.
   */
  getState(): Readonly<ReviewScopeState> {
    return { ...this.state };
  }

  /**
   * Move focus to the next file.
   */
  nextFile(): string {
    if (this.state.fileUris.length === 0) return 'No files to review.';

    const nextIndex = this.state.activeFileIndex >= this.state.fileUris.length - 1
      ? 0
      : this.state.activeFileIndex + 1;

    this.state = {
      ...this.state,
      activeFileIndex: nextIndex,
      hunkCount: this.hunkCounts[nextIndex] ?? 0,
      activeHunkIndex: 0,
      pendingAction: null,
    };

    return this.getFileAnnouncement();
  }

  /**
   * Move focus to the previous file.
   */
  previousFile(): string {
    if (this.state.fileUris.length === 0) return 'No files to review.';

    const prevIndex = this.state.activeFileIndex <= 0
      ? this.state.fileUris.length - 1
      : this.state.activeFileIndex - 1;

    this.state = {
      ...this.state,
      activeFileIndex: prevIndex,
      hunkCount: this.hunkCounts[prevIndex] ?? 0,
      activeHunkIndex: 0,
      pendingAction: null,
    };

    return this.getFileAnnouncement();
  }

  /**
   * Move focus to the next hunk within the current file.
   */
  nextHunk(): string {
    if (this.state.hunkCount === 0) return 'No hunks in this file.';

    const nextIndex = this.state.activeHunkIndex >= this.state.hunkCount - 1
      ? 0
      : this.state.activeHunkIndex + 1;

    this.state = {
      ...this.state,
      activeHunkIndex: nextIndex,
      activeScope: 'hunk',
      pendingAction: null,
    };

    return this.getHunkAnnouncement();
  }

  /**
   * Move focus to the previous hunk within the current file.
   */
  previousHunk(): string {
    if (this.state.hunkCount === 0) return 'No hunks in this file.';

    const prevIndex = this.state.activeHunkIndex <= 0
      ? this.state.hunkCount - 1
      : this.state.activeHunkIndex - 1;

    this.state = {
      ...this.state,
      activeHunkIndex: prevIndex,
      activeScope: 'hunk',
      pendingAction: null,
    };

    return this.getHunkAnnouncement();
  }

  /**
   * Cycle the active scope level: change_set → file → hunk → change_set
   */
  cycleScope(): string {
    const scopes: Array<'change_set' | 'file' | 'hunk'> = ['change_set', 'file', 'hunk'];
    const currentIdx = scopes.indexOf(this.state.activeScope);
    const nextScope = scopes[(currentIdx + 1) % scopes.length]!;

    this.state = {
      ...this.state,
      activeScope: nextScope,
      pendingAction: null,
    };

    return this.getScopeAnnouncement();
  }

  /**
   * Initiate an accept action at the current scope level.
   * Returns a confirmation message describing what will be accepted.
   */
  initiateAccept(): string {
    this.state = { ...this.state, pendingAction: 'accept' };
    return this.getActionConfirmation('accept');
  }

  /**
   * Initiate a reject action at the current scope level.
   * Returns a confirmation message describing what will be rejected.
   */
  initiateReject(): string {
    this.state = { ...this.state, pendingAction: 'reject' };
    return this.getActionConfirmation('reject');
  }

  /**
   * Confirm the pending action.
   */
  confirmAction(): string {
    if (!this.state.pendingAction) return 'No pending action.';

    const action = this.state.pendingAction;
    const scope = this.state.activeScope;
    this.state = { ...this.state, pendingAction: null };

    return `${action === 'accept' ? 'Accepted' : 'Rejected'} at ${scope} scope.`;
  }

  /**
   * Cancel the pending action.
   */
  cancelAction(): string {
    if (!this.state.pendingAction) return '';
    this.state = { ...this.state, pendingAction: null };
    return 'Action cancelled.';
  }

  // ─── Announcement generators ─────────────────────────────────

  getFileAnnouncement(): string {
    if (this.state.activeFileIndex < 0) return 'No file selected.';
    const uri = this.state.fileUris[this.state.activeFileIndex]!;
    const fileName = uri.split('/').pop() ?? uri;
    return `File ${this.state.activeFileIndex + 1} of ${this.state.fileUris.length}: ${fileName}. ${this.state.hunkCount} hunk${this.state.hunkCount !== 1 ? 's' : ''}.`;
  }

  getHunkAnnouncement(): string {
    if (this.state.activeHunkIndex < 0) return 'No hunk selected.';
    return `Hunk ${this.state.activeHunkIndex + 1} of ${this.state.hunkCount}.`;
  }

  getScopeAnnouncement(): string {
    return `Review scope: ${this.state.activeScope.replace('_', ' ')}. Actions will apply to the entire ${this.state.activeScope.replace('_', ' ')}.`;
  }

  private getActionConfirmation(action: 'accept' | 'reject'): string {
    const scopeLabel = this.state.activeScope.replace('_', ' ');
    let target = scopeLabel;

    if (this.state.activeScope === 'file' && this.state.activeFileIndex >= 0) {
      const uri = this.state.fileUris[this.state.activeFileIndex]!;
      target = uri.split('/').pop() ?? uri;
    } else if (this.state.activeScope === 'hunk') {
      target = `hunk ${this.state.activeHunkIndex + 1}`;
    }

    return `${action === 'accept' ? 'Accept' : 'Reject'} ${target}? Press Enter to confirm, Escape to cancel.`;
  }
}
