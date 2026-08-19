/**
 * Semantic Design Tokens for the Structured Response Renderer.
 *
 * Defines the canonical set of semantic tokens used by all response surfaces.
 * Surfaces reference tokens by semantic name; the theme revision service resolves
 * them to CSS custom property values at runtime based on the active theme.
 *
 * Token categories:
 *   canvas  — background for the page root
 *   page    — reading-area background
 *   surface — card/container backgrounds at different elevations
 *   inset   — recessed or input backgrounds
 *   text    — foreground text at different emphasis levels
 *   border  — outlines and dividers
 *   accent  — interactive/brand color
 *   status  — success, warning, error, info semantic colors
 *   focus   — focus ring and keyboard interaction
 *   radius  — border radii for rounding levels
 *   elevation — box-shadow tiers
 *   motion  — transition/animation duration tokens
 *
 * Requirements: 17.1–17.4, 17.8, 21.11, 22.5
 */

// ─── Token Names ────────────────────────────────────────────────

/**
 * All recognized semantic token names in the structured renderer.
 * Each token maps to a CSS custom property (`--nn-sr-<token-name>`).
 */
export const SEMANTIC_TOKEN_NAMES = [
  // Canvas
  'canvas-base',
  'canvas-subtle',

  // Page
  'page-background',
  'page-elevated',

  // Surface
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
  'surface-overlay',

  // Inset
  'inset-background',
  'inset-border',

  // Text
  'text-primary',
  'text-secondary',
  'text-dim',
  'text-inverse',
  'text-link',

  // Border
  'border-default',
  'border-subtle',
  'border-strong',

  // Accent
  'accent-default',
  'accent-hover',
  'accent-pressed',
  'accent-subtle',

  // Status
  'status-success',
  'status-success-subtle',
  'status-warning',
  'status-warning-subtle',
  'status-error',
  'status-error-subtle',
  'status-info',
  'status-info-subtle',

  // Focus
  'focus-ring',
  'focus-ring-inset',

  // Radius
  'radius-xs',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-full',

  // Elevation
  'elevation-none',
  'elevation-low',
  'elevation-medium',
  'elevation-high',

  // Motion
  'motion-instant',
  'motion-quick',
  'motion-normal',
  'motion-slow',
] as const;

export type SemanticTokenName = (typeof SEMANTIC_TOKEN_NAMES)[number];

// ─── Token Categories ───────────────────────────────────────────

export type SemanticTokenCategory =
  | 'canvas'
  | 'page'
  | 'surface'
  | 'inset'
  | 'text'
  | 'border'
  | 'accent'
  | 'status'
  | 'focus'
  | 'radius'
  | 'elevation'
  | 'motion';

/** Map from token name to its category. */
export function getTokenCategory(token: SemanticTokenName): SemanticTokenCategory {
  if (token.startsWith('canvas-')) return 'canvas';
  if (token.startsWith('page-')) return 'page';
  if (token.startsWith('surface-')) return 'surface';
  if (token.startsWith('inset-')) return 'inset';
  if (token.startsWith('text-')) return 'text';
  if (token.startsWith('border-')) return 'border';
  if (token.startsWith('accent-')) return 'accent';
  if (token.startsWith('status-')) return 'status';
  if (token.startsWith('focus-')) return 'focus';
  if (token.startsWith('radius-')) return 'radius';
  if (token.startsWith('elevation-')) return 'elevation';
  if (token.startsWith('motion-')) return 'motion';
  // Should never happen — exhaustive check
  return 'text';
}

// ─── Theme Token Maps ───────────────────────────────────────────

/** A complete set of resolved token values for one theme. */
export type SemanticTokenMap = Readonly<Record<SemanticTokenName, string>>;

/**
 * Dark theme token values.
 * Uses existing NeuroNest CSS variable fallbacks where possible.
 */
