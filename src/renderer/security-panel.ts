/**
 * SecurityPanel — renders security scan findings, summary, SARIF export, and exceptions.
 *
 * Uses the window.electronAPI bridge (invoke/on) from preload.
 * Creates DOM elements programmatically, matching existing dashboard card patterns.
 *
 * Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 9.4
 */

import type { ScanFinding, ScanSummary, ScanResult, ScanException } from '../security/types';

// ─── Helpers ────────────────────────────────────────────────────

const SEVERITY_CONFIG: Record<ScanFinding['severity'], { color: string; bg: string; label: string }> = {
  critical: { color: 'var(--red)',    bg: 'var(--red-container,rgba(248,113,113,0.12))',    label: 'CRITICAL' },
  high:     { color: 'var(--red)',    bg: 'var(--red-container,rgba(248,113,113,0.12))',    label: 'HIGH' },
  medium:   { color: 'var(--yellow)', bg: 'var(--yellow-container,rgba(251,191,36,0.12))',  label: 'MEDIUM' },
  low:      { color: 'var(--green)',  bg: 'var(--green-container,rgba(74,222,128,0.12))',   label: 'LOW' },
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

export class SecurityPanel {
  private container: HTMLElement;
  private summaryEl: HTMLElement | null = null;
  private findingsEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private exceptionsEl: HTMLElement | null = null;
  private progressHandler: ((...args: unknown[]) => void) | null = null;
  private lastScanId: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the panel shell. */
  render(): void {
    this.container.innerHTML = '';

    // Header with run button
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
    header.innerHTML = `<h3 style="margin:0;">🔒 Security Scanner</h3>`;

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:8px;';

    const runBtn = document.createElement('button');
    runBtn.textContent = 'Run Scan';
    runBtn.style.cssText = 'font-size:12px;padding:6px 14px;border:1px solid var(--border-color);background:var(--accent);color:white;border-radius:6px;cursor:pointer;';
    runBtn.addEventListener('click', () => this.runScan());

    const sarifBtn = document.createElement('button');
    sarifBtn.textContent = 'Download SARIF';
    sarifBtn.id = 'security-sarif-btn';
    sarifBtn.style.cssText = 'font-size:12px;padding:6px 14px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;opacity:0.5;';
    sarifBtn.disabled = true;
    sarifBtn.addEventListener('click', () => this.downloadSarif());

    btnGroup.appendChild(runBtn);
    btnGroup.appendChild(sarifBtn);
    header.appendChild(btnGroup);
    this.container.appendChild(header);

    // Progress area
    this.progressEl = document.createElement('div');
    this.progressEl.style.cssText = 'margin-bottom:16px;display:none;';
    this.container.appendChild(this.progressEl);

    // Summary card area
    this.summaryEl = document.createElement('div');
    this.summaryEl.style.cssText = 'margin-bottom:16px;';
    this.container.appendChild(this.summaryEl);

    // Exceptions area
    this.exceptionsEl = document.createElement('div');
    this.exceptionsEl.style.cssText = 'margin-bottom:16px;';
    this.container.appendChild(this.exceptionsEl);

    // Findings list
    this.findingsEl = document.createElement('div');
    this.container.appendChild(this.findingsEl);

    // Show empty state
    this.showEmptyState();
  }

  /** Run a security scan via IPC. */
  async runScan(tier?: string): Promise<void> {
    if (!this.findingsEl || !this.progressEl) return;

    this.findingsEl.innerHTML = '';
    this.summaryEl!.innerHTML = '';
    this.exceptionsEl!.innerHTML = '';
    this.showProgress('Scanning project files…');

    // Listen for scan progress
    this.cleanupProgressListener();
    this.progressHandler = (...args: unknown[]) => {
      const progress = args[0] as { filesScanned?: number; findingsSoFar?: number; currentFile?: string };
      if (progress) {
        const parts: string[] = [];
        if (progress.filesScanned != null) parts.push(`${progress.filesScanned} files scanned`);
        if (progress.findingsSoFar != null) parts.push(`${progress.findingsSoFar} findings`);
        if (progress.currentFile) parts.push(progress.currentFile);
        this.updateProgress(parts.join(' · ') || 'Scanning…');
      }
    };
    eapi().on('security-scan-progress', this.progressHandler);

    try {
      const options: Record<string, unknown> = {};
      if (tier) options.tier = tier;
      const result = await eapi().invoke('security-run-scan', options) as ScanResult;
      this.hideProgress();
      this.cleanupProgressListener();
      this.lastScanId = result.id;
      this.enableSarifButton();
      this.renderScanResult(result);
    } catch (err: unknown) {
      this.hideProgress();
      this.cleanupProgressListener();
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Rendering ────────────────────────────────────────────────

  private renderScanResult(result: ScanResult): void {
    this.renderSummary(result.summary);
    this.renderFindings(result.findings);
    this.renderExceptions(result.summary.suppressedCount);
  }

  private renderSummary(summary: ScanSummary): void {
    if (!this.summaryEl) return;
    this.summaryEl.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'dashboard-grid';
    grid.style.cssText = 'grid-template-columns:repeat(auto-fill,minmax(140px,1fr));margin-bottom:8px;';

    // Total files
    grid.appendChild(this.makeSummaryCard('📁 Files Scanned', String(summary.totalFiles)));
    // Total findings
    grid.appendChild(this.makeSummaryCard('🔍 Total Findings', String(summary.totalFindings)));
    // By severity
    const severities: Array<ScanFinding['severity']> = ['critical', 'high', 'medium', 'low'];
    for (const sev of severities) {
      const count = summary.findingsBySeverity[sev] || 0;
      const cfg = SEVERITY_CONFIG[sev];
      grid.appendChild(this.makeSummaryCard(cfg.label, String(count), cfg.color));
    }

    this.summaryEl.appendChild(grid);

    // Duration + tier info
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:4px;';
    meta.textContent = `Tier: ${summary.tier} · Duration: ${formatDuration(summary.durationMs)}`;
    this.summaryEl.appendChild(meta);
  }

  private makeSummaryCard(label: string, value: string, color?: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'dash-card';
    card.style.cssText = 'padding:12px;';
    card.innerHTML =
      `<div class="dash-label">${escHtml(label)}</div>` +
      `<div class="dash-value" style="font-size:20px;${color ? `color:${color};` : ''}">${escHtml(value)}</div>`;
    return card;
  }

  private renderFindings(findings: ScanFinding[]): void {
    if (!this.findingsEl) return;
    this.findingsEl.innerHTML = '';

    if (findings.length === 0) {
      this.showInfoMessage('No security findings — your code looks clean!');
      return;
    }

    const heading = document.createElement('h4');
    heading.style.cssText = 'font-size:13px;margin-bottom:8px;color:var(--text-secondary);';
    heading.textContent = `Findings (${findings.length})`;
    this.findingsEl.appendChild(heading);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    for (const finding of findings) {
      list.appendChild(this.makeFindingItem(finding));
    }

    this.findingsEl.appendChild(list);
  }

  private makeFindingItem(finding: ScanFinding): HTMLElement {
    const cfg = SEVERITY_CONFIG[finding.severity] || SEVERITY_CONFIG.low;

    const item = document.createElement('div');
    item.className = 'dash-card';
    item.style.cssText = 'padding:10px 14px;border-left:3px solid ' + cfg.color + ';';

    // Top row: severity badge + rule name
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;';
    top.innerHTML =
      `<span style="font-size:10px;padding:2px 6px;border-radius:10px;background:${cfg.bg};color:${cfg.color};font-weight:600;">${cfg.label}</span>` +
      `<span style="font-size:13px;font-weight:600;color:var(--text-primary);">${escHtml(finding.ruleName)}</span>`;
    item.appendChild(top);

    // File location
    const loc = document.createElement('div');
    loc.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:4px;font-family:monospace;';
    loc.textContent = `${finding.filePath}:${finding.line}:${finding.column}`;
    item.appendChild(loc);

    // Description
    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.4;';
    desc.textContent = finding.description;
    item.appendChild(desc);

    return item;
  }

  private renderExceptions(suppressedCount: number): void {
    if (!this.exceptionsEl) return;
    this.exceptionsEl.innerHTML = '';

    if (suppressedCount <= 0) return;

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;';

    bar.innerHTML =
      `<span style="font-size:12px;color:var(--text-secondary);">` +
      `🛡️ <strong>${suppressedCount}</strong> finding${suppressedCount !== 1 ? 's' : ''} suppressed by active exceptions</span>`;

    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View Exceptions';
    viewBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;';
    viewBtn.addEventListener('click', () => this.showExceptionsDetail());
    bar.appendChild(viewBtn);

    this.exceptionsEl.appendChild(bar);
  }

  private async showExceptionsDetail(): Promise<void> {
    if (!this.exceptionsEl) return;

    try {
      // Fetch scan history to get exception info (exceptions are part of scan context)
      const history = await eapi().invoke('security-get-scan-history', '') as ScanResult[];
      if (!history || history.length === 0) return;

      // Show a simple list of suppressed info
      const detail = document.createElement('div');
      detail.style.cssText = 'margin-top:8px;padding:12px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;';
      detail.innerHTML =
        `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">` +
        `Active exceptions are managed through the security scanner configuration. ` +
        `Use the <code>/security</code> command to manage exceptions.</div>`;

      // Only append if not already showing
      const existing = this.exceptionsEl.querySelector('.exceptions-detail');
      if (existing) existing.remove();
      detail.className = 'exceptions-detail';
      this.exceptionsEl.appendChild(detail);
    } catch {
      // Silently fail — exceptions detail is supplementary
    }
  }

  // ─── SARIF Export ─────────────────────────────────────────────

  private enableSarifButton(): void {
    const btn = this.container.querySelector('#security-sarif-btn') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  }

  private async downloadSarif(): Promise<void> {
    if (!this.lastScanId) return;

    try {
      const sarif = await eapi().invoke('security-export-sarif', this.lastScanId);
      // Create a downloadable blob
      const json = JSON.stringify(sarif, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `security-scan-${this.lastScanId}.sarif`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Progress / state helpers ─────────────────────────────────

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
    if (!this.findingsEl) return;
    this.findingsEl.innerHTML =
      `<div style="text-align:center;padding:32px;color:var(--text-dim);font-size:13px;">` +
      `Click "Run Scan" to scan your project for security issues.</div>`;
  }

  private showInfoMessage(text: string): void {
    if (!this.findingsEl) return;
    const info = document.createElement('div');
    info.style.cssText = 'padding:12px 16px;background:var(--green-container,rgba(74,222,128,0.12));border:1px solid var(--green);border-radius:8px;font-size:13px;color:var(--green);margin-bottom:8px;';
    info.innerHTML = `✓ ${escHtml(text)}`;
    this.findingsEl.prepend(info);
  }

  private showError(message: string): void {
    if (!this.findingsEl) return;
    const errEl = document.createElement('div');
    errEl.style.cssText = 'padding:12px 16px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red);border-radius:8px;font-size:13px;color:var(--red);margin-bottom:8px;';
    errEl.textContent = `Error: ${message}`;
    this.findingsEl.prepend(errEl);
  }

  private cleanupProgressListener(): void {
    if (this.progressHandler) {
      eapi().removeListener('security-scan-progress', this.progressHandler);
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
 * Render the security panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderSecurityPanel(container: HTMLElement): SecurityPanel {
  const panel = new SecurityPanel(container);
  panel.render();
  return panel;
}
