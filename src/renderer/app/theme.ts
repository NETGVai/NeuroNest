/**
 * Theme system for NeuroNest renderer.
 * Manages CSS custom properties for dark/light mode switching.
 * Reads initial preference from system settings and allows runtime toggling.
 */

import type { ThemeMode } from '../types';
import { store } from '../state';

/** Dark theme CSS variable values. */
const DARK_THEME: Record<string, string> = {
  '--bg-primary': '#1e1e1e',
  '--bg-sidebar': '#252526',
  '--bg-inspector': '#252526',
  '--bg-chat': '#1e1e1e',
  '--bg-input': '#3c3c3c',
  '--bg-message-user': '#264f78',
  '--bg-message-agent': '#1e1e1e',
  '--surface-container': '#252526',
  '--surface-container-high': '#2d2d2d',
  '--surface-container-highest': '#333333',
  '--on-surface': '#cccccc',
  '--on-surface-variant': '#969696',
  '--outline': '#3c3c3c',
  '--outline-variant': '#2d2d2d',
  '--text-primary': '#cccccc',
  '--text-secondary': '#969696',
  '--text-dim': '#5a5a5a',
  '--border-color': '#2d2d2d',
  '--accent': '#007AFF',
  '--accent-hover': '#3399FF',
};

/** Light theme CSS variable values. */
const LIGHT_THEME: Record<string, string> = {
  '--bg-primary': '#ffffff',
  '--bg-sidebar': '#f3f3f3',
  '--bg-inspector': '#f3f3f3',
  '--bg-chat': '#ffffff',
  '--bg-input': '#e8e8e8',
  '--bg-message-user': '#dcebff',
  '--bg-message-agent': '#f8f8f8',
  '--surface-container': '#f3f3f3',
  '--surface-container-high': '#ebebeb',
  '--surface-container-highest': '#e0e0e0',
  '--on-surface': '#1e1e1e',
  '--on-surface-variant': '#616161',
  '--outline': '#d4d4d4',
  '--outline-variant': '#e8e8e8',
  '--text-primary': '#1e1e1e',
  '--text-secondary': '#616161',
  '--text-dim': '#a0a0a0',
  '--border-color': '#e0e0e0',
  '--accent': '#007AFF',
  '--accent-hover': '#0066DD',
};

/** Applies the given theme variables to the document root. */
function applyThemeVariables(vars: Record<string, string>): void {
  const root = document.documentElement;
  for (const [property, value] of Object.entries(vars)) {
    root.style.setProperty(property, value);
  }
}

/** Detects system color scheme preference. */
function getSystemTheme(): ThemeMode {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

/** Applies the specified theme mode. */
export function applyTheme(mode: ThemeMode): void {
  const vars = mode === 'dark' ? DARK_THEME : LIGHT_THEME;
  applyThemeVariables(vars);
  document.documentElement.setAttribute('data-theme', mode);
  store.set('theme', mode);
}

/** Toggles between dark and light themes. */
export function toggleTheme(): void {
  const current = store.get('theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

/**
 * Initializes the theme system.
 * Reads system preference and sets up a listener for OS theme changes.
 */
export function initTheme(): void {
  const initial = getSystemTheme();
  applyTheme(initial);

  // Listen for system theme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      applyTheme(e.matches ? 'dark' : 'light');
    });
  }
}
