// @ts-nocheck
/**
 * ExtensionsWorkspacePanel — Unified extensions, skills, and integrations management.
 *
 * Tabs:
 * 1. MCP — status, tools, catalog, install, enable, disable, uninstall
 * 2. Skill Packs — install, sync, remove, drift, eval, version
 * 3. Agent Skills — CRUD, search, assignment, events, usage, analytics, real-time
 * 4. Plugins — catalog, install, uninstall, enable, disable, permissions
 * 5. Powers — list, activate, deactivate, docs, status
 *
 * IPC channels:
 * - plugin:catalog, plugin:install, plugin:uninstall, plugin:enable, plugin:disable, plugin:permissions, plugin:list
 * - skill-packs:install, skill-packs:list, skill-packs:sync, skill-packs:remove, skill-packs:check-drift, skill-packs:run-eval
 * - agent-skills:get-skills, agent-skills:create-skill, agent-skills:update-skill, agent-skills:delete-skill,
 *   agent-skills:search-skills, agent-skills:assign-skill, agent-skills:get-usage-stats, agent-skills:get-skill-analytics
 * - powers:list, powers:activate, powers:deactivate
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Requirements: 6.1-6.9
 */

// ─── Constants ─────────────────────────────────────────────────────

var EXT_TABS = [
  { id: 'plugins', label: 'Plugins/MCP', icon: '\uD83D\uDD0C' },
  { id: 'skill-packs', label: 'Skill Packs', icon: '\uD83D\uDCE6' },
  { id: 'agent-skills', label: 'Agent Skills', icon: '\uD83E\uDDE0' },
  { id: 'powers', label: 'Powers', icon: '\u26A1' },
];

// ─── Helpers ───────────────────────────────────────────────────────

function extEsc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
function extApi() { return window.electronAPI; }
function extEl(tag, css, attrs) {
  var el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]); } }
  return el;
}
function extBadge(text, color) {
  return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:' + color + '22;color:' + color + ';font-weight:600;">' + extEsc(text) + '</span>';
}

// ─── Panel class ───────────────────────────────────────────────────

function ExtensionsWorkspacePanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || 'default';
  this.activeTab = 'plugins';
  this.tabContent = null;
}

ExtensionsWorkspacePanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  var header = extEl('h3', 'margin:0 0 12px;font-size:16px;color:var(--text-primary,#cdd6f4);');
  header.textContent = 'Extensions & Skills';
  this.container.appendChild(header);

  var tabBar = extEl('div', 'display:flex;gap:2px;margin-bottom:16px;border-bottom:1px solid var(--border-color,#45475a);overflow-x:auto;');
  for (var i = 0; i < EXT_TABS.length; i++) {
    (function (tab) {
      var btn = extEl('button',
        'padding:6px 12px;border:none;border-bottom:2px solid transparent;background:transparent;' +
        'color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:11px;white-space:nowrap;',
        { 'aria-label': tab.label + ' tab', role: 'tab' });
      btn.textContent = tab.icon + ' ' + tab.label;
      if (tab.id === self.activeTab) { btn.style.color = 'var(--accent-color,#89b4fa)'; btn.style.borderBottomColor = 'var(--accent-color,#89b4fa)'; }
      btn.addEventListener('click', function () { self.activeTab = tab.id; self.render(); });
      tabBar.appendChild(btn);
    })(EXT_TABS[i]);
  }
  this.container.appendChild(tabBar);

  this.tabContent = extEl('div', 'min-height:300px;');
  this.container.appendChild(this.tabContent);
  this.loadTab(this.activeTab);
};

ExtensionsWorkspacePanel.prototype.loadTab = function (id) {
  switch (id) {
    case 'plugins': this.renderPlugins(); break;
    case 'skill-packs': this.renderSkillPacks(); break;
    case 'agent-skills': this.renderAgentSkills(); break;
    case 'powers': this.renderPowers(); break;
  }
};

// ─── Plugins/MCP Tab ───────────────────────────────────────────────

ExtensionsWorkspacePanel.prototype.renderPlugins = function () {
  var self = this; var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading plugins...</div>';
  var api = extApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  Promise.all([api.invoke('plugin:list', {}), api.invoke('plugin:catalog', {})]).then(function (res) {
    el.innerHTML = '';
    var installed = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].plugins) || [];
    var catalog = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].catalog) || [];

    // Installed section
    var instHeader = extEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;');
    instHeader.textContent = 'Installed (' + installed.length + ')';
    el.appendChild(instHeader);

    if (installed.length === 0) {
      var emptyMsg = extEl('div', 'font-size:11px;color:var(--text-muted,#6c7086);margin-bottom:16px;');
      emptyMsg.textContent = 'No plugins installed. Browse the catalog below.';
      el.appendChild(emptyMsg);
    } else {
      for (var i = 0; i < installed.length; i++) {
        el.appendChild(self.renderPluginCard(installed[i], true));
      }
    }

    // Catalog section
    if (catalog.length > 0) {
      var catHeader = extEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin:16px 0 8px;');
      catHeader.textContent = 'Catalog (' + catalog.length + ')';
      el.appendChild(catHeader);
      for (var j = 0; j < Math.min(catalog.length, 20); j++) {
        el.appendChild(self.renderPluginCard(catalog[j], false));
      }
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load plugins</div>'; });
};

