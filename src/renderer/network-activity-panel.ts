/**
 * NetworkActivityPanel — Renderer panel for real-time network sandbox monitoring.
 *
 * Displays:
 * - Real-time allowed/blocked network request activity
 * - Filter by session, agent, domain, status (allowed/blocked)
 * - Summary stats (total, allowed, blocked counts)
 * - Top domains list with block counts
 * - Policy preset indicator with switch controls
 *
 * Wires IPC channels: sandbox:policy-get, sandbox:policy-set, sandbox:log, sandbox:activity
 *
 * Gated behind `network_sandbox` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as worktree-panel.ts.
 *
 * Requirements: 10.7
 */

// ─── Helpers ───────────────────────────────────────────────────────
function networkPanelEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function networkPanelEapi() {
  return window.electronAPI;
}

// ─── Status badge colors ──────────────────────────────────────────
var NETWORK_ACTION_COLORS = {
  allowed: '#34d399',  // green
  blocked: '#f87171',  // red
};

var NETWORK_PRESET_COLORS = {
  permissive: '#60a5fa', // blue
  standard: '#fbbf24',   // amber
  strict: '#f87171',     // red
};

// ─── NetworkActivityPanel class ───────────────────────────────────
function NetworkActivityPanel(container, sessionId) {
  this.container = container;
  this.sessionId = sessionId || '';
  this.entries = [];
  this.currentPolicy = null;
  this.filters = {
    action: '',     // '' = all, 'allowed', 'blocked'
    domain: '',     // domain substring filter
    agentId: '',    // agent ID filter
  };
  this.refreshTimer = null;
  this.activityHandler = null;
}

NetworkActivityPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Network Activity';
  header.appendChild(title);

  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;align-items:center;';

  // Policy badge
  this.policyBadge = document.createElement('span');
  this.policyBadge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;color:#fff;background:#6b7280;text-transform:uppercase;';
  this.policyBadge.textContent = '...';
  headerActions.appendChild(this.policyBadge);

  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.refreshActivity(); });
  headerActions.appendChild(refreshBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Stats summary row
  this.statsRow = document.createElement('div');
  this.statsRow.style.cssText = 'display:flex;gap:16px;margin-bottom:12px;font-size:11px;';
  this.container.appendChild(this.statsRow);

  // Filter controls
  var filterRow = document.createElement('div');
  filterRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;';

  // Status filter
  var statusSelect = document.createElement('select');
  statusSelect.style.cssText = 'font-size:11px;padding:3px 6px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;';
  statusSelect.innerHTML = '<option value="">All Status</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option>';
  statusSelect.addEventListener('change', function () {
    self.filters.action = statusSelect.value;
    self.renderRequestList();
  });
  filterRow.appendChild(statusSelect);

  // Domain filter input
  var domainInput = document.createElement('input');
  domainInput.type = 'text';
  domainInput.placeholder = 'Filter by domain...';
  domainInput.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;width:140px;';
  domainInput.addEventListener('input', function () {
    self.filters.domain = domainInput.value.trim().toLowerCase();
    self.renderRequestList();
  });
  filterRow.appendChild(domainInput);

  // Agent filter input
  var agentInput = document.createElement('input');
  agentInput.type = 'text';
  agentInput.placeholder = 'Filter by agent...';
  agentInput.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;width:120px;';
  agentInput.addEventListener('input', function () {
    self.filters.agentId = agentInput.value.trim();
    self.renderRequestList();
  });
  filterRow.appendChild(agentInput);

  this.container.appendChild(filterRow);

  // Policy controls row
  var policyRow = document.createElement('div');
  policyRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;align-items:center;';

  var policyLabel = document.createElement('span');
  policyLabel.style.cssText = 'font-size:11px;color:var(--text-dim);';
  policyLabel.textContent = 'Policy:';
  policyRow.appendChild(policyLabel);

  var presets = ['permissive', 'standard', 'strict'];
  for (var i = 0; i < presets.length; i++) {
    var presetBtn = document.createElement('button');
    presetBtn.type = 'button';
    presetBtn.textContent = presets[i];
    presetBtn.style.cssText = 'font-size:10px;padding:2px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;text-transform:capitalize;';
    presetBtn.setAttribute('data-preset', presets[i]);
    presetBtn.addEventListener('click', (function (preset) {
      return function () { self.setPreset(preset); };
    })(presets[i]));
    policyRow.appendChild(presetBtn);
  }

  this.container.appendChild(policyRow);

  // Top domains section
  this.topDomainsRoot = document.createElement('div');
  this.topDomainsRoot.style.cssText = 'margin-bottom:12px;';
  this.container.appendChild(this.topDomainsRoot);

  // Request list container
  this.listRoot = document.createElement('div');
  this.listRoot.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto;';
  this.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Loading network activity...</div>';
  this.container.appendChild(this.listRoot);

  // Initial load
  this.refreshActivity();
  this.loadPolicy();

  // Auto-refresh every 10s
  if (this.refreshTimer) clearInterval(this.refreshTimer);
  this.refreshTimer = setInterval(function () { self.refreshActivity(); }, 10000);
};

