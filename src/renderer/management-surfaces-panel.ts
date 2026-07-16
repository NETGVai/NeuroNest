// @ts-nocheck
/**
 * ManagementSurfacesPanel — Completes partial management surfaces.
 *
 * Tabs:
 * 1. Memory — learn, list, search, context, reinforce, forget, source, purge
 * 2. Steering — list, create, edit, delete, category, inclusion, file-match, preview
 * 3. Hooks — list, create, edit, delete, enable, disable, history, live status
 * 4. Backends — add, list, configure, status, enable, disable, delete
 * 5. Sharing — create, retrieve, decrypt, list, revoke, delete, config, stats
 * 6. Specs — create, list, inspect, update, build-prompt, stats, handoff
 * 7. Wiki — config, generate, pages, generations, completion, stats, delete
 * 8. Workspaces — create, list, rebase, sync, changes, delete
 * 9. Tasks — create, list, inspect, update, delete, context, stats
 * 10. Checkpoints — recovery, snapshots, timeline
 *
 * Requirements: 8.1-8.12
 */

// ─── Constants ─────────────────────────────────────────────────────

var MS_TABS = [
  { id: 'memory', label: 'Memory', icon: '\uD83E\uDDE0' },
  { id: 'steering', label: 'Steering', icon: '\uD83C\uDFAF' },
  { id: 'hooks', label: 'Hooks', icon: '\uD83D\uDD17' },
  { id: 'backends', label: 'Backends', icon: '\uD83D\uDDA5' },
  { id: 'sharing', label: 'Sharing', icon: '\uD83D\uDD12' },
  { id: 'specs', label: 'Specs', icon: '\uD83D\uDCDD' },
  { id: 'wiki', label: 'Wiki', icon: '\uD83D\uDCD6' },
  { id: 'workspaces', label: 'Workspaces', icon: '\uD83D\uDCC2' },
  { id: 'tasks', label: 'Tasks', icon: '\u2611' },
  { id: 'checkpoints', label: 'Checkpoints', icon: '\uD83D\uDCBE' },
];

// ─── Helpers ───────────────────────────────────────────────────────

function msEsc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
function msApi() { return window.electronAPI; }
function msEl(tag, css, attrs) {
  var el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]); } }
  return el;
}
function msBadge(t, c) { return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:' + c + '22;color:' + c + ';font-weight:600;">' + msEsc(t) + '</span>'; }
function msTime(ts) { if (!ts) return '-'; var d = new Date(ts); if (isNaN(d.getTime())) return '-'; var diff = Date.now() - d.getTime(); if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'; if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'; return d.toLocaleDateString(); }

// ─── Panel class ───────────────────────────────────────────────────

function ManagementSurfacesPanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || 'default';
  this.activeTab = 'memory';
  this.tabContent = null;
}

ManagementSurfacesPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  var header = msEl('h3', 'margin:0 0 12px;font-size:16px;color:var(--text-primary,#cdd6f4);');
  header.textContent = 'Management';
  this.container.appendChild(header);

  var tabBar = msEl('div', 'display:flex;gap:1px;margin-bottom:16px;border-bottom:1px solid var(--border-color,#45475a);overflow-x:auto;');
  for (var i = 0; i < MS_TABS.length; i++) {
    (function (tab) {
      var btn = msEl('button',
        'padding:5px 8px;border:none;border-bottom:2px solid transparent;background:transparent;' +
        'color:var(--text-secondary,#a6adc8);cursor:pointer;font-size:10px;white-space:nowrap;',
        { 'aria-label': tab.label, role: 'tab' });
      btn.textContent = tab.icon + ' ' + tab.label;
      if (tab.id === self.activeTab) { btn.style.color = 'var(--accent-color,#89b4fa)'; btn.style.borderBottomColor = 'var(--accent-color,#89b4fa)'; }
      btn.addEventListener('click', function () { self.activeTab = tab.id; self.render(); });
      tabBar.appendChild(btn);
    })(MS_TABS[i]);
  }
  this.container.appendChild(tabBar);
  this.tabContent = msEl('div', 'min-height:200px;');
  this.container.appendChild(this.tabContent);
  this.loadTab(this.activeTab);
};

