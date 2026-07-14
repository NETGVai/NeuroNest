/**
 * AnalyticsDashboardPanel — Renderer panel for adoption analytics.
 *
 * Displays key metrics: active users, sessions/day, tasks completed, time saved, total cost.
 * Shows per-agent effectiveness cards: success rate, avg time, cost/task, satisfaction.
 * Trend charts with configurable time ranges.
 * Export button for CSV/JSON.
 *
 * Wires IPC channels: analytics:metrics, analytics:agent-stats,
 * analytics:trends, analytics:export
 *
 * Gated behind `adoption_dashboard` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as worktree-panel.ts.
 *
 * Requirements: 23.3
 */

// ─── Helpers ───────────────────────────────────────────────────────
function analyticsPanelEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function analyticsPanelEapi() {
  return window.electronAPI;
}

// ─── Time range presets ────────────────────────────────────────────
var ANALYTICS_TIME_RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '6 months', days: 180 },
  { label: '1 year', days: 365 },
];

// ─── AnalyticsDashboardPanel class ────────────────────────────────
function AnalyticsDashboardPanel(container, options) {
  this.container = container;
  this.scopeId = (options && options.scopeId) || 'default';
  this.level = (options && options.level) || 'organization';
  this.selectedRange = 30; // default 30 days
  this.metrics = null;
  this.agentStats = [];
  this.trends = [];
  this.refreshTimer = null;
}

AnalyticsDashboardPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header with title, time range selector, and export button
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:14px;color:var(--text-primary);';
  title.textContent = 'Adoption Dashboard';
  header.appendChild(title);

  var controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

  // Time range selector
  var rangeSelect = document.createElement('select');
  rangeSelect.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  rangeSelect.setAttribute('aria-label', 'Time range');
  var i;
  for (i = 0; i < ANALYTICS_TIME_RANGES.length; i++) {
    var opt = document.createElement('option');
    opt.value = String(ANALYTICS_TIME_RANGES[i].days);
    opt.textContent = ANALYTICS_TIME_RANGES[i].label;
    if (ANALYTICS_TIME_RANGES[i].days === self.selectedRange) opt.selected = true;
    rangeSelect.appendChild(opt);
  }
  rangeSelect.addEventListener('change', function () {
    self.selectedRange = parseInt(rangeSelect.value, 10);
    self.loadData();
  });
  controls.appendChild(rangeSelect);

  // Export CSV button
  var exportCsvBtn = document.createElement('button');
  exportCsvBtn.type = 'button';
  exportCsvBtn.textContent = 'Export CSV';
  exportCsvBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  exportCsvBtn.addEventListener('click', function () { self.exportData('csv'); });
  controls.appendChild(exportCsvBtn);

  // Export JSON button
  var exportJsonBtn = document.createElement('button');
  exportJsonBtn.type = 'button';
  exportJsonBtn.textContent = 'Export JSON';
  exportJsonBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  exportJsonBtn.addEventListener('click', function () { self.exportData('json'); });
  controls.appendChild(exportJsonBtn);

  // Refresh button
  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.loadData(); });
  controls.appendChild(refreshBtn);

  header.appendChild(controls);
  this.container.appendChild(header);

  // Key metrics cards row
  this.metricsRow = document.createElement('div');
  this.metricsRow.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px;';
  this.container.appendChild(this.metricsRow);

  // Agent effectiveness section
  var agentHeader = document.createElement('h5');
  agentHeader.style.cssText = 'margin:16px 0 10px;font-size:12px;color:var(--text-secondary);';
  agentHeader.textContent = 'Agent Effectiveness';
  this.container.appendChild(agentHeader);

  this.agentGrid = document.createElement('div');
  this.agentGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:16px;';
  this.container.appendChild(this.agentGrid);

  // Trend charts section
  var trendHeader = document.createElement('h5');
  trendHeader.style.cssText = 'margin:16px 0 10px;font-size:12px;color:var(--text-secondary);';
  trendHeader.textContent = 'Weekly Trends';
  this.container.appendChild(trendHeader);

  this.trendContainer = document.createElement('div');
  this.trendContainer.style.cssText = 'padding:12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-input);';
  this.container.appendChild(this.trendContainer);

  // Status area
  this.statusArea = document.createElement('div');
  this.statusArea.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:12px;text-align:center;';
  this.container.appendChild(this.statusArea);

  // Load initial data
  this.loadData();

  // Auto-refresh every 60s
  if (this.refreshTimer) clearInterval(this.refreshTimer);
  this.refreshTimer = setInterval(function () { self.loadData(); }, 60000);
};

AnalyticsDashboardPanel.prototype.getDateRange = function () {
  var now = new Date();
  var from = new Date();
  from.setDate(now.getDate() - this.selectedRange);
  return {
    fromDate: from.toISOString().split('T')[0],
    toDate: now.toISOString().split('T')[0],
  };
};

AnalyticsDashboardPanel.prototype.buildQuery = function () {
  var range = this.getDateRange();
  return {
    level: this.level,
    scopeId: this.scopeId,
    fromDate: range.fromDate,
    toDate: range.toDate,
  };
};

