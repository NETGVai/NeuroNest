/**
 * Theme Revision Service — Live theme updates for structured response surfaces.
 *
 * Provides a subscription-based theme revision model that updates mounted and
 * future surfaces when the active theme changes, without recomputing canonical
 * content. Each revision increment triggers subscribers with the new token map.
 *
 * Integrates with:
 * - The legacy `theme-changed` IPC channel for cross-process theme switching
 * - The legacy `applyTheme` function's `data-theme` attribute for rollout compat
 * - The structured renderer's CSS custom property layer
 *
 * Requirements: 17.1–17.4, 17.8, 21.11, 22.5
 */

import {
  SEMANTIC_TOKEN_NAMES,
  THEME_TOKEN_REGISTRY,
  TOKEN_CSS_PREFIX,
  tokenToCssProperty,
  type SemanticTokenMap,
  type SemanticTokenName,
  type SupportedThemeId,
  SUPPORTED_THEMES,
} from './semantic-tokens';

// ─── Types ──────────────────────────────────────────────────────

/** Snapshot of the current theme state at a given revision. */
export interface ThemeRevisionSnapshot {
  /** Monotonically increasing revision counter. */
  readonly revision: number;
  /** The active theme identifier. */
  readonly themeId: SupportedThemeId;
  /** The resolved token values for the active theme. */
  readonly tokens: SemanticTokenMap;
  /** Whether the current theme is a high-contrast variant. */
  readonly highContrast: boolean;
  /** Whether the current theme is considered "dark" for color-scheme. */
  readonly isDark: boolean;
}

/** Callback type for theme revision subscribers. */
export type ThemeRevisionListener = (snapshot: ThemeRevisionSnapshot) => void;

/** Unsubscribe handle returned by subscribe(). */
export type ThemeRevisionUnsubscribe = () => void;

/** Options for the theme revision service. */
export interface ThemeRevisionServiceOptions {
  /** Initial theme to apply. Defaults to 'dark'. */
  readonly initialTheme?: SupportedThemeId;
  /**
   * Root element to apply CSS custom properties to.
   * Defaults to document.documentElement when in browser.
   * Pass null in test environments.
   */
  readonly rootElement?: HTMLElement | null;
  /**
   * Whether to observe data-theme attribute on root for legacy compat.
   * Defaults to true in browser environments.
   */
  readonly observeLegacy?: boolean;
}

// ─── Theme Classification ───────────────────────────────────────

const DARK_THEMES: ReadonlySet<SupportedThemeId> = new Set([
  'dark',
  'midnight',
  'terminal',
  'high-contrast-dark',
]);

const HIGH_CONTRAST_THEMES: ReadonlySet<SupportedThemeId> = new Set([
  'high-contrast-dark',
  'high-contrast-light',
]);

/**
 * Maps legacy theme names (from the existing renderer) to supported theme IDs.
 * This bridges the existing `applyTheme()` which uses theme names without
 * the high-contrast variants.
 */
const LEGACY_THEME_MAP: Readonly<Record<string, SupportedThemeId>> = {
  dark: 'dark',
  light: 'light',
  midnight: 'midnight',
  sepia: 'sepia',
  terminal: 'terminal',
  zen: 'zen',
};

export function resolveLegacyThemeId(legacyName: string): SupportedThemeId | undefined {
  return LEGACY_THEME_MAP[legacyName];
}

export function isHighContrast(themeId: SupportedThemeId): boolean {
  return HIGH_CONTRAST_THEMES.has(themeId);
}

export function isDarkTheme(themeId: SupportedThemeId): boolean {
  return DARK_THEMES.has(themeId);
}

export function isSupportedTheme(id: string): id is SupportedThemeId {
  return (SUPPORTED_THEMES as readonly string[]).includes(id);
}

// ─── CSS Custom Property Application ────────────────────────────

/**
 * Applies the full set of semantic token CSS custom properties to a root element.
 * Does not touch any legacy CSS variables — those continue to be managed by
 * the existing theme system.
 */
export function applySemanticTokensToRoot(
  root: HTMLElement,
  tokens: SemanticTokenMap,
): void {
  for (const name of SEMANTIC_TOKEN_NAMES) {
    root.style.setProperty(tokenToCssProperty(name), tokens[name]);
  }
}

/**
 * Removes all semantic token CSS custom properties from a root element.
 */
export function removeSemanticTokensFromRoot(root: HTMLElement): void {
  for (const name of SEMANTIC_TOKEN_NAMES) {
    root.style.removeProperty(tokenToCssProperty(name));
  }
}

// ─── Theme Revision Service ─────────────────────────────────────

