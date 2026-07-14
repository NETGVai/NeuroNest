/**
 * InteractiveTerminalPanel — Renderer panel for agent-controlled interactive terminal.
 *
 * Renders live terminal state with:
 * - Terminal output displayed in a scrollable monospace container
 * - Agent inputs highlighted in a distinct color (cyan/blue)
 * - Agent decision indicators (waiting for output, about to send input)
 * - Session management: create, close, view active sessions
 *
 * Wires IPC channels: terminal:create, terminal:write, terminal:read, terminal:close
 *
 * Gated behind `interactive_terminal` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as worktree-panel.ts.
 *
 * Requirements: 19.5
 */

// ─── Helpers ───────────────────────────────────────────────────────
function terminalPanelEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function terminalPanelEapi() {
  return window.electronAPI;
}

// ─── Constants ────────────────────────────────────────────────────
var TERMINAL_AGENT_INPUT_COLOR = '#22d3ee';  // cyan-400 — distinguishes agent input
var TERMINAL_OUTPUT_COLOR = '#e2e8f0';       // slate-200 — standard output
var TERMINAL_STATUS_COLORS = {
  active: '#34d399',     // green
  idle: '#fbbf24',       // amber
  timed_out: '#f87171',  // red
  closed: '#6b7280',     // gray
};
var TERMINAL_POLL_INTERVAL_MS = 1000;        // Poll output every 1s during active session
var TERMINAL_MAX_OUTPUT_LINES = 500;         // Keep last 500 lines in the display

// ─── Agent Decision States ────────────────────────────────────────
var AGENT_STATE_IDLE = 'idle';
var AGENT_STATE_WAITING = 'waiting_for_output';
var AGENT_STATE_SENDING = 'about_to_send';

// ─── InteractiveTerminalPanel class ───────────────────────────────
function InteractiveTerminalPanel(container, workspaceId) {
  this.container = container;
  this.workspaceId = workspaceId || 'default';
  this.sessions = [];
  this.activeSessionId = null;
  this.agentState = AGENT_STATE_IDLE;
  this.outputLines = [];
  this.pollTimer = null;
  this.outputArea = null;
  this.statusIndicator = null;
  this.agentStateIndicator = null;
  this.inputHistory = []; // Track agent inputs for highlighting
}

InteractiveTerminalPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Main wrapper
  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;gap:8px;';

  // ── Header ──────────────────────────────────────────────────────
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:0 4px;';

  var titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Interactive Terminal';
  titleRow.appendChild(title);

  // Agent state indicator
  this.agentStateIndicator = document.createElement('span');
  this.agentStateIndicator.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:10px;color:#fff;background:#6b7280;';
  this.agentStateIndicator.setAttribute('data-testid', 'agent-state');
  this.agentStateIndicator.textContent = 'idle';
  titleRow.appendChild(this.agentStateIndicator);

  header.appendChild(titleRow);

  // Header actions
  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;';

  var createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.textContent = 'New Session';
  createBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  createBtn.addEventListener('click', function () { self.createSession(); });
  headerActions.appendChild(createBtn);

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid #f87171;background:rgba(248,113,113,0.1);color:#f87171;border-radius:6px;cursor:pointer;';
  closeBtn.addEventListener('click', function () { self.closeActiveSession(); });
  headerActions.appendChild(closeBtn);

  header.appendChild(headerActions);
  wrapper.appendChild(header);

  // ── Session status bar ──────────────────────────────────────────
  var statusBar = document.createElement('div');
  statusBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:11px;color:var(--text-dim);border-bottom:1px solid var(--border-color);';

  this.statusIndicator = document.createElement('span');
  this.statusIndicator.style.cssText = 'display:flex;align-items:center;gap:4px;';
  this.statusIndicator.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#6b7280;display:inline-block;"></span> No active session';
  statusBar.appendChild(this.statusIndicator);

  wrapper.appendChild(statusBar);

  // ── Terminal output area ────────────────────────────────────────
  this.outputArea = document.createElement('div');
  this.outputArea.style.cssText =
    'flex:1;overflow-y:auto;background:#0f172a;border-radius:6px;padding:8px;' +
    'font-family:"JetBrains Mono","Fira Code","SF Mono","Cascadia Code",monospace;' +
    'font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;' +
    'border:1px solid var(--border-color);min-height:200px;max-height:400px;';
  this.outputArea.setAttribute('role', 'log');
  this.outputArea.setAttribute('aria-label', 'Terminal output');
  this.renderEmptyState();
  wrapper.appendChild(this.outputArea);

  // ── Legend ──────────────────────────────────────────────────────
  var legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:12px;padding:4px 8px;font-size:10px;color:var(--text-dim);';
  legend.innerHTML =
    '<span style="display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;background:' + TERMINAL_AGENT_INPUT_COLOR + ';border-radius:2px;"></span> Agent input</span>' +
    '<span style="display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;background:' + TERMINAL_OUTPUT_COLOR + ';border-radius:2px;"></span> Terminal output</span>';
  wrapper.appendChild(legend);

  this.container.appendChild(wrapper);
};

