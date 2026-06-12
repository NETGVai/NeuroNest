/**
 * Minimal reactive state management for the renderer.
 * Framework-agnostic — uses a simple pub/sub pattern with typed events.
 */

import type { AppState, PanelId, StateChangeEvent, ThemeMode } from '../types';

type StateListener<K extends keyof AppState = keyof AppState> = (event: StateChangeEvent<K>) => void;

/**
 * Simple reactive store for application state.
 * Panels and services subscribe to state changes via typed listeners.
 */
class AppStore {
  private state: AppState = {
    activePanel: 'chat',
    theme: 'dark',
    sidebarCollapsed: false,
  };

  private listeners: Map<keyof AppState, Set<StateListener>> = new Map();

  get<K extends keyof AppState>(key: K): AppState[K] {
    return this.state[key];
  }

  set<K extends keyof AppState>(key: K, value: AppState[K]): void {
    const previousValue = this.state[key];
    if (previousValue === value) return;

    this.state[key] = value;

    const event: StateChangeEvent<K> = { key, value, previousValue };
    const keyListeners = this.listeners.get(key);
    if (keyListeners) {
      keyListeners.forEach((listener) => (listener as StateListener<K>)(event));
    }
  }

  subscribe<K extends keyof AppState>(key: K, listener: StateListener<K>): () => void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    const keyListeners = this.listeners.get(key)!;
    keyListeners.add(listener as StateListener);

    // Return unsubscribe function
    return () => {
      keyListeners.delete(listener as StateListener);
    };
  }

  /** Get a snapshot of the full state (read-only). */
  getSnapshot(): Readonly<AppState> {
    return { ...this.state };
  }
}

/** Singleton store instance for the application. */
export const store = new AppStore();

// Re-export convenience functions
export function getActivePanel(): PanelId {
  return store.get('activePanel');
}

export function setActivePanel(panel: PanelId): void {
  store.set('activePanel', panel);
}

export function getTheme(): ThemeMode {
  return store.get('theme');
}

export function setTheme(theme: ThemeMode): void {
  store.set('theme', theme);
}
