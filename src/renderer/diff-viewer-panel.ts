/**
 * DiffViewerPanel — Renderer panel for turn-level diff visualization with revert.
 *
 * Displays side-by-side or unified diff for modified files within each turn.
 * Provides per-turn collapse/expand with summary (files +/-, lines +/-).
 * Adds revert buttons (per-turn and per-file) with confirmation dialog.
 * Supports image diff for binary files (before/after thumbnails).
 * Embeds as a collapsible section under each agent response in chat.
 *
 * Wires IPC channels: diff:get-turns, diff:get-files, diff:revert-turn, diff:revert-file
 *
 * Gated behind `diff_viewer` feature flag (requires `diff_review`).
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as worktree-panel.ts.
 *
 * Requirements: 15.2, 15.5, 15.6, 15.8
 */

// ─── Helpers ───────────────────────────────────────────────────────
function diffViewerEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function diffViewerEapi() {
  return window.electronAPI;
}

// ─── Image extension detection ────────────────────────────────────
var DIFF_VIEWER_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];

function diffViewerIsImageFile(filePath) {
  if (!filePath) return false;
  var lower = filePath.toLowerCase();
  for (var i = 0; i < DIFF_VIEWER_IMAGE_EXTS.length; i++) {
    if (lower.endsWith(DIFF_VIEWER_IMAGE_EXTS[i])) return true;
  }
  return false;
}

// ─── Change type colors and labels ───────────────────────────────
var DIFF_VIEWER_CHANGE_COLORS = {
  added: '#34d399',
  modified: '#fbbf24',
  deleted: '#f87171',
};

var DIFF_VIEWER_CHANGE_CHARS = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
};

// ─── DiffViewerPanel class ────────────────────────────────────────
function DiffViewerPanel(container, sessionId) {
  this.container = container;
  this.sessionId = sessionId || '';
  this.turns = [];
  this.expandedTurns = {};
  this.turnUpdateHandler = null;
  this.viewMode = 'unified'; // 'unified' or 'side-by-side'
}

DiffViewerPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Diff Viewer';
  header.appendChild(title);

  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;align-items:center;';

  // View mode toggle
  var modeBtn = document.createElement('button');
  modeBtn.type = 'button';
  modeBtn.textContent = 'Unified';
  modeBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  modeBtn.addEventListener('click', function () {
    self.viewMode = self.viewMode === 'unified' ? 'side-by-side' : 'unified';
    modeBtn.textContent = self.viewMode === 'unified' ? 'Unified' : 'Side-by-Side';
    self.renderTurnList();
  });
  headerActions.appendChild(modeBtn);

  // Refresh button
  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.refreshTurns(); });
  headerActions.appendChild(refreshBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Turn list container
  this.listRoot = document.createElement('div');
  this.listRoot.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  this.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Loading turns...</div>';
  this.container.appendChild(this.listRoot);

  // Listen for real-time turn updates
  this.cleanupTurnListener();
  this.turnUpdateHandler = function () {
    self.refreshTurns();
  };
  diffViewerEapi().on('diff:turn-updated', this.turnUpdateHandler);

  // Initial load
  this.refreshTurns();
};

DiffViewerPanel.prototype.refreshTurns = function () {
  var self = this;
  var eapi = diffViewerEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('diff:get-turns', { sessionId: self.sessionId });
  } catch (e) {
    self.renderError('Failed to load turns');
    return;
  }

  Promise.resolve(p).then(function (turns) {
    if (Array.isArray(turns)) {
      self.turns = turns;
      self.renderTurnList();
    } else {
      self.turns = [];
      self.renderTurnList();
    }
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Failed to load turns');
  });
};

DiffViewerPanel.prototype.renderTurnList = function () {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';

  if (this.turns.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:24px 8px;text-align:center;';
    empty.textContent = 'No changes recorded yet.';
    this.listRoot.appendChild(empty);
    return;
  }

  var self = this;
  for (var i = 0; i < this.turns.length; i++) {
    var turn = this.turns[i];
    var card = self.renderTurnCard(turn);
    this.listRoot.appendChild(card);
  }
};