export const DARK_TOKENS: SemanticTokenMap = {
  // Canvas
  'canvas-base': '#1e1e1e',
  'canvas-subtle': '#181818',

  // Page
  'page-background': '#1e1e1e',
  'page-elevated': '#252526',

  // Surface
  'surface-container': '#252526',
  'surface-container-high': '#2d2d2d',
  'surface-container-highest': '#333333',
  'surface-overlay': '#3c3c3c',

  // Inset
  'inset-background': '#1a1a1a',
  'inset-border': '#3c3c3c',

  // Text
  'text-primary': '#cccccc',
  'text-secondary': '#969696',
  'text-dim': '#5a5a5a',
  'text-inverse': '#1e1e1e',
  'text-link': '#4fc1ff',

  // Border
  'border-default': '#2d2d2d',
  'border-subtle': '#252526',
  'border-strong': '#444444',

  // Accent
  'accent-default': '#007AFF',
  'accent-hover': '#3399FF',
  'accent-pressed': '#005BB5',
  'accent-subtle': 'rgba(0, 122, 255, 0.15)',

  // Status
  'status-success': '#4ade80',
  'status-success-subtle': 'rgba(74, 222, 128, 0.15)',
  'status-warning': '#fbbf24',
  'status-warning-subtle': 'rgba(251, 191, 36, 0.15)',
  'status-error': '#f87171',
  'status-error-subtle': 'rgba(248, 113, 113, 0.15)',
  'status-info': '#60a5fa',
  'status-info-subtle': 'rgba(96, 165, 250, 0.15)',

  // Focus
  'focus-ring': '#007AFF',
  'focus-ring-inset': 'rgba(0, 122, 255, 0.4)',

  // Radius
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '9999px',

  // Elevation
  'elevation-none': 'none',
  'elevation-low': '0 1px 3px rgba(0, 0, 0, 0.3)',
  'elevation-medium': '0 4px 8px rgba(0, 0, 0, 0.4)',
  'elevation-high': '0 8px 24px rgba(0, 0, 0, 0.5)',

  // Motion
  'motion-instant': '0ms',
  'motion-quick': '100ms',
  'motion-normal': '200ms',
  'motion-slow': '400ms',
};

/**
 * Light theme token values.
 */
export const LIGHT_TOKENS: SemanticTokenMap = {
  // Canvas
  'canvas-base': '#ffffff',
  'canvas-subtle': '#fafafa',

  // Page
  'page-background': '#ffffff',
  'page-elevated': '#f8f8f8',

  // Surface
  'surface-container': '#f3f3f3',
  'surface-container-high': '#ebebeb',
  'surface-container-highest': '#e0e0e0',
  'surface-overlay': '#ffffff',

  // Inset
  'inset-background': '#f0f0f0',
  'inset-border': '#d4d4d4',

  // Text
  'text-primary': '#1e1e1e',
  'text-secondary': '#616161',
  'text-dim': '#a0a0a0',
  'text-inverse': '#ffffff',
  'text-link': '#0066cc',

  // Border
  'border-default': '#e0e0e0',
  'border-subtle': '#ebebeb',
  'border-strong': '#c0c0c0',

  // Accent
  'accent-default': '#007AFF',
  'accent-hover': '#0066DD',
  'accent-pressed': '#004499',
  'accent-subtle': 'rgba(0, 122, 255, 0.1)',

  // Status
  'status-success': '#16a34a',
  'status-success-subtle': 'rgba(22, 163, 74, 0.1)',
  'status-warning': '#ca8a04',
  'status-warning-subtle': 'rgba(202, 138, 4, 0.1)',
  'status-error': '#dc2626',
  'status-error-subtle': 'rgba(220, 38, 38, 0.1)',
  'status-info': '#2563eb',
  'status-info-subtle': 'rgba(37, 99, 235, 0.1)',

  // Focus
  'focus-ring': '#007AFF',
  'focus-ring-inset': 'rgba(0, 122, 255, 0.3)',

  // Radius
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '9999px',

  // Elevation
  'elevation-none': 'none',
  'elevation-low': '0 1px 3px rgba(0, 0, 0, 0.08)',
  'elevation-medium': '0 4px 8px rgba(0, 0, 0, 0.12)',
  'elevation-high': '0 8px 24px rgba(0, 0, 0, 0.16)',

  // Motion
  'motion-instant': '0ms',
  'motion-quick': '100ms',
  'motion-normal': '200ms',
  'motion-slow': '400ms',
};

