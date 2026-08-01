/**
 * Spec Viewer Panel — Main panel component.
 *
 * Registers with panel-registry, fetches spec documents via `spec:get-document` IPC,
 * renders a table of contents sidebar with section navigation.
 *
 * Displays requirements.md, design.md, and tasks.md files in a formatted read view
 * with section navigation (table of contents sidebar) and inline status indicators.
 *
 * Renders requirements as cards, design sections as expandable panels, and tasks as
 * a checklist with status badges (not-started, in-progress, completed).
 *
 * Requirements: 23.9, 23.11, 23.16
 */

import type { PanelModule } from '../../types';
import { renderRequirementCard, parseRequirements } from './requirement-card';
import { renderTaskChecklist, parseTasks } from './task-checklist';
import { renderDependencyGraph, parseDependencyGraph } from './dependency-graph';
import { renderActionBar } from './action-bar';

// ─── Types ──────────────────────────────────────────────────────

/** Document types that can be loaded in the spec viewer. */
type SpecDocType = 'requirements' | 'design' | 'tasks';

/** Table of contents entry for sidebar navigation. */
interface TocEntry {
  id: string;
  label: string;
  level: number;
  type: SpecDocType;
}

/** Design section data for expandable panels. */
interface DesignSection {
  id: string;
  title: string;
  content: string;
  level: number;
}

// ─── CSS Classes ────────────────────────────────────────────────

const CLS = {
  panel: 'nn-spec-viewer',
  layout: 'nn-spec-viewer__layout',
  sidebar: 'nn-spec-viewer__sidebar',
  sidebarTitle: 'nn-spec-viewer__sidebar-title',
  tocList: 'nn-spec-viewer__toc-list',
  tocItem: 'nn-spec-viewer__toc-item',
  tocItemActive: 'nn-spec-viewer__toc-item--active',
  tocDot: 'nn-spec-viewer__toc-dot',
  content: 'nn-spec-viewer__content',
  tabBar: 'nn-spec-viewer__tab-bar',
  tab: 'nn-spec-viewer__tab',
  tabActive: 'nn-spec-viewer__tab--active',
  docContent: 'nn-spec-viewer__doc-content',
  designSection: 'nn-spec-viewer__design-section',
  designHeader: 'nn-spec-viewer__design-header',
  designToggle: 'nn-spec-viewer__design-toggle',
  designTitle: 'nn-spec-viewer__design-title',
  designBody: 'nn-spec-viewer__design-body',
  designBodyHidden: 'nn-spec-viewer__design-body--hidden',
  emptyState: 'nn-spec-viewer__empty',
  statusIndicator: 'nn-spec-viewer__status',
} as const;

// ─── Styles ─────────────────────────────────────────────────────

/** Inject scoped styles for the spec viewer panel. */
function injectStyles(): void {
  if (document.getElementById('nn-spec-viewer-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-spec-viewer-styles';
  style.textContent = `
    .${CLS.panel} {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      background: var(--bg-primary, #0f172a);
      color: var(--text-primary, #e2e8f0);
      font-family: inherit;
      font-size: 13px;
    }
    .${CLS.tabBar} {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border, #334155);
      background: var(--bg-secondary, #1e293b);
      flex-shrink: 0;
    }
    .${CLS.tab} {
      padding: 10px 16px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary, #94a3b8);
      border: none;
      border-bottom: 2px solid transparent;
      background: transparent;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .${CLS.tab}:hover {
      color: var(--text-primary, #e2e8f0);
    }
    .${CLS.tabActive} {
      color: var(--accent, #6366f1);
      border-bottom-color: var(--accent, #6366f1);
    }
    .${CLS.layout} {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .${CLS.sidebar} {
      width: 200px;
      min-width: 160px;
      border-right: 1px solid var(--border, #334155);
      overflow-y: auto;
      background: var(--bg-secondary, #1e293b);
      padding: 12px 0;
      flex-shrink: 0;
    }
    .${CLS.sidebarTitle} {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary, #94a3b8);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 16px 8px;
    }
    .${CLS.tocList} {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .${CLS.tocItem} {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 16px;
      font-size: 12px;
      color: var(--text-secondary, #94a3b8);
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
      border: none;
      background: transparent;
      width: 100%;
      text-align: left;
    }
    .${CLS.tocItem}:hover {
      background: var(--bg-hover, #334155);
      color: var(--text-primary, #e2e8f0);
    }
    .${CLS.tocItemActive} {
      color: var(--accent, #6366f1);
      background: rgba(99, 102, 241, 0.1);
    }
    .${CLS.tocDot} {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--border, #475569);
      flex-shrink: 0;
    }
    .${CLS.tocItemActive} .${CLS.tocDot} {
      background: var(--accent, #6366f1);
    }
    .${CLS.content} {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px;
    }
    .${CLS.docContent} {
      max-width: 720px;
    }
    .${CLS.designSection} {
      border: 1px solid var(--border, #334155);
      border-radius: 8px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .${CLS.designHeader} {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--bg-secondary, #1e293b);
      cursor: pointer;
      border: none;
      width: 100%;
      text-align: left;
      color: var(--text-primary, #e2e8f0);
      transition: background 0.1s;
    }
    .${CLS.designHeader}:hover {
      background: var(--bg-hover, #334155);
    }
    .${CLS.designToggle} {
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--text-secondary, #94a3b8);
    }
    .${CLS.designTitle} {
      font-size: 13px;
      font-weight: 600;
    }
    .${CLS.designBody} {
      padding: 12px 14px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--text-secondary, #94a3b8);
      border-top: 1px solid var(--border, #334155);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .${CLS.designBodyHidden} {
      display: none;
    }
    .${CLS.emptyState} {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--text-secondary, #94a3b8);
      gap: 8px;
    }
    .${CLS.statusIndicator} {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
  `;
  document.head.appendChild(style);
}

// ─── IPC Bridge ─────────────────────────────────────────────────

/** Typed wrapper around the preload-exposed IPC bridge. */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const win = window as unknown as Record<string, unknown>;
  const bridge = win['electronAPI'] as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
  };
}

