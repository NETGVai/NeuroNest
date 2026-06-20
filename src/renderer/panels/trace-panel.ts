/**
 * TracePanel — Collapsible panel for viewing Execution Traces in real time.
 *
 * Features:
 * - Collapsible trace display adjacent to chat
 * - Real-time step updates as entries are added
 * - Failure highlighting with error messages and recovery marking
 * - Expandable entries showing parameters and results
 *
 * Requirements: 14.3, 14.4
 */

import type { ExecutionTrace, TraceEntry } from '../../shared/feature-integration-types.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

type TraceUpdateType = 'trace-started' | 'entry-added' | 'trace-completed';

interface TraceUpdate {
  updateType: TraceUpdateType;
  traceId: string;
  sessionId?: string;
  messageId?: string;
  startedAt?: string;
  entry?: TraceEntry;
  completedAt?: string;
  totalDurationMs?: number;
  totalTokens?: number;
}

type PanelView = 'list' | 'detail';

// ─── Constants ──────────────────────────────────────────────────

const TYPE_ICONS: Record<TraceEntry['type'], string> = {
  'tool-call': '🔧',
  'llm-request': '🤖',
  'decision': '🧭',
  'result': '✅',
  'error': '❌',
};

const TYPE_LABELS: Record<TraceEntry['type'], string> = {
  'tool-call': 'Tool Call',
  'llm-request': 'LLM Request',
  'decision': 'Decision',
  'result': 'Result',
  'error': 'Error',
};