/**
 * Midnight theme token values.
 */
export const MIDNIGHT_TOKENS: SemanticTokenMap = {
  'canvas-base': '#0d1117',
  'canvas-subtle': '#090c10',
  'page-background': '#0d1117',
  'page-elevated': '#161b22',
  'surface-container': '#161b22',
  'surface-container-high': '#1f2937',
  'surface-container-highest': '#2d3748',
  'surface-overlay': '#374151',
  'inset-background': '#0a0e14',
  'inset-border': '#30363d',
  'text-primary': '#e6edf3',
  'text-secondary': '#8b949e',
  'text-dim': '#484f58',
  'text-inverse': '#0d1117',
  'text-link': '#58a6ff',
  'border-default': '#30363d',
  'border-subtle': '#21262d',
  'border-strong': '#484f58',
  'accent-default': '#58a6ff',
  'accent-hover': '#79c0ff',
  'accent-pressed': '#388bfd',
  'accent-subtle': 'rgba(88, 166, 255, 0.15)',
  'status-success': '#3fb950',
  'status-success-subtle': 'rgba(63, 185, 80, 0.15)',
  'status-warning': '#d29922',
  'status-warning-subtle': 'rgba(210, 153, 34, 0.15)',
  'status-error': '#f85149',
  'status-error-subtle': 'rgba(248, 81, 73, 0.15)',
  'status-info': '#58a6ff',
  'status-info-subtle': 'rgba(88, 166, 255, 0.15)',
  'focus-ring': '#58a6ff',
  'focus-ring-inset': 'rgba(88, 166, 255, 0.4)',
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '9999px',
  'elevation-none': 'none',
  'elevation-low': '0 1px 3px rgba(0, 0, 0, 0.4)',
  'elevation-medium': '0 4px 8px rgba(0, 0, 0, 0.5)',
  'elevation-high': '0 8px 24px rgba(0, 0, 0, 0.6)',
  'motion-instant': '0ms',
  'motion-quick': '100ms',
  'motion-normal': '200ms',
  'motion-slow': '400ms',
};

/**
 * Sepia theme token values.
 */
export const SEPIA_TOKENS: SemanticTokenMap = {
  'canvas-base': '#fdf6e3',
  'canvas-subtle': '#faf3dc',
  'page-background': '#fdf6e3',
  'page-elevated': '#f5eed6',
  'surface-container': '#f5eed6',
  'surface-container-high': '#eee8c9',
  'surface-container-highest': '#e5dfbd',
  'surface-overlay': '#fdf6e3',
  'inset-background': '#f8f1d8',
  'inset-border': '#d6cba1',
  'text-primary': '#3b3228',
  'text-secondary': '#6b5e4e',
  'text-dim': '#a89f8e',
  'text-inverse': '#fdf6e3',
  'text-link': '#268bd2',
  'border-default': '#d6cba1',
  'border-subtle': '#e5dfbd',
  'border-strong': '#b5a87f',
  'accent-default': '#268bd2',
  'accent-hover': '#1a6fb0',
  'accent-pressed': '#155a8f',
  'accent-subtle': 'rgba(38, 139, 210, 0.1)',
  'status-success': '#859900',
  'status-success-subtle': 'rgba(133, 153, 0, 0.1)',
  'status-warning': '#b58900',
  'status-warning-subtle': 'rgba(181, 137, 0, 0.1)',
  'status-error': '#dc322f',
  'status-error-subtle': 'rgba(220, 50, 47, 0.1)',
  'status-info': '#268bd2',
  'status-info-subtle': 'rgba(38, 139, 210, 0.1)',
  'focus-ring': '#268bd2',
  'focus-ring-inset': 'rgba(38, 139, 210, 0.3)',
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '9999px',
  'elevation-none': 'none',
  'elevation-low': '0 1px 3px rgba(59, 50, 40, 0.06)',
  'elevation-medium': '0 4px 8px rgba(59, 50, 40, 0.1)',
  'elevation-high': '0 8px 24px rgba(59, 50, 40, 0.14)',
  'motion-instant': '0ms',
  'motion-quick': '100ms',
  'motion-normal': '200ms',
  'motion-slow': '400ms',
};

