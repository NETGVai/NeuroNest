/**
 * PluginPanel — Renderer panel for managing plugins.
 *
 * Displays installed plugins with:
 * - Enable/disable toggle
 * - Uninstall button
 * - Plugin capabilities, version, and health status
 * - Install new plugins from URL
 *
 * Wires IPC channels: plugin:install, plugin:uninstall, plugin:list,
 * plugin:enable, plugin:disable
 *
 * Gated behind `plugin_system` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as worktree-panel.ts.
 *
 * Requirements: 21.7
 */

// ─── Helpers ───────────────────────────────────────────────────────
function pluginPanelEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function pluginPanelEapi() {
  return window.electronAPI;
}

// ─── Status badge colors ──────────────────────────────────────────
var PLUGIN_STATE_COLORS = {
  loaded: '#60a5fa',    // blue
  active: '#34d399',    // green
  disabled: '#6b7280',  // gray
  error: '#f87171',     // red
};

// ─── PluginPanel class ────────────────────────────────────────────
function PluginPanel(container) {
  this.container = container;
  this.plugins = [];
  this.refreshTimer = null;
}

PluginPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Plugin Manager';
  header.appendChild(title);

  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;';

  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.refreshPlugins(); });
  headerActions.appendChild(refreshBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Install form
  var installRow = document.createElement('div');
  installRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;';

  var installInput = document.createElement('input');
  installInput.type = 'text';
  installInput.placeholder = 'Package URL or plugin name...';
  installInput.style.cssText = 'flex:1;font-size:11px;padding:6px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);border-radius:6px;';
  installRow.appendChild(installInput);

  var installBtn = document.createElement('button');
  installBtn.type = 'button';
  installBtn.textContent = 'Install';
  installBtn.style.cssText = 'font-size:11px;padding:6px 14px;border:1px solid #34d399;background:rgba(52,211,153,0.1);color:#34d399;border-radius:6px;cursor:pointer;font-weight:600;';
  installBtn.addEventListener('click', function () {
    var url = installInput.value.trim();
    if (url) self.installPlugin(url);
  });
  installRow.appendChild(installBtn);

  this.container.appendChild(installRow);

  // Status message area
  this.statusArea = document.createElement('div');
  this.statusArea.style.cssText = 'display:none;font-size:11px;padding:6px 10px;margin-bottom:10px;border-radius:6px;';
  this.container.appendChild(this.statusArea);

  // Plugin list container
  this.listRoot = document.createElement('div');
  this.listRoot.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
  this.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Loading plugins...</div>';
  this.container.appendChild(this.listRoot);

  // Initial load
  this.refreshPlugins();

  // Auto-refresh every 60s
  if (this.refreshTimer) clearInterval(this.refreshTimer);
  this.refreshTimer = setInterval(function () { self.refreshPlugins(); }, 60000);
};

PluginPanel.prototype.refreshPlugins = function () {
  var self = this;
  var eapi = pluginPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('plugin:list');
  } catch (e) {
    self.renderError('Failed to list plugins');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.error) {
      self.renderError(result.message || 'Failed to load plugins');
      return;
    }
    if (Array.isArray(result)) {
      self.plugins = result;
      self.renderPluginList();
    } else {
      self.plugins = [];
      self.renderPluginList();
    }
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Failed to load plugins');
  });
};

PluginPanel.prototype.renderPluginList = function () {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';

  if (this.plugins.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:24px 8px;text-align:center;';
    empty.textContent = 'No plugins installed. Use the input above to install a plugin from a URL.';
    this.listRoot.appendChild(empty);
    return;
  }

  var self = this;
  var i;
  for (i = 0; i < this.plugins.length; i++) {
    var plugin = this.plugins[i];
    var card = self.renderPluginCard(plugin);
    this.listRoot.appendChild(card);
  }
};

