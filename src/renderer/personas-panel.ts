// @ts-nocheck
/**
 * PersonasPanel — Renderer UI for Persona management.
 *
 * Provides:
 * 1. Persona selector in chat header — dropdown for quick-switching active persona
 * 2. CRUD panel in settings — list/create/edit/delete personas with form editor
 * 3. System prompt preview — shows what the system prompt looks like with persona applied
 *
 * IPC channels:
 * - personas:list — list all personas
 * - personas:create — create a new persona
 * - personas:update — update an existing persona
 * - personas:delete — delete a persona
 * - personas:preview — preview system prompt with persona applied
 * - personas:activate — activate a persona for the current session
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as feature-management-panel.ts.
 *
 * Requirements: 18.4, 18.5
 */

// ─── Constants ─────────────────────────────────────────────────────

var PERSONA_VERBOSITY_OPTIONS = [
  { value: 'terse', label: 'Terse' },
  { value: 'normal', label: 'Normal' },
  { value: 'verbose', label: 'Verbose' },
];

var PERSONA_FORMAT_OPTIONS = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'json', label: 'JSON' },
  { value: 'diff-only', label: 'Diff Only' },
];

// ─── Helpers ───────────────────────────────────────────────────────

function ppEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function ppEapi() {
  return window.electronAPI;
}

function ppCreateEl(tag, styles, attrs) {
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

// ─── PersonasPanel class ───────────────────────────────────────────

function PersonasPanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || null;
  this.personas = [];
  this.activePersonaId = (options && options.activePersonaId) || null;
  this.view = 'list'; // 'list' | 'form' | 'preview'
  this.editingPersona = null; // persona being edited or null for new
  this.contentEl = null;
  this.previewEl = null;
}

PersonasPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText =
    'padding:16px;height:100%;overflow-y:auto;' +
    'font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  // ── Header ──
  var header = ppCreateEl('div',
    'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;');

  var title = ppCreateEl('h3', 'margin:0;font-size:16px;color:var(--text-primary,#cdd6f4);');
  title.textContent = 'Personas';
  header.appendChild(title);

  var actions = ppCreateEl('div', 'display:flex;gap:6px;flex-wrap:wrap;');

  var createBtn = ppCreateEl('button',
    'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
    'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
  createBtn.textContent = '+ New Persona';
  createBtn.setAttribute('aria-label', 'Create new persona');
  createBtn.addEventListener('click', function () { self.showForm(null); });
  actions.appendChild(createBtn);

  header.appendChild(actions);
  this.container.appendChild(header);

  // ── Content area ──
  this.contentEl = ppCreateEl('div', '');
  this.container.appendChild(this.contentEl);

  // Load data
  this.loadPersonas();
};

PersonasPanel.prototype.loadPersonas = function () {
  var self = this;
  var api = ppEapi();
  if (!api) {
    this.renderError('electronAPI not available');
    return;
  }

  this.contentEl.innerHTML =
    '<p style="color:var(--text-muted,#6c7086);font-size:13px;">Loading personas...</p>';

  api.invoke('personas:list', { projectId: this.projectId }).then(function (result) {
    if (!result || !result.success) {
      self.renderError(result && result.error ? result.error : 'Failed to load personas');
      return;
    }
    self.personas = result.personas || [];
    self.renderList();
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Unknown error');
  });
};

PersonasPanel.prototype.renderError = function (msg) {
  this.contentEl.innerHTML =
    '<p style="color:#f38ba8;font-size:13px;padding:8px;">' + ppEscHtml(msg) + '</p>';
};

PersonasPanel.prototype.renderList = function () {
  var self = this;
  this.view = 'list';
  this.contentEl.innerHTML = '';

  if (this.personas.length === 0) {
    this.contentEl.innerHTML =
      '<p style="color:var(--text-muted,#6c7086);font-size:13px;padding:16px;text-align:center;">' +
      'No personas defined. Create one to get started.</p>';
    return;
  }

  // Separate built-in and custom personas
  var builtins = [];
  var customs = [];
  for (var i = 0; i < this.personas.length; i++) {
    if (this.personas[i].builtIn) {
      builtins.push(this.personas[i]);
    } else {
      customs.push(this.personas[i]);
    }
  }

  // Custom personas section
  if (customs.length > 0) {
    var customHeading = ppCreateEl('div',
      'font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);margin-bottom:8px;' +
      'text-transform:uppercase;letter-spacing:0.5px;');
    customHeading.textContent = 'Custom Personas';
    this.contentEl.appendChild(customHeading);

    for (var c = 0; c < customs.length; c++) {
      this.contentEl.appendChild(this.renderPersonaCard(customs[c]));
    }
  }

  // Built-in personas section
  if (builtins.length > 0) {
    var builtinHeading = ppCreateEl('div',
      'font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);margin-bottom:8px;' +
      'margin-top:16px;text-transform:uppercase;letter-spacing:0.5px;');
    builtinHeading.textContent = 'Built-in Personas (read-only)';
    this.contentEl.appendChild(builtinHeading);

    for (var b = 0; b < builtins.length; b++) {
      this.contentEl.appendChild(this.renderPersonaCard(builtins[b]));
    }
  }
};

