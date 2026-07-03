/**
 * ApprovalGatePanel — Renderer component for the file change approval workflow.
 *
 * Displays after task completion when file modifications are detected.
 * Provides three decision options:
 * - Approve All: accept all changes and proceed with commit
 * - Reject All: revert all files to pre-task state
 * - Selective: approve/reject individual file changes
 *
 * Listens on `agent:approval-request` IPC channel.
 * Sends decisions via `approval:respond` IPC channel.
 *
 * The gate remains accessible until dismissed or a new task starts.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

interface ApprovalRequest {
  sessionId: string;
  changeSummary: ChangeSummary;
  hunks: DiffHunk[];
  mode: 'full' | 'per-hunk';
}

interface ChangeSummary {
  sessionId: string;
  created: FileChangeRecord[];
  modified: FileChangeRecord[];
  deleted: FileChangeRecord[];
  totalToolCalls: number;
  totalIterations: number;
  durationMs: number;
}

interface FileChangeRecord {
  filePath: string;
  timestamp: number;
  toolCallId: string;
  sizeDelta?: number;
}

interface DiffHunk {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

type ApprovalDecision =
  | { action: 'approve_all' }
  | { action: 'reject_all' }
  | { action: 'selective'; approved: string[]; rejected: string[] };

interface ApprovalGateState {
  visible: boolean;
  request: ApprovalRequest | null;
  selectedHunks: Set<string>;
}

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function shortPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 3
    ? `.../${parts.slice(-3).join('/')}`
    : filePath;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ─── ApprovalGatePanel ──────────────────────────────────────────

export class ApprovalGatePanel {
  private container: HTMLElement;
  private state: ApprovalGateState;
  private ipcListener: ((...args: unknown[]) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = {
      visible: false,
      request: null,
      selectedHunks: new Set(),
    };
  }

  /**
   * Initialize the panel and start listening for approval requests.
   */
  init(): void {
    this.setupIPCListener();
    this.render();
  }

  /**
   * Show the approval gate with a specific request.
   * Called programmatically or via IPC event.
   */
  show(request: ApprovalRequest): void {
    // Default: select all files for approval
    const allFilePaths = this.getAllFilePaths(request);
    this.state = {
      visible: true,
      request,
      selectedHunks: new Set(allFilePaths),
    };
    this.render();
  }

  /**
   * Dismiss the approval gate.
   *
   * Requirement 11.5: Gate remains accessible until dismissed or new task starts.
   */
  dismiss(): void {
    this.state = {
      visible: false,
      request: null,
      selectedHunks: new Set(),
    };
    this.render();
  }

  /**
   * Check if the gate is currently visible.
   */
  isVisible(): boolean {
    return this.state.visible;
  }

  /**
   * Clean up IPC listeners on destroy.
   */
  destroy(): void {
    if (this.ipcListener) {
      eapi().removeListener('agent:approval-request', this.ipcListener);
      this.ipcListener = null;
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';

    if (!this.state.visible || !this.state.request) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'block';
    const { request } = this.state;

    // Wrapper
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'border:1px solid var(--border-color);border-radius:8px;background:var(--bg-panel,var(--bg-input));padding:16px;margin:8px 0;';
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-label', 'Approval Gate: Review changes before committing');

    // Header
    wrapper.appendChild(this.renderHeader(request));

    // Change summary
    wrapper.appendChild(this.renderChangeSummary(request.changeSummary));

    // File list with selection (for selective mode)
    wrapper.appendChild(this.renderFileList(request));

    // Action buttons
    wrapper.appendChild(this.renderActions());

    this.container.appendChild(wrapper);
  }

  private renderHeader(request: ApprovalRequest): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:18px;';
    icon.textContent = '🔒';
    titleRow.appendChild(icon);

    const title = document.createElement('h3');
    title.style.cssText =
      'margin:0;font-size:14px;font-weight:600;color:var(--text-primary);';
    title.textContent = 'Review Changes';
    titleRow.appendChild(title);

    header.appendChild(titleRow);

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.style.cssText =
      'background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:16px;padding:4px;border-radius:4px;';
    dismissBtn.setAttribute('aria-label', 'Dismiss approval gate');
    dismissBtn.textContent = '✕';
    dismissBtn.addEventListener('click', () => this.dismiss());
    header.appendChild(dismissBtn);

    return header;
  }

  private renderChangeSummary(summary: ChangeSummary): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText =
      'display:flex;gap:12px;margin-bottom:12px;padding:8px 12px;background:var(--bg-hover,rgba(128,128,128,0.05));border-radius:6px;font-size:11px;color:var(--text-secondary);flex-wrap:wrap;';

    const stats: Array<{ label: string; value: string; color?: string }> = [];

    if (summary.created.length > 0) {
      stats.push({ label: 'Created', value: String(summary.created.length), color: 'var(--green,#22c55e)' });
    }
    if (summary.modified.length > 0) {
      stats.push({ label: 'Modified', value: String(summary.modified.length), color: 'var(--accent,#3b82f6)' });
    }
    if (summary.deleted.length > 0) {
      stats.push({ label: 'Deleted', value: String(summary.deleted.length), color: 'var(--red,#ef4444)' });
    }
    stats.push({ label: 'Tool calls', value: String(summary.totalToolCalls) });
    stats.push({ label: 'Duration', value: formatDuration(summary.durationMs) });

    for (const stat of stats) {
      const item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
      if (stat.color) {
        const dot = document.createElement('span');
        dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${stat.color};`;
        item.appendChild(dot);
      }
      const text = document.createElement('span');
      text.textContent = `${stat.label}: ${stat.value}`;
      item.appendChild(text);
      section.appendChild(item);
    }

    return section;
  }

  private renderFileList(request: ApprovalRequest): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText =
      'max-height:240px;overflow-y:auto;margin-bottom:12px;border:1px solid var(--border-color);border-radius:6px;';

    const allFiles = this.getAllFileEntries(request);

    if (allFiles.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;text-align:center;color:var(--text-dim);font-size:12px;';
      empty.textContent = 'No file changes to review.';
      section.appendChild(empty);
      return section;
    }

    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      const isSelected = this.state.selectedHunks.has(file.filePath);
      const isLast = i === allFiles.length - 1;

      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:8px 12px',
        'font-size:12px',
        `border-bottom:${isLast ? 'none' : '1px solid var(--border-color)'}`,
        'transition:background 0.1s',
      ].join(';');

      // Checkbox for selective approval
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isSelected;
      checkbox.id = `approval-file-${i}`;
      checkbox.setAttribute('aria-label', `Include ${file.filePath} in approval`);
      checkbox.style.cssText = 'flex-shrink:0;cursor:pointer;';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.state.selectedHunks.add(file.filePath);
        } else {
          this.state.selectedHunks.delete(file.filePath);
        }
      });
      row.appendChild(checkbox);

      // Operation badge
      const badge = document.createElement('span');
      badge.style.cssText =
        'font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600;flex-shrink:0;';
      switch (file.operation) {
        case 'created':
          badge.style.background = 'rgba(34,197,94,0.15)';
          badge.style.color = 'var(--green,#22c55e)';
          badge.textContent = 'NEW';
          break;
        case 'modified':
          badge.style.background = 'rgba(59,130,246,0.15)';
          badge.style.color = 'var(--accent,#3b82f6)';
          badge.textContent = 'MOD';
          break;
        case 'deleted':
          badge.style.background = 'rgba(239,68,68,0.15)';
          badge.style.color = 'var(--red,#ef4444)';
          badge.textContent = 'DEL';
          break;
      }
      row.appendChild(badge);

      // File path
      const label = document.createElement('label');
      label.htmlFor = `approval-file-${i}`;
      label.style.cssText =
        'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);cursor:pointer;font-family:var(--font-mono,monospace);font-size:11px;';
      label.title = file.filePath;
      label.textContent = shortPath(file.filePath);
      row.appendChild(label);

      // Size delta
      if (file.sizeDelta !== undefined && file.sizeDelta !== 0) {
        const delta = document.createElement('span');
        delta.style.cssText = `font-size:10px;color:${file.sizeDelta > 0 ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)'};`;
        delta.textContent = file.sizeDelta > 0 ? `+${file.sizeDelta}B` : `${file.sizeDelta}B`;
        row.appendChild(delta);
      }

      section.appendChild(row);
    }

    return section;
  }

  private renderActions(): HTMLElement {
    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';

    // Reject All button
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.style.cssText = [
      'padding:8px 16px',
      'border:1px solid var(--red,#ef4444)',
      'background:transparent',
      'color:var(--red,#ef4444)',
      'border-radius:6px',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'transition:background 0.15s',
    ].join(';');
    rejectBtn.textContent = 'Reject All';
    rejectBtn.setAttribute('aria-label', 'Reject all changes and revert files');
    rejectBtn.addEventListener('click', () => this.submitDecision({ action: 'reject_all' }));
    rejectBtn.addEventListener('mouseenter', () => {
      rejectBtn.style.background = 'rgba(239,68,68,0.1)';
    });
    rejectBtn.addEventListener('mouseleave', () => {
      rejectBtn.style.background = 'transparent';
    });
    actions.appendChild(rejectBtn);

    // Selective Approve button
    const selectiveBtn = document.createElement('button');
    selectiveBtn.type = 'button';
    selectiveBtn.style.cssText = [
      'padding:8px 16px',
      'border:1px solid var(--accent,#3b82f6)',
      'background:transparent',
      'color:var(--accent,#3b82f6)',
      'border-radius:6px',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'transition:background 0.15s',
    ].join(';');
    selectiveBtn.textContent = 'Approve Selected';
    selectiveBtn.setAttribute('aria-label', 'Approve only selected file changes');
    selectiveBtn.addEventListener('click', () => this.submitSelectiveDecision());
    selectiveBtn.addEventListener('mouseenter', () => {
      selectiveBtn.style.background = 'rgba(59,130,246,0.1)';
    });
    selectiveBtn.addEventListener('mouseleave', () => {
      selectiveBtn.style.background = 'transparent';
    });
    actions.appendChild(selectiveBtn);

    // Approve All button
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.style.cssText = [
      'padding:8px 16px',
      'border:none',
      'background:var(--green,#22c55e)',
      'color:white',
      'border-radius:6px',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'transition:opacity 0.15s',
    ].join(';');
    approveBtn.textContent = 'Approve All';
    approveBtn.setAttribute('aria-label', 'Approve all changes and proceed with commit');
    approveBtn.addEventListener('click', () => this.submitDecision({ action: 'approve_all' }));
    approveBtn.addEventListener('mouseenter', () => {
      approveBtn.style.opacity = '0.9';
    });
    approveBtn.addEventListener('mouseleave', () => {
      approveBtn.style.opacity = '1';
    });
    actions.appendChild(approveBtn);

    return actions;
  }

  // ─── Decision Submission ────────────────────────────────────────

  private submitDecision(decision: ApprovalDecision): void {
    eapi().send('approval:respond', decision);
    this.dismiss();
  }

  private submitSelectiveDecision(): void {
    if (!this.state.request) return;

    const allFiles = this.getAllFilePaths(this.state.request);
    const approved = allFiles.filter((fp) => this.state.selectedHunks.has(fp));
    const rejected = allFiles.filter((fp) => !this.state.selectedHunks.has(fp));

    const decision: ApprovalDecision = {
      action: 'selective',
      approved,
      rejected,
    };

    eapi().send('approval:respond', decision);
    this.dismiss();
  }

  // ─── IPC Handling ─────────────────────────────────────────────

  private setupIPCListener(): void {
    this.ipcListener = (...args: unknown[]) => {
      const request = args[0] as ApprovalRequest;
      if (request && request.sessionId && request.changeSummary) {
        this.show(request);
      }
    };
    eapi().on('agent:approval-request', this.ipcListener);
  }

  // ─── Utility ──────────────────────────────────────────────────

  private getAllFilePaths(request: ApprovalRequest): string[] {
    const paths: string[] = [];
    for (const record of request.changeSummary.created) paths.push(record.filePath);
    for (const record of request.changeSummary.modified) paths.push(record.filePath);
    for (const record of request.changeSummary.deleted) paths.push(record.filePath);
    return paths;
  }

  private getAllFileEntries(request: ApprovalRequest): Array<{
    filePath: string;
    operation: 'created' | 'modified' | 'deleted';
    sizeDelta?: number;
  }> {
    const entries: Array<{
      filePath: string;
      operation: 'created' | 'modified' | 'deleted';
      sizeDelta?: number;
    }> = [];

    for (const record of request.changeSummary.created) {
      entries.push({ filePath: record.filePath, operation: 'created', sizeDelta: record.sizeDelta });
    }
    for (const record of request.changeSummary.modified) {
      entries.push({ filePath: record.filePath, operation: 'modified', sizeDelta: record.sizeDelta });
    }
    for (const record of request.changeSummary.deleted) {
      entries.push({ filePath: record.filePath, operation: 'deleted', sizeDelta: record.sizeDelta });
    }

    return entries;
  }
}

// ─── Convenience Export ─────────────────────────────────────────

/**
 * Create and initialize an ApprovalGatePanel in the given container.
 */
export function createApprovalGatePanel(container: HTMLElement): ApprovalGatePanel {
  const panel = new ApprovalGatePanel(container);
  panel.init();
  return panel;
}
