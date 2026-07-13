/**
 * Graph panel module — lazy-loaded Cytoscape graph visualization.
 *
 * This module implements PanelModule and defers ALL Cytoscape initialization
 * until the user explicitly opens the graph panel. No imports of graph-core,
 * graph-controls, or Cytoscape itself occur until mount() is called.
 *
 * Extends with a view selector to switch between Knowledge Graph and
 * Codebase Visualization views (Requirements 7.1, 7.2, 7.4, 7.5).
 *
 * Requirement 16.5: THE NeuroNest_App SHALL defer Cytoscape graph initialization
 * exclusively until the user first opens the graph panel; no automatic, background,
 * or anticipatory initialization SHALL occur prior to this user action.
 */

import type { PanelModule } from '../../types';
import type { ViewMode } from './codebase-viz/types';
import { ViewSelector } from './view-selector';
import type { CytoscapeHandle } from './view-selector';

/** Internal state tracking for the lazy-loaded panel. */
let mounted = false;
let cleanupControls: (() => void) | null = null;
let graphContainer: HTMLElement | null = null;
let viewSelector: ViewSelector | null = null;
let viewSelectorCleanup: (() => void) | null = null;

/**
 * Graph panel module.
 *
 * The mount() method triggers a dynamic import() of the actual graph implementation.
 * This ensures Cytoscape is NOT loaded, parsed, or initialized until the user
 * explicitly navigates to the graph panel.
 */
