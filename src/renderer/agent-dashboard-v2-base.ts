// @ts-nocheck
/**
 * AgentDashboardV2 — Base utilities, event subscriptions, and peek overlay.
 *
 * This file is loaded before agent-dashboard-v2-panel.ts and registers
 * shared helpers, constants, styles, event subscription methods, and
 * peek overlay methods on window._adv2 for the main panel to consume.
 *
 * Extracted to keep agent-dashboard-v2-panel.ts under the 2000-line ratchet.
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────

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

  function adGetRuntimeAgents() {
    var sessions = [];
    var active = window.activeAgents || [];
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      var name = typeof a === 'string' ? a : (a.name || a.agent || 'Agent');
      sessions.push({ id: 'runtime-active-' + i, name: name, status: 'running', task: typeof a === 'object' ? (a.task || a.model || '') : '', provider: typeof a === 'object' ? a.provider : undefined, model: typeof a === 'object' ? a.model : undefined, createdAt: Date.now() });
    }
    var completed = window.completedAgents || [];
    for (var j = 0; j < completed.length; j++) {
      var c = completed[j];
      var cname = typeof c === 'string' ? c : (c.name || c.agent || 'Agent');
      sessions.push({ id: 'runtime-completed-' + j, name: cname, status: 'completed', task: typeof c === 'object' ? (c.task || c.model || '') : '', provider: typeof c === 'object' ? c.provider : undefined, model: typeof c === 'object' ? c.model : undefined, createdAt: Date.now() - 60000 });
    }
    return sessions;
  }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  function injectPanelStyles() {
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

  // ─── Install Subscription Methods ─────────────────────────────────

  function installSubscriptionMethods(Panel) {

    Panel.prototype.subscribeSubagentEvents = function () {
      var self = this;
      this.unsubscribeSubagentEvents();
      if (!window.subscribeEvent) return;

      var onSubagentProgress = function (data) {
        if (!data || !data.sessionId) return;
        var cardEl = self.listEl.querySelector('[data-subagent-id="' + data.sessionId + '"]');
        if (cardEl) {
          var progressContainer = cardEl.querySelector('.ad-sub-progress');
          if (progressContainer && data.progress != null) {
            progressContainer.innerHTML = '';
            progressContainer.appendChild(window.wk.progress(data.progress, data.progressMax || 100));
          } else if (!progressContainer && data.progress != null) {
            var newProgressContainer = document.createElement('div');
            newProgressContainer.className = 'ad-sub-progress';
            newProgressContainer.appendChild(window.wk.progress(data.progress, data.progressMax || 100));
            var actionsRow = cardEl.querySelector('.ad-sub-actions');
            if (actionsRow) { cardEl.insertBefore(newProgressContainer, actionsRow); } else { cardEl.appendChild(newProgressContainer); }
          }
          if (data.elapsedMs || data.startedAt) {
            var elapsedEl = cardEl.querySelector('.ad-sub-elapsed');
            if (elapsedEl) elapsedEl.textContent = '\u23F1 ' + elapsedStr(data.startedAt || (Date.now() - (data.elapsedMs || 0)));
          }
          if (data.task || data.description) {
            var detailSection = cardEl.querySelector('.ad-sub-detail');
            if (detailSection) { var taskRow = detailSection.querySelector('.ad-sub-detail-row'); if (taskRow) { var taskSpan = taskRow.querySelector('span:last-child'); if (taskSpan) taskSpan.textContent = (data.task || data.description || '').slice(0, 80); } }
          }
        } else { self.loadSessions(); }
      };

      var onSubagentCompleted = function (data) {
        if (!data) return;
        self.loadSessions();
        var subName = (data.name || data.agent || data.sessionId || 'Subagent');
        var status = data.status || 'completed';
        if (status === 'completed' || status === 'success') { window.wk.toast('Subagent "' + subName + '" completed', 'success'); }
        else if (status === 'failed' || status === 'error') { window.wk.toast('Subagent "' + subName + '" failed', 'error'); }
      };

      window.subscribeEvent('subagent:progress', onSubagentProgress);
      window.subscribeEvent('subagent:completed', onSubagentCompleted);
      self._eventUnsubs.push(function () { if (window.unsubscribeEvent) { window.unsubscribeEvent('subagent:progress', onSubagentProgress); window.unsubscribeEvent('subagent:completed', onSubagentCompleted); } });
    };

    Panel.prototype.unsubscribeSubagentEvents = function () {
      for (var i = 0; i < this._eventUnsubs.length; i++) { this._eventUnsubs[i](); }
      this._eventUnsubs = [];
    };

    Panel.prototype.subscribeChatStream = function () {
      var self = this;
      var a = api();
      if (!a || typeof a.on !== 'function') return;
      this.unsubscribeChatStream();

      this._chatStreamHandler = function (data) {
        if (!data || !data.msgId) return;
        if (data.start) {
          var sessionId = 'stream-' + data.msgId;
          var projectId = window._neuronestActiveProject || 'default';
          var matchedPreparingId = null;
          self._dashboardSessions.forEach(function (sess, id) {
            if (sess.status === 'preparing' && !matchedPreparingId) {
              var taskMatch = data.task && sess.task && data.task === sess.task;
              var timingMatch = (Date.now() - sess.startedAt) < 5000;
              if (taskMatch || timingMatch) matchedPreparingId = id;
            }
          });
          var session = { id: sessionId, name: data.agent || 'Agent', agentId: data.agentId || '', emoji: '\uD83E\uDD16', provider: data.provider || '', model: data.model || '', status: 'streaming', task: data.task || '', startedAt: Date.now(), buffer: '', projectId: projectId };
          if (matchedPreparingId) {
            var preparingSession = self._dashboardSessions.get(matchedPreparingId);
            if (preparingSession && preparingSession._timeout) clearTimeout(preparingSession._timeout);
            self.dispatchBtn.disabled = false;
            if (!session.task && preparingSession) session.task = preparingSession.task;
            if (preparingSession && preparingSession.name && preparingSession.name !== 'Agent' && session.name === 'Agent') session.name = preparingSession.name;
            if (preparingSession) session.startedAt = preparingSession.startedAt;
            self._dashboardSessions.delete(matchedPreparingId);
            for (var i = self.sessions.length - 1; i >= 0; i--) { if (self.sessions[i].id === matchedPreparingId) { self.sessions.splice(i, 1); break; } }
          }
          self._dashboardSessions.set(sessionId, session);
          self._mergeDashboardSessions();
          self.renderSessionList();
          self.lastRefresh = Date.now();
          self.updateRefreshBadge();
          return;
        }
        if (data.token != null) {
          var tokenSessionId = 'stream-' + data.msgId;
          var existingSession = self._dashboardSessions.get(tokenSessionId);
          if (!existingSession) return;
          existingSession.buffer += data.token;
          if (self._liveIndicator) {
            var liveDotEl = self._liveIndicator.querySelector('span:first-child');
            if (liveDotEl) {
              liveDotEl.classList.add('ad-live-pulsing');
              if (self._livePulseTimer) clearTimeout(self._livePulseTimer);
              self._livePulseTimer = setTimeout(function () { liveDotEl.classList.remove('ad-live-pulsing'); self._livePulseTimer = null; }, 200);
            }
          }
          var cardEl = self.listEl.querySelector('.ad-session-card[data-session-id="' + tokenSessionId + '"]');
          if (cardEl) { var elapsedDisplay = cardEl.querySelector('[data-elapsed-id="' + tokenSessionId + '"]'); if (elapsedDisplay) elapsedDisplay.textContent = elapsedStr(existingSession.startedAt); }
        }
      };
      a.on('chat:stream', this._chatStreamHandler);
    };

    Panel.prototype.unsubscribeChatStream = function () {
      if (this._chatStreamHandler) { var a = api(); if (a && typeof a.removeListener === 'function') a.removeListener('chat:stream', this._chatStreamHandler); this._chatStreamHandler = null; }
    };

    Panel.prototype._hydrateActiveAgents = function () {
      var activeAgents = window.activeAgents;
      if (!activeAgents || !Array.isArray(activeAgents) || activeAgents.length === 0) return;
      var projectId = window._neuronestActiveProject || 'default';
      for (var i = 0; i < activeAgents.length; i++) {
        var agent = activeAgents[i];
        if (!agent) continue;
        var msgId = agent.msgId || agent.id;
        if (!msgId) continue;
        var sessionId = 'stream-' + msgId;
        if (this._dashboardSessions.has(sessionId)) continue;
        this._dashboardSessions.set(sessionId, { id: sessionId, name: agent.agent || agent.name || 'Agent', agentId: agent.agentId || '', emoji: agent.emoji || '\uD83E\uDD16', provider: agent.provider || '', model: agent.model || '', status: 'streaming', task: agent.task || '', startedAt: agent.startedAt || Date.now(), buffer: '', projectId: projectId });
      }
      if (this._dashboardSessions.size > 0) { this._mergeDashboardSessions(); this.renderSessionList(); }
    };

    Panel.prototype.subscribeChatDone = function () {
      var self = this;
      var a = api();
      if (!a || typeof a.on !== 'function') return;
      this.unsubscribeChatDone();
      this._chatDoneHandler = function (data) {
        if (!data || !data.msgId) return;
        var sessionId = 'stream-' + data.msgId;
        var session = self._dashboardSessions.get(sessionId);
        if (!session) return;
        if (session.status === 'stopped') return;
        session.status = 'completed';
        session.completedAt = Date.now();
        self._dashboardSessions.set(sessionId, session);
        if (!self._panelVisible || !self._isPanelVisible()) { self._unreadCount++; self._updateWorkspacePillBadge(); }
        if (session.task && session.buffer) {
          var a2 = api();
          if (a2 && typeof a2.invoke === 'function') {
            a2.invoke('parallel:create', { id: session.id, projectId: session.projectId, name: session.name, task: session.task, status: 'completed', agent: session.name, agentId: session.agentId, emoji: session.emoji }).catch(function () {});
            a2.invoke('parallel:add-message', { sessionId: session.id, role: 'user', content: session.task }).catch(function () {});
            a2.invoke('parallel:add-message', { sessionId: session.id, role: 'assistant', content: session.buffer }).catch(function () {});
          }
        }
        self._mergeDashboardSessions();
        self.renderSessionList();
        self.lastRefresh = Date.now();
        self.updateRefreshBadge();
      };
      a.on('chat:done', this._chatDoneHandler);
    };

    Panel.prototype.unsubscribeChatDone = function () {
      if (this._chatDoneHandler) { var a = api(); if (a && typeof a.removeListener === 'function') a.removeListener('chat:done', this._chatDoneHandler); this._chatDoneHandler = null; }
    };

    Panel.prototype.subscribeChatError = function () {
      var self = this;
      var a = api();
      if (!a || typeof a.on !== 'function') return;
      this.unsubscribeChatError();
      this._chatErrorHandler = function (data) {
        if (!data || !data.msgId) return;
        var sessionId = 'stream-' + data.msgId;
        var session = self._dashboardSessions.get(sessionId);
        if (!session) return;
        if (session.status === 'stopped') return;
        session.status = 'failed';
        session.completedAt = Date.now();
        session.error = data.error || data.message || 'Unknown error';
        self._dashboardSessions.set(sessionId, session);
        self._mergeDashboardSessions();
        self.renderSessionList();
        self.lastRefresh = Date.now();
        self.updateRefreshBadge();
      };
      a.on('chat:error', this._chatErrorHandler);
    };

    Panel.prototype.unsubscribeChatError = function () {
      if (this._chatErrorHandler) { var a = api(); if (a && typeof a.removeListener === 'function') a.removeListener('chat:error', this._chatErrorHandler); this._chatErrorHandler = null; }
    };

    Panel.prototype.subscribeActiveProjectChange = function () {
      var self = this;
      var a = api();
      if (!a || typeof a.on !== 'function') return;
      this.unsubscribeActiveProjectChange();
      this._activeProjectHandler = function (data) { if (data && data.id) window._neuronestActiveProject = data.id; self.loadSessions(); };
      a.on('active-project', this._activeProjectHandler);
    };

    Panel.prototype.unsubscribeActiveProjectChange = function () {
      if (this._activeProjectHandler) { var a = api(); if (a && typeof a.removeListener === 'function') a.removeListener('active-project', this._activeProjectHandler); this._activeProjectHandler = null; }
    };

    Panel.prototype.subscribeCatalogUpdated = function () {
      var self = this;
      var a = api();
      if (!a || typeof a.on !== 'function') return;
      this.unsubscribeCatalogUpdated();
      this._catalogUpdatedHandler = function () { self._loadAgentDropdown(); self._loadAgentCatalog(); };
      a.on('agents:catalog-updated', this._catalogUpdatedHandler);
    };

    Panel.prototype.unsubscribeCatalogUpdated = function () {
      if (this._catalogUpdatedHandler) { var a = api(); if (a && typeof a.removeListener === 'function') a.removeListener('agents:catalog-updated', this._catalogUpdatedHandler); this._catalogUpdatedHandler = null; }
    };
  }

  // ─── Install Peek Methods ─────────────────────────────────────────

  function installPeekMethods(Panel) {

    Panel.prototype.peekSession = function (session) {
      var self = this;
      var a = api();
      if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }
      var isLiveStreaming = session.status === 'streaming' || session.status === 'preparing';
      if (isLiveStreaming) { self.showPeekOverlayLive(session); return; }
      var hasBuffer = session.buffer != null && session.buffer !== '';
      if (hasBuffer) { self.showPeekOverlayLive(session); return; }
      a.invoke('parallel:get-messages', { sessionId: session.id, limit: 5 }).then(function (messages) {
        var msgs = Array.isArray(messages) ? messages : (messages && messages.messages) || [];
        if (msgs.length === 0 && session.task) msgs = [{ role: 'user', content: session.task }];
        self.showPeekOverlay(session, msgs);
      }).catch(function (err) { window.wk.toast('Failed to peek: ' + (err && err.message || err), 'error'); });
    };

    Panel.prototype.showPeekOverlay = function (session, messages) {
      var self = this;
      this.peekEl.style.display = 'block';
      this.peekEl.innerHTML = '';
      this.peekVisible = true;
      this._clearPeekRefreshTimer();
      this._peekSessionId = null;

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
      closeBtn.addEventListener('click', function () { self._clearPeekRefreshTimer(); self._peekSessionId = null; self.peekEl.style.display = 'none'; self.peekVisible = false; });
      header.appendChild(closeBtn);
      this.peekEl.appendChild(header);

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

          if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            for (var tc = 0; tc < m.tool_calls.length; tc++) {
              var toolCall = m.tool_calls[tc];
              var toolCardEl = document.createElement('div');
              toolCardEl.className = 'ad-peek-tool-card';
              var toolNameEl = document.createElement('div');
              toolNameEl.className = 'ad-peek-tool-name';
              toolNameEl.textContent = '\uD83D\uDD27 ' + (toolCall.function && toolCall.function.name || toolCall.name || toolCall.type || 'tool');
              toolCardEl.appendChild(toolNameEl);
              var argsStr = '';
              if (toolCall.function && toolCall.function.arguments) { argsStr = typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : JSON.stringify(toolCall.function.arguments); }
              else if (toolCall.arguments) { argsStr = typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments); }
              else if (toolCall.input) { argsStr = typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input); }
              if (argsStr) { var argsEl = document.createElement('div'); argsEl.className = 'ad-peek-tool-args'; argsEl.textContent = argsStr.slice(0, 200) + (argsStr.length > 200 ? '...' : ''); toolCardEl.appendChild(argsEl); }
              msgEl.appendChild(toolCardEl);
            }
          }
          if (role === 'tool' && m.name) {
            var toolResultCard = document.createElement('div');
            toolResultCard.className = 'ad-peek-tool-card';
            var toolResultName = document.createElement('div');
            toolResultName.className = 'ad-peek-tool-name';
            toolResultName.textContent = '\u2192 Result: ' + m.name;
            toolResultCard.appendChild(toolResultName);
            if (m.content) { var resultContent = document.createElement('div'); resultContent.className = 'ad-peek-tool-args'; resultContent.textContent = (m.content || '').slice(0, 200) + ((m.content || '').length > 200 ? '...' : ''); toolResultCard.appendChild(resultContent); }
            msgEl.appendChild(toolResultCard);
          }
          this.peekEl.appendChild(msgEl);
        }
      }
    };

    Panel.prototype.showPeekOverlayLive = function (session) {
      var self = this;
      this.peekEl.style.display = 'block';
      this.peekEl.innerHTML = '';
      this.peekVisible = true;
      this._peekSessionId = session.id;
      this._clearPeekRefreshTimer();
      var isStreaming = session.status === 'streaming' || session.status === 'preparing';
      if (isStreaming) {
        this._peekRefreshTimer = setInterval(function () {
          if (!self._peekSessionId) { self._clearPeekRefreshTimer(); return; }
          var currentSession = self._dashboardSessions.get(self._peekSessionId);
          if (!currentSession) { self._clearPeekRefreshTimer(); return; }
          if (currentSession.status === 'completed' || currentSession.status === 'failed' || currentSession.status === 'stopped') { self._clearPeekRefreshTimer(); self.showPeekOverlayLive(currentSession); return; }
          self.showPeekOverlayLive(currentSession);
        }, 500);
      }

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
      var titleEl = document.createElement('span');
      titleEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      titleEl.textContent = 'Peek: ' + (session.name || session.id) + ' (live)';
      header.appendChild(titleEl);
      var closeBtn = document.createElement('button');
      closeBtn.className = 'ad-action-btn';
      closeBtn.textContent = '\u2716 Close';
      closeBtn.setAttribute('aria-label', 'Close peek overlay');
      closeBtn.addEventListener('click', function () { self._clearPeekRefreshTimer(); self._peekSessionId = null; self.peekEl.style.display = 'none'; self.peekVisible = false; });
      header.appendChild(closeBtn);
      this.peekEl.appendChild(header);

      if (session.task) {
        var userMsgEl = document.createElement('div');
        userMsgEl.className = 'ad-peek-msg';
        userMsgEl.style.borderLeftColor = AD_ROLE_COLORS['user'];
        var userLabel = document.createElement('span');
        userLabel.style.cssText = 'font-size:10px;font-weight:600;color:' + AD_ROLE_COLORS['user'] + ';text-transform:uppercase;display:block;margin-bottom:2px;';
        userLabel.textContent = 'user';
        userMsgEl.appendChild(userLabel);
        var userContent = document.createElement('span');
        userContent.style.cssText = 'color:var(--text-secondary);word-break:break-word;';
        userContent.textContent = session.task;
        userMsgEl.appendChild(userContent);
        this.peekEl.appendChild(userMsgEl);
      }

      var assistantMsgEl = document.createElement('div');
      assistantMsgEl.className = 'ad-peek-msg';
      assistantMsgEl.style.borderLeftColor = AD_ROLE_COLORS['assistant'];
      var assistantLabel = document.createElement('span');
      assistantLabel.style.cssText = 'font-size:10px;font-weight:600;color:' + AD_ROLE_COLORS['assistant'] + ';text-transform:uppercase;display:block;margin-bottom:2px;';
      assistantLabel.textContent = 'assistant';
      assistantMsgEl.appendChild(assistantLabel);
      var assistantContent = document.createElement('span');
      assistantContent.style.cssText = 'color:var(--text-secondary);word-break:break-word;white-space:pre-wrap;';
      if (session.buffer && session.buffer.length > 0) {
        assistantContent.textContent = session.buffer.length > 500 ? session.buffer.slice(0, 500) + '\u2026' : session.buffer;
      } else {
        assistantContent.style.color = 'var(--text-dim)';
        assistantContent.style.fontStyle = 'italic';
        assistantContent.textContent = 'Waiting for response\u2026';
      }
      assistantMsgEl.appendChild(assistantContent);

      if (session.buffer && session.buffer.length > 0) {
        var toolCalls = this.parseToolCallsFromBuffer(session.buffer);
        for (var tc = 0; tc < toolCalls.length; tc++) {
          var toolCall = toolCalls[tc];
          var toolCardEl = document.createElement('div');
          toolCardEl.className = 'ad-peek-tool-card';
          var toolNameEl = document.createElement('div');
          toolNameEl.className = 'ad-peek-tool-name';
          toolNameEl.textContent = '\uD83D\uDD27 ' + (toolCall.name || 'tool');
          toolCardEl.appendChild(toolNameEl);
          if (toolCall.arguments) { var argsEl = document.createElement('div'); argsEl.className = 'ad-peek-tool-args'; var argsStr = typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments); argsEl.textContent = argsStr.slice(0, 200) + (argsStr.length > 200 ? '\u2026' : ''); toolCardEl.appendChild(argsEl); }
          assistantMsgEl.appendChild(toolCardEl);
        }
      }
      this.peekEl.appendChild(assistantMsgEl);
    };

    Panel.prototype.parseToolCallsFromBuffer = function (buffer) {
      var results = [];
      if (!buffer || typeof buffer !== 'string') return results;
      var xmlPattern = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/g;
      var xmlMatch;
      while ((xmlMatch = xmlPattern.exec(buffer)) !== null) {
        var inner = xmlMatch[1].trim();
        try { var parsed = JSON.parse(inner); results.push({ name: parsed.name || parsed.function || 'tool', arguments: parsed.arguments || parsed.parameters || parsed.input || '' }); }
        catch (e) { var lines = inner.split('\n'); results.push({ name: lines[0].trim() || 'tool', arguments: lines.slice(1).join('\n').trim() }); }
      }
      var jsonPattern = /\{"(?:type"\s*:\s*"function"\s*,\s*")?function"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}[^}]*\}/g;
      var jsonMatch;
      while ((jsonMatch = jsonPattern.exec(buffer)) !== null) {
        try { var obj = JSON.parse(jsonMatch[0]); var fn = obj.function || obj; var toolName = fn.name || 'tool'; var toolArgs = fn.arguments || fn.parameters || ''; var isDuplicate = results.some(function (r) { return r.name === toolName; }); if (!isDuplicate) results.push({ name: toolName, arguments: toolArgs }); }
        catch (e2) { if (jsonMatch[1]) results.push({ name: jsonMatch[1], arguments: '' }); }
      }
      var markerPattern = /(?:@@TOOL|@@FUNCTION|\[TOOL_USE\]|\[tool_use\]):\s*(\w+)(?:\(([^)]*)\))?/g;
      var markerMatch;
      while ((markerMatch = markerPattern.exec(buffer)) !== null) {
        var mName = markerMatch[1] || 'tool';
        var mArgs = markerMatch[2] || '';
        var isDup = results.some(function (r) { return r.name === mName; });
        if (!isDup) results.push({ name: mName, arguments: mArgs });
      }
      return results;
    };

    Panel.prototype._clearPeekRefreshTimer = function () {
      if (this._peekRefreshTimer) { clearInterval(this._peekRefreshTimer); this._peekRefreshTimer = null; }
    };
  }

  // ─── Export on window ────────────────────────────────────────────

  window._adv2 = {
    AD_STATE_COLORS: AD_STATE_COLORS,
    AD_STATE_BADGE_VARIANT: AD_STATE_BADGE_VARIANT,
    AD_ROLE_COLORS: AD_ROLE_COLORS,
    AD_REFRESH_INTERVAL: AD_REFRESH_INTERVAL,
    api: api,
    escHtml: escHtml,
    disableBtn: disableBtn,
    enableBtn: enableBtn,
    relTime: relTime,
    classifyState: classifyState,
    elapsedStr: elapsedStr,
    adGetRuntimeAgents: adGetRuntimeAgents,
    injectPanelStyles: injectPanelStyles,
    installSubscriptionMethods: installSubscriptionMethods,
    installPeekMethods: installPeekMethods
  };

})();