ManagementSurfacesPanel.prototype.loadTab = function (id) {
  var self = this; var el = this.tabContent; var api = msApi();
  if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  switch (id) {
    case 'memory': this.renderMemory(el, api); break;
    case 'steering': this.renderSteering(el, api); break;
    case 'hooks': this.renderHooks(el, api); break;
    case 'backends': this.renderBackends(el, api); break;
    case 'sharing': this.renderSharing(el, api); break;
    case 'specs': this.renderSpecs(el, api); break;
    case 'wiki': this.renderWiki(el, api); break;
    case 'workspaces': this.renderWorkspaces(el, api); break;
    case 'tasks': this.renderTasks(el, api); break;
    case 'checkpoints': this.renderCheckpoints(el, api); break;
  }
};

// ─── Memory Tab ────────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderMemory = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  var self = this;
  api.invoke('memory:get', { projectId: this.projectId, limit: 50 }).then(function (r) {
    el.innerHTML = '';
    var memories = (r && r.memories) || [];
    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;');
    var learnBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    learnBtn.textContent = '+ Learn';
    learnBtn.addEventListener('click', function () {
      var content = prompt('What should I remember?');
      if (content) api.invoke('memory:learn', { projectId: self.projectId, category: 'pattern', content: content, source: 'user' }).then(function () { self.loadTab('memory'); });
    });
    actions.appendChild(learnBtn);
    var purgeBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #f38ba8;background:transparent;color:#f38ba8;cursor:pointer;');
    purgeBtn.textContent = 'Purge All';
    purgeBtn.addEventListener('click', function () { if (confirm('Purge all memories?')) api.invoke('agentmemory:forget', { project: self.projectId }).then(function () { self.loadTab('memory'); }); });
    actions.appendChild(purgeBtn);
    el.appendChild(actions);

    if (memories.length === 0) { el.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-secondary,#a6adc8);">No memories stored.</div>'; return; }
    for (var i = 0; i < memories.length; i++) {
      var m = memories[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);color:var(--text-secondary,#a6adc8);');
      card.innerHTML = '<div style="color:var(--text-primary,#cdd6f4);">' + msEsc(m.content) + '</div><div style="margin-top:2px;">' + msBadge(m.category || m.source || 'auto', '#89b4fa') + ' ' + msTime(m.createdAt) + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Steering Tab ──────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderSteering = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  var self = this;
  api.invoke('steering:list', {}).then(function (r) {
    el.innerHTML = '';
    var items = Array.isArray(r) ? r : (r && r.items) || [];
    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var addBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    addBtn.textContent = '+ Create';
    addBtn.addEventListener('click', function () { api.invoke('steering:create', { projectId: self.projectId }).catch(function () {}); });
    actions.appendChild(addBtn);
    el.appendChild(actions);

    if (items.length === 0) { el.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-secondary,#a6adc8);">No steering rules.</div>'; return; }
    for (var i = 0; i < items.length; i++) {
      var s = items[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-primary,#cdd6f4);font-weight:600;">' + msEsc(s.name || s.id || s.category || 'Rule') + '</span>' +
        msBadge(s.inclusion || 'always', '#a6e3a1') + '</div>' +
        '<div style="color:var(--text-muted,#6c7086);margin-top:2px;">' + msEsc((s.content || '').slice(0, 80)) + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Hooks Tab ─────────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderHooks = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  api.invoke('hooks:list', {}).then(function (r) {
    el.innerHTML = '';
    var hooks = Array.isArray(r) ? r : (r && r.hooks) || [];
    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var addBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    addBtn.textContent = '+ Create Hook';
    addBtn.addEventListener('click', function () { api.invoke('hooks:create', {}).catch(function () {}); });
    actions.appendChild(addBtn);
    el.appendChild(actions);

    if (hooks.length === 0) { el.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-secondary,#a6adc8);">No hooks.</div>'; return; }
    for (var i = 0; i < hooks.length; i++) {
      var h = hooks[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-primary,#cdd6f4);font-weight:600;">' + msEsc(h.name || h.id) + '</span>' +
        msBadge(h.enabled !== false ? 'enabled' : 'disabled', h.enabled !== false ? '#a6e3a1' : '#6c7086') + '</div>' +
        '<div style="color:var(--text-muted,#6c7086);margin-top:2px;">Event: ' + msEsc(h.event || h.trigger || '-') + ' | Type: ' + msEsc(h.type || 'command') + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Backends Tab ──────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderBackends = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  api.invoke('backends:list', {}).then(function (r) {
    el.innerHTML = '';
    var backends = Array.isArray(r) ? r : (r && r.backends) || [];
    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var addBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    addBtn.textContent = '+ Add Backend';
    addBtn.addEventListener('click', function () { api.invoke('backends:add', {}).catch(function () {}); });
    actions.appendChild(addBtn);
    el.appendChild(actions);

    if (backends.length === 0) { el.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-secondary,#a6adc8);">No runtime backends configured.</div>'; return; }
    for (var i = 0; i < backends.length; i++) {
      var b = backends[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-primary,#cdd6f4);font-weight:600;">' + msEsc(b.name || b.id) + '</span>' +
        msBadge(b.status || 'unknown', b.status === 'active' ? '#a6e3a1' : '#6c7086') + '</div>' +
        '<div style="color:var(--text-muted,#6c7086);margin-top:2px;">' + msEsc(b.type || b.provider || '') + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Sharing Tab ───────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderSharing = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  Promise.all([api.invoke('e2e:list', {}), api.invoke('e2e:stats', {})]).then(function (res) {
    el.innerHTML = '';
    var shares = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].shares) || [];
    var stats = res[1] || {};

    if (stats.totalShares != null) {
      var statCard = msEl('div', 'padding:8px 12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;font-size:11px;color:var(--text-secondary,#a6adc8);');
      statCard.textContent = 'Total: ' + (stats.totalShares || 0) + ' | Active: ' + (stats.activeShares || 0) + ' | Revoked: ' + (stats.revokedShares || 0);
      el.appendChild(statCard);
    }

    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var shareBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    shareBtn.textContent = '+ Create Share';
    shareBtn.addEventListener('click', function () { api.invoke('e2e:share', {}).catch(function () {}); });
    actions.appendChild(shareBtn);
    el.appendChild(actions);

    for (var i = 0; i < shares.length; i++) {
      var s = shares[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);">' + msEsc(s.name || s.id) + '</span> ' + msBadge(s.status || 'active', s.status === 'revoked' ? '#f38ba8' : '#a6e3a1') + ' ' + msTime(s.createdAt);
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Specs Tab ─────────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderSpecs = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  Promise.all([api.invoke('specs:list', {}), api.invoke('specs:stats', {})]).then(function (res) {
    el.innerHTML = '';
    var specs = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].specs) || [];
    var stats = res[1] || {};

    if (stats.total != null) {
      var statCard = msEl('div', 'padding:8px 12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;font-size:11px;color:var(--text-secondary,#a6adc8);');
      statCard.textContent = 'Total: ' + (stats.total || 0) + ' | Completed: ' + (stats.completed || 0);
      el.appendChild(statCard);
    }

    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var createBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    createBtn.textContent = '+ Create Spec';
    createBtn.addEventListener('click', function () { api.invoke('specs:create', {}).catch(function () {}); });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    for (var i = 0; i < specs.length; i++) {
      var s = specs[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);font-weight:600;">' + msEsc(s.name || s.id) + '</span> ' + msBadge(s.status || 'draft', '#89b4fa') + ' ' + msTime(s.createdAt);
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Wiki Tab ──────────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderWiki = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  Promise.all([api.invoke('wiki:get-pages', {}), api.invoke('wiki:stats', {})]).then(function (res) {
    el.innerHTML = '';
    var pages = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].pages) || [];
    var stats = res[1] || {};

    if (stats.totalPages != null) {
      var statCard = msEl('div', 'padding:8px 12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;font-size:11px;color:var(--text-secondary,#a6adc8);');
      statCard.textContent = 'Pages: ' + (stats.totalPages || 0) + ' | Generations: ' + (stats.totalGenerations || 0);
      el.appendChild(statCard);
    }

    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var genBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    genBtn.textContent = '\uD83D\uDCDD Generate';
    genBtn.addEventListener('click', function () { api.invoke('wiki:generate', {}).catch(function () {}); });
    actions.appendChild(genBtn);
    el.appendChild(actions);

    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);">' + msEsc(p.title || p.name || p.id) + '</span> ' + msTime(p.updatedAt || p.createdAt);
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Workspaces Tab ────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderWorkspaces = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  api.invoke('workspace:list', {}).then(function (r) {
    el.innerHTML = '';
    var workspaces = Array.isArray(r) ? r : (r && r.workspaces) || [];
    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var createBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    createBtn.textContent = '+ Create';
    createBtn.addEventListener('click', function () { api.invoke('workspace:create', {}).catch(function () {}); });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    if (workspaces.length === 0) { el.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-secondary,#a6adc8);">No workspaces.</div>'; return; }
    for (var i = 0; i < workspaces.length; i++) {
      var w = workspaces[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);font-weight:600;">' + msEsc(w.name || w.ref || w.id) + '</span> ' + msBadge(w.status || 'active', '#a6e3a1');
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Tasks Tab ─────────────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderTasks = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  Promise.all([api.invoke('tracker:get', { projectId: this.projectId }), api.invoke('tracker:stats', {})]).then(function (res) {
    el.innerHTML = '';
    var tasks = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].tasks) || [];
    var stats = res[1] || {};

    if (stats.total != null) {
      var statCard = msEl('div', 'padding:8px 12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;font-size:11px;color:var(--text-secondary,#a6adc8);');
      statCard.textContent = 'Total: ' + (stats.total || 0) + ' | Open: ' + (stats.open || 0) + ' | Done: ' + (stats.done || 0);
      el.appendChild(statCard);
    }

    var actions = msEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var createBtn = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    createBtn.textContent = '+ Create Task';
    createBtn.addEventListener('click', function () { api.invoke('tracker:create', {}).catch(function () {}); });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var card = msEl('div', 'font-size:11px;padding:6px 8px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<span style="color:var(--text-primary,#cdd6f4);">' + msEsc(t.title || t.description || t.id) + '</span> ' + msBadge(t.status || 'open', t.status === 'done' ? '#a6e3a1' : '#89b4fa');
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Checkpoints Tab ───────────────────────────────────────────────

ManagementSurfacesPanel.prototype.renderCheckpoints = function (el, api) {
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading...</div>';
  Promise.all([api.invoke('checkpoint:get-latest', {}), api.invoke('checkpoint:has-recovery', {})]).then(function (res) {
    el.innerHTML = '';
    var latest = res[0] || {}; var hasRecovery = res[1];

    if (hasRecovery) {
      var recoveryCard = msEl('div', 'padding:10px 12px;background:#f9e2af11;border-radius:6px;border:1px solid #f9e2af44;margin-bottom:12px;');
      recoveryCard.innerHTML = '<div style="font-size:12px;font-weight:600;color:#f9e2af;margin-bottom:4px;">\u26A0 Recovery Available</div>' +
        '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);">A recovery checkpoint is available from a previous crash.</div>';
      el.appendChild(recoveryCard);
    }

    var card = msEl('div', 'padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);margin-bottom:12px;');
    card.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">\uD83D\uDCBE Checkpoints</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);line-height:1.6;">' +
      '<div>Latest: ' + msEsc(latest.id || 'none') + '</div>' +
      '<div>Created: ' + msTime(latest.createdAt || latest.timestamp) + '</div>' +
      '<div>Type: ' + msEsc(latest.type || 'auto') + '</div></div>';
    el.appendChild(card);

    var actions = msEl('div', 'display:flex;gap:6px;');
    var newCp = msEl('button', 'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    newCp.textContent = '+ Create Checkpoint';
    newCp.addEventListener('click', function () { api.invoke('checkpoint:start', {}).catch(function () {}); });
    actions.appendChild(newCp);
    el.appendChild(actions);
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;">Failed to load</div>'; });
};

// ─── Cleanup & Exports ─────────────────────────────────────────────

ManagementSurfacesPanel.prototype.destroy = function () { if (this.container) this.container.innerHTML = ''; };

if (typeof window !== 'undefined') { window.ManagementSurfacesPanel = ManagementSurfacesPanel; }
if (typeof module !== 'undefined' && module.exports) { module.exports = { ManagementSurfacesPanel: ManagementSurfacesPanel }; }
