/**
 * NotebookPanel — Renderer panel for interactive notebook editing and execution.
 *
 * Displays notebook with rendered markdown cells and executable code cells.
 * Shows cell outputs inline (text, images, tables).
 * Wires IPC channels: notebook:create, notebook:add-cell, notebook:run-cell,
 * notebook:get-output, notebook:get-cells, notebook:kernel-status.
 *
 * Gated behind `notebook_integration` feature flag.
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 * Follows the same Vanilla JS + DOM manipulation pattern as process-manager-panel.ts.
 *
 * Requirements: 20.3
 */

// ─── Helpers ───────────────────────────────────────────────────────
function nbEscHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function nbApi() {
  return window.electronAPI;
}

// ─── Kernel status colors ──────────────────────────────────────────
var NB_KERNEL_COLORS = {
  idle: '#34d399',
  busy: '#fbbf24',
  starting: '#60a5fa',
  dead: '#f87171',
  restarting: '#fbbf24',
};

// ─── NotebookPanel class ───────────────────────────────────────────
function NotebookPanel(container) {
  this.container = container;
  this.notebookId = null;
  this.notebookName = '';
  this.cells = [];
  this.kernelStatus = 'dead';
  this.language = 'python';
}

NotebookPanel.prototype.render = function () {
  var self = this;
  this.container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border-color);';

  var titleArea = document.createElement('div');
  titleArea.style.cssText = 'display:flex;align-items:center;gap:8px;';

  var icon = document.createElement('span');
  icon.textContent = '\uD83D\uDCD3';
  icon.style.fontSize = '16px';
  titleArea.appendChild(icon);

  var title = document.createElement('h4');
  title.style.cssText = 'margin:0;font-size:13px;color:var(--text-primary);';
  title.textContent = this.notebookId ? this.notebookName : 'Notebook';
  titleArea.appendChild(title);

  // Kernel status badge
  var badge = document.createElement('span');
  badge.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:8px;background:' + (NB_KERNEL_COLORS[this.kernelStatus] || '#6b7280') + ';color:#fff;';
  badge.textContent = this.kernelStatus;
  titleArea.appendChild(badge);

  header.appendChild(titleArea);

  // Actions
  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;';

  if (!this.notebookId) {
    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.textContent = '+ New Notebook';
    createBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-accent);color:#fff;border-radius:6px;cursor:pointer;';
    createBtn.addEventListener('click', function () { self.showCreateDialog(); });
    actions.appendChild(createBtn);
  } else {
    var addCodeBtn = document.createElement('button');
    addCodeBtn.type = 'button';
    addCodeBtn.textContent = '+ Code';
    addCodeBtn.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
    addCodeBtn.addEventListener('click', function () { self.addCell('code'); });
    actions.appendChild(addCodeBtn);

    var addMdBtn = document.createElement('button');
    addMdBtn.type = 'button';
    addMdBtn.textContent = '+ Markdown';
    addMdBtn.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
    addMdBtn.addEventListener('click', function () { self.addCell('markdown'); });
    actions.appendChild(addMdBtn);

    var restartBtn = document.createElement('button');
    restartBtn.type = 'button';
    restartBtn.textContent = '\u21BB Restart Kernel';
    restartBtn.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
    restartBtn.addEventListener('click', function () { self.restartKernel(); });
    actions.appendChild(restartBtn);
  }

  header.appendChild(actions);
  this.container.appendChild(header);

  // Cell list
  this.cellList = document.createElement('div');
  this.cellList.style.cssText = 'display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:calc(100vh - 200px);';

  if (!this.notebookId) {
    this.cellList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:32px 16px;text-align:center;">No notebook open. Create a new notebook or open an existing .ipynb file.</div>';
  } else if (this.cells.length === 0) {
    this.cellList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:32px 16px;text-align:center;">Empty notebook. Add a code or markdown cell to get started.</div>';
  } else {
    this.renderCells();
  }

  this.container.appendChild(this.cellList);

  // Listen for IPC events
  this.setupListeners();
};

NotebookPanel.prototype.renderCells = function () {
  var self = this;
  this.cellList.innerHTML = '';

  for (var i = 0; i < this.cells.length; i++) {
    var cell = this.cells[i];
    var cellEl = this.createCellElement(cell, i);
    this.cellList.appendChild(cellEl);
  }
};

