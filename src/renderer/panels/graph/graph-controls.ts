/**
 * Graph controls — layout controls, zoom, filter UI.
 * Renders the control toolbar for the graph panel and wires user interactions
 * to the graph-core functions.
 */

import type { GraphLayoutName, GraphFilterType, GraphExportFormat } from './types';
import {
  applyLayout,
  filterNodes,
  searchNodes,
  clearSearchHighlights,
  fitToView,
  resetView,
  zoomBy,
  exportGraph,
} from './graph-core';

/** Available layout options for the dropdown. */
const LAYOUT_OPTIONS: Array<{ name: GraphLayoutName; label: string }> = [
  { name: 'cose', label: 'Force-Directed (CoSE)' },
  { name: 'cose-bilkent', label: 'CoSE-Bilkent' },
  { name: 'dagre', label: 'Hierarchical (Dagre)' },
  { name: 'breadthfirst', label: 'Breadth-First' },
  { name: 'circle', label: 'Circle' },
  { name: 'grid', label: 'Grid' },
  { name: 'concentric', label: 'Concentric' },
  { name: 'cola', label: 'Cola (Constraint)' },
  { name: 'random', label: 'Random' },
];

/** Available filter options. */
const FILTER_OPTIONS: Array<{ type: GraphFilterType; label: string; icon: string }> = [
  { type: 'all', label: 'All Nodes', icon: '🔵' },
  { type: 'god-nodes', label: 'God Nodes', icon: '🔴' },
  { type: 'functions', label: 'Functions', icon: '🟢' },
  { type: 'classes', label: 'Classes', icon: '🟡' },
  { type: 'files', label: 'Files', icon: '📄' },
  { type: 'components', label: 'Components', icon: '🟣' },
];

/** State for the controls UI. */
let currentLayout: GraphLayoutName = 'cose';
let currentFilter: GraphFilterType = 'all';
let searchInput: HTMLInputElement | null = null;

/**
 * Render the graph controls toolbar into the given container.
 * Returns a cleanup function to remove event listeners.
 */
