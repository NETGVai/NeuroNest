/**
 * Language Selector Component & Translation Coverage Dashboard
 *
 * Provides a UI component for selecting the display language and viewing
 * translation coverage statistics per locale.
 *
 * Architecture:
 * - Vanilla DOM component (consistent with project patterns)
 * - Integrates with i18n-system for locale switching
 * - Shows coverage percentage per language
 * - Wires IPC channels: i18n:set-locale, i18n:get-locale, i18n:available-locales
 *
 * Requirements: 24.4
 */

import {
  t,
  getLocale,
  setLocale,
  getAvailableLocales,
  onLocaleChange,
  preloadAllLocales,
  type LocaleCode,
  type LocaleMetadata,
} from './i18n-system';

// ─── Types ──────────────────────────────────────────────────────

export interface LanguageSelectorOptions {
  /** Show coverage percentages alongside language names */
  showCoverage?: boolean;
  /** Compact mode (dropdown only, no dashboard) */
  compact?: boolean;
  /** Called after locale change completes */
  onLocaleChanged?: (locale: LocaleCode) => void;
}

// ─── Language Selector Component ────────────────────────────────

/**
 * Creates and mounts the language selector component.
 * Returns an object with mount/unmount lifecycle methods and update triggers.
 */
export function createLanguageSelector(options: LanguageSelectorOptions = {}) {
  const { showCoverage = true, compact = false, onLocaleChanged } = options;

  let container: HTMLElement | null = null;
  let unsubLocale: (() => void) | null = null;

  function render(parent: HTMLElement): void {
    container = document.createElement('div');
    container.className = 'nn-language-selector';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', t('language.title'));

    if (compact) {
      renderCompact(container);
    } else {
      renderFull(container);
    }

    parent.appendChild(container);

    // Subscribe to locale changes for re-render
    unsubLocale = onLocaleChange(() => {
      if (container && container.parentElement) {
        const parent = container.parentElement;
        container.remove();
        render(parent);
      }
    });
  }

  function renderCompact(el: HTMLElement): void {
    const select = createLocaleDropdown();
    el.appendChild(select);
  }

  function renderFull(el: HTMLElement): void {
    // Header
    const header = document.createElement('h3');
    header.textContent = t('language.title');
    header.style.cssText = 'margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--text-primary, #e0e0e0);';
    el.appendChild(header);

    // Description
    const desc = document.createElement('p');
    desc.textContent = t('language.description');
    desc.style.cssText = 'margin: 0 0 12px; font-size: 12px; color: var(--text-dim, #888);';
    el.appendChild(desc);

    // Locale dropdown
    const dropdownRow = document.createElement('div');
    dropdownRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px;';

    const label = document.createElement('label');
    label.textContent = t('settings.language');
    label.style.cssText = 'font-size: 13px; color: var(--text-primary, #e0e0e0); min-width: 60px;';
    label.setAttribute('for', 'nn-locale-select');

    const select = createLocaleDropdown();
    select.id = 'nn-locale-select';

    dropdownRow.appendChild(label);
    dropdownRow.appendChild(select);
    el.appendChild(dropdownRow);

    // Fallback note
    const note = document.createElement('p');
    note.textContent = t('language.fallbackNote');
    note.style.cssText = 'margin: 0 0 16px; font-size: 11px; color: var(--text-dim, #666); font-style: italic;';
    el.appendChild(note);

    // Coverage dashboard
    if (showCoverage) {
      const dashboard = createCoverageDashboard();
      el.appendChild(dashboard);
    }
  }

  function createLocaleDropdown(): HTMLSelectElement {
    const select = document.createElement('select');
    select.style.cssText = `
      background: var(--input-bg, #2d2d2d);
      color: var(--text-primary, #e0e0e0);
      border: 1px solid var(--border-color, #555);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      cursor: pointer;
      min-width: 180px;
    `;
    select.setAttribute('aria-label', t('language.title'));

    const locales = getAvailableLocales();
    const current = getLocale();

    for (const locale of locales) {
      const option = document.createElement('option');
      option.value = locale.code;
      option.textContent = `${locale.nativeName} (${locale.name})`;
      if (locale.code === current) {
        option.selected = true;
      }
      select.appendChild(option);
    }

    select.addEventListener('change', async () => {
      const newLocale = select.value;
      await setLocale(newLocale);
      onLocaleChanged?.(newLocale);
    });

    return select;
  }

  function createCoverageDashboard(): HTMLElement {
    const dashboard = document.createElement('div');
    dashboard.className = 'nn-coverage-dashboard';
    dashboard.style.cssText = 'border-top: 1px solid var(--border-color, #333); padding-top: 12px;';

    const title = document.createElement('h4');
    title.textContent = t('language.coverage');
    title.style.cssText = 'margin: 0 0 10px; font-size: 13px; font-weight: 500; color: var(--text-primary, #e0e0e0);';
    dashboard.appendChild(title);

    const locales = getAvailableLocales();

    for (const locale of locales) {
      const row = createCoverageRow(locale);
      dashboard.appendChild(row);
    }

    return dashboard;
  }

  function createCoverageRow(locale: LocaleMetadata): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';

    // Language name
    const nameEl = document.createElement('span');
    nameEl.textContent = locale.nativeName;
    nameEl.style.cssText = 'font-size: 12px; color: var(--text-primary, #e0e0e0); min-width: 100px;';
    row.appendChild(nameEl);

    // Progress bar
    const barContainer = document.createElement('div');
    barContainer.style.cssText = 'flex: 1; height: 6px; background: var(--input-bg, #2d2d2d); border-radius: 3px; overflow: hidden;';

    const barFill = document.createElement('div');
    const coverage = locale.coverage;
    barFill.style.cssText = `
      height: 100%;
      width: ${coverage}%;
      background: ${coverage === 100 ? 'var(--success-color, #4caf50)' : coverage > 50 ? 'var(--warning-color, #ff9800)' : 'var(--info-color, #2196f3)'};
      border-radius: 3px;
      transition: width 0.3s ease;
    `;
    barContainer.appendChild(barFill);
    row.appendChild(barContainer);

    // Percentage
    const pctEl = document.createElement('span');
    pctEl.textContent = `${coverage}%`;
    pctEl.style.cssText = 'font-size: 11px; color: var(--text-dim, #888); min-width: 36px; text-align: right;';
    row.appendChild(pctEl);

    return row;
  }

  function unmount(): void {
    unsubLocale?.();
    unsubLocale = null;
    container?.remove();
    container = null;
  }

  return {
    mount: render,
    unmount,
    /** Force refresh coverage data */
    async refreshCoverage(): Promise<void> {
      await preloadAllLocales();
      if (container && container.parentElement) {
        const parent = container.parentElement;
        unmount();
        render(parent);
      }
    },
  };
}

