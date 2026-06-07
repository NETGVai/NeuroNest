/**
 * Graph Controls System
 * 
 * Provides comprehensive control panel for graph visualization including
 * layout selection, zoom controls, filters, and search functionality.
 */

import { 
  applyGraphLayout, 
  fitGraphToView, 
  resetGraphView, 
  filterGraphNodes, 
  searchAndHighlightNodes,
  exportGraphAsImage,
  getCurrentCytoscapeInstance 
} from './graph-visualization';
import { ProjectGraph } from '../graph/graph-manager';

export interface ControlsConfig {
  showLayoutControls: boolean;
  showZoomControls: boolean;
  showFilterControls: boolean;
  showSearchControls: boolean;
  showExportControls: boolean;
}

/**
 * Main function to show graph controls - replaces the missing function in index.ts
 */
export function showGraphControls(graphData: ProjectGraph, config: Partial<ControlsConfig> = {}): void {
  const controlsEl = document.getElementById('graph-controls');
  if (!controlsEl) {
    console.error('[GraphControls] Graph controls container not found');
    return;
  }

  const defaultConfig: ControlsConfig = {
    showLayoutControls: true,
    showZoomControls: true,
    showFilterControls: true,
    showSearchControls: true,
    showExportControls: true
  };

  const finalConfig = { ...defaultConfig, ...config };

  try {
    // Clear existing controls
    controlsEl.innerHTML = '';

    // Create main controls container
    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'graph-controls-container';
    controlsContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px;
      background: var(--bg-primary);
      border-radius: 8px;
      border: 1px solid var(--border-color);
      max-height: 100%;
      overflow-y: auto;
    `;

    // Add title
    const title = document.createElement('div');
    title.textContent = 'Graph Controls';
    title.style.cssText = `
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 8px;
    `;
    controlsContainer.appendChild(title);

    // Add layout controls
    if (finalConfig.showLayoutControls) {
      controlsContainer.appendChild(createLayoutControls());
    }

    // Add zoom controls
    if (finalConfig.showZoomControls) {
      controlsContainer.appendChild(createZoomControls());
    }

    // Add filter controls
    if (finalConfig.showFilterControls) {
      controlsContainer.appendChild(createFilterControls(graphData));
    }

    // Add search controls
    if (finalConfig.showSearchControls) {
      controlsContainer.appendChild(createSearchControls());
    }

    // Add export controls
    if (finalConfig.showExportControls) {
      controlsContainer.appendChild(createExportControls());
    }

    // Add statistics
    controlsContainer.appendChild(createStatisticsDisplay(graphData));

    controlsEl.appendChild(controlsContainer);

    console.log('[GraphControls] Graph controls created successfully');

  } catch (error) {
    console.error('[GraphControls] Error creating graph controls:', error);
    
    controlsEl.innerHTML = `
      <div style="padding: 16px; color: var(--text-secondary); text-align: center;">
        <div>⚠️ Failed to create controls</div>
        <div style="font-size: 12px; margin-top: 8px;">${error instanceof Error ? error.message : 'Unknown error'}</div>
      </div>
    `;
  }
}

/**
 * Create layout selection controls
 */
function createLayoutControls(): HTMLElement {
  const section = createControlSection('Layout Algorithm');

  const layouts = [
    { id: 'fcose', name: 'fCoSE (Force)', description: 'Advanced force-directed layout' },
    { id: 'cola', name: 'Cola (Force)', description: 'Physics-based force layout' },
    { id: 'dagre', name: 'Dagre (Hierarchical)', description: 'Top-down hierarchical layout' },
    { id: 'breadthfirst', name: 'Breadth-first', description: 'Tree-like breadth-first layout' },
    { id: 'circle', name: 'Circle', description: 'Circular arrangement' },
    { id: 'grid', name: 'Grid', description: 'Regular grid arrangement' },
    { id: 'random', name: 'Random', description: 'Random positioning' }
  ];

  const layoutContainer = document.createElement('div');
  layoutContainer.style.cssText = `
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `;

  layouts.forEach(layout => {
    const button = createControlButton(layout.name, layout.description);
    button.addEventListener('click', () => {
      // Remove active class from all layout buttons
      layoutContainer.querySelectorAll('.control-button').forEach(btn => {
        btn.classList.remove('active');
      });
      
      // Add active class to clicked button
      button.classList.add('active');
      
      // Apply layout
      applyGraphLayout(layout.id);
      
      console.log(`[GraphControls] Applied ${layout.name} layout`);
    });

    // Set fCoSE as default active
    if (layout.id === 'fcose') {
      button.classList.add('active');
    }

    layoutContainer.appendChild(button);
  });

  section.appendChild(layoutContainer);
  return section;
}

/**
 * Create zoom and pan controls
 */
function createZoomControls(): HTMLElement {
  const section = createControlSection('View Controls');

  const controls = [
    { id: 'zoom-in', name: '🔍 Zoom In', action: () => zoomGraph(1.2) },
    { id: 'zoom-out', name: '🔍 Zoom Out', action: () => zoomGraph(0.8) },
    { id: 'fit-view', name: '📐 Fit to View', action: () => fitGraphToView() },
    { id: 'reset-view', name: '↻ Reset View', action: () => resetGraphView() }
  ];

  const controlsContainer = document.createElement('div');
  controlsContainer.style.cssText = `
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `;

  controls.forEach(control => {
    const button = createControlButton(control.name);
    button.addEventListener('click', control.action);
    controlsContainer.appendChild(button);
  });

  section.appendChild(controlsContainer);
  return section;
}

/**
 * Create filter controls
 */
function createFilterControls(graphData: ProjectGraph): HTMLElement {
  const section = createControlSection('Filter Nodes');

  const filters = [
    { id: 'all', name: '👁️ Show All', description: 'Show all nodes and edges' },
    { id: 'god-nodes', name: '⭐ God Nodes', description: 'Highly connected components' },
    { id: 'functions', name: '🔧 Functions', description: 'Function and method nodes' },
    { id: 'classes', name: '📦 Classes', description: 'Class and interface nodes' },
    { id: 'files', name: '📄 Files', description: 'File and document nodes' }
  ];

  const filterContainer = document.createElement('div');
  filterContainer.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 6px;
  `;

  filters.forEach(filter => {
    const button = createControlButton(filter.name, filter.description);
    button.style.width = '100%';
    
    button.addEventListener('click', () => {
      // Remove active class from all filter buttons
      filterContainer.querySelectorAll('.control-button').forEach(btn => {
        btn.classList.remove('active');
      });
      
      // Add active class to clicked button
      button.classList.add('active');
      
      // Apply filter
      filterGraphNodes(filter.id);
      
      console.log(`[GraphControls] Applied ${filter.name} filter`);
    });

    // Set 'Show All' as default active
    if (filter.id === 'all') {
      button.classList.add('active');
    }

    filterContainer.appendChild(button);
  });

  section.appendChild(filterContainer);
  return section;
}

/**
 * Create search controls
 */
function createSearchControls(): HTMLElement {
  const section = createControlSection('Search Nodes');

  const searchContainer = document.createElement('div');
  searchContainer.style.cssText = `
    display: flex;
    gap: 8px;
    align-items: center;
  `;

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search nodes...';
  searchInput.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 12px;
  `;

  // Search button
  const searchButton = createControlButton('🔍');
  searchButton.style.minWidth = '40px';

  // Clear button
  const clearButton = createControlButton('✕');
  clearButton.style.minWidth = '40px';

  // Search functionality
  const performSearch = () => {
    const searchTerm = searchInput.value.trim();
    if (searchTerm) {
      searchAndHighlightNodes(searchTerm);
    }
  };

  const clearSearch = () => {
    searchInput.value = '';
    const cy = getCurrentCytoscapeInstance();
    if (cy) {
      cy.nodes().removeClass('search-highlight');
      fitGraphToView();
    }
  };

  // Event listeners
  searchButton.addEventListener('click', performSearch);
  clearButton.addEventListener('click', clearSearch);
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      performSearch();
    }
  });

  searchContainer.appendChild(searchInput);
  searchContainer.appendChild(searchButton);
  searchContainer.appendChild(clearButton);

  section.appendChild(searchContainer);
  return section;
}

/**
 * Create export controls
 */
function createExportControls(): HTMLElement {
  const section = createControlSection('Export Graph');

  const exports = [
    { id: 'png', name: '🖼️ PNG Image', action: () => exportGraph('png') },
    { id: 'json', name: '📄 JSON Data', action: () => exportGraph('json') },
    { id: 'csv', name: '📊 CSV Data', action: () => exportGraph('csv') }
  ];

  const exportContainer = document.createElement('div');
  exportContainer.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 6px;
  `;

  exports.forEach(exportOption => {
    const button = createControlButton(exportOption.name);
    button.style.width = '100%';
    button.addEventListener('click', exportOption.action);
    exportContainer.appendChild(button);
  });

  section.appendChild(exportContainer);
  return section;
}

/**
 * Create statistics display
 */
function createStatisticsDisplay(graphData: ProjectGraph): HTMLElement {
  const section = createControlSection('Graph Statistics');

  const stats = [
    { label: 'Nodes', value: graphData.nodes.length },
    { label: 'Edges', value: graphData.edges.length },
    { label: 'Communities', value: Object.keys(graphData.communities || {}).length },
    { label: 'God Nodes', value: graphData.godNodes?.length || 0 }
  ];

  const statsContainer = document.createElement('div');
  statsContainer.style.cssText = `
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `;

  stats.forEach(stat => {
    const statItem = document.createElement('div');
    statItem.style.cssText = `
      padding: 8px;
      background: var(--bg-secondary);
      border-radius: 4px;
      text-align: center;
      border: 1px solid var(--border-color);
    `;

    statItem.innerHTML = `
      <div style="font-size: 16px; font-weight: 600; color: var(--accent);">${stat.value}</div>
      <div style="font-size: 11px; color: var(--text-secondary);">${stat.label}</div>
    `;

    statsContainer.appendChild(statItem);
  });

  section.appendChild(statsContainer);
  return section;
}

/**
 * Create a control section with title
 */
function createControlSection(title: string): HTMLElement {
  const section = document.createElement('div');
  section.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 8px;
  `;

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = `
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `;

  section.appendChild(titleEl);
  return section;
}

/**
 * Create a styled control button
 */
function createControlButton(text: string, tooltip?: string): HTMLElement {
  const button = document.createElement('button');
  button.textContent = text;
  button.className = 'control-button';
  button.style.cssText = `
    padding: 8px 12px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `;

  if (tooltip) {
    button.title = tooltip;
  }

  // Hover effects
  button.addEventListener('mouseenter', () => {
    button.style.background = 'var(--bg-hover)';
    button.style.borderColor = 'var(--accent)';
  });

  button.addEventListener('mouseleave', () => {
    if (!button.classList.contains('active')) {
      button.style.background = 'var(--bg-secondary)';
      button.style.borderColor = 'var(--border-color)';
    }
  });

  return button;
}

/**
 * Zoom the graph by a factor
 */
function zoomGraph(factor: number): void {
  const cy = getCurrentCytoscapeInstance();
  if (!cy) return;

  const currentZoom = cy.zoom();
  const newZoom = currentZoom * factor;
  
  // Apply zoom limits
  if (newZoom >= 0.1 && newZoom <= 3) {
    cy.zoom(newZoom);
  }
}

/**
 * Export graph in various formats
 */
async function exportGraph(format: string): Promise<void> {
  try {
    switch (format) {
      case 'png':
        const blob = await exportGraphAsImage('png');
        downloadBlob(blob, 'knowledge-graph.png');
        break;
      
      case 'json':
        // This would need to be implemented to get the current graph data
        console.log('[GraphControls] JSON export not yet implemented');
        alert('JSON export will be implemented in the next update');
        break;
      
      case 'csv':
        // This would need to be implemented to convert graph data to CSV
        console.log('[GraphControls] CSV export not yet implemented');
        alert('CSV export will be implemented in the next update');
        break;
      
      default:
        console.warn(`[GraphControls] Unknown export format: ${format}`);
    }
  } catch (error) {
    console.error(`[GraphControls] Export failed:`, error);
    alert(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Download a blob as a file
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Add CSS styles for active buttons
 */
function addControlStyles(): void {
  const styleId = 'graph-controls-styles';
  
  // Check if styles already added
  if (document.getElementById(styleId)) {
    return;
  }

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .control-button.active {
      background: var(--accent) !important;
      color: white !important;
      border-color: var(--accent) !important;
    }
    
    .control-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }
    
    .control-button:active {
      transform: translateY(0);
    }
  `;
  
  document.head.appendChild(style);
}

// Add styles when module loads
addControlStyles();