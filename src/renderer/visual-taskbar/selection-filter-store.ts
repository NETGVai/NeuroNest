/**
 * SelectionAndFilterStore — Persists selection and filter state
 * per workspace/session for the Visual_Taskbar.
 *
 * Supports:
 * - Current selection persistence per workspace/session
 * - Active filter combinations (status, priority, requirement, component, etc.)
 * - View mode persistence
 *
 * Requirements: 10.1, 10.2, 10.6, 10.7, 10.12
 */

import type {
  TaskbarFilter,
  TaskbarSelection,
  TaskbarSessionState,
  ViewMode,
  TaskbarEntityStatus,
  TaskbarPriority,
  TaskbarEntityKind,
  TaskbarRiskLevel,
} from './types.js';

/** Listener for session state changes */
export type SessionStateListener = (state: TaskbarSessionState) => void;

/**
 * SelectionAndFilterStore manages the per-workspace/session selection,
 * filter, and view mode state for the Visual_Taskbar.
 */
export class SelectionAndFilterStore {
  private sessions: Map<string, TaskbarSessionState> = new Map();
  private listeners: Set<SessionStateListener> = new Set();

  /**
   * Compute a stable key for workspace + session combination.
   */
  private getKey(workspaceId: string, sessionId: string): string {
    return `${workspaceId}::${sessionId}`;
  }