// ─── Session Management ───────────────────────────────────────────

InteractiveTerminalPanel.prototype.createSession = function () {
  var self = this;
  var eapi = terminalPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('terminal:create', { workspaceId: self.workspaceId });
  } catch (e) {
    self.appendSystemMessage('Failed to create session');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success && result.sessionId) {
      self.activeSessionId = result.sessionId;
      self.outputLines = [];
      self.inputHistory = [];
      self.renderOutputArea();
      self.updateStatus('active', result.sessionId);
      self.appendSystemMessage('Session started: ' + result.sessionId);
      self.startPolling();
    } else {
      var errMsg = (result && result.error) || 'Failed to create session';
      self.appendSystemMessage('Error: ' + errMsg);
    }
  }).catch(function (err) {
    self.appendSystemMessage('Error: ' + (err && err.message ? err.message : 'Create failed'));
  });
};

InteractiveTerminalPanel.prototype.closeActiveSession = function () {
  var self = this;
  if (!self.activeSessionId) {
    self.appendSystemMessage('No active session to close');
    return;
  }

  var eapi = terminalPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var sessionId = self.activeSessionId;
  var p;
  try {
    p = eapi.invoke('terminal:close', { sessionId: sessionId });
  } catch (e) {
    self.appendSystemMessage('Failed to close session');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      self.stopPolling();
      self.activeSessionId = null;
      self.updateStatus('closed', sessionId);
      self.appendSystemMessage('Session closed: ' + sessionId);
      self.setAgentState(AGENT_STATE_IDLE);
    } else {
      var errMsg = (result && result.error) || 'Close failed';
      self.appendSystemMessage('Error: ' + errMsg);
    }
  }).catch(function (err) {
    self.appendSystemMessage('Error: ' + (err && err.message ? err.message : 'Close failed'));
  });
};

// ─── Agent Input Submission (called from external code or UI) ─────

/**
 * Submit agent input to the active session.
 * Highlights the input line in the distinct agent color.
 */
InteractiveTerminalPanel.prototype.sendAgentInput = function (input) {
  var self = this;
  if (!self.activeSessionId) return;

  var eapi = terminalPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  self.setAgentState(AGENT_STATE_SENDING);

  // Record as agent input for highlighting
  self.inputHistory.push(input);
  self.appendAgentInput(input);

  var p;
  try {
    p = eapi.invoke('terminal:write', { sessionId: self.activeSessionId, input: input });
  } catch (e) {
    self.appendSystemMessage('Write failed');
    self.setAgentState(AGENT_STATE_IDLE);
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      self.setAgentState(AGENT_STATE_WAITING);
    } else {
      var errMsg = (result && result.error) || 'Write failed';
      self.appendSystemMessage('Error: ' + errMsg);
      self.setAgentState(AGENT_STATE_IDLE);
    }
  }).catch(function (err) {
    self.appendSystemMessage('Error: ' + (err && err.message ? err.message : 'Write failed'));
    self.setAgentState(AGENT_STATE_IDLE);
  });
};

/**
 * Read output from the active terminal session.
 * Called by the polling loop or manually.
 */
InteractiveTerminalPanel.prototype.readOutput = function () {
  var self = this;
  if (!self.activeSessionId) return;

  var eapi = terminalPanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('terminal:read', { sessionId: self.activeSessionId, timeout: 0 });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success && result.output) {
      var content = result.output.content;
      var status = result.output.status;

      if (content && content.length > 0) {
        self.appendOutput(content);
        // If we got output after being in waiting state, go back to idle
        if (self.agentState === AGENT_STATE_WAITING) {
          self.setAgentState(AGENT_STATE_IDLE);
        }
      }

      // Update status if changed
      if (status && status !== 'active') {
        self.updateStatus(status, self.activeSessionId);
        if (status === 'closed' || status === 'timed_out') {
          self.stopPolling();
        }
      }
    }
  }).catch(function () {
    // Silent — polling errors are non-fatal
  });
};

// ─── Polling ──────────────────────────────────────────────────────

InteractiveTerminalPanel.prototype.startPolling = function () {
  var self = this;
  self.stopPolling();
  self.pollTimer = setInterval(function () {
    self.readOutput();
  }, TERMINAL_POLL_INTERVAL_MS);
};

