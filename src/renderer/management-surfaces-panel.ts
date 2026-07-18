// @ts-nocheck
/**
 * ManagementSurfacesPanel — Full-featured management workspace.
 *
 * Tabs: Memory, Steering, Hooks, Backends, Sharing, Specs, Wiki, Workspaces, Tasks, Checkpoints
 *
 * Uses window.wk namespace utilities (toast, form, card, emptyState, badge, progress, toggle, confirm, dataView, copyButton).
 * IPC calls use window.electronAPI.invoke(channel, args).
 * All buttons disabled during async ops. All actions show toast feedback. No alert() calls.
 * All tabs follow pattern: top action button(s), form slides down on click, list as themed cards with actions, empty state centered.
 */

(function () {
  'use strict';

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
    { id: 'background-tasks', label: 'Bg Tasks', icon: '\u2699' },
  ];

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }
  function projectId() { return window._neuronestActiveProject || 'default'; }

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function relTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  // ─── Panel Class ─────────────────────────────────────────────────

  function ManagementSurfacesPanel(container, options) {
    this.container = container;
    this.activeTab = 'memory';
    this.tabContent = null;
    this.formContainer = null;
  }

  ManagementSurfacesPanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'wk-scroll';
    this.container.style.cssText = 'padding:16px;height:100%;overflow-y:auto;';

    // Header
    var header = document.createElement('h3');
    header.style.cssText = 'margin:0 0 12px;font-size:16px;color:var(--text-primary);';
    header.textContent = 'Management';
    this.container.appendChild(header);

    // Tab bar
    var tabBar = document.createElement('div');
    tabBar.className = 'wk-tabs';
    for (var i = 0; i < MS_TABS.length; i++) {
      (function (tab) {
        var btn = document.createElement('button');
        btn.className = 'wk-tab' + (tab.id === self.activeTab ? ' active' : '');
        btn.textContent = tab.icon + ' ' + tab.label;
        btn.setAttribute('aria-label', tab.label + ' tab');
        btn.setAttribute('role', 'tab');
        btn.addEventListener('click', function () {
          self.activeTab = tab.id;
          self.render();
        });
        tabBar.appendChild(btn);
      })(MS_TABS[i]);
    }
    this.container.appendChild(tabBar);

    // Form container (slides down when action buttons clicked)
    this.formContainer = document.createElement('div');
    this.container.appendChild(this.formContainer);

    // Tab content area
    this.tabContent = document.createElement('div');
    this.tabContent.style.cssText = 'min-height:200px;';
    this.container.appendChild(this.tabContent);

    this.loadTab(this.activeTab);
  };

  ManagementSurfacesPanel.prototype.loadTab = function (id) {
    this.formContainer.innerHTML = '';
    switch (id) {
      case 'memory': this.renderMemory(); break;
      case 'steering': this.renderSteering(); break;
      case 'hooks': this.renderHooks(); break;
      case 'backends': this.renderBackends(); break;
      case 'sharing': this.renderSharing(); break;
      case 'specs': this.renderSpecs(); break;
      case 'wiki': this.renderWiki(); break;
      case 'workspaces': this.renderWorkspaces(); break;
      case 'tasks': this.renderTasks(); break;
      case 'checkpoints': this.renderCheckpoints(); break;
      case 'background-tasks': this.renderBackgroundTasks(); break;
    }
  };

  // ─── Memory Tab ──────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderMemory = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var learnBtn = document.createElement('button');
    learnBtn.className = 'wk-btn-primary';
    learnBtn.textContent = '+ Learn';
    learnBtn.setAttribute('aria-label', 'Learn new memory');
    learnBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'content', label: 'Content', type: 'textarea', placeholder: 'What should I remember?', required: true },
        { name: 'category', label: 'Category', type: 'select', options: ['pattern', 'preference', 'fact', 'convention', 'architecture'] }
      ], function (data) {
        disableBtn(learnBtn);
        api().invoke('memory:learn', { projectId: projectId(), content: data.content, category: data.category, source: 'user' }).then(function () {
          wk.toast('Memory saved', 'success');
          self.formContainer.innerHTML = '';
          self.renderMemory();
        }).catch(function (e) {
          wk.toast('Failed to save: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(learnBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(learnBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    api().invoke('memory:get', { projectId: projectId(), limit: 50 }).then(function (r) {
      listEl.innerHTML = '';
      var memories = (r && r.memories) || [];
      if (memories.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83E\uDDE0', 'No memories stored', 'Click Learn to teach me something.'));
        return;
      }
      for (var i = 0; i < memories.length; i++) {
        (function (m) {
          var cardEl = wk.card(m, function () {
            var wrap = document.createElement('div');
            // Header row
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;';
            var title = document.createElement('span');
            title.style.cssText = 'color:var(--text-primary);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            title.textContent = m.content ? m.content.slice(0, 60) : '(empty)';
            hdr.appendChild(title);
            var catBadge = wk.badge(m.category || m.source || 'auto', 'info');
            hdr.appendChild(catBadge);
            wrap.appendChild(hdr);

            // Confidence mini-bar
            var confidence = m.confidence != null ? m.confidence : 0.8;
            var progEl = wk.progress(confidence * 100, 100);
            progEl.style.marginTop = '6px';
            wrap.appendChild(progEl);

            // Expandable content (hidden by default)
            var detail = document.createElement('div');
            detail.style.cssText = 'display:none;margin-top:8px;font-size:11px;color:var(--text-secondary);line-height:1.5;';
            detail.textContent = m.content || '';
            wrap.appendChild(detail);

            // Click to expand
            hdr.addEventListener('click', function () {
              detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
            });

            // Action row
            var actionRow = document.createElement('div');
            actionRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
            var reinforceBtn = document.createElement('button');
            reinforceBtn.className = 'wk-btn-secondary';
            reinforceBtn.textContent = '\u2B06 Reinforce';
            reinforceBtn.setAttribute('aria-label', 'Reinforce memory');
            reinforceBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              disableBtn(reinforceBtn);
              api().invoke('memory:reinforce', { projectId: projectId(), id: m.id }).then(function () {
                wk.toast('Memory reinforced', 'success');
              }).catch(function () { wk.toast('Failed to reinforce', 'error'); }).finally(function () { enableBtn(reinforceBtn); });
            });
            actionRow.appendChild(reinforceBtn);

            var forgetBtn = document.createElement('button');
            forgetBtn.className = 'wk-btn-danger';
            forgetBtn.textContent = '\u2717 Forget';
            forgetBtn.setAttribute('aria-label', 'Forget memory');
            forgetBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              disableBtn(forgetBtn);
              api().invoke('memory:forget', { projectId: projectId(), id: m.id }).then(function () {
                wk.toast('Memory forgotten', 'success');
                self.renderMemory();
              }).catch(function () { wk.toast('Failed to forget', 'error'); }).finally(function () { enableBtn(forgetBtn); });
            });
            actionRow.appendChild(forgetBtn);
            wrap.appendChild(actionRow);

            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(memories[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load memories', 'Check your connection and try again.'));
    });
  };

  // ─── Steering Tab ────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderSteering = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Rule';
    createBtn.setAttribute('aria-label', 'Create steering rule');
    createBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'name', label: 'Name', type: 'text', placeholder: 'Rule name', required: true },
        { name: 'content', label: 'Content', type: 'textarea', placeholder: 'Rule content / instructions', required: true },
        { name: 'inclusion', label: 'Inclusion Mode', type: 'select', options: ['always', 'manual', 'auto'] },
        { name: 'fileMatch', label: 'File Match', type: 'text', placeholder: 'e.g. **/*.ts (optional)' }
      ], function (data) {
        disableBtn(createBtn);
        api().invoke('steering:create', { projectId: projectId(), name: data.name, content: data.content, inclusion: data.inclusion, fileMatch: data.fileMatch }).then(function () {
          wk.toast('Steering rule created', 'success');
          self.formContainer.innerHTML = '';
          self.renderSteering();
        }).catch(function (e) {
          wk.toast('Failed to create: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(createBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    api().invoke('steering:list', {}).then(function (r) {
      listEl.innerHTML = '';
      var items = Array.isArray(r) ? r : (r && r.items) || [];
      if (items.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83C\uDFAF', 'No steering rules', 'Create rules to guide agent behavior.'));
        return;
      }
      for (var i = 0; i < items.length; i++) {
        (function (s) {
          var cardEl = wk.card(s, function () {
            var wrap = document.createElement('div');
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var name = document.createElement('span');
            name.style.cssText = 'color:var(--text-primary);font-weight:600;font-size:12px;';
            name.textContent = s.name || s.id || 'Rule';
            hdr.appendChild(name);
            hdr.appendChild(wk.badge(s.inclusion || 'always', 'success'));
            wrap.appendChild(hdr);

            // Content preview
            var preview = document.createElement('div');
            preview.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            preview.textContent = (s.content || '').slice(0, 100);
            wrap.appendChild(preview);

            if (s.fileMatch) {
              var fm = document.createElement('div');
              fm.style.cssText = 'margin-top:4px;font-size:10px;color:var(--text-dim);font-family:monospace;';
              fm.textContent = 'Match: ' + s.fileMatch;
              wrap.appendChild(fm);
            }

            // Actions
            var actionRow = document.createElement('div');
            actionRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

            var editBtn = document.createElement('button');
            editBtn.className = 'wk-btn-secondary';
            editBtn.textContent = 'Edit';
            editBtn.setAttribute('aria-label', 'Edit rule');
            editBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              self.formContainer.innerHTML = '';
              wk.form(self.formContainer, [
                { name: 'name', label: 'Name', type: 'text', value: s.name || '' },
                { name: 'content', label: 'Content', type: 'textarea', value: s.content || '' },
                { name: 'inclusion', label: 'Inclusion Mode', type: 'select', options: ['always', 'manual', 'auto'], value: s.inclusion },
                { name: 'fileMatch', label: 'File Match', type: 'text', value: s.fileMatch || '' }
              ], function (data) {
                disableBtn(editBtn);
                api().invoke('steering:edit', { id: s.id, name: data.name, content: data.content, inclusion: data.inclusion, fileMatch: data.fileMatch }).then(function () {
                  wk.toast('Rule updated', 'success');
                  self.formContainer.innerHTML = '';
                  self.renderSteering();
                }).catch(function (e) { wk.toast('Failed: ' + (e.message || e), 'error'); }).finally(function () { enableBtn(editBtn); });
              }, function () { self.formContainer.innerHTML = ''; });
            });
            actionRow.appendChild(editBtn);

            var delBtn = document.createElement('button');
            delBtn.className = 'wk-btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.setAttribute('aria-label', 'Delete rule');
            delBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              var confirmEl = wk.confirm('Delete rule "' + (s.name || s.id) + '"?', function () {
                disableBtn(delBtn);
                api().invoke('steering:delete', { id: s.id }).then(function () {
                  wk.toast('Rule deleted', 'success');
                  self.renderSteering();
                }).catch(function (e) { wk.toast('Failed: ' + (e.message || e), 'error'); }).finally(function () { enableBtn(delBtn); });
              });
              cardEl.appendChild(confirmEl);
            });
            actionRow.appendChild(delBtn);
            wrap.appendChild(actionRow);
            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(items[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load', 'Check connection and retry.'));
    });
  };

  // ─── Hooks Tab ───────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderHooks = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Hook';
    createBtn.setAttribute('aria-label', 'Create hook');
    createBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'name', label: 'Name', type: 'text', placeholder: 'Hook name', required: true },
        { name: 'event', label: 'Event', type: 'select', options: ['PreToolUse', 'PostToolUse', 'PreMessage', 'PostMessage', 'OnError', 'OnComplete'] },
        { name: 'type', label: 'Type', type: 'select', options: ['command', 'script', 'function'] },
        { name: 'command', label: 'Command', type: 'text', placeholder: 'e.g. npm run lint', required: true }
      ], function (data) {
        disableBtn(createBtn);
        api().invoke('hooks:create', { name: data.name, event: data.event, type: data.type, command: data.command }).then(function () {
          wk.toast('Hook created', 'success');
          self.formContainer.innerHTML = '';
          self.renderHooks();
        }).catch(function (e) {
          wk.toast('Failed: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(createBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    api().invoke('hooks:list', {}).then(function (r) {
      listEl.innerHTML = '';
      var hooks = Array.isArray(r) ? r : (r && r.hooks) || [];
      if (hooks.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83D\uDD17', 'No hooks configured', 'Create hooks to run actions on events.'));
        return;
      }
      for (var i = 0; i < hooks.length; i++) {
        (function (h) {
          var cardEl = wk.card(h, function () {
            var wrap = document.createElement('div');
            // Header
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'color:var(--text-primary);font-weight:600;font-size:12px;';
            nameSpan.textContent = h.name || h.id;
            hdr.appendChild(nameSpan);
            var badges = document.createElement('span');
            badges.style.cssText = 'display:flex;gap:4px;align-items:center;';
            badges.appendChild(wk.badge(h.enabled !== false ? 'enabled' : 'disabled', h.enabled !== false ? 'success' : 'warning'));
            if (h.lastRun) {
              badges.appendChild(wk.badge('Last: ' + relTime(h.lastRun), 'info'));
            }
            hdr.appendChild(badges);
            wrap.appendChild(hdr);

            // Info
            var info = document.createElement('div');
            info.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-dim);';
            info.textContent = 'Event: ' + (h.event || h.trigger || '-') + ' | Type: ' + (h.type || 'command');
            wrap.appendChild(info);

            // Toggle enable/disable
            var toggleRow = document.createElement('div');
            toggleRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;';
            var toggleLabel = document.createElement('span');
            toggleLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);';
            toggleLabel.textContent = 'Enabled';
            toggleRow.appendChild(toggleLabel);
            var toggleEl = wk.toggle(h.enabled !== false, function (val) {
              api().invoke('hooks:toggle', { id: h.id, enabled: val }).then(function () {
                wk.toast(val ? 'Hook enabled' : 'Hook disabled', 'success');
              }).catch(function () { wk.toast('Failed to toggle', 'error'); });
            });
            toggleRow.appendChild(toggleEl);
            wrap.appendChild(toggleRow);

            // ── Action buttons: Test Run ──
            var hookActions = document.createElement('div');
            hookActions.style.cssText = 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;';

            var testRunBtn = document.createElement('button');
            testRunBtn.className = 'wk-btn-secondary';
            testRunBtn.textContent = '\u25B6 Test Run';
            testRunBtn.setAttribute('aria-label', 'Test run hook with sample payload');
            hookActions.appendChild(testRunBtn);
            wrap.appendChild(hookActions);

            // ── Test Run form area ──
            var testRunArea = document.createElement('div');
            testRunArea.style.cssText = 'margin-top:8px;';
            wrap.appendChild(testRunArea);

            testRunBtn.addEventListener('click', function () {
              if (testRunArea.querySelector('.wk-form')) {
                testRunArea.innerHTML = '';
                return;
              }
              testRunArea.innerHTML = '';
              wk.form(testRunArea, [
                { name: 'payload', label: 'Sample Event Payload (JSON)', type: 'textarea', placeholder: '{\n  "event": "PreToolUse",\n  "tool": "shell",\n  "args": { "command": "rm -rf /" }\n}', rows: 5 }
              ], function (data) {
                var payloadStr = (data.payload || '').trim();
                var payload = {};
                if (payloadStr) {
                  try {
                    payload = JSON.parse(payloadStr);
                  } catch (parseErr) {
                    wk.toast('Invalid JSON payload: ' + parseErr.message, 'error');
                    return;
                  }
                }
                disableBtn(testRunBtn);
                api().invoke('hooks:test-run', { id: h.id, hookId: h.id, payload: payload }).then(function (result) {
                  wk.toast('Test run completed', 'success');
                  testRunArea.innerHTML = '';
                  // Display test run result inline
                  var resultEl = self.buildHookLogEntry(result || { verdict: 'allow', event: 'test-run', duration: 0 });
                  testRunArea.appendChild(resultEl);
                }).catch(function (e) {
                  wk.toast('Test run failed: ' + (e.message || e), 'error');
                }).finally(function () { enableBtn(testRunBtn); });
              }, function () { testRunArea.innerHTML = ''; });
            });

            // ── Execution Log section ──
            var logSection = document.createElement('div');
            logSection.style.cssText = 'margin-top:12px;border-top:1px solid var(--border-color);padding-top:10px;';
            var logHeader = document.createElement('div');
            logHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;';
            var logTitle = document.createElement('span');
            logTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;';
            logTitle.textContent = 'Execution Log';
            logHeader.appendChild(logTitle);
            var logToggleIcon = document.createElement('span');
            logToggleIcon.style.cssText = 'font-size:10px;color:var(--text-dim);transition:transform var(--motion-quick);';
            logToggleIcon.textContent = '\u25BC';
            logHeader.appendChild(logToggleIcon);
            logSection.appendChild(logHeader);

            var logContent = document.createElement('div');
            logContent.style.cssText = 'display:none;margin-top:8px;max-height:250px;overflow-y:auto;';
            logContent.className = 'wk-scroll';
            logSection.appendChild(logContent);

            var logLoaded = false;
            logHeader.addEventListener('click', function () {
              var isHidden = logContent.style.display === 'none';
              logContent.style.display = isHidden ? 'block' : 'none';
              logToggleIcon.style.transform = isHidden ? 'rotate(180deg)' : '';
              // Lazy-load execution log on first expand
              if (isHidden && !logLoaded) {
                logLoaded = true;
                logContent.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px 0;">Loading log...</div>';
                api().invoke('hooks:get-execution-log', { id: h.id, hookId: h.id }).then(function (logResult) {
                  logContent.innerHTML = '';
                  var entries = Array.isArray(logResult) ? logResult : (logResult && logResult.entries) || [];
                  if (entries.length === 0) {
                    var emptyLog = document.createElement('div');
                    emptyLog.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 0;text-align:center;';
                    emptyLog.textContent = 'No executions recorded yet.';
                    logContent.appendChild(emptyLog);
                    return;
                  }
                  for (var li = 0; li < entries.length; li++) {
                    logContent.appendChild(self.buildHookLogEntry(entries[li]));
                  }
                }).catch(function () {
                  logContent.innerHTML = '<div style="font-size:11px;color:var(--red);padding:8px 0;">Failed to load execution log.</div>';
                });
              }
            });

            wrap.appendChild(logSection);

            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(hooks[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load hooks', ''));
    });
  };

  // ─── Hook Execution Log Entry Builder ──────────────────────────────

  ManagementSurfacesPanel.prototype.buildHookLogEntry = function (entry) {
    var wk = window.wk;
    var entryEl = document.createElement('div');
    var isError = entry.error || entry.verdict === 'error';
    entryEl.style.cssText = 'padding:8px 10px;border-radius:var(--radius-xs);margin-bottom:6px;font-size:11px;' +
      (isError ? 'background:var(--red-container);border:1px solid var(--red);' : 'background:var(--surface-container);border:1px solid var(--border-color);');

    // Row 1: event trigger + verdict badge + duration
    var row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';

    var eventSpan = document.createElement('span');
    eventSpan.style.cssText = 'color:var(--text-primary);font-weight:500;';
    eventSpan.textContent = entry.event || entry.trigger || entry.eventType || 'unknown';
    row1.appendChild(eventSpan);

    var rightInfo = document.createElement('span');
    rightInfo.style.cssText = 'display:flex;gap:6px;align-items:center;';

    // Verdict badge
    var verdict = entry.verdict || entry.result || 'allow';
    var verdictVariant = 'success';
    if (verdict === 'deny' || verdict === 'denied' || verdict === 'blocked') verdictVariant = 'error';
    else if (verdict === 'timeout') verdictVariant = 'warning';
    else if (verdict === 'error') verdictVariant = 'error';
    rightInfo.appendChild(wk.badge(verdict, verdictVariant));

    // Duration
    if (entry.duration != null) {
      var durSpan = document.createElement('span');
      durSpan.style.cssText = 'color:var(--text-dim);font-size:10px;';
      durSpan.textContent = entry.duration + 'ms';
      rightInfo.appendChild(durSpan);
    }

    row1.appendChild(rightInfo);
    entryEl.appendChild(row1);

    // Row 2: PreToolUse denial details (blocked tool name + reason)
    if ((verdict === 'deny' || verdict === 'denied' || verdict === 'blocked') && (entry.toolName || entry.blockedTool || entry.reason || entry.denialReason)) {
      var denialRow = document.createElement('div');
      denialRow.style.cssText = 'margin-top:4px;font-size:10px;color:var(--red);';
      var denialText = '';
      if (entry.toolName || entry.blockedTool) {
        denialText += 'Blocked tool: ' + escHtml(entry.toolName || entry.blockedTool);
      }
      if (entry.reason || entry.denialReason) {
        if (denialText) denialText += ' \u2014 ';
        denialText += 'Reason: ' + escHtml(entry.reason || entry.denialReason);
      }
      denialRow.innerHTML = denialText;
      entryEl.appendChild(denialRow);
    }

    // Row 3: Timestamp
    if (entry.timestamp || entry.time) {
      var timeRow = document.createElement('div');
      timeRow.style.cssText = 'margin-top:3px;font-size:10px;color:var(--text-dim);';
      timeRow.textContent = relTime(entry.timestamp || entry.time);
      entryEl.appendChild(timeRow);
    }

    // Row 4: Expandable output
    if (entry.output || entry.stdout || entry.stderr) {
      var outputToggle = document.createElement('button');
      outputToggle.style.cssText = 'margin-top:4px;background:none;border:none;color:var(--accent);font-size:10px;cursor:pointer;padding:0;font-family:inherit;';
      outputToggle.textContent = '\u25B6 Show output';
      outputToggle.setAttribute('aria-label', 'Toggle execution output');
      entryEl.appendChild(outputToggle);

      var outputBlock = document.createElement('pre');
      outputBlock.style.cssText = 'display:none;margin-top:4px;padding:6px 8px;background:var(--surface-container-high);border-radius:var(--radius-xs);font-size:10px;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;';
      outputBlock.textContent = entry.output || entry.stdout || '';
      if (entry.stderr) {
        outputBlock.textContent += (outputBlock.textContent ? '\n' : '') + entry.stderr;
      }
      entryEl.appendChild(outputBlock);

      outputToggle.addEventListener('click', function () {
        var hidden = outputBlock.style.display === 'none';
        outputBlock.style.display = hidden ? 'block' : 'none';
        outputToggle.textContent = hidden ? '\u25BC Hide output' : '\u25B6 Show output';
      });
    }

    // Row 5: Error with stack trace (highlighted in red)
    if (entry.error || entry.stackTrace || entry.stack) {
      var errorBlock = document.createElement('div');
      errorBlock.style.cssText = 'margin-top:6px;';

      var errorMsg = document.createElement('div');
      errorMsg.style.cssText = 'color:var(--red);font-size:11px;font-weight:600;';
      errorMsg.setAttribute('role', 'alert');
      errorMsg.textContent = '\u26A0 ' + (typeof entry.error === 'string' ? entry.error : (entry.error && entry.error.message) || 'Execution error');
      errorBlock.appendChild(errorMsg);

      var stackContent = entry.stackTrace || entry.stack || (entry.error && entry.error.stack) || '';
      if (stackContent) {
        var stackToggle = document.createElement('button');
        stackToggle.style.cssText = 'margin-top:4px;background:none;border:none;color:var(--red);font-size:10px;cursor:pointer;padding:0;font-family:inherit;text-decoration:underline;';
        stackToggle.textContent = 'Show stack trace';
        stackToggle.setAttribute('aria-label', 'Toggle error stack trace');
        errorBlock.appendChild(stackToggle);

        var stackPre = document.createElement('pre');
        stackPre.style.cssText = 'display:none;margin-top:4px;padding:8px;background:rgba(248,113,113,0.1);border:1px solid var(--red);border-radius:var(--radius-xs);font-size:10px;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;max-height:150px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;';
        stackPre.textContent = stackContent;
        stackPre.setAttribute('aria-label', 'Error stack trace');
        errorBlock.appendChild(stackPre);

        stackToggle.addEventListener('click', function () {
          var hidden = stackPre.style.display === 'none';
          stackPre.style.display = hidden ? 'block' : 'none';
          stackToggle.textContent = hidden ? 'Hide stack trace' : 'Show stack trace';
        });
      }

      entryEl.appendChild(errorBlock);
    }

    return entryEl;
  };

  // ─── Backends Tab ────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderBackends = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // ── Sandbox Policy Section ───────────────────────────────────────
    var sandboxSection = document.createElement('div');
    sandboxSection.style.cssText = 'margin-bottom:20px;border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:14px 16px;background:var(--surface-container);';
    el.appendChild(sandboxSection);

    var sandboxHeader = document.createElement('div');
    sandboxHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
    var sandboxTitle = document.createElement('span');
    sandboxTitle.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);';
    sandboxTitle.textContent = '\uD83D\uDD12 Sandbox Policy';
    sandboxHeader.appendChild(sandboxTitle);
    var sandboxProfileBadge = document.createElement('span');
    sandboxProfileBadge.style.cssText = 'display:inline-block;';
    sandboxHeader.appendChild(sandboxProfileBadge);
    sandboxSection.appendChild(sandboxHeader);

    // Profile badge + denial log + policy viewer load async
    var sandboxBody = document.createElement('div');
    sandboxBody.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:4px 0;">Loading sandbox info...</div>';
    sandboxSection.appendChild(sandboxBody);

    self.loadSandboxInfo(sandboxProfileBadge, sandboxBody);

    // ── Action bar ────────────────────────────────────────────────────
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var addBtn = document.createElement('button');
    addBtn.className = 'wk-btn-primary';
    addBtn.textContent = '+ Add Backend';
    addBtn.setAttribute('aria-label', 'Add backend');
    addBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'name', label: 'Name', type: 'text', placeholder: 'Backend name', required: true },
        { name: 'type', label: 'Type', type: 'select', options: ['openai', 'anthropic', 'local', 'ollama', 'custom'] },
        { name: 'url', label: 'URL', type: 'text', placeholder: 'https://api.example.com', required: true }
      ], function (data) {
        disableBtn(addBtn);
        api().invoke('backends:add', { name: data.name, type: data.type, url: data.url }).then(function () {
          wk.toast('Backend added', 'success');
          self.formContainer.innerHTML = '';
          self.renderBackends();
        }).catch(function (e) {
          wk.toast('Failed: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(addBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(addBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    api().invoke('backends:list', {}).then(function (r) {
      listEl.innerHTML = '';
      var backends = Array.isArray(r) ? r : (r && r.backends) || [];
      if (backends.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83D\uDDA5', 'No backends configured', 'Add a backend to connect to an AI provider.'));
        return;
      }
      for (var i = 0; i < backends.length; i++) {
        (function (b) {
          var cardEl = wk.card(b, function () {
            var wrap = document.createElement('div');
            // Header with status dot
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var nameRow = document.createElement('span');
            nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
            var dot = document.createElement('span');
            var statusColor = b.status === 'active' ? 'var(--green)' : b.status === 'error' ? 'var(--red)' : 'var(--text-dim)';
            dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + statusColor + ';display:inline-block;';
            dot.setAttribute('aria-label', 'Status: ' + (b.status || 'unknown'));
            nameRow.appendChild(dot);
            var nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'color:var(--text-primary);font-weight:600;font-size:12px;';
            nameSpan.textContent = b.name || b.id;
            nameRow.appendChild(nameSpan);
            hdr.appendChild(nameRow);
            hdr.appendChild(wk.badge(b.type || b.provider || 'custom', 'info'));
            wrap.appendChild(hdr);

            // URL
            var urlDiv = document.createElement('div');
            urlDiv.style.cssText = 'margin-top:4px;font-size:10px;color:var(--text-dim);font-family:monospace;';
            urlDiv.textContent = b.url || b.endpoint || '-';
            wrap.appendChild(urlDiv);

            // Expandable config
            if (b.config || b.model) {
              var cfgBtn = document.createElement('button');
              cfgBtn.className = 'wk-btn-secondary';
              cfgBtn.textContent = 'Config';
              cfgBtn.style.marginTop = '8px';
              cfgBtn.setAttribute('aria-label', 'Show configuration');
              var cfgPanel = document.createElement('div');
              cfgPanel.style.display = 'none';
              cfgBtn.addEventListener('click', function () {
                if (cfgPanel.style.display === 'none') {
                  cfgPanel.style.display = 'block';
                  cfgPanel.innerHTML = '';
                  wk.dataView(cfgPanel, b.config || { model: b.model });
                } else {
                  cfgPanel.style.display = 'none';
                }
              });
              wrap.appendChild(cfgBtn);
              wrap.appendChild(cfgPanel);
            }

            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(backends[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load backends', ''));
    });
  };

  // ─── Sandbox Policy Loader ─────────────────────────────────────────

  ManagementSurfacesPanel.prototype.loadSandboxInfo = function (badgeContainer, bodyContainer) {
    var wk = window.wk;
    var ipc = api();

    // Fetch profile, denials, and policy in parallel
    var profilePromise = ipc.invoke('sandbox:get-profile', {}).catch(function () { return null; });
    var denialsPromise = ipc.invoke('sandbox:get-denials', {}).catch(function () { return null; });
    var policyPromise = ipc.invoke('sandbox:get-policy', {}).catch(function () { return null; });

    Promise.all([profilePromise, denialsPromise, policyPromise]).then(function (res) {
      var profileResult = res[0];
      var denialsResult = res[1];
      var policyResult = res[2];

      // ── Profile Badge ──
      var profile = 'off';
      if (profileResult) {
        profile = (typeof profileResult === 'string') ? profileResult : (profileResult.profile || profileResult.name || profileResult.mode || 'off');
      }
      var profileVariant = 'info';
      if (profile === 'off') profileVariant = 'info';
      else if (profile === 'workspace') profileVariant = 'info';
      else if (profile === 'read-only') profileVariant = 'warning';
      else if (profile === 'strict') profileVariant = 'error';
      badgeContainer.innerHTML = '';
      badgeContainer.appendChild(wk.badge(profile, profileVariant));

      // ── Body content ──
      bodyContainer.innerHTML = '';

      // ── Denial Log (collapsible) ──
      var denialSection = document.createElement('div');
      denialSection.style.cssText = 'margin-bottom:12px;';

      var denialHeader = document.createElement('div');
      denialHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:4px 0;';
      var denialTitle = document.createElement('span');
      denialTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;';
      denialTitle.textContent = 'Denial Log';
      denialHeader.appendChild(denialTitle);
      var denialToggle = document.createElement('span');
      denialToggle.style.cssText = 'font-size:10px;color:var(--text-dim);transition:transform var(--motion-quick);';
      denialToggle.textContent = '\u25BC';
      denialHeader.appendChild(denialToggle);
      denialSection.appendChild(denialHeader);

      var denialContent = document.createElement('div');
      denialContent.style.cssText = 'display:none;margin-top:6px;max-height:200px;overflow-y:auto;';
      denialContent.className = 'wk-scroll';
      denialSection.appendChild(denialContent);

      var denials = [];
      if (denialsResult) {
        denials = Array.isArray(denialsResult) ? denialsResult : (denialsResult.denials || denialsResult.entries || []);
      }

      if (denials.length === 0) {
        var emptyDenial = document.createElement('div');
        emptyDenial.style.cssText = 'font-size:11px;color:var(--text-dim);padding:6px 0;text-align:center;';
        emptyDenial.textContent = 'No denials recorded.';
        denialContent.appendChild(emptyDenial);
      } else {
        for (var di = 0; di < denials.length; di++) {
          (function (denial) {
            var row = document.createElement('div');
            row.style.cssText = 'padding:6px 8px;border-radius:var(--radius-xs);margin-bottom:4px;background:var(--surface-container-high);border:1px solid var(--border-color);font-size:11px;';

            var topRow = document.createElement('div');
            topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';

            var pathSpan = document.createElement('span');
            pathSpan.style.cssText = 'color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
            pathSpan.textContent = denial.path || denial.file || '-';
            pathSpan.title = denial.path || denial.file || '';
            topRow.appendChild(pathSpan);

            var profileBadge = wk.badge(denial.profile || denial.blockedBy || profile, 'error');
            topRow.appendChild(profileBadge);
            row.appendChild(topRow);

            var bottomRow = document.createElement('div');
            bottomRow.style.cssText = 'display:flex;justify-content:space-between;margin-top:3px;color:var(--text-dim);font-size:10px;';

            var opSpan = document.createElement('span');
            opSpan.textContent = 'Op: ' + (denial.operation || denial.op || denial.action || 'unknown');
            bottomRow.appendChild(opSpan);

            var tsSpan = document.createElement('span');
            tsSpan.textContent = relTime(denial.timestamp || denial.time || denial.ts);
            bottomRow.appendChild(tsSpan);

            row.appendChild(bottomRow);
            denialContent.appendChild(row);
          })(denials[di]);
        }
      }

      // Denial count badge in header
      if (denials.length > 0) {
        var countBadge = wk.badge(denials.length + '', 'error');
        countBadge.style.marginLeft = '6px';
        denialTitle.appendChild(countBadge);
      }

      denialHeader.addEventListener('click', function () {
        var isHidden = denialContent.style.display === 'none';
        denialContent.style.display = isHidden ? 'block' : 'none';
        denialToggle.style.transform = isHidden ? 'rotate(180deg)' : '';
      });

      bodyContainer.appendChild(denialSection);

      // ── Policy Viewer (collapsible) ──
      var policySection = document.createElement('div');

      var policyHeader = document.createElement('div');
      policyHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:4px 0;';
      var policyTitle = document.createElement('span');
      policyTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;';
      policyTitle.textContent = 'Effective Policy';
      policyHeader.appendChild(policyTitle);
      var policyToggle = document.createElement('span');
      policyToggle.style.cssText = 'font-size:10px;color:var(--text-dim);transition:transform var(--motion-quick);';
      policyToggle.textContent = '\u25BC';
      policyHeader.appendChild(policyToggle);
      policySection.appendChild(policyHeader);

      var policyContent = document.createElement('div');
      policyContent.style.cssText = 'display:none;margin-top:6px;';
      policySection.appendChild(policyContent);

      // Parse policy data
      var allowedPaths = [];
      var deniedGlobs = [];
      if (policyResult) {
        allowedPaths = policyResult.allowedPaths || policyResult.allowed || [];
        deniedGlobs = policyResult.deniedGlobs || policyResult.denied || policyResult.blockedGlobs || [];
      }

      // Allowed paths
      var allowedDiv = document.createElement('div');
      allowedDiv.style.cssText = 'margin-bottom:8px;';
      var allowedLabel = document.createElement('div');
      allowedLabel.style.cssText = 'font-size:10px;font-weight:600;color:var(--green);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
      allowedLabel.textContent = '\u2713 Allowed Paths';
      allowedDiv.appendChild(allowedLabel);

      if (allowedPaths.length === 0) {
        var noAllowed = document.createElement('div');
        noAllowed.style.cssText = 'font-size:11px;color:var(--text-dim);padding:2px 0;';
        noAllowed.textContent = 'None configured';
        allowedDiv.appendChild(noAllowed);
      } else {
        for (var ai = 0; ai < allowedPaths.length; ai++) {
          var allowedItem = document.createElement('div');
          allowedItem.style.cssText = 'font-size:11px;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;padding:2px 6px;background:var(--surface-container-high);border-radius:var(--radius-xs);margin-bottom:2px;';
          allowedItem.textContent = allowedPaths[ai];
          allowedDiv.appendChild(allowedItem);
        }
      }
      policyContent.appendChild(allowedDiv);

      // Denied globs
      var deniedDiv = document.createElement('div');
      var deniedLabel = document.createElement('div');
      deniedLabel.style.cssText = 'font-size:10px;font-weight:600;color:var(--red);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
      deniedLabel.textContent = '\u2717 Denied Globs';
      deniedDiv.appendChild(deniedLabel);

      if (deniedGlobs.length === 0) {
        var noDenied = document.createElement('div');
        noDenied.style.cssText = 'font-size:11px;color:var(--text-dim);padding:2px 0;';
        noDenied.textContent = 'None configured';
        deniedDiv.appendChild(noDenied);
      } else {
        for (var dgi = 0; dgi < deniedGlobs.length; dgi++) {
          var deniedItem = document.createElement('div');
          deniedItem.style.cssText = 'font-size:11px;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;padding:2px 6px;background:var(--surface-container-high);border-radius:var(--radius-xs);margin-bottom:2px;';
          deniedItem.textContent = deniedGlobs[dgi];
          deniedDiv.appendChild(deniedItem);
        }
      }
      policyContent.appendChild(deniedDiv);

      policyHeader.addEventListener('click', function () {
        var isHidden = policyContent.style.display === 'none';
        policyContent.style.display = isHidden ? 'block' : 'none';
        policyToggle.style.transform = isHidden ? 'rotate(180deg)' : '';
      });

      bodyContainer.appendChild(policySection);

    }).catch(function () {
      bodyContainer.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:4px 0;">Sandbox info unavailable.</div>';
      badgeContainer.innerHTML = '';
      badgeContainer.appendChild(wk.badge('unknown', 'info'));
    });
  };

  // ─── Sharing Tab ─────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderSharing = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Share';
    createBtn.setAttribute('aria-label', 'Create share');
    createBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'content', label: 'Content', type: 'select', options: ['conversation', 'memory', 'steering', 'project'] },
        { name: 'expiry', label: 'Expires In', type: 'select', options: ['1h', '24h', '7d', '30d', 'never'] }
      ], function (data) {
        disableBtn(createBtn);
        api().invoke('e2e:share', { projectId: projectId(), content: data.content, expiry: data.expiry }).then(function (r) {
          wk.toast('Share created', 'success');
          self.formContainer.innerHTML = '';
          self.renderSharing();
        }).catch(function (e) {
          wk.toast('Failed: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(createBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    Promise.all([api().invoke('e2e:list', {}), api().invoke('e2e:stats', {})]).then(function (res) {
      listEl.innerHTML = '';
      var shares = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].shares) || [];
      var stats = res[1] || {};

      // Stats bar
      if (stats.totalShares != null) {
        var statBar = document.createElement('div');
        statBar.style.cssText = 'display:flex;gap:12px;margin-bottom:12px;font-size:11px;color:var(--text-secondary);';
        statBar.innerHTML = '<span>Total: ' + (stats.totalShares || 0) + '</span><span>Active: ' + (stats.activeShares || 0) + '</span><span>Revoked: ' + (stats.revokedShares || 0) + '</span>';
        listEl.appendChild(statBar);
      }

      if (shares.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83D\uDD12', 'No shared content', 'Create a share to generate a secure link.'));
        return;
      }
      for (var i = 0; i < shares.length; i++) {
        (function (s) {
          var cardEl = wk.card(s, function () {
            var wrap = document.createElement('div');
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'color:var(--text-primary);font-size:12px;font-weight:600;';
            nameSpan.textContent = s.name || s.id || 'Share';
            hdr.appendChild(nameSpan);
            hdr.appendChild(wk.badge(s.status || 'active', s.status === 'revoked' ? 'error' : 'success'));
            wrap.appendChild(hdr);

            // Expiry
            var expiry = document.createElement('div');
            expiry.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-dim);';
            expiry.textContent = 'Expires: ' + (s.expiresAt ? relTime(s.expiresAt) : 'never') + ' | Created: ' + relTime(s.createdAt);
            wrap.appendChild(expiry);

            // Actions
            var actionRow = document.createElement('div');
            actionRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
            if (s.link || s.url) {
              actionRow.appendChild(wk.copyButton(s.link || s.url));
            }
            if (s.status !== 'revoked') {
              var revokeBtn = document.createElement('button');
              revokeBtn.className = 'wk-btn-danger';
              revokeBtn.textContent = 'Revoke';
              revokeBtn.setAttribute('aria-label', 'Revoke share');
              revokeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var confirmEl = wk.confirm('Revoke this share?', function () {
                  disableBtn(revokeBtn);
                  api().invoke('e2e:revoke', { id: s.id }).then(function () {
                    wk.toast('Share revoked', 'success');
                    self.renderSharing();
                  }).catch(function () { wk.toast('Failed to revoke', 'error'); }).finally(function () { enableBtn(revokeBtn); });
                });
                cardEl.appendChild(confirmEl);
              });
              actionRow.appendChild(revokeBtn);
            }
            wrap.appendChild(actionRow);
            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(shares[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load shares', ''));
    });
  };

  // ─── Specs Tab ───────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderSpecs = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Spec';
    createBtn.setAttribute('aria-label', 'Create spec');
    createBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'name', label: 'Name', type: 'text', placeholder: 'Spec name', required: true },
        { name: 'type', label: 'Type', type: 'select', options: ['feature', 'bugfix', 'refactor'] },
        { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Brief description' }
      ], function (data) {
        disableBtn(createBtn);
        api().invoke('specs:create', { projectId: projectId(), name: data.name, type: data.type, description: data.description }).then(function () {
          wk.toast('Spec created', 'success');
          self.formContainer.innerHTML = '';
          self.renderSpecs();
        }).catch(function (e) {
          wk.toast('Failed: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(createBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    Promise.all([api().invoke('specs:list', {}), api().invoke('specs:stats', {})]).then(function (res) {
      listEl.innerHTML = '';
      var specs = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].specs) || [];
      var stats = res[1] || {};

      // Stats display
      if (stats.total != null) {
        var statBar = document.createElement('div');
        statBar.style.cssText = 'display:flex;gap:12px;margin-bottom:12px;font-size:11px;color:var(--text-secondary);';
        statBar.innerHTML = '<span>Total: ' + (stats.total || 0) + '</span><span>Completed: ' + (stats.completed || 0) + '</span><span>In Progress: ' + (stats.inProgress || 0) + '</span>';
        listEl.appendChild(statBar);
      }

      if (specs.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83D\uDCDD', 'No specs yet', 'Create a spec to plan work.'));
        return;
      }
      for (var i = 0; i < specs.length; i++) {
        (function (s) {
          var statusVariant = s.status === 'completed' ? 'success' : s.status === 'in-progress' ? 'warning' : 'info';
          var cardEl = wk.card(s, function () {
            var wrap = document.createElement('div');
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'color:var(--text-primary);font-weight:600;font-size:12px;';
            nameSpan.textContent = s.name || s.id;
            hdr.appendChild(nameSpan);
            hdr.appendChild(wk.badge(s.status || 'draft', statusVariant));
            wrap.appendChild(hdr);
            if (s.description) {
              var desc = document.createElement('div');
              desc.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-dim);';
              desc.textContent = s.description.slice(0, 80);
              wrap.appendChild(desc);
            }
            var dateEl = document.createElement('div');
            dateEl.style.cssText = 'margin-top:4px;font-size:10px;color:var(--text-dim);';
            dateEl.textContent = relTime(s.createdAt);
            wrap.appendChild(dateEl);
            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(specs[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load specs', ''));
    });
  };

  // ─── Wiki Tab ────────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderWiki = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var genBtn = document.createElement('button');
    genBtn.className = 'wk-btn-primary';
    genBtn.textContent = '\uD83D\uDCDD Generate';
    genBtn.setAttribute('aria-label', 'Generate wiki');
    genBtn.addEventListener('click', function () {
      disableBtn(genBtn);
      // Show progress
      var progWrap = document.createElement('div');
      progWrap.style.cssText = 'margin-bottom:12px;';
      var progLabel = document.createElement('div');
      progLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:4px;';
      progLabel.textContent = 'Generating wiki pages...';
      progWrap.appendChild(progLabel);
      var progBar = wk.progress(30, 100);
      progWrap.appendChild(progBar);
      self.formContainer.innerHTML = '';
      self.formContainer.appendChild(progWrap);

      api().invoke('wiki:generate', { projectId: projectId() }).then(function () {
        wk.toast('Wiki generated', 'success');
        self.formContainer.innerHTML = '';
        self.renderWiki();
      }).catch(function (e) {
        wk.toast('Generation failed: ' + (e.message || e), 'error');
        self.formContainer.innerHTML = '';
      }).finally(function () { enableBtn(genBtn); });
    });
    actions.appendChild(genBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    Promise.all([api().invoke('wiki:get-pages', {}), api().invoke('wiki:stats', {})]).then(function (res) {
      listEl.innerHTML = '';
      var pages = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].pages) || [];
      var stats = res[1] || {};

      if (stats.totalPages != null) {
        var statBar = document.createElement('div');
        statBar.style.cssText = 'display:flex;gap:12px;margin-bottom:12px;font-size:11px;color:var(--text-secondary);';
        statBar.innerHTML = '<span>Pages: ' + (stats.totalPages || 0) + '</span><span>Generations: ' + (stats.totalGenerations || 0) + '</span>';
        listEl.appendChild(statBar);
      }

      if (pages.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83D\uDCD6', 'No wiki pages', 'Click Generate to create documentation.'));
        return;
      }
      for (var i = 0; i < pages.length; i++) {
        (function (p) {
          var cardEl = wk.card(p, function () {
            var wrap = document.createElement('div');
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var title = document.createElement('span');
            title.style.cssText = 'color:var(--text-primary);font-weight:600;font-size:12px;';
            title.textContent = p.title || p.name || p.id;
            hdr.appendChild(title);
            var dateSpan = document.createElement('span');
            dateSpan.style.cssText = 'font-size:10px;color:var(--text-dim);';
            dateSpan.textContent = relTime(p.updatedAt || p.createdAt);
            hdr.appendChild(dateSpan);
            wrap.appendChild(hdr);
            if (p.summary || p.description) {
              var summary = document.createElement('div');
              summary.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-dim);';
              summary.textContent = (p.summary || p.description || '').slice(0, 100);
              wrap.appendChild(summary);
            }
            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(pages[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load wiki', ''));
    });
  };

  // ─── Workspaces Tab ──────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderWorkspaces = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Workspace';
    createBtn.setAttribute('aria-label', 'Create workspace');
    createBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'branch', label: 'Branch Name', type: 'text', placeholder: 'feature/my-branch', required: true }
      ], function (data) {
        disableBtn(createBtn);
        api().invoke('workspace:create', { projectId: projectId(), branch: data.branch }).then(function () {
          wk.toast('Workspace created', 'success');
          self.formContainer.innerHTML = '';
          self.renderWorkspaces();
        }).catch(function (e) {
          wk.toast('Failed: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(createBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    api().invoke('workspace:list', {}).then(function (r) {
      listEl.innerHTML = '';
      var workspaces = Array.isArray(r) ? r : (r && r.workspaces) || [];
      if (workspaces.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83D\uDCC2', 'No workspaces', 'Create a workspace to work on a branch.'));
        return;
      }
      for (var i = 0; i < workspaces.length; i++) {
        (function (w) {
          var cardEl = wk.card(w, function () {
            var wrap = document.createElement('div');
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'color:var(--text-primary);font-weight:600;font-size:12px;';
            nameSpan.textContent = w.name || w.ref || w.branch || w.id;
            hdr.appendChild(nameSpan);
            var badges = document.createElement('span');
            badges.style.cssText = 'display:flex;gap:4px;';
            badges.appendChild(wk.badge(w.branch || w.ref || 'main', 'info'));
            if (w.dirtyCount != null) {
              badges.appendChild(wk.badge(w.dirtyCount + ' dirty', w.dirtyCount > 0 ? 'warning' : 'success'));
            }
            hdr.appendChild(badges);
            wrap.appendChild(hdr);

            // Delete action
            var actionRow = document.createElement('div');
            actionRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
            var delBtn = document.createElement('button');
            delBtn.className = 'wk-btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.setAttribute('aria-label', 'Delete workspace');
            delBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              var confirmEl = wk.confirm('Delete workspace "' + (w.name || w.branch || w.id) + '"?', function () {
                disableBtn(delBtn);
                api().invoke('workspace:delete', { id: w.id }).then(function () {
                  wk.toast('Workspace deleted', 'success');
                  self.renderWorkspaces();
                }).catch(function () { wk.toast('Failed to delete', 'error'); }).finally(function () { enableBtn(delBtn); });
              });
              cardEl.appendChild(confirmEl);
            });
            actionRow.appendChild(delBtn);
            wrap.appendChild(actionRow);
            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(workspaces[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load workspaces', ''));
    });
  };

  // ─── Tasks Tab ───────────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderTasks = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Task';
    createBtn.setAttribute('aria-label', 'Create task');
    createBtn.addEventListener('click', function () {
      self.formContainer.innerHTML = '';
      wk.form(self.formContainer, [
        { name: 'title', label: 'Title', type: 'text', placeholder: 'Task title', required: true },
        { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Describe the task' }
      ], function (data) {
        disableBtn(createBtn);
        api().invoke('tracker:create', { projectId: projectId(), title: data.title, description: data.description }).then(function () {
          wk.toast('Task created', 'success');
          self.formContainer.innerHTML = '';
          self.renderTasks();
        }).catch(function (e) {
          wk.toast('Failed: ' + (e.message || e), 'error');
        }).finally(function () { enableBtn(createBtn); });
      }, function () { self.formContainer.innerHTML = ''; });
    });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    // Load list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    Promise.all([api().invoke('tracker:get', { projectId: projectId() }), api().invoke('tracker:stats', {})]).then(function (res) {
      listEl.innerHTML = '';
      var tasks = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].tasks) || [];
      var stats = res[1] || {};

      if (stats.total != null) {
        var statBar = document.createElement('div');
        statBar.style.cssText = 'display:flex;gap:12px;margin-bottom:12px;font-size:11px;color:var(--text-secondary);';
        statBar.innerHTML = '<span>Total: ' + (stats.total || 0) + '</span><span>Open: ' + (stats.open || 0) + '</span><span>Done: ' + (stats.done || 0) + '</span>';
        listEl.appendChild(statBar);
      }

      if (tasks.length === 0) {
        listEl.appendChild(wk.emptyState('\u2611', 'No tasks', 'Create a task to track work.'));
        return;
      }
      for (var i = 0; i < tasks.length; i++) {
        (function (t) {
          var statusVariant = t.status === 'done' ? 'success' : t.status === 'in-progress' ? 'warning' : 'info';
          var cardEl = wk.card(t, function () {
            var wrap = document.createElement('div');
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;';
            var title = document.createElement('span');
            title.style.cssText = 'color:var(--text-primary);font-size:12px;flex:1;';
            title.textContent = t.title || t.description || t.id;
            hdr.appendChild(title);
            hdr.appendChild(wk.badge(t.status || 'open', statusVariant));
            wrap.appendChild(hdr);

            // Context (expandable)
            if (t.description || t.context) {
              var ctxEl = document.createElement('div');
              ctxEl.style.cssText = 'display:none;margin-top:6px;font-size:11px;color:var(--text-dim);line-height:1.5;';
              ctxEl.textContent = t.description || t.context || '';
              wrap.appendChild(ctxEl);
              hdr.addEventListener('click', function () {
                ctxEl.style.display = ctxEl.style.display === 'none' ? 'block' : 'none';
              });
            }

            return wrap;
          });
          cardEl.style.marginBottom = '8px';
          listEl.appendChild(cardEl);
        })(tasks[i]);
      }
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load tasks', ''));
    });
  };

  // ─── Checkpoints Tab ─────────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderCheckpoints = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';

    // Action bar
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Checkpoint';
    createBtn.setAttribute('aria-label', 'Create checkpoint');
    createBtn.addEventListener('click', function () {
      disableBtn(createBtn);
      api().invoke('checkpoint:start', { projectId: projectId() }).then(function () {
        wk.toast('Checkpoint created', 'success');
        self.renderCheckpoints();
      }).catch(function (e) {
        wk.toast('Failed: ' + (e.message || e), 'error');
      }).finally(function () { enableBtn(createBtn); });
    });
    actions.appendChild(createBtn);
    el.appendChild(actions);

    // Load data
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading...</div>';
    el.appendChild(listEl);

    Promise.all([api().invoke('checkpoint:get-latest', {}), api().invoke('checkpoint:has-recovery', {}), api().invoke('checkpoint:list', {}).catch(function () { return []; })]).then(function (res) {
      listEl.innerHTML = '';
      var latest = res[0] || {};
      var hasRecovery = res[1];
      var checkpoints = Array.isArray(res[2]) ? res[2] : (res[2] && res[2].checkpoints) || [];

      // Recovery CTA
      if (hasRecovery) {
        var recoveryCard = document.createElement('div');
        recoveryCard.className = 'wk-card';
        recoveryCard.style.cssText = 'border-color:var(--yellow);margin-bottom:12px;';
        recoveryCard.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<div><div style="font-size:12px;font-weight:600;color:var(--yellow);">\u26A0 Recovery Available</div>' +
          '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">Restore from a previous checkpoint.</div></div></div>';
        var recoverBtn = document.createElement('button');
        recoverBtn.className = 'wk-btn-primary';
        recoverBtn.textContent = 'Recover';
        recoverBtn.setAttribute('aria-label', 'Recover from checkpoint');
        recoverBtn.addEventListener('click', function () {
          disableBtn(recoverBtn);
          api().invoke('checkpoint:recover', {}).then(function () {
            wk.toast('Recovery complete', 'success');
            self.renderCheckpoints();
          }).catch(function () { wk.toast('Recovery failed', 'error'); }).finally(function () { enableBtn(recoverBtn); });
        });
        recoveryCard.querySelector('div').appendChild(recoverBtn);
        listEl.appendChild(recoveryCard);
      }

      // Timeline visualization
      var timelineHeader = document.createElement('div');
      timelineHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
      timelineHeader.textContent = 'Timeline';
      listEl.appendChild(timelineHeader);

      var allCps = checkpoints.length > 0 ? checkpoints : (latest.id ? [latest] : []);
      if (allCps.length === 0) {
        listEl.appendChild(wk.emptyState('\uD83D\uDCBE', 'No checkpoints', 'Create a checkpoint to save state.'));
        return;
      }

      // Timeline entries
      var timeline = document.createElement('div');
      timeline.style.cssText = 'border-left:2px solid var(--border-color);padding-left:16px;margin-left:8px;';
      for (var i = 0; i < allCps.length; i++) {
        (function (cp) {
          var entry = document.createElement('div');
          entry.style.cssText = 'position:relative;margin-bottom:12px;';
          // Dot on timeline
          var dot = document.createElement('div');
          dot.style.cssText = 'position:absolute;left:-21px;top:4px;width:10px;height:10px;border-radius:50%;background:var(--accent);border:2px solid var(--surface-container-high);';
          entry.appendChild(dot);
          // Card
          var cpCard = wk.card(cp, function () {
            var wrap = document.createElement('div');
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            var idSpan = document.createElement('span');
            idSpan.style.cssText = 'font-size:11px;color:var(--text-primary);font-weight:600;';
            idSpan.textContent = (cp.id || 'checkpoint').slice(0, 12);
            row.appendChild(idSpan);
            row.appendChild(wk.badge(cp.type || 'auto', 'info'));
            wrap.appendChild(row);
            var dateEl = document.createElement('div');
            dateEl.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
            dateEl.textContent = relTime(cp.createdAt || cp.timestamp);
            wrap.appendChild(dateEl);
            return wrap;
          });
          entry.appendChild(cpCard);
          timeline.appendChild(entry);
        })(allCps[i]);
      }
      listEl.appendChild(timeline);
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load checkpoints', ''));
    });
  };

  // ─── Background Tasks Tab ──────────────────────────────────────────

  ManagementSurfacesPanel.prototype.renderBackgroundTasks = function () {
    var self = this;
    var el = this.tabContent;
    var wk = window.wk;
    el.innerHTML = '';
    this.formContainer.innerHTML = '';

    // Load task list
    var listEl = document.createElement('div');
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Loading background tasks...</div>';
    el.appendChild(listEl);

    var ipc = api();
    if (!ipc) {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u2699', 'IPC Unavailable', 'Cannot connect to background task service.'));
      return;
    }

    ipc.invoke('background-tasks:list', {}).then(function (result) {
      listEl.innerHTML = '';
      var tasks = Array.isArray(result) ? result : (result && result.tasks) || [];

      if (tasks.length === 0) {
        listEl.appendChild(wk.emptyState('\u2699', 'No Background Tasks', 'No active or recent background processes.'));
        return;
      }

      for (var i = 0; i < tasks.length; i++) {
        listEl.appendChild(self.buildBackgroundTaskCard(tasks[i]));
      }
    }).catch(function (err) {
      listEl.innerHTML = '';
      listEl.appendChild(wk.emptyState('\u26A0\uFE0F', 'Failed to load background tasks', (err && err.message) || 'Unknown error'));
    });
  };

  ManagementSurfacesPanel.prototype.buildBackgroundTaskCard = function (task) {
    var self = this;
    var ipc = api();
    var wk = window.wk;

    var cardEl = wk.card(task, function (t) {
      var wrap = document.createElement('div');

      // ── Header row: command + status badge ──
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var cmdSpan = document.createElement('span');
      cmdSpan.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-family:"SF Mono",Menlo,monospace;';
      cmdSpan.textContent = t.command || t.cmd || '(unknown)';
      cmdSpan.title = t.command || t.cmd || '';
      hdr.appendChild(cmdSpan);

      var statusVariant = t.status === 'running' ? 'success' : t.status === 'completed' ? 'info' : t.status === 'failed' ? 'error' : 'warning';
      hdr.appendChild(wk.badge(t.status || 'unknown', statusVariant));
      wrap.appendChild(hdr);

      // ── Meta row: PID + elapsed time ──
      var meta = document.createElement('div');
      meta.style.cssText = 'display:flex;gap:12px;margin-top:6px;font-size:11px;color:var(--text-dim);';

      if (t.pid != null) {
        var pidSpan = document.createElement('span');
        pidSpan.textContent = 'PID: ' + t.pid;
        meta.appendChild(pidSpan);
      }

      // Elapsed time
      var elapsedSpan = document.createElement('span');
      if (t.elapsed != null) {
        elapsedSpan.textContent = 'Elapsed: ' + self.formatElapsed(t.elapsed);
      } else if (t.startTime || t.startedAt) {
        var startMs = new Date(t.startTime || t.startedAt).getTime();
        var endMs = t.endTime || t.endedAt ? new Date(t.endTime || t.endedAt).getTime() : Date.now();
        var diffSec = Math.round((endMs - startMs) / 1000);
        elapsedSpan.textContent = 'Elapsed: ' + self.formatElapsed(diffSec);
      } else {
        elapsedSpan.textContent = 'Elapsed: -';
      }
      meta.appendChild(elapsedSpan);

      // Exit code for completed/failed tasks
      if (t.status !== 'running' && t.exitCode != null) {
        var exitSpan = document.createElement('span');
        exitSpan.style.color = t.exitCode === 0 ? 'var(--green)' : 'var(--red)';
        exitSpan.textContent = 'Exit: ' + t.exitCode;
        meta.appendChild(exitSpan);
      }

      wrap.appendChild(meta);

      // ── Output area (expandable) ──
      var outputArea = document.createElement('div');
      outputArea.style.cssText = 'margin-top:8px;';
      wrap.appendChild(outputArea);

      // ── Action buttons ──
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;';

      // View Output button
      var outputBtn = document.createElement('button');
      outputBtn.className = 'wk-btn-secondary';
      outputBtn.textContent = '\uD83D\uDCCB Output';
      outputBtn.setAttribute('aria-label', 'View live output for task');
      outputBtn.addEventListener('click', function () {
        disableBtn(outputBtn);
        ipc.invoke('background-tasks:output', { id: t.id, taskId: t.taskId || t.id, lines: 50 }).then(function (r) {
          enableBtn(outputBtn);
          outputArea.innerHTML = '';
          var outputText = '';
          if (typeof r === 'string') {
            outputText = r;
          } else if (r && r.output) {
            outputText = r.output;
          } else if (r && r.lines) {
            outputText = Array.isArray(r.lines) ? r.lines.join('\n') : String(r.lines);
          } else {
            outputText = '(no output available)';
          }

          var outputPre = document.createElement('pre');
          outputPre.style.cssText = 'background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:10px 12px;font-size:11px;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin:0;';
          outputPre.textContent = outputText;
          outputArea.appendChild(outputPre);
        }).catch(function (err) {
          enableBtn(outputBtn);
          wk.toast((err && err.message) || 'Failed to get output', 'error');
        });
      });
      actions.appendChild(outputBtn);

      // Kill button (only for running tasks)
      if (t.status === 'running') {
        var killBtn = document.createElement('button');
        killBtn.className = 'wk-btn-danger';
        killBtn.textContent = '\u2717 Kill';
        killBtn.setAttribute('aria-label', 'Kill background task');
        killBtn.addEventListener('click', function () {
          // Show inline confirmation
          outputArea.innerHTML = '';
          var confirmEl = wk.confirm('Kill task "' + (t.command || t.cmd || t.id) + '" (PID: ' + (t.pid || '?') + ')?', function () {
            disableBtn(killBtn);
            ipc.invoke('background-tasks:kill', { id: t.id, taskId: t.taskId || t.id, pid: t.pid }).then(function () {
              wk.toast('Task killed', 'success');
              self.renderBackgroundTasks();
            }).catch(function (err) {
              enableBtn(killBtn);
              wk.toast((err && err.message) || 'Failed to kill task', 'error');
            });
          });
          outputArea.appendChild(confirmEl);
        });
        actions.appendChild(killBtn);
      }

      // Final output summary for completed/failed tasks
      if (t.status !== 'running' && (t.summary || t.finalOutput)) {
        var summaryDiv = document.createElement('div');
        summaryDiv.style.cssText = 'margin-top:6px;font-size:11px;color:var(--text-secondary);background:var(--surface-container);border-radius:var(--radius-xs);padding:6px 10px;font-family:"SF Mono",Menlo,monospace;';
        summaryDiv.textContent = t.summary || t.finalOutput;
        wrap.appendChild(summaryDiv);
      }

      wrap.appendChild(actions);
      return wrap;
    });
    cardEl.style.marginBottom = '8px';
    return cardEl;
  };

  ManagementSurfacesPanel.prototype.formatElapsed = function (seconds) {
    if (seconds == null || isNaN(seconds)) return '-';
    var s = Math.abs(Math.round(seconds));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  };

  // ─── Cleanup & Exports ───────────────────────────────────────────

  ManagementSurfacesPanel.prototype.destroy = function () {
    if (this.container) this.container.innerHTML = '';
  };

  if (typeof window !== 'undefined') { window.ManagementSurfacesPanel = ManagementSurfacesPanel; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { ManagementSurfacesPanel: ManagementSurfacesPanel }; }

})();
