// @ts-nocheck
/**
 * MemoryPanel — Renderer UI for Cross-Session Memory management.
 *
 * Provides:
 * 1. Enablement toggle — enable/disable cross-session memory (global + project scope)
 * 2. Search — keyword search across memories with results display
 * 3. Source inspection — view source reference and type for each memory entry
 * 4. Staleness indicator — visual staleness/confidence decay display
 * 5. Save (learn) — explicit memory creation via input form
 * 6. Reinforce — boost confidence of a memory entry
 * 7. Forget — delete individual memory entries
 * 8. Purge — delete all memories for a project
 *
 * IPC channels used:
 * - memory:learn — create a new memory
 * - memory:get — list memories for project
 * - memory:search — search memories by query
 * - memory:forget — delete a memory
 * - memory:reinforce — boost memory confidence
 * - memory:context — get formatted context string
 * - agentmemory:status — get memory subsystem status
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as feature-management-panel.ts.
 *
 * Requirements: 19.11
 */

// ─── Constants ─────────────────────────────────────────────────────

var MEMORY_CATEGORY_OPTIONS = [
  { value: 'pattern', label: 'Pattern', icon: '\uD83D\uDD04' },
  { value: 'preference', label: 'Preference', icon: '\u2699' },
  { value: 'pitfall', label: 'Pitfall', icon: '\u26A0' },
  { value: 'convention', label: 'Convention', icon: '\uD83D\uDCCB' },
  { value: 'dependency', label: 'Dependency', icon: '\uD83D\uDCE6' },
];

var MEMORY_STALENESS_THRESHOLDS = {
  fresh: 0.8,    // confidence >= 0.8
  aging: 0.5,    // confidence >= 0.5
  stale: 0.0,    // confidence < 0.5
};

// ─── Helpers ───────────────────────────────────────────────────────

function memEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function memEapi() {
  return window.electronAPI;
}

function memCreateEl(tag, styles, attrs) {
  var el = document.createElement(tag);
  if (styles) el.style.cssText = styles;
  if (attrs) {
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) {
        el.setAttribute(key, attrs[key]);
      }
    }
  }
  return el;
}

function memFormatDate(timestamp) {
  if (!timestamp) return 'Unknown';
  var d = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (isNaN(d.getTime())) return 'Unknown';
  var now = Date.now();
  var diff = now - d.getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return d.toLocaleDateString();
}

function memGetStalenessLabel(confidence) {
  if (confidence >= MEMORY_STALENESS_THRESHOLDS.fresh) return { label: 'Fresh', color: '#a6e3a1' };
  if (confidence >= MEMORY_STALENESS_THRESHOLDS.aging) return { label: 'Aging', color: '#f9e2af' };
  return { label: 'Stale', color: '#f38ba8' };
}

function memGetCategoryIcon(category) {
  for (var i = 0; i < MEMORY_CATEGORY_OPTIONS.length; i++) {
    if (MEMORY_CATEGORY_OPTIONS[i].value === category) return MEMORY_CATEGORY_OPTIONS[i].icon;
  }
  return '\uD83D\uDCDD';
}

// ─── MemoryPanel class ─────────────────────────────────────────────

function MemoryPanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || 'default';
  this.memories = [];
  this.searchResults = null;
  this.view = 'list'; // 'list' | 'form' | 'detail'
  this.selectedMemory = null;
  this.status = null;
  this.searchQuery = '';
  this.contentEl = null;
  this.isLoading = false;
}

MemoryPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText =
    'padding:16px;height:100%;overflow-y:auto;' +
    'font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  // ── Header ──
  var header = memCreateEl('div',
    'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;');

  var title = memCreateEl('h3', 'margin:0;font-size:16px;color:var(--text-primary,#cdd6f4);');
  title.textContent = 'Cross-Session Memory';
  header.appendChild(title);

  var actions = memCreateEl('div', 'display:flex;gap:6px;flex-wrap:wrap;');

  var learnBtn = memCreateEl('button',
    'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
    'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
  learnBtn.textContent = '+ Learn';
  learnBtn.setAttribute('aria-label', 'Teach a new memory');
  learnBtn.addEventListener('click', function () { self.showForm(); });
  actions.appendChild(learnBtn);

  var purgeBtn = memCreateEl('button',
    'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #f38ba8;' +
    'background:transparent;color:#f38ba8;cursor:pointer;font-weight:600;');
  purgeBtn.textContent = 'Purge All';
  purgeBtn.setAttribute('aria-label', 'Purge all memories for this project');
  purgeBtn.addEventListener('click', function () { self.confirmPurge(); });
  actions.appendChild(purgeBtn);

  header.appendChild(actions);
  this.container.appendChild(header);

  // ── Status Bar ──
  var statusBar = memCreateEl('div',
    'display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 12px;' +
    'background:var(--surface-secondary,#313244);border-radius:6px;font-size:11px;color:var(--text-secondary,#a6adc8);');
  this.statusEl = statusBar;
  this.container.appendChild(statusBar);

  // ── Search Bar ──
  var searchWrap = memCreateEl('div',
    'display:flex;gap:6px;margin-bottom:16px;');

  var searchInput = memCreateEl('input',
    'flex:1;padding:6px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
    'background:var(--input-bg,#1e1e2e);color:var(--text-primary,#cdd6f4);font-size:12px;outline:none;',
    { type: 'text', placeholder: 'Search memories...', 'aria-label': 'Search memories' });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') self.doSearch(searchInput.value);
  });
  searchWrap.appendChild(searchInput);

  var searchBtn = memCreateEl('button',
    'padding:6px 12px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
    'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-size:12px;font-weight:600;');
  searchBtn.textContent = 'Search';
  searchBtn.addEventListener('click', function () { self.doSearch(searchInput.value); });
  searchWrap.appendChild(searchBtn);

  var clearBtn = memCreateEl('button',
    'padding:6px 12px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
    'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:12px;');
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', function () {
    searchInput.value = '';
    self.searchResults = null;
    self.searchQuery = '';
    self.renderList();
  });
  searchWrap.appendChild(clearBtn);

  this.container.appendChild(searchWrap);

  // ── Content area ──
  this.contentEl = memCreateEl('div', 'min-height:200px;');
  this.container.appendChild(this.contentEl);

  // ── Load data ──
  this.loadStatus();
  this.loadMemories();
};

// ─── Status loading ────────────────────────────────────────────────

MemoryPanel.prototype.loadStatus = function () {
  var self = this;
  var api = memEapi();
  if (!api) {
    this.statusEl.textContent = 'IPC unavailable';
    return;
  }

  api.invoke('agentmemory:status', {}).then(function (status) {
    self.status = status;
    self.renderStatus();
  }).catch(function () {
    self.statusEl.textContent = 'Status unavailable';
  });
};

MemoryPanel.prototype.renderStatus = function () {
  if (!this.statusEl || !this.status) return;
  var s = this.status;
  var dot = s.available && s.healthy ? '\u2705' : '\u274C';
  this.statusEl.innerHTML =
    dot + ' <strong>Status:</strong> ' + (s.healthy ? 'Active' : 'Inactive') +
    ' &nbsp;|&nbsp; <strong>Entries:</strong> ' + (s.memoryCount || 0) +
    ' &nbsp;|&nbsp; <strong>Version:</strong> ' + (s.version || 'unknown');
};

// ─── Memory loading ────────────────────────────────────────────────