export function renderControls(container: HTMLElement): () => void {
  const toolbar = document.createElement('div');
  toolbar.className = 'graph-controls-toolbar';
  toolbar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-sidebar, #1e1e2e);
    border-bottom: 1px solid var(--border-color, #334155);
    flex-wrap: wrap;
    font-size: 12px;
  `;

  // Layout selector
  const layoutGroup = createControlGroup('Layout');
  const layoutSelect = document.createElement('select');
  layoutSelect.style.cssText = selectStyle();
  for (const opt of LAYOUT_OPTIONS) {
    const option = document.createElement('option');
    option.value = opt.name;
    option.textContent = opt.label;
    if (opt.name === currentLayout) option.selected = true;
    layoutSelect.appendChild(option);
  }
  layoutGroup.appendChild(layoutSelect);

  // Filter selector
  const filterGroup = createControlGroup('Filter');
  const filterSelect = document.createElement('select');
  filterSelect.style.cssText = selectStyle();
  for (const opt of FILTER_OPTIONS) {
    const option = document.createElement('option');
    option.value = opt.type;
    option.textContent = `${opt.icon} ${opt.label}`;
    if (opt.type === currentFilter) option.selected = true;
    filterSelect.appendChild(option);
  }
  filterGroup.appendChild(filterSelect);

  // Search input
  const searchGroup = createControlGroup('Search');
  searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search nodes…';
  searchInput.style.cssText = `
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #334155);
    background: var(--bg-input, #0f172a);
    color: var(--text-primary, #e2e8f0);
    font-size: 12px;
    width: 150px;
    outline: none;
  `;

  const clearBtn = createButton('✕', 'Clear search');
  clearBtn.style.fontSize = '10px';
  clearBtn.style.padding = '4px 6px';
  searchGroup.appendChild(searchInput);
  searchGroup.appendChild(clearBtn);

  // Zoom controls
  const zoomGroup = createControlGroup('Zoom');
  const zoomInBtn = createButton('+', 'Zoom in');
  const zoomOutBtn = createButton('−', 'Zoom out');
  const fitBtn = createButton('⊞', 'Fit to view');
  const resetBtn = createButton('↺', 'Reset view');
  zoomGroup.appendChild(zoomInBtn);
  zoomGroup.appendChild(zoomOutBtn);
  zoomGroup.appendChild(fitBtn);
  zoomGroup.appendChild(resetBtn);

  // Export button
  const exportGroup = createControlGroup('');
  const exportBtn = createButton('📷 Export', 'Export as image');
  exportGroup.appendChild(exportBtn);

  // Assemble toolbar
  toolbar.appendChild(layoutGroup);
  toolbar.appendChild(filterGroup);
  toolbar.appendChild(searchGroup);
  toolbar.appendChild(zoomGroup);
  toolbar.appendChild(exportGroup);

  container.appendChild(toolbar);

  // Event handlers
  const onLayoutChange = () => {
    currentLayout = layoutSelect.value as GraphLayoutName;
    applyLayout(currentLayout);
  };

  const onFilterChange = () => {
    currentFilter = filterSelect.value as GraphFilterType;
    filterNodes(currentFilter);
  };

  const onSearchInput = () => {
    const term = searchInput?.value ?? '';
    if (term.trim()) {
      searchNodes(term);
    } else {
      clearSearchHighlights();
    }
  };

  const onClearSearch = () => {
    if (searchInput) searchInput.value = '';
    clearSearchHighlights();
  };

  const onZoomIn = () => zoomBy(1.2);
  const onZoomOut = () => zoomBy(0.8);
  const onFit = () => fitToView();
  const onReset = () => resetView();

  const onExport = async () => {
    try {
      const blob = await exportGraph({ format: 'png' as GraphExportFormat, scale: 2 });
      if (blob instanceof Blob) {
        downloadBlob(blob, 'graph-export.png');
      }
    } catch (err) {
      console.error('[GraphControls] Export failed:', err);
    }
  };

  // Attach listeners
  layoutSelect.addEventListener('change', onLayoutChange);
  filterSelect.addEventListener('change', onFilterChange);
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onClearSearch();
  });
  clearBtn.addEventListener('click', onClearSearch);
  zoomInBtn.addEventListener('click', onZoomIn);
  zoomOutBtn.addEventListener('click', onZoomOut);
  fitBtn.addEventListener('click', onFit);
  resetBtn.addEventListener('click', onReset);
  exportBtn.addEventListener('click', onExport);

  // Return cleanup function
  return () => {
    layoutSelect.removeEventListener('change', onLayoutChange);
    filterSelect.removeEventListener('change', onFilterChange);
    searchInput?.removeEventListener('input', onSearchInput);
    clearBtn.removeEventListener('click', onClearSearch);
    zoomInBtn.removeEventListener('click', onZoomIn);
    zoomOutBtn.removeEventListener('click', onZoomOut);
    fitBtn.removeEventListener('click', onFit);
    resetBtn.removeEventListener('click', onReset);
    exportBtn.removeEventListener('click', onExport);
    toolbar.remove();
    searchInput = null;
  };
}

/** Create a labeled control group wrapper. */
function createControlGroup(label: string): HTMLElement {
  const group = document.createElement('div');
  group.style.cssText = 'display:flex;align-items:center;gap:4px;';
  if (label) {
    const lbl = document.createElement('span');
    lbl.textContent = label + ':';
    lbl.style.cssText = 'color:var(--text-secondary, #94a3b8);font-weight:500;';
    group.appendChild(lbl);
  }
  return group;
}

/** Create a styled button. */
function createButton(text: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.title = title;
  btn.style.cssText = `
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #334155);
    background: var(--bg-input, #0f172a);
    color: var(--text-primary, #e2e8f0);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
  `;
  return btn;
}

/** Shared select element styling. */
function selectStyle(): string {
  return `
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #334155);
    background: var(--bg-input, #0f172a);
    color: var(--text-primary, #e2e8f0);
    font-size: 12px;
    outline: none;
    cursor: pointer;
  `;
}

/** Trigger a file download for a Blob. */
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
