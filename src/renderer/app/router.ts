/**
 * Panel router for the decomposed renderer.
 * Manages which panel is visible and handles lazy-loading of panel modules.
 */

import type { PanelId, PanelModule, PanelRoute } from '../types';
import { store } from '../state';

/** Panel route definitions with metadata. */
export const PANEL_ROUTES: PanelRoute[] = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'editor', label: 'Editor', icon: '📝' },
  { id: 'graph', label: 'Graph', icon: '🔗', lazy: true },
  { id: 'terminal', label: 'Terminal', icon: '⬛' },
  { id: 'workspaces', label: 'Workspaces', icon: '📋', lazy: true },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

/** Registry of loaded panel modules keyed by panel ID. */
const panelModules: Map<PanelId, PanelModule> = new Map();

/** Registry of panel container elements. */
const panelContainers: Map<PanelId, HTMLElement> = new Map();

/** Registers a panel module for the given ID. */
export function registerPanel(id: PanelId, module: PanelModule): void {
  panelModules.set(id, module);
}

/** Associates a DOM container element with a panel ID. */
export function registerPanelContainer(id: PanelId, container: HTMLElement): void {
  panelContainers.set(id, container);
}

/** Gets the route definition for a panel ID. */
export function getRoute(id: PanelId): PanelRoute | undefined {
  return PANEL_ROUTES.find((r) => r.id === id);
}

/**
 * Navigates to the specified panel.
 * Hides the previous panel and shows/mounts the new one.
 */
export function navigateTo(id: PanelId): void {
  const previous = store.get('activePanel');
  if (previous === id) return;

  // Blur previous panel
  const prevModule = panelModules.get(previous);
  const prevContainer = panelContainers.get(previous);
  if (prevModule?.onBlur) prevModule.onBlur();
  if (prevContainer) prevContainer.style.display = 'none';

  // Show and focus new panel
  const nextModule = panelModules.get(id);
  const nextContainer = panelContainers.get(id);
  if (nextContainer) {
    nextContainer.style.display = 'flex';
    // Mount if not already mounted
    if (nextModule && !nextContainer.dataset.mounted) {
      nextModule.mount(nextContainer);
      nextContainer.dataset.mounted = 'true';
    }
    if (nextModule?.onFocus) nextModule.onFocus();
  }

  store.set('activePanel', id);
}

/**
 * Initializes the router.
 * Subscribes to state changes and performs initial panel activation.
 */
export function initRouter(): void {
  // Mount the initial panel
  const activePanel = store.get('activePanel');
  const container = panelContainers.get(activePanel);
  const module = panelModules.get(activePanel);

  if (container && module) {
    container.style.display = 'flex';
    module.mount(container);
    container.dataset.mounted = 'true';
  }

  // Hide all other panels
  for (const [id, el] of panelContainers) {
    if (id !== activePanel) {
      el.style.display = 'none';
    }
  }
}
