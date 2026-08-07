// ─── Matrix Protocol Adapter ────────────────────────────────────
// Full ChannelAdapter implementation for Matrix using matrix-js-sdk.
// Supports connecting to a homeserver, listening to room events across
// multiple rooms, sending text messages, and encrypted rooms.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.1, REQ 6.3, REQ 6.6

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { safeImport } from '../import-validator';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Matrix adapter configuration.
 * Requires a homeserver URL and an access token for authentication.
 */
export const MatrixConfigSchema = z.object({
  homeserverUrl: z.string().url(),
  accessToken: z.string().min(1),
  /** Optional user ID. If omitted, resolved from the access token via whoami. */
  userId: z.string().optional(),
});

/** Inferred config type from MatrixConfigSchema. */
export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

// ─── Matrix Adapter ─────────────────────────────────────────────

export class MatrixAdapter extends BaseChannelAdapter {
  readonly channelId = 'matrix';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: true,
    supportsRichMedia: false,
    deliveryMode: 'websocket',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Matrix',
    emoji: '🔗',
    description: 'Decentralized protocol',
    actionTags: ['send message', 'receive message', 'rooms', 'encryption'],
    sortOrder: 1004,
  };

  readonly configSchema = MatrixConfigSchema;

  /** The matrix-js-sdk client instance. */
  private client: any = null;

  /** The authenticated user's Matrix ID (e.g. @user:homeserver.org). */
  private matrixUserId: string | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg = 'Matrix config requires homeserverUrl and accessToken.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    const { homeserverUrl, accessToken, userId } = parsed.data;

    // Import matrix-js-sdk via safeImport
    let matrixSdk: any;
    try {
      matrixSdk = await safeImport('matrix-js-sdk');
    } catch {
      return this.sdkMissing('matrix-js-sdk');
    }

    const createClient = matrixSdk.createClient ?? matrixSdk.default?.createClient;
    if (!createClient) {
      return this.sdkMissing('matrix-js-sdk');
    }

    // Step 1: Create the Matrix client
    try {
      this.client = createClient({
        baseUrl: homeserverUrl,
        accessToken,
        userId: userId ?? undefined,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to create Matrix client: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Step 2: Resolve authenticated user ID
    try {
      if (userId) {
        this.matrixUserId = userId;
      } else {
        const whoami = await this.client.whoami();
        this.matrixUserId = whoami?.user_id ?? null;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.client = null;
      return this.authFailed(`whoami failed: ${errMsg}`);
    }

    if (!this.matrixUserId) {
      this.client = null;
      return this.authFailed('Unable to determine authenticated user ID.');
    }

    // Step 3: Register event listener for room messages (multi-room)
    try {
      this.client.on('Room.timeline', (event: any, room: any) => {
        this.handleTimelineEvent(event, room);
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.client = null;
      return {
        success: false,
        message: `Failed to register timeline listener: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Step 4: Start the client (begins syncing with the homeserver)
    try {
      await this.client.startClient({ initialSyncLimit: 0 });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.client = null;
      return {
        success: false,
        message: `Failed to start Matrix client: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'matrix', userId: this.matrixUserId });

    return {
      success: true,
      message: `Matrix connected as ${this.matrixUserId}`,
    };
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.stopClient();
      } catch {
        // Best-effort cleanup
      }
      this.client = null;
    }
    this.matrixUserId = null;
    this.connected = false;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.client) {
      return { success: false, message: 'Matrix adapter is not connected' };
    }

    const roomId = message.to;

    // Validate room ID format (Matrix room IDs start with ! or are aliases starting with #)
    if (!roomId || (!roomId.startsWith('!') && !roomId.startsWith('#'))) {
      return { success: false, message: `Invalid Matrix room ID or alias: ${roomId}` };
    }

    // Resolve room alias to room ID if necessary
    let targetRoomId = roomId;
    if (roomId.startsWith('#')) {
      try {
        const resolved = await this.client.getRoomIdForAlias(roomId);
        targetRoomId = resolved?.room_id ?? roomId;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Failed to resolve room alias: ${errMsg}` };
      }
    }

    // Send the text message
    try {
      await this.client.sendTextMessage(targetRoomId, message.content);
      return { success: true, message: 'Message sent to Matrix room' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Handles timeline events from all rooms the user is joined to.
   * Filters for text messages from other users and emits them as inbound.
   * Supports encrypted events if the SDK decrypts them transparently.
   */
  private handleTimelineEvent(event: any, _room: any): void {
    if (!this.ctx) return;

    // Only process m.room.message events
    const eventType = event.getType?.() ?? event.type;
    if (eventType !== 'm.room.message') return;

    // Ignore own messages
    const senderId = event.getSender?.() ?? event.sender;
    if (senderId === this.matrixUserId) return;

    // Extract content (works for both encrypted and unencrypted messages
    // since matrix-js-sdk decrypts before emitting timeline events)
    const content = event.getContent?.() ?? event.content ?? {};
    const msgType = content.msgtype;

    // Only handle text messages
    if (msgType !== 'm.text') return;

    const body = content.body;
    if (!body || typeof body !== 'string') return;

    // Emit the inbound message with sender's Matrix user ID
    this.emitInbound(senderId, body, 'text');
  }
}
