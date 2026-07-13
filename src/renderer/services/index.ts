/**
 * Renderer services barrel export.
 * Re-exports IPC client utilities used by panels and other services.
 */

export { ipcInvoke, ipcOn, ipcInvokeSafe, isIpcAvailable } from './ipc-client';
export type { IpcEventCallback, IpcUnsubscribe } from './ipc-client';

export { PromptDetector } from './prompt-detector';
export { ButtonGroupManager, buttonGroupManager } from './button-group-manager';
export { SpecOrchestrator } from './spec-orchestrator';
export { persistSpecDocuments } from './spec-persistence';
export type { SpecPersistMessage, SpecDocuments } from './spec-persistence';
export {
  storeActionMeta,
  getActionMeta,
  clearActionMeta,
  renderHistoricalActionButtons,
} from './message-action-store';
export { SpecUIController } from './spec-ui-integration';
export { UserInputBridge } from './user-input-bridge';
export type { RendererUserInputRequest } from './user-input-bridge';