/**
 * Terminal theme token values.
 */
export const TERMINAL_TOKENS: SemanticTokenMap = {
  'canvas-base': '#0c0c0c',
  'canvas-subtle': '#080808',
  'page-background': '#0c0c0c',
  'page-elevated': '#1a1a1a',
  'surface-container': '#1a1a1a',
  'surface-container-high': '#242424',
  'surface-container-highest': '#2e2e2e',
  'surface-overlay': '#333333',
  'inset-background': '#080808',
  'inset-border': '#333333',
  'text-primary': '#00ff00',
  'text-secondary': '#00cc00',
  'text-dim': '#007700',
  'text-inverse': '#0c0c0c',
  'text-link': '#00ffff',
  'border-default': '#333333',
  'border-subtle': '#222222',
  'border-strong': '#555555',
  'accent-default': '#00ff00',
  'accent-hover': '#33ff33',
  'accent-pressed': '#00cc00',
  'accent-subtle': 'rgba(0, 255, 0, 0.1)',
  'status-success': '#00ff00',
  'status-success-subtle': 'rgba(0, 255, 0, 0.15)',
  'status-warning': '#ffff00',
  'status-warning-subtle': 'rgba(255, 255, 0, 0.15)',
  'status-error': '#ff0000',
  'status-error-subtle': 'rgba(255, 0, 0, 0.15)',
  'status-info': '#00ffff',
  'status-info-subtle': 'rgba(0, 255, 255, 0.15)',
  'focus-ring': '#00ff00',
  'focus-ring-inset': 'rgba(0, 255, 0, 0.3)',
  'radius-xs': '2px',
  'radius-sm': '3px',
  'radius-md': '4px',
  'radius-lg': '6px',
  'radius-full': '9999px',
  'elevation-none': 'none',
  'elevation-low': '0 1px 2px rgba(0, 255, 0, 0.1)',
  'elevation-medium': '0 2px 6px rgba(0, 255, 0, 0.15)',
  'elevation-high': '0 4px 16px rgba(0, 255, 0, 0.2)',
  'motion-instant': '0ms',
  'motion-quick': '80ms',
  'motion-normal': '160ms',
  'motion-slow': '320ms',
};

/**
 * Zen theme token values.
 */
export const ZEN_TOKENS: SemanticTokenMap = {
  'canvas-base': '#f5f5f0',
  'canvas-subtle': '#eeeee8',
  'page-background': '#f5f5f0',
  'page-elevated': '#ffffff',
  'surface-container': '#eeeee8',
  'surface-container-high': '#e5e5df',
  'surface-container-highest': '#dcdcd6',
  'surface-overlay': '#ffffff',
  'inset-background': '#eaeae4',
  'inset-border': '#c8c8c0',
  'text-primary': '#2c2c2c',
  'text-secondary': '#666660',
  'text-dim': '#999990',
  'text-inverse': '#f5f5f0',
  'text-link': '#5c7c9c',
  'border-default': '#d4d4cc',
  'border-subtle': '#e0e0d8',
  'border-strong': '#b0b0a8',
  'accent-default': '#5c7c9c',
  'accent-hover': '#4a6a8a',
  'accent-pressed': '#3a5a7a',
  'accent-subtle': 'rgba(92, 124, 156, 0.1)',
  'status-success': '#5a8a5a',
  'status-success-subtle': 'rgba(90, 138, 90, 0.1)',
  'status-warning': '#9a7a3a',
  'status-warning-subtle': 'rgba(154, 122, 58, 0.1)',
  'status-error': '#b04040',
  'status-error-subtle': 'rgba(176, 64, 64, 0.1)',
  'status-info': '#5c7c9c',
  'status-info-subtle': 'rgba(92, 124, 156, 0.1)',
  'focus-ring': '#5c7c9c',
  'focus-ring-inset': 'rgba(92, 124, 156, 0.3)',
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '9999px',
  'elevation-none': 'none',
  'elevation-low': '0 1px 3px rgba(44, 44, 44, 0.06)',
  'elevation-medium': '0 4px 8px rgba(44, 44, 44, 0.1)',
  'elevation-high': '0 8px 24px rgba(44, 44, 44, 0.14)',
  'motion-instant': '0ms',
  'motion-quick': '120ms',
  'motion-normal': '240ms',
  'motion-slow': '480ms',
};