DiffViewerPanel.prototype.renderTurnCard = function (turn) {
  var self = this;
  var isExpanded = !!this.expandedTurns[turn.id];
  var card = document.createElement('div');
  card.className = 'dash-card';
  card.style.cssText = 'padding:10px 12px;display:flex;flex-direction:column;gap:6px;';
  card.setAttribute('data-turn-id', turn.id || '');

  // Header row: collapse toggle + turn info + revert button
  var headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';

  // Collapse/expand arrow
  var arrow = document.createElement('span');
  arrow.style.cssText = 'font-size:10px;color:var(--text-dim);transition:transform 0.15s;';
  arrow.textContent = isExpanded ? '▼' : '▶';
  headerRow.appendChild(arrow);

  // Turn label
  var turnLabel = document.createElement('span');
  turnLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
  turnLabel.textContent = 'Turn ' + (turn.turnIndex != null ? turn.turnIndex : '?');
  headerRow.appendChild(turnLabel);

  // Agent attribution (Requirement 15.5)
  if (turn.agentId) {
    var agentBadge = document.createElement('span');
    agentBadge.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(96,165,250,0.15);color:#60a5fa;font-family:monospace;';
    agentBadge.textContent = turn.agentId;
    headerRow.appendChild(agentBadge);
  }

  // Summary stats
  var statsSpan = document.createElement('span');
  statsSpan.style.cssText = 'font-size:10px;color:var(--text-dim);margin-left:auto;white-space:nowrap;';
  var statsHtml = '';
  if (turn.filesAdded) statsHtml += '<span style="color:#34d399;">+' + turn.filesAdded + '</span> ';
  if (turn.filesModified) statsHtml += '<span style="color:#fbbf24;">~' + turn.filesModified + '</span> ';
  if (turn.filesDeleted) statsHtml += '<span style="color:#f87171;">-' + turn.filesDeleted + '</span> ';
  statsHtml += '<span style="color:var(--text-dim);">(+' + (turn.linesAdded || 0) + '/-' + (turn.linesRemoved || 0) + ')</span>';
  statsSpan.innerHTML = statsHtml;
  headerRow.appendChild(statsSpan);

  // Toggle expand on header click
  headerRow.addEventListener('click', function () {
    self.toggleTurn(turn.id);
  });

  card.appendChild(headerRow);

  // Revert turn button
  var revertRow = document.createElement('div');
  revertRow.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;';

  var revertTurnBtn = document.createElement('button');
  revertTurnBtn.type = 'button';
  revertTurnBtn.textContent = 'Revert Turn';
  revertTurnBtn.style.cssText = 'font-size:10px;padding:3px 8px;border:1px solid #f87171;background:rgba(248,113,113,0.1);color:#f87171;border-radius:4px;cursor:pointer;';
  revertTurnBtn.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    self.confirmRevertTurn(turn);
  });
  revertRow.appendChild(revertTurnBtn);
  card.appendChild(revertRow);

  // Expanded content area (file list + diffs)
  var expandArea = document.createElement('div');
  expandArea.className = 'diff-viewer-turn-expand';
  expandArea.style.cssText = isExpanded ? 'display:block;margin-top:8px;' : 'display:none;';
  expandArea.setAttribute('data-expand-area', turn.id || '');
  card.appendChild(expandArea);

  if (isExpanded) {
    self.loadTurnFiles(turn.id, expandArea);
  }

  return card;
};

DiffViewerPanel.prototype.toggleTurn = function (turnId) {
  this.expandedTurns[turnId] = !this.expandedTurns[turnId];
  this.renderTurnList();
};

