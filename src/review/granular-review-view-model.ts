/**
 * GranularReviewViewModel — Integrates accept/reject at hunk, file, and
 * Change_Set levels with navigation, remembered display modes, accessible
 * scope announcements, and same-render-cycle count updates.
 *
 * This is the primary review UI model consumed by the renderer. It composes
 * ReviewScopeService, ReviewNavigator, and ChangeSummaryService and adds:
 * - Accept/Reject at hunk, file, and whole Change_Set granularity
 * - Remembered inline, side-by-side, or unified display mode per workspace
 * - Previous/Next pending hunk navigation
 * - Accessible scope indication with non-shortcut fallback controls
 * - Same-render-cycle count and pending indicator updates
 * - Enhanced summaries with diagnostics delta, validation, agent, and task attribution
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.9
 */

import { ChangeSet, FileOperation } from '../change-set/types';
import { ShadowModelService } from '../change-set/shadow-model-service';
import {
  ReviewScopeService,
  ReviewHunk,
  ReviewState,
} from './review-scope-service';
import { ReviewNavigator, NavigationTarget } from './review-navigator';
import {
  ChangeSummaryService,
  FileSummary,
  ChangeSetStatistics,
} from './change-summary-service';

// ─── Display Mode ────────────────────────────────────────────────

/**
 * Supported diff display modes for review.
 * The reviewer's preference is remembered per workspace.
 */
export type DiffDisplayMode = 'inline' | 'side-by-side' | 'unified';

// ─── Accessible Scope ────────────────────────────────────────────

/**
 * Keyboard scope level indicating which granularity Accept/Reject targets.
 * When shortcuts are available, this indicates what they affect.
 * When shortcuts are unavailable, non-shortcut controls remain accessible.
 */
export type KeyboardScopeLevel = 'hunk' | 'file' | 'change-set';

/**
 * Represents the current keyboard/accessible scope state.
 * Ensures scope is always visibly announced and non-shortcut controls are present.
 */
export interface AccessibleScopeState {
  /** The current scope level for accept/reject actions. */
  readonly level: KeyboardScopeLevel;
  /** Human-readable scope announcement for screen readers. */
  readonly announcement: string;
  /** Whether keyboard shortcuts are currently available. */
  readonly shortcutsAvailable: boolean;
  /** Non-shortcut controls are always available regardless of shortcut state. */
  readonly nonShortcutControlsAvailable: true;
  /** Description for non-shortcut controls (for accessibility). */
  readonly nonShortcutDescription: string;
}

// ─── Review Counts ───────────────────────────────────────────────

/**
 * Snapshot of review progress counts — updated atomically in one render cycle.
 */
export interface ReviewCounts {
  /** Total hunks in the Change_Set. */
  readonly totalHunks: number;
  /** Hunks accepted. */
  readonly acceptedHunks: number;
  /** Hunks rejected. */
  readonly rejectedHunks: number;
  /** Hunks still pending review. */
  readonly pendingHunks: number;
  /** Total files in the Change_Set. */
  readonly totalFiles: number;
  /** Files fully accepted (all hunks accepted). */
  readonly acceptedFiles: number;
  /** Files fully rejected (all hunks rejected). */
  readonly rejectedFiles: number;
  /** Files with pending hunks. */
  readonly pendingFiles: number;
  /** Whether there are any pending items at any level. */
  readonly hasPending: boolean;
}

// ─── Enhanced File Summary ───────────────────────────────────────

/**
 * Enhanced file summary with diagnostics, validation, agent, and task attribution.
 * Extends the base FileSummary with full attribution per Requirement 8.4.
 */
export interface EnhancedFileSummary extends FileSummary {
  /** Diagnostics count delta: introduced diagnostics minus resolved diagnostics. */
  readonly diagnosticsDelta: number;
  /** Validation result for this file (pass/fail/pending/skipped). */
  readonly validationResult: 'pass' | 'fail' | 'pending' | 'skipped';
  /** Agent that produced this operation (ID). */
  readonly agentAttribution: string | null;
  /** Task that this operation is linked to (ID). */
  readonly taskAttribution: string | null;
  /** Label for zero-content creation (Req 8.4 — zero-delta create/ADD). */
  readonly emptyCreationLabel: string | null;
}

// ─── Review View State ───────────────────────────────────────────

