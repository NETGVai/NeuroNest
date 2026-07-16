// @ts-nocheck
/**
 * CheckpointTimelineV2Panel — Extended checkpoint timeline with hunk attribution,
 * per-call rewind buttons, and Loop receipts.
 *
 * Extends the existing CheckpointTimelinePanel with:
 * - Hunk attribution showing agent, tool-call ID, and pass number per event
 * - Per-call "Rewind" button with inline external-hunk conflict confirmation
 * - Loop receipts section (rewind availability, blob hashes, post-verify tree hashes)
 *
 * IPC channels:
 *   - `checkpoint:timeline-v2`    — Get extended timeline events with hunk attribution
 *   - `checkpoint:rewind-preview` — Get rewind preview for a tool call
 *   - `checkpoint:rewind-execute` — Execute rewind (with optional force/confirmation)
 *
 * Gated behind `checkpoint_timeline` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as checkpoint-timeline-panel.ts.
 *
 * Validates: Requirements 14.8, 14.9, 14.10, 14.11, 14.13
 */

// ─── Helpers ───────────────────────────────────────────────────────
function cpV2EscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function cpV2Eapi() {
  return window.electronAPI;
}

function cpV2FormatTime(ts) {
  if (!ts) return '--';
  var d = new Date(ts);
  var h = d.getHours();
  var m = d.getMinutes();
  var sec = d.getSeconds();
  return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m) + ':' + (sec < 10 ? '0' + sec : sec);
}

function cpV2FormatDate(ts) {
  if (!ts) return '--';
  var d = new Date(ts);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + cpV2FormatTime(ts);
}

function cpV2TruncateHash(hash) {
  if (!hash) return '--';
  return hash.substring(0, 8) + '...';
}

// ─── Attribution kind labels and colors ───────────────────────────
var CPV2_KIND_LABELS = {
  agent: 'Agent',
  'tool-call': 'Tool Call',
  pass: 'Pass',
  external: 'External',
};

var CPV2_KIND_COLORS = {
  agent: '#60a5fa',
  'tool-call': '#34d399',
  pass: '#a78bfa',
  external: '#f87171',
};

// ─── CheckpointTimelineV2Panel class ──────────────────────────────

/**
 * Extended checkpoint timeline panel with hunk attribution, per-call rewind,
 * and Loop receipts.
 *
 * @param {HTMLElement} container - DOM element to render into
 * @param {string} sessionId - Current session identifier
 *
 * Validates: Requirements 14.8, 14.9
 */
function CheckpointTimelineV2Panel(container, sessionId) {
  this.container = container;
  this.sessionId = sessionId || '';
  this.events = [];
  this.receipts = null;
  this.timelineUpdateHandler = null;
  this.confirmingCallId = null;
  this.conflictFiles = [];
}

CheckpointTimelineV2Panel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';
  this.container.style.position = 'relative';

  // Header row
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Checkpoint Timeline v2';
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

  // Toggle receipts button
  var receiptsBtn = document.createElement('button');
  receiptsBtn.type = 'button';
  receiptsBtn.textContent = 'Receipts';
  receiptsBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  receiptsBtn.addEventListener('click', function () { self.toggleReceipts(); });
  headerActions.appendChild(receiptsBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Timeline events container (vertical list)
  this.timelineRoot = document.createElement('div');
  this.timelineRoot.style.cssText = 'overflow-y:auto;max-height:400px;padding:4px 0;';
  this.timelineRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;text-align:center;">Loading timeline...</div>';
  this.container.appendChild(this.timelineRoot);

  // Receipts section (hidden by default)
  this.receiptsRoot = document.createElement('div');
  this.receiptsRoot.style.cssText = 'display:none;margin-top:12px;border-top:1px solid var(--border-color);padding-top:8px;';
  this.container.appendChild(this.receiptsRoot);

  // Inline confirmation dialog (hidden by default)
  this.confirmDialog = document.createElement('div');
  this.confirmDialog.style.cssText = 'display:none;position:absolute;z-index:1001;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg-secondary,#1e293b);border:1px solid var(--border-color);border-radius:8px;padding:16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:380px;width:90%;';
  this.container.appendChild(this.confirmDialog);

  // Listen for real-time updates
  this.cleanupListener();
  this.timelineUpdateHandler = function () { self.refreshTimeline(); };
  cpV2Eapi().on('checkpoint:timeline-v2-updated', this.timelineUpdateHandler);

  // Initial load
  this.refreshTimeline();
};

