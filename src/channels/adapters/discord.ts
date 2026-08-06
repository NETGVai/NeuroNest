// ─── Discord Bot Adapter ────────────────────────────────────────
// Full ChannelAdapter implementation for Discord using the discord.js SDK.
// Uses websocket gateway via client.login() and routes all discord.js access
// through safeImport to handle missing SDK gracefully.
//
// Requirements: REQ 7.1, REQ 7.2, REQ 7.3, REQ 10.1, REQ 10.2, REQ 10.3,
// REQ 10.4, REQ 10.5, REQ 21.1, REQ 22.1

import { z } from 'zod';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { IncomingMessage, OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { safeImport } from '../import-validator';

// ─── Config Schema (REQ 5.1) ────────────────────────────────────

/**
 * Zod schema for Discord adapter configuration.
 * Requires a non-empty bot token obtained from the Discord Developer Portal.
 */
export const DiscordConfigSchema = z.object({
  token: z.string().min(1),
});

/** Inferred config type from DiscordConfigSchema. */
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

// ─── Constants ──────────────────────────────────────────────────

/** Maximum single-message length before chunking. */
const MAX_MESSAGE_LENGTH = 1900;

// ─── Discord Adapter ────────────────────────────────────────────

export class DiscordAdapter implements ChannelAdapter {
  readonly channelId = 'discord';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'websocket',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Discord',
    emoji: '🎮',
    description: 'Bot via discord.js',
    actionTags: ['send message', 'receive message', 'message chunking'],
    sortOrder: 30,
  };

  readonly configSchema = DiscordConfigSchema;

  private client: any = null;
  private connected = false;
  private ctx: AdapterContext | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg = 'Discord bot token is required. Add it in channel settings.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    const { token } = parsed.data;

    // Import discord.js via safeImport (REQ 7.1)
    let discordModule: any;
    try {
      discordModule = await safeImport('discord.js');
    } catch {
      const msg = 'Discord SDK not installed. Run: npm install discord.js';
      return {
        success: false,
        message: msg,
        error: { code: 'SDK_MISSING', message: msg },
      };
    }

    const { Client, GatewayIntentBits } = discordModule;

    // Instantiate Client with required intents
    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });
    } catch (err: unknown) {
      const msg = 'Failed to instantiate Discord Client';
      return {
        success: false,
        message: msg,
        error: { code: 'PROVIDER_ERROR', message: msg },
      };
    }

    // Register messageCreate handler (REQ 10.3)
    this.client.on('messageCreate', (message: any) => {
      if (!this.ctx) return;

      // REQ 10.3: when author.bot === true, discard silently;
      // when author.bot === false, emit an IncomingMessage;
      // when the bot-check itself throws (malformed author), emit rather than swallow.
      let isBot = false;
      try {
        isBot = message.author?.bot === true;
      } catch {
        // Malformed author — fall through and emit the message
        isBot = false;
      }

      if (isBot) return;

      const incoming: IncomingMessage = {
        channelId: 'discord',
        from: message.author?.id ?? message.author?.username ?? 'unknown',
        content: message.content ?? '',
        timestamp: message.createdAt ? new Date(message.createdAt) : new Date(),
        contentType: 'text',
        providerMetadata: {
          channelId: 'discord',
          guildId: message.guild?.id,
          channelId_: message.channel?.id ?? '',
          messageId: message.id,
        },
      };

      this.ctx.emit(incoming);
    });

    // Login with the bot token
    try {
      await this.client.login(token);
    } catch (err: unknown) {
      this.client = null;
      const errorCode = this.mapErrorCode(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Discord login failed: ${errMsg}`,
        error: { code: errorCode, message: errMsg },
      };
    }

    this.connected = true;
    context.logger.info('Connected', { channelId: 'discord' });

    return {
      success: true,
      message: 'Discord bot connected via websocket gateway',
    };
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.destroy();
      } catch {
        // Swallow errors on destroy — best effort
      }
      this.client = null;
    }
    this.connected = false;
    this.ctx = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.client) {
      return { success: false, message: 'Discord adapter is not connected' };
    }

    const channelId = message.to;

    // Fetch the target channel
    let channel: any;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to fetch channel: ${errMsg}` };
    }

    if (!channel || !channel.send) {
      return { success: false, message: `Channel ${channelId} not found or not a text channel` };
    }

    const content = message.content;

    // REQ 10.4: chunk content strictly when content.length > 1900
    // Exactly 1900 sends as a single message unchanged.
    if (content.length > MAX_MESSAGE_LENGTH) {
      const chunks = this.chunkContent(content);
      // Dispatch chunks sequentially so concatenation equals original content
      for (const chunk of chunks) {
        try {
          await channel.send(chunk);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { success: false, message: `Failed to send chunk: ${errMsg}` };
        }
      }
      return { success: true, message: `Message sent in ${chunks.length} chunks` };
    }

    // Single message — send as-is
    try {
      await channel.send(content);
      return { success: true, message: 'Message sent' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Splits content into chunks of at most MAX_MESSAGE_LENGTH characters.
   * Concatenation of all chunks in order equals the original content.
   */
  private chunkContent(content: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(content.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }

  /**
   * Maps an error to the appropriate ErrorCode.
   * Token-related errors → AUTH_FAILED, everything else → PROVIDER_ERROR.
   */
  private mapErrorCode(err: unknown): 'AUTH_FAILED' | 'PROVIDER_ERROR' {
    if (err && typeof err === 'object') {
      const code = (err as any).code;
      // discord.js uses 'TokenInvalid' error code for bad tokens
      if (code === 'TokenInvalid' || code === 'TOKEN_INVALID') {
        return 'AUTH_FAILED';
      }
      const message = (err as any).message ?? '';
      if (typeof message === 'string') {
        const lower = message.toLowerCase();
        if (lower.includes('token') || lower.includes('401') || lower.includes('unauthorized')) {
          return 'AUTH_FAILED';
        }
      }
    }
    return 'PROVIDER_ERROR';
  }
}
