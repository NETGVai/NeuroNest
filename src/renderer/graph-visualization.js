/**
 * Graph Visualization System
 * 
 * Provides complete Cytoscape.js integration for interactive knowledge graph visualization
 * with multiple layout algorithms, zoom controls, and node/edge interactions.
 */

// Global reference to current Cytoscape instance
var currentCytoscapeInstance = null;

/**
 * Initialize Cytoscape with proper configuration and styling
 */
function initializeCytoscape(container, graphData) {
  console.log('[GraphViz] initializeCytoscape called with container:', container, 'graphData:', graphData);
  
  // Check if Cytoscape is available
  if (typeof window.cytoscape === 'undefined') {
    console.error('[GraphViz] Cytoscape.js not loaded');
    throw new Error('Cytoscape.js library not available');
  }

  console.log('[GraphViz] Cytoscape library found, version:', window.cytoscape.version || 'unknown');

  var cytoscape = window.cytoscape;

  // Convert graph data to Cytoscape format
  console.log('[GraphViz] Converting graph data to Cytoscape format...');
  var elements = convertGraphDataToCytoscape(graphData);
  console.log('[GraphViz] Converted to', elements.length, 'elements');

  // Ensure container is properly sized
  if (container.offsetWidth === 0 || container.offsetHeight === 0) {
    console.warn('[GraphViz] Container has zero dimensions, setting minimum size');
    container.style.width = '800px';
    container.style.height = '500px';
  }

  // Define node and edge styles
  var stylesheet = [
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
      selector: 'node[file_type = "code"]',
      style: {
        'background-color': '#3b82f6',
        'shape': 'round-rectangle',
        'border-color': '#1e40af'
      }
    },
    // Document nodes
    {
      selector: 'node[file_type = "document"]',
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
      selector: 'edge[relation = "imports"]',
      style: {
        'line-color': '#8b5cf6',
        'target-arrow-color': '#8b5cf6',
        'width': 3
      }
    },
    // Contains relationships
    {
      selector: 'edge[relation = "contains"]',
      style: {
        'line-color': '#f59e0b',
        'target-arrow-color': '#f59e0b',
        'line-style': 'dashed'
      }
    },
    // Calls relationships
    {
      selector: 'edge[relation = "calls"]',
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
    },
    // Search highlighted nodes
    {
      selector: 'node.search-highlight',
      style: {
        'border-width': 4,
        'border-color': '#f97316',
        'background-color': '#fb923c',
        'z-index': 15
      }
    }
  ];

  // Create Cytoscape instance with error handling
  console.log('[GraphViz] Creating Cytoscape instance with', elements.length, 'elements');
  console.log('[GraphViz] Stylesheet:', stylesheet);
  
  try {
    var cy = cytoscape({
      container: container,
      elements: elements,
      style: stylesheet,
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 1000,
        fit: true,
        padding: 50,
        randomize: false,
        nodeRepulsion: 400000,
        nodeOverlap: 10,
        idealEdgeLength: 100,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0
      },
      zoom: 1,
      pan: { x: 0, y: 0 },
      minZoom: 0.1,
      maxZoom: 3,
      wheelSensitivity: 0.2,
      boxSelectionEnabled: true,
      selectionType: 'single'
    });

    console.log('[GraphViz] Cytoscape instance created successfully:', cy);

    // Verify the instance was created properly
    if (!cy || typeof cy.nodes !== 'function') {
      throw new Error('Cytoscape instance creation failed - invalid instance');
    }

    // Debug: Check if nodes and edges are present and styled
    console.log('[GraphViz] Nodes count:', cy.nodes().length);
    console.log('[GraphViz] Edges count:', cy.edges().length);
    console.log('[GraphViz] First node style:', cy.nodes().length > 0 ? cy.nodes()[0].style() : 'No nodes');

    // Set up event listeners
    setupCytoscapeEventListeners(cy, graphData);

    // Store reference
    currentCytoscapeInstance = cy;

    // Force a layout after a short delay to ensure proper rendering
    setTimeout(function() {
      if (cy && typeof cy.fit === 'function') {
        cy.fit();
        console.log('[GraphViz] Applied fit layout');
      }
    }, 100);

    console.log('[GraphViz] Cytoscape initialization complete');
    return cy;
    
  } catch (cytoscapeError) {
    console.error('[GraphViz] Cytoscape creation error:', cytoscapeError);
    throw new Error('Failed to create Cytoscape instance: ' + (cytoscapeError.message || 'Unknown error'));
  }
}

