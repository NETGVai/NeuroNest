/**
 * Renderer services barrel export.
 * Re-exports IPC client utilities used by panels and other services.
 */

export { ipcInvoke, ipcOn, ipcInvokeSafe, isIpcAvailable } from './ipc-client';
export type { IpcEventCallback, IpcUnsubscribe } from './ipc-client';