MemoryPanel.prototype.loadMemories = function () {
  var self = this;
  var api = memEapi();
  if (!api) return;

  self.isLoading = true;
  self.renderLoading();

  api.invoke('memory:get', { projectId: this.projectId, limit: 100 }).then(function (result) {
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

// ─── Search ────────────────────────────────────────────────────────

MemoryPanel.prototype.doSearch = function (query) {
  var self = this;
  var api = memEapi();
  if (!api || !query.trim()) return;

  self.searchQuery = query;
  self.isLoading = true;
  self.renderLoading();

  api.invoke('memory:search', { projectId: this.projectId, query: query }).then(function (result) {
    self.isLoading = false;
    if (result && result.success && result.results) {
      self.searchResults = result.results;
    } else {
      self.searchResults = [];
    }
    self.renderList();
  }).catch(function () {
    self.isLoading = false;
    self.searchResults = [];
    self.renderList();
  });
};

// ─── Rendering states ──────────────────────────────────────────────

MemoryPanel.prototype.renderLoading = function () {
  if (!this.contentEl) return;
  this.contentEl.innerHTML =
    '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">' +
    '<div style="font-size:18px;margin-bottom:8px;">\u23F3</div>' +
    'Loading memories...</div>';
};

MemoryPanel.prototype.renderList = function () {
  if (!this.contentEl) return;
  var entries = this.searchResults !== null ? this.searchResults : this.memories;

  if (!entries || entries.length === 0) {
    var emptyMsg = this.searchResults !== null
      ? 'No memories match "' + memEscHtml(this.searchQuery) + '"'
      : 'No memories stored yet. Use <strong>+ Learn</strong> to teach a memory.';
    this.contentEl.innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">' +
      '<div style="font-size:24px;margin-bottom:8px;">\uD83E\uDDE0</div>' +
      emptyMsg + '</div>';
    return;
  }

  var self = this;
  this.contentEl.innerHTML = '';

  // Header
  if (this.searchResults !== null) {
    var resultHeader = memCreateEl('div',
      'font-size:11px;color:var(--text-secondary,#a6adc8);margin-bottom:8px;');
    resultHeader.textContent = entries.length + ' result(s) for "' + this.searchQuery + '"';
    this.contentEl.appendChild(resultHeader);
  }

  // Memory entries list
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    this.contentEl.appendChild(this.renderMemoryCard(entry, i));
  }
};

MemoryPanel.prototype.renderMemoryCard = function (entry, index) {
  var self = this;
  var confidence = entry.confidence != null ? entry.confidence : 1.0;
  var staleness = memGetStalenessLabel(confidence);
  var categoryIcon = memGetCategoryIcon(entry.category || entry.type || 'pattern');

  var card = memCreateEl('div',
    'display:flex;flex-direction:column;padding:10px 12px;margin-bottom:8px;' +
    'background:var(--surface-secondary,#313244);border-radius:6px;' +
    'border:1px solid var(--border-color,#45475a);transition:border-color 0.15s;');
  card.addEventListener('mouseenter', function () { card.style.borderColor = 'var(--accent-color,#89b4fa)'; });
  card.addEventListener('mouseleave', function () { card.style.borderColor = 'var(--border-color,#45475a)'; });

  // Top row: category + content
  var topRow = memCreateEl('div', 'display:flex;align-items:flex-start;gap:8px;');

  var iconSpan = memCreateEl('span', 'font-size:14px;flex-shrink:0;line-height:1.4;');
  iconSpan.textContent = categoryIcon;
  topRow.appendChild(iconSpan);

  var contentDiv = memCreateEl('div', 'flex:1;min-width:0;');

  var contentText = memCreateEl('div',
    'font-size:12px;color:var(--text-primary,#cdd6f4);line-height:1.4;word-break:break-word;');
  contentText.textContent = entry.content || '';
  contentDiv.appendChild(contentText);

  // Meta row: source, date, staleness
  var metaRow = memCreateEl('div',
    'display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;');

  var sourceBadge = memCreateEl('span',
    'font-size:10px;padding:1px 5px;border-radius:3px;' +
    'background:var(--surface-tertiary,#45475a);color:var(--text-secondary,#a6adc8);');
  sourceBadge.textContent = entry.source || entry.agent || 'auto';
  metaRow.appendChild(sourceBadge);

  var catBadge = memCreateEl('span',
    'font-size:10px;padding:1px 5px;border-radius:3px;' +
    'background:var(--surface-tertiary,#45475a);color:var(--text-secondary,#a6adc8);');
  catBadge.textContent = entry.category || entry.type || 'pattern';
  metaRow.appendChild(catBadge);

  var dateSpan = memCreateEl('span', 'font-size:10px;color:var(--text-muted,#6c7086);');
  dateSpan.textContent = memFormatDate(entry.createdAt || entry.timestamp);
  metaRow.appendChild(dateSpan);

  // Staleness badge
  var staleBadge = memCreateEl('span',
    'font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600;' +
    'background:' + staleness.color + '22;color:' + staleness.color + ';');
  staleBadge.textContent = staleness.label + ' (' + Math.round(confidence * 100) + '%)';
  metaRow.appendChild(staleBadge);

  contentDiv.appendChild(metaRow);
  topRow.appendChild(contentDiv);

  // Actions
  var actionsDiv = memCreateEl('div', 'display:flex;gap:4px;flex-shrink:0;align-items:flex-start;');

  var reinforceBtn = memCreateEl('button',
    'font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid #a6e3a1;' +
    'background:transparent;color:#a6e3a1;cursor:pointer;',
    { title: 'Reinforce — boost confidence', 'aria-label': 'Reinforce memory' });
  reinforceBtn.textContent = '\u2B06';
  reinforceBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    self.reinforceMemory(entry);
  });
  actionsDiv.appendChild(reinforceBtn);

  var forgetBtn = memCreateEl('button',
    'font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid #f38ba8;' +
    'background:transparent;color:#f38ba8;cursor:pointer;',
    { title: 'Forget — remove this memory', 'aria-label': 'Forget memory' });
  forgetBtn.textContent = '\u2716';
  forgetBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    self.forgetMemory(entry);
  });
  actionsDiv.appendChild(forgetBtn);

  topRow.appendChild(actionsDiv);
  card.appendChild(topRow);

  // Use count if available
  if (entry.useCount != null && entry.useCount > 0) {
    var useRow = memCreateEl('div',
      'font-size:10px;color:var(--text-muted,#6c7086);margin-top:4px;padding-left:22px;');
    useRow.textContent = 'Used ' + entry.useCount + ' time(s)';
    card.appendChild(useRow);
  }

  return card;
};

