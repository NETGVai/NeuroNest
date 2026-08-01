/**
 * Active Runs sub-panel for the Operations Dashboard.
 * Displays currently running agent operations with status badges,
 * elapsed time, accumulated cost, and agent identity (emoji + name).
 *
 * Requirements: 15.1
 */

/** Data shape for an active agent run. */
export interface ActiveRun {
  runId: string;
  agentId: string;
  agentName: string;
  agentEmoji: string;
  status: 'running' | 'paused' | 'awaiting-approval' | 'terminated';
  startedAt: number;
  accumulatedCostUSD: number;
}

/** CSS class names scoped to active-runs. */
const CSS = {
  container: 'nn-ops-active-runs',
  header: 'nn-ops-active-runs__header',
  list: 'nn-ops-active-runs__list',
  item: 'nn-ops-active-runs__item',
  agentIdentity: 'nn-ops-active-runs__agent-identity',
  agentEmoji: 'nn-ops-active-runs__agent-emoji',
  agentName: 'nn-ops-active-runs__agent-name',
  meta: 'nn-ops-active-runs__meta',
  statusBadge: 'nn-ops-active-runs__status-badge',
  elapsed: 'nn-ops-active-runs__elapsed',
  cost: 'nn-ops-active-runs__cost',
  empty: 'nn-ops-active-runs__empty',
} as const;

/** Format elapsed time from a start timestamp. */
function formatElapsed(startedAt: number): string {
  const elapsed = Math.max(0, Date.now() - startedAt);
  const seconds = Math.floor(elapsed / 1000) % 60;
  const minutes = Math.floor(elapsed / 60000) % 60;
  const hours = Math.floor(elapsed / 3600000);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Format cost in USD. */
function formatCost(costUSD: number): string {
  return `$${costUSD.toFixed(4)}`;
}

/** Get status badge color class. */
function getStatusColor(status: ActiveRun['status']): string {
  switch (status) {
    case 'running': return 'nn-ops-status--running';
    case 'paused': return 'nn-ops-status--paused';
    case 'awaiting-approval': return 'nn-ops-status--awaiting';
    case 'terminated': return 'nn-ops-status--terminated';
    default: return '';
  }
}

/** Inject styles for active-runs sub-panel. */
function injectStyles(): void {
  if (document.getElementById('nn-ops-active-runs-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-ops-active-runs-styles';
  style.textContent = `
    .${CSS.container} {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .${CSS.header} {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 8px 12px;
      color: var(--ops-header-text, #cccccc);
      border-bottom: 1px solid var(--ops-border, #333333);
      background: var(--ops-header-bg, #252526);
    }
    .${CSS.list} {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    .${CSS.item} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--ops-border-light, #2a2a2a);
      transition: background 0.1s ease;
    }
    .${CSS.item}:hover {
      background: var(--ops-item-hover, rgba(255, 255, 255, 0.04));
    }
    .${CSS.agentIdentity} {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .${CSS.agentEmoji} {
      font-size: 18px;
      flex-shrink: 0;
    }
    .${CSS.agentName} {
      font-size: 13px;
      font-weight: 500;
      color: var(--ops-text-primary, #e0e0e0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${CSS.meta} {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .${CSS.statusBadge} {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .nn-ops-status--running {
      background: rgba(73, 199, 145, 0.15);
      color: #49c791;
    }
    .nn-ops-status--paused {
      background: rgba(255, 179, 71, 0.15);
      color: #ffb347;
    }
    .nn-ops-status--awaiting {
      background: rgba(100, 149, 237, 0.15);
      color: #6495ed;
    }
    .nn-ops-status--terminated {
      background: rgba(220, 80, 80, 0.15);
      color: #dc5050;
    }
    .${CSS.elapsed} {
      font-size: 12px;
      color: var(--ops-text-secondary, #999999);
      font-variant-numeric: tabular-nums;
      min-width: 64px;
      text-align: right;
    }
    .${CSS.cost} {
      font-size: 12px;
      color: var(--ops-text-secondary, #999999);
      font-variant-numeric: tabular-nums;
      min-width: 60px;
      text-align: right;
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
 * Active Runs panel component.
 * Displays a live-updating list of active agent runs.
 */
export class ActiveRunsPanel {
  private container: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private runs: ActiveRun[] = [];
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  /** Mount the active runs panel into a container. */
  mount(container: HTMLElement): void {
    injectStyles();
    this.container = container;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = CSS.container;

    const header = document.createElement('div');
    header.className = CSS.header;
    header.textContent = 'Active Runs';
    wrapper.appendChild(header);

    this.listEl = document.createElement('div');
    this.listEl.className = CSS.list;
    this.listEl.setAttribute('role', 'list');
    this.listEl.setAttribute('aria-label', 'Active agent runs');
    wrapper.appendChild(this.listEl);

    container.appendChild(wrapper);
    this.renderList();

    // Update elapsed timers every second
    this.timerInterval = setInterval(() => this.updateTimers(), 1000);
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
    this.runs = [];
  }

  /** Update the displayed runs data. */
  update(runs: ActiveRun[]): void {
    this.runs = runs;
    this.renderList();
  }

  /** Render the list of active runs. */
  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';

    if (this.runs.length === 0) {
      const empty = document.createElement('div');
      empty.className = CSS.empty;
      empty.textContent = 'No active runs';
      this.listEl.appendChild(empty);
      return;
    }

    for (const run of this.runs) {
      const item = document.createElement('div');
      item.className = CSS.item;
      item.setAttribute('role', 'listitem');
      item.dataset.runId = run.runId;

      // Agent identity
      const identity = document.createElement('div');
      identity.className = CSS.agentIdentity;

      const emoji = document.createElement('span');
      emoji.className = CSS.agentEmoji;
      emoji.textContent = run.agentEmoji;
      emoji.setAttribute('aria-hidden', 'true');
      identity.appendChild(emoji);

      const name = document.createElement('span');
      name.className = CSS.agentName;
      name.textContent = run.agentName;
      identity.appendChild(name);

      item.appendChild(identity);

      // Meta info
      const meta = document.createElement('div');
      meta.className = CSS.meta;

      const statusBadge = document.createElement('span');
      statusBadge.className = `${CSS.statusBadge} ${getStatusColor(run.status)}`;
      statusBadge.textContent = run.status.replace('-', ' ');
      meta.appendChild(statusBadge);

      const elapsed = document.createElement('span');
      elapsed.className = CSS.elapsed;
      elapsed.textContent = formatElapsed(run.startedAt);
      elapsed.dataset.startedAt = String(run.startedAt);
      meta.appendChild(elapsed);

      const cost = document.createElement('span');
      cost.className = CSS.cost;
      cost.textContent = formatCost(run.accumulatedCostUSD);
      meta.appendChild(cost);

      item.appendChild(meta);
      this.listEl.appendChild(item);
    }
  }

  /** Update the elapsed time displays. */
  private updateTimers(): void {
    if (!this.listEl) return;

    const elapsedElements = this.listEl.querySelectorAll(`.${CSS.elapsed}`);
    elapsedElements.forEach((el) => {
      const startedAt = Number((el as HTMLElement).dataset.startedAt);
      if (startedAt) {
        el.textContent = formatElapsed(startedAt);
      }
    });
  }
}