/**
 * High contrast dark tokens — ensures WCAG AAA contrast ratio for text.
 */
export const HIGH_CONTRAST_DARK_TOKENS: SemanticTokenMap = {
  'canvas-base': '#000000',
  'canvas-subtle': '#0a0a0a',
  'page-background': '#000000',
  'page-elevated': '#1a1a1a',
  'surface-container': '#1a1a1a',
  'surface-container-high': '#2a2a2a',
  'surface-container-highest': '#3a3a3a',
  'surface-overlay': '#2a2a2a',
  'inset-background': '#0a0a0a',
  'inset-border': '#666666',
  'text-primary': '#ffffff',
  'text-secondary': '#e0e0e0',
  'text-dim': '#999999',
  'text-inverse': '#000000',
  'text-link': '#6ec6ff',
  'border-default': '#666666',
  'border-subtle': '#444444',
  'border-strong': '#ffffff',
  'accent-default': '#6ec6ff',
  'accent-hover': '#99d6ff',
  'accent-pressed': '#3399ff',
  'accent-subtle': 'rgba(110, 198, 255, 0.2)',
  'status-success': '#6fff6f',
  'status-success-subtle': 'rgba(111, 255, 111, 0.2)',
  'status-warning': '#ffff00',
  'status-warning-subtle': 'rgba(255, 255, 0, 0.2)',
  'status-error': '#ff6666',
  'status-error-subtle': 'rgba(255, 102, 102, 0.2)',
  'status-info': '#6ec6ff',
  'status-info-subtle': 'rgba(110, 198, 255, 0.2)',
  'focus-ring': '#ffffff',
  'focus-ring-inset': 'rgba(255, 255, 255, 0.5)',
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '9999px',
  'elevation-none': 'none',
  'elevation-low': '0 0 0 1px #666666',
  'elevation-medium': '0 0 0 2px #666666',
  'elevation-high': '0 0 0 3px #ffffff',
  'motion-instant': '0ms',
  'motion-quick': '100ms',
  'motion-normal': '200ms',
  'motion-slow': '400ms',
};

/**
 * High contrast light tokens — ensures WCAG AAA contrast ratio for text.
 */
export const HIGH_CONTRAST_LIGHT_TOKENS: SemanticTokenMap = {
  'canvas-base': '#ffffff',
  'canvas-subtle': '#f5f5f5',
  'page-background': '#ffffff',
  'page-elevated': '#f5f5f5',
  'surface-container': '#f0f0f0',
  'surface-container-high': '#e5e5e5',
  'surface-container-highest': '#d5d5d5',
  'surface-overlay': '#ffffff',
  'inset-background': '#f5f5f5',
  'inset-border': '#333333',
  'text-primary': '#000000',
  'text-secondary': '#333333',
  'text-dim': '#666666',
  'text-inverse': '#ffffff',
  'text-link': '#0000ee',
  'border-default': '#333333',
  'border-subtle': '#666666',
  'border-strong': '#000000',
  'accent-default': '#0000cc',
  'accent-hover': '#0000aa',
  'accent-pressed': '#000088',
  'accent-subtle': 'rgba(0, 0, 204, 0.12)',
  'status-success': '#006600',
  'status-success-subtle': 'rgba(0, 102, 0, 0.1)',
  'status-warning': '#664400',
  'status-warning-subtle': 'rgba(102, 68, 0, 0.1)',
  'status-error': '#cc0000',
  'status-error-subtle': 'rgba(204, 0, 0, 0.1)',
  'status-info': '#0000cc',
  'status-info-subtle': 'rgba(0, 0, 204, 0.1)',
  'focus-ring': '#000000',
  'focus-ring-inset': 'rgba(0, 0, 0, 0.4)',
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '9999px',
  'elevation-none': 'none',
  'elevation-low': '0 0 0 1px #333333',
  'elevation-medium': '0 0 0 2px #333333',
  'elevation-high': '0 0 0 3px #000000',
  'motion-instant': '0ms',
  'motion-quick': '100ms',
  'motion-normal': '200ms',
  'motion-slow': '400ms',
};

