/**
 * LoopRunPanel — Renderer component for Loop Engine run monitoring.
 *
 * Displays pass timeline, evidence, running cost meter, control buttons,
 * and approval banners. Listens on loop:* IPC channels for real-time updates.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.6, 18.7
 */

import type {
  LoopRunPanelState,
  LoopPassStartEvent,
  LoopVerifyResultEvent,
  LoopStopEvent,
  LoopAwaitingApprovalEvent,
  LoopRunStatusResponse,
  PassTimelineEntry,
  VerifyCheckResult,
  EvidenceItem,
  TerminalState,
} from './loop-run-panel-types';

import {
  isActiveState,
  isTerminalState,
  isAwaitingApproval,
  isStopButtonEnabled,
  isApproveButtonEnabled,
  shouldShowApprovalBanner,
  shouldShowEvidenceAndCost,
  isLlmJudgeCheck,
  getCheckIcon,
  getStatusLabel,
  getStatusColor,
  formatCost,
  createInitialState,
  handlePassStart,
  handleVerifyResult,
  handleLoopStop,
  handleAwaitingApproval,
  handleStatusUpdate,
  getStateDisplayLabel,
} from './loop-run-panel-state';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ─── LoopRunPanel Component ─────────────────────────────────────

export class LoopRunPanel {
  private container: HTMLElement;
  private state: LoopRunPanelState;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  // IPC listener references for cleanup
  private passStartListener: ((...args: unknown[]) => void) | null = null;
  private verifyResultListener: ((...args: unknown[]) => void) | null = null;
  private stopListener: ((...args: unknown[]) => void) | null = null;
  private approvalListener: ((...args: unknown[]) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = createInitialState();
  }

  // ─── Public API ─────────────────────────────────────────────────

  /** Initialize the panel and set up IPC listeners. */
  init(): void {
    this.setupIPCListeners();
    this.render();
  }

  /** Start monitoring a specific run. */
  startMonitoring(runId: string): void {
    this.state = {
      ...createInitialState(),
      runId,
      state: 'PLANNING_PASS',
    };
    this.startPolling();
    this.render();
  }

  /** Get the current panel state (for testing). */
  getState(): LoopRunPanelState {
    return { ...this.state };
  }

  /** Clean up listeners and polling. */
  destroy(): void {
    this.stopPolling();
    this.cleanupListeners();
  }

  // ─── IPC Listener Setup ─────────────────────────────────────────

  private setupIPCListeners(): void {
    this.passStartListener = (...args: unknown[]) => {
      const event = args[0] as LoopPassStartEvent;
      if (event && event.run_id) {
        this.state = handlePassStart(this.state, event);
        this.render();
      }
    };
    eapi().on('loop:pass:start', this.passStartListener);

    this.verifyResultListener = (...args: unknown[]) => {
      const event = args[0] as LoopVerifyResultEvent;
      if (event && event.run_id && Array.isArray(event.results)) {
        this.state = handleVerifyResult(this.state, event);
        this.render();
      }
    };
    eapi().on('loop:verify:result', this.verifyResultListener);

    this.stopListener = (...args: unknown[]) => {
      const event = args[0] as LoopStopEvent;
      if (event && event.run_id && event.final_status) {
        this.state = handleLoopStop(this.state, event);
        this.stopPolling();
        this.render();
      }
    };
    eapi().on('loop:stop', this.stopListener);

    this.approvalListener = (...args: unknown[]) => {
      const event = args[0] as LoopAwaitingApprovalEvent;
      if (event && event.run_id && event.reason) {
        this.state = handleAwaitingApproval(this.state, event);
        this.render();
      }
    };
    eapi().on('loop:awaiting-approval', this.approvalListener);
  }

  private cleanupListeners(): void {
    if (this.passStartListener) {
      eapi().removeListener('loop:pass:start', this.passStartListener);
      this.passStartListener = null;
    }
    if (this.verifyResultListener) {
      eapi().removeListener('loop:verify:result', this.verifyResultListener);
      this.verifyResultListener = null;
    }
    if (this.stopListener) {
      eapi().removeListener('loop:stop', this.stopListener);
      this.stopListener = null;
    }
    if (this.approvalListener) {
      eapi().removeListener('loop:awaiting-approval', this.approvalListener);
      this.approvalListener = null;
    }
  }

  // ─── Polling for continuous updates (REQ-18.2) ────────────────

  private startPolling(): void {
    this.stopPolling();
    // Poll every 1.5s to ensure updates within the 2-second requirement
    this.pollInterval = setInterval(() => this.pollStatus(), 1500);
  }

