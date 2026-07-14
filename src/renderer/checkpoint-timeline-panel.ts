/**
 * CheckpointTimelinePanel — Renderer widget for visual checkpoint timeline.
 *
 * Displays a horizontal scrollable timeline with checkpoint markers.
 * Shows metadata on hover: timestamp, active agent, files affected, description.
 * Provides one-click restore with confirmation dialog (reverts all changes after that point).
 * Supports star/pin toggle to prevent automatic pruning.
 *
 * Wires IPC channels: checkpoint:timeline, checkpoint:restore, checkpoint:star
 *
 * Gated behind `checkpoint_timeline` feature flag (requires `checkpoint`).
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as diff-viewer-panel.ts.
 *
 * Requirements: 16.1, 16.3, 16.4, 16.7
 */

// ─── Helpers ───────────────────────────────────────────────────────
function cpTimelineEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function cpTimelineEapi() {
  return window.electronAPI;
}

function cpTimelineFormatTime(ts) {
  if (!ts) return '--';
  var d = new Date(ts);
  var h = d.getHours();
  var m = d.getMinutes();
  var s = d.getSeconds();
  return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

function cpTimelineFormatDate(ts) {
  if (!ts) return '--';
  var d = new Date(ts);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + cpTimelineFormatTime(ts);
}

// ─── Trigger label map ────────────────────────────────────────────
var CP_TRIGGER_LABELS = {
  session_start: 'Session Start',
  modification_batch: 'Modification',
  mode_change: 'Mode Change',
};

var CP_TRIGGER_COLORS = {
  session_start: '#60a5fa',
  modification_batch: '#fbbf24',
  mode_change: '#a78bfa',
};

// ─── CheckpointTimelinePanel class ────────────────────────────────

/**
 * Horizontal scrollable timeline widget with checkpoint markers.
 *
 * @param {HTMLElement} container - DOM element to render into
 * @param {string} sessionId - Current session identifier
 *
 * Requirement: 16.1
 */
function CheckpointTimelinePanel(container, sessionId) {
  this.container = container;
  this.sessionId = sessionId || '';
  this.checkpoints = [];
  this.hoveredId = null;
  this.tooltipEl = null;
  this.timelineUpdateHandler = null;
}

CheckpointTimelinePanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header row
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Checkpoint Timeline';
  header.appendChild(title);

  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;align-items:center;';

  // Refresh button
  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.refreshTimeline(); });
  headerActions.appendChild(refreshBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Timeline scrollable container (horizontal)
  this.timelineRoot = document.createElement('div');
  this.timelineRoot.style.cssText = 'position:relative;overflow-x:auto;overflow-y:visible;padding:16px 8px 24px 8px;min-height:60px;';
  this.timelineRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;text-align:center;">Loading timeline...</div>';
  this.container.appendChild(this.timelineRoot);

  // Tooltip (shared, repositioned on hover)
  this.tooltipEl = document.createElement('div');
  this.tooltipEl.style.cssText = 'position:absolute;display:none;z-index:1000;background:var(--bg-secondary,#1e293b);border:1px solid var(--border-color);border-radius:6px;padding:8px 12px;pointer-events:none;white-space:nowrap;font-size:11px;color:var(--text-primary);box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  this.container.style.position = 'relative';
  this.container.appendChild(this.tooltipEl);

  // Listen for real-time updates
  this.cleanupListener();
  this.timelineUpdateHandler = function () {
    self.refreshTimeline();
  };
  cpTimelineEapi().on('checkpoint:timeline-updated', this.timelineUpdateHandler);

  // Initial load
  this.refreshTimeline();
};

/**
 * Fetch timeline data from the main process via IPC.
 */
CheckpointTimelinePanel.prototype.refreshTimeline = function () {
  var self = this;
  var eapi = cpTimelineEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('checkpoint:timeline', { sessionId: self.sessionId });
  } catch (e) {
    self.renderError('Failed to load timeline');
    return;
  }

  Promise.resolve(p).then(function (checkpoints) {
    if (Array.isArray(checkpoints)) {
      self.checkpoints = checkpoints;
      self.renderTimeline();
    } else {
      self.checkpoints = [];
      self.renderTimeline();
    }
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Failed to load timeline');
  });
};

