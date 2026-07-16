// @ts-nocheck
/**
 * FeatureManagementPanel — Renderer UI for centralized feature gate configuration.
 *
 * Displays every flag from FeatureGateFlags with full metadata:
 * name, description, stability, global/project values, effective state,
 * availability, and dependencies. Supports search and grouping by capability
 * category. Prevents enabling flags with unsatisfied dependencies and shows
 * indirect-enable reasons. Provides reset-to-default, export-profile, and
 * import-profile actions.
 *
 * Communicates with main process through IPC channels:
 * - feature-gate:get-all — gets full flag state
 * - feature-gate:set — sets global or project override
 * - feature-gate:reset — resets to default
 * - feature-gate:export — exports profile
 * - feature-gate:import — imports profile
 * - feature-gate:audit — retrieves change audit log
 *
 * Gated behind Feature_Management_UI availability.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as cost-controls-panel.ts.
 *
 * Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 2.8, 2.11
 */

// ─── Constants ─────────────────────────────────────────────────────

var FEATURE_GROUPS = [
  { id: 'execution', label: 'Execution', icon: '⚡' },
  { id: 'automation', label: 'Automation', icon: '🔄' },
  { id: 'intelligence', label: 'Intelligence', icon: '🧠' },
  { id: 'quality', label: 'Quality', icon: '✓' },
  { id: 'security', label: 'Security', icon: '🔒' },
  { id: 'extensions', label: 'Extensions', icon: '🧩' },
  { id: 'runtime', label: 'Runtime', icon: '🖥' },
  { id: 'experimental', label: 'Experimental', icon: '🧪' },
];

/**
 * Map feature flags to their capability groups for display grouping.
 * Flags not listed here default to 'experimental'.
 */
var FLAG_GROUP_MAP = {
  // Execution
  worktree_isolation: 'execution',
  ast_locking: 'execution',
  parallel_agents: 'execution',
  session_shell: 'execution',
  background_processes: 'execution',
  interactive_terminal: 'execution',
  headless_mode: 'execution',
  headless_cli: 'execution',
  // Automation
  loops_enabled: 'automation',
  loops_catalog_import: 'automation',
  loops_discover: 'automation',
  loops_scheduler: 'automation',
  scheduled_tasks: 'automation',
  harness_permission_patterns: 'automation',
  harness_hooks: 'automation',
  harness_subagents: 'automation',
  harness_mcp_scoping: 'automation',
  quality_workers: 'automation',
  // Intelligence
  lsp_intelligence: 'intelligence',
  semantic_index: 'intelligence',
  inline_autocomplete: 'intelligence',
  prompt_enhancement: 'intelligence',
  commit_message_gen: 'intelligence',
  context_mentions: 'intelligence',
  context_condenser_v2: 'intelligence',
  context_scoped_delegation: 'intelligence',
  trigger_gated_knowledge: 'intelligence',
  enhanced_drift_classification: 'intelligence',
  drift_aware_orchestration: 'intelligence',
  // Quality
  test_planning: 'quality',
  test_generation: 'quality',
  test_drift_detection: 'quality',
  test_health_analytics: 'quality',
  verification_agent: 'quality',
  code_review_pipeline: 'quality',
  diff_review: 'quality',
  diff_viewer: 'quality',
  checkpoint: 'quality',
  checkpoint_timeline: 'quality',
  compliance_gates: 'quality',
  repo_readiness: 'quality',
  // Security
  sandbox: 'security',
  wasm_sandbox: 'security',
  network_sandbox: 'security',
  credential_vault: 'security',
  vulnerability_blocking: 'security',
  supply_chain_detection: 'security',
  runtimesecurity_hackability_scoring: 'security',
  runtimesecurity_threat_modeling: 'security',
  runtimesecurity_realtime_analysis: 'security',
  runtimesecurity_attack_path_mapping: 'security',
  runtimesecurity_evidence_store: 'security',
  runtimesecurity_ai_security_rules: 'security',
  // Extensions
  plugin_system: 'extensions',
  mcp_marketplace: 'extensions',
  skill_creation: 'extensions',
  notebook_integration: 'extensions',
  session_portability: 'extensions',
  browser_automation: 'extensions',
  // Runtime
  cost_tracking: 'runtime',
  cost_controls: 'runtime',
  model_routing: 'runtime',
  provider_failover: 'runtime',
  provider_registry: 'runtime',
  voice_io: 'runtime',
  speech_to_text: 'runtime',
  i18n_system: 'runtime',
  remote_access: 'runtime',
  cloud_agent: 'runtime',
};

