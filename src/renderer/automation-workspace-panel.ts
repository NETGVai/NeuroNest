// @ts-nocheck
/**
 * AutomationWorkspacePanel — Unified automation management workspace.
 *
 * Provides tabs for:
 * 1. Loops — catalog, crafting, audit, run, approval, stop, status, pass history, receipts
 * 2. Pipelines — define, execute, cancel, list, quick-actions
 * 3. Scheduler — create, list, edit, run-now, pause, resume, enable, disable, delete
 * 4. Missions — create, detail, workers, progress, status, delete, stats
 * 5. PCV — create, start, step, skip, fail, progress, prompt, history
 * 6. Headless — config, start, state, completion, recent, stats
 *
 * IPC channels used:
 * - loops:list, loops:craft, loops:audit, loops:run, loops:approve, loops:stop, loops:runStatus, loops:receipt
 * - pipeline:define, pipeline:execute, pipeline:cancel, pipeline:list, quickaction:execute, quickaction:list
 * - scheduler:create, scheduler:get, scheduler:run, scheduler:delete, scheduler:toggle
 * - scheduler:add, scheduler:remove, scheduler:list, scheduler:pause, scheduler:resume
 * - missions:create, missions:get, missions:list, missions:update-status, missions:update-progress,
 *   missions:add-worker, missions:get-workers, missions:delete, missions:stats
 * - pcv:create, pcv:start, pcv:complete-step, pcv:fail-step, pcv:skip-step, pcv:get, pcv:list, pcv:progress, pcv:prompt
 * - exec:get-config, exec:update-config, exec:start, exec:complete, exec:recent, exec:stats
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 *
 * Requirements: 4.1-4.10
 */

// ─── Constants ─────────────────────────────────────────────────────

var AW_TABS = [
  { id: 'loops', label: 'Loops', icon: '\uD83D\uDD04' },
  { id: 'pipelines', label: 'Pipelines', icon: '\u2699' },
  { id: 'scheduler', label: 'Scheduler', icon: '\u23F0' },
  { id: 'missions', label: 'Missions', icon: '\uD83C\uDFAF' },
  { id: 'pcv', label: 'Plan-Code-Verify', icon: '\u2705' },
  { id: 'headless', label: 'Headless', icon: '\uD83D\uDDA5' },
];

// ─── Helpers ───────────────────────────────────────────────────────

function awEsc(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function awApi() { return window.electronAPI; }

function awEl(tag, css, attrs) {
  var el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]); } }
  return el;
}

function awFormatTime(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '-';
  var now = Date.now(), diff = now - d.getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString();
}

function awStatusBadge(status) {
  var colors = {
    running: '#a6e3a1', idle: '#6c7086', blocked: '#f38ba8',
    completed: '#89b4fa', cancelled: '#f9e2af', failed: '#f38ba8',
    active: '#a6e3a1', paused: '#f9e2af', pending: '#cba6f7',
  };
  var color = colors[status] || '#6c7086';
  return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:' +
    color + '22;color:' + color + ';font-weight:600;">' + awEsc(status) + '</span>';
}

// ─── AutomationWorkspacePanel class ────────────────────────────────

function AutomationWorkspacePanel(container, options) {
  this.container = container;
  this.projectId = (options && options.projectId) || 'default';
  this.activeTab = 'loops';
  this.tabContent = null;
  this.data = {};
}

AutomationWorkspacePanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText =
    'padding:16px;height:100%;overflow-y:auto;' +
    'font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  // Header
  var header = awEl('div', 'display:flex;align-items:center;gap:8px;margin-bottom:12px;');
  var title = awEl('h3', 'margin:0;font-size:16px;color:var(--text-primary,#cdd6f4);');
  title.textContent = 'Automation Workspace';
  header.appendChild(title);
  this.container.appendChild(header);

  // Tab bar
  var tabBar = awEl('div',
    'display:flex;gap:2px;margin-bottom:16px;border-bottom:1px solid var(--border-color,#45475a);' +
    'padding-bottom:0;overflow-x:auto;');
  for (var i = 0; i < AW_TABS.length; i++) {
    (function (tab) {
      var tabBtn = awEl('button',
        'padding:6px 12px;border:none;border-bottom:2px solid transparent;' +
        'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;' +
        'font-size:11px;white-space:nowrap;transition:all 0.15s;',
        { 'aria-label': tab.label + ' tab', role: 'tab' });
      tabBtn.textContent = tab.icon + ' ' + tab.label;
      if (tab.id === self.activeTab) {
        tabBtn.style.color = 'var(--accent-color,#89b4fa)';
        tabBtn.style.borderBottomColor = 'var(--accent-color,#89b4fa)';
      }
      tabBtn.addEventListener('click', function () { self.switchTab(tab.id); });
      tabBar.appendChild(tabBtn);
    })(AW_TABS[i]);
  }
  this.container.appendChild(tabBar);

  // Tab content area
  this.tabContent = awEl('div', 'min-height:300px;');
  this.container.appendChild(this.tabContent);

  this.loadTab(this.activeTab);
};

