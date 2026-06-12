/**
 * Graph core — Cytoscape initialization and graph rendering.
 *
 * IMPORTANT: This module is lazy-loaded. Cytoscape is NOT imported or initialized
 * until the user explicitly opens the graph panel. No background or anticipatory
 * loading occurs (Requirement 16.5).
 */

import type {
  GraphData,
  GraphNode,
  GraphLayoutName,
  GraphFilterType,
  GraphExportOptions,
} from './types';

/**
 * Cytoscape type reference — loaded dynamically at runtime.
 * We use `any` here because the actual type comes from the globally loaded library.
 */
type CytoscapeInstance = {
  nodes: (selector?: string) => CytoscapeCollection;
  edges: (selector?: string) => CytoscapeCollection;
  elements: () => CytoscapeCollection;
  layout: (options: Record<string, unknown>) => { run: () => void };
  fit: (eles?: unknown, padding?: number) => void;
  zoom: (level?: number) => number | void;
  pan: (pos?: { x: number; y: number }) => { x: number; y: number } | void;
  png: (options?: Record<string, unknown>) => Blob;
  svg: (options?: Record<string, unknown>) => string;
  destroy: () => void;
  on: (event: string, selector: string | ((evt: unknown) => void), handler?: (evt: unknown) => void) => void;
  resize: () => void;
};

type CytoscapeCollection = {
  length: number;
  show: () => void;
  hide: () => void;
  filter: (selector: string | ((ele: unknown) => boolean)) => CytoscapeCollection;
  addClass: (classes: string) => CytoscapeCollection;
  removeClass: (classes: string) => CytoscapeCollection;
  connectedEdges: () => CytoscapeCollection;
  connectedNodes: () => CytoscapeCollection;
  union: (other: CytoscapeCollection) => CytoscapeCollection;
};

type CytoscapeFactory = (options: Record<string, unknown>) => CytoscapeInstance;

/** Current Cytoscape instance — null until the panel is mounted and initialized. */
let cytoscapeInstance: CytoscapeInstance | null = null;

/** Whether the Cytoscape library has been loaded. */
let cytoscapeLoaded = false;

/**
 * Dynamically load the Cytoscape library.
 * This defers all Cytoscape code until user action (Requirement 16.5).
 *
 * The library is loaded from the global `window.cytoscape` which is made available
 * via script tags in index.html, but only accessed when this function is called.
 */
async function loadCytoscapeLibrary(): Promise<CytoscapeFactory> {
  if (cytoscapeLoaded) {
    const cy = (window as unknown as { cytoscape: CytoscapeFactory }).cytoscape;
    if (!cy) {
      throw new Error('Cytoscape library not available on window after previous load');
    }
    return cy;
  }

  // Access the globally-loaded Cytoscape (from script tag in index.html)
  const cytoscape = (window as unknown as { cytoscape?: CytoscapeFactory }).cytoscape;
  if (!cytoscape) {
    throw new Error(
      'Cytoscape.js library not available. Ensure cytoscape.min.js is loaded in index.html.'
    );
  }

  cytoscapeLoaded = true;
  return cytoscape;
}

/**
 * Convert internal GraphData to Cytoscape elements format.
 */
function convertToCytoscapeElements(
  graphData: GraphData
): Array<{ group: 'nodes' | 'edges'; data: Record<string, unknown>; classes?: string }> {
  const elements: Array<{
    group: 'nodes' | 'edges';
    data: Record<string, unknown>;
    classes?: string;
  }> = [];

  // Convert nodes
  for (const node of graphData.nodes) {
    const classes = buildNodeClasses(node);
    elements.push({
      group: 'nodes',
      data: {
        id: node.id,
        label: node.label,
        type: node.type,
        filePath: node.filePath ?? '',
        lineNumber: node.lineNumber ?? 0,
        ...spreadMetadata(node.metadata),
      },
      classes,
    });
  }

  // Convert edges
  for (const edge of graphData.edges) {
    elements.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        label: edge.label ?? edge.type,
        weight: edge.weight ?? 1,
      },
    });
  }

  return elements;
}

/** Build CSS class string for a node based on its type and metadata. */
function buildNodeClasses(node: GraphNode): string {
  const classes: string[] = [node.type];

  // Mark "god nodes" — files with high complexity or many connections
  if (node.metadata?.['lineCount'] && (node.metadata['lineCount'] as number) > 1000) {
    classes.push('god-node');
  }

  return classes.join(' ');
}

