// ─── Adapter Interface ──────────────────────────────────────────
// Core contract that every provider plugin implements, plus the
// dependency-injection context and factory type alias used by the registry.

import type { AdapterCapabilities, ChannelStatus } from './capabilities';
import type { TileMetadata } from './tile-metadata';
import type {
  IncomingMessage,
  OutgoingMessage,
  ConnectResult,
  SendResult,
} from './messages';
import type { ErrorCode } from './errors';
import type { ListenerConfig } from '../listener-config';
import type { z } from 'zod';

/**
 * Every provider plugin implements this interface. A single adapter file
 * plus a `registerAdapter` call is all that's needed to add a new channel.
 *
 * @satisfies REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 1.6, REQ 1.7, REQ 1.8
 */
export interface ChannelAdapter {
  /** Stable unique identifier, e.g. 'whatsapp', 'microsoft-teams'. REQ 1.5 */
  readonly channelId: string;

  /** Declarative capability flags used by ChannelManager and the UI. REQ 1.6, REQ 4 */
  readonly capabilities: AdapterCapabilities;

  /** Static UI-tile metadata rendered by the channels-view panel. REQ 1.8, REQ 31 */
  readonly tileMetadata: TileMetadata;

  /**
   * Zod schema for the config object accepted by `connect`. REQ 1.7, REQ 5.
   * Exported as a readonly property so `ChannelManager.connect` can validate
   * before instantiating any SDK.
   */
  readonly configSchema: z.ZodType;

  /** Lifecycle. See REQ 1.1–1.4. */
  connect(config: unknown, context: AdapterContext): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  send(message: OutgoingMessage): Promise<SendResult>;
}

/**
 * DI object handed to every adapter's `connect` call. Adapters use it to
 * emit inbound messages, publish status transitions, log, and reserve
 * listener ports.
 *
 * @satisfies REQ 2.5, REQ 15.1
 */
export interface AdapterContext {
  /** Emit an inbound message. Must have `channelId === this.channelId`. REQ 2 */
  emit(msg: IncomingMessage): void;

  /** Publish a status transition. Exactly one event per transition. REQ 15 */
  setStatus(status: ChannelStatus, error?: { code: ErrorCode; message: string }): void;

  /** Scoped logger. All entries prefixed [ChannelAdapter:<channelId>]. REQ 21.2 */
  readonly logger: {
    info(msg: string, extra?: Record<string, unknown>): void;
    warn(msg: string, extra?: Record<string, unknown>): void;
    error(msg: string, extra?: Record<string, unknown>): void;
  };

  /**
   * Reserve a loopback HTTP listener port. Returns a validated ListenerConfig
   * or throws PortConflictError if another adapter already reserved it. REQ 4.7, REQ 28.6
   */
  reserveListener(options: {
    port?: number;
    host?: string;
    remoteAccessExplicit?: boolean;
    defaultPort: number;
    name: string;
  }): ListenerConfig;

  /** Release a previously reserved listener. Called on disconnect. */
  releaseListener(): void;
}

/**
 * Factory function type used by the Adapter_Registry. Called lazily on first
 * `ChannelManager.connect(channelId, ...)`. REQ 22.4
 */
export type AdapterFactory = () => ChannelAdapter;
