// ─── Nostr Protocol Adapter ─────────────────────────────────────
// Full ChannelAdapter implementation for the Nostr decentralized network.
// Connects to Nostr relays via WebSocket, subscribes to NIP-04 encrypted
// DMs addressed to the configured key, and sends encrypted DMs using the
// configured private key.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.1, REQ 6.4

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Nostr adapter configuration.
 * Requires a private key (nsec or hex format) and at least one relay URL.
 */
export const NostrConfigSchema = z.object({
  /** Private key in nsec (NIP-19 bech32) or 64-char hex format */
  privateKey: z.string().min(1),
  /** Array of relay WebSocket URLs to connect to */
  relayUrls: z.array(z.string().url()).min(1),
});

/** Inferred config type from NostrConfigSchema. */
export type NostrConfig = z.infer<typeof NostrConfigSchema>;

// ─── Nostr Utilities ────────────────────────────────────────────

/**
 * Minimal Nostr event structure per NIP-01.
 */
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * NIP-04 encrypted direct message kind.
 */
const KIND_ENCRYPTED_DM = 4;

// ─── Nostr Adapter ──────────────────────────────────────────────

export class NostrAdapter extends BaseChannelAdapter {
  readonly channelId = 'nostr';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'websocket',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Nostr',
    emoji: '🌐',
    description: 'Decentralized DMs',
    actionTags: ['send message', 'receive message', 'publish notes'],
    sortOrder: 1005,
  };

  readonly configSchema = NostrConfigSchema;

  /** The nostr-tools library loaded dynamically. */
  private nostrTools: any = null;

  /** WebSocket connections to relays. */
  private relayConnections: Array<{ url: string; ws: any; subscriptionId?: string }> = [];

  /** Decoded private key (Uint8Array or hex). */
  private privateKeyHex: string | null = null;

  /** Our public key (hex). */
  private publicKeyHex: string | null = null;

  /** Our public key in npub format for logging. */
  private npub: string | null = null;

  /** Set of seen event IDs to deduplicate across relays. */
  private seenEventIds = new Set<string>();

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Nostr adapter requires a private key and at least one relay URL.\n\n' +
        'Config format: { privateKey: "nsec1..." or hex, relayUrls: ["wss://relay.example.com"] }\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    const { privateKey, relayUrls } = parsed.data;

    // Import nostr-tools dynamically (optional dependency)
    let nostrTools: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nostrTools = require('nostr-tools');
    } catch {
      return this.sdkMissing('nostr-tools');
    }

    this.nostrTools = nostrTools;

    // Decode the private key (supports nsec bech32 or raw hex)
    try {
      this.privateKeyHex = this.decodePrivateKey(privateKey, nostrTools);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.authFailed(`Invalid private key: ${errMsg}`);
    }

    // Derive public key from private key
    try {
      this.publicKeyHex = nostrTools.getPublicKey(this.privateKeyHex);
      // Encode to npub for display
      const nip19 = nostrTools.nip19 ?? nostrTools;
      if (nip19.npubEncode) {
        this.npub = nip19.npubEncode(this.publicKeyHex);
      } else {
        this.npub = (this.publicKeyHex ?? '').slice(0, 16) + '...';
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.cleanup();
      return this.authFailed(`Failed to derive public key: ${errMsg}`);
    }

    // Connect to relays and subscribe to DMs
    try {
      await this.connectToRelays(relayUrls);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.cleanup();
      return {
        success: false,
        message: `Failed to connect to relays: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Verify at least one relay connected
    if (this.relayConnections.length === 0) {
      this.cleanup();
      return {
        success: false,
        message: 'Could not connect to any Nostr relay',
        error: { code: 'PROVIDER_ERROR', message: 'All relay connections failed' },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', {
      channelId: 'nostr',
      npub: this.npub,
      relayCount: this.relayConnections.length,
    });

    return {
      success: true,
      message: `Nostr connected as ${this.npub} via ${this.relayConnections.length} relay(s)`,
    };
  }

  async disconnect(): Promise<void> {
    this.cleanup();
    this.connected = false;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.nostrTools || !this.privateKeyHex || !this.publicKeyHex) {
      return { success: false, message: 'Nostr adapter is not connected' };
    }

    const recipientPubkey = message.to;

    // Validate recipient pubkey — accept hex or npub format
    let recipientHex: string;
    try {
      recipientHex = this.resolveRecipientPubkey(recipientPubkey);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Invalid recipient: ${errMsg}` };
    }

    // Encrypt content using NIP-04
    let encryptedContent: string;
    try {
      const nip04 = this.nostrTools.nip04 ?? this.nostrTools;
      encryptedContent = await nip04.encrypt(this.privateKeyHex, recipientHex, message.content);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Encryption failed: ${errMsg}` };
    }

    // Build the NIP-04 encrypted DM event
    let signedEvent: NostrEvent;
    try {
      const event = {
        kind: KIND_ENCRYPTED_DM,
        pubkey: this.publicKeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientHex]],
        content: encryptedContent,
      };

      // Sign the event
      const finishEvent = this.nostrTools.finalizeEvent ?? this.nostrTools.finishEvent;
      if (finishEvent) {
        signedEvent = finishEvent(event, this.privateKeyHex);
      } else {
        // Fallback: manual signing using getEventHash + getSignature
        const eventId = this.nostrTools.getEventHash(event);
        const sig = this.nostrTools.getSignature(event, this.privateKeyHex);
        signedEvent = { ...event, id: eventId, sig } as NostrEvent;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to create signed event: ${errMsg}` };
    }

    // Publish to all connected relays
    let publishedToAny = false;
    const errors: string[] = [];

    for (const relay of this.relayConnections) {
      try {
        this.publishEventToRelay(relay.ws, signedEvent);
        publishedToAny = true;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`${relay.url}: ${errMsg}`);
      }
    }

    if (!publishedToAny) {
      return { success: false, message: `Failed to publish to any relay: ${errors.join('; ')}` };
    }

    return { success: true, message: `DM sent via ${this.relayConnections.length} relay(s)` };
  }

  // ─── Private: Key handling ────────────────────────────────────────

  /**
   * Decode a private key from nsec bech32 or raw hex format.
   */
  private decodePrivateKey(key: string, nostrTools: any): string {
    // If it starts with 'nsec', decode using NIP-19
    if (key.startsWith('nsec')) {
      const nip19 = nostrTools.nip19 ?? nostrTools;
      if (nip19.decode) {
        const decoded = nip19.decode(key);
        if (decoded.type !== 'nsec') {
          throw new Error('Expected nsec key type');
        }
        // decoded.data is typically a Uint8Array or hex string
        const data = decoded.data;
        if (typeof data === 'string') return data;
        if (data instanceof Uint8Array) {
          return Array.from(data).map((b: number) => b.toString(16).padStart(2, '0')).join('');
        }
        throw new Error('Unexpected nsec decode result type');
      }
      throw new Error('nip19.decode not available in nostr-tools');
    }

    // Otherwise treat as raw hex (64 characters)
    if (/^[0-9a-f]{64}$/i.test(key)) {
      return key.toLowerCase();
    }

    throw new Error('Private key must be nsec1... (bech32) or 64-char hex');
  }

  /**
   * Resolve a recipient identifier to a hex pubkey.
   * Accepts npub bech32 or raw 64-char hex.
   */
  private resolveRecipientPubkey(recipient: string): string {
    if (recipient.startsWith('npub')) {
      const nip19 = this.nostrTools.nip19 ?? this.nostrTools;
      if (nip19.decode) {
        const decoded = nip19.decode(recipient);
        if (decoded.type !== 'npub') {
          throw new Error('Expected npub key type');
        }
        const data = decoded.data;
        if (typeof data === 'string') return data;
        if (data instanceof Uint8Array) {
          return Array.from(data).map((b: number) => b.toString(16).padStart(2, '0')).join('');
        }
        throw new Error('Unexpected npub decode result type');
      }
      throw new Error('nip19.decode not available');
    }

    if (/^[0-9a-f]{64}$/i.test(recipient)) {
      return recipient.toLowerCase();
    }

    throw new Error('Recipient must be npub1... (bech32) or 64-char hex pubkey');
  }

  // ─── Private: Relay connections ───────────────────────────────────

  /**
   * Connect to relay WebSocket URLs and set up DM subscriptions.
   */
  private async connectToRelays(relayUrls: string[]): Promise<void> {
    const WebSocket = await this.getWebSocketImpl();

    const connectionPromises = relayUrls.map(async (url) => {
      try {
        const ws = new WebSocket(url);
        await this.waitForOpen(ws);

        // Subscribe to NIP-04 encrypted DMs addressed to us
        const subscriptionId = this.generateSubscriptionId();
        const filter = {
          kinds: [KIND_ENCRYPTED_DM],
          '#p': [this.publicKeyHex!],
          since: Math.floor(Date.now() / 1000), // Only new messages from now
        };

        const subscribeMsg = JSON.stringify(['REQ', subscriptionId, filter]);
        ws.send(subscribeMsg);

        // Listen for incoming events
        ws.on('message', (data: any) => {
          this.handleRelayMessage(data, url);
        });

        ws.on('close', () => {
          this.log('info', `Relay connection closed: ${url}`);
          this.relayConnections = this.relayConnections.filter((r) => r.url !== url);
        });

        ws.on('error', (err: any) => {
          this.log('warn', `Relay error: ${url}`, {
            error: err?.message ?? String(err),
          });
        });

        this.relayConnections.push({ url, ws, subscriptionId });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log('warn', `Failed to connect to relay: ${url}`, { error: errMsg });
        // Don't throw — continue with other relays
      }
    });

    await Promise.allSettled(connectionPromises);
  }

  /**
   * Get a WebSocket implementation (Node.js ws or native).
   */
  private async getWebSocketImpl(): Promise<any> {
    // Try Node.js ws package first (common in Electron main process)
    try {
      const ws = await import('ws');
      return ws.default ?? ws;
    } catch {
      // Fallback to native WebSocket if available (e.g. in modern Node 21+)
      if (typeof globalThis.WebSocket !== 'undefined') {
        return globalThis.WebSocket;
      }
      throw new Error('No WebSocket implementation available. Install the "ws" package.');
    }
  }

  /**
   * Wait for a WebSocket to open with a timeout.
   */
  private waitForOpen(ws: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.on('error', (err: any) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Handle a message received from a relay WebSocket.
   */
  private handleRelayMessage(data: any, relayUrl: string): void {
    if (!this.ctx || !this.nostrTools || !this.privateKeyHex) return;

    let parsed: any[];
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      return; // Ignore unparseable messages
    }

    // Nostr relay responses: ['EVENT', subscriptionId, event]
    if (!Array.isArray(parsed) || parsed[0] !== 'EVENT' || !parsed[2]) return;

    const event: NostrEvent = parsed[2];

    // Validate it's a NIP-04 DM
    if (event.kind !== KIND_ENCRYPTED_DM) return;

    // Deduplicate across relays
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);

    // Prune seen IDs set to prevent unbounded growth
    if (this.seenEventIds.size > 10000) {
      const idsArray = Array.from(this.seenEventIds);
      this.seenEventIds = new Set(idsArray.slice(-5000));
    }

    // Ignore our own messages
    if (event.pubkey === this.publicKeyHex) return;

    // Decrypt the content using NIP-04
    this.decryptAndEmit(event).catch((err) => {
      this.log('warn', 'Failed to decrypt DM', {
        eventId: event.id,
        error: err?.message ?? String(err),
        relay: relayUrl,
      });
    });
  }

  /**
   * Decrypt a NIP-04 DM event and emit it as an inbound message.
   */
  private async decryptAndEmit(event: NostrEvent): Promise<void> {
    if (!this.nostrTools || !this.privateKeyHex) return;

    const nip04 = this.nostrTools.nip04 ?? this.nostrTools;
    const decrypted = await nip04.decrypt(this.privateKeyHex, event.pubkey, event.content);

    if (!decrypted || typeof decrypted !== 'string') return;

    // Encode sender pubkey as npub for the `from` field
    let senderNpub: string;
    const nip19 = this.nostrTools.nip19 ?? this.nostrTools;
    if (nip19.npubEncode) {
      senderNpub = nip19.npubEncode(event.pubkey);
    } else {
      senderNpub = event.pubkey;
    }

    this.emitInbound(senderNpub, decrypted, 'text');
  }

  // ─── Private: Event publishing ────────────────────────────────────

  /**
   * Publish a signed event to a relay WebSocket.
   */
  private publishEventToRelay(ws: any, event: NostrEvent): void {
    const msg = JSON.stringify(['EVENT', event]);
    ws.send(msg);
  }

  // ─── Private: Subscription ID ─────────────────────────────────────

  /**
   * Generate a random subscription ID for relay requests.
   */
  private generateSubscriptionId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = 'neuronest_';
    for (let i = 0; i < 12; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  // ─── Private: Cleanup ─────────────────────────────────────────────

  /**
   * Clean up all relay connections and internal state.
   */
  private cleanup(): void {
    for (const relay of this.relayConnections) {
      try {
        // Unsubscribe before closing
        if (relay.subscriptionId && relay.ws?.readyState === 1) {
          const closeMsg = JSON.stringify(['CLOSE', relay.subscriptionId]);
          relay.ws.send(closeMsg);
        }
        relay.ws?.close?.();
      } catch {
        // Best-effort cleanup
      }
    }
    this.relayConnections = [];
    this.privateKeyHex = null;
    this.publicKeyHex = null;
    this.npub = null;
    this.nostrTools = null;
    this.seenEventIds.clear();
  }
}
