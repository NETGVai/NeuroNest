/**
 * Settings service — IPC wrappers for reading/writing settings.
 * Communicates with the main process to load, save, and watch settings changes.
 */

import type {
  LoadSettingsRequest,
  LoadSettingsResponse,
  SaveSettingRequest,
  SaveSettingResponse,
  SettingKey,
  SettingValue,
  SettingsServiceEvent,
  SettingsServiceListener,
} from './types';

/** IPC channels used by the settings service. */
const IPC_CHANNELS = {
  LOAD: 'settings:load',
  SAVE: 'settings:save',
  RESET: 'settings:reset',
  CHANGED: 'settings:changed',
} as const;

/**
 * Typed wrapper around the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const bridge = (window as unknown as Record<string, unknown>)['electronAPI'] as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    off?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
    on: bridge?.on ?? (() => {}),
    off: bridge?.off ?? (() => {}),
  };
}

/**
 * SettingsService manages settings I/O via IPC.
 * Provides load, save, and reset operations, and subscribes to
 * external changes (e.g., from other windows or CLI).
 */
export class SettingsService {
  private listeners: Set<SettingsServiceListener> = new Set();
  private changedHandler: ((...args: unknown[]) => void) | null = null;
  private started = false;

  /** Start listening for settings change events from the main process. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const bridge = getIpcBridge();

    this.changedHandler = (...args: unknown[]) => {
      const data = args[0] as { key: string; value: SettingValue } | undefined;
      if (data?.key !== undefined) {
        this.emit({ type: 'setting-changed', key: data.key, value: data.value });
      }
    };

    bridge.on(IPC_CHANNELS.CHANGED, this.changedHandler);
  }

  /** Stop listening for settings events and clean up. */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    const bridge = getIpcBridge();

    if (this.changedHandler) {
      bridge.off(IPC_CHANNELS.CHANGED, this.changedHandler);
      this.changedHandler = null;
    }
  }

  /** Subscribe to settings service events. Returns an unsubscribe function. */
  subscribe(listener: SettingsServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Load all settings from the main process. */
  async loadSettings(request?: LoadSettingsRequest): Promise<LoadSettingsResponse> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.LOAD, request ?? {});
      return (result as LoadSettingsResponse) ?? {
        success: false,
        values: {},
        schema: { groups: [] },
        error: 'No response from main process',
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error loading settings';
      return { success: false, values: {}, schema: { groups: [] }, error: errorMessage };
    }
  }

  /** Save a single setting value. */
  async saveSetting(request: SaveSettingRequest): Promise<SaveSettingResponse> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.SAVE, request);
      return (result as SaveSettingResponse) ?? { success: false, error: 'No response' };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error saving setting';
      return { success: false, error: errorMessage };
    }
  }

  /** Reset a setting to its default value. */
  async resetSetting(key: SettingKey): Promise<SaveSettingResponse> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.RESET, { key });
      return (result as SaveSettingResponse) ?? { success: false, error: 'No response' };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error resetting setting';
      return { success: false, error: errorMessage };
    }
  }

  /** Emit an event to all registered listeners. */
  private emit(event: SettingsServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors to prevent cascading failures.
      }
    }
  }
}
