/**
 * ProgressPanel — Renderer component for multi-step task progress tracking.
 *
 * Displays a collapsible panel listing completed steps with tool name,
 * target, outcome, and duration. Renders parallel execution tracks as
 * visually grouped entries with independent status per operation.
 *
 * Listens on:
 * - `agent:tool-event` for step updates
 * - `agent:parallel-status` for concurrent operation grouping
 * - `agent:progress` for iteration/progress updates
 *
 * Feature-gated via `production_ux_progress_panel`.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 22.1, 22.2, 22.3, 22.4
 */

import type {
  ToolLifecycleEvent,
  ParallelStatusEvent,
  EnhancedLoopProgress,
} from '../../shared/production-ux-types.js';

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

export interface ProgressStep {
  id: string;
  toolName: string;
  target: string;
  outcome: 'success' | 'failure' | 'pending' | 'executing';
  durationMs?: number;
  input?: string;
  output?: string;
  parallelGroupId?: string;
}

export interface ParallelTrack {
  groupId: string;
  operations: Array<{
    toolCallId: string;
    toolName: string;
    status: 'pending' | 'executing' | 'completed' | 'failed';
    filePath?: string;
  }>;
}

export interface ProgressPanelInternalState {
  visible: boolean;
  collapsed: boolean;
  steps: ProgressStep[];
  currentIteration: number;
  maxIterations: number;
  parallelTracks: Map<string, ParallelTrack>;
  toolCallsExecuted: number;
}

// ─── Pure Logic Functions (exported for testing) ────────────────

/**
 * Determines if the progress panel should be visible based on tool calls executed.
 * Panel becomes visible when toolCallsExecuted > 3.
 *
 * Requirement 13.1
 */
export function shouldPanelBeVisible(toolCallsExecuted: number): boolean {
  return toolCallsExecuted > 3;
}

/**
 * Computes progress percentage clamped to [0, 100].
 *
 * Requirement 13.5
 */
