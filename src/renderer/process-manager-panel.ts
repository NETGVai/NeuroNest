/**
 * ProcessManagerPanel — Renderer panel for managing background processes.
 *
 * Displays all active background processes with:
 * - Status badge (running, stopped, crashed, restarting)
 * - Process name, command, PID, port
 * - Start/Stop/Restart action buttons
 * - Expandable log output per process
 *
 * Wires IPC channels: process:start, process:stop, process:list,
 * process:logs, process:status
 *
 * Gated behind `background_processes` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as worktree-panel.ts.
 *
 * Requirements: 11.3
 */

// ─── Helpers ───────────────────────────────────────────────────────
function processPanelEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function processPanelEapi() {
  return window.electronAPI;
}

// ─── Status badge colors ──────────────────────────────────────────
var PROCESS_STATUS_COLORS = {
  running: '#34d399',    // green
  stopped: '#6b7280',   // gray
  crashed: '#f87171',   // red
  restarting: '#fbbf24', // amber
};

// ─── ProcessManagerPanel class ────────────────────────────────────
function ProcessManagerPanel(container) {
  this.container = container;
  this.processes = [];
  this.expandedLogs = {}; // Track which processes have expanded logs
  this.statusHandler = null;
  this.refreshTimer = null;
}

ProcessManagerPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Background Processes';
  header.appendChild(title);

  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;';

  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.refreshProcesses(); });
  headerActions.appendChild(refreshBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Process list container
  this.listRoot = document.createElement('div');
  this.listRoot.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
  this.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Loading processes...</div>';
  this.container.appendChild(this.listRoot);

  // Start listening for real-time updates
  this.subscribeToUpdates();

  // Initial data fetch
  this.refreshProcesses();

  // Auto-refresh every 10 seconds
  this.refreshTimer = setInterval(function () { self.refreshProcesses(); }, 10000);
};

ProcessManagerPanel.prototype.destroy = function () {
  if (this.refreshTimer) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
  if (this.statusHandler) {
    var api = processPanelEapi();
    if (api && api.removeListener) {
      api.removeListener('process:status-update', this.statusHandler);
    }
    this.statusHandler = null;
  }
};

ProcessManagerPanel.prototype.subscribeToUpdates = function () {
  var self = this;
  this.statusHandler = function (data) {
    // On any process status update, refresh the list
    self.refreshProcesses();
  };
  var api = processPanelEapi();
  if (api && api.on) {
    api.on('process:status-update', this.statusHandler);
  }
};

ProcessManagerPanel.prototype.refreshProcesses = function () {
  var self = this;
  var api = processPanelEapi();
  if (!api) return;

  api.invoke('process:list').then(function (result) {
    if (result && result.success && result.processes) {
      self.processes = result.processes;
      self.renderProcessList();
    } else if (result && result.flagDisabled) {
      self.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Background processes feature is disabled.</div>';
    } else {
      self.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Failed to load processes.</div>';
    }
  }).catch(function () {
    self.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Error fetching processes.</div>';
  });
};

ProcessManagerPanel.prototype.renderProcessList = function () {
  var self = this;
  this.listRoot.innerHTML = '';

  if (this.processes.length === 0) {
    this.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">No background processes.</div>';
    return;
  }

  for (var i = 0; i < this.processes.length; i++) {
    var proc = this.processes[i];
    var card = this.renderProcessCard(proc);
    this.listRoot.appendChild(card);
  }
};

ProcessManagerPanel.prototype.renderProcessCard = function (proc) {
  var self = this;
  var card = document.createElement('div');
  card.style.cssText = 'border:1px solid var(--border-color);border-radius:8px;padding:10px 12px;background:var(--bg-panel);';
  card.setAttribute('data-process-id', proc.id);

  // ─── Top row: Name + Status badge ───────────────────────
  var topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';

  var nameEl = document.createElement('span');
  nameEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
  nameEl.textContent = proc.name;
  topRow.appendChild(nameEl);

  var badge = document.createElement('span');
  var badgeColor = PROCESS_STATUS_COLORS[proc.status] || '#6b7280';
  badge.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:10px;background:' + badgeColor + '22;color:' + badgeColor + ';font-weight:500;';
  badge.textContent = proc.status;
  topRow.appendChild(badge);

  card.appendChild(topRow);

  // ─── Detail row: command, PID, port ─────────────────────
  var detailRow = document.createElement('div');
  detailRow.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.5;';

  var details = [];
  details.push('Command: ' + processPanelEscHtml(proc.command));
  if (proc.pid) details.push('PID: ' + proc.pid);
  if (proc.port) details.push('Port: ' + proc.port);
  if (proc.startedAt) {
    var uptime = Date.now() - proc.startedAt;
    var uptimeStr = self.formatUptime(uptime);
    if (proc.status === 'running') details.push('Uptime: ' + uptimeStr);
  }
  detailRow.innerHTML = details.join(' &middot; ');
  card.appendChild(detailRow);

  // ─── Action buttons ─────────────────────────────────────
  var actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';

  if (proc.status === 'running' || proc.status === 'restarting') {
    var stopBtn = self.createActionButton('Stop', '#f87171', function () {
      self.stopProcess(proc.id);
    });
    actionsRow.appendChild(stopBtn);

    var restartBtn = self.createActionButton('Restart', '#fbbf24', function () {
      self.restartProcess(proc.id);
    });
    actionsRow.appendChild(restartBtn);
  } else {
    var startBtn = self.createActionButton('Start', '#34d399', function () {
      self.startProcess(proc);
    });
    actionsRow.appendChild(startBtn);
  }

  var logsBtn = self.createActionButton('Logs', '#60a5fa', function () {
    self.toggleLogs(proc.id, card);
  });
  actionsRow.appendChild(logsBtn);

  card.appendChild(actionsRow);

  // ─── Expandable log output ──────────────────────────────
  var logContainer = document.createElement('div');
  logContainer.style.cssText = 'display:none;';
  logContainer.setAttribute('data-log-container', proc.id);
  card.appendChild(logContainer);

  // If logs were previously expanded, show them
  if (self.expandedLogs[proc.id]) {
    self.showLogs(proc.id, logContainer);
  }

  return card;
};

