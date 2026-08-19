/**
 * Root application component for the decomposed renderer.
 * Provides the layout shell: sidebar + content area pattern.
 * Framework-agnostic — uses vanilla DOM manipulation.
 *
 * ── Launch-mode awareness (Task 3.2) ─────────────────────────────
 *
 * The shell accepts an `AppBootstrapSnapshot` and constructs an application
 * Inspector host only when the resolved mode is `advanced`. Classic never
 * creates the Inspector host DOM, keyboard focus target, or reserved layout
 * region; the Main Workspace consumes the remaining width. The `#nn-root`
 * container publishes `data-launch-mode` so mode-aware CSS can drop the
 * Inspector track without imperative branches in every helper.
 *
 * The application Inspector host is intentionally distinct from any
 * structured-response detail dialogs/sheets that live inside chat panels:
 * it carries `data-launch-mode-region="application-inspector"` and
 * `role="complementary"`, whereas detail dialogs use `role="dialog"` and
 * are constructed by the chat surfaces themselves.
 *
 * Requirements: 2.1–2.7, 3.1–3.3, 9.7
 */

import type { AppBootstrapSnapshot, InspectorLayoutState, LaunchMode, PanelId } from '../types';
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
  inspectorHost: 'nn-inspector-host',
} as const;

/** Idempotent id used to gate a single injection of the layout stylesheet. */
const STYLE_ELEMENT_ID = 'nn-app-styles';

/** Default Inspector host width in DIP when no layout state is supplied. */
const DEFAULT_INSPECTOR_WIDTH_DIP = 320;

/** Options accepted by {@link mountApp}. */
export interface MountAppOptions {
  /**
   * Non-secret application bootstrap snapshot returned by the main-process
   * `app-bootstrap:get-v1` IPC. When omitted or null, the shell falls back to
   * Advanced-mode compatibility so an unresolved bootstrap never leaves the
   * user with a partially mounted workspace (Requirement 1.4).
   */
  bootstrap?: AppBootstrapSnapshot | null;
}

/** Descriptor returned by {@link mountApp} for tests and downstream wiring. */
export interface MountedAppShell {
  readonly root: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly content: HTMLElement;
  /** Non-null only when the resolved mode is `advanced`. */
  readonly inspectorHost: HTMLElement | null;
  readonly launchMode: LaunchMode;
}

/**
 * Resolves the launch mode from the optional bootstrap snapshot. Missing or
 * malformed payloads default to Advanced to preserve current behavior for
 * existing installations (Requirement 1.4).
 */
export function resolveLaunchMode(
  bootstrap: AppBootstrapSnapshot | null | undefined,
): LaunchMode {
  if (bootstrap && (bootstrap.launchMode === 'classic' || bootstrap.launchMode === 'advanced')) {
    return bootstrap.launchMode;
  }
  return 'advanced';
}

/** Injects scoped styles for the layout shell exactly once per document. */
function injectStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
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
    /*
     * Application Inspector host. Present only in Advanced mode; Classic never
     * constructs the aside so no CSS-only hiding is required. Width honors the
     * persisted layout state via the inline width set at mount time.
     */
    .${CSS.inspectorHost} {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-inspector, #252526);
      border-left: 1px solid var(--border-color, #2d2d2d);
      overflow: hidden;
    }
    .${CSS.inspectorHost}[data-collapsed='true'] {
      width: 0 !important;
      border-left-width: 0;
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
  content.setAttribute('aria-label', 'Main Workspace');

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

/**
 * Creates the application Inspector host. Called only in Advanced mode; the
 * host is a distinct region from any chat-scoped structured-response detail
 * dialog. It is the mount point that the Advanced-only Inspector factory
 * (see `inspector-factory.ts`) or downstream tasks (3.3 layout persistence)
 * attach into. The host itself carries no Inspector content — construction
 * of Departments and other Inspector-only surfaces is owned by Advanced-only
 * lifecycle code, keeping Classic free of that startup work.
 */
function createInspectorHost(layout: InspectorLayoutState | undefined): HTMLElement {
  const host = document.createElement('aside');
  host.className = CSS.inspectorHost;
  host.id = 'nn-inspector-host';
  host.setAttribute('role', 'complementary');
  host.setAttribute('aria-label', 'Application Inspector');
  // A stable, machine-checkable marker so tests and static architecture
  // enforcement can prove Classic never constructs the region and that the
  // host is not confused with a chat-scoped detail dialog.
  host.setAttribute('data-launch-mode-region', 'application-inspector');

  const widthDip = layout?.widthDip ?? DEFAULT_INSPECTOR_WIDTH_DIP;
  const collapsed = layout?.collapsed === true;
  host.style.width = `${widthDip}px`;
  host.dataset.layoutWidthDip = String(widthDip);
  host.dataset.collapsed = collapsed ? 'true' : 'false';
  if (typeof layout?.revision === 'number' && Number.isFinite(layout.revision)) {
    host.dataset.layoutRevision = String(layout.revision);
  }

  return host;
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
 * Sets up sidebar navigation, content area, theme, router, and — only in
 * Advanced mode — the application Inspector host.
 *
 * Classic execution guarantees (Requirement 2.1–2.7):
 * - No Inspector host DOM node exists in the tree.
 * - No Inspector-only keyboard focus target or resize handle is created.
 * - The Main Workspace consumes the remaining width via `flex: 1`.
 *
 * Advanced execution guarantees (Requirement 3.1–3.3):
 * - Exactly one Inspector host is appended, carrying the resolved layout
 *   width/collapse metadata for downstream restore.
 * - Structured-response detail dialogs remain a chat-panel concern.
 */
export function mountApp(root: HTMLElement, options: MountAppOptions = {}): MountedAppShell {
  injectStyles();
  initTheme();

  const launchMode = resolveLaunchMode(options.bootstrap ?? null);

  const sidebar = createSidebar();
  const content = createContent();

  root.classList.add(CSS.root);
  // Publish the resolved mode so mode-aware CSS (and downstream code that
  // reads the attribute) can pick the correct layout without inspecting the
  // absence/presence of the Inspector host node.
  root.setAttribute('data-launch-mode', launchMode);
  root.appendChild(sidebar);
  root.appendChild(content);

  let inspectorHost: HTMLElement | null = null;
  if (launchMode === 'advanced') {
    const layout =
      options.bootstrap && options.bootstrap.launchMode === 'advanced'
        ? options.bootstrap.inspector
        : undefined;
    inspectorHost = createInspectorHost(layout);
    root.appendChild(inspectorHost);
  }

  // Set initial sidebar active state
  updateSidebarActive(store.get('activePanel'), sidebar);

  // Subscribe to panel changes for sidebar highlighting
  store.subscribe('activePanel', ({ value }) => {
    updateSidebarActive(value as PanelId, sidebar);
  });

  // Initialize the router (mounts initial panel, hides others)
  initRouter();

  return { root, sidebar, content, inspectorHost, launchMode };
}