NotebookPanel.prototype.createCellElement = function (cell, index) {
  var self = this;
  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'border:1px solid var(--border-color);border-radius:8px;overflow:hidden;background:var(--bg-card);';
  wrapper.dataset.cellId = cell.id;

  // Cell header
  var cellHeader = document.createElement('div');
  cellHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--bg-surface);border-bottom:1px solid var(--border-color);';

  var cellType = document.createElement('span');
  cellType.style.cssText = 'font-size:10px;color:var(--text-dim);text-transform:uppercase;font-weight:600;';
  cellType.textContent = cell.type === 'code' ? '[' + (cell.executionCount || ' ') + '] ' + self.language : 'Markdown';
  cellHeader.appendChild(cellType);

  var cellActions = document.createElement('div');
  cellActions.style.cssText = 'display:flex;gap:4px;';

  if (cell.type === 'code') {
    var runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.textContent = '\u25B6 Run';
    runBtn.style.cssText = 'font-size:10px;padding:2px 6px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;';
    runBtn.addEventListener('click', function () { self.runCell(cell.id); });
    cellActions.appendChild(runBtn);
  }

  var deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.textContent = '\u2715';
  deleteBtn.style.cssText = 'font-size:10px;padding:2px 6px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-dim);border-radius:4px;cursor:pointer;';
  deleteBtn.addEventListener('click', function () { self.deleteCell(cell.id); });
  cellActions.appendChild(deleteBtn);

  cellHeader.appendChild(cellActions);
  wrapper.appendChild(cellHeader);

  // Cell source
  var sourceArea = document.createElement('div');
  sourceArea.style.cssText = 'padding:8px;';

  if (cell.type === 'code') {
    var textarea = document.createElement('textarea');
    textarea.value = cell.source;
    textarea.style.cssText = 'width:100%;min-height:60px;border:none;background:var(--bg-code,#1e1e1e);color:var(--text-code,#d4d4d4);font-family:monospace;font-size:12px;padding:8px;border-radius:4px;resize:vertical;outline:none;';
    textarea.addEventListener('blur', function () {
      self.editCell(cell.id, textarea.value);
    });
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
        e.preventDefault();
        self.editCell(cell.id, textarea.value);
        self.runCell(cell.id);
      }
    });
    sourceArea.appendChild(textarea);
  } else {
    // Render markdown (simple rendering)
    var mdDiv = document.createElement('div');
    mdDiv.style.cssText = 'font-size:12px;color:var(--text-primary);line-height:1.5;padding:4px;';
    mdDiv.innerHTML = self.renderMarkdown(cell.source);
    sourceArea.appendChild(mdDiv);
  }

  wrapper.appendChild(sourceArea);

  // Cell outputs (code cells only)
  if (cell.type === 'code' && cell.outputs && cell.outputs.length > 0) {
    var outputArea = document.createElement('div');
    outputArea.style.cssText = 'border-top:1px solid var(--border-color);padding:8px;background:var(--bg-surface);';

    for (var j = 0; j < cell.outputs.length; j++) {
      var output = cell.outputs[j];
      var outputEl = self.createOutputElement(output);
      outputArea.appendChild(outputEl);
    }

    wrapper.appendChild(outputArea);
  }

  return wrapper;
};

