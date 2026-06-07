/**
 * Graph Controls System
 * 
 * Provides comprehensive control panel for graph visualization including
 * layout selection, zoom controls, filters, and search functionality.
 */

/**
 * Main function to show graph controls - replaces the missing function in index.ts
 */
function showGraphControls(graphData, config) {
  var controlsEl = document.getElementById('graph-controls');
  if (!controlsEl) {
    console.error('[GraphControls] Graph controls container not found');
    return;
  }

  config = config || {};
  var defaultConfig = {
    showLayoutControls: true,
    showZoomControls: true,
    showFilterControls: true,
    showSearchControls: false,
    showExportControls: true
  };

  var finalConfig = Object.assign({}, defaultConfig, config);

  try {
    // Clear existing controls
    controlsEl.innerHTML = '';

    // Create main controls container
    var controlsContainer = document.createElement('div');
    controlsContainer.className = 'graph-controls-container';
    controlsContainer.style.cssText = 
      'display: flex;' +
      'flex-direction: column;' +
      'gap: 16px;' +
      'padding: 16px;' +
      'background: var(--bg-primary);' +
      'border-radius: 8px;' +
      'border: 1px solid var(--border-color);' +
      'max-height: 100%;' +
      'overflow-y: auto;';

    // Add title
    var title = document.createElement('div');
    title.textContent = 'Graph Controls';
    title.style.cssText = 
      'font-size: 14px;' +
      'font-weight: 600;' +
      'color: var(--text-primary);' +
      'margin-bottom: 8px;';
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
    
    controlsEl.innerHTML = 
      '<div style="padding: 16px; color: var(--text-secondary); text-align: center;">' +
        '<div>⚠️ Failed to create controls</div>' +
        '<div style="font-size: 12px; margin-top: 8px;">' + (error.message || 'Unknown error') + '</div>' +
      '</div>';
  }
}

// Make function available globally
window.showGraphControls = showGraphControls;

/**
 * Horizontal layout version of graph controls - replaces separate search and export sections
 */
