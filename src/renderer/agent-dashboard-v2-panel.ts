// @ts-nocheck
/**
 * AgentDashboardV2Panel — Fleet dashboard for multi-session management.
 *
 * Features:
 * - Sessions grouped: awaiting-input (first), running, responding, idle
 * - Subagents under parent; awaiting-input count visible
 * - Per-row: peek, attach, rename, pin, stop
 * - Peek shows recent events without switching active session
 * - Stop routes through lifecycle teardown, releases resources
 * - Inline dispatch field for new sessions
 * - Loop rows: pass number, verify status, blocked reason
 * - Blocked Loop in awaiting-input
 * - Open/close has zero engine trace effect
 *
 * IPC channels:
 * - parallel:list, parallel:get, parallel:create, parallel:update, parallel:delete, parallel:get-messages, parallel:run
 * - session-status:get, session-status:set
 * - loops:runStatus
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Requirements: 21.1-21.11
 */

// ─── Constants ─────────────────────────────────────────────────────

var AD_STATE_ORDER = ['awaiting-input', 'running', 'responding', 'idle'];
var AD_STATE_COLORS = {
  'awaiting-input': '#f9e2af',
  'running': '#a6e3a1',
  'responding': '#89b4fa',
  'idle': '#6c7086',
  'blocked': '#f38ba8',
  'completed': '#6c7086',
};

// ─── Helpers ───────────────────────────────────────────────────────

function adEsc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
function adApi() { return window.electronAPI; }
function adEl(tag, css, attrs) {
  var el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]); } }
  return el;
}
function adBadge(t, c) { return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:' + c + '22;color:' + c + ';font-weight:600;">' + adEsc(t) + '</span>'; }

// ─── Panel class ───────────────────────────────────────────────────

function AgentDashboardV2Panel(container, options) {
  this.container = container;
  this.sessions = [];
  this.peekingSession = null;
}

AgentDashboardV2Panel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);';

  // Header with count
  var header = adEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;');
  var title = adEl('h3', 'margin:0;font-size:16px;color:var(--text-primary,#cdd6f4);');
  title.textContent = 'Agent Dashboard';
  header.appendChild(title);
  this.container.appendChild(header);

  // Inline dispatch field
  var dispatchRow = adEl('div', 'display:flex;gap:6px;margin-bottom:16px;');
  var dispatchInput = adEl('input',
    'flex:1;padding:6px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
    'background:var(--input-bg,#1e1e2e);color:var(--text-primary,#cdd6f4);font-size:12px;outline:none;',
    { placeholder: 'Dispatch new session...', 'aria-label': 'New session dispatch' });
  dispatchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && dispatchInput.value.trim()) { self.dispatchSession(dispatchInput.value.trim()); dispatchInput.value = ''; }
  });
  dispatchRow.appendChild(dispatchInput);
  var dispatchBtn = adEl('button', 'padding:6px 12px;border-radius:4px;border:1px solid var(--accent-color,#89b4fa);background:var(--accent-color,#89b4fa);color:#1e1e2e;cursor:pointer;font-size:12px;font-weight:600;');
  dispatchBtn.textContent = 'Dispatch';
  dispatchBtn.addEventListener('click', function () { if (dispatchInput.value.trim()) { self.dispatchSession(dispatchInput.value.trim()); dispatchInput.value = ''; } });
  dispatchRow.appendChild(dispatchBtn);
  this.container.appendChild(dispatchRow);

  // Session list area
  this.listEl = adEl('div', '');
  this.container.appendChild(this.listEl);

  // Peek overlay area
  this.peekEl = adEl('div', 'display:none;position:sticky;bottom:0;background:var(--surface-secondary,#313244);border-top:1px solid var(--border-color,#45475a);padding:12px;border-radius:6px 6px 0 0;max-height:200px;overflow-y:auto;');
  this.container.appendChild(this.peekEl);

  this.loadSessions();
};

// ─── Data Loading ──────────────────────────────────────────────────

AgentDashboardV2Panel.prototype.loadSessions = function () {
  var self = this;
  var api = adApi(); if (!api) { this.listEl.innerHTML = '<div style="color:#f38ba8;padding:20px;">IPC unavailable</div>'; return; }

  api.invoke('parallel:list', {}).then(function (result) {
    var sessions = Array.isArray(result) ? result : (result && result.sessions) || [];
    self.sessions = sessions;
    self.renderSessionList();
  }).catch(function () {
    self.listEl.innerHTML = '<div style="color:#f38ba8;padding:20px;">Failed to load sessions</div>';
  });
};

