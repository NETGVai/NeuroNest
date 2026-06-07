/**
 * GcfRolloutBanner — Settings-panel yellow warning banner for the GCF_Wire_Format
 * Phase 1 rollout gate (Feature 10, Requirement 56.4).
 *
 * The Phase 1 rollout gate blocks flipping `GCF_WIRE_FORMAT` to active mode
 * until every currently-configured provider has proven GCF comprehension parity
 * (marked `gcfCapable: true` in `~/.neuronest/gcf-capabilities.json`). When the
 * gate is blocked, this banner surfaces a yellow warning in the Settings panel
 * naming the providers that still block the flip so the operator knows to run
 * the per-provider comprehension eval for them first.
 *
 * Data flow:
 *   1. On render, fetch the gate status via the `gcf:rollout-gate-status` IPC
 *      channel (handled in `src/main/ipc.ts`, whitelisted in preload.ts).
 *   2. When `allowed === false`, render the yellow banner listing
 *      `nonCapableProviders`. When `allowed === true`, render nothing (the gate
 *      is open; no warning is warranted).
 *
 * This module is intentionally standalone so the Settings surface in
 * `index.ts` can mount it later (`renderGcfRolloutBanner(container)`) without
 * this file reaching into the renderer monolith. It mirrors the existing
 * TS-panel modules (mcp-panel.ts, security-panel.ts): an exported render
 * function plus a pure view-model helper, both driven through the
 * `window.electronAPI` bridge.
 *
 * Requirements: 56.4
 */

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
} | undefined {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

/**
 * The gate status returned by the `gcf:rollout-gate-status` IPC channel. Mirrors
 * `RolloutGateStatus` in `src/serializers/gcf-eval.ts`. Fields are optional here
 * because the renderer must defend against a malformed/partial payload.
 */
export interface RolloutGateStatus {
  allowed?: boolean;
  configuredProviders?: string[];
  capableProviders?: string[];
  nonCapableProviders?: string[];
  error?: string;
}

/**
 * The view model the banner renders from. `visible` decides whether the banner
 * is shown at all; `providers` is the de-duplicated, display-ready list of
 * blocking provider names; `message` is the human-readable warning text.
 */
export interface BannerViewModel {
  visible: boolean;
  providers: string[];
  message: string;
}

export const GCF_ROLLOUT_BANNER_TESTID = 'gcf-rollout-banner';
export const GCF_ROLLOUT_GATE_CHANNEL = 'gcf:rollout-gate-status';

// ─── Pure view-model derivation ─────────────────────────────────

/**
 * Derive the banner view model from a (possibly malformed) gate status.
 *
 * The banner is shown ONLY when the gate is blocked — `allowed === false` AND
 * there is at least one non-capable provider to name. A fully-open gate
 * (`allowed === true`) or an empty/absent payload yields a hidden banner so the
 * Settings panel stays clean when there is nothing to warn about. A status
 * object carrying an `error` is treated as blocked (fail-closed) so a transient
 * backend failure cannot hide the gate.
 */
export function buildBannerModel(status: RolloutGateStatus | null | undefined): BannerViewModel {
  const hidden: BannerViewModel = { visible: false, providers: [], message: '' };
  if (!status || typeof status !== 'object') return hidden;

  const blockers = Array.isArray(status.nonCapableProviders)
    ? status.nonCapableProviders.filter(
        (p): p is string => typeof p === 'string' && p.trim() !== '',
      )
    : [];

  // De-dupe while preserving order so the same provider isn't listed twice.
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const p of blockers) {
    const key = p.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    providers.push(key);
  }

  const blocked = status.allowed === false || typeof status.error === 'string';

  // Nothing to surface: gate is open, or it's blocked but we have no provider
  // names to attribute the block to (defensive — avoids an empty warning).
  if (!blocked || providers.length === 0) return hidden;

  const noun = providers.length === 1 ? 'provider' : 'providers';
  const message =
    'GCF_WIRE_FORMAT cannot be enabled yet: ' +
    providers.length +
    ' configured ' +
    noun +
    ' have not passed the GCF comprehension eval (' +
    providers.join(', ') +
    '). Run the per-provider comprehension eval for ' +
    (providers.length === 1 ? 'it' : 'them') +
    ' before flipping the flag to active.';

  return { visible: true, providers, message };
}

// ─── Banner element construction ────────────────────────────────

