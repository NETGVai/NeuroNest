// @ts-nocheck
/**
 * Panel Registrations — Registers all orphaned panels in the centralized PanelRegistry.
 *
 * This file imports or references each panel module using lazy-load functions and
 * calls `getPanelRegistry().register(...)` for each panel with appropriate metadata.
 *
 * Panels registered here were previously orphaned (loaded via direct script tags or
 * instantiated ad-hoc in renderer code). This file provides the single common
 * registration path per Requirement 3.2, 3.7, 3.8.
 *
 * The metrics-panel is also migrated from its unmanaged `<script>` tag loading
 * into the registry-managed path (Requirement 3.7, 3.8).
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as panel-registry.ts.
 *
 * Requirements: 3.2, 3.7, 3.8
 */

// ─── Lazy-load adapter ─────────────────────────────────────────────
//
// Each panel is a plain-JS file that exposes its constructor on `window`
// when loaded. The lazy-load functions dynamically inject a <script> tag
// on first access (true lazy loading — no startup cost). Once the script
// loads, the constructor is available on `window` and we adapt it into
// the PanelModule contract: { render(container, options), destroy?() }.

/**
 * Dynamically loads a script by injecting a <script> tag and returns
 * a Promise that resolves once the script finishes loading.
 */
function loadScript(src) {
  return new Promise(function (resolve, reject) {
    // Check if already loaded
    var existing = document.querySelector('script[src="' + src + '"]');
    if (existing) {
      resolve();
      return;
    }
    var script = document.createElement('script');
    script.src = src;
    script.onload = function () { resolve(); };
    script.onerror = function () { reject(new Error('Failed to load script: ' + src)); };
    document.head.appendChild(script);
  });
}

/**
 * Creates a lazy-load function that dynamically loads a panel script file,
 * then resolves a panel module from a window global constructor.
 *
 * @param scriptPath - Relative path to the panel's .js file
 * @param globalName - The window property name for the panel constructor
 * @param constructorArgs - Factory function to create constructor arguments
 */
function createWindowPanelLoader(scriptPath, globalName, constructorArgs) {
  return function () {
    // If already on window, skip script loading
    if (window[globalName]) {
      return Promise.resolve({
        render: function (container, options) {
          var Ctor = window[globalName];
          var args = constructorArgs ? constructorArgs(container, options) : [container];
          var instance;
          switch (args.length) {
            case 1: instance = new Ctor(args[0]); break;
            case 2: instance = new Ctor(args[0], args[1]); break;
            case 3: instance = new Ctor(args[0], args[1], args[2]); break;
            default: instance = new Ctor(args[0]); break;
          }
          if (typeof instance.render === 'function') {
            instance.render();
          }
          return instance;
        },
        destroy: function () { },
      });
    }

    return loadScript(scriptPath).then(function () {
      var Ctor = window[globalName];
      if (!Ctor) {
        throw new Error('Panel constructor "' + globalName + '" not found on window after loading ' + scriptPath);
      }
      return {
        render: function (container, options) {
          var args = constructorArgs ? constructorArgs(container, options) : [container];
          var instance;
          switch (args.length) {
            case 1: instance = new Ctor(args[0]); break;
            case 2: instance = new Ctor(args[0], args[1]); break;
            case 3: instance = new Ctor(args[0], args[1], args[2]); break;
            default: instance = new Ctor(args[0]); break;
          }
          if (typeof instance.render === 'function') {
            instance.render();
          }
          return instance;
        },
        destroy: function () { },
      };
    });
  };
}

/**
 * Creates a lazy-load function for panels that use a standalone render function
 * exposed on window (e.g., `window.renderMetricsPanel(container)`).
 *
 * @param scriptPath - Relative path to the panel's .js file
 * @param renderFnName - The window property name for the render function
 */
function createWindowRenderFnLoader(scriptPath, renderFnName) {
  return function () {
    if (window[renderFnName] && typeof window[renderFnName] === 'function') {
      return Promise.resolve({
        render: function (container, options) {
          return window[renderFnName](container, options);
        },
      });
    }

    return loadScript(scriptPath).then(function () {
      var renderFn = window[renderFnName];
      if (!renderFn || typeof renderFn !== 'function') {
        throw new Error('Panel render function "' + renderFnName + '" not found on window after loading ' + scriptPath);
      }
      return {
        render: function (container, options) {
          return renderFn(container, options);
        },
      };
    });
  };
}

// ─── Registration ──────────────────────────────────────────────────