PluginPanel.prototype.renderPluginCard = function (plugin) {
  var self = this;
  var card = document.createElement('div');
  card.className = 'dash-card';
  card.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:8px;';
  card.setAttribute('data-plugin-id', plugin.id || '');

  // Top row: status badge + plugin name + version
  var topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

  // Status badge
  var statusBadge = document.createElement('span');
  var stateColor = PLUGIN_STATE_COLORS[plugin.state] || '#6b7280';
  statusBadge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;color:#fff;background:' + stateColor + ';text-transform:uppercase;';
  statusBadge.textContent = plugin.state || 'unknown';
  topRow.appendChild(statusBadge);

  // Plugin name
  var nameLabel = document.createElement('span');
  nameLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
  nameLabel.textContent = plugin.name || plugin.id || '';
  topRow.appendChild(nameLabel);

  // Version
  var versionLabel = document.createElement('span');
  versionLabel.style.cssText = 'font-size:10px;color:var(--text-dim);font-family:monospace;';
  versionLabel.textContent = 'v' + (plugin.version || '0.0.0');
  topRow.appendChild(versionLabel);

  card.appendChild(topRow);

  // Description
  if (plugin.description) {
    var descRow = document.createElement('div');
    descRow.style.cssText = 'font-size:11px;color:var(--text-secondary);';
    descRow.textContent = plugin.description;
    card.appendChild(descRow);
  }

  // Author
  if (plugin.author) {
    var authorRow = document.createElement('div');
    authorRow.style.cssText = 'font-size:10px;color:var(--text-dim);';
    authorRow.textContent = 'by ' + plugin.author;
    card.appendChild(authorRow);
  }

  // Permissions
  if (plugin.permissions && plugin.permissions.length > 0) {
    var permRow = document.createElement('div');
    permRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    var j;
    for (j = 0; j < plugin.permissions.length; j++) {
      var permBadge = document.createElement('span');
      permBadge.style.cssText = 'font-size:9px;padding:1px 6px;border-radius:8px;background:rgba(96,165,250,0.15);color:#60a5fa;';
      permBadge.textContent = plugin.permissions[j];
      permRow.appendChild(permBadge);
    }
    card.appendChild(permRow);
  }

  // Action buttons
  var actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';

  // Enable/Disable toggle
  var isActive = plugin.state === 'active';
  var toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.textContent = isActive ? 'Disable' : 'Enable';
  toggleBtn.style.cssText = isActive
    ? 'font-size:10px;padding:3px 8px;border:1px solid #fbbf24;background:rgba(251,191,36,0.1);color:#fbbf24;border-radius:4px;cursor:pointer;'
    : 'font-size:10px;padding:3px 8px;border:1px solid #34d399;background:rgba(52,211,153,0.1);color:#34d399;border-radius:4px;cursor:pointer;';

  // Disable the toggle if plugin is in error state
  if (plugin.state === 'error') {
    toggleBtn.disabled = true;
    toggleBtn.style.cssText += 'opacity:0.5;cursor:not-allowed;';
  }

  toggleBtn.addEventListener('click', (function (p) {
    return function () {
      if (p.state === 'active') {
        self.disablePlugin(p.id);
      } else {
        self.enablePlugin(p.id);
      }
    };
  })(plugin));
  actionsRow.appendChild(toggleBtn);

  // Uninstall button
  var uninstallBtn = document.createElement('button');
  uninstallBtn.type = 'button';
  uninstallBtn.textContent = 'Uninstall';
  uninstallBtn.style.cssText = 'font-size:10px;padding:3px 8px;border:1px solid #f87171;background:rgba(248,113,113,0.1);color:#f87171;border-radius:4px;cursor:pointer;';
  uninstallBtn.addEventListener('click', (function (p) {
    return function () { self.uninstallPlugin(p.id); };
  })(plugin));
  actionsRow.appendChild(uninstallBtn);

  card.appendChild(actionsRow);

  return card;
};

PluginPanel.prototype.installPlugin = function (packageUrl) {
  var self = this;
  var eapi = pluginPanelEapi();
  if (!eapi) return;

  self.showStatus('Installing...', 'info');

  var p;
  try {
    p = eapi.invoke('plugin:install', { packageUrl: packageUrl });
  } catch (e) {
    self.showStatus('Install failed: ' + (e && e.message ? e.message : 'Unknown error'), 'error');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.error) {
      self.showStatus('Install failed: ' + (result.message || 'Unknown error'), 'error');
    } else {
      self.showStatus('Plugin installed successfully', 'success');
      self.refreshPlugins();
    }
  }).catch(function (err) {
    self.showStatus('Install failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
  });
};

PluginPanel.prototype.enablePlugin = function (pluginId) {
  var self = this;
  var eapi = pluginPanelEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('plugin:enable', { pluginId: pluginId });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.error) {
      self.showStatus('Enable failed: ' + (result.message || 'Unknown error'), 'error');
    } else {
      self.refreshPlugins();
    }
  }).catch(function () {
    self.showStatus('Enable request failed', 'error');
  });
};

PluginPanel.prototype.disablePlugin = function (pluginId) {
  var self = this;
  var eapi = pluginPanelEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('plugin:disable', { pluginId: pluginId });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.error) {
      self.showStatus('Disable failed: ' + (result.message || 'Unknown error'), 'error');
    } else {
      self.refreshPlugins();
    }
  }).catch(function () {
    self.showStatus('Disable request failed', 'error');
  });
};

PluginPanel.prototype.uninstallPlugin = function (pluginId) {
  var self = this;
  var eapi = pluginPanelEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('plugin:uninstall', { pluginId: pluginId });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.error) {
      self.showStatus('Uninstall failed: ' + (result.message || 'Unknown error'), 'error');
    } else {
      self.showStatus('Plugin uninstalled', 'success');
      self.refreshPlugins();
    }
  }).catch(function () {
    self.showStatus('Uninstall request failed', 'error');
  });
};

PluginPanel.prototype.showStatus = function (message, type) {
  if (!this.statusArea) return;
  this.statusArea.style.display = 'block';
  this.statusArea.textContent = message;

  if (type === 'error') {
    this.statusArea.style.background = 'rgba(248,113,113,0.1)';
    this.statusArea.style.color = '#f87171';
    this.statusArea.style.border = '1px solid rgba(248,113,113,0.3)';
  } else if (type === 'success') {
    this.statusArea.style.background = 'rgba(52,211,153,0.1)';
    this.statusArea.style.color = '#34d399';
    this.statusArea.style.border = '1px solid rgba(52,211,153,0.3)';
  } else {
    this.statusArea.style.background = 'rgba(96,165,250,0.1)';
    this.statusArea.style.color = '#60a5fa';
    this.statusArea.style.border = '1px solid rgba(96,165,250,0.3)';
  }

  var self = this;
  setTimeout(function () {
    if (self.statusArea) self.statusArea.style.display = 'none';
  }, 5000);
};

PluginPanel.prototype.renderError = function (message) {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:16px 8px;text-align:center;';
  errDiv.textContent = message || 'Error loading plugins';
  this.listRoot.appendChild(errDiv);
};

PluginPanel.prototype.destroy = function () {
  if (this.refreshTimer) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
};

// ─── Convenience entry point ──────────────────────────────────────
function renderPluginPanel(container) {
  var panel = new PluginPanel(container);
  panel.render();
  return panel;
}

// Expose to renderer global scope
if (typeof window !== 'undefined') {
  window.PluginPanel = PluginPanel;
  window.renderPluginPanel = renderPluginPanel;
}
