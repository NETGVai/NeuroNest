/**
 * ExecutionModePanel — execution mode selector and IM task notification display.
 *
 * Reads current mode via `get-execution-mode` channel.
 * Displays incoming IM task notifications via `im-task-received` channel.
 *
 * Requirements: 3.2, 5.2
 */

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

type ExecutionMode = 'flash' | 'standard' | 'pro' | 'ultra';

interface ModeConfig {
  mode: ExecutionMode;
  tokenBudget: number;
}

interface IMTaskNotification {
  channelId: string;
  platform: string;
  from: string;
  content: string;
  threadId?: string;
}

const MODE_INFO: Record<ExecutionMode, { icon: string; label: string; description: string; color: string }> = {
  flash:    { icon: '⚡', label: 'Flash',    description: 'Single-pass, one agent',           color: 'var(--yellow,#f59e0b)' },
  standard: { icon: '🔹', label: 'Standard', description: 'Planning + single agent',          color: 'var(--accent,#3b82f6)' },
  pro:      { icon: '🔷', label: 'Pro',      description: 'Planning + sequential multi-agent', color: 'var(--purple,#8b5cf6)' },
  ultra:    { icon: '🚀', label: 'Ultra',    description: 'Parallel sub-task decomposition',   color: 'var(--green,#22c55e)' },
};

// ─── ExecutionModePanel ─────────────────────────────────────────

export class ExecutionModePanel {
  private container: HTMLElement;
  private selectorEl: HTMLElement | null = null;
  private notificationsEl: HTMLElement | null = null;
  private imHandler: ((...args: unknown[]) => void) | null = null;
  private currentMode: ExecutionMode = 'standard';
  private onModeChange: ((mode: ExecutionMode) => void) | null = null;

  constructor(container: HTMLElement, onModeChange?: (mode: ExecutionMode) => void) {
    this.container = container;
    this.onModeChange = onModeChange ?? null;
  }

  /** Render the panel and load current mode. */
  render(): void {
    this.container.innerHTML = '';

    // Mode selector section
    const modeSection = document.createElement('div');
    modeSection.style.cssText = 'margin-bottom:16px;';

    const modeHeader = document.createElement('div');
    modeHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;';
    modeHeader.textContent = '⚙️ Execution Mode';
    modeSection.appendChild(modeHeader);

    this.selectorEl = document.createElement('div');
    this.selectorEl.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;';
    modeSection.appendChild(this.selectorEl);

    this.container.appendChild(modeSection);

    // IM notifications section
    const imSection = document.createElement('div');

    const imHeader = document.createElement('div');
    imHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;';
    imHeader.textContent = '💬 IM Task Notifications';
    imSection.appendChild(imHeader);

    this.notificationsEl = document.createElement('div');
    this.notificationsEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;';
    this.notificationsEl.innerHTML =
      '<div style="text-align:center;padding:12px;color:var(--text-dim);font-size:11px;">No incoming tasks.</div>';
    imSection.appendChild(this.notificationsEl);

    this.container.appendChild(imSection);

    // Load current mode and render buttons
    this.loadCurrentMode();

    // Listen for IM task notifications
    this.cleanupListener();
    this.imHandler = (...args: unknown[]) => {
      const task = args[0] as IMTaskNotification;
      if (task) this.addNotification(task);
    };
    eapi().on('im-task-received', this.imHandler);
  }

  // ─── Mode selector ─────────────────────────────────────────

  private async loadCurrentMode(): Promise<void> {
    try {
      const info = await eapi().invoke('get-execution-mode') as ModeConfig;
      if (info && info.mode) {
        this.currentMode = info.mode;
      }
    } catch {
      // Default to standard
    }
    this.renderModeButtons();
  }

  private renderModeButtons(): void {
    if (!this.selectorEl) return;
    this.selectorEl.innerHTML = '';

    const modes: ExecutionMode[] = ['flash', 'standard', 'pro', 'ultra'];

    for (const mode of modes) {
      const info = MODE_INFO[mode];
      const isActive = mode === this.currentMode;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(isActive));
      btn.setAttribute('aria-label', `${info.label} mode: ${info.description}`);
      btn.style.cssText = [
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'gap:2px',
        'padding:8px',
        'border-radius:8px',
        'cursor:pointer',
        'font-size:11px',
        'transition:all 0.15s',
        `border:2px solid ${isActive ? info.color : 'var(--border-color)'}`,
        `background:${isActive ? info.color + '15' : 'var(--bg-input)'}`,
        `color:${isActive ? info.color : 'var(--text-secondary)'}`,
      ].join(';');

      btn.innerHTML =
        `<span style="font-size:18px;">${info.icon}</span>` +
        `<span style="font-weight:${isActive ? '700' : '500'};">${info.label}</span>`;

      btn.addEventListener('click', () => this.selectMode(mode));
      this.selectorEl.appendChild(btn);
    }
  }

  private selectMode(mode: ExecutionMode): void {
    this.currentMode = mode;
    this.renderModeButtons();
    this.onModeChange?.(mode);
  }

  // ─── IM notifications ──────────────────────────────────────

  private addNotification(task: IMTaskNotification): void {
    if (!this.notificationsEl) return;

    // Clear empty state
    const emptyState = this.notificationsEl.querySelector('div[style*="text-align:center"]');
    if (emptyState) emptyState.remove();

    const platformIcons: Record<string, string> = {
      telegram: '📱',
      slack: '💼',
      discord: '🎮',
    };

    const notification = document.createElement('div');
    notification.style.cssText = 'padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);animation:fadeIn 0.2s;';
    notification.innerHTML =
      `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">` +
      `<span>${platformIcons[task.platform] ?? '💬'}</span>` +
      `<span style="font-weight:600;">${escHtml(task.from)}</span>` +
      `<span>via ${escHtml(task.platform)}</span>` +
      `</div>` +
      `<div style="font-size:12px;color:var(--text-primary);line-height:1.3;">${escHtml(task.content.slice(0, 200))}</div>`;

    // Prepend (newest first)
    this.notificationsEl.prepend(notification);

    // Keep max 10 notifications
    while (this.notificationsEl.children.length > 10) {
      this.notificationsEl.lastChild?.remove();
    }
  }

  private cleanupListener(): void {
    if (this.imHandler) {
      eapi().removeListener('im-task-received', this.imHandler);
      this.imHandler = null;
    }
  }

  destroy(): void {
    this.cleanupListener();
  }
}

// ─── Convenience export ─────────────────────────────────────────

export function renderExecutionModePanel(
  container: HTMLElement,
  onModeChange?: (mode: ExecutionMode) => void,
): ExecutionModePanel {
  const panel = new ExecutionModePanel(container, onModeChange);
  panel.render();
  return panel;
}
