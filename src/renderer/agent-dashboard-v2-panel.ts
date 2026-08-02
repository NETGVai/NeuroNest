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
 *
 * NOTE: Helper functions, event subscriptions, and peek overlay logic are in
 * agent-dashboard-v2-base.ts (loaded first) and registered on window._adv2.
 */

(function () {
  'use strict';

  // ─── Load shared utilities from base module ──────────────────────

  var base = window._adv2;
  var AD_STATE_COLORS = base.AD_STATE_COLORS;
  var AD_STATE_BADGE_VARIANT = base.AD_STATE_BADGE_VARIANT;
  var AD_REFRESH_INTERVAL = base.AD_REFRESH_INTERVAL;
  var adApi = base.api;
  var escHtml = base.escHtml;
  var disableBtn = base.disableBtn;
  var enableBtn = base.enableBtn;
  var relTime = base.relTime;
  var classifyState = base.classifyState;
  var elapsedStr = base.elapsedStr;
  var adGetRuntimeAgents = base.adGetRuntimeAgents;

  // ─── Inject Panel Styles ─────────────────────────────────────────

  base.injectPanelStyles();

  // ─── Panel Class ─────────────────────────────────────────────────

  function AgentDashboardV2Panel(container, options) {
    this.container = container;
    this.sessions = [];
    this.lastRefresh = Date.now();
    this.refreshTimer = null;
    this.peekVisible = false;
    this._eventUnsubs = [];
    this._dashboardSessions = new Map();
    this._chatStreamHandler = null;
    this._chatDoneHandler = null;
    this._chatErrorHandler = null;
    this._peekRefreshTimer = null;
    this._refreshBadgeTimer = null;
    this._peekSessionId = null;
    this._historyCollapsed = false;
    this._historyCollapsedInitialized = false;
    this._agentsCatalogCollapsed = true;
    this._agentsCatalogCollapsedInitialized = false;
    this._agentsCatalogEl = null;
    this._agents = [];
    this._departments = [];
    this._activeProjectHandler = null;
    this._catalogUpdatedHandler = null;
    this._savedScrollPosition = 0;
    this._unreadCount = 0;
    this._panelVisible = true;
    this._liveIndicator = null;
    this._livePulseTimer = null;
  }

  // Install extracted methods onto the prototype
  base.installSubscriptionMethods(AgentDashboardV2Panel);
  base.installPeekMethods(AgentDashboardV2Panel);

  AgentDashboardV2Panel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'wk-scroll';
    this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;display:flex;flex-direction:column;';

    // Mark panel as visible and reset unread badge (Req 7.4)
    this._panelVisible = true;
    this._unreadCount = 0;
    this._updateWorkspacePillBadge();

    // Header row
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';

    var title = document.createElement('h3');
    title.style.cssText = 'margin:0;font-size:16px;font-weight:600;color:var(--text-primary);';
    title.textContent = 'Agent Dashboard';
    header.appendChild(title);

    // Live indicator (Req 1.5): green dot + "Live" text confirming real-time event subscription
    if (window.EventStreamBus && typeof window.EventStreamBus.createLiveIndicator === 'function') {
      this._liveIndicator = window.EventStreamBus.createLiveIndicator();
    } else {
      // Inline fallback implementation if EventStreamBus is not available
      this._liveIndicator = document.createElement('div');
      this._liveIndicator.setAttribute('role', 'status');
      this._liveIndicator.setAttribute('aria-live', 'polite');
      this._liveIndicator.setAttribute('aria-label', 'Event stream status: connected');
      this._liveIndicator.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;';
      var liveDot = document.createElement('span');
      liveDot.textContent = '\u25CF';
      liveDot.style.cssText = 'color:var(--green, #4ade80);font-size:10px;';
      this._liveIndicator.appendChild(liveDot);
      var liveLabel = document.createElement('span');
      liveLabel.textContent = 'Live';
      liveLabel.style.cssText = 'color:var(--text-dim, #5a5a5a);';
      this._liveIndicator.appendChild(liveLabel);
    }
    this._liveIndicator.style.marginLeft = '8px';
    this._liveIndicator.style.marginRight = 'auto';
    header.appendChild(this._liveIndicator);

    // Refresh badge
    this.refreshBadge = document.createElement('div');
    this.refreshBadge.className = 'ad-refresh-badge';
    this.refreshBadge.innerHTML = '\u21BB Updated just now';
    header.appendChild(this.refreshBadge);

    this.container.appendChild(header);

    // Dispatch row
    var dispatchRow = document.createElement('div');
    dispatchRow.className = 'ad-dispatch-row';

    // Project selector dropdown (leftmost in dispatch row)
    this.projectSelect = document.createElement('select');
    this.projectSelect.className = 'wk-input';
    this.projectSelect.style.cssText = 'width:auto;min-width:120px;max-width:180px;font-size:12px;padding:4px 8px;';
    this.projectSelect.setAttribute('aria-label', 'Select project for dispatch');
    var defaultProjectOpt = document.createElement('option');
    defaultProjectOpt.value = 'default';
    defaultProjectOpt.textContent = 'Default Project';
    this.projectSelect.appendChild(defaultProjectOpt);

    // Override value property to support programmatic value assignment even before
    // async options are loaded.
    (function (selectEl) {
      var _storedValue = 'default';
      var proto = Object.getPrototypeOf(selectEl);
      var _nativeDescriptor = null;
      while (proto && !_nativeDescriptor) {
        _nativeDescriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        proto = Object.getPrototypeOf(proto);
      }
      Object.defineProperty(selectEl, 'value', {
        get: function () {
          var nativeVal = _nativeDescriptor && _nativeDescriptor.get
            ? _nativeDescriptor.get.call(selectEl)
            : '';
          return nativeVal || _storedValue;
        },
        set: function (v) {
          _storedValue = v;
          if (_nativeDescriptor && _nativeDescriptor.set) {
            _nativeDescriptor.set.call(selectEl, v);
          }
        },
        configurable: true,
        enumerable: true
      });
    })(this.projectSelect);

    dispatchRow.appendChild(this.projectSelect);

    // Agent selector dropdown (left of dispatch input)
    this.agentSelect = document.createElement('select');
    this.agentSelect.className = 'wk-input';
    this.agentSelect.style.cssText = 'width:auto;min-width:140px;max-width:180px;font-size:12px;padding:4px 8px;';
    this.agentSelect.setAttribute('aria-label', 'Select agent for dispatch');
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Auto (Orchestrator)';
    this.agentSelect.appendChild(defaultOpt);
    dispatchRow.appendChild(this.agentSelect);

    this.dispatchInput = document.createElement('input');
    this.dispatchInput.className = 'wk-input';
    this.dispatchInput.style.cssText = 'flex:1;';
    this.dispatchInput.placeholder = 'Describe your task...';
    this.dispatchInput.setAttribute('aria-label', 'Dispatch new agent session');
    this.dispatchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && self.dispatchInput.value.trim()) {
        self.dispatchSession(self.dispatchInput.value.trim());
      }
    });
    dispatchRow.appendChild(this.dispatchInput);

    this.dispatchBtn = document.createElement('button');
    this.dispatchBtn.className = 'wk-btn-primary';
    this.dispatchBtn.textContent = 'Go';
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

    // Populate agent dropdown from registry (Req 2.1)
    this._loadAgentDropdown();

    // Populate project dropdown from get-projects IPC (Req 2.1)
    this._loadProjectDropdown();

    // Load agent catalog from departments (Req 6.1, 6.4)
    this._loadAgentCatalog();

    // Load initial data
    this.loadSessions();

    // Start auto-refresh
    this.startAutoRefresh();

    // Subscribe to real-time subagent events
    this.subscribeSubagentEvents();

    // Hydrate any already-running agents from window.activeAgents (Req 7.1, 7.2)
    this._hydrateActiveAgents();

    // Subscribe to chat:stream for live agent tracking (Req 7.1, 1.1)
    this.subscribeChatStream();

    // Subscribe to chat:done to transition sessions to completed state (Req 1.4, 7.1)
    this.subscribeChatDone();

    // Subscribe to chat:error to transition sessions to failed state (Req 1.4, 7.1)
    this.subscribeChatError();

    // Subscribe to active-project event to reload dashboard on project switch (Req 7.3)
    this.subscribeActiveProjectChange();

    // Subscribe to agent catalog updates (import completed after initial render)
    this.subscribeCatalogUpdated();

    // Restore saved scroll position after DOM layout (Req 7.4)
    var savedPos = this._savedScrollPosition;
    if (savedPos > 0) {
      requestAnimationFrame(function () {
        self.container.scrollTop = savedPos;
      });
    }
  };

  // ─── Load Agent Dropdown (Req 2.1) ────────────────────────────────

  AgentDashboardV2Panel.prototype._loadAgentDropdown = function () {
    var self = this;
    var a = adApi();
    if (!a || typeof a.invoke !== 'function') return;

    a.invoke('get-agents').then(function (agents) {
      if (!Array.isArray(agents) || agents.length === 0) return;

      while (self.agentSelect.children.length > 1) {
        self.agentSelect.removeChild(self.agentSelect.children[1]);
      }

      var departments = {};
      for (var i = 0; i < agents.length; i++) {
        var agent = agents[i];
        if (!agent || !agent.id) continue;
        var dept = agent.department || 'Other';
        if (!departments[dept]) departments[dept] = [];
        departments[dept].push(agent);
      }

      var deptNames = Object.keys(departments);
      for (var d = 0; d < deptNames.length; d++) {
        var deptName = deptNames[d];
        var group = document.createElement('optgroup');
        group.label = deptName;

        var deptAgents = departments[deptName];
        for (var j = 0; j < deptAgents.length; j++) {
          var ag = deptAgents[j];
          var opt = document.createElement('option');
          opt.value = ag.id;
          opt.textContent = (ag.emoji || '\uD83E\uDD16') + ' ' + (ag.name || ag.id);
          group.appendChild(opt);
        }

        self.agentSelect.appendChild(group);
      }
    }).catch(function () {});
  };

  // ─── Load Project Dropdown (Req 2.1, 2.3, 2.5) ─────────────────────

  AgentDashboardV2Panel.prototype._loadProjectDropdown = function () {
    var self = this;
    var a = adApi();
    if (!a || typeof a.invoke !== 'function') return;

    a.invoke('get-projects').then(function (projects) {
      if (!Array.isArray(projects) || projects.length === 0) return;

      while (self.projectSelect.children.length > 1) {
        self.projectSelect.removeChild(self.projectSelect.children[1]);
      }

      for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        if (!project || !project.id) continue;
        var opt = document.createElement('option');
        opt.value = project.id;
        opt.textContent = project.name || project.id;
        self.projectSelect.appendChild(opt);
      }

      var activeProject = window._neuronestActiveProject;
      if (activeProject) {
        for (var j = 0; j < self.projectSelect.options.length; j++) {
          if (self.projectSelect.options[j].value === activeProject) {
            self.projectSelect.value = activeProject;
            break;
          }
        }
      }
    }).catch(function () {});
  };

  // ─── Load Agent Catalog (Req 6.1, 6.4) ────────────────────────────

  AgentDashboardV2Panel.prototype._loadAgentCatalog = function () {
    var self = this;
    var a = adApi();
    if (!a || typeof a.invoke !== 'function') return;

    a.invoke('get-departments').then(function (departments) {
      if (!Array.isArray(departments)) {
        self._departments = [];
        self._agents = [];
        return;
      }

      self._departments = departments;

      var allAgents = [];
      for (var i = 0; i < departments.length; i++) {
        var dept = departments[i];
        if (dept && Array.isArray(dept.agents)) {
          for (var j = 0; j < dept.agents.length; j++) {
            allAgents.push(dept.agents[j]);
          }
        }
      }
      self._agents = allAgents;

      self.renderSessionList();
    }).catch(function () {
      self._departments = [];
      self._agents = [];
    });
  };

  // ─── Auto-Refresh ────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.startAutoRefresh = function () {
    var self = this;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(function () {
      self.loadSessions();
      self.updateRefreshBadge();
    }, AD_REFRESH_INTERVAL);

    if (this._refreshBadgeTimer) clearInterval(this._refreshBadgeTimer);
    this._refreshBadgeTimer = setInterval(function () {
      self.updateRefreshBadge();
    }, 1000);
  };

  /**
   * Merge _dashboardSessions (live streaming sessions) into the sessions array
   * used for rendering. Avoids duplicates by checking existing session IDs.
   */
  AgentDashboardV2Panel.prototype._mergeDashboardSessions = function () {
    var existingIds = {};
    for (var i = 0; i < this.sessions.length; i++) {
      existingIds[this.sessions[i].id] = true;
    }

    var self = this;
    self._dashboardSessions.forEach(function (session, id) {
      if (!existingIds[id]) {
        self.sessions.push(session);
      } else {
        for (var j = 0; j < self.sessions.length; j++) {
          if (self.sessions[j].id === id) {
            self.sessions[j] = session;
            break;
          }
        }
      }
    });
  };

  AgentDashboardV2Panel.prototype.updateRefreshBadge = function () {
    if (this.refreshBadge) {
      this.refreshBadge.innerHTML = '\u21BB Updated ' + relTime(this.lastRefresh);
    }

    if (this._liveIndicator) {
      var timeSinceLastEvent = Date.now() - this.lastRefresh;
      var hasActiveSessions = false;

      this._dashboardSessions.forEach(function (sess) {
        if (hasActiveSessions) return;
        var status = (sess.status || '').toLowerCase();
        if (status === 'streaming' || status === 'preparing') {
          hasActiveSessions = true;
        }
      });

      var dotEl = this._liveIndicator.querySelector('span:first-child');
      var labelEl = this._liveIndicator.querySelector('span:last-child');

      if (dotEl && labelEl) {
        if (timeSinceLastEvent > 30000 && hasActiveSessions) {
          dotEl.style.color = 'var(--yellow, #fbbf24)';
          labelEl.textContent = 'Reconnecting\u2026';
          labelEl.style.color = 'var(--yellow, #fbbf24)';
          this._liveIndicator.setAttribute('aria-label', 'Event stream status: reconnecting');
        } else {
          dotEl.style.color = 'var(--green, #4ade80)';
          labelEl.textContent = 'Live';
          labelEl.style.color = 'var(--text-dim, #5a5a5a)';
          this._liveIndicator.setAttribute('aria-label', 'Event stream status: connected');
        }
      }
    }
  };

  // ─── Data Loading ────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.loadSessions = function () {
    var self = this;
    var a = adApi();
    if (!a) {
      this.listEl.innerHTML = '';
      this.listEl.appendChild(window.wk.emptyState('\u26A0\uFE0F', 'IPC Unavailable', 'Cannot connect to the main process.'));
      return;
    }

    var projectId = window._neuronestActiveProject || 'default';

    a.invoke('parallel:list', projectId).then(function (result) {
      var sessions = Array.isArray(result) ? result : (result && result.sessions) || [];

      var runtimeAgents = adGetRuntimeAgents();

      var existingIds = {};
      for (var i = 0; i < sessions.length; i++) {
        existingIds[sessions[i].id] = true;
        if (sessions[i].name) existingIds[sessions[i].name] = true;
      }
      for (var j = 0; j < runtimeAgents.length; j++) {
        if (!existingIds[runtimeAgents[j].id] && !existingIds[runtimeAgents[j].name]) {
          sessions.push(runtimeAgents[j]);
        }
      }

      self.sessions = sessions;
      self._mergeDashboardSessions();
      self.lastRefresh = Date.now();
      self.renderSessionList();
      self.updateRefreshBadge();
    }).catch(function (err) {
      var runtimeAgents = adGetRuntimeAgents();
      if (runtimeAgents.length > 0) {
        self.sessions = runtimeAgents;
        self._mergeDashboardSessions();
        self.lastRefresh = Date.now();
        self.renderSessionList();
        self.updateRefreshBadge();
      } else if (self._dashboardSessions.size > 0) {
        self.sessions = [];
        self._mergeDashboardSessions();
        self.lastRefresh = Date.now();
        self.renderSessionList();
        self.updateRefreshBadge();
      } else {
        self.listEl.innerHTML = '';
        self.listEl.appendChild(window.wk.emptyState('\u274C', 'Failed to load sessions', String(err && err.message || err || 'Unknown error')));
      }
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

    // Filter by current project (Req 7.3)
    var currentProject = window._neuronestActiveProject || 'default';
    parentSessions = parentSessions.filter(function (sess) {
      return !sess.projectId || sess.projectId === currentProject;
    });

    // Split into Active vs History sections (Req 5.2)
    var ACTIVE_STATUSES = ['streaming', 'preparing', 'running', 'responding', 'executing', 'active'];
    var activeSessions = [];
    var historySessions = [];

    for (var k = 0; k < parentSessions.length; k++) {
      var session = parentSessions[k];
      var sessionStatus = (session.status || '').toLowerCase();
      if (ACTIVE_STATUSES.indexOf(sessionStatus) !== -1) {
        activeSessions.push(session);
      } else {
        historySessions.push(session);
      }
    }

    // Render Active section
    if (activeSessions.length > 0) {
      var activeHeader = document.createElement('div');
      activeHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;';
      var activeLine1 = document.createElement('span');
      activeLine1.style.cssText = 'flex:0 0 auto;color:var(--text-dim);font-size:11px;font-weight:600;letter-spacing:0.5px;';
      activeLine1.textContent = '\u2500\u2500 Active (' + activeSessions.length + ') ';
      activeHeader.appendChild(activeLine1);
      var activeRule = document.createElement('span');
      activeRule.style.cssText = 'flex:1;height:1px;background:var(--border-color);';
      activeHeader.appendChild(activeRule);
      el.appendChild(activeHeader);

      for (var ai = 0; ai < activeSessions.length; ai++) {
        el.appendChild(self.renderSessionCard(activeSessions[ai], subagentMap));
      }
    }

    // ── Agents Catalog Section (Req 6.1) ──────────────────────────────
    if (!this._agentsCatalogCollapsedInitialized) {
      this._agentsCatalogCollapsed = activeSessions.length > 0;
      this._agentsCatalogCollapsedInitialized = true;
    }

    var agentsHeader = document.createElement('div');
    agentsHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;cursor:pointer;';

    var agentsCollapseToggle = document.createElement('span');
    agentsCollapseToggle.style.cssText = 'flex:0 0 auto;font-size:10px;color:var(--text-dim);user-select:none;';
    agentsCollapseToggle.textContent = self._agentsCatalogCollapsed ? '\u25B6' : '\u25BC';
    agentsCollapseToggle.setAttribute('aria-label', self._agentsCatalogCollapsed ? 'Expand agents catalog' : 'Collapse agents catalog');
    agentsHeader.appendChild(agentsCollapseToggle);

    var agentsLine1 = document.createElement('span');
    agentsLine1.style.cssText = 'flex:0 0 auto;color:var(--text-dim);font-size:11px;font-weight:600;letter-spacing:0.5px;';
    agentsLine1.textContent = 'Agents';
    agentsHeader.appendChild(agentsLine1);

    var agentsRule = document.createElement('span');
    agentsRule.style.cssText = 'flex:1;height:1px;background:var(--border-color);';
    agentsHeader.appendChild(agentsRule);

    agentsHeader.addEventListener('click', function () {
      self._agentsCatalogCollapsed = !self._agentsCatalogCollapsed;
      self.renderSessionList();
    });

    el.appendChild(agentsHeader);

    if (!this._agentsCatalogCollapsed) {
      this._agentsCatalogEl = document.createElement('div');
      this._agentsCatalogEl.setAttribute('data-agents-catalog', 'true');
      this._agentsCatalogEl.style.cssText = 'margin-bottom:8px;';

      if (this._departments.length === 0) {
        var noAgents = document.createElement('div');
        noAgents.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 2px;';
        noAgents.textContent = 'No agents loaded';
        this._agentsCatalogEl.appendChild(noAgents);
      } else {
        for (var di = 0; di < this._departments.length; di++) {
          var dept = this._departments[di];
          if (!dept || !dept.name) continue;

          var deptHeader = document.createElement('div');
          deptHeader.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-primary);padding:6px 2px 4px;';
          deptHeader.textContent = '\u25BC ' + dept.name;
          this._agentsCatalogEl.appendChild(deptHeader);

          var deptAgents = Array.isArray(dept.agents) ? dept.agents : [];
          for (var ai2 = 0; ai2 < deptAgents.length; ai2++) {
            var agentInfo = deptAgents[ai2];
            if (!agentInfo) continue;

            var agentRow = document.createElement('div');
            agentRow.style.cssText = 'font-size:11px;color:var(--text-secondary);padding:3px 2px 3px 14px;cursor:pointer;border-radius:var(--radius-xs);transition:background var(--motion-quick);display:flex;align-items:center;gap:6px;';
            agentRow.setAttribute('data-agent-id', agentInfo.id || '');
            agentRow.setAttribute('role', 'button');
            agentRow.setAttribute('tabindex', '0');
            agentRow.setAttribute('aria-label', 'Select agent ' + (agentInfo.name || agentInfo.id));

            agentRow.addEventListener('mouseenter', function () { this.style.background = 'var(--surface-container-high)'; });
            agentRow.addEventListener('mouseleave', function () { this.style.background = 'transparent'; });

            (function (aid) {
              agentRow.addEventListener('click', function () {
                if (self.agentSelect) self.agentSelect.value = aid;
                if (self.dispatchInput) {
                  self.dispatchInput.focus();
                  self.dispatchInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
              });
            })(agentInfo.id || '');

            var agentLabel = document.createElement('span');
            agentLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            var agentEmoji = agentInfo.emoji || '\uD83E\uDD16';
            var agentName = agentInfo.name || agentInfo.id || 'Agent';
            var specialty = agentInfo.specialty || '';
            var labelText = agentEmoji + ' ' + agentName;
            if (specialty) {
              var truncatedSpecialty = specialty.length > 30 ? specialty.slice(0, 30) + '\u2026' : specialty;
              labelText += '  \u2014 ' + truncatedSpecialty;
            }
            agentLabel.textContent = labelText;
            agentRow.appendChild(agentLabel);

            var isAgentActive = false;
            self._dashboardSessions.forEach(function (sess) {
              if (isAgentActive) return;
              var sessStatus = (sess.status || '').toLowerCase();
              if (sessStatus === 'streaming' || sessStatus === 'preparing') {
                var matchesId = agentInfo.id && sess.agentId && sess.agentId === agentInfo.id;
                var matchesName = agentName && sess.name && sess.name.toLowerCase() === agentName.toLowerCase();
                if (matchesId || matchesName) isAgentActive = true;
              }
            });

            var statusDot = document.createElement('span');
            statusDot.style.cssText = 'flex:0 0 auto;font-size:10px;white-space:nowrap;display:flex;align-items:center;gap:3px;';
            var dotChar = document.createElement('span');
            dotChar.textContent = '\u25CF';
            dotChar.style.cssText = isAgentActive ? 'color:var(--green, #4ade80);' : 'color:var(--text-dim, #5a5a5a);';
            statusDot.appendChild(dotChar);
            var statusLabel = document.createElement('span');
            statusLabel.style.cssText = 'color:var(--text-dim);';
            statusLabel.textContent = isAgentActive ? 'active' : 'idle';
            statusDot.appendChild(statusLabel);
            agentRow.appendChild(statusDot);

            this._agentsCatalogEl.appendChild(agentRow);
          }
        }
      }

      el.appendChild(this._agentsCatalogEl);
    } else {
      this._agentsCatalogEl = null;
    }

    // History section
    if (!this._historyCollapsedInitialized) {
      this._historyCollapsed = activeSessions.length > 0;
      this._historyCollapsedInitialized = true;
    }

    var historyHeader = document.createElement('div');
    historyHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;cursor:pointer;';

    var collapseToggle = document.createElement('span');
    collapseToggle.style.cssText = 'flex:0 0 auto;font-size:10px;color:var(--text-dim);user-select:none;';
    collapseToggle.textContent = self._historyCollapsed ? '\u25B6' : '\u25BC';
    collapseToggle.setAttribute('aria-label', self._historyCollapsed ? 'Expand history' : 'Collapse history');
    historyHeader.appendChild(collapseToggle);

    var historyLine1 = document.createElement('span');
    historyLine1.style.cssText = 'flex:0 0 auto;color:var(--text-dim);font-size:11px;font-weight:600;letter-spacing:0.5px;';
    historyLine1.textContent = 'History (' + historySessions.length + ') ';
    historyHeader.appendChild(historyLine1);
    var historyRule = document.createElement('span');
    historyRule.style.cssText = 'flex:1;height:1px;background:var(--border-color);';
    historyHeader.appendChild(historyRule);

    if (historySessions.length > 0) {
      var clearAllBtn = document.createElement('button');
      clearAllBtn.className = 'ad-action-btn danger';
      clearAllBtn.style.cssText = 'font-size:11px;color:var(--text-dim);border-color:transparent;padding:2px 6px;';
      clearAllBtn.textContent = 'Clear All';
      clearAllBtn.setAttribute('aria-label', 'Clear all history');
      clearAllBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self.clearAllHistory(historySessions);
      });
      historyHeader.appendChild(clearAllBtn);
    }

    historyHeader.addEventListener('click', function () {
      self._historyCollapsed = !self._historyCollapsed;
      self.renderSessionList();
    });

    el.appendChild(historyHeader);

    if (!this._historyCollapsed) {
      if (historySessions.length === 0) {
        var noHistory = document.createElement('div');
        noHistory.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 2px;';
        noHistory.textContent = 'No history yet';
        el.appendChild(noHistory);
      } else {
        var displayHistory = historySessions.slice(-20);
        for (var hi = 0; hi < displayHistory.length; hi++) {
          el.appendChild(self.renderSessionCard(displayHistory[hi], subagentMap));
        }
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
    card.setAttribute('data-session-id', session.id);

    // Top row: emoji + name | status indicator + elapsed time
    var topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    var nameEl = document.createElement('span');
    nameEl.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
    var displayEmoji = session.emoji || '\uD83E\uDD16';
    var displayName = session.name || session.task || session.id || 'Session';
    nameEl.textContent = displayEmoji + ' ' + displayName;
    topRow.appendChild(nameEl);

    var statusArea = document.createElement('span');
    statusArea.style.cssText = 'display:flex;align-items:center;gap:6px;white-space:nowrap;';

    var statusIndicator = document.createElement('span');
    statusIndicator.style.cssText = 'font-size:11px;font-weight:600;';
    var statusText = '';
    var statusColor = '';
    var sessionStatus = (session.status || state).toLowerCase();
    if (sessionStatus === 'preparing') {
      statusText = '\u23F3 Preparing\u2026';
      statusColor = 'var(--yellow, #fbbf24)';
    } else if (sessionStatus === 'streaming' || sessionStatus === 'running' || sessionStatus === 'responding' || sessionStatus === 'executing' || sessionStatus === 'active') {
      statusText = '\u25CF Running';
      statusColor = 'var(--green, #4ade80)';
    } else if (sessionStatus === 'completed' || sessionStatus === 'idle') {
      statusText = '\u2713 Completed';
      statusColor = 'var(--accent, #007AFF)';
    } else if (sessionStatus === 'failed' || sessionStatus === 'error' || sessionStatus === 'stopped') {
      statusText = '\u2717 Failed';
      statusColor = 'var(--red, #ef4444)';
    } else {
      statusText = '\u25CF ' + (sessionStatus || 'idle');
      statusColor = 'var(--text-dim, #5a5a5a)';
    }
    statusIndicator.style.color = statusColor;
    statusIndicator.textContent = statusText;
    statusArea.appendChild(statusIndicator);

    var elapsedSpan = document.createElement('span');
    elapsedSpan.style.cssText = 'font-size:10px;color:var(--text-dim);';
    elapsedSpan.setAttribute('data-elapsed-id', session.id);
    elapsedSpan.textContent = elapsedStr(session.startedAt || session.createdAt);
    statusArea.appendChild(elapsedSpan);

    topRow.appendChild(statusArea);
    card.appendChild(topRow);

    // Detail rows: task + provider/model
    var detailsContainer = document.createElement('div');
    detailsContainer.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-secondary);';

    if (session.task) {
      var taskRow = document.createElement('div');
      taskRow.style.cssText = 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      taskRow.textContent = '\u251C\u2500 Task: ' + (session.task.length > 60 ? session.task.slice(0, 60) + '\u2026' : session.task);
      detailsContainer.appendChild(taskRow);
    }

    var isFinished = sessionStatus === 'completed' || sessionStatus === 'idle' || sessionStatus === 'failed' || sessionStatus === 'error' || sessionStatus === 'stopped';

    if (session.provider || session.model) {
      var providerRow = document.createElement('div');
      providerRow.style.cssText = 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      var providerText = '';
      if (session.provider && session.model) {
        providerText = session.provider + ' / ' + session.model;
      } else {
        providerText = session.provider || session.model || '';
      }
      var providerPrefix = isFinished ? '\u251C\u2500' : '\u2514\u2500';
      providerRow.textContent = providerPrefix + ' Provider: ' + providerText;
      detailsContainer.appendChild(providerRow);
    }

    if (isFinished) {
      var resultText = session.result || session.buffer || '';
      if (resultText) {
        var resultRow = document.createElement('div');
        resultRow.style.cssText = 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        var truncatedResult = resultText.length > 100 ? resultText.slice(0, 100) + '\u2026' : resultText;
        var resultPrefix = session.completedAt ? '\u251C\u2500' : '\u2514\u2500';
        resultRow.textContent = resultPrefix + ' Result: ' + truncatedResult;
        detailsContainer.appendChild(resultRow);
      }

      if (session.completedAt) {
        var completionRow = document.createElement('div');
        completionRow.style.cssText = 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        var completionLabel = sessionStatus === 'failed' || sessionStatus === 'error' ? 'Failed' : sessionStatus === 'stopped' ? 'Stopped' : 'Completed';
        completionRow.textContent = '\u2514\u2500 ' + completionLabel + ' ' + relTime(session.completedAt);
        detailsContainer.appendChild(completionRow);
      }
    }

    card.appendChild(detailsContainer);

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

    var peekBtn = document.createElement('button');
    peekBtn.className = 'ad-action-btn';
    peekBtn.textContent = '\uD83D\uDC41 Peek';
    peekBtn.setAttribute('aria-label', 'Peek at recent messages');
    peekBtn.addEventListener('click', function (e) { e.stopPropagation(); self.peekSession(session); });
    actions.appendChild(peekBtn);

    var isActiveSession = !isFinished;
    if (isActiveSession) {
      var stopBtn = document.createElement('button');
      stopBtn.className = 'ad-action-btn danger';
      stopBtn.textContent = '\u25A0 Stop';
      stopBtn.setAttribute('aria-label', 'Stop session');
      stopBtn.addEventListener('click', function (e) { e.stopPropagation(); self.stopSession(session, card); });
      actions.appendChild(stopBtn);
    }

    if (isFinished) {
      var clearBtn = document.createElement('button');
      clearBtn.className = 'ad-action-btn danger';
      clearBtn.textContent = '\uD83D\uDDD1 Clear';
      clearBtn.setAttribute('aria-label', 'Clear session from history');
      clearBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self.clearSession(session);
      });
      actions.appendChild(clearBtn);
    }

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

        var subContent = document.createElement('div');
        subContent.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';

        var subName = document.createElement('span');
        subName.style.cssText = 'color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-weight:600;';
        subName.textContent = '\u2514 ' + (sub.name || sub.agent || sub.id);
        subContent.appendChild(subName);

        if (sub.startedAt || sub.createdAt) {
          var elapsedEl = document.createElement('span');
          elapsedEl.className = 'ad-sub-elapsed';
          elapsedEl.textContent = '\u23F1 ' + elapsedStr(sub.startedAt || sub.createdAt);
          subContent.appendChild(elapsedEl);
        }

        var subBadge = window.wk.badge(subState.replace(/-/g, ' '), AD_STATE_BADGE_VARIANT[subState] || 'info');
        subContent.appendChild(subBadge);
        subCard.appendChild(subContent);

        var detailSection = document.createElement('div');
        detailSection.className = 'ad-sub-detail';

        if (sub.task || sub.description) {
          var staskRow = document.createElement('div');
          staskRow.className = 'ad-sub-detail-row';
          staskRow.innerHTML = '<span class="ad-sub-label">Task:</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml((sub.task || sub.description || '').slice(0, 80)) + '</span>';
          detailSection.appendChild(staskRow);
        }

        if (sub.worktreePath || sub.worktree || sub.cwd) {
          var wtRow = document.createElement('div');
          wtRow.className = 'ad-sub-detail-row';
          wtRow.innerHTML = '<span class="ad-sub-label">Path:</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:\'SF Mono\',Menlo,monospace;font-size:9px;">' + escHtml(sub.worktreePath || sub.worktree || sub.cwd) + '</span>';
          detailSection.appendChild(wtRow);
        }

        subCard.appendChild(detailSection);

        if (sub.progress != null || sub.progressValue != null) {
          var progressContainer = document.createElement('div');
          progressContainer.className = 'ad-sub-progress';
          var progVal = sub.progress || sub.progressValue || 0;
          var progMax = sub.progressMax || 100;
          progressContainer.appendChild(window.wk.progress(progVal, progMax));
          subCard.appendChild(progressContainer);
        }

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
    var a = adApi();
    if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

    var projectId = self.projectSelect ? self.projectSelect.value : (window._neuronestActiveProject || 'default');
    var selectedAgentId = self.agentSelect ? self.agentSelect.value : '';

    var payload = {
      projectId: projectId,
      message: task,
      source: 'dashboard'
    };

    if (selectedAgentId) {
      payload.agent = selectedAgentId;
    }

    a.send('chat-message', payload);

    self.dispatchBtn.disabled = true;

    var preparingId = 'preparing-' + Date.now();
    var agentName = 'Agent';
    if (selectedAgentId && self.agentSelect) {
      var selectedOption = self.agentSelect.options[self.agentSelect.selectedIndex];
      if (selectedOption && selectedOption.textContent) {
        agentName = selectedOption.textContent.trim();
      }
    }

    var preparingSession = {
      id: preparingId,
      name: agentName,
      agentId: selectedAgentId || '',
      emoji: '\uD83E\uDD16',
      provider: '',
      model: '',
      status: 'preparing',
      task: task,
      startedAt: Date.now(),
      buffer: '',
      projectId: projectId
    };

    self._dashboardSessions.set(preparingId, preparingSession);
    self._mergeDashboardSessions();
    self.renderSessionList();

    var preparingTimeout = setTimeout(function () {
      self.dispatchBtn.disabled = false;
      var session = self._dashboardSessions.get(preparingId);
      if (session && session.status === 'preparing') {
        self._dashboardSessions.delete(preparingId);
        for (var i = self.sessions.length - 1; i >= 0; i--) {
          if (self.sessions[i].id === preparingId) {
            self.sessions.splice(i, 1);
            break;
          }
        }
        self.renderSessionList();
      }
    }, 3000);

    preparingSession._timeout = preparingTimeout;
    self.dispatchInput.value = '';
    window.wk.toast('Task dispatched', 'success');
  };

  // ─── Rename (Inline editable field) ──────────────────────────────

  AgentDashboardV2Panel.prototype.startRename = function (session, card, nameEl) {
    var self = this;
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
      if (input.parentNode) input.parentNode.removeChild(input);
      nameEl.style.display = '';

      if (!newName || newName === currentName) return;

      var a = adApi();
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

    input.addEventListener('blur', function () { finishRename(); });
  };

  // ─── Stop (with confirm dialog) ─────────────────────────────────

  AgentDashboardV2Panel.prototype.stopSession = function (session, card) {
    var self = this;
    var sessionName = session.name || session.task || session.id || 'Session';

    var existingConfirm = card.querySelector('.wk-confirm');
    if (existingConfirm) { existingConfirm.remove(); return; }

    var isLive = session.status === 'streaming' || session.status === 'preparing';

    var confirmMessage = isLive
      ? 'Stop agent "' + sessionName + '"? This will abort the running pipeline.'
      : 'Stop session "' + sessionName + '"? This will release all resources.';

    var confirmEl = window.wk.confirm(
      confirmMessage,
      function () {
        var a = adApi();
        if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

        var btns = card.querySelectorAll('.ad-action-btn');
        for (var i = 0; i < btns.length; i++) disableBtn(btns[i]);

        if (isLive) {
          var msgId = session.id.replace('stream-', '');
          a.send('abort-pipeline', { msgId: msgId });

          var dashSession = self._dashboardSessions.get(session.id);
          if (dashSession) {
            dashSession.status = 'stopped';
            dashSession.completedAt = Date.now();
            self._dashboardSessions.set(session.id, dashSession);
          }

          session.status = 'stopped';
          session.completedAt = Date.now();

          self._mergeDashboardSessions();
          self.renderSessionList();
          self.lastRefresh = Date.now();
          self.updateRefreshBadge();

          window.wk.toast('Agent stopped', 'success');
        } else {
          a.invoke('parallel:delete', { sessionId: session.id }).then(function () {
            window.wk.toast('Session stopped', 'success');
            self.loadSessions();
          }).catch(function (err) {
            window.wk.toast('Stop failed: ' + (err && err.message || err), 'error');
            for (var i = 0; i < btns.length; i++) enableBtn(btns[i]);
          });
        }
      }
    );

    card.appendChild(confirmEl);
  };

  // ─── Clear Session (Remove from history) ──────────────────────────

  AgentDashboardV2Panel.prototype.clearSession = function (session) {
    var self = this;
    var a = adApi();
    if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

    a.invoke('parallel:delete', { sessionId: session.id }).then(function () {
      self._dashboardSessions.delete(session.id);

      for (var i = self.sessions.length - 1; i >= 0; i--) {
        if (self.sessions[i].id === session.id) {
          self.sessions.splice(i, 1);
          break;
        }
      }

      self.renderSessionList();
      self.lastRefresh = Date.now();
      self.updateRefreshBadge();
      window.wk.toast('Session cleared', 'success');
    }).catch(function (err) {
      window.wk.toast('Clear failed: ' + (err && err.message || err), 'error');
    });
  };

  // ─── Clear All History ────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.clearAllHistory = function (historySessions) {
    var self = this;

    var existingConfirm = self.listEl.querySelector('.wk-confirm');
    if (existingConfirm) { existingConfirm.remove(); return; }

    var confirmEl = window.wk.confirm(
      'Clear all history? This will permanently delete ' + historySessions.length + ' session(s).',
      function () {
        var a = adApi();
        if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

        for (var i = 0; i < historySessions.length; i++) {
          (function (sessionId) {
            a.invoke('parallel:delete', { sessionId: sessionId }).catch(function (err) {
              console.warn('[AgentDashboard] Failed to delete session ' + sessionId + ':', err);
            });
          })(historySessions[i].id);
        }

        for (var j = 0; j < historySessions.length; j++) {
          self._dashboardSessions.delete(historySessions[j].id);
        }

        var historyIds = {};
        for (var k = 0; k < historySessions.length; k++) {
          historyIds[historySessions[k].id] = true;
        }
        for (var m = self.sessions.length - 1; m >= 0; m--) {
          if (historyIds[self.sessions[m].id]) {
            self.sessions.splice(m, 1);
          }
        }

        self.renderSessionList();
        self.lastRefresh = Date.now();
        self.updateRefreshBadge();
        window.wk.toast('History cleared', 'success');
      }
    );

    self.listEl.appendChild(confirmEl);
  };

  // ─── Cancel Subagent ─────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.cancelSubagent = function (subagent, cardEl) {
    var self = this;
    var subName = subagent.name || subagent.agent || subagent.id || 'Subagent';

    var existingConfirm = cardEl.querySelector('.wk-confirm');
    if (existingConfirm) { existingConfirm.remove(); return; }

    var confirmEl = window.wk.confirm(
      'Cancel subagent "' + subName + '"? Parent and sibling agents will continue.',
      function () {
        var a = adApi();
        if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

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

  // ─── Workspace Pill Unread Badge (Requirement 7.4) ──────────────────

  AgentDashboardV2Panel.prototype._isPanelVisible = function () {
    if (!this.container) return false;
    if (this.container.offsetParent === null) return false;
    return true;
  };

  AgentDashboardV2Panel.prototype._updateWorkspacePillBadge = function () {
    var count = this._unreadCount;

    var pill = document.querySelector('[data-workspace="agent-dashboard"]') ||
               document.querySelector('[data-panel-id="agent-dashboard-v2"]') ||
               document.querySelector('.nn-sidebar-nav-item[data-panel-id="agent-dashboard-v2"]') ||
               document.querySelector('button[title="Agent Dashboard"]') ||
               document.querySelector('[aria-label="Open Agent Dashboard"]');

    if (!pill) {
      var buttons = document.querySelectorAll('button[aria-label*="Agent Dashboard"]');
      if (buttons.length > 0) pill = buttons[0];
    }

    if (!pill) return;

    var badgeId = 'ad-unread-badge';
    var badge = pill.querySelector('#' + badgeId) || pill.querySelector('[data-ad-badge]');

    if (count <= 0) {
      if (badge) badge.parentNode.removeChild(badge);
      return;
    }

    if (!badge) {
      badge = document.createElement('span');
      badge.id = badgeId;
      badge.setAttribute('data-ad-badge', 'true');
      badge.style.cssText =
        'position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;' +
        'background:var(--red, #ef4444);color:#fff;font-size:9px;font-weight:700;' +
        'border-radius:8px;display:flex;align-items:center;justify-content:center;' +
        'padding:0 4px;pointer-events:none;line-height:1;z-index:10;';

      var pillStyle = window.getComputedStyle(pill);
      if (pillStyle.position === 'static' || pillStyle.position === '') {
        pill.style.position = 'relative';
      }
      pill.appendChild(badge);
    }

    badge.textContent = count > 99 ? '99+' : String(count);
  };

  // ─── Cleanup ─────────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.destroy = function () {
    if (this.container) {
      this._savedScrollPosition = this.container.scrollTop || 0;
    }

    this._panelVisible = false;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this._refreshBadgeTimer) {
      clearInterval(this._refreshBadgeTimer);
      this._refreshBadgeTimer = null;
    }
    this._clearPeekRefreshTimer();
    this._peekSessionId = null;
    this.unsubscribeSubagentEvents();
    this.unsubscribeChatStream();
    this.unsubscribeChatDone();
    this.unsubscribeChatError();
    this.unsubscribeActiveProjectChange();
    this.unsubscribeCatalogUpdated();
    if (this._livePulseTimer) {
      clearTimeout(this._livePulseTimer);
      this._livePulseTimer = null;
    }
    if (this.container) this.container.innerHTML = '';
  };

  // ─── Exports ─────────────────────────────────────────────────────

  if (typeof window !== 'undefined') { window.AgentDashboardV2Panel = AgentDashboardV2Panel; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { AgentDashboardV2Panel: AgentDashboardV2Panel }; }

})();
