/**
 * Terminal panel module.
 * Implements the PanelModule interface for the application router.
 * Manages terminal sessions, xterm.js core, and IPC communication.
 */

import type { PanelModule } from '../../types';
import type { TerminalServiceEvent, TerminalSession } from './types';
import { TerminalCore } from './terminal-core';
import { TerminalService } from './terminal-service';

export type { TerminalSession, TerminalSessionId, TerminalConfig } from './types';

/**
 * Terminal panel implementing the PanelModule lifecycle.
 * Supports a single active terminal session with future multi-tab support.
 */
class TerminalPanel implements PanelModule {
  private container: HTMLElement | null = null;
  private terminalCore: TerminalCore;
  private terminalService: TerminalService;
  private unsubscribeService: (() => void) | null = null;
  private activeSession: TerminalSession | null = null;
  private toolbar: HTMLElement | null = null;
  private terminalContainer: HTMLElement | null = null;

  constructor() {
    this.terminalCore = new TerminalCore();
    this.terminalService = new TerminalService();
  }

  /** Mount the terminal panel into the given container element. */
  mount(container: HTMLElement): void {
    this.container = container;

    // Apply panel-level styles
    Object.assign(container.style, {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    });

    // Create toolbar
    this.toolbar = this.createToolbar();
    container.appendChild(this.toolbar);

    // Create terminal container
    this.terminalContainer = document.createElement('div');
    Object.assign(this.terminalContainer.style, {
      flex: '1',
      position: 'relative',
      overflow: 'hidden',
    });
    container.appendChild(this.terminalContainer);

    // Mount terminal core
    this.terminalCore.mount(this.terminalContainer);

    // Wire up terminal data to service (sends keystrokes to pty)
    this.terminalCore.onData((data) => {
      if (this.activeSession) {
        this.terminalService.write({
          sessionId: this.activeSession.id,
          data,
        });
      }
    });

    // Wire up terminal resize to service
    this.terminalCore.onResize((cols, rows) => {
      if (this.activeSession) {
        this.terminalService.resize({
          sessionId: this.activeSession.id,
          cols,
          rows,
        });
      }
    });

    // Start service and subscribe to events
    this.terminalService.start();
    this.unsubscribeService = this.terminalService.subscribe(this.handleServiceEvent);

    // Create initial terminal session
    this.createNewSession();
  }

  /** Unmount the terminal panel and clean up resources. */
  unmount(): void {
    if (this.unsubscribeService) {
      this.unsubscribeService();
      this.unsubscribeService = null;
    }
    this.terminalService.stop();
    this.terminalCore.unmount();

    // Destroy active session
    if (this.activeSession) {
      this.terminalService.destroySession(this.activeSession.id);
      this.activeSession = null;
    }

    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.toolbar = null;
    this.terminalContainer = null;
  }

  /** Called when the panel receives focus. */
  onFocus(): void {
    this.terminalCore.focus();
  }

  /** Called when the panel loses focus. */
  onBlur(): void {
    // No special cleanup needed.
  }

  /** Handle events from the terminal service. */
  private handleServiceEvent = (event: TerminalServiceEvent): void => {
    switch (event.type) {
      case 'data':
        if (this.activeSession && event.sessionId === this.activeSession.id) {
          this.terminalCore.write(event.data);
        }
        break;
      case 'exit':
        if (this.activeSession && event.sessionId === this.activeSession.id) {
          this.activeSession.status = 'exited';
          this.activeSession.exitCode = event.exitCode;
          this.terminalCore.write(`\r\n[Process exited with code ${event.exitCode}]\r\n`);
          this.updateToolbarStatus();
        }
        break;
      case 'error':
        if (this.activeSession && event.sessionId === this.activeSession.id) {
          this.activeSession.status = 'error';
          this.activeSession.error = event.error;
          this.terminalCore.write(`\r\n[Error: ${event.error}]\r\n`);
          this.updateToolbarStatus();
        }
        break;
    }
  };

  /** Create a new terminal session. */
  private async createNewSession(): Promise<void> {
    const response = await this.terminalService.createSession({});

    if (response.success && response.session) {
      this.activeSession = response.session;
      this.terminalCore.clear();
      this.updateToolbarStatus();

      // Send initial resize
      const dims = this.terminalCore.getDimensions();
      await this.terminalService.resize({
        sessionId: this.activeSession.id,
        cols: dims.cols,
        rows: dims.rows,
      });
    } else {
      this.terminalCore.write(`[Failed to create terminal session: ${response.error ?? 'unknown error'}]\r\n`);
    }
  }

  /** Create the terminal toolbar with controls. */
  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'terminal-panel__toolbar';
    Object.assign(toolbar.style, {
      display: 'flex',
      alignItems: 'center',
      padding: '4px 8px',
      gap: '8px',
      borderBottom: '1px solid var(--border-color, #333)',
      backgroundColor: 'var(--panel-header-bg, #252526)',
      minHeight: '32px',
    });

    // Status indicator
    const status = document.createElement('span');
    status.className = 'terminal-panel__status';
    status.textContent = 'Terminal';
    Object.assign(status.style, {
      fontSize: '12px',
      color: 'var(--text-secondary, #999)',
      flex: '1',
    });
    toolbar.appendChild(status);

    // New terminal button
    const newBtn = document.createElement('button');
    newBtn.textContent = '+';
    newBtn.title = 'New Terminal';
    newBtn.setAttribute('aria-label', 'New Terminal');
    Object.assign(newBtn.style, {
      background: 'none',
      border: '1px solid var(--border-color, #555)',
      color: 'var(--text-primary, #ccc)',
      borderRadius: '4px',
      padding: '2px 8px',
      cursor: 'pointer',
      fontSize: '14px',
    });
    newBtn.addEventListener('click', () => {
      this.createNewSession();
    });
    toolbar.appendChild(newBtn);

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '⌫';
    clearBtn.title = 'Clear Terminal';
    clearBtn.setAttribute('aria-label', 'Clear Terminal');
    Object.assign(clearBtn.style, {
      background: 'none',
      border: '1px solid var(--border-color, #555)',
      color: 'var(--text-primary, #ccc)',
      borderRadius: '4px',
      padding: '2px 8px',
      cursor: 'pointer',
      fontSize: '14px',
    });
    clearBtn.addEventListener('click', () => {
      this.terminalCore.clear();
    });
    toolbar.appendChild(clearBtn);

    return toolbar;
  }

  /** Update the toolbar status text. */
  private updateToolbarStatus(): void {
    if (!this.toolbar) return;
    const statusEl = this.toolbar.querySelector('.terminal-panel__status') as HTMLElement | null;
    if (!statusEl || !this.activeSession) return;

    const statusText = this.activeSession.status === 'running'
      ? `Terminal — ${this.activeSession.label}`
      : `Terminal — ${this.activeSession.status}`;
    statusEl.textContent = statusText;
  }
}

/** Create and export the terminal panel module singleton. */
export function createTerminalPanel(): PanelModule {
  return new TerminalPanel();
}

/** Default export: a ready-to-use terminal panel instance. */
export const terminalPanel: PanelModule = createTerminalPanel();