/** Escape a string for use as a CSS selector (ID escaping). */
function escapeCssSelector(value: string): string {
  return value.replace(/([^\w-])/g, '\\$1');
}

// ─── Panel Implementation ───────────────────────────────────────

/**
 * Spec Viewer panel implementing the PanelModule lifecycle.
 * Displays spec documents with section navigation and formatted content.
 *
 * Requirements: 23.9, 23.11, 23.16
 */
export class SpecViewerPanel implements PanelModule {
  private container: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private tocListEl: HTMLElement | null = null;

  private activeTab: SpecDocType = 'requirements';
  private documents: Record<SpecDocType, string> = {
    requirements: '',
    design: '',
    tasks: '',
  };
  private tocEntries: TocEntry[] = [];
  private activeTocId: string | null = null;

  /** Mount the spec viewer panel into the given container element. */
  mount(container: HTMLElement): void {
    this.container = container;
    injectStyles();

    this.panelEl = document.createElement('div');
    this.panelEl.className = CLS.panel;
    this.panelEl.setAttribute('role', 'region');
    this.panelEl.setAttribute('aria-label', 'Spec Viewer');

    // Tab bar
    const tabBar = this.renderTabBar();
    this.panelEl.appendChild(tabBar);

    // Action bar with workflow buttons (Requirements: 23.10)
    const actionBar = renderActionBar();
    this.panelEl.appendChild(actionBar);

    // Layout: sidebar + content
    const layout = document.createElement('div');
    layout.className = CLS.layout;

    // Sidebar (TOC)
    const sidebar = this.renderSidebar();
    layout.appendChild(sidebar);

    // Content area
    this.contentEl = document.createElement('div');
    this.contentEl.className = CLS.content;
    layout.appendChild(this.contentEl);

    this.panelEl.appendChild(layout);
    container.appendChild(this.panelEl);

    // Load documents
    this.loadDocuments();
  }

  /** Unmount the panel and clean up. */
  unmount(): void {
    if (this.panelEl && this.container) {
      this.container.removeChild(this.panelEl);
    }
    this.container = null;
    this.panelEl = null;
    this.contentEl = null;
    this.tocListEl = null;
    this.documents = { requirements: '', design: '', tasks: '' };
    this.tocEntries = [];
    this.activeTocId = null;
  }

  /** Called when the panel receives focus. */
  onFocus(): void {
    this.loadDocuments();
  }

  /** Called when the panel loses focus. */
  onBlur(): void {
    // No action needed.
  }

  // ─── Rendering ──────────────────────────────────────────────────

  /** Render the tab bar for switching between document views. */
  private renderTabBar(): HTMLElement {
    const tabBar = document.createElement('div');
    tabBar.className = CLS.tabBar;
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'Spec document tabs');

    const tabs: Array<{ type: SpecDocType; label: string }> = [
      { type: 'requirements', label: 'Requirements' },
      { type: 'design', label: 'Design' },
      { type: 'tasks', label: 'Tasks' },
    ];

