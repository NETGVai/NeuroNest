// @ts-nocheck
/**
 * DriftIntelligenceWorkspacePanel — Unified drift and intelligence management.
 *
 * Tabs:
 * 1. Drift — state, confidence, history, signals, scope, stale countdown, anchor summary, config
 * 2. Semantic — status, search, reindex, stop
 * 3. Indexing — config, progress, status, cancel
 * 4. LSP — status, diagnostics, references, definitions, symbols
 * 5. Prompt Enhancement — config, preview, accept, reject, history
 * 6. Vision — analyze, compare, diagram (disabled when provider lacks vision)
 * 7. Commit Gen — config and generate action
 *
 * IPC channels:
 * - drift:get-state
 * - semantic:search, semantic:index-status, semantic:reindex
 * - indexing:getStatus, indexing:fullReindex, indexing:stop, indexing:getConfig, indexing:updateConfig
 * - lsp:diagnostics, lsp:references, lsp:definition, lsp:symbols, lsp:status
 * - prompt:enhance, prompt:config
 * - vision:analyze, vision:compare, vision:diagram
 * - commit:generate, commit:config
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Requirements: 5.1-5.11
 */

// ─── Constants ─────────────────────────────────────────────────────

var DI_TABS = [
  { id: 'drift', label: 'Drift', icon: '\uD83C\uDFAF' },
  { id: 'semantic', label: 'Semantic', icon: '\uD83D\uDD0D' },
  { id: 'indexing', label: 'Indexing', icon: '\uD83D\uDDC2' },
  { id: 'lsp', label: 'LSP', icon: '\uD83D\uDD17' },
  { id: 'prompt', label: 'Prompt', icon: '\u2728' },
  { id: 'vision', label: 'Vision', icon: '\uD83D\uDC41' },
  { id: 'commit', label: 'Commit', icon: '\uD83D\uDCDD' },
];

// ─── Helpers ───────────────────────────────────────────────────────

function diEsc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
function diApi() { return window.electronAPI; }
function diEl(tag, css, attrs) {
  var el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]); } }
  return el;
}

function diConfBadge(confidence) {
  var pct = Math.round((confidence || 0) * 100);
  var color = pct >= 80 ? '#a6e3a1' : pct >= 50 ? '#f9e2af' : '#f38ba8';
  return '<span style="font-size:11px;padding:2px 6px;border-radius:3px;background:' + color + '22;color:' + color + ';font-weight:600;">' + pct + '%</span>';
}

function diStatusDot(active) {
  var color = active ? '#a6e3a1' : '#6c7086';
  return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';margin-right:6px;"></span>';
}

// ─── Panel class ───────────────────────────────────────────────────

function DriftIntelligenceWorkspacePanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || 'default';
  this.activeTab = 'drift';
  this.tabContent = null;
}

DriftIntelligenceWorkspacePanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText =
    'padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  var header = diEl('h3', 'margin:0 0 12px;font-size:16px;color:var(--text-primary,#cdd6f4);');
  header.textContent = 'Drift & Intelligence';
  this.container.appendChild(header);

  // Tab bar
  var tabBar = diEl('div', 'display:flex;gap:2px;margin-bottom:16px;border-bottom:1px solid var(--border-color,#45475a);overflow-x:auto;');
  for (var i = 0; i < DI_TABS.length; i++) {
    (function (tab) {
      var btn = diEl('button',
        'padding:6px 10px;border:none;border-bottom:2px solid transparent;background:transparent;' +
        'color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:11px;white-space:nowrap;',
        { 'aria-label': tab.label + ' tab', role: 'tab' });
      btn.textContent = tab.icon + ' ' + tab.label;
      if (tab.id === self.activeTab) {
        btn.style.color = 'var(--accent-color,#89b4fa)';
        btn.style.borderBottomColor = 'var(--accent-color,#89b4fa)';
      }
      btn.addEventListener('click', function () { self.activeTab = tab.id; self.render(); });
      tabBar.appendChild(btn);
    })(DI_TABS[i]);
  }
  this.container.appendChild(tabBar);

  this.tabContent = diEl('div', 'min-height:300px;');
  this.container.appendChild(this.tabContent);
  this.loadTab(this.activeTab);
};

DriftIntelligenceWorkspacePanel.prototype.loadTab = function (id) {
  switch (id) {
    case 'drift': this.renderDrift(); break;
    case 'semantic': this.renderSemantic(); break;
    case 'indexing': this.renderIndexing(); break;
    case 'lsp': this.renderLSP(); break;
    case 'prompt': this.renderPrompt(); break;
    case 'vision': this.renderVision(); break;
    case 'commit': this.renderCommit(); break;
  }
};

