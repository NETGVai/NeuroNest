/**
 * Graph Visualization System
 * 
 * Provides complete Cytoscape.js integration for interactive knowledge graph visualization
 * with multiple layout algorithms, zoom controls, and node/edge interactions.
 */

import { ProjectGraph, GraphNode, GraphEdge } from '../graph/graph-manager';

// Global reference to current Cytoscape instance
let currentCytoscapeInstance: any = null;

export interface LayoutOptions {
  name: string;
  animate?: boolean;
  animationDuration?: number;
  fit?: boolean;
  padding?: number;
}

export interface VisualizationConfig {
  container: HTMLElement;
  layout: string;
  style?: any[];
  zoom?: number;
  pan?: { x: number; y: number };
}

/**
 * Initialize Cytoscape with proper configuration and styling
 */
export function initializeCytoscape(container: HTMLElement, graphData: ProjectGraph): any {
  // Check if Cytoscape is available
  if (typeof (window as any).cytoscape === 'undefined') {
    console.error('[GraphViz] Cytoscape.js not loaded');
    throw new Error('Cytoscape.js library not available');
  }

  const cytoscape = (window as any).cytoscape;

  // Convert graph data to Cytoscape format
  const elements = convertGraphDataToCytoscape(graphData);

  // Define node and edge styles
  const stylesheet = [
    // Node styles
    {
      selector: 'node',
      style: {
        'background-color': '#3b82f6',
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '12px',
        'font-family': 'system-ui, -apple-system, sans-serif',
        'color': '#ffffff',
        'text-outline-width': 2,
        'text-outline-color': '#1e40af',
        'width': 'mapData(degree, 1, 20, 30, 80)',
        'height': 'mapData(degree, 1, 20, 30, 80)',
        'border-width': 2,
        'border-color': '#1e40af',
        'cursor': 'pointer'
      }
    },
    // Code file nodes
    {
      selector: 'node[file_type = \"code\"]',
      style: {
        'background-color': '#3b82f6',
        'shape': 'round-rectangle',
        'border-color': '#1e40af'
      }
    },
    // Document nodes
    {
      selector: 'node[file_type = \"document\"]',
      style: {
        'background-color': '#10b981',
        'shape': 'round-tag',
        'border-color': '#047857'
      }
    },
    // Function/method nodes
    {
      selector: 'node.function',
      style: {
        'background-color': '#f59e0b',
        'shape': 'ellipse',
        'border-color': '#d97706'
      }
    },
    // Class nodes
    {
      selector: 'node.class',
      style: {
        'background-color': '#8b5cf6',
        'shape': 'round-rectangle',
        'border-color': '#7c3aed'
      }
    },
    // God nodes (highly connected)
    {
      selector: 'node.god-node',
      style: {
        'background-color': '#ef4444',
        'border-color': '#dc2626',
        'border-width': 4,
        'text-outline-color': '#dc2626'
      }
    },
    // Edge styles
    {
      selector: 'edge',
      style: {
        'width': 2,
        'line-color': '#6b7280',
        'target-arrow-color': '#6b7280',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 1.2,
        'opacity': 0.7
      }
    },
    // Import relationships
    {
      selector: 'edge[relation = \"imports\"]',
      style: {
        'line-color': '#8b5cf6',
        'target-arrow-color': '#8b5cf6',
        'width': 3
      }
    },
    // Contains relationships
    {
      selector: 'edge[relation = \"contains\"]',
      style: {
        'line-color': '#f59e0b',
        'target-arrow-color': '#f59e0b',
        'line-style': 'dashed'
      }
    },
    // Calls relationships
    {
      selector: 'edge[relation = \"calls\"]',
      style: {
        'line-color': '#10b981',
        'target-arrow-color': '#10b981'
      }
    },
    // Selected nodes
    {
      selector: 'node:selected',
      style: {
        'border-width': 4,
        'border-color': '#fbbf24',
        'background-color': '#f59e0b'
      }
    },
    // Highlighted nodes (on hover)
    {
      selector: 'node.highlighted',
      style: {
        'border-width': 3,
        'border-color': '#fbbf24',
        'z-index': 10
      }
    },
    // Highlighted edges
    {
      selector: 'edge.highlighted',
      style: {
        'width': 4,
        'opacity': 1,
        'z-index': 10
      }
    }
  ];

  // Create Cytoscape instance
  const cy = cytoscape({
    container: container,
    elements: elements,
    style: stylesheet,
    layout: {
      name: 'fcose',
      animate: true,
      animationDuration: 1000,
      fit: true,
      padding: 50,
      randomize: false,
      nodeRepulsion: 4500,
      idealEdgeLength: 50,
      edgeElasticity: 0.45,
      nestingFactor: 0.1,
      gravity: 0.25,
      numIter: 2500,
      tile: true,
      tilingPaddingVertical: 10,
      tilingPaddingHorizontal: 10
    },
    zoom: 1,
    pan: { x: 0, y: 0 },
    minZoom: 0.1,
    maxZoom: 3,
    wheelSensitivity: 0.2,
    boxSelectionEnabled: true,
    selectionType: 'single'
  });

  // Set up event listeners
  setupCytoscapeEventListeners(cy, graphData);

  // Store reference
  currentCytoscapeInstance = cy;

  return cy;
}

