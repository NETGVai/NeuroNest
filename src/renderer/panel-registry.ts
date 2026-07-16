// @ts-nocheck
/**
 * PanelRegistry — Centralized panel registration, lazy loading, and navigation.
 *
 * Provides a single registry used by both the legacy renderer entry point
 * and the decomposed application router. Each panel declares:
 * - Unique id and display metadata (label, icon)
 * - Feature-gate binding (panels hidden/disabled when gate is off)
 * - Group classification (tools, automation, quality, extensions, settings)
 * - Lazy-load function (module fetched only on first access)
 * - Optional command-palette action
 *
 * The registry manages mount/unmount lifecycle, error boundaries per panel,
 * navigation with deep-link identifiers, and localStorage persistence
 * of open state + subview selection.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as feature-management-panel.ts.
 *
 * Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 3.7
 */

// ─── Constants ─────────────────────────────────────────────────────

var PANEL_REGISTRY_STORAGE_KEY = 'neuronest_panel_registry_state';
var PANEL_REGISTRY_SUBVIEW_KEY = 'neuronest_panel_registry_subviews';
var PANEL_GROUPS = ['tools', 'automation', 'quality', 'extensions', 'settings'];

// ─── Helpers ───────────────────────────────────────────────────────

function prEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function prEapi() {
  return window.electronAPI;
}

function prReadStorage(key) {
  try {
    var raw = window.localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    // Corrupted storage — ignore
  }
  return null;
}

function prWriteStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Storage full or unavailable — non-fatal
  }
}

// ─── PanelDefinition shape (documented, not enforced at runtime) ──
// {
//   id: string,
//   label: string,
//   icon: string,
//   featureGate: string|undefined,   // keyof FeatureGateFlags
//   lazy: true,
//   load: function() -> Promise<PanelModule>,
//   group: 'tools'|'automation'|'quality'|'extensions'|'settings',
//   commandPaletteAction: string|undefined
// }
//
// PanelModule shape:
// {
//   render: function(container, options) -> panelInstance,
//   destroy?: function() -> void
// }

// ─── PanelRegistry class ───────────────────────────────────────────

function PanelRegistry() {
  this._definitions = {};       // id -> PanelDefinition
  this._mounted = {};           // id -> { container, instance, errorState }
  this._loadCache = {};         // id -> Promise<PanelModule>
  this._navListeners = [];      // Array of function(id)
  this._commandPaletteEntries = []; // Array of { id, label, action }
  this._openState = prReadStorage(PANEL_REGISTRY_STORAGE_KEY) || {};
  this._subviewState = prReadStorage(PANEL_REGISTRY_SUBVIEW_KEY) || {};
}

// ─── Registration ──────────────────────────────────────────────────

/**
 * Register a panel definition. Overwrites any previous definition with the same id.
 * This ensures a panel is only loaded through the registry, not through unmanaged script tags.
 */
PanelRegistry.prototype.register = function (def) {
  if (!def || !def.id || !def.load) {
    throw new Error('PanelRegistry.register: definition must have id and load function');
  }
  if (typeof def.load !== 'function') {
    throw new Error('PanelRegistry.register: load must be a function returning a Promise');
  }
  if (PANEL_GROUPS.indexOf(def.group) === -1) {
    throw new Error('PanelRegistry.register: group must be one of ' + PANEL_GROUPS.join(', '));
  }

  this._definitions[def.id] = {
    id: def.id,
    label: def.label || def.id,
    icon: def.icon || '',
    featureGate: def.featureGate || null,
    lazy: true,
    load: def.load,
    group: def.group,
    commandPaletteAction: def.commandPaletteAction || null,
  };

  // Register command-palette entry if specified
  if (def.commandPaletteAction) {
    this._commandPaletteEntries.push({
      id: def.id,
      label: def.label || def.id,
      action: def.commandPaletteAction,
    });
  }
};

// ─── Availability (feature-gate check) ────────────────────────────

/**
 * Check if a panel is available given current feature-gate state.
 * A panel without a featureGate is always available.
 * Queries the feature-gate system via IPC synchronously if possible,
 * otherwise assumes available (optimistic for startup speed).
 */
