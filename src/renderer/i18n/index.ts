/**
 * i18n Module — Public API
 *
 * Re-exports the i18n system and language selector for use by renderer components.
 *
 * Usage:
 *   import { t, initI18n, setLocale } from '../i18n';
 *   import { createLanguageSelector } from '../i18n';
 */

export {
  initI18n,
  t,
  setLocale,
  getLocale,
  getAvailableLocales,
  onLocaleChange,
  getLocaleCoverage,
  preloadAllLocales,
  refreshCoverageStats,
  SUPPORTED_LOCALES,
  type LocaleCode,
  type LocaleStrings,
  type LocaleMetadata,
  type LocaleChangeListener,
} from './i18n-system';

export {
  createLanguageSelector,
  fetchAvailableLocalesIPC,
  type LanguageSelectorOptions,
  type I18nIPCContract,
} from './language-selector';
