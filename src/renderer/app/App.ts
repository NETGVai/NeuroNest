/**
 * Root application component for the decomposed renderer.
 * Provides the layout shell: sidebar + content area pattern.
 * Framework-agnostic — uses vanilla DOM manipulation.
 */

import type { PanelId } from '../types';
import { store } from '../state';
import { PANEL_ROUTES, navigateTo, registerPanelContainer, initRouter } from './router';
import { initTheme, toggleTheme } from './theme';

/** CSS class names used by the layout. */
const CSS = {
  root: 'nn-app',
  sidebar: 'nn-sidebar',
  sidebarNav: 'nn-sidebar-nav',
  sidebarNavItem: 'nn-sidebar-nav-item',
  sidebarNavItemActive: 'nn-sidebar-nav-item--active',
  content: 'nn-content',
  panelContainer: 'nn-panel',
  themeToggle: 'nn-theme-toggle',
} as const;

/** Injects scoped styles for the layout shell. */
function injectStyles(): void {
  const style = document.createElement('style');
  style.id = 'nn-app-styles';
  style.textContent = `
    .${CSS.root} {
      display: flex;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .${CSS.sidebar} {
      display: flex;
      flex-direction: column;
      width: 48px;
      background: var(--bg-sidebar, #252526);
      border-right: 1px solid var(--border-color, #2d2d2d);
      flex-shrink: 0;
    }
    .${CSS.sidebarNav} {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px 0;
      gap: 4px;
      flex: 1;
    }
    .${CSS.sidebarNavItem} {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 18px;
      opacity: 0.5;
      transition: opacity 0.15s, background 0.15s;
    }
    .${CSS.sidebarNavItem}:hover {
      opacity: 0.8;
      background: rgba(255, 255, 255, 0.04);
    }
    .${CSS.sidebarNavItemActive} {
      opacity: 1;
      background: rgba(255, 255, 255, 0.08);
    }
    .${CSS.content} {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .${CSS.panelContainer} {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .${CSS.themeToggle} {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      opacity: 0.5;
      margin-bottom: 8px;
      transition: opacity 0.15s, background 0.15s;
    }
    .${CSS.themeToggle}:hover {
      opacity: 0.8;
      background: rgba(255, 255, 255, 0.04);
    }
  `;
  document.head.appendChild(style);
}

/** Creates the sidebar navigation with panel buttons. */
function createSidebar(): HTMLElement {
  const sidebar = document.createElement('aside');
  sidebar.className = CSS.sidebar;
  sidebar.setAttribute('role', 'navigation');
  sidebar.setAttribute('aria-label', 'Panel navigation');

  const nav = document.createElement('nav');
  nav.className = CSS.sidebarNav;

  for (const route of PANEL_ROUTES) {
    const btn = document.createElement('button');
    btn.className = CSS.sidebarNavItem;
    btn.dataset.panelId = route.id;
    btn.textContent = route.icon;
    btn.title = route.label;
    btn.setAttribute('aria-label', `Switch to ${route.label} panel`);

    btn.addEventListener('click', () => navigateTo(route.id));
    nav.appendChild(btn);
  }

  sidebar.appendChild(nav);

  // Theme toggle at the bottom
  const themeBtn = document.createElement('button');
  themeBtn.className = CSS.themeToggle;
  themeBtn.textContent = '🌓';
  themeBtn.title = 'Toggle theme';
  themeBtn.setAttribute('aria-label', 'Toggle dark/light theme');
  themeBtn.addEventListener('click', toggleTheme);
  sidebar.appendChild(themeBtn);

  return sidebar;
}

/** Creates the main content area with panel containers. */
function createContent(): HTMLElement {
  const content = document.createElement('main');
  content.className = CSS.content;
  content.setAttribute('role', 'main');

  for (const route of PANEL_ROUTES) {
    const panel = document.createElement('div');
    panel.className = CSS.panelContainer;
    panel.id = `nn-panel-${route.id}`;
    panel.dataset.panelId = route.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', `${route.label} panel`);
    content.appendChild(panel);
    registerPanelContainer(route.id, panel);
  }

  return content;
}

/** Updates sidebar active state based on the current panel. */
function updateSidebarActive(activePanel: PanelId, sidebar: HTMLElement): void {
  const items = sidebar.querySelectorAll(`.${CSS.sidebarNavItem}`);
  items.forEach((item) => {
    const el = item as HTMLElement;
    if (el.dataset.panelId === activePanel) {
      el.classList.add(CSS.sidebarNavItemActive);
      el.setAttribute('aria-current', 'true');
    } else {
      el.classList.remove(CSS.sidebarNavItemActive);
      el.removeAttribute('aria-current');
    }
  });
}

/**
 * Mounts the application layout shell into the given root element.
 * Sets up sidebar navigation, content area, theme, and router.
 */
export function mountApp(root: HTMLElement): void {
  injectStyles();
  initTheme();

  const sidebar = createSidebar();
  const content = createContent();

  root.classList.add(CSS.root);
  root.appendChild(sidebar);
  root.appendChild(content);

  // Set initial sidebar active state
  updateSidebarActive(store.get('activePanel'), sidebar);

  // Subscribe to panel changes for sidebar highlighting
  store.subscribe('activePanel', ({ value }) => {
    updateSidebarActive(value as PanelId, sidebar);
  });

  // Initialize the router (mounts initial panel, hides others)
  initRouter();
}