/**
 * Build the yellow warning banner element for a blocked gate. Returns a single
 * `<div>` carrying the `data-testid` hook, an amber/yellow color scheme, a
 * warning icon, the headline, and the list of blocking providers. Pure DOM
 * construction — no IPC — so it is trivially unit-testable.
 */
export function buildBannerElement(model: BannerViewModel): HTMLElement {
  const banner = document.createElement('div');
  banner.setAttribute('data-testid', GCF_ROLLOUT_BANNER_TESTID);
  banner.setAttribute('role', 'alert');
  banner.setAttribute('data-blocked', model.visible ? 'true' : 'false');
  // Yellow/amber warning treatment consistent with a cautionary (not error)
  // state — the gate is a precondition, not a failure.
  banner.style.cssText =
    'display:flex;align-items:flex-start;gap:10px;padding:12px 14px;margin:8px 0;' +
    'border:1px solid #f59e0b;border-left-width:4px;border-radius:6px;' +
    'background:rgba(245,158,11,0.12);color:var(--text-primary,#e2e8f0);font-size:12px;line-height:1.5;';

  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.style.cssText = 'flex:0 0 auto;font-size:14px;line-height:1.3;';
  icon.textContent = '⚠️';
  banner.appendChild(icon);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;gap:6px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;color:#b45309;';
  title.textContent = 'GCF wire format rollout blocked';
  body.appendChild(title);

  const detail = document.createElement('div');
  detail.style.cssText = 'color:var(--text-secondary,#94a3b8);';
  detail.textContent = model.message;
  body.appendChild(detail);

  if (model.providers.length > 0) {
    const list = document.createElement('ul');
    list.style.cssText = 'margin:2px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:2px;';
    for (const provider of model.providers) {
      const item = document.createElement('li');
      item.setAttribute('data-provider', provider);
      item.style.cssText = 'font-family:monospace;color:var(--text-primary,#e2e8f0);';
      item.innerHTML = escHtml(provider);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  banner.appendChild(body);
  return banner;
}

// ─── GcfRolloutBanner ───────────────────────────────────────────

export class GcfRolloutBanner {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Fetch the gate status and (re)render. Safe to call repeatedly. */
  render(): Promise<void> {
    return this.refresh();
  }

  /**
   * Fetch the gate status over IPC and repaint. The banner is shown only when
   * the gate is blocked; otherwise the container is cleared. Never throws — an
   * IPC/transport error is treated as a blocked gate so the warning surfaces
   * (fail-closed) rather than silently disappearing.
   */
  refresh(): Promise<void> {
    const api = eapi();
    if (!api || typeof api.invoke !== 'function') {
      // No bridge available (e.g. very early boot) — render nothing rather
      // than crash. There is no gate signal to act on.
      this.clear();
      return Promise.resolve();
    }

    let p: Promise<unknown>;
    try {
      p = Promise.resolve(api.invoke(GCF_ROLLOUT_GATE_CHANNEL));
    } catch (e: unknown) {
      this.paint(buildBannerModel({ allowed: false, error: String(e) }));
      return Promise.resolve();
    }

    return p
      .then((status) => {
        this.paint(buildBannerModel(status as RolloutGateStatus));
      })
      .catch((err: unknown) => {
        const message = err && (err as Error).message ? (err as Error).message : String(err);
        this.paint(buildBannerModel({ allowed: false, error: message }));
      });
  }

  /** Paint the banner from a view model, or clear when it is hidden. */
  private paint(model: BannerViewModel): void {
    this.clear();
    if (!model.visible) return;
    this.container.appendChild(buildBannerElement(model));
  }

  /** Remove any previously-rendered banner from the container. */
  private clear(): void {
    const existing = this.container.querySelector(
      '[data-testid="' + GCF_ROLLOUT_BANNER_TESTID + '"]',
    );
    if (existing && existing.parentNode === this.container) {
      this.container.removeChild(existing);
    }
  }
}

// ─── Convenience entry point ────────────────────────────────────

/**
 * Mount the banner into `container` and kick off the initial gate fetch.
 * Returns the instance so the caller can `refresh()` it after the operator
 * edits providers or runs the comprehension eval.
 */
export function renderGcfRolloutBanner(container: HTMLElement): GcfRolloutBanner {
  const banner = new GcfRolloutBanner(container);
  void banner.render();
  return banner;
}
