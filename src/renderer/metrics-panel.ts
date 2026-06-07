/**
 * MetricsPanel — Dashboard_Metrics_Panel renderer for the 12-Factor
 * agent improvements (Factor 5 + Factor 9 telemetry).
 *
 * Renders one small inline-SVG line chart per panel from the runtime
 * config at `~/.neuronest/config/metrics-panel.json`. The main process
 * reads the file (chokidar-style watch — currently `fs.watch`), validates
 * the JSON, and broadcasts changes over `metrics:config-updated`. If the
 * file is missing or malformed the panel falls back to the four default
 * panels baked in below.
 *
 * Renderer constraint (per tasks.md Notes section, task 33):
 *   - Plain JavaScript: `var` declarations, no type annotations, no
 *     non-null `!` assertions. The `scripts/copy-renderer.mjs`
 *     parse-check is what enforces this on build.
 *
 * Data flow:
 *   1. On render, fetch current config via `metrics:get-config` IPC.
 *   2. For each panel, fetch each key's series via `metrics:get-series`.
 *   3. Draw a small line chart per panel (one polyline per key).
 *   4. Subscribe to `metrics:config-updated`; on broadcast, re-render.
 *
 * Validates: Requirements 5.4
 */

// ── Defaults baked in (per design.md Dashboard_Metrics_Panel) ─────
var METRICS_PANEL_DEFAULT_CONFIG = {
  panels: [
    {
      title: 'Unified state size',
      keys: ['unified_state.bytes', 'unified_state.estimated_tokens'],
    },
    {
      title: 'Error compaction savings',
      keys: [
        'errors.compacted.input_estimated_tokens',
        'errors.compacted.output_estimated_tokens',
      ],
    },
    {
      title: 'Orchestrator tick latency',
      keys: ['orchestrator.tick_latency_ms'],
    },
    {
      title: 'Event log health',
      keys: [
        'event_log.reconciled',
        'event_log.reconciler_unmatched',
        'event_log.gap_detected',
      ],
    },
  ],
};

// ── Readiness_Tile auto-refresh interval (Requirement 37.2) ───────
var METRICS_PANEL_READINESS_REFRESH_MS = 30000;

// ── Series colors for the line chart polylines ────────────────────
var METRICS_PANEL_SERIES_COLORS = [
  '#60a5fa', // blue
  '#34d399', // green
  '#fbbf24', // amber
  '#f472b6', // pink
  '#a78bfa', // violet
  '#fb923c', // orange
];

// ── Helpers ───────────────────────────────────────────────────────
function metricsPanelEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function metricsPanelEapi() {
  return window.electronAPI;
}

// ── Readiness_Tile helpers (F6 — app:readiness) ───────────────────
// Build one per-check breakdown row for the readiness report. Each row
// shows a colored status dot (green = ok, red = failed), the check name,
// and a detail/error string. When a check fails the detail carries the
// corresponding error string (Requirement 37.3).
function metricsPanelReadinessRow(label, ok, detail) {
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-size:11px;color:var(--text-secondary);';

  var dot = document.createElement('span');
  var dotColor = ok ? '#34d399' : '#f87171';
  dot.style.cssText = 'flex:0 0 auto;margin-top:3px;display:inline-block;width:8px;height:8px;border-radius:50%;background:' + dotColor + ';';
  row.appendChild(dot);

  var text = document.createElement('span');
  text.style.cssText = 'flex:1 1 auto;word-break:break-word;';
  var html = '<span style="font-weight:600;color:var(--text-primary);font-family:monospace;">' + metricsPanelEscHtml(label) + '</span>';
  if (detail != null && detail !== '') {
    html += ' <span style="color:var(--text-dim);">' + metricsPanelEscHtml(detail) + '</span>';
  }
  text.innerHTML = html;
  row.appendChild(text);

  return row;
}

// Validate a freshly-loaded config object. Returns the validated
// config or null if it is malformed. We are deliberately strict:
// the renderer falls back to defaults rather than rendering a
// half-valid panel set, because a partial render hides config errors.
function metricsPanelValidateConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var panels = raw.panels;
  if (!Array.isArray(panels)) return null;
  var out = [];
  var i;
  for (i = 0; i < panels.length; i++) {
    var p = panels[i];
    if (!p || typeof p !== 'object') return null;
    if (typeof p.title !== 'string' || p.title.length === 0) return null;
    if (!Array.isArray(p.keys) || p.keys.length === 0) return null;
    var keys = [];
    var j;
    for (j = 0; j < p.keys.length; j++) {
      var k = p.keys[j];
      if (typeof k !== 'string' || k.length === 0) return null;
      keys.push(k);
    }
    out.push({ title: p.title, keys: keys });
  }
  if (out.length === 0) return null;
  return { panels: out };
}