NetworkActivityPanel.prototype.loadPolicy = function () {
  var self = this;
  var eapi = networkPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('sandbox:policy-get');
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.policy) {
      self.currentPolicy = result.policy;
      self.updatePolicyBadge();
    }
  }).catch(function () {});
};

NetworkActivityPanel.prototype.updatePolicyBadge = function () {
  if (!this.policyBadge || !this.currentPolicy) return;
  var preset = this.currentPolicy.preset || 'unknown';
  var color = NETWORK_PRESET_COLORS[preset] || '#6b7280';
  this.policyBadge.style.background = color;
  this.policyBadge.textContent = preset;
};

NetworkActivityPanel.prototype.setPreset = function (preset) {
  var self = this;
  var eapi = networkPanelEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('sandbox:policy-set', { preset: preset });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.policy) {
      self.currentPolicy = result.policy;
      self.updatePolicyBadge();
    }
  }).catch(function () {});
};

NetworkActivityPanel.prototype.refreshActivity = function () {
  var self = this;
  var eapi = networkPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('sandbox:activity', { sessionId: self.sessionId, limit: 100 });
  } catch (e) {
    self.renderError('Failed to load network activity');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.error) {
      self.renderError(result.message || 'Feature disabled');
      return;
    }
    if (result && typeof result.totalRequests === 'number') {
      self.entries = result.recentRequests || [];
      self.renderStats(result);
      self.renderTopDomains(result.topDomains || []);
      self.renderRequestList();
    } else {
      self.entries = [];
      self.renderStats({ totalRequests: 0, allowedCount: 0, blockedCount: 0 });
      self.renderTopDomains([]);
      self.renderRequestList();
    }
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Failed to load activity');
  });
};

NetworkActivityPanel.prototype.renderStats = function (summary) {
  if (!this.statsRow) return;
  this.statsRow.innerHTML = '';

  var totalStat = document.createElement('div');
  totalStat.style.cssText = 'display:flex;align-items:center;gap:4px;';
  totalStat.innerHTML = '<span style="color:var(--text-dim);">Total:</span><span style="color:var(--text-secondary);font-weight:600;">' + (summary.totalRequests || 0) + '</span>';
  this.statsRow.appendChild(totalStat);

  var allowedStat = document.createElement('div');
  allowedStat.style.cssText = 'display:flex;align-items:center;gap:4px;';
  allowedStat.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#34d399;display:inline-block;"></span><span style="color:var(--text-dim);">Allowed:</span><span style="color:#34d399;font-weight:600;">' + (summary.allowedCount || 0) + '</span>';
  this.statsRow.appendChild(allowedStat);

  var blockedStat = document.createElement('div');
  blockedStat.style.cssText = 'display:flex;align-items:center;gap:4px;';
  blockedStat.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#f87171;display:inline-block;"></span><span style="color:var(--text-dim);">Blocked:</span><span style="color:#f87171;font-weight:600;">' + (summary.blockedCount || 0) + '</span>';
  this.statsRow.appendChild(blockedStat);
};

NetworkActivityPanel.prototype.renderTopDomains = function (topDomains) {
  if (!this.topDomainsRoot) return;
  this.topDomainsRoot.innerHTML = '';

  if (!topDomains || topDomains.length === 0) return;

  var heading = document.createElement('div');
  heading.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;';
  heading.textContent = 'Top Domains';
  this.topDomainsRoot.appendChild(heading);

  var domainList = document.createElement('div');
  domainList.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';

  var max = Math.min(topDomains.length, 8);
  for (var i = 0; i < max; i++) {
    var d = topDomains[i];
    var chip = document.createElement('span');
    var hasBlocked = d.blocked > 0;
    var chipBorder = hasBlocked ? '#f87171' : 'var(--border-color)';
    chip.style.cssText = 'font-size:10px;padding:2px 8px;border:1px solid ' + chipBorder + ';border-radius:10px;color:var(--text-secondary);font-family:monospace;';
    chip.textContent = d.domain + ' (' + d.count + ')';
    if (hasBlocked) {
      chip.title = d.blocked + ' blocked';
    }
    domainList.appendChild(chip);
  }

  this.topDomainsRoot.appendChild(domainList);
};