  private stopPolling(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async pollStatus(): Promise<void> {
    if (!this.state.runId) return;
    if (isTerminalState(this.state.state)) {
      this.stopPolling();
      return;
    }

    try {
      const response = (await eapi().invoke('loops:runStatus', {
        runId: this.state.runId,
      })) as LoopRunStatusResponse;

      if (response) {
        this.state = handleStatusUpdate(this.state, {
          state: response.state,
          costUsd: response.costUsd,
          evidence: response.evidence ?? this.state.evidence,
        });
        this.render();
      }
    } catch {
      // Polling failure — silently continue
    }
  }

  // ─── Actions ──────────────────────────────────────────────────

  private async handleStopClick(): Promise<void> {
    if (!this.state.runId || !isStopButtonEnabled(this.state.state)) return;
    try {
      await eapi().invoke('loops:stop', { runId: this.state.runId });
    } catch {
      // Stop request failed — the loop:stop event will update state
    }
  }

  private async handleApproveClick(): Promise<void> {
    if (!this.state.runId || !isApproveButtonEnabled(this.state.state)) return;
    try {
      await eapi().invoke('loops:approve', { runId: this.state.runId });
      this.state = {
        ...this.state,
        state: 'PLANNING_PASS',
        approvalReason: null,
      };
      this.render();
    } catch {
      // Approve request failed
    }
  }

  // ─── Rendering ────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';

    if (!this.state.runId) {
      this.renderEmptyState();
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'border:1px solid var(--border-color);border-radius:8px;background:var(--bg-panel,var(--bg-input));overflow:hidden;position:relative;';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Loop run panel');

    // Approval banner (non-dismissible, overlaying)
    if (shouldShowApprovalBanner(this.state.state)) {
      wrapper.appendChild(this.renderApprovalBanner());
    }

    // Header
    wrapper.appendChild(this.renderHeader());

    // Evidence and cost meter (shown during active states)
    if (shouldShowEvidenceAndCost(this.state.state)) {
      wrapper.appendChild(this.renderEvidenceAndCost());
    }

    // Terminal state info
    if (isTerminalState(this.state.state)) {
      wrapper.appendChild(this.renderTerminalInfo());
    }

    // Pass timeline
    wrapper.appendChild(this.renderTimeline());

    // Action buttons
    wrapper.appendChild(this.renderActions());

    this.container.appendChild(wrapper);
  }

  private renderEmptyState(): void {
    const empty = document.createElement('div');
    empty.style.cssText =
      'text-align:center;padding:24px;color:var(--text-dim);font-size:12px;';
    empty.textContent = 'No active loop run.';
    this.container.appendChild(empty);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-color);';

    // Loop icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:14px;';
    icon.textContent = '🔄';
    header.appendChild(icon);

    // Title
    const title = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
    title.textContent = 'Loop Run';
    header.appendChild(title);

    // State badge
    const badge = document.createElement('span');
    badge.style.cssText =
      'font-size:10px;padding:2px 6px;border-radius:4px;font-weight:500;' +
      `background:${this.getStateBadgeBackground()};color:${this.getStateBadgeColor()};`;
    badge.textContent = getStateDisplayLabel(this.state.state);
    header.appendChild(badge);

    // Spacer
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;';
    header.appendChild(spacer);

    // Pass count
    const passCount = document.createElement('span');
    passCount.style.cssText = 'font-size:11px;color:var(--text-secondary);';
    passCount.textContent = `${this.state.passes.length} pass${this.state.passes.length !== 1 ? 'es' : ''}`;
    header.appendChild(passCount);

    return header;
  }

  private renderEvidenceAndCost(): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText =
      'padding:8px 12px;border-bottom:1px solid var(--border-color);background:var(--bg-input);';
    section.setAttribute('aria-label', 'Evidence and cost');

    // Cost meter
    const costRow = document.createElement('div');
    costRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;';

    const costIcon = document.createElement('span');
    costIcon.style.cssText = 'font-size:12px;';
    costIcon.textContent = '💰';
    costRow.appendChild(costIcon);