/**
 * Complete review view state snapshot — everything needed to render the review UI
 * in a single atomic update (same render cycle for counts and indicators).
 */
export interface ReviewViewState {
  /** The Change_Set being reviewed. */
  readonly changeSetId: string;
  /** Review progress counts (updated atomically). */
  readonly counts: ReviewCounts;
  /** Enhanced file summaries with full attribution. */
  readonly fileSummaries: readonly EnhancedFileSummary[];
  /** Active display mode. */
  readonly displayMode: DiffDisplayMode;
  /** Current accessible scope state. */
  readonly scope: AccessibleScopeState;
  /** Current navigation target. */
  readonly currentTarget: NavigationTarget | null;
  /** Whether back navigation is available. */
  readonly canGoBack: boolean;
  /** Whether forward navigation is available. */
  readonly canGoForward: boolean;
  /** Whether there is a next pending hunk. */
  readonly hasNextPending: boolean;
  /** Whether there is a previous pending hunk. */
  readonly hasPreviousPending: boolean;
  /** Aggregate Change_Set state (overall accept/reject/pending). */
  readonly changeSetReviewState: 'pending' | 'accepted' | 'rejected' | 'partial';
}

// ─── Accept/Reject Result ────────────────────────────────────────

/**
 * Result from an accept or reject action. Contains the updated view state
 * so the renderer can update counts and indicators in the same render cycle.
 */
export interface ReviewActionResult {
  /** Whether the action was successful. */
  readonly success: boolean;
  /** The updated view state (same render cycle update). */
  readonly viewState: ReviewViewState;
  /** Error message if the action failed. */
  readonly error?: string;
}

// ─── Listener Interface ──────────────────────────────────────────

/**
 * Listener for review state changes.
 * Renderers subscribe to receive atomic state updates.
 */
export type ReviewStateListener = (state: ReviewViewState) => void;

// ─── Service ────────────────────────────────────────────────────

/**
 * GranularReviewViewModel ties together review scope, navigation, summaries,
 * and accessible scope into one coherent view model consumed by the renderer.
 *
 * It ensures that Accept/Reject actions at any granularity trigger an atomic
 * state update including refreshed counts, indicators, and scope announcements,
 * all computed before returning so the renderer can apply them in a single cycle.
 */
export class GranularReviewViewModel {
  private readonly reviewScopeService: ReviewScopeService;
  private readonly reviewNavigator: ReviewNavigator;
  private readonly changeSummaryService: ChangeSummaryService;

  /** Remembered display mode per workspace (workspaceId -> mode). */
  private readonly displayModeByWorkspace = new Map<string, DiffDisplayMode>();

  /** Current scope level for accept/reject actions. */
  private currentScopeLevel: KeyboardScopeLevel = 'hunk';

  /** Whether shortcuts are currently available. */
  private shortcutsAvailable = true;

  /** Active Change_Set for the current review session. */
  private activeChangeSet: ChangeSet | null = null;

  /** Per-file attribution metadata. Key: `${changeSetId}:${fileUri}`. */
  private readonly attributionMap = new Map<string, {
    agentId: string | null;
    taskId: string | null;
    diagnosticsDelta: number;
    validationResult: 'pass' | 'fail' | 'pending' | 'skipped';
  }>();

  /** Registered state listeners. */
  private readonly listeners = new Set<ReviewStateListener>();