// Convert a metric_samples row list (`{ value, recorded_at }`) into
// a normalized chart-ready array `{ x, y }` where x is recorded_at
// (UNIX ms) and y is the numeric value. Filters out non-finite
// values so a single NaN sample cannot break the SVG render.
function metricsPanelNormalizeSeries(rows) {
  if (!Array.isArray(rows)) return [];
  var out = [];
  var i;
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || typeof r !== 'object') continue;
    var x = Number(r.recorded_at);
    var y = Number(r.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x: x, y: y });
  }
  // Sort ascending by recorded_at; the API returns rows in some order
  // but the chart math below assumes x is monotonic non-decreasing.
  out.sort(function (a, b) { return a.x - b.x; });
  return out;
}

// Draw a small inline-SVG line chart. `seriesList` is an array of
// `{ key, points: [{x,y}, ...] }`. Returns an SVG element. The chart
// uses a fixed pixel viewBox so the parent can size it freely with
// CSS — the polyline coordinates auto-scale.
function metricsPanelRenderChart(seriesList, width, height) {
  var svgNs = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNs, 'svg');
  var w = width || 360;
  var h = height || 100;
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(h));
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'display:block;background:var(--bg-input,#0f172a);border-radius:6px;';

  // Compute global x/y bounds across all series so the chart shares
  // a single coordinate system. Series with zero points are skipped.
  var anyPoints = false;
  var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  var i, j;
  for (i = 0; i < seriesList.length; i++) {
    var pts = seriesList[i].points;
    for (j = 0; j < pts.length; j++) {
      anyPoints = true;
      if (pts[j].x < xMin) xMin = pts[j].x;
      if (pts[j].x > xMax) xMax = pts[j].x;
      if (pts[j].y < yMin) yMin = pts[j].y;
      if (pts[j].y > yMax) yMax = pts[j].y;
    }
  }

  if (!anyPoints) {
    var emptyText = document.createElementNS(svgNs, 'text');
    emptyText.setAttribute('x', String(w / 2));
    emptyText.setAttribute('y', String(h / 2));
    emptyText.setAttribute('text-anchor', 'middle');
    emptyText.setAttribute('dominant-baseline', 'middle');
    emptyText.setAttribute('fill', 'var(--text-dim,#64748b)');
    emptyText.setAttribute('font-size', '11');
    emptyText.textContent = 'No data yet';
    svg.appendChild(emptyText);
    return svg;
  }

  // Pad the y range so a flat series doesn't collapse to a single line
  // on the chart edge. If yMin === yMax, expand by 1 unit.
  if (yMin === yMax) {
    yMin = yMin - 1;
    yMax = yMax + 1;
  }
  // Defensive: if x range collapses (single point) widen by 1 ms so
  // we don't divide by zero in the projection below.
  if (xMin === xMax) {
    xMin = xMin - 1;
    xMax = xMax + 1;
  }

  // Padding inside the SVG so polylines don't touch the borders.
  var padX = 4;
  var padY = 4;
  var plotW = w - 2 * padX;
  var plotH = h - 2 * padY;

  function projectX(x) {
    return padX + ((x - xMin) / (xMax - xMin)) * plotW;
  }
  function projectY(y) {
    // Y is inverted: SVG 0 is at the top.
    return padY + (1 - (y - yMin) / (yMax - yMin)) * plotH;
  }

  // Draw a faint baseline so empty-range charts still show structure.
  var baseline = document.createElementNS(svgNs, 'line');
  baseline.setAttribute('x1', String(padX));
  baseline.setAttribute('y1', String(padY + plotH));
  baseline.setAttribute('x2', String(padX + plotW));
  baseline.setAttribute('y2', String(padY + plotH));
  baseline.setAttribute('stroke', 'var(--border-color,#334155)');
  baseline.setAttribute('stroke-width', '1');
  baseline.setAttribute('opacity', '0.5');
  svg.appendChild(baseline);

  // One polyline per series.
  for (i = 0; i < seriesList.length; i++) {
    var s = seriesList[i];
    if (s.points.length === 0) continue;
    var color = METRICS_PANEL_SERIES_COLORS[i % METRICS_PANEL_SERIES_COLORS.length];
    var pointsAttr = '';
    for (j = 0; j < s.points.length; j++) {
      var px = projectX(s.points[j].x);
      var py = projectY(s.points[j].y);
      if (j > 0) pointsAttr += ' ';
      pointsAttr += px.toFixed(2) + ',' + py.toFixed(2);
    }
    var polyline = document.createElementNS(svgNs, 'polyline');
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', color);
    polyline.setAttribute('stroke-width', '1.5');
    polyline.setAttribute('stroke-linejoin', 'round');
    polyline.setAttribute('stroke-linecap', 'round');
    polyline.setAttribute('points', pointsAttr);
    svg.appendChild(polyline);
  }

  return svg;
}

