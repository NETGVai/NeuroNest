/**
 * Context Manager UI panel.
 *
 * Implements the PanelModule interface to display and manage GCF context sources.
 * Uses vanilla DOM manipulation (matching existing renderer panel patterns).
 *
 * Features:
 *   - Source list with type, status, and last-updated timestamp
 *   - Add File button (native file picker via IPC)
 *   - Add URL button (text input with URL validation)
 *   - Remove button (update only after GCF confirmation)
 *   - Context stats display (total entries, memory, utilization %)
 *   - Drift notification badge (unresolved conflict count)
 *   - Full keyboard navigation + ARIA labels
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */

import type { PanelModule } from '../types';

// ─── Types ──────────────────────────────────────────────────────

/** Represents a context source displayed in the panel. */
export interface ContextSourceItem {
  id: string;
  type: 'file' | 'url' | 'agent_generated';
  source: string;
  status: 'active' | 'stale' | 'error';
  lastUpdated: number;
}

/** Stats returned from context:get-stats IPC. */
export interface ContextStatsData {
  totalEntries: number;
  memoryUsageBytes: number;
  cacheHitRate: number;
  activeSourceCount: number;
  lastDriftEventAt: number | null;
}

/** IPC response shape for add/remove operations. */
interface IPCResponse {
  success: boolean;
  entry?: ContextSourceItem;
  error?: { code: string; message: string };
}

/** IPC response shape for listing sources. */
interface ListSourcesResponse {
  success: boolean;
  entries?: ContextSourceItem[];
  error?: { code: string; message: string };
}

/** IPC response shape for stats. */
interface GetStatsResponse {
  success: boolean;
  stats?: ContextStatsData;
  error?: { code: string; message: string };
}

// ─── CSS Classes ────────────────────────────────────────────────

const CSS = {
  panel: 'nn-ctx-panel',
  header: 'nn-ctx-panel__header',
  headerTitle: 'nn-ctx-panel__header-title',
  driftBadge: 'nn-ctx-panel__drift-badge',
  stats: 'nn-ctx-panel__stats',
  statItem: 'nn-ctx-panel__stat-item',
  toolbar: 'nn-ctx-panel__toolbar',
  toolbarBtn: 'nn-ctx-panel__toolbar-btn',
  urlInput: 'nn-ctx-panel__url-input',
  urlInputContainer: 'nn-ctx-panel__url-input-container',
  urlSubmitBtn: 'nn-ctx-panel__url-submit-btn',
  urlCancelBtn: 'nn-ctx-panel__url-cancel-btn',
  sourceList: 'nn-ctx-panel__source-list',
  sourceItem: 'nn-ctx-panel__source-item',
  sourceType: 'nn-ctx-panel__source-type',
  sourceStatus: 'nn-ctx-panel__source-status',
  sourcePath: 'nn-ctx-panel__source-path',
  sourceTimestamp: 'nn-ctx-panel__source-timestamp',
  sourceRemoveBtn: 'nn-ctx-panel__source-remove',
  emptyState: 'nn-ctx-panel__empty-state',
  statusActive: 'nn-ctx-panel__source-status--active',
  statusStale: 'nn-ctx-panel__source-status--stale',
  statusError: 'nn-ctx-panel__source-status--error',
} as const;

// ─── IPC Bridge ─────────────────────────────────────────────────