DiffViewerPanel.prototype.loadTurnFiles = function (turnId, container) {
  var self = this;
  var eapi = diffViewerEapi();
  if (!eapi) return;

  container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:6px;">Loading files...</div>';

  var p;
  try {
    p = eapi.invoke('diff:get-files', { turnId: turnId });
  } catch (e) {
    container.innerHTML = '<div style="font-size:11px;color:#f87171;padding:6px;">Failed to load files</div>';
    return;
  }

  Promise.resolve(p).then(function (files) {
    if (Array.isArray(files) && files.length > 0) {
      self.renderFileList(container, turnId, files);
    } else {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:6px;">No file changes in this turn.</div>';
    }
  }).catch(function (err) {
    container.innerHTML = '<div style="font-size:11px;color:#f87171;padding:6px;">' + diffViewerEscHtml(err && err.message ? err.message : 'Error') + '</div>';
  });
};

DiffViewerPanel.prototype.renderFileList = function (container, turnId, files) {
  var self = this;
  container.innerHTML = '';

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileCard = document.createElement('div');
    fileCard.style.cssText = 'padding:6px 8px;margin-bottom:6px;background:var(--bg-input,#0f172a);border-radius:4px;border:1px solid var(--border-color);';

    // File header: change type + path + revert button
    var fileHeader = document.createElement('div');
    fileHeader.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';

    var typeColor = DIFF_VIEWER_CHANGE_COLORS[file.changeType] || '#6b7280';
    var typeChar = DIFF_VIEWER_CHANGE_CHARS[file.changeType] || '?';

    var typeBadge = document.createElement('span');
    typeBadge.style.cssText = 'font-size:10px;font-weight:700;color:' + typeColor + ';font-family:monospace;';
    typeBadge.textContent = typeChar;
    fileHeader.appendChild(typeBadge);

    var pathSpan = document.createElement('span');
    pathSpan.style.cssText = 'font-size:11px;color:var(--text-secondary);font-family:monospace;word-break:break-all;flex:1;';
    pathSpan.textContent = file.filePath || '';
    fileHeader.appendChild(pathSpan);

    // Per-file revert button
    var revertFileBtn = document.createElement('button');
    revertFileBtn.type = 'button';
    revertFileBtn.textContent = 'Revert';
    revertFileBtn.style.cssText = 'font-size:9px;padding:2px 6px;border:1px solid #f87171;background:rgba(248,113,113,0.1);color:#f87171;border-radius:3px;cursor:pointer;flex-shrink:0;';
    revertFileBtn.addEventListener('click', (function (turnIdCopy, fileCopy) {
      return function () { self.confirmRevertFile(turnIdCopy, fileCopy); };
    })(turnId, file));
    fileHeader.appendChild(revertFileBtn);

    fileCard.appendChild(fileHeader);

    // Diff content area
    if (diffViewerIsImageFile(file.filePath)) {
      // Image diff: show before/after thumbnails
      self.renderImageDiff(fileCard, file);
    } else {
      // Text diff: render unified or side-by-side
      self.renderTextDiff(fileCard, file);
    }

    container.appendChild(fileCard);
  }
};

DiffViewerPanel.prototype.renderImageDiff = function (container, file) {
  var imgRow = document.createElement('div');
  imgRow.style.cssText = 'display:flex;gap:12px;align-items:center;padding:8px 0;';

  // Before thumbnail (if available)
  if (file.beforeContent) {
    var beforeBox = document.createElement('div');
    beforeBox.style.cssText = 'text-align:center;';
    var beforeLabel = document.createElement('div');
    beforeLabel.style.cssText = 'font-size:9px;color:var(--text-dim);margin-bottom:4px;';
    beforeLabel.textContent = 'Before';
    beforeBox.appendChild(beforeLabel);
    var beforeImg = document.createElement('img');
    beforeImg.style.cssText = 'max-width:120px;max-height:80px;border-radius:4px;border:1px solid var(--border-color);';
    beforeImg.src = file.beforeContent;
    beforeImg.alt = 'Before';
    beforeBox.appendChild(beforeImg);
    imgRow.appendChild(beforeBox);

    // Arrow between images
    var arrowSpan = document.createElement('span');
    arrowSpan.style.cssText = 'font-size:16px;color:var(--text-dim);';
    arrowSpan.textContent = '→';
    imgRow.appendChild(arrowSpan);
  }

  // After thumbnail (if available)
  if (file.afterContent) {
    var afterBox = document.createElement('div');
    afterBox.style.cssText = 'text-align:center;';
    var afterLabel = document.createElement('div');
    afterLabel.style.cssText = 'font-size:9px;color:var(--text-dim);margin-bottom:4px;';
    afterLabel.textContent = 'After';
    afterBox.appendChild(afterLabel);
    var afterImg = document.createElement('img');
    afterImg.style.cssText = 'max-width:120px;max-height:80px;border-radius:4px;border:1px solid var(--border-color);';
    afterImg.src = file.afterContent;
    afterImg.alt = 'After';
    afterBox.appendChild(afterImg);
    imgRow.appendChild(afterBox);
  }

  container.appendChild(imgRow);
};

