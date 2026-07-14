/**
 * Internationalization (i18n) System for NeuroNest Renderer
 *
 * Provides locale detection, string resolution, ICU MessageFormat
 * support for pluralization/interpolation, and runtime language switching.
 *
 * Architecture:
 * - System locale detection via navigator.language
 * - User override persisted via IPC (i18n:set-locale / i18n:get-locale)
 * - Fallback chain: user override → system locale → 'en'
 * - ICU MessageFormat for plurals, select, and interpolation
 * - Event-driven updates — components subscribe to locale changes
 *
 * Requirements: 24.1
 */

// ─── Types ──────────────────────────────────────────────────────

export type LocaleCode = string;

export interface LocaleStrings {
  [key: string]: string;
}

export interface LocaleMetadata {
  code: LocaleCode;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
  coverage: number; // percentage of translated strings (0-100)
}

export type LocaleChangeListener = (locale: LocaleCode) => void;

// ─── ICU MessageFormat (Lightweight Implementation) ──────────────

/**
 * Lightweight ICU MessageFormat parser supporting:
 * - Simple interpolation: {name}
 * - Plural: {count, plural, one {# item} other {# items}}
 * - Select: {gender, select, male {He} female {She} other {They}}
 */
function formatMessage(template: string, values: Record<string, string | number> = {}): string {
  if (!template) return '';

  // Handle plural and select patterns
  const result = template.replace(
    /\{(\w+),\s*(plural|select),\s*([^}]+(?:\{[^}]*\}[^}]*)*)\}/g,
    (_match, variable, type, cases) => {
      const value = values[variable];
      if (type === 'plural') {
        return resolvePlural(cases, value as number);
      }
      if (type === 'select') {
        return resolveSelect(cases, String(value));
      }
      return String(value ?? '');
    }
  );

  // Handle simple interpolation: {variableName}
  return result.replace(/\{(\w+)\}/g, (_match, key) => {
    return String(values[key] ?? `{${key}}`);
  });
}

/**
 * Resolve ICU plural cases.
 * Supports: =0, =1, zero, one, two, few, many, other
 */
function resolvePlural(casesStr: string, count: number): string {
  const cases = parseCases(casesStr);
  const exactKey = `=${count}`;
  if (cases[exactKey]) {
    return cases[exactKey].replace(/#/g, String(count));
  }

  // CLDR plural category (simplified for common languages)
  let category: string;
  if (count === 0) category = 'zero';
  else if (count === 1) category = 'one';
  else if (count === 2) category = 'two';
  else category = 'other';

  const template = cases[category] ?? cases['other'] ?? '';
  return template.replace(/#/g, String(count));
}

/**
 * Resolve ICU select cases.
 */
function resolveSelect(casesStr: string, value: string): string {
  const cases = parseCases(casesStr);
  return cases[value] ?? cases['other'] ?? '';
}

/**
 * Parse ICU case expressions like: one {# file} other {# files}
 */
function parseCases(casesStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /(\w+|=\d+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(casesStr)) !== null) {
    const key = match[1] as string;
    const value = match[2] as string;
    result[key] = value;
  }
  return result;
}

// ─── Supported Locales Registry ─────────────────────────────────

export const SUPPORTED_LOCALES: LocaleMetadata[] = [
  { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr', coverage: 100 },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文', direction: 'ltr', coverage: 0 },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', direction: 'ltr', coverage: 0 },
  { code: 'ko', name: 'Korean', nativeName: '한국어', direction: 'ltr', coverage: 0 },
  { code: 'de', name: 'German', nativeName: 'Deutsch', direction: 'ltr', coverage: 0 },
  { code: 'es', name: 'Spanish', nativeName: 'Español', direction: 'ltr', coverage: 0 },
  { code: 'fr', name: 'French', nativeName: 'Français', direction: 'ltr', coverage: 0 },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', direction: 'ltr', coverage: 0 },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', direction: 'ltr', coverage: 0 },
];

// ─── I18n System ────────────────────────────────────────────────

/** In-memory cache of loaded locale strings */
const localeCache: Map<LocaleCode, LocaleStrings> = new Map();

/** Current active locale */
let currentLocale: LocaleCode = 'en';

/** English fallback strings (always loaded) */
let fallbackStrings: LocaleStrings = {};

/** Listeners for locale change events */
const changeListeners: Set<LocaleChangeListener> = new Set();

/**
 * Detect the system locale from the browser environment.
 * Returns a BCP 47 language tag normalized to match our locale file names.
 */
function detectSystemLocale(): LocaleCode {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav) return 'en';

  const raw = nav.language || (nav as any).userLanguage || 'en';
  // Normalize: zh-Hans-CN → zh-CN, pt-BR stays pt-BR
  const normalized = raw.replace('zh-Hans', 'zh').replace('zh-Hant', 'zh');

  // Check if we have an exact match
  const exact = SUPPORTED_LOCALES.find(l => l.code === normalized);
  if (exact) return exact.code;

  // Check base language match (e.g., 'de-AT' → 'de')
  const base = normalized.split('-')[0];
  const baseMatch = SUPPORTED_LOCALES.find(l => l.code === base);
  if (baseMatch) return baseMatch.code;

  return 'en';
}

