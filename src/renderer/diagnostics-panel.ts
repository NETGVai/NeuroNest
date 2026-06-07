/**
 * DiagnosticsPanel — renders health check results from DiagnosticsEngine.
 *
 * Uses the window.electronAPI bridge (invoke/on) from preload.
 * Creates DOM elements programmatically, matching existing dashboard card patterns.
 *
 * Requirements: 7.1, 7.4, 7.6, 7.7
 */

import type { HealthCheckResult, DiagnosticsReport } from '../diagnostics/types';

// ─── Helpers ────────────────────────────────────────────────────

const STATUS_CONFIG: Record<HealthCheckResult['status'], { icon: string; color: string; label: string }> = {
  pass:    { icon: '✓', color: 'var(--green)',  label: 'Pass' },
  warning: { icon: '⚠', color: 'var(--yellow)', label: 'Warning' },
  fail:    { icon: '✗', color: 'var(--red)',    label: 'Fail' },
};

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Panel class ────────────────────────────────────────────────

export class DiagnosticsPanel {
  private container: HTMLElement;
  private resultsGrid: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressHandler: ((...args: unknown[]) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the panel shell and trigger a diagnostics run. */
  render(): void {
    this.container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
    header.innerHTML = `<h3 style="margin:0;">🩺 System Diagnostics</h3>`;

    const runBtn = document.createElement('button');
    runBtn.textContent = 'Run Diagnostics';
    runBtn.style.cssText = 'font-size:12px;padding:6px 14px;border:1px solid var(--border-color);background:var(--accent);color:white;border-radius:6px;cursor:pointer;';
    runBtn.addEventListener('click', () => this.runDiagnostics());
    header.appendChild(runBtn);
    this.container.appendChild(header);

    // Progress area
    this.progressEl = document.createElement('div');
    this.progressEl.style.cssText = 'margin-bottom:16px;display:none;';
    this.container.appendChild(this.progressEl);

    // Results grid
    this.resultsGrid = document.createElement('div');
    this.resultsGrid.className = 'dashboard-grid';
    this.resultsGrid.style.cssText = 'grid-template-columns:repeat(auto-fill,minmax(280px,1fr));';
    this.container.appendChild(this.resultsGrid);

    // Show empty state
    this.showEmptyState();
  }

  /** Run diagnostics via IPC, streaming progress. */
  async runDiagnostics(): Promise<void> {
    if (!this.resultsGrid || !this.progressEl) return;

    // Clear previous results
    this.resultsGrid.innerHTML = '';
    this.showProgress('Running diagnostics…');

    // Listen for incremental progress
    this.cleanupProgressListener();
    this.progressHandler = (...args: unknown[]) => {
      const result = args[0] as HealthCheckResult;
      if (result && result.name) {
        this.appendResultCard(result);
        this.updateProgress(`Completed: ${result.name}`);
      }
    };
    eapi().on('diagnostics-progress', this.progressHandler);

    try {
      const report = await eapi().invoke('diagnostics-run-doctor') as DiagnosticsReport;
      this.hideProgress();
      this.cleanupProgressListener();

      // Render full report (in case progress events were missed)
      this.renderReport(report);
    } catch (err: unknown) {
      this.hideProgress();
      this.cleanupProgressListener();
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Rendering helpers ──────────────────────────────────────

  private renderReport(report: DiagnosticsReport): void {
    if (!this.resultsGrid) return;
    this.resultsGrid.innerHTML = '';

    if (!report.checks || report.checks.length === 0) {
      this.showEmptyState();
      return;
    }

    // Check if all passed
    const allPassed = report.checks.every(c => c.status === 'pass');
    if (allPassed) {
      this.showInfoMessage('All systems operational — no issues found.');
    }

    for (const check of report.checks) {
      this.appendResultCard(check);
    }

    // Summary footer
    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:12px;font-size:12px;color:var(--text-dim);';
    footer.textContent = `Completed in ${formatDuration(report.totalDurationMs)}` +
      (report.completedAll ? '' : ' (some checks timed out)');
    this.container.appendChild(footer);
  }

  private appendResultCard(result: HealthCheckResult): void {
    if (!this.resultsGrid) return;

    const cfg = STATUS_CONFIG[result.status] || STATUS_CONFIG.fail;
    const card = document.createElement('div');
    card.className = 'dash-card';
    card.style.cssText = `padding:14px;border-left:3px solid ${cfg.color};`;

    // Top row: icon + name + duration
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
    top.innerHTML =
      `<span style="font-size:14px;font-weight:600;color:var(--text-primary);">` +
      `<span style="color:${cfg.color};margin-right:6px;font-size:16px;">${cfg.icon}</span>` +
      `${escHtml(result.name)}</span>` +
      `<span style="font-size:11px;color:var(--text-dim);">${formatDuration(result.durationMs)}</span>`;
    card.appendChild(top);

    // Message
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.4;';
    msg.textContent = result.message;
    card.appendChild(msg);

    // Timeout badge
    if (result.timedOut) {
      const badge = document.createElement('span');
      badge.style.cssText = 'display:inline-block;margin-top:6px;font-size:10px;padding:2px 6px;border-radius:10px;background:var(--yellow-container,rgba(251,191,36,0.12));color:var(--yellow);font-weight:600;';
      badge.textContent = 'TIMED OUT';
      card.appendChild(badge);
    }

    this.resultsGrid.appendChild(card);
  }

  private showProgress(text: string): void {
    if (!this.progressEl) return;
    this.progressEl.style.display = 'block';
    this.progressEl.innerHTML =
      `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg-input);border-radius:8px;border:1px solid var(--border-color);">` +
      `<span style="display:inline-block;width:14px;height:14px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></span>` +
      `<span style="font-size:12px;color:var(--text-secondary);">${escHtml(text)}</span>` +
      `</div>`;
  }

  private updateProgress(text: string): void {
    if (!this.progressEl) return;
    const span = this.progressEl.querySelector('span:last-child');
    if (span) span.textContent = text;
  }

  private hideProgress(): void {
    if (!this.progressEl) return;
    this.progressEl.style.display = 'none';
    this.progressEl.innerHTML = '';
  }

  private showEmptyState(): void {
    if (!this.resultsGrid) return;
    this.resultsGrid.innerHTML =
      `<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-dim);font-size:13px;">` +
      `Click "Run Diagnostics" to check system health.</div>`;
  }

  private showInfoMessage(text: string): void {
    if (!this.resultsGrid) return;
    const info = document.createElement('div');
    info.style.cssText = 'grid-column:1/-1;padding:12px 16px;background:var(--green-container,rgba(74,222,128,0.12));border:1px solid var(--green);border-radius:8px;font-size:13px;color:var(--green);margin-bottom:8px;';
    info.innerHTML = `✓ ${escHtml(text)}`;
    this.resultsGrid.prepend(info);
  }

  private showError(message: string): void {
    if (!this.resultsGrid) return;
    this.resultsGrid.innerHTML =
      `<div style="grid-column:1/-1;padding:12px 16px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red);border-radius:8px;font-size:13px;color:var(--red);">` +
      `Error: ${escHtml(message)}</div>`;
  }

  private cleanupProgressListener(): void {
    if (this.progressHandler) {
      eapi().removeListener('diagnostics-progress', this.progressHandler);
      this.progressHandler = null;
    }
  }

  /** Clean up listeners when panel is destroyed. */
  destroy(): void {
    this.cleanupProgressListener();
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the diagnostics panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderDiagnosticsPanel(container: HTMLElement): DiagnosticsPanel {
  const panel = new DiagnosticsPanel(container);
  panel.render();
  return panel;
}
