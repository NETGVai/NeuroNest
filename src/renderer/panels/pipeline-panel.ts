/**
 * PipelinePanel — Renderer panel for pipeline management and execution trace display.
 *
 * Features:
 * - Pipeline list view with execute/delete actions
 * - Execution trace display showing step status (pending/running/completed/failed)
 * - Real-time updates during pipeline execution
 * - Quick action toolbar with buttons for each configured quick action
 *
 * Requirements: 4.3, 5.1
 */

import type {
  PipelineDefinition,
  PipelineExecution,
  StepExecution,
  QuickAction,
} from '../../shared/feature-integration-types.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
type PanelView = 'list' | 'execution' | 'define';

// ─── Constants ──────────────────────────────────────────────────

const STATUS_ICONS: Record<StepStatus, string> = {
  pending: '⏳',
  running: '⚙️',
  completed: '✅',
  failed: '❌',
  skipped: '⏭️',
};

const STATUS_COLORS: Record<StepStatus, string> = {
  pending: 'var(--text-dim, #888)',
  running: 'var(--accent, #3b82f6)',
  completed: 'var(--green, #22c55e)',
  failed: 'var(--red, #ef4444)',
  skipped: 'var(--text-dim, #888)',
};

const QUICK_ACTION_ICONS: Record<string, string> = {
  component: '🧩',
  test: '🧪',
  lint: '✨',
  api: '🔌',
  package: '📦',
};

// ─── Helpers ────────────────────────────────────────────────────

function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
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

// ─── PipelinePanel ──────────────────────────────────────────────

