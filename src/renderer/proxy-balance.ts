/**
 * Renderer-side helpers for the LLM Proxy Professional Mode session-stats
 * balance row.
 *
 * These helpers are intentionally framework-free and DOM-light so they can be
 * unit-tested in jsdom (see task 17.3 / Property 19) and reused inline by the
 * Electron renderer's `src/renderer/index.ts` (which is built by stripping
 * `export` keywords and concatenating into a plain browser script).
 *
 * The heavy DOM wiring (binding to `chat:done`, calling `renderBalanceRow`
 * after each completion, subscribing to `SettingsChangeEvent`) lives in
 * `index.ts` and mirrors the logic here so behavior stays consistent.
 *
 * Feature: llm-proxy-professional-mode
 * Validates: Requirements 8.3, 8.4
 */

// ─── Public types ───────────────────────────────────────────────

export interface ProxyBalanceResponse {
  /** Remaining USD credit balance returned by `GET /v1/credits/balance`. */
  balance: number;
  /** Currency code; the proxy always returns `"USD"` per the design. */
  currency: string;
}

/**
 * Snapshot of the renderer-side balance state for the session-stats panel.
 *
 * The renderer keeps one of these per running app (module-scoped) and updates
 * it after each chat completion when professional mode is enabled.
 */
export interface BalanceState {
  /**
   * Last balance value returned successfully by the proxy. `null` until the
   * very first successful fetch — failures BEFORE the first successful fetch
   * leave this as `null` and the panel only shows the "balance unavailable"
   * indicator.
   */
  lastKnownBalance: number | null;
  /** Whether the most recent fetch attempt failed. */
  fetchFailed: boolean;
}

// ─── Pure helpers ───────────────────────────────────────────────

/**
 * Fresh-state factory. Used both in production and in tests.
 */
export function createBalanceState(): BalanceState {
  return { lastKnownBalance: null, fetchFailed: false };
}

/**
 * Low-balance predicate (Property 19).
 *
 * Returns `true` when the warning row should be displayed:
 *   - balance is at or below zero, OR
 *   - balance is strictly less than the configured threshold.
 *
 * Non-finite balances or thresholds are treated conservatively: a non-finite
 * balance is considered "low" (we can't confirm credit, so warn the user); a
 * non-finite threshold falls back to the spec default of 1.0 USD.
 */
export function isLowBalance(balance: number | null, threshold: number): boolean {
  if (balance === null) return false; // no value yet — caller decides what to render
  if (!Number.isFinite(balance)) return true;
  const t = Number.isFinite(threshold) ? threshold : 1.0;
  return balance < t || balance <= 0;
}

/**
 * Format a USD balance for display. Always two decimals, e.g. `$0.00`.
 */
export function formatBalanceUsd(balance: number): string {
  if (!Number.isFinite(balance)) return '$0.00';
  // Avoid `-0.00` for tiny negative residuals from credit deductions.
  const v = Object.is(balance, -0) ? 0 : balance;
  return '$' + v.toFixed(2);
}

/**
 * Apply a successful balance response to a state snapshot, returning a new
 * snapshot. Pure, so callers can use it in tests without DOM.
 */
export function applyBalanceSuccess(
  state: BalanceState,
  response: ProxyBalanceResponse,
): BalanceState {
  return {
    lastKnownBalance: response.balance,
    fetchFailed: false,
  };
}

/**
 * Apply a fetch failure to a state snapshot. The previous `lastKnownBalance`
 * is retained per Requirement 8.3 ("on balance fetch failure, retain the
 * last-known balance").
 */
export function applyBalanceFailure(state: BalanceState): BalanceState {
  return {
    lastKnownBalance: state.lastKnownBalance,
    fetchFailed: true,
  };
}

// ─── Network ────────────────────────────────────────────────────

/**
 * Tiny helper around `fetch` that GETs `${endpoint}/credits/balance` with a
 * `Bearer` auth token. Returns the parsed `{balance, currency}` response or
 * `null` when:
 *   - endpoint or token is missing/empty,
 *   - the fetch rejects (network error, abort, etc.),
 *   - the response is not 2xx,
 *   - the response body is not valid JSON, or
 *   - the parsed body lacks a finite `balance` field.
 *
 * Never throws to the caller, so a balance failure cannot block subsequent
 * chat requests (Requirement 8.3).
 *
 * The `fetchImpl` parameter exists only to allow tests to inject a fake
 * `fetch`. In production it defaults to the global `fetch`.
 */