/**
 * Fetch extended timeline data with hunk attribution from main process.
 *
 * Validates: Requirement 14.9 — timeline events carry attribution
 */
CheckpointTimelineV2Panel.prototype.refreshTimeline = function () {
  var self = this;
  var eapi = cpV2Eapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('checkpoint:timeline-v2', { sessionId: self.sessionId });
  } catch (e) {
    self.renderError('Failed to load timeline');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && Array.isArray(result.events)) {
      self.events = result.events;
      self.receipts = result.receipts || null;
      self.renderEvents();
    } else {
      self.events = [];
      self.receipts = null;
      self.renderEvents();
    }
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Failed to load timeline');
  });
};

/**
 * Render the vertical event list with hunk attribution.
 *
 * Each event shows: timestamp, kind badge, agent/tool-call/pass info,
 * files affected, and a Rewind button for tool-call events.
 *
 * Validates: Requirements 14.8, 14.9
 */
CheckpointTimelineV2Panel.prototype.renderEvents = function () {
  if (!this.timelineRoot) return;
  this.timelineRoot.innerHTML = '';

  if (this.events.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;';
    empty.textContent = 'No timeline events in this session.';
    this.timelineRoot.appendChild(empty);
    return;
  }

  var self = this;
  for (var i = 0; i < this.events.length; i++) {
    var ev = this.events[i];
    var row = self.renderEventRow(ev, i);
    self.timelineRoot.appendChild(row);
  }
};

/**
 * Render a single timeline event row with attribution and rewind button.
 *
 * Validates: Requirements 14.9 (attribution), 14.10 (rewind button)
 */
CheckpointTimelineV2Panel.prototype.renderEventRow = function (ev, index) {
  var self = this;
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-color,#1e293b);transition:background 0.1s;';
  row.addEventListener('mouseenter', function () { row.style.background = 'rgba(96,165,250,0.05)'; });
  row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });

  // Left: timeline dot with kind color
  var kindColor = CPV2_KIND_COLORS[ev.kind] || '#6b7280';
  var dotCol = document.createElement('div');
  dotCol.style.cssText = 'display:flex;flex-direction:column;align-items:center;min-width:12px;padding-top:4px;';
  var dot = document.createElement('div');
  dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:' + kindColor + ';border:2px solid var(--bg-primary,#0f172a);';
  dotCol.appendChild(dot);
  row.appendChild(dotCol);

  // Middle: event info
  var info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';

  // Top line: kind badge + timestamp
  var topLine = document.createElement('div');
  topLine.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;';

  var kindBadge = document.createElement('span');
  var kindLabel = CPV2_KIND_LABELS[ev.kind] || ev.kind || 'Unknown';
  kindBadge.style.cssText = 'font-size:10px;padding:1px 6px;border-radius:3px;background:' + kindColor + '22;color:' + kindColor + ';font-weight:600;';
  kindBadge.textContent = kindLabel;
  topLine.appendChild(kindBadge);

  var timeSpan = document.createElement('span');
  timeSpan.style.cssText = 'font-size:10px;color:var(--text-dim);';
  timeSpan.textContent = cpV2FormatTime(ev.timestamp);
  topLine.appendChild(timeSpan);

  info.appendChild(topLine);

  // Attribution line: agent, tool-call ID, pass number
  var attrLine = document.createElement('div');
  attrLine.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:2px;';
  var attrParts = [];
  if (ev.agentId) attrParts.push('Agent: ' + ev.agentId);
  if (ev.toolCallId) attrParts.push('Call: ' + ev.toolCallId.substring(0, 12));
  if (ev.passNumber != null) attrParts.push('Pass: ' + ev.passNumber);
  attrLine.textContent = attrParts.join(' | ') || 'No attribution';
  info.appendChild(attrLine);

  // Files affected
  if (ev.filesAffected && ev.filesAffected.length > 0) {
    var filesLine = document.createElement('div');
    filesLine.style.cssText = 'font-size:10px;color:var(--text-dim);';
    var fileCount = ev.filesAffected.length;
    var displayFiles = ev.filesAffected.slice(0, 3).join(', ');
    filesLine.textContent = fileCount + ' file' + (fileCount > 1 ? 's' : '') + ': ' + displayFiles + (fileCount > 3 ? '...' : '');
    info.appendChild(filesLine);
  }

  row.appendChild(info);

  // Right: Rewind button (only for tool-call events with rewind available)
  if (ev.kind === 'tool-call' && ev.rewindAvailable) {
    var rewindBtn = document.createElement('button');
    rewindBtn.type = 'button';
    rewindBtn.textContent = '\u21ba Rewind';
    rewindBtn.style.cssText = 'font-size:10px;padding:4px 8px;border:1px solid #f87171;background:transparent;color:#f87171;border-radius:4px;cursor:pointer;white-space:nowrap;flex-shrink:0;';
    rewindBtn.addEventListener('mouseenter', function () { rewindBtn.style.background = 'rgba(248,113,113,0.1)'; });
    rewindBtn.addEventListener('mouseleave', function () { rewindBtn.style.background = 'transparent'; });
    rewindBtn.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      self.initiateRewind(ev.toolCallId);
    });
    row.appendChild(rewindBtn);
  }

  return row;
};

