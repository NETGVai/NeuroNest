/**
 * Typed IPC client — wrappers for invoke/on/off patterns.
 * Provides a centralized, type-safe abstraction over the Electron preload bridge.
 * All panels and services use this module instead of accessing window.electronAPI directly.
 */

/** Callback type for IPC event listeners. */
export type IpcEventCallback<T = unknown> = (data: T) => void;

/** Unsubscribe function returned by event listeners. */
export type IpcUnsubscribe = () => void;

/** Shape of the preload-exposed IPC bridge on window. */
interface IpcBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
}

/**
 * Gets the IPC bridge from the preload-exposed window API.
 * Returns a safe fallback if the bridge is unavailable (e.g., during testing).
 */
function getBridge(): IpcBridge {
  const api = (window as unknown as Record<string, unknown>)['electronAPI'] as Partial<IpcBridge> | undefined;

  return {
    invoke: api?.invoke ?? (async () => undefined),
    on: api?.on ?? (() => {}),
    off: api?.off ?? (() => {}),
  };
}

/**
 * Invoke an IPC channel with typed request/response.
 * Sends a message to the main process and awaits a response.
 *
 * @param channel - The IPC channel name
 * @param data - Optional payload to send
 * @returns The response from the main process
 */
export async function ipcInvoke<TResponse = unknown, TRequest = unknown>(
  channel: string,
  data?: TRequest,
): Promise<TResponse> {
  const bridge = getBridge();
  const result = await bridge.invoke(channel, data);
  return result as TResponse;
}

/**
 * Subscribe to an IPC event channel.
 * Listens for events pushed from the main process.
 *
 * @param channel - The IPC channel to listen on
 * @param callback - Handler invoked with event data
 * @returns Unsubscribe function to remove the listener
 */
export function ipcOn<T = unknown>(channel: string, callback: IpcEventCallback<T>): IpcUnsubscribe {
  const bridge = getBridge();

  const handler = (...args: unknown[]): void => {
    callback(args[0] as T);
  };

  bridge.on(channel, handler);

  return () => {
    bridge.off(channel, handler);
  };
}

/**
 * Invoke an IPC channel and handle errors gracefully.
 * Returns a result object instead of throwing.
 *
 * @param channel - The IPC channel name
 * @param data - Optional payload to send
 * @returns Result with success flag and data or error
 */
export async function ipcInvokeSafe<TResponse = unknown, TRequest = unknown>(
  channel: string,
  data?: TRequest,
): Promise<{ success: true; data: TResponse } | { success: false; error: string }> {
  try {
    const result = await ipcInvoke<TResponse, TRequest>(channel, data);
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown IPC error';
    return { success: false, error: message };
  }
}

/**
 * Check whether the IPC bridge is available.
 * Useful for conditional behavior in environments without Electron (e.g., tests, web).
 */
export function isIpcAvailable(): boolean {
  const api = (window as unknown as Record<string, unknown>)['electronAPI'];
  return api != null && typeof (api as Record<string, unknown>)['invoke'] === 'function';
}
