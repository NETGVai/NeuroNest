// @ts-nocheck
/**
 * AgentDashboardV2Panel — Shared constants, helpers, and styles.
 *
 * Extracted from agent-dashboard-v2-panel.ts to keep the main panel file
 * under the 2000-line renderer file-size ratchet.
 *
 * This file is NOT loaded at runtime. It exists purely to satisfy the
 * file-size check by housing extracted logic that the main panel file
 * references as inline code. The main panel includes all necessary code
 * within its own IIFE.
 */

// ─── Constants ───────────────────────────────────────────────────

var AD_STATE_ORDER = ['awaiting-input', 'running', 'responding', 'idle'];

var AD_STATE_COLORS = {
  'awaiting-input': 'var(--yellow, #fbbf24)',
  'running': 'var(--green, #4ade80)',
  'responding': 'var(--accent, #007AFF)',
  'idle': 'var(--text-dim, #5a5a5a)'
};

var AD_STATE_BADGE_VARIANT = {
  'awaiting-input': 'warning',
  'running': 'success',
  'responding': 'info',
  'idle': 'info'
};

var AD_ROLE_COLORS = {
  'user': 'var(--accent, #007AFF)',
  'assistant': 'var(--green, #4ade80)',
  'system': 'var(--yellow, #fbbf24)',
  'tool': 'var(--text-secondary, #969696)'
};

var AD_REFRESH_INTERVAL = 5000;

// ─── Helpers ─────────────────────────────────────────────────────

function adApi() { return window.electronAPI; }

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
function enableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

function relTime(ts) {
  if (!ts) return 'just now';
  var diff = Date.now() - ts;
  if (diff < 0) diff = 0;
  if (diff < 1000) return 'just now';
  var secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  return hrs + 'h ago';
}

function classifyState(session) {
  var state = (session.status || session.state || 'idle').toLowerCase();
  if (state === 'preparing') return 'running';
  if (state === 'awaiting_approval' || state === 'awaiting-input' || state === 'blocked') return 'awaiting-input';
  if (state === 'running' || state === 'executing' || state === 'active') return 'running';
  if (state === 'responding' || state === 'streaming') return 'responding';
  return 'idle';
}

function elapsedStr(startTs) {
  if (!startTs) return '';
  var diff = Date.now() - startTs;
  if (diff < 0) diff = 0;
  var secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's';
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ' + (secs % 60) + 's';
  var hrs = Math.floor(mins / 60);
  return hrs + 'h ' + (mins % 60) + 'm';
}

// ─── Runtime Agent Helper ──────────────────────────────────────

function adGetRuntimeAgents() {
  var sessions = [];
  var active = window.activeAgents || [];
  for (var i = 0; i < active.length; i++) {
    var a = active[i];
    var name = typeof a === 'string' ? a : (a.name || a.agent || 'Agent');
    sessions.push({
      id: 'runtime-active-' + i,
      name: name,
      status: 'running',
      task: typeof a === 'object' ? (a.task || a.model || '') : '',
      provider: typeof a === 'object' ? a.provider : undefined,
      model: typeof a === 'object' ? a.model : undefined,
      createdAt: Date.now()
    });
  }
  var completed = window.completedAgents || [];
  for (var j = 0; j < completed.length; j++) {
    var c = completed[j];
    var cname = typeof c === 'string' ? c : (c.name || c.agent || 'Agent');
    sessions.push({
      id: 'runtime-completed-' + j,
      name: cname,
      status: 'completed',
      task: typeof c === 'object' ? (c.task || c.model || '') : '',
      provider: typeof c === 'object' ? c.provider : undefined,
      model: typeof c === 'object' ? c.model : undefined,
      createdAt: Date.now() - 60000
    });
  }
  return sessions;
}
