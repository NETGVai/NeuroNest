/**
 * Graph panel module — lazy-loaded Cytoscape graph visualization.
 *
 * This module implements PanelModule and defers ALL Cytoscape initialization
 * until the user explicitly opens the graph panel. No imports of graph-core,
 * graph-controls, or Cytoscape itself occur until mount() is called.
 *
 * Requirement 16.5: THE NeuroNest_App SHALL defer Cytoscape graph initialization
 * exclusively until the user first opens the graph panel; no automatic, background,
 * or anticipatory initialization SHALL occur prior to this user action.
 */

import type { PanelModule } from '../../types';

/** Internal state tracking for the lazy-loaded panel. */
let mounted = false;
let cleanupControls: (() => void) | null = null;
let graphContainer: HTMLElement | null = null;

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
      const [{ renderControls }, { initializeGraph, resizeGraph }, { loadGraph, generateGraph }] =
        await Promise.all([
          import('./graph-controls'),
          import('./graph-core'),
          import('./graph-service'),
        ]);

      // Remove loading indicator
      container.removeChild(loadingEl);

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

export default graphPanelModule;
