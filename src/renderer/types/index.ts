/**
 * Shared renderer types for the decomposed module architecture.
 * Each panel and service imports from this central type hub.
 */

/** Identifies which panel is currently active in the layout. */
export type PanelId = 'chat' | 'editor' | 'graph' | 'terminal' | 'workspaces' | 'settings';

/** Theme variants supported by the application. */
export type ThemeMode = 'dark' | 'light';

/** Route definition for panel-based navigation. */
export interface PanelRoute {
  id: PanelId;
  label: string;
  icon: string;
  /** If true, the panel module is loaded lazily on first access. */
  lazy?: boolean;
}

/** Lifecycle hooks for panel modules. */
export interface PanelModule {
  /** Called when the panel is mounted into the DOM. */
  mount(container: HTMLElement): void;
  /** Called when the panel is unmounted (hidden or destroyed). */
  unmount(): void;
  /** Optional: called when the panel receives focus. */
  onFocus?(): void;
  /** Optional: called when the panel loses focus. */
  onBlur?(): void;
}

/** Application-level state that panels can subscribe to. */
export interface AppState {
  activePanel: PanelId;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
}

/** Event emitted when application state changes. */
export interface StateChangeEvent<K extends keyof AppState = keyof AppState> {
  key: K;
  value: AppState[K];
  previousValue: AppState[K];
}