// ─── Helpers ────────────────────────────────────────────────────

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatDate(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── TracePanel ─────────────────────────────────────────────────

export class TracePanel {
  private container: HTMLElement;
  private sessionId: string;
  private currentView: PanelView = 'list';
  private traces: ExecutionTrace[] = [];
  private selectedTrace: ExecutionTrace | null = null;
  private collapsed: boolean = false;
  private expandedEntries: Set<string> = new Set();
  private streamListener: ((...args: unknown[]) => void) | null = null;

  constructor(container: HTMLElement, sessionId: string) {
    this.container = container;
    this.sessionId = sessionId;
  }

  /** Initialize the panel and subscribe to real-time updates. */
  render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText =
      'display:flex;flex-direction:column;height:100%;font-family:var(--font-family,system-ui);';
    this.subscribeToStream();
    this.loadTraces();
  }

  /** Load all traces for the current session. */
  async loadTraces(): Promise<void> {
    this.currentView = 'list';
    this.selectedTrace = null;

    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading traces…</div>';

    try {
      const result = await eapi().invoke('trace:list-by-session', {
        sessionId: this.sessionId,
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.traces = (result as ExecutionTrace[]) ?? [];
      this.renderList();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Real-time streaming ────────────────────────────────────

  /** Subscribe to real-time trace updates for the current session. */
  private subscribeToStream(): void {
    // Register session-level subscription with main process
    eapi().invoke('trace:stream', {
      action: 'subscribe',
      sessionId: this.sessionId,
    }).catch((err) => {
      console.warn('[TracePanel] Failed to subscribe to stream:', err);
    });

    // Listen for pushed updates from main process
    this.streamListener = (...args: unknown[]) => {
      const update = args[1] as TraceUpdate | undefined;
      if (!update) return;
      this.handleStreamUpdate(update);
    };

    eapi().on('trace:update', this.streamListener);
  }

  /** Unsubscribe from real-time trace updates. */
  private unsubscribeFromStream(): void {
    eapi().invoke('trace:stream', {
      action: 'unsubscribe',
      sessionId: this.sessionId,
    }).catch(() => { /* ignore */ });

    if (this.streamListener) {
      eapi().removeListener('trace:update', this.streamListener);
      this.streamListener = null;
    }
  }

  /**
   * Handle a real-time trace update from the main process.
   * Requirement 14.3: Updating in real time as steps complete.
   */
  private handleStreamUpdate(update: TraceUpdate): void {
    switch (update.updateType) {
      case 'trace-started':
        this.handleTraceStarted(update);
        break;
      case 'entry-added':
        this.handleEntryAdded(update);
        break;
      case 'trace-completed':
        this.handleTraceCompleted(update);
        break;
    }
  }

  private handleTraceStarted(update: TraceUpdate): void {
    const newTrace: ExecutionTrace = {
      id: update.traceId,
      sessionId: update.sessionId ?? this.sessionId,
      messageId: update.messageId ?? '',
      entries: [],
      startedAt: update.startedAt ?? new Date().toISOString(),
      totalDurationMs: 0,
      totalTokens: 0,
    };

    // Add to front (newest first)
    this.traces.unshift(newTrace);

    if (this.currentView === 'list') {
      this.renderList();
    }
  }

  private handleEntryAdded(update: TraceUpdate): void {
    if (!update.entry) return;

    // Update in-memory trace
    const trace = this.traces.find((t) => t.id === update.traceId);
    if (trace) {
      trace.entries.push(update.entry);
      trace.totalTokens += update.entry.tokenCount ?? 0;
    }

    // If we're viewing this trace in detail, append the entry to the DOM
    if (this.currentView === 'detail' && this.selectedTrace?.id === update.traceId) {
      this.selectedTrace = trace ?? this.selectedTrace;
      this.appendEntryToDetail(update.entry);
    }
  }

  private handleTraceCompleted(update: TraceUpdate): void {
    const trace = this.traces.find((t) => t.id === update.traceId);
    if (trace) {
      trace.completedAt = update.completedAt;
      trace.totalDurationMs = update.totalDurationMs ?? trace.totalDurationMs;
      trace.totalTokens = update.totalTokens ?? trace.totalTokens;
    }

    // Refresh the current view to show completion status
    if (this.currentView === 'list') {
      this.renderList();
    } else if (this.currentView === 'detail' && this.selectedTrace?.id === update.traceId) {
      this.selectedTrace = trace ?? this.selectedTrace;
      this.updateDetailHeader();
    }
  }

  // ─── List View ──────────────────────────────────────────────

  private renderList(): void {
    this.container.innerHTML = '';

    // Collapsible header
    const header = this.createHeader('📋 Execution Traces', [
      {
        label: this.collapsed ? '▶' : '▼',
        title: this.collapsed ? 'Expand panel' : 'Collapse panel',
        onClick: () => this.toggleCollapse(),
      },
      { label: '↻', title: 'Refresh', onClick: () => this.loadTraces() },
    ]);
    this.container.appendChild(header);

    if (this.collapsed) return;

    // Empty state
    if (this.traces.length === 0) {
      this.container.appendChild(this.createEmptyState(
        'No execution traces yet. Traces appear here as agents execute tasks.',
      ));
      return;
    }

    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    for (const trace of this.traces) {
      listContainer.appendChild(this.createTraceRow(trace));
    }

    this.container.appendChild(listContainer);
  }

  private createTraceRow(trace: ExecutionTrace): HTMLElement {
    const row = document.createElement('div');
    const isActive = !trace.completedAt;
    const hasErrors = trace.entries.some((e) => e.type === 'error' || e.error);

    row.style.cssText =
      `display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid ${hasErrors ? 'var(--red,#ef4444)' : 'var(--border-color)'};border-radius:6px;background:var(--bg-input);margin-bottom:4px;cursor:pointer;transition:background 0.15s;`;

    if (isActive) {
      row.style.borderColor = 'var(--accent,#3b82f6)';
    }

    row.addEventListener('mouseenter', () => {
      row.style.background = 'var(--bg-hover,rgba(255,255,255,0.05))';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'var(--bg-input)';
    });
    row.addEventListener('click', () => this.openDetail(trace));

    // Status indicator
    const statusEl = document.createElement('span');
    statusEl.style.cssText = 'font-size:10px;flex-shrink:0;';
    if (isActive) {
      statusEl.textContent = '⏳';
      statusEl.title = 'Running';
    } else if (hasErrors) {
      statusEl.textContent = '⚠️';
      statusEl.title = 'Completed with errors';
    } else {
      statusEl.textContent = '✓';
      statusEl.title = 'Completed';
    }
    row.appendChild(statusEl);

    // Info area
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';

    const titleEl = document.createElement('div');
    titleEl.style.cssText =
      'font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    titleEl.textContent = `Trace ${trace.id.slice(0, 8)}…`;
    info.appendChild(titleEl);

    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
    const parts: string[] = [
      formatDate(trace.startedAt),
      `${trace.entries.length} steps`,
    ];
    if (trace.totalDurationMs > 0) {
      parts.push(formatDuration(trace.totalDurationMs));
    }
    if (trace.totalTokens > 0) {
      parts.push(`${trace.totalTokens} tokens`);
    }
    metaEl.textContent = parts.join(' · ');
    info.appendChild(metaEl);

    row.appendChild(info);
    return row;
  }

  // ─── Detail View ────────────────────────────────────────────

  private async openDetail(trace: ExecutionTrace): Promise<void> {
    this.selectedTrace = trace;
    this.currentView = 'detail';
    this.expandedEntries.clear();

    // If the trace was loaded from the list (summary), fetch the full trace
    if (trace.entries.length === 0) {
      this.container.innerHTML =
        '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading trace…</div>';

      try {
        const result = await eapi().invoke('trace:get', { traceId: trace.id });

        if (result && typeof result === 'object' && 'error' in (result as any)) {
          this.showError((result as any).message);
          return;
        }

        this.selectedTrace = result as ExecutionTrace;
      } catch (err: unknown) {
        this.showError(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    this.renderDetail();
  }

  private renderDetail(): void {
    if (!this.selectedTrace) return;
    this.container.innerHTML = '';

    // Header
    const header = this.createDetailHeader();
    this.container.appendChild(header);

    // Entries list (scrollable)
    const entriesContainer = document.createElement('div');
    entriesContainer.id = 'trace-entries-container';
    entriesContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    if (this.selectedTrace.entries.length === 0) {
      entriesContainer.appendChild(
        this.createEmptyState('Waiting for trace entries…'),
      );
    } else {
      for (const entry of this.selectedTrace.entries) {
        entriesContainer.appendChild(this.createEntryRow(entry));
      }
    }

    this.container.appendChild(entriesContainer);
  }

  private createDetailHeader(): HTMLElement {
    const trace = this.selectedTrace!;
    const isActive = !trace.completedAt;
    const hasErrors = trace.entries.some((e) => e.type === 'error' || e.error);

    const wrapper = document.createElement('div');
    wrapper.id = 'trace-detail-header';
    wrapper.style.cssText =
      'border-bottom:1px solid var(--border-color);';

    // Top bar with back button and title
    const header = this.createHeader(
      `📋 Trace ${trace.id.slice(0, 8)}…`,
      [{ label: '←', title: 'Back to list', onClick: () => this.loadTraces() }],
    );
    wrapper.appendChild(header);

    // Summary bar
    const summary = document.createElement('div');
    summary.style.cssText =
      'display:flex;align-items:center;gap:12px;padding:6px 12px;font-size:11px;color:var(--text-dim);flex-wrap:wrap;';

    // Status badge
    const badge = document.createElement('span');
    badge.style.cssText =
      `font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;`;
    if (isActive) {
      badge.style.background = 'var(--accent,#3b82f6)';
      badge.style.color = 'white';
      badge.textContent = '● Running';
    } else if (hasErrors) {
      badge.style.background = 'var(--red-container,rgba(248,113,113,0.12))';
      badge.style.color = 'var(--red,#ef4444)';
      badge.textContent = '⚠ Errors';
    } else {
      badge.style.background = 'var(--green-container,rgba(74,222,128,0.12))';
      badge.style.color = 'var(--green,#22c55e)';
      badge.textContent = '✓ Completed';
    }
    summary.appendChild(badge);

    // Metrics
    const metrics = document.createElement('span');
    const parts: string[] = [`${trace.entries.length} steps`];
    if (trace.totalDurationMs > 0) parts.push(formatDuration(trace.totalDurationMs));
    if (trace.totalTokens > 0) parts.push(`${trace.totalTokens} tokens`);
    metrics.textContent = parts.join(' · ');
    summary.appendChild(metrics);

    wrapper.appendChild(summary);
    return wrapper;
  }

  /** Update the detail header without re-rendering all entries. */
  private updateDetailHeader(): void {
    const existing = this.container.querySelector('#trace-detail-header');
    if (!existing) return;
    const newHeader = this.createDetailHeader();
    existing.replaceWith(newHeader);
  }

  /** Append a single entry to the detail view (for real-time updates). */
  private appendEntryToDetail(entry: TraceEntry): void {
    const entriesContainer = this.container.querySelector('#trace-entries-container');
    if (!entriesContainer) return;

    // Remove empty state if present
    const emptyState = entriesContainer.querySelector('[data-empty-state]');
    if (emptyState) emptyState.remove();

    entriesContainer.appendChild(this.createEntryRow(entry));

    // Auto-scroll to bottom for real-time updates
    entriesContainer.scrollTop = entriesContainer.scrollHeight;

    // Update header metrics
    this.updateDetailHeader();
  }

  /**
   * Create a collapsible entry row.
   * Requirement 14.3: Collapsible trace display with step details.
   * Requirement 14.4: Failure highlighting with error message.
   */
  private createEntryRow(entry: TraceEntry): HTMLElement {
    const isError = entry.type === 'error' || !!entry.error;
    const isExpanded = this.expandedEntries.has(entry.id);

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      `margin-bottom:4px;border:1px solid ${isError ? 'var(--red,#ef4444)' : 'var(--border-color)'};border-radius:6px;overflow:hidden;${isError ? 'background:var(--red-container,rgba(248,113,113,0.06));' : 'background:var(--bg-input);'}`;

    // Header row (always visible, clickable to expand)
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;user-select:none;';
    header.addEventListener('click', () => {
      if (this.expandedEntries.has(entry.id)) {
        this.expandedEntries.delete(entry.id);
      } else {
        this.expandedEntries.add(entry.id);
      }
      wrapper.replaceWith(this.createEntryRow(entry));
    });

    // Expand/collapse indicator
    const arrow = document.createElement('span');
    arrow.style.cssText = 'font-size:10px;color:var(--text-dim);flex-shrink:0;width:12px;';
    arrow.textContent = isExpanded ? '▼' : '▶';
    header.appendChild(arrow);

    // Sequence number
    const seqEl = document.createElement('span');
    seqEl.style.cssText =
      'font-size:10px;font-weight:700;color:var(--text-dim);flex-shrink:0;min-width:20px;';
    seqEl.textContent = `#${entry.sequence}`;
    header.appendChild(seqEl);

    // Type icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:12px;flex-shrink:0;';
    icon.textContent = TYPE_ICONS[entry.type] ?? '•';
    icon.title = TYPE_LABELS[entry.type] ?? entry.type;
    header.appendChild(icon);

    // Entry label
    const label = document.createElement('span');
    label.style.cssText =
      `font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${isError ? 'var(--red,#ef4444)' : 'var(--text-primary)'};`;

    if (entry.toolName) {
      label.textContent = entry.toolName;
    } else if (entry.type === 'error') {
      label.textContent = entry.error ?? 'Error';
    } else {
      label.textContent = TYPE_LABELS[entry.type] ?? entry.type;
    }
    header.appendChild(label);

    // Duration badge
    if (entry.durationMs != null) {
      const dur = document.createElement('span');
      dur.style.cssText =
        'font-size:9px;color:var(--text-dim);flex-shrink:0;';
      dur.textContent = formatDuration(entry.durationMs);
      header.appendChild(dur);
    }

    // Timestamp
    const tsEl = document.createElement('span');
    tsEl.style.cssText = 'font-size:9px;color:var(--text-dim);flex-shrink:0;';
    tsEl.textContent = formatTimestamp(entry.timestamp);
    header.appendChild(tsEl);

    wrapper.appendChild(header);

    // Expanded detail section
    if (isExpanded) {
      const detail = document.createElement('div');
      detail.style.cssText =
        'padding:6px 10px 8px 38px;border-top:1px solid var(--border-color);font-size:11px;';

      // Parameters
      if (entry.parameters && Object.keys(entry.parameters).length > 0) {
        detail.appendChild(this.createDetailSection('Parameters', entry.parameters));
      }

      // Result
      if (entry.result !== undefined && entry.result !== null) {
        detail.appendChild(this.createDetailSection('Result', entry.result));
      }

      // Token count
      if (entry.tokenCount != null) {
        const tokenEl = document.createElement('div');
        tokenEl.style.cssText = 'color:var(--text-dim);margin-top:4px;';
        tokenEl.textContent = `Tokens: ${entry.tokenCount}`;
        detail.appendChild(tokenEl);
      }

      // Error message — Requirement 14.4: Highlight failure with error message
      if (entry.error) {
        const errorEl = document.createElement('div');
        errorEl.style.cssText =
          'margin-top:6px;padding:6px 8px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:4px;color:var(--red,#ef4444);font-size:11px;white-space:pre-wrap;word-break:break-word;';
        errorEl.textContent = `⚠ Error: ${entry.error}`;
        detail.appendChild(errorEl);
      }

      wrapper.appendChild(detail);
    }

    return wrapper;
  }

  /** Render a key-value section in the expanded entry detail. */
  private createDetailSection(label: string, data: unknown): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:4px;';

    const labelEl = document.createElement('div');
    labelEl.style.cssText =
      'font-size:10px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;';
    labelEl.textContent = label;
    section.appendChild(labelEl);

    const pre = document.createElement('pre');
    pre.style.cssText =
      'background:var(--bg-code,#1e1e1e);color:var(--text-code,#d4d4d4);padding:6px 8px;border-radius:4px;font-size:10px;font-family:var(--font-mono,"Fira Code",monospace);overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow-y:auto;margin:0;';
    pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    section.appendChild(pre);

    return section;
  }

  // ─── Collapse toggle ───────────────────────────────────────

  /** Toggle collapsed state (Requirement 14.3: collapsible panel). */
  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    if (this.currentView === 'list') {
      this.renderList();
    }
  }

  // ─── UI Helpers ───────────────────────────────────────────

  private createHeader(
    title: string,
    buttons: Array<{ label: string; title: string; onClick: () => void }>,
  ): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-bottom:1px solid var(--border-color);min-height:36px;';

    const titleEl = document.createElement('span');
    titleEl.style.cssText =
      'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    if (buttons.length > 0) {
      const btnGroup = document.createElement('div');
      btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

      for (const btn of buttons) {
        const el = document.createElement('button');
        el.textContent = btn.label;
        el.title = btn.title;
        el.setAttribute('aria-label', btn.title);
        el.style.cssText =
          'font-size:13px;width:28px;height:28px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
        el.addEventListener('click', btn.onClick);
        btnGroup.appendChild(el);
      }

      header.appendChild(btnGroup);
    }

    return header;
  }

  private createEmptyState(message: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText =
      'text-align:center;padding:32px 16px;color:var(--text-dim);font-size:12px;';
    el.setAttribute('data-empty-state', 'true');
    el.textContent = message;
    return el;
  }

  private showError(message: string): void {
    this.container.innerHTML = '';

    const header = this.createHeader('📋 Execution Traces', [
      { label: '↻', title: 'Retry', onClick: () => this.loadTraces() },
    ]);
    this.container.appendChild(header);

    const errorEl = document.createElement('div');
    errorEl.style.cssText =
      'margin:12px;padding:12px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:8px;font-size:12px;color:var(--red,#ef4444);';
    errorEl.textContent = `Error: ${message}`;
    this.container.appendChild(errorEl);
  }

  /** Clean up resources and unsubscribe from streams. */
  destroy(): void {
    this.unsubscribeFromStream();
    this.container.innerHTML = '';
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the trace panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderTracePanel(
  container: HTMLElement,
  sessionId: string,
): TracePanel {
  const panel = new TracePanel(container, sessionId);
  panel.render();
  return panel;
}