// ── MetricsPanel class ────────────────────────────────────────────
function MetricsPanel(container) {
  this.container = container;
  this.config = METRICS_PANEL_DEFAULT_CONFIG;
  this.configHandler = null;
  this.refreshTimer = null;
  this.readinessTimer = null;
  this.readinessBody = null;
}

MetricsPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
  header.innerHTML = '<h4 style="margin:0;font-size:13px;color:var(--text-secondary);">📊 Metrics</h4>';

  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.refreshSeries(); });
  header.appendChild(refreshBtn);
  this.container.appendChild(header);

  // Panels grid
  this.panelsRoot = document.createElement('div');
  this.panelsRoot.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
  this.container.appendChild(this.panelsRoot);

  // Readiness_Tile (F6 — app:readiness). Rendered above the chart
  // panels so instance health is the first thing the operator sees.
  this.renderReadinessTile();

  // Listen for config edits broadcast from the main process.
  this.cleanupConfigListener();
  this.configHandler = function () {
    // Re-fetch and re-render. The broadcast itself does not carry the
    // new config payload — keeping the renderer path identical to the
    // initial-load path means there is exactly one validation
    // codepath, which makes the malformed-file fallback consistent.
    self.loadConfigAndRender();
  };
  metricsPanelEapi().on('metrics:config-updated', this.configHandler);

  // Initial load.
  this.loadConfigAndRender();
};

// Fetch the runtime config, fall back to defaults on error/malformed,
// then refresh series for all panels.
MetricsPanel.prototype.loadConfigAndRender = function () {
  var self = this;
  var p = metricsPanelEapi().invoke('metrics:get-config');
  Promise.resolve(p).then(function (raw) {
    var validated = metricsPanelValidateConfig(raw);
    if (validated) {
      self.config = validated;
    } else {
      self.config = METRICS_PANEL_DEFAULT_CONFIG;
      console.warn('[MetricsPanel] config missing or malformed; using defaults');
    }
    self.renderPanelShells();
    self.refreshSeries();
  }).catch(function (err) {
    self.config = METRICS_PANEL_DEFAULT_CONFIG;
    console.warn('[MetricsPanel] failed to fetch config:', err && err.message ? err.message : err);
    self.renderPanelShells();
    self.refreshSeries();
  });
};

// Build one card per configured panel. The series area is empty until
// `refreshSeries` populates it — keeps the layout stable across reloads.
MetricsPanel.prototype.renderPanelShells = function () {
  if (!this.panelsRoot) return;
  this.panelsRoot.innerHTML = '';

  var panels = this.config.panels;
  var i, j;
  for (i = 0; i < panels.length; i++) {
    var p = panels[i];

    var card = document.createElement('div');
    card.className = 'dash-card';
    card.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:8px;';
    card.setAttribute('data-panel-index', String(i));

    var title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
    title.textContent = p.title;
    card.appendChild(title);

    var chartSlot = document.createElement('div');
    chartSlot.className = 'metrics-panel-chart';
    chartSlot.style.cssText = 'min-height:100px;';
    chartSlot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:32px 8px;text-align:center;">Loading…</div>';
    card.appendChild(chartSlot);

    // Legend — one row per key with its color swatch.
    var legend = document.createElement('div');
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px 14px;font-size:10px;color:var(--text-dim);';
    for (j = 0; j < p.keys.length; j++) {
      var color = METRICS_PANEL_SERIES_COLORS[j % METRICS_PANEL_SERIES_COLORS.length];
      var item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
      item.innerHTML =
        '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + color + ';"></span>' +
        '<span style="font-family:monospace;">' + metricsPanelEscHtml(p.keys[j]) + '</span>';
      legend.appendChild(item);
    }
    card.appendChild(legend);

    this.panelsRoot.appendChild(card);
  }
};