/**
 * Initiate a rewind for a tool call. First fetches a preview to check for conflicts.
 * If external-hunk conflicts exist, shows inline confirmation before proceeding.
 *
 * Validates: Requirements 14.10 (per-call rewind), 14.7 (conflict confirmation)
 */
CheckpointTimelineV2Panel.prototype.initiateRewind = function (toolCallId) {
  var self = this;
  var eapi = cpV2Eapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('checkpoint:rewind-preview', { sessionId: self.sessionId, toolCallId: toolCallId });
  } catch (e) {
    self.showError('Failed to fetch rewind preview');
    return;
  }

  Promise.resolve(p).then(function (preview) {
    if (!preview) {
      self.showError('No rewind data available for this call');
      return;
    }

    if (preview.hasConflicts && preview.conflictingFiles && preview.conflictingFiles.length > 0) {
      // Show inline conflict confirmation
      self.showConflictConfirmation(toolCallId, preview.conflictingFiles, preview.diffs);
    } else {
      // No conflicts — execute immediately
      self.executeRewind(toolCallId, false);
    }
  }).catch(function (err) {
    self.showError(err && err.message ? err.message : 'Rewind preview failed');
  });
};

/**
 * Show inline confirmation dialog when external-hunk conflicts would be destroyed.
 *
 * Validates: Requirement 14.10 — confirm external-hunk conflicts inline
 */
CheckpointTimelineV2Panel.prototype.showConflictConfirmation = function (toolCallId, conflictFiles, diffs) {
  var self = this;
  this.confirmingCallId = toolCallId;
  this.conflictFiles = conflictFiles;

  var dialog = this.confirmDialog;
  dialog.innerHTML = '';
  dialog.style.display = 'block';

  // Title
  var titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:13px;font-weight:600;color:#f87171;margin-bottom:8px;';
  titleEl.textContent = '\u26A0 External Edit Conflicts';
  dialog.appendChild(titleEl);

  // Description
  var desc = document.createElement('div');
  desc.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:12px;';
  desc.textContent = 'Rewinding this tool call will overwrite external edits in the following files:';
  dialog.appendChild(desc);

  // File list
  var fileList = document.createElement('div');
  fileList.style.cssText = 'max-height:120px;overflow-y:auto;margin-bottom:12px;';
  for (var i = 0; i < conflictFiles.length; i++) {
    var fileRow = document.createElement('div');
    fileRow.style.cssText = 'font-size:10px;font-family:monospace;color:var(--text-primary);padding:2px 4px;border-left:2px solid #f87171;margin-bottom:2px;background:rgba(248,113,113,0.05);';
    fileRow.textContent = conflictFiles[i];
    fileList.appendChild(fileRow);
  }
  dialog.appendChild(fileList);

  // Action buttons
  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'font-size:11px;padding:6px 12px;border:1px solid var(--border-color);background:transparent;color:var(--text-secondary);border-radius:4px;cursor:pointer;';
  cancelBtn.addEventListener('click', function () { self.hideConflictConfirmation(); });
  actions.appendChild(cancelBtn);

  var forceBtn = document.createElement('button');
  forceBtn.type = 'button';
  forceBtn.textContent = 'Rewind Anyway';
  forceBtn.style.cssText = 'font-size:11px;padding:6px 12px;border:1px solid #f87171;background:#f8717122;color:#f87171;border-radius:4px;cursor:pointer;font-weight:600;';
  forceBtn.addEventListener('click', function () {
    self.hideConflictConfirmation();
    self.executeRewind(toolCallId, true);
  });
  actions.appendChild(forceBtn);

  dialog.appendChild(actions);
};

