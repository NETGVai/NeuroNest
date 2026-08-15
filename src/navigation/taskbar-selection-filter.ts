/**
 * TaskbarSelectionFilter — Lets taskbar selection filter files, decorations,
 * review, and timeline without forcing navigation on cursor movement.
 *
 * When a user selects an entity in the Visual_Taskbar, the filter applies to:
 * - File tree (show only files associated with the selected entity)
 * - Editor decorations (highlight relevant lines)
 * - Review queue (filter to related Change_Sets)
 * - Chat timeline (filter to related messages/events)
 *
 * Importantly, this filtering does NOT force editor navigation on cursor
 * movement — it only applies passive filtering and decorations.
 *
 * Requirements: 19.3, 19.5
 */

import type { TaskbarEntity, TaskbarTypedLink } from '../renderer/visual-taskbar/types';

/**
 * A decoration that can be applied to editor lines.
 */
export interface FilterDecoration {
  uri: string;
  range: { startLine: number; endLine: number };
  kind: 'task-linked' | 'pending-agent-edit' | 'review-status' | 'failing-evidence';
  label?: string;
  entityId: string;
}

/**
 * Filter state derived from the currently selected taskbar entity.
 */
export interface SelectionFilterState {
  /** Currently selected entity (null if nothing selected) */
  selectedEntity: TaskbarEntity | null;
  /** Files associated with the selected entity */
  filteredFiles: string[];
  /** Editor decorations to apply */
  decorations: FilterDecoration[];
  /** Review queue Change_Set IDs to highlight */
  reviewFilter: string[];
  /** Timeline event IDs/types to highlight */
  timelineFilter: string[];
  /** Whether filtering is active */
  isActive: boolean;
}

/**
 * Listener for selection filter state changes.
 */
export type SelectionFilterListener = (state: SelectionFilterState) => void;

/**
 * Source of entity metadata for resolving files, decorations, and related items.
 */
export interface EntityMetadataSource {
  /** Get files associated with an entity */
  getEntityFiles(entityId: string): string[];
  /** Get source ranges for an entity in specific files */
  getEntitySourceRanges(entityId: string): Array<{ uri: string; startLine: number; endLine: number }>;
  /** Get Change_Set IDs related to an entity */
  getRelatedChangeSets(entityId: string): string[];
  /** Get timeline event IDs/types related to an entity */
  getRelatedTimelineEvents(entityId: string): string[];
  /** Get linked entities for the selected entity */
  getLinkedEntities(entityId: string): TaskbarTypedLink[];
}

/**
 * TaskbarSelectionFilter applies passive filtering and decorations
 * based on the currently selected Visual_Taskbar entity.
 *
 * It does NOT force navigation on cursor movement.
 */
export class TaskbarSelectionFilter {
  private currentState: SelectionFilterState = {
    selectedEntity: null,
    filteredFiles: [],
    decorations: [],
    reviewFilter: [],
    timelineFilter: [],
    isActive: false,
  };

  private listeners = new Set<SelectionFilterListener>();

  constructor(private readonly metadataSource: EntityMetadataSource) {}

  /**
   * Apply a selection filter for the given entity.
   * This updates the derived filter state without forcing any navigation.
   */
  applySelection(entity: TaskbarEntity | null): void {
    if (!entity) {
      this.clearFilter();
      return;
    }

    const filteredFiles = this.metadataSource.getEntityFiles(entity.id);
    const sourceRanges = this.metadataSource.getEntitySourceRanges(entity.id);
    const reviewFilter = this.metadataSource.getRelatedChangeSets(entity.id);
    const timelineFilter = this.metadataSource.getRelatedTimelineEvents(entity.id);

    const decorations: FilterDecoration[] = sourceRanges.map((range) => ({
      uri: range.uri,
      range: { startLine: range.startLine, endLine: range.endLine },
      kind: this.resolveDecorationKind(entity),
      label: entity.title,
      entityId: entity.id,
    }));

    this.currentState = {
      selectedEntity: entity,
      filteredFiles,
      decorations,
      reviewFilter,
      timelineFilter,
      isActive: true,
    };

    this.notifyListeners();
  }

  /**
   * Clear the current selection filter.
   */
  clearFilter(): void {
    this.currentState = {
      selectedEntity: null,
      filteredFiles: [],
      decorations: [],
      reviewFilter: [],
      timelineFilter: [],
      isActive: false,
    };
    this.notifyListeners();
  }

  /**
   * Get the current filter state.
   */
  getState(): Readonly<SelectionFilterState> {
    return this.currentState;
  }

  /**
   * Check if filtering is active.
   */
  isFiltering(): boolean {
    return this.currentState.isActive;
  }

  /**
   * Get decorations for a specific file URI.
   */
  getDecorationsForFile(uri: string): FilterDecoration[] {
    return this.currentState.decorations.filter((d) => d.uri === uri);
  }

  /**
   * Check if a file passes the current selection filter.
   */
  isFileIncluded(filePath: string): boolean {
    if (!this.currentState.isActive) return true;
    if (this.currentState.filteredFiles.length === 0) return true;
    return this.currentState.filteredFiles.includes(filePath);
  }

  /**
   * Check if a Change_Set passes the current selection filter.
   */
  isChangeSetIncluded(changeSetId: string): boolean {
    if (!this.currentState.isActive) return true;
    if (this.currentState.reviewFilter.length === 0) return true;
    return this.currentState.reviewFilter.includes(changeSetId);
  }

  /**
   * Check if a timeline event passes the current selection filter.
   */
  isTimelineEventIncluded(eventId: string): boolean {
    if (!this.currentState.isActive) return true;
    if (this.currentState.timelineFilter.length === 0) return true;
    return this.currentState.timelineFilter.includes(eventId);
  }

  /**
   * Subscribe to filter state changes.
   */
  subscribe(listener: SelectionFilterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private resolveDecorationKind(entity: TaskbarEntity): FilterDecoration['kind'] {
    switch (entity.kind) {
      case 'task':
        return 'task-linked';
      case 'execution':
        return 'pending-agent-edit';
      default:
        return 'task-linked';
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.currentState);
    }
  }
}
