// @ts-nocheck
/**
 * AutomationWorkspacePanel — Unified automation management workspace.
 *
 * Uses window.wk namespace utilities for forms, toasts, cards, badges, etc.
 * All actions show toast feedback. All buttons disabled during async ops.
 * No alert() calls — all data displayed in-panel.
 *
 * Tabs: Loops, Pipelines, Scheduler, Missions, PCV, Headless
 * Requirements: 1-5 (toast, forms, data display, polish, per-panel)
 */

(function () {
  'use strict';

  var TABS = [
    { id: 'loops', label: 'Loops' },
    { id: 'pipelines', label: 'Pipelines' },
    { id: 'scheduler', label: 'Scheduler' },
    { id: 'missions', label: 'Missions' },
    { id: 'pcv', label: 'PCV' },
    { id: 'headless', label: 'Headless' },
  ];

  function api() { return window.electronAPI; }
  function projectId() { return window._neuronestActiveProject || 'default'; }

  // ─── Helpers ─────────────────────────────────────────────────────

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.pointerEvents = ''; }

  function asyncAction(btn, promise, successMsg) {
    disableBtn(btn);
    return promise.then(function (r) {
      enableBtn(btn);
      wk.toast(successMsg, 'success');
      return r;
    }).catch(function (err) {
      enableBtn(btn);
      wk.toast((err && err.message) || 'Action failed', 'error');
      throw err;
    });
  }

  function formatTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  function statusVariant(s) {
    if (s === 'running' || s === 'active' || s === 'completed') return 'success';
    if (s === 'failed' || s === 'cancelled' || s === 'blocked') return 'error';
    if (s === 'paused' || s === 'awaiting_approval') return 'warning';
    return 'info';
  }

  // ─── Panel Constructor ────────────────────────────────────────────

  function AutomationWorkspacePanel(container, options) {
    this.container = container;
    this.activeTab = 'loops';
    this.formContainer = null;
    this.listContainer = null;
    // Event subscription cleanup functions for the Loops tab (Req 6, 16)
    this._loopEventUnsubs = [];
    // Container for pass detail cards (live stream)
    this._passDetailContainer = null;
    // Plan Mode state (Req 10.1-10.5)
    this._planModeActive = false;
    this._currentPlan = null;
    this._planSectionEl = null;
    this._planEventUnsubs = [];
  }

  AutomationWorkspacePanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-family);overflow:hidden;';

    // Plan Mode section — rendered above tab bar when active (Req 10.1, 10.5)
    this._planSectionEl = document.createElement('div');
    this._planSectionEl.setAttribute('data-plan-mode-section', 'true');
    this.container.appendChild(this._planSectionEl);

    // Subscribe to plan events (Req 10.1, 10.4)
    this._subscribePlanEvents();

    // If plan mode is already active, render it immediately
    if (this._planModeActive && this._currentPlan) {
      this._renderPlanModeSection();
    } else {
      // Check initial plan state from backend
      this._fetchInitialPlanState();
    }

    // Tab bar
    var tabBar = document.createElement('div');
    tabBar.className = 'wk-tabs';
    for (var i = 0; i < TABS.length; i++) {
      (function (tab) {
        var btn = document.createElement('button');
        btn.className = 'wk-tab' + (tab.id === self.activeTab ? ' active' : '');
        btn.textContent = tab.label;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-label', tab.label + ' tab');
        btn.addEventListener('click', function () {
          self.activeTab = tab.id;
          self.render();
        });
        tabBar.appendChild(btn);
      })(TABS[i]);
    }
    this.container.appendChild(tabBar);

    // Scrollable content area
    var content = document.createElement('div');
    content.className = 'wk-scroll';
    content.style.cssText = 'flex:1;overflow-y:auto;padding:0 4px;';
    this.container.appendChild(content);

    // Form mount point
    this.formContainer = document.createElement('div');
    content.appendChild(this.formContainer);

    // List mount point
    this.listContainer = document.createElement('div');
    content.appendChild(this.listContainer);

    this.loadTab(this.activeTab);
  };

  // ─── Plan Mode (Req 10.1-10.5) ─────────────────────────────────────

  AutomationWorkspacePanel.prototype._fetchInitialPlanState = function () {
    var self = this;
    var a = api();
    if (!a) return;
    a.invoke('plan:get-current', {}).then(function (result) {
      if (result && result.active) {
        self._planModeActive = true;
        self._currentPlan = result.plan || result;
        self._renderPlanModeSection();
      }
    }).catch(function () {
      // No active plan — expected case, do nothing
    });
  };

  AutomationWorkspacePanel.prototype._subscribePlanEvents = function () {
    var self = this;
    if (!window.subscribeEvent) return;

    var onPlanStateChanged = function (data) {
      if (!data) return;
      var state = data.state || data.status;
      if (state === 'planning' || state === 'active') {
        self._planModeActive = true;
        self._currentPlan = data.plan || self._currentPlan || data;
        self._renderPlanModeSection();
      } else if (state === 'executing' || state === 'execution') {
        // Transition from planning to execution (Req 10.4)
        self._planModeActive = false;
        self._currentPlan = null;
        self._renderPlanModeTransition();
      } else if (state === 'idle' || state === 'discarded' || state === 'cancelled') {
        self._planModeActive = false;
        self._currentPlan = null;
        self._clearPlanModeSection();
      }
    };

    var onPlanUpdated = function (data) {
      if (!data) return;
      self._currentPlan = data.plan || data;
      if (self._planModeActive) {
        self._renderPlanModeSection();
      }
    };

    window.subscribeEvent('plan:state-changed', onPlanStateChanged);
    window.subscribeEvent('plan:updated', onPlanUpdated);

    self._planEventUnsubs.push(function () {
      if (window.unsubscribeEvent) {
        window.unsubscribeEvent('plan:state-changed', onPlanStateChanged);
        window.unsubscribeEvent('plan:updated', onPlanUpdated);
      }
    });
  };

  AutomationWorkspacePanel.prototype._cleanupPlanEvents = function () {
    for (var i = 0; i < this._planEventUnsubs.length; i++) {
      this._planEventUnsubs[i]();
    }
    this._planEventUnsubs = [];
  };

  AutomationWorkspacePanel.prototype._clearPlanModeSection = function () {
    if (this._planSectionEl) {
      this._planSectionEl.innerHTML = '';
    }
  };

  AutomationWorkspacePanel.prototype._renderPlanModeTransition = function () {
    var self = this;
    if (!self._planSectionEl) return;
    self._planSectionEl.innerHTML = '';

    var transEl = document.createElement('div');
    transEl.style.cssText = 'background:var(--green-container);border:1px solid var(--green);border-radius:var(--radius-sm);padding:12px 16px;margin-bottom:12px;animation:wkFadeIn 0.3s ease forwards;';
    transEl.setAttribute('role', 'status');
    transEl.setAttribute('aria-live', 'polite');

    var msg = document.createElement('div');
    msg.style.cssText = 'font-size:13px;font-weight:600;color:var(--green);display:flex;align-items:center;gap:8px;';
    msg.innerHTML = '<span style="font-size:16px;">&#10003;</span> Plan approved — transitioning to execution';
    transEl.appendChild(msg);

    self._planSectionEl.appendChild(transEl);

    // Auto-remove after 4 seconds
    setTimeout(function () {
      if (transEl.parentNode) {
        transEl.style.opacity = '0';
        transEl.style.transition = 'opacity 0.3s ease';
        setTimeout(function () { self._clearPlanModeSection(); }, 300);
      }
    }, 4000);
  };

  AutomationWorkspacePanel.prototype._renderPlanModeSection = function () {
    var self = this;
    if (!self._planSectionEl) return;
    self._planSectionEl.innerHTML = '';

    var plan = self._currentPlan;
    if (!plan) return;

    // Plan Mode container (Req 10.1)
    var section = document.createElement('div');
    section.className = 'wk-plan-mode-section';
    section.style.cssText = 'border:2px solid var(--yellow);border-radius:var(--radius-sm);margin-bottom:12px;overflow:hidden;animation:wkFadeIn 0.3s ease forwards;';
    section.setAttribute('role', 'region');
    section.setAttribute('aria-label', 'Plan Mode');

    // Read-Only banner (Req 10.5)
    var banner = document.createElement('div');
    banner.className = 'wk-plan-mode-banner';
    banner.style.cssText = 'background:var(--yellow-container);padding:10px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--yellow);';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'assertive');
    var bannerIcon = document.createElement('span');
    bannerIcon.style.cssText = 'font-size:14px;';
    bannerIcon.textContent = '\u26A0\uFE0F';
    banner.appendChild(bannerIcon);
    var bannerText = document.createElement('span');
    bannerText.style.cssText = 'font-size:12px;font-weight:600;color:var(--yellow);';
    bannerText.textContent = 'Read-Only \u2014 Agent is planning';
    banner.appendChild(bannerText);
    var bannerHint = document.createElement('span');
    bannerHint.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-left:auto;';
    bannerHint.textContent = 'No edits will be made until you approve the plan.';
    banner.appendChild(bannerHint);
    section.appendChild(banner);

    // Plan content body (Req 10.2)
    var body = document.createElement('div');
    body.style.cssText = 'padding:14px 16px;background:var(--surface-container);';

    // Goal
    if (plan.goal) {
      var goalSection = document.createElement('div');
      goalSection.style.cssText = 'margin-bottom:12px;';
      var goalLabel = document.createElement('div');
      goalLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
      goalLabel.textContent = 'Goal';
      goalSection.appendChild(goalLabel);
      var goalText = document.createElement('div');
      goalText.style.cssText = 'font-size:13px;color:var(--text-primary);font-weight:500;';
      goalText.textContent = plan.goal;
      goalSection.appendChild(goalText);
      body.appendChild(goalSection);
    }

    // Steps (numbered list)
    var steps = plan.steps || [];
    if (steps.length > 0) {
      var stepsSection = document.createElement('div');
      stepsSection.style.cssText = 'margin-bottom:12px;';
      var stepsLabel = document.createElement('div');
      stepsLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;';
      stepsLabel.textContent = 'Steps';
      stepsSection.appendChild(stepsLabel);
      var stepsList = document.createElement('ol');
      stepsList.style.cssText = 'margin:0;padding-left:20px;font-size:12px;color:var(--text-secondary);line-height:1.8;';
      for (var si = 0; si < steps.length; si++) {
        var li = document.createElement('li');
        li.style.cssText = 'padding:2px 0;';
        li.textContent = typeof steps[si] === 'string' ? steps[si] : (steps[si].description || steps[si].name || JSON.stringify(steps[si]));
        stepsList.appendChild(li);
      }
      stepsSection.appendChild(stepsList);
      body.appendChild(stepsSection);
    }

    // Verification criteria
    var verification = plan.verification || plan.verificationCriteria || plan.verify || [];
    if (typeof verification === 'string') verification = [verification];
    if (verification.length > 0) {
      var verifySection = document.createElement('div');
      verifySection.style.cssText = 'margin-bottom:12px;';
      var verifyLabel = document.createElement('div');
      verifyLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;';
      verifyLabel.textContent = 'Verification';
      verifySection.appendChild(verifyLabel);
      var verifyList = document.createElement('ul');
      verifyList.style.cssText = 'margin:0;padding-left:18px;font-size:12px;color:var(--text-secondary);line-height:1.7;list-style:disc;';
      for (var vi = 0; vi < verification.length; vi++) {
        var vli = document.createElement('li');
        vli.style.cssText = 'padding:1px 0;';
        vli.textContent = typeof verification[vi] === 'string' ? verification[vi] : JSON.stringify(verification[vi]);
        verifyList.appendChild(vli);
      }
      verifySection.appendChild(verifyList);
      body.appendChild(verifySection);
    }

    // Protected paths
    var protectedPaths = plan.protectedPaths || plan.protected || [];
    if (typeof protectedPaths === 'string') protectedPaths = [protectedPaths];
    if (protectedPaths.length > 0) {
      var protSection = document.createElement('div');
      protSection.style.cssText = 'margin-bottom:12px;';
      var protLabel = document.createElement('div');
      protLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;';
      protLabel.textContent = 'Protected Paths';
      protSection.appendChild(protLabel);
      var protList = document.createElement('div');
      protList.style.cssText = 'font-size:11px;color:var(--text-secondary);font-family:"SF Mono",Menlo,monospace;background:var(--surface-container-high);border-radius:var(--radius-xs);padding:8px 10px;';
      protList.textContent = protectedPaths.join(', ');
      protSection.appendChild(protList);
      body.appendChild(protSection);
    }

    section.appendChild(body);

    // Action buttons (Req 10.3)
    var actionsBar = document.createElement('div');
    actionsBar.style.cssText = 'display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border-color);background:var(--surface-container-high);flex-wrap:wrap;';

    // Approve & Execute (Req 10.3, 10.4)
    var approveBtn = document.createElement('button');
    approveBtn.className = 'wk-btn-primary';
    approveBtn.textContent = '\u2713 Approve & Execute';
    approveBtn.setAttribute('aria-label', 'Approve plan and begin execution');
    approveBtn.addEventListener('click', function () {
      disableBtn(approveBtn);
      var a = api();
      if (!a) { enableBtn(approveBtn); return; }
      wk.toast('Approving plan...', 'info');
      a.invoke('plan:approve', { planId: plan.id }).then(function () {
        wk.toast('Plan approved \u2014 execution starting', 'success');
        self._planModeActive = false;
        self._currentPlan = null;
        self._renderPlanModeTransition();
      }).catch(function (err) {
        enableBtn(approveBtn);
        wk.toast((err && err.message) || 'Failed to approve plan', 'error');
      });
    });
    actionsBar.appendChild(approveBtn);

    // Send to Loop (Req 10.3)
    var loopBtn = document.createElement('button');
    loopBtn.className = 'wk-btn-secondary';
    loopBtn.textContent = '\uD83D\uDD04 Send to Loop';
    loopBtn.setAttribute('aria-label', 'Send plan to Loop Engine');
    loopBtn.addEventListener('click', function () {
      disableBtn(loopBtn);
      var a = api();
      if (!a) { enableBtn(loopBtn); return; }
      wk.toast('Sending to Loop Engine...', 'info');
      a.invoke('plan:send-to-loop', { planId: plan.id }).then(function () {
        enableBtn(loopBtn);
        wk.toast('Plan sent to Loop Engine', 'success');
      }).catch(function (err) {
        enableBtn(loopBtn);
        wk.toast((err && err.message) || 'Failed to send to loop', 'error');
      });
    });
    actionsBar.appendChild(loopBtn);

    // Revise (Req 10.3)
    var reviseBtn = document.createElement('button');
    reviseBtn.className = 'wk-btn-secondary';
    reviseBtn.textContent = '\u270F\uFE0F Revise';
    reviseBtn.setAttribute('aria-label', 'Request plan revision');
    reviseBtn.addEventListener('click', function () {
      disableBtn(reviseBtn);
      var a = api();
      if (!a) { enableBtn(reviseBtn); return; }
      wk.toast('Requesting revision...', 'info');
      a.invoke('plan:revise', { planId: plan.id }).then(function () {
        enableBtn(reviseBtn);
        wk.toast('Revision requested \u2014 agent is reworking the plan', 'info');
      }).catch(function (err) {
        enableBtn(reviseBtn);
        wk.toast((err && err.message) || 'Failed to request revision', 'error');
      });
    });
    actionsBar.appendChild(reviseBtn);

    // Discard (Req 10.3)
    var discardBtn = document.createElement('button');
    discardBtn.className = 'wk-btn-danger';
    discardBtn.textContent = '\u2715 Discard';
    discardBtn.setAttribute('aria-label', 'Discard the current plan');
    discardBtn.addEventListener('click', function () {
      disableBtn(discardBtn);
      var a = api();
      if (!a) { enableBtn(discardBtn); return; }
      a.invoke('plan:discard', { planId: plan.id }).then(function () {
        wk.toast('Plan discarded', 'success');
        self._planModeActive = false;
        self._currentPlan = null;
        self._clearPlanModeSection();
      }).catch(function (err) {
        enableBtn(discardBtn);
        wk.toast((err && err.message) || 'Failed to discard plan', 'error');
      });
    });
    actionsBar.appendChild(discardBtn);

    section.appendChild(actionsBar);
    self._planSectionEl.appendChild(section);
  };

  // ─── Tab Loading ─────────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.loadTab = function (tabId) {
    // Unsubscribe from loop events when switching away from loops tab (Req 16)
    this._cleanupLoopEvents();

    this.formContainer.innerHTML = '';
    this.listContainer.innerHTML = '';
    switch (tabId) {
      case 'loops': this.renderLoopsTab(); break;
      case 'pipelines': this.renderPipelinesTab(); break;
      case 'scheduler': this.renderSchedulerTab(); break;
      case 'missions': this.renderMissionsTab(); break;
      case 'pcv': this.renderPCVTab(); break;
      case 'headless': this.renderHeadlessTab(); break;
    }
  };

  // ─── Loop Event Cleanup ────────────────────────────────────────────

  AutomationWorkspacePanel.prototype._cleanupLoopEvents = function () {
    for (var i = 0; i < this._loopEventUnsubs.length; i++) {
      this._loopEventUnsubs[i]();
    }
    this._loopEventUnsubs = [];
    this._passDetailContainer = null;
  };

  // ─── Loops Tab ─────────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.renderLoopsTab = function () {
    var self = this;
    var fc = this.formContainer;
    var lc = this.listContainer;

    // Action bar with Live indicator (Req 6.1, 16.3)
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;align-items:center;';
    var craftBtn = document.createElement('button');
    craftBtn.className = 'wk-btn-primary';
    craftBtn.textContent = '+ Craft Loop';
    craftBtn.setAttribute('aria-label', 'Craft a new loop');
    craftBtn.addEventListener('click', function () {
      self.showLoopForm();
    });
    bar.appendChild(craftBtn);

    // Live indicator from EventStreamBus (Req 16.3)
    if (window.EventStreamBus && typeof window.EventStreamBus.createLiveIndicator === 'function') {
      var liveEl = window.EventStreamBus.createLiveIndicator();
      liveEl.style.marginLeft = 'auto';
      bar.appendChild(liveEl);
    }
    fc.appendChild(bar);

    // Pass detail container for real-time pass data (Req 6.4)
    var passDetailSection = document.createElement('div');
    passDetailSection.style.cssText = 'margin-bottom:12px;';
    passDetailSection.setAttribute('aria-label', 'Live pass details');
    self._passDetailContainer = passDetailSection;
    lc.appendChild(passDetailSection);

    // Loop cards list container
    var loopListContainer = document.createElement('div');
    loopListContainer.setAttribute('data-loop-list', 'true');
    lc.appendChild(loopListContainer);

    // Load list
    var a = api();
    if (!a) { loopListContainer.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', 'Cannot connect to backend.')); return; }

    a.invoke('loops:list', {}).then(function (result) {
      var loops = (result && result.loops) || result || [];
      if (!Array.isArray(loops)) loops = [];
      if (loops.length === 0) {
        loopListContainer.appendChild(wk.emptyState('🔄', 'No loops configured', 'Craft one to automate iterative tasks.'));
        return;
      }
      for (var i = 0; i < loops.length; i++) {
        loopListContainer.appendChild(self.renderLoopCard(loops[i]));
      }
    }).catch(function (err) {
      loopListContainer.appendChild(wk.emptyState('❌', 'Failed to load loops', (err && err.message) || ''));
    });

    // Subscribe to real-time loop events (Req 6.1, 6.2, 6.4, 16.1)
    self._subscribeLoopEvents(loopListContainer);
  };

  // ─── Loop Event Subscriptions (Req 6.1-6.5, 16.1-16.2) ───────────

  AutomationWorkspacePanel.prototype._subscribeLoopEvents = function (loopListContainer) {
    var self = this;

    if (!window.subscribeEvent) return;

    // Handler for loop:state-changed — update state badge + action buttons in real-time (Req 6.1, 6.2)
    var onStateChanged = function (data) {
      if (!data || !data.loopId) return;
      var cardEl = loopListContainer.querySelector('[data-loop-id="' + data.loopId + '"]');
      if (!cardEl) return;

      // Update state badge
      var badgeEl = cardEl.querySelector('.wk-badge');
      if (badgeEl) {
        var newState = data.state || data.status || 'idle';
        badgeEl.textContent = newState;
        badgeEl.className = 'wk-badge wk-badge-' + statusVariant(newState);
        badgeEl.setAttribute('aria-label', statusVariant(newState) + ' status: ' + newState);
      }

      // Update action buttons based on new state
      var actionsEl = cardEl.querySelector('[data-loop-actions]');
      if (actionsEl) {
        self._updateLoopActions(actionsEl, data);
      }
    };

    // Handler for loop:pass-completed — append pass detail card (Req 6.4, 16.2)
    var onPassCompleted = function (data) {
      if (!data) return;
      var passCard = self._createPassDetailCard(data);
      if (self._passDetailContainer && window.EventStreamBus) {
        window.EventStreamBus.appendIncremental(self._passDetailContainer, passCard);
      } else if (self._passDetailContainer) {
        self._passDetailContainer.prepend(passCard);
      }
    };

    window.subscribeEvent('loop:state-changed', onStateChanged);
    window.subscribeEvent('loop:pass-completed', onPassCompleted);

    // Store cleanup functions
    self._loopEventUnsubs.push(function () {
      if (window.unsubscribeEvent) {
        window.unsubscribeEvent('loop:state-changed', onStateChanged);
        window.unsubscribeEvent('loop:pass-completed', onPassCompleted);
      }
    });
  };

  // ─── Update Loop Action Buttons In-Place (Req 6.3, 6.5) ──────────

  AutomationWorkspacePanel.prototype._updateLoopActions = function (actionsEl, data) {
    var self = this;
    var state = data.state || data.status || 'idle';
    var loopId = data.loopId;

    actionsEl.innerHTML = '';

    // Pause/Stop button for running loops (Req 6.3)
    if (state === 'running' || state === 'active' || state === 'executing' || state === 'verifying' || state === 'planning') {
      var pauseBtn = document.createElement('button');
      pauseBtn.className = 'wk-btn-secondary';
      pauseBtn.textContent = '⏸ Pause';
      pauseBtn.setAttribute('aria-label', 'Pause loop');
      pauseBtn.addEventListener('click', function () {
        asyncAction(pauseBtn, api().invoke('loops:stop', { loopId: loopId }), 'Loop paused');
      });
      actionsEl.appendChild(pauseBtn);

      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'wk-btn-danger';
      cancelBtn.textContent = '✕ Cancel';
      cancelBtn.setAttribute('aria-label', 'Cancel loop');
      cancelBtn.addEventListener('click', function () {
        asyncAction(cancelBtn, api().invoke('loops:stop', { loopId: loopId, cancel: true }), 'Loop cancelled')
          .then(function () { self.loadTab('loops'); }).catch(function () {});
      });
      actionsEl.appendChild(cancelBtn);
    }

    // Resume/Approve button for paused or awaiting approval (Req 6.3, 6.5)
    if (state === 'paused' || state === 'awaiting_approval' || state === 'blocked') {
      var resumeBtn = document.createElement('button');
      resumeBtn.className = 'wk-btn-primary';
      resumeBtn.textContent = '▶ Resume';
      resumeBtn.setAttribute('aria-label', 'Resume loop');
      resumeBtn.addEventListener('click', function () {
        asyncAction(resumeBtn, api().invoke('loops:approve', { loopId: loopId }), 'Loop resumed');
      });
      actionsEl.appendChild(resumeBtn);

      var cancelBtn2 = document.createElement('button');
      cancelBtn2.className = 'wk-btn-danger';
      cancelBtn2.textContent = '✕ Cancel';
      cancelBtn2.setAttribute('aria-label', 'Cancel loop');
      cancelBtn2.addEventListener('click', function () {
        asyncAction(cancelBtn2, api().invoke('loops:stop', { loopId: loopId, cancel: true }), 'Loop cancelled')
          .then(function () { self.loadTab('loops'); }).catch(function () {});
      });
      actionsEl.appendChild(cancelBtn2);
    }

    // Run button for idle/completed/failed
    if (state === 'idle' || state === 'completed' || state === 'failed') {
      var runBtn = document.createElement('button');
      runBtn.className = 'wk-btn-primary';
      runBtn.textContent = '▶ Run';
      runBtn.setAttribute('aria-label', 'Run loop');
      runBtn.addEventListener('click', function () {
        asyncAction(runBtn, api().invoke('loops:run', { loopId: loopId }), 'Loop started')
          .then(function () { self.loadTab('loops'); }).catch(function () {});
      });
      actionsEl.appendChild(runBtn);
    }

    // Receipt button — always available
    var receiptBtn = document.createElement('button');
    receiptBtn.className = 'wk-btn-secondary';
    receiptBtn.textContent = '📄 Receipt';
    receiptBtn.setAttribute('aria-label', 'View receipt');
    receiptBtn.addEventListener('click', function () {
      disableBtn(receiptBtn);
      api().invoke('loops:receipt', { loopId: loopId }).then(function (r) {
        enableBtn(receiptBtn);
        if (r) {
          var parentCard = actionsEl.closest('.wk-card');
          if (parentCard) {
            var existing = parentCard.querySelector('.wk-data-view');
            if (existing) { existing.remove(); return; }
            wk.dataView(parentCard, r);
          }
        } else {
          wk.toast('No receipt available', 'info');
        }
      }).catch(function (err) {
        enableBtn(receiptBtn);
        wk.toast((err && err.message) || 'Failed to load receipt', 'error');
      });
    });
    actionsEl.appendChild(receiptBtn);
  };

  // ─── Pass Detail Card (Req 6.4) ──────────────────────────────────

  AutomationWorkspacePanel.prototype._createPassDetailCard = function (passData) {
    var passNum = passData.passNumber || passData.pass || '?';
    var tools = passData.toolsCalled || passData.tools || [];
    var files = passData.filesModified || passData.files || [];
    var verification = passData.verificationResult || passData.verification || 'unknown';

    var el = document.createElement('div');
    el.className = 'wk-card';
    el.style.cssText = 'margin-bottom:6px;padding:10px 14px;border-left:3px solid var(--accent);';
    el.setAttribute('aria-label', 'Pass ' + passNum + ' detail');

    // Top row: pass number + verification badge
    var top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
    var passLabel = document.createElement('span');
    passLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
    passLabel.textContent = 'Pass ' + passNum;
    top.appendChild(passLabel);

    var verifyVariant = verification === 'passed' || verification === 'success' ? 'success' :
                        verification === 'failed' ? 'error' : 'info';
    top.appendChild(wk.badge(verification, verifyVariant));
    el.appendChild(top);

    // Tools called
    if (tools.length > 0) {
      var toolsRow = document.createElement('div');
      toolsRow.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:2px;';
      toolsRow.textContent = '🔧 Tools: ' + (Array.isArray(tools) ? tools.join(', ') : String(tools));
      el.appendChild(toolsRow);
    }

    // Files modified
    if (files.length > 0) {
      var filesRow = document.createElement('div');
      filesRow.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:2px;';
      filesRow.textContent = '📁 Files: ' + (Array.isArray(files) ? files.join(', ') : String(files));
      el.appendChild(filesRow);
    }

    // Timestamp
    var timeRow = document.createElement('div');
    timeRow.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:4px;';
    timeRow.textContent = formatTime(passData.completedAt || Date.now());
    el.appendChild(timeRow);

    return el;
  };

  AutomationWorkspacePanel.prototype.showLoopForm = function () {
    var self = this;
    var fc = this.formContainer;
    // Remove existing form if any
    var existing = fc.querySelector('.wk-form');
    if (existing) { existing.remove(); return; }

    wk.form(fc, [
      { name: 'name', label: 'Loop Name', placeholder: 'e.g. Fix Auth Bug', required: true },
      { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Describe what this loop should accomplish' },
      { name: 'verifyChecks', label: 'Verify Checks (one per line)', type: 'textarea', placeholder: 'npm test\nnpm run lint' },
    ], function (data) {
      var a = api(); if (!a) return;
      var payload = {
        projectId: projectId(),
        name: data.name,
        description: data.description,
        verifyChecks: data.verifyChecks ? data.verifyChecks.split('\n').filter(function (l) { return l.trim(); }) : [],
      };
      wk.toast('Crafting loop...', 'info');
      a.invoke('loops:craft', payload).then(function () {
        wk.toast('Loop crafted successfully', 'success');
        self.loadTab('loops');
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to craft loop', 'error');
      });
    }, function () { /* cancel — form removes itself */ });
  };

  AutomationWorkspacePanel.prototype.renderLoopCard = function (loop) {
    var self = this;
    var status = loop.status || loop.state || 'idle';

    var el = wk.card(loop, function () {
      var wrap = document.createElement('div');

      // Top row: name + badge
      var top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';
      var name = document.createElement('span');
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);';
      name.textContent = loop.name || loop.id || 'Unnamed Loop';
      top.appendChild(name);
      top.appendChild(wk.badge(status, statusVariant(status)));
      wrap.appendChild(top);

      // Live state indicator (Req 6.1) — shows current phase
      var stateIndicator = document.createElement('div');
      stateIndicator.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;gap:6px;';
      stateIndicator.setAttribute('data-loop-state-indicator', 'true');
      if (status === 'running' || status === 'active' || status === 'executing') {
        stateIndicator.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);animation:esb-pulse 1.5s ease-in-out infinite;"></span> Executing';
      } else if (status === 'planning') {
        stateIndicator.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);animation:esb-pulse 1.5s ease-in-out infinite;"></span> Planning';
      } else if (status === 'verifying') {
        stateIndicator.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--yellow);animation:esb-pulse 1.5s ease-in-out infinite;"></span> Verifying';
      }
      if (stateIndicator.innerHTML) {
        wrap.appendChild(stateIndicator);
      }

      // Meta
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;';
      var parts = [];
      if (loop.passCount != null) parts.push('Pass: ' + loop.passCount);
      if (loop.startedAt) parts.push('Started: ' + formatTime(loop.startedAt));
      meta.textContent = parts.join(' · ');
      wrap.appendChild(meta);

      // Action buttons container with data attribute for real-time updates (Req 6.3, 6.5)
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
      actions.setAttribute('data-loop-actions', 'true');

      // Pause/Resume/Cancel controls based on state (Req 6.3)
      if (status === 'running' || status === 'active' || status === 'executing' || status === 'verifying' || status === 'planning') {
        var pauseBtn = document.createElement('button');
        pauseBtn.className = 'wk-btn-secondary';
        pauseBtn.textContent = '⏸ Pause';
        pauseBtn.setAttribute('aria-label', 'Pause loop');
        pauseBtn.addEventListener('click', function () {
          asyncAction(pauseBtn, api().invoke('loops:stop', { loopId: loop.id }), 'Loop paused');
        });
        actions.appendChild(pauseBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'wk-btn-danger';
        cancelBtn.textContent = '✕ Cancel';
        cancelBtn.setAttribute('aria-label', 'Cancel loop');
        cancelBtn.addEventListener('click', function () {
          asyncAction(cancelBtn, api().invoke('loops:stop', { loopId: loop.id, cancel: true }), 'Loop cancelled')
            .then(function () { self.loadTab('loops'); }).catch(function () {});
        });
        actions.appendChild(cancelBtn);
      }

      if (status === 'idle' || status === 'completed' || status === 'failed') {
        var runBtn = document.createElement('button');
        runBtn.className = 'wk-btn-primary';
        runBtn.textContent = '▶ Run';
        runBtn.setAttribute('aria-label', 'Run loop');
        runBtn.addEventListener('click', function () {
          asyncAction(runBtn, api().invoke('loops:run', { loopId: loop.id }), 'Loop started')
            .then(function () { self.loadTab('loops'); }).catch(function () {});
        });
        actions.appendChild(runBtn);
      }

      if (status === 'paused' || status === 'blocked' || status === 'awaiting_approval') {
        var resumeBtn = document.createElement('button');
        resumeBtn.className = 'wk-btn-primary';
        resumeBtn.textContent = '▶ Resume';
        resumeBtn.setAttribute('aria-label', 'Resume loop');
        resumeBtn.addEventListener('click', function () {
          asyncAction(resumeBtn, api().invoke('loops:approve', { loopId: loop.id }), 'Loop resumed');
        });
        actions.appendChild(resumeBtn);

        var cancelBtn2 = document.createElement('button');
        cancelBtn2.className = 'wk-btn-danger';
        cancelBtn2.textContent = '✕ Cancel';
        cancelBtn2.setAttribute('aria-label', 'Cancel loop');
        cancelBtn2.addEventListener('click', function () {
          asyncAction(cancelBtn2, api().invoke('loops:stop', { loopId: loop.id, cancel: true }), 'Loop cancelled')
            .then(function () { self.loadTab('loops'); }).catch(function () {});
        });
        actions.appendChild(cancelBtn2);
      }

      // Receipt button — always available
      var receiptBtn = document.createElement('button');
      receiptBtn.className = 'wk-btn-secondary';
      receiptBtn.textContent = '📄 Receipt';
      receiptBtn.setAttribute('aria-label', 'View receipt');
      receiptBtn.addEventListener('click', function () {
        disableBtn(receiptBtn);
        api().invoke('loops:receipt', { loopId: loop.id }).then(function (r) {
          enableBtn(receiptBtn);
          if (r) {
            // Show receipt in-panel
            var existing = el.querySelector('.wk-data-view');
            if (existing) { existing.remove(); return; }
            wk.dataView(el, r);
          } else {
            wk.toast('No receipt available', 'info');
          }
        }).catch(function (err) {
          enableBtn(receiptBtn);
          wk.toast((err && err.message) || 'Failed to load receipt', 'error');
        });
      });
      actions.appendChild(receiptBtn);

      wrap.appendChild(actions);
      return wrap;
    });

    el.style.marginBottom = '8px';
    // Add data attribute for real-time event targeting (Req 6.2)
    el.setAttribute('data-loop-id', loop.id || '');
    return el;
  };

  // ─── Pipelines Tab ─────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.renderPipelinesTab = function () {
    var self = this;
    var fc = this.formContainer;
    var lc = this.listContainer;

    // Action bar
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var defBtn = document.createElement('button');
    defBtn.className = 'wk-btn-primary';
    defBtn.textContent = '+ Define Pipeline';
    defBtn.setAttribute('aria-label', 'Define a new pipeline');
    defBtn.addEventListener('click', function () {
      self.showPipelineForm();
    });
    bar.appendChild(defBtn);
    fc.appendChild(bar);

    // Load list
    var a = api();
    if (!a) { lc.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', '')); return; }

    a.invoke('pipeline:list', {}).then(function (result) {
      var pipelines = Array.isArray(result) ? result : (result && result.pipelines) || [];
      if (pipelines.length === 0) {
        lc.appendChild(wk.emptyState('⚙', 'No pipelines defined', 'Define one to orchestrate multi-step workflows.'));
        return;
      }
      for (var i = 0; i < pipelines.length; i++) {
        lc.appendChild(self.renderPipelineCard(pipelines[i]));
      }
    }).catch(function (err) {
      lc.appendChild(wk.emptyState('❌', 'Failed to load pipelines', (err && err.message) || ''));
    });
  };

  AutomationWorkspacePanel.prototype.showPipelineForm = function () {
    var self = this;
    var fc = this.formContainer;
    var existing = fc.querySelector('.wk-form');
    if (existing) { existing.remove(); return; }

    wk.form(fc, [
      { name: 'name', label: 'Pipeline Name', placeholder: 'e.g. Deploy Pipeline', required: true },
      { name: 'steps', label: 'Steps (one per line)', type: 'textarea', placeholder: 'lint\ntest\nbuild\ndeploy', rows: 5 },
    ], function (data) {
      var a = api(); if (!a) return;
      var payload = {
        projectId: projectId(),
        name: data.name,
        steps: data.steps ? data.steps.split('\n').filter(function (l) { return l.trim(); }) : [],
      };
      wk.toast('Defining pipeline...', 'info');
      a.invoke('pipeline:define', payload).then(function () {
        wk.toast('Pipeline defined', 'success');
        self.loadTab('pipelines');
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to define pipeline', 'error');
      });
    }, function () {});
  };

  AutomationWorkspacePanel.prototype.renderPipelineCard = function (p) {
    var self = this;
    var status = p.status || 'idle';

    var el = wk.card(p, function () {
      var wrap = document.createElement('div');

      var top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';
      var name = document.createElement('span');
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);';
      name.textContent = p.name || p.id || 'Unnamed Pipeline';
      top.appendChild(name);
      top.appendChild(wk.badge(status, statusVariant(status)));
      wrap.appendChild(top);

      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;';
      meta.textContent = (p.steps ? p.steps.length + ' steps' : '0 steps') + ' · ' + formatTime(p.updatedAt || p.createdAt);
      wrap.appendChild(meta);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;';

      if (status !== 'running') {
        var execBtn = document.createElement('button');
        execBtn.className = 'wk-btn-primary';
        execBtn.textContent = '▶ Execute';
        execBtn.setAttribute('aria-label', 'Execute pipeline');
        execBtn.addEventListener('click', function () {
          asyncAction(execBtn, api().invoke('pipeline:execute', { pipelineId: p.id }), 'Pipeline started')
            .then(function () { self.loadTab('pipelines'); }).catch(function () {});
        });
        actions.appendChild(execBtn);
      }

      if (status === 'running') {
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'wk-btn-danger';
        cancelBtn.textContent = '✕ Cancel';
        cancelBtn.setAttribute('aria-label', 'Cancel pipeline');
        cancelBtn.addEventListener('click', function () {
          asyncAction(cancelBtn, api().invoke('pipeline:cancel', { pipelineId: p.id }), 'Pipeline cancelled')
            .then(function () { self.loadTab('pipelines'); }).catch(function () {});
        });
        actions.appendChild(cancelBtn);
      }

      wrap.appendChild(actions);
      return wrap;
    });

    el.style.marginBottom = '8px';
    return el;
  };

  // ─── Scheduler Tab ─────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.renderSchedulerTab = function () {
    var self = this;
    var fc = this.formContainer;
    var lc = this.listContainer;

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var addBtn = document.createElement('button');
    addBtn.className = 'wk-btn-primary';
    addBtn.textContent = '+ Create Schedule';
    addBtn.setAttribute('aria-label', 'Create a new schedule');
    addBtn.addEventListener('click', function () {
      self.showSchedulerForm();
    });
    bar.appendChild(addBtn);
    fc.appendChild(bar);

    var a = api();
    if (!a) { lc.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', '')); return; }

    a.invoke('scheduler:list', {}).then(function (result) {
      var schedules = Array.isArray(result) ? result : (result && result.schedules) || [];
      if (schedules.length === 0) {
        lc.appendChild(wk.emptyState('⏰', 'No schedules', 'Create one to automate recurring tasks.'));
        return;
      }
      for (var i = 0; i < schedules.length; i++) {
        lc.appendChild(self.renderScheduleCard(schedules[i]));
      }
    }).catch(function (err) {
      lc.appendChild(wk.emptyState('❌', 'Failed to load schedules', (err && err.message) || ''));
    });
  };

  AutomationWorkspacePanel.prototype.showSchedulerForm = function () {
    var self = this;
    var fc = this.formContainer;
    var existing = fc.querySelector('.wk-form');
    if (existing) { existing.remove(); return; }

    wk.form(fc, [
      { name: 'name', label: 'Schedule Name', placeholder: 'e.g. Nightly Tests', required: true },
      { name: 'cron', label: 'Cron Expression', placeholder: '0 0 * * * (midnight daily)' },
      { name: 'task', label: 'Target Task', placeholder: 'npm run test', required: true },
    ], function (data) {
      var a = api(); if (!a) return;
      var payload = { projectId: projectId(), name: data.name, cron: data.cron, task: data.task };
      wk.toast('Creating schedule...', 'info');
      a.invoke('scheduler:add', payload).then(function () {
        wk.toast('Schedule created', 'success');
        self.loadTab('scheduler');
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to create schedule', 'error');
      });
    }, function () {});
  };

  AutomationWorkspacePanel.prototype.renderScheduleCard = function (s) {
    var self = this;
    var enabled = s.enabled !== false;

    var el = wk.card(s, function () {
      var wrap = document.createElement('div');

      var top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';
      var name = document.createElement('span');
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);';
      name.textContent = s.name || s.id || 'Unnamed Schedule';
      top.appendChild(name);

      var toggleEl = wk.toggle(enabled, function (newVal) {
        wk.toast(newVal ? 'Enabling...' : 'Disabling...', 'info');
        api().invoke('scheduler:toggle', { scheduleId: s.id, enabled: newVal }).then(function () {
          wk.toast(newVal ? 'Schedule enabled' : 'Schedule disabled', 'success');
          self.loadTab('scheduler');
        }).catch(function (err) {
          wk.toast((err && err.message) || 'Toggle failed', 'error');
          self.loadTab('scheduler');
        });
      });
      top.appendChild(toggleEl);
      wrap.appendChild(top);

      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-dim);';
      var parts = [];
      if (s.cron) parts.push(s.cron);
      if (s.nextRun) parts.push('Next: ' + formatTime(s.nextRun));
      if (s.task) parts.push('Task: ' + s.task);
      meta.textContent = parts.join(' · ');
      wrap.appendChild(meta);

      return wrap;
    });

    el.style.marginBottom = '8px';
    return el;
  };

  // ─── Missions Tab ──────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.renderMissionsTab = function () {
    var self = this;
    var fc = this.formContainer;
    var lc = this.listContainer;

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Mission';
    createBtn.setAttribute('aria-label', 'Create a new mission');
    createBtn.addEventListener('click', function () {
      self.showMissionForm();
    });
    bar.appendChild(createBtn);
    fc.appendChild(bar);

    var a = api();
    if (!a) { lc.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', '')); return; }

    a.invoke('missions:list', {}).then(function (result) {
      var missions = Array.isArray(result) ? result : (result && result.missions) || [];
      if (missions.length === 0) {
        lc.appendChild(wk.emptyState('🎯', 'No missions yet', 'Create a mission to coordinate goal-driven work.'));
        return;
      }
      for (var i = 0; i < missions.length; i++) {
        lc.appendChild(self.renderMissionCard(missions[i]));
      }
    }).catch(function (err) {
      lc.appendChild(wk.emptyState('❌', 'Failed to load missions', (err && err.message) || ''));
    });
  };

  AutomationWorkspacePanel.prototype.showMissionForm = function () {
    var self = this;
    var fc = this.formContainer;
    var existing = fc.querySelector('.wk-form');
    if (existing) { existing.remove(); return; }

    wk.form(fc, [
      { name: 'name', label: 'Mission Name', placeholder: 'e.g. Ship v2.0', required: true },
      { name: 'goal', label: 'Goal', type: 'textarea', placeholder: 'Describe the mission goal', required: true },
    ], function (data) {
      var a = api(); if (!a) return;
      var payload = { projectId: projectId(), name: data.name, goal: data.goal };
      wk.toast('Creating mission...', 'info');
      a.invoke('missions:create', payload).then(function () {
        wk.toast('Mission created', 'success');
        self.loadTab('missions');
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to create mission', 'error');
      });
    }, function () {});
  };

  AutomationWorkspacePanel.prototype.renderMissionCard = function (m) {
    var self = this;
    var status = m.status || 'pending';
    var progressVal = m.progress != null ? Math.round(m.progress * 100) : 0;

    var el = wk.card(m, function () {
      var wrap = document.createElement('div');

      var top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';
      var name = document.createElement('span');
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);';
      name.textContent = m.name || m.id || 'Unnamed Mission';
      top.appendChild(name);
      top.appendChild(wk.badge(status, statusVariant(status)));
      wrap.appendChild(top);

      // Progress bar
      var progWrap = document.createElement('div');
      progWrap.style.cssText = 'margin-bottom:6px;';
      progWrap.appendChild(wk.progress(progressVal, 100));
      var progLabel = document.createElement('div');
      progLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
      progLabel.textContent = progressVal + '% complete';
      progWrap.appendChild(progLabel);
      wrap.appendChild(progWrap);

      // Stats button
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;';
      var statsBtn = document.createElement('button');
      statsBtn.className = 'wk-btn-secondary';
      statsBtn.textContent = '📊 Stats';
      statsBtn.setAttribute('aria-label', 'View mission stats');
      statsBtn.addEventListener('click', function () {
        disableBtn(statsBtn);
        api().invoke('missions:stats', { missionId: m.id }).then(function (stats) {
          enableBtn(statsBtn);
          if (stats) {
            var existing = el.querySelector('.wk-data-view');
            if (existing) { existing.remove(); return; }
            wk.dataView(el, stats);
          } else {
            wk.toast('No stats available', 'info');
          }
        }).catch(function (err) {
          enableBtn(statsBtn);
          wk.toast((err && err.message) || 'Failed to load stats', 'error');
        });
      });
      actions.appendChild(statsBtn);
      wrap.appendChild(actions);

      return wrap;
    });

    el.style.marginBottom = '8px';
    return el;
  };

  // ─── PCV Tab ───────────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.renderPCVTab = function () {
    var self = this;
    var fc = this.formContainer;
    var lc = this.listContainer;

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ New PCV Run';
    createBtn.setAttribute('aria-label', 'Start a new PCV run');
    createBtn.addEventListener('click', function () {
      self.showPCVForm();
    });
    bar.appendChild(createBtn);
    fc.appendChild(bar);

    var a = api();
    if (!a) { lc.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', '')); return; }

    a.invoke('pcv:list', {}).then(function (result) {
      var runs = Array.isArray(result) ? result : (result && result.runs) || [];
      if (runs.length === 0) {
        lc.appendChild(wk.emptyState('✅', 'No PCV runs', 'Start a Plan-Code-Verify cycle.'));
        return;
      }
      for (var i = 0; i < runs.length; i++) {
        lc.appendChild(self.renderPCVCard(runs[i]));
      }
    }).catch(function (err) {
      lc.appendChild(wk.emptyState('❌', 'Failed to load PCV runs', (err && err.message) || ''));
    });
  };

  AutomationWorkspacePanel.prototype.showPCVForm = function () {
    var self = this;
    var fc = this.formContainer;
    var existing = fc.querySelector('.wk-form');
    if (existing) { existing.remove(); return; }

    wk.form(fc, [
      { name: 'task', label: 'Task Description', type: 'textarea', placeholder: 'Describe what should be planned, coded, and verified', required: true },
    ], function (data) {
      var a = api(); if (!a) return;
      wk.toast('Creating PCV run...', 'info');
      a.invoke('pcv:create', { projectId: projectId(), task: data.task }).then(function () {
        wk.toast('PCV run created', 'success');
        self.loadTab('pcv');
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to create PCV run', 'error');
      });
    }, function () {});
  };

  AutomationWorkspacePanel.prototype.renderPCVCard = function (run) {
    var self = this;
    var status = run.status || 'pending';
    var completed = run.completedSteps || 0;
    var total = run.totalSteps || 0;

    var el = wk.card(run, function () {
      var wrap = document.createElement('div');

      var top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';
      var name = document.createElement('span');
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);';
      name.textContent = run.name || run.task || run.id || 'PCV Run';
      top.appendChild(name);
      top.appendChild(wk.badge(status, statusVariant(status)));
      wrap.appendChild(top);

      // Steps progress
      if (total > 0) {
        var progWrap = document.createElement('div');
        progWrap.style.cssText = 'margin-bottom:6px;';
        progWrap.appendChild(wk.progress(completed, total));
        var progLabel = document.createElement('div');
        progLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
        progLabel.textContent = 'Steps: ' + completed + '/' + total;
        progWrap.appendChild(progLabel);
        wrap.appendChild(progWrap);
      }

      // Step action buttons
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

      if (status === 'running' || status === 'active' || status === 'pending') {
        var completeBtn = document.createElement('button');
        completeBtn.className = 'wk-btn-primary';
        completeBtn.textContent = '✓ Complete Step';
        completeBtn.setAttribute('aria-label', 'Complete current step');
        completeBtn.addEventListener('click', function () {
          asyncAction(completeBtn, api().invoke('pcv:complete-step', { runId: run.id }), 'Step completed')
            .then(function () { self.loadTab('pcv'); }).catch(function () {});
        });
        actions.appendChild(completeBtn);

        var skipBtn = document.createElement('button');
        skipBtn.className = 'wk-btn-secondary';
        skipBtn.textContent = '⏭ Skip';
        skipBtn.setAttribute('aria-label', 'Skip current step');
        skipBtn.addEventListener('click', function () {
          asyncAction(skipBtn, api().invoke('pcv:skip-step', { runId: run.id }), 'Step skipped')
            .then(function () { self.loadTab('pcv'); }).catch(function () {});
        });
        actions.appendChild(skipBtn);

        var failBtn = document.createElement('button');
        failBtn.className = 'wk-btn-danger';
        failBtn.textContent = '✕ Fail';
        failBtn.setAttribute('aria-label', 'Fail current step');
        failBtn.addEventListener('click', function () {
          asyncAction(failBtn, api().invoke('pcv:fail-step', { runId: run.id }), 'Step failed')
            .then(function () { self.loadTab('pcv'); }).catch(function () {});
        });
        actions.appendChild(failBtn);
      }

      wrap.appendChild(actions);
      return wrap;
    });

    el.style.marginBottom = '8px';
    return el;
  };

  // ─── Headless Tab ──────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.renderHeadlessTab = function () {
    var self = this;
    var fc = this.formContainer;
    var lc = this.listContainer;

    var a = api();
    if (!a) { lc.appendChild(wk.emptyState('⚠️', 'IPC Unavailable', '')); return; }

    // Start button at top
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var startBtn = document.createElement('button');
    startBtn.className = 'wk-btn-primary';
    startBtn.textContent = '▶ Start Headless Execution';
    startBtn.setAttribute('aria-label', 'Start headless execution');
    startBtn.addEventListener('click', function () {
      asyncAction(startBtn, a.invoke('exec:start', { projectId: projectId() }), 'Headless execution started')
        .then(function () { self.loadTab('headless'); }).catch(function () {});
    });
    bar.appendChild(startBtn);
    fc.appendChild(bar);

    // Load config + stats
    Promise.all([
      a.invoke('exec:get-config', {}),
      a.invoke('exec:stats', {}),
    ]).then(function (results) {
      var config = results[0] || {};
      var stats = results[1] || {};

      // Config card (editable)
      var configCard = wk.card(config, function (cfg) {
        var wrap = document.createElement('div');
        var heading = document.createElement('div');
        heading.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
        heading.textContent = 'Configuration';
        wrap.appendChild(heading);

        var fields = document.createElement('div');
        fields.style.cssText = 'font-size:11px;color:var(--text-secondary);display:flex;flex-wrap:wrap;gap:12px;';
        fields.innerHTML =
          '<span>Mode: <strong>' + (cfg.mode || 'standard') + '</strong></span>' +
          '<span>Timeout: <strong>' + (cfg.timeout || 300) + 's</strong></span>' +
          '<span>Auto-approve: <strong>' + (cfg.autoApprove ? 'Yes' : 'No') + '</strong></span>';
        wrap.appendChild(fields);

        // Edit config button
        var editBtn = document.createElement('button');
        editBtn.className = 'wk-btn-secondary';
        editBtn.style.marginTop = '8px';
        editBtn.textContent = '✏️ Edit Config';
        editBtn.setAttribute('aria-label', 'Edit configuration');
        editBtn.addEventListener('click', function () {
          self.showHeadlessConfigForm(cfg);
        });
        wrap.appendChild(editBtn);
        return wrap;
      });
      configCard.style.marginBottom = '12px';
      lc.appendChild(configCard);

      // Stats gauge cards
      var statsContainer = document.createElement('div');
      statsContainer.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px;';

      var statItems = [
        { label: 'Total Runs', value: stats.totalRuns || 0 },
        { label: 'Completed', value: stats.completed || 0 },
        { label: 'Failed', value: stats.failed || 0 },
        { label: 'Avg Duration', value: (stats.avgDuration || 0) + 's' },
      ];

      for (var i = 0; i < statItems.length; i++) {
        var si = statItems[i];
        var statCard = wk.card(si, function (item) {
          var wrap = document.createElement('div');
          wrap.style.cssText = 'text-align:center;';
          var val = document.createElement('div');
          val.style.cssText = 'font-size:20px;font-weight:700;color:var(--text-primary);';
          val.textContent = String(item.value);
          wrap.appendChild(val);
          var lbl = document.createElement('div');
          lbl.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
          lbl.textContent = item.label;
          wrap.appendChild(lbl);
          return wrap;
        });
        statsContainer.appendChild(statCard);
      }
      lc.appendChild(statsContainer);
    }).catch(function (err) {
      lc.appendChild(wk.emptyState('❌', 'Failed to load headless config', (err && err.message) || ''));
    });
  };

  AutomationWorkspacePanel.prototype.showHeadlessConfigForm = function (currentConfig) {
    var self = this;
    var fc = this.formContainer;
    var existing = fc.querySelector('.wk-form');
    if (existing) { existing.remove(); return; }

    wk.form(fc, [
      { name: 'mode', label: 'Mode', placeholder: 'standard', value: currentConfig.mode || 'standard' },
      { name: 'timeout', label: 'Timeout (seconds)', placeholder: '300', value: String(currentConfig.timeout || 300) },
      { name: 'autoApprove', label: 'Auto-approve', type: 'select', options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ], value: currentConfig.autoApprove ? 'true' : 'false' },
    ], function (data) {
      var a = api(); if (!a) return;
      var payload = {
        mode: data.mode,
        timeout: parseInt(data.timeout, 10) || 300,
        autoApprove: data.autoApprove === 'true',
      };
      wk.toast('Updating config...', 'info');
      a.invoke('exec:update-config', payload).then(function () {
        wk.toast('Configuration updated', 'success');
        self.loadTab('headless');
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to update config', 'error');
      });
    }, function () {});
  };

  // ─── Cleanup ───────────────────────────────────────────────────────

  AutomationWorkspacePanel.prototype.destroy = function () {
    this._cleanupLoopEvents();
    this._cleanupPlanEvents();
    if (this.container) this.container.innerHTML = '';
  };

  // ─── Export ────────────────────────────────────────────────────────

  window.AutomationWorkspacePanel = AutomationWorkspacePanel;

})();
