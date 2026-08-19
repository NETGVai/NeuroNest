/**
 * Detail Inspector Coordinator
 *
 * One correlated inspector per application instance. Manages:
 * - Typed selection for tool/source/diff/data/trajectory/insight/attachment/provenance
 * - Adaptive layout: resizable pane when minimum main width remains, focus-contained
 *   sheet/dialog otherwise
 * - In-place entity updates while inspector is open
 * - Entity removal → unavailable state
 * - Session change → close with cleanup
 * - Invoker focus restoration on close (invoker → nearest workflow control → composer)
 * - Ephemeral per-session width/open-state persistence (never domain state)
 * - No duplicate approval controls (those live in the composer)
 *
 * Requirements: 7.4–7.7, 8.5, 12.4–12.6, 16.1–16.8, 18.7
 */

import type {
  InspectorSelection,
  InspectorKind,
  InspectorEntity,
  InspectorEntityStatus,
  InspectorLayoutMode,
  InspectorCloseReason,
  FocusRestorationTarget,
  DetailInspectorState,
  DetailInspectorView,
  InspectorAccessibilityData,
  InspectorEphemeralPreferences,
  DetailInspectorConfig,
} from './types';
import {
  InspectorSelectionSchema,
  INSPECTOR_KIND_LABELS,
  DEFAULT_INSPECTOR_CONFIG,
} from './types';

// ─── Viewport Provider ──────────────────────────────────────────

/**
 * Port for querying the current viewport width.
 * The coordinator uses this to decide between pane and sheet mode.
 */
export interface ViewportWidthProvider {
  /** Current available width in DIP for the chat area (excluding chrome). */
  getAvailableWidthDip(): number;
}

// ─── Focus Restoration Port ─────────────────────────────────────

/**
 * Port for restoring focus after the inspector closes.
 */
export interface FocusRestorationPort {
  /** Attempt to restore focus to a specific control ID. Returns true if successful. */
  focusControl(controlId: string): boolean;

  /** Focus the nearest surviving workflow control. Returns true if successful. */
  focusNearestWorkflowControl(stableKey: string): boolean;

  /** Focus the primary composer. Always succeeds. */
  focusComposer(): void;
}

// ─── Coordinator ────────────────────────────────────────────────

export class DetailInspectorCoordinator {
  private state: DetailInspectorState;
  private readonly config: DetailInspectorConfig;
  private readonly viewportProvider: ViewportWidthProvider;
  private readonly focusPort: FocusRestorationPort;

  /**
   * Ephemeral per-session preferences. Not persisted to any durable store.
   * Key is sessionId.
   */
  private readonly sessionPreferences: Map<string, InspectorEphemeralPreferences> = new Map();

