// @ts-nocheck
/**
 * HooksManagementPanel — Renderer UI for Hooks v2 management.
 *
 * Provides:
 *   - Hook list with name, type, events, enabled state, and last execution status
 *   - Full schema editor for creating/editing hook definitions (v2 fields)
 *   - Execution history table with color-coded verdicts
 *   - Actions: create, edit, delete, enable/disable, run-now (test execution)
 *
 * IPC channels:
 *   - hooks:list — get all hooks
 *   - hooks:create — create a new hook
 *   - hooks:update — update an existing hook
 *   - hooks:delete — delete a hook
 *   - hooks:enable — enable a hook
 *   - hooks:disable — disable a hook
 *   - hooks:history — get execution history
 *   - hooks:run-now — test-execute a hook
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as feature-management-panel.ts.
 *
 * Requirements: 17.11
 */

// ─── Constants ─────────────────────────────────────────────────────

var HOOK_EVENTS = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'TurnStart',
  'TurnDone', 'TurnError', 'AgentStop', 'LoopPassStart', 'LoopPassDone',
];

var HOOK_TYPES = ['command', 'http'];

var HOOK_VERDICTS = ['deny', 'decline'];

var HOOK_HTTP_METHODS = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'];

var VERDICT_COLORS = {
  allow: { color: '#a6e3a1', bg: 'rgba(166,227,161,0.15)', label: 'Allow' },
  deny: { color: '#f38ba8', bg: 'rgba(243,139,168,0.15)', label: 'Deny' },
  pass: { color: '#6c7086', bg: 'rgba(108,112,134,0.15)', label: 'Pass' },
  timeout: { color: '#fab387', bg: 'rgba(250,179,135,0.15)', label: 'Timeout' },
  error: { color: '#f38ba8', bg: 'rgba(243,139,168,0.15)', label: 'Error' },
};

var MIN_TIMEOUT_MS = 100;
var MAX_TIMEOUT_MS = 10000;
var DEFAULT_TIMEOUT_MS = 2000;

// ─── Helpers ───────────────────────────────────────────────────────

function hkEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function hkEapi() {
  return window.electronAPI;
}

function hkCreateEl(tag, styles, attrs) {
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

function hkFormatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function hkFormatTimestamp(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  return d.toLocaleString();
}

// ─── HooksManagementPanel class ────────────────────────────────────

function HooksManagementPanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || null;
  this.hooks = [];
  this.history = [];
  this.activeView = 'list'; // 'list' | 'editor' | 'history'
  this.editingHook = null;  // null for new, hook object for edit
  this.contentEl = null;
  this.headerEl = null;
}

HooksManagementPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  // ── Header ──
  this.headerEl = hkCreateEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;');

  var title = hkCreateEl('h3', 'margin:0;font-size:16px;color:var(--text-primary,#cdd6f4);');
  title.textContent = 'Hooks v2 Management';
  this.headerEl.appendChild(title);

  var navBtns = hkCreateEl('div', 'display:flex;gap:6px;flex-wrap:wrap;');
  this.renderNavButtons(navBtns);
  this.headerEl.appendChild(navBtns);
  this.container.appendChild(this.headerEl);

  // ── Content area ──
  this.contentEl = hkCreateEl('div', '');
  this.container.appendChild(this.contentEl);

  this.loadHooks();
};

HooksManagementPanel.prototype.renderNavButtons = function (container) {
  var self = this;
  container.innerHTML = '';

  var views = [
    { id: 'list', label: 'Hook List' },
    { id: 'history', label: 'Execution History' },
  ];

  for (var i = 0; i < views.length; i++) {
    (function (view) {
      var isActive = self.activeView === view.id;
      var btn = hkCreateEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);cursor:pointer;background:' + (isActive ? 'var(--accent-color,#89b4fa)' : 'transparent') + ';color:' + (isActive ? '#1e1e2e' : 'var(--text-secondary,#a6adc8)') + ';font-weight:' + (isActive ? '600' : '400') + ';');
      btn.textContent = view.label;
      btn.setAttribute('aria-label', view.label);
      btn.addEventListener('click', function () {
        self.activeView = view.id;
        self.renderNavButtons(container);
        self.renderContent();
      });
      container.appendChild(btn);
    })(views[i]);
  }

  // Create new hook button
  var createBtn = hkCreateEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #a6e3a1;background:rgba(166,227,161,0.15);color:#a6e3a1;cursor:pointer;font-weight:600;');
  createBtn.textContent = '+ New Hook';
  createBtn.setAttribute('aria-label', 'Create new hook');
  createBtn.addEventListener('click', function () {
    self.editingHook = null;
    self.activeView = 'editor';
    self.renderNavButtons(container);
    self.renderContent();
  });
  container.appendChild(createBtn);
};

