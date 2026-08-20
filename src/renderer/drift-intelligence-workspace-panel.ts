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

  function finiteNumber(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    var num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function formatCompact(value) {
    var num = finiteNumber(value);
    if (num == null) return 'N/A';
    if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
    if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(num).toLocaleString();
  }

  function formatDurationMs(value) {
    var ms = finiteNumber(value);
    if (ms == null) return 'N/A';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    var minutes = Math.floor(ms / 60000);
    return minutes + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
  }

  function safeInvoke(channel, args) {
    var bridge = api();
    if (!bridge) return Promise.resolve({ ok: false, error: 'IPC unavailable' });
    var invokeArgs = [channel].concat(args || []);
    return bridge.invoke.apply(bridge, invokeArgs).then(function (value) {
      if (value && value.error) {
        return { ok: false, error: String(value.message || value.code || value.error), value: value };
      }
      return { ok: true, value: value };
    }).catch(function (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    });
  }

  function metricCard(label, value, detail, tone) {
    var colors = {
      good: 'var(--green, #4ade80)',
      warn: 'var(--yellow, #fbbf24)',
      bad: 'var(--red, #f87171)',
      info: 'var(--accent, #89b4fa)',
      muted: 'var(--text-secondary, #aaa)'
    };
    var card = document.createElement('div');
    card.className = 'wk-card';
    card.style.cssText = 'padding:12px;min-width:0;';
    var labelEl = document.createElement('div');
    labelEl.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-bottom:6px;';
    labelEl.textContent = label;
    var valueEl = document.createElement('div');
    valueEl.style.cssText = 'font-size:18px;font-weight:700;line-height:1.15;color:' + (colors[tone] || colors.muted) + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    valueEl.textContent = value == null ? 'N/A' : String(value);
    card.appendChild(labelEl);
    card.appendChild(valueEl);
    if (detail) {
      var detailEl = document.createElement('div');
      detailEl.style.cssText = 'font-size:10px;line-height:1.4;color:var(--text-dim);margin-top:5px;';
      detailEl.textContent = detail;
      card.appendChild(detailEl);
    }
    return card;
  }

  function sectionBlock(title, subtitle) {
    var root = document.createElement('section');
    root.style.cssText = 'margin-top:16px;';
    var heading = document.createElement('div');
    heading.style.cssText = 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px;';
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-primary);';
    titleEl.textContent = title;
    heading.appendChild(titleEl);
    if (subtitle) {
      var subtitleEl = document.createElement('div');
      subtitleEl.style.cssText = 'font-size:10px;color:var(--text-dim);';
      subtitleEl.textContent = subtitle;
      heading.appendChild(subtitleEl);
    }
    var body = document.createElement('div');
    root.appendChild(heading);
    root.appendChild(body);
    return { root: root, body: body };
  }

  function metricGrid() {
    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:8px;';
    return grid;
  }

  function evidenceTone(tone) {
    var tones = {
      good: { color: 'var(--green,#4ade80)', background: 'rgba(74,222,128,.10)' },
      warn: { color: 'var(--yellow,#fbbf24)', background: 'rgba(251,191,36,.10)' },
      bad: { color: 'var(--red,#f87171)', background: 'rgba(248,113,113,.10)' },
      info: { color: 'var(--accent,#89b4fa)', background: 'rgba(137,180,250,.10)' },
      muted: { color: 'var(--text-secondary,#aaa)', background: 'var(--surface-container-highest,#333)' }
    };
    return tones[tone] || tones.muted;
  }

  // Compact Beautiful UI-style tool/status chips for discrete run facts.
  function evidenceChips(items) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:21px;';
    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      var tone = evidenceTone(item.tone);
      var chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border:1px solid ' + tone.color + ';border-radius:999px;background:' + tone.background + ';color:' + tone.color + ';font-size:9px;line-height:1.2;font-weight:700;white-space:nowrap;';
      if (item.symbol) {
        var symbol = document.createElement('span');
        symbol.setAttribute('aria-hidden', 'true');
        symbol.textContent = item.symbol;
        chip.appendChild(symbol);
      }
      var text = document.createElement('span');
      text.textContent = item.text;
      chip.appendChild(text);
      row.appendChild(chip);
    }
    return row;
  }

  // Progress treatment for bounded scope usage such as modified/allowed paths.
  function evidenceMeter(value, max, tone, startLabel, endLabel) {
    var safeValue = Math.max(0, Number(value) || 0);
    var safeMax = Math.max(0, Number(max) || 0);
    var pct = safeMax > 0 ? Math.min(100, (safeValue / safeMax) * 100) : 0;
    var color = evidenceTone(tone).color;
    var root = document.createElement('div');
    root.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    var labels = document.createElement('div');
    labels.style.cssText = 'display:flex;justify-content:space-between;gap:8px;color:var(--text-dim);font-size:9px;line-height:1.2;';
    var start = document.createElement('span');
    start.textContent = startLabel;
    var end = document.createElement('span');
    end.textContent = endLabel;
    labels.appendChild(start);
    labels.appendChild(end);
    var track = document.createElement('div');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(safeMax));
    track.setAttribute('aria-valuenow', String(safeMax > 0 ? Math.min(safeValue, safeMax) : 0));
    track.setAttribute('aria-valuetext', startLabel + ' of ' + endLabel);
    track.style.cssText = 'height:5px;overflow:hidden;border-radius:999px;background:var(--surface-container-highest,#333);';
    var fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:' + pct + '%;border-radius:inherit;background:' + color + ';transition:width var(--motion-standard,.3s);';
    track.appendChild(fill);
    root.appendChild(labels);
    root.appendChild(track);
    return root;
  }

  // Small task-row/stat treatment for paired or outcome-oriented counters.
  function evidenceStats(items) {
    var row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:repeat(' + Math.max(1, items.length) + ',minmax(0,1fr));gap:5px;';
    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      var tone = evidenceTone(item.tone);
      var stat = document.createElement('div');
      stat.style.cssText = 'min-width:0;padding:5px 6px;border-radius:6px;background:' + tone.background + ';';
      var value = document.createElement('div');
      value.style.cssText = 'color:' + tone.color + ';font-size:11px;font-weight:800;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      value.textContent = item.value;
      var label = document.createElement('div');
      label.style.cssText = 'margin-top:2px;color:var(--text-dim);font-size:8px;line-height:1.2;text-transform:uppercase;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      label.textContent = item.label;
      stat.appendChild(value);
      stat.appendChild(label);
      row.appendChild(stat);
    }
    return row;
  }

  function runEvidenceCard(options) {
    var tone = evidenceTone(options.tone);
    var card = document.createElement('div');
    card.className = 'wk-card';
    card.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:11px 12px;min-width:0;min-height:126px;box-sizing:border-box;';
    card.setAttribute('aria-label', options.label + ': ' + options.value);

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';
    var icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:0 0 24px;border-radius:7px;background:' + tone.background + ';color:' + tone.color + ';font-size:12px;font-weight:800;';
    icon.textContent = options.icon || '•';
    var heading = document.createElement('div');
    heading.style.cssText = 'min-width:0;';
    var label = document.createElement('div');
    label.style.cssText = 'color:var(--text-dim);font-size:8px;font-weight:750;letter-spacing:.07em;line-height:1.2;text-transform:uppercase;';
    label.textContent = options.label;
    var value = document.createElement('div');
    value.style.cssText = 'margin-top:2px;color:' + tone.color + ';font-size:14px;font-weight:750;line-height:1.25;overflow-wrap:anywhere;';
    value.textContent = options.value == null ? 'N/A' : String(options.value);
    heading.appendChild(label);
    heading.appendChild(value);
    header.appendChild(icon);
    header.appendChild(heading);
    card.appendChild(header);

    if (options.visual) card.appendChild(options.visual);
    if (options.detail) {
      var detail = document.createElement('div');
      detail.style.cssText = 'margin-top:auto;color:var(--text-dim);font-size:9px;line-height:1.4;';
      detail.textContent = options.detail;
      card.appendChild(detail);
    }
    return card;
  }

  // Circular gauge with a fixed overlay layer. Text never shares flow space
  // with the SVG stroke, which prevents the 100% label from overlapping it.
  function circularGauge(value, max, label, thresholds) {
    var pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
    var radius = 36;
    var circumference = 2 * Math.PI * radius;
    var offset = circumference - (pct / 100) * circumference;
    var warningPct = thresholds && finiteNumber(thresholds.warning) != null ? Number(thresholds.warning) * 100 : 70;
    var criticalPct = thresholds && finiteNumber(thresholds.critical) != null ? Number(thresholds.critical) * 100 : 40;
    var color = pct <= criticalPct ? 'var(--red, #f87171)' : pct <= warningPct ? 'var(--yellow, #fbbf24)' : 'var(--green, #4ade80)';

    var el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 104px;';
    var dial = document.createElement('div');
    dial.style.cssText = 'position:relative;width:88px;height:88px;flex:0 0 88px;';
    dial.innerHTML = '<svg width="88" height="88" viewBox="0 0 88 88" aria-hidden="true" style="position:absolute;inset:0;transform:rotate(-90deg);">' +
      '<circle cx="44" cy="44" r="' + radius + '" fill="none" stroke="var(--surface-container-highest, #333)" stroke-width="6"/>' +
      '<circle cx="44" cy="44" r="' + radius + '" fill="none" stroke="' + color + '" stroke-width="6" ' +
      'stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '" stroke-linecap="round" ' +
      'style="transition:stroke-dashoffset var(--motion-standard, 0.3s);"/>' +
      '</svg>' +
      '<div style="position:absolute;inset:10px;display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1;font-weight:700;color:' + color + ';">' + Math.round(pct) + '%</div>';
    var labelEl = document.createElement('div');
    labelEl.style.cssText = 'font-size:10px;line-height:1.2;color:var(--text-dim);text-align:center;';
    labelEl.textContent = label || '';
    el.appendChild(dial);
    el.appendChild(labelEl);
    return el;
  }

  function inactiveOrb(value, label) {
    var el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 104px;';
    el.innerHTML = '<div style="width:88px;height:88px;border-radius:50%;border:6px solid var(--surface-container-highest,#333);box-sizing:border-box;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:16px;font-weight:800;">' + escHtml(value || 'IDLE') + '</div>' +
      '<div style="font-size:10px;line-height:1.2;color:var(--text-dim);text-align:center;">' + escHtml(label || 'Evaluation state') + '</div>';
    return el;
  }

  // ─── Panel Constructor ────────────────────────────────────────────

  function DriftIntelligenceWorkspacePanel(container, options) {
    this.container = container;
    this.projectId = (options && options.projectId) || projectId();
    this.activeTab = 'drift';
    this._driftTimer = null;
    this._driftListeners = [];
    this._driftLoadGeneration = 0;
    this._destroyed = false;
  }

  DriftIntelligenceWorkspacePanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-family);overflow:hidden;';

    // Tab bar
    var tabBar = document.createElement('div');
    tabBar.className = 'wk-tabs';
    tabBar.style.cssText = 'flex:0 0 auto;padding:0 4px;';
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
    content.style.cssText = 'flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 8px 28px;scroll-padding-bottom:28px;box-sizing:border-box;';
    this.container.appendChild(content);

    this._content = content;
    this._loadTab(this.activeTab);
  };

  DriftIntelligenceWorkspacePanel.prototype._clearDriftLiveUpdates = function () {
    if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }
    var bridge = api();
    if (bridge && bridge.removeListener && this._driftListeners) {
      for (var i = 0; i < this._driftListeners.length; i++) {
        bridge.removeListener(this._driftListeners[i].channel, this._driftListeners[i].callback);
      }
    }
    this._driftListeners = [];
    this._driftLoadGeneration += 1;
  };

  DriftIntelligenceWorkspacePanel.prototype._loadTab = function (id) {
    this._clearDriftLiveUpdates();

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
      el.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to drift and intelligence services.'));
      return;
    }

    var toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:4px 0 10px;flex-wrap:wrap;';
    var toolbarCopy = document.createElement('div');
    toolbarCopy.innerHTML = '<div style="font-size:13px;font-weight:700;color:var(--text-primary);">Drift Management Intelligence</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">Live task alignment plus correlated execution, provider, quality, cost, and risk evidence.</div>';
    var toolbarActions = document.createElement('div');
    toolbarActions.style.cssText = 'display:flex;align-items:center;gap:8px;';
    var updatedLabel = document.createElement('span');
    updatedLabel.style.cssText = 'font-size:10px;color:var(--text-dim);';
    updatedLabel.textContent = 'Loading evidence…';
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'wk-btn';
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText = 'font-size:10px;padding:4px 9px;';
    toolbarActions.appendChild(updatedLabel);
    toolbarActions.appendChild(refreshBtn);
    toolbar.appendChild(toolbarCopy);
    toolbar.appendChild(toolbarActions);
    el.appendChild(toolbar);

    var dashboardBody = document.createElement('div');
    el.appendChild(dashboardBody);

    function statePill(text, tone) {
      var colors = {
        good: ['rgba(74,222,128,.12)', 'var(--green,#4ade80)'],
        warn: ['rgba(251,191,36,.12)', 'var(--yellow,#fbbf24)'],
        bad: ['rgba(248,113,113,.12)', 'var(--red,#f87171)'],
        muted: ['var(--surface-container-highest,#333)', 'var(--text-secondary,#aaa)'],
        info: ['rgba(137,180,250,.12)', 'var(--accent,#89b4fa)']
      };
      var pair = colors[tone] || colors.muted;
      var pill = document.createElement('span');
      pill.style.cssText = 'display:inline-flex;align-items:center;padding:3px 7px;border-radius:999px;background:' + pair[0] + ';color:' + pair[1] + ';font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;';
      pill.textContent = text;
      return pill;
    }

    function resultValue(snapshot, key) {
      var entry = snapshot[key];
      return entry && entry.ok ? entry.value : null;
    }

    function appendUnavailable(container, text) {
      var unavailable = document.createElement('div');
      unavailable.style.cssText = 'font-size:10px;color:var(--text-dim);padding:10px 12px;border:1px dashed var(--border-color);border-radius:8px;';
      unavailable.textContent = text;
      container.appendChild(unavailable);
    }

    function runSourceLabel(source) {
      if (source === 'agent-loop') return 'Drift-aware agent loop';
      if (source === 'enhanced-swarm') return 'Enhanced swarm';
      if (source === 'standard-swarm') return 'Standard swarm';
      return 'Agent execution';
    }

    function completedEvidence(state) {
      var latest = state && state.latestCompleted ? state.latestCompleted : null;
      var historicalDrift = latest && latest.driftState ? latest.driftState : null;
      return {
        latest: latest,
        drift: state && state.active === true ? state : historicalDrift,
        live: !!(state && state.active === true),
        historical: !!(state && state.active !== true && historicalDrift)
      };
    }

    function renderHero(snapshot) {
      var driftEntry = snapshot.drift;
      var state = resultValue(snapshot, 'drift');
      var evidence = completedEvidence(state);
      var latest = evidence.latest;
      var driftState = evidence.drift;
      var lintConfig = resultValue(snapshot, 'lintConfig');
      var isActive = evidence.live;
      var hasHistoricalDrift = evidence.historical;
      var confidence = driftState ? finiteNumber(driftState.confidence) : null;
      var thresholds = driftState && driftState.thresholds ? driftState.thresholds : null;
      var warningThreshold = thresholds ? finiteNumber(thresholds.warning) : null;
      var criticalThreshold = thresholds ? finiteNumber(thresholds.critical) : null;
      var unavailable = !driftEntry || !driftEntry.ok;
      var statusText = 'Monitoring inactive';
      var statusTone = 'muted';
      if (unavailable) {
        statusText = 'Monitor unavailable';
        statusTone = 'bad';
      } else if (isActive && confidence != null && criticalThreshold != null && confidence <= criticalThreshold) {
        statusText = 'Critical drift';
        statusTone = 'bad';
      } else if (isActive && confidence != null && warningThreshold != null && confidence <= warningThreshold) {
        statusText = 'Drift warning';
        statusTone = 'warn';
      } else if (isActive) {
        statusText = 'Evaluating current run';
        statusTone = 'good';
      } else if (hasHistoricalDrift) {
        statusText = 'Latest completed drift evaluation';
        statusTone = latest && latest.status === 'completed' ? 'good' : 'warn';
      } else if (latest) {
        statusText = 'Monitoring idle · completed run available';
        statusTone = latest.status === 'completed' ? 'info' : 'warn';
      }

      var hero = document.createElement('div');
      hero.className = 'wk-card';
      hero.style.cssText = 'display:flex;align-items:center;gap:18px;padding:16px;flex-wrap:wrap;';
      hero.appendChild((isActive || hasHistoricalDrift) && confidence != null
        ? circularGauge(confidence * 100, 100, isActive ? 'Task alignment' : 'Last alignment', thresholds)
        : inactiveOrb(unavailable ? 'N/A' : 'IDLE', unavailable ? 'Service state' : 'Evaluation state'));

      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:210px;';
      var statusRow = document.createElement('div');
      statusRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:7px;';
      var statusLabel = document.createElement('div');
      statusLabel.style.cssText = 'font-size:15px;font-weight:700;color:var(--text-primary);';
      statusLabel.textContent = statusText;
      statusRow.appendChild(statusLabel);
      statusRow.appendChild(statePill(unavailable ? 'Unavailable' : isActive ? 'Live' : latest ? 'Latest completed run' : 'Idle', statusTone));
      info.appendChild(statusRow);

      var explanation = document.createElement('div');
      explanation.style.cssText = 'font-size:11px;line-height:1.55;color:var(--text-secondary);';
      if (!driftEntry || !driftEntry.ok) {
        explanation.textContent = 'The drift service could not be read: ' + ((driftEntry && driftEntry.error) || 'unknown error') + '.';
      } else if (hasHistoricalDrift) {
        explanation.textContent = 'No run is being evaluated now. The gauge and drift evidence below are retained from the latest completed ' + runSourceLabel(latest.source).toLowerCase() + ' run at ' + formatTime(latest.completedAt) + '; they are historical, not live.';
      } else if (latest) {
        explanation.textContent = 'No run is being evaluated now. The latest ' + runSourceLabel(latest.source).toLowerCase() + ' run completed at ' + formatTime(latest.completedAt) + '. No drift snapshot is attached to this retained run; it may predate always-on capture. New runs record drift evidence in every execution mode.';
      } else if (!isActive) {
        explanation.textContent = 'No agent run is being evaluated now and no completed run evidence has been recorded for this project yet. Idle is not a 100% confidence result.';
      } else {
        explanation.textContent = 'Confidence measures alignment with the current intent anchor. It decays from elapsed time, scope violations, unexpected tools, and consecutive failures.';
      }
      info.appendChild(explanation);

      var configRow = document.createElement('div');
      configRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;';
      configRow.appendChild(statePill('Always on · all execution modes', 'good'));
      if (lintConfig && lintConfig.lintEnabled === true) {
        configRow.appendChild(statePill('Lint checks enabled', 'info'));
      } else if (!lintConfig) {
        configRow.appendChild(statePill('Lint state unknown', 'muted'));
      }
      if (lintConfig && lintConfig.runOnAiChange === true) configRow.appendChild(statePill('AI-change checks', 'info'));
      if (driftState && driftState.anchor && driftState.anchor.purpose) configRow.appendChild(statePill(String(driftState.anchor.purpose), 'info'));
      if ((isActive || hasHistoricalDrift) && warningThreshold != null && criticalThreshold != null) {
        configRow.appendChild(statePill('Warn ≤ ' + Math.round(warningThreshold * 100) + '%', 'warn'));
        configRow.appendChild(statePill('Critical ≤ ' + Math.round(criticalThreshold * 100) + '%', 'bad'));
      }
      info.appendChild(configRow);

      if (driftState && driftState.anchor) {
        var anchor = document.createElement('div');
        anchor.style.cssText = 'margin-top:11px;padding:9px 10px;border-left:3px solid var(--accent,#89b4fa);background:var(--bg-input);border-radius:0 7px 7px 0;';
        var anchorTiming = isActive
          ? (driftState.staleCountdownMs > 0 ? ' · stale threshold in ' + formatDurationMs(driftState.staleCountdownMs) : ' · stale threshold reached')
          : (latest ? ' · run completed ' + formatTime(latest.completedAt) : '');
        anchor.innerHTML = '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-dim);margin-bottom:3px;">' + (isActive ? 'Intent anchor' : 'Latest completed intent anchor') + '</div>' +
          '<div style="font-size:11px;color:var(--text-primary);line-height:1.45;overflow-wrap:anywhere;">' + escHtml(driftState.anchor.statement || 'No statement recorded') + '</div>' +
          '<div style="font-size:9px;color:var(--text-dim);margin-top:4px;">Created ' + escHtml(formatTime(driftState.anchor.createdAt)) + escHtml(anchorTiming) + '</div>';
        info.appendChild(anchor);
      }

      hero.appendChild(info);
      dashboardBody.appendChild(hero);
    }

    function renderScopeAndSignals(snapshot) {
      var state = resultValue(snapshot, 'drift');
      var evidence = completedEvidence(state);
      var latest = evidence.latest;
      var driftState = evidence.drift;
      var active = evidence.live;
      var historical = evidence.historical;
      var hasDriftEvidence = active || historical;
      var scope = driftState && driftState.scope ? driftState.scope : null;
      var signals = driftState && Array.isArray(driftState.signals) ? driftState.signals : [];
      var sectionTitle = active ? 'Current run evidence' : latest ? 'Latest completed run' : 'Run evidence';
      var sectionSubtitle = active
        ? 'Live scope envelope and threshold crossings'
        : latest
          ? runSourceLabel(latest.source) + ' · completed ' + formatTime(latest.completedAt) + ' · historical evidence, not live'
          : 'No completed project run has been recorded yet';
      var section = sectionBlock(sectionTitle, sectionSubtitle);
      var grid = metricGrid();
      var toolsUsed = scope ? Math.max(0, Number(scope.toolsUsed) || 0) : 0;
      var toolsAllowed = scope ? Math.max(0, Number(scope.toolsAllowed) || 0) : 0;
      var pathsModified = scope ? Math.max(0, Number(scope.pathsModified) || 0) : 0;
      var pathsAllowed = scope ? Math.max(0, Number(scope.pathsAllowed) || 0) : 0;

      var toolsVisual = scope
        ? evidenceChips([
          { symbol: '●', text: formatCompact(toolsUsed) + ' observed', tone: 'info' },
          { symbol: '◇', text: formatCompact(toolsAllowed) + ' allowed', tone: 'muted' }
        ])
        : evidenceChips([{ symbol: '—', text: 'Awaiting snapshot', tone: 'muted' }]);
      grid.appendChild(runEvidenceCard({
        label: 'Tools in scope',
        value: scope ? formatCompact(toolsUsed) + ' / ' + formatCompact(toolsAllowed) : 'N/A',
        detail: hasDriftEvidence ? 'Distinct observed tool IDs compared with the allowed set' : latest ? 'No retained scope snapshot; this run may predate always-on capture' : 'No scope envelope recorded',
        icon: '⌘',
        tone: scope ? 'info' : 'muted',
        visual: toolsVisual
      }));

      var pathScopeValue = scope
        ? (pathsAllowed === 0 ? formatCompact(pathsModified) + ' / unrestricted' : formatCompact(pathsModified) + ' / ' + formatCompact(pathsAllowed))
        : 'N/A';
      var pathsVisual = !scope
        ? evidenceChips([{ symbol: '—', text: 'Awaiting snapshot', tone: 'muted' }])
        : pathsAllowed === 0
          ? evidenceChips([
            { symbol: '↗', text: formatCompact(pathsModified) + ' modified', tone: 'info' },
            { symbol: '∞', text: 'Unrestricted', tone: 'good' }
          ])
          : evidenceMeter(pathsModified, pathsAllowed, pathsModified > pathsAllowed ? 'warn' : 'info', formatCompact(pathsModified) + ' modified', formatCompact(pathsAllowed) + ' allowed');
      grid.appendChild(runEvidenceCard({
        label: 'Paths in scope',
        value: pathScopeValue,
        detail: hasDriftEvidence && scope ? (pathsAllowed === 0 ? 'Modified paths; no path restriction configured' : 'Modified paths compared with allowed patterns') : latest ? 'No retained scope snapshot; this run may predate always-on capture' : 'No scope envelope recorded',
        icon: '⌁',
        tone: scope ? (pathsAllowed > 0 && pathsModified > pathsAllowed ? 'warn' : 'info') : 'muted',
        visual: pathsVisual
      }));

      var signalsVisual = evidenceChips([hasDriftEvidence
        ? { symbol: signals.length ? '▲' : '✓', text: signals.length ? signals.length + ' threshold crossing' + (signals.length === 1 ? '' : 's') : 'No crossings', tone: signals.length ? 'warn' : 'good' }
        : { symbol: '—', text: 'No snapshot', tone: 'muted' }
      ]);
      grid.appendChild(runEvidenceCard({
        label: 'Drift signals',
        value: hasDriftEvidence ? String(signals.length) : 'N/A',
        detail: hasDriftEvidence ? (signals.length ? 'Threshold crossings recorded in this run' : 'No threshold crossings in this run') : latest ? 'No retained drift snapshot; new runs capture every mode' : 'No signal history recorded',
        icon: '△',
        tone: signals.length ? 'warn' : (hasDriftEvidence ? 'good' : 'muted'),
        visual: signalsVisual
      }));

      var timingValue = active ? formatDurationMs(driftState.staleCountdownMs) : latest ? formatTime(latest.completedAt) : 'N/A';
      var timingVisual = active
        ? evidenceChips([{ symbol: '◷', text: 'Anchor countdown', tone: 'info' }])
        : latest
          ? evidenceChips([{ symbol: '✓', text: 'Persisted run', tone: latest.status === 'completed' ? 'good' : 'warn' }])
          : evidenceChips([{ symbol: '—', text: 'No completed run', tone: 'muted' }]);
      grid.appendChild(runEvidenceCard({
        label: active ? 'Intent freshness' : 'Completed',
        value: timingValue,
        detail: active ? 'Time until the current intent anchor becomes stale' : latest ? 'Latest persisted project run' : 'Starts with the next recorded run',
        icon: active ? '◷' : '✓',
        tone: active ? 'info' : latest ? 'good' : 'muted',
        visual: timingVisual
      }));
      section.body.appendChild(grid);

      if (latest && !active) {
        var runGrid = metricGrid();
        runGrid.style.marginTop = '8px';
        var taskCompleted = Number(latest.taskCompletedCount || 0);
        var taskFailed = Number(latest.taskFailedCount || 0);
        var taskBlocked = Number(latest.taskBlockedCount || 0);
        var toolSucceeded = Number(latest.toolSuccessCount || 0);
        var toolFailed = Number(latest.toolFailureCount || 0);
        var taskTotal = taskCompleted + taskFailed + taskBlocked;
        var toolTotal = toolSucceeded + toolFailed;
        var outcomeSummary = taskTotal
          ? taskCompleted + ' completed · ' + taskFailed + ' failed · ' + taskBlocked + ' blocked'
          : toolTotal
            ? toolSucceeded + ' succeeded · ' + toolFailed + ' failed'
            : latest.agentOutputCount
              ? latest.agentOutputCount + ' agent outputs produced; outcome status unavailable'
              : 'No outcome counters exposed by this execution mode';

        runGrid.appendChild(runEvidenceCard({
          label: 'Execution mode',
          value: runSourceLabel(latest.source),
          detail: 'Persisted execution source; never inferred',
          icon: '◇',
          tone: 'info',
          visual: evidenceChips([{ symbol: '◆', text: String(latest.source || 'agent execution').replace(/-/g, ' '), tone: 'info' }])
        }));

        var statusTone = latest.status === 'completed' ? 'good' : latest.status === 'failed' ? 'bad' : 'warn';
        var outcomeVisual = taskTotal
          ? evidenceStats([
            { value: formatCompact(taskCompleted), label: 'Completed', tone: 'good' },
            { value: formatCompact(taskFailed), label: 'Failed', tone: taskFailed ? 'bad' : 'muted' },
            { value: formatCompact(taskBlocked), label: 'Blocked', tone: taskBlocked ? 'warn' : 'muted' }
          ])
          : toolTotal
            ? evidenceStats([
              { value: formatCompact(toolSucceeded), label: 'Succeeded', tone: 'good' },
              { value: formatCompact(toolFailed), label: 'Failed', tone: toolFailed ? 'bad' : 'muted' }
            ])
            : evidenceChips([{ symbol: latest.status === 'completed' ? '✓' : '•', text: String(latest.status || 'unknown'), tone: statusTone }]);
        runGrid.appendChild(runEvidenceCard({
          label: 'Run status',
          value: String(latest.status || 'unknown'),
          detail: outcomeSummary,
          icon: latest.status === 'completed' ? '✓' : latest.status === 'failed' ? '×' : '•',
          tone: statusTone,
          visual: outcomeVisual
        }));

        runGrid.appendChild(runEvidenceCard({
          label: 'Phases / iterations',
          value: formatCompact(latest.phaseCount || 0) + ' / ' + formatCompact(latest.loopIterations || 0),
          detail: 'Coordinator phases and drift-aware loop iterations',
          icon: '↻',
          tone: 'info',
          visual: evidenceStats([
            { value: formatCompact(latest.phaseCount || 0), label: 'Phases', tone: 'info' },
            { value: formatCompact(latest.loopIterations || 0), label: 'Iterations', tone: 'info' }
          ])
        }));

        runGrid.appendChild(runEvidenceCard({
          label: 'Agent outputs',
          value: formatCompact(latest.agentOutputCount || 0),
          detail: latest.source === 'standard-swarm' ? 'Output count only; not treated as success' : 'Outputs returned by the coordinator',
          icon: '✦',
          tone: latest.agentOutputCount ? 'info' : 'muted',
          visual: evidenceChips([latest.agentOutputCount
            ? { symbol: '✦', text: formatCompact(latest.agentOutputCount) + ' produced', tone: 'info' }
            : { symbol: '—', text: 'No outputs recorded', tone: 'muted' }
          ])
        }));
        section.body.appendChild(runGrid);
      }

      if (signals.length) {
        var list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px;';
        for (var i = signals.length - 1; i >= Math.max(0, signals.length - 8); i--) {
          var signal = signals[i] || {};
          var severity = signal.severity || 'info';
          var row = document.createElement('div');
          row.className = 'wk-card';
          row.style.cssText = 'display:flex;gap:9px;align-items:flex-start;padding:9px 11px;border-left:3px solid ' + (severity === 'critical' ? 'var(--red,#f87171)' : severity === 'warning' ? 'var(--yellow,#fbbf24)' : 'var(--accent,#89b4fa)') + ';';
          var icon = document.createElement('span');
          icon.textContent = severity === 'critical' ? '●' : severity === 'warning' ? '▲' : '●';
          icon.style.cssText = 'color:' + (severity === 'critical' ? 'var(--red,#f87171)' : severity === 'warning' ? 'var(--yellow,#fbbf24)' : 'var(--accent,#89b4fa)') + ';font-size:10px;margin-top:2px;';
          var copy = document.createElement('div');
          copy.style.cssText = 'min-width:0;flex:1;';
          copy.innerHTML = '<div style="font-size:11px;color:var(--text-primary);line-height:1.4;">' + escHtml(signal.message || 'Drift signal') + '</div>' +
            '<div style="font-size:9px;color:var(--text-dim);margin-top:3px;">' + escHtml(String(signal.category || 'uncategorized').replace(/_/g, ' ')) + ' · ' + escHtml(severity) +
            (signal.iteration != null ? ' · iteration ' + escHtml(signal.iteration) : '') +
            (finiteNumber(signal.currentConfidence) != null ? ' · ' + Math.round(Number(signal.currentConfidence) * 100) + '% alignment' : '') +
            (signal.timestamp ? ' · ' + escHtml(formatTime(signal.timestamp)) : '') + '</div>';
          row.appendChild(icon);
          row.appendChild(copy);
          list.appendChild(row);
        }
        section.body.appendChild(list);
      } else {
        appendUnavailable(section.body, hasDriftEvidence ? (historical ? 'No drift thresholds were crossed in the latest completed monitored run.' : 'No drift thresholds have been crossed in the current run.') : latest ? 'No drift snapshot is attached to this retained run. New runs capture drift evidence in every execution mode.' : 'No active or completed run evidence is available for this project yet.');
      }
      dashboardBody.appendChild(section.root);
    }

    function renderExecution(snapshot) {
      var metrics = resultValue(snapshot, 'metrics');
      var eventsResult = resultValue(snapshot, 'events');
      var events = eventsResult && eventsResult.success ? eventsResult.stats : null;
      var successes = metrics ? finiteNumber(metrics.totalToolSuccessCount) : null;
      var failures = metrics ? finiteNumber(metrics.totalToolFailureCount) : null;
      var attempts = successes != null && failures != null ? successes + failures : null;
      var successRate = attempts && successes != null ? (successes / attempts) * 100 : null;
      var taskSuccesses = metrics ? finiteNumber(metrics.totalTaskCompletedCount) : null;
      var taskFailures = metrics ? finiteNumber(metrics.totalTaskFailedCount) : null;
      var taskBlocked = metrics ? finiteNumber(metrics.totalTaskBlockedCount) : null;
      var taskAttempts = taskSuccesses != null && taskFailures != null && taskBlocked != null ? taskSuccesses + taskFailures + taskBlocked : null;
      var taskSuccessRate = taskAttempts && taskSuccesses != null ? (taskSuccesses / taskAttempts) * 100 : null;
      var observations = events ? finiteNumber(events.observations) : null;
      var observationRate = observations && finiteNumber(events.successRate) != null ? Number(events.successRate) * 100 : null;
      var section = sectionBlock('Execution reliability', 'Project-scoped completed-run evidence; tool, task, and output counts remain semantically separate');
      var grid = metricGrid();
      grid.appendChild(metricCard('Tool reliability', successRate == null ? 'N/A' : Math.round(successRate) + '%', attempts ? formatCompact(successes) + ' succeeded / ' + formatCompact(attempts) + ' attempts' : 'No drift-aware tool outcomes recorded', successRate == null ? 'muted' : successRate >= 95 ? 'good' : successRate >= 80 ? 'warn' : 'bad'));
      grid.appendChild(metricCard('Task reliability', taskSuccessRate == null ? 'N/A' : Math.round(taskSuccessRate) + '%', taskAttempts ? formatCompact(taskSuccesses) + ' completed · ' + formatCompact(taskFailures) + ' failed · ' + formatCompact(taskBlocked) + ' blocked' : 'No enhanced task outcomes recorded', taskSuccessRate == null ? 'muted' : taskSuccessRate >= 95 ? 'good' : taskSuccessRate >= 80 ? 'warn' : 'bad'));
      grid.appendChild(metricCard('Recorded runs', metrics ? formatCompact(metrics.runCount) : 'N/A', metrics ? formatCompact(metrics.sessionCount) + ' project session identifiers represented' : 'Metrics service unavailable', metrics && metrics.runCount ? 'info' : 'muted'));
      grid.appendChild(metricCard('Phases / iterations', metrics ? formatCompact(metrics.totalPhases) + ' / ' + formatCompact(metrics.totalLoopIterations) : 'N/A', 'Swarm phases / drift-aware loop iterations', metrics && (metrics.totalPhases || metrics.totalLoopIterations) ? 'info' : 'muted'));
      grid.appendChild(metricCard('Agent outputs', metrics ? formatCompact(metrics.totalAgentOutputCount) : 'N/A', 'Coordinator outputs; not assumed successful', metrics && metrics.totalAgentOutputCount ? 'info' : 'muted'));
      grid.appendChild(metricCard('Agent-loop tokens', metrics && metrics.totalTokensConsumed ? formatCompact(metrics.totalTokensConsumed) : 'N/A', metrics && metrics.totalTokensConsumed ? 'Measured tokens from drift-aware loops' : 'Default swarm does not expose measured run tokens', metrics && metrics.totalTokensConsumed ? 'info' : 'muted'));
      grid.appendChild(metricCard('Observed activity', events ? formatCompact(events.totalEvents) : 'N/A', events ? formatCompact(events.actions) + ' actions · ' + formatCompact(events.observations) + ' observations' : 'Event stream unavailable', 'info'));
      grid.appendChild(metricCard('Observation success', observationRate == null ? 'N/A' : Math.round(observationRate) + '%', observations ? formatCompact(observations) + ' observed outcomes · ' + formatDurationMs(events.avgDurationMs) + ' average' : 'No observed outcomes', observationRate == null ? 'muted' : observationRate >= 95 ? 'good' : observationRate >= 80 ? 'warn' : 'bad'));
      section.body.appendChild(grid);
      dashboardBody.appendChild(section.root);
    }

    function renderProviderHealth(snapshot) {
      var providers = resultValue(snapshot, 'providers');
      var route = resultValue(snapshot, 'route');
      var section = sectionBlock('Provider health & routing', 'Availability, circuit state, stability, and latency can explain execution drift');
      if (!Array.isArray(providers) || providers.length === 0) {
        appendUnavailable(section.body, 'No provider health samples are available. Configure a provider to begin health probes.');
      } else {
        var summary = metricGrid();
        var sampled = providers.filter(function (provider) { return finiteNumber(provider.lastChecked) != null && Number(provider.lastChecked) > 0; });
        var healthy = sampled.filter(function (provider) { return provider.healthy && !provider.circuitOpen; }).length;
        var circuits = providers.filter(function (provider) { return provider.circuitOpen; }).length;
        var stabilityValues = sampled.map(function (provider) { return finiteNumber(provider.stabilityScore); }).filter(function (value) { return value != null; });
        var avgStability = stabilityValues.length ? stabilityValues.reduce(function (a, b) { return a + b; }, 0) / stabilityValues.length : null;
        summary.appendChild(metricCard('Healthy providers', sampled.length ? healthy + ' / ' + sampled.length : 'N/A', providers.length + ' configured · ' + (providers.length - sampled.length) + ' awaiting samples', sampled.length ? (healthy === sampled.length ? 'good' : 'warn') : 'muted'));
        summary.appendChild(metricCard('Open circuits', String(circuits), circuits ? 'Routing is skipping failed providers' : 'No circuit breakers open', circuits ? 'bad' : 'good'));
        summary.appendChild(metricCard('Avg stability', avgStability == null ? 'N/A' : Math.round(avgStability) + '/100', stabilityValues.length ? stabilityValues.length + ' sampled providers' : 'Awaiting health samples', avgStability == null ? 'muted' : avgStability >= 80 ? 'good' : avgStability >= 50 ? 'warn' : 'bad'));
        summary.appendChild(metricCard('Routing override', route && (route.provider || route.model) ? (route.provider || 'provider') : 'Automatic', route && route.model ? route.model : 'Health-aware routing remains eligible', route ? 'info' : 'good'));
        section.body.appendChild(summary);

        var providerList = document.createElement('div');
        providerList.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:7px;margin-top:8px;';
        for (var i = 0; i < Math.min(providers.length, 8); i++) {
          var provider = providers[i];
          var hasSample = finiteNumber(provider.lastChecked) != null && Number(provider.lastChecked) > 0;
          var providerCard = document.createElement('div');
          providerCard.className = 'wk-card';
          providerCard.style.cssText = 'padding:10px 11px;min-width:0;';
          var providerTone = provider.circuitOpen ? 'bad' : !hasSample ? 'muted' : provider.healthy ? 'good' : 'warn';
          var providerTop = document.createElement('div');
          providerTop.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';
          var providerName = document.createElement('div');
          providerName.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          providerName.textContent = provider.providerName || provider.providerId || 'Provider';
          providerTop.appendChild(providerName);
          providerTop.appendChild(statePill(provider.circuitOpen ? 'Circuit open' : !hasSample ? 'Awaiting probe' : provider.healthy ? 'Healthy' : 'Degraded', providerTone));
          providerCard.appendChild(providerTop);
          var providerDetail = document.createElement('div');
          providerDetail.style.cssText = 'font-size:9px;color:var(--text-dim);line-height:1.5;margin-top:5px;overflow-wrap:anywhere;';
          providerDetail.textContent = (provider.model || 'Model not reported') + (hasSample ? ' · avg ' + formatDurationMs(provider.avgLatencyMs) + ' · p95 ' + formatDurationMs(provider.p95LatencyMs) + ' · ' + Math.round((finiteNumber(provider.uptime) || 0) * 100) + '% uptime' : '') + (provider.lastError ? ' · ' + provider.lastError : '');
          providerCard.appendChild(providerDetail);
          providerList.appendChild(providerCard);
        }
        section.body.appendChild(providerList);
      }
      dashboardBody.appendChild(section.root);
    }

    function ratioValue(passed, total) {
      var passNum = finiteNumber(passed);
      var totalNum = finiteNumber(total);
      if (passNum == null || !totalNum) return null;
      return (passNum / totalNum) * 100;
    }

    function renderQuality(snapshot) {
      var lint = resultValue(snapshot, 'lint');
      var arch = resultValue(snapshot, 'architecture');
      var gaps = resultValue(snapshot, 'testGaps');
      var review = resultValue(snapshot, 'review');
      var qa = resultValue(snapshot, 'qa');
      var alerts = resultValue(snapshot, 'alerts');
      var lintRate = lint ? ratioValue(lint.lintPassed, lint.lintRuns) : null;
      var testRate = lint ? ratioValue(lint.testPassed, lint.testRuns) : null;
      var qaRate = qa ? ratioValue(qa.passed, qa.total) : null;
      var section = sectionBlock('Quality & change-risk signals', 'Project-scoped checks correlated with scope creep and regression risk');
      var grid = metricGrid();
      grid.appendChild(metricCard('Lint pass rate', lintRate == null ? 'N/A' : Math.round(lintRate) + '%', lint && lint.lintRuns ? lint.lintPassed + ' / ' + lint.lintRuns + ' runs passed' : 'No lint runs recorded', lintRate == null ? 'muted' : lintRate === 100 ? 'good' : 'warn'));
      grid.appendChild(metricCard('Test pass rate', testRate == null ? 'N/A' : Math.round(testRate) + '%', lint && lint.testRuns ? lint.testPassed + ' / ' + lint.testRuns + ' runs passed' : 'No test runs recorded', testRate == null ? 'muted' : testRate === 100 ? 'good' : 'warn'));
      grid.appendChild(metricCard('Architecture', arch && finiteNumber(arch.overallScore) != null ? formatCompact(arch.overallScore) + '/10k' : 'N/A', arch ? formatCompact(arch.fileCount) + ' files · ' + formatCompact(arch.cycleCount) + ' cycles · grade ' + (arch.couplingGrade || 'N/A') : 'No architecture scan recorded', arch && Number(arch.cycleCount) > 0 ? 'warn' : arch ? 'info' : 'muted'));
      grid.appendChild(metricCard('Known test gaps', Array.isArray(gaps) && gaps.length ? formatCompact(gaps.length) : 'N/A', Array.isArray(gaps) && gaps.length ? 'Persisted uncovered-file findings' : 'No recorded gap scan or no persisted findings', Array.isArray(gaps) && gaps.length ? 'warn' : 'muted'));
      grid.appendChild(metricCard('Review findings', review && review.totalReviews ? formatCompact(review.totalIssues) : 'N/A', review && review.totalReviews ? review.totalReviews + ' reviews · last ' + formatTime(review.lastReview) : 'No AI reviews recorded', review && review.totalIssues > 0 ? 'warn' : review && review.totalReviews ? 'good' : 'muted'));
      grid.appendChild(metricCard('QA verification', qaRate == null ? 'N/A' : Math.round(qaRate) + '%', qa && qa.total ? qa.passed + ' passed · ' + qa.failed + ' failed · n=' + qa.total : 'No QA runs recorded', qaRate == null ? 'muted' : qaRate === 100 ? 'good' : 'warn'));
      grid.appendChild(metricCard('Predictive alerts', Array.isArray(alerts) ? String(alerts.length) : 'N/A', Array.isArray(alerts) ? (alerts.length ? 'Unacknowledged project trends' : 'No active trend alerts') : 'Prediction service unavailable', Array.isArray(alerts) && alerts.length ? 'warn' : Array.isArray(alerts) ? 'good' : 'muted'));
      grid.appendChild(metricCard('Auto-fixes', lint ? formatCompact(lint.autoFixes) : 'N/A', 'Recorded lint corrections', lint && lint.autoFixes ? 'info' : 'muted'));
      section.body.appendChild(grid);

      if (Array.isArray(alerts) && alerts.length) {
        var alertList = document.createElement('div');
        alertList.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px;';
        for (var i = 0; i < Math.min(alerts.length, 5); i++) {
          var alert = alerts[i];
          var alertRow = document.createElement('div');
          alertRow.className = 'wk-card';
          alertRow.style.cssText = 'padding:9px 11px;border-left:3px solid ' + (alert.severity === 'warning' ? 'var(--yellow,#fbbf24)' : 'var(--accent,#89b4fa)') + ';';
          alertRow.innerHTML = '<div style="font-size:11px;color:var(--text-primary);line-height:1.4;">' + escHtml(alert.message || alert.alertType || 'Predictive alert') + '</div>' +
            '<div style="font-size:9px;color:var(--text-dim);margin-top:3px;">' + escHtml(String(alert.alertType || 'trend').replace(/_/g, ' ')) + ' · ' + escHtml(formatTime(alert.createdAt)) + '</div>';
          alertList.appendChild(alertRow);
        }
        section.body.appendChild(alertList);
      }
      dashboardBody.appendChild(section.root);
    }

    function renderOperations(snapshot) {
      var gateway = resultValue(snapshot, 'gateway');
      var appStats = resultValue(snapshot, 'appStats');
      var projectCost = resultValue(snapshot, 'projectCost');
      var section = sectionBlock('Operational footprint', 'Gateway and spend evidence that can correlate with retries, latency, or routing instability');
      var grid = metricGrid();
      var requests = gateway ? finiteNumber(gateway.totalRequests) : null;
      grid.appendChild(metricCard('Gateway requests', requests == null ? 'N/A' : formatCompact(requests), requests ? formatCompact(gateway.totalTokens) + ' tokens observed' : 'No gateway requests recorded', 'info'));
      grid.appendChild(metricCard('Gateway blocks', gateway ? formatCompact(gateway.blockedCount) : 'N/A', requests ? Math.round((Number(gateway.blockedCount || 0) / requests) * 100) + '% of requests' : 'No gateway sample denominator', gateway && gateway.blockedCount ? 'warn' : requests ? 'good' : 'muted'));
      grid.appendChild(metricCard('Gateway latency', requests ? formatDurationMs(gateway.avgLatency) : 'N/A', requests ? 'Average across gateway requests' : 'No latency samples', requests ? 'info' : 'muted'));
      grid.appendChild(metricCard('Project AI cost', finiteNumber(projectCost) != null ? '$' + Number(projectCost).toFixed(3) : 'N/A', 'Cost attributed to this project', finiteNumber(projectCost) != null ? 'info' : 'muted'));
      grid.appendChild(metricCard('Total AI cost', appStats && finiteNumber(appStats.totalCost) != null ? '$' + Number(appStats.totalCost).toFixed(3) : 'N/A', appStats ? formatCompact(appStats.totalTokens) + ' total tokens tracked' : 'Application totals unavailable', 'info'));
      grid.appendChild(metricCard('Configured providers', appStats ? formatCompact(appStats.providers) : 'N/A', 'Available routing pool', appStats ? 'info' : 'muted'));
      section.body.appendChild(grid);
      dashboardBody.appendChild(section.root);
    }

    function renderSnapshot(snapshot) {
      dashboardBody.innerHTML = '';
      renderHero(snapshot);
      renderScopeAndSignals(snapshot);
      renderExecution(snapshot);
      renderProviderHealth(snapshot);
      renderQuality(snapshot);
      renderOperations(snapshot);
    }

    function loadDashboard() {
      if (self._destroyed || self.activeTab !== 'drift') return;
      var generation = ++self._driftLoadGeneration;
      var currentProjectId = self.projectId || projectId();
      refreshBtn.disabled = true;
      updatedLabel.textContent = 'Refreshing…';
      var requests = [
        ['drift', 'drift:get-state', [{ projectId: currentProjectId }]],
        ['lintConfig', 'lint-test:get-config', [currentProjectId]],
        ['metrics', 'get-cumulative-metrics', [{ projectId: currentProjectId }]],
        ['events', 'events:stats', []],
        ['providers', 'health:get-statuses', []],
        ['route', 'router:get-override', []],
        ['lint', 'lint-test:stats', [currentProjectId]],
        ['architecture', 'arch:latest', [currentProjectId]],
        ['testGaps', 'arch:get-test-gaps', [currentProjectId]],
        ['review', 'review:stats', [currentProjectId]],
        ['qa', 'qa:stats', [currentProjectId]],
        ['alerts', 'predictive:active', [currentProjectId]],
        ['gateway', 'gateway:stats', [currentProjectId]],
        ['projectCost', 'get-project-cost', [{ projectId: currentProjectId }]],
        ['appStats', 'get-dashboard-stats', []]
      ];
      Promise.all(requests.map(function (request) { return safeInvoke(request[1], request[2]); })).then(function (results) {
        if (self._destroyed || self.activeTab !== 'drift' || generation !== self._driftLoadGeneration) return;
        var snapshot = {};
        var failures = [];
        for (var i = 0; i < requests.length; i++) {
          snapshot[requests[i][0]] = results[i];
          if (!results[i].ok) failures.push(requests[i][0] + ': ' + results[i].error);
        }
        renderSnapshot(snapshot);
        updatedLabel.textContent = 'Updated ' + new Date().toLocaleTimeString() + (failures.length ? ' · ' + failures.length + ' source' + (failures.length === 1 ? '' : 's') + ' unavailable' : '');
        updatedLabel.title = failures.join('\n');
        refreshBtn.disabled = false;
      }).catch(function (err) {
        if (self._destroyed || generation !== self._driftLoadGeneration) return;
        dashboardBody.innerHTML = '';
        dashboardBody.appendChild(wk.emptyState('❌', 'Failed to load intelligence', (err && err.message) || 'Unknown error'));
        updatedLabel.textContent = 'Refresh failed';
        refreshBtn.disabled = false;
      });
    }

    refreshBtn.addEventListener('click', loadDashboard);
    var invalidate = debounce(loadDashboard, 250);
    var liveChannels = ['drift:signal', 'drift:state-update', 'provider-health-update', 'cost:budget-event'];
    for (var i = 0; i < liveChannels.length; i++) {
      api().on(liveChannels[i], invalidate);
      self._driftListeners.push({ channel: liveChannels[i], callback: invalidate });
    }
    var projectChanged = function (data) {
      if (!data || !data.id || data.id === self.projectId) return;
      self.projectId = data.id;
      self._driftLoadGeneration += 1;
      loadDashboard();
    };
    api().on('active-project', projectChanged);
    self._driftListeners.push({ channel: 'active-project', callback: projectChanged });

    loadDashboard();
    self._driftTimer = setInterval(loadDashboard, 30000);
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
    this._clearDriftLiveUpdates();
    if (this.container) this.container.innerHTML = '';
  };

  if (typeof window !== 'undefined') {
    window.DriftIntelligenceWorkspacePanel = DriftIntelligenceWorkspacePanel;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DriftIntelligenceWorkspacePanel: DriftIntelligenceWorkspacePanel };
  }

})();