function showGraphControlsHorizontal(graphData, config) {
  console.log('[GraphControls] showGraphControlsHorizontal called with:', graphData);
  
  var controlsEl = document.getElementById('graph-controls-horizontal');
  if (!controlsEl) {
    console.error('[GraphControls] Horizontal graph controls container not found');
    return;
  }

  try {
    // Clear existing controls
    controlsEl.innerHTML = '';

    // Create main horizontal controls container
    var controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = 
      'display: flex;' +
      'flex-wrap: wrap;' +
      'gap: 20px;' +
      'padding: 20px;' +
      'background: var(--bg-primary);' +
      'border-radius: 12px;' +
      'border: 2px solid var(--border-color);' +
      'align-items: center;' +
      'justify-content: center;';

    // 1. Layout Controls Section
    var layoutSection = document.createElement('div');
    layoutSection.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-shrink: 0;';
    
    var layoutLabel = document.createElement('span');
    layoutLabel.textContent = 'Layout:';
    layoutLabel.style.cssText = 'font-size: 12px; color: var(--text-secondary); font-weight: 600; white-space: nowrap;';
    layoutSection.appendChild(layoutLabel);

    // Get available layouts from global variable set by HTML
    var availableLayouts = window.availableCytoscapeLayouts || ['cose', 'circle', 'grid', 'random'];
    
    var allLayouts = [
      { id: 'cose', name: 'Cose' },
      { id: 'fcose', name: 'fCoSE' },
      { id: 'cola', name: 'Cola' },
      { id: 'dagre', name: 'Dagre' },
      { id: 'random', name: 'Random' },
      { id: 'circle', name: 'Circle' },
      { id: 'grid', name: 'Grid' }
    ];
    
    // Filter to only show available layouts
    var layouts = allLayouts.filter(function(layout) {
      return availableLayouts.indexOf(layout.id) !== -1;
    });
    
    layouts.forEach(function(layout) {
      var button = createSimpleButton(layout.name);
      button.addEventListener('click', function() {
        console.log('[GraphControls] Layout clicked:', layout.name);
        // Remove active from all layout buttons
        var layoutButtons = layoutSection.querySelectorAll('button');
        for (var i = 0; i < layoutButtons.length; i++) {
          layoutButtons[i].classList.remove('active');
        }
        button.classList.add('active');
        
        if (typeof window.applyGraphLayout === 'function') {
          window.applyGraphLayout(layout.id);
        }
      });
      
      // Set 'Cose' as default active
      if (layout.id === 'cose') {
        button.classList.add('active');
      }
      
      layoutSection.appendChild(button);
    });

    // 2. Filter Nodes Section
    var filterSection = document.createElement('div');
    filterSection.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-shrink: 0;';
    
    var filterLabel = document.createElement('span');
    filterLabel.textContent = 'Filter:';
    filterLabel.style.cssText = 'font-size: 12px; color: var(--text-secondary); font-weight: 600; white-space: nowrap;';
    filterSection.appendChild(filterLabel);

    var filters = [
      { id: 'all', name: 'All' },
      { id: 'god-nodes', name: 'God Nodes' },
      { id: 'functions', name: 'Functions' },
      { id: 'classes', name: 'Classes' }
    ];
    
    filters.forEach(function(filter) {
      var button = createSimpleButton(filter.name);
      button.addEventListener('click', function() {
        console.log('[GraphControls] Filter clicked:', filter.name);
        // Remove active from all filter buttons
        var filterButtons = filterSection.querySelectorAll('button');
        for (var i = 0; i < filterButtons.length; i++) {
          filterButtons[i].classList.remove('active');
        }
        button.classList.add('active');
        
        if (typeof window.filterGraphNodes === 'function') {
          window.filterGraphNodes(filter.id);
        }
      });
      
      // Set 'All' as default active
      if (filter.id === 'all') {
        button.classList.add('active');
      }
      
      filterSection.appendChild(button);
    });

    // 3. View Controls Section
    var viewSection = document.createElement('div');
    viewSection.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-shrink: 0;';
    
    var viewLabel = document.createElement('span');
    viewLabel.textContent = 'View:';
    viewLabel.style.cssText = 'font-size: 12px; color: var(--text-secondary); font-weight: 600; white-space: nowrap;';
    viewSection.appendChild(viewLabel);

    var viewControls = [
      { name: 'Zoom In', action: function() { if (typeof window.zoomGraph === 'function') window.zoomGraph(1.2); } },
      { name: 'Zoom Out', action: function() { if (typeof window.zoomGraph === 'function') window.zoomGraph(0.8); } },
      { name: 'Fit View', action: function() { if (typeof window.fitGraphToView === 'function') window.fitGraphToView(); } }
    ];
    
    viewControls.forEach(function(control) {
      var button = createSimpleButton(control.name);
      button.addEventListener('click', function() {
        console.log('[GraphControls] View control clicked:', control.name);
        control.action();
      });
      viewSection.appendChild(button);
    });

    // 4. Export Graph Section
    var exportSection = document.createElement('div');
    exportSection.style.cssText = 
      'display: flex;' +
      'gap: 8px;' +
      'align-items: center;' +
      'flex-shrink: 0;';
    
    var exportLabel = document.createElement('span');
    exportLabel.textContent = 'Export:';
    exportLabel.style.cssText = 
      'font-size: 12px;' +
      'color: var(--text-secondary);' +
      'font-weight: 600;' +
      'white-space: nowrap;';
    exportSection.appendChild(exportLabel);

    var exportFormats = [
      { id: 'png', name: 'PNG' },
      { id: 'svg', name: 'SVG' },
      { id: 'json', name: 'JSON' },
      { id: 'csv', name: 'CSV' }
    ];
    
    exportFormats.forEach(function(format) {
      var button = createSimpleButton(format.name);
      button.addEventListener('click', function() {
        console.log('[GraphControls] Export clicked:', format.name);
        var originalText = button.textContent;
        button.textContent = '⏳';
        button.disabled = true;
        
        setTimeout(function() {
          if (typeof window.exportGraph === 'function') {
            window.exportGraph(format.id);
          }
          button.textContent = originalText;
          button.disabled = false;
        }, 100);
      });
      exportSection.appendChild(button);
    });

    // Add all sections to container
    controlsContainer.appendChild(layoutSection);
    controlsContainer.appendChild(filterSection);
    controlsContainer.appendChild(viewSection);
    controlsContainer.appendChild(exportSection);

    controlsEl.appendChild(controlsContainer);

    console.log('[GraphControls] Complete horizontal graph controls created successfully');

  } catch (error) {
    console.error('[GraphControls] Error creating horizontal graph controls:', error);
    
    controlsEl.innerHTML = 
      '<div style="padding: 16px; color: var(--red); text-align: center;">' +
        '<div>⚠️ Failed to create horizontal controls</div>' +
        '<div style="font-size: 12px; margin-top: 8px;">' + (error.message || 'Unknown error') + '</div>' +
      '</div>';
  }
}

