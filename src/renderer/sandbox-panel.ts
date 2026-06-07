/**
 * SandboxPanel — streams sandbox execution output in real-time.
 *
 * Listens to `sandbox-output` channel for streaming output.
 * Displays session status and output files after completion.
 *
 * Requirements: 9.1, 9.5
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

type SessionStatus = 'running' | 'completed' | 'timed_out' | 'error';

interface SandboxOutputEvent {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'status' | 'files';
  content?: string;
  status?: SessionStatus;
  files?: string[];
}

const STATUS_CONFIG: Record<SessionStatus, { icon: string; color: string; label: string }> = {
  running:    { icon: '⏳', color: 'var(--accent,#3b82f6)', label: 'Running' },
  completed:  { icon: '✓',  color: 'var(--green,#22c55e)',  label: 'Completed' },
  timed_out:  { icon: '⏱',  color: 'var(--yellow,#f59e0b)', label: 'Timed Out' },
  error:      { icon: '✗',  color: 'var(--red,#ef4444)',    label: 'Error' },
};

// ─── SandboxPanel ───────────────────────────────────────────────

export class SandboxPanel {
  private container: HTMLElement;
  private outputEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private filesEl: HTMLElement | null = null;
  private outputHandler: ((...args: unknown[]) => void) | null = null;
  private currentStatus: SessionStatus = 'running';

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the panel shell and start listening for output. */
  render(): void {
    this.container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    header.innerHTML = '<h3 style="margin:0;">📦 Sandbox Output</h3>';
    this.container.appendChild(header);

    // Status badge
    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = 'margin-bottom:8px;';
    this.updateStatusBadge('running');
    this.container.appendChild(this.statusEl);

    // Output terminal
    this.outputEl = document.createElement('pre');
    this.outputEl.style.cssText = [
      'background:var(--bg-terminal,#1e1e1e)',
      'color:var(--text-terminal,#d4d4d4)',
      'padding:12px',
      'border-radius:8px',
      'font-family:monospace',
      'font-size:11px',
      'line-height:1.5',
      'max-height:300px',
      'overflow-y:auto',
      'white-space:pre-wrap',
      'word-break:break-all',
      'margin:0',
    ].join(';');
    this.outputEl.textContent = 'Waiting for sandbox output…\n';
    this.container.appendChild(this.outputEl);

    // Output files section (hidden initially)
    this.filesEl = document.createElement('div');
    this.filesEl.style.cssText = 'margin-top:8px;display:none;';
    this.container.appendChild(this.filesEl);

    // Listen for sandbox output
    this.cleanupListener();
    this.outputHandler = (...args: unknown[]) => {
      const event = args[0] as SandboxOutputEvent;
      this.handleOutputEvent(event);
    };
    eapi().on('sandbox-output', this.outputHandler);
  }

  // ─── Event handling ─────────────────────────────────────────

  private handleOutputEvent(event: SandboxOutputEvent): void {
    if (!event) return;

    if (event.type === 'stdout' || event.type === 'stderr') {
      this.appendOutput(event.content ?? '', event.type === 'stderr');
    }

    if (event.type === 'status' && event.status) {
      this.currentStatus = event.status;
      this.updateStatusBadge(event.status);
    }

    if (event.type === 'files' && event.files) {
      this.renderOutputFiles(event.files);
    }
  }

  private appendOutput(text: string, isStderr: boolean = false): void {
    if (!this.outputEl) return;

    // Clear placeholder on first real output
    if (this.outputEl.textContent === 'Waiting for sandbox output…\n') {
      this.outputEl.textContent = '';
    }

    const span = document.createElement('span');
    if (isStderr) {
      span.style.color = 'var(--red,#ef4444)';
    }
    span.textContent = text;
    this.outputEl.appendChild(span);

    // Auto-scroll to bottom
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private updateStatusBadge(status: SessionStatus): void {
    if (!this.statusEl) return;
    const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.running;
    this.statusEl.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border-radius:12px;background:${cfg.color}20;color:${cfg.color};font-weight:600;">` +
      `${cfg.icon} ${cfg.label}</span>`;
  }

  private renderOutputFiles(files: string[]): void {
    if (!this.filesEl || files.length === 0) return;
    this.filesEl.style.display = 'block';
    this.filesEl.innerHTML =
      '<div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">📁 Output Files</div>' +
      files.map((f) =>
        `<div style="font-size:11px;color:var(--text-primary);padding:2px 0;font-family:monospace;">${escHtml(f)}</div>`,
      ).join('');
  }

  private cleanupListener(): void {
    if (this.outputHandler) {
      eapi().removeListener('sandbox-output', this.outputHandler);
      this.outputHandler = null;
    }
  }

  destroy(): void {
    this.cleanupListener();
  }
}

// ─── Convenience export ─────────────────────────────────────────

export function renderSandboxPanel(container: HTMLElement): SandboxPanel {
  const panel = new SandboxPanel(container);
  panel.render();
  return panel;
}
