/**
 * FocusModePanel — Renderer component for Agent Focus Mode.
 *
 * Provides a full-width layout with chat, progress panel, and change summary
 * (no code editor pane). Includes a visible toggle button and supports
 * split-view with file tree on one side.
 *
 * Feature-gated via `production_ux_focus_mode`.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5
 */

import {
  type FocusModeState,
  type FocusModeEvent,
  type FilePreview,
  type ProgressPanelState,
  INITIAL_FOCUS_MODE_STATE,
  focusModeReducer,
  computeLayout,
  shouldShowFilePreview,
} from '../focus-mode-state.js';

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

function shortPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 3
    ? `.../${parts.slice(-3).join('/')}`
    : filePath;
}

function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

// ─── FocusModePanel ─────────────────────────────────────────────

export class FocusModePanel {
  private container: HTMLElement;
  private state: FocusModeState;
  private toggleButton: HTMLElement | null = null;
  private layoutContainer: HTMLElement | null = null;
  private chatContainer: HTMLElement | null = null;
  private fileTreeContainer: HTMLElement | null = null;
  private progressContainer: HTMLElement | null = null;
  private changeSummaryContainer: HTMLElement | null = null;
  private filePreviews: FilePreview[] = [];
  private fileChangeListener: ((...args: unknown[]) => void) | null = null;
  private enabled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = { ...INITIAL_FOCUS_MODE_STATE };
  }

  /**
   * Initialize the panel: check feature gate, render toggle, set up IPC.
   */
  async init(): Promise<void> {
    this.enabled = await this.checkFeatureGate();
    if (!this.enabled) return;

    this.setupIPCListeners();
    this.renderToggleButton();
    this.applyLayout();
  }

  /**
   * Get the current focus mode state (for external consumers / tests).
   */
  getState(): FocusModeState {
    return { ...this.state };
  }

  /**
   * Check if focus mode is currently active.
   */
  isActive(): boolean {
    return this.state.active;
  }

  /**
   * Toggle focus mode on/off.
   * Preserves chat scroll position and progress panel state.
   *
   * Requirement 20.2: Visible toggle between Focus Mode and Editor View.
   * Requirement 20.5: Preserve chat scroll position and progress panel state.
   */
  toggle(): void {
    if (!this.enabled) return;

    // Save current scroll position before switching
    this.saveScrollPosition();

    this.dispatch({ type: 'toggle' });
    this.applyLayout();
    this.renderToggleButton();

    // Restore scroll position after layout change
    this.restoreScrollPosition();

    // Notify main process
    eapi().invoke('focus-mode:toggle').catch(() => {
      // Non-critical — continue without IPC confirmation
    });
  }

  /**
   * Toggle split-view (file tree visible on one side).
   *
   * Requirement 20.4: Split-view with file tree visible on one side.
   */
  toggleSplitView(): void {
    if (!this.enabled || !this.state.active) return;

    this.dispatch({ type: 'toggle_split_view' });
    this.applyLayout();
  }

  /**
   * Add an inline file preview to the chat area.
   *
   * Requirement 20.3: Inline file previews within chat when agent
   * references or modifies files.
   */
  addFilePreview(preview: FilePreview): void {
    if (!this.state.active) return;
    if (!shouldShowFilePreview(this.state.active, preview.filePath)) return;

    this.filePreviews.push(preview);
    this.renderFilePreview(preview);
  }

  /**
   * Update progress panel state (called from external progress events).
   */
  updateProgressState(progressState: ProgressPanelState): void {
    this.dispatch({ type: 'update_progress', progressState });
  }

  /**
   * Clean up IPC listeners on destroy.
   */
  destroy(): void {
    if (this.fileChangeListener) {
      eapi().removeListener('agent:file-change', this.fileChangeListener);
      this.fileChangeListener = null;
    }
  }

  // ─── Internal Methods ───────────────────────────────────────────

  private dispatch(event: FocusModeEvent): void {
    this.state = focusModeReducer(this.state, event);
  }

  private async checkFeatureGate(): Promise<boolean> {
    try {
      const config = await eapi().invoke('get-config') as Record<string, unknown>;
      if (config && typeof config === 'object') {
        return (config as any).production_ux_focus_mode === true;
      }
    } catch {
      // Feature not available — disabled
    }
    return false;
  }

  /**
   * Render the toggle button.
   *
   * Requirement 20.2: A visible toggle button between Focus Mode and Editor View.
   */
  private renderToggleButton(): void {
    if (this.toggleButton) {
      this.toggleButton.remove();
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'focus-mode-toggle';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', String(this.state.active));
    btn.setAttribute('aria-label', this.state.active
      ? 'Switch to Editor View'
      : 'Switch to Focus Mode');

    btn.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:60px',
      'z-index:1000',
      'display:flex',
      'align-items:center',
      'gap:6px',
      'padding:6px 12px',
      'border-radius:6px',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'transition:all 0.15s',
      `border:1px solid ${this.state.active ? 'var(--accent,#3b82f6)' : 'var(--border-color)'}`,
      `background:${this.state.active ? 'var(--accent,#3b82f6)' : 'var(--bg-input)'}`,
      `color:${this.state.active ? '#fff' : 'var(--text-secondary)'}`,
    ].join(';');

    const icon = document.createElement('span');
    icon.textContent = this.state.active ? '📋' : '🎯';
    btn.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = this.state.active ? 'Editor View' : 'Focus Mode';
    btn.appendChild(label);

    // Split-view sub-toggle (only visible in focus mode)
    if (this.state.active) {
      const splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.className = 'focus-mode-split-toggle';
      splitBtn.setAttribute('aria-label', this.state.splitView
        ? 'Hide file tree'
        : 'Show file tree');
      splitBtn.style.cssText = [
        'margin-left:6px',
        'padding:2px 6px',
        'border-radius:4px',
        'font-size:10px',
        'cursor:pointer',
        'border:1px solid rgba(255,255,255,0.3)',
        'background:transparent',
        'color:inherit',
      ].join(';');
      splitBtn.textContent = this.state.splitView ? '◧' : '▣';
      splitBtn.title = this.state.splitView ? 'Hide file tree' : 'Show file tree';
      splitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleSplitView();
      });
      btn.appendChild(splitBtn);
    }

    btn.addEventListener('click', () => this.toggle());

    this.container.appendChild(btn);
    this.toggleButton = btn;
  }

  /**
   * Apply the layout configuration to the DOM.
   *
   * Requirement 20.1: Full-width layout with chat, progress panel,
   * and change summary (no code editor pane).
   */
  private applyLayout(): void {
    const layout = computeLayout(this.state);

    // Apply layout class to the main container
    const appRoot = document.getElementById('app') ?? document.body;
    appRoot.classList.remove('layout-editor-view', 'layout-focus-full', 'layout-focus-split');
    appRoot.classList.add(layout.containerClass);

    // Show/hide editor pane
    const editorPane = document.querySelector('.editor-pane') as HTMLElement | null;
    if (editorPane) {
      editorPane.style.display = layout.showEditor ? '' : 'none';
    }

    // Show/hide file tree
    const fileTree = document.querySelector('.file-tree') as HTMLElement | null;
    if (fileTree) {
      fileTree.style.display = layout.showFileTree ? '' : 'none';
    }

    // Show/hide progress panel
    const progressPanel = document.querySelector('.progress-panel') as HTMLElement | null;
    if (progressPanel) {
      progressPanel.style.display = layout.showProgressPanel ? '' : 'none';
    }

    // Show/hide change summary
    const changeSummary = document.querySelector('.change-summary-panel') as HTMLElement | null;
    if (changeSummary) {
      changeSummary.style.display = layout.showChangeSummary ? '' : 'none';
    }

    // Expand chat to full width when in focus mode
    const chatPanel = document.querySelector('.chat-panel') as HTMLElement | null;
    if (chatPanel) {
      if (this.state.active) {
        chatPanel.style.flex = '1';
        chatPanel.style.maxWidth = 'none';
      } else {
        chatPanel.style.flex = '';
        chatPanel.style.maxWidth = '';
      }
    }
  }

  /**
   * Save the current chat scroll position.
   *
   * Requirement 20.5: Preserve chat scroll position on mode switch.
   */
  private saveScrollPosition(): void {
    const chatScroll = document.querySelector('.chat-messages') as HTMLElement | null;
    if (chatScroll) {
      this.dispatch({ type: 'save_scroll_position', position: chatScroll.scrollTop });
    }
  }

  /**
   * Restore the chat scroll position after a mode switch.
   *
   * Requirement 20.5: Preserve chat scroll position on mode switch.
   */
  private restoreScrollPosition(): void {
    const chatScroll = document.querySelector('.chat-messages') as HTMLElement | null;
    if (chatScroll && this.state.chatScrollPosition > 0) {
      // Use requestAnimationFrame to ensure DOM has updated before scrolling
      requestAnimationFrame(() => {
        chatScroll.scrollTop = this.state.chatScrollPosition;
      });
    }
  }

  /**
   * Render an inline file preview within the chat area.
   *
   * Requirement 20.3: Display inline file previews within chat
   * when agent references or modifies files.
   */
  private renderFilePreview(preview: FilePreview): void {
    const chatMessages = document.querySelector('.chat-messages') as HTMLElement | null;
    if (!chatMessages) return;

    const previewEl = document.createElement('div');
    previewEl.className = 'focus-mode-file-preview';
    previewEl.setAttribute('role', 'article');
    previewEl.setAttribute('aria-label', `File preview: ${preview.filePath}`);
    previewEl.style.cssText = [
      'margin:8px 0',
      'border:1px solid var(--border-color)',
      'border-radius:6px',
      'overflow:hidden',
      'font-size:12px',
    ].join(';');

    // Header with file path and operation badge
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:6px 10px',
      'background:var(--bg-hover,rgba(128,128,128,0.05))',
      'border-bottom:1px solid var(--border-color)',
    ].join(';');

    const operationColors: Record<string, string> = {
      created: 'var(--green,#22c55e)',
      modified: 'var(--accent,#3b82f6)',
      deleted: 'var(--red,#ef4444)',
      referenced: 'var(--text-dim)',
    };

    const badge = document.createElement('span');
    badge.style.cssText = `font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600;color:${operationColors[preview.operation] ?? 'var(--text-dim)'};background:${operationColors[preview.operation] ?? 'var(--text-dim)'}15;`;
    badge.textContent = preview.operation.toUpperCase();
    header.appendChild(badge);

    const pathLabel = document.createElement('span');
    pathLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono,monospace);font-size:11px;color:var(--text-secondary);';
    pathLabel.title = preview.filePath;
    pathLabel.textContent = shortPath(preview.filePath);
    header.appendChild(pathLabel);

    const ext = document.createElement('span');
    ext.style.cssText = 'font-size:10px;color:var(--text-dim);';
    ext.textContent = getFileExtension(preview.filePath);
    header.appendChild(ext);

    previewEl.appendChild(header);

    // Content area with code preview
    if (preview.content) {
      const content = document.createElement('pre');
      content.style.cssText = [
        'margin:0',
        'padding:8px 10px',
        'max-height:200px',
        'overflow:auto',
        'font-family:var(--font-mono,monospace)',
        'font-size:11px',
        'line-height:1.4',
        'color:var(--text-primary)',
        'background:var(--bg-input)',
        'white-space:pre-wrap',
        'word-break:break-all',
      ].join(';');

      // Truncate long content
      const maxChars = 2000;
      const displayContent = preview.content.length > maxChars
        ? preview.content.slice(0, maxChars) + '\n... (truncated)'
        : preview.content;

      content.textContent = displayContent;
      previewEl.appendChild(content);
    }

    chatMessages.appendChild(previewEl);
  }

  /**
   * Set up IPC listeners for file change events.
   * When files are referenced/modified, display inline previews in focus mode.
   */
  private setupIPCListeners(): void {
    this.fileChangeListener = (...args: unknown[]) => {
      if (!this.state.active) return;

      const event = args[0] as { type: string; filePath: string } | undefined;
      if (!event || !event.filePath) return;

      // Create a preview from the file change event
      const preview: FilePreview = {
        filePath: event.filePath,
        language: getFileExtension(event.filePath),
        content: '', // Content loaded on demand
        operation: (event.type as FilePreview['operation']) ?? 'referenced',
      };

      this.addFilePreview(preview);
    };

    eapi().on('agent:file-change', this.fileChangeListener);
  }
}

// ─── Convenience Export ─────────────────────────────────────────

/**
 * Create and initialize a FocusModePanel in the given container.
 * Feature-gated: returns the panel but it may be disabled if the gate is off.
 */
export async function createFocusModePanel(container: HTMLElement): Promise<FocusModePanel> {
  const panel = new FocusModePanel(container);
  await panel.init();
  return panel;
}
