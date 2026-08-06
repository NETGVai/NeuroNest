// ─── Message Types ──────────────────────────────────────────────
// Unified incoming/outgoing message shapes and lifecycle result types
// shared by every adapter and the ChannelManager orchestrator.

import type { ProviderMetadata } from './provider-metadata';
import type { ErrorCode } from './errors';

/**
 * The normalized inbound message shape emitted by every adapter.
 * Downstream consumers (chat pipeline, firewall, IMGateway) process
 * messages without provider-specific branching.
 *
 * @satisfies REQ 2.1, REQ 2.2
 */
export interface IncomingMessage {
  /** REQ 2.1 */
  channelId: string;
  from: string;
  content: string;
  timestamp: Date;

  /** REQ 2.2 */
  contentType?: 'text' | 'image' | 'audio' | 'video' | 'file' | 'other';

  /** REQ 2.3 — discriminated union keyed on channelId */
  providerMetadata?: ProviderMetadata;
}

/**
 * The normalized outbound message shape passed to `ChannelAdapter.send()`.
 * Callers construct this via `ChannelManager.sendMessage` which validates
 * the discriminator match before delegation.
 *
 * @satisfies REQ 3.1, REQ 3.2
 */
export interface OutgoingMessage {
  /** REQ 3.1 */
  to: string;
  content: string;

  /** REQ 3.2 */
  contentType?: 'text' | 'image' | 'audio' | 'video' | 'file' | 'other';

  /** REQ 3.3 */
  providerMetadata?: ProviderMetadata;
}

/**
 * Result returned by `ChannelAdapter.connect()` and surfaced by
 * `ChannelManager.connect()`.
 *
 * @satisfies REQ 14.3, REQ 21.1
 */
export interface ConnectResult {
  success: boolean;
  message: string;
  /** Optional QR-code data for providers that need it (retained from current API) */
  qrCode?: string;
  /** Structured error code, present when success === false. REQ 21.1 */
  error?: { code: ErrorCode; message: string };
}

/**
 * Result returned by `ChannelAdapter.send()` and surfaced by
 * `ChannelManager.sendMessage()`.
 *
 * @satisfies REQ 14.3
 */
export interface SendResult {
  success: boolean;
  message: string;
}

/**
 * The unified per-channel connection record surfaced by getStatus/getAllStatuses.
 * REQ 14.1, REQ 24.7
 */
export interface ChannelConnection {
  id: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}
