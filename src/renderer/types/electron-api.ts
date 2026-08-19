import type {
  IpcCleanupReason,
  IpcSubscriptionScope,
} from '../preload-subscription-registry.js';
import type {
  ExternalLinkRequestV1,
  ExternalLinkResultV1,
} from '../../shared/external-link-ipc-contracts.js';
import type { AppBootstrapPreloadBridge } from './app-bootstrap-preload.js';
import type { StructuredChatPreloadBridge } from './structured-chat-preload.js';

/** Fixed external-link IPC accessor exposed via `contextBridge` (task 10.6). */
export interface ExternalLinkPreloadBridge {
  openExternalLink(request: ExternalLinkRequestV1): Promise<ExternalLinkResultV1>;
}

/** Existing migration bridge retained while callers move to fixed typed methods. */
export interface LegacyElectronPreloadBridge {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(
    channel: string,
    callback: (...args: unknown[]) => void,
  ): (() => void) | undefined;
  onScoped(
    channel: string,
    scope: IpcSubscriptionScope,
    callback: (...args: unknown[]) => void,
  ): (() => void) | undefined;
  removeListener(
    channel: string,
    callback: (...args: unknown[]) => void,
  ): number;
  switchSubscriptionSession(sessionId: string, branchId?: string): number;
  rollbackSubscriptionGate(gateId: string): number;
  cleanupSubscriptions(reason: IpcCleanupReason): number;
}

export type ElectronPreloadBridge = LegacyElectronPreloadBridge
  & AppBootstrapPreloadBridge
  & StructuredChatPreloadBridge
  & ExternalLinkPreloadBridge;

declare global {
  interface Window {
    electronAPI: ElectronPreloadBridge;
  }
}

export {};