/**
 * Render the horizontal timeline with checkpoint markers.
 * Each checkpoint is a clickable dot on a horizontal line.
 *
 * Requirement: 16.1
 */
CheckpointTimelinePanel.prototype.renderTimeline = function () {
  if (!this.timelineRoot) return;
  this.timelineRoot.innerHTML = '';

  if (this.checkpoints.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;';
    empty.textContent = 'No checkpoints in this session.';
    this.timelineRoot.appendChild(empty);
    return;
  }

  // Timeline track
  var track = document.createElement('div');
  track.style.cssText = 'display:flex;align-items:center;gap:0;min-width:max-content;position:relative;padding:8px 0;';

  // Horizontal line (background)
  var line = document.createElement('div');
  line.style.cssText = 'position:absolute;top:50%;left:16px;right:16px;height:2px;background:var(--border-color,#374151);transform:translateY(-50%);border-radius:1px;';
  track.appendChild(line);

  var self = this;
  for (var i = 0; i < this.checkpoints.length; i++) {
    var cp = this.checkpoints[i];
    var marker = self.renderMarker(cp, i);
    track.appendChild(marker);
  }

  this.timelineRoot.appendChild(track);
};

/**
 * Render a single checkpoint marker on the timeline.
 *
 * Requirements: 16.1, 16.3 (hover metadata)
 */
CheckpointTimelinePanel.prototype.renderMarker = function (cp, index) {
  var self = this;
  var markerWrap = document.createElement('div');
  markerWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;position:relative;z-index:1;min-width:48px;cursor:pointer;';
  markerWrap.setAttribute('data-checkpoint-id', cp.id || '');

  // Dot
  var dotColor = CP_TRIGGER_COLORS[cp.trigger] || '#60a5fa';
  var dotSize = cp.starred ? '14px' : '10px';
  var dot = document.createElement('div');
  dot.style.cssText = 'width:' + dotSize + ';height:' + dotSize + ';border-radius:50%;background:' + dotColor + ';border:2px solid ' + (cp.starred ? '#fbbf24' : 'var(--bg-primary,#0f172a)') + ';transition:transform 0.15s;';
  markerWrap.appendChild(dot);

  // Star indicator
  if (cp.starred) {
    var starIcon = document.createElement('span');
    starIcon.style.cssText = 'position:absolute;top:-12px;font-size:10px;color:#fbbf24;';
    starIcon.textContent = '\u2605';
    markerWrap.appendChild(starIcon);
  }

  // Time label below dot
  var timeLabel = document.createElement('span');
  timeLabel.style.cssText = 'font-size:9px;color:var(--text-dim);margin-top:4px;white-space:nowrap;';
  timeLabel.textContent = cpTimelineFormatTime(cp.createdAt);
  markerWrap.appendChild(timeLabel);

  // Hover events — show metadata tooltip (Requirement 16.3)
  markerWrap.addEventListener('mouseenter', function (e) {
    self.showTooltip(cp, markerWrap);
    dot.style.transform = 'scale(1.3)';
  });
  markerWrap.addEventListener('mouseleave', function () {
    self.hideTooltip();
    dot.style.transform = 'scale(1)';
  });

  // Click — show action menu (restore / star)
  markerWrap.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    self.showActionMenu(cp, markerWrap);
  });

  return markerWrap;
};

/**
 * Show metadata tooltip on hover.
 *
 * Requirement: 16.3 — Show metadata: timestamp, active agent, files affected, description
 */