AnalyticsDashboardPanel.prototype.loadData = function () {
  var self = this;
  var eapi = analyticsPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') {
    self.showStatus('API not available');
    return;
  }

  var query = self.buildQuery();

  // Load metrics, agent stats, and trends in parallel
  var metricsP, agentP, trendsP;
  try {
    metricsP = eapi.invoke('analytics:metrics', query);
    agentP = eapi.invoke('analytics:agent-stats', query);
    trendsP = eapi.invoke('analytics:trends', query);
  } catch (e) {
    self.showStatus('Failed to load analytics');
    return;
  }

  Promise.all([
    Promise.resolve(metricsP),
    Promise.resolve(agentP),
    Promise.resolve(trendsP),
  ]).then(function (results) {
    var metricsRes = results[0];
    var agentRes = results[1];
    var trendsRes = results[2];

    if (metricsRes && metricsRes.success) {
      self.metrics = metricsRes.data;
      self.renderMetricsCards();
    }

    if (agentRes && agentRes.success) {
      self.agentStats = agentRes.data || [];
      self.renderAgentCards();
    }

    if (trendsRes && trendsRes.success) {
      self.trends = trendsRes.data || [];
      self.renderTrendChart();
    }

    self.showStatus('Last updated: ' + new Date().toLocaleTimeString());
  }).catch(function (err) {
    self.showStatus('Error: ' + (err && err.message ? err.message : 'Load failed'));
  });
};

AnalyticsDashboardPanel.prototype.renderMetricsCards = function () {
  if (!this.metricsRow || !this.metrics) return;
  this.metricsRow.innerHTML = '';

  var m = this.metrics;
  var cards = [
    { label: 'Active Users', value: m.activeUsers, color: '#60a5fa' },
    { label: 'Sessions/Day', value: m.sessionsPerDay, color: '#34d399' },
    { label: 'Tasks Completed', value: m.tasksCompleted, color: '#a78bfa' },
    { label: 'Success Rate', value: (m.successRate * 100).toFixed(1) + '%', color: '#fbbf24' },
    { label: 'Time Saved', value: m.estimatedTimeSaved + 'h', color: '#f472b6' },
    { label: 'Total Cost', value: '$' + m.totalCost.toFixed(2), color: '#fb923c' },
    { label: 'Cost/Task', value: '$' + m.costPerTask.toFixed(2), color: '#94a3b8' },
    { label: 'Feedback', value: m.avgFeedbackScore.toFixed(1) + '/5', color: '#2dd4bf' },
  ];

  var i;
  for (i = 0; i < cards.length; i++) {
    var card = this.createMetricCard(cards[i].label, cards[i].value, cards[i].color);
    this.metricsRow.appendChild(card);
  }
};

AnalyticsDashboardPanel.prototype.createMetricCard = function (label, value, color) {
  var card = document.createElement('div');
  card.className = 'dash-card';
  card.style.cssText = 'padding:12px;text-align:center;border-left:3px solid ' + color + ';';

  var valueEl = document.createElement('div');
  valueEl.style.cssText = 'font-size:18px;font-weight:700;color:var(--text-primary);margin-bottom:4px;';
  valueEl.textContent = String(value);
  card.appendChild(valueEl);

  var labelEl = document.createElement('div');
  labelEl.style.cssText = 'font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;';
  labelEl.textContent = label;
  card.appendChild(labelEl);

  return card;
};

AnalyticsDashboardPanel.prototype.renderAgentCards = function () {
  if (!this.agentGrid) return;
  this.agentGrid.innerHTML = '';

  if (this.agentStats.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:16px 8px;';
    empty.textContent = 'No agent data for this time range.';
    this.agentGrid.appendChild(empty);
    return;
  }

  var i;
  for (i = 0; i < this.agentStats.length; i++) {
    var agent = this.agentStats[i];
    var card = this.createAgentCard(agent);
    this.agentGrid.appendChild(card);
  }
};

AnalyticsDashboardPanel.prototype.createAgentCard = function (agent) {
  var card = document.createElement('div');
  card.className = 'dash-card';
  card.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:6px;';

  // Agent name
  var nameEl = document.createElement('div');
  nameEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);font-family:monospace;';
  nameEl.textContent = agent.agentId;
  card.appendChild(nameEl);

  // Stats grid
  var statsGrid = document.createElement('div');
  statsGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;';

  var stats = [
    { label: 'Success', value: (agent.successRate * 100).toFixed(1) + '%' },
    { label: 'Avg Time', value: this.formatDuration(agent.avgDurationMs) },
    { label: 'Cost/Task', value: '$' + agent.costPerTask.toFixed(2) },
    { label: 'Satisfaction', value: agent.avgSatisfaction.toFixed(1) + '/5' },
  ];

  var i;
  for (i = 0; i < stats.length; i++) {
    var statEl = document.createElement('div');
    statEl.style.cssText = 'font-size:10px;';

    var statLabel = document.createElement('span');
    statLabel.style.cssText = 'color:var(--text-dim);';
    statLabel.textContent = stats[i].label + ': ';
    statEl.appendChild(statLabel);

    var statValue = document.createElement('span');
    statValue.style.cssText = 'color:var(--text-secondary);font-weight:500;';
    statValue.textContent = stats[i].value;
    statEl.appendChild(statValue);

    statsGrid.appendChild(statEl);
  }

  card.appendChild(statsGrid);

  // Invocations count
  var invocEl = document.createElement('div');
  invocEl.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
  invocEl.textContent = agent.invocations + ' invocations';
  card.appendChild(invocEl);

  return card;
};