HooksManagementPanel.prototype.loadHooks = function () {
  var self = this;
  var api = hkEapi();
  if (!api) {
    this.renderError('electronAPI not available');
    return;
  }

  api.invoke('hooks:list', { projectId: this.projectId }).then(function (result) {
    if (result && result.success) {
      self.hooks = result.hooks || [];
    } else {
      self.hooks = [];
    }
    self.renderContent();
  }).catch(function () {
    self.hooks = [];
    self.renderContent();
  });
};

HooksManagementPanel.prototype.loadHistory = function () {
  var self = this;
  var api = hkEapi();
  if (!api) return;

  api.invoke('hooks:history', { projectId: this.projectId, limit: 100 }).then(function (result) {
    if (result && result.success) {
      self.history = result.history || [];
    } else {
      self.history = [];
    }
    self.renderHistoryView();
  }).catch(function () {
    self.history = [];
    self.renderHistoryView();
  });
};

HooksManagementPanel.prototype.renderContent = function () {
  if (this.activeView === 'list') {
    this.renderListView();
  } else if (this.activeView === 'editor') {
    this.renderEditorView();
  } else if (this.activeView === 'history') {
    this.loadHistory();
  }
};

HooksManagementPanel.prototype.renderError = function (msg) {
  this.contentEl.innerHTML = '<p style="color:#f38ba8;font-size:13px;padding:8px;">' + hkEscHtml(msg) + '</p>';
};

// ─── List View ─────────────────────────────────────────────────────

HooksManagementPanel.prototype.renderListView = function () {
  var self = this;
  this.contentEl.innerHTML = '';

  if (this.hooks.length === 0) {
    var empty = hkCreateEl('div', 'text-align:center;padding:40px;color:var(--text-muted,#6c7086);');
    empty.innerHTML = '<p style="font-size:14px;margin-bottom:8px;">No hooks configured</p><p style="font-size:12px;">Create a hook to add lifecycle automation to your project.</p>';
    this.contentEl.appendChild(empty);
    return;
  }

  for (var i = 0; i < this.hooks.length; i++) {
    this.contentEl.appendChild(this.renderHookCard(this.hooks[i]));
  }
};

