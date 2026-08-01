/**
 * New decomposed renderer entry point for NeuroNest.
 * This file replaces the 27k-line god-file with a clean bootstrap.
 * Under 100 lines — delegates all work to modular subsystems.
 *
 * Architecture:
 * 1. Initialize theme (dark/light based on system preference)
 * 2. Mount the App layout shell (sidebar + content area)
 * 3. Register panel modules (chat, editor, graph, terminal, settings)
 * 4. Boot the router (shows initial panel)
 *
 * The original src/renderer/index.ts remains operational during migration.
 * This entry point will fully replace it once all panels are extracted.
 */

import { mountApp } from './app/App';
import { registerPanel } from './app/router';
import { chatPanel } from './panels/chat';
import { graphPanelModule } from './panels/graph';
import { createWorkspacesPanel } from './app/workspaces-panel';
import { fileTreePanel } from './panels/file-tree';
import type { PanelId, PanelModule } from './types';

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
 * Bootstrap the renderer application.
 * Called when the DOM is ready.
 */
function bootstrap(): void {
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

  // Mount the application shell
  mountApp(root);

  // Wire up the editor:open-file IPC event from the main process.
  // This event is sent when a file is opened from the File Tree Panel.
  // It navigates to the editor panel and opens the requested file.
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

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
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