export async function fetchProxyBalance(
  endpoint: string | undefined,
  authToken: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<ProxyBalanceResponse | null> {
  if (!endpoint || endpoint.length === 0) return null;
  if (!authToken || authToken.length === 0) return null;

  const f: typeof fetch =
    fetchImpl ??
    (typeof fetch !== 'undefined' ? fetch : (undefined as unknown as typeof fetch));
  if (!f) return null;

  // Strip a single trailing slash so callers can pass either form.
  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  const url = `${base}/credits/balance`;

  let res: Response;
  try {
    res = await f(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return null;
  }

  if (!res || !res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  if (!body || typeof body !== 'object') return null;
  const obj = body as { balance?: unknown; currency?: unknown };
  const balance = typeof obj.balance === 'number' ? obj.balance : NaN;
  if (!Number.isFinite(balance)) return null;
  const currency = typeof obj.currency === 'string' ? obj.currency : 'USD';
  return { balance, currency };
}

// ─── DOM rendering ──────────────────────────────────────────────

/**
 * Element ids used by the renderer. Centralised here so tests can import them.
 */
export const PROXY_BALANCE_DOM = {
  /** Wrapper id for the balance value inside the Session stats panel. */
  balanceCard: 'stat-proxy-balance-card',
  /** Span inside the balance card holding the formatted value. */
  balanceValue: 'stat-proxy-balance',
  /** Tiny inline indicator shown next to the value when fetch fails. */
  unavailableIndicator: 'stat-proxy-balance-unavailable',
  /** Warning row above the model selector. */
  warningRow: 'proxy-low-balance-warning',
} as const;

export interface RenderBalanceRowOptions {
  /** Whether professional mode is currently enabled. */
  professionalMode: boolean;
  /** Current state snapshot for the panel. */
  state: BalanceState;
  /** Low-balance threshold in USD. */
  threshold: number;
  /**
   * Optional document override for tests. Defaults to `globalThis.document`.
   */
  doc?: Document;
}

/**
 * Idempotently render (or remove) the proxy balance row in the session-stats
 * panel and the low-balance warning row above the model selector.
 *
 * Returns the elements that were created/touched so callers (and tests) can
 * inspect them.
 *
 * Behavior:
 *   - When `professionalMode` is `false`, both rows are removed from the DOM
 *     (no-op if they don't exist). This matches Requirement 1.7: toggling off
 *     should immediately revert the panel.
 *   - When `professionalMode` is `true` and `state.lastKnownBalance` is a
 *     known number, the balance card is shown with `formatBalanceUsd`.
 *   - When `state.fetchFailed` is `true`, a small "balance unavailable"
 *     indicator is appended next to the value (or shown alone before the
 *     first successful fetch).
 *   - The warning row is shown above the model selector iff
 *     `isLowBalance(lastKnownBalance, threshold)` is `true`.
 */
export function renderBalanceRow(
  opts: RenderBalanceRowOptions,
): {
  balanceCard: HTMLElement | null;
  warningRow: HTMLElement | null;
} {
  const doc =
    opts.doc ??
    (typeof globalThis !== 'undefined' && (globalThis as { document?: Document }).document
      ? (globalThis as { document: Document }).document
      : (undefined as unknown as Document));
  if (!doc) return { balanceCard: null, warningRow: null };

  const { professionalMode, state, threshold } = opts;

  // ─── Balance card in the Session panel ────────────────────────
  const sessionPanel = findSessionPanel(doc);
  let balanceCard = doc.getElementById(PROXY_BALANCE_DOM.balanceCard);

  if (!professionalMode) {
    // Toggle off: tear down both rows.
    if (balanceCard && balanceCard.parentElement) {
      balanceCard.parentElement.removeChild(balanceCard);
    }
    const existingWarning = doc.getElementById(PROXY_BALANCE_DOM.warningRow);
    if (existingWarning && existingWarning.parentElement) {
      existingWarning.parentElement.removeChild(existingWarning);
    }
    return { balanceCard: null, warningRow: null };
  }

  if (sessionPanel && !balanceCard) {
    balanceCard = doc.createElement('div');
    balanceCard.id = PROXY_BALANCE_DOM.balanceCard;
    balanceCard.setAttribute(
      'style',
      'grid-column:1 / -1;background:var(--bg-input);border-radius:6px;padding:6px 8px;text-align:center;margin-top:6px;',
    );
    balanceCard.innerHTML =
      '<div style="font-size:13px;font-weight:700;color:var(--green,#a6e3a1);">' +
      '<span id="' +
      PROXY_BALANCE_DOM.balanceValue +
      '">—</span>' +
      ' <span id="' +
      PROXY_BALANCE_DOM.unavailableIndicator +
      '" style="display:none;font-size:9px;color:var(--text-dim);font-weight:500;">balance unavailable</span>' +
      '</div>' +
      '<div style="font-size:8px;color:var(--text-dim);text-transform:uppercase;">Proxy Balance</div>';
    // Append into the session grid so it sits below the existing four cards.
    sessionPanel.appendChild(balanceCard);
  }

  if (balanceCard) {
    const valueEl = balanceCard.querySelector(
      '#' + PROXY_BALANCE_DOM.balanceValue,
    ) as HTMLElement | null;
    const unavailEl = balanceCard.querySelector(
      '#' + PROXY_BALANCE_DOM.unavailableIndicator,
    ) as HTMLElement | null;
    if (valueEl) {
      valueEl.textContent =
        state.lastKnownBalance === null ? '—' : formatBalanceUsd(state.lastKnownBalance);
    }
    if (unavailEl) {
      unavailEl.style.display = state.fetchFailed ? 'inline' : 'none';
    }
  }

  // ─── Low-balance warning above the model selector ────────────
  let warningRow = doc.getElementById(PROXY_BALANCE_DOM.warningRow);
  const showWarning =
    state.lastKnownBalance !== null && isLowBalance(state.lastKnownBalance, threshold);

  if (!showWarning) {
    if (warningRow && warningRow.parentElement) {
      warningRow.parentElement.removeChild(warningRow);
    }
    return { balanceCard: balanceCard ?? null, warningRow: null };
  }

  if (!warningRow) {
    warningRow = doc.createElement('div');
    warningRow.id = PROXY_BALANCE_DOM.warningRow;
    warningRow.setAttribute('role', 'alert');
    warningRow.setAttribute(
      'style',
      'margin:6px 16px 0;padding:6px 10px;border-radius:6px;background:rgba(243,139,168,0.15);' +
        'border:1px solid rgba(243,139,168,0.45);color:var(--text-primary);font-size:11px;' +
        'display:flex;align-items:center;gap:6px;',
    );
    insertWarningAboveModelSelector(doc, warningRow);
  }

  const balanceText =
    state.lastKnownBalance === null ? '$0.00' : formatBalanceUsd(state.lastKnownBalance);
  warningRow.innerHTML =
    '<span aria-hidden="true">⚠️</span>' +
    '<span><strong>Low proxy balance:</strong> ' +
    balanceText +
    ' remaining. Top up before continuing.</span>';

  return { balanceCard: balanceCard ?? null, warningRow };
}

// ─── DOM placement helpers ─────────────────────────────────────

/**
 * Find the Session stats grid (the container of `#stat-status`,
 * `#stat-messages`, `#stat-tokens`, `#stat-cost`). The panel layout uses a
 * 2-column CSS grid; we anchor the new balance card to the same grid so it
 * inherits the same look.
 */
function findSessionPanel(doc: Document): HTMLElement | null {
  const status = doc.getElementById('stat-status');
  if (!status) return null;
  // The stats grid is the parent of the status card.
  const grid = status.parentElement;
  return grid as HTMLElement | null;
}

/**
 * Insert the low-balance warning row immediately above the model selector.
 *
 * The renderer historically uses different selectors for the model dropdown
 * depending on context (`#openmythos-model-select`, `.prov-model-select`,
 * `#spec-model-select`, `#agent-model-sel`). We try a few in order and fall
 * back to inserting before `#input-bar` so the warning is at least visible
 * just above the chat input area.
 */
function insertWarningAboveModelSelector(doc: Document, row: HTMLElement): void {
  const candidates = [
    '#openmythos-model-select',
    '.prov-model-select',
    '#spec-model-select',
    '#agent-model-sel',
    '#input-bar',
  ];
  for (const sel of candidates) {
    const target = doc.querySelector(sel) as HTMLElement | null;
    if (target && target.parentElement) {
      target.parentElement.insertBefore(row, target);
      return;
    }
  }
  // Last resort: append to body so the warning is at least surfaced.
  if (doc.body) doc.body.appendChild(row);
}