    const costLabel = document.createElement('span');
    costLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);';
    costLabel.textContent = 'Running Cost:';
    costRow.appendChild(costLabel);

    const costValue = document.createElement('span');
    costValue.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-primary);font-family:var(--font-mono,monospace);';
    costValue.textContent = formatCost(this.state.costUsd);
    costRow.appendChild(costValue);

    section.appendChild(costRow);

    // Evidence items
    if (this.state.evidence.length > 0) {
      const evidenceLabel = document.createElement('div');
      evidenceLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:4px;';
      evidenceLabel.textContent = 'Evidence:';
      section.appendChild(evidenceLabel);

      const evidenceList = document.createElement('div');
      evidenceList.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:80px;overflow-y:auto;';

      for (const item of this.state.evidence.slice(-5)) {
        const evidenceItem = document.createElement('div');
        evidenceItem.style.cssText =
          'font-size:10px;color:var(--text-secondary);font-family:var(--font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        evidenceItem.title = item.ref;
        evidenceItem.textContent = `${item.type === 'file' ? '📄' : '📝'} ${item.ref}`;
        evidenceList.appendChild(evidenceItem);
      }

      section.appendChild(evidenceList);
    }

    return section;
  }

  private renderApprovalBanner(): HTMLElement {
    const banner = document.createElement('div');
    banner.style.cssText = [
      'position:sticky',
      'top:0',
      'z-index:10',
      'padding:12px 16px',
      'background:var(--yellow, #f59e0b)',
      'color:#000',
      'font-size:12px',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
    ].join(';');
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'assertive');

    // Reason text
    const reasonText = document.createElement('div');
    reasonText.style.cssText = 'font-weight:600;';
    reasonText.textContent = `⚠️ Approval Required: ${this.state.approvalReason ?? 'Unknown reason'}`;
    banner.appendChild(reasonText);

    // Approve button inside banner
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.style.cssText = [
      'padding:6px 12px',
      'border-radius:4px',
      'border:none',
      'background:#000',
      'color:#fff',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'align-self:flex-start',
    ].join(';');
    approveBtn.textContent = 'Approve & Continue';
    approveBtn.setAttribute('aria-label', 'Approve loop continuation');
    approveBtn.addEventListener('click', () => this.handleApproveClick());
    banner.appendChild(approveBtn);

    return banner;
  }

  private renderTerminalInfo(): HTMLElement {
    const section = document.createElement('div');
    const status = this.state.state as TerminalState;
    const color = getStatusColor(status);

    section.style.cssText =
      `padding:10px 12px;border-bottom:1px solid var(--border-color);background:${color}10;`;

    // Status line
    const statusLine = document.createElement('div');
    statusLine.style.cssText = `font-size:12px;font-weight:600;color:${color};margin-bottom:4px;`;
    statusLine.textContent = `${this.getTerminalIcon(status)} ${getStatusLabel(status)}`;
    section.appendChild(statusLine);

    // Stop reason (show whatever is available, per REQ-18.7)
    if (this.state.stopReason) {
      const reasonLine = document.createElement('div');
      reasonLine.style.cssText = 'font-size:11px;color:var(--text-secondary);';
      reasonLine.textContent = `Reason: ${this.state.stopReason}`;
      section.appendChild(reasonLine);
    }

    // Cost summary
    const costLine = document.createElement('div');
    costLine.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:4px;';
    costLine.textContent = `Total cost: ${formatCost(this.state.costUsd)} · ${this.state.passes.length} pass${this.state.passes.length !== 1 ? 'es' : ''}`;
    section.appendChild(costLine);

    return section;
  }

  private renderTimeline(): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText = 'max-height:300px;overflow-y:auto;';
    section.setAttribute('role', 'list');
    section.setAttribute('aria-label', 'Pass timeline');

    if (this.state.passes.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;text-align:center;color:var(--text-dim);font-size:11px;';
      empty.textContent = 'Waiting for first pass…';
      section.appendChild(empty);
      return section;
    }

    for (const pass of this.state.passes) {
      section.appendChild(this.renderPassEntry(pass));
    }

    return section;
  }

  private renderPassEntry(pass: PassTimelineEntry): HTMLElement {
    const entry = document.createElement('div');
    entry.style.cssText =
      'padding:8px 12px;border-bottom:1px solid var(--border-color, #333);';
    entry.setAttribute('role', 'listitem');

    // Pass header: number + action summary
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';

    const passNum = document.createElement('span');
    passNum.style.cssText =
      'font-size:10px;font-weight:700;color:var(--accent,#3b82f6);background:var(--accent,#3b82f6)15;padding:1px 5px;border-radius:3px;';
    passNum.textContent = `#${pass.passNumber}`;
    header.appendChild(passNum);

    const summary = document.createElement('span');
    summary.style.cssText = 'font-size:11px;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    summary.title = pass.actionSummary;
    summary.textContent = pass.actionSummary || 'Executing…';
    header.appendChild(summary);

    entry.appendChild(header);

    // Verify results (per check)
    if (pass.verifyResults.length > 0) {
      const checksRow = document.createElement('div');
      checksRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';

      for (const check of pass.verifyResults) {
        checksRow.appendChild(this.renderCheckBadge(check));
      }

      entry.appendChild(checksRow);
    }

    return entry;
  }

  private renderCheckBadge(check: VerifyCheckResult): HTMLElement {
    const badge = document.createElement('span');
    const isLlm = isLlmJudgeCheck(check);

    // Base styles
    let bgColor = check.passed ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
    let textColor = check.passed ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)';

    // Amber badge for llmJudge (REQ-18.6)
    if (isLlm) {
      bgColor = 'rgba(245,158,11,0.15)';
      textColor = 'var(--yellow,#f59e0b)';
    }

    badge.style.cssText =
      `font-size:10px;padding:1px 5px;border-radius:3px;background:${bgColor};color:${textColor};font-weight:500;display:inline-flex;align-items:center;gap:2px;`;
    badge.title = check.output || check.checkId;

    // Icon
    const icon = document.createElement('span');
    icon.textContent = getCheckIcon(check.passed);
    icon.style.cssText = 'font-size:9px;';
    badge.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.textContent = check.checkId;
    badge.appendChild(label);

    // Soft verification indicator for llmJudge
    if (isLlm) {
      const softBadge = document.createElement('span');
      softBadge.style.cssText =
        'font-size:8px;margin-left:2px;padding:0 3px;border-radius:2px;background:var(--yellow,#f59e0b);color:#000;font-weight:700;';
      softBadge.textContent = 'soft';
      softBadge.title = 'Soft verification (LLM judge)';
      badge.appendChild(softBadge);
    }

    return badge;
  }

  private renderActions(): HTMLElement {
    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--border-color);';

    // Stop button
    const stopEnabled = isStopButtonEnabled(this.state.state);
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.disabled = !stopEnabled;
    stopBtn.style.cssText = [
      'padding:5px 10px',
      'border-radius:4px',
      'font-size:11px',
      'font-weight:500',
      'cursor:' + (stopEnabled ? 'pointer' : 'not-allowed'),
      'opacity:' + (stopEnabled ? '1' : '0.4'),
      'border:1px solid var(--red,#ef4444)',
      'background:transparent',
      'color:var(--red,#ef4444)',
    ].join(';');
    stopBtn.textContent = '⏹ Stop';
    stopBtn.setAttribute('aria-label', 'Stop loop run');
    stopBtn.addEventListener('click', () => this.handleStopClick());
    actions.appendChild(stopBtn);

    // Approve button (visible only in AWAITING_APPROVAL)
    if (isAwaitingApproval(this.state.state)) {
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.style.cssText = [
        'padding:5px 10px',
        'border-radius:4px',
        'font-size:11px',
        'font-weight:500',
        'cursor:pointer',
        'border:none',
        'background:var(--green,#22c55e)',
        'color:#fff',
      ].join(';');
      approveBtn.textContent = '✓ Approve';
      approveBtn.setAttribute('aria-label', 'Approve loop continuation');
      approveBtn.addEventListener('click', () => this.handleApproveClick());
      actions.appendChild(approveBtn);
    }

    return actions;
  }

  // ─── Styling helpers ──────────────────────────────────────────

  private getStateBadgeBackground(): string {
    if (isActiveState(this.state.state)) return 'rgba(59,130,246,0.12)';
    if (isAwaitingApproval(this.state.state)) return 'rgba(245,158,11,0.12)';
    if (this.state.state === 'SUCCEEDED') return 'rgba(34,197,94,0.12)';
    if (this.state.state === 'BLOCKED') return 'rgba(239,68,68,0.12)';
    return 'rgba(136,136,136,0.12)';
  }

  private getStateBadgeColor(): string {
    if (isActiveState(this.state.state)) return 'var(--accent,#3b82f6)';
    if (isAwaitingApproval(this.state.state)) return 'var(--yellow,#f59e0b)';
    if (this.state.state === 'SUCCEEDED') return 'var(--green,#22c55e)';
    if (this.state.state === 'BLOCKED') return 'var(--red,#ef4444)';
    return 'var(--text-dim,#888)';
  }

  private getTerminalIcon(status: TerminalState): string {
    switch (status) {
      case 'SUCCEEDED': return '✅';
      case 'NO_OP': return '⏭';
      case 'BLOCKED': return '🚫';
      case 'LIMIT_EXHAUSTED': return '⏱';
      case 'STALLED': return '⚠️';
    }
  }
}

// ─── Convenience Export ─────────────────────────────────────────

/**
 * Create and initialize a LoopRunPanel in the given container.
 */
export function createLoopRunPanel(container: HTMLElement): LoopRunPanel {
  const panel = new LoopRunPanel(container);
  panel.init();
  return panel;
}