// For each configured panel + key, fetch the series from the
// `metrics:get-series` IPC, normalize, and re-render the chart.
// Errors per-key fall back to an empty series so one bad key cannot
// hide the rest of the panel.
MetricsPanel.prototype.refreshSeries = function () {
  if (!this.panelsRoot) return;
  var self = this;
  var panels = this.config.panels;
  var i;
  for (i = 0; i < panels.length; i++) {
    (function (panelIndex, panel) {
      var fetches = [];
      var k;
      for (k = 0; k < panel.keys.length; k++) {
        var key = panel.keys[k];
        fetches.push(self.fetchSeries(key));
      }
      Promise.all(fetches).then(function (results) {
        var seriesList = [];
        var idx;
        for (idx = 0; idx < panel.keys.length; idx++) {
          seriesList.push({
            key: panel.keys[idx],
            points: metricsPanelNormalizeSeries(results[idx]),
          });
        }
        self.renderPanelChart(panelIndex, seriesList);
      });
    })(i, panels[i]);
  }
};

// Single-key series fetch with graceful degradation. The handler in
// `src/main/ipc.ts` already returns `[]` on any error, but this is a
// belt-and-suspenders fallback so the renderer never sees a rejected
// promise propagate up.
MetricsPanel.prototype.fetchSeries = function (key) {
  try {
    var p = metricsPanelEapi().invoke('metrics:get-series', { key: key, limit: 200 });
    return Promise.resolve(p).catch(function () { return []; });
  } catch (e) {
    return Promise.resolve([]);
  }
};

// Replace the chart slot in panel #panelIndex with a freshly-drawn
// SVG. Idempotent — safe to call repeatedly.
MetricsPanel.prototype.renderPanelChart = function (panelIndex, seriesList) {
  if (!this.panelsRoot) return;
  var card = this.panelsRoot.querySelector('[data-panel-index="' + panelIndex + '"]');
  if (!card) return;
  var slot = card.querySelector('.metrics-panel-chart');
  if (!slot) return;
  slot.innerHTML = '';
  var svg = metricsPanelRenderChart(seriesList, 360, 100);
  slot.appendChild(svg);
};

// ── Readiness_Tile (F6 — app:readiness) ───────────────────────────
// Build the readiness card: a header row carrying the overall ready/
// not-ready status dot plus a clickable "Refresh" button, and a body
// that holds the per-check breakdown. Clicking anywhere on the card
// (or the button) refreshes the report; a 30s interval auto-refreshes
// it (Requirement 37.2). Additive — sits above the chart panels and
// never interferes with the existing panel render path.
MetricsPanel.prototype.renderReadinessTile = function () {
  if (!this.container) return;
  var self = this;

  var card = document.createElement('div');
  card.className = 'dash-card';
  card.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:8px;margin-bottom:12px;cursor:pointer;';
  card.setAttribute('data-readiness-tile', '1');
  card.title = 'Click to refresh readiness';

  // Header: overall status dot + label on the left, Refresh button right.
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:8px;';

  this.readinessDot = document.createElement('span');
  this.readinessDot.style.cssText = 'flex:0 0 auto;display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--text-dim,#64748b);';
  header.appendChild(this.readinessDot);

  this.readinessStatus = document.createElement('span');
  this.readinessStatus.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
  this.readinessStatus.textContent = 'Readiness — checking…';
  header.appendChild(this.readinessStatus);

  var readinessBtn = document.createElement('button');
  readinessBtn.type = 'button';
  readinessBtn.textContent = 'Refresh';
  readinessBtn.style.cssText = 'margin-left:auto;font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  readinessBtn.addEventListener('click', function (e) {
    // Stop the click from double-firing through the card handler.
    if (e && e.stopPropagation) e.stopPropagation();
    self.refreshReadiness();
  });
  header.appendChild(readinessBtn);
  card.appendChild(header);

  // Body: per-check breakdown rows, populated on each refresh.
  this.readinessBody = document.createElement('div');
  this.readinessBody.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  this.readinessBody.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">Loading…</div>';
  card.appendChild(this.readinessBody);

  // Click-to-refresh on the whole card (Requirement 37.2).
  card.addEventListener('click', function () { self.refreshReadiness(); });

  // Insert the readiness tile above the chart panels so it leads the
  // dashboard. `panelsRoot` is already appended by `render`.
  if (this.panelsRoot && this.panelsRoot.parentNode === this.container) {
    this.container.insertBefore(card, this.panelsRoot);
  } else {
    this.container.appendChild(card);
  }

  // 30-second auto-refresh interval (Requirement 37.2). Clear any prior
  // timer first so repeated `render()` calls don't stack intervals.
  if (this.readinessTimer) {
    clearInterval(this.readinessTimer);
    this.readinessTimer = null;
  }
  this.readinessTimer = setInterval(function () { self.refreshReadiness(); }, METRICS_PANEL_READINESS_REFRESH_MS);

  // Initial fetch.
  this.refreshReadiness();
};