CheckpointTimelinePanel.prototype.showTooltip = function (cp, anchorEl) {
  if (!this.tooltipEl) return;

  var html = '';
  html += '<div style="font-weight:600;margin-bottom:4px;">' + cpTimelineEscHtml(cp.description || 'Checkpoint') + '</div>';
  html += '<div style="color:var(--text-dim);">Time: ' + cpTimelineFormatDate(cp.createdAt) + '</div>';
  if (cp.agentId) {
    html += '<div style="color:var(--text-dim);">Agent: <span style="color:#60a5fa;">' + cpTimelineEscHtml(cp.agentId) + '</span></div>';
  }
  html += '<div style="color:var(--text-dim);">Files affected: ' + (cp.filesAffected || 0) + '</div>';
  var triggerLabel = CP_TRIGGER_LABELS[cp.trigger] || cp.trigger || 'Unknown';
  html += '<div style="color:var(--text-dim);">Trigger: ' + cpTimelineEscHtml(triggerLabel) + '</div>';
  if (cp.starred) {
    html += '<div style="color:#fbbf24;margin-top:4px;">\u2605 Starred (protected from pruning)</div>';
  }

  this.tooltipEl.innerHTML = html;
  this.tooltipEl.style.display = 'block';

  // Position tooltip above the marker
  var containerRect = this.container.getBoundingClientRect();
  var anchorRect = anchorEl.getBoundingClientRect();
  var left = anchorRect.left - containerRect.left + (anchorRect.width / 2);
  var top = anchorRect.top - containerRect.top - 8;

  this.tooltipEl.style.left = left + 'px';
  this.tooltipEl.style.top = top + 'px';
  this.tooltipEl.style.transform = 'translate(-50%, -100%)';
};

CheckpointTimelinePanel.prototype.hideTooltip = function () {
  if (this.tooltipEl) {
    this.tooltipEl.style.display = 'none';
  }
};

/**
 * Show an action menu for restore and star toggle.
 *
 * Requirements: 16.4 (one-click restore), 16.7 (star toggle)
 */
CheckpointTimelinePanel.prototype.showActionMenu = function (cp, anchorEl) {
  var self = this;

  // Remove any existing action menu
  var existing = this.container.querySelector('.cp-timeline-action-menu');
  if (existing) existing.remove();

  var menu = document.createElement('div');
  menu.className = 'cp-timeline-action-menu';
  menu.style.cssText = 'position:absolute;z-index:1001;background:var(--bg-secondary,#1e293b);border:1px solid var(--border-color);border-radius:6px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;flex-direction:column;gap:2px;';

  // Restore button (Requirement 16.4)
  var restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.textContent = '\u21ba Restore';
  restoreBtn.style.cssText = 'font-size:11px;padding:6px 12px;border:none;background:transparent;color:var(--text-primary);text-align:left;border-radius:4px;cursor:pointer;white-space:nowrap;';
  restoreBtn.addEventListener('mouseenter', function () { restoreBtn.style.background = 'rgba(96,165,250,0.15)'; });
  restoreBtn.addEventListener('mouseleave', function () { restoreBtn.style.background = 'transparent'; });
  restoreBtn.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    menu.remove();
    self.confirmRestore(cp);
  });
  menu.appendChild(restoreBtn);

  // Star/Unstar button (Requirement 16.7 — star/pin toggle)
  var starBtn = document.createElement('button');
  starBtn.type = 'button';
  starBtn.textContent = cp.starred ? '\u2606 Unstar' : '\u2605 Star';
  starBtn.style.cssText = 'font-size:11px;padding:6px 12px;border:none;background:transparent;color:' + (cp.starred ? 'var(--text-primary)' : '#fbbf24') + ';text-align:left;border-radius:4px;cursor:pointer;white-space:nowrap;';
  starBtn.addEventListener('mouseenter', function () { starBtn.style.background = 'rgba(251,191,36,0.15)'; });
  starBtn.addEventListener('mouseleave', function () { starBtn.style.background = 'transparent'; });
  starBtn.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    menu.remove();
    self.toggleStar(cp);
  });
  menu.appendChild(starBtn);

  // Position menu below the marker
  var containerRect = this.container.getBoundingClientRect();
  var anchorRect = anchorEl.getBoundingClientRect();
  var left = anchorRect.left - containerRect.left + (anchorRect.width / 2);
  var top = anchorRect.bottom - containerRect.top + 4;

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.transform = 'translateX(-50%)';

  this.container.appendChild(menu);

  // Close menu on outside click
  var closeHandler = function (e) {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(function () {
    document.addEventListener('click', closeHandler, true);
  }, 0);
};

