// @ts-nocheck
/**
 * MemoryPanel — Cross-Session Memory management panel (rewritten).
 *
 * Features:
 * - Search: debounced 300ms with highlight matching in results
 * - Learn form: content textarea + category dropdown + "Save" button with validation
 * - Memory cards: expandable content. Confidence color-coded bar (green/yellow/red). Source badge.
 * - Reinforce: arrow-up button → toast "Memory reinforced"
 * - Forget: X button → confirm → toast "Memory forgotten"
 * - Purge: danger button → prominent warning dialog → toast "All memories purged"
 * - Status bar: entry count, health indicator, refresh button
 *
 * Uses window.wk namespace utilities (toast, form, card, emptyState, badge, progress, toggle, confirm).
 * IPC calls use window.electronAPI.invoke(channel, args).
 * All buttons disabled during async ops. All actions show toast feedback. No alert() calls.
 *
 * IPC channels:
 * - memory:learn, memory:get, memory:search, memory:forget, memory:reinforce, agentmemory:status, agentmemory:forget
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

  var CATEGORIES = [
    { value: 'pattern', label: 'Pattern' },
    { value: 'preference', label: 'Preference' },
    { value: 'pitfall', label: 'Pitfall' },
    { value: 'convention', label: 'Convention' },
    { value: 'dependency', label: 'Dependency' },
  ];

  var DEBOUNCE_MS = 300;

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

  function confidenceColor(conf) {
    if (conf >= 0.7) return 'var(--green, #4ade80)';
    if (conf >= 0.4) return 'var(--yellow, #fbbf24)';
    return 'var(--red, #f87171)';
  }

  function confidenceVariant(conf) {
    if (conf >= 0.7) return 'success';
    if (conf >= 0.4) return 'warning';
    return 'error';
  }

  function highlightMatch(text, query) {
    if (!query || !text) return escHtml(text || '');
    var regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escHtml(text).replace(regex, '<mark style="background:var(--yellow,#fbbf24);color:#000;border-radius:2px;padding:0 2px;">$1</mark>');
  }

  function relTime(ts) {
    if (!ts) return 'unknown';
    var diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    if (diff < 0) diff = 0;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'mem-panel-styles';
  styleEl.textContent = [
    '.mem-panel{padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);}',
    '.mem-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}',
    '.mem-title{margin:0;font-size:16px;font-weight:600;color:var(--text-primary);}',
    '.mem-actions{display:flex;gap:6px;align-items:center;}',
    '.mem-status-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);margin-bottom:12px;font-size:11px;color:var(--text-secondary);}',
    '.mem-status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}',
    '.mem-search-row{display:flex;gap:6px;margin-bottom:16px;}',
    '.mem-card{background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:8px;transition:border-color var(--motion-quick);cursor:pointer;}',
    '.mem-card:hover{border-color:var(--accent);}',
    '.mem-card-top{display:flex;align-items:flex-start;gap:8px;}',
    '.mem-card-content{flex:1;min-width:0;}',
    '.mem-card-text{font-size:12px;color:var(--text-primary);line-height:1.5;word-break:break-word;}',
    '.mem-card-text.collapsed{max-height:40px;overflow:hidden;text-overflow:ellipsis;}',
    '.mem-card-meta{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap;}',
    '.mem-card-actions{display:flex;gap:4px;flex-shrink:0;align-items:flex-start;}',
    '.mem-conf-bar{height:4px;border-radius:2px;background:var(--surface-container-highest);overflow:hidden;margin-top:6px;width:100%;}',
    '.mem-conf-fill{height:100%;border-radius:2px;transition:width var(--motion-standard);}',
    '.mem-expand-hint{font-size:10px;color:var(--text-dim);margin-top:4px;}',
    '.mem-loading{text-align:center;padding:48px 24px;color:var(--text-secondary);}',
    '@keyframes memPulse{0%,100%{opacity:0.6}50%{opacity:1}}',
    '.mem-loading-icon{font-size:24px;animation:memPulse 1.2s infinite;}',
  ].join('\n');
  if (!document.getElementById('mem-panel-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── MemoryPanel class ─────────────────────────────────────────────

  function MemoryPanel(container, options) {
    this.container = container;
    this.projectId = (options && options.projectId) || 'default';
    this.memories = [];
    this.searchResults = null;
    this.searchQuery = '';
    this.status = null;
    this.isLoading = false;
    this.expandedIds = {};
    this.debounceTimer = null;
    this.contentEl = null;
    this.statusEl = null;
    this.formContainer = null;
  }

  MemoryPanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'mem-panel wk-scroll';

    // ── Header ──
    var header = document.createElement('div');
    header.className = 'mem-header';

    var title = document.createElement('h3');
    title.className = 'mem-title';
    title.textContent = 'Cross-Session Memory';
    header.appendChild(title);

    var actions = document.createElement('div');
    actions.className = 'mem-actions';

    var learnBtn = document.createElement('button');
    learnBtn.className = 'wk-btn-primary';
    learnBtn.textContent = '+ Learn';
    learnBtn.setAttribute('aria-label', 'Teach a new memory');
    learnBtn.addEventListener('click', function () { self.showLearnForm(); });
    actions.appendChild(learnBtn);

    var purgeBtn = document.createElement('button');
    purgeBtn.className = 'wk-btn-danger';
    purgeBtn.textContent = 'Purge All';
    purgeBtn.setAttribute('aria-label', 'Purge all memories');
    purgeBtn.addEventListener('click', function () { self.confirmPurge(); });
    actions.appendChild(purgeBtn);

    header.appendChild(actions);
    this.container.appendChild(header);

    // ── Status Bar ──
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'mem-status-bar';
    this.statusEl.innerHTML = '<span class="mem-status-dot" style="background:var(--text-dim);"></span> Loading...';
    this.container.appendChild(this.statusEl);

    // ── Search Bar ──
    var searchRow = document.createElement('div');
    searchRow.className = 'mem-search-row';

    var searchInput = document.createElement('input');
    searchInput.className = 'wk-input';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search memories...';
    searchInput.setAttribute('aria-label', 'Search memories');
    searchInput.style.flex = '1';
    searchInput.addEventListener('input', function () {
      self.debouncedSearch(searchInput.value);
    });
    searchRow.appendChild(searchInput);
    this.container.appendChild(searchRow);

    // ── Form container (shows learn form when active) ──
    this.formContainer = document.createElement('div');
    this.container.appendChild(this.formContainer);

    // ── Content area ──
    this.contentEl = document.createElement('div');
    this.container.appendChild(this.contentEl);

    // ── Load data ──
    this.loadStatus();
    this.loadMemories();
  };

  // ─── Debounced Search ────────────────────────────────────────────

  MemoryPanel.prototype.debouncedSearch = function (query) {
    var self = this;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    var trimmed = query.trim();

    if (!trimmed) {
      this.searchResults = null;
      this.searchQuery = '';
      this.renderList();
      return;
    }

    this.debounceTimer = setTimeout(function () {
      self.doSearch(trimmed);
    }, DEBOUNCE_MS);
  };

  MemoryPanel.prototype.doSearch = function (query) {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    self.searchQuery = query;
    self.isLoading = true;
    self.renderLoading();

    eapi.invoke('memory:search', { projectId: this.projectId, query: query }).then(function (result) {
      self.isLoading = false;
      if (result && result.success && result.results) {
        self.searchResults = result.results;
      } else {
        self.searchResults = [];
      }
      self.renderList();
    }).catch(function (err) {
      self.isLoading = false;
      self.searchResults = [];
      self.renderList();
      wk.toast('Search failed: ' + (err.message || 'Unknown error'), 'error');
    });
  };

  // ─── Status Loading ──────────────────────────────────────────────

  MemoryPanel.prototype.loadStatus = function () {
    var self = this;
    var eapi = api();
    if (!eapi) {
      this.renderStatusBar(null);
      return;
    }

    eapi.invoke('agentmemory:status', {}).then(function (status) {
      self.status = status;
      self.renderStatusBar(status);
    }).catch(function () {
      self.renderStatusBar(null);
    });
  };

  MemoryPanel.prototype.renderStatusBar = function (status) {
    if (!this.statusEl) return;
    this.statusEl.innerHTML = '';

    var dot = document.createElement('span');
    dot.className = 'mem-status-dot';

    if (status && status.healthy) {
      dot.style.background = 'var(--green, #4ade80)';
    } else {
      dot.style.background = 'var(--red, #f87171)';
    }
    this.statusEl.appendChild(dot);

    var countSpan = document.createElement('span');
    countSpan.textContent = (status ? (status.memoryCount || 0) : 0) + ' memories';
    this.statusEl.appendChild(countSpan);

    var sep = document.createElement('span');
    sep.textContent = '·';
    sep.style.color = 'var(--text-dim)';
    this.statusEl.appendChild(sep);

    var healthSpan = document.createElement('span');
    healthSpan.textContent = status && status.healthy ? 'Healthy' : 'Unavailable';
    this.statusEl.appendChild(healthSpan);

    // Spacer
    var spacer = document.createElement('span');
    spacer.style.flex = '1';
    this.statusEl.appendChild(spacer);

    // Refresh button
    var self = this;
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'wk-btn-secondary';
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.style.padding = '2px 8px';
    refreshBtn.style.fontSize = '10px';
    refreshBtn.setAttribute('aria-label', 'Refresh memories');
    refreshBtn.addEventListener('click', function () {
      disableBtn(refreshBtn);
      self.loadStatus();
      self.loadMemories();
      setTimeout(function () { enableBtn(refreshBtn); }, 1000);
    });
    this.statusEl.appendChild(refreshBtn);
  };

  // ─── Memory Loading ──────────────────────────────────────────────

  MemoryPanel.prototype.loadMemories = function () {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    self.isLoading = true;
    self.renderLoading();

    eapi.invoke('memory:get', { projectId: this.projectId, limit: 100 }).then(function (result) {
      self.isLoading = false;
      if (result && result.success && result.memories) {
        self.memories = result.memories;
      } else {
        self.memories = [];
      }
      self.renderList();
    }).catch(function () {
      self.isLoading = false;
      self.memories = [];
      self.renderList();
    });
  };

  // ─── Render States ───────────────────────────────────────────────

  MemoryPanel.prototype.renderLoading = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = '<div class="mem-loading"><div class="mem-loading-icon">🧠</div><div>Loading memories...</div></div>';
  };

  MemoryPanel.prototype.renderList = function () {
    if (!this.contentEl) return;
    var entries = this.searchResults !== null ? this.searchResults : this.memories;

    if (!entries || entries.length === 0) {
      this.contentEl.innerHTML = '';
      var msg = this.searchResults !== null
        ? 'No memories match your search.'
        : 'No memories stored yet. Teach one to get started.';
      this.contentEl.appendChild(wk.emptyState('🧠', msg, this.searchResults !== null ? 'Try a different query' : 'Click "+ Learn" to add a memory'));
      return;
    }

    var self = this;
    this.contentEl.innerHTML = '';

    // Result count header for search
    if (this.searchResults !== null) {
      var resultHdr = document.createElement('div');
      resultHdr.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:8px;';
      resultHdr.textContent = entries.length + ' result(s) for "' + this.searchQuery + '"';
      this.contentEl.appendChild(resultHdr);
    }

    for (var i = 0; i < entries.length; i++) {
      this.contentEl.appendChild(this.renderMemoryCard(entries[i]));
    }
  };

  // ─── Memory Card ─────────────────────────────────────────────────

  MemoryPanel.prototype.renderMemoryCard = function (entry) {
    var self = this;
    var entryId = entry.id || entry._id || ('mem-' + Math.random());
    var confidence = entry.confidence != null ? entry.confidence : 1.0;
    var isExpanded = !!this.expandedIds[entryId];

    var card = document.createElement('div');
    card.className = 'mem-card';
    card.setAttribute('aria-label', 'Memory entry');

    // ── Top row ──
    var topRow = document.createElement('div');
    topRow.className = 'mem-card-top';

    // Content area
    var contentDiv = document.createElement('div');
    contentDiv.className = 'mem-card-content';

    // Text (expandable)
    var textEl = document.createElement('div');
    textEl.className = 'mem-card-text' + (isExpanded ? '' : ' collapsed');
    if (this.searchQuery) {
      textEl.innerHTML = highlightMatch(entry.content || '', this.searchQuery);
    } else {
      textEl.textContent = entry.content || '';
    }
    contentDiv.appendChild(textEl);

    // Click to expand/collapse
    card.addEventListener('click', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      self.expandedIds[entryId] = !self.expandedIds[entryId];
      if (self.expandedIds[entryId]) {
        textEl.classList.remove('collapsed');
        hintEl.textContent = 'Click to collapse';
      } else {
        textEl.classList.add('collapsed');
        hintEl.textContent = 'Click to expand';
      }
    });

    // Expand hint
    var hintEl = document.createElement('div');
    hintEl.className = 'mem-expand-hint';
    hintEl.textContent = isExpanded ? 'Click to collapse' : 'Click to expand';
    contentDiv.appendChild(hintEl);

    // Meta row: source badge, category, date
    var metaRow = document.createElement('div');
    metaRow.className = 'mem-card-meta';

    // Source badge
    var sourceBadgeEl = wk.badge(entry.source || entry.agent || 'auto', 'info');
    metaRow.appendChild(sourceBadgeEl);

    // Category badge
    var catBadgeEl = wk.badge(entry.category || entry.type || 'pattern', 'warning');
    metaRow.appendChild(catBadgeEl);

    // Date
    var dateSpan = document.createElement('span');
    dateSpan.style.cssText = 'font-size:10px;color:var(--text-dim);';
    dateSpan.textContent = relTime(entry.createdAt || entry.timestamp);
    metaRow.appendChild(dateSpan);

    contentDiv.appendChild(metaRow);

    // Confidence color-coded bar
    var confBar = document.createElement('div');
    confBar.className = 'mem-conf-bar';
    var confFill = document.createElement('div');
    confFill.className = 'mem-conf-fill';
    confFill.style.width = Math.round(confidence * 100) + '%';
    confFill.style.background = confidenceColor(confidence);
    confBar.appendChild(confFill);
    contentDiv.appendChild(confBar);

    topRow.appendChild(contentDiv);

    // Actions column
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'mem-card-actions';

    // Reinforce button (arrow-up)
    var reinforceBtn = document.createElement('button');
    reinforceBtn.className = 'wk-btn-secondary';
    reinforceBtn.style.cssText = 'padding:3px 7px;font-size:11px;';
    reinforceBtn.textContent = '⬆';
    reinforceBtn.title = 'Reinforce memory';
    reinforceBtn.setAttribute('aria-label', 'Reinforce memory');
    reinforceBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self.reinforceMemory(entry, reinforceBtn);
    });
    actionsDiv.appendChild(reinforceBtn);

    // Forget button (X)
    var forgetBtn = document.createElement('button');
    forgetBtn.className = 'wk-btn-danger';
    forgetBtn.style.cssText = 'padding:3px 7px;font-size:11px;';
    forgetBtn.textContent = '✕';
    forgetBtn.title = 'Forget memory';
    forgetBtn.setAttribute('aria-label', 'Forget memory');
    forgetBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self.forgetMemory(entry, card);
    });
    actionsDiv.appendChild(forgetBtn);

    topRow.appendChild(actionsDiv);
    card.appendChild(topRow);

    return card;
  };

  // ─── Actions ─────────────────────────────────────────────────────

  MemoryPanel.prototype.reinforceMemory = function (entry, btn) {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    disableBtn(btn);
    eapi.invoke('memory:reinforce', { memoryId: entry.id }).then(function (result) {
      enableBtn(btn);
      if (result && result.success) {
        wk.toast('Memory reinforced', 'success');
        self.loadMemories();
        self.loadStatus();
      } else {
        wk.toast('Failed to reinforce memory', 'error');
      }
    }).catch(function (err) {
      enableBtn(btn);
      wk.toast('Reinforce failed: ' + (err.message || 'Unknown error'), 'error');
    });
  };

  MemoryPanel.prototype.forgetMemory = function (entry, cardEl) {
    var self = this;
    var confirmEl = wk.confirm('Forget this memory? This cannot be undone.', function () {
      var eapi = api();
      if (!eapi) return;

      eapi.invoke('memory:forget', { memoryId: entry.id }).then(function (result) {
        if (result && result.success) {
          wk.toast('Memory forgotten', 'success');
          self.loadMemories();
          self.loadStatus();
        } else {
          wk.toast('Failed to forget memory', 'error');
        }
      }).catch(function (err) {
        wk.toast('Forget failed: ' + (err.message || 'Unknown error'), 'error');
      });
    });
    cardEl.appendChild(confirmEl);
  };

  MemoryPanel.prototype.confirmPurge = function () {
    var self = this;
    // Remove any existing confirm from formContainer
    this.formContainer.innerHTML = '';

    var warningBox = document.createElement('div');
    warningBox.style.cssText = 'background:var(--red-container,rgba(248,113,113,0.1));border:2px solid var(--red,#f87171);border-radius:var(--radius-sm);padding:16px;margin-bottom:12px;';

    var warningIcon = document.createElement('div');
    warningIcon.style.cssText = 'font-size:24px;margin-bottom:8px;';
    warningIcon.textContent = '⚠️';
    warningBox.appendChild(warningIcon);

    var warningTitle = document.createElement('div');
    warningTitle.style.cssText = 'font-size:14px;font-weight:600;color:var(--red,#f87171);margin-bottom:6px;';
    warningTitle.textContent = 'Purge All Memories';
    warningBox.appendChild(warningTitle);

    var warningMsg = document.createElement('div');
    warningMsg.style.cssText = 'font-size:12px;color:var(--text-primary);margin-bottom:12px;';
    warningMsg.textContent = 'This will permanently delete ALL memories for this project. This action cannot be undone.';
    warningBox.appendChild(warningMsg);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'wk-btn-danger';
    confirmBtn.textContent = 'Yes, Purge Everything';
    confirmBtn.setAttribute('aria-label', 'Confirm purge all memories');
    confirmBtn.addEventListener('click', function () {
      self.doPurge(confirmBtn);
    });
    btnRow.appendChild(confirmBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'wk-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel purge');
    cancelBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
    });
    btnRow.appendChild(cancelBtn);

    warningBox.appendChild(btnRow);
    this.formContainer.appendChild(warningBox);
  };

  MemoryPanel.prototype.doPurge = function (btn) {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    disableBtn(btn);
    eapi.invoke('agentmemory:forget', { project: this.projectId }).then(function (result) {
      enableBtn(btn);
      self.formContainer.innerHTML = '';
      if (result && result.success) {
        wk.toast('All memories purged', 'success');
        self.memories = [];
        self.searchResults = null;
        self.renderList();
        self.loadStatus();
      } else {
        wk.toast('Purge failed', 'error');
      }
    }).catch(function (err) {
      enableBtn(btn);
      wk.toast('Purge failed: ' + (err.message || 'Unknown error'), 'error');
    });
  };

  // ─── Learn Form ──────────────────────────────────────────────────

  MemoryPanel.prototype.showLearnForm = function () {
    var self = this;
    this.formContainer.innerHTML = '';

    var catOptions = [];
    for (var i = 0; i < CATEGORIES.length; i++) {
      catOptions.push({ value: CATEGORIES[i].value, label: CATEGORIES[i].label });
    }

    wk.form(this.formContainer, [
      { name: 'content', label: 'Content', type: 'textarea', placeholder: 'What should I remember? e.g., "This project uses Zod for validation"', required: true, rows: 4 },
      { name: 'category', label: 'Category', type: 'select', options: catOptions }
    ], function (data) {
      self.saveMemory(data.content, data.category);
    }, function () {
      self.formContainer.innerHTML = '';
    });
  };

  MemoryPanel.prototype.saveMemory = function (content, category) {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    // Find the save button and disable it
    var saveBtn = self.formContainer.querySelector('.wk-btn-primary');
    if (saveBtn) disableBtn(saveBtn);

    eapi.invoke('memory:learn', {
      projectId: this.projectId,
      category: category,
      content: content,
      source: 'user',
    }).then(function (result) {
      if (saveBtn) enableBtn(saveBtn);
      if (result && result.success) {
        wk.toast('Memory saved', 'success');
        self.formContainer.innerHTML = '';
        self.loadMemories();
        self.loadStatus();
      } else {
        wk.toast('Failed to save memory', 'error');
      }
    }).catch(function (err) {
      if (saveBtn) enableBtn(saveBtn);
      wk.toast('Save failed: ' + (err.message || 'Unknown error'), 'error');
    });
  };

  // ─── Cleanup ─────────────────────────────────────────────────────

  MemoryPanel.prototype.destroy = function () {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.container) this.container.innerHTML = '';
    this.memories = [];
    this.searchResults = null;
    this.status = null;
  };

  // ─── Export ──────────────────────────────────────────────────────

  window.MemoryPanel = MemoryPanel;

})();
