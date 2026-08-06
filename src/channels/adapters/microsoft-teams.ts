// ─── Microsoft Teams Bot Framework Adapter ──────────────────────
// Full ChannelAdapter implementation for Microsoft Teams using the
// Bot Framework SDK (botbuilder). Routes inbound activities through
// a loopback HTTP listener on /api/messages.
//
// Requirements: REQ 4.7, REQ 4.8, REQ 7.1, REQ 7.2, REQ 7.3, REQ 7.4,
// REQ 16.1, REQ 16.2, REQ 16.3, REQ 16.4, REQ 16.5, REQ 16.6, REQ 16.7,
// REQ 16.8, REQ 19.2, REQ 19.4, REQ 21.1, REQ 22.1, REQ 23.1, REQ 23.3

import { z } from 'zod';
import * as http from 'node:http';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { IncomingMessage, OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { safeImport } from '../import-validator';
import { redactSecrets } from '../redact';

// ─── Constants ──────────────────────────────────────────────────

/** Default port for the Microsoft Teams /api/messages listener */
const TEAMS_DEFAULT_PORT = 9878;

/** Maximum number of conversation references to cache */
const CONVERSATION_REF_MAX_SIZE = 10_000;

/** TTL for conversation references: 30 days in milliseconds */
const CONVERSATION_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Config Schema (REQ 5.1) ────────────────────────────────────

/**
 * Zod schema for Microsoft Teams adapter configuration.
 * Validates required Azure Bot registration fields.
 */
export const TeamsConfigSchema = z.object({
  appId: z.string().uuid(),
  appPassword: z.string().min(1),
  tenantId: z.string().uuid(),
  listenerPort: z.number().int().optional(),
  listenerHost: z.string().optional(),
  remoteAccessExplicit: z.boolean().optional(),
});

type TeamsConfig = z.infer<typeof TeamsConfigSchema>;

// ─── Conversation Reference Entry ───────────────────────────────

interface ConversationRefEntry {
  ref: any;
  capturedAt: number;
}

// ─── Microsoft Teams Adapter ────────────────────────────────────

export class MicrosoftTeamsAdapter implements ChannelAdapter {
  readonly channelId = 'microsoft-teams';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: true,
    supportsRichMedia: true,
    deliveryMode: 'webhook',
    requiresListener: true,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Microsoft Teams',
    emoji: '🟣',
    description: 'Bot Framework integration',
    actionTags: ['send message', 'receive message', 'typing indicator', 'rich media'],
    sortOrder: 70,
  };

  readonly configSchema = TeamsConfigSchema;

  private server: http.Server | null = null;
  private connected = false;
  private ctx: AdapterContext | null = null;
  private config: TeamsConfig | null = null;
  private cloudAdapter: any = null;
  private conversationRefs: Map<string, ConversationRefEntry> = new Map();

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // ─── Import botbuilder SDK via safeImport (REQ 7.1) ───────────
    let botbuilder: any;
    try {
      botbuilder = await safeImport('botbuilder');
    } catch {
      const msg =
        'Microsoft Teams SDK not installed. Run: npm install botbuilder';
      return {
        success: false,
        message: msg,
        error: { code: 'SDK_MISSING', message: msg },
      };
    }

    // ─── Validate configuration (REQ 5.1, REQ 21.1) ──────────────
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const missingFields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
      const msg =
        `Microsoft Teams configuration is invalid. Missing or invalid fields: ${missingFields}.\n\n` +
        'Setup steps:\n' +
        '1. Register a Bot at https://dev.botframework.com/bots/new or via Azure Bot registration\n' +
        '2. Note your App ID (appId), App Password (appPassword), and Tenant ID (tenantId)\n' +
        '3. Connect with: /channel microsoft-teams appId=<uuid> appPassword=<secret> tenantId=<uuid>\n\n' +
        'See: https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // ─── Build Bot Framework authentication & adapter (REQ 16.1) ──
    try {
      const { ConfigurationBotFrameworkAuthentication, CloudAdapter } = botbuilder;

      const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: this.config.appId,
        MicrosoftAppPassword: this.config.appPassword,
        MicrosoftAppTenantId: this.config.tenantId,
      });

      this.cloudAdapter = new CloudAdapter(botFrameworkAuth);
    } catch (err: any) {
      const msg = `Failed to initialize Bot Framework adapter: ${err?.message ?? String(err)}`;
      return {
        success: false,
        message: msg,
        error: { code: 'PROVIDER_ERROR', message: msg },
      };
    }

    // ─── Reserve listener port (REQ 4.7) ─────────────────────────
    let listenerConfig;
    try {
      const reserveOpts: {
        port?: number;
        host?: string;
        remoteAccessExplicit?: boolean;
        defaultPort: number;
        name: string;
      } = {
        defaultPort: TEAMS_DEFAULT_PORT,
        name: 'Microsoft Teams /api/messages',
      };
      if (this.config.listenerPort !== undefined) reserveOpts.port = this.config.listenerPort;
      if (this.config.listenerHost !== undefined) reserveOpts.host = this.config.listenerHost;
      if (this.config.remoteAccessExplicit !== undefined) reserveOpts.remoteAccessExplicit = this.config.remoteAccessExplicit;
      listenerConfig = context.reserveListener(reserveOpts);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      return {
        success: false,
        message: msg,
        error: { code: 'LISTENER_PORT_CONFLICT', message: msg },
      };
    }

    // ─── Start loopback HTTP listener (REQ 22.1) ─────────────────
    try {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/messages') {
          this.handleInbound(req, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(listenerConfig.port, listenerConfig.host, () => {
          this.server!.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      context.releaseListener();
      return {
        success: false,
        message: `Failed to start Teams listener: ${msg}`,
        error: { code: 'NETWORK_ERROR', message: msg },
      };
    }

    this.connected = true;
    context.logger.info('Connected', { port: listenerConfig.port, host: listenerConfig.host });
    context.logger.info('Config (redacted)', redactSecrets({
      appId: this.config.appId,
      appPassword: this.config.appPassword,
      tenantId: this.config.tenantId,
    }) as Record<string, unknown>);

    return {
      success: true,
      message: `Microsoft Teams listener on ${listenerConfig.host}:${listenerConfig.port}/api/messages`,
    };
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.connected = false;
    this.config = null;
    this.cloudAdapter = null;
    this.conversationRefs.clear();
    if (this.ctx) {
      this.ctx.releaseListener();
      this.ctx = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config || !this.cloudAdapter) {
      return { success: false, message: 'Microsoft Teams adapter is not connected' };
    }

    // Opportunistic sweep before lookup
    this.sweepExpiredRefs();

    const entry = this.conversationRefs.get(message.to);
    if (!entry) {
      return {
        success: false,
        message: `No conversation reference for ${message.to}`,
      };
    }

    try {
      await this.cloudAdapter.continueConversationAsync(
        this.config.appId,
        entry.ref,
        async (turnContext: any) => {
          await turnContext.sendActivity({ type: 'message', text: message.content });
        },
      );
      return { success: true, message: 'Message sent via Teams' };
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      if (this.ctx) {
        this.ctx.logger.error('Send failed', { error: errMsg, to: message.to });
      }
      return { success: false, message: `Teams send failed: ${errMsg}` };
    }
  }

  // ─── Private: Inbound POST handling ─────────────────────────────

  private handleInbound(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.cloudAdapter || !this.ctx) {
      res.writeHead(503);
      res.end();
      return;
    }

    // Delegate to CloudAdapter.process which handles JWT validation (REQ 19.2)
    this.cloudAdapter.process(req, res, async (turnContext: any) => {
      const activity = turnContext.activity;
      if (!activity) return;

      // Capture conversation reference (REQ 16.4)
      const conversationRef = this.extractConversationReference(turnContext);
      const userId = this.resolveUserId(activity);

      if (conversationRef && userId) {
        this.storeConversationRef(userId, conversationRef);
      }

      // Route based on activity type (REQ 16.5, REQ 16.6)
      if (activity.type === 'message') {
        this.emitMessageActivity(activity, userId);
      } else if (activity.type === 'typing') {
        this.emitTypingActivity(activity, userId);
      }
    });
  }

  // ─── Private: Conversation reference management ─────────────────

  private extractConversationReference(turnContext: any): any {
    try {
      // TurnContext.getConversationReference is a static utility in botbuilder
      if (turnContext.activity) {
        // Build a minimal conversation reference from the activity
        const activity = turnContext.activity;
        return {
          activityId: activity.id,
          user: activity.from,
          bot: activity.recipient,
          conversation: activity.conversation,
          channelId: activity.channelId,
          locale: activity.locale,
          serviceUrl: activity.serviceUrl,
        };
      }
    } catch {
      // Silently fail — non-critical
    }
    return null;
  }

  private resolveUserId(activity: any): string {
    // Prefer AAD object ID (globally unique within Azure AD), fallback to activity.from.id
    return activity?.from?.aadObjectId ?? activity?.from?.id ?? '';
  }

  private storeConversationRef(userId: string, ref: any): void {
    if (!userId) return;

    this.conversationRefs.set(userId, {
      ref,
      capturedAt: Date.now(),
    });

    // Enforce LRU cap (REQ 16.4)
    if (this.conversationRefs.size > CONVERSATION_REF_MAX_SIZE) {
      this.evictOldest();
    }
  }

  private sweepExpiredRefs(): void {
    const now = Date.now();
    for (const [key, entry] of this.conversationRefs) {
      if (now - entry.capturedAt > CONVERSATION_REF_TTL_MS) {
        this.conversationRefs.delete(key);
      }
    }
  }

  private evictOldest(): void {
    // Remove entries beyond the cap, oldest first
    const entries = [...this.conversationRefs.entries()]
      .sort((a, b) => a[1].capturedAt - b[1].capturedAt);

    const toRemove = entries.length - CONVERSATION_REF_MAX_SIZE;
    for (let i = 0; i < toRemove; i++) {
      const entry = entries[i];
      if (entry) {
        this.conversationRefs.delete(entry[0]);
      }
    }
  }

  // ─── Private: Activity emission ─────────────────────────────────

  private emitMessageActivity(activity: any, userId: string): void {
    if (!this.ctx) return;

    const incoming: IncomingMessage = {
      channelId: 'microsoft-teams',
      from: userId,
      content: activity.text ?? '',
      timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
      contentType: 'text',
      providerMetadata: {
        channelId: 'microsoft-teams',
        activityType: 'message',
        aadObjectId: activity.from?.aadObjectId,
        conversationRef: userId,
      },
    };

    this.ctx.emit(incoming);
  }

  private emitTypingActivity(activity: any, userId: string): void {
    if (!this.ctx) return;

    const incoming: IncomingMessage = {
      channelId: 'microsoft-teams',
      from: userId,
      content: '',
      timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
      contentType: 'other',
      providerMetadata: {
        channelId: 'microsoft-teams',
        activityType: 'typing',
        aadObjectId: activity.from?.aadObjectId,
        conversationRef: userId,
      },
    };

    this.ctx.emit(incoming);
  }
}