NetworkActivityPanel.prototype.renderRequestList = function () {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';

  // Apply filters
  var filtered = this.getFilteredEntries();

  if (filtered.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:24px 8px;text-align:center;';
    empty.textContent = this.entries.length === 0
      ? 'No network requests recorded yet.'
      : 'No requests match the current filters.';
    this.listRoot.appendChild(empty);
    return;
  }

  // Display in reverse chronological order (most recent first)
  var displayEntries = filtered.slice().reverse();
  var maxDisplay = Math.min(displayEntries.length, 100);

  for (var i = 0; i < maxDisplay; i++) {
    var entry = displayEntries[i];
    var row = this.renderRequestRow(entry);
    this.listRoot.appendChild(row);
  }

  if (displayEntries.length > maxDisplay) {
    var moreRow = document.createElement('div');
    moreRow.style.cssText = 'font-size:10px;color:var(--text-dim);padding:8px;text-align:center;font-style:italic;';
    moreRow.textContent = '... and ' + (displayEntries.length - maxDisplay) + ' more requests';
    this.listRoot.appendChild(moreRow);
  }
};

NetworkActivityPanel.prototype.getFilteredEntries = function () {
  var entries = this.entries;
  var filters = this.filters;

  if (filters.action) {
    entries = entries.filter(function (e) { return e.action === filters.action; });
  }
  if (filters.domain) {
    var domainLower = filters.domain;
    entries = entries.filter(function (e) {
      return e.domain && e.domain.toLowerCase().indexOf(domainLower) !== -1;
    });
  }
  if (filters.agentId) {
    var agentFilter = filters.agentId;
    entries = entries.filter(function (e) {
      return e.agentId && e.agentId.indexOf(agentFilter) !== -1;
    });
  }

  return entries;
};

NetworkActivityPanel.prototype.renderRequestRow = function (entry) {
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;background:var(--bg-input,rgba(15,23,42,0.4));font-size:10px;';

  // Status dot
  var statusDot = document.createElement('span');
  var statusColor = NETWORK_ACTION_COLORS[entry.action] || '#6b7280';
  statusDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:' + statusColor + ';flex-shrink:0;';
  statusDot.title = entry.action || 'unknown';
  row.appendChild(statusDot);

  // Method badge
  var methodBadge = document.createElement('span');
  methodBadge.style.cssText = 'font-weight:600;color:var(--text-secondary);min-width:32px;font-family:monospace;';
  methodBadge.textContent = entry.method || 'GET';
  row.appendChild(methodBadge);

  // Domain
  var domainSpan = document.createElement('span');
  domainSpan.style.cssText = 'color:var(--text-secondary);font-family:monospace;min-width:100px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  domainSpan.textContent = entry.domain || '';
  domainSpan.title = entry.url || '';
  row.appendChild(domainSpan);

  // URL path (truncated)
  var urlSpan = document.createElement('span');
  urlSpan.style.cssText = 'color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;';
  var urlPath = '';
  try {
    var parsed = new URL(entry.url || '');
    urlPath = parsed.pathname + parsed.search;
  } catch (e) {
    urlPath = entry.url || '';
  }
  urlSpan.textContent = urlPath;
  urlSpan.title = entry.url || '';
  row.appendChild(urlSpan);

  // Agent (if present)
  if (entry.agentId) {
    var agentSpan = document.createElement('span');
    agentSpan.style.cssText = 'color:var(--text-dim);font-size:9px;padding:1px 4px;border:1px solid var(--border-color);border-radius:3px;';
    agentSpan.textContent = entry.agentId;
    row.appendChild(agentSpan);
  }

  // Timestamp
  var timeSpan = document.createElement('span');
  timeSpan.style.cssText = 'color:var(--text-dim);flex-shrink:0;min-width:52px;text-align:right;';
  timeSpan.textContent = this.formatTime(entry.timestamp);
  row.appendChild(timeSpan);

  return row;
};

NetworkActivityPanel.prototype.formatTime = function (timestamp) {
  if (!timestamp) return '';
  try {
    var d = new Date(timestamp);
    var h = d.getHours().toString().padStart(2, '0');
    var m = d.getMinutes().toString().padStart(2, '0');
    var s = d.getSeconds().toString().padStart(2, '0');
    return h + ':' + m + ':' + s;
  } catch (e) {
    return '';
  }
};

NetworkActivityPanel.prototype.renderError = function (message) {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:16px 8px;text-align:center;';
  errDiv.textContent = message || 'Error loading network activity';
  this.listRoot.appendChild(errDiv);
};

NetworkActivityPanel.prototype.destroy = function () {
  if (this.refreshTimer) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
};

// ─── Convenience entry point ──────────────────────────────────────
function renderNetworkActivityPanel(container, sessionId) {
  var panel = new NetworkActivityPanel(container, sessionId);
  panel.render();
  return panel;
}

// Expose to renderer global scope so index.ts can attach the panel
// without going through ES modules.
if (typeof window !== 'undefined') {
  window.NetworkActivityPanel = NetworkActivityPanel;
  window.renderNetworkActivityPanel = renderNetworkActivityPanel;
}