// ─── IPC Wiring ─────────────────────────────────────────────────

/**
 * Register IPC handlers for i18n on the main process side.
 * This function should be called from the main process IPC setup.
 *
 * IPC Channels:
 * - i18n:set-locale  — Persist user locale preference
 * - i18n:get-locale  — Retrieve stored locale preference
 * - i18n:available-locales — Get list of supported locales with metadata
 *
 * Note: The actual IPC handler registration happens in src/main/ipc.ts.
 * This module provides the renderer-side contract.
 */
export interface I18nIPCContract {
  /** Set the user's preferred locale */
  'i18n:set-locale': (locale: LocaleCode) => Promise<void>;
  /** Get the stored user locale (null = use system default) */
  'i18n:get-locale': () => Promise<LocaleCode | null>;
  /** Get all available locales with metadata */
  'i18n:available-locales': () => Promise<LocaleMetadata[]>;
}

/**
 * Renderer-side helper to get available locales via IPC.
 * Falls back to local SUPPORTED_LOCALES if IPC is unavailable.
 */
export async function fetchAvailableLocalesIPC(): Promise<LocaleMetadata[]> {
  try {
    const api = (window as any).electronAPI;
    if (api?.invoke) {
      return await api.invoke('i18n:available-locales');
    }
  } catch {
    // IPC unavailable — use local data
  }
  return getAvailableLocales();
}