/**
 * Typed wrapper around the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const win = window as unknown as Record<string, unknown>;
  const bridge = win['electronAPI'] as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    off?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
    on: bridge?.on ?? (() => {}),
    off: bridge?.off ?? (() => {}),
  };
}

// ─── Styles ─────────────────────────────────────────────────────

/** Inject scoped styles for the context manager panel. */
function injectStyles(): void {
  if (document.getElementById('nn-ctx-panel-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-ctx-panel-styles';
  style.textContent = `
    .${CSS.panel} {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      background: var(--bg-primary, #0f172a);
      color: var(--text-primary, #e2e8f0);
      font-family: inherit;
      font-size: 13px;
    }
    .${CSS.header} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, #334155);
      background: var(--bg-secondary, #1e293b);
    }
    .${CSS.headerTitle} {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #e2e8f0);
    }
    .${CSS.driftBadge} {
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      border-radius: 10px;
      background: var(--red, #ef4444);
      color: white;
      font-size: 11px;
      font-weight: 700;
    }
    .${CSS.driftBadge}[data-count]:not([data-count="0"]) {
      display: flex;
    }
    .${CSS.stats} {
      display: flex;
      gap: 16px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--border, #334155);
      background: var(--bg-secondary, #1e293b);
    }
    .${CSS.statItem} {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .${CSS.statItem} .label {
      font-size: 11px;
      color: var(--text-secondary, #94a3b8);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .${CSS.statItem} .value {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary, #e2e8f0);
    }
    .${CSS.toolbar} {
      display: flex;
      gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--border, #334155);
    }
    .${CSS.toolbarBtn} {
      padding: 6px 12px;
      border: 1px solid var(--border, #334155);
      border-radius: 6px;
      background: var(--bg-secondary, #1e293b);
      color: var(--text-primary, #e2e8f0);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .${CSS.toolbarBtn}:hover {
      background: var(--bg-hover, #334155);
      border-color: var(--accent, #6366f1);
    }
    .${CSS.toolbarBtn}:focus-visible {
      outline: 2px solid var(--accent, #6366f1);
      outline-offset: 2px;
    }
    .${CSS.urlInputContainer} {
      display: none;
      gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--border, #334155);
      align-items: center;
    }
    .${CSS.urlInputContainer}.visible {
      display: flex;
    }
    .${CSS.urlInput} {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--border, #334155);
      border-radius: 6px;
      background: var(--bg-input, #0f172a);
      color: var(--text-primary, #e2e8f0);
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s;
    }
    .${CSS.urlInput}:focus {
      border-color: var(--accent, #6366f1);
    }
    .${CSS.urlInput}[aria-invalid="true"] {
      border-color: var(--red, #ef4444);
    }
    .${CSS.urlSubmitBtn} {
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      background: var(--accent, #6366f1);
      color: white;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    .${CSS.urlSubmitBtn}:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .${CSS.urlCancelBtn} {
      padding: 6px 12px;
      border: 1px solid var(--border, #334155);
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary, #94a3b8);
      font-size: 12px;
      cursor: pointer;
    }
    .${CSS.sourceList} {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }
    .${CSS.sourceItem} {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      transition: background 0.1s;
    }
    .${CSS.sourceItem}:hover {
      background: var(--bg-hover, #1e293b);
    }
    .${CSS.sourceItem}:focus-within {
      background: var(--bg-hover, #1e293b);
    }
    .${CSS.sourceType} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .${CSS.sourceType}[data-type="file"] {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }
    .${CSS.sourceType}[data-type="url"] {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
    }
    .${CSS.sourceType}[data-type="agent_generated"] {
      background: rgba(139, 92, 246, 0.15);
      color: #a78bfa;
    }
    .${CSS.sourceStatus} {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .${CSS.statusActive} {
      background: #10b981;
    }
    .${CSS.statusStale} {
      background: #f59e0b;
    }
    .${CSS.statusError} {
      background: #ef4444;
    }
    .${CSS.sourcePath} {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      color: var(--text-primary, #e2e8f0);
    }
    .${CSS.sourceTimestamp} {
      font-size: 11px;
      color: var(--text-secondary, #94a3b8);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .${CSS.sourceRemoveBtn} {
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary, #94a3b8);
      font-size: 11px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s, background 0.15s;
      flex-shrink: 0;
    }
    .${CSS.sourceItem}:hover .${CSS.sourceRemoveBtn},
    .${CSS.sourceRemoveBtn}:focus-visible {
      opacity: 1;
    }
    .${CSS.sourceRemoveBtn}:hover {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }
    .${CSS.sourceRemoveBtn}:focus-visible {
      outline: 2px solid var(--accent, #6366f1);
      outline-offset: 2px;
    }
    .${CSS.emptyState} {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 12px;
      color: var(--text-secondary, #94a3b8);
      padding: 32px 16px;
      text-align: center;
    }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ────────────────────────────────────────────────────

/** Format bytes into a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a timestamp into a short relative or absolute time string. */
function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;

  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Validate a URL string format. */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Map source type to short display label. */
function typeLabel(type: string): string {
  switch (type) {
    case 'file': return 'F';
    case 'url': return 'U';
    case 'agent_generated': return 'A';
    default: return '?';
  }
}

/** Escape HTML special characters. */
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ─── Panel Implementation ───────────────────────────────────────

/**
 * Context Manager panel implementing the PanelModule lifecycle.
 * Manages the display and interaction of GCF context sources.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */
export class ContextManagerPanel implements PanelModule {
  private container: HTMLElement | null = null;
  private sources: ContextSourceItem[] = [];
  private stats: ContextStatsData | null = null;
  private driftCount = 0;
  private urlInputVisible = false;

  // DOM element references
  private panelEl: HTMLElement | null = null;
  private sourceListEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private driftBadgeEl: HTMLElement | null = null;
  private urlInputContainerEl: HTMLElement | null = null;
  private urlInputEl: HTMLInputElement | null = null;

  // IPC listener references for cleanup
  private driftHandler: ((...args: unknown[]) => void) | null = null;

  // Polling interval for stats
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  /** Mount the context manager panel into the given container. */
  mount(container: HTMLElement): void {
    this.container = container;
    injectStyles();

    // Build panel structure
    this.panelEl = document.createElement('div');
    this.panelEl.className = CSS.panel;
    this.panelEl.setAttribute('role', 'region');
    this.panelEl.setAttribute('aria-label', 'Context Manager');

    // Header with title and drift badge
    const headerEl = this.renderHeader();
    this.panelEl.appendChild(headerEl);

    // Stats bar
    this.statsEl = this.renderStats();
    this.panelEl.appendChild(this.statsEl);

    // Toolbar with Add File / Add URL buttons
    const toolbarEl = this.renderToolbar();
    this.panelEl.appendChild(toolbarEl);

    // URL input row (hidden by default)
    this.urlInputContainerEl = this.renderUrlInput();
    this.panelEl.appendChild(this.urlInputContainerEl);

    // Source list
    this.sourceListEl = document.createElement('div');
    this.sourceListEl.className = CSS.sourceList;
    this.sourceListEl.setAttribute('role', 'list');
    this.sourceListEl.setAttribute('aria-label', 'Context sources');
    this.panelEl.appendChild(this.sourceListEl);

    container.appendChild(this.panelEl);

    // Load initial data
    this.refreshSources();
    this.refreshStats();

    // Listen for drift events from main process
    const bridge = getIpcBridge();
    this.driftHandler = () => {
      this.driftCount++;
      this.updateDriftBadge();
    };
    bridge.on('context:drift-event', this.driftHandler);

    // Poll stats every 10 seconds
    this.statsInterval = setInterval(() => this.refreshStats(), 10_000);
  }

  /** Unmount the panel and clean up all resources. */
  unmount(): void {
    // Remove drift event listener
    if (this.driftHandler) {
      const bridge = getIpcBridge();
      bridge.off('context:drift-event', this.driftHandler);
      this.driftHandler = null;
    }

    // Clear stats polling
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    // Remove DOM
    if (this.panelEl && this.container) {
      this.container.removeChild(this.panelEl);
    }

    this.container = null;
    this.panelEl = null;
    this.sourceListEl = null;
    this.statsEl = null;
    this.driftBadgeEl = null;
    this.urlInputContainerEl = null;
    this.urlInputEl = null;
    this.sources = [];
    this.stats = null;
    this.driftCount = 0;
  }

  /** Called when the panel receives focus. */
  onFocus(): void {
    this.refreshSources();
    this.refreshStats();
  }

  /** Called when the panel loses focus. */
  onBlur(): void {
    // No action needed.
  }

  // ─── Rendering ──────────────────────────────────────────────────

  /** Render the panel header with title and drift notification badge. */
  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = CSS.header;

    const title = document.createElement('h2');
    title.className = CSS.headerTitle;
    title.textContent = 'Context Sources';
    title.id = 'ctx-panel-title';
    header.appendChild(title);

    this.driftBadgeEl = document.createElement('span');
    this.driftBadgeEl.className = CSS.driftBadge;
    this.driftBadgeEl.setAttribute('role', 'status');
    this.driftBadgeEl.setAttribute('aria-label', 'Unresolved drift conflicts');
    this.driftBadgeEl.setAttribute('data-count', '0');
    this.driftBadgeEl.textContent = '0';
    header.appendChild(this.driftBadgeEl);

    return header;
  }

  /** Render the stats bar showing context statistics. */
  private renderStats(): HTMLElement {
    const statsEl = document.createElement('div');
    statsEl.className = CSS.stats;
    statsEl.setAttribute('role', 'group');
    statsEl.setAttribute('aria-label', 'Context statistics');
    this.updateStatsDOM(statsEl);
    return statsEl;
  }

  /** Render the toolbar with Add File and Add URL buttons. */
  private renderToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = CSS.toolbar;
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Context source actions');

    // Add File button (Requirement 10.2)
    const addFileBtn = document.createElement('button');
    addFileBtn.className = CSS.toolbarBtn;
    addFileBtn.textContent = 'Add File';
    addFileBtn.setAttribute('aria-label', 'Add file as context source');
    addFileBtn.addEventListener('click', () => this.handleAddFile());
    addFileBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.handleAddFile();
      }
    });
    toolbar.appendChild(addFileBtn);

    // Add URL button (Requirement 10.3)
    const addUrlBtn = document.createElement('button');
    addUrlBtn.className = CSS.toolbarBtn;
    addUrlBtn.textContent = 'Add URL';
    addUrlBtn.setAttribute('aria-label', 'Add URL as context source');
    addUrlBtn.addEventListener('click', () => this.toggleUrlInput());
    addUrlBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleUrlInput();
      }
    });
    toolbar.appendChild(addUrlBtn);

    return toolbar;
  }

  /** Render the URL input row (hidden by default). */
  private renderUrlInput(): HTMLElement {
    const container = document.createElement('div');
    container.className = CSS.urlInputContainer;
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'URL input');

    this.urlInputEl = document.createElement('input');
    this.urlInputEl.className = CSS.urlInput;
    this.urlInputEl.type = 'url';
    this.urlInputEl.placeholder = 'https://example.com/docs';
    this.urlInputEl.setAttribute('aria-label', 'Enter URL');
    this.urlInputEl.setAttribute('aria-invalid', 'false');
    this.urlInputEl.addEventListener('input', () => this.validateUrlInput());
    this.urlInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleAddUrl();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideUrlInput();
      }
    });
    container.appendChild(this.urlInputEl);

    const submitBtn = document.createElement('button');
    submitBtn.className = CSS.urlSubmitBtn;
    submitBtn.textContent = 'Add';
    submitBtn.setAttribute('aria-label', 'Submit URL');
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => this.handleAddUrl());
    container.appendChild(submitBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = CSS.urlCancelBtn;
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel adding URL');
    cancelBtn.addEventListener('click', () => this.hideUrlInput());
    container.appendChild(cancelBtn);

    return container;
  }

  /** Render a single source item in the list. */
  private renderSourceItem(source: ContextSourceItem): HTMLElement {
    const item = document.createElement('div');
    item.className = CSS.sourceItem;
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', `${source.type} source: ${source.source}, status: ${source.status}`);

    // Type badge
    const typeBadge = document.createElement('span');
    typeBadge.className = CSS.sourceType;
    typeBadge.setAttribute('data-type', source.type);
    typeBadge.setAttribute('aria-label', `Type: ${source.type}`);
    typeBadge.textContent = typeLabel(source.type);
    item.appendChild(typeBadge);

    // Status indicator
    const statusDot = document.createElement('span');
    statusDot.className = CSS.sourceStatus;
    statusDot.setAttribute('aria-label', `Status: ${source.status}`);
    switch (source.status) {
      case 'active':
        statusDot.classList.add(CSS.statusActive);
        break;
      case 'stale':
        statusDot.classList.add(CSS.statusStale);
        break;
      default:
        statusDot.classList.add(CSS.statusError);
    }
    item.appendChild(statusDot);

    // Source path/URL
    const pathEl = document.createElement('span');
    pathEl.className = CSS.sourcePath;
    pathEl.textContent = source.source;
    pathEl.title = source.source;
    item.appendChild(pathEl);

    // Timestamp
    const timestampEl = document.createElement('span');
    timestampEl.className = CSS.sourceTimestamp;
    timestampEl.textContent = formatTimestamp(source.lastUpdated);
    timestampEl.setAttribute('aria-label', `Last updated: ${formatTimestamp(source.lastUpdated)}`);
    item.appendChild(timestampEl);

    // Remove button (Requirement 10.4)
    const removeBtn = document.createElement('button');
    removeBtn.className = CSS.sourceRemoveBtn;
    removeBtn.textContent = 'Remove';
    removeBtn.setAttribute('aria-label', `Remove ${source.source}`);
    removeBtn.addEventListener('click', () => this.handleRemoveSource(source.id));
    removeBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.handleRemoveSource(source.id);
      }
    });
    item.appendChild(removeBtn);

    return item;
  }

  /** Render the empty state when no sources exist. */
  private renderEmptyState(): HTMLElement {
    const empty = document.createElement('div');
    empty.className = CSS.emptyState;
    empty.setAttribute('role', 'status');
    empty.innerHTML = `
      <div style="font-size: 32px;">📂</div>
      <div style="font-size: 13px;">No context sources</div>
      <div style="font-size: 12px; color: var(--text-tertiary, #64748b);">
        Add files or URLs to provide context to your agents
      </div>
    `;
    return empty;
  }

  // ─── DOM Updates ────────────────────────────────────────────────

  /** Update the stats bar DOM content. */
  private updateStatsDOM(container?: HTMLElement): void {
    const el = container ?? this.statsEl;
    if (!el) return;

    const totalEntries = this.stats?.totalEntries ?? 0;
    const memoryUsage = this.stats?.memoryUsageBytes ?? 0;
    // Context window utilization: estimated as (memoryUsage / 64MB) * 100
    const maxMemory = 64 * 1024 * 1024;
    const utilization = Math.min(100, (memoryUsage / maxMemory) * 100);

    el.innerHTML = '';

    const items: Array<{ label: string; value: string }> = [
      { label: 'Entries', value: String(totalEntries) },
      { label: 'Memory', value: formatBytes(memoryUsage) },
      { label: 'Utilization', value: `${utilization.toFixed(1)}%` },
    ];

    for (const item of items) {
      const statItem = document.createElement('div');
      statItem.className = CSS.statItem;
      statItem.innerHTML = `
        <span class="label">${escapeHtml(item.label)}</span>
        <span class="value">${escapeHtml(item.value)}</span>
      `;
      el.appendChild(statItem);
    }
  }

  /** Update the drift notification badge count. */
  private updateDriftBadge(): void {
    if (!this.driftBadgeEl) return;
    this.driftBadgeEl.setAttribute('data-count', String(this.driftCount));
    this.driftBadgeEl.textContent = String(this.driftCount);
    this.driftBadgeEl.setAttribute(
      'aria-label',
      `${this.driftCount} unresolved drift conflict${this.driftCount !== 1 ? 's' : ''}`
    );
  }

  /** Re-render the source list from current state. */
  private renderSourceList(): void {
    if (!this.sourceListEl) return;
    this.sourceListEl.innerHTML = '';

    if (this.sources.length === 0) {
      this.sourceListEl.appendChild(this.renderEmptyState());
      return;
    }

    for (const source of this.sources) {
      this.sourceListEl.appendChild(this.renderSourceItem(source));
    }
  }

  // ─── Actions ────────────────────────────────────────────────────

  /**
   * Handle "Add File" button click.
   * Opens native file picker via IPC dialog, sends selected path.
   * Requirement 10.2
   */
  private async handleAddFile(): Promise<void> {
    const bridge = getIpcBridge();

    // Open native file picker via Electron dialog
    const result = await bridge.invoke('dialog:open-file', {
      properties: ['openFile'],
      title: 'Select a file to add as context source',
    }) as { canceled: boolean; filePaths?: string[] } | undefined;

    if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return;
    }

    const filePath = result.filePaths[0];

    // Send add-source request via IPC
    const response = await bridge.invoke('context:add-source', {
      type: 'file',
      path: filePath,
    }) as IPCResponse | undefined;

    if (response?.success) {
      await this.refreshSources();
      this.refreshStats();
    }
  }

  /** Toggle the URL input row visibility. */
  private toggleUrlInput(): void {
    if (this.urlInputVisible) {
      this.hideUrlInput();
    } else {
      this.showUrlInput();
    }
  }

  /** Show the URL input row and focus the input. */
  private showUrlInput(): void {
    this.urlInputVisible = true;
    if (this.urlInputContainerEl) {
      this.urlInputContainerEl.classList.add('visible');
    }
    if (this.urlInputEl) {
      this.urlInputEl.value = '';
      this.urlInputEl.setAttribute('aria-invalid', 'false');
      this.urlInputEl.focus();
    }
  }

  /** Hide the URL input row. */
  private hideUrlInput(): void {
    this.urlInputVisible = false;
    if (this.urlInputContainerEl) {
      this.urlInputContainerEl.classList.remove('visible');
    }
    if (this.urlInputEl) {
      this.urlInputEl.value = '';
      this.urlInputEl.setAttribute('aria-invalid', 'false');
    }
  }

  /** Validate the URL input and update submit button state. */
  private validateUrlInput(): void {
    if (!this.urlInputEl || !this.urlInputContainerEl) return;

    const value = this.urlInputEl.value.trim();
    const valid = value.length === 0 || isValidUrl(value);
    const canSubmit = value.length > 0 && isValidUrl(value);

    this.urlInputEl.setAttribute('aria-invalid', String(!valid && value.length > 0));

    // Update submit button
    const submitBtn = this.urlInputContainerEl.querySelector(
      `.${CSS.urlSubmitBtn}`
    ) as HTMLButtonElement | null;
    if (submitBtn) {
      submitBtn.disabled = !canSubmit;
    }
  }

  /**
   * Handle URL submission.
   * Validates format and sends via IPC.
   * Requirement 10.3
   */
  private async handleAddUrl(): Promise<void> {
    if (!this.urlInputEl) return;

    const url = this.urlInputEl.value.trim();
    if (!isValidUrl(url)) {
      this.urlInputEl.setAttribute('aria-invalid', 'true');
      this.urlInputEl.focus();
      return;
    }

    const bridge = getIpcBridge();
    const response = await bridge.invoke('context:add-source', {
      type: 'url',
      url,
    }) as IPCResponse | undefined;

    if (response?.success) {
      this.hideUrlInput();
      await this.refreshSources();
      this.refreshStats();
    }
  }

  /**
   * Handle removal of a context source.
   * Sends removal request and updates list ONLY after GCF confirmation.
   * Requirement 10.4
   */
  private async handleRemoveSource(entryId: string): Promise<void> {
    const bridge = getIpcBridge();
    const response = await bridge.invoke('context:remove-source', {
      entryId,
    }) as IPCResponse | undefined;

    // Only update the list after successful confirmation from GCF
    if (response?.success) {
      this.sources = this.sources.filter((s) => s.id !== entryId);
      this.renderSourceList();
      this.refreshStats();
    }
  }

  // ─── Data Loading ───────────────────────────────────────────────

  /** Fetch and display the current list of context sources via IPC. */
  private async refreshSources(): Promise<void> {
    const bridge = getIpcBridge();
    const response = await bridge.invoke('context:list-sources') as ListSourcesResponse | undefined;

    if (response?.success && response.entries) {
      this.sources = response.entries.map((entry) => {
        // The IPC response may include ContextEntry fields (lastAccessedAt)
        // or our panel-shaped fields (lastUpdated), handle both.
        const raw = entry as unknown as Record<string, unknown>;
        const lastUpdated = (entry.lastUpdated
          ?? (raw['lastAccessedAt'] as number | undefined)
          ?? Date.now()) as number;
        return {
          id: entry.id,
          type: entry.type,
          source: entry.source,
          status: entry.status ?? 'active',
          lastUpdated,
        };
      });
    } else {
      this.sources = [];
    }

    this.renderSourceList();
  }

  /** Fetch and display context statistics via IPC. */
  private async refreshStats(): Promise<void> {
    const bridge = getIpcBridge();
    const response = await bridge.invoke('context:get-stats') as GetStatsResponse | undefined;

    if (response?.success && response.stats) {
      this.stats = response.stats;
    }

    this.updateStatsDOM();
  }
}

// ─── Module Export ──────────────────────────────────────────────

/** Create and export the context manager panel module singleton. */
export function createContextManagerPanel(): PanelModule {
  return new ContextManagerPanel();
}

/** Default export: a ready-to-use context manager panel instance. */
export const contextManagerPanel: PanelModule = createContextManagerPanel();

export default contextManagerPanel;
