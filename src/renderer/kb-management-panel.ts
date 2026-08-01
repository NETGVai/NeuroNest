// @ts-nocheck
/**
 * KBManagementPanel — Knowledge Base management panel for the sidebar.
 *
 * Displays all configured knowledge sources with status, last-synced
 * timestamp, and chunk count. Shows per-source statistics (total chunks,
 * tokens, indexing status, health indicator) and per-project storage
 * consumption breakdown.
 *
 * IPC channels:
 * - kb:sources-list    — list all sources for active project
 * - kb:status          — overall KB health/stats
 * - kb:source-reindex  — trigger re-indexing
 *
 * Renderer-bound events (listened):
 * - kb:indexing-progress       — real-time progress updates
 * - kb:source-status-changed   — source state transitions
 *
 * Uses window.wk namespace utilities (toast, badge, emptyState, progress).
 * Uses window.electronAPI.invoke(channel, args) for IPC.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 *
 * Requirements: 4.1, 4.4, 36.5
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

  var REFRESH_INTERVAL_MS = 30000; // Auto-refresh every 30s

  /**
   * Status color definitions with high-contrast colors ensuring 4.5:1 contrast
   * against dark backgrounds (#1e1e2e). Each status also has a secondary differentiator
   * (icon) so color is never the sole indicator.
   */
  var STATUS_COLORS = {
    idle: { bg: 'var(--green-container, rgba(74,222,128,0.15))', text: 'var(--green, #4ade80)', icon: '✓', contrastLabel: 'Ready' },
    indexing: { bg: 'var(--accent-container, rgba(96,165,250,0.15))', text: 'var(--accent, #93bbfc)', icon: '⟳', contrastLabel: 'Indexing' },
    error: { bg: 'var(--red-container, rgba(248,113,113,0.15))', text: 'var(--red, #f87171)', icon: '✗', contrastLabel: 'Error' },
    'auth-failed': { bg: 'var(--yellow-container, rgba(251,191,36,0.15))', text: 'var(--yellow, #fbbf24)', icon: '⚠', contrastLabel: 'Auth Failed' },
  };

  var CONNECTOR_TYPE_LABELS = {
    'local-files': { label: 'Local Files', icon: '\uD83D\uDCC1' },
    'git-repository': { label: 'Git Repo', icon: '\uD83D\uDD17' },
    'url-website': { label: 'URL', icon: '\uD83C\uDF10' },
    'pdf-document': { label: 'PDF', icon: '\uD83D\uDCC4' },
    'docx-document': { label: 'DOCX', icon: '\uD83D\uDCDD' },
    'csv-file': { label: 'CSV', icon: '\uD83D\uDCCA' },
    'json-file': { label: 'JSON', icon: '\u007B\u007D' },
    'markdown-wiki': { label: 'Markdown', icon: '\uD83D\uDCD6' },
  };

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

  function relTime(ts) {
    if (!ts) return 'Never';
    var diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    if (diff < 0) diff = 0;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatNumber(n) {
    if (n == null) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'kb-panel-styles';
  styleEl.textContent = [
    '.kb-panel{padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);}',
    '.kb-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}',
    '.kb-title{margin:0;font-size:16px;font-weight:600;color:var(--text-primary);}',
    '.kb-actions{display:flex;gap:6px;align-items:center;}',
    '.kb-status-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);margin-bottom:12px;font-size:11px;color:var(--text-secondary);flex-wrap:wrap;}',
    '.kb-status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}',
    '.kb-storage-section{background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:12px;}',
    '.kb-storage-title{font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;}',
    '.kb-storage-row{display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;}',
    '.kb-storage-label{color:var(--text-secondary);}',
    '.kb-storage-value{color:var(--text-primary);font-weight:500;}',
    '.kb-source-list{display:flex;flex-direction:column;gap:8px;}',
    '.kb-source-card{background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:12px 14px;transition:border-color var(--motion-quick);}',
    '.kb-source-card:hover{border-color:var(--accent);}',
    '.kb-source-header{display:flex;align-items:center;gap:8px;margin-bottom:6px;}',
    '.kb-source-icon{font-size:16px;flex-shrink:0;}',
    '.kb-source-name{font-size:13px;font-weight:500;color:var(--text-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.kb-source-status{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;}',
    '.kb-status-icon{font-size:11px;line-height:1;}',
    '.kb-source-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:6px;margin-top:8px;}',
    '.kb-stat-item{text-align:center;padding:4px 0;}',
    '.kb-stat-value{font-size:13px;font-weight:600;color:var(--text-primary);}',
    '.kb-stat-label{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.3px;margin-top:2px;}',
    '.kb-source-meta{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:10px;color:var(--text-dim);}',
    '.kb-source-actions{display:flex;gap:4px;margin-top:8px;}',
    '.kb-health-indicator{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:4px;}',
    '.kb-loading{text-align:center;padding:48px 24px;color:var(--text-secondary);}',
    '@keyframes kbPulse{0%,100%{opacity:0.6}50%{opacity:1}}',
    '.kb-loading-icon{font-size:24px;animation:kbPulse 1.2s infinite;}',
    '.kb-section-label{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;margin-top:16px;}',
    '.kb-source-card:focus-visible{outline:2px solid var(--accent,#89b4fa);outline-offset:2px;}',
    '.kb-source-card:focus{outline:none;}',
  ].join('\n');
  if (!document.getElementById('kb-panel-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── KBManagementPanel Class ─────────────────────────────────────

  function KBManagementPanel(container, options) {
    this.container = container;
    this.projectId = (options && options.projectId) || window._neuronestActiveProject || 'default';
    this.sources = [];
    this.status = null;
    this.isLoading = false;
    this.refreshTimer = null;
    this.contentEl = null;
    this.statusBarEl = null;
    this.storageEl = null;

    // Bind event listener references for cleanup
    this._onIndexingProgress = this.onIndexingProgress.bind(this);
    this._onSourceStatusChanged = this.onSourceStatusChanged.bind(this);
  }

  KBManagementPanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'kb-panel wk-scroll';

    // ── Header ──
    var header = document.createElement('div');
    header.className = 'kb-header';

    var title = document.createElement('h3');
    title.className = 'kb-title';
    title.textContent = 'Knowledge Base';
    title.setAttribute('aria-label', 'Knowledge Base Management Panel');
    header.appendChild(title);

    var actions = document.createElement('div');
    actions.className = 'kb-actions';

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'wk-btn-secondary';
    refreshBtn.textContent = '\u21BB Refresh';
    refreshBtn.style.padding = '4px 10px';
    refreshBtn.style.fontSize = '11px';
    refreshBtn.setAttribute('aria-label', 'Refresh knowledge base sources');
    refreshBtn.addEventListener('click', function () {
      disableBtn(refreshBtn);
      self.loadAll();
      setTimeout(function () { enableBtn(refreshBtn); }, 1500);
    });
    actions.appendChild(refreshBtn);
    header.appendChild(actions);
    this.container.appendChild(header);

    // ── Status Bar ──
    this.statusBarEl = document.createElement('div');
    this.statusBarEl.className = 'kb-status-bar';
    this.statusBarEl.setAttribute('role', 'status');
    this.statusBarEl.setAttribute('aria-live', 'polite');
    this.statusBarEl.setAttribute('aria-atomic', 'true');
    this.statusBarEl.setAttribute('aria-label', 'Knowledge base status summary');
    this.statusBarEl.innerHTML = '<span class="kb-status-dot" style="background:var(--text-dim);"></span> Loading...';
    this.container.appendChild(this.statusBarEl);

    // ── Live region for dynamic announcements ──
    this.liveRegionEl = document.createElement('div');
    this.liveRegionEl.setAttribute('role', 'log');
    this.liveRegionEl.setAttribute('aria-live', 'polite');
    this.liveRegionEl.setAttribute('aria-label', 'Knowledge base activity log');
    this.liveRegionEl.className = 'sr-only';
    this.liveRegionEl.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
    this.container.appendChild(this.liveRegionEl);

    // ── Storage Breakdown ──
    this.storageEl = document.createElement('div');
    this.storageEl.className = 'kb-storage-section';
    this.storageEl.setAttribute('aria-label', 'Per-project storage consumption breakdown');
    this.container.appendChild(this.storageEl);

    // ── Section label ──
    var sectionLabel = document.createElement('div');
    sectionLabel.className = 'kb-section-label';
    sectionLabel.textContent = 'Sources';
    this.container.appendChild(sectionLabel);

    // ── Content area (source list) ──
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'kb-source-list';
    this.contentEl.setAttribute('role', 'list');
    this.contentEl.setAttribute('aria-label', 'Knowledge sources list');
    this.container.appendChild(this.contentEl);

    // ── Load data ──
    this.loadAll();

    // ── Register IPC event listeners ──
    this.registerEventListeners();

    // ── Start auto-refresh ──
    this.refreshTimer = setInterval(function () {
      self.loadAll();
    }, REFRESH_INTERVAL_MS);
  };

  // ─── IPC Event Listeners ─────────────────────────────────────────

  KBManagementPanel.prototype.registerEventListeners = function () {
    var eapi = api();
    if (!eapi || !eapi.on) return;

    eapi.on('kb:indexing-progress', this._onIndexingProgress);
    eapi.on('kb:source-status-changed', this._onSourceStatusChanged);
  };

  KBManagementPanel.prototype.unregisterEventListeners = function () {
    var eapi = api();
    if (!eapi || !eapi.removeListener) return;

    eapi.removeListener('kb:indexing-progress', this._onIndexingProgress);
    eapi.removeListener('kb:source-status-changed', this._onSourceStatusChanged);
  };

  KBManagementPanel.prototype.onIndexingProgress = function (data) {
    // Update the source card with progress information
    if (!data || !data.sourceId) return;
    var card = this.contentEl && this.contentEl.querySelector('[data-source-id="' + data.sourceId + '"]');
    if (!card) return;

    var progressEl = card.querySelector('.kb-source-progress');
    if (progressEl && data.chunksProcessed != null) {
      var text = data.chunksProcessed + ' chunks processed';
      if (data.ratePerSecond) text += ' (' + data.ratePerSecond.toFixed(1) + '/s)';
      if (data.etaMs) text += ' \u2022 ETA: ' + Math.ceil(data.etaMs / 1000) + 's';
      progressEl.textContent = text;
    }

    // Announce significant milestones to screen readers
    if (this.liveRegionEl && data.chunksProcessed != null && data.totalChunks > 0) {
      var percent = Math.round((data.chunksProcessed / data.totalChunks) * 100);
      if (percent % 25 === 0 && percent > 0) {
        this.liveRegionEl.textContent = 'Indexing progress: ' + percent + '% complete (' + data.chunksProcessed + ' of ' + data.totalChunks + ' chunks)';
      }
    }
  };

  KBManagementPanel.prototype.onSourceStatusChanged = function (data) {
    if (!data || !data.sourceId) return;
    // Announce status change to screen readers via live region
    if (this.liveRegionEl && data.status) {
      var statusInfo = STATUS_COLORS[data.status] || {};
      var statusLabel = statusInfo.contrastLabel || data.status;
      this.liveRegionEl.textContent = 'Source status changed to: ' + statusLabel;
    }
    // Reload sources to reflect new status
    this.loadAll();
  };

  // ─── Data Loading ────────────────────────────────────────────────

  KBManagementPanel.prototype.loadAll = function () {
    this.loadStatus();
    this.loadSources();
  };

  KBManagementPanel.prototype.loadStatus = function () {
    var self = this;
    var eapi = api();
    if (!eapi) {
      this.renderStatusBar(null);
      return;
    }

    eapi.invoke('kb:status', { projectId: this.projectId }).then(function (result) {
      if (result && result.success) {
        self.status = result.data;
      } else {
        self.status = null;
      }
      self.renderStatusBar(self.status);
      self.renderStorageBreakdown(self.status);
    }).catch(function () {
      self.status = null;
      self.renderStatusBar(null);
      self.renderStorageBreakdown(null);
    });
  };

  KBManagementPanel.prototype.loadSources = function () {
    var self = this;
    var eapi = api();
    if (!eapi) {
      this.sources = [];
      this.renderSourceList();
      return;
    }

    if (!this.sources.length) {
      self.isLoading = true;
      self.renderLoading();
    }

    eapi.invoke('kb:sources-list', { projectId: this.projectId }).then(function (result) {
      self.isLoading = false;
      if (result && result.success && result.data) {
        self.sources = Array.isArray(result.data) ? result.data : [];
      } else {
        self.sources = [];
      }
      self.renderSourceList();
      self.renderStorageBreakdown(self.status);
    }).catch(function () {
      self.isLoading = false;
      self.sources = [];
      self.renderSourceList();
    });
  };

  // ─── Render Status Bar ───────────────────────────────────────────

  KBManagementPanel.prototype.renderStatusBar = function (status) {
    if (!this.statusBarEl) return;
    this.statusBarEl.innerHTML = '';

    // Health dot
    var dot = document.createElement('span');
    dot.className = 'kb-status-dot';
    dot.setAttribute('aria-hidden', 'true');
    if (status && status.errorSources === 0) {
      dot.style.background = 'var(--green, #4ade80)';
    } else if (status && status.errorSources > 0) {
      dot.style.background = 'var(--red, #f87171)';
    } else {
      dot.style.background = 'var(--text-dim)';
    }
    this.statusBarEl.appendChild(dot);

    // Source count
    var sourcesSpan = document.createElement('span');
    sourcesSpan.textContent = (status ? status.totalSources : 0) + ' sources';
    this.statusBarEl.appendChild(sourcesSpan);

    var sep1 = document.createElement('span');
    sep1.textContent = '\u00B7';
    sep1.style.color = 'var(--text-dim)';
    this.statusBarEl.appendChild(sep1);

    // Total chunks
    var chunksSpan = document.createElement('span');
    chunksSpan.textContent = formatNumber(status ? status.totalChunks : 0) + ' chunks';
    this.statusBarEl.appendChild(chunksSpan);

    // Indexing indicator
    if (status && status.indexingSources > 0) {
      var sep2 = document.createElement('span');
      sep2.textContent = '\u00B7';
      sep2.style.color = 'var(--text-dim)';
      this.statusBarEl.appendChild(sep2);

      var indexingSpan = document.createElement('span');
      indexingSpan.style.color = 'var(--accent, #60a5fa)';
      indexingSpan.textContent = status.indexingSources + ' indexing';
      this.statusBarEl.appendChild(indexingSpan);
    }

    // Errors indicator
    if (status && status.errorSources > 0) {
      var sep3 = document.createElement('span');
      sep3.textContent = '\u00B7';
      sep3.style.color = 'var(--text-dim)';
      this.statusBarEl.appendChild(sep3);

      var errorSpan = document.createElement('span');
      errorSpan.style.color = 'var(--red, #f87171)';
      errorSpan.textContent = status.errorSources + ' error(s)';
      this.statusBarEl.appendChild(errorSpan);
    }

    // Embedding model info
    if (status && status.embeddingModel) {
      var sep4 = document.createElement('span');
      sep4.textContent = '\u00B7';
      sep4.style.color = 'var(--text-dim)';
      this.statusBarEl.appendChild(sep4);

      var modelSpan = document.createElement('span');
      modelSpan.style.color = 'var(--text-dim)';
      modelSpan.textContent = status.embeddingModel + ' (' + (status.dimensions || '?') + 'd)';
      this.statusBarEl.appendChild(modelSpan);
    }
  };

  // ─── Render Storage Breakdown ────────────────────────────────────

  KBManagementPanel.prototype.renderStorageBreakdown = function (status) {
    if (!this.storageEl) return;
    this.storageEl.innerHTML = '';

    var title = document.createElement('div');
    title.className = 'kb-storage-title';
    title.textContent = 'Storage Consumption';
    title.setAttribute('aria-label', 'Per-project storage consumption breakdown');
    this.storageEl.appendChild(title);

    if (!status || !this.sources.length) {
      var emptyRow = document.createElement('div');
      emptyRow.className = 'kb-storage-row';
      emptyRow.innerHTML = '<span class="kb-storage-label">No data available</span>';
      this.storageEl.appendChild(emptyRow);
      return;
    }

    // Per-source breakdown: approximate bytes from chunk count * avg chunk size
    var totalEstimatedBytes = 0;
    var sourceBreakdown = [];

    for (var i = 0; i < this.sources.length; i++) {
      var src = this.sources[i];
      var label = src.label || src.config && src.config.label || src.uri || 'Unknown';
      // Estimate: each chunk ~2KB text + embedding overhead
      var chunkCount = src.chunkCount || src.chunk_count || 0;
      var estimatedBytes = chunkCount * 2048;
      totalEstimatedBytes += estimatedBytes;
      sourceBreakdown.push({ label: label, bytes: estimatedBytes, chunks: chunkCount });
    }

    // Total row
    var totalRow = document.createElement('div');
    totalRow.className = 'kb-storage-row';
    totalRow.style.fontWeight = '600';
    totalRow.style.borderBottom = '1px solid var(--border-color)';
    totalRow.style.paddingBottom = '6px';
    totalRow.style.marginBottom = '4px';
    totalRow.innerHTML = '<span class="kb-storage-label">Total (est.)</span><span class="kb-storage-value">' + escHtml(formatBytes(totalEstimatedBytes)) + '</span>';
    this.storageEl.appendChild(totalRow);

    // Per-source rows (top sources by storage)
    sourceBreakdown.sort(function (a, b) { return b.bytes - a.bytes; });
    var maxToShow = Math.min(sourceBreakdown.length, 5);
    for (var j = 0; j < maxToShow; j++) {
      var item = sourceBreakdown[j];
      var row = document.createElement('div');
      row.className = 'kb-storage-row';
      row.innerHTML = '<span class="kb-storage-label">' + escHtml(item.label) + '</span><span class="kb-storage-value">' + escHtml(formatBytes(item.bytes)) + ' (' + formatNumber(item.chunks) + ' chunks)</span>';
      this.storageEl.appendChild(row);
    }

    if (sourceBreakdown.length > maxToShow) {
      var moreRow = document.createElement('div');
      moreRow.className = 'kb-storage-row';
      moreRow.style.color = 'var(--text-dim)';
      moreRow.textContent = '+ ' + (sourceBreakdown.length - maxToShow) + ' more sources';
      this.storageEl.appendChild(moreRow);
    }
  };

  // ─── Render Source List ──────────────────────────────────────────

  KBManagementPanel.prototype.renderLoading = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = '<div class="kb-loading"><div class="kb-loading-icon">\uD83D\uDCDA</div><div>Loading knowledge sources...</div></div>';
  };

  KBManagementPanel.prototype.renderSourceList = function () {
    if (!this.contentEl) return;

    if (!this.sources || this.sources.length === 0) {
      this.contentEl.innerHTML = '';
      var emptyEl = wk.emptyState(
        '\uD83D\uDCDA',
        'No knowledge sources configured.',
        'Add a source to begin indexing knowledge for your agents.'
      );
      this.contentEl.appendChild(emptyEl);
      return;
    }

    var self = this;
    this.contentEl.innerHTML = '';

    for (var i = 0; i < this.sources.length; i++) {
      this.contentEl.appendChild(this.renderSourceCard(this.sources[i]));
    }
  };

  // ─── Render Source Card ──────────────────────────────────────────

  KBManagementPanel.prototype.renderSourceCard = function (source) {
    var self = this;
    var sourceId = source.id || source._id || '';
    var connectorType = source.type || (source.config && source.config.type) || 'local-files';
    var typeInfo = CONNECTOR_TYPE_LABELS[connectorType] || { label: connectorType, icon: '\uD83D\uDCC1' };
    var status = source.status || 'idle';
    var statusColors = STATUS_COLORS[status] || STATUS_COLORS['idle'];
    var label = source.label || (source.config && source.config.label) || source.uri || 'Unknown Source';
    var lastSynced = source.lastSyncedAt || source.last_synced_at;
    var chunkCount = source.chunkCount || source.chunk_count || 0;
    var tokenCount = source.tokenCount || source.token_count || 0;
    var lastError = source.lastError || source.last_error;

    var card = document.createElement('div');
    card.className = 'kb-source-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', 'Knowledge source: ' + label + ', status: ' + (statusColors.contrastLabel || status) + ', ' + chunkCount + ' chunks');
    card.setAttribute('data-source-id', sourceId);
    card.setAttribute('tabindex', '0');
    // Keyboard navigation: allow Enter to focus the first action button inside
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var firstBtn = card.querySelector('button');
        if (firstBtn) firstBtn.focus();
      }
    });

    // ── Header row: icon + name + status badge ──
    var headerRow = document.createElement('div');
    headerRow.className = 'kb-source-header';

    var iconSpan = document.createElement('span');
    iconSpan.className = 'kb-source-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.textContent = typeInfo.icon;
    headerRow.appendChild(iconSpan);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'kb-source-name';
    nameSpan.textContent = label;
    nameSpan.title = label;
    headerRow.appendChild(nameSpan);

    // Status badge with health indicator + secondary differentiator (icon)
    var statusBadge = document.createElement('span');
    statusBadge.className = 'kb-source-status';
    statusBadge.style.background = statusColors.bg;
    statusBadge.style.color = statusColors.text;
    statusBadge.setAttribute('role', 'status');
    statusBadge.setAttribute('aria-label', 'Source status: ' + (statusColors.contrastLabel || status));

    // Secondary differentiator: icon (not relying on color alone)
    var statusIcon = document.createElement('span');
    statusIcon.className = 'kb-status-icon';
    statusIcon.setAttribute('aria-hidden', 'true');
    statusIcon.textContent = statusColors.icon || '';
    statusBadge.appendChild(statusIcon);

    var healthDot = document.createElement('span');
    healthDot.className = 'kb-health-indicator';
    healthDot.setAttribute('aria-hidden', 'true');
    healthDot.style.background = statusColors.text;
    statusBadge.appendChild(healthDot);

    var statusText = document.createElement('span');
    statusText.textContent = statusColors.contrastLabel || status.charAt(0).toUpperCase() + status.slice(1);
    statusBadge.appendChild(statusText);

    headerRow.appendChild(statusBadge);
    card.appendChild(headerRow);

    // ── Statistics grid ──
    var statsGrid = document.createElement('div');
    statsGrid.className = 'kb-source-stats';
    statsGrid.setAttribute('aria-label', 'Source statistics');

    // Chunks stat
    var chunkStat = this.createStatItem(formatNumber(chunkCount), 'Chunks');
    statsGrid.appendChild(chunkStat);

    // Tokens stat
    var tokenStat = this.createStatItem(formatNumber(tokenCount), 'Tokens');
    statsGrid.appendChild(tokenStat);

    // Last synced stat
    var syncStat = this.createStatItem(relTime(lastSynced), 'Last Sync');
    statsGrid.appendChild(syncStat);

    // Type stat
    var typeStat = this.createStatItem(typeInfo.label, 'Type');
    statsGrid.appendChild(typeStat);

    card.appendChild(statsGrid);

    // ── Meta row ──
    var metaRow = document.createElement('div');
    metaRow.className = 'kb-source-meta';

    if (source.uri) {
      var uriSpan = document.createElement('span');
      uriSpan.textContent = source.uri;
      uriSpan.title = source.uri;
      uriSpan.style.overflow = 'hidden';
      uriSpan.style.textOverflow = 'ellipsis';
      uriSpan.style.whiteSpace = 'nowrap';
      uriSpan.style.maxWidth = '200px';
      metaRow.appendChild(uriSpan);
    }

    card.appendChild(metaRow);

    // ── Error display ──
    if (status === 'error' && lastError) {
      var errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'font-size:10px;color:var(--red, #f87171);margin-top:6px;padding:4px 8px;background:var(--red-container, rgba(248,113,113,0.1));border-radius:var(--radius-xs);';
      errorDiv.textContent = lastError;
      errorDiv.setAttribute('role', 'alert');
      card.appendChild(errorDiv);
    }

    // ── Progress indicator for indexing ──
    if (status === 'indexing') {
      var progressDiv = document.createElement('div');
      progressDiv.className = 'kb-source-progress';
      progressDiv.style.cssText = 'font-size:10px;color:var(--accent, #60a5fa);margin-top:6px;';
      progressDiv.textContent = 'Indexing in progress...';
      progressDiv.setAttribute('aria-live', 'polite');
      card.appendChild(progressDiv);
    }

    // ── Actions row ──
    var actionsRow = document.createElement('div');
    actionsRow.className = 'kb-source-actions';

    var reindexBtn = document.createElement('button');
    reindexBtn.className = 'wk-btn-secondary';
    reindexBtn.textContent = '\u21BB Re-index';
    reindexBtn.style.cssText = 'padding:3px 8px;font-size:10px;';
    reindexBtn.setAttribute('aria-label', 'Re-index source: ' + label);
    reindexBtn.disabled = (status === 'indexing');
    if (status === 'indexing') reindexBtn.style.opacity = '0.5';
    reindexBtn.addEventListener('click', function () {
      self.reindexSource(sourceId, reindexBtn);
    });
    actionsRow.appendChild(reindexBtn);

    card.appendChild(actionsRow);
    return card;
  };

  // ─── Stat Item Helper ────────────────────────────────────────────

  KBManagementPanel.prototype.createStatItem = function (value, label) {
    var item = document.createElement('div');
    item.className = 'kb-stat-item';

    var valEl = document.createElement('div');
    valEl.className = 'kb-stat-value';
    valEl.textContent = value;
    item.appendChild(valEl);

    var labelEl = document.createElement('div');
    labelEl.className = 'kb-stat-label';
    labelEl.textContent = label;
    item.appendChild(labelEl);

    return item;
  };

  // ─── Actions ─────────────────────────────────────────────────────

  KBManagementPanel.prototype.reindexSource = function (sourceId, btn) {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    disableBtn(btn);
    eapi.invoke('kb:source-reindex', { sourceId: sourceId }).then(function (result) {
      if (result && result.success) {
        wk.toast('Re-indexing queued', 'success');
        self.loadAll();
      } else {
        wk.toast('Failed to queue re-indexing', 'error');
        enableBtn(btn);
      }
    }).catch(function (err) {
      wk.toast('Re-index failed: ' + (err.message || 'Unknown error'), 'error');
      enableBtn(btn);
    });
  };

  // ─── Cleanup ─────────────────────────────────────────────────────

  KBManagementPanel.prototype.destroy = function () {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unregisterEventListeners();
    if (this.container) this.container.innerHTML = '';
    this.sources = [];
    this.status = null;
  };

  // ─── Export ──────────────────────────────────────────────────────

  window.KBManagementPanel = KBManagementPanel;

})();
