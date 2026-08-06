// ─── Telegram Bot API Adapter ───────────────────────────────────
// Full ChannelAdapter implementation for Telegram using the grammy SDK.
// Uses long-polling via bot.start() and routes all grammy access through
// safeImport to handle missing SDK gracefully.
//
// Requirements: REQ 7.1, REQ 7.2, REQ 7.3, REQ 9.1, REQ 9.2, REQ 9.3,
// REQ 9.4, REQ 18.1, REQ 18.4, REQ 21.1, REQ 22.1

import { z } from 'zod';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { IncomingMessage, OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { safeImport } from '../import-validator';

// ─── Config Schema (REQ 5.1) ────────────────────────────────────

/**
 * Zod schema for Telegram adapter configuration.
 * Requires a non-empty bot token obtained from @BotFather.
 */
export const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
});

/** Inferred config type from TelegramConfigSchema. */
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

// ─── Telegram Adapter ───────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly channelId = 'telegram';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: true,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Telegram',
    emoji: '✈️',
    description: 'Bot API via grammy',
    actionTags: ['send message', 'receive message', 'typing indicator'],
    sortOrder: 20,
  };

  readonly configSchema = TelegramConfigSchema;

  private bot: any = null;
  private connected = false;
  private ctx: AdapterContext | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg = 'Telegram bot token is required. Add it in channel settings.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    const { botToken } = parsed.data;

    // Import grammy via safeImport
    let grammyModule: any;
    try {
      grammyModule = await safeImport('grammy');
    } catch {
      const msg = 'Telegram SDK not installed. Run: npm install grammy';
      return {
        success: false,
        message: msg,
        error: { code: 'SDK_MISSING', message: msg },
      };
    }

    const Bot = grammyModule.Bot ?? grammyModule.default?.Bot;

    // Step 1: Instantiate Bot
    try {
      this.bot = new Bot(botToken);
    } catch (err: unknown) {
      const msg = 'Instantiate Bot(botToken)';
      const errorCode = this.mapErrorCode(err);
      return {
        success: false,
        message: msg,
        error: { code: errorCode, message: msg },
      };
    }

    // Step 2: Register message:text handler
    try {
      this.bot.on('message:text', (grammyCtx: any) => {
        if (!this.ctx) return;
        const incoming: IncomingMessage = {
          channelId: 'telegram',
          from: String(grammyCtx.message?.chat?.id ?? grammyCtx.from?.id ?? ''),
          content: grammyCtx.message?.text ?? '',
          timestamp: new Date((grammyCtx.message?.date ?? 0) * 1000),
          contentType: 'text',
          providerMetadata: {
            channelId: 'telegram',
            chatId: grammyCtx.message?.chat?.id ?? 0,
            messageId: grammyCtx.message?.message_id,
          },
        };
        this.ctx.emit(incoming);
      });
    } catch (err: unknown) {
      const msg = 'Register message:text handler';
      const errorCode = this.mapErrorCode(err);
      return {
        success: false,
        message: msg,
        error: { code: errorCode, message: msg },
      };
    }

    // Step 3: Install bot.catch
    try {
      this.bot.catch((err: unknown) => {
        if (this.ctx) {
          this.ctx.logger.error('Grammy bot error', { error: String(err) });
        }
      });
    } catch (err: unknown) {
      const msg = 'Install bot.catch';
      const errorCode = this.mapErrorCode(err);
      return {
        success: false,
        message: msg,
        error: { code: errorCode, message: msg },
      };
    }

    // Step 4: Call bot.start()
    try {
      // bot.start() returns a promise that resolves when polling begins.
      // We don't await indefinitely; grammy's start resolves once polling is active.
      await this.bot.start();
    } catch (err: unknown) {
      const msg = 'Call bot.start()';
      const errorCode = this.mapErrorCode(err);
      return {
        success: false,
        message: msg,
        error: { code: errorCode, message: msg },
      };
    }

    this.connected = true;
    context.logger.info('Connected', { channelId: 'telegram' });

    return {
      success: true,
      message: 'Telegram bot connected via long-polling',
    };
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      try {
        await this.bot.stop();
      } catch {
        // Swallow errors on stop — best effort
      }
      this.bot = null;
    }
    this.connected = false;
    this.ctx = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.bot) {
      return { success: false, message: 'Telegram adapter is not connected' };
    }

    const chatId = message.to;

    // Send typing indicator first — abort on failure
    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Typing indicator failed: ${errMsg}` };
    }

    // Attempt Markdown-parsed delivery, fall back to plain text on parse errors
    try {
      await this.bot.api.sendMessage(chatId, message.content, { parse_mode: 'Markdown' });
      return { success: true, message: 'Message sent with Markdown' };
    } catch (markdownErr: unknown) {
      // Check if this is a parse error (grammy reports 400 for bad Markdown)
      const isParseError = this.isParseError(markdownErr);
      if (!isParseError) {
        // Non-parse error — don't retry
        const errMsg = markdownErr instanceof Error ? markdownErr.message : String(markdownErr);
        return { success: false, message: `Send failed: ${errMsg}` };
      }

      // Fall back to plain text
      try {
        await this.bot.api.sendMessage(chatId, message.content);
        return { success: true, message: 'Message sent as plain text (Markdown fallback)' };
      } catch (plainErr: unknown) {
        const errMsg = plainErr instanceof Error ? plainErr.message : String(plainErr);
        return { success: false, message: `Send failed: ${errMsg}` };
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Maps an error to the appropriate ErrorCode.
   * HTTP 401 → AUTH_FAILED, everything else → PROVIDER_ERROR.
   */
  private mapErrorCode(err: unknown): 'AUTH_FAILED' | 'PROVIDER_ERROR' {
    if (err && typeof err === 'object') {
      const statusCode = (err as any).statusCode ?? (err as any).status ?? (err as any).error_code;
      if (statusCode === 401) {
        return 'AUTH_FAILED';
      }
      // grammy HttpError exposes .status
      const message = (err as any).message ?? '';
      if (typeof message === 'string' && message.includes('401')) {
        return 'AUTH_FAILED';
      }
    }
    return 'PROVIDER_ERROR';
  }

  /**
   * Determines if a grammy error is a Telegram parse error (bad Markdown).
   * Telegram returns HTTP 400 with description containing "can't parse"
   * when Markdown formatting is invalid.
   */
  private isParseError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const description = (err as any).description ?? (err as any).message ?? '';
    if (typeof description === 'string') {
      const lower = description.toLowerCase();
      return lower.includes("can't parse") || lower.includes('bad request: can\'t parse');
    }
    return false;
  }
}