ProcessManagerPanel.prototype.createActionButton = function (label, color, onClick) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.style.cssText = 'font-size:10px;padding:3px 8px;border:1px solid ' + color + '44;background:' + color + '11;color:' + color + ';border-radius:4px;cursor:pointer;font-weight:500;';
  btn.addEventListener('click', onClick);
  return btn;
};

ProcessManagerPanel.prototype.stopProcess = function (id) {
  var self = this;
  var api = processPanelEapi();
  if (!api) return;

  api.invoke('process:stop', { id: id }).then(function (result) {
    if (result && result.success) {
      self.refreshProcesses();
    } else {
      console.warn('[ProcessPanel] Stop failed:', result && result.error);
    }
  }).catch(function (err) {
    console.error('[ProcessPanel] Stop error:', err);
  });
};

ProcessManagerPanel.prototype.restartProcess = function (id) {
  var self = this;
  var api = processPanelEapi();
  if (!api) return;

  // Restart: stop then start (the IPC doesn't have a restart channel,
  // but the manager handles restart via stop + start with same config)
  // For now, we'll just stop and let the user start again, OR we implement
  // it via the manager's restart method through a process:start call
  // Actually - let's just stop it. The BackgroundProcessManager's restart
  // will be triggered from the main process event handling if autoRestart is on.
  // For UI-driven restart, we stop, refresh to get the stopped state, then start.
  api.invoke('process:stop', { id: id }).then(function (stopResult) {
    if (!stopResult || !stopResult.success) {
      console.warn('[ProcessPanel] Restart (stop phase) failed:', stopResult && stopResult.error);
      return;
    }
    // Find the process config to restart
    var proc = null;
    for (var i = 0; i < self.processes.length; i++) {
      if (self.processes[i].id === id) {
        proc = self.processes[i];
        break;
      }
    }
    if (proc) {
      // Small delay to allow the process to fully terminate
      setTimeout(function () {
        api.invoke('process:start', {
          name: proc.name,
          command: proc.command,
          cwd: proc.cwd,
          port: proc.port,
        }).then(function () {
          self.refreshProcesses();
        });
      }, 500);
    }
  }).catch(function (err) {
    console.error('[ProcessPanel] Restart error:', err);
  });
};

ProcessManagerPanel.prototype.startProcess = function (proc) {
  var self = this;
  var api = processPanelEapi();
  if (!api) return;

  api.invoke('process:start', {
    name: proc.name,
    command: proc.command,
    cwd: proc.cwd,
    port: proc.port,
  }).then(function (result) {
    if (result && result.success) {
      self.refreshProcesses();
    } else {
      console.warn('[ProcessPanel] Start failed:', result && result.error);
    }
  }).catch(function (err) {
    console.error('[ProcessPanel] Start error:', err);
  });
};

ProcessManagerPanel.prototype.toggleLogs = function (id, card) {
  var logContainer = card.querySelector('[data-log-container="' + id + '"]');
  if (!logContainer) return;

  if (this.expandedLogs[id]) {
    // Collapse
    logContainer.style.display = 'none';
    logContainer.innerHTML = '';
    delete this.expandedLogs[id];
  } else {
    // Expand
    this.expandedLogs[id] = true;
    this.showLogs(id, logContainer);
  }
};

ProcessManagerPanel.prototype.showLogs = function (id, logContainer) {
  var self = this;
  var api = processPanelEapi();
  if (!api) return;

  logContainer.style.display = 'block';
  logContainer.innerHTML = '<div style="font-size:10px;color:var(--text-dim);padding:4px;">Loading logs...</div>';

  api.invoke('process:logs', { id: id, lineCount: 50 }).then(function (result) {
    if (result && result.success && result.logs) {
      self.renderLogs(logContainer, result.logs);
    } else {
      logContainer.innerHTML = '<div style="font-size:10px;color:var(--text-dim);padding:4px;">No logs available.</div>';
    }
  }).catch(function () {
    logContainer.innerHTML = '<div style="font-size:10px;color:#f87171;padding:4px;">Error loading logs.</div>';
  });
};

ProcessManagerPanel.prototype.renderLogs = function (container, logs) {
  container.innerHTML = '';

  var logBox = document.createElement('pre');
  logBox.style.cssText = 'font-size:10px;font-family:monospace;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;padding:8px;max-height:200px;overflow-y:auto;margin:4px 0 0 0;white-space:pre-wrap;word-break:break-all;color:var(--text-primary);line-height:1.4;';

  if (logs.length === 0) {
    logBox.textContent = '(no output captured)';
  } else {
    logBox.textContent = logs.join('\n');
    // Auto-scroll to bottom
    setTimeout(function () { logBox.scrollTop = logBox.scrollHeight; }, 0);
  }

  container.appendChild(logBox);
};

ProcessManagerPanel.prototype.formatUptime = function (ms) {
  if (ms < 1000) return ms + 'ms';
  var seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  var hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
};

// ─── Export for renderer usage ────────────────────────────────────
if (typeof window !== 'undefined') {
  (window as any).ProcessManagerPanel = ProcessManagerPanel;
}

export { ProcessManagerPanel };