/**
 * Hide the inline conflict confirmation dialog.
 */
CheckpointTimelineV2Panel.prototype.hideConflictConfirmation = function () {
  this.confirmingCallId = null;
  this.conflictFiles = [];
  if (this.confirmDialog) {
    this.confirmDialog.style.display = 'none';
    this.confirmDialog.innerHTML = '';
  }
};

/**
 * Execute the rewind operation via IPC.
 *
 * Validates: Requirement 14.10 — execute rewind, refresh timeline after
 */
CheckpointTimelineV2Panel.prototype.executeRewind = function (toolCallId, force) {
  var self = this;
  var eapi = cpV2Eapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('checkpoint:rewind-execute', {
      sessionId: self.sessionId,
      toolCallId: toolCallId,
      force: !!force,
      confirmed: !!force,
    });
  } catch (e) {
    self.showError('Rewind execution failed');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.applied) {
      // Refresh timeline to show restored state
      self.refreshTimeline();
    } else if (result && result.confirmationRequired) {
      // Should not happen with force=true, but handle gracefully
      self.showConflictConfirmation(toolCallId, result.conflictingFiles || [], []);
    } else {
      var errMsg = (result && result.error) || 'Rewind failed';
      self.showError(errMsg);
    }
  }).catch(function (err) {
    self.showError(err && err.message ? err.message : 'Rewind execution failed');
  });
};

/**
 * Toggle the Loop receipts section visibility.
 *
 * Validates: Requirement 14.11 — Loop receipts display
 */
CheckpointTimelineV2Panel.prototype.toggleReceipts = function () {
  if (!this.receiptsRoot) return;

  var isHidden = this.receiptsRoot.style.display === 'none';
  if (isHidden) {
    this.receiptsRoot.style.display = 'block';
    this.renderReceipts();
  } else {
    this.receiptsRoot.style.display = 'none';
  }
};

/**
 * Render the Loop receipts section showing:
 * - Rewind availability per tool call
 * - Blob hashes for snapshotted files
 * - Post-verify tree hash
 *
 * Validates: Requirement 14.11 — Loop receipts record rewind availability,
 *   blob hash, post-verify tree hash
 */
