// @ts-nocheck
/**
 * AgentDashboardV2Panel — Fleet dashboard for multi-session management.
 *
 * Features:
 * - Session cards with colored left-border (yellow=awaiting, green=running, blue=responding, gray=idle)
 * - Peek: slide-up overlay with last 5 messages, role-colored. Close button.
 * - Dispatch: prominent input field with accent button. Shows toast on dispatch.
 * - Rename: inline editable field (no prompt/alert).
 * - Stop: confirm dialog before action + toast.
 * - Auto-refresh every 5s with "Updated Xs ago" indicator.
 * - Subagents indented under parent with smaller cards.
 *
 * Uses window.wk namespace utilities (toast, form, card, emptyState, badge, progress, toggle, confirm, dataView, copyButton).
 * IPC calls use window.electronAPI.invoke(channel, args).
 * All buttons disabled during async ops. All actions show toast feedback. No alert() calls.
 *
 * IPC channels:
 * - parallel:list, parallel:get, parallel:create, parallel:update, parallel:delete, parallel:get-messages, parallel:run
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 */

(function () {
  'use strict';

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

  function api() { return window.electronAPI; }

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

  // ─── Inject Panel Styles ─────────────────────────────────────────

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
  ].join('\n');
  if (!document.getElementById('ad-panel-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── Panel Class ─────────────────────────────────────────────────

  function AgentDashboardV2Panel(container, options) {
    this.container = container;
    this.sessions = [];
    this.lastRefresh = Date.now();
    this.refreshTimer = null;
    this.peekVisible = false;
    this._eventUnsubs = [];
  }

  AgentDashboardV2Panel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'wk-scroll';
    this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;display:flex;flex-direction:column;';

    // Header row
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';

    var title = document.createElement('h3');
    title.style.cssText = 'margin:0;font-size:16px;font-weight:600;color:var(--text-primary);';
    title.textContent = 'Agent Dashboard';
    header.appendChild(title);

    // Refresh badge
    this.refreshBadge = document.createElement('div');
    this.refreshBadge.className = 'ad-refresh-badge';
    this.refreshBadge.innerHTML = '\u21BB Updated just now';
    header.appendChild(this.refreshBadge);

    this.container.appendChild(header);

    // Dispatch row
    var dispatchRow = document.createElement('div');
    dispatchRow.className = 'ad-dispatch-row';

    this.dispatchInput = document.createElement('input');
    this.dispatchInput.className = 'wk-input';
    this.dispatchInput.style.cssText = 'flex:1;';
    this.dispatchInput.placeholder = 'Dispatch a new agent session...';
    this.dispatchInput.setAttribute('aria-label', 'Dispatch new agent session');
    this.dispatchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && self.dispatchInput.value.trim()) {
        self.dispatchSession(self.dispatchInput.value.trim());
      }
    });
    dispatchRow.appendChild(this.dispatchInput);

    this.dispatchBtn = document.createElement('button');
    this.dispatchBtn.className = 'wk-btn-primary';
    this.dispatchBtn.textContent = 'Dispatch';
    this.dispatchBtn.setAttribute('aria-label', 'Dispatch session');
    this.dispatchBtn.addEventListener('click', function () {
      if (self.dispatchInput.value.trim()) {
        self.dispatchSession(self.dispatchInput.value.trim());
      }
    });
    dispatchRow.appendChild(this.dispatchBtn);

    this.container.appendChild(dispatchRow);

    // Session list area
    this.listEl = document.createElement('div');
    this.listEl.style.cssText = 'flex:1;overflow-y:auto;';
    this.container.appendChild(this.listEl);

    // Peek overlay area (initially hidden)
    this.peekEl = document.createElement('div');
    this.peekEl.className = 'ad-peek-overlay';
    this.peekEl.style.display = 'none';
    this.container.appendChild(this.peekEl);

    // Load initial data
    this.loadSessions();

    // Start auto-refresh
    this.startAutoRefresh();

    // Subscribe to real-time subagent events
    this.subscribeSubagentEvents();
  };

  // ─── Auto-Refresh ────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.startAutoRefresh = function () {
    var self = this;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(function () {
      self.loadSessions();
      self.updateRefreshBadge();
    }, AD_REFRESH_INTERVAL);
  };

  // ─── Real-Time Event Subscriptions ───────────────────────────────

  AgentDashboardV2Panel.prototype.subscribeSubagentEvents = function () {
    var self = this;

    // Clean up old subscriptions
    this.unsubscribeSubagentEvents();

    if (!window.subscribeEvent) return;

    // Subscribe to subagent:progress — incremental progress updates
    var onSubagentProgress = function (data) {
      if (!data || !data.sessionId) return;
      // Find the subagent card and update progress
      var cardEl = self.listEl.querySelector('[data-subagent-id="' + data.sessionId + '"]');
      if (cardEl) {
        // Update progress bar
        var progressContainer = cardEl.querySelector('.ad-sub-progress');
        if (progressContainer && data.progress != null) {
          progressContainer.innerHTML = '';
          progressContainer.appendChild(window.wk.progress(data.progress, data.progressMax || 100));
        } else if (!progressContainer && data.progress != null) {
          var newProgressContainer = document.createElement('div');
          newProgressContainer.className = 'ad-sub-progress';
          newProgressContainer.appendChild(window.wk.progress(data.progress, data.progressMax || 100));
          // Insert before actions row
          var actionsRow = cardEl.querySelector('.ad-sub-actions');
          if (actionsRow) {
            cardEl.insertBefore(newProgressContainer, actionsRow);
          } else {
            cardEl.appendChild(newProgressContainer);
          }
        }

        // Update elapsed time if provided
        if (data.elapsedMs || data.startedAt) {
          var elapsedEl = cardEl.querySelector('.ad-sub-elapsed');
          if (elapsedEl) {
            elapsedEl.textContent = '\u23F1 ' + elapsedStr(data.startedAt || (Date.now() - (data.elapsedMs || 0)));
          }
        }

        // Update task text if provided
        if (data.task || data.description) {
          var detailSection = cardEl.querySelector('.ad-sub-detail');
          if (detailSection) {
            var taskRow = detailSection.querySelector('.ad-sub-detail-row');
            if (taskRow) {
              var taskSpan = taskRow.querySelector('span:last-child');
              if (taskSpan) taskSpan.textContent = (data.task || data.description || '').slice(0, 80);
            }
          }
        }
      } else {
        // Card not found — could be a new subagent; do a full refresh
        self.loadSessions();
      }
    };

    // Subscribe to subagent:completed — update parent session progress in real-time
    var onSubagentCompleted = function (data) {
      if (!data) return;
      // Refresh the session list to reflect parent progress update
      self.loadSessions();
      // Show a toast if subagent completed successfully
      var subName = (data.name || data.agent || data.sessionId || 'Subagent');
      var status = data.status || 'completed';
      if (status === 'completed' || status === 'success') {
        window.wk.toast('Subagent "' + subName + '" completed', 'success');
      } else if (status === 'failed' || status === 'error') {
        window.wk.toast('Subagent "' + subName + '" failed', 'error');
      }
    };

    window.subscribeEvent('subagent:progress', onSubagentProgress);
    window.subscribeEvent('subagent:completed', onSubagentCompleted);

    self._eventUnsubs.push(function () {
      if (window.unsubscribeEvent) {
        window.unsubscribeEvent('subagent:progress', onSubagentProgress);
        window.unsubscribeEvent('subagent:completed', onSubagentCompleted);
      }
    });
  };

  AgentDashboardV2Panel.prototype.unsubscribeSubagentEvents = function () {
    for (var i = 0; i < this._eventUnsubs.length; i++) {
      this._eventUnsubs[i]();
    }
    this._eventUnsubs = [];
  };

  AgentDashboardV2Panel.prototype.updateRefreshBadge = function () {
    if (this.refreshBadge) {
      this.refreshBadge.innerHTML = '\u21BB Updated ' + relTime(this.lastRefresh);
    }
  };

  // ─── Data Loading ────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.loadSessions = function () {
    var self = this;
    var a = api();
    if (!a) {
      this.listEl.innerHTML = '';
      this.listEl.appendChild(window.wk.emptyState('\u26A0\uFE0F', 'IPC Unavailable', 'Cannot connect to the main process.'));
      return;
    }

    a.invoke('parallel:list', {}).then(function (result) {
      var sessions = Array.isArray(result) ? result : (result && result.sessions) || [];
      self.sessions = sessions;
      self.lastRefresh = Date.now();
      self.renderSessionList();
      self.updateRefreshBadge();
    }).catch(function (err) {
      self.listEl.innerHTML = '';
      self.listEl.appendChild(window.wk.emptyState('\u274C', 'Failed to load sessions', String(err && err.message || err || 'Unknown error')));
    });
  };

  // ─── Session List Rendering ──────────────────────────────────────

  AgentDashboardV2Panel.prototype.renderSessionList = function () {
    var self = this;
    var el = this.listEl;
    el.innerHTML = '';

    if (this.sessions.length === 0) {
      el.appendChild(window.wk.emptyState('\uD83D\uDC65', 'No active sessions', 'Use the dispatch field above to start a new agent session.'));
      return;
    }

    // Separate parents and subagents
    var parentSessions = [];
    var subagentMap = {};

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

    // Group sessions by state
    var groups = {};
    for (var i = 0; i < AD_STATE_ORDER.length; i++) { groups[AD_STATE_ORDER[i]] = []; }

    for (var k = 0; k < parentSessions.length; k++) {
      var session = parentSessions[k];
      var state = classifyState(session);
      if (groups[state]) { groups[state].push(session); }
      else { groups['idle'].push(session); }
    }

    // Render groups
    for (var g = 0; g < AD_STATE_ORDER.length; g++) {
      var groupName = AD_STATE_ORDER[g];
      var groupSessions = groups[groupName];
      if (groupSessions.length === 0) continue;

      var groupHeader = document.createElement('div');
      groupHeader.className = 'ad-group-header';
      groupHeader.style.color = AD_STATE_COLORS[groupName] || 'var(--text-dim)';
      groupHeader.textContent = groupName.replace(/-/g, ' ') + ' (' + groupSessions.length + ')';
      el.appendChild(groupHeader);

      for (var si = 0; si < groupSessions.length; si++) {
        el.appendChild(self.renderSessionCard(groupSessions[si], subagentMap));
      }
    }
  };

  // ─── Session Card ────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.renderSessionCard = function (session, subagentMap) {
    var self = this;
    var state = classifyState(session);
    var color = AD_STATE_COLORS[state] || 'var(--text-dim)';

    var card = document.createElement('div');
    card.className = 'ad-session-card';
    card.style.borderLeftColor = color;

    // Top row: name + badge
    var topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    var nameEl = document.createElement('span');
    nameEl.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
    nameEl.textContent = session.name || session.task || session.id || 'Session';
    nameEl.setAttribute('data-session-id', session.id);
    topRow.appendChild(nameEl);

    var badgeEl = window.wk.badge(state.replace(/-/g, ' '), AD_STATE_BADGE_VARIANT[state] || 'info');
    topRow.appendChild(badgeEl);

    card.appendChild(topRow);

    // Loop info if available
    if (session.loopPass != null || session.loopState) {
      var loopInfo = document.createElement('div');
      loopInfo.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:4px;';
      var loopText = 'Loop pass ' + (session.loopPass || 0);
      if (session.loopVerifyStatus) loopText += ' \u2022 verify: ' + session.loopVerifyStatus;
      if (session.blockedReason) loopText += ' \u2022 ' + session.blockedReason;
      loopInfo.textContent = loopText;
      card.appendChild(loopInfo);
    }

    // Actions row
    var actions = document.createElement('div');
    actions.className = 'ad-actions-row';

    // Peek button
    var peekBtn = document.createElement('button');
    peekBtn.className = 'ad-action-btn';
    peekBtn.textContent = '\uD83D\uDC41 Peek';
    peekBtn.setAttribute('aria-label', 'Peek at recent messages');
    peekBtn.addEventListener('click', function (e) { e.stopPropagation(); self.peekSession(session); });
    actions.appendChild(peekBtn);

    // Rename button
    var renameBtn = document.createElement('button');
    renameBtn.className = 'ad-action-btn';
    renameBtn.textContent = '\u270F\uFE0F Rename';
    renameBtn.setAttribute('aria-label', 'Rename session');
    renameBtn.addEventListener('click', function (e) { e.stopPropagation(); self.startRename(session, card, nameEl); });
    actions.appendChild(renameBtn);

    // Stop button
    var stopBtn = document.createElement('button');
    stopBtn.className = 'ad-action-btn danger';
    stopBtn.textContent = '\u25A0 Stop';
    stopBtn.setAttribute('aria-label', 'Stop session');
    stopBtn.addEventListener('click', function (e) { e.stopPropagation(); self.stopSession(session, card); });
    actions.appendChild(stopBtn);

    card.appendChild(actions);

    // Subagents
    var subs = subagentMap[session.id];
    if (subs && subs.length > 0) {
      var subContainer = document.createElement('div');
      subContainer.style.cssText = 'margin-top:8px;';

      for (var i = 0; i < subs.length; i++) {
        var sub = subs[i];
        var subState = classifyState(sub);
        var subColor = AD_STATE_COLORS[subState] || 'var(--text-dim)';

        var subCard = document.createElement('div');
        subCard.className = 'ad-sub-card';
        subCard.style.borderLeftColor = subColor;
        subCard.setAttribute('data-subagent-id', sub.id || '');

        // Top row: name + badge + elapsed time
        var subContent = document.createElement('div');
        subContent.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';

        var subName = document.createElement('span');
        subName.style.cssText = 'color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-weight:600;';
        subName.textContent = '\u2514 ' + (sub.name || sub.agent || sub.id);
        subContent.appendChild(subName);

        // Elapsed time
        if (sub.startedAt || sub.createdAt) {
          var elapsedEl = document.createElement('span');
          elapsedEl.className = 'ad-sub-elapsed';
          elapsedEl.textContent = '\u23F1 ' + elapsedStr(sub.startedAt || sub.createdAt);
          subContent.appendChild(elapsedEl);
        }

        var subBadge = window.wk.badge(subState.replace(/-/g, ' '), AD_STATE_BADGE_VARIANT[subState] || 'info');
        subContent.appendChild(subBadge);

        subCard.appendChild(subContent);

        // Detail section: task, worktree path
        var detailSection = document.createElement('div');
        detailSection.className = 'ad-sub-detail';

        // Task description
        if (sub.task || sub.description) {
          var taskRow = document.createElement('div');
          taskRow.className = 'ad-sub-detail-row';
          taskRow.innerHTML = '<span class="ad-sub-label">Task:</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml((sub.task || sub.description || '').slice(0, 80)) + '</span>';
          detailSection.appendChild(taskRow);
        }

        // Worktree path
        if (sub.worktreePath || sub.worktree || sub.cwd) {
          var wtRow = document.createElement('div');
          wtRow.className = 'ad-sub-detail-row';
          wtRow.innerHTML = '<span class="ad-sub-label">Path:</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:\'SF Mono\',Menlo,monospace;font-size:9px;">' + escHtml(sub.worktreePath || sub.worktree || sub.cwd) + '</span>';
          detailSection.appendChild(wtRow);
        }

        subCard.appendChild(detailSection);

        // Progress bar
        if (sub.progress != null || sub.progressValue != null) {
          var progressContainer = document.createElement('div');
          progressContainer.className = 'ad-sub-progress';
          var progVal = sub.progress || sub.progressValue || 0;
          var progMax = sub.progressMax || 100;
          progressContainer.appendChild(window.wk.progress(progVal, progMax));
          subCard.appendChild(progressContainer);
        }

        // Actions row: Cancel button
        var subActions = document.createElement('div');
        subActions.className = 'ad-sub-actions';

        var peekSubBtn = document.createElement('button');
        peekSubBtn.className = 'ad-action-btn';
        peekSubBtn.textContent = '\uD83D\uDC41 Peek';
        peekSubBtn.setAttribute('aria-label', 'Peek at subagent messages');
        (function(subRef) {
          peekSubBtn.addEventListener('click', function (e) { e.stopPropagation(); self.peekSession(subRef); });
        })(sub);
        subActions.appendChild(peekSubBtn);

        var cancelSubBtn = document.createElement('button');
        cancelSubBtn.className = 'ad-action-btn danger';
        cancelSubBtn.textContent = '\u2716 Cancel';
        cancelSubBtn.setAttribute('aria-label', 'Cancel this subagent');
        (function(subRef, cardRef) {
          cancelSubBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            self.cancelSubagent(subRef, cardRef);
          });
        })(sub, subCard);
        subActions.appendChild(cancelSubBtn);

        subCard.appendChild(subActions);
        subContainer.appendChild(subCard);
      }
      card.appendChild(subContainer);
    }

    return card;
  };

  // ─── Dispatch ────────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.dispatchSession = function (task) {
    var self = this;
    var a = api();
    if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

    disableBtn(self.dispatchBtn);
    window.wk.toast('Dispatching session...', 'info');

    a.invoke('parallel:create', { task: task }).then(function () {
      window.wk.toast('Session dispatched', 'success');
      self.dispatchInput.value = '';
      enableBtn(self.dispatchBtn);
      self.loadSessions();
    }).catch(function (err) {
      window.wk.toast('Failed to dispatch: ' + (err && err.message || err), 'error');
      enableBtn(self.dispatchBtn);
    });
  };

  // ─── Peek ────────────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.peekSession = function (session) {
    var self = this;
    var a = api();
    if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

    a.invoke('parallel:get-messages', { sessionId: session.id, limit: 5 }).then(function (messages) {
      var msgs = Array.isArray(messages) ? messages : (messages && messages.messages) || [];
      self.showPeekOverlay(session, msgs);
    }).catch(function (err) {
      window.wk.toast('Failed to peek: ' + (err && err.message || err), 'error');
    });
  };

  AgentDashboardV2Panel.prototype.showPeekOverlay = function (session, messages) {
    var self = this;
    this.peekEl.style.display = 'block';
    this.peekEl.innerHTML = '';
    this.peekVisible = true;

    // Header row
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';

    var titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
    titleEl.textContent = 'Peek: ' + (session.name || session.id);
    header.appendChild(titleEl);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'ad-action-btn';
    closeBtn.textContent = '\u2716 Close';
    closeBtn.setAttribute('aria-label', 'Close peek overlay');
    closeBtn.addEventListener('click', function () {
      self.peekEl.style.display = 'none';
      self.peekVisible = false;
    });
    header.appendChild(closeBtn);

    this.peekEl.appendChild(header);

    // Messages
    if (messages.length === 0) {
      var emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'font-size:11px;color:var(--text-dim);text-align:center;padding:12px;';
      emptyMsg.textContent = 'No recent messages.';
      this.peekEl.appendChild(emptyMsg);
    } else {
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        var role = m.role || 'system';
        var roleColor = AD_ROLE_COLORS[role] || 'var(--text-dim)';

        var msgEl = document.createElement('div');
        msgEl.className = 'ad-peek-msg';
        msgEl.style.borderLeftColor = roleColor;

        var roleLabel = document.createElement('span');
        roleLabel.style.cssText = 'font-size:10px;font-weight:600;color:' + roleColor + ';text-transform:uppercase;display:block;margin-bottom:2px;';
        roleLabel.textContent = role;
        msgEl.appendChild(roleLabel);

        var content = document.createElement('span');
        content.style.cssText = 'color:var(--text-secondary);word-break:break-word;';
        content.textContent = (m.content || '').slice(0, 150) + ((m.content || '').length > 150 ? '...' : '');
        msgEl.appendChild(content);

        // Tool call info: render tool_calls from assistant messages
        if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          for (var tc = 0; tc < m.tool_calls.length; tc++) {
            var toolCall = m.tool_calls[tc];
            var toolCardEl = document.createElement('div');
            toolCardEl.className = 'ad-peek-tool-card';

            var toolNameEl = document.createElement('div');
            toolNameEl.className = 'ad-peek-tool-name';
            toolNameEl.textContent = '\uD83D\uDD27 ' + (toolCall.function && toolCall.function.name || toolCall.name || toolCall.type || 'tool');
            toolCardEl.appendChild(toolNameEl);

            // Show arguments summary
            var argsStr = '';
            if (toolCall.function && toolCall.function.arguments) {
              argsStr = typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : JSON.stringify(toolCall.function.arguments);
            } else if (toolCall.arguments) {
              argsStr = typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments);
            } else if (toolCall.input) {
              argsStr = typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input);
            }
            if (argsStr) {
              var argsEl = document.createElement('div');
              argsEl.className = 'ad-peek-tool-args';
              argsEl.textContent = argsStr.slice(0, 200) + (argsStr.length > 200 ? '...' : '');
              toolCardEl.appendChild(argsEl);
            }

            msgEl.appendChild(toolCardEl);
          }
        }

        // Tool role messages: show as tool result card
        if (role === 'tool' && m.name) {
          var toolResultCard = document.createElement('div');
          toolResultCard.className = 'ad-peek-tool-card';

          var toolResultName = document.createElement('div');
          toolResultName.className = 'ad-peek-tool-name';
          toolResultName.textContent = '\u2192 Result: ' + m.name;
          toolResultCard.appendChild(toolResultName);

          if (m.content) {
            var resultContent = document.createElement('div');
            resultContent.className = 'ad-peek-tool-args';
            resultContent.textContent = (m.content || '').slice(0, 200) + ((m.content || '').length > 200 ? '...' : '');
            toolResultCard.appendChild(resultContent);
          }

          msgEl.appendChild(toolResultCard);
        }

        this.peekEl.appendChild(msgEl);
      }
    }
  };

  // ─── Rename (Inline editable field) ──────────────────────────────

  AgentDashboardV2Panel.prototype.startRename = function (session, card, nameEl) {
    var self = this;

    // Replace the name element with an input
    var currentName = session.name || session.task || session.id || 'Session';
    var input = document.createElement('input');
    input.className = 'ad-rename-input';
    input.value = currentName;
    input.setAttribute('aria-label', 'Enter new session name');

    nameEl.style.display = 'none';
    nameEl.parentNode.insertBefore(input, nameEl);
    input.focus();
    input.select();

    function finishRename() {
      var newName = input.value.trim();
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
      nameEl.style.display = '';

      if (!newName || newName === currentName) return;

      var a = api();
      if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

      a.invoke('parallel:update', { sessionId: session.id, name: newName }).then(function () {
        nameEl.textContent = newName;
        session.name = newName;
        window.wk.toast('Session renamed', 'success');
      }).catch(function (err) {
        window.wk.toast('Rename failed: ' + (err && err.message || err), 'error');
      });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finishRename(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (input.parentNode) input.parentNode.removeChild(input);
        nameEl.style.display = '';
      }
    });

    input.addEventListener('blur', function () {
      finishRename();
    });
  };

  // ─── Stop (with confirm dialog) ─────────────────────────────────

  AgentDashboardV2Panel.prototype.stopSession = function (session, card) {
    var self = this;
    var sessionName = session.name || session.task || session.id || 'Session';

    // Remove any existing confirm in this card
    var existingConfirm = card.querySelector('.wk-confirm');
    if (existingConfirm) { existingConfirm.remove(); return; }

    var confirmEl = window.wk.confirm(
      'Stop session "' + sessionName + '"? This will release all resources.',
      function () {
        var a = api();
        if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

        // Disable all action buttons in this card during the operation
        var btns = card.querySelectorAll('.ad-action-btn');
        for (var i = 0; i < btns.length; i++) disableBtn(btns[i]);

        a.invoke('parallel:delete', { sessionId: session.id }).then(function () {
          window.wk.toast('Session stopped', 'success');
          self.loadSessions();
        }).catch(function (err) {
          window.wk.toast('Stop failed: ' + (err && err.message || err), 'error');
          for (var i = 0; i < btns.length; i++) enableBtn(btns[i]);
        });
      }
    );

    card.appendChild(confirmEl);
  };

  // ─── Cancel Subagent (individual, without affecting parent/siblings) ──

  AgentDashboardV2Panel.prototype.cancelSubagent = function (subagent, cardEl) {
    var self = this;
    var subName = subagent.name || subagent.agent || subagent.id || 'Subagent';

    // Remove any existing confirm in this card
    var existingConfirm = cardEl.querySelector('.wk-confirm');
    if (existingConfirm) { existingConfirm.remove(); return; }

    var confirmEl = window.wk.confirm(
      'Cancel subagent "' + subName + '"? Parent and sibling agents will continue.',
      function () {
        var a = api();
        if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

        // Disable buttons in this subagent card
        var btns = cardEl.querySelectorAll('.ad-action-btn');
        for (var i = 0; i < btns.length; i++) disableBtn(btns[i]);

        a.invoke('parallel:delete', { sessionId: subagent.id }).then(function () {
          window.wk.toast('Subagent "' + subName + '" cancelled', 'success');
          self.loadSessions();
        }).catch(function (err) {
          window.wk.toast('Cancel failed: ' + (err && err.message || err), 'error');
          for (var i = 0; i < btns.length; i++) enableBtn(btns[i]);
        });
      }
    );

    cardEl.appendChild(confirmEl);
  };

  // ─── Cleanup ─────────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.destroy = function () {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unsubscribeSubagentEvents();
    if (this.container) this.container.innerHTML = '';
  };

  // ─── Exports ─────────────────────────────────────────────────────

  if (typeof window !== 'undefined') { window.AgentDashboardV2Panel = AgentDashboardV2Panel; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { AgentDashboardV2Panel: AgentDashboardV2Panel }; }

})();