AnalyticsDashboardPanel.prototype.renderTrendChart = function () {
  if (!this.trendContainer) return;
  this.trendContainer.innerHTML = '';

  if (this.trends.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:16px;text-align:center;';
    empty.textContent = 'No trend data for this time range.';
    this.trendContainer.appendChild(empty);
    return;
  }

  // Simple ASCII-style bar chart for trends
  var maxSessions = 1;
  var maxUsers = 1;
  var maxTasks = 1;
  var i;
  for (i = 0; i < this.trends.length; i++) {
    if (this.trends[i].sessions > maxSessions) maxSessions = this.trends[i].sessions;
    if (this.trends[i].activeUsers > maxUsers) maxUsers = this.trends[i].activeUsers;
    if (this.trends[i].tasksCompleted > maxTasks) maxTasks = this.trends[i].tasksCompleted;
  }

  // Legend
  var legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:16px;margin-bottom:10px;font-size:10px;';
  legend.innerHTML =
    '<span><span style="display:inline-block;width:10px;height:10px;background:#60a5fa;border-radius:2px;margin-right:4px;"></span>Users</span>' +
    '<span><span style="display:inline-block;width:10px;height:10px;background:#34d399;border-radius:2px;margin-right:4px;"></span>Sessions</span>' +
    '<span><span style="display:inline-block;width:10px;height:10px;background:#a78bfa;border-radius:2px;margin-right:4px;"></span>Tasks</span>';
  this.trendContainer.appendChild(legend);

  // Chart rows
  var chartArea = document.createElement('div');
  chartArea.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

  for (i = 0; i < this.trends.length; i++) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';

    var weekLabel = document.createElement('span');
    weekLabel.style.cssText = 'font-size:10px;color:var(--text-dim);min-width:60px;font-family:monospace;';
    weekLabel.textContent = this.trends[i].week;
    row.appendChild(weekLabel);

    var barsWrap = document.createElement('div');
    barsWrap.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px;';

    // Users bar
    var userBar = this.createBar(this.trends[i].activeUsers, maxUsers, '#60a5fa');
    barsWrap.appendChild(userBar);

    // Sessions bar
    var sessionBar = this.createBar(this.trends[i].sessions, maxSessions, '#34d399');
    barsWrap.appendChild(sessionBar);

    // Tasks bar
    var taskBar = this.createBar(this.trends[i].tasksCompleted, maxTasks, '#a78bfa');
    barsWrap.appendChild(taskBar);

    row.appendChild(barsWrap);
    chartArea.appendChild(row);
  }

  this.trendContainer.appendChild(chartArea);
};

AnalyticsDashboardPanel.prototype.createBar = function (value, max, color) {
  var bar = document.createElement('div');
  var pct = max > 0 ? Math.round((value / max) * 100) : 0;
  bar.style.cssText = 'height:4px;border-radius:2px;background:' + color + ';width:' + pct + '%;min-width:2px;opacity:0.8;';
  bar.title = String(value);
  return bar;
};

AnalyticsDashboardPanel.prototype.exportData = function (format) {
  var self = this;
  var eapi = analyticsPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var query = self.buildQuery();
  query.format = format;
  query.includeAgentStats = true;
  query.includeTrends = true;

  var p;
  try {
    p = eapi.invoke('analytics:export', query);
  } catch (e) {
    self.showStatus('Export failed');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success && result.data) {
      // Trigger download via blob URL
      var blob = new Blob([result.data.data], { type: result.data.mimeType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = result.data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      self.showStatus('Exported: ' + result.data.filename);
    } else {
      self.showStatus('Export failed: ' + ((result && result.error) || 'unknown'));
    }
  }).catch(function (err) {
    self.showStatus('Export error: ' + (err && err.message ? err.message : 'unknown'));
  });
};

AnalyticsDashboardPanel.prototype.formatDuration = function (ms) {
  if (!ms || ms <= 0) return '0s';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
};

AnalyticsDashboardPanel.prototype.showStatus = function (msg) {
  if (this.statusArea) {
    this.statusArea.textContent = msg;
  }
};

AnalyticsDashboardPanel.prototype.destroy = function () {
  if (this.refreshTimer) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
};

// ─── Convenience entry point ──────────────────────────────────────
function renderAnalyticsDashboardPanel(container, options) {
  var panel = new AnalyticsDashboardPanel(container, options);
  panel.render();
  return panel;
}

// Expose to renderer global scope
if (typeof window !== 'undefined') {
  window.AnalyticsDashboardPanel = AnalyticsDashboardPanel;
  window.renderAnalyticsDashboardPanel = renderAnalyticsDashboardPanel;
}