export const graphPanelModule: PanelModule = {
  /**
   * Mount the graph panel into the DOM.
   * This is the ONLY entry point that triggers Cytoscape loading.
   */
  async mount(container: HTMLElement): Promise<void> {
    if (mounted) return;
    mounted = true;
    graphContainer = container;

    // Set up panel layout
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.height = '100%';
    container.style.overflow = 'hidden';

    // Show loading state while we dynamically import the graph modules
    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-secondary, #94a3b8);
      font-size: 14px;
    `;
    loadingEl.textContent = 'Loading graph visualization…';
    container.appendChild(loadingEl);

    try {
      // Dynamic imports — this is where Cytoscape gets loaded for the first time.
      // No graph code is imported until this point (user action triggers it).
      const [{ renderControls }, { initializeGraph, resizeGraph, getCytoscapeInstance }, { loadGraph, generateGraph }] =
        await Promise.all([
          import('./graph-controls'),
          import('./graph-core'),
          import('./graph-service'),
        ]);

      // Remove loading indicator
      container.removeChild(loadingEl);

      // Initialize view selector (Requirement 7.1)
      viewSelector = new ViewSelector();

      // Render view selector toolbar
      const viewSelectorEl = renderViewSelector(viewSelector.getCurrentView(), async (mode) => {
        await handleViewSwitch(
          mode,
          vizContainer,
          getCytoscapeInstance as unknown as () => CytoscapeHandle | null,
          initializeGraph as unknown as (container: HTMLElement, graphData: unknown) => Promise<unknown>,
          resizeGraph
        );
      });
      container.appendChild(viewSelectorEl);

      // Render controls toolbar
      cleanupControls = renderControls(container);

      // Create graph visualization container
      const vizContainer = document.createElement('div');
      vizContainer.id = 'graph-panel-visualization';
      vizContainer.style.cssText = `
        flex: 1;
        position: relative;
        min-height: 0;
        background: var(--bg-primary, #0f172a);
        border-radius: 0 0 8px 8px;
      `;
      container.appendChild(vizContainer);

      // Attempt to load existing graph data for the active project
      const projectId = getActiveProjectId();
      if (projectId) {
        let graphData = await loadGraph(projectId);
        if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
          // Show empty state with generate button
          renderEmptyState(vizContainer, async () => {
            vizContainer.innerHTML = '';
            const spinnerEl = document.createElement('div');
            spinnerEl.style.cssText =
              'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);';
            spinnerEl.textContent = 'Generating knowledge graph…';
            vizContainer.appendChild(spinnerEl);

            try {
              graphData = await generateGraph(projectId);
              vizContainer.innerHTML = '';
              await initializeGraph(vizContainer, graphData);
            } catch (genErr) {
              vizContainer.innerHTML = '';
              renderErrorState(vizContainer, genErr);
            }
          });
        } else {
          await initializeGraph(vizContainer, graphData);
        }
      } else {
        renderNoProjectState(vizContainer);
      }

      // Handle container resize
      const resizeObserver = new ResizeObserver(() => {
        resizeGraph();
      });
      resizeObserver.observe(vizContainer);

      // Store observer reference for cleanup
      (container as unknown as { __graphResizeObserver?: ResizeObserver }).__graphResizeObserver =
        resizeObserver;
    } catch (err) {
      container.removeChild(loadingEl);
      renderErrorState(container, err);
    }
  },

  /**
   * Unmount the graph panel and release resources.
   */
  unmount(): void {
    if (!mounted) return;

    // Dynamically import destroy to clean up Cytoscape instance
    import('./graph-core').then(({ destroyGraph }) => {
      destroyGraph();
    });

    // Clean up controls
    if (cleanupControls) {
      cleanupControls();
      cleanupControls = null;
    }

    // Clean up view selector
    if (viewSelectorCleanup) {
      viewSelectorCleanup();
      viewSelectorCleanup = null;
    }
    viewSelector = null;

    // Clean up resize observer
    if (graphContainer) {
      const observer = (graphContainer as unknown as { __graphResizeObserver?: ResizeObserver })
        .__graphResizeObserver;
      if (observer) {
        observer.disconnect();
      }
      graphContainer.innerHTML = '';
    }

    graphContainer = null;
    mounted = false;
  },

  /**
   * Called when the graph panel receives focus.
   */
  onFocus(): void {
    // Trigger a resize in case the container dimensions changed while hidden
    if (mounted) {
      import('./graph-core').then(({ resizeGraph }) => {
        resizeGraph();
      });
    }
  },

  /**
   * Called when the graph panel loses focus.
   */
  onBlur(): void {
    // No action needed on blur — graph state is preserved
  },
};

/** Get the currently active project ID from global state. */
function getActiveProjectId(): string | null {
  // Access the global activeProjectId set by the main renderer
  return (window as unknown as { activeProjectId?: string | null }).activeProjectId ?? null;
}

/** Render an empty state with a button to generate the graph. */
function renderEmptyState(container: HTMLElement, onGenerate: () => void): void {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary, #94a3b8);
    gap: 16px;
  `;
  wrapper.innerHTML = `
    <div style="font-size: 48px;">📊</div>
    <div style="font-size: 14px;">No knowledge graph available</div>
    <div style="font-size: 12px; color: var(--text-tertiary, #64748b);">
      Generate a knowledge graph to visualize your project structure
    </div>
  `;

  const generateBtn = document.createElement('button');
  generateBtn.textContent = '🔄 Generate Graph';
  generateBtn.style.cssText = `
    padding: 10px 20px;
    border-radius: 6px;
    border: none;
    background: var(--accent, #6366f1);
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  `;
  generateBtn.addEventListener('click', onGenerate);
  wrapper.appendChild(generateBtn);
  container.appendChild(wrapper);
}

/** Render a state indicating no project is active. */
function renderNoProjectState(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary, #94a3b8);gap:12px;">
      <div style="font-size:48px;">📁</div>
      <div style="font-size:14px;">No project selected</div>
      <div style="font-size:12px;color:var(--text-tertiary, #64748b);">
        Open a project to view its knowledge graph
      </div>
    </div>
  `;
}

/** Render an error state with details. */
function renderErrorState(container: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown error occurred';
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--red, #ef4444);gap:12px;">
      <div style="font-size:48px;">⚠️</div>
      <div style="font-size:14px;">Failed to load graph visualization</div>
      <div style="font-size:12px;color:var(--text-secondary, #94a3b8);max-width:400px;text-align:center;">
        ${escapeHtml(message)}
      </div>
    </div>
  `;
}

/** Escape HTML special characters. */
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ─── View Selector UI (Requirements 7.1, 7.2, 7.4, 7.5) ────────────────────

/**
 * Render the view selector toggle between Knowledge Graph and Codebase Visualization.
 */
function renderViewSelector(
  currentView: ViewMode,
  onSwitch: (mode: ViewMode) => void
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.id = 'graph-view-selector';
  wrapper.setAttribute('role', 'tablist');
  wrapper.setAttribute('aria-label', 'Graph view selector');
  wrapper.style.cssText = `
    display: flex;
    gap: 0;
    padding: 8px 12px;
    background: var(--bg-secondary, #1e293b);
    border-bottom: 1px solid var(--border, #334155);
  `;

  const views: Array<{ mode: ViewMode; label: string }> = [
    { mode: 'knowledge-graph', label: 'Knowledge Graph' },
    { mode: 'codebase-visualization', label: 'Codebase Visualization' },
  ];

  for (const view of views) {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(view.mode === currentView));
    btn.setAttribute('data-view-mode', view.mode);
    btn.textContent = view.label;
    btn.style.cssText = getViewTabStyle(view.mode === currentView);
    btn.addEventListener('click', () => {
      onSwitch(view.mode);
      // Update active tab styling
      const tabs = wrapper.querySelectorAll('[role="tab"]');
      for (const tab of tabs) {
        const tabMode = (tab as HTMLElement).getAttribute('data-view-mode');
        const isActive = tabMode === view.mode;
        (tab as HTMLElement).setAttribute('aria-selected', String(isActive));
        (tab as HTMLElement).style.cssText = getViewTabStyle(isActive);
      }
    });
    wrapper.appendChild(btn);
  }

  return wrapper;
}

/** Get style string for a view selector tab. */
function getViewTabStyle(isActive: boolean): string {
  const base = `
    padding: 6px 16px;
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    border-radius: 4px;
  `;
  if (isActive) {
    return base + 'background: var(--accent, #6366f1); color: white;';
  }
  return base + 'background: transparent; color: var(--text-secondary, #94a3b8);';
}

/**
 * Handle switching between views.
 * Preserves Cytoscape instance, swaps data, restores zoom/pan/selection (Requirement 7.2).
 * Lazy-loads codebase-viz modules on first switch (Requirement 7.4).
 */
async function handleViewSwitch(
  mode: ViewMode,
  vizContainer: HTMLElement,
  getCytoscapeInstance: () => CytoscapeHandle | null,
  initializeGraph: (container: HTMLElement, graphData: unknown) => Promise<unknown>,
  resizeGraph: () => void
): Promise<void> {
  if (!viewSelector) return;

  const cy = getCytoscapeInstance();

  if (mode === 'codebase-visualization') {
    // Lazy-load codebase viz modules on first switch (Requirement 7.4)
    if (!viewSelector.isCodebaseVizLoaded()) {
      const vizModule = await viewSelector.lazyLoadCodebaseViz();
      if (!vizModule) {
        renderErrorState(vizContainer, new Error('Failed to load codebase visualization module'));
        return;
      }
    }

    // Check if we have previously loaded codebase data
    const savedState = viewSelector.getViewState('codebase-visualization');
    if (savedState.elements && savedState.elements.length > 0 && cy) {
      // Switch view: swap data, restore zoom/pan/selection
      viewSelector.switchView(mode, cy as CytoscapeHandle);
    } else {
      // No data yet — show empty state with "Analyze Codebase" button (Requirement 7.5)
      if (cy) {
        viewSelector.saveViewState(cy as CytoscapeHandle);
      }
      // Update current view to codebase-visualization
      viewSelector.switchView(mode, cy as CytoscapeHandle);
      vizContainer.innerHTML = '';
      renderCodebaseEmptyState(vizContainer, async () => {
        const projectId = getActiveProjectId();
        if (!projectId) return;

        vizContainer.innerHTML = '';
        const spinnerEl = document.createElement('div');
        spinnerEl.style.cssText =
          'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);';
        spinnerEl.textContent = 'Analyzing codebase…';
        vizContainer.appendChild(spinnerEl);

        try {
          const vizModule = await viewSelector!.lazyLoadCodebaseViz();
          if (vizModule) {
            await vizModule.analyzeCodebase(projectId);
          }
          // After analysis, the codebase-view module will populate the graph.
          // For now, signal that analysis is complete.
          vizContainer.innerHTML = '';
          resizeGraph();
        } catch (err) {
          vizContainer.innerHTML = '';
          renderErrorState(vizContainer, err);
        }
      });
    }
  } else {
    // Switching back to knowledge graph
    if (cy) {
      viewSelector.switchView(mode, cy as CytoscapeHandle);
      resizeGraph();
    }
  }
}

/**
 * Render empty state for codebase visualization with "Analyze Codebase" button.
 * Follows the same pattern as the existing "Generate Graph" empty state (Requirement 7.5).
 */
function renderCodebaseEmptyState(container: HTMLElement, onAnalyze: () => void): void {
  const emptyState = viewSelector?.getEmptyState();
  if (!emptyState) return;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary, #94a3b8);
    gap: 16px;
  `;
  wrapper.innerHTML = `
    <div style="font-size: 48px;">${emptyState.icon}</div>
    <div style="font-size: 14px;">${escapeHtml(emptyState.message)}</div>
    <div style="font-size: 12px; color: var(--text-tertiary, #64748b); max-width: 400px; text-align: center;">
      ${escapeHtml(emptyState.detail)}
    </div>
  `;

  const analyzeBtn = document.createElement('button');
  analyzeBtn.textContent = `🔍 ${emptyState.actionLabel}`;
  analyzeBtn.style.cssText = `
    padding: 10px 20px;
    border-radius: 6px;
    border: none;
    background: var(--accent, #6366f1);
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  `;
  analyzeBtn.addEventListener('click', onAnalyze);
  wrapper.appendChild(analyzeBtn);
  container.appendChild(wrapper);
}

export default graphPanelModule;