export function computeProgressPercentage(currentIteration: number, maxIterations: number): number {
  if (maxIterations <= 0) return 0;
  const raw = (currentIteration / maxIterations) * 100;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Groups steps by their parallelGroupId. Steps without a group are returned
 * as individual entries. Steps sharing the same group are aggregated.
 *
 * Requirements: 22.1, 22.2, 22.3
 */
export function groupStepsByParallelTrack(
  steps: ProgressStep[],
): Array<{ type: 'single'; step: ProgressStep } | { type: 'parallel'; groupId: string; steps: ProgressStep[] }> {
  const result: Array<
    { type: 'single'; step: ProgressStep } | { type: 'parallel'; groupId: string; steps: ProgressStep[] }
  > = [];
  const groupMap = new Map<string, ProgressStep[]>();
  const groupOrder: string[] = [];

  for (const step of steps) {
    if (step.parallelGroupId) {
      if (!groupMap.has(step.parallelGroupId)) {
        groupMap.set(step.parallelGroupId, []);
        groupOrder.push(step.parallelGroupId);
      }
      groupMap.get(step.parallelGroupId)!.push(step);
    } else {
      // Flush any pending groups encountered before this non-grouped step
      // (We handle ordering below in a single pass)
      result.push({ type: 'single', step });
    }
  }

  // Now re-build maintaining insertion order: interleave singles and groups
  // by position of first occurrence
  const finalResult: Array<
    { type: 'single'; step: ProgressStep } | { type: 'parallel'; groupId: string; steps: ProgressStep[] }
  > = [];

  // Track which group was already emitted
  const emittedGroups = new Set<string>();

  for (const step of steps) {
    if (step.parallelGroupId) {
      if (!emittedGroups.has(step.parallelGroupId)) {
        emittedGroups.add(step.parallelGroupId);
        finalResult.push({
          type: 'parallel',
          groupId: step.parallelGroupId,
          steps: groupMap.get(step.parallelGroupId)!,
        });
      }
      // Skip subsequent steps in same group (already emitted)
    } else {
      finalResult.push({ type: 'single', step });
    }
  }

  return finalResult;
}

/**
 * Converts a ParallelStatusEvent into the display model.
 * Each operation retains independent status — a failure in one
 * does NOT affect others in the same group.
 *
 * Requirements: 22.1, 22.2, 22.4
 */
export function buildParallelTrack(event: ParallelStatusEvent): ParallelTrack {
  return {
    groupId: event.groupId,
    operations: event.operations.map((op) => ({
      toolCallId: op.toolCallId,
      toolName: op.toolName,
      status: op.status,
      filePath: op.filePath,
    })),
  };
}

/**
 * Checks whether a parallel track contains any failures.
 *
 * Requirement 22.4: Highlight failures without hiding concurrent operation status.
 */
export function trackHasFailure(track: ParallelTrack): boolean {
  return track.operations.some((op) => op.status === 'failed');
}

/**
 * Returns the overall status label for a parallel track based on
 * its constituent operations.
 */
export function getTrackOverallStatus(
  track: ParallelTrack,
): 'pending' | 'executing' | 'completed' | 'failed' | 'mixed' {
  const statuses = new Set(track.operations.map((op) => op.status));
  if (statuses.size === 1) return track.operations[0].status;
  if (statuses.has('failed')) return 'mixed';
  if (statuses.has('executing')) return 'executing';
  if (statuses.has('pending')) return 'pending';
  return 'completed';
}

// ─── Helpers ────────────────────────────────────────────────────

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

// ─── Status Colors & Icons ──────────────────────────────────────

const STATUS_CONFIG: Record<string, { color: string; icon: string; bgAlpha: string }> = {
  pending: { color: 'var(--text-dim,#888)', icon: '○', bgAlpha: '0.05' },
  executing: { color: 'var(--accent,#3b82f6)', icon: '◉', bgAlpha: '0.08' },
  completed: { color: 'var(--green,#22c55e)', icon: '✓', bgAlpha: '0.08' },
  success: { color: 'var(--green,#22c55e)', icon: '✓', bgAlpha: '0.08' },
  failed: { color: 'var(--red,#ef4444)', icon: '✗', bgAlpha: '0.1' },
  failure: { color: 'var(--red,#ef4444)', icon: '✗', bgAlpha: '0.1' },
};

function getStatusConfig(status: string): { color: string; icon: string; bgAlpha: string } {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG['pending'];
}

// ─── ProgressPanel Component ────────────────────────────────────

export class ProgressPanel {
  private container: HTMLElement;
  private state: ProgressPanelInternalState;
  private toolEventListener: ((...args: unknown[]) => void) | null = null;
  private parallelStatusListener: ((...args: unknown[]) => void) | null = null;
  private progressListener: ((...args: unknown[]) => void) | null = null;
  private enabled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = {
      visible: false,
      collapsed: false,
      steps: [],
      currentIteration: 0,
      maxIterations: 25,
      parallelTracks: new Map(),
      toolCallsExecuted: 0,
    };
  }

  /**
   * Initialize the panel: check feature gate, set up IPC listeners, render.
   */
  async init(): Promise<void> {
    this.enabled = await this.checkFeatureGate();
    if (!this.enabled) return;

    this.setupIPCListeners();
    this.render();
  }

  /**
   * Get current internal state (for testing/external consumers).
   */
  getState(): ProgressPanelInternalState {
    return {
      ...this.state,
      parallelTracks: new Map(this.state.parallelTracks),
    };
  }

  /**
   * Check if the panel is currently visible.
   */
  isVisible(): boolean {
    return this.state.visible;
  }

  /**
   * Toggle collapsed state.
   */
  toggleCollapse(): void {
    this.state.collapsed = !this.state.collapsed;
    this.render();
  }

  /**
   * Process a tool lifecycle event and update steps.
   */
  handleToolEvent(event: ToolLifecycleEvent): void {
    if (event.type === 'tool_start') {
      const step: ProgressStep = {
        id: event.toolCallId,
        toolName: event.toolName,
        target: event.filePath ?? event.command ?? '',
        outcome: 'executing',
        parallelGroupId: event.parallelGroupId,
      };
      this.state.steps.push(step);
    } else if (event.type === 'tool_complete' || event.type === 'tool_error') {
      const existing = this.state.steps.find((s) => s.id === event.toolCallId);
      if (existing) {
        existing.outcome = event.success ? 'success' : 'failure';
        existing.durationMs = event.durationMs;
      }
      this.state.toolCallsExecuted++;
    }

    this.state.visible = shouldPanelBeVisible(this.state.toolCallsExecuted);
    this.render();
  }

  /**
   * Process a parallel status event and update the parallel tracks display.
   *
   * Requirements: 22.1, 22.2, 22.3, 22.4
   */
  handleParallelStatus(event: ParallelStatusEvent): void {
    const track = buildParallelTrack(event);
    this.state.parallelTracks.set(event.groupId, track);
    this.render();
  }

  /**
   * Process a progress event and update iteration info.
   */
  handleProgress(event: EnhancedLoopProgress): void {
    this.state.currentIteration = event.iteration;
    this.state.maxIterations = event.maxIterations;
    this.render();
  }

  /**
   * Reset the panel state (e.g., on new task start).
   */
  reset(): void {
    this.state = {
      visible: false,
      collapsed: false,
      steps: [],
      currentIteration: 0,
      maxIterations: 25,
      parallelTracks: new Map(),
      toolCallsExecuted: 0,
    };
    this.render();
  }

  /**
   * Clean up IPC listeners.
   */
  destroy(): void {
    if (this.toolEventListener) {
      eapi().removeListener('agent:tool-event', this.toolEventListener);
      this.toolEventListener = null;
    }
    if (this.parallelStatusListener) {
      eapi().removeListener('agent:parallel-status', this.parallelStatusListener);
      this.parallelStatusListener = null;
    }
    if (this.progressListener) {
      eapi().removeListener('agent:progress', this.progressListener);
      this.progressListener = null;
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';

    if (!this.state.visible) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'block';
    this.container.className = 'progress-panel';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'border:1px solid var(--border-color);border-radius:8px;background:var(--bg-panel,var(--bg-input));overflow:hidden;margin:8px 0;';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Task progress panel');

    // Header with progress bar and collapse toggle
    wrapper.appendChild(this.renderHeader());

    // Content (collapsible)
    if (!this.state.collapsed) {
      wrapper.appendChild(this.renderStepsList());
    }

    this.container.appendChild(wrapper);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none;';
    header.addEventListener('click', () => this.toggleCollapse());

    // Collapse indicator
    const collapseIcon = document.createElement('span');
    collapseIcon.style.cssText = 'font-size:10px;color:var(--text-dim);transition:transform 0.2s;';
    collapseIcon.textContent = this.state.collapsed ? '▶' : '▼';
    header.appendChild(collapseIcon);

    // Title
    const title = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
    title.textContent = 'Progress';
    header.appendChild(title);

    // Step count
    const stepCount = document.createElement('span');
    stepCount.style.cssText = 'font-size:11px;color:var(--text-secondary);';
    stepCount.textContent = `Step ${this.state.currentIteration} of ${this.state.maxIterations}`;
    header.appendChild(stepCount);

    // Spacer
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;';
    header.appendChild(spacer);

    // Progress percentage
    const pct = computeProgressPercentage(this.state.currentIteration, this.state.maxIterations);
    const pctLabel = document.createElement('span');
    pctLabel.style.cssText = 'font-size:11px;font-weight:500;color:var(--text-secondary);';
    pctLabel.textContent = `${Math.round(pct)}%`;
    header.appendChild(pctLabel);

    // Progress bar (below header)
    const progressBarContainer = document.createElement('div');
    progressBarContainer.style.cssText =
      'position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--border-color);';
    const progressBarFill = document.createElement('div');
    progressBarFill.style.cssText = `width:${pct}%;height:100%;background:var(--accent,#3b82f6);transition:width 0.3s;border-radius:1px;`;
    progressBarContainer.appendChild(progressBarFill);

    // Wrap header with position relative for progress bar
    const headerWrapper = document.createElement('div');
    headerWrapper.style.cssText = 'position:relative;border-bottom:1px solid var(--border-color);';
    headerWrapper.appendChild(header);
    headerWrapper.appendChild(progressBarContainer);

    return headerWrapper;
  }

  private renderStepsList(): HTMLElement {
    const list = document.createElement('div');
    list.style.cssText = 'max-height:300px;overflow-y:auto;padding:4px 0;';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Execution steps');

    const grouped = groupStepsByParallelTrack(this.state.steps);

    for (const entry of grouped) {
      if (entry.type === 'single') {
        list.appendChild(this.renderSingleStep(entry.step));
      } else {
        list.appendChild(this.renderParallelGroup(entry.groupId, entry.steps));
      }
    }

    return list;
  }

  private renderSingleStep(step: ProgressStep): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;transition:background 0.1s;';
    row.setAttribute('role', 'listitem');

    const config = getStatusConfig(step.outcome);

    // Status icon
    const icon = document.createElement('span');
    icon.style.cssText = `color:${config.color};font-size:12px;flex-shrink:0;`;
    icon.textContent = config.icon;
    row.appendChild(icon);

    // Tool name
    const toolLabel = document.createElement('span');
    toolLabel.style.cssText = 'font-weight:500;color:var(--text-primary);flex-shrink:0;';
    toolLabel.textContent = step.toolName;
    row.appendChild(toolLabel);

    // Target
    const targetLabel = document.createElement('span');
    targetLabel.style.cssText =
      'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-family:var(--font-mono,monospace);font-size:10px;';
    targetLabel.title = step.target;
    targetLabel.textContent = shortPath(step.target);
    row.appendChild(targetLabel);

    // Duration
    if (step.durationMs !== undefined) {
      const dur = document.createElement('span');
      dur.style.cssText = 'font-size:10px;color:var(--text-dim);flex-shrink:0;';
      dur.textContent = formatDuration(step.durationMs);
      row.appendChild(dur);
    }

    return row;
  }

  /**
   * Render a group of parallel operations as a visually distinct track.
   *
   * Requirements: 22.1, 22.2, 22.3, 22.4
   * - Display concurrent operations as parallel tracks (visual grouping)
   * - Each track shows independent status
   * - Visually indicate which operations are running concurrently
   * - Highlight failures without hiding concurrent operation status
   */
  private renderParallelGroup(groupId: string, steps: ProgressStep[]): HTMLElement {
    const group = document.createElement('div');
    group.className = 'parallel-track-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `Parallel operations (${steps.length} concurrent)`);
    group.setAttribute('data-group-id', groupId);

    // Check for failure in this group
    const track = this.state.parallelTracks.get(groupId);
    const hasFailure = track ? trackHasFailure(track) : steps.some((s) => s.outcome === 'failure');

    // Group container with left border to indicate parallel execution
    const borderColor = hasFailure
      ? 'var(--red,#ef4444)'
      : 'var(--accent,#3b82f6)';
    const bgColor = hasFailure
      ? 'rgba(239,68,68,0.03)'
      : 'rgba(59,130,246,0.03)';

    group.style.cssText = [
      `border-left:3px solid ${borderColor}`,
      `background:${bgColor}`,
      'margin:4px 8px',
      'border-radius:0 6px 6px 0',
      'padding:4px 0',
    ].join(';');

    // Parallel track header
    const trackHeader = document.createElement('div');
    trackHeader.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:4px 10px;font-size:10px;color:var(--text-dim);';

    const parallelIcon = document.createElement('span');
    parallelIcon.style.cssText = 'font-size:10px;';
    parallelIcon.textContent = '⫘';
    parallelIcon.title = 'Parallel execution';
    trackHeader.appendChild(parallelIcon);

    const trackLabel = document.createElement('span');
    trackLabel.textContent = `${steps.length} concurrent operations`;
    trackHeader.appendChild(trackLabel);

    if (hasFailure) {
      const failBadge = document.createElement('span');
      failBadge.style.cssText =
        'font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,0.15);color:var(--red,#ef4444);font-weight:600;';
      failBadge.textContent = 'HAS FAILURE';
      trackHeader.appendChild(failBadge);
    }

    group.appendChild(trackHeader);

    // Render each operation in the parallel group with independent status
    for (const step of steps) {
      const opRow = this.renderParallelOperation(step, track);
      group.appendChild(opRow);
    }

    return group;
  }

  /**
   * Render a single operation within a parallel track.
   * Each operation shows its own independent status.
   *
   * Requirement 22.2: Each track shows independent status
   * Requirement 22.4: Highlight failures without hiding concurrent operation status
   */
  private renderParallelOperation(step: ProgressStep, track?: ParallelTrack): HTMLElement {
    // Try to get the real-time status from the parallel track if available
    let displayStatus = step.outcome;
    if (track) {
      const trackOp = track.operations.find((op) => op.toolCallId === step.id);
      if (trackOp) {
        // Map ParallelStatusEvent status to ProgressStep outcome
        switch (trackOp.status) {
          case 'pending': displayStatus = 'pending'; break;
          case 'executing': displayStatus = 'executing'; break;
          case 'completed': displayStatus = 'success'; break;
          case 'failed': displayStatus = 'failure'; break;
        }
      }
    }

    const config = getStatusConfig(displayStatus);
    const isFailed = displayStatus === 'failure';

    const row = document.createElement('div');
    row.className = 'parallel-track-operation';
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-tool-call-id', step.id);
    row.setAttribute('data-status', displayStatus);
    row.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:4px 10px 4px 16px',
      'font-size:11px',
      isFailed ? 'background:rgba(239,68,68,0.06)' : '',
    ].join(';');

    // Status icon
    const icon = document.createElement('span');
    icon.style.cssText = `color:${config.color};font-size:11px;flex-shrink:0;`;
    icon.textContent = config.icon;
    row.appendChild(icon);

    // Tool name
    const toolLabel = document.createElement('span');
    toolLabel.style.cssText = [
      'font-weight:500',
      `color:${isFailed ? 'var(--red,#ef4444)' : 'var(--text-primary)'}`,
      'flex-shrink:0',
    ].join(';');
    toolLabel.textContent = step.toolName;
    row.appendChild(toolLabel);

    // Target (file path)
    const targetLabel = document.createElement('span');
    targetLabel.style.cssText =
      'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-family:var(--font-mono,monospace);font-size:10px;';
    targetLabel.title = step.target;
    targetLabel.textContent = shortPath(step.target);
    row.appendChild(targetLabel);

    // Status label
    const statusLabel = document.createElement('span');
    statusLabel.style.cssText = `font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;color:${config.color};background:${config.color}15;flex-shrink:0;`;
    statusLabel.textContent = displayStatus.toUpperCase();
    row.appendChild(statusLabel);

    // Duration (if complete)
    if (step.durationMs !== undefined && (displayStatus === 'success' || displayStatus === 'failure')) {
      const dur = document.createElement('span');
      dur.style.cssText = 'font-size:10px;color:var(--text-dim);flex-shrink:0;';
      dur.textContent = formatDuration(step.durationMs);
      row.appendChild(dur);
    }

    return row;
  }

  // ─── IPC Listeners ──────────────────────────────────────────────

  private setupIPCListeners(): void {
    this.toolEventListener = (...args: unknown[]) => {
      const event = args[0] as ToolLifecycleEvent;
      if (event && event.type && event.toolName) {
        this.handleToolEvent(event);
      }
    };
    eapi().on('agent:tool-event', this.toolEventListener);

    this.parallelStatusListener = (...args: unknown[]) => {
      const event = args[0] as ParallelStatusEvent;
      if (event && event.groupId && Array.isArray(event.operations)) {
        this.handleParallelStatus(event);
      }
    };
    eapi().on('agent:parallel-status', this.parallelStatusListener);

    this.progressListener = (...args: unknown[]) => {
      const event = args[0] as EnhancedLoopProgress;
      if (event && typeof event.iteration === 'number') {
        this.handleProgress(event);
      }
    };
    eapi().on('agent:progress', this.progressListener);
  }

  private async checkFeatureGate(): Promise<boolean> {
    try {
      const config = await eapi().invoke('get-config') as Record<string, unknown>;
      if (config && typeof config === 'object') {
        return (config as any).production_ux_progress_panel === true;
      }
    } catch {
      // Feature not available — disabled
    }
    return false;
  }
}

// ─── Convenience Export ─────────────────────────────────────────

/**
 * Create and initialize a ProgressPanel in the given container.
 * Feature-gated: returns the panel but it may be disabled if the gate is off.
 */
export async function createProgressPanel(container: HTMLElement): Promise<ProgressPanel> {
  const panel = new ProgressPanel(container);
  await panel.init();
  return panel;
}