// ─── Actions ───────────────────────────────────────────────────────

MemoryPanel.prototype.reinforceMemory = function (entry) {
  var self = this;
  var api = memEapi();
  if (!api) return;

  api.invoke('memory:reinforce', { memoryId: entry.id }).then(function (result) {
    if (result && result.success) {
      // Reload to show updated confidence
      self.loadMemories();
      self.loadStatus();
    }
  }).catch(function () { /* silent */ });
};

MemoryPanel.prototype.forgetMemory = function (entry) {
  var self = this;
  if (!confirm('Forget this memory?\n\n"' + (entry.content || '').slice(0, 80) + '..."')) return;

  var api = memEapi();
  if (!api) return;

  api.invoke('memory:forget', { memoryId: entry.id }).then(function (result) {
    if (result && result.success) {
      self.loadMemories();
      self.loadStatus();
    }
  }).catch(function () { /* silent */ });
};

MemoryPanel.prototype.confirmPurge = function () {
  var self = this;
  if (!confirm('Purge ALL memories for this project?\n\nThis cannot be undone.')) return;

  var api = memEapi();
  if (!api) return;

  api.invoke('agentmemory:forget', { project: this.projectId }).then(function (result) {
    if (result && result.success) {
      self.memories = [];
      self.searchResults = null;
      self.renderList();
      self.loadStatus();
    }
  }).catch(function () { /* silent */ });
};

// ─── Learn Form ────────────────────────────────────────────────────

