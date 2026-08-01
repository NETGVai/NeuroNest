/**
 * Collapsible section component for the chat panel.
 * Renders expandable/collapsible sections for tool call results, diff previews,
 * and long output blocks. Sections are collapsed by default with a summary line
 * showing tool name and status. Consecutive tool call results are grouped into
 * a single "Actions performed" section to reduce visual noise.
 *
 * Uses vanilla DOM manipulation (matching the project's existing pattern).
 */

/** Status of a tool call result. */
export type ToolCallStatus = 'success' | 'failure' | 'pending';

/** A single tool call result entry within a collapsible section. */
export interface ToolCallEntry {
  /** Name of the tool that was invoked. */
  toolName: string;
  /** Status of the tool call. */
  status: ToolCallStatus;
  /** Full detail content to show when expanded. */
  detail: string;
  /** Duration in milliseconds (optional, displayed in summary). */
  duration?: number;
}

/** Configuration for creating a collapsible section. */
export interface CollapsibleSectionConfig {
  /** Summary text shown in the collapsed header. */
  summary: string;
  /** Detailed content shown when expanded. */
  content: string;
  /** Whether the section starts expanded. Default: false. */
  expanded?: boolean;
}

/** CSS class names scoped to collapsible sections. */
const CSS = {
  section: 'nn-collapsible-section',
  sectionExpanded: 'nn-collapsible-section--expanded',
  header: 'nn-collapsible-section__header',
  chevron: 'nn-collapsible-section__chevron',
  summary: 'nn-collapsible-section__summary',
  statusBadge: 'nn-collapsible-section__status',
  statusSuccess: 'nn-collapsible-section__status--success',
  statusFailure: 'nn-collapsible-section__status--failure',
  statusPending: 'nn-collapsible-section__status--pending',
  body: 'nn-collapsible-section__body',
  toolEntry: 'nn-collapsible-section__tool-entry',
  toolName: 'nn-collapsible-section__tool-name',
  toolDetail: 'nn-collapsible-section__tool-detail',
  toolDuration: 'nn-collapsible-section__tool-duration',
  groupHeader: 'nn-collapsible-section__group-header',
  groupCount: 'nn-collapsible-section__group-count',
} as const;

