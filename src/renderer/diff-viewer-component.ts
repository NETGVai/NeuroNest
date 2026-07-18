// @ts-nocheck
/**
 * DiffViewerComponent — Inline diff viewer with accept/reject per-hunk.
 *
 * Shows unified-format diffs with syntax highlighting, green/red line coloring
 * for additions/deletions, file-by-file navigation tabs for multi-file diffs,
 * and per-hunk accept/reject actions that call IPC to apply or revert changes.
 *
 * Exposed as window.DiffViewerComponent for workspace panels and chat messages.
 *
 * API:
 *   var viewer = new window.DiffViewerComponent(container, options)
 *   viewer.setDiffs(diffs)  // [{filePath, hunks: [{header, lines, accepted}]}]
 *   viewer.destroy()
 *
 * Also exposes convenience:
 *   window.wk.diffView(container, hunks, onAccept, onReject)
 *
 * Requirements: 7.1-7.5
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 */

(function () {
  'use strict';

  // ─── Inject Component Styles ─────────────────────────────────────

  var styleId = 'diff-viewer-component-styles';
  if (!document.getElementById(styleId)) {
    var styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.textContent = [
      '.dvc-container{font-family:inherit;border:1px solid var(--border-color);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface-container);}',
      '.dvc-file-tabs{display:flex;gap:0;border-bottom:1px solid var(--border-color);overflow-x:auto;background:var(--bg-sidebar);}',
      '.dvc-file-tabs::-webkit-scrollbar{height:3px;}',
      '.dvc-file-tabs::-webkit-scrollbar-track{background:transparent;}',
      '.dvc-file-tabs::-webkit-scrollbar-thumb{background:var(--surface-container-highest);border-radius:2px;}',
      '.dvc-file-tab{padding:6px 14px;font-size:11px;color:var(--text-secondary);border:none;background:none;border-bottom:2px solid transparent;cursor:pointer;transition:all var(--motion-quick);font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;white-space:nowrap;flex-shrink:0;}',
      '.dvc-file-tab:hover{color:var(--text-primary);background:var(--surface-hover);}',
      '.dvc-file-tab.active{color:var(--accent);border-bottom-color:var(--accent);background:var(--surface-container);}',
      '.dvc-file-tab .dvc-tab-badge{font-size:9px;font-weight:700;margin-left:6px;padding:1px 5px;border-radius:8px;}',
      '.dvc-file-tab .dvc-tab-badge-add{background:var(--green-container);color:var(--green);}',
      '.dvc-file-tab .dvc-tab-badge-del{background:var(--red-container);color:var(--red);}',
      '.dvc-diff-body{max-height:500px;overflow-y:auto;}',
      '.dvc-diff-body::-webkit-scrollbar{width:6px;}',
      '.dvc-diff-body::-webkit-scrollbar-track{background:transparent;}',
      '.dvc-diff-body::-webkit-scrollbar-thumb{background:var(--surface-container-highest);border-radius:3px;}',
      '.dvc-hunk{border-bottom:1px solid var(--border-color);}',
      '.dvc-hunk:last-child{border-bottom:none;}',
      '.dvc-hunk-header{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;background:var(--surface-container-high);border-bottom:1px solid var(--border-color);}',
      '.dvc-hunk-range{font-size:11px;color:var(--accent);font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font-weight:600;}',
      '.dvc-hunk-actions{display:flex;gap:6px;}',
      '.dvc-hunk-btn{font-size:10px;padding:3px 10px;border-radius:var(--radius-xs);cursor:pointer;font-weight:600;font-family:inherit;transition:all var(--motion-quick);border:1px solid;}',
      '.dvc-hunk-btn-accept{background:var(--green-container);color:var(--green);border-color:var(--green);}',
      '.dvc-hunk-btn-accept:hover{background:var(--green);color:#fff;}',
      '.dvc-hunk-btn-accept:disabled{opacity:0.4;cursor:not-allowed;}',
      '.dvc-hunk-btn-reject{background:var(--red-container);color:var(--red);border-color:var(--red);}',
      '.dvc-hunk-btn-reject:hover{background:var(--red);color:#fff;}',
      '.dvc-hunk-btn-reject:disabled{opacity:0.4;cursor:not-allowed;}',
      '.dvc-hunk-status{font-size:9px;font-weight:700;padding:2px 6px;border-radius:8px;text-transform:uppercase;}',
      '.dvc-hunk-status-accepted{background:var(--green-container);color:var(--green);}',
      '.dvc-hunk-status-rejected{background:var(--red-container);color:var(--red);}',
      '.dvc-lines{font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font-size:12px;line-height:1.6;margin:0;padding:0;}',
      '.dvc-line{display:flex;padding:0 12px;min-height:20px;transition:background var(--motion-quick);}',
      '.dvc-line:hover{filter:brightness(1.1);}',
      '.dvc-line-num{width:40px;text-align:right;padding-right:10px;color:var(--text-dim);font-size:11px;user-select:none;-webkit-user-select:none;flex-shrink:0;}',
      '.dvc-line-content{flex:1;white-space:pre-wrap;word-break:break-all;padding:0 4px;-webkit-user-select:text;user-select:text;}',
      '.dvc-line-add{background:rgba(74,222,128,0.08);}',
      '.dvc-line-add .dvc-line-content{color:var(--green);}',
      '.dvc-line-del{background:rgba(248,113,113,0.08);}',
      '.dvc-line-del .dvc-line-content{color:var(--red);}',
      '.dvc-line-ctx .dvc-line-content{color:var(--text-secondary);}',
      '.dvc-empty{text-align:center;padding:32px 16px;color:var(--text-dim);font-size:12px;}',
      '.dvc-file-summary{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:11px;color:var(--text-dim);border-bottom:1px solid var(--border-color);background:var(--surface-container-high);}',
      '.dvc-file-path{font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;color:var(--text-primary);font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    ].join('\n');
    document.head.appendChild(styleEl);
  }

  // ─── Utility ─────────────────────────────────────────────────────

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function eapi() {
    return window.electronAPI;
  }

  // ─── DiffViewerComponent Constructor ─────────────────────────────

  function DiffViewerComponent(container, options) {
    this.container = container;
    this.options = options || {};
    this.diffs = []; // [{filePath, hunks: [{header, lines: [{type, content, oldNum, newNum}], status}]}]
    this.activeFileIndex = 0;
    this.onAccept = this.options.onAccept || null;
    this.onReject = this.options.onReject || null;
  }

  /**
   * Set diff data and re-render.
   * @param {Array} diffs — Array of file diffs:
   *   [{
   *     filePath: string,
   *     hunks: [{
   *       header: string,       // e.g. "@@ -12,7 +12,10 @@"
   *       lines: [{type: 'add'|'del'|'ctx', content: string, oldNum: number|null, newNum: number|null}],
   *       status: null|'accepted'|'rejected'
   *     }]
   *   }]
   */
  DiffViewerComponent.prototype.setDiffs = function (diffs) {
    this.diffs = diffs || [];
    this.activeFileIndex = 0;
    this.render();
  };

  DiffViewerComponent.prototype.render = function () {
    this.container.innerHTML = '';

    if (!this.diffs || this.diffs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'dvc-empty';
      empty.textContent = 'No diffs to display';
      this.container.appendChild(empty);
      return;
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'dvc-container';

    // File tabs (only if multiple files)
    if (this.diffs.length > 1) {
      var tabBar = this.renderFileTabs();
      wrapper.appendChild(tabBar);
    }

    // Diff body for active file
    var body = document.createElement('div');
    body.className = 'dvc-diff-body';
    this.renderFileContent(body);
    wrapper.appendChild(body);

    this.container.appendChild(wrapper);
  };

  DiffViewerComponent.prototype.renderFileTabs = function () {
    var self = this;
    var tabBar = document.createElement('div');
    tabBar.className = 'dvc-file-tabs';

    for (var i = 0; i < this.diffs.length; i++) {
      (function (index) {
        var diff = self.diffs[index];
        var tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'dvc-file-tab' + (index === self.activeFileIndex ? ' active' : '');

        // Show filename (last segment)
        var parts = (diff.filePath || 'unknown').split('/');
        var fileName = parts[parts.length - 1];
        tab.textContent = fileName;

        // Count additions/deletions for badge
        var addCount = 0;
        var delCount = 0;
        if (diff.hunks) {
          for (var h = 0; h < diff.hunks.length; h++) {
            var lines = diff.hunks[h].lines || [];
            for (var l = 0; l < lines.length; l++) {
              if (lines[l].type === 'add') addCount++;
              else if (lines[l].type === 'del') delCount++;
            }
          }
        }

        if (addCount > 0) {
          var addBadge = document.createElement('span');
          addBadge.className = 'dvc-tab-badge dvc-tab-badge-add';
          addBadge.textContent = '+' + addCount;
          tab.appendChild(addBadge);
        }
        if (delCount > 0) {
          var delBadge = document.createElement('span');
          delBadge.className = 'dvc-tab-badge dvc-tab-badge-del';
          delBadge.textContent = '-' + delCount;
          tab.appendChild(delBadge);
        }

        tab.title = diff.filePath || '';
        tab.addEventListener('click', function () {
          self.activeFileIndex = index;
          self.render();
        });

        tabBar.appendChild(tab);
      })(i);
    }

    return tabBar;
  };

  DiffViewerComponent.prototype.renderFileContent = function (body) {
    var self = this;
    var diff = this.diffs[this.activeFileIndex];
    if (!diff) return;

    // File path summary bar
    var summary = document.createElement('div');
    summary.className = 'dvc-file-summary';
    var pathSpan = document.createElement('span');
    pathSpan.className = 'dvc-file-path';
    pathSpan.textContent = diff.filePath || 'unknown';
    pathSpan.title = diff.filePath || '';
    summary.appendChild(pathSpan);
    body.appendChild(summary);

    // Render hunks
    var hunks = diff.hunks || [];
    if (hunks.length === 0) {
      var noHunks = document.createElement('div');
      noHunks.className = 'dvc-empty';
      noHunks.textContent = 'No hunks in this file';
      body.appendChild(noHunks);
      return;
    }

    for (var h = 0; h < hunks.length; h++) {
      (function (hunkIndex) {
        var hunk = hunks[hunkIndex];
        var hunkEl = document.createElement('div');
        hunkEl.className = 'dvc-hunk';

        // Hunk header with range and accept/reject buttons
        var hdr = document.createElement('div');
        hdr.className = 'dvc-hunk-header';

        var rangeSpan = document.createElement('span');
        rangeSpan.className = 'dvc-hunk-range';
        rangeSpan.textContent = hunk.header || '@@ ... @@';
        hdr.appendChild(rangeSpan);

        var actionsDiv = document.createElement('div');
        actionsDiv.className = 'dvc-hunk-actions';

        if (hunk.status === 'accepted') {
          var statusEl = document.createElement('span');
          statusEl.className = 'dvc-hunk-status dvc-hunk-status-accepted';
          statusEl.textContent = 'Accepted';
          actionsDiv.appendChild(statusEl);
        } else if (hunk.status === 'rejected') {
          var statusEl2 = document.createElement('span');
          statusEl2.className = 'dvc-hunk-status dvc-hunk-status-rejected';
          statusEl2.textContent = 'Rejected';
          actionsDiv.appendChild(statusEl2);
        } else {
          // Accept button
          var acceptBtn = document.createElement('button');
          acceptBtn.type = 'button';
          acceptBtn.className = 'dvc-hunk-btn dvc-hunk-btn-accept';
          acceptBtn.textContent = 'Accept Hunk';
          acceptBtn.addEventListener('click', function () {
            self.handleAccept(diff.filePath, hunkIndex, hunk);
          });
          actionsDiv.appendChild(acceptBtn);

          // Reject button
          var rejectBtn = document.createElement('button');
          rejectBtn.type = 'button';
          rejectBtn.className = 'dvc-hunk-btn dvc-hunk-btn-reject';
          rejectBtn.textContent = 'Reject Hunk';
          rejectBtn.addEventListener('click', function () {
            self.handleReject(diff.filePath, hunkIndex, hunk);
          });
          actionsDiv.appendChild(rejectBtn);
        }

        hdr.appendChild(actionsDiv);
        hunkEl.appendChild(hdr);

        // Render diff lines
        var linesContainer = document.createElement('div');
        linesContainer.className = 'dvc-lines';
        var lines = hunk.lines || [];

        for (var l = 0; l < lines.length; l++) {
          var lineData = lines[l];
          var lineEl = document.createElement('div');
          lineEl.className = 'dvc-line';

          if (lineData.type === 'add') {
            lineEl.className += ' dvc-line-add';
          } else if (lineData.type === 'del') {
            lineEl.className += ' dvc-line-del';
          } else {
            lineEl.className += ' dvc-line-ctx';
          }

          // Line number
          var numEl = document.createElement('span');
          numEl.className = 'dvc-line-num';
          if (lineData.type === 'add') {
            numEl.textContent = lineData.newNum != null ? String(lineData.newNum) : '';
          } else if (lineData.type === 'del') {
            numEl.textContent = lineData.oldNum != null ? String(lineData.oldNum) : '';
          } else {
            numEl.textContent = lineData.oldNum != null ? String(lineData.oldNum) : '';
          }
          lineEl.appendChild(numEl);

          // Content with prefix
          var contentEl = document.createElement('span');
          contentEl.className = 'dvc-line-content';
          var prefix = lineData.type === 'add' ? '+ ' : lineData.type === 'del' ? '- ' : '  ';
          contentEl.textContent = prefix + (lineData.content || '');
          lineEl.appendChild(contentEl);

          linesContainer.appendChild(lineEl);
        }

        hunkEl.appendChild(linesContainer);
        body.appendChild(hunkEl);
      })(h);
    }
  };

  // ─── Accept/Reject Handlers ──────────────────────────────────────

  DiffViewerComponent.prototype.handleAccept = function (filePath, hunkIndex, hunk) {
    var self = this;

    // Mark hunk as accepted immediately for responsiveness
    hunk.status = 'accepted';
    self.render();

    // Call IPC to apply the hunk
    var api = eapi();
    if (api && typeof api.invoke === 'function') {
      api.invoke('diff:accept-hunk', {
        filePath: filePath,
        hunkIndex: hunkIndex
      }).then(function () {
        if (window.showThemedToast) {
          window.showThemedToast('Hunk accepted', 'success');
        }
      }).catch(function (err) {
        if (window.showThemedToast) {
          window.showThemedToast('Accept failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
        }
        // Revert status on failure
        hunk.status = null;
        self.render();
      });
    }

    // Call external handler if provided
    if (self.onAccept) {
      self.onAccept(filePath, hunkIndex, hunk);
    }
  };

  DiffViewerComponent.prototype.handleReject = function (filePath, hunkIndex, hunk) {
    var self = this;

    // Mark hunk as rejected immediately
    hunk.status = 'rejected';
    self.render();

    // Call IPC to revert the hunk and notify agent (Requirement 7.5)
    var api = eapi();
    if (api && typeof api.invoke === 'function') {
      api.invoke('diff:reject-hunk', {
        filePath: filePath,
        hunkIndex: hunkIndex
      }).then(function () {
        if (window.showThemedToast) {
          window.showThemedToast('Hunk rejected — change reverted', 'info');
        }
      }).catch(function (err) {
        if (window.showThemedToast) {
          window.showThemedToast('Reject failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
        }
        // Revert status on failure
        hunk.status = null;
        self.render();
      });
    }

    // Call external handler if provided
    if (self.onReject) {
      self.onReject(filePath, hunkIndex, hunk);
    }
  };

  DiffViewerComponent.prototype.destroy = function () {
    this.container.innerHTML = '';
    this.diffs = [];
    this.onAccept = null;
    this.onReject = null;
  };

  // ─── Static helper: parse a unified diff string into structured data ──

  DiffViewerComponent.parsePatch = function (patchText, filePath) {
    if (!patchText) return { filePath: filePath || 'unknown', hunks: [] };

    var lines = patchText.split('\n');
    var hunks = [];
    var currentHunk = null;
    var oldLine = 0;
    var newLine = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Skip diff headers (---/+++)
      if (line.startsWith('---') || line.startsWith('+++')) continue;

      // Hunk header
      if (line.startsWith('@@')) {
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = { header: line, lines: [], status: null };

        // Parse line numbers from @@ -oldStart,oldCount +newStart,newCount @@
        var match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          oldLine = parseInt(match[1], 10);
          newLine = parseInt(match[2], 10);
        }
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.substring(1), oldNum: null, newNum: newLine });
        newLine++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'del', content: line.substring(1), oldNum: oldLine, newNum: null });
        oldLine++;
      } else {
        // Context line (may or may not start with a space)
        var content = line.startsWith(' ') ? line.substring(1) : line;
        currentHunk.lines.push({ type: 'ctx', content: content, oldNum: oldLine, newNum: newLine });
        oldLine++;
        newLine++;
      }
    }

    if (currentHunk) hunks.push(currentHunk);

    return { filePath: filePath || 'unknown', hunks: hunks };
  };

  // ─── Convenience: wk.diffView ────────────────────────────────────
  // Matches the design doc API: wk.diffView(container, hunks, onAccept, onReject)

  function wkDiffView(container, diffs, onAccept, onReject) {
    var viewer = new DiffViewerComponent(container, {
      onAccept: onAccept || null,
      onReject: onReject || null
    });

    // Accept either pre-structured diffs array or raw hunks for a single file
    if (Array.isArray(diffs) && diffs.length > 0 && diffs[0].filePath) {
      viewer.setDiffs(diffs);
    } else if (Array.isArray(diffs)) {
      // Treat as hunks for a single file
      viewer.setDiffs([{ filePath: 'changes', hunks: diffs }]);
    } else {
      viewer.setDiffs([]);
    }

    return viewer;
  }

  // ─── Expose to Global Scope ──────────────────────────────────────

  if (typeof window !== 'undefined') {
    window.DiffViewerComponent = DiffViewerComponent;

    // Attach to wk namespace (workspace-ui-kit.js loads before this script)
    if (window.wk) {
      window.wk.diffView = wkDiffView;
    }
  }

})();
