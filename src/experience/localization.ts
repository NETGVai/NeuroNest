/**
 * Localization / internationalization contract for user-visible experience
 * strings, numbers, durations, and keyboard shortcuts
 * (FUT-PKG-07-EXPERIENCE/T-007).
 *
 * NN-UI-012 requires that user-visible labels, status, errors, durations,
 * numbers, and shortcuts are localized, that the language catalog supports at
 * least the declared 20+ languages, and that English is NOT hardcoded into
 * workflows. NN-UI-011 folds localization into the accessibility floor.
 *
 * This module is a headless, DOM-free LOCALIZATION CONTRACT: it defines the
 * supported languages, the required message-key surface, a catalog shape, and
 * pure formatters for numbers/durations/shortcuts driven by locale data (via
 * the platform `Intl` API, which is present in the Electron main/renderer
 * runtimes). It verifies catalog COMPLETENESS so a missing/empty localized
 * string is a visible failure rather than a silent English fallback baked into
 * a workflow. It does NOT translate text itself — the actual translations are
 * supplied per language; this contract guarantees they are present and that no
 * workflow resolves a hardcoded English literal.
 *
 * Design anchors: D-10, D-12–D-14 (experience surfaces), D-22 (verification).
 * Requirements: NN-UI-012, NN-UI-011, NN-INV-013.
 */

// ─── Supported languages (NN-UI-012: at least 20+ declared) ─────────────────

/**
 * The declared supported languages (BCP-47 primary subtags). NN-UI-012 requires
 * "at least the declared 20+ languages". This list is the catalog contract:
 * every language here MUST have a complete message catalog, and the count is
 * asserted to be ≥ 20 so the floor can never silently shrink.
 */
export const SUPPORTED_LANGUAGES = Object.freeze([
  'en', // English
  'es', // Spanish
  'fr', // French
  'de', // German
  'it', // Italian
  'pt', // Portuguese
  'nl', // Dutch
  'ru', // Russian
  'pl', // Polish
  'tr', // Turkish
  'ar', // Arabic (RTL)
  'he', // Hebrew (RTL)
  'hi', // Hindi
  'ja', // Japanese
  'ko', // Korean
  'zh', // Chinese
  'vi', // Vietnamese
  'th', // Thai
  'id', // Indonesian
  'uk', // Ukrainian
  'cs', // Czech
  'sv', // Swedish
] as const);

export type LanguageTag = (typeof SUPPORTED_LANGUAGES)[number];

/** The minimum number of declared languages required by NN-UI-012. */
export const MIN_SUPPORTED_LANGUAGES = 20;

/** Languages that render right-to-left (affects shortcut/text direction hints). */
export const RTL_LANGUAGES: ReadonlySet<LanguageTag> = new Set<LanguageTag>(['ar', 'he']);

/** True when a supported language renders right-to-left. */
export function isRtl(language: LanguageTag): boolean {
  return RTL_LANGUAGES.has(language);
}

// ─── Message keys (the localized user-visible surface) ──────────────────────

/**
 * The required user-visible message keys. NN-UI-012 enumerates the localized
 * surface: labels, status, errors, durations, and shortcuts. A workflow renders
 * a key through {@link Localizer.t}, never an English literal, so the catalog is
 * the single source of user-visible text and completeness is checkable.
 */
export const REQUIRED_MESSAGE_KEYS = Object.freeze([
  // Labels
  'label.send',
  'label.cancel',
  'label.approve',
  'label.reject',
  'label.retry',
  'label.settings',
  // Status
  'status.connecting',
  'status.streaming',
  'status.completed',
  'status.offline',
  // Errors
  'error.network',
  'error.unauthorized',
  'error.timeout',
  // Duration/number units (patterns are localized, values are Intl-formatted)
  'unit.seconds',
  'unit.minutes',
  // Shortcut action names
  'shortcut.newChat',
  'shortcut.openPalette',
  'shortcut.focusEditor',
] as const);

export type MessageKey = (typeof REQUIRED_MESSAGE_KEYS)[number];

/** A per-language message catalog: every required key mapped to localized text. */
export type MessageCatalog = Readonly<Record<MessageKey, string>>;

/** The full catalog set keyed by language tag. */
export type LanguageCatalogs = Readonly<Partial<Record<LanguageTag, MessageCatalog>>>;

// ─── Catalog completeness verification (no hardcoded English) ───────────────

/** One localization completeness finding. */
export interface LocalizationFinding {
  readonly code: string;
  readonly severity: 'critical' | 'advisory';
  readonly message: string;
  readonly language?: LanguageTag;
  readonly key?: MessageKey;
}

/**
 * Verify the language catalog set is complete: every supported language has a
 * catalog, every catalog defines every required key with a non-empty string,
 * and the declared language count meets the 20+ floor. A missing language, a
 * missing key, or an empty string is a CRITICAL finding so a workflow can never
 * silently fall back to a hardcoded English literal (NN-UI-012). Returns every
 * finding (empty = complete). This is the machine-checkable core of
 * V-UI-001/localization-responsive.
 */