/** Injects scoped styles for collapsible sections. */
function injectStyles(): void {
  if (document.getElementById('nn-collapsible-section-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-collapsible-section-styles';
  style.textContent = `
    .${CSS.section} {
      border: 1px solid var(--border-color, #3d3d3d);
      border-radius: 6px;
      margin: 6px 0;
      overflow: hidden;
      background: var(--collapsible-bg, #1e1e1e);
    }
    .${CSS.header} {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      background: var(--collapsible-header-bg, #252526);
      transition: background 0.1s ease;
    }
    .${CSS.header}:hover {
      background: var(--collapsible-header-hover-bg, #2a2d2e);
    }
    .${CSS.header}:focus-visible {
      outline: 2px solid var(--focus-ring-color, #007acc);
      outline-offset: -2px;
    }
    .${CSS.chevron} {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      transition: transform 0.15s ease;
      color: var(--text-secondary, #aaaaaa);
    }
    .${CSS.sectionExpanded} .${CSS.chevron} {
      transform: rotate(90deg);
    }
    .${CSS.summary} {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary, #cccccc);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${CSS.statusBadge} {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }
    .${CSS.statusSuccess} {
      background: var(--status-success-bg, #1b3a1b);
      color: var(--status-success-text, #4ec94e);
    }
    .${CSS.statusFailure} {
      background: var(--status-failure-bg, #3a1b1b);
      color: var(--status-failure-text, #f44336);
    }
    .${CSS.statusPending} {
      background: var(--status-pending-bg, #3a3a1b);
      color: var(--status-pending-text, #ffa726);
    }
    .${CSS.body} {
      display: none;
      padding: 8px 12px;
      border-top: 1px solid var(--border-color, #3d3d3d);
      font-size: 13px;
      color: var(--text-primary, #cccccc);
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.5;
      max-height: 400px;
      overflow-y: auto;
    }
    .${CSS.sectionExpanded} .${CSS.body} {
      display: block;
    }
    .${CSS.toolEntry} {
      padding: 6px 0;
      border-bottom: 1px solid var(--border-subtle, #2d2d2d);
    }
    .${CSS.toolEntry}:last-child {
      border-bottom: none;
    }
    .${CSS.toolName} {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary, #cccccc);
      margin-bottom: 4px;
    }
    .${CSS.toolDetail} {
      font-size: 12px;
      color: var(--text-secondary, #aaaaaa);
      white-space: pre-wrap;
      word-wrap: break-word;
      padding-left: 22px;
    }
    .${CSS.toolDuration} {
      font-size: 11px;
      color: var(--text-tertiary, #666666);
      margin-left: auto;
      flex-shrink: 0;
    }
    .${CSS.groupHeader} {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .${CSS.groupCount} {
      font-size: 11px;
      color: var(--text-tertiary, #888888);
      background: var(--badge-bg, #333333);
      padding: 1px 6px;
      border-radius: 10px;
      flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);
}

/** Creates the chevron SVG icon for expand/collapse indication. */
function createChevronIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'currentColor');
  svg.classList.add(CSS.chevron);
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 4l4 4-4 4');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');

  svg.appendChild(path);
  return svg;
}

/** Formats a duration in milliseconds to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Creates a single collapsible section element.
 * Used for tool call results, diff previews, and long output blocks.
 *
 * @param config - Section configuration (summary, content, expanded state)
 * @returns The collapsible section DOM element
 */
export function createCollapsibleSection(config: CollapsibleSectionConfig): HTMLElement {
  injectStyles();

  const section = document.createElement('div');
  section.className = CSS.section;
  if (config.expanded) {
    section.classList.add(CSS.sectionExpanded);
  }
  section.setAttribute('role', 'region');

  // Header (clickable to toggle)
  const header = document.createElement('div');
  header.className = CSS.header;
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', String(!!config.expanded));
  header.setAttribute('aria-label', `Toggle ${config.summary}`);

  header.appendChild(createChevronIcon());

  const summaryEl = document.createElement('span');
  summaryEl.className = CSS.summary;
  summaryEl.textContent = config.summary;
  header.appendChild(summaryEl);

  section.appendChild(header);

  // Body (hidden when collapsed)
  const body = document.createElement('div');
  body.className = CSS.body;
  body.textContent = config.content;
  section.appendChild(body);

  // Toggle handler
  const toggle = (): void => {
    const isExpanded = section.classList.toggle(CSS.sectionExpanded);
    header.setAttribute('aria-expanded', String(isExpanded));
  };

  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  return section;
}

/**
 * Creates a collapsible section for a single tool call result.
 * Shows tool name and status in the summary line.
 *
 * @param entry - The tool call result entry
 * @returns The collapsible section DOM element
 */
export function createToolCallSection(entry: ToolCallEntry): HTMLElement {
  injectStyles();

  const section = document.createElement('div');
  section.className = CSS.section;
  section.setAttribute('role', 'region');

  // Header
  const header = document.createElement('div');
  header.className = CSS.header;
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', 'false');
  header.setAttribute('aria-label', `Toggle ${entry.toolName} result (${entry.status})`);

  header.appendChild(createChevronIcon());

  const summaryEl = document.createElement('span');
  summaryEl.className = CSS.summary;
  summaryEl.textContent = entry.toolName;
  header.appendChild(summaryEl);

  if (entry.duration !== undefined) {
    const durationEl = document.createElement('span');
    durationEl.className = CSS.toolDuration;
    durationEl.textContent = formatDuration(entry.duration);
    header.appendChild(durationEl);
  }

  const statusBadge = document.createElement('span');
  statusBadge.className = CSS.statusBadge;
  statusBadge.classList.add(
    entry.status === 'success'
      ? CSS.statusSuccess
      : entry.status === 'failure'
        ? CSS.statusFailure
        : CSS.statusPending
  );
  statusBadge.textContent = entry.status;
  header.appendChild(statusBadge);

  section.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = CSS.body;
  body.textContent = entry.detail;
  section.appendChild(body);

  // Toggle handler
  const toggle = (): void => {
    const isExpanded = section.classList.toggle(CSS.sectionExpanded);
    header.setAttribute('aria-expanded', String(isExpanded));
  };

  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  return section;
}

/**
 * Groups consecutive tool call results into a single collapsible
 * "Actions performed" section. The outer section is collapsed by default
 * with a count badge. Expanding it reveals individual tool entries with
 * their own expand/collapse controls.
 *
 * @param entries - Array of consecutive tool call results to group
 * @returns The grouped collapsible section DOM element
 */
export function createGroupedToolCallSection(entries: ToolCallEntry[]): HTMLElement {
  injectStyles();

  if (entries.length === 0) {
    // Edge case: no entries, return empty section
    return createCollapsibleSection({
      summary: 'Actions performed',
      content: 'No actions recorded.',
    });
  }

  // If only one entry, render a single tool call section directly
  if (entries.length === 1) {
    return createToolCallSection(entries[0]);
  }

  const section = document.createElement('div');
  section.className = CSS.section;
  section.setAttribute('role', 'region');
  section.setAttribute('aria-label', 'Actions performed');

  // Compute aggregate status
  const hasFailure = entries.some((e) => e.status === 'failure');
  const hasPending = entries.some((e) => e.status === 'pending');
  const aggregateStatus: ToolCallStatus = hasFailure
    ? 'failure'
    : hasPending
      ? 'pending'
      : 'success';

  // Header
  const header = document.createElement('div');
  header.className = CSS.header;
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', 'false');
  header.setAttribute('aria-label', `Toggle actions performed (${entries.length} actions)`);

  header.appendChild(createChevronIcon());

  const groupHeaderEl = document.createElement('span');
  groupHeaderEl.className = CSS.groupHeader;

  const summaryText = document.createElement('span');
  summaryText.className = CSS.summary;
  summaryText.textContent = 'Actions performed';
  groupHeaderEl.appendChild(summaryText);

  const countBadge = document.createElement('span');
  countBadge.className = CSS.groupCount;
  countBadge.textContent = String(entries.length);
  countBadge.setAttribute('aria-label', `${entries.length} actions`);
  groupHeaderEl.appendChild(countBadge);

  header.appendChild(groupHeaderEl);

  const statusBadge = document.createElement('span');
  statusBadge.className = CSS.statusBadge;
  statusBadge.classList.add(
    aggregateStatus === 'success'
      ? CSS.statusSuccess
      : aggregateStatus === 'failure'
        ? CSS.statusFailure
        : CSS.statusPending
  );
  statusBadge.textContent = aggregateStatus;
  header.appendChild(statusBadge);

  section.appendChild(header);

  // Body with individual tool entries
  const body = document.createElement('div');
  body.className = CSS.body;

  for (const entry of entries) {
    const toolEntryEl = document.createElement('div');
    toolEntryEl.className = CSS.toolEntry;

    const toolNameRow = document.createElement('div');
    toolNameRow.className = CSS.toolName;

    // Status indicator dot
    const dotColor =
      entry.status === 'success'
        ? 'var(--status-success-text, #4ec94e)'
        : entry.status === 'failure'
          ? 'var(--status-failure-text, #f44336)'
          : 'var(--status-pending-text, #ffa726)';
    const dot = document.createElement('span');
    dot.style.width = '6px';
    dot.style.height = '6px';
    dot.style.borderRadius = '50%';
    dot.style.background = dotColor;
    dot.style.flexShrink = '0';
    dot.setAttribute('aria-hidden', 'true');
    toolNameRow.appendChild(dot);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.toolName;
    toolNameRow.appendChild(nameSpan);

    if (entry.duration !== undefined) {
      const durationEl = document.createElement('span');
      durationEl.className = CSS.toolDuration;
      durationEl.textContent = formatDuration(entry.duration);
      toolNameRow.appendChild(durationEl);
    }

    toolEntryEl.appendChild(toolNameRow);

    if (entry.detail) {
      const detailEl = document.createElement('div');
      detailEl.className = CSS.toolDetail;
      detailEl.textContent = entry.detail;
      toolEntryEl.appendChild(detailEl);
    }

    body.appendChild(toolEntryEl);
  }

  section.appendChild(body);

  // Toggle handler
  const toggle = (): void => {
    const isExpanded = section.classList.toggle(CSS.sectionExpanded);
    header.setAttribute('aria-expanded', String(isExpanded));
  };

  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  return section;
}

/**
 * Utility to determine if a set of tool call entries should be grouped.
 * Groups consecutive entries (2 or more) into an "Actions performed" section.
 *
 * @param entries - Array of tool call entries to evaluate
 * @returns true if entries should be grouped (2+ consecutive entries)
 */
export function shouldGroupEntries(entries: ToolCallEntry[]): boolean {
  return entries.length >= 2;
}