NotebookPanel.prototype.createOutputElement = function (output) {
  var el = document.createElement('div');
  el.style.cssText = 'margin-bottom:4px;';

  switch (output.type) {
    case 'text':
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;font-size:11px;font-family:monospace;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;';
      pre.textContent = output.content;
      el.appendChild(pre);
      break;

    case 'image':
      var img = document.createElement('img');
      var mimeType = output.mimeType || 'image/png';
      img.src = 'data:' + mimeType + ';base64,' + output.content;
      img.style.cssText = 'max-width:100%;border-radius:4px;';
      img.alt = 'Cell output';
      el.appendChild(img);
      break;

    case 'table':
      var tableDiv = document.createElement('div');
      tableDiv.style.cssText = 'overflow-x:auto;';
      var table = document.createElement('table');
      table.style.cssText = 'font-size:11px;border-collapse:collapse;width:100%;';
      var rows = output.content.split('\n').filter(function (r) { return r.trim(); });
      for (var k = 0; k < rows.length; k++) {
        var tr = document.createElement('tr');
        var cols = rows[k].split('\t');
        for (var l = 0; l < cols.length; l++) {
          var td = document.createElement(k === 0 ? 'th' : 'td');
          td.style.cssText = 'padding:4px 8px;border:1px solid var(--border-color);text-align:left;';
          td.textContent = cols[l];
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      tableDiv.appendChild(table);
      el.appendChild(tableDiv);
      break;

    case 'error':
      var errPre = document.createElement('pre');
      errPre.style.cssText = 'margin:0;font-size:11px;font-family:monospace;color:#f87171;white-space:pre-wrap;word-break:break-word;';
      errPre.textContent = output.content;
      el.appendChild(errPre);
      break;
  }

  return el;
};

NotebookPanel.prototype.renderMarkdown = function (source) {
  // Simple markdown rendering (headings, bold, italic, code, links)
  var html = nbEscHtml(source);
  html = html.replace(/^### (.+)$/gm, '<h5 style="margin:4px 0;">$1</h5>');
  html = html.replace(/^## (.+)$/gm, '<h4 style="margin:4px 0;">$1</h4>');
  html = html.replace(/^# (.+)$/gm, '<h3 style="margin:4px 0;">$1</h3>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code style="background:var(--bg-code);padding:1px 3px;border-radius:2px;font-size:11px;">$1</code>');
  html = html.replace(/\n/g, '<br>');
  return html;
};

// ─── Actions ───────────────────────────────────────────────────────
NotebookPanel.prototype.showCreateDialog = function () {
  var self = this;
  var name = prompt('Notebook name:', 'Untitled');
  if (!name) return;

  var api = nbApi();
  if (!api || !api.invoke) return;

  api.invoke('notebook:create', { name: name, language: 'python' }).then(function (result) {
    if (result && result.success) {
      self.notebookId = result.notebook.id;
      self.notebookName = result.notebook.name;
      self.language = result.notebook.language || 'python';
      self.cells = [];
      self.render();
    }
  });
};

NotebookPanel.prototype.addCell = function (type) {
  var self = this;
  var api = nbApi();
  if (!api || !api.invoke || !self.notebookId) return;

  var source = type === 'code' ? '# Enter code here\n' : '# Title\n\nEnter text here.';

  api.invoke('notebook:add-cell', { notebookId: self.notebookId, type: type, source: source }).then(function (result) {
    if (result && result.success) {
      self.cells.push(result.cell);
      self.renderCells();
    }
  });
};

NotebookPanel.prototype.editCell = function (cellId, newSource) {
  var self = this;
  var api = nbApi();
  if (!api || !api.invoke || !self.notebookId) return;

  api.invoke('notebook:edit-cell', { notebookId: self.notebookId, cellId: cellId, source: newSource }).then(function (result) {
    if (result && result.success) {
      for (var i = 0; i < self.cells.length; i++) {
        if (self.cells[i].id === cellId) {
          self.cells[i].source = newSource;
          break;
        }
      }
    }
  });
};

NotebookPanel.prototype.deleteCell = function (cellId) {
  var self = this;
  var api = nbApi();
  if (!api || !api.invoke || !self.notebookId) return;

  api.invoke('notebook:delete-cell', { notebookId: self.notebookId, cellId: cellId }).then(function (result) {
    if (result && result.success) {
      self.cells = self.cells.filter(function (c) { return c.id !== cellId; });
      self.renderCells();
    }
  });
};

NotebookPanel.prototype.runCell = function (cellId) {
  var self = this;
  var api = nbApi();
  if (!api || !api.invoke || !self.notebookId) return;

  // Mark cell as executing visually
  var cellEl = self.cellList.querySelector('[data-cell-id="' + cellId + '"]');
  if (cellEl) {
    cellEl.style.borderColor = '#fbbf24';
  }

  self.kernelStatus = 'busy';
  self.render();

  api.invoke('notebook:run-cell', { notebookId: self.notebookId, cellId: cellId }).then(function (result) {
    self.kernelStatus = 'idle';
    if (result && result.success && result.result) {
      // Update cell outputs
      for (var i = 0; i < self.cells.length; i++) {
        if (self.cells[i].id === cellId) {
          self.cells[i].outputs = result.result.outputs;
          self.cells[i].executionCount = result.result.executionCount;
          break;
        }
      }
    }
    self.renderCells();
  }).catch(function () {
    self.kernelStatus = 'idle';
    self.renderCells();
  });
};

NotebookPanel.prototype.restartKernel = function () {
  var self = this;
  var api = nbApi();
  if (!api || !api.invoke || !self.notebookId) return;

  self.kernelStatus = 'restarting';
  self.render();

  api.invoke('notebook:restart-kernel', { notebookId: self.notebookId }).then(function (result) {
    if (result && result.success && result.kernel) {
      self.kernelStatus = result.kernel.status;
    } else {
      self.kernelStatus = 'dead';
    }
    self.render();
  });
};

NotebookPanel.prototype.loadCells = function () {
  var self = this;
  var api = nbApi();
  if (!api || !api.invoke || !self.notebookId) return;

  api.invoke('notebook:get-cells', { notebookId: self.notebookId }).then(function (result) {
    if (result && result.success) {
      self.cells = result.cells;
      self.renderCells();
    }
  });
};

// ─── Event Listeners ───────────────────────────────────────────────
NotebookPanel.prototype.setupListeners = function () {
  var self = this;
  var api = nbApi();
  if (!api || !api.receive) return;

  api.receive('notebook:cell-executed', function (data) {
    if (data && data.notebookId === self.notebookId) {
      self.kernelStatus = 'idle';
      self.loadCells();
    }
  });

  api.receive('notebook:kernel-event', function (data) {
    if (!data) return;
    if (data.event === 'started') self.kernelStatus = 'idle';
    else if (data.event === 'crashed') self.kernelStatus = 'dead';
    else if (data.event === 'restarting') self.kernelStatus = 'restarting';
    else if (data.event === 'shutdown') self.kernelStatus = 'dead';
    self.render();
  });
};

NotebookPanel.prototype.destroy = function () {
  // Cleanup on unmount (no-op for now; future: remove listeners)
};

// ─── Export ────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.NotebookPanel = NotebookPanel;
}