/**
 * Manages theme state and notifies subscribers when the theme changes.
 *
 * This service:
 * 1. Maintains a monotonically increasing revision counter
 * 2. Applies semantic tokens as CSS custom properties on the root element
 * 3. Notifies subscribers synchronously on theme changes
 * 4. Optionally observes the legacy data-theme attribute for compat
 * 5. Preserves current legacy theme behavior (legacy CSS vars are untouched)
 */
export class ThemeRevisionService {
  private revision = 0;
  private themeId: SupportedThemeId;
  private tokens: SemanticTokenMap;
  private readonly rootElement: HTMLElement | null;
  private readonly listeners = new Set<ThemeRevisionListener>();
  private mutationObserver: MutationObserver | null = null;
  private disposed = false;

  constructor(options: ThemeRevisionServiceOptions = {}) {
    this.themeId = options.initialTheme ?? 'dark';
    this.tokens = THEME_TOKEN_REGISTRY[this.themeId];
    this.rootElement = options.rootElement !== undefined ? options.rootElement : null;

    // Apply initial tokens
    if (this.rootElement) {
      applySemanticTokensToRoot(this.rootElement, this.tokens);
    }

    // Optionally observe legacy theme changes via data-theme attribute
    if (options.observeLegacy !== false && this.rootElement && typeof MutationObserver !== 'undefined') {
      this.startLegacyObserver();
    }
  }

  /** Get the current theme revision snapshot. */
  getSnapshot(): ThemeRevisionSnapshot {
    return Object.freeze({
      revision: this.revision,
      themeId: this.themeId,
      tokens: this.tokens,
      highContrast: isHighContrast(this.themeId),
      isDark: isDarkTheme(this.themeId),
    });
  }

  /** Get the current revision number. */
  getRevision(): number {
    return this.revision;
  }

  /** Get the current theme ID. */
  getThemeId(): SupportedThemeId {
    return this.themeId;
  }

  /** Get the current resolved tokens. */
  getTokens(): SemanticTokenMap {
    return this.tokens;
  }

  /** Resolve a single token value for the current theme. */
  resolveToken(token: SemanticTokenName): string {
    return this.tokens[token];
  }

  /**
   * Set the active theme. If different from current, increments revision,
   * applies tokens, and notifies subscribers.
   *
   * Returns true if the theme actually changed.
   */
  setTheme(themeId: SupportedThemeId): boolean {
    if (this.disposed) return false;
    if (this.themeId === themeId) return false;

    this.themeId = themeId;
    this.tokens = THEME_TOKEN_REGISTRY[themeId];
    this.revision++;

    // Apply CSS custom properties to root element
    if (this.rootElement) {
      applySemanticTokensToRoot(this.rootElement, this.tokens);
    }

    // Notify subscribers
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }

    return true;
  }

  /**
   * Handle a legacy theme-changed event (from IPC or data-theme attribute).
   * Maps the legacy name to a supported theme ID and applies it.
   *
   * Returns true if the theme changed.
   */
  handleLegacyThemeChange(legacyName: string): boolean {
    if (this.disposed) return false;
    const resolved = resolveLegacyThemeId(legacyName);
    if (resolved === undefined) return false;
    return this.setTheme(resolved);
  }

  /**
   * Subscribe to theme revision changes.
   * The listener is called synchronously whenever the theme changes.
   * Returns an unsubscribe function.
   */
  subscribe(listener: ThemeRevisionListener): ThemeRevisionUnsubscribe {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get the count of active subscribers.
   */
  getSubscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Dispose the service: remove observers, clear listeners, clean up CSS properties.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    if (this.rootElement) {
      removeSemanticTokensFromRoot(this.rootElement);
    }
  }

  /** Whether the service has been disposed. */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ─── Private ─────────────────────────────────────────────────

  private startLegacyObserver(): void {
    if (!this.rootElement) return;

    this.mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'data-theme'
        ) {
          const attr = this.rootElement!.getAttribute('data-theme');
          if (attr) {
            this.handleLegacyThemeChange(attr);
          }
        }
      }
    });

    this.mutationObserver.observe(this.rootElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
}

// ─── Convenience: CSS variable reference helper ─────────────────

/**
 * Creates a style object (Record<string, string>) that uses semantic tokens
 * via CSS var() references. This is the recommended way for surfaces to
 * build inline styles without hard-coding theme-specific colors.
 *
 * Example:
 *   const styles = buildTokenStyles({
 *     color: 'text-primary',
 *     background: 'surface-container',
 *     borderRadius: 'radius-sm',
 *   });
 *   // Returns: { color: 'var(--nn-sr-text-primary)', background: 'var(--nn-sr-surface-container)', ... }
 */
export function buildTokenStyles(
  mapping: Partial<Record<string, SemanticTokenName>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [prop, token] of Object.entries(mapping)) {
    if (token !== undefined) {
      result[prop] = `var(${TOKEN_CSS_PREFIX}${token})`;
    }
  }
  return result;
}
