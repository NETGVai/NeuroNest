/**
 * ModeToggle — Renderer UI component for switching between Autopilot and Supervised execution modes.
 *
 * - Autopilot: agent executes all tool calls without pausing
 * - Supervised: agent pauses after each turn with file edits, presenting hunks for accept/reject/discuss
 * - Supports mid-execution mode switching without state loss
 *
 * Feature gate: production_ux_execution_modes
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */

// ─── Types ──────────────────────────────────────────────────────

export type ExecutionModeType = 'autopilot' | 'supervised';

export interface ModeToggleOptions {
  /** Initial mode. Defaults to 'autopilot' */
  initialMode?: ExecutionModeType;
  /** Callback fired when user toggles the mode */
  onModeChange?: (mode: ExecutionModeType) => void;
  /** Whether the toggle is enabled (feature-gated) */
  enabled?: boolean;
}

interface ElectronAPI {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): void;
  removeListener(channel: string, callback: (...args: unknown[]) => void): void;
}

// ─── Helpers ────────────────────────────────────────────────────

function getElectronAPI(): ElectronAPI {
  return (window as any).electronAPI;
}

// ─── ModeToggle Component ───────────────────────────────────────

export class ModeToggle {
  private container: HTMLElement;
  private currentMode: ExecutionModeType;
  private onModeChange: ((mode: ExecutionModeType) => void) | null;
  private enabled: boolean;
  private toggleEl: HTMLElement | null = null;

  constructor(container: HTMLElement, options: ModeToggleOptions = {}) {
    this.container = container;
    this.currentMode = options.initialMode ?? 'autopilot';
    this.onModeChange = options.onModeChange ?? null;
    this.enabled = options.enabled ?? true;
  }

  /**
   * Render the mode toggle into the container.
   */
  render(): void {
    if (!this.enabled) {
      this.container.innerHTML = '';
      return;
    }

    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'mode-toggle-wrapper';
    wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';

    // Label
    const label = document.createElement('span');
    label.className = 'mode-toggle-label';
    label.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary,#888);text-transform:uppercase;letter-spacing:0.5px;';
    label.textContent = 'Mode';
    wrapper.appendChild(label);

    // Toggle container (pill switch)
    this.toggleEl = document.createElement('div');
    this.toggleEl.className = 'mode-toggle-switch';
    this.toggleEl.setAttribute('role', 'radiogroup');
    this.toggleEl.setAttribute('aria-label', 'Execution mode toggle');
    this.toggleEl.style.cssText = [
      'display:inline-flex',
      'border-radius:6px',
      'overflow:hidden',
      'border:1px solid var(--border-color,#333)',
      'background:var(--bg-input,#1a1a1a)',
    ].join(';');

    // Autopilot button
    const autopilotBtn = this.createModeButton('autopilot', '⚡', 'Autopilot');
    this.toggleEl.appendChild(autopilotBtn);

    // Supervised button
    const supervisedBtn = this.createModeButton('supervised', '👁', 'Supervised');
    this.toggleEl.appendChild(supervisedBtn);

    wrapper.appendChild(this.toggleEl);
    this.container.appendChild(wrapper);

    this.updateButtonStates();
  }

  /**
   * Get the current mode.
   */
  getMode(): ExecutionModeType {
    return this.currentMode;
  }

  /**
   * Set the mode programmatically (e.g. syncing from backend state).
   */
  setMode(mode: ExecutionModeType): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.updateButtonStates();
  }

  /**
   * Enable or disable the toggle.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.container.innerHTML = '';
      this.toggleEl = null;
    } else if (!this.toggleEl) {
      this.render();
    }
  }

  /**
   * Clean up event listeners.
   */
  destroy(): void {
    this.container.innerHTML = '';
    this.toggleEl = null;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private createModeButton(mode: ExecutionModeType, icon: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mode-toggle-btn mode-toggle-btn--${mode}`;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(mode === this.currentMode));
    btn.setAttribute('aria-label', `${label} mode`);
    btn.setAttribute('data-mode', mode);
    btn.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:4px',
      'padding:4px 10px',
      'border:none',
      'cursor:pointer',
      'font-size:11px',
      'font-weight:500',
      'transition:all 0.15s ease',
      'outline:none',
    ].join(';');

    btn.innerHTML = `<span style="font-size:13px;">${icon}</span><span>${label}</span>`;

    btn.addEventListener('click', () => this.handleModeSelect(mode));
    return btn;
  }

  private handleModeSelect(mode: ExecutionModeType): void {
    if (mode === this.currentMode) return;

    this.currentMode = mode;
    this.updateButtonStates();

    // Notify the main process via IPC
    try {
      getElectronAPI().send('agent:switch-mode', mode);
    } catch {
      // IPC may not be available in tests
    }

    // Fire the callback
    this.onModeChange?.(mode);
  }

  private updateButtonStates(): void {
    if (!this.toggleEl) return;

    const buttons = this.toggleEl.querySelectorAll('.mode-toggle-btn');
    buttons.forEach((btn) => {
      const buttonEl = btn as HTMLButtonElement;
      const mode = buttonEl.getAttribute('data-mode') as ExecutionModeType;
      const isActive = mode === this.currentMode;

      buttonEl.setAttribute('aria-checked', String(isActive));

      if (isActive) {
        buttonEl.style.background = mode === 'autopilot'
          ? 'var(--green,#22c55e)20'
          : 'var(--yellow,#f59e0b)20';
        buttonEl.style.color = mode === 'autopilot'
          ? 'var(--green,#22c55e)'
          : 'var(--yellow,#f59e0b)';
        buttonEl.style.fontWeight = '700';
      } else {
        buttonEl.style.background = 'transparent';
        buttonEl.style.color = 'var(--text-secondary,#888)';
        buttonEl.style.fontWeight = '500';
      }
    });
  }
}

// ─── Factory function ───────────────────────────────────────────

/**
 * Create and render a ModeToggle component.
 */
export function createModeToggle(container: HTMLElement, options?: ModeToggleOptions): ModeToggle {
  const toggle = new ModeToggle(container, options);
  toggle.render();
  return toggle;
}
