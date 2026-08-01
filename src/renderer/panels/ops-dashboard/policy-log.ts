/**
 * Policy Log sub-panel for the Operations Dashboard.
 * Displays recent policy decisions in a scrollable log with
 * allow (green), deny (red), and escalate (yellow) color coding,
 * rule ID, and correlation ID.
 *
 * Requirements: 15.4
 */

/** Data shape for a policy decision entry. */
export interface PolicyDecisionEntry {
  correlationId: string;
  decision: 'allow' | 'deny' | 'escalate';
  matchedRule: string | null;
  toolName: string;
  agentId: string;
  timestamp: number;
  reason?: string;
}

/** CSS class names scoped to policy-log. */
const CSS = {
  container: 'nn-ops-policy-log',
  header: 'nn-ops-policy-log__header',
  list: 'nn-ops-policy-log__list',
  item: 'nn-ops-policy-log__item',
  decisionBadge: 'nn-ops-policy-log__decision-badge',
  itemContent: 'nn-ops-policy-log__item-content',
  toolInfo: 'nn-ops-policy-log__tool-info',
  ruleId: 'nn-ops-policy-log__rule-id',
  correlationId: 'nn-ops-policy-log__correlation-id',
  timestamp: 'nn-ops-policy-log__timestamp',
  empty: 'nn-ops-policy-log__empty',
} as const;

/** Get decision badge class based on decision type. */
function getDecisionClass(decision: PolicyDecisionEntry['decision']): string {
  switch (decision) {
    case 'allow': return 'nn-ops-decision--allow';
    case 'deny': return 'nn-ops-decision--deny';
    case 'escalate': return 'nn-ops-decision--escalate';
    default: return '';
  }
}

/** Format a timestamp as a time string (HH:MM:SS). */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Truncate a string to max length with ellipsis. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

/** Inject styles for policy-log sub-panel. */
function injectStyles(): void {
  if (document.getElementById('nn-ops-policy-log-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-ops-policy-log-styles';
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
      padding: 2px 0;
      font-family: var(--font-mono, 'Fira Code', 'JetBrains Mono', Consolas, monospace);
    }
    .${CSS.item} {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      border-bottom: 1px solid var(--ops-border-light, #2a2a2a);
      font-size: 11px;
      transition: background 0.1s ease;
    }
    .${CSS.item}:hover {
      background: var(--ops-item-hover, rgba(255, 255, 255, 0.04));
    }
    .${CSS.decisionBadge} {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      min-width: 52px;
      text-align: center;
      flex-shrink: 0;
    }
    .nn-ops-decision--allow {
      background: rgba(73, 199, 145, 0.15);
      color: #49c791;
    }
    .nn-ops-decision--deny {
      background: rgba(220, 80, 80, 0.15);
      color: #dc5050;
    }
    .nn-ops-decision--escalate {
      background: rgba(255, 179, 71, 0.15);
      color: #ffb347;
    }
    .${CSS.itemContent} {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }
    .${CSS.toolInfo} {
      color: var(--ops-text-primary, #e0e0e0);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${CSS.ruleId} {
      color: var(--ops-text-secondary, #999999);
      white-space: nowrap;
    }
    .${CSS.correlationId} {
      color: var(--ops-text-muted, #666666);
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${CSS.timestamp} {
      color: var(--ops-text-muted, #666666);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .${CSS.empty} {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-size: 13px;
      color: var(--ops-text-muted, #666666);
      padding: 24px;
      font-family: system-ui, sans-serif;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Policy Log panel component.
 * Displays a scrollable log of recent policy decisions with color-coded badges.
 */
export class PolicyLogPanel {
  private container: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private decisions: PolicyDecisionEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  /** Mount the policy log panel into a container. */
  mount(container: HTMLElement): void {
    injectStyles();
    this.container = container;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = CSS.container;

    const header = document.createElement('div');
    header.className = CSS.header;
    header.textContent = 'Policy Decisions';
    wrapper.appendChild(header);

    this.listEl = document.createElement('div');
    this.listEl.className = CSS.list;
    this.listEl.setAttribute('role', 'log');
    this.listEl.setAttribute('aria-label', 'Recent policy decisions');
    this.listEl.setAttribute('aria-live', 'polite');
    wrapper.appendChild(this.listEl);

    container.appendChild(wrapper);
    this.renderList();
  }

  /** Unmount and clean up resources. */
  unmount(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.listEl = null;
    this.decisions = [];
  }

  /** Update the displayed decisions data. */
  update(decisions: PolicyDecisionEntry[]): void {
    this.decisions = decisions.slice(0, this.maxEntries);
    this.renderList();
  }

  /** Append a single new decision to the log (most recent first). */
  append(decision: PolicyDecisionEntry): void {
    this.decisions.unshift(decision);
    if (this.decisions.length > this.maxEntries) {
      this.decisions.pop();
    }

    // Optimized: prepend single item instead of re-rendering
    if (this.listEl && this.decisions.length > 0) {
      const emptyEl = this.listEl.querySelector(`.${CSS.empty}`);
      if (emptyEl) {
        this.listEl.removeChild(emptyEl);
      }
      const item = this.createItemElement(decision);
      this.listEl.insertBefore(item, this.listEl.firstChild);

      // Remove overflow items from DOM
      while (this.listEl.children.length > this.maxEntries) {
        this.listEl.removeChild(this.listEl.lastChild!);
      }
    }
  }

  /** Render the full list of policy decisions. */
  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';

    if (this.decisions.length === 0) {
      const empty = document.createElement('div');
      empty.className = CSS.empty;
      empty.textContent = 'No policy decisions recorded';
      this.listEl.appendChild(empty);
      return;
    }

    for (const decision of this.decisions) {
      const item = this.createItemElement(decision);
      this.listEl.appendChild(item);
    }
  }

  /** Create a DOM element for a single policy decision. */
  private createItemElement(decision: PolicyDecisionEntry): HTMLElement {
    const item = document.createElement('div');
    item.className = CSS.item;
    item.setAttribute('role', 'listitem');

    // Timestamp
    const timestamp = document.createElement('span');
    timestamp.className = CSS.timestamp;
    timestamp.textContent = formatTime(decision.timestamp);
    item.appendChild(timestamp);

    // Decision badge
    const badge = document.createElement('span');
    badge.className = `${CSS.decisionBadge} ${getDecisionClass(decision.decision)}`;
    badge.textContent = decision.decision;
    item.appendChild(badge);

    // Content area
    const content = document.createElement('div');
    content.className = CSS.itemContent;

    // Tool name + agent
    const toolInfo = document.createElement('span');
    toolInfo.className = CSS.toolInfo;
    toolInfo.textContent = `${decision.toolName} (${truncate(decision.agentId, 20)})`;
    toolInfo.title = `Tool: ${decision.toolName}, Agent: ${decision.agentId}`;
    content.appendChild(toolInfo);

    // Rule ID
    if (decision.matchedRule) {
      const ruleId = document.createElement('span');
      ruleId.className = CSS.ruleId;
      ruleId.textContent = `rule:${decision.matchedRule}`;
      content.appendChild(ruleId);
    }

    // Correlation ID
    const correlationId = document.createElement('span');
    correlationId.className = CSS.correlationId;
    correlationId.textContent = truncate(decision.correlationId, 12);
    correlationId.title = decision.correlationId;
    content.appendChild(correlationId);

    item.appendChild(content);
    return item;
  }
}
