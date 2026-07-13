/**
 * View Selector module for the Graph Panel.
 *
 * Manages switching between "Knowledge Graph" and "Codebase Visualization"
 * views within the same Cytoscape instance. Preserves zoom, pan, and selection
 * state per view to maintain user context across switches.
 *
 * Lazy-loads codebase visualization modules on first access to avoid
 * eagerly importing analysis code.
 *
 * Requirements: 7.1, 7.2, 7.4, 7.5
 */

import type { ViewMode, CodebaseGraphData } from './codebase-viz/types';
import type { GraphData } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Per-view saved Cytoscape state for restore on switch. */
export interface ViewState {
  zoom: number;
  pan: { x: number; y: number };
  selectedNodeIds: string[];
  elements: CytoscapeElementData[] | null;
}

/** Minimal Cytoscape element representation for saving/restoring. */
export interface CytoscapeElementData {
  group: 'nodes' | 'edges';
  data: Record<string, unknown>;
  classes?: string;
  position?: { x: number; y: number };
}

/** Cytoscape instance interface used by the view selector. */
export interface CytoscapeHandle {
  zoom(): number;
  zoom(level: number): void;
  pan(): { x: number; y: number };
  pan(pos: { x: number; y: number }): void;
  elements(): {
    remove(): void;
    jsons(): CytoscapeElementData[];
  };
  add(elements: CytoscapeElementData[]): void;
  nodes(selector?: string): {
    filter(fn: (ele: unknown) => boolean): { data(key: string): string }[];
    select(): void;
  };
  $id(id: string): { select(): void; length: number };
  resize(): void;
  fit(eles?: unknown, padding?: number): void;
}

/** Lazy-loaded codebase viz module shape. */
export interface CodebaseVizModule {
  analyzeCodebase: (projectId: string) => Promise<unknown>;
  onProgress: (callback: (percent: number) => void) => () => void;
}

/** Result from getEmptyState for the codebase visualization view. */
export interface EmptyStateInfo {
  icon: string;
  message: string;
  detail: string;
  actionLabel: string;
  actionType: 'analyze-codebase';
}

// ─── ViewSelector Class ──────────────────────────────────────────────────────

/**
 * Manages view switching between Knowledge Graph and Codebase Visualization.
 *
 * Key behaviors:
 * - Preserves a single Cytoscape instance across view switches (no destroy/recreate)
 * - Saves and restores per-view state: zoom, pan, selected nodes, element data
 * - Lazy-loads codebase-viz modules on first switch to codebase view
 * - Provides empty state info when no analysis data exists
 */
export class ViewSelector {
  private currentView: ViewMode = 'knowledge-graph';
  private viewStates: Map<ViewMode, ViewState> = new Map();
  private codebaseVizModule: CodebaseVizModule | null = null;
  private codebaseVizLoading = false;

  constructor() {
    // Initialize default view states
    this.viewStates.set('knowledge-graph', this.createDefaultViewState());
    this.viewStates.set('codebase-visualization', this.createDefaultViewState());
  }

  /** Get the currently active view mode. */
  getCurrentView(): ViewMode {
    return this.currentView;
  }

  /** Get saved state for a specific view. */
  getViewState(mode: ViewMode): ViewState {
    return this.viewStates.get(mode) ?? this.createDefaultViewState();
  }

  /** Check if codebase viz modules have been loaded. */
  isCodebaseVizLoaded(): boolean {
    return this.codebaseVizModule !== null;
  }

  /** Check if codebase viz modules are currently loading. */
  isCodebaseVizLoading(): boolean {
    return this.codebaseVizLoading;
  }