    for (const tab of tabs) {
      const button = document.createElement('button');
      button.className = tab.type === this.activeTab
        ? `${CLS.tab} ${CLS.tabActive}`
        : CLS.tab;
      button.textContent = tab.label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.type === this.activeTab));
      button.setAttribute('data-tab', tab.type);
      button.addEventListener('click', () => this.switchTab(tab.type));
      tabBar.appendChild(button);
    }

    return tabBar;
  }

  /** Render the sidebar with table of contents. */
  private renderSidebar(): HTMLElement {
    const sidebar = document.createElement('nav');
    sidebar.className = CLS.sidebar;
    sidebar.setAttribute('aria-label', 'Table of contents');

    const title = document.createElement('div');
    title.className = CLS.sidebarTitle;
    title.textContent = 'Contents';
    sidebar.appendChild(title);

    this.tocListEl = document.createElement('ul');
    this.tocListEl.className = CLS.tocList;
    this.tocListEl.setAttribute('role', 'list');
    sidebar.appendChild(this.tocListEl);

    return sidebar;
  }

  /** Update the TOC sidebar with entries from the current document. */
  private updateToc(): void {
    if (!this.tocListEl) return;
    this.tocListEl.innerHTML = '';

    for (const entry of this.tocEntries) {
      const li = document.createElement('li');

      const button = document.createElement('button');
      button.className = entry.id === this.activeTocId
        ? `${CLS.tocItem} ${CLS.tocItemActive}`
        : CLS.tocItem;
      button.style.paddingLeft = `${16 + (entry.level - 1) * 12}px`;
      button.setAttribute('data-toc-id', entry.id);

      const dot = document.createElement('span');
      dot.className = CLS.tocDot;
      button.appendChild(dot);

      const label = document.createElement('span');
      label.textContent = entry.label;
      button.appendChild(label);

      button.addEventListener('click', () => this.scrollToSection(entry.id));

      li.appendChild(button);
      this.tocListEl.appendChild(li);
    }
  }

  /** Render the content area based on the active tab. */
  private renderContent(): void {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = '';

    const docContent = document.createElement('div');
    docContent.className = CLS.docContent;

    switch (this.activeTab) {
      case 'requirements':
        this.renderRequirementsContent(docContent);
        break;
      case 'design':
        this.renderDesignContent(docContent);
        break;
      case 'tasks':
        this.renderTasksContent(docContent);
        break;
    }

    this.contentEl.appendChild(docContent);
  }

  /** Render requirements as cards. */
  private renderRequirementsContent(container: HTMLElement): void {
    const markdown = this.documents.requirements;
    if (!markdown) {
      container.appendChild(this.renderEmptyState('No requirements document loaded.'));
      return;
    }

    const requirements = parseRequirements(markdown);
    this.tocEntries = requirements.map((req) => ({
      id: `req-${req.id}`,
      label: `${req.id}. ${req.title}`,
      level: 1,
      type: 'requirements' as SpecDocType,
    }));
    this.updateToc();

    if (requirements.length === 0) {
      container.appendChild(this.renderEmptyState('No requirements found in document.'));
      return;
    }

    for (const req of requirements) {
      const card = renderRequirementCard(req);
      card.id = `req-${req.id}`;
      container.appendChild(card);
    }
  }

  /** Render design sections as expandable panels. */
  private renderDesignContent(container: HTMLElement): void {
    const markdown = this.documents.design;
    if (!markdown) {
      container.appendChild(this.renderEmptyState('No design document loaded.'));
      return;
    }

    const sections = this.parseDesignSections(markdown);
    this.tocEntries = sections.map((section) => ({
      id: section.id,
      label: section.title,
      level: section.level,
      type: 'design' as SpecDocType,
    }));
    this.updateToc();

    if (sections.length === 0) {
      container.appendChild(this.renderEmptyState('No design sections found.'));
      return;
    }

    for (const section of sections) {
      container.appendChild(this.renderDesignSection(section));
    }
  }

  /** Render tasks as a checklist with dependency graph. */
  private renderTasksContent(container: HTMLElement): void {
    const markdown = this.documents.tasks;
    if (!markdown) {
      container.appendChild(this.renderEmptyState('No tasks document loaded.'));
      return;
    }

    const tasks = parseTasks(markdown);
    this.tocEntries = tasks.map((task) => ({
      id: `task-${task.id}`,
      label: `${task.id}. ${task.title}`,
      level: 1,
      type: 'tasks' as SpecDocType,
    }));
    this.updateToc();

    // Render task checklist
    if (tasks.length > 0) {
      const checklist = renderTaskChecklist(tasks);
      checklist.id = 'task-checklist';
      container.appendChild(checklist);
    }

    // Render dependency graph
    const graphData = parseDependencyGraph(markdown);
    if (graphData.waves.length > 0) {
      const spacer = document.createElement('div');
      spacer.style.marginTop = '24px';
      container.appendChild(spacer);

      const graph = renderDependencyGraph(graphData);
      graph.id = 'dependency-graph';
      container.appendChild(graph);
    }
  }

  /** Render a single design section as an expandable panel. */
  private renderDesignSection(section: DesignSection): HTMLElement {
    const sectionEl = document.createElement('div');
    sectionEl.className = CLS.designSection;
    sectionEl.id = section.id;

    // Header (clickable toggle)
    const header = document.createElement('button');
    header.className = CLS.designHeader;
    header.setAttribute('aria-expanded', 'false');
    header.setAttribute('aria-controls', `${section.id}-body`);

    const toggle = document.createElement('span');
    toggle.className = CLS.designToggle;
    toggle.textContent = '\u25B6';
    header.appendChild(toggle);

    const title = document.createElement('span');
    title.className = CLS.designTitle;
    title.textContent = section.title;
    header.appendChild(title);

    // Body (collapsible)
    const body = document.createElement('div');
    body.className = `${CLS.designBody} ${CLS.designBodyHidden}`;
    body.id = `${section.id}-body`;
    body.textContent = section.content;

    // Toggle behavior
    header.addEventListener('click', () => {
      const isExpanded = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', String(!isExpanded));
      toggle.textContent = isExpanded ? '\u25B6' : '\u25BC';
      if (isExpanded) {
        body.classList.add(CLS.designBodyHidden);
      } else {
        body.classList.remove(CLS.designBodyHidden);
      }
    });

    sectionEl.appendChild(header);
    sectionEl.appendChild(body);

    return sectionEl;
  }

  /** Render an empty state message. */
  private renderEmptyState(message: string): HTMLElement {
    const empty = document.createElement('div');
    empty.className = CLS.emptyState;
    empty.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.style.fontSize = '32px';
    icon.textContent = '\uD83D\uDCCB';
    empty.appendChild(icon);

    const text = document.createElement('div');
    text.style.fontSize = '13px';
    text.textContent = message;
    empty.appendChild(text);

    return empty;
  }

  // ─── Actions ────────────────────────────────────────────────────

  /** Switch to a different document tab. */
  private switchTab(tab: SpecDocType): void {
    if (tab === this.activeTab) return;
    this.activeTab = tab;

    // Update tab bar
    if (this.panelEl) {
      const tabs = this.panelEl.querySelectorAll(`[role="tab"]`);
      tabs.forEach((tabEl) => {
        const type = tabEl.getAttribute('data-tab');
        if (type === tab) {
          tabEl.classList.add(CLS.tabActive);
          tabEl.setAttribute('aria-selected', 'true');
        } else {
          tabEl.classList.remove(CLS.tabActive);
          tabEl.setAttribute('aria-selected', 'false');
        }
      });
    }

    this.renderContent();
  }

  /** Scroll to a section within the content area. */
  private scrollToSection(sectionId: string): void {
    this.activeTocId = sectionId;
    this.updateToc();

    if (this.contentEl) {
      const escaped = escapeCssSelector(sectionId);
      const target = this.contentEl.querySelector(`#${escaped}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  // ─── Data Loading ───────────────────────────────────────────────

  /** Fetch all spec documents from the main process via IPC. */
  private async loadDocuments(): Promise<void> {
    const bridge = getIpcBridge();

    const docTypes: SpecDocType[] = ['requirements', 'design', 'tasks'];

    for (const docType of docTypes) {
      try {
        const response = await bridge.invoke('spec:get-document', { type: docType }) as
          | { success: boolean; content?: string }
          | undefined;

        if (response?.success && response.content) {
          this.documents[docType] = response.content;
        }
      } catch {
        // Silently handle IPC failures — show empty state for that doc
      }
    }

    this.renderContent();
  }

  // ─── Parsers ────────────────────────────────────────────────────

  /** Parse design document into sections (## and ### headings). */
  private parseDesignSections(markdown: string): DesignSection[] {
    const sections: DesignSection[] = [];
    const headingPattern = /^(#{2,3}) (.+)$/gm;
    let match: RegExpExecArray | null;
    const matches: Array<{ level: number; title: string; startIndex: number }> = [];

    while ((match = headingPattern.exec(markdown)) !== null) {
      matches.push({
        level: match[1].length - 1, // ## = 1, ### = 2
        title: match[2],
        startIndex: match.index + match[0].length,
      });
    }

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const next = matches[i + 1];
      const endIndex = next
        ? next.startIndex - next.title.length - next.level - 2
        : markdown.length;
      const content = markdown.slice(current.startIndex, endIndex).trim();
      const id = `design-${current.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;

      sections.push({
        id,
        title: current.title,
        content: content.slice(0, 500) + (content.length > 500 ? '...' : ''),
        level: current.level,
      });
    }

    return sections;
  }
}

// ─── Module Export ──────────────────────────────────────────────

/** Create and export the spec viewer panel module singleton. */
export function createSpecViewerPanel(): PanelModule {
  return new SpecViewerPanel();
}

/** Default export: a ready-to-use spec viewer panel instance. */
export const specViewerPanel: PanelModule = createSpecViewerPanel();

export default specViewerPanel;