DiffViewerPanel.prototype.renderTextDiff = function (container, file) {
  var patch = file.patch || '';
  if (!patch) {
    var noChanges = document.createElement('div');
    noChanges.style.cssText = 'font-size:10px;color:var(--text-dim);padding:4px 0;';
    noChanges.textContent = '(no patch data)';
    container.appendChild(noChanges);
    return;
  }

  if (this.viewMode === 'side-by-side') {
    this.renderSideBySideDiff(container, file);
  } else {
    this.renderUnifiedDiff(container, patch);
  }
};

DiffViewerPanel.prototype.renderUnifiedDiff = function (container, patch) {
  var pre = document.createElement('pre');
  pre.style.cssText = 'font-size:10px;font-family:monospace;margin:0;padding:6px;max-height:300px;overflow:auto;line-height:1.5;white-space:pre-wrap;word-break:break-all;';

  var lines = patch.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lineDiv = document.createElement('div');

    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineDiv.style.cssText = 'background:rgba(52,211,153,0.1);color:#34d399;';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lineDiv.style.cssText = 'background:rgba(248,113,113,0.1);color:#f87171;';
    } else if (line.startsWith('@@')) {
      lineDiv.style.cssText = 'color:#60a5fa;font-weight:600;';
    } else {
      lineDiv.style.cssText = 'color:var(--text-dim);';
    }

    lineDiv.textContent = line;
    pre.appendChild(lineDiv);
  }

  container.appendChild(pre);
};

DiffViewerPanel.prototype.renderSideBySideDiff = function (container, file) {
  var patch = file.patch || '';
  if (!patch) return;

  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;gap:2px;max-height:300px;overflow:auto;';

  var leftCol = document.createElement('pre');
  leftCol.style.cssText = 'flex:1;font-size:10px;font-family:monospace;margin:0;padding:4px;line-height:1.5;white-space:pre-wrap;word-break:break-all;border-right:1px solid var(--border-color);';

  var rightCol = document.createElement('pre');
  rightCol.style.cssText = 'flex:1;font-size:10px;font-family:monospace;margin:0;padding:4px;line-height:1.5;white-space:pre-wrap;word-break:break-all;';

  var lines = patch.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      // Header lines go on both sides
      var hdrLeft = document.createElement('div');
      hdrLeft.style.cssText = 'color:#60a5fa;font-weight:600;';
      hdrLeft.textContent = line;
      leftCol.appendChild(hdrLeft);
      var hdrRight = document.createElement('div');
      hdrRight.style.cssText = 'color:#60a5fa;font-weight:600;';
      hdrRight.textContent = line;
      rightCol.appendChild(hdrRight);
    } else if (line.startsWith('-')) {
      var delLine = document.createElement('div');
      delLine.style.cssText = 'background:rgba(248,113,113,0.1);color:#f87171;';
      delLine.textContent = line.substring(1);
      leftCol.appendChild(delLine);
    } else if (line.startsWith('+')) {
      var addLine = document.createElement('div');
      addLine.style.cssText = 'background:rgba(52,211,153,0.1);color:#34d399;';
      addLine.textContent = line.substring(1);
      rightCol.appendChild(addLine);
    } else {
      // Context line — show on both sides
      var ctxLeft = document.createElement('div');
      ctxLeft.style.cssText = 'color:var(--text-dim);';
      ctxLeft.textContent = line.startsWith(' ') ? line.substring(1) : line;
      leftCol.appendChild(ctxLeft);
      var ctxRight = document.createElement('div');
      ctxRight.style.cssText = 'color:var(--text-dim);';
      ctxRight.textContent = line.startsWith(' ') ? line.substring(1) : line;
      rightCol.appendChild(ctxRight);
    }
  }

  wrapper.appendChild(leftCol);
  wrapper.appendChild(rightCol);
  container.appendChild(wrapper);
};

