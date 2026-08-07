// ─── Twitter/X Adapter ──────────────────────────────────────────
// Full ChannelAdapter implementation for Twitter/X using the API v2.
// Supports posting tweets, replying to mentions, and sending/receiving DMs.
// Polls for new DMs and mentions at a configurable interval.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 4.1

import { z } from 'zod';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { BaseChannelAdapter } from './base-adapter';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Twitter/X adapter configuration.
 * Requires API key, API secret, bearer token, and access token + secret
 * for user-context actions (DMs, posting on behalf of user).
 */
export const TwitterXConfigSchema = z.object({
  /** Twitter/X API Key (Consumer Key) */
  apiKey: z.string().min(1),
  /** Twitter/X API Secret (Consumer Secret) */
  apiSecret: z.string().min(1),
  /** Twitter/X Bearer Token for app-only requests */
  bearerToken: z.string().min(1),
  /** OAuth 1.0a Access Token for user-context requests */
  accessToken: z.string().min(1),
  /** OAuth 1.0a Access Token Secret for user-context requests */
  accessTokenSecret: z.string().min(1),
  /** Polling interval in seconds for new DMs and mentions (default: 30) */
  pollIntervalSeconds: z.number().int().min(10).max(300).default(30),
});

export type TwitterXConfig = z.infer<typeof TwitterXConfigSchema>;

// ─── Constants ──────────────────────────────────────────────────

const TWITTER_API_BASE = 'https://api.twitter.com';
const API_VERSION = '2';

// ─── Twitter/X Adapter ──────────────────────────────────────────

