/**
 * New decomposed renderer entry point for NeuroNest.
 * This file replaces the 27k-line god-file with a clean bootstrap.
 *
 * Architecture:
 * 1. Fetch the non-secret application bootstrap snapshot via the fixed IPC
 *    method exposed by `preload.ts` (`window.electronAPI.getAppBootstrap`).
 * 2. Initialize theme (dark/light based on system preference).
 * 3. Mount the App layout shell (sidebar + content area, plus the Advanced-only
 *    application Inspector host when the resolved mode is `advanced`).
 * 4. Register panel modules (chat, editor, graph, terminal, settings).
 * 5. Boot the router (shows initial panel).
 *
 * Launch mode is resolved by the main process before the workspace document
 * is even loaded (`LaunchModeWindowGate`). This file only reads the snapshot,
 * forwards it to `mountApp`, and defaults to Advanced-mode compatibility
 * behavior when the bootstrap bridge is unavailable so the user never sees a
 * partially mounted shell (Requirement 1.4).
 *
 * The original `src/renderer/index.ts` remains operational during migration.
 * This entry point will fully replace it once all panels are extracted.
 *
 * Requirements: 1.4, 2.1–2.7, 3.1–3.3, 9.7
 */

import { mountApp } from './app/App';
import { registerPanel } from './app/router';
import { chatPanel } from './panels/chat';
import { graphPanelModule } from './panels/graph';
import { createWorkspacesPanel } from './app/workspaces-panel';
import { fileTreePanel } from './panels/file-tree';
import type { AppBootstrapSnapshot, PanelId, PanelModule } from './types';

/**
 * Creates a placeholder panel module.
 * Used for panels not yet extracted from the god-file.
 * Displays a minimal message indicating the panel is loading.
 */
function createPlaceholderPanel(_id: PanelId, label: string): PanelModule {
  return {
    mount(container: HTMLElement): void {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 1;
        color: var(--text-dim, #5a5a5a);
        font-size: 14px;
      `;
      wrapper.textContent = `${label} panel — migration in progress`;
      container.appendChild(wrapper);
    },
    unmount(): void {
      // Cleanup handled by container removal
    },
  };
}

/**
 * Preload bridge shape used at the renderer boundary. Only the fixed
 * bootstrap method plus the pre-existing `on` channel are referenced here;
 * this keeps the entry file honest about what it touches on `electronAPI`.
 */
interface RendererBridge {
  getAppBootstrap?: () => Promise<AppBootstrapSnapshot>;
  on?: (channel: string, callback: (...args: unknown[]) => void) => void;
}

/**
 * Reads the non-secret application bootstrap snapshot. Returns `null` when
 * the preload bridge, IPC method, or main-process resolution are unavailable;
 * callers must fall back to Advanced-mode compatibility (Requirement 1.4).
 */
async function readBootstrap(): Promise<AppBootstrapSnapshot | null> {
  const bridge = (window as unknown as { electronAPI?: RendererBridge }).electronAPI;
  if (!bridge || typeof bridge.getAppBootstrap !== 'function') return null;
  try {
    const snapshot = await bridge.getAppBootstrap();
    return snapshot ?? null;
  } catch (err) {
    // Bootstrap unavailable — the shell will fall back to Advanced-mode
    // compatibility so the user never sees a partially mounted workspace.
    // eslint-disable-next-line no-console
    console.warn('[NeuroNest] getAppBootstrap failed; falling back to Advanced:', err);
    return null;
  }
}

/**
 * Bootstrap the renderer application.
 * Called when the DOM is ready.
 */
async function bootstrap(): Promise<void> {
  const root = document.getElementById('nn-root');
  if (!root) {
    console.error('[NeuroNest] Missing #nn-root element in HTML');
    return;
  }

  // Register panel modules
  registerPanel('chat', chatPanel);
  registerPanel('editor', createPlaceholderPanel('editor', 'Editor'));
  registerPanel('graph', graphPanelModule);
  registerPanel('terminal', createPlaceholderPanel('terminal', 'Terminal'));
  registerPanel('workspaces', createWorkspacesPanel());
  registerPanel('file-tree', fileTreePanel);
  registerPanel('settings', createPlaceholderPanel('settings', 'Settings'));

  // Resolve the graphical launch mode before mounting the shell so Classic
  // never constructs the application Inspector host and Advanced restores
  // its persisted layout hints.
  const snapshot = await readBootstrap();

  // Mount the application shell with the resolved bootstrap; missing values
  // default to Advanced-mode compatibility inside `mountApp`.
  mountApp(root, { bootstrap: snapshot });

  // Wire up the editor:open-file IPC event from the main process.
  // This event is sent when a file is opened from the File Tree Panel.
  // It navigates to the editor panel and opens the requested file.
  const bridge = (window as unknown as { electronAPI?: RendererBridge }).electronAPI;

  if (bridge?.on) {
    bridge.on('editor:open-file', (...args: unknown[]) => {
      const payload = args[0] as {
        path?: string;
        relativePath?: string;
        line?: number;
        preview?: boolean;
      } | undefined;
      if (!payload?.path) return;

      // Navigate to editor panel and dispatch file-open event for the editor to handle
      // This allows any mounted editor (Monaco, CodeMirror, etc.) to pick up the file
      window.dispatchEvent(
        new CustomEvent('nn:open-file', {
          detail: {
            path: payload.path,
            relativePath: payload.relativePath,
            line: payload.line,
            preview: payload.preview,
          },
        }),
      );
    });
  }
}

// Wait for DOM readiness then bootstrap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