// ─── Revert with Confirmation Dialog ──────────────────────────────
DiffViewerPanel.prototype.confirmRevertTurn = function (turn) {
  var self = this;
  var totalFiles = (turn.filesAdded || 0) + (turn.filesModified || 0) + (turn.filesDeleted || 0);
  var msg = 'Revert all changes from Turn ' + turn.turnIndex + '?\n\n' +
    'This will undo ' + totalFiles + ' file change(s).\nA checkpoint will be created before reverting.';

  if (!window.confirm(msg)) return;

  var eapi = diffViewerEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('diff:revert-turn', { sessionId: self.sessionId, turnId: turn.id });
  } catch (e) {
    self.showTurnError(turn.id, 'Revert request failed');
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      self.refreshTurns();
    } else {
      var errMsg = (result && result.error) || 'Revert failed — possible merge conflicts.';
      self.showTurnError(turn.id, errMsg);
    }
  }).catch(function (err) {
    self.showTurnError(turn.id, err && err.message ? err.message : 'Revert failed');
  });
};

DiffViewerPanel.prototype.confirmRevertFile = function (turnId, file) {
  var self = this;
  var msg = 'Revert changes to "' + (file.filePath || 'unknown') + '"?\n\nA checkpoint will be created before reverting.';

  if (!window.confirm(msg)) return;

  var eapi = diffViewerEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('diff:revert-file', { sessionId: self.sessionId, turnId: turnId, filePath: file.filePath });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      self.refreshTurns();
    } else {
      var errMsg = (result && result.error) || 'Revert failed — possible merge conflicts.';
      window.alert(errMsg);
    }
  }).catch(function (err) {
    window.alert(err && err.message ? err.message : 'Revert failed');
  });
};

DiffViewerPanel.prototype.showTurnError = function (turnId, message) {
  if (!this.listRoot) return;
  var card = this.listRoot.querySelector('[data-turn-id="' + turnId + '"]');
  if (!card) return;

  var existing = card.querySelector('.diff-viewer-error');
  if (existing) existing.remove();

  var errDiv = document.createElement('div');
  errDiv.className = 'diff-viewer-error';
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:4px 0;';
  errDiv.textContent = message;
  card.appendChild(errDiv);

  setTimeout(function () { if (errDiv.parentNode) errDiv.remove(); }, 5000);
};

DiffViewerPanel.prototype.renderError = function (message) {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:16px 8px;text-align:center;';
  errDiv.textContent = message || 'Error loading diff data';
  this.listRoot.appendChild(errDiv);
};

DiffViewerPanel.prototype.cleanupTurnListener = function () {
  if (this.turnUpdateHandler) {
    try { diffViewerEapi().removeListener('diff:turn-updated', this.turnUpdateHandler); } catch (e) {}
    this.turnUpdateHandler = null;
  }
};

DiffViewerPanel.prototype.destroy = function () {
  this.cleanupTurnListener();
};

// ─── Embeddable collapsible section for chat view (Requirement 15.6) ──
// Creates a compact collapsible diff summary suitable for embedding
// under an agent response message in the chat panel.
function DiffViewerInlineSection(turnData) {
  this.turnData = turnData;
  this.expanded = false;
  this.element = null;
  this.filesLoaded = false;
}