/**
 * Convert ProjectGraph data to Cytoscape elements format
 */
function convertGraphDataToCytoscape(graphData: ProjectGraph): any[] {
  const elements: any[] = [];

  // Add nodes
  graphData.nodes.forEach(node => {
    const element = {
      data: {
        id: node.id,
        label: node.label,
        file_type: node.file_type,
        source_file: node.source_file,
        source_location: node.source_location,
        community: node.community,
        degree: calculateNodeDegree(node.id, graphData.edges)
      },
      classes: getNodeClasses(node, graphData)
    };

    elements.push(element);
  });

  // Add edges
  graphData.edges.forEach((edge, index) => {
    const element = {
      data: {
        id: `edge-${index}`,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        confidence: edge.confidence,
        weight: edge.weight,
        source_file: edge.source_file,
        source_location: edge.source_location
      },
      classes: edge.relation
    };

    elements.push(element);
  });

  return elements;
}

/**
 * Calculate node degree (number of connections)
 */
function calculateNodeDegree(nodeId: string, edges: GraphEdge[]): number {
  return edges.filter(edge => edge.source === nodeId || edge.target === nodeId).length;
}

/**
 * Get CSS classes for a node based on its properties
 */
function getNodeClasses(node: GraphNode, graphData: ProjectGraph): string {
  const classes: string[] = [];

  // Add file type class
  if (node.file_type) {
    classes.push(node.file_type);
  }

  // Add node type classes based on label patterns
  if (node.label.includes('()') || node.label.includes('function')) {
    classes.push('function');
  } else if (node.label.includes('class ') || node.label.includes('Class')) {
    classes.push('class');
  }

  // Add god node class if this node is highly connected
  if (graphData.godNodes && graphData.godNodes.includes(node.id)) {
    classes.push('god-node');
  }

  return classes.join(' ');
}

/**
 * Set up event listeners for Cytoscape interactions
 */
function setupCytoscapeEventListeners(cy: any, graphData: ProjectGraph): void {
  // Node hover effects
  cy.on('mouseover', 'node', function(event: any) {
    const node = event.target;
    const connectedEdges = node.connectedEdges();
    const connectedNodes = connectedEdges.connectedNodes();

    // Highlight the node and its connections
    node.addClass('highlighted');
    connectedEdges.addClass('highlighted');
    connectedNodes.addClass('highlighted');
  });

  cy.on('mouseout', 'node', function(event: any) {
    const node = event.target;
    const connectedEdges = node.connectedEdges();
    const connectedNodes = connectedEdges.connectedNodes();

    // Remove highlights
    node.removeClass('highlighted');
    connectedEdges.removeClass('highlighted');
    connectedNodes.removeClass('highlighted');
  });

  // Node click handler
  cy.on('tap', 'node', function(event: any) {
    const node = event.target;
    const nodeData = node.data();
    
    console.log('[GraphViz] Node clicked:', nodeData);
    
    // Show node details
    showNodeDetails(nodeData);
  });

  // Edge click handler
  cy.on('tap', 'edge', function(event: any) {
    const edge = event.target;
    const edgeData = edge.data();
    
    console.log('[GraphViz] Edge clicked:', edgeData);
    
    // Show edge details
    showEdgeDetails(edgeData);
  });

  // Background click handler (deselect)
  cy.on('tap', function(event: any) {
    if (event.target === cy) {
      cy.$(':selected').unselect();
    }
  });

  // Zoom and pan limits
  cy.on('zoom', function() {
    const zoom = cy.zoom();
    if (zoom < 0.1) {
      cy.zoom(0.1);
    } else if (zoom > 3) {
      cy.zoom(3);
    }
  });
}