export function verifyCatalogCompleteness(catalogs: LanguageCatalogs): LocalizationFinding[] {
  const findings: LocalizationFinding[] = [];

  if (SUPPORTED_LANGUAGES.length < MIN_SUPPORTED_LANGUAGES) {
    findings.push({
      code: 'insufficient-language-count',
      severity: 'critical',
      message: `only ${SUPPORTED_LANGUAGES.length} languages declared; NN-UI-012 requires at least ${MIN_SUPPORTED_LANGUAGES}`,
    });
  }

  for (const lang of SUPPORTED_LANGUAGES) {
    const catalog = catalogs[lang];
    if (!catalog) {
      findings.push({
        code: 'missing-language-catalog',
        severity: 'critical',
        message: `no message catalog for supported language ${lang}`,
        language: lang,
      });
      continue;
    }
    for (const key of REQUIRED_MESSAGE_KEYS) {
      const value = catalog[key];
      if (value === undefined || value === null || String(value).trim().length === 0) {
        findings.push({
          code: 'missing-message',
          severity: 'critical',
          message: `language ${lang} is missing localized text for key ${key}`,
          language: lang,
          key,
        });
      }
    }
  }

  return findings;
}

/** True when any localization finding is release-blocking. */
export function hasCriticalLocalizationFinding(findings: readonly LocalizationFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}

// ─── Localizer (label/status/error resolution) ──────────────────────────────

/**
 * A localizer bound to one language and catalog. `t` resolves a required key to
 * its localized string; a missing key THROWS (a visible failure) rather than
 * returning an English literal, so a hardcoded-English fallback can never leak
 * into a workflow (NN-UI-012). Numbers/durations/shortcuts are formatted via the
 * platform `Intl` API for the bound locale.
 */
export class Localizer {
  constructor(
    readonly language: LanguageTag,
    private readonly catalog: MessageCatalog,
  ) {}

  /** The text direction for the bound language. */
  get direction(): 'ltr' | 'rtl' {
    return isRtl(this.language) ? 'rtl' : 'ltr';
  }

  /** Resolve a required message key to localized text (throws if missing). */
  t(key: MessageKey): string {
    const value = this.catalog[key];
    if (value === undefined || value === null || String(value).trim().length === 0) {
      throw new Error(`missing localized message for key ${key} in language ${this.language}`);
    }
    return value;
  }

  /** Format a number for the bound locale (NN-UI-012 localized numbers). */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.language, options).format(value);
  }

  /**
   * Format a duration in milliseconds as a localized "N unit" string using the
   * bound locale's number formatting plus the catalog's unit label. Sub-minute
   * durations render seconds; longer durations render whole minutes. The number
   * is Intl-formatted so grouping/decimal separators are locale-correct
   * (NN-UI-012 localized durations).
   */
  formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) {
      return `${this.formatNumber(totalSeconds)} ${this.t('unit.seconds')}`;
    }
    const minutes = Math.round(totalSeconds / 60);
    return `${this.formatNumber(minutes)} ${this.t('unit.minutes')}`;
  }
}

// ─── Keyboard shortcuts (localized action names, platform-correct chords) ────

/** A logical shortcut action bound to a localized name and a key chord. */
export interface ShortcutModel {
  /** The message key for the localized action name. */
  readonly actionKey: Extract<MessageKey, `shortcut.${string}`>;
  /**
   * The platform-agnostic accelerator using `Mod` for the primary modifier
   * (Cmd on macOS, Ctrl elsewhere). Rendered per platform by
   * {@link formatShortcut}.
   */
  readonly accelerator: string;
}

/** The supported platform profiles for shortcut rendering. */
export type PlatformProfile = 'mac' | 'win' | 'linux';

/**
 * Render a platform-agnostic accelerator into the correct per-platform display
 * string: `Mod` becomes `⌘` on macOS and `Ctrl` on Windows/Linux, and `Alt`
 * becomes `⌥` on macOS. This keeps shortcut display truthful per platform
 * profile (NN-UI-012 localized shortcuts across platform profiles).
 */
export function formatShortcut(accelerator: string, platform: PlatformProfile): string {
  const parts = accelerator.split('+').map((p) => p.trim());
  return parts
    .map((part) => {
      if (part === 'Mod') return platform === 'mac' ? '⌘' : 'Ctrl';
      if (part === 'Alt') return platform === 'mac' ? '⌥' : 'Alt';
      if (part === 'Shift') return platform === 'mac' ? '⇧' : 'Shift';
      return part;
    })
    .join(platform === 'mac' ? '' : '+');
}

/**
 * Build a localized, platform-correct shortcut label: the localized action name
 * followed by the platform-rendered chord. Uses {@link Localizer.t} so a missing
 * action name is a visible failure, never a hardcoded English label.
 */
export function localizedShortcutLabel(
  localizer: Localizer,
  shortcut: ShortcutModel,
  platform: PlatformProfile,
): string {
  return `${localizer.t(shortcut.actionKey)} (${formatShortcut(shortcut.accelerator, platform)})`;
}
