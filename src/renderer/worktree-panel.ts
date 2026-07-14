/**
 * WorktreeManagerPanel — Renderer panel for managing git worktree agent isolation.
 *
 * Displays active worktrees with:
 * - Status (created, active, merging, merged, discarded)
 * - Diff stats (files added/modified/deleted, lines +/-)
 * - Agent assignment
 * - Action buttons: Merge, Create PR, Discard
 * - Diff preview for each worktree compared to main
 *
 * Wires IPC channels: worktree:create, worktree:list, worktree:merge,
 * worktree:discard, worktree:diff
 *
 * Gated behind `worktree_agent_manager` feature flag (requires `worktree_isolation`).
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as metrics-panel.ts.
 *
 * Requirements: 3.7
 */

// ─── Helpers ───────────────────────────────────────────────────────
function worktreePanelEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function worktreePanelEapi() {
  return window.electronAPI;
}

// ─── Status badge colors ──────────────────────────────────────────
var WORKTREE_STATUS_COLORS = {
  created: '#60a5fa',   // blue
  active: '#34d399',    // green
  merging: '#fbbf24',   // amber
  merged: '#a78bfa',    // violet
  discarded: '#6b7280', // gray
};

// ─── WorktreeManagerPanel class ───────────────────────────────────
function WorktreeManagerPanel(container, projectId, projectDir) {
  this.container = container;
  this.projectId = projectId || '';
  this.projectDir = projectDir || '';
  this.worktrees = [];
  this.statusHandler = null;
  this.refreshTimer = null;
}

WorktreeManagerPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-secondary);';
  title.textContent = 'Worktree Manager';
  header.appendChild(title);

  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;gap:6px;';

  var refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
  refreshBtn.addEventListener('click', function () { self.refreshWorktrees(); });
  headerActions.appendChild(refreshBtn);

  header.appendChild(headerActions);
  this.container.appendChild(header);

  // Worktree list container
  this.listRoot = document.createElement('div');
  this.listRoot.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
  this.listRoot.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:16px 8px;text-align:center;">Loading worktrees...</div>';
  this.container.appendChild(this.listRoot);

  // Listen for real-time status updates
  this.cleanupStatusListener();
  this.statusHandler = function () {
    self.refreshWorktrees();
  };
  worktreePanelEapi().on('worktree:status-update', this.statusHandler);

  // Initial load
  this.refreshWorktrees();

  // Auto-refresh every 30s
  if (this.refreshTimer) clearInterval(this.refreshTimer);
  this.refreshTimer = setInterval(function () { self.refreshWorktrees(); }, 30000);
};

WorktreeManagerPanel.prototype.refreshWorktrees = function () {
  var self = this;
  var eapi = worktreePanelEapi();
  if (!eapi || typeof eapi.invoke !== 'function') return;

  var p;
  try {
    p = eapi.invoke('worktree:list', self.projectId);
  } catch (e) {
    self.renderError('Failed to list worktrees');
    return;
  }

  Promise.resolve(p).then(function (worktrees) {
    if (Array.isArray(worktrees)) {
      self.worktrees = worktrees;
      self.renderWorktreeList();
    } else {
      self.worktrees = [];
      self.renderWorktreeList();
    }
  }).catch(function (err) {
    self.renderError(err && err.message ? err.message : 'Failed to load worktrees');
  });
};

WorktreeManagerPanel.prototype.renderWorktreeList = function () {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';

  if (this.worktrees.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:24px 8px;text-align:center;';
    empty.textContent = 'No active worktrees. Worktrees are created automatically in Ultra mode.';
    this.listRoot.appendChild(empty);
    return;
  }

  var self = this;
  var i;
  for (i = 0; i < this.worktrees.length; i++) {
    var wt = this.worktrees[i];
    var card = self.renderWorktreeCard(wt);
    this.listRoot.appendChild(card);
  }
};