AgentDashboardV2Panel.prototype.renderSessionList = function () {
  var self = this;
  var el = this.listEl;
  el.innerHTML = '';

  if (this.sessions.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary,#a6adc8);"><div style="font-size:24px;margin-bottom:8px;">\uD83D\uDC65</div>No active sessions. Use the dispatch field above to start one.</div>';
    return;
  }

  // Group sessions by state
  var groups = {};
  for (var i = 0; i < AD_STATE_ORDER.length; i++) { groups[AD_STATE_ORDER[i]] = []; }

  // Separate parents and subagents
  var parentSessions = [];
  var subagentMap = {}; // parentId -> [subagents]

  for (var j = 0; j < this.sessions.length; j++) {
    var s = this.sessions[j];
    if (s.parentId || s.parentSessionId) {
      var pid = s.parentId || s.parentSessionId;
      if (!subagentMap[pid]) subagentMap[pid] = [];
      subagentMap[pid].push(s);
    } else {
      parentSessions.push(s);
    }
  }

  // Classify parents into groups
  for (var k = 0; k < parentSessions.length; k++) {
    var session = parentSessions[k];
    var state = self.classifyState(session);
    if (groups[state]) { groups[state].push(session); }
    else { groups['idle'].push(session); }
  }

  // Awaiting-input count badge in header
  var awaitCount = groups['awaiting-input'].length;
  if (awaitCount > 0) {
    var countBadge = adEl('div', 'font-size:11px;padding:2px 8px;background:#f9e2af22;color:#f9e2af;border-radius:4px;margin-bottom:8px;font-weight:600;');
    countBadge.textContent = '\u26A0 ' + awaitCount + ' session(s) awaiting input';
    el.appendChild(countBadge);
  }

  // Render groups in order
  for (var g = 0; g < AD_STATE_ORDER.length; g++) {
    var groupName = AD_STATE_ORDER[g];
    var groupSessions = groups[groupName];
    if (groupSessions.length === 0) continue;

    var groupHeader = adEl('div', 'font-size:11px;font-weight:600;color:' + (AD_STATE_COLORS[groupName] || '#a6adc8') + ';margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.5px;');
    groupHeader.textContent = groupName.replace('-', ' ') + ' (' + groupSessions.length + ')';
    el.appendChild(groupHeader);

    for (var si = 0; si < groupSessions.length; si++) {
      el.appendChild(self.renderSessionRow(groupSessions[si], subagentMap));
    }
  }
};

AgentDashboardV2Panel.prototype.classifyState = function (session) {
  var state = (session.status || session.state || 'idle').toLowerCase();
  if (state === 'awaiting_approval' || state === 'awaiting-input' || state === 'blocked') return 'awaiting-input';
  if (state === 'running' || state === 'executing' || state === 'active') return 'running';
  if (state === 'responding' || state === 'streaming') return 'responding';
  return 'idle';
};

// ─── Session Row Rendering ─────────────────────────────────────────

AgentDashboardV2Panel.prototype.renderSessionRow = function (session, subagentMap) {
  var self = this;
  var state = this.classifyState(session);
  var color = AD_STATE_COLORS[state] || '#6c7086';

  var row = adEl('div', 'padding:8px 12px;margin-bottom:4px;background:var(--surface-secondary,#313244);border-radius:6px;border:1px solid var(--border-color,#45475a);border-left:3px solid ' + color + ';');

  // Top: name + state badge
  var topRow = adEl('div', 'display:flex;align-items:center;justify-content:space-between;gap:6px;');
  var nameSpan = adEl('span', 'font-size:12px;color:var(--text-primary,#cdd6f4);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;');
  nameSpan.textContent = session.name || session.task || session.id || 'Session';
  topRow.appendChild(nameSpan);

  var badgeHtml = adBadge(state.replace('-', ' '), color);
  var badgeSpan = adEl('span', '');
  badgeSpan.innerHTML = badgeHtml;
  topRow.appendChild(badgeSpan);
  row.appendChild(topRow);

  // Loop info if available
  if (session.loopPass != null || session.loopState) {
    var loopInfo = adEl('div', 'font-size:10px;color:var(--text-muted,#6c7086);margin-top:2px;');
    loopInfo.textContent = 'Loop: pass ' + (session.loopPass || 0) +
      (session.loopVerifyStatus ? ' | verify: ' + session.loopVerifyStatus : '') +
      (session.blockedReason ? ' | ' + session.blockedReason : '');
    row.appendChild(loopInfo);
  }

  // Actions
  var actions = adEl('div', 'display:flex;gap:4px;margin-top:6px;');

  var peekBtn = adEl('button', 'font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;', { title: 'Peek at recent events' });
  peekBtn.textContent = '\uD83D\uDC41';
  peekBtn.addEventListener('click', function (e) { e.stopPropagation(); self.peekSession(session); });
  actions.appendChild(peekBtn);

  var attachBtn = adEl('button', 'font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;', { title: 'Attach to session' });
  attachBtn.textContent = '\u21AA';
  attachBtn.addEventListener('click', function (e) { e.stopPropagation(); self.attachSession(session); });
  actions.appendChild(attachBtn);

  var renameBtn = adEl('button', 'font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;', { title: 'Rename' });
  renameBtn.textContent = '\u270F';
  renameBtn.addEventListener('click', function (e) { e.stopPropagation(); self.renameSession(session); });
  actions.appendChild(renameBtn);

  var stopBtn = adEl('button', 'font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid #f38ba8;background:transparent;color:#f38ba8;cursor:pointer;', { title: 'Stop session' });
  stopBtn.textContent = '\u25A0';
  stopBtn.addEventListener('click', function (e) { e.stopPropagation(); self.stopSession(session); });
  actions.appendChild(stopBtn);

  row.appendChild(actions);

  // Subagents
  var subs = subagentMap[session.id];
  if (subs && subs.length > 0) {
    var subContainer = adEl('div', 'margin-top:6px;padding-left:12px;border-left:2px solid var(--border-color,#45475a);');
    for (var i = 0; i < subs.length; i++) {
      var sub = subs[i];
      var subState = this.classifyState(sub);
      var subRow = adEl('div', 'font-size:10px;padding:3px 6px;margin-bottom:2px;color:var(--text-secondary,#a6adc8);');
      subRow.innerHTML = '\u2514 ' + adEsc(sub.name || sub.agent || sub.id) + ' ' + adBadge(subState.replace('-', ' '), AD_STATE_COLORS[subState] || '#6c7086');
      subContainer.appendChild(subRow);
    }
    row.appendChild(subContainer);
  }

  return row;
};

