/**
 * NativeShell — Window management, macOS integration, and launch mode detection.
 *
 * Pure logic (window state persistence, launch mode) is separated from
 * Electron-specific code so it can be unit-tested without Electron.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WindowConfig, WindowState } from '../shared/types.js';
import { getSecureWebPreferences } from './security/window-hardener';
import { getDataDirectory } from '../storage/data-directory.js';

// ─── Types ──────────────────────────────────────────────────────

export interface Shortcut {
  accelerator: string;
  action: string;
}

export interface NativeShell {
  createMainWindow(config: WindowConfig): void;
  restoreWindowState(): WindowState;
  persistWindowState(state: WindowState): void;
  getLaunchMode(): 'gui' | 'cli';
  registerSpotlightActions(): void;
  registerKeyboardShortcuts(shortcuts: Shortcut[]): void;
  getSystemTheme(): 'light' | 'dark';
  onThemeChange(callback: (theme: 'light' | 'dark') => void): void;
}

// ─── Constants ──────────────────────────────────────────────────

const STATE_DIR = getDataDirectory();
const STATE_FILE = path.join(STATE_DIR, 'window-state.json');

const DEFAULT_WINDOW_STATE: WindowState = {
  x: 100,
  y: 100,
  width: 1200,
  height: 800,
  isMaximized: false,
};

// ─── Pure logic (no Electron dependency) ────────────────────────

/**
 * Read persisted window state from disk.
 * Returns the default state when the file is missing or corrupt.
 */
export function restoreWindowState(
  filePath: string = STATE_FILE,
): WindowState {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return validateWindowState(parsed);
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

/**
 * Write window state to disk as JSON.
 * Creates the directory if it doesn't exist.
 */
export function persistWindowState(
  state: WindowState,
  filePath: string = STATE_FILE,
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Validate and coerce a parsed object into a valid WindowState.
 * Falls back to defaults for any invalid or missing fields.
 */
export function validateWindowState(obj: unknown): WindowState {
  if (obj === null || typeof obj !== 'object') {
    return { ...DEFAULT_WINDOW_STATE };
  }

  const o = obj as Record<string, unknown>;

  return {
    x: typeof o.x === 'number' && Number.isFinite(o.x) ? o.x : DEFAULT_WINDOW_STATE.x,
    y: typeof o.y === 'number' && Number.isFinite(o.y) ? o.y : DEFAULT_WINDOW_STATE.y,
    width:
      typeof o.width === 'number' && Number.isFinite(o.width) && o.width > 0
        ? o.width
        : DEFAULT_WINDOW_STATE.width,
    height:
      typeof o.height === 'number' && Number.isFinite(o.height) && o.height > 0
        ? o.height
        : DEFAULT_WINDOW_STATE.height,
    isMaximized: typeof o.isMaximized === 'boolean' ? o.isMaximized : DEFAULT_WINDOW_STATE.isMaximized,
  };
}

/**
 * Detect whether the app was launched in CLI mode or GUI mode.
 * CLI mode is triggered by the --cli flag.
 */
export function getLaunchMode(argv: string[] = process.argv): 'gui' | 'cli' {
  const args = argv.slice(1);
  if (args.includes('--cli')) {
    return 'cli';
  }
  return 'gui';
}

/** Default window state used when no persisted state exists. */
export { DEFAULT_WINDOW_STATE };

// ─── Electron-dependent implementation ──────────────────────────

/**
 * Full NativeShell implementation that wraps Electron APIs.
 *
 * This class should only be instantiated inside the Electron main process.
 * The pure functions above (restoreWindowState, persistWindowState,
 * getLaunchMode, validateWindowState) can be used and tested independently.
 */
export class ElectronNativeShell implements NativeShell {
  private win: import('electron').BrowserWindow | null = null;
  private themeCallbacks: Array<(theme: 'light' | 'dark') => void> = [];

  /** Returns the main BrowserWindow, or null if not yet created. */
  getWindow(): import('electron').BrowserWindow | null {
    return this.win;
  }

  createMainWindow(config: WindowConfig): void {
    // Dynamic import so this module can be loaded without Electron at test time
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BrowserWindow } = require('electron') as typeof import('electron');
    const path = require('node:path') as typeof import('node:path');

    const saved = restoreWindowState();

    this.win = new BrowserWindow({
      x: saved.x,
      y: saved.y,
      width: saved.width,
      height: saved.height,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      titleBarStyle: config.titleBarStyle,
      webPreferences: getSecureWebPreferences({
        preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      }),
    });

    if (saved.isMaximized) {
      this.win.maximize();
    }

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // Persist state on move/resize
    const persist = () => {
      if (!this.win) return;
      const bounds = this.win.getBounds();
      persistWindowState({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: this.win.isMaximized(),
      });
    };

    this.win.on('resize', persist);
    this.win.on('move', persist);
    this.win.on('close', persist);
  }

  restoreWindowState(): WindowState {
    return restoreWindowState();
  }

  persistWindowState(state: WindowState): void {
    persistWindowState(state);
  }

  getLaunchMode(): 'gui' | 'cli' {
    return getLaunchMode();
  }

  registerSpotlightActions(): void {
    const { app } = require('electron') as typeof import('electron');

    app.setAsDefaultProtocolClient('neuronest');

    // Register user activities for Spotlight indexing
    if (typeof app.setUserActivity === 'function') {
      app.setUserActivity('com.neuronest.open', {
        title: 'Open NeuroNest',
        description: 'Launch NeuroNest - The AI Coding SuperAgent',
      });
    }
  }

  registerKeyboardShortcuts(shortcuts: Shortcut[]): void {
    const { globalShortcut } = require('electron') as typeof import('electron');

    for (const shortcut of shortcuts) {
      globalShortcut.register(shortcut.accelerator, () => {
        if (this.win) {
          this.win.webContents.send('shortcut', shortcut.action);
        }
      });
    }
  }

  getSystemTheme(): 'light' | 'dark' {
    const { nativeTheme } = require('electron') as typeof import('electron');
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  onThemeChange(callback: (theme: 'light' | 'dark') => void): void {
    this.themeCallbacks.push(callback);

    // Only register the listener once
    if (this.themeCallbacks.length === 1) {
      const { nativeTheme } = require('electron') as typeof import('electron');
      nativeTheme.on('updated', () => {
        const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        for (const cb of this.themeCallbacks) {
          cb(theme);
        }
      });
    }
  }
}