ExtensionsWorkspacePanel.prototype.renderPluginCard = function (plugin, isInstalled) {
  var self = this; var api = extApi();
  var card = extEl('div', 'padding:10px 12px;margin-bottom:6px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
  var enabled = plugin.enabled !== false;

  card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
    '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + extEsc(plugin.name || plugin.id) + '</span>' +
    (isInstalled ? extBadge(enabled ? 'enabled' : 'disabled', enabled ? '#a6e3a1' : '#6c7086') : extBadge('available', '#cba6f7')) + '</div>' +
    '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:3px;">' + extEsc(plugin.description || '') + '</div>';

  var actions = extEl('div', 'display:flex;gap:4px;margin-top:6px;');
  if (isInstalled) {
    var toggleBtn = extEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    toggleBtn.textContent = enabled ? 'Disable' : 'Enable';
    toggleBtn.addEventListener('click', function () { api.invoke(enabled ? 'plugin:disable' : 'plugin:enable', { id: plugin.id }).then(function () { self.renderPlugins(); }).catch(function () {}); });
    actions.appendChild(toggleBtn);
    var uninstBtn = extEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #f38ba8;background:transparent;color:#f38ba8;cursor:pointer;');
    uninstBtn.textContent = 'Uninstall';
    uninstBtn.addEventListener('click', function () { if (confirm('Uninstall ' + (plugin.name || plugin.id) + '?')) api.invoke('plugin:uninstall', { id: plugin.id }).then(function () { self.renderPlugins(); }).catch(function () {}); });
    actions.appendChild(uninstBtn);
  } else {
    var installBtn = extEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #a6e3a1;background:transparent;color:#a6e3a1;cursor:pointer;');
    installBtn.textContent = 'Install';
    installBtn.addEventListener('click', function () { api.invoke('plugin:install', { id: plugin.id }).then(function () { self.renderPlugins(); }).catch(function () {}); });
    actions.appendChild(installBtn);
  }
  card.appendChild(actions);
  return card;
};

// ─── Skill Packs Tab ───────────────────────────────────────────────

ExtensionsWorkspacePanel.prototype.renderSkillPacks = function () {
  var self = this; var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading skill packs...</div>';
  var api = extApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('skill-packs:list', {}).then(function (result) {
    el.innerHTML = '';
    var packs = Array.isArray(result) ? result : (result && result.packs) || [];

    var actBar = extEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var installBtn = extEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    installBtn.textContent = '+ Install Pack';
    installBtn.addEventListener('click', function () { api.invoke('skill-packs:install', {}).catch(function () {}); });
    actBar.appendChild(installBtn);
    var syncBtn = extEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    syncBtn.textContent = '\uD83D\uDD04 Sync All';
    syncBtn.addEventListener('click', function () { api.invoke('skill-packs:sync', {}).catch(function () {}); });
    actBar.appendChild(syncBtn);
    el.appendChild(actBar);

    if (packs.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);"><div style="font-size:24px;margin-bottom:8px;">\uD83D\uDCE6</div>No skill packs installed.</div>';
      return;
    }

    for (var i = 0; i < packs.length; i++) {
      var p = packs[i];
      var card = extEl('div', 'padding:10px 12px;margin-bottom:6px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + extEsc(p.name || p.id) + '</span>' +
        extBadge('v' + (p.version || '?'), '#89b4fa') + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:3px;">' +
        (p.skillCount || 0) + ' skills | ' + (p.driftStatus || 'synced') + '</div>';

      var actions = extEl('div', 'display:flex;gap:4px;margin-top:6px;');
      (function (pack) {
        var driftBtn = extEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
        driftBtn.textContent = 'Check Drift';
        driftBtn.addEventListener('click', function () { api.invoke('skill-packs:check-drift', { packId: pack.id }).catch(function () {}); });
        actions.appendChild(driftBtn);
        var evalBtn = extEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
        evalBtn.textContent = 'Run Eval';
        evalBtn.addEventListener('click', function () { api.invoke('skill-packs:run-eval', { packId: pack.id }).catch(function () {}); });
        actions.appendChild(evalBtn);
        var rmBtn = extEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #f38ba8;background:transparent;color:#f38ba8;cursor:pointer;');
        rmBtn.textContent = 'Remove';
        rmBtn.addEventListener('click', function () { if (confirm('Remove pack ' + (pack.name || pack.id) + '?')) api.invoke('skill-packs:remove', { packId: pack.id }).then(function () { self.renderSkillPacks(); }).catch(function () {}); });
        actions.appendChild(rmBtn);
      })(p);
      card.appendChild(actions);
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load skill packs</div>'; });
};

// ─── Agent Skills Tab ──────────────────────────────────────────────

ExtensionsWorkspacePanel.prototype.renderAgentSkills = function () {
  var self = this; var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading agent skills...</div>';
  var api = extApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('agent-skills:get-skills', {}).then(function (result) {
    el.innerHTML = '';
    var skills = Array.isArray(result) ? result : (result && result.skills) || [];

    var actBar = extEl('div', 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;');
    var createBtn = extEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    createBtn.textContent = '+ Create Skill';
    createBtn.addEventListener('click', function () { api.invoke('agent-skills:create-skill', {}).catch(function () {}); });
    actBar.appendChild(createBtn);
    var statsBtn = extEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    statsBtn.textContent = '\uD83D\uDCCA Usage Stats';
    statsBtn.addEventListener('click', function () { api.invoke('agent-skills:get-usage-stats', {}).then(function (s) { if (s) alert(JSON.stringify(s, null, 2)); }).catch(function () {}); });
    actBar.appendChild(statsBtn);
    el.appendChild(actBar);

    // Search
    var searchWrap = extEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var searchInput = extEl('input', 'flex:1;padding:6px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);background:var(--input-bg,#1e1e2e);color:var(--text-primary,#cdd6f4);font-size:12px;outline:none;', { placeholder: 'Search skills...', 'aria-label': 'Search agent skills' });
    var searchBtn = extEl('button', 'padding:6px 12px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-size:12px;font-weight:600;');
    searchBtn.textContent = 'Search';
    searchBtn.addEventListener('click', function () {
      var q = searchInput.value.trim(); if (!q) return;
      api.invoke('agent-skills:search-skills', { query: q }).then(function (r) {
        var results = Array.isArray(r) ? r : (r && r.skills) || [];
        self.showSkillResults(results, el);
      }).catch(function () {});
    });
    searchWrap.appendChild(searchInput); searchWrap.appendChild(searchBtn);
    el.appendChild(searchWrap);

    if (skills.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-secondary,#a6adc8);"><div style="font-size:24px;margin-bottom:8px;">\uD83E\uDDE0</div>No agent skills found.</div>';
      return;
    }

    self._skillListEl = extEl('div', '');
    el.appendChild(self._skillListEl);
    self.showSkillResults(skills, self._skillListEl);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load agent skills</div>'; });
};

ExtensionsWorkspacePanel.prototype.showSkillResults = function (skills, container) {
  if (!container) return;
  container.innerHTML = '';
  for (var i = 0; i < skills.length; i++) {
    var s = skills[i];
    var card = extEl('div', 'padding:8px 12px;margin-bottom:6px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
    var scopeBadge = s.scope === 'agent' ? extBadge('agent', '#cba6f7') : extBadge('generic', '#89b4fa');
    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + extEsc(s.name || s.id) + '</span>' +
      scopeBadge + '</div>' +
      '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:3px;">' +
      extEsc(s.description || '') + '</div>' +
      '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:2px;">' +
      'Source: ' + extEsc(s.source || 'local') + ' | Category: ' + extEsc(s.category || '-') + '</div>';
    container.appendChild(card);
  }
};

// ─── Powers Tab ────────────────────────────────────────────────────

ExtensionsWorkspacePanel.prototype.renderPowers = function () {
  var self = this; var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading powers...</div>';
  var api = extApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;">IPC unavailable</div>'; return; }

  api.invoke('powers:list', {}).then(function (result) {
    el.innerHTML = '';
    var powers = Array.isArray(result) ? result : (result && result.powers) || [];

    if (powers.length === 0) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);"><div style="font-size:24px;margin-bottom:8px;">\u26A1</div>No powers available.</div>';
      return;
    }

    for (var i = 0; i < powers.length; i++) {
      var p = powers[i];
      var card = extEl('div', 'padding:10px 12px;margin-bottom:6px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
      var active = p.active || p.enabled;
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + extEsc(p.name || p.id) + '</span>' +
        extBadge(active ? 'active' : 'inactive', active ? '#a6e3a1' : '#6c7086') + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:3px;">' + extEsc(p.description || '') + '</div>';

      var actions = extEl('div', 'display:flex;gap:4px;margin-top:6px;');
      (function (power, isActive) {
        var toggleBtn = extEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid ' + (isActive ? '#f38ba8' : '#a6e3a1') + ';background:transparent;color:' + (isActive ? '#f38ba8' : '#a6e3a1') + ';cursor:pointer;');
        toggleBtn.textContent = isActive ? 'Deactivate' : 'Activate';
        toggleBtn.addEventListener('click', function () {
          api.invoke(isActive ? 'powers:deactivate' : 'powers:activate', { powerId: power.id }).then(function () { self.renderPowers(); }).catch(function () {});
        });
        actions.appendChild(toggleBtn);
      })(p, active);
      card.appendChild(actions);
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load powers</div>'; });
};

// ─── Cleanup & Exports ─────────────────────────────────────────────

ExtensionsWorkspacePanel.prototype.destroy = function () {
  if (this.container) this.container.innerHTML = '';
};

if (typeof window !== 'undefined') {
  window.ExtensionsWorkspacePanel = ExtensionsWorkspacePanel;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExtensionsWorkspacePanel: ExtensionsWorkspacePanel };
}