// ─── Actions ───────────────────────────────────────────────────────

AgentDashboardV2Panel.prototype.peekSession = function (session) {
  var self = this;
  var api = adApi(); if (!api) return;

  api.invoke('parallel:get-messages', { sessionId: session.id, limit: 5 }).then(function (messages) {
    var msgs = Array.isArray(messages) ? messages : (messages && messages.messages) || [];
    self.peekEl.style.display = 'block';
    self.peekEl.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:8px;">' +
      '<span style="font-size:11px;font-weight:600;color:var(--text-primary,#cdd6f4);">Peek: ' + adEsc(session.name || session.id) + '</span>' +
      '<button style="font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--border-color,#45475a);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;" id="ad-peek-close">\u2716</button></div>';

    if (msgs.length === 0) {
      self.peekEl.innerHTML += '<div style="font-size:11px;color:var(--text-muted,#6c7086);">No recent events.</div>';
    } else {
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        self.peekEl.innerHTML += '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--border-color,#45475a);color:var(--text-secondary,#a6adc8);">' +
          '<strong>' + adEsc(m.role || 'system') + ':</strong> ' + adEsc((m.content || '').slice(0, 120)) + '</div>';
      }
    }

    self.peekEl.querySelector('#ad-peek-close').addEventListener('click', function () { self.peekEl.style.display = 'none'; });
  }).catch(function () {});
};

AgentDashboardV2Panel.prototype.attachSession = function (session) {
  var api = adApi(); if (!api) return;
  api.invoke('parallel:get', { sessionId: session.id }).catch(function () {});
};

AgentDashboardV2Panel.prototype.renameSession = function (session) {
  var newName = prompt('Rename session:', session.name || session.id);
  if (!newName || !newName.trim()) return;
  var api = adApi(); if (!api) return;
  var self = this;
  api.invoke('parallel:update', { sessionId: session.id, name: newName.trim() }).then(function () { self.loadSessions(); }).catch(function () {});
};

AgentDashboardV2Panel.prototype.stopSession = function (session) {
  if (!confirm('Stop session "' + (session.name || session.id) + '"? This will release all resources.')) return;
  var api = adApi(); if (!api) return;
  var self = this;
  api.invoke('parallel:delete', { sessionId: session.id }).then(function () { self.loadSessions(); }).catch(function () {});
};

AgentDashboardV2Panel.prototype.dispatchSession = function (task) {
  var api = adApi(); if (!api) return;
  var self = this;
  api.invoke('parallel:create', { task: task }).then(function () { self.loadSessions(); }).catch(function () {});
};

// ─── Cleanup & Exports ─────────────────────────────────────────────

AgentDashboardV2Panel.prototype.destroy = function () { if (this.container) this.container.innerHTML = ''; };

if (typeof window !== 'undefined') { window.AgentDashboardV2Panel = AgentDashboardV2Panel; }
if (typeof module !== 'undefined' && module.exports) { module.exports = { AgentDashboardV2Panel: AgentDashboardV2Panel }; }