// ─── Drift Tab ─────────────────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.renderDrift = function () {
  var self = this; var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading drift state...</div>';
  var api = diApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('drift:get-state', {}).then(function (state) {
    el.innerHTML = '';
    if (!state) { el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">Drift system inactive</div>'; return; }

    // State card
    var card = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
      '<span style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);">' + diStatusDot(state.active !== false) + 'Drift Monitor</span>' +
      diConfBadge(state.confidence) + '</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>State: <strong>' + diEsc(state.state || 'nominal') + '</strong></div>' +
      '<div>Scope usage: ' + (state.scopeUsage != null ? Math.round(state.scopeUsage * 100) + '%' : 'N/A') + '</div>' +
      '<div>Stale countdown: ' + (state.staleCountdown || 'N/A') + '</div>' +
      (state.anchorSummary ? '<div>Anchor: ' + diEsc(state.anchorSummary.slice(0, 100)) + '</div>' : '') + '</div>';
    el.appendChild(card);

    // Signals
    if (state.signals && state.signals.length > 0) {
      var sigHeader = diEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:6px;');
      sigHeader.textContent = 'Recent Signals (' + state.signals.length + ')';
      el.appendChild(sigHeader);
      for (var i = 0; i < Math.min(state.signals.length, 8); i++) {
        var sig = state.signals[i];
        var sigEl = diEl('div', 'font-size:11px;padding:4px 8px;margin-bottom:4px;background:var(--surface-tertiary,#45475a);border-radius:4px;color:var(--text-secondary,#a6adc8);');
        sigEl.textContent = (sig.type || sig.kind || 'signal') + ': ' + (sig.message || sig.reason || JSON.stringify(sig));
        el.appendChild(sigEl);
      }
    }

    // Config note
    var configNote = diEl('div', 'font-size:10px;color:var(--text-muted,#6c7086);margin-top:12px;');
    configNote.textContent = 'Configure drift sensitivity, thresholds, and pause-on-critical in Feature Settings.';
    el.appendChild(configNote);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load drift state</div>'; });
};

// ─── Semantic Tab ──────────────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.renderSemantic = function () {
  var self = this; var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading semantic status...</div>';
  var api = diApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('semantic:index-status', {}).then(function (status) {
    el.innerHTML = '';
    var st = status || {};

    var card = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">' +
      diStatusDot(st.indexed || st.ready) + 'Semantic Index</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Files indexed: ' + (st.fileCount || st.totalFiles || 0) + '</div>' +
      '<div>Chunks: ' + (st.chunkCount || 0) + '</div>' +
      '<div>Status: ' + diEsc(st.status || (st.ready ? 'Ready' : 'Not indexed')) + '</div></div>';
    el.appendChild(card);

    // Actions
    var actions = diEl('div', 'display:flex;gap:6px;margin-bottom:16px;');
    var reindexBtn = diEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    reindexBtn.textContent = '\uD83D\uDD04 Reindex';
    reindexBtn.addEventListener('click', function () { api.invoke('semantic:reindex', {}).catch(function () {}); });
    actions.appendChild(reindexBtn);
    el.appendChild(actions);

    // Search
    var searchWrap = diEl('div', 'display:flex;gap:6px;');
    var searchInput = diEl('input', 'flex:1;padding:6px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:var(--input-bg,#1e1e2e);color:var(--text-primary,#cdd6f4);font-size:12px;outline:none;', { placeholder: 'Semantic search...', 'aria-label': 'Semantic search' });
    var searchBtn = diEl('button', 'padding:6px 12px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-size:12px;font-weight:600;');
    searchBtn.textContent = 'Search';
    searchBtn.addEventListener('click', function () {
      var q = searchInput.value.trim(); if (!q) return;
      api.invoke('semantic:search', { query: q }).then(function (r) {
        var results = Array.isArray(r) ? r : (r && r.results) || [];
        self.showSemanticResults(results);
      }).catch(function () {});
    });
    searchWrap.appendChild(searchInput); searchWrap.appendChild(searchBtn);
    el.appendChild(searchWrap);

    self._semanticResultsEl = diEl('div', 'margin-top:12px;');
    el.appendChild(self._semanticResultsEl);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load semantic status</div>'; });
};

DriftIntelligenceWorkspacePanel.prototype.showSemanticResults = function (results) {
  var el = this._semanticResultsEl; if (!el) return;
  if (results.length === 0) { el.innerHTML = '<div style="font-size:11px;color:var(--text-muted,#6c7086);padding:8px;">No results.</div>'; return; }
  el.innerHTML = '';
  for (var i = 0; i < Math.min(results.length, 10); i++) {
    var r = results[i];
    var item = diEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
    item.innerHTML = '<div style="color:var(--text-primary,#cdd6f4);font-weight:600;">' + diEsc(r.file || r.path || 'unknown') + '</div>' +
      '<div style="color:var(--text-secondary,#a6adc8);margin-top:2px;">' + diEsc((r.content || r.text || '').slice(0, 120)) + '</div>';
    el.appendChild(item);
  }
};

// ─── Indexing Tab ──────────────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.renderIndexing = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading indexing status...</div>';
  var api = diApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  Promise.all([api.invoke('indexing:getStatus', {}), api.invoke('indexing:getConfig', {})]).then(function (res) {
    el.innerHTML = '';
    var status = res[0] || {}; var config = res[1] || {};

    var card = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    var progress = status.progress != null ? Math.round(status.progress * 100) : 0;
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">Indexing Pipeline</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Status: ' + diEsc(status.state || status.status || 'idle') + '</div>' +
      '<div>Progress: ' + progress + '%</div>' +
      '<div>Files processed: ' + (status.filesProcessed || 0) + '/' + (status.totalFiles || 0) + '</div></div>' +
      '<div style="margin-top:8px;height:4px;background:var(--surface-tertiary,#45475a);border-radius:2px;overflow:hidden;">' +
      '<div style="height:100%;width:' + progress + '%;background:var(--accent-color,#89b4fa);"></div></div>';
    el.appendChild(card);

    // Config
    var cfgCard = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    cfgCard.innerHTML = '<div style="font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:4px;">Configuration</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);">Exclude: ' + diEsc((config.exclude || []).join(', ') || 'none') + '</div>';
    el.appendChild(cfgCard);

    // Actions
    var actions = diEl('div', 'display:flex;gap:6px;');
    var reindexBtn = diEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    reindexBtn.textContent = 'Full Reindex';
    reindexBtn.addEventListener('click', function () { api.invoke('indexing:fullReindex', {}).catch(function () {}); });
    actions.appendChild(reindexBtn);
    var stopBtn = diEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #f38ba8;background:transparent;color:#f38ba8;cursor:pointer;');
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', function () { api.invoke('indexing:stop', {}).catch(function () {}); });
    actions.appendChild(stopBtn);
    el.appendChild(actions);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load indexing status</div>'; });
};

// ─── LSP Tab ───────────────────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.renderLSP = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading LSP status...</div>';
  var api = diApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('lsp:status', {}).then(function (status) {
    el.innerHTML = '';
    var st = status || {};
    var card = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">' +
      diStatusDot(st.connected || st.running) + 'Language Server</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Connected: ' + (st.connected || st.running ? 'Yes' : 'No') + '</div>' +
      '<div>Language: ' + diEsc(st.language || st.serverName || 'N/A') + '</div>' +
      '<div>Diagnostics: ' + (st.diagnosticCount || 0) + ' active</div></div>';
    el.appendChild(card);

    // Quick actions
    var actions = diEl('div', 'display:flex;gap:6px;flex-wrap:wrap;');
    var diagBtn = diEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    diagBtn.textContent = 'Diagnostics';
    diagBtn.addEventListener('click', function () { api.invoke('lsp:diagnostics', {}).then(function (r) { alert(JSON.stringify(r, null, 2)); }).catch(function () {}); });
    actions.appendChild(diagBtn);
    var symBtn = diEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    symBtn.textContent = 'Symbols';
    symBtn.addEventListener('click', function () { api.invoke('lsp:symbols', {}).then(function (r) { alert(JSON.stringify(r, null, 2)); }).catch(function () {}); });
    actions.appendChild(symBtn);
    el.appendChild(actions);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load LSP status</div>'; });
};

// ─── Prompt Enhancement Tab ────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.renderPrompt = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading prompt config...</div>';
  var api = diApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('prompt:config', {}).then(function (config) {
    el.innerHTML = '';
    var cfg = config || {};

    var card = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">Prompt Enhancement</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Enabled: ' + (cfg.enabled !== false ? 'Yes' : 'No') + '</div>' +
      '<div>Strategy: ' + diEsc(cfg.strategy || 'auto') + '</div>' +
      '<div>Context window: ' + (cfg.contextWindow || 'default') + '</div></div>';
    el.appendChild(card);

    // Preview action
    var previewWrap = diEl('div', 'margin-bottom:12px;');
    var textarea = diEl('textarea',
      'width:100%;min-height:60px;padding:8px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
      'background:var(--input-bg,#1e1e2e);color:var(--text-primary,#cdd6f4);font-size:12px;resize:vertical;outline:none;box-sizing:border-box;',
      { placeholder: 'Enter a prompt to preview enhancement...', 'aria-label': 'Prompt to enhance' });
    previewWrap.appendChild(textarea);

    var enhanceBtn = diEl('button', 'font-size:11px;padding:4px 10px;margin-top:6px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    enhanceBtn.textContent = '\u2728 Enhance';
    enhanceBtn.addEventListener('click', function () {
      var text = textarea.value.trim(); if (!text) return;
      api.invoke('prompt:enhance', { prompt: text }).then(function (r) {
        var resultEl = el.querySelector('.di-enhance-result');
        if (resultEl) resultEl.innerHTML = '<div style="font-size:11px;color:var(--text-primary,#cdd6f4);white-space:pre-wrap;padding:8px;background:var(--surface-tertiary,#45475a);border-radius:4px;">' + diEsc(r && r.enhanced || r || '') + '</div>';
      }).catch(function () {});
    });
    previewWrap.appendChild(enhanceBtn);
    el.appendChild(previewWrap);

    var resultArea = diEl('div', 'di-enhance-result');
    resultArea.className = 'di-enhance-result';
    el.appendChild(resultArea);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load prompt config</div>'; });
};

// ─── Vision Tab ────────────────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.renderVision = function () {
  var el = this.tabContent;
  el.innerHTML = '';
  var api = diApi();

  var card = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
  card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">\uD83D\uDC41 Vision Analysis</div>' +
    '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);">Analyze screenshots, compare UI states, or generate diagrams from descriptions.</div>';
  el.appendChild(card);

  var note = diEl('div', 'font-size:10px;color:var(--text-muted,#6c7086);margin-bottom:12px;font-style:italic;');
  note.textContent = 'Vision features require a provider with image capabilities. Actions are disabled if the current provider lacks vision support.';
  el.appendChild(note);

  var actions = diEl('div', 'display:flex;gap:6px;flex-wrap:wrap;');
  var analyzeBtn = diEl('button', 'font-size:11px;padding:6px 12px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
  analyzeBtn.textContent = 'Analyze Image';
  analyzeBtn.addEventListener('click', function () { if (api) api.invoke('vision:analyze', {}).catch(function () {}); });
  actions.appendChild(analyzeBtn);

  var compareBtn = diEl('button', 'font-size:11px;padding:6px 12px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  compareBtn.textContent = 'Compare';
  compareBtn.addEventListener('click', function () { if (api) api.invoke('vision:compare', {}).catch(function () {}); });
  actions.appendChild(compareBtn);

  var diagramBtn = diEl('button', 'font-size:11px;padding:6px 12px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  diagramBtn.textContent = 'Generate Diagram';
  diagramBtn.addEventListener('click', function () { if (api) api.invoke('vision:diagram', {}).catch(function () {}); });
  actions.appendChild(diagramBtn);
  el.appendChild(actions);
};

// ─── Commit Tab ────────────────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.renderCommit = function () {
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading commit config...</div>';
  var api = diApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('commit:config', {}).then(function (config) {
    el.innerHTML = '';
    var cfg = config || {};

    var card = diEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">\uD83D\uDCDD Commit Message Generation</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Style: ' + diEsc(cfg.style || 'conventional') + '</div>' +
      '<div>Include scope: ' + (cfg.includeScope !== false ? 'Yes' : 'No') + '</div>' +
      '<div>Max length: ' + (cfg.maxLength || 72) + '</div></div>';
    el.appendChild(card);

    var genBtn = diEl('button', 'font-size:11px;padding:6px 14px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    genBtn.textContent = '\uD83D\uDCDD Generate Commit Message';
    genBtn.addEventListener('click', function () {
      api.invoke('commit:generate', {}).then(function (r) {
        var resultArea = el.querySelector('.di-commit-result');
        if (resultArea) resultArea.innerHTML = '<div style="margin-top:8px;font-size:12px;padding:8px;background:var(--surface-tertiary,#45475a);border-radius:4px;color:var(--text-primary,#cdd6f4);white-space:pre-wrap;">' + diEsc(r && r.message || r || '') + '</div>';
      }).catch(function () {});
    });
    el.appendChild(genBtn);

    var resultArea = diEl('div', '');
    resultArea.className = 'di-commit-result';
    el.appendChild(resultArea);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load commit config</div>'; });
};

// ─── Cleanup & Exports ─────────────────────────────────────────────

DriftIntelligenceWorkspacePanel.prototype.destroy = function () {
  if (this.container) this.container.innerHTML = '';
};

if (typeof window !== 'undefined') {
  window.DriftIntelligenceWorkspacePanel = DriftIntelligenceWorkspacePanel;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DriftIntelligenceWorkspacePanel: DriftIntelligenceWorkspacePanel };
}
