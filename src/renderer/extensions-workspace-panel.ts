// @ts-nocheck
/**
 * ExtensionsWorkspacePanel — Unified extensions, skills, and integrations management.
 *
 * Uses window.wk namespace utilities for forms, toasts, cards, badges, toggles, etc.
 * All actions show toast feedback. All buttons disabled during async ops.
 * No alert() calls — all data displayed in-panel.
 *
 * Tabs: Plugins, Skill Packs, Agent Skills, Powers
 * Requirements: 1-5, 5.3 (toast, forms, data display, polish, per-panel)
 *
 * IPC channels:
 * - plugin:catalog, plugin:install, plugin:uninstall, plugin:enable, plugin:disable, plugin:permissions, plugin:list
 * - skill-packs:install, skill-packs:list, skill-packs:sync, skill-packs:remove, skill-packs:check-drift, skill-packs:run-eval
 * - agent-skills:get-skills, agent-skills:create-skill, agent-skills:update-skill, agent-skills:delete-skill,
 *   agent-skills:search-skills, agent-skills:assign-skill, agent-skills:get-usage-stats,
 *   agent-skills:get-execution-history, agent-skills:run-manually
 * - powers:list, powers:activate, powers:deactivate
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 */

(function () {
  'use strict';

  var TABS = [
    { id: 'plugins', label: 'Plugins' },
    { id: 'skill-packs', label: 'Skill Packs' },
    { id: 'agent-skills', label: 'Agent Skills' },
    { id: 'powers', label: 'Powers' },
    { id: 'mcp-servers', label: 'MCP Servers' },
  ];

  function api() { return window.electronAPI; }
  function projectId() { return window._neuronestActiveProject || 'default'; }

  // ─── Helpers ─────────────────────────────────────────────────────

  function escHtmlStr(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

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

  var _searchTimer = null;
  function debounce(fn, delay) {
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(function () { fn.apply(ctx, args); }, delay);
    };
  }

  // ─── Panel Constructor ────────────────────────────────────────────

  function ExtensionsWorkspacePanel(container, options) {
    this.container = container;
    this.activeTab = 'plugins';
    this.formContainer = null;
    this.listContainer = null;
  }

  ExtensionsWorkspacePanel.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-family);overflow:hidden;';

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

    this.formContainer = document.createElement('div');
    content.appendChild(this.formContainer);

    this.listContainer = document.createElement('div');
    content.appendChild(this.listContainer);

    this.loadTab(this.activeTab);
  };

  ExtensionsWorkspacePanel.prototype.loadTab = function (id) {
    this.formContainer.innerHTML = '';
    this.listContainer.innerHTML = '';
    switch (id) {
      case 'plugins': this.renderPlugins(); break;
      case 'skill-packs': this.renderSkillPacks(); break;
      case 'agent-skills': this.renderAgentSkills(); break;
      case 'powers': this.renderPowers(); break;
      case 'mcp-servers': this.renderMcpServers(); break;
    }
  };

  // ─── Plugins Tab ──────────────────────────────────────────────────

  ExtensionsWorkspacePanel.prototype.renderPlugins = function () {
    var self = this;
    var list = this.listContainer;
    list.innerHTML = '';

    // Loading state
    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading plugins...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('🔌', 'IPC Unavailable', 'Cannot connect to plugin service.'));
      return;
    }

    Promise.all([
      ipc.invoke('plugin:list', {}),
      ipc.invoke('plugin:catalog', {})
    ]).then(function (res) {
      list.innerHTML = '';
      var installed = Array.isArray(res[0]) ? res[0] : (res[0] && res[0].plugins) || [];
      var catalog = Array.isArray(res[1]) ? res[1] : (res[1] && res[1].catalog) || [];

      // Filter out installed from catalog
      var installedIds = {};
      for (var k = 0; k < installed.length; k++) {
        installedIds[installed[k].id] = true;
      }
      var available = [];
      for (var c = 0; c < catalog.length; c++) {
        if (!installedIds[catalog[c].id]) available.push(catalog[c]);
      }

      // ── Installed Section ──
      var instHeader = document.createElement('div');
      instHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;';
      instHeader.textContent = 'Installed (' + installed.length + ')';
      list.appendChild(instHeader);

      if (installed.length === 0) {
        list.appendChild(wk.emptyState('🔌', 'No Plugins Installed', 'Browse the catalog below to install plugins.'));
      } else {
        for (var i = 0; i < installed.length; i++) {
          list.appendChild(self.buildInstalledPluginCard(installed[i]));
        }
      }

      // ── Available / Catalog Section ──
      var catHeader = document.createElement('div');
      catHeader.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-primary);margin:20px 0 8px;';
      catHeader.textContent = 'Available (' + available.length + ')';
      list.appendChild(catHeader);

      if (available.length === 0) {
        var emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'font-size:12px;color:var(--text-dim);padding:12px 0;';
        emptyMsg.textContent = 'All available plugins are already installed.';
        list.appendChild(emptyMsg);
      } else {
        for (var j = 0; j < Math.min(available.length, 30); j++) {
          list.appendChild(self.buildCatalogPluginCard(available[j]));
        }
      }
    }).catch(function (err) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('❌', 'Failed to Load Plugins', (err && err.message) || 'Unknown error'));
    });
  };

  ExtensionsWorkspacePanel.prototype.buildInstalledPluginCard = function (plugin) {
    var self = this;
    var ipc = api();
    var enabled = plugin.enabled !== false;

    var cardEl = wk.card(plugin, function (p) {
      var wrap = document.createElement('div');
      // Top row: name + toggle
      var topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      nameSpan.textContent = p.name || p.id;
      topRow.appendChild(nameSpan);

      // Toggle switch for enable/disable
      var toggleEl = wk.toggle(enabled, function (isActive) {
        var channel = isActive ? 'plugin:enable' : 'plugin:disable';
        ipc.invoke(channel, { id: p.id }).then(function () {
          wk.toast((p.name || p.id) + (isActive ? ' enabled' : ' disabled'), 'success');
          self.renderPlugins();
        }).catch(function (err) {
          wk.toast((err && err.message) || 'Toggle failed', 'error');
          self.renderPlugins();
        });
      });
      toggleEl.setAttribute('aria-label', 'Toggle ' + (p.name || p.id));
      topRow.appendChild(toggleEl);
      wrap.appendChild(topRow);

      // Description
      if (p.description) {
        var desc = document.createElement('div');
        desc.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:4px;';
        desc.textContent = p.description;
        wrap.appendChild(desc);
      }

      // Author + status
      var meta = document.createElement('div');
      meta.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;';
      if (p.author) {
        var authorEl = document.createElement('span');
        authorEl.style.cssText = 'font-size:10px;color:var(--text-dim);';
        authorEl.textContent = 'by ' + p.author;
        meta.appendChild(authorEl);
      }
      meta.appendChild(wk.badge(enabled ? 'enabled' : 'disabled', enabled ? 'success' : 'info'));
      wrap.appendChild(meta);

      return wrap;
    });
    cardEl.style.marginBottom = '8px';
    return cardEl;
  };

  ExtensionsWorkspacePanel.prototype.buildCatalogPluginCard = function (plugin) {
    var self = this;
    var ipc = api();

    var cardEl = wk.card(plugin, function (p) {
      var wrap = document.createElement('div');

      // Top row: name + install button
      var topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      nameSpan.textContent = p.name || p.id;
      topRow.appendChild(nameSpan);

      var installBtn = document.createElement('button');
      installBtn.className = 'wk-btn-primary';
      installBtn.textContent = 'Install';
      installBtn.setAttribute('aria-label', 'Install ' + (p.name || p.id));
      installBtn.addEventListener('click', function () {
        self.showInstallConfirmation(p, cardEl, installBtn);
      });
      topRow.appendChild(installBtn);
      wrap.appendChild(topRow);

      // Description
      if (p.description) {
        var desc = document.createElement('div');
        desc.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:4px;';
        desc.textContent = p.description;
        wrap.appendChild(desc);
      }

      // Author
      if (p.author) {
        var authorEl = document.createElement('div');
        authorEl.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:4px;';
        authorEl.textContent = 'by ' + p.author;
        wrap.appendChild(authorEl);
      }

      return wrap;
    });
    cardEl.style.marginBottom = '8px';
    return cardEl;
  };

  ExtensionsWorkspacePanel.prototype.showInstallConfirmation = function (plugin, cardEl, installBtn) {
    var self = this;
    var ipc = api();

    // Build inline permission confirmation
    var confirmWrap = document.createElement('div');
    confirmWrap.style.cssText = 'margin-top:8px;padding:10px 12px;background:var(--surface-container);border:1px solid var(--accent);border-radius:var(--radius-sm);animation:wkSlideDown 0.2s ease;';

    var title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:6px;';
    title.textContent = 'Confirm Installation';
    confirmWrap.appendChild(title);

    // Show permissions if available
    var permissions = plugin.permissions || plugin.requiredPermissions || [];
    if (permissions.length > 0) {
      var permLabel = document.createElement('div');
      permLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:4px;';
      permLabel.textContent = 'Permissions requested:';
      confirmWrap.appendChild(permLabel);
      for (var i = 0; i < permissions.length; i++) {
        var permItem = document.createElement('div');
        permItem.style.cssText = 'font-size:11px;color:var(--yellow);padding:2px 0;';
        permItem.textContent = '• ' + permissions[i];
        confirmWrap.appendChild(permItem);
      }
    } else {
      var noPerms = document.createElement('div');
      noPerms.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:4px;';
      noPerms.textContent = 'No special permissions required.';
      confirmWrap.appendChild(noPerms);
    }

    // Action buttons
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'wk-btn-primary';
    confirmBtn.textContent = 'Confirm Install';
    confirmBtn.setAttribute('aria-label', 'Confirm install ' + (plugin.name || plugin.id));
    confirmBtn.addEventListener('click', function () {
      asyncAction(confirmBtn, ipc.invoke('plugin:install', { id: plugin.id }), (plugin.name || plugin.id) + ' installed')
        .then(function () { self.renderPlugins(); })
        .catch(function () {});
    });
    actions.appendChild(confirmBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'wk-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel installation');
    cancelBtn.addEventListener('click', function () { confirmWrap.remove(); });
    actions.appendChild(cancelBtn);

    confirmWrap.appendChild(actions);
    cardEl.appendChild(confirmWrap);
  };

  // ─── Skill Packs Tab ──────────────────────────────────────────────

  ExtensionsWorkspacePanel.prototype.renderSkillPacks = function () {
    var self = this;
    var form = this.formContainer;
    var list = this.listContainer;
    list.innerHTML = '';

    // Action bar
    var actionBar = document.createElement('div');
    actionBar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';

    var installBtn = document.createElement('button');
    installBtn.className = 'wk-btn-primary';
    installBtn.textContent = '+ Install Pack';
    installBtn.setAttribute('aria-label', 'Install skill pack');
    installBtn.addEventListener('click', function () {
      asyncAction(installBtn, api().invoke('skill-packs:install', {}), 'Skill pack installed')
        .then(function () { self.renderSkillPacks(); })
        .catch(function () {});
    });
    actionBar.appendChild(installBtn);

    var syncBtn = document.createElement('button');
    syncBtn.className = 'wk-btn-secondary';
    syncBtn.textContent = '🔄 Sync All';
    syncBtn.setAttribute('aria-label', 'Sync all skill packs');
    syncBtn.addEventListener('click', function () {
      asyncAction(syncBtn, api().invoke('skill-packs:sync', {}), 'All packs synced')
        .then(function () { self.renderSkillPacks(); })
        .catch(function () {});
    });
    actionBar.appendChild(syncBtn);

    form.innerHTML = '';
    form.appendChild(actionBar);

    // Loading state
    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading skill packs...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('📦', 'IPC Unavailable', 'Cannot connect to skill packs service.'));
      return;
    }

    ipc.invoke('skill-packs:list', {}).then(function (result) {
      list.innerHTML = '';
      var packs = Array.isArray(result) ? result : (result && result.packs) || [];

      if (packs.length === 0) {
        list.appendChild(wk.emptyState('📦', 'No Skill Packs', 'Install a pack to add curated skill collections.'));
        return;
      }

      for (var i = 0; i < packs.length; i++) {
        list.appendChild(self.buildSkillPackCard(packs[i]));
      }
    }).catch(function (err) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('❌', 'Failed to Load Skill Packs', (err && err.message) || 'Unknown error'));
    });
  };

  ExtensionsWorkspacePanel.prototype.buildSkillPackCard = function (pack) {
    var self = this;
    var ipc = api();

    var cardEl = wk.card(pack, function (p) {
      var wrap = document.createElement('div');

      // Top row: name + version badge
      var topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      nameSpan.textContent = p.name || p.id;
      topRow.appendChild(nameSpan);

      var badgeRow = document.createElement('span');
      badgeRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
      badgeRow.appendChild(wk.badge('v' + (p.version || '?'), 'info'));
      badgeRow.appendChild(wk.badge((p.skillCount || 0) + ' skills', 'success'));
      topRow.appendChild(badgeRow);
      wrap.appendChild(topRow);

      // Description / drift status
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:4px;';
      meta.textContent = p.description || ('Drift: ' + (p.driftStatus || 'synced'));
      wrap.appendChild(meta);

      // Drift / eval result display area
      var resultArea = document.createElement('div');
      resultArea.style.cssText = 'margin-top:6px;';
      resultArea.setAttribute('data-result-area', 'true');
      wrap.appendChild(resultArea);

      // Action buttons
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;';

      var driftBtn = document.createElement('button');
      driftBtn.className = 'wk-btn-secondary';
      driftBtn.textContent = 'Check Drift';
      driftBtn.setAttribute('aria-label', 'Check drift for ' + (p.name || p.id));
      driftBtn.addEventListener('click', function () {
        disableBtn(driftBtn);
        wk.toast('Checking drift...', 'info');
        ipc.invoke('skill-packs:check-drift', { packId: p.id }).then(function (r) {
          enableBtn(driftBtn);
          wk.toast('Drift check complete', 'success');
          // Show results inline
          resultArea.innerHTML = '';
          if (r) {
            wk.dataView(resultArea, r);
          }
        }).catch(function (err) {
          enableBtn(driftBtn);
          wk.toast((err && err.message) || 'Drift check failed', 'error');
        });
      });
      actions.appendChild(driftBtn);

      var evalBtn = document.createElement('button');
      evalBtn.className = 'wk-btn-secondary';
      evalBtn.textContent = 'Run Eval';
      evalBtn.setAttribute('aria-label', 'Run eval for ' + (p.name || p.id));
      evalBtn.addEventListener('click', function () {
        disableBtn(evalBtn);
        wk.toast('Running evaluation...', 'info');
        ipc.invoke('skill-packs:run-eval', { packId: p.id }).then(function (r) {
          enableBtn(evalBtn);
          wk.toast('Evaluation complete', 'success');
          resultArea.innerHTML = '';
          if (r) {
            wk.dataView(resultArea, r);
          }
        }).catch(function (err) {
          enableBtn(evalBtn);
          wk.toast((err && err.message) || 'Eval failed', 'error');
        });
      });
      actions.appendChild(evalBtn);

      var removeBtn = document.createElement('button');
      removeBtn.className = 'wk-btn-danger';
      removeBtn.textContent = 'Remove';
      removeBtn.setAttribute('aria-label', 'Remove ' + (p.name || p.id));
      removeBtn.addEventListener('click', function () {
        var confirmEl = wk.confirm('Remove skill pack "' + (p.name || p.id) + '"? This cannot be undone.', function () {
          asyncAction(removeBtn, ipc.invoke('skill-packs:remove', { packId: p.id }), (p.name || p.id) + ' removed')
            .then(function () { self.renderSkillPacks(); })
            .catch(function () {});
        });
        resultArea.innerHTML = '';
        resultArea.appendChild(confirmEl);
      });
      actions.appendChild(removeBtn);

      wrap.appendChild(actions);
      return wrap;
    });
    cardEl.style.marginBottom = '8px';
    return cardEl;
  };

  // ─── Agent Skills Tab ─────────────────────────────────────────────

  ExtensionsWorkspacePanel.prototype.renderAgentSkills = function () {
    var self = this;
    var form = this.formContainer;
    var list = this.listContainer;
    form.innerHTML = '';
    list.innerHTML = '';

    // Action bar with Create button
    var actionBar = document.createElement('div');
    actionBar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';

    var createBtn = document.createElement('button');
    createBtn.className = 'wk-btn-primary';
    createBtn.textContent = '+ Create Skill';
    createBtn.setAttribute('aria-label', 'Create new agent skill');
    createBtn.addEventListener('click', function () {
      self.showCreateSkillForm();
    });
    actionBar.appendChild(createBtn);
    form.appendChild(actionBar);

    // Search bar with debounce
    var searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'margin-bottom:12px;';

    var searchInput = document.createElement('input');
    searchInput.className = 'wk-input';
    searchInput.placeholder = 'Search skills...';
    searchInput.setAttribute('aria-label', 'Search agent skills');

    var debouncedSearch = debounce(function () {
      var q = searchInput.value.trim();
      if (!q) {
        self.loadSkillsList();
        return;
      }
      var ipc = api();
      if (!ipc) return;
      ipc.invoke('agent-skills:search-skills', { query: q }).then(function (r) {
        var results = Array.isArray(r) ? r : (r && r.skills) || [];
        self.displaySkillCards(results);
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Search failed', 'error');
      });
    }, 300);

    searchInput.addEventListener('input', debouncedSearch);
    searchWrap.appendChild(searchInput);
    form.appendChild(searchWrap);

    // Load skills list
    this.loadSkillsList();
  };

  ExtensionsWorkspacePanel.prototype.showCreateSkillForm = function () {
    var self = this;
    var form = this.formContainer;

    // Remove any existing form
    var existingForm = form.querySelector('.wk-form');
    if (existingForm) { existingForm.remove(); return; }

    wk.form(form, [
      { name: 'name', label: 'Skill Name', placeholder: 'e.g., Code Review', required: true },
      { name: 'description', label: 'Description', type: 'textarea', placeholder: 'What does this skill do?', rows: 3 },
      { name: 'category', label: 'Category', type: 'select', options: [
        { value: 'general', label: 'General' },
        { value: 'code', label: 'Code' },
        { value: 'testing', label: 'Testing' },
        { value: 'documentation', label: 'Documentation' },
        { value: 'devops', label: 'DevOps' },
        { value: 'security', label: 'Security' },
        { value: 'data', label: 'Data' },
        { value: 'design', label: 'Design' },
      ] }
    ], function (data) {
      var ipc = api();
      if (!ipc) { wk.toast('IPC unavailable', 'error'); return; }
      ipc.invoke('agent-skills:create-skill', data).then(function () {
        wk.toast('Skill "' + data.name + '" created', 'success');
        var existingForm2 = form.querySelector('.wk-form');
        if (existingForm2) existingForm2.remove();
        self.loadSkillsList();
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to create skill', 'error');
      });
    }, function () {
      // cancel — form removes itself
    });
  };

  ExtensionsWorkspacePanel.prototype.loadSkillsList = function () {
    var self = this;
    var list = this.listContainer;
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading skills...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('🧠', 'IPC Unavailable', 'Cannot connect to agent skills service.'));
      return;
    }

    ipc.invoke('agent-skills:get-skills', {}).then(function (result) {
      var skills = Array.isArray(result) ? result : (result && result.skills) || [];
      self.displaySkillCards(skills);
    }).catch(function (err) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('❌', 'Failed to Load Skills', (err && err.message) || 'Unknown error'));
    });
  };

  ExtensionsWorkspacePanel.prototype.displaySkillCards = function (skills) {
    var list = this.listContainer;
    list.innerHTML = '';

    if (skills.length === 0) {
      list.appendChild(wk.emptyState('🧠', 'No Agent Skills', 'Create a skill to get started.'));
      return;
    }

    for (var i = 0; i < skills.length; i++) {
      list.appendChild(this.buildAgentSkillCard(skills[i]));
    }
  };

  ExtensionsWorkspacePanel.prototype.buildAgentSkillCard = function (skill) {
    var self = this;
    var ipc = api();
    var cardEl = wk.card(skill, function (s) {
      var wrap = document.createElement('div');

      // Top row: name + source badge
      var topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      nameSpan.textContent = s.name || s.id;
      topRow.appendChild(nameSpan);

      var badgeWrap = document.createElement('span');
      badgeWrap.style.cssText = 'display:flex;gap:4px;align-items:center;';
      var sourceVariant = s.source === 'pack' ? 'info' : (s.source === 'agent' ? 'warning' : 'success');
      badgeWrap.appendChild(wk.badge(s.source || 'local', sourceVariant));
      topRow.appendChild(badgeWrap);
      wrap.appendChild(topRow);

      // Description
      if (s.description) {
        var desc = document.createElement('div');
        desc.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:4px;';
        desc.textContent = s.description;
        wrap.appendChild(desc);
      }

      // Proficiency metrics row (success rate + avg duration)
      var metricsRow = document.createElement('div');
      metricsRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;';
      metricsRow.setAttribute('data-metrics-row', s.id || s.name);

      if (s.proficiency != null) {
        var profLabel = document.createElement('span');
        profLabel.style.cssText = 'font-size:10px;color:var(--text-dim);';
        profLabel.textContent = 'Proficiency:';
        metricsRow.appendChild(profLabel);
        var profBar = wk.progress(s.proficiency, 100);
        profBar.style.cssText += ';width:60px;display:inline-block;';
        metricsRow.appendChild(profBar);
      }

      if (s.category) {
        metricsRow.appendChild(wk.badge(s.category, 'info'));
      }

      wrap.appendChild(metricsRow);

      // Proficiency stats area (updated from IPC)
      var statsArea = document.createElement('div');
      statsArea.style.cssText = 'margin-top:6px;';
      statsArea.setAttribute('data-stats-area', s.id || s.name);
      wrap.appendChild(statsArea);

      // Load proficiency metrics from IPC
      if (ipc) {
        self.loadProficiencyMetrics(s, statsArea);
      }

      // Action buttons row
      var actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;';

      // "Run Manually" button
      var runBtn = document.createElement('button');
      runBtn.className = 'wk-btn-primary';
      runBtn.textContent = '\u25B6 Run Manually';
      runBtn.setAttribute('aria-label', 'Run ' + (s.name || s.id) + ' manually');

      // Run Manually form area
      var runFormArea = document.createElement('div');
      runFormArea.style.cssText = 'margin-top:8px;';
      runBtn.addEventListener('click', function () {
        self.showRunManuallyForm(s, runFormArea, statsArea, historyArea);
      });
      actionsRow.appendChild(runBtn);
      wrap.appendChild(actionsRow);
      wrap.appendChild(runFormArea);

      // Execution History section
      var historyArea = document.createElement('div');
      historyArea.style.cssText = 'margin-top:10px;';
      historyArea.setAttribute('data-history-area', s.id || s.name);
      wrap.appendChild(historyArea);

      // Load execution history
      if (ipc) {
        self.loadExecutionHistory(s, historyArea);
      }

      return wrap;
    });
    cardEl.style.marginBottom = '8px';
    return cardEl;
  };

  // ─── Skill Execution Visibility Helpers ─────────────────────────────

  ExtensionsWorkspacePanel.prototype.loadProficiencyMetrics = function (skill, container) {
    var ipc = api();
    if (!ipc) return;

    ipc.invoke('agent-skills:get-usage-stats', { skillId: skill.id || skill.name }).then(function (stats) {
      container.innerHTML = '';
      if (!stats) return;

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;font-size:10px;color:var(--text-dim);';

      // Success rate
      var successRate = stats.successRate != null ? stats.successRate : (stats.success_rate != null ? stats.success_rate : null);
      if (successRate != null) {
        var srLabel = document.createElement('span');
        var pct = Math.round(successRate * 100);
        srLabel.textContent = 'Success: ' + pct + '%';
        srLabel.style.color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
        row.appendChild(srLabel);
      }

      // Avg duration
      var avgDuration = stats.avgDuration || stats.avg_duration;
      if (avgDuration != null) {
        var durLabel = document.createElement('span');
        durLabel.textContent = 'Avg: ' + (avgDuration < 1000 ? avgDuration + 'ms' : (avgDuration / 1000).toFixed(1) + 's');
        row.appendChild(durLabel);
      }

      // Total runs
      var totalRuns = stats.totalRuns || stats.total_runs;
      if (totalRuns != null) {
        var runsLabel = document.createElement('span');
        runsLabel.textContent = totalRuns + ' runs';
        row.appendChild(runsLabel);
      }

      if (row.children.length > 0) {
        container.appendChild(row);
      }
    }).catch(function () {
      // Silently fail — metrics are non-critical
    });
  };

  ExtensionsWorkspacePanel.prototype.loadExecutionHistory = function (skill, container) {
    var self = this;
    var ipc = api();
    if (!ipc) return;

    container.innerHTML = '';
    var loading = document.createElement('div');
    loading.style.cssText = 'font-size:10px;color:var(--text-dim);padding:4px 0;';
    loading.textContent = 'Loading execution history...';
    container.appendChild(loading);

    ipc.invoke('agent-skills:get-execution-history', { skillId: skill.id || skill.name }).then(function (result) {
      container.innerHTML = '';
      var runs = Array.isArray(result) ? result : (result && result.runs) || [];

      if (runs.length === 0) {
        var emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'font-size:10px;color:var(--text-dim);padding:4px 0;';
        emptyMsg.textContent = 'No execution history yet.';
        container.appendChild(emptyMsg);
        return;
      }

      // Section header
      var header = document.createElement('div');
      header.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;cursor:pointer;display:flex;align-items:center;gap:4px;';
      header.setAttribute('aria-label', 'Toggle execution history');

      var arrow = document.createElement('span');
      arrow.textContent = '\u25BC';
      arrow.style.cssText = 'font-size:9px;transition:transform var(--motion-quick);';
      header.appendChild(arrow);

      var headerText = document.createElement('span');
      headerText.textContent = 'Execution History (' + runs.length + ')';
      header.appendChild(headerText);
      container.appendChild(header);

      // Execution list (collapsible)
      var histList = document.createElement('div');
      histList.style.cssText = 'max-height:200px;overflow-y:auto;';
      histList.className = 'wk-scroll';

      var collapsed = false;
      header.addEventListener('click', function () {
        collapsed = !collapsed;
        histList.style.display = collapsed ? 'none' : 'block';
        arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
      });

      for (var i = 0; i < Math.min(runs.length, 10); i++) {
        histList.appendChild(self.buildExecutionRow(runs[i]));
      }

      container.appendChild(histList);
    }).catch(function () {
      container.innerHTML = '';
      var errMsg = document.createElement('div');
      errMsg.style.cssText = 'font-size:10px;color:var(--text-dim);padding:4px 0;';
      errMsg.textContent = 'Could not load execution history.';
      container.appendChild(errMsg);
    });
  };

  ExtensionsWorkspacePanel.prototype.buildExecutionRow = function (run) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:10px;';

    // Status badge
    var status = run.status || 'unknown';
    var statusVariant = status === 'success' ? 'success' : status === 'failed' ? 'error' : 'warning';
    row.appendChild(wk.badge(status, statusVariant));

    // Timestamp
    var ts = document.createElement('span');
    ts.style.cssText = 'color:var(--text-dim);min-width:55px;';
    var timestamp = run.timestamp || run.startedAt || run.date;
    if (timestamp) {
      var d = new Date(timestamp);
      ts.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } else {
      ts.textContent = '--';
    }
    row.appendChild(ts);

    // Trigger
    var trigger = document.createElement('span');
    trigger.style.cssText = 'color:var(--text-secondary);flex-shrink:0;';
    trigger.textContent = run.trigger || 'manual';
    row.appendChild(trigger);

    // Duration
    var dur = document.createElement('span');
    dur.style.cssText = 'color:var(--text-dim);flex-shrink:0;';
    var duration = run.duration || run.durationMs;
    if (duration != null) {
      dur.textContent = duration < 1000 ? duration + 'ms' : (duration / 1000).toFixed(1) + 's';
    }
    row.appendChild(dur);

    // Output summary (truncated)
    var output = document.createElement('span');
    output.style.cssText = 'color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var summary = run.outputSummary || run.output || run.result || '';
    if (typeof summary === 'object') summary = JSON.stringify(summary);
    if (summary.length > 60) summary = summary.substring(0, 60) + '...';
    output.textContent = summary;
    output.title = run.outputSummary || run.output || run.result || '';
    row.appendChild(output);

    // Failed execution: expandable error details
    if (status === 'failed' && (run.error || run.errorMessage || run.fixSuggestion)) {
      row.style.cursor = 'pointer';
      var errorDetail = document.createElement('div');
      errorDetail.style.cssText = 'display:none;margin-top:4px;padding:6px 8px;background:var(--red-container);border-radius:var(--radius-xs);font-size:10px;color:var(--red);width:100%;';

      var errText = run.error || run.errorMessage || 'Unknown error';
      var fixText = run.fixSuggestion || run.suggestion || '';
      errorDetail.innerHTML = '<div style="font-weight:600;margin-bottom:2px;">Error:</div><div>' + escHtmlStr(errText) + '</div>';
      if (fixText) {
        errorDetail.innerHTML += '<div style="font-weight:600;margin-top:4px;color:var(--accent);">Fix suggestion:</div><div style="color:var(--text-secondary);">' + escHtmlStr(fixText) + '</div>';
      }

      // Wrap row in a container to hold expandable content
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.04);';
      row.style.borderBottom = 'none';
      wrapper.appendChild(row);
      wrapper.appendChild(errorDetail);

      row.addEventListener('click', function () {
        errorDetail.style.display = errorDetail.style.display === 'none' ? 'block' : 'none';
      });

      return wrapper;
    }

    return row;
  };

  ExtensionsWorkspacePanel.prototype.showRunManuallyForm = function (skill, formArea, statsArea, historyArea) {
    var self = this;
    var ipc = api();

    // Toggle: if form already open, close it
    if (formArea.querySelector('.wk-form')) {
      formArea.innerHTML = '';
      return;
    }

    formArea.innerHTML = '';
    wk.form(formArea, [
      { name: 'input', label: 'Custom Input', type: 'textarea', placeholder: 'Enter input for this skill (plain text or JSON)', rows: 3, required: true }
    ], function (data) {
      formArea.innerHTML = '';
      // Show running state
      var runningMsg = document.createElement('div');
      runningMsg.style.cssText = 'font-size:11px;color:var(--accent);padding:6px 0;';
      runningMsg.textContent = 'Running "' + (skill.name || skill.id) + '"...';
      formArea.appendChild(runningMsg);

      ipc.invoke('agent-skills:run-manually', { skillId: skill.id || skill.name, input: data.input }).then(function (result) {
        formArea.innerHTML = '';
        wk.toast('Skill "' + (skill.name || skill.id) + '" executed successfully', 'success');

        // Show output inline
        if (result) {
          var resultHeader = document.createElement('div');
          resultHeader.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:4px;';
          resultHeader.textContent = '\u2705 Output:';
          formArea.appendChild(resultHeader);

          if (typeof result === 'string') {
            var resultPre = document.createElement('pre');
            resultPre.style.cssText = 'background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:8px 10px;font-size:11px;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin:0;';
            resultPre.textContent = result;
            formArea.appendChild(resultPre);
          } else {
            wk.dataView(formArea, result);
          }
        }

        // Refresh proficiency metrics and history
        self.loadProficiencyMetrics(skill, statsArea);
        self.loadExecutionHistory(skill, historyArea);
      }).catch(function (err) {
        formArea.innerHTML = '';
        wk.toast('Skill execution failed', 'error');

        var errDiv = document.createElement('div');
        errDiv.style.cssText = 'padding:8px 10px;background:var(--red-container);border-radius:var(--radius-xs);font-size:11px;color:var(--red);margin-top:4px;';
        errDiv.textContent = '\u274C Error: ' + ((err && err.message) || 'Execution failed');
        formArea.appendChild(errDiv);

        // Still refresh metrics and history (they track failures too)
        self.loadProficiencyMetrics(skill, statsArea);
        self.loadExecutionHistory(skill, historyArea);
      });
    }, function () {
      formArea.innerHTML = '';
    });
  };

  // ─── Powers Tab ───────────────────────────────────────────────────

  ExtensionsWorkspacePanel.prototype.renderPowers = function () {
    var self = this;
    var list = this.listContainer;
    this.formContainer.innerHTML = '';
    list.innerHTML = '';

    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading powers...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('⚡', 'IPC Unavailable', 'Cannot connect to powers service.'));
      return;
    }

    ipc.invoke('powers:list', {}).then(function (result) {
      list.innerHTML = '';
      var powers = Array.isArray(result) ? result : (result && result.powers) || [];

      if (powers.length === 0) {
        list.appendChild(wk.emptyState('⚡', 'No Powers Available', 'Powers extend your agent with additional capabilities.'));
        return;
      }

      for (var i = 0; i < powers.length; i++) {
        list.appendChild(self.buildPowerCard(powers[i]));
      }
    }).catch(function (err) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('❌', 'Failed to Load Powers', (err && err.message) || 'Unknown error'));
    });
  };

  ExtensionsWorkspacePanel.prototype.buildPowerCard = function (power) {
    var self = this;
    var ipc = api();
    var active = power.active || power.enabled;

    var cardEl = wk.card(power, function (p) {
      var wrap = document.createElement('div');

      // Top row: name + toggle
      var topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var nameWrap = document.createElement('div');
      nameWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';

      var icon = document.createElement('span');
      icon.style.cssText = 'font-size:18px;';
      icon.textContent = p.icon || '⚡';
      nameWrap.appendChild(icon);

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      nameSpan.textContent = p.name || p.id;
      nameWrap.appendChild(nameSpan);
      topRow.appendChild(nameWrap);

      // Toggle switch
      var toggleEl = wk.toggle(active, function (isActive) {
        var channel = isActive ? 'powers:activate' : 'powers:deactivate';
        ipc.invoke(channel, { powerId: p.id }).then(function () {
          wk.toast((p.name || p.id) + (isActive ? ' activated' : ' deactivated'), 'success');
          self.renderPowers();
        }).catch(function (err) {
          wk.toast((err && err.message) || 'Toggle failed', 'error');
          self.renderPowers();
        });
      });
      toggleEl.setAttribute('aria-label', 'Toggle ' + (p.name || p.id));
      topRow.appendChild(toggleEl);
      wrap.appendChild(topRow);

      // Description
      if (p.description) {
        var desc = document.createElement('div');
        desc.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:6px;';
        desc.textContent = p.description;
        wrap.appendChild(desc);
      }

      return wrap;
    });

    // Active state = accent left border
    cardEl.style.marginBottom = '8px';
    if (active) {
      cardEl.style.borderLeftWidth = '3px';
      cardEl.style.borderLeftColor = 'var(--accent)';
    }

    return cardEl;
  };

  // ─── MCP Servers Tab ───────────────────────────────────────────────

  ExtensionsWorkspacePanel.prototype.renderMcpServers = function () {
    var self = this;
    var form = this.formContainer;
    var list = this.listContainer;
    form.innerHTML = '';
    list.innerHTML = '';

    // Action bar with Add Server button
    var actionBar = document.createElement('div');
    actionBar.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';

    var addBtn = document.createElement('button');
    addBtn.className = 'wk-btn-primary';
    addBtn.textContent = '+ Add Server';
    addBtn.setAttribute('aria-label', 'Add MCP server');
    addBtn.addEventListener('click', function () {
      self.showAddMcpServerForm();
    });
    actionBar.appendChild(addBtn);
    form.appendChild(actionBar);

    // Loading
    var loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    loading.textContent = 'Loading MCP servers...';
    list.appendChild(loading);

    var ipc = api();
    if (!ipc) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('\uD83D\uDD0C', 'IPC Unavailable', 'Cannot connect to MCP service.'));
      return;
    }

    ipc.invoke('mcp:list-servers', {}).then(function (result) {
      list.innerHTML = '';
      var servers = Array.isArray(result) ? result : (result && result.servers) || [];

      if (servers.length === 0) {
        list.appendChild(wk.emptyState('\uD83D\uDD0C', 'No MCP Servers', 'Add an MCP server to extend agent capabilities.'));
        return;
      }

      for (var i = 0; i < servers.length; i++) {
        list.appendChild(self.buildMcpServerCard(servers[i]));
      }
    }).catch(function (err) {
      list.innerHTML = '';
      list.appendChild(wk.emptyState('\u274C', 'Failed to Load MCP Servers', (err && err.message) || 'Unknown error'));
    });
  };

  ExtensionsWorkspacePanel.prototype.showAddMcpServerForm = function () {
    var self = this;
    var form = this.formContainer;

    // Remove existing form if toggling
    var existingForm = form.querySelector('.wk-form');
    if (existingForm) { existingForm.remove(); return; }

    wk.form(form, [
      { name: 'name', label: 'Server Name', placeholder: 'e.g., my-mcp-server', required: true },
      { name: 'command', label: 'Command', placeholder: 'e.g., npx or /usr/local/bin/mcp-server', required: true },
      { name: 'args', label: 'Args (comma-separated)', placeholder: 'e.g., -y,@modelcontextprotocol/server-filesystem,/path', type: 'textarea', rows: 2 }
    ], function (data) {
      var ipc = api();
      if (!ipc) { wk.toast('IPC unavailable', 'error'); return; }

      // Parse args: split by comma, trim each
      var argsArray = [];
      if (data.args && data.args.trim()) {
        argsArray = data.args.split(',').map(function (a) { return a.trim(); }).filter(function (a) { return a.length > 0; });
      }

      var serverConfig = {
        name: data.name.trim(),
        command: data.command.trim(),
        args: argsArray
      };

      ipc.invoke('mcp:add-server', serverConfig).then(function () {
        wk.toast('MCP server "' + serverConfig.name + '" added', 'success');
        var existingForm2 = form.querySelector('.wk-form');
        if (existingForm2) existingForm2.remove();
        self.renderMcpServers();
      }).catch(function (err) {
        wk.toast((err && err.message) || 'Failed to add server', 'error');
      });
    }, function () {
      // cancel
    });
  };

  ExtensionsWorkspacePanel.prototype.buildMcpServerCard = function (server) {
    var self = this;
    var ipc = api();

    var cardEl = wk.card(server, function (s) {
      var wrap = document.createElement('div');

      // ── Header row: name + status badge ──
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var nameWrap = document.createElement('div');
      nameWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

      // Status dot
      var dot = document.createElement('span');
      var statusColor = s.status === 'connected' ? 'var(--green)' : s.status === 'error' ? 'var(--red)' : 'var(--text-dim)';
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + statusColor + ';display:inline-block;flex-shrink:0;';
      dot.setAttribute('aria-label', 'Status: ' + (s.status || 'unknown'));
      nameWrap.appendChild(dot);

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      nameSpan.textContent = s.name || s.id;
      nameWrap.appendChild(nameSpan);
      hdr.appendChild(nameWrap);

      var statusVariant = s.status === 'connected' ? 'success' : s.status === 'error' ? 'error' : 'warning';
      hdr.appendChild(wk.badge(s.status || 'disconnected', statusVariant));
      wrap.appendChild(hdr);

      // ── Command info ──
      if (s.command) {
        var cmdDiv = document.createElement('div');
        cmdDiv.style.cssText = 'margin-top:4px;font-size:10px;color:var(--text-dim);font-family:"SF Mono",Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        var cmdText = s.command;
        if (s.args && s.args.length > 0) {
          cmdText += ' ' + (Array.isArray(s.args) ? s.args.join(' ') : s.args);
        }
        cmdDiv.textContent = cmdText;
        cmdDiv.title = cmdText;
        wrap.appendChild(cmdDiv);
      }

      // ── Error diagnostic info (if status is error) ──
      if (s.status === 'error' && (s.error || s.errorMessage || s.diagnostic)) {
        var errDiv = document.createElement('div');
        errDiv.style.cssText = 'margin-top:6px;padding:6px 10px;background:var(--red-container);border-radius:var(--radius-xs);font-size:11px;color:var(--red);';
        errDiv.textContent = s.error || s.errorMessage || s.diagnostic;
        wrap.appendChild(errDiv);
      }

      // ── Tool list (expandable) ──
      var toolArea = document.createElement('div');
      toolArea.style.cssText = 'margin-top:8px;';
      wrap.appendChild(toolArea);

      // ── Invoke result area ──
      var invokeArea = document.createElement('div');
      invokeArea.style.cssText = 'margin-top:8px;';
      wrap.appendChild(invokeArea);

      // ── Action buttons ──
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;';

      // Show Tools button
      var toolsBtn = document.createElement('button');
      toolsBtn.className = 'wk-btn-secondary';
      toolsBtn.textContent = '\uD83D\uDEE0 Tools';
      toolsBtn.setAttribute('aria-label', 'Show available tools for ' + (s.name || s.id));
      toolsBtn.addEventListener('click', function () {
        if (toolArea.querySelector('.wk-data-view')) {
          toolArea.innerHTML = '';
          return;
        }
        disableBtn(toolsBtn);
        ipc.invoke('mcp:list-tools', { serverId: s.id, name: s.name }).then(function (r) {
          enableBtn(toolsBtn);
          toolArea.innerHTML = '';
          var tools = Array.isArray(r) ? r : (r && r.tools) || [];
          if (tools.length === 0) {
            var noTools = document.createElement('div');
            noTools.style.cssText = 'font-size:11px;color:var(--text-dim);padding:6px 0;';
            noTools.textContent = 'No tools available.';
            toolArea.appendChild(noTools);
            return;
          }

          // Render tool list
          var toolList = document.createElement('div');
          toolList.className = 'wk-data-view wk-scroll';
          toolList.style.maxHeight = '200px';
          for (var ti = 0; ti < tools.length; ti++) {
            (function (tool) {
              var toolItem = document.createElement('div');
              toolItem.style.cssText = 'padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;';

              var toolName = document.createElement('div');
              toolName.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-primary);';
              toolName.textContent = tool.name || tool.id;
              toolItem.appendChild(toolName);

              if (tool.description) {
                var toolDesc = document.createElement('div');
                toolDesc.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
                toolDesc.textContent = tool.description;
                toolItem.appendChild(toolDesc);
              }

              // Show parameter schema on click
              if (tool.inputSchema || tool.parameters) {
                var schemaDiv = document.createElement('div');
                schemaDiv.style.cssText = 'display:none;margin-top:4px;font-size:10px;color:var(--text-secondary);font-family:"SF Mono",Menlo,monospace;background:var(--surface-container);border-radius:var(--radius-xs);padding:4px 8px;white-space:pre-wrap;max-height:100px;overflow-y:auto;';
                schemaDiv.textContent = JSON.stringify(tool.inputSchema || tool.parameters, null, 2);
                toolItem.appendChild(schemaDiv);

                toolItem.addEventListener('click', function () {
                  schemaDiv.style.display = schemaDiv.style.display === 'none' ? 'block' : 'none';
                });
              }

              // Test invoke button per tool
              var invokeBtn = document.createElement('button');
              invokeBtn.className = 'wk-btn-secondary';
              invokeBtn.style.cssText = 'margin-top:4px;font-size:10px;padding:3px 8px;';
              invokeBtn.textContent = '\u25B6 Test';
              invokeBtn.setAttribute('aria-label', 'Test invoke ' + (tool.name || tool.id));
              invokeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.showTestInvokeForm(s, tool, invokeArea);
              });
              toolItem.appendChild(invokeBtn);

              toolList.appendChild(toolItem);
            })(tools[ti]);
          }
          toolArea.appendChild(toolList);
        }).catch(function (err) {
          enableBtn(toolsBtn);
          wk.toast((err && err.message) || 'Failed to list tools', 'error');
        });
      });
      actions.appendChild(toolsBtn);

      // Reconnect button (shown for disconnected/error servers)
      if (s.status !== 'connected') {
        var reconnectBtn = document.createElement('button');
        reconnectBtn.className = 'wk-btn-primary';
        reconnectBtn.textContent = '\uD83D\uDD04 Reconnect';
        reconnectBtn.setAttribute('aria-label', 'Reconnect ' + (s.name || s.id));
        reconnectBtn.addEventListener('click', function () {
          disableBtn(reconnectBtn);
          wk.toast('Reconnecting to ' + (s.name || s.id) + '...', 'info');
          ipc.invoke('mcp:reconnect', { serverId: s.id, name: s.name }).then(function () {
            enableBtn(reconnectBtn);
            wk.toast((s.name || s.id) + ' reconnected', 'success');
            self.renderMcpServers();
          }).catch(function (err) {
            enableBtn(reconnectBtn);
            wk.toast((err && err.message) || 'Reconnect failed', 'error');
          });
        });
        actions.appendChild(reconnectBtn);
      }

      wrap.appendChild(actions);
      return wrap;
    });

    // Active indicator
    cardEl.style.marginBottom = '8px';
    if (server.status === 'connected') {
      cardEl.style.borderLeftWidth = '3px';
      cardEl.style.borderLeftColor = 'var(--green)';
    } else if (server.status === 'error') {
      cardEl.style.borderLeftWidth = '3px';
      cardEl.style.borderLeftColor = 'var(--red)';
    }

    return cardEl;
  };

  ExtensionsWorkspacePanel.prototype.showTestInvokeForm = function (server, tool, resultArea) {
    var self = this;
    var ipc = api();
    resultArea.innerHTML = '';

    // Build form fields from the tool's inputSchema
    var fields = [];
    var schema = tool.inputSchema || tool.parameters || {};
    var props = schema.properties || {};
    var requiredFields = schema.required || [];
    var propKeys = Object.keys(props);

    if (propKeys.length === 0) {
      // No parameters — just show a JSON input
      fields.push({ name: '_rawInput', label: 'Input (JSON)', type: 'textarea', placeholder: '{}', rows: 3 });
    } else {
      for (var k = 0; k < propKeys.length; k++) {
        var key = propKeys[k];
        var prop = props[key];
        var fieldDef = {
          name: key,
          label: key + (prop.type ? ' (' + prop.type + ')' : ''),
          placeholder: prop.description || '',
          required: requiredFields.indexOf(key) >= 0
        };
        if (prop.type === 'string' && (prop.description && prop.description.length > 50)) {
          fieldDef.type = 'textarea';
          fieldDef.rows = 2;
        }
        fields.push(fieldDef);
      }
    }

    wk.form(resultArea, fields, function (data) {
      // Build input object
      var input = {};
      if (data._rawInput) {
        try { input = JSON.parse(data._rawInput); } catch (e) { wk.toast('Invalid JSON input', 'error'); return; }
      } else {
        for (var dk in data) {
          if (Object.prototype.hasOwnProperty.call(data, dk) && data[dk]) {
            input[dk] = data[dk];
          }
        }
      }

      // Invoke the tool
      resultArea.innerHTML = '';
      var loadingDiv = document.createElement('div');
      loadingDiv.style.cssText = 'text-align:center;padding:12px;color:var(--text-dim);font-size:11px;';
      loadingDiv.textContent = 'Invoking ' + (tool.name || tool.id) + '...';
      resultArea.appendChild(loadingDiv);

      ipc.invoke('mcp:invoke-tool', { serverId: server.id, name: server.name, toolName: tool.name || tool.id, input: input }).then(function (r) {
        resultArea.innerHTML = '';
        // Show result
        var resultHeader = document.createElement('div');
        resultHeader.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:4px;';
        resultHeader.textContent = '\u2705 Result:';
        resultArea.appendChild(resultHeader);

        if (typeof r === 'string') {
          var resultPre = document.createElement('pre');
          resultPre.style.cssText = 'background:var(--surface-container);border:1px solid var(--border-color);border-radius:var(--radius-xs);padding:8px 10px;font-size:11px;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;max-height:150px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin:0;';
          resultPre.textContent = r;
          resultArea.appendChild(resultPre);
        } else {
          wk.dataView(resultArea, r);
        }
      }).catch(function (err) {
        resultArea.innerHTML = '';
        var errDiv = document.createElement('div');
        errDiv.style.cssText = 'padding:8px 10px;background:var(--red-container);border-radius:var(--radius-xs);font-size:11px;color:var(--red);';
        errDiv.textContent = '\u274C Error: ' + ((err && err.message) || 'Invoke failed');
        resultArea.appendChild(errDiv);
      });
    }, function () {
      resultArea.innerHTML = '';
    });
  };

  // ─── Cleanup & Exports ────────────────────────────────────────────

  ExtensionsWorkspacePanel.prototype.destroy = function () {
    if (this.container) this.container.innerHTML = '';
  };

  if (typeof window !== 'undefined') {
    window.ExtensionsWorkspacePanel = ExtensionsWorkspacePanel;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ExtensionsWorkspacePanel: ExtensionsWorkspacePanel };
  }

})();