InteractiveTerminalPanel.prototype.stopPolling = function () {
  if (this.pollTimer) {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
};

// ─── Display Methods ──────────────────────────────────────────────

InteractiveTerminalPanel.prototype.renderEmptyState = function () {
  if (!this.outputArea) return;
  this.outputArea.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:16px;text-align:center;">No active terminal session.<br>Click "New Session" to start an interactive terminal.</div>';
};

InteractiveTerminalPanel.prototype.renderOutputArea = function () {
  if (!this.outputArea) return;
  this.outputArea.innerHTML = '';
};

InteractiveTerminalPanel.prototype.appendOutput = function (text) {
  if (!this.outputArea) return;

  // Remove empty state if present
  var emptyState = this.outputArea.querySelector('div[style*="text-align:center"]');
  if (emptyState) emptyState.remove();

  var span = document.createElement('span');
  span.style.cssText = 'color:' + TERMINAL_OUTPUT_COLOR + ';';
  span.textContent = text;
  this.outputArea.appendChild(span);

  // Track lines for buffer management
  var newLines = text.split('\n');
  var i;
  for (i = 0; i < newLines.length; i++) {
    this.outputLines.push({ type: 'output', text: newLines[i] });
  }

  // Prune if over max lines
  this.pruneOutput();

  // Auto-scroll to bottom
  this.outputArea.scrollTop = this.outputArea.scrollHeight;
};

InteractiveTerminalPanel.prototype.appendAgentInput = function (input) {
  if (!this.outputArea) return;

  // Remove empty state if present
  var emptyState = this.outputArea.querySelector('div[style*="text-align:center"]');
  if (emptyState) emptyState.remove();

  var wrapper = document.createElement('span');
  wrapper.style.cssText = 'display:inline;';

  // Agent input indicator
  var indicator = document.createElement('span');
  indicator.style.cssText = 'color:' + TERMINAL_AGENT_INPUT_COLOR + ';font-weight:600;opacity:0.7;';
  indicator.textContent = '\u25B6 '; // ▶ arrow
  wrapper.appendChild(indicator);

  var span = document.createElement('span');
  span.style.cssText = 'color:' + TERMINAL_AGENT_INPUT_COLOR + ';font-weight:600;';
  span.textContent = input;
  wrapper.appendChild(span);

  this.outputArea.appendChild(wrapper);

  this.outputLines.push({ type: 'agent_input', text: input });
  this.pruneOutput();

  // Auto-scroll to bottom
  this.outputArea.scrollTop = this.outputArea.scrollHeight;
};

InteractiveTerminalPanel.prototype.appendSystemMessage = function (msg) {
  if (!this.outputArea) return;

  // Remove empty state if present
  var emptyState = this.outputArea.querySelector('div[style*="text-align:center"]');
  if (emptyState) emptyState.remove();

  var div = document.createElement('div');
  div.style.cssText = 'color:#a78bfa;font-style:italic;font-size:11px;padding:2px 0;';
  div.textContent = '[system] ' + msg;
  this.outputArea.appendChild(div);

  this.outputLines.push({ type: 'system', text: msg });
  this.pruneOutput();

  // Auto-scroll to bottom
  this.outputArea.scrollTop = this.outputArea.scrollHeight;
};

InteractiveTerminalPanel.prototype.pruneOutput = function () {
  // Keep only the last TERMINAL_MAX_OUTPUT_LINES entries in the DOM
  if (!this.outputArea) return;
  while (this.outputArea.childNodes.length > TERMINAL_MAX_OUTPUT_LINES) {
    this.outputArea.removeChild(this.outputArea.firstChild);
  }
  while (this.outputLines.length > TERMINAL_MAX_OUTPUT_LINES) {
    this.outputLines.shift();
  }
};

// ─── Status Updates ───────────────────────────────────────────────

InteractiveTerminalPanel.prototype.updateStatus = function (status, sessionId) {
  if (!this.statusIndicator) return;

  var color = TERMINAL_STATUS_COLORS[status] || '#6b7280';
  var label = status || 'unknown';
  var shortId = sessionId ? sessionId.slice(-8) : '';

  this.statusIndicator.innerHTML =
    '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';display:inline-block;"></span> ' +
    '<span>' + terminalPanelEscHtml(label) + '</span>' +
    (shortId ? ' <span style="font-family:monospace;opacity:0.7;">(' + terminalPanelEscHtml(shortId) + ')</span>' : '');
};

InteractiveTerminalPanel.prototype.setAgentState = function (state) {
  this.agentState = state;
  if (!this.agentStateIndicator) return;

  var bgColor;
  var label;
  switch (state) {
    case AGENT_STATE_WAITING:
      bgColor = '#fbbf24'; // amber
      label = 'waiting for output';
      break;
    case AGENT_STATE_SENDING:
      bgColor = TERMINAL_AGENT_INPUT_COLOR;
      label = 'sending input';
      break;
    default:
      bgColor = '#6b7280';
      label = 'idle';
  }

  this.agentStateIndicator.style.background = bgColor;
  this.agentStateIndicator.textContent = label;
};

// ─── Cleanup ──────────────────────────────────────────────────────

InteractiveTerminalPanel.prototype.destroy = function () {
  this.stopPolling();
  this.activeSessionId = null;
  this.outputLines = [];
  this.inputHistory = [];
};

// ─── Convenience entry point ──────────────────────────────────────
function renderInteractiveTerminalPanel(container, workspaceId) {
  var panel = new InteractiveTerminalPanel(container, workspaceId);
  panel.render();
  return panel;
}

// Expose to renderer global scope so index.ts can attach the panel
// without going through ES modules.
if (typeof window !== 'undefined') {
  window.InteractiveTerminalPanel = InteractiveTerminalPanel;
  window.renderInteractiveTerminalPanel = renderInteractiveTerminalPanel;
}