  constructor(
    viewportProvider: ViewportWidthProvider,
    focusPort: FocusRestorationPort,
    config: Partial<DetailInspectorConfig> = {},
  ) {
    this.config = { ...DEFAULT_INSPECTOR_CONFIG, ...config };
    this.viewportProvider = viewportProvider;
    this.focusPort = focusPort;
    this.state = this.createClosedState('');
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Open the inspector with the given selection.
   * Validates the selection, determines layout mode, and stores focus target.
   *
   * Requirements: 16.1, 16.3, 16.4
   */
  open(selection: InspectorSelection, sessionId: string): void {
    // Validate selection schema
    const parseResult = InspectorSelectionSchema.safeParse(selection);
    if (!parseResult.success) {
      return; // Invalid selection — no-op
    }

    const validSelection = parseResult.data;

    // If already open with the same identity, update rather than re-open
    if (
      this.state.open &&
      this.state.selection?.identity === validSelection.identity &&
      this.state.selection?.kind === validSelection.kind
    ) {
      // Update source revision if it changed
      if (this.state.selection.sourceRevision !== validSelection.sourceRevision) {
        this.state = {
          ...this.state,
          selection: validSelection,
          currentSourceRevision: validSelection.sourceRevision,
        };
      }
      return;
    }

    // Determine layout mode based on available viewport width
    const layoutMode = this.computeLayoutMode();

    // Store focus target for restoration on close
    const focusTarget: FocusRestorationTarget = {
      controlId: validSelection.invokingControlId,
      fallback: 'nearest_workflow_control',
    };

    this.state = {
      open: true,
      selection: validSelection,
      layoutMode,
      entityStatus: 'loading',
      title: INSPECTOR_KIND_LABELS[validSelection.kind],
      currentSourceRevision: validSelection.sourceRevision,
      focusTarget,
      loading: true,
      sessionId,
    };

    // Persist open state in ephemeral preferences
    this.setSessionPreference(sessionId, { lastOpenSelection: validSelection });
  }

  /**
   * Update the entity data when it changes while the inspector is open.
   * Preserves the user's selected identity — only content/status updates.
   *
   * Requirements: 16.5
   */
  update(entity: InspectorEntity): void {
    if (!this.state.open || !this.state.selection) {
      return;
    }

    // Only accept updates for the currently selected entity
    if (
      entity.identity !== this.state.selection.identity ||
      entity.kind !== this.state.selection.kind
    ) {
      return;
    }

    // Handle entity removal
    if (entity.removed || entity.status === 'removed') {
      this.state = {
        ...this.state,
        entityStatus: 'unavailable',
        title: `${INSPECTOR_KIND_LABELS[entity.kind]} (Unavailable)`,
        loading: false,
        currentSourceRevision: entity.sourceRevision,
      };
      return;
    }

    // Normal in-place update
    this.state = {
      ...this.state,
      entityStatus: entity.status,
      title: entity.title || INSPECTOR_KIND_LABELS[entity.kind],
      loading: entity.status === 'loading',
      currentSourceRevision: entity.sourceRevision,
    };
  }

  /**
   * Close the inspector and restore focus.
   *
   * Requirements: 16.6, 16.7
   */
  close(reason: InspectorCloseReason): void {
    if (!this.state.open) {
      return;
    }

    const focusTarget = this.state.focusTarget;
    const invokingStableKey = this.state.selection?.invokingStableKey ?? '';
    const sessionId = this.state.sessionId;

    // Clear open state in ephemeral preferences on user close
    if (reason === 'user') {
      this.setSessionPreference(sessionId, { lastOpenSelection: null });
    }

    // Reset state
    this.state = this.createClosedState(sessionId);

    // Restore focus based on close reason
    this.restoreFocus(focusTarget, invokingStableKey, reason);
  }

  /**
   * Handle session change. Closes the inspector if the session differs.
   *
   * Requirement: 16.7 (ephemeral per-session state)
   */
  handleSessionChange(newSessionId: string): void {
    if (this.state.open && this.state.sessionId !== newSessionId) {
      this.close('session_change');
    }

    // Check if the new session had an open inspector (ephemeral restore)
    this.state = { ...this.state, sessionId: newSessionId };
  }

  /**
   * Resize the inspector pane (only in pane mode).
   * Persists width as ephemeral preference.
   *
   * Requirement: 16.7
   */
  resize(widthDip: number): void {
    if (!this.state.open || this.state.layoutMode !== 'pane') {
      return;
    }

    // Clamp to bounds
    const clampedWidth = Math.max(
      this.config.minimumWidthDip,
      Math.min(widthDip, this.config.inspectorMaxWidthDip),
    );

    // Persist in ephemeral preferences
    this.setSessionPreference(this.state.sessionId, { preferredWidthDip: clampedWidth });
  }

  /**
   * Recompute layout mode (e.g., after viewport resize).
   * May switch between pane and sheet mode.
   *
   * Requirement: 16.3
   */
  recomputeLayout(): void {
    if (!this.state.open) {
      return;
    }

    const newMode = this.computeLayoutMode();
    if (newMode !== this.state.layoutMode) {
      this.state = { ...this.state, layoutMode: newMode };
    }
  }

  // ─── State Accessors ────────────────────────────────────────

  getState(): Readonly<DetailInspectorState> {
    return this.state;
  }

  isOpen(): boolean {
    return this.state.open;
  }

  getSelection(): Readonly<InspectorSelection> | null {
    return this.state.selection;
  }

  getLayoutMode(): InspectorLayoutMode {
    return this.state.layoutMode;
  }

  getConfig(): Readonly<DetailInspectorConfig> {
    return this.config;
  }

  /**
   * Get the ephemeral preferences for a session.
   */
  getSessionPreferences(sessionId: string): Readonly<InspectorEphemeralPreferences> {
    return this.sessionPreferences.get(sessionId) ?? {
      preferredWidthDip: this.config.defaultWidthDip,
      lastOpenSelection: null,
    };
  }

  /**
   * Get the presentation view for rendering.
   *
   * Requirements: 16.2, 16.4, 16.8
   */
  getView(): DetailInspectorView {
    if (!this.state.open || !this.state.selection) {
      return this.createClosedView();
    }

    const prefs = this.getSessionPreferences(this.state.sessionId);
    const widthDip = this.state.layoutMode === 'pane' ? prefs.preferredWidthDip : 0;

    return {
      visible: true,
      layoutMode: this.state.layoutMode,
      kindLabel: INSPECTOR_KIND_LABELS[this.state.selection.kind],
      title: this.state.title,
      identity: this.state.selection.identity,
      entityStatus: this.state.entityStatus,
      sourceRevision: this.state.currentSourceRevision,
      closable: true,
      resizable: this.state.layoutMode === 'pane',
      widthDip,
      accessibility: this.buildAccessibility(),
    };
  }

  // ─── Private Methods ────────────────────────────────────────

  /**
   * Determine layout mode from current viewport and config.
   * Pane mode is used only when the remaining main column width
   * meets or exceeds the configured minimum.
   *
   * Requirement: 16.3
   */
  private computeLayoutMode(): InspectorLayoutMode {
    const availableWidth = this.viewportProvider.getAvailableWidthDip();
    const prefs = this.getSessionPreferences(this.state.sessionId);
    const inspectorWidth = prefs.preferredWidthDip;

    const remainingMainWidth = availableWidth - inspectorWidth;

    if (remainingMainWidth >= this.config.minimumMainColumnWidthDip) {
      return 'pane';
    }
    return 'sheet';
  }

  /**
   * Restore focus after inspector closes.
   * Priority: invoking control → nearest workflow control → composer.
   *
   * Requirement: 16.6
   */
  private restoreFocus(
    target: FocusRestorationTarget | null,
    invokingStableKey: string,
    reason: InspectorCloseReason,
  ): void {
    if (!target) {
      this.focusPort.focusComposer();
      return;
    }

    // Try the invoking control first
    if (this.focusPort.focusControl(target.controlId)) {
      return;
    }

    // Try nearest workflow control using the stable key
    if (
      target.fallback === 'nearest_workflow_control' &&
      this.focusPort.focusNearestWorkflowControl(invokingStableKey)
    ) {
      return;
    }

    // Final fallback: composer
    this.focusPort.focusComposer();
  }

  /**
   * Build accessibility data for the current state.
   *
   * Requirement: 16.2 (200% text, no overlap)
   */
  private buildAccessibility(): InspectorAccessibilityData {
    const selection = this.state.selection;
    const isSheet = this.state.layoutMode === 'sheet';

    const kindLabel = selection ? INSPECTOR_KIND_LABELS[selection.kind] : 'Detail';
    const statusText = this.state.entityStatus === 'unavailable'
      ? ' (unavailable)'
      : this.state.entityStatus === 'loading'
        ? ' (loading)'
        : '';

    return {
      ariaLabel: `${kindLabel}${statusText}`,
      role: isSheet ? 'dialog' : 'complementary',
      modal: isSheet,
      ariaDescription: selection
        ? `Inspecting ${selection.kind}: ${this.state.title}`
        : 'Detail inspector closed',
    };
  }

  private createClosedState(sessionId: string): DetailInspectorState {
    return {
      open: false,
      selection: null,
      layoutMode: 'pane',
      entityStatus: 'loading',
      title: '',
      currentSourceRevision: 0,
      focusTarget: null,
      loading: false,
      sessionId,
    };
  }

  private createClosedView(): DetailInspectorView {
    return {
      visible: false,
      layoutMode: 'pane',
      kindLabel: '',
      title: '',
      identity: '',
      entityStatus: 'loading',
      sourceRevision: 0,
      closable: false,
      resizable: false,
      widthDip: 0,
      accessibility: {
        ariaLabel: 'Detail inspector',
        role: 'complementary',
        modal: false,
        ariaDescription: 'Detail inspector closed',
      },
    };
  }

  /**
   * Update ephemeral session preferences (merge).
   */
  private setSessionPreference(
    sessionId: string,
    updates: Partial<InspectorEphemeralPreferences>,
  ): void {
    const existing = this.sessionPreferences.get(sessionId) ?? {
      preferredWidthDip: this.config.defaultWidthDip,
      lastOpenSelection: null,
    };
    this.sessionPreferences.set(sessionId, { ...existing, ...updates });
  }
}