/**
 * Show detailed information about a node in a themed panel
 */
function showNodeDetails(nodeData: any): void {
  // Remove any existing detail panel
  const existing = document.getElementById('nn-graph-detail-panel');
  if (existing) existing.remove();

  const fileType = nodeData.file_type || 'unknown';
  const icon = fileType === 'code' ? '💻' : fileType === 'document' ? '📄' : fileType === 'image' ? '🖼️' : '📋';
  const confColors: Record<string, string> = { EXTRACTED: '#a6e3a1', INFERRED: '#f9e2af', AMBIGUOUS: '#f38ba8' };
  const degree = nodeData.degree || 0;
  const isGodNode = degree >= 5;

  const panel = document.createElement('div');
  panel.id = 'nn-graph-detail-panel';
  panel.style.cssText = 'position:fixed;top:50%;right:24px;transform:translateY(-50%);width:320px;max-height:80vh;overflow-y:auto;background:var(--bg-sidebar,#1e1e2e);border:1px solid var(--border-color,#45475a);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);z-index:9999;font-family:inherit;color:#cdd6f4;';

  let html = '<div style="padding:16px 16px 0;">';
  // Header with close button
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">';
  html += '<div style="display:flex;align-items:center;gap:8px;">';
  html += '<span style="font-size:28px;">' + icon + '</span>';
  html += '<div>';
  html += '<div style="font-size:15px;font-weight:600;color:#cdd6f4;word-break:break-word;">' + (nodeData.label || nodeData.id) + '</div>';
  if (isGodNode) html += '<span style="font-size:9px;background:#89b4fa;color:#1e1e2e;padding:2px 6px;border-radius:4px;font-weight:700;margin-top:2px;display:inline-block;">GOD NODE</span>';
  html += '</div></div>';
  html += '<button id="nn-graph-detail-close" style="background:none;border:none;color:#a6adc8;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">✕</button>';
  html += '</div>';

  // Stats row
  html += '<div style="display:flex;gap:8px;margin-bottom:14px;">';
  html += '<div style="flex:1;background:#313244;border-radius:8px;padding:8px;text-align:center;">';
  html += '<div style="font-size:18px;font-weight:700;color:#89b4fa;">' + degree + '</div>';
  html += '<div style="font-size:9px;color:#a6adc8;">Connections</div></div>';
  const communityLabel = nodeData.community !== undefined ? nodeData.community : '—';
  html += '<div style="flex:1;background:#313244;border-radius:8px;padding:8px;text-align:center;">';
  html += '<div style="font-size:18px;font-weight:700;color:#a6e3a1;">' + communityLabel + '</div>';
  html += '<div style="font-size:9px;color:#a6adc8;">Community</div></div>';
  html += '<div style="flex:1;background:#313244;border-radius:8px;padding:8px;text-align:center;">';
  html += '<div style="font-size:14px;font-weight:600;color:#cba6f7;">' + (fileType.charAt(0).toUpperCase() + fileType.slice(1)) + '</div>';
  html += '<div style="font-size:9px;color:#a6adc8;">Type</div></div>';
  html += '</div>';

  // Details
  html += '<div style="background:#313244;border-radius:8px;padding:12px;margin-bottom:14px;">';
  if (nodeData.source_file) {
    html += '<div style="margin-bottom:8px;"><span style="font-size:10px;color:#a6adc8;display:block;margin-bottom:2px;">Source File</span>';
    html += '<span style="font-size:12px;color:#89b4fa;font-family:\'SF Mono\',Menlo,monospace;word-break:break-all;">' + nodeData.source_file + '</span></div>';
  }
  if (nodeData.source_location) {
    html += '<div><span style="font-size:10px;color:#a6adc8;display:block;margin-bottom:2px;">Location</span>';
    html += '<span style="font-size:12px;color:#cdd6f4;font-family:\'SF Mono\',Menlo,monospace;">' + nodeData.source_location + '</span></div>';
  }
  if (!nodeData.source_file && !nodeData.source_location) {
    html += '<div style="font-size:11px;color:#a6adc8;font-style:italic;">No source location available</div>';
  }
  html += '</div>';

  html += '</div>';
  panel.innerHTML = html;
  document.body.appendChild(panel);

  // Close handler
  const closeBtn = document.getElementById('nn-graph-detail-close');
  if (closeBtn) closeBtn.addEventListener('click', () => panel.remove());
  // Close on outside click
  const outsideHandler = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node)) { panel.remove(); document.removeEventListener('mousedown', outsideHandler); }
  };
  setTimeout(() => document.addEventListener('mousedown', outsideHandler), 100);
}