/**
 * Stability levels for display badges.
 */
var STABILITY_LEVELS = {
  stable: { label: 'Stable', color: '#a6e3a1', bg: 'rgba(166,227,161,0.15)' },
  beta: { label: 'Beta', color: '#89b4fa', bg: 'rgba(137,180,250,0.15)' },
  experimental: { label: 'Experimental', color: '#f9e2af', bg: 'rgba(249,226,175,0.15)' },
  deprecated: { label: 'Deprecated', color: '#f38ba8', bg: 'rgba(243,139,168,0.15)' },
};

/**
 * Flag stability classification. Flags not listed default to 'experimental'.
 */
var FLAG_STABILITY = {
  provider_registry: 'stable',
  context_condenser_v2: 'stable',
  loops_enabled: 'stable',
  production_ux_action_first: 'stable',
  cost_tracking: 'beta',
  checkpoint: 'beta',
  lsp_intelligence: 'beta',
  worktree_isolation: 'beta',
  parallel_agents: 'beta',
  semantic_index: 'beta',
  diff_review: 'beta',
  model_routing: 'beta',
};

// ─── Helpers ───────────────────────────────────────────────────────

function fmEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function fmEapi() {
  return window.electronAPI;
}

function fmGetGroup(flag) {
  return FLAG_GROUP_MAP[flag] || 'experimental';
}

function fmGetStability(flag) {
  return FLAG_STABILITY[flag] || 'experimental';
}