PanelRegistry.prototype.isAvailable = function (id) {
  var def = this._definitions[id];
  if (!def) return false;
  if (!def.featureGate) return true;

  // Check cached gate state if available on window
  if (window._neuronestFeatureGates) {
    var gateState = window._neuronestFeatureGates[def.featureGate];
    if (gateState !== undefined) {
      return !!gateState;
    }
  }

  // If no cached gates, panel is optimistically available
  // (real gate check happens at mount time via async IPC)
  return true;
};

/**
 * Async availability check that queries the feature-gate system via IPC.
 * Returns a Promise<boolean>.
 */
PanelRegistry.prototype.isAvailableAsync = function (id) {
  var def = this._definitions[id];
  if (!def) return Promise.resolve(false);
  if (!def.featureGate) return Promise.resolve(true);

  var api = prEapi();
  if (!api || typeof api.invoke !== 'function') {
    // No IPC available — assume available
    return Promise.resolve(true);
  }

  return api.invoke('feature-gate:get-all', {}).then(function (result) {
    if (!result || !result.success || !result.flags) return true;
    var flags = result.flags;
    for (var i = 0; i < flags.length; i++) {
      if (flags[i].flag === def.featureGate) {
        var effective = flags[i].effective;
        return effective ? effective.enabled && effective.available : true;
      }
    }
    return true;
  }).catch(function () {
    return true; // On error, assume available
  });
};

// ─── Mount ─────────────────────────────────────────────────────────

/**
 * Mount a panel into a container element. Lazy-loads the panel module
 * on first access. Shows an error boundary if loading fails.
 */
PanelRegistry.prototype.mount = function (id, container) {
  var self = this;
  var def = this._definitions[id];

  if (!def) {
    return Promise.reject(new Error('PanelRegistry.mount: unknown panel "' + id + '"'));
  }

  if (!container || !container.appendChild) {
    return Promise.reject(new Error('PanelRegistry.mount: invalid container'));
  }

  // Check feature gate (async)
  return self.isAvailableAsync(id).then(function (available) {
    if (!available) {
      self._renderUnavailable(id, container, def);
      return;
    }

    // Show loading state
    self._renderLoading(id, container, def);

    // Lazy-load the module (cache the promise for deduplication)
    if (!self._loadCache[id]) {
      self._loadCache[id] = def.load();
    }

    return self._loadCache[id].then(function (panelModule) {
      // Clear loading state
      container.innerHTML = '';

      // Validate module
      if (!panelModule || typeof panelModule.render !== 'function') {
        throw new Error('Panel module "' + id + '" does not export a render function');
      }

      // Create a scoped container for the panel
      var panelContainer = document.createElement('div');
      panelContainer.setAttribute('data-panel-id', id);
      panelContainer.style.cssText = 'width:100%;height:100%;';
      container.appendChild(panelContainer);

      // Render the panel
      var options = {
        subview: self._subviewState[id] || null,
        onSubviewChange: function (subview) {
          self._subviewState[id] = subview;
          prWriteStorage(PANEL_REGISTRY_SUBVIEW_KEY, self._subviewState);
        },
      };

      var instance = panelModule.render(panelContainer, options);

      // Track mounted state
      self._mounted[id] = {
        container: container,
        panelContainer: panelContainer,
        instance: instance,
        module: panelModule,
        errorState: false,
      };

      // Persist open state
      self._openState[id] = true;
      prWriteStorage(PANEL_REGISTRY_STORAGE_KEY, self._openState);

    }).catch(function (err) {
      // Error boundary: show recoverable error without breaking other panels
      self._loadCache[id] = null; // Clear failed cache so retry is possible
      self._renderError(id, container, def, err);
    });
  });
};

// ─── Unmount ───────────────────────────────────────────────────────

/**
 * Unmount a panel, calling its destroy method if available, and cleaning up.
 */
PanelRegistry.prototype.unmount = function (id) {
  var mounted = this._mounted[id];
  if (!mounted) return;

  // Call destroy on the instance if available
  if (mounted.instance && typeof mounted.instance.destroy === 'function') {
    try {
      mounted.instance.destroy();
    } catch (e) {
      // Destroy errors are non-fatal
    }
  }

  // Call destroy on the module if available and different from instance
  if (mounted.module && typeof mounted.module.destroy === 'function' && mounted.module !== mounted.instance) {
    try {
      mounted.module.destroy();
    } catch (e) {
      // Non-fatal
    }
  }

  // Clear DOM
  if (mounted.container) {
    mounted.container.innerHTML = '';
  }

  delete this._mounted[id];

  // Update open state
  this._openState[id] = false;
  prWriteStorage(PANEL_REGISTRY_STORAGE_KEY, this._openState);
};

