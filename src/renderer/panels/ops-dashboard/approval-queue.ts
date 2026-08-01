/**
 * Approval Queue sub-panel for the Operations Dashboard.
 * Displays pending approval requests with approve/deny buttons.
 * Sends decisions via `ops:approve-grant` IPC channel.
 * Shows countdown timer for time remaining before timeout.
 *
 * Requirements: 15.2, 15.5
 */

/** Data shape for a pending approval request. */
export interface PendingApproval {
  grantId: string;
  requestingAgentId: string;
  requestingAgentName: string;
  requestingAgentEmoji: string;
  capability: string;
  target: string;
  requestedAt: number;
  timeoutAt: number;
}

/** CSS class names scoped to approval-queue. */
const CSS = {
  container: 'nn-ops-approval-queue',
  header: 'nn-ops-approval-queue__header',
  headerCount: 'nn-ops-approval-queue__header-count',
  list: 'nn-ops-approval-queue__list',
  item: 'nn-ops-approval-queue__item',
  itemHeader: 'nn-ops-approval-queue__item-header',
  agentInfo: 'nn-ops-approval-queue__agent-info',
  countdown: 'nn-ops-approval-queue__countdown',
  details: 'nn-ops-approval-queue__details',
  detailRow: 'nn-ops-approval-queue__detail-row',
  detailLabel: 'nn-ops-approval-queue__detail-label',
  detailValue: 'nn-ops-approval-queue__detail-value',
  actions: 'nn-ops-approval-queue__actions',
  approveBtn: 'nn-ops-approval-queue__approve-btn',
  denyBtn: 'nn-ops-approval-queue__deny-btn',
  empty: 'nn-ops-approval-queue__empty',
} as const;

/**
 * Typed wrapper for accessing the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
  };
}

/** Format remaining time as countdown string. */
function formatCountdown(timeoutAt: number): string {
  const remaining = Math.max(0, timeoutAt - Date.now());
  if (remaining === 0) return 'Expired';

  const seconds = Math.floor(remaining / 1000) % 60;
  const minutes = Math.floor(remaining / 60000) % 60;
  const hours = Math.floor(remaining / 3600000);

  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
  return `${seconds}s remaining`;
}

/** Check if countdown is urgent (less than 60 seconds). */
function isUrgent(timeoutAt: number): boolean {
  return (timeoutAt - Date.now()) < 60000;
}