/** Safely spread metadata into a flat object for Cytoscape data. */
function spreadMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

/** Default stylesheet for the graph visualization. */
function getDefaultStylesheet(): Array<{ selector: string; style: Record<string, unknown> }> {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '10px',
        'background-color': '#6366f1',
        color: '#e2e8f0',
        width: 30,
        height: 30,
        'text-wrap': 'ellipsis',
        'text-max-width': '80px',
      },
    },
    {
      selector: 'node.file',
      style: { 'background-color': '#3b82f6', shape: 'round-rectangle' },
    },
    {
      selector: 'node.function',
      style: { 'background-color': '#10b981', shape: 'ellipse' },
    },
    {
      selector: 'node.class',
      style: { 'background-color': '#f59e0b', shape: 'diamond' },
    },
    {
      selector: 'node.variable',
      style: { 'background-color': '#8b5cf6', shape: 'ellipse', width: 20, height: 20 },
    },
    {
      selector: 'node.component',
      style: { 'background-color': '#ec4899', shape: 'hexagon' },
    },
    {
      selector: 'node.god-node',
      style: {
        'background-color': '#ef4444',
        'border-width': 3,
        'border-color': '#fca5a5',
        width: 50,
        height: 50,
      },
    },
    {
      selector: 'node.search-highlight',
      style: {
        'border-width': 4,
        'border-color': '#facc15',
        'background-color': '#fbbf24',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': '#475569',
        'target-arrow-color': '#475569',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'font-size': '8px',
        color: '#94a3b8',
      },
    },
    {
      selector: 'edge[type="imports"]',
      style: { 'line-color': '#3b82f6', 'target-arrow-color': '#3b82f6' },
    },
    {
      selector: 'edge[type="calls"]',
      style: { 'line-color': '#10b981', 'target-arrow-color': '#10b981' },
    },
    {
      selector: 'edge[type="extends"]',
      style: {
        'line-color': '#f59e0b',
        'target-arrow-color': '#f59e0b',
        'line-style': 'dashed',
      },
    },
  ];
}

/**
 * Initialize the Cytoscape graph instance inside the given container.
 * This is only called when the user opens the graph panel — never before.
 */
export async function initializeGraph(
  container: HTMLElement,
  graphData: GraphData
): Promise<CytoscapeInstance> {
  const cytoscape = await loadCytoscapeLibrary();

  // Destroy any previous instance
  if (cytoscapeInstance) {
    cytoscapeInstance.destroy();
    cytoscapeInstance = null;
  }

  const elements = convertToCytoscapeElements(graphData);

  const cy = cytoscape({
    container,
    elements,
    style: getDefaultStylesheet(),
    layout: { name: 'cose', animate: false, fit: true, padding: 50 },
    minZoom: 0.1,
    maxZoom: 5,
    wheelSensitivity: 0.3,
  }) as unknown as CytoscapeInstance;

  cytoscapeInstance = cy;

  // Set up interaction event listeners
  setupEventListeners(cy);

  return cy;
}

/** Set up user interaction event listeners on the Cytoscape instance. */
function setupEventListeners(cy: CytoscapeInstance): void {
  cy.on('mouseover', 'node', (event: unknown) => {
    const node = (event as { target: { style: (prop: string, value: unknown) => void } }).target;
    node.style('opacity', 0.8);
  });

  cy.on('mouseout', 'node', (event: unknown) => {
    const node = (event as { target: { style: (prop: string, value: unknown) => void } }).target;
    node.style('opacity', 1);
  });
}

/**
 * Apply a layout algorithm to the current graph.
 */
export function applyLayout(layoutName: GraphLayoutName, options?: Record<string, unknown>): void {
  if (!cytoscapeInstance) return;

  const layoutOptions: Record<string, unknown> = {
    name: layoutName,
    animate: true,
    animationDuration: 500,
    fit: true,
    padding: 50,
    ...options,
  };

  // Layout-specific defaults
  switch (layoutName) {
    case 'cose':
      Object.assign(layoutOptions, {
        idealEdgeLength: 100,
        nodeOverlap: 20,
        nodeRepulsion: 400000,
      });
      break;
    case 'dagre':
      Object.assign(layoutOptions, { rankDir: 'TB', spacingFactor: 1.5 });
      break;
    case 'breadthfirst':
      Object.assign(layoutOptions, { directed: true, spacingFactor: 1.5 });
      break;
    case 'circle':
      Object.assign(layoutOptions, { startAngle: -Math.PI / 2, clockwise: true });
      break;
    case 'grid':
      Object.assign(layoutOptions, { condense: true });
      break;
    default:
      break;
  }

  const layout = cytoscapeInstance.layout(layoutOptions);
  layout.run();
}