  /**
   * Get or create the session state for a workspace/session pair.
   */
  getSessionState(workspaceId: string, sessionId: string): TaskbarSessionState {
    const key = this.getKey(workspaceId, sessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const initial: TaskbarSessionState = {
      workspaceId,
      sessionId,
      viewMode: 'compact',
      filter: {},
      selection: {
        selectedEntityId: null,
        expandedEntityIds: [],
      },
    };
    this.sessions.set(key, initial);
    return initial;
  }

  /**
   * Set the view mode for a workspace/session.
   */
  setViewMode(workspaceId: string, sessionId: string, viewMode: ViewMode): void {
    const state = this.getSessionState(workspaceId, sessionId);
    state.viewMode = viewMode;
    this.persist(workspaceId, sessionId, state);
  }

  /**
   * Set the selected entity for a workspace/session.
   */
  setSelectedEntity(workspaceId: string, sessionId: string, entityId: string | null): void {
    const state = this.getSessionState(workspaceId, sessionId);
    state.selection.selectedEntityId = entityId;
    this.persist(workspaceId, sessionId, state);
  }

  /**
   * Toggle expansion of an entity in the selection state.
   */
  toggleExpanded(workspaceId: string, sessionId: string, entityId: string): void {
    const state = this.getSessionState(workspaceId, sessionId);
    const index = state.selection.expandedEntityIds.indexOf(entityId);
    if (index >= 0) {
      state.selection.expandedEntityIds.splice(index, 1);
    } else {
      state.selection.expandedEntityIds.push(entityId);
    }
    this.persist(workspaceId, sessionId, state);
  }

  /**
   * Set a complete filter for a workspace/session.
   */
  setFilter(workspaceId: string, sessionId: string, filter: TaskbarFilter): void {
    const state = this.getSessionState(workspaceId, sessionId);
    state.filter = filter;
    this.persist(workspaceId, sessionId, state);
  }

  /**
   * Update specific filter fields while preserving others.
   */
  updateFilter(workspaceId: string, sessionId: string, partial: Partial<TaskbarFilter>): void {
    const state = this.getSessionState(workspaceId, sessionId);
    state.filter = { ...state.filter, ...partial };
    this.persist(workspaceId, sessionId, state);
  }

  /**
   * Set status filter.
   */
  setStatusFilter(workspaceId: string, sessionId: string, statuses: TaskbarEntityStatus[]): void {
    this.updateFilter(workspaceId, sessionId, { status: statuses });
  }

  /**
   * Set priority filter.
   */
  setPriorityFilter(workspaceId: string, sessionId: string, priorities: TaskbarPriority[]): void {
    this.updateFilter(workspaceId, sessionId, { priority: priorities });
  }

  /**
   * Set kind filter.
   */
  setKindFilter(workspaceId: string, sessionId: string, kinds: TaskbarEntityKind[]): void {
    this.updateFilter(workspaceId, sessionId, { kind: kinds });
  }

  /**
   * Set requirement filter.
   */
  setRequirementFilter(workspaceId: string, sessionId: string, requirementId: string | undefined): void {
    this.updateFilter(workspaceId, sessionId, { requirementId });
  }

  /**
   * Set component filter.
   */
  setComponentFilter(workspaceId: string, sessionId: string, component: string | undefined): void {
    this.updateFilter(workspaceId, sessionId, { component });
  }

  /**
   * Set file filter.
   */
  setFileFilter(workspaceId: string, sessionId: string, file: string | undefined): void {
    this.updateFilter(workspaceId, sessionId, { file });
  }

  /**
   * Set agent filter.
   */
  setAgentFilter(workspaceId: string, sessionId: string, agent: string | undefined): void {
    this.updateFilter(workspaceId, sessionId, { agent });
  }

  /**
   * Set run filter.
   */
  setRunFilter(workspaceId: string, sessionId: string, run: string | undefined): void {
    this.updateFilter(workspaceId, sessionId, { run });
  }

  /**
   * Set risk filter.
   */
  setRiskFilter(workspaceId: string, sessionId: string, risks: TaskbarRiskLevel[]): void {
    this.updateFilter(workspaceId, sessionId, { risk: risks });
  }

  /**
   * Set milestone filter.
   */
  setMilestoneFilter(workspaceId: string, sessionId: string, milestone: string | undefined): void {
    this.updateFilter(workspaceId, sessionId, { milestone });
  }

  /**
   * Clear all filters for a workspace/session.
   */
  clearFilters(workspaceId: string, sessionId: string): void {
    const state = this.getSessionState(workspaceId, sessionId);
    state.filter = {};
    this.persist(workspaceId, sessionId, state);
  }

  /**
   * Clear selection for a workspace/session.
   */
  clearSelection(workspaceId: string, sessionId: string): void {
    const state = this.getSessionState(workspaceId, sessionId);
    state.selection = { selectedEntityId: null, expandedEntityIds: [] };
    this.persist(workspaceId, sessionId, state);
  }

  /**
   * Check if any filter is active.
   */
  hasActiveFilters(workspaceId: string, sessionId: string): boolean {
    const state = this.getSessionState(workspaceId, sessionId);
    const f = state.filter;
    return !!(
      (f.status && f.status.length > 0) ||
      (f.priority && f.priority.length > 0) ||
      (f.kind && f.kind.length > 0) ||
      f.requirementId ||
      f.component ||
      f.workspaceId ||
      f.file ||
      f.agent ||
      f.run ||
      (f.risk && f.risk.length > 0) ||
      f.milestone
    );
  }

  /**
   * Load serialized session states (e.g. from workspace storage).
   */
  loadFrom(states: TaskbarSessionState[]): void {
    this.sessions.clear();
    for (const state of states) {
      const key = this.getKey(state.workspaceId, state.sessionId);
      this.sessions.set(key, state);
    }
  }

  /**
   * Serialize all session states.
   */
  serialize(): TaskbarSessionState[] {
    return [...this.sessions.values()];
  }

  /**
   * Subscribe to state changes.
   */
  subscribe(listener: SessionStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get all tracked session keys.
   */
  getTrackedSessions(): Array<{ workspaceId: string; sessionId: string }> {
    return [...this.sessions.values()].map((s) => ({
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
    }));
  }

  private persist(workspaceId: string, sessionId: string, state: TaskbarSessionState): void {
    const key = this.getKey(workspaceId, sessionId);
    this.sessions.set(key, state);
    this.notifyListeners(state);
  }

  private notifyListeners(state: TaskbarSessionState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