/** Inject styles for approval-queue sub-panel. */
function injectStyles(): void {
  if (document.getElementById('nn-ops-approval-queue-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-ops-approval-queue-styles';
  style.textContent = `
    .${CSS.container} {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .${CSS.header} {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 8px 12px;
      color: var(--ops-header-text, #cccccc);
      border-bottom: 1px solid var(--ops-border, #333333);
      background: var(--ops-header-bg, #252526);
    }
    .${CSS.headerCount} {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 8px;
      background: rgba(255, 179, 71, 0.2);
      color: #ffb347;
    }
    .${CSS.list} {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    .${CSS.item} {
      padding: 10px 12px;
      border-bottom: 1px solid var(--ops-border-light, #2a2a2a);
    }
    .${CSS.itemHeader} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .${CSS.agentInfo} {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--ops-text-primary, #e0e0e0);
    }
    .${CSS.countdown} {
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--ops-text-secondary, #999999);
    }
    .${CSS.countdown}.urgent {
      color: #dc5050;
      font-weight: 600;
    }
    .${CSS.details} {
      margin-bottom: 8px;
    }
    .${CSS.detailRow} {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 2px 0;
    }
    .${CSS.detailLabel} {
      font-size: 11px;
      font-weight: 600;
      color: var(--ops-text-muted, #666666);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      min-width: 72px;
    }
    .${CSS.detailValue} {
      font-size: 12px;
      color: var(--ops-text-secondary, #999999);
      word-break: break-all;
    }
    .${CSS.actions} {
      display: flex;
      gap: 8px;
    }
    .${CSS.approveBtn},
    .${CSS.denyBtn} {
      flex: 1;
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, opacity 0.15s ease;
    }
    .${CSS.approveBtn}:focus-visible,
    .${CSS.denyBtn}:focus-visible {
      outline: 2px solid var(--focus-ring, #007acc);
      outline-offset: 1px;
    }
    .${CSS.approveBtn} {
      background: rgba(73, 199, 145, 0.2);
      color: #49c791;
    }
    .${CSS.approveBtn}:hover {
      background: rgba(73, 199, 145, 0.35);
    }
    .${CSS.approveBtn}:disabled,
    .${CSS.denyBtn}:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .${CSS.denyBtn} {
      background: rgba(220, 80, 80, 0.2);
      color: #dc5050;
    }
    .${CSS.denyBtn}:hover {
      background: rgba(220, 80, 80, 0.35);
    }
    .${CSS.empty} {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-size: 13px;
      color: var(--ops-text-muted, #666666);
      padding: 24px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Approval Queue panel component.
 * Displays pending approvals and processes approve/deny decisions.
 */
export class ApprovalQueuePanel {
  private container: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private headerCountEl: HTMLElement | null = null;
  private approvals: PendingApproval[] = [];
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private processingIds: Set<string> = new Set();

  /** Mount the approval queue panel into a container. */
  mount(container: HTMLElement): void {
    injectStyles();
    this.container = container;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = CSS.container;

    // Header with count badge
    const header = document.createElement('div');
    header.className = CSS.header;

    const headerText = document.createElement('span');
    headerText.textContent = 'Pending Approvals';
    header.appendChild(headerText);

    this.headerCountEl = document.createElement('span');
    this.headerCountEl.className = CSS.headerCount;
    this.headerCountEl.textContent = '0';
    header.appendChild(this.headerCountEl);

    wrapper.appendChild(header);

    this.listEl = document.createElement('div');
    this.listEl.className = CSS.list;
    this.listEl.setAttribute('role', 'list');
    this.listEl.setAttribute('aria-label', 'Pending approval requests');
    wrapper.appendChild(this.listEl);

    container.appendChild(wrapper);
    this.renderList();

    // Update countdown timers every second
    this.timerInterval = setInterval(() => this.updateCountdowns(), 1000);
  }

  /** Unmount and clean up resources. */
  unmount(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.listEl = null;
    this.headerCountEl = null;
    this.approvals = [];
    this.processingIds.clear();
  }

  /** Update the displayed approvals data. */
  update(approvals: PendingApproval[]): void {
    this.approvals = approvals;
    if (this.headerCountEl) {
      this.headerCountEl.textContent = String(approvals.length);
    }
    this.renderList();
  }

  /** Render the list of pending approvals. */
  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';

    if (this.approvals.length === 0) {
      const empty = document.createElement('div');
      empty.className = CSS.empty;
      empty.textContent = 'No pending approvals';
      this.listEl.appendChild(empty);
      return;
    }

    for (const approval of this.approvals) {
      const item = document.createElement('div');
      item.className = CSS.item;
      item.setAttribute('role', 'listitem');
      item.dataset.grantId = approval.grantId;

      // Item header: agent info + countdown
      const itemHeader = document.createElement('div');
      itemHeader.className = CSS.itemHeader;

      const agentInfo = document.createElement('div');
      agentInfo.className = CSS.agentInfo;
      agentInfo.textContent = `${approval.requestingAgentEmoji} ${approval.requestingAgentName}`;
      itemHeader.appendChild(agentInfo);

      const countdown = document.createElement('span');
      countdown.className = CSS.countdown;
      countdown.dataset.timeoutAt = String(approval.timeoutAt);
      countdown.textContent = formatCountdown(approval.timeoutAt);
      if (isUrgent(approval.timeoutAt)) {
        countdown.classList.add('urgent');
      }
      itemHeader.appendChild(countdown);

      item.appendChild(itemHeader);

      // Details: capability and target
      const details = document.createElement('div');
      details.className = CSS.details;

      const capRow = document.createElement('div');
      capRow.className = CSS.detailRow;
      const capLabel = document.createElement('span');
      capLabel.className = CSS.detailLabel;
      capLabel.textContent = 'Capability';
      const capValue = document.createElement('span');
      capValue.className = CSS.detailValue;
      capValue.textContent = approval.capability;
      capRow.appendChild(capLabel);
      capRow.appendChild(capValue);
      details.appendChild(capRow);

      const targetRow = document.createElement('div');
      targetRow.className = CSS.detailRow;
      const targetLabel = document.createElement('span');
      targetLabel.className = CSS.detailLabel;
      targetLabel.textContent = 'Target';
      const targetValue = document.createElement('span');
      targetValue.className = CSS.detailValue;
      targetValue.textContent = approval.target;
      targetRow.appendChild(targetLabel);
      targetRow.appendChild(targetValue);
      details.appendChild(targetRow);

      item.appendChild(details);

      // Action buttons
      const actions = document.createElement('div');
      actions.className = CSS.actions;

      const approveBtn = document.createElement('button');
      approveBtn.className = CSS.approveBtn;
      approveBtn.textContent = 'Approve';
      approveBtn.setAttribute('aria-label', `Approve ${approval.capability} for ${approval.requestingAgentName}`);
      approveBtn.disabled = this.processingIds.has(approval.grantId);
      approveBtn.addEventListener('click', () => this.handleDecision(approval.grantId, 'approve'));
      actions.appendChild(approveBtn);

      const denyBtn = document.createElement('button');
      denyBtn.className = CSS.denyBtn;
      denyBtn.textContent = 'Deny';
      denyBtn.setAttribute('aria-label', `Deny ${approval.capability} for ${approval.requestingAgentName}`);
      denyBtn.disabled = this.processingIds.has(approval.grantId);
      denyBtn.addEventListener('click', () => this.handleDecision(approval.grantId, 'deny'));
      actions.appendChild(denyBtn);

      item.appendChild(actions);
      this.listEl.appendChild(item);
    }
  }

  /** Handle an approve/deny decision. Processes within 2 seconds per Requirement 15.5. */
  private async handleDecision(grantId: string, decision: 'approve' | 'deny'): Promise<void> {
    if (this.processingIds.has(grantId)) return;

    this.processingIds.add(grantId);
    this.disableButtons(grantId);

    const bridge = getIpcBridge();
    await bridge.invoke('ops:approve-grant', { grantId, decision });

    // Remove from local list after decision is sent
    this.approvals = this.approvals.filter((a) => a.grantId !== grantId);
    this.processingIds.delete(grantId);

    if (this.headerCountEl) {
      this.headerCountEl.textContent = String(this.approvals.length);
    }
    this.renderList();
  }

  /** Disable buttons for a specific grant while processing. */
  private disableButtons(grantId: string): void {
    if (!this.listEl) return;
    const item = this.listEl.querySelector(`[data-grant-id="${grantId}"]`);
    if (item) {
      const buttons = item.querySelectorAll('button');
      buttons.forEach((btn) => { (btn as HTMLButtonElement).disabled = true; });
    }
  }

  /** Update the countdown timers for all pending approvals. */
  private updateCountdowns(): void {
    if (!this.listEl) return;

    const countdownElements = this.listEl.querySelectorAll(`.${CSS.countdown}`);
    countdownElements.forEach((el) => {
      const timeoutAt = Number((el as HTMLElement).dataset.timeoutAt);
      if (timeoutAt) {
        el.textContent = formatCountdown(timeoutAt);
        if (isUrgent(timeoutAt)) {
          el.classList.add('urgent');
        } else {
          el.classList.remove('urgent');
        }
      }
    });
  }
}