  constructor(
    shadowModelService: ShadowModelService,
    reviewScopeService?: ReviewScopeService,
    reviewNavigator?: ReviewNavigator,
    changeSummaryService?: ChangeSummaryService
  ) {
    this.reviewScopeService = reviewScopeService ?? new ReviewScopeService(shadowModelService);
    this.reviewNavigator = reviewNavigator ?? new ReviewNavigator(this.reviewScopeService);
    this.changeSummaryService = changeSummaryService ?? new ChangeSummaryService(shadowModelService);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /**
   * Start reviewing a Change_Set. Sets it as the active review context.
   */
  startReview(changeSet: ChangeSet): ReviewViewState {
    this.activeChangeSet = changeSet;
    this.reviewScopeService.clearStates(changeSet.id);
    this.reviewNavigator.clear();
    return this.computeViewState();
  }

  /**
   * End the current review and clean up state.
   */
  endReview(): void {
    if (this.activeChangeSet) {
      this.reviewScopeService.clearStates(this.activeChangeSet.id);
    }
    this.activeChangeSet = null;
    this.reviewNavigator.clear();
  }

  // ─── Subscription ──────────────────────────────────────────────

  /**
   * Subscribe to receive atomic state updates on any review action.
   * Returns an unsubscribe function.
   */
  subscribe(listener: ReviewStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─── Accept / Reject Actions ───────────────────────────────────

  /**
   * Accept a single hunk. Updates counts in the same computation cycle.
   * Requirement 8.1: Accept action at hunk level.
   * Requirement 8.5: Counts and pending indicators update atomically.
   */
  acceptHunk(hunkId: string): ReviewActionResult {
    if (!this.activeChangeSet) {
      return { success: false, viewState: this.computeEmptyState(), error: 'No active review session' };
    }

    this.reviewScopeService.setReviewState(this.activeChangeSet.id, 'hunk', hunkId, 'accepted');
    const viewState = this.computeViewState();
    this.notifyListeners(viewState);
    return { success: true, viewState };
  }

  /**
   * Reject a single hunk. Updates counts in the same computation cycle.
   * Requirement 8.1: Reject action at hunk level.
   * Requirement 8.5: Counts and pending indicators update atomically.
   */
  rejectHunk(hunkId: string): ReviewActionResult {
    if (!this.activeChangeSet) {
      return { success: false, viewState: this.computeEmptyState(), error: 'No active review session' };
    }

    this.reviewScopeService.setReviewState(this.activeChangeSet.id, 'hunk', hunkId, 'rejected');
    const viewState = this.computeViewState();
    this.notifyListeners(viewState);
    return { success: true, viewState };
  }

  /**
   * Accept all hunks in a file. Updates counts atomically.
   * Requirement 8.1: Accept action at file level.
   */
  acceptFile(fileUri: string): ReviewActionResult {
    if (!this.activeChangeSet) {
      return { success: false, viewState: this.computeEmptyState(), error: 'No active review session' };
    }

    const hunkScope = this.reviewScopeService.getHunkLevelScope(this.activeChangeSet, fileUri);
    for (const entry of hunkScope) {
      this.reviewScopeService.setReviewState(
        this.activeChangeSet.id,
        'hunk',
        entry.hunk.id,
        'accepted'
      );
    }

    this.reviewScopeService.setReviewState(this.activeChangeSet.id, 'file', fileUri, 'accepted');
    const viewState = this.computeViewState();
    this.notifyListeners(viewState);
    return { success: true, viewState };
  }

  /**
   * Reject all hunks in a file. Updates counts atomically.
   * Requirement 8.1: Reject action at file level.
   */
  rejectFile(fileUri: string): ReviewActionResult {
    if (!this.activeChangeSet) {
      return { success: false, viewState: this.computeEmptyState(), error: 'No active review session' };
    }

    const hunkScope = this.reviewScopeService.getHunkLevelScope(this.activeChangeSet, fileUri);
    for (const entry of hunkScope) {
      this.reviewScopeService.setReviewState(
        this.activeChangeSet.id,
        'hunk',
        entry.hunk.id,
        'rejected'
      );
    }

    this.reviewScopeService.setReviewState(this.activeChangeSet.id, 'file', fileUri, 'rejected');
    const viewState = this.computeViewState();
    this.notifyListeners(viewState);
    return { success: true, viewState };
  }

  /**
   * Accept the entire Change_Set (all files, all hunks).
   * Requirement 8.1: Accept action at Change_Set level.
   */
  acceptChangeSet(): ReviewActionResult {
    if (!this.activeChangeSet) {
      return { success: false, viewState: this.computeEmptyState(), error: 'No active review session' };
    }

    const fileScope = this.reviewScopeService.getFileLevelScope(this.activeChangeSet);
    for (const fileEntry of fileScope) {
      const hunkScope = this.reviewScopeService.getHunkLevelScope(
        this.activeChangeSet,
        fileEntry.fileUri
      );
      for (const hEntry of hunkScope) {
        this.reviewScopeService.setReviewState(
          this.activeChangeSet.id,
          'hunk',
          hEntry.hunk.id,
          'accepted'
        );
      }
      this.reviewScopeService.setReviewState(
        this.activeChangeSet.id,
        'file',
        fileEntry.fileUri,
        'accepted'
      );
    }

    const viewState = this.computeViewState();
    this.notifyListeners(viewState);
    return { success: true, viewState };
  }

  /**
   * Reject the entire Change_Set (all files, all hunks).
   * Requirement 8.1: Reject action at Change_Set level.
   */
  rejectChangeSet(): ReviewActionResult {
    if (!this.activeChangeSet) {
      return { success: false, viewState: this.computeEmptyState(), error: 'No active review session' };
    }

    const fileScope = this.reviewScopeService.getFileLevelScope(this.activeChangeSet);
    for (const fileEntry of fileScope) {
      const hunkScope = this.reviewScopeService.getHunkLevelScope(
        this.activeChangeSet,
        fileEntry.fileUri
      );
      for (const hEntry of hunkScope) {
        this.reviewScopeService.setReviewState(
          this.activeChangeSet.id,
          'hunk',
          hEntry.hunk.id,
          'rejected'
        );
      }
      this.reviewScopeService.setReviewState(
        this.activeChangeSet.id,
        'file',
        fileEntry.fileUri,
        'rejected'
      );
    }

    const viewState = this.computeViewState();
    this.notifyListeners(viewState);
    return { success: true, viewState };
  }

  // ─── Navigation ────────────────────────────────────────────────

  /**
   * Navigate to the next pending hunk.
   * Requirement 8.2: Navigate Previous/Next pending without manual scrolling.
   */
  navigateNextPending(): NavigationTarget | null {
    if (!this.activeChangeSet) return null;
    return this.reviewNavigator.nextPendingHunk(this.activeChangeSet);
  }

  /**
   * Navigate to the previous pending hunk.
   * Requirement 8.2: Navigate Previous/Next pending without manual scrolling.
   */
  navigatePreviousPending(): NavigationTarget | null {
    if (!this.activeChangeSet) return null;
    return this.reviewNavigator.previousPendingHunk(this.activeChangeSet);
  }

  /**
   * Navigate back in review history.
   */
  navigateBack(): NavigationTarget | null {
    return this.reviewNavigator.goBack();
  }

  /**
   * Navigate forward in review history.
   */
  navigateForward(): NavigationTarget | null {
    return this.reviewNavigator.goForward();
  }

  // ─── Display Mode ──────────────────────────────────────────────

  /**
   * Get the current display mode for a workspace.
   * Requirement 8.3: Remember the preferred review display mode.
   */
  getDisplayMode(workspaceId: string): DiffDisplayMode {
    return this.displayModeByWorkspace.get(workspaceId) ?? 'unified';
  }

  /**
   * Set and remember the display mode for a workspace.
   * Requirement 8.3: Inline, side-by-side, or unified with remembered preference.
   */
  setDisplayMode(workspaceId: string, mode: DiffDisplayMode): ReviewViewState {
    this.displayModeByWorkspace.set(workspaceId, mode);
    const viewState = this.computeViewState();
    this.notifyListeners(viewState);
    return viewState;
  }

  // ─── Accessible Scope ──────────────────────────────────────────

  /**
   * Set the current keyboard scope level for accept/reject actions.
   * Requirement 8.9: Clearly visible active-scope indication.
   */
  setScopeLevel(level: KeyboardScopeLevel): AccessibleScopeState {
    this.currentScopeLevel = level;
    return this.computeScopeState();
  }

  /**
   * Mark whether keyboard shortcuts are currently available.
   * Requirement 8.9: When shortcuts unavailable, UI indicates so
   * and retains accessible non-shortcut controls.
   */
  setShortcutsAvailable(available: boolean): AccessibleScopeState {
    this.shortcutsAvailable = available;
    return this.computeScopeState();
  }

  /**
   * Get the current accessible scope state.
   */
  getScopeState(): AccessibleScopeState {
    return this.computeScopeState();
  }

  // ─── Attribution ───────────────────────────────────────────────

  /**
   * Set attribution metadata for a file operation in the active review.
   * Used to populate enhanced summaries with agent, task, diagnostics, and validation.
   * Requirement 8.4: Summaries include agent and task attribution.
   */
  setFileAttribution(
    changeSetId: string,
    fileUri: string,
    attribution: {
      agentId?: string | null;
      taskId?: string | null;
      diagnosticsDelta?: number;
      validationResult?: 'pass' | 'fail' | 'pending' | 'skipped';
    }
  ): void {
    const key = `${changeSetId}:${fileUri}`;
    const existing = this.attributionMap.get(key);
    this.attributionMap.set(key, {
      agentId: attribution.agentId ?? existing?.agentId ?? null,
      taskId: attribution.taskId ?? existing?.taskId ?? null,
      diagnosticsDelta: attribution.diagnosticsDelta ?? existing?.diagnosticsDelta ?? 0,
      validationResult: attribution.validationResult ?? existing?.validationResult ?? 'pending',
    });
  }

  // ─── View State ────────────────────────────────────────────────

  /**
   * Get the current complete review view state.
   * All counts, indicators, and scope are computed atomically so the renderer
   * can apply them in a single render cycle (Requirement 8.5).
   */
  getViewState(): ReviewViewState {
    return this.computeViewState();
  }

  // ─── Private Computation ───────────────────────────────────────

  private computeViewState(): ReviewViewState {
    if (!this.activeChangeSet) return this.computeEmptyState();

    const changeSet = this.activeChangeSet;
    const counts = this.computeCounts(changeSet);
    const fileSummaries = this.computeEnhancedSummaries(changeSet);
    const navState = this.reviewNavigator.getState();
    const scope = this.computeScopeState();
    const displayMode = this.displayModeByWorkspace.get(changeSet.workspaceId) ?? 'unified';

    // Determine overall Change_Set review state
    let changeSetReviewState: 'pending' | 'accepted' | 'rejected' | 'partial';
    if (counts.pendingHunks === counts.totalHunks) {
      changeSetReviewState = 'pending';
    } else if (counts.acceptedHunks === counts.totalHunks) {
      changeSetReviewState = 'accepted';
    } else if (counts.rejectedHunks === counts.totalHunks) {
      changeSetReviewState = 'rejected';
    } else {
      changeSetReviewState = 'partial';
    }

    // Determine pending navigation availability
    const hasNextPending = this.hasNextPendingHunk(changeSet);
    const hasPreviousPending = this.hasPreviousPendingHunk(changeSet);

    return {
      changeSetId: changeSet.id,
      counts,
      fileSummaries,
      displayMode,
      scope,
      currentTarget: navState.current,
      canGoBack: navState.canGoBack,
      canGoForward: navState.canGoForward,
      hasNextPending,
      hasPreviousPending,
      changeSetReviewState,
    };
  }

  private computeEmptyState(): ReviewViewState {
    return {
      changeSetId: '',
      counts: {
        totalHunks: 0,
        acceptedHunks: 0,
        rejectedHunks: 0,
        pendingHunks: 0,
        totalFiles: 0,
        acceptedFiles: 0,
        rejectedFiles: 0,
        pendingFiles: 0,
        hasPending: false,
      },
      fileSummaries: [],
      displayMode: 'unified',
      scope: this.computeScopeState(),
      currentTarget: null,
      canGoBack: false,
      canGoForward: false,
      hasNextPending: false,
      hasPreviousPending: false,
      changeSetReviewState: 'pending',
    };
  }

  private computeCounts(changeSet: ChangeSet): ReviewCounts {
    const fileScope = this.reviewScopeService.getFileLevelScope(changeSet);

    let totalHunks = 0;
    let acceptedHunks = 0;
    let rejectedHunks = 0;
    let pendingHunks = 0;
    let acceptedFiles = 0;
    let rejectedFiles = 0;
    let pendingFiles = 0;

    for (const fileEntry of fileScope) {
      const hunkScope = this.reviewScopeService.getHunkLevelScope(changeSet, fileEntry.fileUri);
      let fileAllAccepted = hunkScope.length > 0;
      let fileAllRejected = hunkScope.length > 0;
      let fileHasPending = false;

      for (const hEntry of hunkScope) {
        totalHunks++;
        const state = hEntry.state;
        if (state === 'accepted') {
          acceptedHunks++;
          fileAllRejected = false;
        } else if (state === 'rejected') {
          rejectedHunks++;
          fileAllAccepted = false;
        } else {
          pendingHunks++;
          fileAllAccepted = false;
          fileAllRejected = false;
          fileHasPending = true;
        }
      }

      if (fileAllAccepted && hunkScope.length > 0) {
        acceptedFiles++;
      } else if (fileAllRejected && hunkScope.length > 0) {
        rejectedFiles++;
      } else if (fileHasPending || hunkScope.length === 0) {
        pendingFiles++;
      }
    }

    return {
      totalHunks,
      acceptedHunks,
      rejectedHunks,
      pendingHunks,
      totalFiles: fileScope.length,
      acceptedFiles,
      rejectedFiles,
      pendingFiles,
      hasPending: pendingHunks > 0,
    };
  }

  private computeEnhancedSummaries(changeSet: ChangeSet): EnhancedFileSummary[] {
    const baseSummary = this.changeSummaryService.generateSummary(changeSet);

    return baseSummary.files.map((fileSummary) => {
      const key = `${changeSet.id}:${fileSummary.fileUri}`;
      const attribution = this.attributionMap.get(key);

      // Determine empty creation label (Req 8.4)
      // A create/ADD operation with zero meaningful content should be labeled
      // as an empty creation regardless of whether additions is 0 or 1
      // (an empty string split by newline produces one empty-string element).
      let emptyCreationLabel: string | null = null;
      if (fileSummary.isEmptyCreation) {
        emptyCreationLabel = 'Empty file creation';
      } else if (
        fileSummary.operationKind === 'create' &&
        fileSummary.removals === 0
      ) {
        // Check if the create has zero actual content by inspecting the operation
        const createOp = changeSet.operations.find(
          (op) => op.kind === 'create' && op.targetUri === fileSummary.fileUri
        );
        if (createOp && createOp.kind === 'create' && createOp.proposedBlob === '') {
          emptyCreationLabel = 'Zero-content creation';
        }
      }

      return {
        ...fileSummary,
        diagnosticsDelta: attribution?.diagnosticsDelta ?? 0,
        validationResult: attribution?.validationResult ?? 'pending',
        agentAttribution: attribution?.agentId ?? changeSet.runId ?? null,
        taskAttribution: attribution?.taskId ?? changeSet.taskId ?? null,
        emptyCreationLabel,
      };
    });
  }

  private computeScopeState(): AccessibleScopeState {
    const levelLabels: Record<KeyboardScopeLevel, string> = {
      hunk: 'Hunk',
      file: 'File',
      'change-set': 'Change Set',
    };

    const announcement = this.shortcutsAvailable
      ? `Review scope: ${levelLabels[this.currentScopeLevel]}. Keyboard shortcuts active.`
      : `Review scope: ${levelLabels[this.currentScopeLevel]}. Shortcuts unavailable. Use Accept and Reject buttons.`;

    const nonShortcutDescription = `Accept and Reject buttons for ${levelLabels[this.currentScopeLevel]} scope`;

    return {
      level: this.currentScopeLevel,
      announcement,
      shortcutsAvailable: this.shortcutsAvailable,
      nonShortcutControlsAvailable: true,
      nonShortcutDescription,
    };
  }

  private hasNextPendingHunk(changeSet: ChangeSet): boolean {
    const fileScope = this.reviewScopeService.getFileLevelScope(changeSet);
    const navState = this.reviewNavigator.getState();
    const currentHunkId = navState.current?.hunkId;
    let pastCurrent = !currentHunkId;

    for (const fileEntry of fileScope) {
      const hunkScope = this.reviewScopeService.getHunkLevelScope(changeSet, fileEntry.fileUri);
      for (const hEntry of hunkScope) {
        if (hEntry.hunk.id === currentHunkId) {
          pastCurrent = true;
          continue;
        }
        if (pastCurrent && hEntry.state === 'pending') {
          return true;
        }
      }
    }
    return false;
  }

  private hasPreviousPendingHunk(changeSet: ChangeSet): boolean {
    const fileScope = this.reviewScopeService.getFileLevelScope(changeSet);
    const navState = this.reviewNavigator.getState();
    const currentHunkId = navState.current?.hunkId;
    let beforeCurrent = true;

    for (const fileEntry of fileScope) {
      const hunkScope = this.reviewScopeService.getHunkLevelScope(changeSet, fileEntry.fileUri);
      for (const hEntry of hunkScope) {
        if (hEntry.hunk.id === currentHunkId) {
          return hunkScope.slice(0, hunkScope.indexOf(hEntry)).some((h) => h.state === 'pending');
        }
      }
    }

    // If no current target, check if any pending hunks exist before the end
    for (const fileEntry of fileScope) {
      const hunkScope = this.reviewScopeService.getHunkLevelScope(changeSet, fileEntry.fileUri);
      if (hunkScope.some((h) => h.state === 'pending')) return true;
    }

    return false;
  }

  private notifyListeners(state: ReviewViewState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
