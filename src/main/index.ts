/**
 * Electron main process entry point.
 *
 * Responsibilities:
 * - Window management (create, restore state, persist state)
 * - Launch mode detection (GUI vs CLI)
 * - macOS native integration (Dark Mode, Spotlight, keyboard shortcuts)
 * - IPC routing between main and renderer processes
 */

export { getLaunchMode } from './launch-mode.js';

export {
  restoreWindowState,
  persistWindowState,
  validateWindowState,
  getLaunchMode as getLaunchModeFromArgs,
  DEFAULT_WINDOW_STATE,
  ElectronNativeShell,
} from './native-shell.js';

export type { NativeShell, Shortcut } from './native-shell.js';

export {
  registerIPCHandlers,
  notifyThemeChange,
  notifyToolOutput,
  notifyShortcut,
} from './ipc.js';

export type { IPCDependencies } from './ipc.js';

// Electron bootstrap is in electron-app.ts — only imported when
// running inside the actual Electron runtime, not during tests.