/**
 * Confirm and execute a checkpoint restore.
 * One-click restore with confirmation dialog that reverts all changes after selected checkpoint.
 *
 * Requirement: 16.4
 */
CheckpointTimelinePanel.prototype.confirmRestore = function (cp) {
  var self = this;
  var desc = cp.description || 'Checkpoint';
  var time = cpTimelineFormatDate(cp.createdAt);
  var msg = 'Restore to "' + desc + '"?\n\n' +
    'Time: ' + time + '\n' +
    'This will revert ALL changes made after this checkpoint.\n\n' +
    'This action cannot be undone.';

  if (!window.confirm(msg)) return;

  var eapi = cpTimelineEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('checkpoint:restore', { sessionId: self.sessionId, checkpointId: cp.id });
  } catch (e) {
    self.showError('Restore request failed');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      self.refreshTimeline();
    } else {
      var errMsg = (result && result.error) || 'Restore failed';
      self.showError(errMsg);
    }
  }).catch(function (err) {
    self.showError(err && err.message ? err.message : 'Restore failed');
  });
};

/**
 * Toggle star/pin on a checkpoint to prevent automatic pruning.
 *
 * Requirement: 16.7 (via star/pin to prevent pruning)
 */
CheckpointTimelinePanel.prototype.toggleStar = function (cp) {
  var self = this;
  var eapi = cpTimelineEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('checkpoint:star', { checkpointId: cp.id, starred: !cp.starred });
  } catch (e) {
    self.showError('Star toggle failed');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      // Update local state immediately for responsiveness
      cp.starred = !cp.starred;
      self.renderTimeline();
    } else {
      var errMsg = (result && result.error) || 'Star toggle failed';
      self.showError(errMsg);
    }
  }).catch(function (err) {
    self.showError(err && err.message ? err.message : 'Star toggle failed');
  });
};

// ─── Error display ────────────────────────────────────────────────
CheckpointTimelinePanel.prototype.showError = function (message) {
  if (!this.timelineRoot) return;

  var existing = this.timelineRoot.querySelector('.cp-timeline-error');
  if (existing) existing.remove();

  var errDiv = document.createElement('div');
  errDiv.className = 'cp-timeline-error';
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:6px 8px;text-align:center;';
  errDiv.textContent = message || 'Error';
  this.timelineRoot.appendChild(errDiv);

  setTimeout(function () { if (errDiv.parentNode) errDiv.remove(); }, 5000);
};

CheckpointTimelinePanel.prototype.renderError = function (message) {
  if (!this.timelineRoot) return;
  this.timelineRoot.innerHTML = '';
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:16px 8px;text-align:center;';
  errDiv.textContent = message || 'Error loading timeline';
  this.timelineRoot.appendChild(errDiv);
};

// ─── Cleanup ──────────────────────────────────────────────────────
CheckpointTimelinePanel.prototype.cleanupListener = function () {
  if (this.timelineUpdateHandler) {
    try { cpTimelineEapi().removeListener('checkpoint:timeline-updated', this.timelineUpdateHandler); } catch (e) {}
    this.timelineUpdateHandler = null;
  }
};

CheckpointTimelinePanel.prototype.destroy = function () {
  this.cleanupListener();
};

// ─── Convenience entry point ──────────────────────────────────────
function renderCheckpointTimelinePanel(container, sessionId) {
  var panel = new CheckpointTimelinePanel(container, sessionId);
  panel.render();
  return panel;
}

// Expose to renderer global scope
if (typeof window !== 'undefined') {
  window.CheckpointTimelinePanel = CheckpointTimelinePanel;
  window.renderCheckpointTimelinePanel = renderCheckpointTimelinePanel;
}
