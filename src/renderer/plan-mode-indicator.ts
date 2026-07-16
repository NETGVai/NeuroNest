// @ts-nocheck
/**
 * PlanModeIndicator — Renderer UI component for Plan Mode status and control.
 *
 * Displays:
 * - Mode indicator (visual badge showing "Plan Mode" active state)
 * - Plan preview (displays the current plan file path or a summary)
 * - Toggle button (enter/exit plan mode via IPC)
 * - `/plan` slash command registration
 *
 * Communicates with main process through IPC channels:
 * - plan-mode:get-state — gets current plan mode state (active, planFilePath)
 * - plan-mode:toggle — toggles plan mode on/off
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as feature-management-panel.ts.
 *
 * Requirements: 11.8
 */

// ─── Constants ─────────────────────────────────────────────────────

var PLAN_MODE_BADGE_ACTIVE_BG = 'rgba(250,179,135,0.2)';
var PLAN_MODE_BADGE_ACTIVE_COLOR = '#fab387';
var PLAN_MODE_BADGE_ACTIVE_BORDER = '#fab387';
var PLAN_MODE_BADGE_INACTIVE_BG = 'transparent';
var PLAN_MODE_BADGE_INACTIVE_COLOR = 'var(--text-muted,#6c7086)';
var PLAN_MODE_BADGE_INACTIVE_BORDER = 'var(--border-color,#313244)';

var PLAN_COMMAND_PREFIX = '/plan ';
var PLAN_COMMAND_EXACT = '/plan';

var PLAN_HELP_TEXT =
  'Usage: `/plan <file-path>`\n\n' +
  'Enters Plan Mode — restricts all mutations to the specified plan file.\n' +
  'While active, the agent can read any file but can only write to the plan file.\n\n' +
  'Use `/plan off` to exit Plan Mode.\n\n' +
  'Example: `/plan ./docs/architecture-plan.md`';

// ─── Helpers ───────────────────────────────────────────────────────

function pmEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function pmEapi() {
  return window.electronAPI;
}

function pmCreateEl(tag, styles, attrs) {
  var el = document.createElement(tag);
  if (styles) el.style.cssText = styles;
  if (attrs) {
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) {
        el.setAttribute(key, attrs[key]);
      }
    }
  }
  return el;
}

// ─── PlanModeIndicator class ───────────────────────────────────────

function PlanModeIndicator(container, options) {
  this.container = container;
  this.options = options || {};
  this.active = false;
  this.planFilePath = '';
  this.badgeEl = null;
  this.previewEl = null;
  this.toggleBtn = null;
  this._stateListener = null;
}

/**
 * Render the Plan Mode indicator UI.
 */
PlanModeIndicator.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;';

  // ── Mode indicator badge ──
  this.badgeEl = pmCreateEl('div', 'display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;transition:all 0.2s;cursor:default;border:1px solid ' + PLAN_MODE_BADGE_INACTIVE_BORDER + ';background:' + PLAN_MODE_BADGE_INACTIVE_BG + ';color:' + PLAN_MODE_BADGE_INACTIVE_COLOR + ';');
  this.badgeEl.setAttribute('role', 'status');
  this.badgeEl.setAttribute('aria-label', 'Plan Mode status');

  var icon = pmCreateEl('span', 'font-size:12px;');
  icon.textContent = '\uD83D\uDCDD'; // 📝
  this.badgeEl.appendChild(icon);

  var label = pmCreateEl('span', '');
  label.textContent = 'Plan Mode';
  this.badgeEl.appendChild(label);

  this.container.appendChild(this.badgeEl);

  // ── Plan file preview ──
  this.previewEl = pmCreateEl('span', 'font-size:11px;color:var(--text-muted,#6c7086);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;');
  this.previewEl.setAttribute('title', '');
  this.container.appendChild(this.previewEl);

  // ── Toggle button ──
  this.toggleBtn = pmCreateEl('button', 'font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--border-color,#313244);background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;transition:all 0.2s;');
  this.toggleBtn.textContent = 'Enter';
  this.toggleBtn.setAttribute('aria-label', 'Toggle Plan Mode');
  this.toggleBtn.addEventListener('click', function () {
    self.handleToggle();
  });
  this.container.appendChild(this.toggleBtn);

  // Load initial state
  this.loadState();

  // Subscribe to state updates
  this.subscribeToUpdates();
};

/**
 * Load current plan mode state from main process.
 */
PlanModeIndicator.prototype.loadState = function () {
  var self = this;
  var api = pmEapi();
  if (!api) return;

  api.invoke('plan-mode:get-state').then(function (result) {
    if (result && typeof result === 'object') {
      self.updateUI(result.active, result.planFilePath || '');
    }
  }).catch(function () {
    // Graceful: plan mode IPC not available yet
  });
};

/**
 * Subscribe to plan-mode state update events from main process.
 */
PlanModeIndicator.prototype.subscribeToUpdates = function () {
  var self = this;
  var api = pmEapi();
  if (!api) return;

  this._stateListener = function (data) {
    if (data && typeof data === 'object') {
      self.updateUI(data.active, data.planFilePath || '');
    }
  };
  api.on('plan-mode:state-update', this._stateListener);
};

/**
 * Update the UI to reflect current plan mode state.
 */