DiffViewerInlineSection.prototype.render = function () {
  var self = this;
  var turn = this.turnData;

  var section = document.createElement('div');
  section.style.cssText = 'margin-top:8px;border:1px solid var(--border-color);border-radius:6px;overflow:hidden;';
  section.setAttribute('data-diff-inline', turn.id || '');

  // Collapsed header — always visible
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg-input,#0f172a);cursor:pointer;';

  var arrow = document.createElement('span');
  arrow.style.cssText = 'font-size:9px;color:var(--text-dim);';
  arrow.textContent = '▶';
  header.appendChild(arrow);

  var label = document.createElement('span');
  label.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);';
  label.textContent = 'Changes';
  header.appendChild(label);

  // Summary stats
  var stats = document.createElement('span');
  stats.style.cssText = 'font-size:10px;color:var(--text-dim);margin-left:auto;';
  var statsArr = [];
  if (turn.filesAdded) statsArr.push('+' + turn.filesAdded);
  if (turn.filesModified) statsArr.push('~' + turn.filesModified);
  if (turn.filesDeleted) statsArr.push('-' + turn.filesDeleted);
  stats.textContent = statsArr.join(' ') + ' files, +' + (turn.linesAdded || 0) + '/-' + (turn.linesRemoved || 0) + ' lines';
  header.appendChild(stats);

  header.addEventListener('click', function () {
    self.expanded = !self.expanded;
    arrow.textContent = self.expanded ? '▼' : '▶';
    body.style.display = self.expanded ? 'block' : 'none';
    if (self.expanded && !self.filesLoaded) {
      self.loadFiles(body);
    }
  });

  section.appendChild(header);

  // Expandable body
  var body = document.createElement('div');
  body.style.cssText = 'display:none;padding:8px 10px;';
  section.appendChild(body);

  this.element = section;
  return section;
};

DiffViewerInlineSection.prototype.loadFiles = function (body) {
  var self = this;
  var eapi = diffViewerEapi();
  if (!eapi) return;

  body.innerHTML = '<div style="font-size:10px;color:var(--text-dim);">Loading...</div>';

  var p;
  try {
    p = eapi.invoke('diff:get-files', { turnId: self.turnData.id });
  } catch (e) {
    body.innerHTML = '<div style="font-size:10px;color:#f87171;">Failed to load files</div>';
    return;
  }

  Promise.resolve(p).then(function (files) {
    self.filesLoaded = true;
    body.innerHTML = '';
    if (!Array.isArray(files) || files.length === 0) {
      body.innerHTML = '<div style="font-size:10px;color:var(--text-dim);">No files.</div>';
      return;
    }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var row = document.createElement('div');
      row.style.cssText = 'font-size:10px;font-family:monospace;padding:2px 0;color:var(--text-dim);';
      var typeColor = DIFF_VIEWER_CHANGE_COLORS[f.changeType] || '#6b7280';
      var typeChar = DIFF_VIEWER_CHANGE_CHARS[f.changeType] || '?';
      row.innerHTML = '<span style="color:' + typeColor + ';font-weight:600;margin-right:6px;">' + typeChar + '</span>' + diffViewerEscHtml(f.filePath);
      body.appendChild(row);
    }
  }).catch(function () {
    body.innerHTML = '<div style="font-size:10px;color:#f87171;">Error loading files</div>';
  });
};

// ─── Convenience entry points ─────────────────────────────────────
function renderDiffViewerPanel(container, sessionId) {
  var panel = new DiffViewerPanel(container, sessionId);
  panel.render();
  return panel;
}

function createDiffViewerInlineSection(turnData) {
  var section = new DiffViewerInlineSection(turnData);
  return section.render();
}

// Expose to renderer global scope so index.ts can attach the panel
// without going through ES modules.
if (typeof window !== 'undefined') {
  window.DiffViewerPanel = DiffViewerPanel;
  window.renderDiffViewerPanel = renderDiffViewerPanel;
  window.DiffViewerInlineSection = DiffViewerInlineSection;
  window.createDiffViewerInlineSection = createDiffViewerInlineSection;
}
