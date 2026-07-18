// @ts-nocheck
/**
 * Chat Empty State & Suggestions (Requirements 22.1-22.5)
 *
 * Displays a welcoming empty state with brain icon, contextual suggestion cards,
 * and a capabilities list when the chat has no messages. Clicking a suggestion
 * populates the input and auto-sends. The empty state disappears on first message.
 *
 * Uses window.wk namespace utilities and integrates with the existing chat system.
 * Plain-JS contract: var, no type annotations, no non-null assertions.
 */
(function () {
  'use strict';

  // ─── Default suggestions (no project open) ──────────────────────────
  var defaultSuggestions = [
    { icon: '🚀', label: 'Create a new project', action: 'create-project' },
    { icon: '💡', label: 'Explain NeuroNest', prompt: 'What can NeuroNest do? Give me an overview of all your capabilities.', action: 'auto-select-send' },
    { icon: '🧪', label: 'Run a code review', prompt: 'Review my codebase for potential issues, security vulnerabilities, and improvement opportunities.', action: 'auto-select-send' },
    { icon: '📖', label: 'Learn something new', prompt: 'Teach me about a modern software engineering concept or best practice.', action: 'auto-select-send' },
  ];

  // ─── Project-contextual suggestions ──────────────────────────────────
  var projectSuggestions = [
    { icon: '🧪', label: 'Fix failing tests', prompt: 'Find and fix any failing tests in this project.' },
    { icon: '🔍', label: 'Explain this codebase', prompt: 'Give me a high-level overview of this codebase: architecture, key files, and how things connect.' },
    { icon: '✨', label: 'Add a feature', prompt: 'I want to add a new feature to this project. Help me plan and implement it.' },
    { icon: '🛡️', label: 'Review security', prompt: 'Scan this project for security vulnerabilities and suggest fixes.' },
    { icon: '📦', label: 'Refactor code', prompt: 'Identify areas of this codebase that could benefit from refactoring and help me improve them.' },
    { icon: '📝', label: 'Write documentation', prompt: 'Generate comprehensive documentation for this project including README, API docs, and inline comments.' },
  ];

  // ─── Capabilities list ───────────────────────────────────────────────
  var capabilities = [
    'Read & write files',
    'Run commands & scripts',
    'Browse the web',
    'Manage git repos',
    'Run & fix tests',
    'Generate documentation',
  ];

  // ─── Render the empty state ──────────────────────────────────────────
  function renderEmptyState() {
    var chatArea = document.getElementById('chat-area');
    if (!chatArea) return;

    // Remove existing empty state if present
    var existing = chatArea.querySelector('.chat-empty-state');
    if (existing) existing.remove();

    // Don't show if there are already messages
    var messages = chatArea.querySelectorAll('.message');
    if (messages.length > 0) return;

    // Determine context: is a project open?
    var hasProject = !!(window._neuronestActiveProject && window._neuronestActiveProject !== 'default');
    var suggestions = hasProject ? projectSuggestions : defaultSuggestions;

    // Check if the original .welcome element (with orbital system) already exists
    var welcomeEl = chatArea.querySelector('.welcome');

    // If .welcome doesn't exist (e.g., after clearing conversation), rebuild it
    if (!welcomeEl) {
      welcomeEl = document.createElement('div');
      welcomeEl.className = 'welcome';
      // Use the global buildOrbitalWelcome function from index.ts if available
      var orbitalHtml = '';
      if (typeof buildOrbitalWelcome === 'function') {
        orbitalHtml = buildOrbitalWelcome();
      } else if (typeof window.buildOrbitalWelcome === 'function') {
        orbitalHtml = window.buildOrbitalWelcome();
      }
      var branding = (typeof getBranding === 'function') ? getBranding() :
        ((typeof window.getBranding === 'function') ? window.getBranding() :
        { appName: 'NeuroNest', appDescription: 'The AI Coding SuperAgent', appTagline: 'Self-improving agents, swarm execution, orchestrated workflows, and compounding memory.' });
      welcomeEl.innerHTML = orbitalHtml +
        '<h1>' + branding.appName + '</h1>' +
        '<p>' + branding.appDescription + ' \u2014 ' + branding.appTagline + '</p>';
      chatArea.appendChild(welcomeEl);
    }

    // Build the suggestion pills container (appended BELOW .welcome)
    var container = document.createElement('div');
    container.className = 'chat-empty-state';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Suggestions');

    // Suggestions grid
    var grid = document.createElement('div');
    grid.className = 'chat-empty-state-grid';

    for (var i = 0; i < suggestions.length; i++) {
      var s = suggestions[i];
      var card = document.createElement('button');
      card.className = 'chat-empty-state-card';
      card.setAttribute('aria-label', s.label);
      if (s.prompt) card.setAttribute('data-prompt', s.prompt);
      card.innerHTML = '<span class="chat-empty-state-card-icon">' + s.icon + '</span>' +
        '<span class="chat-empty-state-card-label">' + s.label + '</span>';
      card.addEventListener('click', (function (suggestion) {
        return function () {
          if (suggestion.action === 'create-project') {
            handleCreateProject();
          } else {
            handleAutoSelectAndSend(suggestion.prompt);
          }
        };
      })(s));
      grid.appendChild(card);
    }
    container.appendChild(grid);

    // Capabilities section
    var capSection = document.createElement('div');
    capSection.className = 'chat-empty-state-capabilities';
    var capLabel = document.createElement('span');
    capLabel.className = 'chat-empty-state-cap-label';
    capLabel.textContent = 'Can: ';
    capSection.appendChild(capLabel);
    var capText = document.createElement('span');
    capText.className = 'chat-empty-state-cap-text';
    capText.textContent = capabilities.join(', ');
    capSection.appendChild(capText);
    container.appendChild(capSection);

    // Insert the suggestion container after the .welcome element
    if (welcomeEl.nextSibling) {
      chatArea.insertBefore(container, welcomeEl.nextSibling);
    } else {
      chatArea.appendChild(container);
    }
  }

  // ─── Helper: get electronAPI ────────────────────────────────────────
  function eapi() { return window.electronAPI; }

  // ─── Handle "Create a new project" pill ───────────────────────────────
  function handleCreateProject() {
    // Use the global showModalPrompt if available, otherwise build an inline modal
    var promptFn = window.showModalPrompt;
    if (typeof promptFn === 'function') {
      promptFn('Create New Project', 'Enter a name for your project...').then(function (name) {
        if (!name || !name.trim()) return;
        _doCreateProject(name.trim());
      });
    } else {
      // Fallback: build a themed modal inline
      _showInlineCreateModal();
    }
  }

  function _showInlineCreateModal() {
    // Remove existing modal if any
    var existing = document.getElementById('ces-create-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'ces-create-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);animation:chatEmptyFadeIn 0.2s ease;';

    var modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-sidebar,#252526);border:1px solid var(--border-color,#2d2d2d);border-radius:var(--radius-sm,8px);padding:24px;width:360px;max-width:90vw;box-shadow:0 12px 48px rgba(0,0,0,0.4);';

    var title = document.createElement('h3');
    title.textContent = 'Create New Project';
    title.style.cssText = 'margin:0 0 16px 0;font-size:16px;font-weight:600;color:var(--text-primary,#cccccc);';
    modal.appendChild(title);

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Enter a name for your project...';
    input.style.cssText = 'width:100%;padding:10px 14px;border-radius:var(--radius-xs,4px);border:1px solid var(--border-color,#2d2d2d);background:var(--bg-input,#3c3c3c);color:var(--text-primary,#cccccc);font-size:13px;font-family:inherit;outline:none;transition:border-color 0.15s;';
    input.addEventListener('focus', function () { input.style.borderColor = 'var(--accent,#007AFF)'; });
    input.addEventListener('blur', function () { input.style.borderColor = 'var(--border-color,#2d2d2d)'; });
    modal.appendChild(input);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:8px 16px;border-radius:var(--radius-xs,4px);border:1px solid var(--border-color,#2d2d2d);background:transparent;color:var(--text-secondary,#969696);font-size:13px;cursor:pointer;font-family:inherit;';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });

    var createBtn = document.createElement('button');
    createBtn.textContent = 'Create';
    createBtn.style.cssText = 'padding:8px 16px;border-radius:var(--radius-xs,4px);border:none;background:var(--accent,#007AFF);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;';
    createBtn.addEventListener('click', function () {
      var name = input.value.trim();
      if (!name) {
        input.style.borderColor = 'var(--red,#f87171)';
        return;
      }
      overlay.remove();
      _doCreateProject(name);
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(createBtn);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);

    // Close on overlay click (outside modal)
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    var escHandler = function (e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    // Submit on Enter
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        createBtn.click();
      }
    });

    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 50);
  }

  function _doCreateProject(name) {
    // Create the project via IPC
    eapi().send('project-create', { name: name });

    // Wait briefly for backend to process, then fetch updated list
    setTimeout(function () {
      eapi().invoke('get-projects').then(function (projects) {
        if (!projects || projects.length === 0) {
          _toast("Failed to create project", 'error');
          return;
        }
        // Find the newly created project by name (most recent one matching)
        var newProject = null;
        for (var i = projects.length - 1; i >= 0; i--) {
          if (projects[i].name === name) {
            newProject = projects[i];
            break;
          }
        }
        if (!newProject) {
          // Fallback: use the last project in the list (most recently created)
          newProject = projects[projects.length - 1];
        }

        // Set as active project
        activeProjectId = newProject.id;
        window._neuronestActiveProject = newProject.id;
        eapi().send('project-open', { projectId: newProject.id });

        // Show success toast
        _toast("Project '" + name + "' created!", 'success');

        // Remove welcome screen and empty state from chat area
        var chatArea = document.getElementById('chat-area');
        if (chatArea) {
          var welcomeEl = chatArea.querySelector('.welcome');
          if (welcomeEl) welcomeEl.remove();
          var emptyState = chatArea.querySelector('.chat-empty-state');
          if (emptyState) emptyState.remove();
        }

        // Focus the chat input
        var chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.focus();
      }).catch(function (err) {
        _toast('Error creating project: ' + (err && err.message ? err.message : String(err)), 'error');
      });
    }, 300);
  }

  // ─── Handle auto-select project + send prompt ─────────────────────────
  function handleAutoSelectAndSend(prompt) {
    // If a project is already active, just send the prompt directly
    if (window._neuronestActiveProject && window._neuronestActiveProject !== 'default') {
      handleSuggestionClick(prompt);
      return;
    }

    // No project active — auto-select the first available project
    eapi().invoke('get-projects').then(function (projects) {
      if (!projects || projects.length === 0) {
        _toast('No projects available. Create one first.', 'error');
        return;
      }

      // Select the first project
      var proj = projects[0];
      activeProjectId = proj.id;
      window._neuronestActiveProject = proj.id;
      eapi().send('project-open', { projectId: proj.id });

      // Show toast
      _toast('Auto-selected project: ' + (proj.name || proj.id), 'info');

      // Now send the prompt
      handleSuggestionClick(prompt);
    }).catch(function (err) {
      _toast('Error loading projects: ' + (err && err.message ? err.message : String(err)), 'error');
      // Fallback: just try to send anyway
      handleSuggestionClick(prompt);
    });
  }

  // ─── Toast helper ─────────────────────────────────────────────────────
  function _toast(message, type) {
    if (typeof window.showThemedToast === 'function') {
      window.showThemedToast(message, type || 'info');
    }
  }

  // ─── Handle suggestion click: populate input and auto-send ────────────
  function handleSuggestionClick(prompt) {
    var input = document.getElementById('chat-input');
    if (input) {
      input.value = prompt;
      // Trigger input event for auto-resize
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Auto-send: use the global sendChat function if available
    if (typeof window.sendChat === 'function') {
      var sent = window.sendChat(prompt);
      if (input) {
        input.value = '';
        input.style.height = 'auto';
      }
      // Activate brain animation if sent successfully
      if (sent && typeof window.setBrainActive === 'function') {
        window.setBrainActive(true);
      }
    } else {
      // Fallback: simulate send button click
      var sendBtn = document.getElementById('send-btn');
      if (sendBtn) sendBtn.click();
    }
  }

  // ─── Inject CSS styles ───────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('chat-empty-state-styles')) return;
    var style = document.createElement('style');
    style.id = 'chat-empty-state-styles';
    style.textContent = [
      '.chat-empty-state {',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  padding: 0 24px 48px 24px;',
      '  text-align: center;',
      '  animation: chatEmptyFadeIn 0.4s ease;',
      '}',
      '@keyframes chatEmptyFadeIn {',
      '  from { opacity: 0; transform: translateY(12px); }',
      '  to { opacity: 1; transform: translateY(0); }',
      '}',
      '.chat-empty-state-grid {',
      '  display: grid;',
      '  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));',
      '  gap: 10px;',
      '  max-width: 520px;',
      '  width: 100%;',
      '  margin-bottom: 28px;',
      '}',
      '.chat-empty-state-card {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 12px 16px;',
      '  background: var(--surface-container-high);',
      '  border: 1px solid var(--border-color);',
      '  border-radius: var(--radius-sm);',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '  font-size: 13px;',
      '  color: var(--text-secondary);',
      '  text-align: left;',
      '  transition: all var(--motion-quick);',
      '}',
      '.chat-empty-state-card:hover {',
      '  border-color: var(--accent);',
      '  color: var(--text-primary);',
      '  background: var(--surface-hover);',
      '  transform: translateY(-1px);',
      '  box-shadow: 0 2px 8px rgba(0,0,0,0.15);',
      '}',
      '.chat-empty-state-card:active {',
      '  transform: translateY(0);',
      '  background: var(--surface-active);',
      '}',
      '.chat-empty-state-card:focus-visible {',
      '  outline: 2px solid var(--accent);',
      '  outline-offset: 2px;',
      '}',
      '.chat-empty-state-card-icon {',
      '  font-size: 18px;',
      '  flex-shrink: 0;',
      '}',
      '.chat-empty-state-card-label {',
      '  flex: 1;',
      '  font-weight: 500;',
      '}',
      '.chat-empty-state-capabilities {',
      '  font-size: 12px;',
      '  color: var(--text-dim);',
      '  max-width: 460px;',
      '  line-height: 1.6;',
      '}',
      '.chat-empty-state-cap-label {',
      '  font-weight: 600;',
      '  color: var(--text-secondary);',
      '}',
      '.chat-empty-state-cap-text {',
      '  color: var(--text-dim);',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ─── Initialize ──────────────────────────────────────────────────────
  function init() {
    injectStyles();
    // Render on load (after a small delay to ensure DOM is ready)
    setTimeout(renderEmptyState, 100);
  }

  // Expose for external use (e.g., when conversation is cleared)
  window.chatEmptyState = {
    render: renderEmptyState,
    init: init,
  };

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