// Helper function to create consistent buttons
function createSimpleButton(text) {
  var button = document.createElement('button');
  button.textContent = text;
  button.style.cssText = 
    'padding: 6px 12px;' +
    'border: 1px solid var(--border-color);' +
    'border-radius: 4px;' +
    'background: var(--surface-container);' +
    'color: var(--text-primary);' +
    'font-size: 11px;' +
    'cursor: pointer;' +
    'transition: all 0.2s ease;' +
    'white-space: nowrap;';
  
  // Hover effects
  button.addEventListener('mouseenter', function() {
    if (!button.disabled) {
      button.style.background = 'var(--surface-hover)';
      button.style.borderColor = 'var(--accent)';
    }
  });

  button.addEventListener('mouseleave', function() {
    if (!button.classList.contains('active') && !button.disabled) {
      button.style.background = 'var(--surface-container)';
      button.style.borderColor = 'var(--border-color)';
    }
  });

  return button;
}

// Make horizontal function available globally
window.showGraphControlsHorizontal = showGraphControlsHorizontal;

// Make utility functions available globally
window.zoomGraph = zoomGraph;
window.exportGraph = exportGraph;
window.exportGraphAsJSON = exportGraphAsJSON;
window.exportGraphAsCSV = exportGraphAsCSV;

/**
 * Create layout selection controls
 */