  /**
   * Switch between views. Saves current view state and restores the target view state.
   *
   * @param mode - The target view mode
   * @param cy - The Cytoscape instance to manipulate
   * @param newElements - Optional new elements to load in the target view
   *                      (if null, restores previously saved elements)
   * @returns true if the switch was performed, false if already on that view
   */
  switchView(
    mode: ViewMode,
    cy: CytoscapeHandle,
    newElements?: CytoscapeElementData[] | null
  ): boolean {
    if (mode === this.currentView) {
      return false;
    }

    // Save current view state
    this.saveViewState(cy);

    // Switch to new view
    const previousView = this.currentView;
    this.currentView = mode;

    // Remove current elements
    cy.elements().remove();

    // Determine elements to load
    const targetState = this.viewStates.get(mode);
    const elementsToLoad = newElements ?? targetState?.elements;

    if (elementsToLoad && elementsToLoad.length > 0) {
      // Load elements into Cytoscape
      cy.add(elementsToLoad);

      // Restore view state (zoom, pan, selection) if we have saved state
      if (targetState && targetState.elements !== null) {
        this.restoreViewState(cy, targetState);
      } else {
        // First time loading this view — fit to content
        cy.resize();
        cy.fit(undefined, 50);
      }

      // If new elements were explicitly provided, save them
      if (newElements) {
        const state = this.viewStates.get(mode) ?? this.createDefaultViewState();
        state.elements = newElements;
        this.viewStates.set(mode, state);
      }
    }

    return true;
  }

  /**
   * Save the current Cytoscape state (zoom, pan, selection, elements) for the active view.
   */
  saveViewState(cy: CytoscapeHandle): void {
    const state: ViewState = {
      zoom: cy.zoom() as number,
      pan: cy.pan() as { x: number; y: number },
      selectedNodeIds: this.getSelectedNodeIds(cy),
      elements: cy.elements().jsons(),
    };
    this.viewStates.set(this.currentView, state);
  }

  /**
   * Restore a saved view state onto the Cytoscape instance.
   */
  restoreViewState(cy: CytoscapeHandle, state: ViewState): void {
    // Restore zoom and pan
    cy.zoom(state.zoom);
    cy.pan(state.pan);

    // Restore selection
    if (state.selectedNodeIds.length > 0) {
      for (const nodeId of state.selectedNodeIds) {
        const ele = cy.$id(nodeId);
        if (ele.length > 0) {
          ele.select();
        }
      }
    }
  }

  /**
   * Lazy-load the codebase visualization modules.
   * Returns the loaded module, or null if loading fails.
   * Uses dynamic import following the lazy-loading pattern (Requirement 7.4).
   */
  async lazyLoadCodebaseViz(): Promise<CodebaseVizModule | null> {
    if (this.codebaseVizModule) {
      return this.codebaseVizModule;
    }

    if (this.codebaseVizLoading) {
      // Already in progress — wait for it
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          if (!this.codebaseVizLoading) {
            clearInterval(interval);
            resolve(this.codebaseVizModule);
          }
        }, 50);
      });
    }

    this.codebaseVizLoading = true;

    try {
      const module = await import('./codebase-viz/codebase-graph-service');
      this.codebaseVizModule = {
        analyzeCodebase: module.analyzeCodebase,
        onProgress: module.onProgress,
      };
      return this.codebaseVizModule;
    } catch {
      // Loading failed — module may not be available
      return null;
    } finally {
      this.codebaseVizLoading = false;
    }
  }

  /**
   * Get the empty state information for the codebase visualization view.
   * Displayed when no analysis has been run (Requirement 7.5).
   */
  getEmptyState(): EmptyStateInfo {
    return {
      icon: '🔍',
      message: 'No codebase analysis available',
      detail: 'Analyze your codebase to visualize file dependencies, detect patterns, and assess code health.',
      actionLabel: 'Analyze Codebase',
      actionType: 'analyze-codebase',
    };
  }

  /**
   * Update saved elements for a specific view without switching to it.
   */
  updateViewElements(mode: ViewMode, elements: CytoscapeElementData[]): void {
    const state = this.viewStates.get(mode) ?? this.createDefaultViewState();
    state.elements = elements;
    this.viewStates.set(mode, state);
  }

  /**
   * Reset a view's saved state back to defaults.
   */
  resetViewState(mode: ViewMode): void {
    this.viewStates.set(mode, this.createDefaultViewState());
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private createDefaultViewState(): ViewState {
    return {
      zoom: 1,
      pan: { x: 0, y: 0 },
      selectedNodeIds: [],
      elements: null,
    };
  }

  private getSelectedNodeIds(cy: CytoscapeHandle): string[] {
    try {
      const selected = cy.nodes(':selected');
      if (!selected) return [];
      const ids: string[] = [];
      const filtered = selected.filter(() => true);
      for (const node of filtered) {
        const id = node.data('id');
        if (id) ids.push(id);
      }
      return ids;
    } catch {
      return [];
    }
  }
}