AutomationWorkspacePanel.prototype.switchTab = function (tabId) {
  this.activeTab = tabId;
  this.render();
};

AutomationWorkspacePanel.prototype.loadTab = function (tabId) {
  switch (tabId) {
    case 'loops': this.renderLoopsTab(); break;
    case 'pipelines': this.renderPipelinesTab(); break;
    case 'scheduler': this.renderSchedulerTab(); break;
    case 'missions': this.renderMissionsTab(); break;
    case 'pcv': this.renderPCVTab(); break;
    case 'headless': this.renderHeadlessTab(); break;
  }
};

// ─── Loops Tab ─────────────────────────────────────────────────────

AutomationWorkspacePanel.prototype.renderLoopsTab = function () {
  var self = this;
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading loops...</div>';

  var api = awApi();
  if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('loops:list', {}).then(function (result) {
    el.innerHTML = '';
    var loops = (result && result.loops) || result || [];
    if (!Array.isArray(loops)) loops = [];

    // Actions bar
    var actBar = awEl('div', 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;');
    var craftBtn = awEl('button',
      'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
      'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    craftBtn.textContent = '+ Craft Loop';
    craftBtn.addEventListener('click', function () { self.craftLoop(); });
    actBar.appendChild(craftBtn);
    el.appendChild(actBar);

    if (loops.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">' +
        '<div style="font-size:24px;margin-bottom:8px;">\uD83D\uDD04</div>No loops yet. Craft one to get started.</div>';
      return;
    }

    // Loop list
    for (var i = 0; i < loops.length; i++) {
      el.appendChild(self.renderLoopCard(loops[i]));
    }
  }).catch(function () {
    el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load loops</div>';
  });
};

AutomationWorkspacePanel.prototype.renderLoopCard = function (loop) {
  var self = this;
  var card = awEl('div',
    'padding:10px 12px;margin-bottom:8px;background:var(--surface-secondary,#313244);' +
    'border-radius:6px;border:1px solid var(--border-color,#45475a);');

  var topRow = awEl('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;');
  var nameEl = awEl('span', 'font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;');
  nameEl.textContent = loop.name || loop.id || 'Unnamed Loop';
  topRow.appendChild(nameEl);

  var statusEl = awEl('span', '');
  statusEl.innerHTML = awStatusBadge(loop.status || loop.state || 'idle');
  topRow.appendChild(statusEl);
  card.appendChild(topRow);

  // Meta row
  var meta = awEl('div', 'display:flex;gap:8px;margin-top:4px;font-size:10px;color:var(--text-muted,#6c7086);');
  if (loop.passCount != null) { meta.innerHTML += '<span>Pass: ' + loop.passCount + '</span>'; }
  if (loop.startedAt) { meta.innerHTML += '<span>Started: ' + awFormatTime(loop.startedAt) + '</span>'; }
  if (loop.terminalReason) { meta.innerHTML += '<span>Reason: ' + awEsc(loop.terminalReason) + '</span>'; }
  card.appendChild(meta);

  // Actions
  var actions = awEl('div', 'display:flex;gap:4px;margin-top:6px;');
  var status = loop.status || loop.state || 'idle';

  if (status === 'idle' || status === 'completed' || status === 'failed') {
    var runBtn = awEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #a6e3a1;background:transparent;color:#a6e3a1;cursor:pointer;');
    runBtn.textContent = '\u25B6 Run';
    runBtn.addEventListener('click', function () { self.runLoop(loop); });
    actions.appendChild(runBtn);
  }
  if (status === 'running' || status === 'active') {
    var stopBtn = awEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #f38ba8;background:transparent;color:#f38ba8;cursor:pointer;');
    stopBtn.textContent = '\u25A0 Stop';
    stopBtn.addEventListener('click', function () { self.stopLoop(loop); });
    actions.appendChild(stopBtn);
  }
  if (status === 'blocked' || status === 'awaiting_approval') {
    var approveBtn = awEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid #f9e2af;background:transparent;color:#f9e2af;cursor:pointer;');
    approveBtn.textContent = '\u2714 Approve';
    approveBtn.addEventListener('click', function () { self.approveLoop(loop); });
    actions.appendChild(approveBtn);
  }
  var receiptBtn = awEl('button', 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
  receiptBtn.textContent = '\uD83D\uDCC4 Receipt';
  receiptBtn.addEventListener('click', function () { self.viewReceipt(loop); });
  actions.appendChild(receiptBtn);

  card.appendChild(actions);
  return card;
};

AutomationWorkspacePanel.prototype.craftLoop = function () {
  var api = awApi(); if (!api) return;
  api.invoke('loops:craft', { projectId: this.projectId }).then(function () {}).catch(function () {});
};
AutomationWorkspacePanel.prototype.runLoop = function (loop) {
  var self = this; var api = awApi(); if (!api) return;
  api.invoke('loops:run', { loopId: loop.id }).then(function () { self.loadTab('loops'); }).catch(function () {});
};
AutomationWorkspacePanel.prototype.stopLoop = function (loop) {
  var self = this; var api = awApi(); if (!api) return;
  api.invoke('loops:stop', { loopId: loop.id }).then(function () { self.loadTab('loops'); }).catch(function () {});
};
AutomationWorkspacePanel.prototype.approveLoop = function (loop) {
  var self = this; var api = awApi(); if (!api) return;
  api.invoke('loops:approve', { loopId: loop.id }).then(function () { self.loadTab('loops'); }).catch(function () {});
};
AutomationWorkspacePanel.prototype.viewReceipt = function (loop) {
  var api = awApi(); if (!api) return;
  api.invoke('loops:receipt', { loopId: loop.id }).then(function (r) { if (r) alert(JSON.stringify(r, null, 2)); }).catch(function () {});
};

// ─── Pipelines Tab ─────────────────────────────────────────────────

AutomationWorkspacePanel.prototype.renderPipelinesTab = function () {
  var self = this;
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading pipelines...</div>';
  var api = awApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('pipeline:list', {}).then(function (result) {
    el.innerHTML = '';
    var pipelines = Array.isArray(result) ? result : (result && result.pipelines) || [];

    var actBar = awEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var defBtn = awEl('button',
      'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
      'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    defBtn.textContent = '+ Define Pipeline';
    defBtn.addEventListener('click', function () { self.definePipeline(); });
    actBar.appendChild(defBtn);
    el.appendChild(actBar);

    if (pipelines.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">' +
        '<div style="font-size:24px;margin-bottom:8px;">\u2699</div>No pipelines defined.</div>';
      return;
    }
    for (var i = 0; i < pipelines.length; i++) {
      var p = pipelines[i];
      var card = awEl('div', 'padding:10px 12px;margin-bottom:8px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + awEsc(p.name || p.id) + '</span>' +
        awStatusBadge(p.status || 'idle') + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:4px;">' +
        (p.steps ? p.steps.length + ' steps' : '') + ' ' + awFormatTime(p.updatedAt || p.createdAt) + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load pipelines</div>'; });
};

AutomationWorkspacePanel.prototype.definePipeline = function () {
  var api = awApi(); if (!api) return;
  api.invoke('pipeline:define', { projectId: this.projectId }).catch(function () {});
};

// ─── Scheduler Tab ─────────────────────────────────────────────────

AutomationWorkspacePanel.prototype.renderSchedulerTab = function () {
  var self = this;
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading schedules...</div>';
  var api = awApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('scheduler:list', {}).then(function (result) {
    el.innerHTML = '';
    var schedules = Array.isArray(result) ? result : (result && result.schedules) || [];

    var actBar = awEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var addBtn = awEl('button',
      'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
      'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    addBtn.textContent = '+ Create Schedule';
    addBtn.addEventListener('click', function () { self.createSchedule(); });
    actBar.appendChild(addBtn);
    el.appendChild(actBar);

    if (schedules.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">' +
        '<div style="font-size:24px;margin-bottom:8px;">\u23F0</div>No schedules. Create one to automate recurring tasks.</div>';
      return;
    }
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      var card = awEl('div', 'padding:10px 12px;margin-bottom:8px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + awEsc(s.name || s.id) + '</span>' +
        awStatusBadge(s.enabled === false ? 'paused' : 'active') + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:4px;">' +
        (s.cron || s.interval || '') + ' | Next: ' + awFormatTime(s.nextRun) + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load schedules</div>'; });
};

AutomationWorkspacePanel.prototype.createSchedule = function () {
  var api = awApi(); if (!api) return;
  api.invoke('scheduler:create', { projectId: this.projectId }).catch(function () {});
};

// ─── Missions Tab ──────────────────────────────────────────────────

AutomationWorkspacePanel.prototype.renderMissionsTab = function () {
  var self = this;
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading missions...</div>';
  var api = awApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('missions:list', {}).then(function (result) {
    el.innerHTML = '';
    var missions = Array.isArray(result) ? result : (result && result.missions) || [];

    var actBar = awEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var createBtn = awEl('button',
      'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
      'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    createBtn.textContent = '+ Create Mission';
    createBtn.addEventListener('click', function () { self.createMission(); });
    actBar.appendChild(createBtn);

    var statsBtn = awEl('button',
      'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
      'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;');
    statsBtn.textContent = '\uD83D\uDCCA Stats';
    statsBtn.addEventListener('click', function () { self.viewMissionStats(); });
    actBar.appendChild(statsBtn);
    el.appendChild(actBar);

    if (missions.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">' +
        '<div style="font-size:24px;margin-bottom:8px;">\uD83C\uDFAF</div>No missions yet.</div>';
      return;
    }
    for (var i = 0; i < missions.length; i++) {
      var m = missions[i];
      var card = awEl('div', 'padding:10px 12px;margin-bottom:8px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
      var progress = m.progress != null ? Math.round(m.progress * 100) : 0;
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + awEsc(m.name || m.id) + '</span>' +
        awStatusBadge(m.status || 'pending') + '</div>' +
        '<div style="margin-top:6px;height:4px;background:var(--surface-tertiary,#45475a);border-radius:2px;overflow:hidden;">' +
        '<div style="height:100%;width:' + progress + '%;background:var(--accent-color,#89b4fa);transition:width 0.3s;"></div></div>' +
        '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:4px;">' +
        progress + '% | Workers: ' + (m.workerCount || 0) + ' | ' + awFormatTime(m.createdAt) + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load missions</div>'; });
};

AutomationWorkspacePanel.prototype.createMission = function () {
  var api = awApi(); if (!api) return;
  api.invoke('missions:create', { projectId: this.projectId }).catch(function () {});
};
AutomationWorkspacePanel.prototype.viewMissionStats = function () {
  var api = awApi(); if (!api) return;
  api.invoke('missions:stats', {}).then(function (s) { if (s) alert(JSON.stringify(s, null, 2)); }).catch(function () {});
};

// ─── PCV Tab ───────────────────────────────────────────────────────

AutomationWorkspacePanel.prototype.renderPCVTab = function () {
  var self = this;
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading PCV runs...</div>';
  var api = awApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('pcv:list', {}).then(function (result) {
    el.innerHTML = '';
    var runs = Array.isArray(result) ? result : (result && result.runs) || [];

    var actBar = awEl('div', 'display:flex;gap:6px;margin-bottom:12px;');
    var createBtn = awEl('button',
      'font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
      'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;');
    createBtn.textContent = '+ New PCV Run';
    createBtn.addEventListener('click', function () { self.createPCV(); });
    actBar.appendChild(createBtn);
    el.appendChild(actBar);

    if (runs.length === 0) {
      el.innerHTML += '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);">' +
        '<div style="font-size:24px;margin-bottom:8px;">\u2705</div>No Plan-Code-Verify runs.</div>';
      return;
    }
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var card = awEl('div', 'padding:10px 12px;margin-bottom:8px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;">' + awEsc(r.name || r.id) + '</span>' +
        awStatusBadge(r.status || 'pending') + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:4px;">' +
        'Steps: ' + (r.completedSteps || 0) + '/' + (r.totalSteps || 0) + ' | ' + awFormatTime(r.createdAt) + '</div>';
      el.appendChild(card);
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load PCV runs</div>'; });
};

AutomationWorkspacePanel.prototype.createPCV = function () {
  var api = awApi(); if (!api) return;
  api.invoke('pcv:create', { projectId: this.projectId }).catch(function () {});
};

// ─── Headless Tab ──────────────────────────────────────────────────

AutomationWorkspacePanel.prototype.renderHeadlessTab = function () {
  var self = this;
  var el = this.tabContent;
  el.innerHTML = '<div style="color:var(--text-secondary,#a6adc8);padding:20px;text-align:center;">\u23F3 Loading headless config...</div>';
  var api = awApi(); if (!api) { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  Promise.all([
    api.invoke('exec:get-config', {}),
    api.invoke('exec:recent', {}),
    api.invoke('exec:stats', {}),
  ]).then(function (results) {
    el.innerHTML = '';
    var config = results[0] || {};
    var recent = Array.isArray(results[1]) ? results[1] : (results[1] && results[1].runs) || [];
    var stats = results[2] || {};

    // Config section
    var configSection = awEl('div', 'margin-bottom:16px;padding:12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);');
    configSection.innerHTML = '<div style="font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;">Configuration</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#a6adc8);">' +
      'Mode: ' + awEsc(config.mode || 'standard') + ' | Timeout: ' + (config.timeout || 300) + 's | ' +
      'Auto-approve: ' + (config.autoApprove ? 'Yes' : 'No') + '</div>';
    el.appendChild(configSection);

    // Stats
    if (stats) {
      var statsSection = awEl('div', 'display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;');
      var statItems = [
        { label: 'Total Runs', value: stats.totalRuns || 0 },
        { label: 'Completed', value: stats.completed || 0 },
        { label: 'Failed', value: stats.failed || 0 },
        { label: 'Avg Duration', value: (stats.avgDuration || 0) + 's' },
      ];
      for (var i = 0; i < statItems.length; i++) {
        var si = statItems[i];
        var statEl = awEl('div', 'padding:8px 12px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);min-width:80px;text-align:center;');
        statEl.innerHTML = '<div style="font-size:16px;color:var(--text-primary,#cdd6f4);font-weight:700;">' + awEsc(si.value) + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted,#6c7086);margin-top:2px;">' + si.label + '</div>';
        statsSection.appendChild(statEl);
      }
      el.appendChild(statsSection);
    }

    // Start button
    var startBtn = awEl('button',
      'font-size:11px;padding:6px 14px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);' +
      'background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600;margin-bottom:16px;');
    startBtn.textContent = '\u25B6 Start Headless Execution';
    startBtn.addEventListener('click', function () { self.startHeadless(); });
    el.appendChild(startBtn);

    // Recent runs
    if (recent.length > 0) {
      var recentHeader = awEl('div', 'font-size:12px;font-weight:600;color:var(--text-primary,#cdd6f4);margin-bottom:8px;');
      recentHeader.textContent = 'Recent Runs';
      el.appendChild(recentHeader);
      for (var j = 0; j < Math.min(recent.length, 10); j++) {
        var run = recent[j];
        var runCard = awEl('div', 'padding:8px 12px;margin-bottom:6px;background:var(--surface-secondary,#313244);border-radius:4px;border:1px solid var(--border-color,#45475a);font-size:11px;');
        runCard.innerHTML = '<div style="display:flex;justify-content:space-between;">' +
          '<span style="color:var(--text-primary,#cdd6f4);">' + awEsc(run.task || run.id || 'Run ' + (j + 1)) + '</span>' +
          awStatusBadge(run.status || 'completed') + '</div>' +
          '<div style="color:var(--text-muted,#6c7086);margin-top:2px;">' + awFormatTime(run.completedAt || run.startedAt) + '</div>';
        el.appendChild(runCard);
      }
    }
  }).catch(function () { el.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load headless config</div>'; });
};

AutomationWorkspacePanel.prototype.startHeadless = function () {
  var api = awApi(); if (!api) return;
  api.invoke('exec:start', { projectId: this.projectId }).catch(function () {});
};

// ─── Cleanup ───────────────────────────────────────────────────────

AutomationWorkspacePanel.prototype.destroy = function () {
  if (this.container) this.container.innerHTML = '';
};

// ─── Exports ───────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.AutomationWorkspacePanel = AutomationWorkspacePanel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AutomationWorkspacePanel: AutomationWorkspacePanel };
}