/**
 * Show detailed information about an edge in a themed panel
 */
function showEdgeDetails(edgeData: any): void {
  const existing = document.getElementById('nn-graph-detail-panel');
  if (existing) existing.remove();

  const confColors: Record<string, string> = { EXTRACTED: '#a6e3a1', INFERRED: '#f9e2af', AMBIGUOUS: '#f38ba8' };
  const confColor = confColors[edgeData.confidence] || '#a6adc8';
  const confDescs: Record<string, string> = { EXTRACTED: 'Explicitly found in source', INFERRED: 'Reasonably deduced', AMBIGUOUS: 'Uncertain — needs review' };

  const panel = document.createElement('div');
  panel.id = 'nn-graph-detail-panel';
  panel.style.cssText = 'position:fixed;top:50%;right:24px;transform:translateY(-50%);width:320px;max-height:80vh;overflow-y:auto;background:var(--bg-sidebar,#1e1e2e);border:1px solid var(--border-color,#45475a);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);z-index:9999;font-family:inherit;color:#cdd6f4;';

  let html = '<div style="padding:16px;">';
  // Header
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">';
  html += '<div style="display:flex;align-items:center;gap:8px;">';
  html += '<span style="font-size:24px;">🔗</span>';
  html += '<div style="font-size:15px;font-weight:600;color:#cdd6f4;">Relationship</div>';
  html += '</div>';
  html += '<button id="nn-graph-detail-close" style="background:none;border:none;color:#a6adc8;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">✕</button>';
  html += '</div>';

  // Relationship visual
  html += '<div style="background:#313244;border-radius:8px;padding:14px;margin-bottom:14px;text-align:center;">';
  html += '<div style="font-size:12px;color:#cdd6f4;font-weight:500;margin-bottom:6px;">' + (edgeData.sourceLabel || edgeData.source || '?') + '</div>';
  html += '<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin:8px 0;">';
  html += '<div style="flex:1;height:1px;background:#45475a;"></div>';
  html += '<span style="font-size:11px;color:#89b4fa;background:#1e1e2e;padding:3px 10px;border-radius:4px;border:1px solid #45475a;white-space:nowrap;">' + (edgeData.relation || 'related') + '</span>';
  html += '<div style="flex:1;height:1px;background:#45475a;"></div>';
  html += '</div>';
  html += '<div style="font-size:12px;color:#cdd6f4;font-weight:500;margin-top:6px;">' + (edgeData.targetLabel || edgeData.target || '?') + '</div>';
  html += '</div>';

  // Confidence badge
  html += '<div style="background:#313244;border-radius:8px;padding:12px;margin-bottom:14px;border-left:3px solid ' + confColor + ';">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
  html += '<span style="font-size:10px;color:#a6adc8;">Confidence</span>';
  html += '<span style="font-size:12px;font-weight:700;color:' + confColor + ';">' + (edgeData.confidence || 'EXTRACTED') + '</span>';
  html += '</div>';
  html += '<div style="font-size:10px;color:#a6adc8;margin-top:4px;">' + (confDescs[edgeData.confidence] || '') + '</div>';
  html += '</div>';

  // Source info
  if (edgeData.source_file || edgeData.source_location) {
    html += '<div style="background:#313244;border-radius:8px;padding:12px;">';
    if (edgeData.source_file) {
      html += '<div style="margin-bottom:6px;"><span style="font-size:10px;color:#a6adc8;display:block;margin-bottom:2px;">Source File</span>';
      html += '<span style="font-size:11px;color:#89b4fa;font-family:\'SF Mono\',Menlo,monospace;">' + edgeData.source_file + '</span></div>';
    }
    if (edgeData.source_location) {
      html += '<div><span style="font-size:10px;color:#a6adc8;display:block;margin-bottom:2px;">Location</span>';
      html += '<span style="font-size:11px;color:#cdd6f4;font-family:\'SF Mono\',Menlo,monospace;">' + edgeData.source_location + '</span></div>';
    }
    html += '</div>';
  }

  html += '</div>';
  panel.innerHTML = html;
  document.body.appendChild(panel);

  const closeBtn = document.getElementById('nn-graph-detail-close');
  if (closeBtn) closeBtn.addEventListener('click', () => panel.remove());
  const outsideHandler = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node)) { panel.remove(); document.removeEventListener('mousedown', outsideHandler); }
  };
  setTimeout(() => document.addEventListener('mousedown', outsideHandler), 100);
}