HooksManagementPanel.prototype.renderHookCard = function (hook) {
  var self = this;
  var card = hkCreateEl('div', 'padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);' + (!hook.enabled ? 'opacity:0.6;' : ''));

  // Top row: name + type badge + enabled toggle
  var topRow = hkCreateEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;');

  var nameSection = hkCreateEl('div', 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;');
  var nameEl = hkCreateEl('span', 'font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
  nameEl.textContent = hook.name;
  nameSection.appendChild(nameEl);

  // Type badge
  var typeBadge = hkCreateEl('span', 'font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600;white-space:nowrap;background:rgba(137,180,250,0.15);color:#89b4fa;');
  typeBadge.textContent = hook.type || 'command';
  nameSection.appendChild(typeBadge);

  // Verdict badge (if configured)
  if (hook.verdict) {
    var verdictBadge = hkCreateEl('span', 'font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600;white-space:nowrap;background:rgba(243,139,168,0.15);color:#f38ba8;');
    verdictBadge.textContent = 'verdict: ' + hook.verdict;
    nameSection.appendChild(verdictBadge);
  }

  topRow.appendChild(nameSection);

  // Actions
  var actionsRow = hkCreateEl('div', 'display:flex;align-items:center;gap:6px;flex-shrink:0;');

  // Enable/disable toggle
  var toggleLabel = hkCreateEl('label', 'position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;');
  var toggleInput = hkCreateEl('input', 'opacity:0;width:0;height:0;', { type: 'checkbox' });
  if (hook.enabled) toggleInput.checked = true;
  toggleInput.addEventListener('change', function () {
    self.handleToggleHook(hook, toggleInput.checked);
  });
  toggleLabel.appendChild(toggleInput);
  var slider = hkCreateEl('span', 'position:absolute;inset:0;border-radius:10px;transition:background 0.2s;background:' + (hook.enabled ? '#a6e3a1' : 'var(--bg-tertiary,#313244)') + ';');
  var knob = hkCreateEl('span', 'position:absolute;top:2px;left:' + (hook.enabled ? '18px' : '2px') + ';width:16px;height:16px;border-radius:50%;background:var(--text-primary,#cdd6f4);transition:left 0.2s;');
  slider.appendChild(knob);
  toggleLabel.appendChild(slider);
  actionsRow.appendChild(toggleLabel);

  topRow.appendChild(actionsRow);
  card.appendChild(topRow);

  // Events row
  var eventsRow = hkCreateEl('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;');
  var events = hook.events || [];
  for (var i = 0; i < events.length; i++) {
    var evBadge = hkCreateEl('span', 'font-size:10px;padding:1px 6px;border-radius:3px;background:var(--bg-tertiary,#313244);color:var(--text-muted,#6c7086);');
    evBadge.textContent = events[i];
    eventsRow.appendChild(evBadge);
  }
  card.appendChild(eventsRow);

  // Info row: matcher, timeout, command/url
  var infoRow = hkCreateEl('div', 'font-size:11px;color:var(--text-secondary,#a6adc8);margin-bottom:6px;');
  var infoParts = [];
  if (hook.matcher) infoParts.push('Matcher: /' + hook.matcher + '/');
  infoParts.push('Timeout: ' + (hook.timeout || DEFAULT_TIMEOUT_MS) + 'ms');
  if (hook.type === 'command' && hook.command) infoParts.push('Cmd: ' + hook.command);
  if (hook.type === 'http' && hook.url) infoParts.push((hook.method || 'POST') + ' ' + hook.url);
  infoRow.textContent = infoParts.join(' · ');
  card.appendChild(infoRow);

  // Action buttons
  var btnRow = hkCreateEl('div', 'display:flex;gap:6px;margin-top:8px;');

  var editBtn = hkCreateEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', function () { self.handleEditHook(hook); });
  btnRow.appendChild(editBtn);

  var runBtn = hkCreateEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #89b4fa;background:rgba(137,180,250,0.1);color:#89b4fa;cursor:pointer;');
  runBtn.textContent = 'Run Now';
  runBtn.addEventListener('click', function () { self.handleRunNow(hook); });
  btnRow.appendChild(runBtn);

  var deleteBtn = hkCreateEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #f38ba8;background:rgba(243,139,168,0.1);color:#f38ba8;cursor:pointer;');
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', function () { self.handleDeleteHook(hook); });
  btnRow.appendChild(deleteBtn);

  card.appendChild(btnRow);
  return card;
};

// ─── Editor View ───────────────────────────────────────────────────

HooksManagementPanel.prototype.renderEditorView = function () {
  var self = this;
  var hook = this.editingHook || {};
  var isEdit = !!this.editingHook;
  this.contentEl.innerHTML = '';

  var form = hkCreateEl('div', 'max-width:600px;');

  // Title
  var formTitle = hkCreateEl('h4', 'margin:0 0 16px;font-size:14px;color:var(--text-primary,#cdd6f4);');
  formTitle.textContent = isEdit ? 'Edit Hook: ' + hook.name : 'Create New Hook';
  form.appendChild(formTitle);

  // Validation feedback area
  var validationEl = hkCreateEl('div', 'margin-bottom:12px;display:none;');
  validationEl.id = 'hk-validation-feedback';
  form.appendChild(validationEl);

  // Name field
  form.appendChild(this.createFormField('Name', 'hk-name', 'text', hook.name || '', 'Hook name (required)'));

  // Type field (select)
  form.appendChild(this.createSelectField('Type', 'hk-type', HOOK_TYPES, hook.type || 'command'));

  // Events (multi-select checkboxes)
  form.appendChild(this.createMultiSelect('Events', 'hk-events', HOOK_EVENTS, hook.events || []));

  // Matcher (regex)
  form.appendChild(this.createFormField('Matcher (regex)', 'hk-matcher', 'text', hook.matcher || '', 'Optional regex pattern'));

  // Timeout (number/slider)
  form.appendChild(this.createTimeoutField(hook.timeout || DEFAULT_TIMEOUT_MS));

  // Verdict (select, optional)
  var verdictOptions = ['(none)'].concat(HOOK_VERDICTS);
  form.appendChild(this.createSelectField('Verdict (blocking events)', 'hk-verdict', verdictOptions, hook.verdict || '(none)'));

  // Command field (for type=command)
  form.appendChild(this.createFormField('Command', 'hk-command', 'text', hook.command || '', 'Shell command to execute'));

  // URL field (for type=http)
  form.appendChild(this.createFormField('URL', 'hk-url', 'text', hook.url || '', 'HTTP endpoint URL'));

  // HTTP Method (for type=http)
  form.appendChild(this.createSelectField('HTTP Method', 'hk-method', HOOK_HTTP_METHODS, hook.method || 'POST'));

  // Enabled toggle
  form.appendChild(this.createCheckboxField('Enabled', 'hk-enabled', hook.enabled !== false));

  // Form buttons
  var btnRow = hkCreateEl('div', 'display:flex;gap:8px;margin-top:16px;');

  var saveBtn = hkCreateEl('button', 'font-size:12px;padding:6px 16px;border-radius:4px;border:none;background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
  saveBtn.textContent = isEdit ? 'Update Hook' : 'Create Hook';
  saveBtn.addEventListener('click', function () { self.handleSaveHook(); });
  btnRow.appendChild(saveBtn);

  var cancelBtn = hkCreateEl('button', 'font-size:12px;padding:6px 16px;border-radius:4px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () {
    self.activeView = 'list';
    self.editingHook = null;
    var navBtns = self.headerEl.querySelector('div:last-child');
    if (navBtns) self.renderNavButtons(navBtns);
    self.renderContent();
  });
  btnRow.appendChild(cancelBtn);

  form.appendChild(btnRow);
  this.contentEl.appendChild(form);

  // Show/hide fields based on type
  this.updateTypeFields();
  var typeSelect = document.getElementById('hk-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', function () { self.updateTypeFields(); });
  }
};

HooksManagementPanel.prototype.updateTypeFields = function () {
  var typeSelect = document.getElementById('hk-type');
  if (!typeSelect) return;
  var type = typeSelect.value;
  var commandGroup = document.getElementById('hk-command-group');
  var urlGroup = document.getElementById('hk-url-group');
  var methodGroup = document.getElementById('hk-method-group');

  if (commandGroup) commandGroup.style.display = type === 'command' ? 'block' : 'none';
  if (urlGroup) urlGroup.style.display = type === 'http' ? 'block' : 'none';
  if (methodGroup) methodGroup.style.display = type === 'http' ? 'block' : 'none';
};

HooksManagementPanel.prototype.createFormField = function (label, id, type, value, placeholder) {
  var groupId = id + '-group';
  var group = hkCreateEl('div', 'margin-bottom:12px;');
  group.id = groupId;
  var lbl = hkCreateEl('label', 'display:block;font-size:12px;color:var(--text-secondary,#a6adc8);margin-bottom:4px;', { for: id });
  lbl.textContent = label;
  group.appendChild(lbl);
  var input = hkCreateEl('input', 'width:100%;padding:6px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);font-size:12px;box-sizing:border-box;', { type: type, id: id, placeholder: placeholder || '' });
  input.value = value;
  group.appendChild(input);
  return group;
};

HooksManagementPanel.prototype.createSelectField = function (label, id, options, selected) {
  var groupId = id + '-group';
  var group = hkCreateEl('div', 'margin-bottom:12px;');
  group.id = groupId;
  var lbl = hkCreateEl('label', 'display:block;font-size:12px;color:var(--text-secondary,#a6adc8);margin-bottom:4px;', { for: id });
  lbl.textContent = label;
  group.appendChild(lbl);
  var select = hkCreateEl('select', 'width:100%;padding:6px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);font-size:12px;', { id: id });
  for (var i = 0; i < options.length; i++) {
    var opt = document.createElement('option');
    opt.value = options[i];
    opt.textContent = options[i];
    if (options[i] === selected) opt.selected = true;
    select.appendChild(opt);
  }
  group.appendChild(select);
  return group;
};

HooksManagementPanel.prototype.createMultiSelect = function (label, id, options, selected) {
  var group = hkCreateEl('div', 'margin-bottom:12px;');
  var lbl = hkCreateEl('label', 'display:block;font-size:12px;color:var(--text-secondary,#a6adc8);margin-bottom:4px;');
  lbl.textContent = label;
  group.appendChild(lbl);
  var container = hkCreateEl('div', 'display:flex;flex-wrap:wrap;gap:6px;padding:8px;border-radius:4px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);');
  for (var i = 0; i < options.length; i++) {
    (function (opt) {
      var isChecked = selected.indexOf(opt) !== -1;
      var checkLabel = hkCreateEl('label', 'display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-primary,#cdd6f4);cursor:pointer;padding:2px 6px;border-radius:3px;background:' + (isChecked ? 'rgba(137,180,250,0.2)' : 'transparent') + ';border:1px solid ' + (isChecked ? '#89b4fa' : 'transparent') + ';');
      var checkbox = hkCreateEl('input', 'cursor:pointer;', { type: 'checkbox', 'data-event': opt });
      checkbox.className = id + '-checkbox';
      if (isChecked) checkbox.checked = true;
      checkbox.addEventListener('change', function () {
        checkLabel.style.background = checkbox.checked ? 'rgba(137,180,250,0.2)' : 'transparent';
        checkLabel.style.borderColor = checkbox.checked ? '#89b4fa' : 'transparent';
      });
      checkLabel.appendChild(checkbox);
      var span = document.createElement('span');
      span.textContent = opt;
      checkLabel.appendChild(span);
      container.appendChild(checkLabel);
    })(options[i]);
  }
  group.appendChild(container);
  return group;
};

HooksManagementPanel.prototype.createTimeoutField = function (value) {
  var group = hkCreateEl('div', 'margin-bottom:12px;');
  var lbl = hkCreateEl('label', 'display:block;font-size:12px;color:var(--text-secondary,#a6adc8);margin-bottom:4px;', { for: 'hk-timeout' });
  lbl.textContent = 'Timeout (ms): ' + value;
  lbl.id = 'hk-timeout-label';
  group.appendChild(lbl);

  var row = hkCreateEl('div', 'display:flex;align-items:center;gap:8px;');

  var range = hkCreateEl('input', 'flex:1;', { type: 'range', id: 'hk-timeout', min: String(MIN_TIMEOUT_MS), max: String(MAX_TIMEOUT_MS), step: '100' });
  range.value = String(value);
  range.addEventListener('input', function () {
    lbl.textContent = 'Timeout (ms): ' + range.value;
    numInput.value = range.value;
  });
  row.appendChild(range);

  var numInput = hkCreateEl('input', 'width:70px;padding:4px 6px;border-radius:4px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);font-size:11px;text-align:center;', { type: 'number', min: String(MIN_TIMEOUT_MS), max: String(MAX_TIMEOUT_MS), step: '100' });
  numInput.value = String(value);
  numInput.addEventListener('input', function () {
    var v = parseInt(numInput.value, 10);
    if (!isNaN(v) && v >= MIN_TIMEOUT_MS && v <= MAX_TIMEOUT_MS) {
      range.value = String(v);
      lbl.textContent = 'Timeout (ms): ' + v;
    }
  });
  row.appendChild(numInput);

  group.appendChild(row);
  return group;
};

HooksManagementPanel.prototype.createCheckboxField = function (label, id, checked) {
  var group = hkCreateEl('div', 'margin-bottom:12px;display:flex;align-items:center;gap:8px;');
  var checkbox = hkCreateEl('input', 'cursor:pointer;', { type: 'checkbox', id: id });
  if (checked) checkbox.checked = true;
  group.appendChild(checkbox);
  var lbl = hkCreateEl('label', 'font-size:12px;color:var(--text-secondary,#a6adc8);cursor:pointer;', { for: id });
  lbl.textContent = label;
  group.appendChild(lbl);
  return group;
};

// ─── Save Hook (Create/Update) ─────────────────────────────────────

HooksManagementPanel.prototype.handleSaveHook = function () {
  var self = this;
  var api = hkEapi();
  if (!api) return;

  // Gather form values
  var nameEl = document.getElementById('hk-name');
  var typeEl = document.getElementById('hk-type');
  var matcherEl = document.getElementById('hk-matcher');
  var timeoutEl = document.getElementById('hk-timeout');
  var verdictEl = document.getElementById('hk-verdict');
  var commandEl = document.getElementById('hk-command');
  var urlEl = document.getElementById('hk-url');
  var methodEl = document.getElementById('hk-method');
  var enabledEl = document.getElementById('hk-enabled');

  // Collect selected events
  var eventCheckboxes = document.querySelectorAll('.hk-events-checkbox');
  var selectedEvents = [];
  for (var i = 0; i < eventCheckboxes.length; i++) {
    if (eventCheckboxes[i].checked) {
      selectedEvents.push(eventCheckboxes[i].getAttribute('data-event'));
    }
  }

  var hookData = {
    name: nameEl ? nameEl.value.trim() : '',
    type: typeEl ? typeEl.value : 'command',
    events: selectedEvents,
    matcher: matcherEl && matcherEl.value.trim() ? matcherEl.value.trim() : undefined,
    timeout: timeoutEl ? parseInt(timeoutEl.value, 10) : DEFAULT_TIMEOUT_MS,
    enabled: enabledEl ? enabledEl.checked : true,
    verdict: (verdictEl && verdictEl.value !== '(none)') ? verdictEl.value : undefined,
    command: commandEl ? commandEl.value.trim() : undefined,
    url: urlEl ? urlEl.value.trim() : undefined,
    method: methodEl ? methodEl.value : undefined,
    projectId: self.projectId,
  };

  // Client-side validation matching hook-engine-v2.ts
  var errors = this.validateHookData(hookData);
  if (errors.length > 0) {
    this.showValidationErrors(errors);
    return;
  }

  var isEdit = !!this.editingHook;
  var channel = isEdit ? 'hooks:update' : 'hooks:create';
  var payload = isEdit ? { hookId: this.editingHook.id || this.editingHook.name, updates: hookData } : hookData;

  api.invoke(channel, payload).then(function (result) {
    if (result && result.success) {
      self.showToast(isEdit ? 'Hook updated' : 'Hook created', 'success');
      self.editingHook = null;
      self.activeView = 'list';
      var navBtns = self.headerEl.querySelector('div:last-child');
      if (navBtns) self.renderNavButtons(navBtns);
      self.loadHooks();
    } else {
      self.showToast('Failed: ' + (result && result.error ? result.error : 'Unknown error'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

// ─── Validation (mirrors hook-engine-v2.ts) ────────────────────────

HooksManagementPanel.prototype.validateHookData = function (hook) {
  var errors = [];

  // name: required, non-empty
  if (!hook.name || hook.name.length === 0) {
    errors.push({ field: 'name', message: 'Name is required' });
  }

  // type: must be command or http
  if (HOOK_TYPES.indexOf(hook.type) === -1) {
    errors.push({ field: 'type', message: 'Type must be command or http' });
  }

  // events: required, non-empty
  if (!hook.events || hook.events.length === 0) {
    errors.push({ field: 'events', message: 'At least one event is required' });
  } else {
    for (var i = 0; i < hook.events.length; i++) {
      if (HOOK_EVENTS.indexOf(hook.events[i]) === -1) {
        errors.push({ field: 'events', message: 'Invalid event: ' + hook.events[i] });
      }
    }
  }

  // matcher: if present, must be valid regex
  if (hook.matcher) {
    try {
      new RegExp(hook.matcher);
    } catch (e) {
      errors.push({ field: 'matcher', message: 'Invalid regex pattern' });
    }
  }

  // timeout: must be within bounds
  if (hook.timeout < MIN_TIMEOUT_MS || hook.timeout > MAX_TIMEOUT_MS) {
    errors.push({ field: 'timeout', message: 'Timeout must be between ' + MIN_TIMEOUT_MS + 'ms and ' + MAX_TIMEOUT_MS + 'ms' });
  }

  // verdict: if present, must be deny or decline
  if (hook.verdict && HOOK_VERDICTS.indexOf(hook.verdict) === -1) {
    errors.push({ field: 'verdict', message: 'Verdict must be deny or decline' });
  }

  // type-specific
  if (hook.type === 'command') {
    if (!hook.command || hook.command.length === 0) {
      errors.push({ field: 'command', message: 'Command is required for type "command"' });
    }
  } else if (hook.type === 'http') {
    if (!hook.url || hook.url.length === 0) {
      errors.push({ field: 'url', message: 'URL is required for type "http"' });
    } else {
      try {
        new URL(hook.url);
      } catch (e) {
        errors.push({ field: 'url', message: 'URL must be a valid URL' });
      }
    }
  }

  return errors;
};

HooksManagementPanel.prototype.showValidationErrors = function (errors) {
  var el = document.getElementById('hk-validation-feedback');
  if (!el) return;
  el.style.display = 'block';
  el.style.cssText = 'margin-bottom:12px;padding:8px 12px;border-radius:4px;border:1px solid #f38ba8;background:rgba(243,139,168,0.1);';
  var html = '';
  for (var i = 0; i < errors.length; i++) {
    html += '<div style="font-size:12px;color:#f38ba8;margin-bottom:2px;">' + hkEscHtml(errors[i].field) + ': ' + hkEscHtml(errors[i].message) + '</div>';
  }
  el.innerHTML = html;
};

// ─── History View ──────────────────────────────────────────────────

HooksManagementPanel.prototype.renderHistoryView = function () {
  var self = this;
  this.contentEl.innerHTML = '';

  if (this.history.length === 0) {
    var empty = hkCreateEl('div', 'text-align:center;padding:40px;color:var(--text-muted,#6c7086);');
    empty.innerHTML = '<p style="font-size:14px;margin-bottom:8px;">No execution history</p><p style="font-size:12px;">Hook executions will appear here as they run.</p>';
    this.contentEl.appendChild(empty);
    return;
  }

  // Table header
  var table = hkCreateEl('div', 'width:100%;');
  var thead = hkCreateEl('div', 'display:grid;grid-template-columns:1fr 1fr 90px 70px 140px;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-color,#313244);font-size:11px;font-weight:600;color:var(--text-muted,#6c7086);');
  var cols = ['Hook', 'Event', 'Verdict', 'Duration', 'Timestamp'];
  for (var c = 0; c < cols.length; c++) {
    var th = hkCreateEl('span', '');
    th.textContent = cols[c];
    thead.appendChild(th);
  }
  table.appendChild(thead);

  // Table rows
  for (var i = 0; i < this.history.length; i++) {
    table.appendChild(this.renderHistoryRow(this.history[i]));
  }

  this.contentEl.appendChild(table);
};

HooksManagementPanel.prototype.renderHistoryRow = function (entry) {
  var row = hkCreateEl('div', 'display:grid;grid-template-columns:1fr 1fr 90px 70px 140px;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-color,#313244);font-size:12px;align-items:center;');

  // Hook name
  var nameCell = hkCreateEl('span', 'color:var(--text-primary,#cdd6f4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
  nameCell.textContent = entry.hookName || entry.hook_name || '—';
  row.appendChild(nameCell);

  // Event
  var eventCell = hkCreateEl('span', 'color:var(--text-secondary,#a6adc8);');
  eventCell.textContent = entry.event || '—';
  row.appendChild(eventCell);

  // Verdict (color-coded)
  var verdict = (entry.verdict || 'pass').toLowerCase();
  var vc = VERDICT_COLORS[verdict] || VERDICT_COLORS.pass;
  var verdictCell = hkCreateEl('span', 'font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600;text-align:center;background:' + vc.bg + ';color:' + vc.color + ';');
  verdictCell.textContent = vc.label;
  row.appendChild(verdictCell);

  // Duration
  var durationCell = hkCreateEl('span', 'color:var(--text-muted,#6c7086);font-size:11px;');
  durationCell.textContent = hkFormatDuration(entry.durationMs || entry.duration_ms);
  row.appendChild(durationCell);

  // Timestamp
  var tsCell = hkCreateEl('span', 'color:var(--text-muted,#6c7086);font-size:10px;');
  tsCell.textContent = hkFormatTimestamp(entry.timestamp || entry.created_at);
  row.appendChild(tsCell);

  return row;
};

// ─── Action Handlers ───────────────────────────────────────────────

HooksManagementPanel.prototype.handleToggleHook = function (hook, enabled) {
  var self = this;
  var api = hkEapi();
  if (!api) return;

  var channel = enabled ? 'hooks:enable' : 'hooks:disable';
  api.invoke(channel, { hookId: hook.id || hook.name, projectId: self.projectId }).then(function (result) {
    if (result && result.success) {
      self.loadHooks();
    } else {
      self.showToast('Failed to toggle hook: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

HooksManagementPanel.prototype.handleEditHook = function (hook) {
  this.editingHook = hook;
  this.activeView = 'editor';
  var navBtns = this.headerEl.querySelector('div:last-child');
  if (navBtns) this.renderNavButtons(navBtns);
  this.renderContent();
};

HooksManagementPanel.prototype.handleDeleteHook = function (hook) {
  var self = this;
  if (!confirm('Delete hook "' + hook.name + '"? This cannot be undone.')) return;

  var api = hkEapi();
  if (!api) return;

  api.invoke('hooks:delete', { hookId: hook.id || hook.name, projectId: self.projectId }).then(function (result) {
    if (result && result.success) {
      self.showToast('Hook deleted', 'success');
      self.loadHooks();
    } else {
      self.showToast('Delete failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

HooksManagementPanel.prototype.handleRunNow = function (hook) {
  var self = this;
  var api = hkEapi();
  if (!api) return;

  api.invoke('hooks:run-now', { hookId: hook.id || hook.name, projectId: self.projectId }).then(function (result) {
    if (result && result.success) {
      var verdict = result.verdict || 'pass';
      var duration = result.durationMs ? ' (' + result.durationMs + 'ms)' : '';
      self.showToast('Hook executed: ' + verdict + duration, verdict === 'deny' ? 'error' : 'success');
    } else {
      self.showToast('Run failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

// ─── Toast Notification ────────────────────────────────────────────

HooksManagementPanel.prototype.showToast = function (message, type) {
  var colors = {
    success: { bg: 'rgba(166,227,161,0.15)', color: '#a6e3a1', border: '#a6e3a1' },
    error: { bg: 'rgba(243,139,168,0.15)', color: '#f38ba8', border: '#f38ba8' },
    info: { bg: 'rgba(137,180,250,0.15)', color: '#89b4fa', border: '#89b4fa' },
  };
  var c = colors[type] || colors.info;

  var toast = hkCreateEl('div', 'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid ' + c.border + ';background:' + c.bg + ';color:' + c.color + ';box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;');
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  document.body.appendChild(toast);

  setTimeout(function () {
    toast.style.opacity = '0';
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 3000);
};

// ─── Destroy ───────────────────────────────────────────────────────

HooksManagementPanel.prototype.destroy = function () {
  this.container.innerHTML = '';
  this.hooks = [];
  this.history = [];
};

// ─── Exports ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HooksManagementPanel: HooksManagementPanel };
}