WorktreeManagerPanel.prototype.renderWorktreeCard = function (wt) {
  var self = this;
  var card = document.createElement('div');
  card.className = 'dash-card';
  card.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:8px;';
  card.setAttribute('data-worktree-id', wt.id || '');

  // Top row: status badge + agent name + branch
  var topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

  // Status badge
  var statusBadge = document.createElement('span');
  var statusColor = WORKTREE_STATUS_COLORS[wt.status] || '#6b7280';
  statusBadge.style.cssText = 'font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;color:#fff;background:' + statusColor + ';text-transform:uppercase;';
  statusBadge.textContent = wt.status || 'unknown';
  topRow.appendChild(statusBadge);

  // Agent assignment
  if (wt.agentId || wt.agent_id) {
    var agentLabel = document.createElement('span');
    agentLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);font-family:monospace;';
    agentLabel.textContent = wt.agentId || wt.agent_id;
    topRow.appendChild(agentLabel);
  }

  card.appendChild(topRow);

  // Branch name
  var branchRow = document.createElement('div');
  branchRow.style.cssText = 'font-size:11px;color:var(--text-dim);font-family:monospace;word-break:break-all;';
  branchRow.textContent = wt.branchName || wt.branch_name || '';
  card.appendChild(branchRow);

  // Diff stats if available
  var diffStats = wt.diffStats || wt.diff_stats;
  if (diffStats) {
    var statsRow = document.createElement('div');
    statsRow.style.cssText = 'display:flex;gap:12px;font-size:11px;';
    var parsed = typeof diffStats === 'string' ? JSON.parse(diffStats) : diffStats;

    if (parsed.added || parsed.modified || parsed.deleted) {
      var filesStr = '';
      if (parsed.added) filesStr += '+' + parsed.added + ' added ';
      if (parsed.modified) filesStr += '~' + parsed.modified + ' modified ';
      if (parsed.deleted) filesStr += '-' + parsed.deleted + ' deleted';

      var filesSpan = document.createElement('span');
      filesSpan.style.cssText = 'color:var(--text-secondary);';
      filesSpan.textContent = filesStr.trim();
      statsRow.appendChild(filesSpan);
    }

    if (parsed.insertions || parsed.deletions) {
      var linesSpan = document.createElement('span');
      linesSpan.style.cssText = 'color:var(--text-dim);';
      linesSpan.innerHTML = '<span style="color:#34d399;">+' + (parsed.insertions || 0) + '</span> <span style="color:#f87171;">-' + (parsed.deletions || 0) + '</span>';
      statsRow.appendChild(linesSpan);
    }

    card.appendChild(statsRow);
  }

  // Action buttons (only for active/completed worktrees)
  var status = wt.status || '';
  if (status === 'active' || status === 'created' || status === 'merging') {
    var actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';

    // Diff preview button
    var diffBtn = document.createElement('button');
    diffBtn.type = 'button';
    diffBtn.textContent = 'View Diff';
    diffBtn.style.cssText = 'font-size:10px;padding:3px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;';
    diffBtn.addEventListener('click', (function (worktree) {
      return function () { self.viewDiff(worktree); };
    })(wt));
    actionsRow.appendChild(diffBtn);

    // Merge button
    var mergeBtn = document.createElement('button');
    mergeBtn.type = 'button';
    mergeBtn.textContent = 'Merge';
    mergeBtn.style.cssText = 'font-size:10px;padding:3px 8px;border:1px solid #34d399;background:rgba(52,211,153,0.1);color:#34d399;border-radius:4px;cursor:pointer;';
    mergeBtn.addEventListener('click', (function (worktree) {
      return function () { self.mergeWorktree(worktree); };
    })(wt));
    actionsRow.appendChild(mergeBtn);

    // Discard button
    var discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.textContent = 'Discard';
    discardBtn.style.cssText = 'font-size:10px;padding:3px 8px;border:1px solid #f87171;background:rgba(248,113,113,0.1);color:#f87171;border-radius:4px;cursor:pointer;';
    discardBtn.addEventListener('click', (function (worktree) {
      return function () { self.discardWorktree(worktree); };
    })(wt));
    actionsRow.appendChild(discardBtn);

    card.appendChild(actionsRow);
  }

  // Diff preview area (populated on demand)
  var diffPreview = document.createElement('div');
  diffPreview.className = 'worktree-diff-preview';
  diffPreview.style.cssText = 'display:none;';
  diffPreview.setAttribute('data-diff-area', wt.id || '');
  card.appendChild(diffPreview);

  return card;
};

WorktreeManagerPanel.prototype.viewDiff = function (wt) {
  var self = this;
  var worktreeId = wt.id;
  var eapi = worktreePanelEapi();
  if (!eapi) return;

  // Toggle existing diff preview
  var diffArea = this.listRoot.querySelector('[data-diff-area="' + worktreeId + '"]');
  if (diffArea && diffArea.style.display !== 'none') {
    diffArea.style.display = 'none';
    return;
  }

  // Show loading
  if (diffArea) {
    diffArea.style.display = 'block';
    diffArea.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;">Loading diff...</div>';
  }

  var p;
  try {
    p = eapi.invoke('worktree:diff', { worktreeId: worktreeId, projectDir: self.projectDir });
  } catch (e) {
    if (diffArea) diffArea.innerHTML = '<div style="font-size:11px;color:#f87171;padding:8px;">Failed to load diff</div>';
    return;
  }

  Promise.resolve(p).then(function (summary) {
    if (!diffArea) return;
    if (summary && summary.error) {
      diffArea.innerHTML = '<div style="font-size:11px;color:#f87171;padding:8px;">' + worktreePanelEscHtml(summary.error) + '</div>';
      return;
    }
    self.renderDiffPreview(diffArea, summary);
  }).catch(function (err) {
    if (diffArea) {
      diffArea.innerHTML = '<div style="font-size:11px;color:#f87171;padding:8px;">' + worktreePanelEscHtml(err && err.message ? err.message : 'Diff failed') + '</div>';
    }
  });
};