/**
 * Apply a layout to the graph
 */
export function applyGraphLayout(layoutName: string, options: Partial<LayoutOptions> = {}): void {
  if (!currentCytoscapeInstance) {
    console.error('[GraphViz] No Cytoscape instance available');
    return;
  }

  const defaultOptions = {
    animate: true,
    animationDuration: 1000,
    fit: true,
    padding: 50
  };

  const layoutOptions = { ...defaultOptions, ...options, name: layoutName };

  // Apply layout-specific options
  switch (layoutName) {
    case 'fcose':
      Object.assign(layoutOptions, {
        randomize: false,
        nodeRepulsion: 4500,
        idealEdgeLength: 50,
        edgeElasticity: 0.45,
        nestingFactor: 0.1,
        gravity: 0.25,
        numIter: 2500,
        tile: true
      });
      break;
    
    case 'cola':
      Object.assign(layoutOptions, {
        randomize: false,
        maxSimulationTime: 4000,
        ungrabifyWhileSimulating: false,
        fit: true,
        edgeLength: 80,
        nodeSpacing: 10
      });
      break;
    
    case 'dagre':
      Object.assign(layoutOptions, {
        rankDir: 'TB',
        ranker: 'longest-path',
        nodeSep: 50,
        edgeSep: 10,
        rankSep: 100
      });
      break;
    
    case 'circle':
      Object.assign(layoutOptions, {
        radius: Math.min(400, Math.max(200, currentCytoscapeInstance.nodes().length * 10)),
        startAngle: -Math.PI / 2,
        clockwise: true
      });
      break;
    
    case 'grid':
      Object.assign(layoutOptions, {
        rows: Math.ceil(Math.sqrt(currentCytoscapeInstance.nodes().length)),
        cols: Math.ceil(Math.sqrt(currentCytoscapeInstance.nodes().length))
      });
      break;
    
    case 'breadthfirst':
      Object.assign(layoutOptions, {
        directed: true,
        roots: currentCytoscapeInstance.nodes().filter('[indegree = 0]'),
        spacingFactor: 1.5
      });
      break;
  }

  console.log(`[GraphViz] Applying ${layoutName} layout`);
  
  const layout = currentCytoscapeInstance.layout(layoutOptions);
  layout.run();
}

/**
 * Fit the graph to the viewport
 */
export function fitGraphToView(padding: number = 50): void {
  if (!currentCytoscapeInstance) {
    return;
  }
  
  currentCytoscapeInstance.fit(undefined, padding);
}

/**
 * Reset zoom and pan to default
 */
export function resetGraphView(): void {
  if (!currentCytoscapeInstance) {
    return;
  }
  
  currentCytoscapeInstance.zoom(1);
  currentCytoscapeInstance.pan({ x: 0, y: 0 });
  fitGraphToView();
}

/**
 * Filter graph nodes based on criteria
 */