// ─── Navigate ──────────────────────────────────────────────────────

/**
 * Navigate to a panel by id. Notifies registered navigation listeners
 * and updates the application's active view. If the panel is not mounted,
 * listeners are responsible for mounting it in the appropriate container.
 */
PanelRegistry.prototype.navigate = function (id) {
  var def = this._definitions[id];
  if (!def) return;

  if (!this.isAvailable(id)) return;

  // Notify navigation listeners
  for (var i = 0; i < this._navListeners.length; i++) {
    try {
      this._navListeners[i](id, def);
    } catch (e) {
      // Navigation listener errors are non-fatal
    }
  }

  // Send IPC navigation event for deep-link support
  var api = prEapi();
  if (api && typeof api.send === 'function') {
    api.send('panel:navigate', { id: id });
  }
};

// ─── Navigation Listener Registration ─────────────────────────────

/**
 * Register a listener that is called when navigate() is invoked.
 * Returns an unsubscribe function.
 */
PanelRegistry.prototype.onNavigate = function (listener) {
  var self = this;
  if (typeof listener !== 'function') return function () {};
  self._navListeners.push(listener);
  return function () {
    var idx = self._navListeners.indexOf(listener);
    if (idx !== -1) self._navListeners.splice(idx, 1);
  };
};

// ─── Query Methods ─────────────────────────────────────────────────

/**
 * Get all registered panel definitions.
 */
PanelRegistry.prototype.getAll = function () {
  var result = [];
  for (var id in this._definitions) {
    if (Object.prototype.hasOwnProperty.call(this._definitions, id)) {
      result.push(this._definitions[id]);
    }
  }
  return result;
};

/**
 * Get panel definitions filtered by group.
 */
PanelRegistry.prototype.getByGroup = function (group) {
  var result = [];
  for (var id in this._definitions) {
    if (Object.prototype.hasOwnProperty.call(this._definitions, id)) {
      if (this._definitions[id].group === group) {
        result.push(this._definitions[id]);
      }
    }
  }
  return result;
};

/**
 * Get a single panel definition by id.
 */
PanelRegistry.prototype.get = function (id) {
  return this._definitions[id] || null;
};

/**
 * Check if a panel is currently mounted.
 */
PanelRegistry.prototype.isMounted = function (id) {
  return !!this._mounted[id];
};

/**
 * Get persisted open state for a panel.
 */
PanelRegistry.prototype.wasOpen = function (id) {
  return !!this._openState[id];
};

/**
 * Get the persisted subview for a panel.
 */
PanelRegistry.prototype.getSubview = function (id) {
  return this._subviewState[id] || null;
};

/**
 * Set the subview for a panel and persist it.
 */
PanelRegistry.prototype.setSubview = function (id, subview) {
  this._subviewState[id] = subview;
  prWriteStorage(PANEL_REGISTRY_SUBVIEW_KEY, this._subviewState);
};

/**
 * Get all command-palette entries for registered panels.
 */
PanelRegistry.prototype.getCommandPaletteEntries = function () {
  var self = this;
  return this._commandPaletteEntries.filter(function (entry) {
    return self.isAvailable(entry.id);
  });
};

/**
 * Get navigation entries (for sidebar/nav). Only returns available panels.
 */
PanelRegistry.prototype.getNavigationEntries = function () {
  var self = this;
  var entries = [];
  for (var id in this._definitions) {
    if (Object.prototype.hasOwnProperty.call(this._definitions, id)) {
      if (self.isAvailable(id)) {
        var def = self._definitions[id];
        entries.push({
          id: def.id,
          label: def.label,
          icon: def.icon,
          group: def.group,
        });
      }
    }
  }
  return entries;
};

// ─── Error Boundary Rendering ──────────────────────────────────────

/**
 * Render an error state when a panel fails to load.
 * Provides a retry button and does not affect other panels.
 */
