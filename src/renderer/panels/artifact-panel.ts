/**
 * ArtifactPanel — Sidebar panel for browsing, previewing, and managing artifacts.
 *
 * Features:
 * - Sidebar listing artifacts grouped by session, sorted by creation time
 * - Type-based preview rendering (code with syntax highlighting, documents, diagrams)
 * - Version history display with diff comparison between checkpoints
 * - "Open in Editor" action for code-bundle type artifacts
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import type { Artifact, ArtifactType } from '../../shared/feature-integration-types.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

interface CheckpointSummary {
  id: string;
  artifactId: string;
  version: number;
  createdAt: string;
  hasDiff: boolean;
}

interface ArtifactGetResult {
  artifact: Artifact;
  content: string;
  version?: number;
}

interface DiffResult {
  diff: string;
  v1: number;
  v2: number;
}

type PanelView = 'list' | 'detail' | 'history' | 'diff';

// ─── Constants ──────────────────────────────────────────────────

const TYPE_ICONS: Record<ArtifactType, string> = {
  'code-bundle': '📦',
  'document': '📄',
  'spreadsheet-data': '📊',
  'diagram': '🗺️',
  'generated-app': '🚀',
};

const TYPE_LABELS: Record<ArtifactType, string> = {
  'code-bundle': 'Code Bundle',
  'document': 'Document',
  'spreadsheet-data': 'Spreadsheet',
  'diagram': 'Diagram',
  'generated-app': 'Generated App',
};

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function groupBySession(artifacts: Artifact[]): Map<string, Artifact[]> {
  const map = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    const group = map.get(a.sessionId) ?? [];
    group.push(a);
    map.set(a.sessionId, group);
  }
  return map;
}

// ─── ArtifactPanel ──────────────────────────────────────────────

export class ArtifactPanel {
  private container: HTMLElement;
  private projectDir: string;
  private currentView: PanelView = 'list';
  private selectedArtifact: Artifact | null = null;
  private artifacts: Artifact[] = [];
  private history: CheckpointSummary[] = [];

  constructor(container: HTMLElement, projectDir: string) {
    this.container = container;
    this.projectDir = projectDir;
  }

  /** Render the panel and load artifacts. */
  render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText =
      'display:flex;flex-direction:column;height:100%;font-family:var(--font-family,system-ui);';
    this.loadArtifacts();
  }

  /** Refresh the artifact list. */
  async loadArtifacts(): Promise<void> {
    this.currentView = 'list';
    this.selectedArtifact = null;

    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading artifacts…</div>';

    try {
      const result = await eapi().invoke('artifact:list', {
        projectDir: this.projectDir,
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.artifacts = (result as Artifact[]) ?? [];
      this.renderList();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── List View ──────────────────────────────────────────────

  private renderList(): void {
    this.container.innerHTML = '';

    // Header
    const header = this.createHeader('📂 Artifacts', [
      { label: '↻', title: 'Refresh', onClick: () => this.loadArtifacts() },
    ]);
    this.container.appendChild(header);

    // Empty state
    if (this.artifacts.length === 0) {
      this.container.appendChild(this.createEmptyState(
        'No artifacts yet. Artifacts will appear here when agents produce outputs.',
      ));
      return;
    }

    // Group by session and render
    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    const grouped = groupBySession(this.artifacts);

    for (const [sessionId, items] of grouped) {
      const sessionGroup = document.createElement('div');
      sessionGroup.style.cssText = 'margin-bottom:12px;';

      const sessionLabel = document.createElement('div');
      sessionLabel.style.cssText =
        'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);padding:4px 8px;font-weight:600;';
      sessionLabel.textContent = `Session ${sessionId.slice(0, 8)}…`;
      sessionGroup.appendChild(sessionLabel);

      for (const artifact of items) {
        sessionGroup.appendChild(this.createArtifactRow(artifact));
      }

      listContainer.appendChild(sessionGroup);
    }

    this.container.appendChild(listContainer);
  }

  private createArtifactRow(artifact: Artifact): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);margin-bottom:4px;cursor:pointer;transition:background 0.15s;';
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover,rgba(255,255,255,0.05))'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'var(--bg-input)'; });
    row.addEventListener('click', () => this.openDetail(artifact));

    // Type icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:16px;flex-shrink:0;';
    icon.textContent = TYPE_ICONS[artifact.type] ?? '📎';
    row.appendChild(icon);

    // Content area
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    title.textContent = artifact.title;
    content.appendChild(title);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
    meta.textContent = `${TYPE_LABELS[artifact.type]} · ${formatDate(artifact.createdAt)}`;
    content.appendChild(meta);

    row.appendChild(content);
    return row;
  }

  // ─── Detail View ────────────────────────────────────────────

  private async openDetail(artifact: Artifact): Promise<void> {
    this.selectedArtifact = artifact;
    this.currentView = 'detail';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading…</div>';

    try {
      const result = await eapi().invoke('artifact:get', {
        artifactId: artifact.id,
      }) as ArtifactGetResult | { error: true; message: string };

      if ('error' in result) {
        this.showError(result.message);
        return;
      }

      this.renderDetail(result.artifact, result.content);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderDetail(artifact: Artifact, content: string): void {
    this.container.innerHTML = '';

    // Header with back button and actions
    const actions: Array<{ label: string; title: string; onClick: () => void }> = [
      { label: '🕐', title: 'Version History', onClick: () => this.openHistory(artifact) },
      { label: '🗑️', title: 'Delete', onClick: () => this.confirmDelete(artifact) },
    ];

    // Add "Open in Editor" for code-bundle artifacts (Requirement 2.3)
    if (artifact.type === 'code-bundle') {
      actions.unshift({
        label: '✏️',
        title: 'Open in Editor',
        onClick: () => this.openInEditor(artifact),
      });
    }

    const header = this.createHeader(
      `${TYPE_ICONS[artifact.type] ?? '📎'} ${artifact.title}`,
      [{ label: '←', title: 'Back to list', onClick: () => this.loadArtifacts() }, ...actions],
    );
    this.container.appendChild(header);

    // Metadata bar
    const metaBar = document.createElement('div');
    metaBar.style.cssText = 'padding:8px 12px;font-size:11px;color:var(--text-dim);border-bottom:1px solid var(--border-color);';
    metaBar.textContent = `${TYPE_LABELS[artifact.type]} · Created ${formatDate(artifact.createdAt)} · Updated ${formatDate(artifact.updatedAt)}`;
    this.container.appendChild(metaBar);

    // Content preview area
    const previewArea = document.createElement('div');
    previewArea.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';
    previewArea.appendChild(this.renderPreview(artifact.type, content));
    this.container.appendChild(previewArea);
  }

  // ─── Type-Based Preview Rendering ─────────────────────────

  /**
   * Render artifact content based on type:
   * - code-bundle: syntax-highlighted code block
   * - document: formatted text
   * - diagram: rendered as image (base64) or Mermaid source
   * - spreadsheet-data: table format
   * - generated-app: code with file listing
   */
  private renderPreview(type: ArtifactType, content: string): HTMLElement {
    switch (type) {
      case 'code-bundle':
      case 'generated-app':
        return this.renderCodePreview(content);
      case 'document':
        return this.renderDocumentPreview(content);
      case 'diagram':
        return this.renderDiagramPreview(content);
      case 'spreadsheet-data':
        return this.renderSpreadsheetPreview(content);
      default:
        return this.renderCodePreview(content);
    }
  }

  private renderCodePreview(content: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;';

    const pre = document.createElement('pre');
    pre.style.cssText =
      'background:var(--bg-code,#1e1e1e);color:var(--text-code,#d4d4d4);padding:12px;border-radius:6px;font-size:12px;font-family:var(--font-mono,"Fira Code",monospace);overflow-x:auto;white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:500px;overflow-y:auto;';

    const code = document.createElement('code');
    code.textContent = content;
    pre.appendChild(code);
    wrapper.appendChild(pre);

    return wrapper;
  }

  private renderDocumentPreview(content: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'padding:12px;background:var(--bg-input);border-radius:6px;font-size:13px;line-height:1.6;color:var(--text-primary);white-space:pre-wrap;word-break:break-word;max-height:500px;overflow-y:auto;';
    wrapper.textContent = content;
    return wrapper;
  }

  private renderDiagramPreview(content: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'text-align:center;padding:12px;';

    // Check if content is base64 image data
    if (content.startsWith('data:image') || content.startsWith('iVBOR') || content.startsWith('/9j/')) {
      const img = document.createElement('img');
      img.src = content.startsWith('data:') ? content : `data:image/png;base64,${content}`;
      img.style.cssText = 'max-width:100%;max-height:400px;border-radius:6px;border:1px solid var(--border-color);';
      img.alt = 'Diagram';
      wrapper.appendChild(img);
    } else {
      // Render as Mermaid source code
      const label = document.createElement('div');
      label.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;';
      label.textContent = 'Mermaid / PlantUML source:';
      wrapper.appendChild(label);
      wrapper.appendChild(this.renderCodePreview(content));
    }

    return wrapper;
  }

  private renderSpreadsheetPreview(content: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'overflow-x:auto;';

    try {
      const data = JSON.parse(content);
      if (Array.isArray(data) && data.length > 0) {
        const table = document.createElement('table');
        table.style.cssText =
          'border-collapse:collapse;width:100%;font-size:11px;background:var(--bg-input);border-radius:6px;overflow:hidden;';

        // Header row from first object keys
        const keys = Object.keys(data[0]);
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const key of keys) {
          const th = document.createElement('th');
          th.style.cssText = 'padding:6px 8px;text-align:left;border-bottom:1px solid var(--border-color);font-weight:600;color:var(--text-primary);background:var(--bg-hover);';
          th.textContent = key;
          headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Data rows
        const tbody = document.createElement('tbody');
        for (const row of data.slice(0, 50)) {
          const tr = document.createElement('tr');
          for (const key of keys) {
            const td = document.createElement('td');
            td.style.cssText = 'padding:4px 8px;border-bottom:1px solid var(--border-color);color:var(--text-secondary);';
            td.textContent = String(row[key] ?? '');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrapper.appendChild(table);

        if (data.length > 50) {
          const more = document.createElement('div');
          more.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px;text-align:center;';
          more.textContent = `Showing 50 of ${data.length} rows`;
          wrapper.appendChild(more);
        }
      } else {
        wrapper.appendChild(this.renderCodePreview(content));
      }
    } catch {
      // If not valid JSON, render as code
      wrapper.appendChild(this.renderCodePreview(content));
    }

    return wrapper;
  }

  // ─── Version History View ─────────────────────────────────

  private async openHistory(artifact: Artifact): Promise<void> {
    this.currentView = 'history';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading history…</div>';

    try {
      const result = await eapi().invoke('artifact:history', {
        artifactId: artifact.id,
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.history = (result as CheckpointSummary[]) ?? [];
      this.renderHistory(artifact);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderHistory(artifact: Artifact): void {
    this.container.innerHTML = '';

    const header = this.createHeader(
      `🕐 History: ${artifact.title}`,
      [{ label: '←', title: 'Back to detail', onClick: () => this.openDetail(artifact) }],
    );
    this.container.appendChild(header);

    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    if (this.history.length === 0) {
      listContainer.appendChild(this.createEmptyState('No version history available.'));
      this.container.appendChild(listContainer);
      return;
    }

    // Render checkpoints in reverse (newest first)
    const reversed = [...this.history].reverse();
    for (let i = 0; i < reversed.length; i++) {
      const cp = reversed[i];
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);margin-bottom:4px;';

      // Version badge
      const badge = document.createElement('span');
      badge.style.cssText =
        'font-size:11px;font-weight:700;background:var(--accent,#3b82f6);color:white;border-radius:4px;padding:2px 6px;flex-shrink:0;';
      badge.textContent = `v${cp.version}`;
      row.appendChild(badge);

      // Info
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;';
      const dateEl = document.createElement('div');
      dateEl.style.cssText = 'font-size:11px;color:var(--text-secondary);';
      dateEl.textContent = formatDate(cp.createdAt);
      info.appendChild(dateEl);
      row.appendChild(info);

      // Diff button (only if not the first version and there's a previous)
      if (cp.version > 1) {
        const diffBtn = document.createElement('button');
        diffBtn.textContent = 'Diff';
        diffBtn.title = `Compare v${cp.version - 1} → v${cp.version}`;
        diffBtn.style.cssText =
          'font-size:10px;padding:3px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;';
        diffBtn.addEventListener('click', () => this.openDiff(artifact, cp.version - 1, cp.version));
        row.appendChild(diffBtn);
      }

      listContainer.appendChild(row);
    }

    this.container.appendChild(listContainer);
  }

  // ─── Diff Comparison View ─────────────────────────────────

  private async openDiff(artifact: Artifact, v1: number, v2: number): Promise<void> {
    this.currentView = 'diff';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Computing diff…</div>';

    try {
      const result = await eapi().invoke('artifact:diff', {
        artifactId: artifact.id,
        v1,
        v2,
      }) as DiffResult | { error: true; message: string };

      if ('error' in result) {
        this.showError(result.message);
        return;
      }

      this.renderDiff(artifact, result);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderDiff(artifact: Artifact, result: DiffResult): void {
    this.container.innerHTML = '';

    const header = this.createHeader(
      `📝 Diff: v${result.v1} → v${result.v2}`,
      [{ label: '←', title: 'Back to history', onClick: () => this.openHistory(artifact) }],
    );
    this.container.appendChild(header);

    const diffContainer = document.createElement('div');
    diffContainer.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    if (!result.diff || result.diff.trim() === '') {
      diffContainer.appendChild(
        this.createEmptyState('No differences between these versions.'),
      );
    } else {
      diffContainer.appendChild(this.renderDiffContent(result.diff));
    }

    this.container.appendChild(diffContainer);
  }

  private renderDiffContent(diff: string): HTMLElement {
    const pre = document.createElement('pre');
    pre.style.cssText =
      'background:var(--bg-code,#1e1e1e);padding:12px;border-radius:6px;font-size:11px;font-family:var(--font-mono,"Fira Code",monospace);overflow-x:auto;line-height:1.6;';

    const lines = diff.split('\n');
    for (const line of lines) {
      const span = document.createElement('span');
      span.style.cssText = 'display:block;padding:0 4px;';

      if (line.startsWith('+') && !line.startsWith('+++')) {
        span.style.background = 'rgba(46, 160, 67, 0.15)';
        span.style.color = '#3fb950';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        span.style.background = 'rgba(248, 81, 73, 0.15)';
        span.style.color = '#f85149';
      } else if (line.startsWith('@@')) {
        span.style.color = '#a5d6ff';
      } else {
        span.style.color = 'var(--text-code,#d4d4d4)';
      }

      span.textContent = line;
      pre.appendChild(span);
    }

    return pre;
  }

  // ─── Actions ──────────────────────────────────────────────

  /**
   * Open code-bundle artifact in the Monaco editor.
   * Requirement 2.3: "Open in Editor" action for code-bundle artifacts.
   */
  private async openInEditor(artifact: Artifact): Promise<void> {
    try {
      await eapi().invoke('editor:open-artifact', { artifactId: artifact.id });
    } catch (err: unknown) {
      console.error('[ArtifactPanel] Failed to open in editor:', err);
    }
  }

  /**
   * Confirm and delete an artifact.
   * Requirement 2.4: Deletion with confirmation prompt.
   */
  private async confirmDelete(artifact: Artifact): Promise<void> {
    const confirmed = window.confirm(
      `Delete artifact "${artifact.title}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const result = await eapi().invoke('artifact:delete', {
        artifactId: artifact.id,
      }) as { success: boolean } | { error: true; message: string };

      if ('error' in result) {
        this.showError(result.message);
        return;
      }

      // Return to list and refresh
      await this.loadArtifacts();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
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

    const header = this.createHeader('📂 Artifacts', [
      { label: '↻', title: 'Retry', onClick: () => this.loadArtifacts() },
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
    this.container.innerHTML = '';
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the artifact panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderArtifactPanel(
  container: HTMLElement,
  projectDir: string,
): ArtifactPanel {
  const panel = new ArtifactPanel(container, projectDir);
  panel.render();
  return panel;
}