WorktreeManagerPanel.prototype.renderDiffPreview = function (container, summary) {
  if (!summary) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;">No changes</div>';
    return;
  }

  container.innerHTML = '';
  container.style.cssText = 'display:block;margin-top:8px;padding:8px;background:var(--bg-input,#0f172a);border-radius:6px;border:1px solid var(--border-color);';

  // Summary line
  var summaryLine = document.createElement('div');
  summaryLine.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-bottom:6px;';
  summaryLine.innerHTML =
    '<span style="color:#34d399;">+' + (summary.filesAdded || 0) + ' added</span> ' +
    '<span style="color:#fbbf24;">~' + (summary.filesModified || 0) + ' modified</span> ' +
    '<span style="color:#f87171;">-' + (summary.filesDeleted || 0) + ' deleted</span> ' +
    '<span style="color:var(--text-dim);">(+' + (summary.linesAdded || 0) + '/-' + (summary.linesDeleted || 0) + ' lines)</span>';
  container.appendChild(summaryLine);

  // File list
  var changedFiles = summary.changedFiles || [];
  if (changedFiles.length > 0) {
    var fileList = document.createElement('div');
    fileList.style.cssText = 'font-size:10px;font-family:monospace;max-height:150px;overflow-y:auto;';

    var i;
    var maxFiles = Math.min(changedFiles.length, 20); // Cap display at 20 files
    for (i = 0; i < maxFiles; i++) {
      var f = changedFiles[i];
      var fileRow = document.createElement('div');
      fileRow.style.cssText = 'padding:2px 0;color:var(--text-dim);';

      var typeColor = f.changeType === 'added' ? '#34d399' : f.changeType === 'deleted' ? '#f87171' : '#fbbf24';
      var typeChar = f.changeType === 'added' ? 'A' : f.changeType === 'deleted' ? 'D' : 'M';
      fileRow.innerHTML = '<span style="color:' + typeColor + ';font-weight:600;margin-right:6px;">' + typeChar + '</span>' + worktreePanelEscHtml(f.path);
      fileList.appendChild(fileRow);
    }

    if (changedFiles.length > maxFiles) {
      var moreRow = document.createElement('div');
      moreRow.style.cssText = 'padding:4px 0;color:var(--text-dim);font-style:italic;';
      moreRow.textContent = '... and ' + (changedFiles.length - maxFiles) + ' more files';
      fileList.appendChild(moreRow);
    }

    container.appendChild(fileList);
  }
};

WorktreeManagerPanel.prototype.mergeWorktree = function (wt) {
  var self = this;
  var eapi = worktreePanelEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('worktree:merge', { worktreeId: wt.id, projectDir: self.projectDir });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      self.refreshWorktrees();
    } else {
      var errMsg = (result && result.error) || (result && result.message) || 'Merge failed';
      self.showActionError(wt.id, errMsg);
    }
  }).catch(function () {
    self.showActionError(wt.id, 'Merge request failed');
  });
};

WorktreeManagerPanel.prototype.discardWorktree = function (wt) {
  var self = this;
  var eapi = worktreePanelEapi();
  if (!eapi) return;

  var p;
  try {
    p = eapi.invoke('worktree:discard', { worktreeId: wt.id, projectDir: self.projectDir });
  } catch (e) {
    return;
  }

  Promise.resolve(p).then(function (result) {
    if (result && result.success) {
      self.refreshWorktrees();
    } else {
      var errMsg = (result && result.error) || (result && result.message) || 'Discard failed';
      self.showActionError(wt.id, errMsg);
    }
  }).catch(function () {
    self.showActionError(wt.id, 'Discard request failed');
  });
};

WorktreeManagerPanel.prototype.showActionError = function (worktreeId, message) {
  if (!this.listRoot) return;
  var card = this.listRoot.querySelector('[data-worktree-id="' + worktreeId + '"]');
  if (!card) return;

  // Remove any existing error
  var existing = card.querySelector('.worktree-action-error');
  if (existing) existing.remove();

  var errDiv = document.createElement('div');
  errDiv.className = 'worktree-action-error';
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:4px 0;';
  errDiv.textContent = message;
  card.appendChild(errDiv);

  // Auto-remove after 5s
  setTimeout(function () { if (errDiv.parentNode) errDiv.remove(); }, 5000);
};

WorktreeManagerPanel.prototype.renderError = function (message) {
  if (!this.listRoot) return;
  this.listRoot.innerHTML = '';
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'font-size:11px;color:#f87171;padding:16px 8px;text-align:center;';
  errDiv.textContent = message || 'Error loading worktrees';
  this.listRoot.appendChild(errDiv);
};

WorktreeManagerPanel.prototype.cleanupStatusListener = function () {
  if (this.statusHandler) {
    try { worktreePanelEapi().removeListener('worktree:status-update', this.statusHandler); } catch (e) {}
    this.statusHandler = null;
  }
};

WorktreeManagerPanel.prototype.destroy = function () {
  this.cleanupStatusListener();
  if (this.refreshTimer) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
};

// ─── Convenience entry point ──────────────────────────────────────
function renderWorktreePanel(container, projectId, projectDir) {
  var panel = new WorktreeManagerPanel(container, projectId, projectDir);
  panel.render();
  return panel;
}

// Expose to renderer global scope so index.ts can attach the panel
// without going through ES modules.
if (typeof window !== 'undefined') {
  window.WorktreeManagerPanel = WorktreeManagerPanel;
  window.renderWorktreePanel = renderWorktreePanel;
}