MemoryPanel.prototype.showForm = function () {
  var self = this;
  if (!this.contentEl) return;
  this.contentEl.innerHTML = '';

  var form = memCreateEl('div',
    'padding:16px;background:var(--surface-secondary,#313244);border-radius:6px;' +
    'border:1px solid var(--border-color,#45475a);');

  var formTitle = memCreateEl('h4', 'margin:0 0 12px;font-size:14px;color:var(--text-primary,#cdd6f4);');
  formTitle.textContent = 'Teach a New Memory';
  form.appendChild(formTitle);

  // Content textarea
  var contentLabel = memCreateEl('label',
    'display:block;font-size:11px;color:var(--text-secondary,#a6adc8);margin-bottom:4px;');
  contentLabel.textContent = 'What should I remember?';
  form.appendChild(contentLabel);

  var textarea = memCreateEl('textarea',
    'width:100%;min-height:80px;padding:8px;border-radius:4px;' +
    'border:1px solid var(--border-color,#45475a);background:var(--input-bg,#1e1e2e);' +
    'color:var(--text-primary,#cdd6f4);font-size:12px;resize:vertical;outline:none;box-sizing:border-box;',
    { placeholder: 'e.g., "This project uses Zod for validation" or "Tests go in tests/ not __tests__/"', 'aria-label': 'Memory content' });
  form.appendChild(textarea);

  // Category select
  var catLabel = memCreateEl('label',
    'display:block;font-size:11px;color:var(--text-secondary,#a6adc8);margin-top:10px;margin-bottom:4px;');
  catLabel.textContent = 'Category';
  form.appendChild(catLabel);

  var catSelect = memCreateEl('select',
    'width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
    'background:var(--input-bg,#1e1e2e);color:var(--text-primary,#cdd6f4);font-size:12px;',
    { 'aria-label': 'Memory category' });
  for (var i = 0; i < MEMORY_CATEGORY_OPTIONS.length; i++) {
    var opt = document.createElement('option');
    opt.value = MEMORY_CATEGORY_OPTIONS[i].value;
    opt.textContent = MEMORY_CATEGORY_OPTIONS[i].icon + ' ' + MEMORY_CATEGORY_OPTIONS[i].label;
    catSelect.appendChild(opt);
  }
  form.appendChild(catSelect);

  // Buttons
  var btnRow = memCreateEl('div', 'display:flex;gap:8px;margin-top:12px;');

  var saveBtn = memCreateEl('button',
    'padding:6px 14px;border-radius:4px;border:none;' +
    'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-size:12px;font-weight:600;');
  saveBtn.textContent = 'Save Memory';
  saveBtn.addEventListener('click', function () {
    var content = textarea.value.trim();
    if (!content) {
      textarea.style.borderColor = '#f38ba8';
      return;
    }
    self.saveMemory(content, catSelect.value);
  });
  btnRow.appendChild(saveBtn);

  var cancelBtn = memCreateEl('button',
    'padding:6px 14px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
    'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:12px;');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () {
    self.renderList();
  });
  btnRow.appendChild(cancelBtn);

  form.appendChild(btnRow);
  this.contentEl.appendChild(form);
  textarea.focus();
};

MemoryPanel.prototype.saveMemory = function (content, category) {
  var self = this;
  var api = memEapi();
  if (!api) return;

  api.invoke('memory:learn', {
    projectId: this.projectId,
    category: category,
    content: content,
    source: 'user',
  }).then(function (result) {
    if (result && result.success) {
      self.loadMemories();
      self.loadStatus();
    } else {
      alert('Failed to save memory. It may conflict with existing project steering.');
    }
  }).catch(function () {
    alert('Failed to save memory.');
  });
};

// ─── Cleanup ───────────────────────────────────────────────────────

MemoryPanel.prototype.destroy = function () {
  if (this.container) this.container.innerHTML = '';
  this.memories = [];
  this.searchResults = null;
  this.status = null;
};

// ─── Exports ───────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.MemoryPanel = MemoryPanel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MemoryPanel: MemoryPanel };
}
