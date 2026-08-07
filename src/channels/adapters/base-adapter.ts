// ─── Base Channel Adapter ────────────────────────────────────────
// Abstract base class providing shared boilerplate for all 36 channel
// adapter implementations. Concrete adapters extend this to get
// `isConnected()`, `emitInbound()`, `log()`, `sdkMissing()`, and
// `authFailed()` for free — only needing to implement the abstract
// lifecycle methods and declare their unique metadata.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.7, REQ 1.8

import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import type { z } from 'zod';

/**
 * Abstract base class implementing the `ChannelAdapter` interface with
 * shared utilities. Every concrete adapter extends this rather than
 * implementing `ChannelAdapter` from scratch.
 *
 * Provides:
 * - Connection state tracking (`isConnected`)
 * - Inbound message emission helper (`emitInbound`)
 * - Scoped logging (`log`)
 * - Standard error result factories (`sdkMissing`, `authFailed`)
 *
 * Concrete adapters must define:
 * - `channelId` — stable identifier
 * - `capabilities` — declarative flags
 * - `tileMetadata` — UI tile data
 * - `configSchema` — Zod validation schema
 * - `connect(config, context)` — establish SDK connection
 * - `disconnect()` — tear down resources
 * - `send(message)` — deliver outbound message
 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  /** Stable unique identifier for this channel (e.g. 'signal', 'notion'). */
  abstract readonly channelId: string;

  /** Declarative capability flags used by ChannelManager and UI. */
  abstract readonly capabilities: AdapterCapabilities;

  /** Static UI-tile metadata for the channels-view panel. */
  abstract readonly tileMetadata: TileMetadata;

  /** Zod schema for validating config before connect. */
  abstract readonly configSchema: z.ZodType;

  /** Adapter context injected during connect, used for emit/logging. */
  protected ctx: AdapterContext | null = null;

  /** Internal connection state flag. */
  protected connected = false;

  /** Establish connection using the channel's SDK or API. */
  abstract connect(config: unknown, context: AdapterContext): Promise<ConnectResult>;

  /** Release all SDK resources and return to disconnected state. */
  abstract disconnect(): Promise<void>;

  /** Deliver an outbound message to the external channel. */
  abstract send(message: OutgoingMessage): Promise<SendResult>;

  /**
   * Returns whether this adapter is currently connected.
   * @satisfies REQ 1.2, REQ 1.3
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Emit an inbound message through the adapter context.
   * Convenience wrapper that constructs a proper `IncomingMessage`
   * from common fields. Adapters call this when they receive a
   * message from the external channel.
   *
   * @param from - Sender identifier (phone number, user ID, etc.)
   * @param content - Message content body
   * @param contentType - Content type, defaults to 'text'
   * @satisfies REQ 1.5
   */
  protected emitInbound(
    from: string,
    content: string,
    contentType?: 'text' | 'image' | 'audio' | 'video' | 'file' | 'other',
  ): void {
    if (!this.ctx) return;
    this.ctx.emit({
      channelId: this.channelId,
      from,
      content,
      timestamp: new Date(),
      contentType: contentType ?? 'text',
    });
  }

  /**
   * Scoped logging helper. Delegates to the adapter context logger
   * when available, otherwise silently discards (pre-connect calls).
   *
   * @param level - Log severity level
   * @param msg - Log message
   * @param extra - Optional structured metadata
   */
  protected log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!this.ctx) return;
    this.ctx.logger[level](msg, extra);
  }

  /**
   * Returns a standardized `ConnectResult` for when a required SDK
   * package is not installed. Adapters call this in their `connect`
   * method after detecting a missing dependency.
   *
   * @param packageName - The npm package that is missing
   * @returns ConnectResult with success=false, error code SDK_MISSING
   * @satisfies REQ 1.7
   */
  protected sdkMissing(packageName: string): ConnectResult {
    return {
      success: false,
      message: `SDK package "${packageName}" is not installed. Run: npm install ${packageName}`,
      error: { code: 'SDK_MISSING', message: `Package "${packageName}" not found` },
    };
  }

  /**
   * Returns a standardized `ConnectResult` for authentication failures.
   * Adapters call this when credentials are invalid or expired.
   *
   * @param detail - Human-readable description of the auth failure
   * @returns ConnectResult with success=false, error code AUTH_FAILED
   * @satisfies REQ 1.8
   */
  protected authFailed(detail: string): ConnectResult {
    return {
      success: false,
      message: `Authentication failed: ${detail}`,
      error: { code: 'AUTH_FAILED', message: detail },
    };
  }
}