export function filterGraphNodes(filterType: string): void {
  if (!currentCytoscapeInstance) {
    return;
  }

  // Show all nodes first
  currentCytoscapeInstance.nodes().show();
  currentCytoscapeInstance.edges().show();

  switch (filterType) {
    case 'god-nodes':
      // Show only god nodes and their connections
      const godNodes = currentCytoscapeInstance.nodes('.god-node');
      const connectedElements = godNodes.union(godNodes.connectedEdges()).union(godNodes.connectedEdges().connectedNodes());
      currentCytoscapeInstance.elements().hide();
      connectedElements.show();
      break;
    
    case 'functions':
      // Show only function nodes
      const functionNodes = currentCytoscapeInstance.nodes('.function');
      const functionConnections = functionNodes.union(functionNodes.connectedEdges());
      currentCytoscapeInstance.elements().hide();
      functionConnections.show();
      break;
    
    case 'classes':
      // Show only class nodes
      const classNodes = currentCytoscapeInstance.nodes('.class');
      const classConnections = classNodes.union(classNodes.connectedEdges());
      currentCytoscapeInstance.elements().hide();
      classConnections.show();
      break;
    
    case 'files':
      // Show only file nodes
      const fileNodes = currentCytoscapeInstance.nodes('[file_type = \"code\"], [file_type = \"document\"]');
      const fileConnections = fileNodes.union(fileNodes.connectedEdges());
      currentCytoscapeInstance.elements().hide();
      fileConnections.show();
      break;
    
    case 'all':
    default:
      // Show all elements
      currentCytoscapeInstance.elements().show();
      break;
  }

  // Fit to view after filtering
  fitGraphToView();
}

/**
 * Search and highlight nodes by label
 */
export function searchAndHighlightNodes(searchTerm: string): void {
  if (!currentCytoscapeInstance || !searchTerm.trim()) {
    return;
  }

  // Remove previous search highlights
  currentCytoscapeInstance.nodes().removeClass('search-highlight');

  // Find matching nodes
  const matchingNodes = currentCytoscapeInstance.nodes().filter(function(node: any) {
    const label = node.data('label').toLowerCase();
    return label.includes(searchTerm.toLowerCase());
  });

  if (matchingNodes.length > 0) {
    // Highlight matching nodes
    matchingNodes.addClass('search-highlight');
    
    // Fit to show highlighted nodes
    currentCytoscapeInstance.fit(matchingNodes, 100);
    
    console.log(`[GraphViz] Found ${matchingNodes.length} nodes matching "${searchTerm}"`);
  } else {
    console.log(`[GraphViz] No nodes found matching "${searchTerm}"`);
  }
}

/**
 * Export graph visualization as image
 */
export function exportGraphAsImage(format: 'png' | 'jpg' = 'png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!currentCytoscapeInstance) {
      reject(new Error('No Cytoscape instance available'));
      return;
    }

    try {
      const options = {
        output: 'blob',
        format: format,
        bg: '#ffffff',
        full: true,
        scale: 2
      };

      const blob = currentCytoscapeInstance.png(options);
      resolve(blob);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Get current Cytoscape instance
 */
export function getCurrentCytoscapeInstance(): any {
  return currentCytoscapeInstance;
}

/**
 * Main function to show graph visualization - replaces the missing function in index.ts
 */
export function showGraphVisualization(graphData: ProjectGraph): void {
  const vizEl = document.getElementById('graph-visualization');
  if (!vizEl) {
    console.error('[GraphViz] Graph visualization container not found');
    return;
  }

  try {
    // Clear any existing content
    vizEl.innerHTML = '';

    // Check if we have valid graph data
    if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
      vizEl.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);">
          <div style="text-align:center;">
            <div style="font-size:48px;margin-bottom:16px;">📊</div>
            <div>No graph data available</div>
            <div style="font-size:12px;margin-top:8px;">Generate a knowledge graph first</div>
          </div>
        </div>
      `;
      return;
    }

    // Set up container styling
    vizEl.style.width = '100%';
    vizEl.style.height = '100%';
    vizEl.style.position = 'relative';

    // Initialize Cytoscape
    const cy = initializeCytoscape(vizEl, graphData);
    
    console.log(`[GraphViz] Graph visualization created with ${graphData.nodes.length} nodes and ${graphData.edges.length} edges`);

  } catch (error) {
    console.error('[GraphViz] Error creating graph visualization:', error);
    
    vizEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);">
        <div style="text-align:center;">
          <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
          <div>Failed to create graph visualization</div>
          <div style="font-size:12px;margin-top:8px;">Error: ${error instanceof Error ? error.message : 'Unknown error'}</div>
        </div>
      </div>
    `;
  }
}