// Fetch the readiness report over the `app:readiness` IPC channel and
// repaint the overall status dot plus the per-check breakdown. Never
// throws — IPC/transport errors render as a failed (red) tile so the
// operator sees the instance is unhealthy rather than a stale state.
MetricsPanel.prototype.refreshReadiness = function () {
  var self = this;
  var eapi = metricsPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('app:readiness');
  } catch (e) {
    self.renderReadinessError(e && e.message ? e.message : String(e));
    return;
  }

  Promise.resolve(p).then(function (report) {
    self.renderReadinessReport(report);
  }).catch(function (err) {
    self.renderReadinessError(err && err.message ? err.message : String(err));
  });
};

// Paint a successful (or partially-failing) readiness report. The
// overall dot is green iff `report.ready`, red otherwise. The body
// lists one row per check (database, dataDir, localFirst) with each
// check's error string surfaced when it failed (Requirement 37.3).
MetricsPanel.prototype.renderReadinessReport = function (report) {
  if (!this.readinessBody) return;
  var checks = (report && report.checks) || {};
  var ready = !!(report && report.ready);

  if (this.readinessDot) {
    this.readinessDot.style.background = ready ? '#34d399' : '#f87171';
  }
  if (this.readinessStatus) {
    this.readinessStatus.textContent = ready ? 'Readiness — ready' : 'Readiness — not ready';
  }

  this.readinessBody.innerHTML = '';

  // database check
  var db = checks.database || {};
  this.readinessBody.appendChild(
    metricsPanelReadinessRow('database', !!db.ok, db.ok ? 'SELECT 1 ok' : (db.error || 'failed'))
  );

  // dataDir check
  var dataDir = checks.dataDir || {};
  var dataDirDetail = dataDir.ok
    ? ('writable' + (dataDir.path ? ' · ' + dataDir.path : ''))
    : (dataDir.error || 'not writable');
  this.readinessBody.appendChild(
    metricsPanelReadinessRow('dataDir', !!dataDir.ok, dataDirDetail)
  );

  // localFirst informational flag
  var localFirst = checks.localFirst || {};
  this.readinessBody.appendChild(
    metricsPanelReadinessRow('localFirst', !!localFirst.ok, localFirst.local ? 'local storage' : 'remote storage')
  );
};

// Paint a transport/IPC error as a failed tile. The breakdown body
// carries the error string so the failure mode is visible.
MetricsPanel.prototype.renderReadinessError = function (message) {
  if (this.readinessDot) this.readinessDot.style.background = '#f87171';
  if (this.readinessStatus) this.readinessStatus.textContent = 'Readiness — unavailable';
  if (this.readinessBody) {
    this.readinessBody.innerHTML = '';
    this.readinessBody.appendChild(
      metricsPanelReadinessRow('app:readiness', false, message || 'IPC call failed')
    );
  }
};

MetricsPanel.prototype.cleanupConfigListener = function () {
  if (this.configHandler) {
    try { metricsPanelEapi().removeListener('metrics:config-updated', this.configHandler); } catch (e) {}
    this.configHandler = null;
  }
};

MetricsPanel.prototype.destroy = function () {
  this.cleanupConfigListener();
  if (this.refreshTimer) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
  if (this.readinessTimer) {
    clearInterval(this.readinessTimer);
    this.readinessTimer = null;
  }
};

// ── Convenience entry point ───────────────────────────────────────
function renderMetricsPanel(container) {
  var panel = new MetricsPanel(container);
  panel.render();
  return panel;
}

// Expose to renderer global scope so `index.ts` can attach the panel
// to a container without going through ES modules (the renderer ships
// as plain JS — no `import`/`require` available).
if (typeof window !== 'undefined') {
  window.MetricsPanel = MetricsPanel;
  window.renderMetricsPanel = renderMetricsPanel;
  window.METRICS_PANEL_DEFAULT_CONFIG = METRICS_PANEL_DEFAULT_CONFIG;
}