PersonasPanel.prototype.renderPersonaCard = function (persona) {
  var self = this;
  var isActive = this.activePersonaId === persona.id;
  var isBuiltIn = persona.builtIn;

  var card = ppCreateEl('div',
    'padding:12px;margin-bottom:8px;border-radius:8px;' +
    'border:1px solid ' + (isActive ? 'var(--accent-color,#89b4fa)' : 'var(--border-color,#313244)') + ';' +
    'background:var(--bg-secondary,#181825);');

  // Top row: name + source badge + actions
  var topRow = ppCreateEl('div',
    'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;');

  var nameSection = ppCreateEl('div', 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;');

  var nameEl = ppCreateEl('span',
    'font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);');
  nameEl.textContent = persona.name;
  nameSection.appendChild(nameEl);

  // Source badge
  var srcBadge = ppCreateEl('span',
    'font-size:10px;padding:1px 6px;border-radius:3px;font-weight:500;' +
    (isBuiltIn
      ? 'color:#a6e3a1;background:rgba(166,227,161,0.15);'
      : 'color:#89b4fa;background:rgba(137,180,250,0.15);'));
  srcBadge.textContent = persona.source || (isBuiltIn ? 'built-in' : 'custom');
  nameSection.appendChild(srcBadge);

  // Active indicator
  if (isActive) {
    var activeBadge = ppCreateEl('span',
      'font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600;' +
      'color:#1e1e2e;background:var(--accent-color,#89b4fa);');
    activeBadge.textContent = 'Active';
    nameSection.appendChild(activeBadge);
  }

  topRow.appendChild(nameSection);

  // Action buttons
  var actionsRow = ppCreateEl('div', 'display:flex;gap:4px;flex-shrink:0;');

  // Activate button
  if (!isActive) {
    var activateBtn = ppCreateEl('button',
      'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--accent-color,#89b4fa);' +
      'background:transparent;color:var(--accent-color,#89b4fa);cursor:pointer;');
    activateBtn.textContent = 'Activate';
    activateBtn.setAttribute('aria-label', 'Activate persona ' + persona.name);
    activateBtn.addEventListener('click', function () { self.handleActivate(persona.id); });
    actionsRow.appendChild(activateBtn);
  }

  // Preview button
  var previewBtn = ppCreateEl('button',
    'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#313244);' +
    'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  previewBtn.textContent = 'Preview';
  previewBtn.setAttribute('aria-label', 'Preview system prompt with ' + persona.name);
  previewBtn.addEventListener('click', function () { self.handlePreview(persona.id); });
  actionsRow.appendChild(previewBtn);

  if (!isBuiltIn) {
    // Edit button
    var editBtn = ppCreateEl('button',
      'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#313244);' +
      'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit persona ' + persona.name);
    editBtn.addEventListener('click', function () { self.showForm(persona); });
    actionsRow.appendChild(editBtn);

    // Delete button
    var deleteBtn = ppCreateEl('button',
      'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #f38ba8;' +
      'background:transparent;color:#f38ba8;cursor:pointer;');
    deleteBtn.textContent = 'Delete';
    deleteBtn.setAttribute('aria-label', 'Delete persona ' + persona.name);
    deleteBtn.addEventListener('click', function () { self.handleDelete(persona); });
    actionsRow.appendChild(deleteBtn);
  }

  topRow.appendChild(actionsRow);
  card.appendChild(topRow);

  // Description
  if (persona.description) {
    var desc = ppCreateEl('p',
      'margin:0 0 6px;font-size:12px;color:var(--text-secondary,#a6adc8);line-height:1.4;');
    desc.textContent = persona.description;
    card.appendChild(desc);
  }

  // Meta row: verbosity, output contract
  var metaRow = ppCreateEl('div',
    'display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px;');

  if (persona.style && persona.style.verbosity) {
    var verbBadge = ppCreateEl('span',
      'padding:1px 6px;border-radius:3px;background:var(--bg-tertiary,#313244);' +
      'color:var(--text-muted,#6c7086);');
    verbBadge.textContent = 'Verbosity: ' + persona.style.verbosity;
    metaRow.appendChild(verbBadge);
  }

  if (persona.style && persona.style.outputContract) {
    var fmtBadge = ppCreateEl('span',
      'padding:1px 6px;border-radius:3px;background:var(--bg-tertiary,#313244);' +
      'color:var(--text-muted,#6c7086);');
    fmtBadge.textContent = 'Format: ' + persona.style.outputContract.format;
    metaRow.appendChild(fmtBadge);
  }

  if (metaRow.children.length > 0) {
    card.appendChild(metaRow);
  }

  return card;
};

// ─── Form View (Create / Edit) ─────────────────────────────────────

PersonasPanel.prototype.showForm = function (persona) {
  this.view = 'form';
  this.editingPersona = persona || null;
  this.renderForm();
};

PersonasPanel.prototype.renderForm = function () {
  var self = this;
  var isEdit = !!this.editingPersona;
  var p = this.editingPersona || {};

  this.contentEl.innerHTML = '';

  // Back button
  var backBtn = ppCreateEl('button',
    'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);' +
    'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;margin-bottom:12px;');
  backBtn.textContent = '\u2190 Back to List';
  backBtn.addEventListener('click', function () { self.renderList(); });
  this.contentEl.appendChild(backBtn);

  var formTitle = ppCreateEl('h4',
    'margin:0 0 12px;font-size:14px;color:var(--text-primary,#cdd6f4);');
  formTitle.textContent = isEdit ? 'Edit Persona' : 'Create New Persona';
  this.contentEl.appendChild(formTitle);

  var form = ppCreateEl('div', '');

  // Name field
  form.appendChild(this.createFormField('Name', 'text', 'pp-name', p.name || '', 'Persona name'));

  // Description field
  form.appendChild(this.createFormField('Description', 'text', 'pp-desc', p.description || '',
    'Brief description of what this persona does'));

  // System Prompt Overlay (textarea)
  var overlayGroup = ppCreateEl('div', 'margin-bottom:12px;');
  var overlayLabel = ppCreateEl('label',
    'display:block;font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);margin-bottom:4px;');
  overlayLabel.textContent = 'System Prompt Overlay';
  overlayLabel.setAttribute('for', 'pp-overlay');
  overlayGroup.appendChild(overlayLabel);

  var overlayInput = ppCreateEl('textarea',
    'width:100%;min-height:100px;padding:8px 12px;border-radius:6px;' +
    'border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);' +
    'color:var(--text-primary,#cdd6f4);font-size:13px;box-sizing:border-box;resize:vertical;' +
    'font-family:inherit;',
    { id: 'pp-overlay', placeholder: 'Instructions appended to the system prompt...' });
  overlayInput.value = p.systemPromptOverlay || '';
  overlayGroup.appendChild(overlayInput);
  form.appendChild(overlayGroup);

  // Verbosity select
  var verbGroup = ppCreateEl('div', 'margin-bottom:12px;');
  var verbLabel = ppCreateEl('label',
    'display:block;font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);margin-bottom:4px;');
  verbLabel.textContent = 'Verbosity';
  verbLabel.setAttribute('for', 'pp-verbosity');
  verbGroup.appendChild(verbLabel);

  var verbSelect = ppCreateEl('select',
    'width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#313244);' +
    'background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);font-size:13px;',
    { id: 'pp-verbosity' });

  var defaultOpt = ppCreateEl('option', '');
  defaultOpt.value = '';
  defaultOpt.textContent = '(default)';
  verbSelect.appendChild(defaultOpt);

  for (var v = 0; v < PERSONA_VERBOSITY_OPTIONS.length; v++) {
    var opt = ppCreateEl('option', '');
    opt.value = PERSONA_VERBOSITY_OPTIONS[v].value;
    opt.textContent = PERSONA_VERBOSITY_OPTIONS[v].label;
    if (p.style && p.style.verbosity === PERSONA_VERBOSITY_OPTIONS[v].value) {
      opt.selected = true;
    }
    verbSelect.appendChild(opt);
  }
  verbGroup.appendChild(verbSelect);
  form.appendChild(verbGroup);

  // Output format select
  var fmtGroup = ppCreateEl('div', 'margin-bottom:12px;');
  var fmtLabel = ppCreateEl('label',
    'display:block;font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);margin-bottom:4px;');
  fmtLabel.textContent = 'Output Format';
  fmtLabel.setAttribute('for', 'pp-format');
  fmtGroup.appendChild(fmtLabel);

  var fmtSelect = ppCreateEl('select',
    'width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#313244);' +
    'background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);font-size:13px;',
    { id: 'pp-format' });

  var fmtDefault = ppCreateEl('option', '');
  fmtDefault.value = '';
  fmtDefault.textContent = '(none)';
  fmtSelect.appendChild(fmtDefault);

  for (var f = 0; f < PERSONA_FORMAT_OPTIONS.length; f++) {
    var fopt = ppCreateEl('option', '');
    fopt.value = PERSONA_FORMAT_OPTIONS[f].value;
    fopt.textContent = PERSONA_FORMAT_OPTIONS[f].label;
    if (p.style && p.style.outputContract && p.style.outputContract.format === PERSONA_FORMAT_OPTIONS[f].value) {
      fopt.selected = true;
    }
    fmtSelect.appendChild(fopt);
  }
  fmtGroup.appendChild(fmtSelect);
  form.appendChild(fmtGroup);

  // Submit row
  var submitRow = ppCreateEl('div', 'display:flex;gap:8px;margin-top:16px;');

  var saveBtn = ppCreateEl('button',
    'font-size:12px;padding:6px 16px;border-radius:4px;border:none;' +
    'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
  saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Persona';
  saveBtn.addEventListener('click', function () { self.handleSave(); });
  submitRow.appendChild(saveBtn);

  var cancelBtn = ppCreateEl('button',
    'font-size:12px;padding:6px 16px;border-radius:4px;border:1px solid var(--border-color,#313244);' +
    'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () { self.renderList(); });
  submitRow.appendChild(cancelBtn);

  form.appendChild(submitRow);
  this.contentEl.appendChild(form);
};

PersonasPanel.prototype.createFormField = function (label, type, id, value, placeholder) {
  var group = ppCreateEl('div', 'margin-bottom:12px;');

  var labelEl = ppCreateEl('label',
    'display:block;font-size:12px;font-weight:600;color:var(--text-secondary,#a6adc8);margin-bottom:4px;');
  labelEl.textContent = label;
  labelEl.setAttribute('for', id);
  group.appendChild(labelEl);

  var input = ppCreateEl('input',
    'width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#313244);' +
    'background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);font-size:13px;' +
    'box-sizing:border-box;',
    { type: type, id: id, placeholder: placeholder || '' });
  input.value = value;
  group.appendChild(input);

  return group;
};

// ─── Action Handlers ───────────────────────────────────────────────

PersonasPanel.prototype.handleSave = function () {
  var self = this;
  var api = ppEapi();
  if (!api) return;

  var nameVal = (document.getElementById('pp-name') || {}).value || '';
  var descVal = (document.getElementById('pp-desc') || {}).value || '';
  var overlayVal = (document.getElementById('pp-overlay') || {}).value || '';
  var verbVal = (document.getElementById('pp-verbosity') || {}).value || '';
  var fmtVal = (document.getElementById('pp-format') || {}).value || '';

  if (!nameVal.trim()) {
    this.showToast('Name is required', 'error');
    return;
  }
  if (!overlayVal.trim()) {
    this.showToast('System prompt overlay is required', 'error');
    return;
  }

  var style = {};
  if (verbVal) style.verbosity = verbVal;
  if (fmtVal) style.outputContract = { format: fmtVal };

  var payload = {
    name: nameVal.trim(),
    description: descVal.trim(),
    systemPromptOverlay: overlayVal.trim(),
    style: Object.keys(style).length > 0 ? style : undefined,
    projectId: this.projectId || undefined,
  };

  var channel = this.editingPersona ? 'personas:update' : 'personas:create';
  if (this.editingPersona) {
    payload.id = this.editingPersona.id;
  }

  api.invoke(channel, payload).then(function (result) {
    if (result && result.success) {
      self.showToast(self.editingPersona ? 'Persona updated' : 'Persona created', 'success');
      self.editingPersona = null;
      self.loadPersonas();
    } else {
      self.showToast('Failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

PersonasPanel.prototype.handleDelete = function (persona) {
  var self = this;
  if (!confirm('Delete persona "' + persona.name + '"? This cannot be undone.')) return;

  var api = ppEapi();
  if (!api) return;

  api.invoke('personas:delete', { id: persona.id, projectId: this.projectId }).then(function (result) {
    if (result && result.success) {
      self.showToast('Persona deleted', 'success');
      if (self.activePersonaId === persona.id) {
        self.activePersonaId = null;
      }
      self.loadPersonas();
    } else {
      self.showToast('Failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

PersonasPanel.prototype.handleActivate = function (personaId) {
  var self = this;
  var api = ppEapi();
  if (!api) return;

  api.invoke('personas:activate', { id: personaId, projectId: this.projectId }).then(function (result) {
    if (result && result.success) {
      self.activePersonaId = personaId;
      self.showToast('Persona activated', 'success');
      self.renderList();
    } else {
      self.showToast('Failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

PersonasPanel.prototype.handlePreview = function (personaId) {
  var self = this;
  var api = ppEapi();
  if (!api) return;

  api.invoke('personas:preview', { id: personaId, projectId: this.projectId }).then(function (result) {
    if (result && result.success) {
      self.renderPreview(result.preview, personaId);
    } else {
      self.showToast('Preview failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

PersonasPanel.prototype.renderPreview = function (previewText, personaId) {
  var self = this;
  this.view = 'preview';
  this.contentEl.innerHTML = '';

  // Find persona name
  var personaName = '';
  for (var i = 0; i < this.personas.length; i++) {
    if (this.personas[i].id === personaId) {
      personaName = this.personas[i].name;
      break;
    }
  }

  // Back button
  var backBtn = ppCreateEl('button',
    'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);' +
    'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;margin-bottom:12px;');
  backBtn.textContent = '\u2190 Back to List';
  backBtn.addEventListener('click', function () { self.renderList(); });
  this.contentEl.appendChild(backBtn);

  var previewTitle = ppCreateEl('h4',
    'margin:0 0 12px;font-size:14px;color:var(--text-primary,#cdd6f4);');
  previewTitle.textContent = 'System Prompt Preview: ' + personaName;
  this.contentEl.appendChild(previewTitle);

  var previewBox = ppCreateEl('div',
    'padding:12px;border-radius:8px;border:1px solid var(--border-color,#313244);' +
    'background:var(--bg-secondary,#181825);max-height:400px;overflow-y:auto;');

  var previewPre = ppCreateEl('pre',
    'margin:0;font-size:12px;color:var(--text-primary,#cdd6f4);white-space:pre-wrap;' +
    'word-wrap:break-word;font-family:var(--font-mono,monospace);line-height:1.5;');
  previewPre.textContent = previewText || '(empty)';
  previewBox.appendChild(previewPre);

  this.contentEl.appendChild(previewBox);
};

// ─── Chat Header Selector ──────────────────────────────────────────

/**
 * Creates a compact persona selector dropdown suitable for embedding
 * in the chat header. Returns a DOM element with the selector.
 */
PersonasPanel.prototype.createChatSelector = function (containerEl) {
  var self = this;

  var wrap = ppCreateEl('div',
    'display:inline-flex;align-items:center;gap:4px;');

  var label = ppCreateEl('span',
    'font-size:11px;color:var(--text-muted,#6c7086);');
  label.textContent = 'Persona:';
  wrap.appendChild(label);

  var select = ppCreateEl('select',
    'font-size:11px;padding:2px 6px;border-radius:4px;' +
    'border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);' +
    'color:var(--text-primary,#cdd6f4);cursor:pointer;',
    { 'aria-label': 'Select active persona' });

  // None option
  var noneOpt = ppCreateEl('option', '');
  noneOpt.value = '';
  noneOpt.textContent = '(none)';
  select.appendChild(noneOpt);

  for (var i = 0; i < this.personas.length; i++) {
    var p = this.personas[i];
    var opt = ppCreateEl('option', '');
    opt.value = p.id;
    opt.textContent = p.name + (p.builtIn ? ' (built-in)' : '');
    if (p.id === this.activePersonaId) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', function () {
    var selectedId = select.value;
    if (selectedId) {
      self.handleActivate(selectedId);
    } else {
      // Deactivate
      self.activePersonaId = null;
    }
  });

  wrap.appendChild(select);

  if (containerEl) {
    containerEl.appendChild(wrap);
  }

  return wrap;
};

// ─── Toast Notification ────────────────────────────────────────────

PersonasPanel.prototype.showToast = function (message, type) {
  var colors = {
    success: { bg: 'rgba(166,227,161,0.15)', color: '#a6e3a1', border: '#a6e3a1' },
    error: { bg: 'rgba(243,139,168,0.15)', color: '#f38ba8', border: '#f38ba8' },
    info: { bg: 'rgba(137,180,250,0.15)', color: '#89b4fa', border: '#89b4fa' },
  };
  var c = colors[type] || colors.info;

  var toast = ppCreateEl('div',
    'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:8px;font-size:13px;' +
    'z-index:9999;border:1px solid ' + c.border + ';background:' + c.bg + ';color:' + c.color +
    ';box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;');
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

PersonasPanel.prototype.destroy = function () {
  this.container.innerHTML = '';
  this.personas = [];
  this.editingPersona = null;
};

// ─── Exports ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PersonasPanel: PersonasPanel };
}