PanelRegistry.prototype._renderError = function (id, container, def, err) {
  var self = this;
  container.innerHTML = '';

  var errorEl = document.createElement('div');
  errorEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:120px;padding:24px;text-align:center;';
  errorEl.setAttribute('role', 'alert');
  errorEl.setAttribute('aria-live', 'assertive');

  var iconEl = document.createElement('div');
  iconEl.style.cssText = 'font-size:28px;margin-bottom:12px;opacity:0.7;';
  iconEl.textContent = '\u26A0'; // ⚠ warning
  errorEl.appendChild(iconEl);

  var titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:6px;';
  titleEl.textContent = 'Panel failed to load';
  errorEl.appendChild(titleEl);

  var msgEl = document.createElement('div');
  msgEl.style.cssText = 'font-size:12px;color:var(--text-secondary,#a6adc8);margin-bottom:16px;max-width:300px;word-break:break-word;';
  msgEl.textContent = (def.label || id) + ' encountered an error: ' + (err && err.message ? err.message : 'Unknown error');
  errorEl.appendChild(msgEl);

  var retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.style.cssText = 'font-size:12px;padding:6px 16px;border-radius:6px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);cursor:pointer;';
  retryBtn.textContent = 'Retry';
  retryBtn.setAttribute('aria-label', 'Retry loading ' + (def.label || id));
  retryBtn.addEventListener('click', function () {
    self.mount(id, container);
  });
  errorEl.appendChild(retryBtn);

  container.appendChild(errorEl);

  // Track error state
  self._mounted[id] = {
    container: container,
    panelContainer: null,
    instance: null,
    module: null,
    errorState: true,
  };
};

/**
 * Render an unavailable state when feature gate prevents access.
 */
PanelRegistry.prototype._renderUnavailable = function (id, container, def) {
  container.innerHTML = '';

  var el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:120px;padding:24px;text-align:center;opacity:0.6;';

  var iconEl = document.createElement('div');
  iconEl.style.cssText = 'font-size:28px;margin-bottom:12px;';
  iconEl.textContent = '\uD83D\uDD12'; // 🔒
  el.appendChild(iconEl);

  var titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:6px;';
  titleEl.textContent = (def.label || id) + ' is unavailable';
  el.appendChild(titleEl);

  var msgEl = document.createElement('div');
  msgEl.style.cssText = 'font-size:12px;color:var(--text-secondary,#a6adc8);max-width:300px;';
  msgEl.textContent = 'This panel requires the "' + (def.featureGate || 'unknown') + '" feature to be enabled.';
  el.appendChild(msgEl);

  container.appendChild(el);
};

/**
 * Render a loading state while the panel module is being fetched.
 */
PanelRegistry.prototype._renderLoading = function (id, container, def) {
  container.innerHTML = '';

  var el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:80px;padding:16px;';

  var spinner = document.createElement('div');
  spinner.style.cssText = 'width:20px;height:20px;border:2px solid var(--border-color,#313244);border-top-color:var(--accent-color,#89b4fa);border-radius:50%;animation:prSpin 0.6s linear infinite;margin-bottom:8px;';
  el.appendChild(spinner);

  var labelEl = document.createElement('div');
  labelEl.style.cssText = 'font-size:12px;color:var(--text-secondary,#a6adc8);';
  labelEl.textContent = 'Loading ' + (def.label || id) + '...';
  el.appendChild(labelEl);

  container.appendChild(el);

  // Inject spinner keyframes if not already present
  if (!document.getElementById('pr-spin-keyframes')) {
    var style = document.createElement('style');
    style.id = 'pr-spin-keyframes';
    style.textContent = '@keyframes prSpin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }
};

// ─── Singleton Instance ────────────────────────────────────────────

var _panelRegistryInstance = null;

/**
 * Get or create the singleton PanelRegistry instance.
 */
function getPanelRegistry() {
  if (!_panelRegistryInstance) {
    _panelRegistryInstance = new PanelRegistry();
  }
  return _panelRegistryInstance;
}

// ─── Exports ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PanelRegistry: PanelRegistry,
    getPanelRegistry: getPanelRegistry,
  };
}

// Expose to renderer global scope
if (typeof window !== 'undefined') {
  window.PanelRegistry = PanelRegistry;
  window.getPanelRegistry = getPanelRegistry;
}