function registerAllPanels() {
  var registry = window.getPanelRegistry ? window.getPanelRegistry() : null;
  if (!registry) {
    console.warn('[panel-registrations] PanelRegistry not available. Skipping registration.');
    return;
  }

  // ────────────────────────────────────────────────────────────────
  // 1. Interactive Terminal
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'interactive-terminal',
    label: 'Interactive Terminal',
    icon: '\u2328',  // ⌨
    featureGate: 'interactive_terminal',
    group: 'tools',
    commandPaletteAction: 'Open Interactive Terminal',
    load: createWindowPanelLoader('./interactive-terminal-panel.js', 'InteractiveTerminalPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Network Activity
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'network-activity',
    label: 'Network Activity',
    icon: '\uD83C\uDF10',  // 🌐
    featureGate: 'network_sandbox',
    group: 'tools',
    commandPaletteAction: 'Open Network Activity',
    load: createWindowPanelLoader('./network-activity-panel.js', 'NetworkActivityPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Plugin Manager
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'plugin-manager',
    label: 'Plugin Manager',
    icon: '\uD83D\uDD0C',  // 🔌
    featureGate: 'plugin_system',
    group: 'extensions',
    commandPaletteAction: 'Open Plugin Manager',
    load: createWindowPanelLoader('./plugin-panel.js', 'PluginPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Worktree Manager
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'worktree-manager',
    label: 'Worktree Manager',
    icon: '\uD83C\uDF33',  // 🌳
    featureGate: 'worktree_agent_manager',
    group: 'tools',
    commandPaletteAction: 'Open Worktree Manager',
    load: createWindowPanelLoader('./worktree-panel.js', 'WorktreeManagerPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Cost Controls
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'cost-controls',
    label: 'Cost Controls',
    icon: '\uD83D\uDCB0',  // 💰
    featureGate: 'cost_controls',
    group: 'settings',
    commandPaletteAction: 'Open Cost Controls',
    load: createWindowPanelLoader('./cost-controls-panel.js', 'CostSummaryPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Diff Viewer
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'diff-viewer',
    label: 'Diff Viewer',
    icon: '\uD83D\uDCC4',  // 📄
    featureGate: 'diff_viewer',
    group: 'quality',
    commandPaletteAction: 'Open Diff Viewer',
    load: createWindowPanelLoader('./diff-viewer-panel.js', 'DiffViewerPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 7. Checkpoint Timeline
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'checkpoint-timeline',
    label: 'Checkpoint Timeline',
    icon: '\u23F3',  // ⏳
    featureGate: 'checkpoint_timeline',
    group: 'quality',
    commandPaletteAction: 'Open Checkpoint Timeline',
    load: createWindowPanelLoader('./checkpoint-timeline-panel.js', 'CheckpointTimelinePanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 8. Marketplace
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'marketplace',
    label: 'MCP Marketplace',
    icon: '\uD83D\uDED2',  // 🛒
    featureGate: 'mcp_marketplace',
    group: 'extensions',
    commandPaletteAction: 'Open MCP Marketplace',
    load: createWindowPanelLoader('./marketplace-panel.js', 'MarketplacePanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 9. Process Manager
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'process-manager',
    label: 'Process Manager',
    icon: '\u2699',  // ⚙
    featureGate: 'background_processes',
    group: 'tools',
    commandPaletteAction: 'Open Process Manager',
    load: createWindowPanelLoader('./process-manager-panel.js', 'ProcessManagerPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 10. Analytics Dashboard
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'analytics-dashboard',
    label: 'Analytics Dashboard',
    icon: '\uD83D\uDCCA',  // 📊
    featureGate: 'adoption_dashboard',
    group: 'settings',
    commandPaletteAction: 'Open Analytics Dashboard',
    load: createWindowPanelLoader('./analytics-dashboard-panel.js', 'AnalyticsDashboardPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 11. Notebook
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'notebook',
    label: 'Notebook',
    icon: '\uD83D\uDCD3',  // 📓
    featureGate: 'notebook_integration',
    group: 'tools',
    commandPaletteAction: 'Open Notebook',
    load: createWindowPanelLoader('./notebook-panel.js', 'NotebookPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 12. Cross-Session Memory
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'cross-session-memory',
    label: 'Cross-Session Memory',
    icon: '\uD83E\uDDE0',  // 🧠
    featureGate: 'cross_session_memory',
    group: 'settings',
    commandPaletteAction: 'Open Cross-Session Memory',
    load: createWindowPanelLoader('./memory-panel.js', 'MemoryPanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 13. Automation Workspace
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'automation-workspace',
    label: 'Automation',
    icon: '\uD83D\uDD04',  // 🔄
    featureGate: null,
    group: 'automation',
    commandPaletteAction: 'Open Automation Workspace',
    load: createWindowPanelLoader('./automation-workspace-panel.js', 'AutomationWorkspacePanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 14. Drift & Intelligence Workspace
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'drift-intelligence-workspace',
    label: 'Drift & Intelligence',
    icon: '\uD83C\uDFAF',  // 🎯
    featureGate: null,
    group: 'tools',
    commandPaletteAction: 'Open Drift & Intelligence',
    load: createWindowPanelLoader('./drift-intelligence-workspace-panel.js', 'DriftIntelligenceWorkspacePanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 15. Extensions Workspace
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'extensions-workspace',
    label: 'Extensions & Skills',
    icon: '\uD83D\uDD0C',  // 🔌
    featureGate: null,
    group: 'extensions',
    commandPaletteAction: 'Open Extensions Workspace',
    load: createWindowPanelLoader('./extensions-workspace-panel.js', 'ExtensionsWorkspacePanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 16. Quality, Review & Security Workspace
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'quality-review-security-workspace',
    label: 'Quality & Security',
    icon: '\uD83D\uDD12',  // 🔒
    featureGate: null,
    group: 'quality',
    commandPaletteAction: 'Open Quality & Security',
    load: createWindowPanelLoader('./quality-review-security-workspace-panel.js', 'QualityReviewSecurityWorkspacePanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 17. Management Surfaces
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'management-surfaces',
    label: 'Management',
    icon: '\u2699',  // ⚙
    featureGate: null,
    group: 'settings',
    commandPaletteAction: 'Open Management',
    load: createWindowPanelLoader('./management-surfaces-panel.js', 'ManagementSurfacesPanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 18. Agent Dashboard v2
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'agent-dashboard-v2',
    label: 'Agent Dashboard',
    icon: '\uD83D\uDC65',  // 👥
    featureGate: null,
    group: 'tools',
    commandPaletteAction: 'Open Agent Dashboard',
    load: function () {
      // Load base utilities first, then the main panel
      return loadScript('./agent-dashboard-v2-base.js').then(function () {
        return loadScript('./agent-dashboard-v2-panel.js');
      }).then(function () {
        var Ctor = window.AgentDashboardV2Panel;
        if (!Ctor) throw new Error('AgentDashboardV2Panel not found on window');
        return {
          render: function (container) {
            var instance = new Ctor(container);
            if (typeof instance.render === 'function') instance.render();
            return instance;
          },
          destroy: function () { },
        };
      });
    },
  });

  // ────────────────────────────────────────────────────────────────
  // 19. Knowledge Base Management
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'kb-management',
    label: 'Knowledge Base',
    icon: '\uD83D\uDCDA',  // 📚
    featureGate: 'kb_system',
    group: 'tools',
    commandPaletteAction: 'Open Knowledge Base',
    load: createWindowPanelLoader('./kb-management-panel.js', 'KBManagementPanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 20. Training Progress
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'training-progress',
    label: 'Training Progress',
    icon: '\uD83C\uDFCB',  // 🏋
    featureGate: 'training_pipeline',
    group: 'tools',
    commandPaletteAction: 'Open Training Progress',
    load: createWindowPanelLoader('./training-progress-panel.js', 'TrainingProgressPanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 20b. Training Configuration
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'training-config',
    label: 'Training Configuration',
    icon: '\u2699',  // ⚙
    featureGate: 'training_pipeline',
    group: 'tools',
    commandPaletteAction: 'Open Training Configuration',
    load: createWindowPanelLoader('./training-config-panel.js', 'TrainingConfigPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 20c. Model Comparison
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'model-comparison',
    label: 'Model Comparison',
    icon: '\u2696',  // ⚖
    featureGate: 'training_pipeline',
    group: 'tools',
    commandPaletteAction: 'Open Model Comparison',
    load: createWindowPanelLoader('./model-comparison-panel.js', 'ModelComparisonPanel', function (container) {
      return [container, { projectId: window._neuronestActiveProject || 'default' }];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 21. File Tree Panel (sidebar)
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'file-tree',
    label: 'File Tree',
    icon: '\uD83D\uDCC1',  // 📁
    featureGate: 'file_tree_panel',
    group: 'tools',
    commandPaletteAction: 'Open File Tree',
    load: createWindowPanelLoader('./file-tree-panel.js', 'FileTreePanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 22. Spec Viewer Panel
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'spec-viewer',
    label: 'Spec Viewer',
    icon: '\uD83D\uDCCB',  // 📋
    featureGate: 'spec_viewer_panel',
    group: 'tools',
    commandPaletteAction: 'Open Spec Viewer',
    load: createWindowPanelLoader('./spec-viewer-panel.js', 'SpecViewerPanel', function (container) {
      return [container];
    }),
  });

  // ────────────────────────────────────────────────────────────────
  // 23. Metrics Panel (migrated from unmanaged <script> tag)
  //
  // Previously loaded exclusively via `<script src="./metrics-panel.js">`
  // in index.html. Now registered through the common registry path per
  // Requirement 3.7, 3.8. The metrics-panel script tag is retained for
  // backward compatibility during migration. No dedicated feature gate.
  // ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'metrics-panel',
    label: 'Metrics Dashboard',
    icon: '\uD83D\uDCC8',  // 📈
    featureGate: null,
    group: 'settings',
    commandPaletteAction: 'Open Metrics Dashboard',
    load: createWindowRenderFnLoader('./metrics-panel.js', 'renderMetricsPanel'),
  });
}

// ─── Auto-register on script load ──────────────────────────────────

// Execute registration when this script loads. The panel-registry.ts must
// be loaded before this file so that getPanelRegistry() is available.
if (typeof window !== 'undefined') {
  // Defer registration slightly to ensure panel-registry.ts has executed
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerAllPanels);
  } else {
    registerAllPanels();
  }
}

// ─── Exports ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    registerAllPanels: registerAllPanels,
    createWindowPanelLoader: createWindowPanelLoader,
    createWindowRenderFnLoader: createWindowRenderFnLoader,
    loadScript: loadScript,
  };
}

if (typeof window !== 'undefined') {
  window.registerAllPanels = registerAllPanels;
}
