// ─── Slack Bot Adapter ──────────────────────────────────────────
// Full ChannelAdapter implementation for Slack using the @slack/bolt SDK.
// Uses Socket Mode via app.start() and routes all @slack/bolt access through
// safeImport to handle missing SDK gracefully.
//
// Requirements: REQ 7.1, REQ 7.2, REQ 7.3, REQ 11.1, REQ 11.2, REQ 11.3,
// REQ 11.4, REQ 11.5, REQ 21.1, REQ 22.1

import { z } from 'zod';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { IncomingMessage, OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { safeImport } from '../import-validator';

// ─── Config Schema (REQ 5.1, REQ 11.1) ─────────────────────────

/**
 * Zod schema for Slack adapter configuration.
 * Requires both a bot token (xoxb-...) and an app token (xapp-...)
 * for Socket Mode operation.
 */
export const SlackConfigSchema = z.object({
  botToken: z.string().min(1),
  appToken: z.string().min(1),
});

/** Inferred config type from SlackConfigSchema. */
export type SlackConfig = z.infer<typeof SlackConfigSchema>;

// ─── Slack Adapter ──────────────────────────────────────────────

export class SlackAdapter implements ChannelAdapter {
  readonly channelId = 'slack';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'websocket',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Slack',
    emoji: '💼',
    description: 'Socket Mode via @slack/bolt',
    actionTags: ['send message', 'receive message', 'socket mode'],
    sortOrder: 40,
  };

  readonly configSchema = SlackConfigSchema;

  private app: any = null;
  private connected = false;
  private ctx: AdapterContext | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config (REQ 11.1)
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Slack requires both a Bot Token (xoxb-...) and an App Token (xapp-...). Add them in channel settings.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    const { botToken, appToken } = parsed.data;

    // Import @slack/bolt via safeImport (REQ 7.1)
    let boltModule: any;
    try {
      boltModule = await safeImport('@slack/bolt');
    } catch {
      const msg = 'Slack SDK not installed. Run: npm install @slack/bolt';
      return {
        success: false,
        message: msg,
        error: { code: 'SDK_MISSING', message: msg },
      };
    }

    const App = boltModule.App ?? boltModule.default?.App;

    // Step 1: Instantiate App with socket mode (REQ 11.2)
    try {
      this.app = new App({
        token: botToken,
        appToken: appToken,
        socketMode: true,
      });
    } catch (err: unknown) {
      this.app = null;
      const errorCode = this.classifyError(err);
      const msg = 'Instantiate App({ token, appToken, socketMode: true })';
      return {
        success: false,
        message: msg,
        error: { code: errorCode, message: msg },
      };
    }

    // Step 2: Register message event handler (REQ 11.2, REQ 11.3)
    try {
      this.app.message(async ({ message: payload }: any) => {
        if (!this.ctx) return;

        // REQ 11.3: if the payload has a `subtype` field (regardless of value), discard
        if (payload && 'subtype' in payload) {
          return;
        }

        const incoming: IncomingMessage = {
          channelId: 'slack',
          from: payload?.user ?? payload?.bot_id ?? 'unknown',
          content: payload?.text ?? '',
          timestamp: payload?.ts
            ? new Date(parseFloat(payload.ts) * 1000)
            : new Date(),
          contentType: 'text',
          providerMetadata: {
            channelId: 'slack',
            ts: payload?.ts ?? '',
            thread_ts: payload?.thread_ts,
            teamId: payload?.team,
          },
        };

        this.ctx.emit(incoming);
      });
    } catch (err: unknown) {
      this.app = null;
      const errorCode = this.classifyError(err);
      const msg = 'Register message event handler';
      return {
        success: false,
        message: msg,
        error: { code: errorCode, message: msg },
      };
    }

    // Step 3: Call app.start() (REQ 11.2)
    try {
      await this.app.start();
    } catch (err: unknown) {
      this.app = null;
      const errorCode = this.classifyError(err);
      const msg = 'Call app.start()';
      return {
        success: false,
        message: msg,
        error: { code: errorCode, message: msg },
      };
    }

    this.connected = true;
    context.logger.info('Connected', { channelId: 'slack' });

    return {
      success: true,
      message: 'Slack connected via Socket Mode',
    };
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // Swallow errors on stop — best effort
      }
      this.app = null;
    }
    this.connected = false;
    this.ctx = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.app) {
      return { success: false, message: 'Slack adapter is not connected' };
    }

    // REQ 11.4: send via app.client.chat.postMessage
    try {
      await this.app.client.chat.postMessage({
        channel: message.to,
        text: message.content,
      });
      return { success: true, message: 'Message sent' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Classifies a connect-time error into the appropriate ErrorCode per REQ 11.5.
   *
   * Precedence:
   * 1. HTTP 401/403 or Bolt AuthorizationError → AUTH_FAILED
   * 2. ECONNREFUSED/ETIMEDOUT/ENOTFOUND or socket-mode TransportError → NETWORK_ERROR
   * 3. Everything else → PROVIDER_ERROR
   */
  private classifyError(err: unknown): 'AUTH_FAILED' | 'NETWORK_ERROR' | 'PROVIDER_ERROR' {
    if (!err || typeof err !== 'object') {
      return 'PROVIDER_ERROR';
    }

    const errObj = err as any;
    const code = errObj.code ?? '';
    const name = errObj.name ?? '';
    const message = errObj.message ?? '';
    const statusCode = errObj.statusCode ?? errObj.status ?? errObj.data?.response_metadata?.status;

    // AUTH_FAILED: HTTP 401/403 or AuthorizationError
    if (statusCode === 401 || statusCode === 403) {
      return 'AUTH_FAILED';
    }
    if (
      name === 'AuthorizationError' ||
      code === 'slack_webapi_platform_error' &&
        (message.includes('invalid_auth') || message.includes('not_authed'))
    ) {
      return 'AUTH_FAILED';
    }
    if (typeof message === 'string') {
      const lower = message.toLowerCase();
      if (
        lower.includes('invalid_auth') ||
        lower.includes('not_authed') ||
        lower.includes('token_revoked') ||
        lower.includes('account_inactive')
      ) {
        return 'AUTH_FAILED';
      }
    }

    // NETWORK_ERROR: ECONNREFUSED/ETIMEDOUT/ENOTFOUND or TransportError
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND'
    ) {
      return 'NETWORK_ERROR';
    }
    if (name === 'TransportError' || code === 'TransportError') {
      return 'NETWORK_ERROR';
    }
    if (typeof message === 'string') {
      const lower = message.toLowerCase();
      if (
        lower.includes('econnrefused') ||
        lower.includes('etimedout') ||
        lower.includes('enotfound') ||
        lower.includes('socket hang up') ||
        lower.includes('transport error')
      ) {
        return 'NETWORK_ERROR';
      }
    }

    return 'PROVIDER_ERROR';
  }
}
