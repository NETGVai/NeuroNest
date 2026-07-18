// @ts-nocheck
/**
 * DriftIntelligenceWorkspacePanel — Unified drift and intelligence management.
 *
 * Uses window.wk namespace utilities for forms, toasts, cards, badges, etc.
 * All actions show toast feedback. All buttons disabled during async ops.
 * No alert() calls — all data displayed in-panel.
 *
 * Tabs: Drift, Semantic, Indexing, LSP, Prompt, Vision, Commit
 * Requirements: 1-5 (toast, forms, data display, polish, per-panel)
 */

(function () {
  'use strict';

  var TABS = [
    { id: 'drift', label: 'Drift' },
    { id: 'semantic', label: 'Semantic' },
    { id: 'indexing', label: 'Indexing' },
    { id: 'lsp', label: 'LSP' },
    { id: 'prompt', label: 'Prompt' },
    { id: 'vision', label: 'Vision' },
    { id: 'commit', label: 'Commit' },
  ];

  function api() { return window.electronAPI; }
  function projectId() { return window._neuronestActiveProject || 'default'; }

  // ─── Helpers ─────────────────────────────────────────────────────

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.pointerEvents = ''; }

  function asyncAction(btn, promise, successMsg) {
    disableBtn(btn);
    return promise.then(function (r) {
      enableBtn(btn);
      wk.toast(successMsg, 'success');
      return r;
    }).catch(function (err) {
      enableBtn(btn);
      wk.toast((err && err.message) || 'Action failed', 'error');
      throw err;
    });
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function formatTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  function debounce(fn, delay) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, delay);
    };
  }

  // Circular gauge SVG component
  function circularGauge(value, max, label) {
    var pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
    var radius = 36;
    var circumference = 2 * Math.PI * radius;
    var offset = circumference - (pct / 100) * circumference;
    var color = pct >= 80 ? 'var(--green, #4ade80)' : pct >= 50 ? 'var(--yellow, #fbbf24)' : 'var(--red, #f87171)';

    var el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';
    el.innerHTML = '<svg width="88" height="88" viewBox="0 0 88 88" style="transform:rotate(-90deg);">' +
      '<circle cx="44" cy="44" r="' + radius + '" fill="none" stroke="var(--surface-container-highest, #333)" stroke-width="6"/>' +
      '<circle cx="44" cy="44" r="' + radius + '" fill="none" stroke="' + color + '" stroke-width="6" ' +
      'stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '" stroke-linecap="round" ' +
      'style="transition:stroke-dashoffset var(--motion-standard, 0.3s);"/>' +
      '</svg>' +
      '<div style="position:relative;margin-top:-60px;font-size:18px;font-weight:700;color:' + color + ';">' + Math.round(pct) + '%</div>' +
      '<div style="font-size:11px;color:var(--text-dim, #5a5a5a);margin-top:8px;">' + escHtml(label || '') + '</div>';
    return el;
  }

  // ─── Panel Constructor ────────────────────────────────────────────

  function DriftIntelligenceWorkspacePanel(container, options) {
    this.container = container;
    this.activeTab = 'drift';
    this._driftTimer = null;
    this._destroyed = false;
  }

  DriftIntelligenceWorkspacePanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-family);overflow:hidden;';

    // Tab bar
    var tabBar = document.createElement('div');
    tabBar.className = 'wk-tabs';
    for (var i = 0; i < TABS.length; i++) {
      (function (tab) {
        var btn = document.createElement('button');
        btn.className = 'wk-tab' + (tab.id === self.activeTab ? ' active' : '');
        btn.textContent = tab.label;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-label', tab.label + ' tab');
        btn.addEventListener('click', function () {
          self.activeTab = tab.id;
          self.render();
        });
        tabBar.appendChild(btn);
      })(TABS[i]);
    }
    this.container.appendChild(tabBar);

    // Scrollable content area
    var content = document.createElement('div');
    content.className = 'wk-scroll';
    content.style.cssText = 'flex:1;overflow-y:auto;padding:0 4px;';
    this.container.appendChild(content);

    this._content = content;
    this._loadTab(this.activeTab);
  };

  DriftIntelligenceWorkspacePanel.prototype._loadTab = function (id) {
    // Clear any running timers
    if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }

    switch (id) {
      case 'drift': this._renderDrift(); break;
      case 'semantic': this._renderSemantic(); break;
      case 'indexing': this._renderIndexing(); break;
      case 'lsp': this._renderLSP(); break;
      case 'prompt': this._renderPrompt(); break;
      case 'vision': this._renderVision(); break;
      case 'commit': this._renderCommit(); break;
    }
  };

  // ─── Drift Tab ─────────────────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype._renderDrift = function () {
    var self = this;
    var el = this._content;
    el.innerHTML = '';

    if (!api()) {
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to the drift service.'));
      return;
    }

    // Last updated indicator
    var updatedLabel = document.createElement('div');
    updatedLabel.style.cssText = 'font-size:10px;color:var(--text-dim);text-align:right;margin-bottom:8px;';
    updatedLabel.textContent = 'Loading...';
    el.appendChild(updatedLabel);

    var driftBody = document.createElement('div');
    el.appendChild(driftBody);

    function loadDrift() {
      if (self._destroyed) return;
      api().invoke('drift:get-state', {}).then(function (state) {
        if (self._destroyed || self.activeTab !== 'drift') return;
        driftBody.innerHTML = '';
        updatedLabel.textContent = 'Last updated: ' + new Date().toLocaleTimeString();

        if (!state) {
          driftBody.appendChild(wk.emptyState('🎯', 'Drift Inactive', 'Drift monitoring is not active for this project.'));
          return;
        }

        // Hero card with circular gauge
        var heroCard = document.createElement('div');
        heroCard.className = 'wk-card';
        heroCard.style.cssText = 'display:flex;align-items:center;gap:20px;margin-bottom:12px;padding:16px;';

        var gauge = circularGauge((state.confidence || 0) * 100, 100, 'Confidence');
        heroCard.appendChild(gauge);

        var info = document.createElement('div');
        info.style.cssText = 'flex:1;';
        var stateLabel = document.createElement('div');
        stateLabel.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:6px;';
        stateLabel.textContent = (state.state || 'nominal').charAt(0).toUpperCase() + (state.state || 'nominal').slice(1);
        info.appendChild(stateLabel);

        // Scope usage bar
        if (state.scopeUsage != null) {
          var scopeLabel = document.createElement('div');
          scopeLabel.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:4px;';
          scopeLabel.textContent = 'Scope Usage: ' + Math.round(state.scopeUsage * 100) + '%';
          info.appendChild(scopeLabel);
          info.appendChild(wk.progress(state.scopeUsage * 100, 100));
        }

        if (state.staleCountdown) {
          var staleEl = document.createElement('div');
          staleEl.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:6px;';
          staleEl.textContent = 'Stale countdown: ' + state.staleCountdown;
          info.appendChild(staleEl);
        }

        if (state.anchorSummary) {
          var anchorEl = document.createElement('div');
          anchorEl.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:4px;';
          anchorEl.textContent = 'Anchor: ' + state.anchorSummary.slice(0, 100);
          info.appendChild(anchorEl);
        }

        heroCard.appendChild(info);
        driftBody.appendChild(heroCard);

        // Signals list
        if (state.signals && state.signals.length > 0) {
          var sigHeader = document.createElement('div');
          sigHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;display:flex;align-items:center;gap:6px;';
          sigHeader.textContent = 'Recent Signals';
          var sigCount = wk.badge(String(state.signals.length), 'info');
          sigHeader.appendChild(sigCount);
          driftBody.appendChild(sigHeader);

          var sigList = document.createElement('div');
          sigList.className = 'wk-scroll';
          sigList.style.cssText = 'max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;';

          for (var i = 0; i < state.signals.length; i++) {
            var sig = state.signals[i];
            var sigCard = document.createElement('div');
            sigCard.className = 'wk-card';
            sigCard.style.cssText = 'padding:8px 12px;display:flex;align-items:center;gap:8px;';

            var typeIcon = document.createElement('span');
            typeIcon.style.cssText = 'font-size:14px;flex-shrink:0;';
            var sigType = sig.type || sig.kind || 'info';
            typeIcon.textContent = sigType === 'error' ? '🔴' : sigType === 'warning' ? '🟡' : sigType === 'drift' ? '🎯' : '🔵';
            sigCard.appendChild(typeIcon);

            var sigContent = document.createElement('div');
            sigContent.style.cssText = 'flex:1;min-width:0;';
            var sigMsg = document.createElement('div');
            sigMsg.style.cssText = 'font-size:11px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            sigMsg.textContent = sig.message || sig.reason || JSON.stringify(sig);
            sigContent.appendChild(sigMsg);

            if (sig.timestamp || sig.time) {
              var sigTime = document.createElement('div');
              sigTime.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
              sigTime.textContent = formatTime(sig.timestamp || sig.time);
              sigContent.appendChild(sigTime);
            }
            sigCard.appendChild(sigContent);
            sigList.appendChild(sigCard);
          }
          driftBody.appendChild(sigList);
        } else {
          var emptySig = document.createElement('div');
          emptySig.style.cssText = 'font-size:11px;color:var(--text-dim);text-align:center;padding:16px;';
          emptySig.textContent = 'No signals detected';
          driftBody.appendChild(emptySig);
        }
      }).catch(function (err) {
        driftBody.innerHTML = '';
        driftBody.appendChild(wk.emptyState('❌', 'Failed to load drift state', (err && err.message) || 'Unknown error'));
      });
    }

    loadDrift();
    // Auto-refresh every 10s
    self._driftTimer = setInterval(loadDrift, 10000);
  };

  // ─── Semantic Tab ──────────────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype._renderSemantic = function () {
    var self = this;
    var el = this._content;
    el.innerHTML = '';

    if (!api()) {
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to the semantic service.'));
      return;
    }

    // Search bar with debounce
    var searchRow = document.createElement('div');
    searchRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;';

    var searchIcon = document.createElement('span');
    searchIcon.style.cssText = 'font-size:14px;flex-shrink:0;';
    searchIcon.textContent = '🔍';
    searchRow.appendChild(searchIcon);

    var searchInput = document.createElement('input');
    searchInput.className = 'wk-input';
    searchInput.style.cssText = 'flex:1;';
    searchInput.placeholder = 'Search codebase semantically...';
    searchInput.setAttribute('aria-label', 'Semantic search input');
    searchRow.appendChild(searchInput);
    el.appendChild(searchRow);

    // Results container
    var resultsContainer = document.createElement('div');
    resultsContainer.style.cssText = 'margin-bottom:16px;';
    el.appendChild(resultsContainer);

    // Debounced search handler
    var doSearch = debounce(function () {
      var query = searchInput.value.trim();
      if (!query) { resultsContainer.innerHTML = ''; return; }
      resultsContainer.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;">Searching...</div>';
      api().invoke('semantic:search', { query: query }).then(function (r) {
        var results = Array.isArray(r) ? r : (r && r.results) || [];
        resultsContainer.innerHTML = '';
        if (results.length === 0) {
          resultsContainer.appendChild(wk.emptyState('📭', 'No Results', 'No files matched your query.'));
          return;
        }
        for (var i = 0; i < Math.min(results.length, 15); i++) {
          var item = results[i];
          var card = document.createElement('div');
          card.className = 'wk-card';
          card.style.cssText = 'margin-bottom:6px;padding:10px 14px;';

          var filePath = document.createElement('div');
          filePath.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;';
          filePath.textContent = item.file || item.path || 'unknown';
          if (item.score || item.relevance) {
            var scoreEl = wk.badge(Math.round((item.score || item.relevance) * 100) + '%', 'info');
            filePath.appendChild(scoreEl);
          }
          card.appendChild(filePath);

          var snippet = document.createElement('div');
          snippet.style.cssText = "font-size:11px;color:var(--text-secondary);font-family:'SF Mono',Menlo,monospace;white-space:pre-wrap;max-height:60px;overflow:hidden;line-height:1.4;";
          snippet.textContent = (item.content || item.text || '').slice(0, 200);
          card.appendChild(snippet);

          resultsContainer.appendChild(card);
        }
      }).catch(function (err) {
        resultsContainer.innerHTML = '';
        wk.toast((err && err.message) || 'Search failed', 'error');
      });
    }, 300);

    searchInput.addEventListener('input', doSearch);

    // Action bar: Reindex button
    var actionBar = document.createElement('div');
    actionBar.style.cssText = 'display:flex;gap:8px;align-items:center;padding-top:8px;border-top:1px solid var(--border-color);';

    var reindexBtn = document.createElement('button');
    reindexBtn.className = 'wk-btn-primary';
    reindexBtn.textContent = '🔄 Reindex';
    reindexBtn.setAttribute('aria-label', 'Reindex semantic search');
    var reindexSpinner = document.createElement('span');
    reindexSpinner.style.cssText = 'display:none;margin-left:6px;';
    reindexSpinner.textContent = '⏳';
    reindexBtn.appendChild(reindexSpinner);

    reindexBtn.addEventListener('click', function () {
      reindexSpinner.style.display = 'inline';
      wk.toast('Reindex started...', 'info');
      asyncAction(reindexBtn, api().invoke('semantic:reindex', {}), 'Reindex complete!').then(function () {
        reindexSpinner.style.display = 'none';
      }).catch(function () {
        reindexSpinner.style.display = 'none';
      });
    });
    actionBar.appendChild(reindexBtn);

    // Index status indicator
    api().invoke('semantic:index-status', {}).then(function (status) {
      var st = status || {};
      var statusText = document.createElement('span');
      statusText.style.cssText = 'font-size:11px;color:var(--text-dim);';
      statusText.textContent = (st.fileCount || st.totalFiles || 0) + ' files indexed';
      actionBar.appendChild(statusText);
    }).catch(function () {});

    el.appendChild(actionBar);
  };

  // ─── Indexing Tab ──────────────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype._renderIndexing = function () {
    var self = this;
    var el = this._content;
    el.innerHTML = '';

    if (!api()) {
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to the indexing service.'));
      return;
    }

    var loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px;text-align:center;';
    loadingEl.textContent = 'Loading indexing status...';
    el.appendChild(loadingEl);

    Promise.all([
      api().invoke('indexing:getStatus', {}),
      api().invoke('indexing:getConfig', {})
    ]).then(function (res) {
      el.innerHTML = '';
      var status = res[0] || {};
      var config = res[1] || {};

      // Progress card
      var progressCard = document.createElement('div');
      progressCard.className = 'wk-card';
      progressCard.style.cssText = 'margin-bottom:12px;';

      var progressHeader = document.createElement('div');
      progressHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;';
      progressHeader.textContent = 'Indexing Pipeline';
      var statusBadge = wk.badge(status.state || status.status || 'idle', (status.state === 'indexing' || status.state === 'running') ? 'warning' : 'info');
      progressHeader.appendChild(statusBadge);
      progressCard.appendChild(progressHeader);

      var pctValue = status.progress != null ? Math.round(status.progress * 100) : 0;
      var pctLabel = document.createElement('div');
      pctLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:6px;';
      pctLabel.textContent = 'Progress: ' + pctValue + '% (' + (status.filesProcessed || 0) + '/' + (status.totalFiles || 0) + ' files)';
      progressCard.appendChild(pctLabel);

      // Animated progress bar
      var progressBar = wk.progress(pctValue, 100);
      progressBar.style.cssText = 'height:6px;background:var(--surface-container-high);border-radius:3px;overflow:hidden;';
      var fill = progressBar.querySelector('.wk-progress-fill');
      if (fill) fill.style.cssText = 'height:100%;background:var(--accent);border-radius:3px;transition:width 0.5s ease;width:' + pctValue + '%;';
      progressCard.appendChild(progressBar);
      el.appendChild(progressCard);

      // Config card — editable inline
      var configCard = document.createElement('div');
      configCard.className = 'wk-card';
      configCard.style.cssText = 'margin-bottom:12px;';

      var configHeader = document.createElement('div');
      configHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
      configHeader.textContent = 'Configuration';
      configCard.appendChild(configHeader);

      var excludeLabel = document.createElement('label');
      excludeLabel.style.cssText = 'font-size:11px;color:var(--text-dim);display:block;margin-bottom:4px;';
      excludeLabel.textContent = 'Exclude patterns (comma separated)';
      configCard.appendChild(excludeLabel);

      var excludeInput = document.createElement('input');
      excludeInput.className = 'wk-input';
      excludeInput.value = (config.exclude || []).join(', ');
      excludeInput.placeholder = 'node_modules, .git, dist';
      excludeInput.setAttribute('aria-label', 'Exclude patterns');
      configCard.appendChild(excludeInput);

      var saveConfigBtn = document.createElement('button');
      saveConfigBtn.className = 'wk-btn-secondary';
      saveConfigBtn.style.cssText = 'margin-top:8px;';
      saveConfigBtn.textContent = 'Save Config';
      saveConfigBtn.setAttribute('aria-label', 'Save indexing configuration');
      saveConfigBtn.addEventListener('click', function () {
        var patterns = excludeInput.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        asyncAction(saveConfigBtn, api().invoke('indexing:updateConfig', { exclude: patterns }), 'Config updated').then(function () {
          self._renderIndexing();
        }).catch(function () {});
      });
      configCard.appendChild(saveConfigBtn);
      el.appendChild(configCard);

      // Action buttons
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;';

      var reindexBtn = document.createElement('button');
      reindexBtn.className = 'wk-btn-primary';
      reindexBtn.textContent = 'Full Reindex';
      reindexBtn.setAttribute('aria-label', 'Start full reindex');
      reindexBtn.addEventListener('click', function () {
        asyncAction(reindexBtn, api().invoke('indexing:fullReindex', {}), 'Full reindex started').then(function () {
          setTimeout(function () { self._renderIndexing(); }, 1000);
        }).catch(function () {});
      });
      actions.appendChild(reindexBtn);

      var stopBtn = document.createElement('button');
      stopBtn.className = 'wk-btn-danger';
      stopBtn.textContent = 'Stop';
      stopBtn.setAttribute('aria-label', 'Stop indexing');
      stopBtn.addEventListener('click', function () {
        asyncAction(stopBtn, api().invoke('indexing:stop', {}), 'Indexing stopped').then(function () {
          self._renderIndexing();
        }).catch(function () {});
      });
      actions.appendChild(stopBtn);
      el.appendChild(actions);
    }).catch(function (err) {
      el.innerHTML = '';
      el.appendChild(wk.emptyState('❌', 'Failed to load indexing status', (err && err.message) || 'Unknown error'));
    });
  };

  // ─── LSP Tab ───────────────────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype._renderLSP = function () {
    var self = this;
    var el = this._content;
    el.innerHTML = '';

    if (!api()) {
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to the LSP service.'));
      return;
    }

    var loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px;text-align:center;';
    loadingEl.textContent = 'Loading LSP status...';
    el.appendChild(loadingEl);

    api().invoke('lsp:status', {}).then(function (status) {
      el.innerHTML = '';
      var st = status || {};

      // Status card
      var statusCard = document.createElement('div');
      statusCard.className = 'wk-card';
      statusCard.style.cssText = 'margin-bottom:12px;';

      var statusHeader = document.createElement('div');
      statusHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;display:flex;align-items:center;gap:8px;';
      statusHeader.textContent = 'Language Server';
      var connBadge = wk.badge(
        (st.connected || st.running) ? 'Connected' : 'Disconnected',
        (st.connected || st.running) ? 'success' : 'error'
      );
      statusHeader.appendChild(connBadge);
      statusCard.appendChild(statusHeader);

      var details = document.createElement('div');
      details.style.cssText = 'font-size:11px;color:var(--text-secondary);line-height:1.8;';
      details.innerHTML = '<div>Language: <strong>' + escHtml(st.language || st.serverName || 'N/A') + '</strong></div>' +
        '<div>Diagnostics: <strong>' + (st.diagnosticCount || 0) + '</strong> active</div>';
      statusCard.appendChild(details);
      el.appendChild(statusCard);

      // Diagnostics section
      var diagHeader = document.createElement('div');
      diagHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
      diagHeader.textContent = 'Diagnostics';
      el.appendChild(diagHeader);

      var diagContainer = document.createElement('div');
      diagContainer.style.cssText = 'margin-bottom:16px;';
      el.appendChild(diagContainer);

      var diagBtn = document.createElement('button');
      diagBtn.className = 'wk-btn-secondary';
      diagBtn.textContent = 'Load Diagnostics';
      diagBtn.setAttribute('aria-label', 'Load diagnostics');
      diagBtn.addEventListener('click', function () {
        asyncAction(diagBtn, api().invoke('lsp:diagnostics', {}), 'Diagnostics loaded').then(function (diags) {
          diagContainer.innerHTML = '';
          var items = Array.isArray(diags) ? diags : (diags && diags.diagnostics) || [];
          if (items.length === 0) {
            diagContainer.appendChild(wk.emptyState('✅', 'No Issues', 'No diagnostics reported.'));
            return;
          }
          var list = document.createElement('div');
          list.className = 'wk-scroll';
          list.style.cssText = 'max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;';
          for (var i = 0; i < items.length; i++) {
            var diag = items[i];
            var severity = (diag.severity || 'info').toLowerCase();
            var sevColor = severity === 'error' ? 'var(--red)' : severity === 'warning' ? 'var(--yellow)' : 'var(--accent)';
            var diagCard = document.createElement('div');
            diagCard.className = 'wk-card';
            diagCard.style.cssText = 'padding:8px 12px;border-left:3px solid ' + sevColor + ';';
            diagCard.innerHTML = '<div style="font-size:11px;color:var(--text-primary);font-weight:500;">' + escHtml(diag.message || diag.text || '') + '</div>' +
              '<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">' + escHtml(diag.file || diag.source || '') + (diag.line ? ':' + diag.line : '') + '</div>';
            list.appendChild(diagCard);
          }
          diagContainer.appendChild(list);
        }).catch(function () {});
      });
      el.appendChild(diagBtn);

      // Symbols section — filterable list (no alert())
      var symSection = document.createElement('div');
      symSection.style.cssText = 'margin-top:16px;';

      var symHeader = document.createElement('div');
      symHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
      symHeader.textContent = 'Symbols';
      symSection.appendChild(symHeader);

      var symFilter = document.createElement('input');
      symFilter.className = 'wk-input';
      symFilter.style.cssText = 'margin-bottom:8px;';
      symFilter.placeholder = 'Filter symbols...';
      symFilter.setAttribute('aria-label', 'Filter symbols');
      symSection.appendChild(symFilter);

      var symContainer = document.createElement('div');
      symSection.appendChild(symContainer);

      var symBtn = document.createElement('button');
      symBtn.className = 'wk-btn-secondary';
      symBtn.style.cssText = 'margin-top:8px;';
      symBtn.textContent = 'Load Symbols';
      symBtn.setAttribute('aria-label', 'Load symbols');

      var allSymbols = [];
      symBtn.addEventListener('click', function () {
        asyncAction(symBtn, api().invoke('lsp:symbols', {}), 'Symbols loaded').then(function (syms) {
          allSymbols = Array.isArray(syms) ? syms : (syms && syms.symbols) || [];
          renderSymbols(allSymbols, '');
        }).catch(function () {});
      });

      function renderSymbols(symbols, filter) {
        symContainer.innerHTML = '';
        var filtered = symbols;
        if (filter) {
          var lowerFilter = filter.toLowerCase();
          filtered = symbols.filter(function (s) {
            return ((s.name || s.symbol || '') + (s.kind || '')).toLowerCase().indexOf(lowerFilter) >= 0;
          });
        }
        if (filtered.length === 0) {
          symContainer.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;">No symbols found.</div>';
          return;
        }
        var list = document.createElement('div');
        list.className = 'wk-scroll';
        list.style.cssText = 'max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:3px;';
        for (var i = 0; i < Math.min(filtered.length, 50); i++) {
          var sym = filtered[i];
          var symEl = document.createElement('div');
          symEl.style.cssText = 'font-size:11px;padding:4px 8px;background:var(--surface-container-high);border-radius:var(--radius-xs);display:flex;justify-content:space-between;align-items:center;';
          symEl.innerHTML = '<span style="color:var(--text-primary);">' + escHtml(sym.name || sym.symbol || 'unnamed') + '</span>' +
            '<span style="color:var(--text-dim);font-size:10px;">' + escHtml(sym.kind || sym.type || '') + '</span>';
          list.appendChild(symEl);
        }
        symContainer.appendChild(list);
      }

      symFilter.addEventListener('input', function () {
        renderSymbols(allSymbols, symFilter.value.trim());
      });

      symSection.appendChild(symBtn);
      el.appendChild(symSection);
    }).catch(function (err) {
      el.innerHTML = '';
      el.appendChild(wk.emptyState('❌', 'Failed to load LSP status', (err && err.message) || 'Unknown error'));
    });
  };

  // ─── Prompt Enhancement Tab ────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype._renderPrompt = function () {
    var self = this;
    var el = this._content;
    el.innerHTML = '';

    if (!api()) {
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to the prompt service.'));
      return;
    }

    api().invoke('prompt:config', {}).then(function (config) {
      el.innerHTML = '';
      var cfg = config || {};

      // Config card
      var configCard = document.createElement('div');
      configCard.className = 'wk-card';
      configCard.style.cssText = 'margin-bottom:12px;';
      configCard.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">Prompt Enhancement</div>' +
        '<div style="font-size:11px;color:var(--text-secondary);line-height:1.6;">' +
        '<div>Enabled: ' + (cfg.enabled !== false ? '<span style="color:var(--green);">Yes</span>' : '<span style="color:var(--red);">No</span>') + '</div>' +
        '<div>Strategy: ' + escHtml(cfg.strategy || 'auto') + '</div>' +
        '<div>Context window: ' + escHtml(cfg.contextWindow || 'default') + '</div></div>';
      el.appendChild(configCard);

      // Input area
      var inputLabel = document.createElement('div');
      inputLabel.style.cssText = 'font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;font-weight:600;';
      inputLabel.textContent = 'Enter prompt to enhance';
      el.appendChild(inputLabel);

      var textarea = document.createElement('textarea');
      textarea.className = 'wk-textarea';
      textarea.placeholder = 'Type your prompt here to preview enhancement...';
      textarea.setAttribute('aria-label', 'Prompt to enhance');
      textarea.rows = 4;
      el.appendChild(textarea);

      var enhanceBtn = document.createElement('button');
      enhanceBtn.className = 'wk-btn-primary';
      enhanceBtn.style.cssText = 'margin-top:8px;margin-bottom:16px;';
      enhanceBtn.textContent = '✨ Enhance Prompt';
      enhanceBtn.setAttribute('aria-label', 'Enhance prompt');
      el.appendChild(enhanceBtn);

      // Split view containers for before/after
      var splitContainer = document.createElement('div');
      splitContainer.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;display:none;';

      var beforeBox = document.createElement('div');
      beforeBox.style.cssText = "background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:10px;font-size:11px;font-family:'SF Mono',Menlo,monospace;color:var(--text-secondary);white-space:pre-wrap;max-height:200px;overflow-y:auto;";
      var beforeLabel = document.createElement('div');
      beforeLabel.style.cssText = 'font-size:10px;color:var(--text-dim);text-transform:uppercase;margin-bottom:6px;font-weight:600;';
      beforeLabel.textContent = 'Before';
      beforeBox.appendChild(beforeLabel);
      var beforeContent = document.createElement('div');
      beforeBox.appendChild(beforeContent);

      var afterBox = document.createElement('div');
      afterBox.style.cssText = "background:var(--surface-container);border:1px solid var(--accent);border-radius:var(--radius-sm);padding:10px;font-size:11px;font-family:'SF Mono',Menlo,monospace;color:var(--text-primary);white-space:pre-wrap;max-height:200px;overflow-y:auto;";
      var afterLabel = document.createElement('div');
      afterLabel.style.cssText = 'font-size:10px;color:var(--accent);text-transform:uppercase;margin-bottom:6px;font-weight:600;';
      afterLabel.textContent = 'After (Enhanced)';
      afterBox.appendChild(afterLabel);
      var afterContent = document.createElement('div');
      afterBox.appendChild(afterContent);

      splitContainer.appendChild(beforeBox);
      splitContainer.appendChild(afterBox);
      el.appendChild(splitContainer);

      // Accept/Reject buttons
      var actionRow = document.createElement('div');
      actionRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;display:none;';

      var acceptBtn = document.createElement('button');
      acceptBtn.className = 'wk-btn-primary';
      acceptBtn.textContent = '✓ Accept';
      acceptBtn.setAttribute('aria-label', 'Accept enhanced prompt');

      var rejectBtn = document.createElement('button');
      rejectBtn.className = 'wk-btn-secondary';
      rejectBtn.textContent = '✗ Reject';
      rejectBtn.setAttribute('aria-label', 'Reject enhanced prompt');

      actionRow.appendChild(acceptBtn);
      actionRow.appendChild(rejectBtn);
      el.appendChild(actionRow);

      var lastEnhanced = '';
      enhanceBtn.addEventListener('click', function () {
        var text = textarea.value.trim();
        if (!text) { wk.toast('Enter a prompt first', 'info'); return; }
        asyncAction(enhanceBtn, api().invoke('prompt:enhance', { prompt: text }), 'Prompt enhanced').then(function (r) {
          var enhanced = (r && r.enhanced) || r || '';
          lastEnhanced = enhanced;
          beforeContent.textContent = text;
          afterContent.textContent = enhanced;
          splitContainer.style.display = 'grid';
          actionRow.style.display = 'flex';
        }).catch(function () {
          splitContainer.style.display = 'none';
          actionRow.style.display = 'none';
        });
      });

      acceptBtn.addEventListener('click', function () {
        if (lastEnhanced) {
          textarea.value = lastEnhanced;
          wk.toast('Enhanced prompt accepted', 'success');
        }
        splitContainer.style.display = 'none';
        actionRow.style.display = 'none';
      });

      rejectBtn.addEventListener('click', function () {
        splitContainer.style.display = 'none';
        actionRow.style.display = 'none';
        wk.toast('Enhancement rejected', 'info');
      });
    }).catch(function (err) {
      el.innerHTML = '';
      el.appendChild(wk.emptyState('❌', 'Failed to load prompt config', (err && err.message) || 'Unknown error'));
    });
  };

  // ─── Vision Tab ────────────────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype._renderVision = function () {
    var self = this;
    var el = this._content;
    el.innerHTML = '';

    if (!api()) {
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to the vision service.'));
      return;
    }

    // Info card
    var infoCard = document.createElement('div');
    infoCard.className = 'wk-card';
    infoCard.style.cssText = 'margin-bottom:12px;';
    infoCard.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">👁 Vision Analysis</div>' +
      '<div style="font-size:11px;color:var(--text-secondary);">Analyze screenshots, compare UI states, or generate diagrams. Requires a vision-capable provider.</div>';
    el.appendChild(infoCard);

    // File picker for image input
    var fileRow = document.createElement('div');
    fileRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;';

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.cssText = 'display:none;';
    fileInput.setAttribute('aria-label', 'Select image file');

    var filePickerBtn = document.createElement('button');
    filePickerBtn.className = 'wk-btn-secondary';
    filePickerBtn.textContent = '📁 Select Image';
    filePickerBtn.setAttribute('aria-label', 'Open file picker for image');
    filePickerBtn.addEventListener('click', function () { fileInput.click(); });

    var fileLabel = document.createElement('span');
    fileLabel.style.cssText = 'font-size:11px;color:var(--text-dim);';
    fileLabel.textContent = 'No file selected';

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length > 0) {
        fileLabel.textContent = fileInput.files[0].name;
      }
    });

    fileRow.appendChild(fileInput);
    fileRow.appendChild(filePickerBtn);
    fileRow.appendChild(fileLabel);
    el.appendChild(fileRow);

    // Results container
    var resultsContainer = document.createElement('div');
    resultsContainer.style.cssText = 'margin-bottom:12px;';
    el.appendChild(resultsContainer);

    // Action buttons
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    var analyzeBtn = document.createElement('button');
    analyzeBtn.className = 'wk-btn-primary';
    analyzeBtn.textContent = '🔍 Analyze Image';
    analyzeBtn.setAttribute('aria-label', 'Analyze selected image');
    analyzeBtn.addEventListener('click', function () {
      wk.toast('Analyzing image...', 'info');
      asyncAction(analyzeBtn, api().invoke('vision:analyze', {}), 'Analysis complete').then(function (r) {
        resultsContainer.innerHTML = '';
        var result = r || {};
        if (typeof result === 'string') {
          var textCard = document.createElement('div');
          textCard.className = 'wk-card';
          textCard.style.cssText = "font-size:11px;color:var(--text-primary);white-space:pre-wrap;font-family:'SF Mono',Menlo,monospace;max-height:200px;overflow-y:auto;";
          textCard.textContent = result;
          resultsContainer.appendChild(textCard);
        } else {
          wk.dataView(resultsContainer, result);
        }
      }).catch(function () {});
    });
    actions.appendChild(analyzeBtn);

    var compareBtn = document.createElement('button');
    compareBtn.className = 'wk-btn-secondary';
    compareBtn.textContent = '↔ Compare';
    compareBtn.setAttribute('aria-label', 'Compare images');
    compareBtn.addEventListener('click', function () {
      asyncAction(compareBtn, api().invoke('vision:compare', {}), 'Comparison complete').then(function (r) {
        resultsContainer.innerHTML = '';
        wk.dataView(resultsContainer, r || { result: 'No data' });
      }).catch(function () {});
    });
    actions.appendChild(compareBtn);

    var diagramBtn = document.createElement('button');
    diagramBtn.className = 'wk-btn-secondary';
    diagramBtn.textContent = '📐 Diagram';
    diagramBtn.setAttribute('aria-label', 'Generate diagram');
    diagramBtn.addEventListener('click', function () {
      asyncAction(diagramBtn, api().invoke('vision:diagram', {}), 'Diagram generated').then(function (r) {
        resultsContainer.innerHTML = '';
        wk.dataView(resultsContainer, r || { result: 'No data' });
      }).catch(function () {});
    });
    actions.appendChild(diagramBtn);

    el.appendChild(actions);
  };

  // ─── Commit Tab ────────────────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype._renderCommit = function () {
    var self = this;
    var el = this._content;
    el.innerHTML = '';

    if (!api()) {
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to the commit service.'));
      return;
    }

    api().invoke('commit:config', {}).then(function (config) {
      el.innerHTML = '';
      var cfg = config || {};

      // Config card with inline editing
      var configCard = document.createElement('div');
      configCard.className = 'wk-card';
      configCard.style.cssText = 'margin-bottom:12px;';

      var configHeader = document.createElement('div');
      configHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:10px;';
      configHeader.textContent = '📝 Commit Message Config';
      configCard.appendChild(configHeader);

      // Style dropdown
      var styleRow = document.createElement('div');
      styleRow.style.cssText = 'margin-bottom:8px;';
      var styleLabel = document.createElement('label');
      styleLabel.style.cssText = 'font-size:11px;color:var(--text-dim);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;';
      styleLabel.textContent = 'Style';
      styleRow.appendChild(styleLabel);
      var styleSelect = document.createElement('select');
      styleSelect.className = 'wk-select';
      styleSelect.setAttribute('aria-label', 'Commit style');
      var styles = ['conventional', 'angular', 'simple', 'detailed'];
      for (var i = 0; i < styles.length; i++) {
        var opt = document.createElement('option');
        opt.value = styles[i];
        opt.textContent = styles[i].charAt(0).toUpperCase() + styles[i].slice(1);
        if (styles[i] === (cfg.style || 'conventional')) opt.selected = true;
        styleSelect.appendChild(opt);
      }
      styleRow.appendChild(styleSelect);
      configCard.appendChild(styleRow);

      // Scope toggle
      var scopeRow = document.createElement('div');
      scopeRow.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;gap:8px;';
      var scopeLabel = document.createElement('span');
      scopeLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);';
      scopeLabel.textContent = 'Include scope';
      scopeRow.appendChild(scopeLabel);
      var scopeToggle = wk.toggle(cfg.includeScope !== false, function () {});
      scopeRow.appendChild(scopeToggle);
      configCard.appendChild(scopeRow);

      // Max length input
      var maxRow = document.createElement('div');
      maxRow.style.cssText = 'margin-bottom:8px;';
      var maxLabel = document.createElement('label');
      maxLabel.style.cssText = 'font-size:11px;color:var(--text-dim);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;';
      maxLabel.textContent = 'Max Length';
      maxRow.appendChild(maxLabel);
      var maxInput = document.createElement('input');
      maxInput.className = 'wk-input';
      maxInput.type = 'number';
      maxInput.value = String(cfg.maxLength || 72);
      maxInput.setAttribute('aria-label', 'Max commit message length');
      maxRow.appendChild(maxInput);
      configCard.appendChild(maxRow);

      el.appendChild(configCard);

      // Generate button
      var generateBtn = document.createElement('button');
      generateBtn.className = 'wk-btn-primary';
      generateBtn.style.cssText = 'margin-bottom:16px;';
      generateBtn.textContent = '📝 Generate Commit Message';
      generateBtn.setAttribute('aria-label', 'Generate commit message');
      el.appendChild(generateBtn);

      // Result area — monospace code block with copy button
      var resultArea = document.createElement('div');
      resultArea.style.cssText = 'display:none;';
      el.appendChild(resultArea);

      generateBtn.addEventListener('click', function () {
        var opts = {
          style: styleSelect.value,
          includeScope: scopeToggle.classList.contains('active'),
          maxLength: parseInt(maxInput.value, 10) || 72
        };
        wk.toast('Generating commit message...', 'info');
        asyncAction(generateBtn, api().invoke('commit:generate', opts), 'Commit message generated').then(function (r) {
          var message = (r && r.message) || r || '';
          resultArea.style.display = 'block';
          resultArea.innerHTML = '';

          var codeBlock = document.createElement('div');
          codeBlock.style.cssText = "background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:12px;font-family:'SF Mono',Menlo,monospace;font-size:12px;color:var(--text-primary);white-space:pre-wrap;line-height:1.5;margin-bottom:8px;";
          codeBlock.textContent = message;
          resultArea.appendChild(codeBlock);

          // Copy button using wk.copyButton
          var copyBtn = wk.copyButton(message);
          resultArea.appendChild(copyBtn);
        }).catch(function () {
          resultArea.style.display = 'none';
        });
      });
    }).catch(function (err) {
      el.innerHTML = '';
      el.appendChild(wk.emptyState('❌', 'Failed to load commit config', (err && err.message) || 'Unknown error'));
    });
  };

  // ─── Cleanup & Exports ─────────────────────────────────────────────

  DriftIntelligenceWorkspacePanel.prototype.destroy = function () {
    this._destroyed = true;
    if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }
    if (this.container) this.container.innerHTML = '';
  };

  if (typeof window !== 'undefined') {
    window.DriftIntelligenceWorkspacePanel = DriftIntelligenceWorkspacePanel;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DriftIntelligenceWorkspacePanel: DriftIntelligenceWorkspacePanel };
  }

})();