/**
 * Load locale strings from the locales directory.
 * Uses dynamic import for JSON files.
 */
async function loadLocaleStrings(locale: LocaleCode): Promise<LocaleStrings> {
  if (localeCache.has(locale)) {
    return localeCache.get(locale)!;
  }

  try {
    // Dynamic import of JSON locale file
    const module = await import(`./locales/${locale}.json`);
    const strings: LocaleStrings = module.default ?? module;
    localeCache.set(locale, strings);
    return strings;
  } catch (err) {
    console.warn(`[i18n] Failed to load locale "${locale}", falling back to English`, err);
    return fallbackStrings;
  }
}

/**
 * Initialize the i18n system.
 * Detects locale, loads strings, and sets up the translation function.
 *
 * Call this once during app bootstrap.
 */
export async function initI18n(): Promise<void> {
  // Always load English as the fallback
  fallbackStrings = await loadLocaleStrings('en');

  // Determine locale: user override → system locale → 'en'
  let userLocale: LocaleCode | null = null;
  try {
    const api = (window as any).electronAPI;
    if (api?.invoke) {
      userLocale = await api.invoke('i18n:get-locale');
    }
  } catch {
    // IPC not available — fall through to system detection
  }

  const resolvedLocale = userLocale || detectSystemLocale();
  await setLocale(resolvedLocale, false);
}

/**
 * Set the active locale at runtime. Loads strings and notifies listeners.
 *
 * @param locale - BCP 47 locale code
 * @param persist - Whether to persist the choice via IPC (default: true)
 */
export async function setLocale(locale: LocaleCode, persist = true): Promise<void> {
  const supported = SUPPORTED_LOCALES.find(l => l.code === locale);
  if (!supported) {
    console.warn(`[i18n] Unsupported locale "${locale}", falling back to English`);
    locale = 'en';
  }

  await loadLocaleStrings(locale);
  currentLocale = locale;

  // Set document direction for RTL support
  if (typeof document !== 'undefined') {
    const meta = SUPPORTED_LOCALES.find(l => l.code === locale);
    document.documentElement.dir = meta?.direction ?? 'ltr';
    document.documentElement.lang = locale;
  }

  // Persist user preference via IPC
  if (persist) {
    try {
      const api = (window as any).electronAPI;
      if (api?.invoke) {
        await api.invoke('i18n:set-locale', locale);
      }
    } catch {
      // Persist failure is non-fatal
    }
  }

  // Notify listeners
  for (const listener of changeListeners) {
    try {
      listener(locale);
    } catch (err) {
      console.error('[i18n] Listener error:', err);
    }
  }
}

/**
 * Get the current active locale code.
 */
export function getLocale(): LocaleCode {
  return currentLocale;
}

/**
 * Get available locales with metadata.
 */
export function getAvailableLocales(): LocaleMetadata[] {
  return [...SUPPORTED_LOCALES];
}

/**
 * Translate a key to a localized string.
 *
 * @param key - Dot-notation key (e.g., 'sidebar.chat')
 * @param values - Interpolation values for ICU MessageFormat
 * @returns Resolved string, or the key itself if not found
 */
export function t(key: string, values?: Record<string, string | number>): string {
  const strings = localeCache.get(currentLocale) ?? fallbackStrings;
  const template = strings[key] ?? fallbackStrings[key] ?? key;
  if (values) {
    return formatMessage(template, values);
  }
  return template;
}

/**
 * Subscribe to locale change events.
 * Returns an unsubscribe function.
 */
export function onLocaleChange(listener: LocaleChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Calculate translation coverage for a locale.
 * Returns percentage (0-100) of keys translated relative to English base.
 */
export function getLocaleCoverage(locale: LocaleCode): number {
  const localeStrings = localeCache.get(locale);
  if (!localeStrings || !fallbackStrings) return 0;
  if (locale === 'en') return 100;

  const totalKeys = Object.keys(fallbackStrings).length;
  if (totalKeys === 0) return 0;

  const translatedKeys = Object.keys(localeStrings).filter(
    key => localeStrings[key] && localeStrings[key] !== fallbackStrings[key]
  ).length;

  return Math.round((translatedKeys / totalKeys) * 100);
}

/**
 * Update the coverage metadata for all loaded locales.
 * Should be called after locales are loaded.
 */
export function refreshCoverageStats(): void {
  for (const meta of SUPPORTED_LOCALES) {
    if (localeCache.has(meta.code)) {
      meta.coverage = getLocaleCoverage(meta.code);
    }
  }
}

/**
 * Preload all locale files (useful for coverage dashboard).
 */
export async function preloadAllLocales(): Promise<void> {
  await Promise.all(
    SUPPORTED_LOCALES.map(meta => loadLocaleStrings(meta.code).catch(() => {}))
  );
  refreshCoverageStats();
}