/**
 * Filter graph nodes by category.
 */
export function filterNodes(filterType: GraphFilterType): void {
  if (!cytoscapeInstance) return;

  // Show everything first
  cytoscapeInstance.elements().show();

  if (filterType === 'all') return;

  // Determine which nodes to show
  let visibleNodes: CytoscapeCollection;

  switch (filterType) {
    case 'god-nodes':
      visibleNodes = cytoscapeInstance.nodes('.god-node');
      break;
    case 'functions':
      visibleNodes = cytoscapeInstance.nodes('.function');
      break;
    case 'classes':
      visibleNodes = cytoscapeInstance.nodes('.class');
      break;
    case 'files':
      visibleNodes = cytoscapeInstance.nodes('.file');
      break;
    case 'components':
      visibleNodes = cytoscapeInstance.nodes('.component');
      break;
    default:
      return;
  }

  // Hide everything, then show only matching nodes and their connections
  cytoscapeInstance.elements().hide();
  const connected = visibleNodes.union(visibleNodes.connectedEdges()).union(
    visibleNodes.connectedEdges().connectedNodes()
  );
  connected.show();
}

/**
 * Search for nodes matching a term and highlight them.
 */
export function searchNodes(searchTerm: string): number {
  if (!cytoscapeInstance || !searchTerm.trim()) return 0;

  // Clear previous highlights
  cytoscapeInstance.nodes().removeClass('search-highlight');

  const term = searchTerm.toLowerCase();
  const matching = cytoscapeInstance.nodes().filter((node: unknown) => {
    const label = ((node as { data: (key: string) => string }).data('label') ?? '').toLowerCase();
    return label.includes(term);
  });

  if (matching.length > 0) {
    matching.addClass('search-highlight');
    cytoscapeInstance.fit(matching, 100);
  }

  return matching.length;
}

/**
 * Clear all search highlights.
 */
export function clearSearchHighlights(): void {
  if (!cytoscapeInstance) return;
  cytoscapeInstance.nodes().removeClass('search-highlight');
}

/**
 * Fit the entire graph into view.
 */
export function fitToView(padding = 50): void {
  if (!cytoscapeInstance) return;
  cytoscapeInstance.fit(undefined, padding);
}

/**
 * Reset zoom and pan to defaults, then fit.
 */
export function resetView(): void {
  if (!cytoscapeInstance) return;
  cytoscapeInstance.zoom(1);
  cytoscapeInstance.pan({ x: 0, y: 0 });
  fitToView();
}

/**
 * Zoom in or out by a factor.
 */
export function zoomBy(factor: number): void {
  if (!cytoscapeInstance) return;
  const currentZoom = cytoscapeInstance.zoom() as number;
  cytoscapeInstance.zoom(currentZoom * factor);
}

/**
 * Export the graph as an image.
 */
export async function exportGraph(options: GraphExportOptions): Promise<Blob | string> {
  if (!cytoscapeInstance) {
    throw new Error('No graph instance available for export');
  }

  const exportOpts: Record<string, unknown> = {
    bg: options.background ?? '#1e1e2e',
    full: options.fullGraph ?? true,
    scale: options.scale ?? 2,
    maxWidth: 4000,
    maxHeight: 4000,
  };

  if (options.format === 'svg') {
    return cytoscapeInstance.svg(exportOpts);
  }

  exportOpts['output'] = 'blob';
  return cytoscapeInstance.png(exportOpts);
}

/**
 * Get the current Cytoscape instance (for advanced usage by controls).
 */
export function getCytoscapeInstance(): CytoscapeInstance | null {
  return cytoscapeInstance;
}

/**
 * Destroy the Cytoscape instance and release resources.
 */
export function destroyGraph(): void {
  if (cytoscapeInstance) {
    cytoscapeInstance.destroy();
    cytoscapeInstance = null;
  }
}

/**
 * Resize the graph to fit its container (e.g., after panel resize).
 */
export function resizeGraph(): void {
  if (cytoscapeInstance) {
    cytoscapeInstance.resize();
    cytoscapeInstance.fit(undefined, 50);
  }
}
