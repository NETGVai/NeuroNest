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
    '@keyframes adLivePulse{0%,100%{opacity:1;}50%{opacity:0.5;}}',
    '.ad-live-pulsing{animation:adLivePulse 0.6s ease-in-out infinite;}',
    '#ad-unread-badge{animation:adBadgePop 0.2s ease;}',
    '@keyframes adBadgePop{from{transform:scale(0);}to{transform:scale(1);}}',
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
    // async options are loaded. This ensures dispatchSession() always reads the
    // most recently assigned projectId regardless of option population timing.
    (function (selectEl) {
      var _storedValue = 'default';
      var proto = Object.getPrototypeOf(selectEl);
      var _nativeDescriptor = null;
      // Walk prototype chain to find native value descriptor
      while (proto && !_nativeDescriptor) {
        _nativeDescriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        proto = Object.getPrototypeOf(proto);
      }
      Object.defineProperty(selectEl, 'value', {
        get: function () {
          var nativeVal = _nativeDescriptor && _nativeDescriptor.get
            ? _nativeDescriptor.get.call(selectEl)
            : '';
          // If native value matches a valid option, use it; otherwise use stored value
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

  /**
   * Populate the agent selector dropdown by calling `get-agents` on panel mount.
   * Preserves the existing default "Auto (Orchestrator)" option at the top (outside any optgroup).
   * On success, groups agents by their `department` field using <optgroup> elements
   * as separator labels. Each agent is rendered as an <option> with value = agent.id
   * and display text = agent.emoji + ' ' + agent.name.
   * Agents without a department are placed in an "Other" group.
   * On failure, gracefully keeps just the default option.
   *
   * Requirement 2.1: Dispatch input allows users to select which agent should handle
   * the task, with a dropdown populated from the Agent Registry.
   */
  AgentDashboardV2Panel.prototype._loadAgentDropdown = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.invoke !== 'function') return;

    a.invoke('get-agents').then(function (agents) {
      if (!Array.isArray(agents) || agents.length === 0) return;

      // Remove all options and optgroups except the first default "Auto (Orchestrator)"
      while (self.agentSelect.children.length > 1) {
        self.agentSelect.removeChild(self.agentSelect.children[1]);
      }

      // Group agents by department
      var departments = {};
      for (var i = 0; i < agents.length; i++) {
        var agent = agents[i];
        if (!agent || !agent.id) continue;
        var dept = agent.department || 'Other';
        if (!departments[dept]) {
          departments[dept] = [];
        }
        departments[dept].push(agent);
      }

      // Create an <optgroup> for each department with agent <option> elements inside
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
    }).catch(function () {
      // On failure, keep the default option — no user-facing error needed
    });
  };

  // ─── Load Project Dropdown (Req 2.1, 2.3, 2.5) ─────────────────────

  /**
   * Populate the project selector dropdown by calling `get-projects` on panel mount.
   * Preserves the existing default "Default Project" option at the top.
   * On success, clears all options except the first default, iterates returned projects
   * and creates an <option> for each with value = project.id and text = project.name.
   * Pre-selects the option matching `window._neuronestActiveProject` if set.
   * On failure or empty list, keeps just the "Default Project" fallback so dispatch
   * can still proceed.
   *
   * Requirement 2.1: Project selector dropdown populated from get-projects IPC.
   * Requirement 2.3: Pre-select active project.
   * Requirement 2.5: Graceful fallback when project list is empty or IPC fails.
   */
  AgentDashboardV2Panel.prototype._loadProjectDropdown = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.invoke !== 'function') return;

    a.invoke('get-projects').then(function (projects) {
      if (!Array.isArray(projects) || projects.length === 0) return;

      // Remove all options except the first default "Default Project"
      while (self.projectSelect.children.length > 1) {
        self.projectSelect.removeChild(self.projectSelect.children[1]);
      }

      // Add an option for each project
      for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        if (!project || !project.id) continue;
        var opt = document.createElement('option');
        opt.value = project.id;
        opt.textContent = project.name || project.id;
        self.projectSelect.appendChild(opt);
      }

      // Pre-select the option matching window._neuronestActiveProject if set
      var activeProject = window._neuronestActiveProject;
      if (activeProject) {
        // Check if the active project matches one of the available options
        for (var j = 0; j < self.projectSelect.options.length; j++) {
          if (self.projectSelect.options[j].value === activeProject) {
            self.projectSelect.value = activeProject;
            break;
          }
        }
      }
    }).catch(function () {
      // On failure, keep the default option — no user-facing error needed
    });
  };

  // ─── Load Agent Catalog (Req 6.1, 6.4) ────────────────────────────

  /**
   * Load the agent catalog by calling `get-departments` to retrieve departments
   * and their agents. On success, stores the response in `this._departments`
   * and flattens all agents into `this._agents`. Triggers a re-render of the
   * session list to update the agents catalog section.
   *
   * Requirement 6.1: The dashboard SHALL show a quick-access list of available agents grouped by department.
   * Requirement 6.4: The agent list SHALL update when agents are added or removed from the registry.
   */
  AgentDashboardV2Panel.prototype._loadAgentCatalog = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.invoke !== 'function') return;

    a.invoke('get-departments').then(function (departments) {
      if (!Array.isArray(departments)) {
        self._departments = [];
        self._agents = [];
        return;
      }

      self._departments = departments;

      // Flatten all agents from all departments into a single array
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

      // Re-render the session list to update the agents catalog section
      self.renderSessionList();
    }).catch(function () {
      // On failure, _agents remains empty — no user-facing error needed
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

    // Start a 1-second interval to keep the "Updated Xs ago" badge text current (Req 1.5)
    if (this._refreshBadgeTimer) clearInterval(this._refreshBadgeTimer);
    this._refreshBadgeTimer = setInterval(function () {
      self.updateRefreshBadge();
    }, 1000);
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

  // ─── Chat Stream Subscription (Live Agent Tracking) ──────────────

  /**
   * Subscribe to `chat:stream` start events to detect when new agents begin execution.
   * When a start event is received (data.start === true), creates a new session entry
   * in the _dashboardSessions map and re-renders the session list.
   *
   * Requirement 7.1: Subscribe to chat:stream IPC events to track agent lifecycle.
   * Requirement 1.1: Display all currently active agents from the runtime pipeline.
   * Requirement 1.2: Each active agent card shows agent name, emoji, provider/model, status, elapsed time.
   * Requirement 1.3: Agent status updates in real-time (within 1 second).
   */
  AgentDashboardV2Panel.prototype.subscribeChatStream = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.on !== 'function') return;

    // Remove previous handler if any
    this.unsubscribeChatStream();

    this._chatStreamHandler = function (data) {
      if (!data || !data.msgId) return;

      // Start event: data.start === true indicates a new agent began execution
      if (data.start) {
        var sessionId = 'stream-' + data.msgId;
        var projectId = window._neuronestActiveProject || 'default';

        // Check if there's a 'preparing' session that matches (by task text or timing)
        var matchedPreparingId = null;
        self._dashboardSessions.forEach(function (sess, id) {
          if (sess.status === 'preparing' && !matchedPreparingId) {
            // Match by task text if available, or by timing (within 5 seconds)
            var taskMatch = data.task && sess.task && data.task === sess.task;
            var timingMatch = (Date.now() - sess.startedAt) < 5000;
            if (taskMatch || timingMatch) {
              matchedPreparingId = id;
            }
          }
        });

        // Build the new streaming session
        var session = {
          id: sessionId,
          name: data.agent || 'Agent',
          agentId: data.agentId || '',
          emoji: '\uD83E\uDD16',
          provider: data.provider || '',
          model: data.model || '',
          status: 'streaming',
          task: data.task || '',
          startedAt: Date.now(),
          buffer: '',
          projectId: projectId
        };

        // If a preparing session was found, remove it and replace with the streaming session
        if (matchedPreparingId) {
          var preparingSession = self._dashboardSessions.get(matchedPreparingId);
          // Clear the timeout so it doesn't fire
          if (preparingSession && preparingSession._timeout) {
            clearTimeout(preparingSession._timeout);
          }
          // Re-enable the dispatch button now that the stream has started (Req 2.4 UX polish)
          self.dispatchBtn.disabled = false;
          // Carry over the task text from the preparing session if the stream didn't provide one
          if (!session.task && preparingSession) {
            session.task = preparingSession.task;
          }
          // Carry over the agent name if preparing had a more specific one
          if (preparingSession && preparingSession.name && preparingSession.name !== 'Agent' && session.name === 'Agent') {
            session.name = preparingSession.name;
          }
          // Use the original startedAt from when the user dispatched
          if (preparingSession) {
            session.startedAt = preparingSession.startedAt;
          }
          // Remove the preparing session from the map and sessions array
          self._dashboardSessions.delete(matchedPreparingId);
          for (var i = self.sessions.length - 1; i >= 0; i--) {
            if (self.sessions[i].id === matchedPreparingId) {
              self.sessions.splice(i, 1);
              break;
            }
          }
        }

        self._dashboardSessions.set(sessionId, session);

        // Merge into sessions array for rendering and re-render
        self._mergeDashboardSessions();
        self.renderSessionList();
        self.lastRefresh = Date.now();
        self.updateRefreshBadge();
        return;
      }

      // Token event: data.token is present (and data.start is NOT true)
      // Requirement 1.2: Update streaming buffer
      // Requirement 1.3: Real-time status update (elapsed time)
      if (data.token != null) {
        var tokenSessionId = 'stream-' + data.msgId;
        var existingSession = self._dashboardSessions.get(tokenSessionId);
        if (!existingSession) return;

        // Append token to buffer
        existingSession.buffer += data.token;

        // Pulse the live dot to indicate active data flow (Req 1.5 UX polish)
        if (self._liveIndicator) {
          var liveDotEl = self._liveIndicator.querySelector('span:first-child');
          if (liveDotEl) {
            liveDotEl.classList.add('ad-live-pulsing');
            // Debounce: clear previous timer and set a new one to remove the pulse after 200ms of inactivity
            if (self._livePulseTimer) {
              clearTimeout(self._livePulseTimer);
            }
            self._livePulseTimer = setTimeout(function () {
              liveDotEl.classList.remove('ad-live-pulsing');
              self._livePulseTimer = null;
            }, 200);
          }
        }

        // Targeted DOM update for elapsed time — avoid full re-render on every token
        var cardEl = self.listEl.querySelector('.ad-session-card[data-session-id="' + tokenSessionId + '"]');
        if (cardEl) {
          var elapsedDisplay = cardEl.querySelector('[data-elapsed-id="' + tokenSessionId + '"]');
          if (elapsedDisplay) {
            elapsedDisplay.textContent = elapsedStr(existingSession.startedAt);
          }
        }
      }
    };

    a.on('chat:stream', this._chatStreamHandler);
  };

  AgentDashboardV2Panel.prototype.unsubscribeChatStream = function () {
    if (this._chatStreamHandler) {
      var a = api();
      if (a && typeof a.removeListener === 'function') {
        a.removeListener('chat:stream', this._chatStreamHandler);
      }
      this._chatStreamHandler = null;
    }
  };

  // ─── Hydrate Already-Running Agents on Mount ─────────────────────

  /**
   * On panel mount, reads `window.activeAgents` array to pick up any agents
   * that are already streaming when the dashboard panel opens. For each active
   * agent not already in _dashboardSessions, creates a session entry with
   * status 'streaming' and the proper schema.
   *
   * Requirement 7.1: Subscribe to chat:stream, chat:done, chat:error IPC events to track agent lifecycle.
   * Requirement 7.2: When the main chat sends a message and an agent starts responding, a corresponding session card appears.
   * Requirement 1.1: Display all currently active agents from the runtime pipeline.
   */
  AgentDashboardV2Panel.prototype._hydrateActiveAgents = function () {
    var activeAgents = window.activeAgents;
    if (!activeAgents || !Array.isArray(activeAgents) || activeAgents.length === 0) return;

    var projectId = window._neuronestActiveProject || 'default';

    for (var i = 0; i < activeAgents.length; i++) {
      var agent = activeAgents[i];
      if (!agent) continue;

      // Determine the msgId — skip if we can't key the session
      var msgId = agent.msgId || agent.id;
      if (!msgId) continue;

      var sessionId = 'stream-' + msgId;

      // Skip if already tracked in _dashboardSessions
      if (this._dashboardSessions.has(sessionId)) continue;

      var session = {
        id: sessionId,
        name: agent.agent || agent.name || 'Agent',
        agentId: agent.agentId || '',
        emoji: agent.emoji || '\uD83E\uDD16',
        provider: agent.provider || '',
        model: agent.model || '',
        status: 'streaming',
        task: agent.task || '',
        startedAt: agent.startedAt || Date.now(),
        buffer: '',
        projectId: projectId
      };

      this._dashboardSessions.set(sessionId, session);
    }

    // Merge into sessions array and re-render
    if (this._dashboardSessions.size > 0) {
      this._mergeDashboardSessions();
      this.renderSessionList();
    }
  };

  // ─── Chat Done Subscription (Session Completion) ─────────────────

  /**
   * Subscribe to `chat:done` events to transition streaming sessions to completed state.
   * When `chat:done` fires with a msgId, finds the corresponding session via 'stream-' + msgId,
   * transitions it to 'completed', records the completion time, and re-renders.
   *
   * Requirement 1.4: When an agent completes, its card transitions to completed with a brief summary.
   * Requirement 7.1: Subscribe to chat:done IPC events to track agent lifecycle.
   */
  AgentDashboardV2Panel.prototype.subscribeChatDone = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.on !== 'function') return;

    // Remove previous handler if any
    this.unsubscribeChatDone();

    this._chatDoneHandler = function (data) {
      if (!data || !data.msgId) return;

      var sessionId = 'stream-' + data.msgId;
      var session = self._dashboardSessions.get(sessionId);
      if (!session) return;

      // If the session was already stopped by the user (via Stop button / abort-pipeline),
      // don't overwrite the 'stopped' status with 'completed'. The user already saw the
      // "Agent stopped" toast and the stopped state — flashing to 'completed' would be confusing.
      if (session.status === 'stopped') return;

      // Transition to completed state
      session.status = 'completed';
      session.completedAt = Date.now();

      // Update the session in the dashboard sessions map
      self._dashboardSessions.set(sessionId, session);

      // If panel is hidden, increment unread badge count (Req 7.4)
      if (!self._panelVisible || !self._isPanelVisible()) {
        self._unreadCount++;
        self._updateWorkspacePillBadge();
      }

      // Persist session to SQLite via parallel:create, then attach messages (Req 5.1, 5.3)
      // Only persist if session has meaningful content (task and buffer are non-empty)
      if (session.task && session.buffer) {
        var a2 = api();
        if (a2 && typeof a2.invoke === 'function') {
          // Fire-and-forget: create the session record in DB first so add-message can reference it
          a2.invoke('parallel:create', {
            id: session.id,
            projectId: session.projectId,
            name: session.name,
            task: session.task,
            status: 'completed',
            agent: session.name,
            agentId: session.agentId,
            emoji: session.emoji
          }).catch(function (err) {
            console.warn('[AgentDashboard] Failed to persist session record:', err);
          });

          // Fire-and-forget: persist user prompt
          a2.invoke('parallel:add-message', { sessionId: session.id, role: 'user', content: session.task }).catch(function (err) {
            console.warn('[AgentDashboard] Failed to persist user message:', err);
          });
          // Fire-and-forget: persist assistant response
          a2.invoke('parallel:add-message', { sessionId: session.id, role: 'assistant', content: session.buffer }).catch(function (err) {
            console.warn('[AgentDashboard] Failed to persist assistant message:', err);
          });
        }
      }

      // Merge and re-render to reflect the completed status
      self._mergeDashboardSessions();
      self.renderSessionList();
      self.lastRefresh = Date.now();
      self.updateRefreshBadge();
    };

    a.on('chat:done', this._chatDoneHandler);
  };

  AgentDashboardV2Panel.prototype.unsubscribeChatDone = function () {
    if (this._chatDoneHandler) {
      var a = api();
      if (a && typeof a.removeListener === 'function') {
        a.removeListener('chat:done', this._chatDoneHandler);
      }
      this._chatDoneHandler = null;
    }
  };

  // ─── Chat Error Subscription (Session Failure) ───────────────────

  /**
   * Subscribe to `chat:error` events to transition streaming sessions to failed state.
   * When `chat:error` fires with a msgId, finds the corresponding session via 'stream-' + msgId,
   * transitions it to 'failed', stores error info and completion time, and re-renders.
   *
   * Requirement 1.4: When an agent fails, its card transitions to failed state.
   * Requirement 7.1: Subscribe to chat:error IPC events to track agent lifecycle.
   */
  AgentDashboardV2Panel.prototype.subscribeChatError = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.on !== 'function') return;

    // Remove previous handler if any
    this.unsubscribeChatError();

    this._chatErrorHandler = function (data) {
      if (!data || !data.msgId) return;

      var sessionId = 'stream-' + data.msgId;
      var session = self._dashboardSessions.get(sessionId);
      if (!session) return;

      // If the session was already stopped by the user (via Stop button / abort-pipeline),
      // don't overwrite the 'stopped' status with 'failed'. The abort itself causes an error
      // event, but the user already acknowledged the stop action.
      if (session.status === 'stopped') return;

      // Transition to failed state
      session.status = 'failed';
      session.completedAt = Date.now();
      session.error = data.error || data.message || 'Unknown error';

      // Update the session in the dashboard sessions map
      self._dashboardSessions.set(sessionId, session);

      // Merge and re-render to reflect the failed status
      self._mergeDashboardSessions();
      self.renderSessionList();
      self.lastRefresh = Date.now();
      self.updateRefreshBadge();
    };

    a.on('chat:error', this._chatErrorHandler);
  };

  AgentDashboardV2Panel.prototype.unsubscribeChatError = function () {
    if (this._chatErrorHandler) {
      var a = api();
      if (a && typeof a.removeListener === 'function') {
        a.removeListener('chat:error', this._chatErrorHandler);
      }
      this._chatErrorHandler = null;
    }
  };

  // ─── Active Project Change Subscription (Project-Scoped View) ────

  /**
   * Subscribe to `active-project` events to reload the dashboard when the user
   * switches projects. When fired, reloads sessions so the dashboard displays
   * only sessions for the new project.
   *
   * Requirement 7.3: If the user switches between projects, the dashboard SHALL show
   * only agents relevant to the current project.
   */
  AgentDashboardV2Panel.prototype.subscribeActiveProjectChange = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.on !== 'function') return;

    // Remove previous handler if any
    this.unsubscribeActiveProjectChange();

    this._activeProjectHandler = function (data) {
      // Update the global active project reference if the event provides an id
      if (data && data.id) {
        window._neuronestActiveProject = data.id;
      }

      // Reload sessions to show only sessions for the new project
      self.loadSessions();
    };

    a.on('active-project', this._activeProjectHandler);
  };

  AgentDashboardV2Panel.prototype.unsubscribeActiveProjectChange = function () {
    if (this._activeProjectHandler) {
      var a = api();
      if (a && typeof a.removeListener === 'function') {
        a.removeListener('active-project', this._activeProjectHandler);
      }
      this._activeProjectHandler = null;
    }
  };

  /**
   * Listen for 'agents:catalog-updated' event from the main process.
   * This fires after the deferred async agent catalog import completes,
   * ensuring the dashboard refreshes its department counts with the full
   * agent registry (e.g. 305+ instead of the initial 118).
   */
  AgentDashboardV2Panel.prototype.subscribeCatalogUpdated = function () {
    var self = this;
    var a = api();
    if (!a || typeof a.on !== 'function') return;

    // Remove previous handler if any
    this.unsubscribeCatalogUpdated();

    this._catalogUpdatedHandler = function () {
      self._loadAgentDropdown();
      self._loadAgentCatalog();
    };

    a.on('agents:catalog-updated', this._catalogUpdatedHandler);
  };

  AgentDashboardV2Panel.prototype.unsubscribeCatalogUpdated = function () {
    if (this._catalogUpdatedHandler) {
      var a = api();
      if (a && typeof a.removeListener === 'function') {
        a.removeListener('agents:catalog-updated', this._catalogUpdatedHandler);
      }
      this._catalogUpdatedHandler = null;
    }
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
        // Update existing session in the array with latest dashboard state
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

    // Requirement 1.5: If no events received for 30s and there are active sessions,
    // show "Reconnecting..." state on the live indicator with yellow/orange color.
    // When a new event arrives (lastRefresh updates), the indicator returns to "Live" (green).
    if (this._liveIndicator) {
      var timeSinceLastEvent = Date.now() - this.lastRefresh;
      var hasActiveSessions = false;

      // Check if there are any active streaming/preparing sessions
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
          // Stale connection: show "Reconnecting..." with yellow/orange color
          dotEl.style.color = 'var(--yellow, #fbbf24)';
          labelEl.textContent = 'Reconnecting\u2026';
          labelEl.style.color = 'var(--yellow, #fbbf24)';
          this._liveIndicator.setAttribute('aria-label', 'Event stream status: reconnecting');
        } else {
          // Healthy connection: show "Live" with green color
          dotEl.style.color = 'var(--green, #4ade80)';
          labelEl.textContent = 'Live';
          labelEl.style.color = 'var(--text-dim, #5a5a5a)';
          this._liveIndicator.setAttribute('aria-label', 'Event stream status: connected');
        }
      }
    }
  };

  // ─── Runtime Agent Helper ──────────────────────────────────────

  /**
   * Get active agents from the runtime pipeline state (global vars from index.ts).
   * Converts them into a session-like format for the dashboard to display.
   */
  function _adGetRuntimeAgents() {
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

  // ─── Data Loading ────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.loadSessions = function () {
    var self = this;
    var a = api();
    if (!a) {
      this.listEl.innerHTML = '';
      this.listEl.appendChild(window.wk.emptyState('\u26A0\uFE0F', 'IPC Unavailable', 'Cannot connect to the main process.'));
      return;
    }

    var projectId = window._neuronestActiveProject || 'default';

    a.invoke('parallel:list', projectId).then(function (result) {
      var sessions = Array.isArray(result) ? result : (result && result.sessions) || [];

      // Merge in active pipeline agents from the runtime state
      // These are agents currently streaming responses (shown in right sidebar)
      var runtimeAgents = _adGetRuntimeAgents();

      // Avoid duplicates: only add runtime agents that aren't already in the DB sessions
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
      // Even if parallel:list fails, still show runtime agents
      var runtimeAgents = _adGetRuntimeAgents();
      if (runtimeAgents.length > 0) {
        self.sessions = runtimeAgents;
        self._mergeDashboardSessions();
        self.lastRefresh = Date.now();
        self.renderSessionList();
        self.updateRefreshBadge();
      } else if (self._dashboardSessions.size > 0) {
        // Show live streaming sessions even if DB and runtime agents are empty
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

    // Filter by current project (Req 7.3) — only show sessions for the active project.
    // Sessions without a projectId are shown regardless (pre-project-scoping legacy sessions).
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

    // Render Active section (skip if no active sessions)
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
    // Sits between Active and History sections. Collapsible: default collapsed
    // if there are active sessions, expanded if no active sessions.

    // Determine default collapsed state on first render for Agents section
    if (!this._agentsCatalogCollapsedInitialized) {
      this._agentsCatalogCollapsed = activeSessions.length > 0;
      this._agentsCatalogCollapsedInitialized = true;
    }

    var agentsHeader = document.createElement('div');
    agentsHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;cursor:pointer;';

    // Collapse/expand toggle for Agents section
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

    // Toggle collapse/expand on header click
    agentsHeader.addEventListener('click', function () {
      self._agentsCatalogCollapsed = !self._agentsCatalogCollapsed;
      self.renderSessionList();
    });

    el.appendChild(agentsHeader);

    // Agent catalog container — renders agents grouped by department (Req 6.1)
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
        // Render agents grouped by department with department name as section header
        for (var di = 0; di < this._departments.length; di++) {
          var dept = this._departments[di];
          if (!dept || !dept.name) continue;

          // Department header
          var deptHeader = document.createElement('div');
          deptHeader.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-primary);padding:6px 2px 4px;';
          deptHeader.textContent = '\u25BC ' + dept.name;
          this._agentsCatalogEl.appendChild(deptHeader);

          // Agent rows within this department
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

            // Hover effect
            agentRow.addEventListener('mouseenter', function () {
              this.style.background = 'var(--surface-container-high)';
            });
            agentRow.addEventListener('mouseleave', function () {
              this.style.background = 'transparent';
            });

            // Click handler: pre-fill dispatch input with this agent selected (Req 6.3)
            (function (aid) {
              agentRow.addEventListener('click', function () {
                if (self.agentSelect) {
                  self.agentSelect.value = aid;
                }
                if (self.dispatchInput) {
                  self.dispatchInput.focus();
                  self.dispatchInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
              });
            })(agentInfo.id || '');

            // Agent emoji + name + specialty (truncated)
            var agentLabel = document.createElement('span');
            agentLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            var agentEmoji = agentInfo.emoji || '\uD83E\uDD16';
            var agentName = agentInfo.name || agentInfo.id || 'Agent';
            var specialty = agentInfo.specialty || '';
            var labelText = agentEmoji + ' ' + agentName;
            if (specialty) {
              // Truncate specialty to 30 chars
              var truncatedSpecialty = specialty.length > 30 ? specialty.slice(0, 30) + '\u2026' : specialty;
              labelText += '  \u2014 ' + truncatedSpecialty;
            }
            agentLabel.textContent = labelText;
            agentRow.appendChild(agentLabel);

            // Status dot: green if active, gray if idle (Req 6.2)
            // Cross-reference with _dashboardSessions to determine if this agent is currently executing
            var isAgentActive = false;
            self._dashboardSessions.forEach(function (sess) {
              if (isAgentActive) return;
              var sessStatus = (sess.status || '').toLowerCase();
              if (sessStatus === 'streaming' || sessStatus === 'preparing') {
                // Match by agentId or by name (case-insensitive)
                var matchesId = agentInfo.id && sess.agentId && sess.agentId === agentInfo.id;
                var matchesName = agentName && sess.name && sess.name.toLowerCase() === agentName.toLowerCase();
                if (matchesId || matchesName) {
                  isAgentActive = true;
                }
              }
            });

            var statusDot = document.createElement('span');
            statusDot.style.cssText = 'flex:0 0 auto;font-size:10px;white-space:nowrap;display:flex;align-items:center;gap:3px;';
            var dotChar = document.createElement('span');
            dotChar.textContent = '\u25CF';
            dotChar.style.cssText = isAgentActive
              ? 'color:var(--green, #4ade80);'
              : 'color:var(--text-dim, #5a5a5a);';
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

    // Determine default collapsed state on first render:
    // expanded if no active sessions, collapsed if there are active sessions (Req 5.2)
    if (!this._historyCollapsedInitialized) {
      this._historyCollapsed = activeSessions.length > 0;
      this._historyCollapsedInitialized = true;
    }

    // Render History section
    var historyHeader = document.createElement('div');
    historyHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;cursor:pointer;';

    // Collapse/expand toggle button
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

    // "Clear All" button — only shown if there are history sessions to clear (Req 5.4)
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

    // Toggle collapse/expand on header click
    historyHeader.addEventListener('click', function () {
      self._historyCollapsed = !self._historyCollapsed;
      self.renderSessionList();
    });

    el.appendChild(historyHeader);

    // Only render history cards when not collapsed
    if (!this._historyCollapsed) {
      if (historySessions.length === 0) {
        var noHistory = document.createElement('div');
        noHistory.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 2px;';
        noHistory.textContent = 'No history yet';
        el.appendChild(noHistory);
      } else {
        // Limit to the last 20 history entries
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

    // ─ Top row: emoji + name | status indicator + elapsed time ─
    var topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    // Left side: emoji + agent name
    var nameEl = document.createElement('span');
    nameEl.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
    var displayEmoji = session.emoji || '\uD83E\uDD16';
    var displayName = session.name || session.task || session.id || 'Session';
    nameEl.textContent = displayEmoji + ' ' + displayName;
    topRow.appendChild(nameEl);

    // Right side: status indicator + elapsed time
    var statusArea = document.createElement('span');
    statusArea.style.cssText = 'display:flex;align-items:center;gap:6px;white-space:nowrap;';

    // Status indicator with colored symbol
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

    // Elapsed time
    var elapsedSpan = document.createElement('span');
    elapsedSpan.style.cssText = 'font-size:10px;color:var(--text-dim);';
    elapsedSpan.setAttribute('data-elapsed-id', session.id);
    elapsedSpan.textContent = elapsedStr(session.startedAt || session.createdAt);
    statusArea.appendChild(elapsedSpan);

    topRow.appendChild(statusArea);
    card.appendChild(topRow);

    // ─ Detail rows: task + provider/model ─
    var detailsContainer = document.createElement('div');
    detailsContainer.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-secondary);';

    // Task description (truncated)
    if (session.task) {
      var taskRow = document.createElement('div');
      taskRow.style.cssText = 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      taskRow.textContent = '\u251C\u2500 Task: ' + (session.task.length > 60 ? session.task.slice(0, 60) + '\u2026' : session.task);
      detailsContainer.appendChild(taskRow);
    }

    // Result summary for completed/failed/stopped sessions (first 100 chars)
    var isFinished = sessionStatus === 'completed' || sessionStatus === 'idle' || sessionStatus === 'failed' || sessionStatus === 'error' || sessionStatus === 'stopped';

    // Provider / model
    if (session.provider || session.model) {
      var providerRow = document.createElement('div');
      providerRow.style.cssText = 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      var providerText = '';
      if (session.provider && session.model) {
        providerText = session.provider + ' / ' + session.model;
      } else {
        providerText = session.provider || session.model || '';
      }
      // Use ├─ if more rows follow (finished sessions have result/completion), else └─
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
        // Use ├─ if completion time follows, else └─
        var resultPrefix = session.completedAt ? '\u251C\u2500' : '\u2514\u2500';
        resultRow.textContent = resultPrefix + ' Result: ' + truncatedResult;
        detailsContainer.appendChild(resultRow);
      }

      // Completion time (e.g., "Completed 2m ago")
      if (session.completedAt) {
        var completionRow = document.createElement('div');
        completionRow.style.cssText = 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        var completionLabel = sessionStatus === 'failed' || sessionStatus === 'error' ? 'Failed' : sessionStatus === 'stopped' ? 'Stopped' : 'Completed';
        completionRow.textContent = '\u2514\u2500 ' + completionLabel + ' ' + relTime(session.completedAt);
        detailsContainer.appendChild(completionRow);
      }
    }

    card.appendChild(detailsContainer);

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

    // Stop button (only for active/live sessions)
    var isActiveSession = !isFinished;
    if (isActiveSession) {
      var stopBtn = document.createElement('button');
      stopBtn.className = 'ad-action-btn danger';
      stopBtn.textContent = '\u25A0 Stop';
      stopBtn.setAttribute('aria-label', 'Stop session');
      stopBtn.addEventListener('click', function (e) { e.stopPropagation(); self.stopSession(session, card); });
      actions.appendChild(stopBtn);
    }

    // Clear button (only for history/finished sessions: completed, failed, stopped)
    // Requirement 5.4: Users SHALL be able to clear individual historical sessions.
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

  /**
   * Dispatch a task through the real agent pipeline using the chat-message IPC channel.
   * Reads the selected agent from the dropdown and fires a one-way send to the main process.
   * The pipeline events (chat:stream, chat:done, chat:error) will create and update
   * the dashboard card — no need to call parallel:create here.
   *
   * Requirement 2.3: Dispatching a task SHALL actually execute it through the real agent pipeline.
   * Requirement 2.2: If no agent is explicitly selected, auto-route to default orchestrator.
   */
  AgentDashboardV2Panel.prototype.dispatchSession = function (task) {
    var self = this;
    var a = api();
    if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

    var projectId = self.projectSelect ? self.projectSelect.value : (window._neuronestActiveProject || 'default');
    var selectedAgentId = self.agentSelect ? self.agentSelect.value : '';

    // Build the chat-message payload
    var payload = {
      projectId: projectId,
      message: task,
      source: 'dashboard'
    };

    // Only include the agent field if a specific agent was selected (not "Auto")
    if (selectedAgentId) {
      payload.agent = selectedAgentId;
    }

    // Fire-and-forget: send through the real chat-message pipeline
    a.send('chat-message', payload);

    // Briefly disable the dispatch button to prevent accidental double-clicks (Req 2.4 UX polish)
    self.dispatchBtn.disabled = true;

    // Immediately create a "preparing" session card so user sees instant feedback (Req 2.4)
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

    // Set a 3-second timeout to remove the preparing state if no stream arrives
    var preparingTimeout = setTimeout(function () {
      // Re-enable the dispatch button after the timeout (Req 2.4 UX polish)
      self.dispatchBtn.disabled = false;

      var session = self._dashboardSessions.get(preparingId);
      if (session && session.status === 'preparing') {
        self._dashboardSessions.delete(preparingId);
        // Remove from sessions array
        for (var i = self.sessions.length - 1; i >= 0; i--) {
          if (self.sessions[i].id === preparingId) {
            self.sessions.splice(i, 1);
            break;
          }
        }
        self.renderSessionList();
      }
    }, 3000);

    // Store timeout reference on the session for potential cleanup
    preparingSession._timeout = preparingTimeout;

    // Clear the dispatch input
    self.dispatchInput.value = '';

    window.wk.toast('Task dispatched', 'success');
  };

  // ─── Peek ────────────────────────────────────────────────────────

  /**
   * Peek at a session's messages. For live/streaming sessions, renders the user's
   * original task and the streaming buffer directly. For completed sessions that
   * still have a buffer in memory (just finished), also renders from the buffer.
   * For historical sessions (loaded from DB, no buffer), fetches persisted messages.
   *
   * Requirement 3.1: Peek shows the actual conversation history for the selected agent session.
   * Requirement 3.2: For runtime agents (currently streaming), Peek shows the live buffered content so far.
   */
  AgentDashboardV2Panel.prototype.peekSession = function (session) {
    var self = this;
    var a = api();
    if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

    // Check if this is a live/streaming session
    var isLiveStreaming = session.status === 'streaming' || session.status === 'preparing';

    if (isLiveStreaming) {
      // For live sessions, render directly from session.buffer (Req 3.2)
      self.showPeekOverlayLive(session);
      return;
    }

    // For completed sessions that still have a buffer in memory (just finished,
    // came from _dashboardSessions), render using the buffer directly.
    // These are sessions that transitioned from streaming to completed but haven't
    // been persisted to the DB yet or still retain their buffer.
    var hasBuffer = session.buffer != null && session.buffer !== '';
    if (hasBuffer) {
      self.showPeekOverlayLive(session);
      return;
    }

    // For historical sessions (loaded from DB via parallel:list, no buffer),
    // fetch persisted messages from the store.
    a.invoke('parallel:get-messages', { sessionId: session.id, limit: 5 }).then(function (messages) {
      var msgs = Array.isArray(messages) ? messages : (messages && messages.messages) || [];
      // If no messages were returned but session has a task, show at least the user prompt
      if (msgs.length === 0 && session.task) {
        msgs = [{ role: 'user', content: session.task }];
      }
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

    // Clear any live peek refresh timer since we're now viewing a historical session
    this._clearPeekRefreshTimer();
    this._peekSessionId = null;

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
      self._clearPeekRefreshTimer();
      self._peekSessionId = null;
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

  // ─── Live Peek Overlay (Streaming Sessions) ───────────────────────

  /**
   * Show Peek overlay for live/streaming sessions by rendering the user's original
   * task at the top and the assistant's streaming buffer below it.
   * If the buffer is empty (session just started), shows a loading indicator.
   *
   * Requirement 3.1: Peek shows actual conversation for the selected agent session.
   * Requirement 3.2: For runtime agents (currently streaming), Peek shows the live buffered content.
   */
  AgentDashboardV2Panel.prototype.showPeekOverlayLive = function (session) {
    var self = this;
    this.peekEl.style.display = 'block';
    this.peekEl.innerHTML = '';
    this.peekVisible = true;

    // Track the peeked session for auto-refresh (Req 3.4)
    this._peekSessionId = session.id;

    // Clear any existing peek refresh timer before starting a new one
    this._clearPeekRefreshTimer();

    // Start 500ms auto-refresh interval for live streaming sessions (Req 3.4)
    var isStreaming = session.status === 'streaming' || session.status === 'preparing';
    if (isStreaming) {
      this._peekRefreshTimer = setInterval(function () {
        if (!self._peekSessionId) {
          self._clearPeekRefreshTimer();
          return;
        }
        var currentSession = self._dashboardSessions.get(self._peekSessionId);
        if (!currentSession) {
          self._clearPeekRefreshTimer();
          return;
        }
        // If session has completed or failed, stop refreshing and do one final render
        if (currentSession.status === 'completed' || currentSession.status === 'failed' || currentSession.status === 'stopped') {
          self._clearPeekRefreshTimer();
          self.showPeekOverlayLive(currentSession);
          return;
        }
        // Re-render the peek overlay with updated buffer content
        self.showPeekOverlayLive(currentSession);
      }, 500);
    }

    // Header row
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
    closeBtn.addEventListener('click', function () {
      self._clearPeekRefreshTimer();
      self._peekSessionId = null;
      self.peekEl.style.display = 'none';
      self.peekVisible = false;
    });
    header.appendChild(closeBtn);

    this.peekEl.appendChild(header);

    // User message: show the original task/prompt
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

    // Assistant message: show buffer content or loading indicator
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
      // Show the buffered content (truncate display to 500 chars for readability)
      var displayBuffer = session.buffer.length > 500
        ? session.buffer.slice(0, 500) + '\u2026'
        : session.buffer;
      assistantContent.textContent = displayBuffer;
    } else {
      // No buffer yet — show loading indicator
      assistantContent.style.color = 'var(--text-dim)';
      assistantContent.style.fontStyle = 'italic';
      assistantContent.textContent = 'Waiting for response\u2026';
    }

    assistantMsgEl.appendChild(assistantContent);

    // Requirement 3.3: Parse tool_calls from buffer if present
    // Detect tool call patterns in the streaming buffer and render them as cards
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

        if (toolCall.arguments) {
          var argsEl = document.createElement('div');
          argsEl.className = 'ad-peek-tool-args';
          var argsStr = typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments);
          argsEl.textContent = argsStr.slice(0, 200) + (argsStr.length > 200 ? '\u2026' : '');
          toolCardEl.appendChild(argsEl);
        }

        assistantMsgEl.appendChild(toolCardEl);
      }
    }

    this.peekEl.appendChild(assistantMsgEl);
  };

  // ─── Tool Call Buffer Parser (Requirement 3.3) ────────────────────

  /**
   * Parse tool call patterns from raw streaming buffer text.
   * Supports:
   *   - XML-style: <tool_call>...</tool_call> or <function_call>...</function_call>
   *   - JSON-style: {"function": {"name": "...", "arguments": ...}}
   *   - Simple function markers: @@TOOL: name(args)
   * Returns an array of { name, arguments } objects.
   */
  AgentDashboardV2Panel.prototype.parseToolCallsFromBuffer = function (buffer) {
    var results = [];
    if (!buffer || typeof buffer !== 'string') return results;

    // Pattern 1: XML-style tool_call or function_call blocks
    var xmlPattern = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/g;
    var xmlMatch;
    while ((xmlMatch = xmlPattern.exec(buffer)) !== null) {
      var inner = xmlMatch[1].trim();
      // Try to parse as JSON inside the XML tags
      try {
        var parsed = JSON.parse(inner);
        results.push({
          name: parsed.name || parsed.function || 'tool',
          arguments: parsed.arguments || parsed.parameters || parsed.input || ''
        });
      } catch (e) {
        // If not JSON, extract name from first line
        var lines = inner.split('\n');
        results.push({ name: lines[0].trim() || 'tool', arguments: lines.slice(1).join('\n').trim() });
      }
    }

    // Pattern 2: JSON blocks with "function" key indicating tool calls
    // Match {"function": {"name": "...", ...}} or {"type": "function", "function": {...}}
    var jsonPattern = /\{"(?:type"\s*:\s*"function"\s*,\s*")?function"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}[^}]*\}/g;
    var jsonMatch;
    while ((jsonMatch = jsonPattern.exec(buffer)) !== null) {
      // Avoid duplicates if already captured via XML
      var fullMatch = jsonMatch[0];
      try {
        var obj = JSON.parse(fullMatch);
        var fn = obj.function || obj;
        var toolName = fn.name || 'tool';
        var toolArgs = fn.arguments || fn.parameters || '';
        // Check we haven't already captured this name at the same position
        var isDuplicate = results.some(function (r) { return r.name === toolName; });
        if (!isDuplicate) {
          results.push({ name: toolName, arguments: toolArgs });
        }
      } catch (e2) {
        // Fallback: use regex capture group for the name
        if (jsonMatch[1]) {
          results.push({ name: jsonMatch[1], arguments: '' });
        }
      }
    }

    // Pattern 3: Simple markers like @@TOOL: function_name(args) or [TOOL_USE] function_name
    var markerPattern = /(?:@@TOOL|@@FUNCTION|\[TOOL_USE\]|\[tool_use\]):\s*(\w+)(?:\(([^)]*)\))?/g;
    var markerMatch;
    while ((markerMatch = markerPattern.exec(buffer)) !== null) {
      var mName = markerMatch[1] || 'tool';
      var mArgs = markerMatch[2] || '';
      var isDup = results.some(function (r) { return r.name === mName; });
      if (!isDup) {
        results.push({ name: mName, arguments: mArgs });
      }
    }

    return results;
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

  /**
   * Stop a session. Distinguishes between live sessions (streaming/preparing) and
   * historical sessions:
   * - Live sessions: call `eapi().send('abort-pipeline', { msgId })` to halt the specific agent,
   *   then mark the session as 'stopped'. The `chat:error` or `chat:done` event will
   *   fire and handle the final UI transition.
   * - Historical sessions: call `parallel:delete` to remove from the DB (existing behavior).
   *
   * Requirement 4.1: Stop button SHALL actually abort the running agent pipeline.
   * Requirement 4.2: After stopping, agent's status transitions to "stopped" with toast.
   * Requirement 4.3: Stopping one agent session SHALL NOT affect other concurrent sessions.
   */
  AgentDashboardV2Panel.prototype.stopSession = function (session, card) {
    var self = this;
    var sessionName = session.name || session.task || session.id || 'Session';

    // Remove any existing confirm in this card
    var existingConfirm = card.querySelector('.wk-confirm');
    if (existingConfirm) { existingConfirm.remove(); return; }

    // Determine if this is a live session (streaming/preparing) or a historical one
    var isLive = session.status === 'streaming' || session.status === 'preparing';

    var confirmMessage = isLive
      ? 'Stop agent "' + sessionName + '"? This will abort the running pipeline.'
      : 'Stop session "' + sessionName + '"? This will release all resources.';

    var confirmEl = window.wk.confirm(
      confirmMessage,
      function () {
        var a = api();
        if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

        // Disable all action buttons in this card during the operation
        var btns = card.querySelectorAll('.ad-action-btn');
        for (var i = 0; i < btns.length; i++) disableBtn(btns[i]);

        if (isLive) {
          // Live session: abort the pipeline (Req 4.1, 4.3)
          // Extract the msgId from session.id ('stream-<msgId>') so the backend
          // can target only this specific agent if it supports per-session abort.
          var msgId = session.id.replace('stream-', '');
          a.send('abort-pipeline', { msgId: msgId });

          // Mark the session as 'stopped' in _dashboardSessions immediately (Req 4.2)
          var dashSession = self._dashboardSessions.get(session.id);
          if (dashSession) {
            dashSession.status = 'stopped';
            dashSession.completedAt = Date.now();
            self._dashboardSessions.set(session.id, dashSession);
          }

          // Also update the local session object for immediate UI feedback
          session.status = 'stopped';
          session.completedAt = Date.now();

          // Re-render to reflect the stopped status
          self._mergeDashboardSessions();
          self.renderSessionList();
          self.lastRefresh = Date.now();
          self.updateRefreshBadge();

          window.wk.toast('Agent stopped', 'success');
          // The chat:error or chat:done event listener will handle the final transition
        } else {
          // Historical session: delete from DB (existing behavior)
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

  // ─── Clear Session (Remove from history) ──────────────────────────────

  /**
   * Clear a completed/failed/stopped session from history.
   * Calls `parallel:delete` to remove it from the database, removes it from
   * the in-memory _dashboardSessions map and sessions array, then re-renders.
   *
   * Requirement 5.4: Users SHALL be able to clear individual historical sessions.
   */
  AgentDashboardV2Panel.prototype.clearSession = function (session) {
    var self = this;
    var a = api();
    if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

    a.invoke('parallel:delete', { sessionId: session.id }).then(function () {
      // Remove from _dashboardSessions if present
      self._dashboardSessions.delete(session.id);

      // Remove from sessions array
      for (var i = self.sessions.length - 1; i >= 0; i--) {
        if (self.sessions[i].id === session.id) {
          self.sessions.splice(i, 1);
          break;
        }
      }

      // Re-render
      self.renderSessionList();
      self.lastRefresh = Date.now();
      self.updateRefreshBadge();

      window.wk.toast('Session cleared', 'success');
    }).catch(function (err) {
      window.wk.toast('Clear failed: ' + (err && err.message || err), 'error');
    });
  };

  // ─── Clear All History (with confirmation dialog) ─────────────────────

  /**
   * Clear all historical sessions from the database and in-memory state.
   * Shows a confirmation dialog before proceeding. On confirm, iterates through
   * all history sessions, deletes each from the database, removes them from
   * _dashboardSessions and sessions array, and re-renders.
   *
   * Requirement 5.4: Users SHALL be able to clear all history.
   */
  AgentDashboardV2Panel.prototype.clearAllHistory = function (historySessions) {
    var self = this;

    // Remove any existing confirm in the list area
    var existingConfirm = self.listEl.querySelector('.wk-confirm');
    if (existingConfirm) { existingConfirm.remove(); return; }

    var confirmEl = window.wk.confirm(
      'Clear all history? This will permanently delete ' + historySessions.length + ' session(s).',
      function () {
        var a = api();
        if (!a) { window.wk.toast('IPC unavailable', 'error'); return; }

        // Delete each history session from the database
        for (var i = 0; i < historySessions.length; i++) {
          (function (sessionId) {
            a.invoke('parallel:delete', { sessionId: sessionId }).catch(function (err) {
              console.warn('[AgentDashboard] Failed to delete session ' + sessionId + ':', err);
            });
          })(historySessions[i].id);
        }

        // Remove from _dashboardSessions map
        for (var j = 0; j < historySessions.length; j++) {
          self._dashboardSessions.delete(historySessions[j].id);
        }

        // Remove from sessions array
        var historyIds = {};
        for (var k = 0; k < historySessions.length; k++) {
          historyIds[historySessions[k].id] = true;
        }
        for (var m = self.sessions.length - 1; m >= 0; m--) {
          if (historyIds[self.sessions[m].id]) {
            self.sessions.splice(m, 1);
          }
        }

        // Re-render
        self.renderSessionList();
        self.lastRefresh = Date.now();
        self.updateRefreshBadge();

        window.wk.toast('History cleared', 'success');
      }
    );

    self.listEl.appendChild(confirmEl);
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

  // ─── Peek Refresh Timer Cleanup (Requirement 3.4) ─────────────────

  /**
   * Clears the 500ms peek auto-refresh interval timer.
   * Called when: Peek is closed, session completes/fails, or panel is destroyed.
   */
  AgentDashboardV2Panel.prototype._clearPeekRefreshTimer = function () {
    if (this._peekRefreshTimer) {
      clearInterval(this._peekRefreshTimer);
      this._peekRefreshTimer = null;
    }
  };

  // ─── Workspace Pill Unread Badge (Requirement 7.4) ──────────────────

  /**
   * Checks whether the panel container is currently visible in the DOM.
   * Returns false if the container or any ancestor has display:none or
   * if the container is not attached to the document.
   */
  AgentDashboardV2Panel.prototype._isPanelVisible = function () {
    if (!this.container) return false;
    // offsetParent is null when the element or any ancestor has display:none
    // (except for elements with position:fixed, which is not the case here)
    if (this.container.offsetParent === null) return false;
    return true;
  };

  /**
   * Updates or creates a badge element on the Agent Dashboard workspace pill/tab
   * to indicate unread session completions. Looks for the workspace pill by known
   * selectors (data-workspace, data-panel-id, or button text). When _unreadCount
   * is 0, removes the badge element entirely.
   *
   * Requirement 7.4: If the panel is hidden when a session completes, show an
   * unread badge count on the Agent Dashboard workspace pill.
   */
  AgentDashboardV2Panel.prototype._updateWorkspacePillBadge = function () {
    var count = this._unreadCount;

    // Try to find the workspace pill/tab for the Agent Dashboard
    var pill = document.querySelector('[data-workspace="agent-dashboard"]') ||
               document.querySelector('[data-panel-id="agent-dashboard-v2"]') ||
               document.querySelector('.nn-sidebar-nav-item[data-panel-id="agent-dashboard-v2"]') ||
               document.querySelector('button[title="Agent Dashboard"]') ||
               document.querySelector('[aria-label="Open Agent Dashboard"]');

    // If we can't find the pill in the sidebar, look in the workspaces grid cards
    if (!pill) {
      var buttons = document.querySelectorAll('button[aria-label*="Agent Dashboard"]');
      if (buttons.length > 0) {
        pill = buttons[0];
      }
    }

    if (!pill) return;

    // Find existing badge or create a new one
    var badgeId = 'ad-unread-badge';
    var badge = pill.querySelector('#' + badgeId) || pill.querySelector('[data-ad-badge]');

    if (count <= 0) {
      // Remove badge if count is 0
      if (badge) {
        badge.parentNode.removeChild(badge);
      }
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

      // Ensure the pill has relative positioning for the absolute badge
      var pillStyle = window.getComputedStyle(pill);
      if (pillStyle.position === 'static' || pillStyle.position === '') {
        pill.style.position = 'relative';
      }

      pill.appendChild(badge);
    }

    // Update the badge text
    badge.textContent = count > 99 ? '99+' : String(count);
  };

  // ─── Cleanup ─────────────────────────────────────────────────────

  AgentDashboardV2Panel.prototype.destroy = function () {
    // Save scroll position before teardown so it can be restored on next render (Req 7.4)
    if (this.container) {
      this._savedScrollPosition = this.container.scrollTop || 0;
    }

    // Mark panel as hidden so unread badge can accumulate (Req 7.4)
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