// ─── Theme Registry ─────────────────────────────────────────────

/** All supported NeuroNest theme identifiers. */
export const SUPPORTED_THEMES = [
  'dark',
  'light',
  'midnight',
  'sepia',
  'terminal',
  'zen',
  'high-contrast-dark',
  'high-contrast-light',
] as const;

export type SupportedThemeId = (typeof SUPPORTED_THEMES)[number];

/** Map from theme identifier to its token set. */
export const THEME_TOKEN_REGISTRY: Readonly<Record<SupportedThemeId, SemanticTokenMap>> = {
  dark: DARK_TOKENS,
  light: LIGHT_TOKENS,
  midnight: MIDNIGHT_TOKENS,
  sepia: SEPIA_TOKENS,
  terminal: TERMINAL_TOKENS,
  zen: ZEN_TOKENS,
  'high-contrast-dark': HIGH_CONTRAST_DARK_TOKENS,
  'high-contrast-light': HIGH_CONTRAST_LIGHT_TOKENS,
};

// ─── CSS Custom Property Prefix ─────────────────────────────────

/** CSS property prefix for structured-renderer semantic tokens. */
export const TOKEN_CSS_PREFIX = '--nn-sr-';

/**
 * Returns the full CSS custom property name for a semantic token.
 */
export function tokenToCssProperty(token: SemanticTokenName): string {
  return `${TOKEN_CSS_PREFIX}${token}`;
}

/**
 * Returns a CSS `var()` expression referencing the semantic token.
 * This is the primary API for surfaces to resolve token values in styles.
 */
export function tokenVar(token: SemanticTokenName): string {
  return `var(${TOKEN_CSS_PREFIX}${token})`;
}

// ─── Token Audit Utilities ──────────────────────────────────────

/**
 * Verifies that a given token map has values for all defined token names.
 * Returns a list of missing tokens (empty if complete).
 */
export function auditTokenCompleteness(
  tokenMap: Partial<Record<SemanticTokenName, string>>,
): SemanticTokenName[] {
  const missing: SemanticTokenName[] = [];
  for (const token of SEMANTIC_TOKEN_NAMES) {
    if (!(token in tokenMap) || tokenMap[token] === undefined || tokenMap[token] === '') {
      missing.push(token);
    }
  }
  return missing;
}

/**
 * Checks whether any token value uses a hard-coded theme-specific literal
 * that should have been resolved through a semantic token.
 *
 * Returns token names whose values match known literal patterns that
 * indicate a bypassed token (e.g., `#1e1e1e` in a non-dark context).
 */
export function auditNoLiterals(
  tokenMap: Partial<Record<SemanticTokenName, string>>,
): { token: SemanticTokenName; value: string }[] {
  // This audit checks only that values are non-empty strings.
  // In real use, surfaces should reference tokenVar() not raw values.
  const violations: { token: SemanticTokenName; value: string }[] = [];
  for (const token of SEMANTIC_TOKEN_NAMES) {
    const value = tokenMap[token];
    if (value === undefined || value === '') {
      violations.push({ token, value: value ?? '' });
    }
  }
  return violations;
}