PlanModeIndicator.prototype.updateUI = function (active, planFilePath) {
  this.active = !!active;
  this.planFilePath = planFilePath || '';

  if (!this.badgeEl || !this.previewEl || !this.toggleBtn) return;

  if (this.active) {
    this.badgeEl.style.background = PLAN_MODE_BADGE_ACTIVE_BG;
    this.badgeEl.style.color = PLAN_MODE_BADGE_ACTIVE_COLOR;
    this.badgeEl.style.borderColor = PLAN_MODE_BADGE_ACTIVE_BORDER;
    this.badgeEl.setAttribute('aria-label', 'Plan Mode active');

    // Show plan file path preview
    var fileName = this.planFilePath.split('/').pop() || this.planFilePath;
    this.previewEl.textContent = fileName;
    this.previewEl.setAttribute('title', this.planFilePath);
    this.previewEl.style.display = 'inline';

    this.toggleBtn.textContent = 'Exit';
    this.toggleBtn.setAttribute('aria-label', 'Exit Plan Mode');
  } else {
    this.badgeEl.style.background = PLAN_MODE_BADGE_INACTIVE_BG;
    this.badgeEl.style.color = PLAN_MODE_BADGE_INACTIVE_COLOR;
    this.badgeEl.style.borderColor = PLAN_MODE_BADGE_INACTIVE_BORDER;
    this.badgeEl.setAttribute('aria-label', 'Plan Mode inactive');

    this.previewEl.style.display = 'none';
    this.previewEl.textContent = '';
    this.previewEl.setAttribute('title', '');

    this.toggleBtn.textContent = 'Enter';
    this.toggleBtn.setAttribute('aria-label', 'Enter Plan Mode');
  }
};

/**
 * Handle toggle button click — enters or exits plan mode via IPC.
 */
PlanModeIndicator.prototype.handleToggle = function () {
  var self = this;
  var api = pmEapi();
  if (!api) return;

  api.invoke('plan-mode:toggle').then(function (result) {
    if (result && typeof result === 'object') {
      self.updateUI(result.active, result.planFilePath || '');
    }
  }).catch(function (err) {
    console.warn('[plan-mode-indicator] toggle failed:', err && err.message ? err.message : err);
  });
};

/**
 * Clean up listeners and DOM.
 */
PlanModeIndicator.prototype.destroy = function () {
  var api = pmEapi();
  if (api && this._stateListener) {
    api.removeListener('plan-mode:state-update', this._stateListener);
  }
  this._stateListener = null;
  this.container.innerHTML = '';
};

// ─── /plan Slash Command ───────────────────────────────────────────

/**
 * PlanSlashCommand — handles the `/plan` chat slash command.
 *
 * Detection:
 *   - `/plan` (exact) → show help
 *   - `/plan <file-path>` → enter plan mode with specified file
 *   - `/plan off` → exit plan mode
 *
 * Returns:
 *   - { kind: 'not_a_command' } — message is not a /plan command
 *   - { kind: 'help_emitted' } — help was displayed
 *   - { kind: 'toggled', active, planFilePath } — plan mode was toggled
 *   - { kind: 'error', message } — toggle failed
 */
var PlanSlashCommand = {
  /**
   * Handle a raw message and check if it's a /plan command.
   *
   * @param rawMessage - The user's raw input message
   * @param ctx - Context with adapter for rendering responses
   * @returns Result indicating what happened
   */
  handle: function (rawMessage, ctx) {
    // Help branch — exact `/plan`
    if (rawMessage === PLAN_COMMAND_EXACT) {
      if (ctx && ctx.adapter && ctx.adapter.renderHelp) {
        ctx.adapter.renderHelp(PLAN_HELP_TEXT);
      }
      return Promise.resolve({ kind: 'help_emitted' });
    }

    // Command branch — `/plan <arg>`
    if (rawMessage.startsWith(PLAN_COMMAND_PREFIX)) {
      var arg = rawMessage.slice(PLAN_COMMAND_PREFIX.length).trim();

      if (!arg) {
        if (ctx && ctx.adapter && ctx.adapter.renderHelp) {
          ctx.adapter.renderHelp(PLAN_HELP_TEXT);
        }
        return Promise.resolve({ kind: 'help_emitted' });
      }

      var api = pmEapi();
      if (!api) {
        return Promise.resolve({ kind: 'error', message: 'electronAPI not available' });
      }

      // `/plan off` — exit plan mode
      if (arg.toLowerCase() === 'off') {
        return api.invoke('plan-mode:toggle').then(function (result) {
          if (result && result.active === false) {
            return { kind: 'toggled', active: false, planFilePath: '' };
          }
          return { kind: 'toggled', active: result ? result.active : false, planFilePath: result ? result.planFilePath || '' : '' };
        }).catch(function (err) {
          return { kind: 'error', message: err && err.message ? err.message : 'Failed to exit plan mode' };
        });
      }

      // `/plan <file-path>` — enter plan mode with given file
      return api.invoke('plan-mode:toggle', { planFilePath: arg }).then(function (result) {
        return {
          kind: 'toggled',
          active: result ? result.active : true,
          planFilePath: result ? result.planFilePath || arg : arg,
        };
      }).catch(function (err) {
        return { kind: 'error', message: err && err.message ? err.message : 'Failed to enter plan mode' };
      });
    }

    // Not a /plan command
    return Promise.resolve({ kind: 'not_a_command' });
  },
};

// ─── Exports ───────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PlanModeIndicator: PlanModeIndicator,
    PlanSlashCommand: PlanSlashCommand,
    PLAN_HELP_TEXT: PLAN_HELP_TEXT,
  };
}

if (typeof window !== 'undefined') {
  window.PlanModeIndicator = PlanModeIndicator;
  window.PlanSlashCommand = PlanSlashCommand;
}