/**
 * Convert ProjectGraph data to Cytoscape elements format
 */
function convertGraphDataToCytoscape(graphData) {
  var elements = [];

  // Validate nodes exist before creating edges
  var nodeIds = new Set();
  if (graphData.nodes) {
    graphData.nodes.forEach(function(node) {
      nodeIds.add(node.id);
    });
  }

  // Add nodes
  if (graphData.nodes) {
    graphData.nodes.forEach(function(node) {
      var element = {
        data: {
          id: node.id,
          label: node.label,
          file_type: node.file_type,
          source_file: node.source_file,
          source_location: node.source_location,
          community: node.community,
          degree: calculateNodeDegree(node.id, graphData.edges || [])
        },
        classes: getNodeClasses(node, graphData)
      };

      elements.push(element);
    });
  }

  // Add edges - only if both source and target nodes exist
  if (graphData.edges) {
    graphData.edges.forEach(function(edge, index) {
      // Check if both source and target nodes exist
      if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
        var element = {
          data: {
            id: 'edge-' + index,
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
      } else {
        console.warn('[GraphViz] Skipping edge with nonexistent nodes:', edge.source, '->', edge.target);
      }
    });
  }

  return elements;
}

/**
 * Calculate node degree (number of connections)
 */
function calculateNodeDegree(nodeId, edges) {
  if (!edges) return 0;
  return edges.filter(function(edge) {
    return edge.source === nodeId || edge.target === nodeId;
  }).length;
}

/**
 * Get CSS classes for a node based on its properties
 */
function getNodeClasses(node, graphData) {
  var classes = [];

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
function setupCytoscapeEventListeners(cy, graphData) {
  // Node hover effects
  cy.on('mouseover', 'node', function(event) {
    var node = event.target;
    var connectedEdges = node.connectedEdges();
    var connectedNodes = connectedEdges.connectedNodes();

    // Highlight the node and its connections
    node.addClass('highlighted');
    connectedEdges.addClass('highlighted');
    connectedNodes.addClass('highlighted');
  });

  cy.on('mouseout', 'node', function(event) {
    var node = event.target;
    var connectedEdges = node.connectedEdges();
    var connectedNodes = connectedEdges.connectedNodes();

    // Remove highlights
    node.removeClass('highlighted');
    connectedEdges.removeClass('highlighted');
    connectedNodes.removeClass('highlighted');
  });

  // Node click handler
  cy.on('tap', 'node', function(event) {
    var node = event.target;
    var nodeData = node.data();
    
    console.log('[GraphViz] Node clicked:', nodeData);
    
    // Show node details
    showNodeDetails(nodeData);
  });

  // Edge click handler
  cy.on('tap', 'edge', function(event) {
    var edge = event.target;
    var edgeData = edge.data();
    
    console.log('[GraphViz] Edge clicked:', edgeData);
    
    // Show edge details
    showEdgeDetails(edgeData);
  });

  // Background click handler (deselect)
  cy.on('tap', function(event) {
    if (event.target === cy) {
      cy.$(':selected').unselect();
    }
  });

  // Zoom and pan limits
  cy.on('zoom', function() {
    var zoom = cy.zoom();
    if (zoom < 0.1) {
      cy.zoom(0.1);
    } else if (zoom > 3) {
      cy.zoom(3);
    }
  });
}

/**
 * Show detailed information about a node
 */
function showNodeDetails(nodeData) {
  // Remove any existing detail panel
  var existing = document.getElementById('nn-graph-detail-panel');
  if (existing) existing.remove();

  var fileType = nodeData.file_type || 'unknown';
  var icon = fileType === 'code' ? '💻' : fileType === 'document' ? '📄' : fileType === 'image' ? '🖼️' : '📋';
  var degree = nodeData.degree || 0;
  var isGodNode = degree >= 5;

  var panel = document.createElement('div');
  panel.id = 'nn-graph-detail-panel';
  panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:360px;max-height:80vh;overflow-y:auto;background:var(--bg-sidebar,var(--bg-primary,#1e1e2e));border:1px solid var(--border-color,#45475a);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.35);z-index:9999;font-family:inherit;color:var(--text-primary,#cdd6f4);';

  var h = '<div style="padding:16px 16px 0;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">';
  h += '<div style="display:flex;align-items:center;gap:8px;">';
  h += '<span style="font-size:28px;">' + icon + '</span>';
  h += '<div>';
  h += '<div style="font-size:15px;font-weight:600;color:var(--text-primary,#cdd6f4);word-break:break-word;">' + (nodeData.label || nodeData.id) + '</div>';
  if (isGodNode) h += '<span style="font-size:9px;background:var(--accent,#89b4fa);color:#fff;padding:2px 6px;border-radius:4px;font-weight:700;margin-top:2px;display:inline-block;">GOD NODE</span>';
  h += '</div></div>';
  h += '<button id="nn-graph-detail-close" style="background:none;border:none;color:var(--text-dim,#a6adc8);font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">✕</button>';
  h += '</div>';

  h += '<div style="display:flex;gap:8px;margin-bottom:14px;">';
  h += '<div style="flex:1;background:var(--surface-container,var(--bg-input,#313244));border-radius:8px;padding:8px;text-align:center;border:1px solid var(--border-color,#45475a);">';
  h += '<div style="font-size:18px;font-weight:700;color:var(--accent,#89b4fa);">' + degree + '</div>';
  h += '<div style="font-size:9px;color:var(--text-dim,#a6adc8);">Connections</div></div>';
  var communityLabel = nodeData.community !== undefined ? nodeData.community : '—';
  h += '<div style="flex:1;background:var(--surface-container,var(--bg-input,#313244));border-radius:8px;padding:8px;text-align:center;border:1px solid var(--border-color,#45475a);">';
  h += '<div style="font-size:18px;font-weight:700;color:var(--green,#a6e3a1);">' + communityLabel + '</div>';
  h += '<div style="font-size:9px;color:var(--text-dim,#a6adc8);">Community</div></div>';
  h += '<div style="flex:1;background:var(--surface-container,var(--bg-input,#313244));border-radius:8px;padding:8px;text-align:center;border:1px solid var(--border-color,#45475a);">';
  h += '<div style="font-size:14px;font-weight:600;color:var(--purple,#cba6f7);">' + (fileType.charAt(0).toUpperCase() + fileType.slice(1)) + '</div>';
  h += '<div style="font-size:9px;color:var(--text-dim,#a6adc8);">Type</div></div>';
  h += '</div>';

  h += '<div style="background:var(--surface-container,var(--bg-input,#313244));border-radius:8px;padding:12px;margin-bottom:14px;border:1px solid var(--border-color,#45475a);">';
  if (nodeData.source_file) {
    h += '<div style="margin-bottom:8px;"><span style="font-size:10px;color:var(--text-dim,#a6adc8);display:block;margin-bottom:2px;">Source File</span>';
    h += '<span style="font-size:12px;color:var(--accent,#89b4fa);font-family:SF Mono,Menlo,monospace;word-break:break-all;">' + nodeData.source_file + '</span></div>';
  }
  if (nodeData.source_location) {
    h += '<div><span style="font-size:10px;color:var(--text-dim,#a6adc8);display:block;margin-bottom:2px;">Location</span>';
    h += '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-family:SF Mono,Menlo,monospace;">' + nodeData.source_location + '</span></div>';
  }
  if (!nodeData.source_file && !nodeData.source_location) {
    h += '<div style="font-size:11px;color:var(--text-dim,#a6adc8);font-style:italic;">No source location available</div>';
  }
  h += '</div></div>';
  panel.innerHTML = h;
  document.body.appendChild(panel);

  document.getElementById('nn-graph-detail-close').addEventListener('click', function() { panel.remove(); });
  setTimeout(function() {
    document.addEventListener('mousedown', function handler(e) {
      if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('mousedown', handler); }
    });
  }, 100);
}

/**
 * Show detailed information about an edge
 */
function showEdgeDetails(edgeData) {
  var existing = document.getElementById('nn-graph-detail-panel');
  if (existing) existing.remove();

  var confColors = { EXTRACTED: 'var(--green,#a6e3a1)', INFERRED: 'var(--yellow,#f9e2af)', AMBIGUOUS: 'var(--red,#f38ba8)' };
  var confColor = confColors[edgeData.confidence] || 'var(--text-dim,#a6adc8)';
  var confDescs = { EXTRACTED: 'Explicitly found in source', INFERRED: 'Reasonably deduced', AMBIGUOUS: 'Uncertain — needs review' };

  var panel = document.createElement('div');
  panel.id = 'nn-graph-detail-panel';
  panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:360px;max-height:80vh;overflow-y:auto;background:var(--bg-sidebar,var(--bg-primary,#1e1e2e));border:1px solid var(--border-color,#45475a);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.35);z-index:9999;font-family:inherit;color:var(--text-primary,#cdd6f4);';

  var h = '<div style="padding:16px;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">';
  h += '<div style="display:flex;align-items:center;gap:8px;">';
  h += '<span style="font-size:24px;">🔗</span>';
  h += '<div style="font-size:15px;font-weight:600;color:var(--text-primary,#cdd6f4);">Relationship</div>';
  h += '</div>';
  h += '<button id="nn-graph-detail-close" style="background:none;border:none;color:var(--text-dim,#a6adc8);font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">✕</button>';
  h += '</div>';

  h += '<div style="background:var(--surface-container,var(--bg-input,#313244));border-radius:8px;padding:14px;margin-bottom:14px;text-align:center;border:1px solid var(--border-color,#45475a);">';
  h += '<div style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:500;margin-bottom:6px;">' + (edgeData.sourceLabel || edgeData.source || '?') + '</div>';
  h += '<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin:8px 0;">';
  h += '<div style="flex:1;height:1px;background:var(--border-color,#45475a);"></div>';
  h += '<span style="font-size:11px;color:var(--accent,#89b4fa);background:var(--bg-primary,#1e1e2e);padding:3px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);white-space:nowrap;">' + (edgeData.relation || 'related') + '</span>';
  h += '<div style="flex:1;height:1px;background:var(--border-color,#45475a);"></div>';
  h += '</div>';
  h += '<div style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:500;margin-top:6px;">' + (edgeData.targetLabel || edgeData.target || '?') + '</div>';
  h += '</div>';

  h += '<div style="background:var(--surface-container,var(--bg-input,#313244));border-radius:8px;padding:12px;margin-bottom:14px;border-left:3px solid ' + confColor + ';border:1px solid var(--border-color,#45475a);border-left:3px solid ' + confColor + ';">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
  h += '<span style="font-size:10px;color:var(--text-dim,#a6adc8);">Confidence</span>';
  h += '<span style="font-size:12px;font-weight:700;color:' + confColor + ';">' + (edgeData.confidence || 'EXTRACTED') + '</span>';
  h += '</div>';
  h += '<div style="font-size:10px;color:var(--text-dim,#a6adc8);margin-top:4px;">' + (confDescs[edgeData.confidence] || '') + '</div>';
  h += '</div>';

  if (edgeData.source_file || edgeData.source_location) {
    h += '<div style="background:var(--surface-container,var(--bg-input,#313244));border-radius:8px;padding:12px;border:1px solid var(--border-color,#45475a);">';
    if (edgeData.source_file) {
      h += '<div style="margin-bottom:6px;"><span style="font-size:10px;color:var(--text-dim,#a6adc8);display:block;margin-bottom:2px;">Source File</span>';
      h += '<span style="font-size:11px;color:var(--accent,#89b4fa);font-family:SF Mono,Menlo,monospace;">' + edgeData.source_file + '</span></div>';
    }
    if (edgeData.source_location) {
      h += '<div><span style="font-size:10px;color:var(--text-dim,#a6adc8);display:block;margin-bottom:2px;">Location</span>';
      h += '<span style="font-size:11px;color:var(--text-primary,#cdd6f4);font-family:SF Mono,Menlo,monospace;">' + edgeData.source_location + '</span></div>';
    }
    h += '</div>';
  }

  h += '</div>';
  panel.innerHTML = h;
  document.body.appendChild(panel);

  document.getElementById('nn-graph-detail-close').addEventListener('click', function() { panel.remove(); });
  setTimeout(function() {
    document.addEventListener('mousedown', function handler(e) {
      if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('mousedown', handler); }
    });
  }, 100);
}

/**
 * Apply a layout to the graph
 */
function applyGraphLayout(layoutName, options) {
  if (!currentCytoscapeInstance) {
    console.error('[GraphViz] No Cytoscape instance available');
    return;
  }

  options = options || {};
  var defaultOptions = {
    animate: true,
    animationDuration: 1000,
    fit: true,
    padding: 50
  };

  var layoutOptions = Object.assign({}, defaultOptions, options, { name: layoutName });

  // Apply layout-specific options
  switch (layoutName) {
    case 'cose':
      Object.assign(layoutOptions, {
        randomize: false,
        nodeRepulsion: 400000,
        nodeOverlap: 10,
        idealEdgeLength: 100,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0
      });
      break;
    
    case 'fcose':
      // Check if fCoSE extension is available
      if (typeof cytoscapeFcose === 'undefined' || !cytoscape.layoutBase) {
        console.warn('[GraphViz] fCoSE extension not available, falling back to cose');
        layoutName = 'cose';
        layoutOptions.name = 'cose';
        Object.assign(layoutOptions, {
          randomize: false,
          nodeRepulsion: 400000,
          nodeOverlap: 10,
          idealEdgeLength: 100,
          edgeElasticity: 100,
          nestingFactor: 5,
          gravity: 80,
          numIter: 1000,
          initialTemp: 200,
          coolingFactor: 0.95,
          minTemp: 1.0
        });
      } else {
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
      }
      break;
    
    case 'cola':
      // Check if Cola extension is available
      if (typeof cytoscapeCola === 'undefined') {
        console.warn('[GraphViz] Cola extension not available, falling back to cose');
        layoutName = 'cose';
        layoutOptions.name = 'cose';
        Object.assign(layoutOptions, {
          randomize: false,
          nodeRepulsion: 400000,
          nodeOverlap: 10,
          idealEdgeLength: 100,
          edgeElasticity: 100,
          nestingFactor: 5,
          gravity: 80,
          numIter: 1000,
          initialTemp: 200,
          coolingFactor: 0.95,
          minTemp: 1.0
        });
      } else {
        Object.assign(layoutOptions, {
          randomize: false,
          maxSimulationTime: 4000,
          ungrabifyWhileSimulating: false,
          fit: true,
          edgeLength: 80,
          nodeSpacing: 10
        });
      }
      break;
    
    case 'dagre':
      // Check if Dagre extension is available
      if (typeof cytoscapeDagre === 'undefined') {
        console.warn('[GraphViz] Dagre extension not available, falling back to breadthfirst');
        layoutName = 'breadthfirst';
        layoutOptions.name = 'breadthfirst';
        Object.assign(layoutOptions, {
          directed: true,
          roots: currentCytoscapeInstance.nodes().filter('[indegree = 0]'),
          spacingFactor: 1.5
        });
      } else {
        Object.assign(layoutOptions, {
          rankDir: 'TB',
          ranker: 'longest-path',
          nodeSep: 50,
          edgeSep: 10,
          rankSep: 100
        });
      }
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

  console.log('[GraphViz] Applying ' + layoutName + ' layout');
  
  var layout = currentCytoscapeInstance.layout(layoutOptions);
  layout.run();
}

/**
 * Fit the graph to the viewport
 */
function fitGraphToView(padding) {
  if (!currentCytoscapeInstance) {
    return;
  }
  
  padding = padding || 50;
  currentCytoscapeInstance.fit(undefined, padding);
}

/**
 * Reset zoom and pan to default
 */
function resetGraphView() {
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
function filterGraphNodes(filterType) {
  if (!currentCytoscapeInstance) {
    return;
  }

  // Show all nodes first
  currentCytoscapeInstance.nodes().show();
  currentCytoscapeInstance.edges().show();

  switch (filterType) {
    case 'god-nodes':
      // Show only god nodes and their connections
      var godNodes = currentCytoscapeInstance.nodes('.god-node');
      var connectedElements = godNodes.union(godNodes.connectedEdges()).union(godNodes.connectedEdges().connectedNodes());
      currentCytoscapeInstance.elements().hide();
      connectedElements.show();
      break;
    
    case 'functions':
      // Show only function nodes
      var functionNodes = currentCytoscapeInstance.nodes('.function');
      var functionConnections = functionNodes.union(functionNodes.connectedEdges());
      currentCytoscapeInstance.elements().hide();
      functionConnections.show();
      break;
    
    case 'classes':
      // Show only class nodes
      var classNodes = currentCytoscapeInstance.nodes('.class');
      var classConnections = classNodes.union(classNodes.connectedEdges());
      currentCytoscapeInstance.elements().hide();
      classConnections.show();
      break;
    
    case 'files':
      // Show only file nodes
      var fileNodes = currentCytoscapeInstance.nodes('[file_type = "code"], [file_type = "document"]');
      var fileConnections = fileNodes.union(fileNodes.connectedEdges());
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
function searchAndHighlightNodes(searchTerm) {
  if (!currentCytoscapeInstance || !searchTerm.trim()) {
    return;
  }

  // Remove previous search highlights
  currentCytoscapeInstance.nodes().removeClass('search-highlight');

  // Find matching nodes
  var matchingNodes = currentCytoscapeInstance.nodes().filter(function(node) {
    var label = node.data('label').toLowerCase();
    return label.includes(searchTerm.toLowerCase());
  });

  if (matchingNodes.length > 0) {
    // Highlight matching nodes
    matchingNodes.addClass('search-highlight');
    
    // Fit to show highlighted nodes
    currentCytoscapeInstance.fit(matchingNodes, 100);
    
    console.log('[GraphViz] Found ' + matchingNodes.length + ' nodes matching "' + searchTerm + '"');
  } else {
    console.log('[GraphViz] No nodes found matching "' + searchTerm + '"');
  }
}

/**
 * Export graph visualization as image
 */
function exportGraphAsImage(format) {
  return new Promise(function(resolve, reject) {
    if (!currentCytoscapeInstance) {
      reject(new Error('No Cytoscape instance available'));
      return;
    }

    try {
      format = format || 'png';
      
      if (format === 'svg') {
        // SVG export
        var svgContent = currentCytoscapeInstance.svg({
          full: true,
          scale: 2
        });
        resolve(svgContent);
      } else {
        // PNG/other raster formats
        var options = {
          output: 'blob',
          format: format,
          bg: '#ffffff',
          full: true,
          scale: 2,
          maxWidth: 4000,
          maxHeight: 4000
        };

        var blob = currentCytoscapeInstance.png(options);
        resolve(blob);
      }
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Get current Cytoscape instance
 */
function getCurrentCytoscapeInstance() {
  return currentCytoscapeInstance;
}

/**
 * Main function to show graph visualization - replaces the missing function in index.ts
 */
function showGraphVisualization(graphData) {
  console.log('[GraphViz] showGraphVisualization called with data:', graphData);
  
  var vizEl = document.getElementById('graph-visualization');
  if (!vizEl) {
    console.error('[GraphViz] Graph visualization container not found');
    return;
  }

  try {
    // Clear any existing content
    vizEl.innerHTML = '';

    // Check if we have valid graph data
    if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
      console.warn('[GraphViz] No valid graph data:', graphData);
      vizEl.innerHTML = 
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);">' +
          '<div style="text-align:center;">' +
            '<div style="font-size:48px;margin-bottom:16px;">📊</div>' +
            '<div>No graph data available</div>' +
            '<div style="font-size:12px;margin-top:8px;">Generate a knowledge graph first</div>' +
          '</div>' +
        '</div>';
      return;
    }

    console.log('[GraphViz] Processing graph with', graphData.nodes.length, 'nodes and', (graphData.edges ? graphData.edges.length : 0), 'edges');

    // Set up container styling with proper dimensions
    vizEl.style.width = '100%';
    vizEl.style.height = '500px';
    vizEl.style.position = 'relative';
    vizEl.style.backgroundColor = 'var(--bg-primary)';
    vizEl.style.border = '1px solid var(--border-color)';
    vizEl.style.borderRadius = '8px';
    
    console.log('[GraphViz] Container styled, dimensions:', vizEl.offsetWidth, 'x', vizEl.offsetHeight);

    // Ensure container has proper dimensions before initializing Cytoscape
    if (vizEl.offsetWidth === 0 || vizEl.offsetHeight === 0) {
      console.warn('[GraphViz] Container has zero dimensions, forcing layout');
      vizEl.style.minWidth = '800px';
      vizEl.style.minHeight = '500px';
    }

    // Initialize Cytoscape immediately (no delay needed)
    try {
      var cy = initializeCytoscape(vizEl, graphData);
      console.log('[GraphViz] Graph visualization created successfully with ' + graphData.nodes.length + ' nodes and ' + (graphData.edges ? graphData.edges.length : 0) + ' edges');
    } catch (initError) {
      console.error('[GraphViz] Cytoscape initialization failed:', initError);
      vizEl.innerHTML = 
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);">' +
          '<div style="text-align:center;">' +
            '<div style="font-size:48px;margin-bottom:16px;">⚠️</div>' +
            '<div>Cytoscape initialization failed</div>' +
            '<div style="font-size:12px;margin-top:8px;">' + (initError.message || 'Unknown error') + '</div>' +
          '</div>' +
        '</div>';
    }

  } catch (error) {
    console.error('[GraphViz] Error creating graph visualization:', error);
    
    vizEl.innerHTML = 
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);">' +
        '<div style="text-align:center;">' +
          '<div style="font-size:48px;margin-bottom:16px;">⚠️</div>' +
          '<div>Failed to create graph visualization</div>' +
          '<div style="font-size:12px;margin-top:8px;">Error: ' + (error.message || 'Unknown error') + '</div>' +
        '</div>' +
      '</div>';
  }
}

// Make function available globally
window.showGraphVisualization = showGraphVisualization;

// Make utility functions available globally for controls
window.fitGraphToView = fitGraphToView;
window.resetGraphView = resetGraphView;
window.filterGraphNodes = filterGraphNodes;
window.applyGraphLayout = applyGraphLayout;
window.exportGraphAsImage = exportGraphAsImage;
window.getCurrentCytoscapeInstance = getCurrentCytoscapeInstance;
window.searchAndHighlightNodes = searchAndHighlightNodes;