function createLayoutControls() {
  var section = createControlSection('Layout Algorithm');

  var layouts = [
    { id: 'cose', name: 'Cose (Force)', description: 'Built-in force-directed layout' },
    { id: 'fcose', name: 'fCoSE (Force)', description: 'Advanced force-directed layout' },
    { id: 'cola', name: 'Cola (Force)', description: 'Physics-based force layout' },
    { id: 'dagre', name: 'Dagre (Hierarchical)', description: 'Top-down hierarchical layout' },
    { id: 'breadthfirst', name: 'Breadth-first', description: 'Tree-like breadth-first layout' },
    { id: 'circle', name: 'Circle', description: 'Circular arrangement' },
    { id: 'grid', name: 'Grid', description: 'Regular grid arrangement' },
    { id: 'random', name: 'Random', description: 'Random positioning' }
  ];

  var layoutContainer = document.createElement('div');
  layoutContainer.style.cssText = 
    'display: grid;' +
    'grid-template-columns: 1fr 1fr;' +
    'gap: 8px;';

  layouts.forEach(function(layout) {
    var button = createControlButton(layout.name, layout.description);
    button.addEventListener('click', function() {
      // Remove active class from all layout buttons
      var buttons = layoutContainer.querySelectorAll('.control-button');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.remove('active');
      }
      
      // Add active class to clicked button
      button.classList.add('active');
      
      // Apply layout
      applyGraphLayout(layout.id);
      
      console.log('[GraphControls] Applied ' + layout.name + ' layout');
    });

    // Set Cose as default active
    if (layout.id === 'cose') {
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
function createZoomControls() {
  var section = createControlSection('View Controls');

  var controls = [
    { id: 'zoom-in', name: '🔍 Zoom In', action: function() { zoomGraph(1.2); } },
    { id: 'zoom-out', name: '🔍 Zoom Out', action: function() { zoomGraph(0.8); } },
    { id: 'fit-view', name: '📐 Fit to View', action: function() { fitGraphToView(); } },
    { id: 'reset-view', name: '↻ Reset View', action: function() { resetGraphView(); } }
  ];

  var controlsContainer = document.createElement('div');
  controlsContainer.style.cssText = 
    'display: grid;' +
    'grid-template-columns: 1fr 1fr;' +
    'gap: 8px;';

  controls.forEach(function(control) {
    var button = createControlButton(control.name);
    button.addEventListener('click', control.action);
    controlsContainer.appendChild(button);
  });

  section.appendChild(controlsContainer);
  return section;
}

/**
 * Create filter controls
 */
function createFilterControls(graphData) {
  var section = createControlSection('Filter Nodes');

  var filters = [
    { id: 'all', name: '👁️ Show All', description: 'Show all nodes and edges' },
    { id: 'god-nodes', name: '⭐ God Nodes', description: 'Highly connected components' },
    { id: 'functions', name: '🔧 Functions', description: 'Function and method nodes' },
    { id: 'classes', name: '📦 Classes', description: 'Class and interface nodes' },
    { id: 'files', name: '📄 Files', description: 'File and document nodes' }
  ];

  var filterContainer = document.createElement('div');
  filterContainer.style.cssText = 
    'display: flex;' +
    'flex-direction: column;' +
    'gap: 6px;';

  filters.forEach(function(filter) {
    var button = createControlButton(filter.name, filter.description);
    button.style.width = '100%';
    
    button.addEventListener('click', function() {
      // Remove active class from all filter buttons
      var buttons = filterContainer.querySelectorAll('.control-button');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.remove('active');
      }
      
      // Add active class to clicked button
      button.classList.add('active');
      
      // Apply filter
      filterGraphNodes(filter.id);
      
      console.log('[GraphControls] Applied ' + filter.name + ' filter');
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
function createSearchControls() {
  var section = createControlSection('Search Nodes');

  var searchContainer = document.createElement('div');
  searchContainer.style.cssText = 
    'display: flex;' +
    'gap: 8px;' +
    'align-items: center;';

  // Search input
  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search nodes...';
  searchInput.style.cssText = 
    'flex: 1;' +
    'padding: 8px 12px;' +
    'border: 1px solid var(--border-color);' +
    'border-radius: 4px;' +
    'background: var(--bg-input);' +
    'color: var(--text-primary);' +
    'font-size: 12px;';

  // Search button
  var searchButton = createControlButton('🔍');
  searchButton.style.minWidth = '40px';

  // Clear button
  var clearButton = createControlButton('✕');
  clearButton.style.minWidth = '40px';

  // Search functionality
  var performSearch = function() {
    var searchTerm = searchInput.value.trim();
    if (searchTerm) {
      searchAndHighlightNodes(searchTerm);
    }
  };

  var clearSearch = function() {
    searchInput.value = '';
    var cy = getCurrentCytoscapeInstance();
    if (cy) {
      cy.nodes().removeClass('search-highlight');
      fitGraphToView();
    }
  };

  // Event listeners
  searchButton.addEventListener('click', performSearch);
  clearButton.addEventListener('click', clearSearch);
  searchInput.addEventListener('keypress', function(e) {
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
function createExportControls() {
  var section = createControlSection('Export Graph');

  var exports = [
    { id: 'png', name: '🖼️ PNG Image', description: 'High-quality raster image' },
    { id: 'svg', name: '🎨 SVG Vector', description: 'Scalable vector graphics' },
    { id: 'json', name: '📄 JSON Data', description: 'Complete graph data with positions' },
    { id: 'csv', name: '📊 CSV Data', description: 'Spreadsheet-compatible format' }
  ];

  var exportContainer = document.createElement('div');
  exportContainer.style.cssText = 
    'display: flex;' +
    'flex-direction: column;' +
    'gap: 6px;';

  exports.forEach(function(exportOption) {
    var button = createControlButton(exportOption.name, exportOption.description);
    button.style.width = '100%';
    button.addEventListener('click', function() {
      // Add loading state
      var originalText = button.textContent;
      button.textContent = '⏳ Exporting...';
      button.disabled = true;
      
      // Export with timeout
      setTimeout(function() {
        exportGraph(exportOption.id);
        button.textContent = originalText;
        button.disabled = false;
      }, 100);
    });
    exportContainer.appendChild(button);
  });

  section.appendChild(exportContainer);
  return section;
}

/**
 * Create statistics display
 */
function createStatisticsDisplay(graphData) {
  var section = createControlSection('Graph Statistics');

  var stats = [
    { label: 'Nodes', value: graphData.nodes ? graphData.nodes.length : 0 },
    { label: 'Edges', value: graphData.edges ? graphData.edges.length : 0 },
    { label: 'Communities', value: graphData.communities ? Object.keys(graphData.communities).length : 0 },
    { label: 'God Nodes', value: graphData.godNodes ? graphData.godNodes.length : 0 }
  ];

  var statsContainer = document.createElement('div');
  statsContainer.style.cssText = 
    'display: grid;' +
    'grid-template-columns: 1fr 1fr;' +
    'gap: 8px;';

  stats.forEach(function(stat) {
    var statItem = document.createElement('div');
    statItem.style.cssText = 
      'padding: 8px;' +
      'background: var(--surface-container);' +
      'border-radius: 4px;' +
      'text-align: center;' +
      'border: 1px solid var(--border-color);';

    statItem.innerHTML = 
      '<div style="font-size: 16px; font-weight: 600; color: var(--accent);">' + stat.value + '</div>' +
      '<div style="font-size: 11px; color: var(--text-secondary);">' + stat.label + '</div>';

    statsContainer.appendChild(statItem);
  });

  section.appendChild(statsContainer);
  return section;
}

/**
 * Create a control section with title
 */
function createControlSection(title) {
  var section = document.createElement('div');
  section.style.cssText = 
    'display: flex;' +
    'flex-direction: column;' +
    'gap: 8px;';

  var titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = 
    'font-size: 12px;' +
    'font-weight: 600;' +
    'color: var(--text-secondary);' +
    'text-transform: uppercase;' +
    'letter-spacing: 0.5px;';

  section.appendChild(titleEl);
  return section;
}

/**
 * Create a styled control button
 */
function createControlButton(text, tooltip) {
  var button = document.createElement('button');
  button.textContent = text;
  button.className = 'control-button';
  button.style.cssText = 
    'padding: 8px 12px;' +
    'border: 1px solid var(--border-color);' +
    'border-radius: 4px;' +
    'background: var(--surface-container);' +
    'color: var(--text-primary);' +
    'font-size: 11px;' +
    'cursor: pointer;' +
    'transition: all 0.2s ease;' +
    'white-space: nowrap;' +
    'overflow: hidden;' +
    'text-overflow: ellipsis;';

  if (tooltip) {
    button.title = tooltip;
  }

  // Hover effects
  button.addEventListener('mouseenter', function() {
    button.style.background = 'var(--surface-hover)';
    button.style.borderColor = 'var(--accent)';
  });

  button.addEventListener('mouseleave', function() {
    if (!button.classList.contains('active')) {
      button.style.background = 'var(--surface-container)';
      button.style.borderColor = 'var(--border-color)';
    }
  });

  return button;
}

/**
 * Zoom the graph by a factor
 */
function zoomGraph(factor) {
  var cy = getCurrentCytoscapeInstance();
  if (!cy) return;

  var currentZoom = cy.zoom();
  var newZoom = currentZoom * factor;
  
  // Apply zoom limits
  if (newZoom >= 0.1 && newZoom <= 3) {
    cy.zoom(newZoom);
  }
}

/**
 * Export graph in various formats
 */
function exportGraph(format) {
  try {
    switch (format) {
      case 'png':
        exportGraphAsImage('png').then(function(blob) {
          downloadBlob(blob, 'knowledge-graph.png');
        }).catch(function(error) {
          console.error('[GraphControls] PNG export failed:', error);
          alert('PNG export failed: ' + (error.message || 'Unknown error'));
        });
        break;
      
      case 'svg':
        exportGraphAsImage('svg').then(function(svgData) {
          var blob = new Blob([svgData], { type: 'image/svg+xml' });
          downloadBlob(blob, 'knowledge-graph.svg');
        }).catch(function(error) {
          console.error('[GraphControls] SVG export failed:', error);
          alert('SVG export failed: ' + (error.message || 'Unknown error'));
        });
        break;
      
      case 'json':
        exportGraphAsJSON().then(function(jsonData) {
          var blob = new Blob([jsonData], { type: 'application/json' });
          downloadBlob(blob, 'knowledge-graph.json');
        }).catch(function(error) {
          console.error('[GraphControls] JSON export failed:', error);
          alert('JSON export failed: ' + (error.message || 'Unknown error'));
        });
        break;
      
      case 'csv':
        exportGraphAsCSV().then(function(csvData) {
          var blob = new Blob([csvData], { type: 'text/csv' });
          downloadBlob(blob, 'knowledge-graph.csv');
        }).catch(function(error) {
          console.error('[GraphControls] CSV export failed:', error);
          alert('CSV export failed: ' + (error.message || 'Unknown error'));
        });
        break;
      
      default:
        console.warn('[GraphControls] Unknown export format: ' + format);
    }
  } catch (error) {
    console.error('[GraphControls] Export failed:', error);
    alert('Export failed: ' + (error.message || 'Unknown error'));
  }
}

/**
 * Export graph data as JSON
 */
function exportGraphAsJSON() {
  return new Promise(function(resolve, reject) {
    try {
      var cy = getCurrentCytoscapeInstance();
      if (!cy) {
        reject(new Error('No Cytoscape instance available'));
        return;
      }

      // Get all nodes and edges from Cytoscape
      var nodes = [];
      var edges = [];

      cy.nodes().forEach(function(node) {
        var data = node.data();
        nodes.push({
          id: data.id,
          label: data.label,
          file_type: data.file_type,
          source_file: data.source_file,
          source_location: data.source_location,
          community: data.community,
          degree: data.degree,
          position: node.position()
        });
      });

      cy.edges().forEach(function(edge) {
        var data = edge.data();
        edges.push({
          id: data.id,
          source: data.source,
          target: data.target,
          relation: data.relation,
          confidence: data.confidence,
          weight: data.weight,
          source_file: data.source_file,
          source_location: data.source_location
        });
      });

      var exportData = {
        metadata: {
          exportedAt: new Date().toISOString(),
          format: 'cytoscape-json',
          version: '1.0',
          nodeCount: nodes.length,
          edgeCount: edges.length
        },
        nodes: nodes,
        edges: edges
      };

      resolve(JSON.stringify(exportData, null, 2));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Export graph data as CSV
 */
function exportGraphAsCSV() {
  return new Promise(function(resolve, reject) {
    try {
      var cy = getCurrentCytoscapeInstance();
      if (!cy) {
        reject(new Error('No Cytoscape instance available'));
        return;
      }

      var csvLines = [];
      
      // Nodes CSV section
      csvLines.push('# NODES');
      csvLines.push('id,label,type,source_file,source_location,community,degree,x_position,y_position');
      
      cy.nodes().forEach(function(node) {
        var data = node.data();
        var pos = node.position();
        var row = [
          escapeCSV(data.id || ''),
          escapeCSV(data.label || ''),
          escapeCSV(data.file_type || ''),
          escapeCSV(data.source_file || ''),
          escapeCSV(data.source_location || ''),
          data.community || '',
          data.degree || 0,
          pos.x || 0,
          pos.y || 0
        ];
        csvLines.push(row.join(','));
      });

      // Empty line separator
      csvLines.push('');
      
      // Edges CSV section
      csvLines.push('# EDGES');
      csvLines.push('id,source,target,relation,confidence,weight,source_file,source_location');
      
      cy.edges().forEach(function(edge) {
        var data = edge.data();
        var row = [
          escapeCSV(data.id || ''),
          escapeCSV(data.source || ''),
          escapeCSV(data.target || ''),
          escapeCSV(data.relation || ''),
          escapeCSV(data.confidence || ''),
          data.weight || 0,
          escapeCSV(data.source_file || ''),
          escapeCSV(data.source_location || '')
        ];
        csvLines.push(row.join(','));
      });

      resolve(csvLines.join('\n'));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Escape CSV field values
 */
function escapeCSV(value) {
  if (typeof value !== 'string') {
    value = String(value);
  }
  
  // If the value contains comma, quote, or newline, wrap in quotes and escape quotes
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  
  return value;
}

/**
 * Download a blob as a file
 */
function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
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
function addControlStyles() {
  var styleId = 'graph-controls-styles';
  
  // Check if styles already added
  if (document.getElementById(styleId)) {
    return;
  }

  var style = document.createElement('style');
  style.id = styleId;
  style.textContent = 
    '.control-button.active {' +
      'background: var(--accent) !important;' +
      'color: white !important;' +
      'border-color: var(--accent) !important;' +
    '}' +
    '.control-button:hover {' +
      'transform: translateY(-1px);' +
      'box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);' +
    '}' +
    '.control-button:active {' +
      'transform: translateY(0);' +
    '}' +
    '.horizontal-control-button.active, button.active {' +
      'background: var(--accent) !important;' +
      'color: white !important;' +
      'border-color: var(--accent) !important;' +
    '}' +
    '.horizontal-control-button:hover, button:hover {' +
      'transform: translateY(-1px);' +
      'box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);' +
    '}' +
    '.horizontal-control-button:active, button:active {' +
      'transform: translateY(0);' +
    '}' +
    '.horizontal-control-button:disabled, button:disabled {' +
      'opacity: 0.6;' +
      'cursor: not-allowed;' +
      'transform: none !important;' +
    '}' +
    '@media (max-width: 768px) {' +
      '.graph-controls-horizontal-container {' +
        'flex-direction: column !important;' +
        'align-items: stretch !important;' +
      '}' +
      '.horizontal-control-section {' +
        'justify-content: center;' +
        'flex-wrap: wrap;' +
      '}' +
    '}';
  
  document.head.appendChild(style);
}

// Add styles when module loads
addControlStyles();

/**
 * Create horizontal filter controls section
 */
function createHorizontalFilterControls(graphData) {
  var section = document.createElement('div');
  section.className = 'horizontal-control-section';
  section.style.cssText = 
    'display: flex;' +
    'align-items: center;' +
    'gap: 8px;' +
    'flex-shrink: 0;';

  // Section label
  var label = document.createElement('span');
  label.textContent = 'Filter:';
  label.style.cssText = 
    'font-size: 12px;' +
    'color: var(--text-secondary);' +
    'font-weight: 600;' +
    'white-space: nowrap;';
  section.appendChild(label);

  // Filter buttons
  var filters = [
    { id: 'all', name: 'All', description: 'Show all nodes' },
    { id: 'god-nodes', name: 'God Nodes', description: 'Highly connected components' },
    { id: 'functions', name: 'Functions', description: 'Function nodes' },
    { id: 'classes', name: 'Classes', description: 'Class nodes' }
  ];

  filters.forEach(function(filter) {
    var button = createHorizontalButton(filter.name, filter.description);
    button.addEventListener('click', function() {
      // Remove active class from all filter buttons in this section
      var buttons = section.querySelectorAll('.horizontal-control-button');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.remove('active');
      }
      
      // Add active class to clicked button
      button.classList.add('active');
      
      // Apply filter
      filterGraphNodes(filter.id);
      
      console.log('[GraphControls] Applied ' + filter.name + ' filter');
    });

    // Set 'All' as default active
    if (filter.id === 'all') {
      button.classList.add('active');
    }

    section.appendChild(button);
  });

  return section;
}

/**
 * Create horizontal view controls section
 */
function createHorizontalViewControls() {
  var section = document.createElement('div');
  section.className = 'horizontal-control-section';
  section.style.cssText = 
    'display: flex;' +
    'align-items: center;' +
    'gap: 8px;' +
    'flex-shrink: 0;';

  // Section label
  var label = document.createElement('span');
  label.textContent = 'View:';
  label.style.cssText = 
    'font-size: 12px;' +
    'color: var(--text-secondary);' +
    'font-weight: 600;' +
    'white-space: nowrap;';
  section.appendChild(label);

  // View control buttons
  var controls = [
    { id: 'zoom-in', name: 'Zoom In', action: function() { zoomGraph(1.2); } },
    { id: 'zoom-out', name: 'Zoom Out', action: function() { zoomGraph(0.8); } },
    { id: 'fit-view', name: 'Fit View', action: function() { fitGraphToView(); } }
  ];

  controls.forEach(function(control) {
    var button = createHorizontalButton(control.name);
    button.addEventListener('click', control.action);
    section.appendChild(button);
  });

  return section;
}

/**
 * Create horizontal export controls section
 */
function createHorizontalExportControls() {
  var section = document.createElement('div');
  section.className = 'horizontal-control-section';
  section.style.cssText = 
    'display: flex;' +
    'align-items: center;' +
    'gap: 8px;' +
    'flex-shrink: 0;';

  // Section label
  var label = document.createElement('span');
  label.textContent = 'Export:';
  label.style.cssText = 
    'font-size: 12px;' +
    'color: var(--text-secondary);' +
    'font-weight: 600;' +
    'white-space: nowrap;';
  section.appendChild(label);

  // Export buttons
  var exports = [
    { id: 'png', name: 'PNG', description: 'Export as PNG image' },
    { id: 'svg', name: 'SVG', description: 'Export as SVG vector' },
    { id: 'json', name: 'JSON', description: 'Export as JSON data' },
    { id: 'csv', name: 'CSV', description: 'Export as CSV data' }
  ];

  exports.forEach(function(exportOption) {
    var button = createHorizontalButton(exportOption.name, exportOption.description);
    button.addEventListener('click', function() {
      // Add loading state
      var originalText = button.textContent;
      button.textContent = '⏳';
      button.disabled = true;
      
      // Export with timeout
      setTimeout(function() {
        exportGraph(exportOption.id);
        button.textContent = originalText;
        button.disabled = false;
      }, 100);
    });
    section.appendChild(button);
  });

  return section;
}

/**
 * Create horizontal search controls section
 */
function createHorizontalSearchControls() {
  var section = document.createElement('div');
  section.className = 'horizontal-control-section';
  section.style.cssText = 
    'display: flex;' +
    'align-items: center;' +
    'gap: 8px;' +
    'flex: 1;' +
    'min-width: 200px;' +
    'max-width: 400px;';

  // Section label
  var label = document.createElement('span');
  label.textContent = 'Search:';
  label.style.cssText = 
    'font-size: 12px;' +
    'color: var(--text-secondary);' +
    'font-weight: 600;' +
    'white-space: nowrap;';
  section.appendChild(label);

  // Search input
  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search nodes...';
  searchInput.style.cssText = 
    'flex: 1;' +
    'padding: 6px 8px;' +
    'border: 1px solid var(--border-color);' +
    'border-radius: 4px;' +
    'background: var(--bg-input);' +
    'color: var(--text-primary);' +
    'font-size: 12px;' +
    'min-width: 120px;';

  // Search button
  var searchButton = createHorizontalButton('🔍');
  searchButton.style.minWidth = '32px';
  searchButton.style.padding = '6px 8px';

  // Clear button
  var clearButton = createHorizontalButton('✕');
  clearButton.style.minWidth = '32px';
  clearButton.style.padding = '6px 8px';

  // Search functionality
  var performSearch = function() {
    var searchTerm = searchInput.value.trim();
    if (searchTerm) {
      searchAndHighlightNodes(searchTerm);
    }
  };

  var clearSearch = function() {
    searchInput.value = '';
    var cy = getCurrentCytoscapeInstance();
    if (cy) {
      cy.nodes().removeClass('search-highlight');
      fitGraphToView();
    }
  };

  // Event listeners
  searchButton.addEventListener('click', performSearch);
  clearButton.addEventListener('click', clearSearch);
  searchInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      performSearch();
    }
  });

  section.appendChild(searchInput);
  section.appendChild(searchButton);
  section.appendChild(clearButton);

  return section;
}

/**
 * Create a styled horizontal control button
 */
function createHorizontalButton(text, tooltip) {
  var button = document.createElement('button');
  button.textContent = text;
  button.className = 'horizontal-control-button';
  button.style.cssText = 
    'padding: 6px 12px;' +
    'border: 1px solid var(--border-color);' +
    'border-radius: 4px;' +
    'background: var(--surface-container);' +
    'color: var(--text-primary);' +
    'font-size: 11px;' +
    'cursor: pointer;' +
    'transition: all 0.2s ease;' +
    'white-space: nowrap;' +
    'min-width: fit-content;';

  if (tooltip) {
    button.title = tooltip;
  }

  // Hover effects
  button.addEventListener('mouseenter', function() {
    if (!button.disabled) {
      button.style.background = 'var(--surface-hover)';
      button.style.borderColor = 'var(--accent)';
    }
  });

  button.addEventListener('mouseleave', function() {
    if (!button.classList.contains('active') && !button.disabled) {
      button.style.background = 'var(--surface-container)';
      button.style.borderColor = 'var(--border-color)';
    }
  });

  return button;
}