export class TwitterXAdapter extends BaseChannelAdapter {
  readonly channelId = 'twitter-x';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Twitter/X',
    emoji: '🐦',
    description: 'Twitter/X DMs and mentions via API v2',
    actionTags: ['send DM', 'receive DM', 'reply to mention', 'post tweet'],
    sortOrder: 1100,
  };

  readonly configSchema = TwitterXConfigSchema;

  private config: TwitterXConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private authenticatedUserId: string | null = null;
  private lastDmEventId: string | null = null;
  private lastMentionId: string | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Twitter/X adapter requires API credentials.\n\n' +
        'Setup steps:\n' +
        '1. Create a Twitter/X developer app at https://developer.twitter.com\n' +
        '2. Enable OAuth 1.0a and generate Access Token + Secret\n' +
        '3. Generate a Bearer Token for app-only requests\n' +
        '4. Ensure the app has Read, Write, and Direct Messages permissions\n' +
        '5. Connect with: apiKey, apiSecret, bearerToken, accessToken, accessTokenSecret\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify credentials by fetching the authenticated user
    try {
      const meResponse = await this.apiRequest('GET', `/${API_VERSION}/users/me`);
      const meData = JSON.parse(meResponse.body);

      if (!meData.data?.id) {
        return this.authFailed('Unable to retrieve authenticated user. Check your credentials.');
      }

      this.authenticatedUserId = meData.data.id;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.isAuthError(err)) {
        return this.authFailed(errMsg);
      }
      return {
        success: false,
        message: `Failed to connect to Twitter/X API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start polling for new DMs and mentions
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected', {
      userId: this.authenticatedUserId,
      pollInterval: this.config.pollIntervalSeconds,
    });

    return {
      success: true,
      message: `Twitter/X connected as user ${this.authenticatedUserId}`,
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.config = null;
    this.authenticatedUserId = null;
    this.lastDmEventId = null;
    this.lastMentionId = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Twitter/X adapter is not connected' };
    }

    // Determine delivery method based on the `to` field format:
    // - "dm:<user_id>" → send a Direct Message
    // - "reply:<tweet_id>" → reply to a tweet/mention
    // - Otherwise treat as a DM to a user ID
    if (message.to.startsWith('dm:')) {
      return this.sendDirectMessage(message.to.slice(3), message.content);
    } else if (message.to.startsWith('reply:')) {
      return this.replyToTweet(message.to.slice(6), message.content);
    } else {
      // Default: send as DM
      return this.sendDirectMessage(message.to, message.content);
    }
  }

  // ─── Private: Send Direct Message via API v2 ──────────────────

  private async sendDirectMessage(participantId: string, text: string): Promise<SendResult> {
    const body = JSON.stringify({
      text,
    });

    try {
      const response = await this.apiRequest(
        'POST',
        `/${API_VERSION}/dm_conversations/with/${participantId}/messages`,
        body,
      );
      const data = JSON.parse(response.body);

      if (data.errors) {
        const errMsg = data.errors[0]?.message || 'Unknown Twitter API error';
        this.log('error', 'DM send failed', { error: errMsg, to: participantId });
        return { success: false, message: `DM send failed: ${errMsg}` };
      }

      return { success: true, message: `DM sent to user ${participantId}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'DM send failed', { error: errMsg, to: participantId });
      return { success: false, message: `Twitter/X DM send failed: ${errMsg}` };
    }
  }

  // ─── Private: Reply to a Tweet/Mention ────────────────────────

  private async replyToTweet(tweetId: string, text: string): Promise<SendResult> {
    const body = JSON.stringify({
      text,
      reply: {
        in_reply_to_tweet_id: tweetId,
      },
    });

    try {
      const response = await this.apiRequest('POST', `/${API_VERSION}/tweets`, body);
      const data = JSON.parse(response.body);

      if (data.errors) {
        const errMsg = data.errors[0]?.message || 'Unknown Twitter API error';
        this.log('error', 'Reply failed', { error: errMsg, tweetId });
        return { success: false, message: `Reply failed: ${errMsg}` };
      }

      return { success: true, message: `Replied to tweet ${tweetId}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Reply failed', { error: errMsg, tweetId });
      return { success: false, message: `Twitter/X reply failed: ${errMsg}` };
    }
  }

  // ─── Private: Polling for DMs and Mentions ────────────────────

  private startPolling(): void {
    if (!this.config) return;

    const intervalMs = this.config.pollIntervalSeconds * 1000;

    this.pollTimer = setInterval(() => {
      this.pollDirectMessages().catch((err) => {
        this.log('warn', 'DM poll error', { error: err instanceof Error ? err.message : String(err) });
      });
      this.pollMentions().catch((err) => {
        this.log('warn', 'Mentions poll error', { error: err instanceof Error ? err.message : String(err) });
      });
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ─── Private: Poll Direct Messages ────────────────────────────

  private async pollDirectMessages(): Promise<void> {
    if (!this.connected || !this.config || !this.authenticatedUserId) return;

    let path = `/${API_VERSION}/dm_events?dm_event.fields=id,text,sender_id,created_at&event_types=MessageCreate`;

    // Only fetch events newer than the last seen one
    if (this.lastDmEventId) {
      path += `&since_id=${this.lastDmEventId}`;
    } else {
      // On first poll, only look at recent messages (max 5) to avoid replay
      path += '&max_results=5';
    }

    try {
      const response = await this.apiRequest('GET', path);
      const data = JSON.parse(response.body);

      if (!data.data || !Array.isArray(data.data)) return;

      // Process messages oldest-first
      const events = data.data.reverse();

      for (const event of events) {
        const senderId = event.sender_id;
        const text = event.text;
        const eventId = event.id;

        // Skip messages sent by us
        if (senderId === this.authenticatedUserId) continue;

        // Skip if we've already seen this event
        if (this.lastDmEventId && eventId <= this.lastDmEventId) continue;

        if (senderId && text) {
          this.emitInbound(`dm:${senderId}`, text, 'text');
        }

        // Track the latest event ID
        if (!this.lastDmEventId || eventId > this.lastDmEventId) {
          this.lastDmEventId = eventId;
        }
      }
    } catch (err: unknown) {
      // Swallow poll errors — they'll be retried next interval
      this.log('warn', 'Failed to poll DMs', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Private: Poll Mentions ───────────────────────────────────

  private async pollMentions(): Promise<void> {
    if (!this.connected || !this.config || !this.authenticatedUserId) return;

    let path = `/${API_VERSION}/users/${this.authenticatedUserId}/mentions?tweet.fields=id,text,author_id,created_at`;

    // Only fetch mentions newer than the last seen one
    if (this.lastMentionId) {
      path += `&since_id=${this.lastMentionId}`;
    } else {
      // On first poll, only look at recent mentions (max 5)
      path += '&max_results=5';
    }

    try {
      const response = await this.apiRequest('GET', path);
      const data = JSON.parse(response.body);

      if (!data.data || !Array.isArray(data.data)) return;

      // Process mentions oldest-first
      const mentions = data.data.reverse();

      for (const mention of mentions) {
        const authorId = mention.author_id;
        const text = mention.text;
        const tweetId = mention.id;

        // Skip own tweets
        if (authorId === this.authenticatedUserId) continue;

        // Skip if we've already seen this mention
        if (this.lastMentionId && tweetId <= this.lastMentionId) continue;

        if (authorId && text) {
          this.emitInbound(`reply:${tweetId}`, text, 'text');
        }

        // Track the latest mention ID
        if (!this.lastMentionId || tweetId > this.lastMentionId) {
          this.lastMentionId = tweetId;
        }
      }
    } catch (err: unknown) {
      // Swallow poll errors — they'll be retried next interval
      this.log('warn', 'Failed to poll mentions', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Private: OAuth 1.0a Signed API Request ───────────────────

  private apiRequest(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        return reject(new Error('Adapter not configured'));
      }

      const url = new URL(path, TWITTER_API_BASE);
      const fullUrl = url.toString();

      // Generate OAuth 1.0a signature
      const oauthHeaders = this.generateOAuthHeaders(method, fullUrl, body);

      const headers: Record<string, string> = {
        Authorization: oauthHeaders,
        Accept: 'application/json',
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode ?? 0;

          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode, body: responseBody });
          } else {
            const err = new Error(`Twitter API error: HTTP ${statusCode}`) as any;
            err.statusCode = statusCode;
            err.responseBody = responseBody;
            reject(err);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Twitter API request timed out') as any;
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => reject(err));

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  // ─── Private: OAuth 1.0a Header Generation ────────────────────

  private generateOAuthHeaders(method: string, url: string, _body?: string): string {
    if (!this.config) return '';

    const { apiKey, apiSecret, accessToken, accessTokenSecret } = this.config;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    // OAuth parameters
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: apiKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: timestamp,
      oauth_token: accessToken,
      oauth_version: '1.0',
    };

    // Parse query parameters from URL
    const parsedUrl = new URL(url);
    const allParams: Record<string, string> = { ...oauthParams };
    parsedUrl.searchParams.forEach((value, key) => {
      allParams[key] = value;
    });

    // Sort parameters and create parameter string
    const sortedKeys = Object.keys(allParams).sort();
    const paramString = sortedKeys
      .map((key) => `${this.percentEncode(key)}=${this.percentEncode(allParams[key] ?? '')}`)
      .join('&');

    // Create base string
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
    const signatureBaseString = [
      method.toUpperCase(),
      this.percentEncode(baseUrl),
      this.percentEncode(paramString),
    ].join('&');

    // Create signing key
    const signingKey = `${this.percentEncode(apiSecret)}&${this.percentEncode(accessTokenSecret)}`;

    // Generate signature
    const signature = crypto
      .createHmac('sha1', signingKey)
      .update(signatureBaseString)
      .digest('base64');

    oauthParams['oauth_signature'] = signature;

    // Build Authorization header
    const authHeader = Object.keys(oauthParams)
      .sort()
      .map((key) => `${this.percentEncode(key)}="${this.percentEncode(oauthParams[key] ?? '')}"`)
      .join(', ');

    return `OAuth ${authHeader}`;
  }

  // ─── Private: RFC 3986 Percent Encoding ───────────────────────

  private percentEncode(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  // ─── Private: Error Classification ────────────────────────────

  private isAuthError(err: unknown): boolean {
    if (err && typeof err === 'object') {
      const statusCode = (err as any).statusCode;
      if (statusCode === 401 || statusCode === 403) {
        return true;
      }
    }
    return false;
  }
}