export class PipelinePanel {
  private container: HTMLElement;
  private projectDir: string;
  private currentView: PanelView = 'list';
  private pipelines: PipelineDefinition[] = [];
  private quickActions: QuickAction[] = [];
  private currentExecution: PipelineExecution | null = null;
  private executionPollingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement, projectDir: string) {
    this.container = container;
    this.projectDir = projectDir;
  }

  /** Render the panel and load initial data. */
  render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText =
      'display:flex;flex-direction:column;height:100%;font-family:var(--font-family,system-ui);';
    this.loadPipelines();
  }

  /** Load pipeline list and quick actions. */
  async loadPipelines(): Promise<void> {
    this.currentView = 'list';
    this.currentExecution = null;
    this.stopPolling();

    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading pipelines…</div>';

    try {
      const [pipelineResult, quickActionResult] = await Promise.all([
        eapi().invoke('pipeline:list'),
        eapi().invoke('quickaction:list'),
      ]);

      if (pipelineResult && typeof pipelineResult === 'object' && 'error' in (pipelineResult as any)) {
        this.showError((pipelineResult as any).message);
        return;
      }

      if (quickActionResult && typeof quickActionResult === 'object' && 'error' in (quickActionResult as any)) {
        this.showError((quickActionResult as any).message);
        return;
      }

      this.pipelines = (pipelineResult as PipelineDefinition[]) ?? [];
      this.quickActions = (quickActionResult as QuickAction[]) ?? [];
      this.renderListView();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── List View ──────────────────────────────────────────────

  private renderListView(): void {
    this.container.innerHTML = '';

    // Header
    const header = this.createHeader('⚡ Pipelines', [
      { label: '↻', title: 'Refresh', onClick: () => this.loadPipelines() },
    ]);
    this.container.appendChild(header);

    const scrollContainer = document.createElement('div');
    scrollContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    // Quick Action Toolbar (Requirement 5.1)
    if (this.quickActions.length > 0) {
      scrollContainer.appendChild(this.renderQuickActionToolbar());
    }

    // Pipeline List
    if (this.pipelines.length === 0) {
      scrollContainer.appendChild(
        this.createEmptyState('No pipelines defined. Create a pipeline to automate multi-step workflows.'),
      );
    } else {
      const sectionLabel = document.createElement('div');
      sectionLabel.style.cssText =
        'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);padding:8px 8px 4px;font-weight:600;';
      sectionLabel.textContent = 'Saved Pipelines';
      scrollContainer.appendChild(sectionLabel);

      for (const pipeline of this.pipelines) {
        scrollContainer.appendChild(this.createPipelineRow(pipeline));
      }
    }

    this.container.appendChild(scrollContainer);
  }

  // ─── Quick Action Toolbar (Requirement 5.1) ───────────────

  private renderQuickActionToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.style.cssText =
      'display:flex;flex-wrap:wrap;gap:6px;padding:8px;margin-bottom:8px;background:var(--bg-input);border-radius:8px;border:1px solid var(--border-color);';

    const toolbarLabel = document.createElement('div');
    toolbarLabel.style.cssText =
      'width:100%;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);font-weight:600;margin-bottom:4px;';
    toolbarLabel.textContent = 'Quick Actions';
    toolbar.appendChild(toolbarLabel);

    for (const action of this.quickActions) {
      const btn = document.createElement('button');
      btn.style.cssText =
        'display:flex;align-items:center;gap:4px;padding:6px 10px;font-size:11px;border:1px solid var(--border-color);background:var(--bg-code,#1e1e1e);color:var(--text-primary);border-radius:6px;cursor:pointer;transition:background 0.15s,border-color 0.15s;white-space:nowrap;';
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = 'var(--accent,#3b82f6)';
        btn.style.background = 'var(--bg-hover,rgba(255,255,255,0.05))';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = 'var(--border-color)';
        btn.style.background = 'var(--bg-code,#1e1e1e)';
      });
      btn.addEventListener('click', () => this.executeQuickAction(action));
      btn.title = action.label;
      btn.setAttribute('aria-label', `Execute quick action: ${action.label}`);

      const icon = document.createElement('span');
      icon.textContent = QUICK_ACTION_ICONS[action.icon ?? ''] ?? '▶';
      btn.appendChild(icon);

      const label = document.createElement('span');
      label.textContent = action.label;
      btn.appendChild(label);

      toolbar.appendChild(btn);
    }

    return toolbar;
  }

  // ─── Pipeline Row ─────────────────────────────────────────

  private createPipelineRow(pipeline: PipelineDefinition): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:10px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);margin-bottom:4px;cursor:pointer;transition:background 0.15s;';
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover,rgba(255,255,255,0.05))'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'var(--bg-input)'; });

    // Pipeline icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:16px;flex-shrink:0;';
    icon.textContent = '⚡';
    row.appendChild(icon);

    // Content area
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    title.textContent = pipeline.name;
    content.appendChild(title);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
    meta.textContent = `${pipeline.steps.length} step${pipeline.steps.length !== 1 ? 's' : ''} · ${pipeline.category || 'Uncategorized'} · ${formatDate(pipeline.createdAt)}`;
    content.appendChild(meta);

    row.appendChild(content);

    // Execute button
    const execBtn = document.createElement('button');
    execBtn.textContent = '▶';
    execBtn.title = 'Execute pipeline';
    execBtn.setAttribute('aria-label', `Execute pipeline: ${pipeline.name}`);
    execBtn.style.cssText =
      'font-size:12px;width:28px;height:28px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--accent,#3b82f6);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    execBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.executePipeline(pipeline);
    });
    row.appendChild(execBtn);

    return row;
  }

  // ─── Execute Pipeline ─────────────────────────────────────

  private async executePipeline(pipeline: PipelineDefinition): Promise<void> {
    this.currentView = 'execution';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Starting pipeline…</div>';

    try {
      const result = await eapi().invoke('pipeline:execute', {
        pipelineId: pipeline.id,
        params: {},
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.currentExecution = result as PipelineExecution;
      this.renderExecutionTrace(pipeline);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Execute Quick Action ─────────────────────────────────

  private async executeQuickAction(action: QuickAction): Promise<void> {
    this.currentView = 'execution';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Executing quick action…</div>';

    try {
      const result = await eapi().invoke('quickaction:execute', {
        actionId: action.id,
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.currentExecution = result as PipelineExecution;
      // Look up the pipeline for display
      const pipeline = this.pipelines.find((p) => p.id === action.pipelineId);
      this.renderExecutionTrace(pipeline ?? null, action.label);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Execution Trace Display (Requirement 4.3) ────────────

  private renderExecutionTrace(pipeline: PipelineDefinition | null, actionLabel?: string): void {
    this.container.innerHTML = '';

    const execution = this.currentExecution;
    if (!execution) return;

    const title = actionLabel
      ? `⚡ ${actionLabel}`
      : `⚡ ${pipeline?.name ?? 'Pipeline Execution'}`;

    // Header with back button and cancel
    const actions: Array<{ label: string; title: string; onClick: () => void }> = [
      { label: '←', title: 'Back to list', onClick: () => this.loadPipelines() },
    ];

    if (execution.status === 'running') {
      actions.push({
        label: '⏹',
        title: 'Cancel execution',
        onClick: () => this.cancelExecution(execution.id),
      });
    }

    const header = this.createHeader(title, actions);
    this.container.appendChild(header);

    // Execution status bar
    const statusBar = document.createElement('div');
    statusBar.style.cssText =
      'padding:8px 12px;font-size:11px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:8px;';

    const statusBadge = document.createElement('span');
    statusBadge.style.cssText = `font-size:10px;font-weight:700;border-radius:4px;padding:2px 8px;background:${this.getStatusBackground(execution.status)};color:${this.getStatusColor(execution.status)};`;
    statusBadge.textContent = execution.status.toUpperCase();
    statusBar.appendChild(statusBadge);

    const duration = document.createElement('span');
    duration.style.cssText = 'color:var(--text-dim);';
    duration.textContent = formatDuration(execution.startedAt, execution.completedAt);
    statusBar.appendChild(duration);

    this.container.appendChild(statusBar);

    // Step list with trace
    const traceContainer = document.createElement('div');
    traceContainer.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    for (let i = 0; i < execution.steps.length; i++) {
      const step = execution.steps[i];
      const stepDef = pipeline?.steps[i];
      traceContainer.appendChild(this.renderStepTrace(step, stepDef, i));
    }

    // Error display if failed
    if (execution.error) {
      const errorEl = document.createElement('div');
      errorEl.style.cssText =
        'margin-top:12px;padding:10px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:6px;font-size:11px;color:var(--red,#ef4444);';
      errorEl.textContent = execution.error;
      traceContainer.appendChild(errorEl);
    }

    this.container.appendChild(traceContainer);
  }

  private renderStepTrace(step: StepExecution, stepDef: PipelineDefinition['steps'][number] | undefined, index: number): HTMLElement {
    const status = step.status as StepStatus;
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-color);';

    // Step number + status icon
    const iconArea = document.createElement('div');
    iconArea.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0;width:32px;';

    const statusIcon = document.createElement('span');
    statusIcon.style.cssText = 'font-size:16px;';
    statusIcon.textContent = STATUS_ICONS[status] ?? '⏳';
    statusIcon.setAttribute('aria-label', `Status: ${status}`);
    iconArea.appendChild(statusIcon);

    const stepNum = document.createElement('span');
    stepNum.style.cssText = 'font-size:9px;color:var(--text-dim);';
    stepNum.textContent = `#${index + 1}`;
    iconArea.appendChild(stepNum);

    row.appendChild(iconArea);

    // Step content
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const name = document.createElement('span');
    name.style.cssText = `font-size:12px;font-weight:600;color:${STATUS_COLORS[status]};`;
    name.textContent = stepDef?.name ?? `Step ${index + 1}`;
    nameRow.appendChild(name);

    // Duration for completed/failed steps
    if (step.startedAt) {
      const dur = document.createElement('span');
      dur.style.cssText = 'font-size:10px;color:var(--text-dim);';
      dur.textContent = formatDuration(step.startedAt, step.completedAt);
      nameRow.appendChild(dur);
    }

    content.appendChild(nameRow);

    // Tool/agent info
    if (stepDef) {
      const toolInfo = document.createElement('div');
      toolInfo.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
      toolInfo.textContent = stepDef.toolId
        ? `Tool: ${stepDef.toolId}`
        : stepDef.agentId
          ? `Agent: ${stepDef.agentId}`
          : '';
      content.appendChild(toolInfo);
    }

    // Error message for failed steps
    if (step.error) {
      const err = document.createElement('div');
      err.style.cssText = 'font-size:10px;color:var(--red,#ef4444);margin-top:4px;padding:4px 6px;background:var(--red-container,rgba(248,113,113,0.08));border-radius:4px;';
      err.textContent = step.error;
      content.appendChild(err);
    }

    row.appendChild(content);
    return row;
  }

  // ─── Cancel Execution ─────────────────────────────────────

  private async cancelExecution(executionId: string): Promise<void> {
    try {
      const result = await eapi().invoke('pipeline:cancel', { executionId });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        console.error('[PipelinePanel] Cancel failed:', (result as any).message);
      }

      // Refresh the execution display
      if (this.currentExecution) {
        this.currentExecution.status = 'cancelled';
        this.renderExecutionTrace(
          this.pipelines.find((p) => p.id === this.currentExecution?.pipelineId) ?? null,
        );
      }
    } catch (err: unknown) {
      console.error('[PipelinePanel] Cancel error:', err);
    }
  }

  // ─── Polling for Real-time Updates ────────────────────────

  private stopPolling(): void {
    if (this.executionPollingInterval) {
      clearInterval(this.executionPollingInterval);
      this.executionPollingInterval = null;
    }
  }

  // ─── Status Helpers ───────────────────────────────────────

  private getStatusBackground(status: string): string {
    switch (status) {
      case 'running': return 'rgba(59,130,246,0.15)';
      case 'completed': return 'rgba(34,197,94,0.15)';
      case 'failed': return 'rgba(239,68,68,0.15)';
      case 'cancelled': return 'rgba(136,136,136,0.15)';
      default: return 'rgba(136,136,136,0.1)';
    }
  }

  private getStatusColor(status: string): string {
    switch (status) {
      case 'running': return 'var(--accent,#3b82f6)';
      case 'completed': return 'var(--green,#22c55e)';
      case 'failed': return 'var(--red,#ef4444)';
      case 'cancelled': return 'var(--text-dim,#888)';
      default: return 'var(--text-dim,#888)';
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
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
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
    el.textContent = message;
    return el;
  }

  private showError(message: string): void {
    this.container.innerHTML = '';

    const header = this.createHeader('⚡ Pipelines', [
      { label: '↻', title: 'Retry', onClick: () => this.loadPipelines() },
    ]);
    this.container.appendChild(header);

    const errorEl = document.createElement('div');
    errorEl.style.cssText =
      'margin:12px;padding:12px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:8px;font-size:12px;color:var(--red,#ef4444);';
    errorEl.textContent = `Error: ${message}`;
    this.container.appendChild(errorEl);
  }

  /** Clean up resources. */
  destroy(): void {
    this.stopPolling();
    this.container.innerHTML = '';
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the pipeline panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderPipelinePanel(
  container: HTMLElement,
  projectDir: string,
): PipelinePanel {
  const panel = new PipelinePanel(container, projectDir);
  panel.render();
  return panel;
}
