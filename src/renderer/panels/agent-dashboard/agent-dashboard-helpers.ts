// @ts-nocheck
/**
 * AgentDashboardV2Panel — Shared constants, helpers, and styles.
 *
 * Extracted from agent-dashboard-v2-panel.ts to keep the main panel file
 * under the 2000-line renderer file-size ratchet.
 */

// ─── Constants ───────────────────────────────────────────────────

export var AD_STATE_ORDER = ['awaiting-input', 'running', 'responding', 'idle'];

export var AD_STATE_COLORS = {
  'awaiting-input': 'var(--yellow, #fbbf24)',
  'running': 'var(--green, #4ade80)',
  'responding': 'var(--accent, #007AFF)',
  'idle': 'var(--text-dim, #5a5a5a)'
};

export var AD_STATE_BADGE_VARIANT = {
  'awaiting-input': 'warning',
  'running': 'success',
  'responding': 'info',
  'idle': 'info'
};

export var AD_ROLE_COLORS = {
  'user': 'var(--accent, #007AFF)',
  'assistant': 'var(--green, #4ade80)',
  'system': 'var(--yellow, #fbbf24)',
  'tool': 'var(--text-secondary, #969696)'
};

export var AD_REFRESH_INTERVAL = 5000;

// ─── Helpers ─────────────────────────────────────────────────────

export function adApi() { return window.electronAPI; }

export function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

export function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
export function enableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

export function relTime(ts) {
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

export function classifyState(session) {
  var state = (session.status || session.state || 'idle').toLowerCase();
  if (state === 'preparing') return 'running';
  if (state === 'awaiting_approval' || state === 'awaiting-input' || state === 'blocked') return 'awaiting-input';
  if (state === 'running' || state === 'executing' || state === 'active') return 'running';
  if (state === 'responding' || state === 'streaming') return 'responding';
  return 'idle';
}

export function elapsedStr(startTs) {
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

/**
 * Get active agents from the runtime pipeline state (global vars from index.ts).
 * Converts them into a session-like format for the dashboard to display.
 */
export function adGetRuntimeAgents() {
  var sessions = [];

  // Get active agents (currently executing)
  var active = window.activeAgents || (typeof activeAgents !== 'undefined' ? activeAgents : []);
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

  // Get completed agents (recently finished)
  var completed = window.completedAgents || (typeof completedAgents !== 'undefined' ? completedAgents : []);
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
      createdAt: Date.now() - 60000 // Show as recent
    });
  }

  return sessions;
}

// ─── Inject Panel Styles ─────────────────────────────────────────

export function injectPanelStyles() {
  if (document.getElementById('ad-panel-styles')) return;

  var styleEl = document.createElement('style');
  styleEl.id = 'ad-panel-styles';
  styleEl.textContent = [
    '.ad-session-card{background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:6px;transition:border-color var(--motion-quick),box-shadow var(--motion-quick);border-left-width:3px;border-left-style:solid;}',
    '.ad-session-card:hover{border-color:var(--accent);box-shadow:0 2px 8px rgba(0,0,0,0.12);}',
    '.ad-sub-card{background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:6px 10px;margin-bottom:4px;margin-left:16px;font-size:11px;border-left-width:2px;border-left-style:solid;}',
    '.ad-peek-overlay{position:sticky;bottom:0;background:var(--surface-container-high);border-top:2px solid var(--accent);border-radius:var(--radius-sm) var(--radius-sm) 0 0;padding:14px;max-height:240px;overflow-y:auto;animation:adSlideUp 0.25s ease;box-shadow:0 -4px 16px rgba(0,0,0,0.2);}',
    '.ad-peek-msg{font-size:11px;padding:6px 8px;margin-bottom:4px;border-radius:var(--radius-xs);background:var(--surface-container);border-left:2px solid var(--text-dim);}',
    '.ad-dispatch-row{display:flex;gap:8px;margin-bottom:16px;}',
    '.ad-refresh-badge{font-size:10px;color:var(--text-dim);display:flex;align-items:center;gap:4px;}',
    '.ad-group-header{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px;padding:0 2px;}',
    '.ad-actions-row{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;}',
    '.ad-action-btn{font-size:10px;padding:3px 8px;border-radius:var(--radius-xs);border:1px solid var(--border-color);background:transparent;color:var(--text-secondary);cursor:pointer;transition:all var(--motion-quick);font-family:inherit;}',
    '.ad-action-btn:hover{border-color:var(--accent);color:var(--accent);}',
    '.ad-action-btn:disabled{opacity:0.5;cursor:not-allowed;}',
    '.ad-action-btn.danger{border-color:var(--red);color:var(--red);}',
    '.ad-action-btn.danger:hover{background:var(--red);color:#fff;}',
    '.ad-rename-input{font-size:12px;padding:4px 8px;border-radius:var(--radius-xs);border:1px solid var(--accent);background:var(--bg-input);color:var(--text-primary);outline:none;width:100%;box-sizing:border-box;font-family:inherit;}',
    '.ad-sub-detail{margin-top:4px;}',
    '.ad-sub-detail-row{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-dim);margin-top:2px;}',
    '.ad-sub-detail-row .ad-sub-label{color:var(--text-secondary);font-weight:600;min-width:48px;}',
    '.ad-sub-progress{margin-top:4px;}',
    '.ad-sub-elapsed{font-size:9px;color:var(--text-dim);margin-left:auto;white-space:nowrap;}',
    '.ad-sub-actions{display:flex;gap:4px;margin-top:4px;}',
    '.ad-peek-tool-card{background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:6px 8px;margin-top:6px;font-size:10px;}',
    '.ad-peek-tool-name{font-weight:600;color:var(--accent);margin-bottom:2px;}',
    '.ad-peek-tool-args{color:var(--text-dim);font-family:"SF Mono",Menlo,monospace;font-size:9px;word-break:break-all;max-height:60px;overflow-y:auto;}',
    '@keyframes adSlideUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}',
    '@keyframes adLivePulse{0%,100%{opacity:1;}50%{opacity:0.5;}}',
    '.ad-live-pulsing{animation:adLivePulse 0.6s ease-in-out infinite;}',
    '#ad-unread-badge{animation:adBadgePop 0.2s ease;}',
    '@keyframes adBadgePop{from{transform:scale(0);}to{transform:scale(1);}}',
  ].join('\n');
  document.head.appendChild(styleEl);
}