CheckpointTimelineV2Panel.prototype.renderReceipts = function () {
  if (!this.receiptsRoot) return;
  this.receiptsRoot.innerHTML = '';

  var receiptTitle = document.createElement('div');
  receiptTitle.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;';
  receiptTitle.textContent = 'Loop Receipts';
  this.receiptsRoot.appendChild(receiptTitle);

  if (!this.receipts || !this.receipts.entries || this.receipts.entries.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 4px;';
    empty.textContent = 'No receipt data available for this session.';
    this.receiptsRoot.appendChild(empty);
    return;
  }

  // Post-verify tree hash (session-level)
  if (this.receipts.postVerifyTreeHash) {
    var treeHashRow = document.createElement('div');
    treeHashRow.style.cssText = 'font-size:11px;color:var(--text-secondary);padding:4px 8px;margin-bottom:8px;background:rgba(167,139,250,0.08);border-radius:4px;';
    treeHashRow.innerHTML = '<span style="font-weight:600;">Post-verify tree hash:</span> <code style="font-family:monospace;font-size:10px;color:#a78bfa;">' + cpV2EscHtml(this.receipts.postVerifyTreeHash) + '</code>';
    this.receiptsRoot.appendChild(treeHashRow);
  }

  // Receipt entries table
  var table = document.createElement('div');
  table.style.cssText = 'border:1px solid var(--border-color);border-radius:6px;overflow:hidden;';

  // Table header
  var thead = document.createElement('div');
  thead.style.cssText = 'display:flex;gap:0;background:var(--bg-input,#1e293b);padding:6px 8px;font-size:10px;font-weight:600;color:var(--text-dim);border-bottom:1px solid var(--border-color);';
  thead.innerHTML = '<span style="flex:2;">Tool Call</span><span style="flex:1;text-align:center;">Rewind</span><span style="flex:2;">Blob Hash</span><span style="flex:2;">File</span>';
  table.appendChild(thead);

  // Receipt entry rows
  for (var i = 0; i < this.receipts.entries.length; i++) {
    var entry = this.receipts.entries[i];
    var entryRow = document.createElement('div');
    entryRow.style.cssText = 'display:flex;gap:0;padding:5px 8px;font-size:10px;color:var(--text-primary);border-bottom:1px solid var(--border-color,#1e293b22);align-items:center;';
    if (i % 2 === 1) entryRow.style.background = 'rgba(255,255,255,0.02)';

    // Tool call ID (truncated)
    var callCol = document.createElement('span');
    callCol.style.cssText = 'flex:2;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    callCol.textContent = entry.toolCallId ? entry.toolCallId.substring(0, 12) : '--';
    callCol.title = entry.toolCallId || '';
    entryRow.appendChild(callCol);

    // Rewind availability
    var rewindCol = document.createElement('span');
    rewindCol.style.cssText = 'flex:1;text-align:center;';
    if (entry.rewindAvailable) {
      rewindCol.innerHTML = '<span style="color:#34d399;">\u2713</span>';
    } else {
      rewindCol.innerHTML = '<span style="color:#6b7280;">\u2715</span>';
    }
    entryRow.appendChild(rewindCol);

    // Blob hash (truncated)
    var blobCol = document.createElement('span');
    blobCol.style.cssText = 'flex:2;font-family:monospace;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    blobCol.textContent = cpV2TruncateHash(entry.blobHash);
    blobCol.title = entry.blobHash || '';
    entryRow.appendChild(blobCol);

    // File path (truncated)
    var fileCol = document.createElement('span');
    fileCol.style.cssText = 'flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim);';
    var fileName = entry.file ? entry.file.split('/').pop() : '--';
    fileCol.textContent = fileName;
    fileCol.title = entry.file || '';
    entryRow.appendChild(fileCol);

    table.appendChild(entryRow);
  }

  this.receiptsRoot.appendChild(table);
};

// ─── Error display ────────────────────────────────────────────────
CheckpointTimelineV2Panel.prototype.showError = function (message) {
  if (!this.timelineRoot) return;

  var existing = this.timelineRoot.querySelector('.cpv2-error');
  if (existing) existing.remove();

  var errDiv = document.createElement('div');
  errDiv.className = 'cpv2-error';
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:6px 8px;text-align:center;';
  errDiv.textContent = message || 'Error';
  this.timelineRoot.appendChild(errDiv);

  setTimeout(function () { if (errDiv.parentNode) errDiv.remove(); }, 5000);
};

CheckpointTimelineV2Panel.prototype.renderError = function (message) {
  if (!this.timelineRoot) return;
  this.timelineRoot.innerHTML = '';
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:16px 8px;text-align:center;';
  errDiv.textContent = message || 'Error loading timeline';
  this.timelineRoot.appendChild(errDiv);
};

// ─── Cleanup ──────────────────────────────────────────────────────
CheckpointTimelineV2Panel.prototype.cleanupListener = function () {
  if (this.timelineUpdateHandler) {
    try { cpV2Eapi().removeListener('checkpoint:timeline-v2-updated', this.timelineUpdateHandler); } catch (e) {}
    this.timelineUpdateHandler = null;
  }
};

CheckpointTimelineV2Panel.prototype.destroy = function () {
  this.cleanupListener();
  this.hideConflictConfirmation();
};

// ─── Convenience entry point ──────────────────────────────────────
function renderCheckpointTimelineV2Panel(container, sessionId) {
  var panel = new CheckpointTimelineV2Panel(container, sessionId);
  panel.render();
  return panel;
}

// Expose to renderer global scope
if (typeof window !== 'undefined') {
  window.CheckpointTimelineV2Panel = CheckpointTimelineV2Panel;
  window.renderCheckpointTimelineV2Panel = renderCheckpointTimelineV2Panel;
}
