/**
 * SkillPacksPanel — Settings-panel "Skill Packs" tab for the Skill_Pack_System
 * (Feature 11, Requirements 63.2 / 63.3).
 *
 * Surfaces every installed Skill_Pack in a table (name, version, last sync,
 * drift status) with per-pack action buttons (Sync, Remove, Check Drift, Run
 * Eval) and a top-of-panel Install field accepting a Git URL. All data flows
 * through the six whitelisted IPC channels (Requirement 63.1):
 *
 *   skill-packs:list        → Array<{ packId, name, version, …, lastSync? }>
 *   skill-packs:install     ← { source: { kind: 'git', url }, force? }
 *   skill-packs:sync        ← { packId }            → { ok, error? }
 *   skill-packs:remove      ← { packId }            → { ok, error? }
 *   skill-packs:check-drift ← { packId }            → DriftReport
 *   skill-packs:run-eval    ← { packId }            → EvalReport | { skipped, reason }
 *
 * This module is intentionally standalone so the Settings surface in `index.ts`
 * can mount it later (`renderSkillPacksPanel(container)`) without this file
 * reaching into the renderer monolith — mirroring the existing TS-panel modules
 * (mcp-panel.ts, security-panel.ts, gcf-rollout-banner.ts): a class plus an
 * exported render function, both driven through the `window.electronAPI`
 * bridge.
 *
 * Requirements: 63.2, 63.3
 */

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/** A DOM-id-safe slug derived from a packId (which may contain `/`, `.`, etc.). */
function safeId(packId: string): string {
  return String(packId).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function eapi():
  | { invoke(channel: string, ...args: unknown[]): Promise<unknown> }
  | undefined {
  return (window as any).electronAPI;
}

// ─── Channel constants ──────────────────────────────────────────

export const SKILL_PACKS_LIST_CHANNEL = 'skill-packs:list';
export const SKILL_PACKS_INSTALL_CHANNEL = 'skill-packs:install';
export const SKILL_PACKS_SYNC_CHANNEL = 'skill-packs:sync';
export const SKILL_PACKS_REMOVE_CHANNEL = 'skill-packs:remove';
export const SKILL_PACKS_CHECK_DRIFT_CHANNEL = 'skill-packs:check-drift';
export const SKILL_PACKS_RUN_EVAL_CHANNEL = 'skill-packs:run-eval';

export const SKILL_PACKS_PANEL_TESTID = 'skill-packs-panel';

// ─── Types ──────────────────────────────────────────────────────

/**
 * One installed pack as projected by `skill-packs:list`. The production handler
 * returns a flat shape (`{ packId, name, version, … }`), while the design
 * contract documents a nested `{ packId, manifest, lastSync }` shape; both are
 * normalized by {@link normalizePackEntry} so the panel renders either.
 */
export interface SkillPackEntry {
  packId: string;
  name: string;
  version: string;
  /** Epoch-ms of the last successful sync, when known. */
  lastSync?: number;
  description?: string;
  source?: string;
}

/** Mirrors `DriftReport` from `src/skills/drift-detector.ts`. */
export interface DriftReport {
  packId?: string;
  status?: 'fresh' | 'stale' | 'unknown';
  sourceCommit?: string;
  currentCommit?: string;
  commitsBehind?: number;
  perSkill?: Array<{ skillId: string; status: 'fresh' | 'stale' | 'unknown' }>;
  error?: string;
}

type DriftStatus = 'fresh' | 'stale' | 'unknown';

// ─── Presentation maps ──────────────────────────────────────────

const DRIFT_BADGES: Record<
  DriftStatus | 'unchecked' | 'checking',
  { label: string; color: string; bg: string }
> = {
  fresh:     { label: 'Fresh',       color: 'var(--green,#22c55e)',     bg: 'rgba(34,197,94,0.12)' },
  stale:     { label: 'Stale',       color: 'var(--amber,#f59e0b)',     bg: 'rgba(245,158,11,0.12)' },
  unknown:   { label: 'Unknown',     color: 'var(--text-secondary)',    bg: 'var(--bg-input,rgba(148,163,184,0.12))' },
  unchecked: { label: 'Not checked', color: 'var(--text-dim)',          bg: 'var(--bg-input,rgba(148,163,184,0.12))' },
  checking:  { label: 'Checking…',   color: 'var(--text-dim)',          bg: 'var(--bg-input,rgba(148,163,184,0.12))' },
};

// ─── Pure helpers (unit-testable without a DOM) ─────────────────

/**
 * Normalize a raw `skill-packs:list` entry (flat OR nested-`manifest`) into the
 * panel's {@link SkillPackEntry}. Defends against partial/malformed rows so a
 * single bad entry cannot break the table.
 */
export function normalizePackEntry(raw: any): SkillPackEntry {
  const manifest = raw && typeof raw === 'object' ? raw.manifest : undefined;
  const pick = (k: string): unknown =>
    (raw && raw[k] !== undefined ? raw[k] : manifest ? manifest[k] : undefined);

  const packId = String(pick('packId') ?? raw?.packId ?? pick('name') ?? '');
  const name = String(pick('name') || packId || '(unnamed)');
  const versionRaw = pick('version');
  const version = versionRaw === undefined || versionRaw === null ? '' : String(versionRaw);
  const lastSyncRaw = raw?.lastSync ?? raw?.lastSyncedAt;
  const lastSync =
    typeof lastSyncRaw === 'number' && Number.isFinite(lastSyncRaw) ? lastSyncRaw : undefined;

  return {
    packId,
    name,
    version,
    lastSync,
    description: pick('description') as string | undefined,
    source: pick('source') as string | undefined,
  };
}

/** Human-readable "last sync" cell text. */
export function formatLastSync(lastSync: number | undefined): string {
  if (typeof lastSync !== 'number' || !Number.isFinite(lastSync) || lastSync <= 0) {
    return 'Never';
  }
  try {
    return new Date(lastSync).toLocaleString();
  } catch {
    return 'Never';
  }
}

// ─── SkillPacksPanel ────────────────────────────────────────────

export class SkillPacksPanel {
  private container: HTMLElement;
  private installInput: HTMLInputElement | null = null;
  private installButton: HTMLButtonElement | null = null;
  private installStatus: HTMLElement | null = null;
  private tableBody: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the static scaffold (install field + table) and load the packs. */
  render(): void {
    this.container.innerHTML = '';
    this.container.setAttribute('data-testid', SKILL_PACKS_PANEL_TESTID);

    // Header
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    header.innerHTML = '<h3 style="margin:0;">📦 Skill Packs</h3>';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('data-testid', 'skill-packs-refresh');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText =
      'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
    refreshBtn.addEventListener('click', () => void this.loadData());
    header.appendChild(refreshBtn);
    this.container.appendChild(header);

    // Install field (Requirement 63.3)
    this.container.appendChild(this.buildInstallRow());

    // Packs table (Requirement 63.2)
    this.container.appendChild(this.buildTable());

    void this.loadData();
  }

  /** Build the "Install from Git URL" input + button row. */
  private buildInstallRow(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:16px;';

    const label = document.createElement('label');
    label.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
    label.textContent = 'Install a pack from a Git URL';
    wrap.appendChild(label);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';

    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-testid', 'skill-packs-install-url');
    input.setAttribute('aria-label', 'Git URL of the skill pack to install');
    input.placeholder = 'https://github.com/owner/repo';
    input.style.cssText =
      'flex:1;min-width:0;font-size:12px;padding:6px 8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);border-radius:6px;font-family:monospace;';
    input.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void this.installFromUrl();
      }
    });
    this.installInput = input;
    row.appendChild(input);

    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-testid', 'skill-packs-install-btn');
    button.textContent = 'Install';
    button.style.cssText =
      'flex-shrink:0;font-size:12px;padding:6px 14px;border:1px solid var(--accent,#3b82f6);background:var(--accent-container,rgba(59,130,246,0.12));color:var(--accent,#3b82f6);border-radius:6px;cursor:pointer;font-weight:600;';
    button.addEventListener('click', () => void this.installFromUrl());
    this.installButton = button;
    row.appendChild(button);

    wrap.appendChild(row);

    const status = document.createElement('div');
    status.setAttribute('data-testid', 'skill-packs-install-status');
    status.style.cssText = 'font-size:11px;color:var(--text-dim);min-height:14px;';
    this.installStatus = status;
    wrap.appendChild(status);

    return wrap;
  }

  /** Build the packs table skeleton and capture its `<tbody>`. */
  private buildTable(): HTMLElement {
    const table = document.createElement('table');
    table.setAttribute('data-testid', 'skill-packs-table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of ['Name', 'Version', 'Last sync', 'Drift', 'Actions']) {
      const th = document.createElement('th');
      th.textContent = col;
      th.style.cssText =
        'text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-color);color:var(--text-secondary);font-weight:600;';
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    tbody.setAttribute('data-testid', 'skill-packs-tbody');
    this.tableBody = tbody;
    table.appendChild(tbody);

    return table;
  }

  /** Load installed packs and (re)render the table body. */
  async loadData(): Promise<void> {
    const body = this.tableBody;
    if (!body) return;

    const api = eapi();
    if (!api || typeof api.invoke !== 'function') {
      this.renderMessageRow('Skill pack bridge unavailable.');
      return;
    }

    this.renderMessageRow('Loading skill packs…');

    let packs: unknown;
    try {
      packs = await api.invoke(SKILL_PACKS_LIST_CHANNEL);
    } catch (err: unknown) {
      this.renderMessageRow(`Error: ${String((err as Error)?.message ?? err)}`, true);
      return;
    }

    // The handler returns `{ error }` on failure rather than throwing.
    if (packs && typeof packs === 'object' && !Array.isArray(packs) && (packs as any).error) {
      this.renderMessageRow(`Error: ${String((packs as any).error)}`, true);
      return;
    }

    if (!Array.isArray(packs) || packs.length === 0) {
      this.renderMessageRow('No skill packs installed. Add one with a Git URL above.');
      return;
    }

    body.innerHTML = '';
    for (const raw of packs) {
      const entry = normalizePackEntry(raw);
      body.appendChild(this.buildPackRow(entry));
      // Populate the drift badge in the background (Requirement 63.2). A failed
      // probe degrades to "Unknown" rather than breaking the row.
      void this.checkDrift(entry.packId);
    }
  }

  /** Render a single full-width message row (loading / empty / error). */
  private renderMessageRow(message: string, isError = false): void {
    const body = this.tableBody;
    if (!body) return;
    body.innerHTML = '';
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', 'skill-packs-message-row');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.style.cssText = `padding:16px;text-align:center;font-size:12px;color:${
      isError ? 'var(--red,#ef4444)' : 'var(--text-dim)'
    };`;
    td.textContent = message;
    tr.appendChild(td);
    body.appendChild(tr);
  }

  /** Build a `<tr>` for one installed pack. */
  private buildPackRow(entry: SkillPackEntry): HTMLElement {
    const sid = safeId(entry.packId);
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', `skill-packs-row-${sid}`);
    tr.setAttribute('data-pack-id', entry.packId);
    tr.style.cssText = 'border-bottom:1px solid var(--border-color);';

    const cell = (testid: string): HTMLElement => {
      const td = document.createElement('td');
      td.setAttribute('data-testid', testid);
      td.style.cssText = 'padding:6px 8px;vertical-align:middle;';
      return td;
    };

    // Name
    const nameCell = cell(`skill-packs-name-${sid}`);
    nameCell.innerHTML =
      `<div style="font-weight:600;color:var(--text-primary);">${escHtml(entry.name)}</div>` +
      (entry.description
        ? `<div style="font-size:10px;color:var(--text-dim);">${escHtml(entry.description)}</div>`
        : '');
    tr.appendChild(nameCell);

    // Version
    const versionCell = cell(`skill-packs-version-${sid}`);
    versionCell.style.cssText += 'font-family:monospace;color:var(--text-secondary);';
    versionCell.textContent = entry.version || '—';
    tr.appendChild(versionCell);

    // Last sync
    const syncCell = cell(`skill-packs-last-sync-${sid}`);
    syncCell.style.cssText += 'color:var(--text-secondary);white-space:nowrap;';
    syncCell.textContent = formatLastSync(entry.lastSync);
    tr.appendChild(syncCell);

    // Drift status badge (starts "Not checked", filled in by checkDrift)
    const driftCell = cell(`skill-packs-drift-cell-${sid}`);
    driftCell.appendChild(this.buildDriftBadge(sid, 'unchecked'));
    tr.appendChild(driftCell);

    // Actions
    const actionsCell = cell(`skill-packs-actions-${sid}`);
    actionsCell.style.cssText += 'white-space:nowrap;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    actions.appendChild(
      this.buildActionButton(`skill-packs-sync-${sid}`, 'Sync', `Sync pack: ${entry.name}`, () =>
        this.syncPack(entry.packId),
      ),
    );
    actions.appendChild(
      this.buildActionButton(
        `skill-packs-check-drift-${sid}`,
        'Check Drift',
        `Check drift for pack: ${entry.name}`,
        () => this.checkDrift(entry.packId),
      ),
    );
    actions.appendChild(
      this.buildActionButton(
        `skill-packs-run-eval-${sid}`,
        'Run Eval',
        `Run eval for pack: ${entry.name}`,
        () => this.runEval(entry.packId),
      ),
    );
    actions.appendChild(
      this.buildActionButton(
        `skill-packs-remove-${sid}`,
        'Remove',
        `Remove pack: ${entry.name}`,
        () => this.removePack(entry.packId),
        true,
      ),
    );
    actionsCell.appendChild(actions);

    // Per-row status line (eval result / action feedback)
    const status = document.createElement('div');
    status.setAttribute('data-testid', `skill-packs-row-status-${sid}`);
    status.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:4px;min-height:12px;';
    actionsCell.appendChild(status);

    tr.appendChild(actionsCell);
    return tr;
  }

  private buildActionButton(
    testid: string,
    label: string,
    ariaLabel: string,
    onClick: () => void | Promise<void>,
    danger = false,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-testid', testid);
    btn.setAttribute('aria-label', ariaLabel);
    btn.textContent = label;
    const accent = danger ? 'var(--red,#ef4444)' : 'var(--accent,#3b82f6)';
    btn.style.cssText =
      `font-size:10px;padding:3px 8px;border:1px solid ${accent};background:transparent;color:${accent};border-radius:6px;cursor:pointer;font-weight:600;`;
    btn.addEventListener('click', () => void onClick());
    return btn;
  }

  private buildDriftBadge(sid: string, status: DriftStatus | 'unchecked' | 'checking'): HTMLElement {
    const cfg = DRIFT_BADGES[status] ?? DRIFT_BADGES.unknown;
    const badge = document.createElement('span');
    badge.setAttribute('data-testid', `skill-packs-drift-${sid}`);
    badge.setAttribute('data-drift', status);
    badge.style.cssText =
      `font-size:9px;padding:2px 8px;border-radius:10px;background:${cfg.bg};color:${cfg.color};font-weight:600;`;
    badge.textContent = cfg.label;
    return badge;
  }

  /** Replace a row's drift badge with one reflecting `status`. */
  private setDriftBadge(packId: string, status: DriftStatus | 'unchecked' | 'checking'): void {
    const sid = safeId(packId);
    const existing = this.container.querySelector(`[data-testid="skill-packs-drift-${sid}"]`);
    if (!existing || !existing.parentNode) return;
    existing.parentNode.replaceChild(this.buildDriftBadge(sid, status), existing);
  }

  private setRowStatus(packId: string, message: string, isError = false): void {
    const sid = safeId(packId);
    const el = this.container.querySelector(
      `[data-testid="skill-packs-row-status-${sid}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? 'var(--red,#ef4444)' : 'var(--text-dim)';
  }

  // ─── IPC actions ───────────────────────────────────────────

  /**
   * Install a pack from the Git URL field (Requirement 63.3). Calls
   * `skill-packs:install` with a `{ kind: 'git', url }` source, then refreshes
   * the table on success.
   */
  async installFromUrl(): Promise<void> {
    const input = this.installInput;
    const button = this.installButton;
    if (!input) return;

    const url = input.value.trim();
    if (!url) {
      this.setInstallStatus('Enter a Git URL to install.', true);
      return;
    }

    const api = eapi();
    if (!api || typeof api.invoke !== 'function') {
      this.setInstallStatus('Skill pack bridge unavailable.', true);
      return;
    }

    const originalLabel = button?.textContent ?? 'Install';
    if (button) {
      button.disabled = true;
      button.style.opacity = '0.6';
      button.style.cursor = 'wait';
      button.textContent = 'Installing…';
    }
    this.setInstallStatus('Installing…');

    try {
      const result = (await api.invoke(SKILL_PACKS_INSTALL_CHANNEL, {
        source: { kind: 'git', url },
      })) as { ok?: boolean; packId?: string; error?: string } | undefined;

      if (result && result.error) {
        this.setInstallStatus(`Install failed: ${result.error}`, true);
        return;
      }

      this.setInstallStatus(
        result?.packId ? `Installed ${result.packId}.` : 'Pack installed.',
      );
      input.value = '';
      await this.loadData();
    } catch (err: unknown) {
      this.setInstallStatus(`Install failed: ${String((err as Error)?.message ?? err)}`, true);
    } finally {
      if (button) {
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.textContent = originalLabel;
      }
    }
  }

  /** Probe drift for a pack and update its badge (Requirement 63.2). */
  async checkDrift(packId: string): Promise<void> {
    const api = eapi();
    if (!api || typeof api.invoke !== 'function') return;
    this.setDriftBadge(packId, 'checking');
    try {
      const report = (await api.invoke(SKILL_PACKS_CHECK_DRIFT_CHANNEL, { packId })) as
        | DriftReport
        | undefined;
      const status: DriftStatus = report && report.status ? report.status : 'unknown';
      this.setDriftBadge(packId, status);
    } catch {
      this.setDriftBadge(packId, 'unknown');
    }
  }

  /** Sync a pack from its upstream Git repo, then refresh. */
  async syncPack(packId: string): Promise<void> {
    const api = eapi();
    if (!api || typeof api.invoke !== 'function') return;
    this.setRowStatus(packId, 'Syncing…');
    try {
      const result = (await api.invoke(SKILL_PACKS_SYNC_CHANNEL, { packId })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (result && result.error) {
        this.setRowStatus(packId, `Sync failed: ${result.error}`, true);
        return;
      }
      this.setRowStatus(packId, 'Synced.');
      await this.loadData();
    } catch (err: unknown) {
      this.setRowStatus(packId, `Sync failed: ${String((err as Error)?.message ?? err)}`, true);
    }
  }

  /** Remove a pack and refresh the table. */
  async removePack(packId: string): Promise<void> {
    const api = eapi();
    if (!api || typeof api.invoke !== 'function') return;
    this.setRowStatus(packId, 'Removing…');
    try {
      const result = (await api.invoke(SKILL_PACKS_REMOVE_CHANNEL, { packId })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (result && result.error) {
        this.setRowStatus(packId, `Remove failed: ${result.error}`, true);
        return;
      }
      await this.loadData();
    } catch (err: unknown) {
      this.setRowStatus(packId, `Remove failed: ${String((err as Error)?.message ?? err)}`, true);
    }
  }

  /** Run the pack's eval regression suite and surface the headline result. */
  async runEval(packId: string): Promise<void> {
    const api = eapi();
    if (!api || typeof api.invoke !== 'function') return;
    this.setRowStatus(packId, 'Running eval…');
    try {
      const result = (await api.invoke(SKILL_PACKS_RUN_EVAL_CHANNEL, { packId })) as any;
      if (result && result.error) {
        this.setRowStatus(packId, `Eval failed: ${result.error}`, true);
        return;
      }
      if (result && result.skipped) {
        this.setRowStatus(packId, `Eval skipped: ${result.reason ?? 'no eval declared'}`);
        return;
      }
      if (result && typeof result.overallAccuracy === 'number') {
        this.setRowStatus(packId, `Eval accuracy: ${Math.round(result.overallAccuracy)}%`);
        return;
      }
      this.setRowStatus(packId, 'Eval complete.');
    } catch (err: unknown) {
      this.setRowStatus(packId, `Eval failed: ${String((err as Error)?.message ?? err)}`, true);
    }
  }

  private setInstallStatus(message: string, isError = false): void {
    if (!this.installStatus) return;
    this.installStatus.textContent = message;
    this.installStatus.style.color = isError ? 'var(--red,#ef4444)' : 'var(--text-dim)';
  }

  destroy(): void {}
}

// ─── Convenience entry point ────────────────────────────────────

/**
 * Mount the Skill Packs panel into `container` and kick off the initial load.
 * Returns the instance so the Settings surface can `loadData()` it again later.
 */
export function renderSkillPacksPanel(container: HTMLElement): SkillPacksPanel {
  const panel = new SkillPacksPanel(container);
  panel.render();
  return panel;
}