function fmFormatFlagName(flag) {
  // Convert snake_case to Title Case
  return flag.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function fmCreateEl(tag, styles, attrs) {
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

// ─── FeatureManagementPanel class ──────────────────────────────────

function FeatureManagementPanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || null;
  this.flags = [];         // Array of flag state objects from main
  this.searchQuery = '';
  this.activeGroup = null; // null = show all
  this.contentEl = null;
  this.searchEl = null;
  this.groupTabsEl = null;
}

FeatureManagementPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  // ── Header ──
  var header = fmCreateEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;');

  var title = fmCreateEl('h3', 'margin:0;font-size:16px;color:var(--text-primary,#cdd6f4);');
  title.textContent = 'Feature Management';
  header.appendChild(title);

  // Action buttons
  var actions = fmCreateEl('div', 'display:flex;gap:6px;flex-wrap:wrap;');

  var resetBtn = fmCreateEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  resetBtn.textContent = 'Reset All to Default';
  resetBtn.setAttribute('aria-label', 'Reset all features to default');
  resetBtn.addEventListener('click', function () { self.handleResetAll(); });
  actions.appendChild(resetBtn);

  var exportBtn = fmCreateEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  exportBtn.textContent = 'Export Profile';
  exportBtn.setAttribute('aria-label', 'Export feature profile');
  exportBtn.addEventListener('click', function () { self.handleExport(); });
  actions.appendChild(exportBtn);

  var importBtn = fmCreateEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  importBtn.textContent = 'Import Profile';
  importBtn.setAttribute('aria-label', 'Import feature profile');
  importBtn.addEventListener('click', function () { self.handleImport(); });
  actions.appendChild(importBtn);

  header.appendChild(actions);
  this.container.appendChild(header);

  // ── Search bar ──
  var searchRow = fmCreateEl('div', 'margin-bottom:12px;');
  this.searchEl = fmCreateEl('input', 'width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);font-size:13px;box-sizing:border-box;', { type: 'text', placeholder: 'Search features...', 'aria-label': 'Search features' });
  this.searchEl.addEventListener('input', function () {
    self.searchQuery = self.searchEl.value.toLowerCase();
    self.renderFlags();
  });
  searchRow.appendChild(this.searchEl);
  this.container.appendChild(searchRow);

  // ── Group tabs ──
  this.groupTabsEl = fmCreateEl('div', 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:16px;');
  this.renderGroupTabs();
  this.container.appendChild(this.groupTabsEl);

  // ── Content area (flag list) ──
  this.contentEl = fmCreateEl('div', '');
  this.container.appendChild(this.contentEl);

  // Load data
  this.loadFlags();
};

FeatureManagementPanel.prototype.renderGroupTabs = function () {
  var self = this;
  this.groupTabsEl.innerHTML = '';

  // "All" tab
  var allTab = fmCreateEl('button', 'font-size:11px;padding:4px 10px;border-radius:12px;border:1px solid var(--border-color,#313244);cursor:pointer;background:' + (self.activeGroup === null ? 'var(--accent-color,#89b4fa)' : 'transparent') + ';color:' + (self.activeGroup === null ? '#1e1e2e' : 'var(--text-secondary,#a6adc8)') + ';font-weight:' + (self.activeGroup === null ? '600' : '400') + ';');
  allTab.textContent = 'All';
  allTab.setAttribute('aria-label', 'Show all groups');
  allTab.addEventListener('click', function () {
    self.activeGroup = null;
    self.renderGroupTabs();
    self.renderFlags();
  });
  this.groupTabsEl.appendChild(allTab);

  for (var i = 0; i < FEATURE_GROUPS.length; i++) {
    (function (group) {
      var isActive = self.activeGroup === group.id;
      var tab = fmCreateEl('button', 'font-size:11px;padding:4px 10px;border-radius:12px;border:1px solid var(--border-color,#313244);cursor:pointer;background:' + (isActive ? 'var(--accent-color,#89b4fa)' : 'transparent') + ';color:' + (isActive ? '#1e1e2e' : 'var(--text-secondary,#a6adc8)') + ';font-weight:' + (isActive ? '600' : '400') + ';');
      tab.textContent = group.icon + ' ' + group.label;
      tab.setAttribute('aria-label', 'Filter by ' + group.label);
      tab.addEventListener('click', function () {
        self.activeGroup = group.id;
        self.renderGroupTabs();
        self.renderFlags();
      });
      self.groupTabsEl.appendChild(tab);
    })(FEATURE_GROUPS[i]);
  }
};

FeatureManagementPanel.prototype.loadFlags = function () {
  var self = this;
  var api = fmEapi();
  if (!api) {
    this.renderError('electronAPI not available');
    return;
  }

  this.contentEl.innerHTML = '<p style="color:var(--text-muted,#6c7086);font-size:13px;">Loading feature flags...</p>';

  api.invoke('feature-gate:get-all', { projectId: this.projectId }).then(function (result) {
    if (!result || !result.success) {
      self.renderError(result && result.error ? result.error : 'Failed to load feature flags');
      return;
    }
    self.flags = result.flags || [];
    self.renderFlags();
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Unknown error');
  });
};

FeatureManagementPanel.prototype.renderError = function (msg) {
  this.contentEl.innerHTML = '<p style="color:#f38ba8;font-size:13px;padding:8px;">' + fmEscHtml(msg) + '</p>';
};

FeatureManagementPanel.prototype.renderFlags = function () {
  var self = this;
  this.contentEl.innerHTML = '';

  // Filter flags
  var filtered = this.flags.filter(function (f) {
    // Group filter
    if (self.activeGroup !== null && fmGetGroup(f.flag) !== self.activeGroup) return false;
    // Search filter
    if (self.searchQuery) {
      var name = (f.flag || '').toLowerCase();
      var desc = (f.description || '').toLowerCase();
      var label = fmFormatFlagName(f.flag).toLowerCase();
      if (name.indexOf(self.searchQuery) === -1 &&
          desc.indexOf(self.searchQuery) === -1 &&
          label.indexOf(self.searchQuery) === -1) {
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) {
    this.contentEl.innerHTML = '<p style="color:var(--text-muted,#6c7086);font-size:13px;padding:16px;text-align:center;">No features match the current filter.</p>';
    return;
  }

  // Group the filtered flags
  var grouped = {};
  for (var i = 0; i < filtered.length; i++) {
    var group = fmGetGroup(filtered[i].flag);
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(filtered[i]);
  }

  // Render each group
  for (var g = 0; g < FEATURE_GROUPS.length; g++) {
    var grp = FEATURE_GROUPS[g];
    var items = grouped[grp.id];
    if (!items || items.length === 0) continue;
    this.renderGroupSection(grp, items);
  }
};

FeatureManagementPanel.prototype.renderGroupSection = function (group, items) {
  var self = this;

  var section = fmCreateEl('div', 'margin-bottom:20px;');

  // Group heading
  var heading = fmCreateEl('div', 'display:flex;align-items:center;gap:6px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border-color,#313244);');
  var icon = fmCreateEl('span', 'font-size:14px;');
  icon.textContent = group.icon;
  heading.appendChild(icon);
  var label = fmCreateEl('span', 'font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);');
  label.textContent = group.label;
  heading.appendChild(label);
  var count = fmCreateEl('span', 'font-size:11px;color:var(--text-muted,#6c7086);margin-left:4px;');
  count.textContent = '(' + items.length + ')';
  heading.appendChild(count);
  section.appendChild(heading);

  // Flag cards
  for (var i = 0; i < items.length; i++) {
    section.appendChild(self.renderFlagCard(items[i]));
  }

  this.contentEl.appendChild(section);
};

FeatureManagementPanel.prototype.renderFlagCard = function (flagData) {
  var self = this;
  var flag = flagData.flag;
  var effective = flagData.effective; // { enabled, source, available, reason }
  var globalValue = flagData.globalValue;
  var projectValue = flagData.projectValue;
  var deps = flagData.dependencies; // { valid, satisfied, missing, incompatible, missingAny }
  var stability = fmGetStability(flag);
  var stabInfo = STABILITY_LEVELS[stability] || STABILITY_LEVELS.experimental;

  var isUnavailable = effective && !effective.available;
  var isEnabled = effective && effective.enabled;
  var isIndirect = effective && (effective.source === 'dependency' || effective.source === 'project');

  var card = fmCreateEl('div', 'padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border-color,#313244);background:var(--bg-secondary,#181825);' + (isUnavailable ? 'opacity:0.6;' : ''));

  // Top row: name + stability badge + toggle
  var topRow = fmCreateEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;');

  var nameSection = fmCreateEl('div', 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;');

  var nameEl = fmCreateEl('span', 'font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
  nameEl.textContent = fmFormatFlagName(flag);
  nameEl.title = flag;
  nameSection.appendChild(nameEl);

  // Stability badge
  var badge = fmCreateEl('span', 'font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600;white-space:nowrap;color:' + stabInfo.color + ';background:' + stabInfo.bg + ';');
  badge.textContent = stabInfo.label;
  nameSection.appendChild(badge);

  topRow.appendChild(nameSection);

  // Toggle switch
  var toggleWrap = fmCreateEl('div', 'display:flex;align-items:center;gap:8px;flex-shrink:0;');
  var toggle = this.createToggle(flag, isEnabled, isUnavailable, deps);
  toggleWrap.appendChild(toggle);
  topRow.appendChild(toggleWrap);

  card.appendChild(topRow);

  // Description
  if (flagData.description) {
    var desc = fmCreateEl('p', 'margin:0 0 6px;font-size:12px;color:var(--text-secondary,#a6adc8);line-height:1.4;');
    desc.textContent = flagData.description;
    card.appendChild(desc);
  }

  // Metadata row: source, availability, global/project values
  var metaRow = fmCreateEl('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px;');

  // Effective source
  if (effective) {
    var srcBadge = fmCreateEl('span', 'padding:1px 6px;border-radius:3px;background:var(--bg-tertiary,#313244);color:var(--text-muted,#6c7086);');
    srcBadge.textContent = 'Source: ' + effective.source;
    metaRow.appendChild(srcBadge);
  }

  // Availability
  var availBadge = fmCreateEl('span', 'padding:1px 6px;border-radius:3px;background:' + (isUnavailable ? 'rgba(243,139,168,0.15)' : 'rgba(166,227,161,0.15)') + ';color:' + (isUnavailable ? '#f38ba8' : '#a6e3a1') + ';');
  availBadge.textContent = isUnavailable ? 'Unavailable' : 'Available';
  metaRow.appendChild(availBadge);

  // Global value
  if (globalValue !== null && globalValue !== undefined) {
    var gBadge = fmCreateEl('span', 'padding:1px 6px;border-radius:3px;background:var(--bg-tertiary,#313244);color:var(--text-muted,#6c7086);');
    gBadge.textContent = 'Global: ' + (globalValue ? 'on' : 'off');
    metaRow.appendChild(gBadge);
  }

  // Project value
  if (projectValue !== null && projectValue !== undefined) {
    var pBadge = fmCreateEl('span', 'padding:1px 6px;border-radius:3px;background:var(--bg-tertiary,#313244);color:var(--text-muted,#6c7086);');
    pBadge.textContent = 'Project: ' + (projectValue ? 'on' : 'off');
    metaRow.appendChild(pBadge);
  }

  card.appendChild(metaRow);

  // Indirect-enable reason
  if (isIndirect && effective && effective.reason) {
    var reasonEl = fmCreateEl('div', 'margin-top:6px;font-size:11px;color:#89b4fa;padding:4px 8px;border-radius:4px;background:rgba(137,180,250,0.1);');
    reasonEl.textContent = 'Indirect: ' + effective.reason;
    card.appendChild(reasonEl);
  }

  // Unavailable reason
  if (isUnavailable && effective && effective.reason) {
    var unavailEl = fmCreateEl('div', 'margin-top:6px;font-size:11px;color:#f38ba8;padding:4px 8px;border-radius:4px;background:rgba(243,139,168,0.1);');
    unavailEl.textContent = effective.reason;
    card.appendChild(unavailEl);
  }

  // Dependency info (when deps are unsatisfied)
  if (deps && !deps.valid) {
    var depEl = fmCreateEl('div', 'margin-top:6px;font-size:11px;color:#fab387;padding:4px 8px;border-radius:4px;background:rgba(250,179,135,0.1);');
    var depText = 'Cannot enable: ';
    if (deps.missing && deps.missing.length > 0) {
      depText += 'Missing prerequisites: ' + deps.missing.map(fmFormatFlagName).join(', ');
    }
    if (deps.incompatible && deps.incompatible.length > 0) {
      depText += (deps.missing && deps.missing.length > 0 ? '. ' : '') + 'Incompatible with: ' + deps.incompatible.map(fmFormatFlagName).join(', ');
    }
    if (deps.missingAny && deps.missingAny.length > 0) {
      depText += (deps.missing && deps.missing.length > 0 ? '. ' : '') + 'Requires one of: ' + deps.missingAny.map(fmFormatFlagName).join(', ');
    }
    depEl.textContent = depText;
    card.appendChild(depEl);
  }

  // Dependencies list (satisfied)
  if (deps && deps.satisfied && deps.satisfied.length > 0) {
    var satEl = fmCreateEl('div', 'margin-top:4px;font-size:10px;color:var(--text-muted,#6c7086);');
    satEl.textContent = 'Depends on: ' + deps.satisfied.map(fmFormatFlagName).join(', ');
    card.appendChild(satEl);
  }

  // Reset button for this flag
  var resetRow = fmCreateEl('div', 'margin-top:8px;display:flex;gap:6px;');
  var resetFlagBtn = fmCreateEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-muted,#6c7086);cursor:pointer;');
  resetFlagBtn.textContent = 'Reset to Default';
  resetFlagBtn.addEventListener('click', function () {
    self.handleResetFlag(flag);
  });
  resetRow.appendChild(resetFlagBtn);
  card.appendChild(resetRow);

  return card;
};

FeatureManagementPanel.prototype.createToggle = function (flag, isEnabled, isUnavailable, deps) {
  var self = this;
  var canEnable = !isUnavailable && (deps ? deps.valid : true);

  var label = fmCreateEl('label', 'position:relative;display:inline-block;width:36px;height:20px;cursor:' + (canEnable ? 'pointer' : 'not-allowed') + ';opacity:' + (canEnable ? '1' : '0.5') + ';');

  var input = fmCreateEl('input', 'opacity:0;width:0;height:0;', { type: 'checkbox' });
  if (isEnabled) input.checked = true;
  if (!canEnable) input.disabled = true;

  input.addEventListener('change', function () {
    if (!canEnable) {
      input.checked = isEnabled;
      return;
    }
    self.handleToggle(flag, input.checked);
  });
  label.appendChild(input);

  var slider = fmCreateEl('span', 'position:absolute;inset:0;border-radius:10px;transition:background 0.2s;background:' + (isEnabled ? '#a6e3a1' : 'var(--bg-tertiary,#313244)') + ';');

  var knob = fmCreateEl('span', 'position:absolute;top:2px;left:' + (isEnabled ? '18px' : '2px') + ';width:16px;height:16px;border-radius:50%;background:var(--text-primary,#cdd6f4);transition:left 0.2s;');
  slider.appendChild(knob);
  label.appendChild(slider);

  return label;
};

// ─── Action Handlers ───────────────────────────────────────────────

FeatureManagementPanel.prototype.handleToggle = function (flag, value) {
  var self = this;
  var api = fmEapi();
  if (!api) return;

  var scope = this.projectId ? 'project' : 'global';
  api.invoke('feature-gate:set', {
    flag: flag,
    value: value,
    scope: scope,
    projectId: this.projectId || undefined,
  }).then(function (result) {
    if (result && result.success) {
      self.loadFlags();
    } else {
      self.showToast('Failed to update: ' + (result && result.error ? result.error : 'Unknown error'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

FeatureManagementPanel.prototype.handleResetFlag = function (flag) {
  var self = this;
  var api = fmEapi();
  if (!api) return;

  var scope = this.projectId ? 'project' : 'global';
  api.invoke('feature-gate:reset', {
    flag: flag,
    scope: scope,
    projectId: this.projectId || undefined,
  }).then(function (result) {
    if (result && result.success) {
      self.loadFlags();
      self.showToast('Reset ' + fmFormatFlagName(flag) + ' to default', 'success');
    } else {
      self.showToast('Failed to reset: ' + (result && result.error ? result.error : 'Unknown'), 'error');
    }
  }).catch(function (err) {
    self.showToast('Error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

FeatureManagementPanel.prototype.handleResetAll = function () {
  var self = this;
  if (!confirm('Reset all feature flags to their default values? This cannot be undone.')) return;

  var api = fmEapi();
  if (!api) return;

  // Reset each flag that has an override
  var flagsWithOverrides = this.flags.filter(function (f) {
    return f.globalValue !== null || f.projectValue !== null;
  });

  if (flagsWithOverrides.length === 0) {
    self.showToast('No overrides to reset', 'info');
    return;
  }

  var promises = flagsWithOverrides.map(function (f) {
    var scope = self.projectId ? 'project' : 'global';
    return api.invoke('feature-gate:reset', {
      flag: f.flag,
      scope: scope,
      projectId: self.projectId || undefined,
    });
  });

  Promise.all(promises).then(function () {
    self.loadFlags();
    self.showToast('Reset ' + flagsWithOverrides.length + ' flags to defaults', 'success');
  }).catch(function (err) {
    self.showToast('Error during reset: ' + (err && err.message ? err.message : 'Unknown'), 'error');
    self.loadFlags();
  });
};

FeatureManagementPanel.prototype.handleExport = function () {
  var self = this;
  var api = fmEapi();
  if (!api) return;

  api.invoke('feature-gate:export').then(function (result) {
    if (!result || !result.success || !result.profile) {
      self.showToast('Export failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
      return;
    }
    // Create downloadable JSON
    var blob = new Blob([JSON.stringify(result.profile, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'neuronest-feature-profile-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    self.showToast('Profile exported successfully', 'success');
  }).catch(function (err) {
    self.showToast('Export error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
  });
};

FeatureManagementPanel.prototype.handleImport = function () {
  var self = this;
  var api = fmEapi();
  if (!api) return;

  // Create file input for import
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';

  input.addEventListener('change', function () {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var profile = JSON.parse(e.target.result);
        api.invoke('feature-gate:import', { profile: profile }).then(function (result) {
          if (result && result.success) {
            self.loadFlags();
            var msg = 'Imported ' + (result.imported || 0) + ' flags';
            if (result.skipped) msg += ', skipped ' + result.skipped;
            self.showToast(msg, 'success');
          } else {
            self.showToast('Import failed: ' + (result && result.error ? result.error : 'Unknown'), 'error');
          }
        }).catch(function (err) {
          self.showToast('Import error: ' + (err && err.message ? err.message : 'Unknown'), 'error');
        });
      } catch (parseErr) {
        self.showToast('Invalid JSON file', 'error');
      }
    };
    reader.readAsText(file);
  });

  document.body.appendChild(input);
  input.click();
  document.body.removeChild(input);
};

// ─── Toast Notification ────────────────────────────────────────────

FeatureManagementPanel.prototype.showToast = function (message, type) {
  var colors = {
    success: { bg: 'rgba(166,227,161,0.15)', color: '#a6e3a1', border: '#a6e3a1' },
    error: { bg: 'rgba(243,139,168,0.15)', color: '#f38ba8', border: '#f38ba8' },
    info: { bg: 'rgba(137,180,250,0.15)', color: '#89b4fa', border: '#89b4fa' },
  };
  var c = colors[type] || colors.info;

  var toast = fmCreateEl('div', 'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid ' + c.border + ';background:' + c.bg + ';color:' + c.color + ';box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;');
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

FeatureManagementPanel.prototype.destroy = function () {
  this.container.innerHTML = '';
  this.flags = [];
};

// ─── Exports ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FeatureManagementPanel: FeatureManagementPanel };
}
