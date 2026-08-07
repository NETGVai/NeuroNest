// ─── Zalo Personal Adapter ──────────────────────────────────────
// Full ChannelAdapter implementation for Zalo personal messaging.
// Uses QR code login flow for personal account access and polls
// for new messages via the Zalo personal chat API endpoints.
//
// The QR login flow:
// 1. Adapter requests a QR code URL from the Zalo auth endpoint
// 2. The QR code is returned in the ConnectResult for display to the user
// 3. User scans the QR with their Zalo mobile app
// 4. Adapter polls the auth endpoint until the session is confirmed
// 5. Session cookies are stored for subsequent API requests
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 4.1

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Zalo Personal adapter configuration.
 * Supports two modes:
 * 1. Session-based: provide cookies/session data from a prior login
 * 2. QR-based: omit cookies, and the adapter will generate a QR for login
 *
 * An optional `onQrCode` callback can be used programmatically.
 */
export const ZaloPersonalConfigSchema = z.object({
  /** Optional saved session cookies from a prior login (JSON string or object). */
  cookies: z.any().optional(),
  /** Optional IMEI identifier used by Zalo for device binding. */
  imei: z.string().optional(),
  /** User agent string to use for requests (default provided). */
  userAgent: z.string().optional(),
  /** Polling interval for new messages in milliseconds (default: 3000). */
  pollInterval: z.number().int().min(1000).optional(),
  /** QR login timeout in milliseconds (default: 120000 = 2 minutes). */
  qrTimeout: z.number().int().min(10000).optional(),
});

/** Inferred config type. */
export type ZaloPersonalConfig = z.infer<typeof ZaloPersonalConfigSchema>;

// ─── Internal Types ─────────────────────────────────────────────

interface ZaloSession {
  cookies: Record<string, string>;
  imei: string;
  userId: string;
}

interface ZaloMessage {
  msgId: string;
  fromUid: string;
  content: string;
  ts: number;
  type: number;
}

// ─── Zalo Personal Adapter ──────────────────────────────────────

export class ZaloPersonalAdapter extends BaseChannelAdapter {
  readonly channelId = 'zalo-personal';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Zalo Personal',
    emoji: '💬',
    description: 'Zalo personal messaging via QR login',
    actionTags: ['send message', 'receive message', 'personal chat'],
    sortOrder: 1060,
  };

  readonly configSchema = ZaloPersonalConfigSchema;

  private config: ZaloPersonalConfig | null = null;
  private session: ZaloSession | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTimestamp = 0;

  // Zalo API base URLs
  private static readonly AUTH_BASE = 'https://id.zalo.me';
  private static readonly CHAT_BASE = 'https://chat.zalo.me';
  private static readonly API_BASE = 'https://tt-chat-1.zalo.me';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Zalo Personal config is invalid. Provide cookies from a prior session ' +
        'or leave blank to initiate QR login.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // If cookies/session data provided, attempt to restore session
    if (this.config.cookies) {
      const sessionResult = await this.restoreSession(this.config.cookies);
      if (sessionResult) {
        this.session = sessionResult;
        this.startPolling();
        this.connected = true;
        this.log('info', 'Connected via restored session', { userId: this.session.userId });
        return {
          success: true,
          message: `Connected to Zalo Personal as user ${this.session.userId}`,
        };
      }
      // Session restoration failed — fall through to QR login
      this.log('warn', 'Session cookies expired or invalid, initiating QR login');
    }

    // Initiate QR code login flow
    const qrResult = await this.initiateQrLogin();
    if (!qrResult.success) {
      return qrResult;
    }

    // QR generated — return it in ConnectResult for display
    // The adapter is now in a "pending" state waiting for scan confirmation.
    // The poll for auth confirmation runs in background.
    return qrResult;
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.session = null;
    this.config = null;
    this.connected = false;
    this.ctx = null;
    this.lastMessageTimestamp = 0;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.session) {
      return { success: false, message: 'Zalo Personal adapter is not connected' };
    }

    try {
      const payload = {
        toId: message.to,
        message: message.content,
        clientId: Date.now(),
        imei: this.session.imei,
      };

      const response = await this.apiRequest(
        'POST',
        '/api/message/sms',
        payload,
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        return {
          success: false,
          message: `Send failed (${response.status}): ${errText}`,
        };
      }

      const data = await response.json().catch(() => ({})) as { error_code?: number; error_message?: string };

      if (data.error_code && data.error_code !== 0) {
        return {
          success: false,
          message: `Zalo send error: ${data.error_message ?? 'Unknown'}`,
        };
      }

      return { success: true, message: 'Message sent via Zalo Personal' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private: QR Login Flow ───────────────────────────────────

  /**
   * Initiates the QR code login flow.
   * Requests a QR code from Zalo's auth endpoint and begins polling
   * for scan confirmation.
   */
  private async initiateQrLogin(): Promise<ConnectResult> {
    try {
      const imei = this.config?.imei ?? this.generateImei();

      // Request QR code from Zalo auth
      const qrResponse = await fetch(`${ZaloPersonalAdapter.AUTH_BASE}/account/login/qr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getUserAgent(),
        },
        body: JSON.stringify({ imei }),
      });

      if (!qrResponse.ok) {
        const msg = `Failed to get QR code: HTTP ${qrResponse.status}`;
        return {
          success: false,
          message: msg,
          error: { code: 'PROVIDER_ERROR', message: msg },
        };
      }

      const qrData = await qrResponse.json() as {
        data?: { qr_code?: string; token?: string; session_id?: string };
        error_code?: number;
      };

      if (!qrData.data?.qr_code) {
        const msg = 'Zalo did not return a QR code. Service may be temporarily unavailable.';
        return {
          success: false,
          message: msg,
          error: { code: 'PROVIDER_ERROR', message: msg },
        };
      }

      const qrCode = qrData.data.qr_code;
      const authToken = qrData.data.token ?? qrData.data.session_id ?? '';

      // Start background auth polling to wait for QR scan
      this.waitForQrConfirmation(authToken, imei);

      return {
        success: true,
        message: 'Scan the QR code with your Zalo mobile app to connect.',
        qrCode,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const msg = `QR login initiation failed: ${errMsg}`;
      return {
        success: false,
        message: msg,
        error: { code: 'PROVIDER_ERROR', message: msg },
      };
    }
  }

  /**
   * Polls the auth endpoint waiting for QR scan confirmation.
   * On success, stores the session and starts message polling.
   * On timeout, logs an error.
   */
  private waitForQrConfirmation(authToken: string, imei: string): void {
    const timeout = this.config?.qrTimeout ?? 120000;
    const startTime = Date.now();
    const checkInterval = 2000;

    const checker = setInterval(async () => {
      if (Date.now() - startTime > timeout) {
        clearInterval(checker);
        this.log('error', 'QR login timed out — user did not scan in time');
        return;
      }

      try {
        const response = await fetch(
          `${ZaloPersonalAdapter.AUTH_BASE}/account/login/qr/check`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': this.getUserAgent(),
            },
            body: JSON.stringify({ token: authToken, imei }),
          },
        );

        if (!response.ok) return;

        const data = await response.json() as {
          error_code?: number;
          data?: {
            cookies?: Record<string, string>;
            uid?: string;
            token?: string;
          };
        };

        if (data.error_code === 0 && data.data?.cookies) {
          clearInterval(checker);

          this.session = {
            cookies: data.data.cookies,
            imei,
            userId: data.data.uid ?? 'unknown',
          };

          this.lastMessageTimestamp = Date.now();
          this.startPolling();
          this.connected = true;

          this.log('info', 'QR login confirmed', { userId: this.session.userId });
        }
      } catch {
        // Transient failure — keep polling
      }
    }, checkInterval);
  }

  // ─── Private: Session Restoration ─────────────────────────────

  /**
   * Attempt to restore a session using saved cookies.
   * Returns a ZaloSession if valid, null if expired/invalid.
   */
  private async restoreSession(
    cookies: string | Record<string, string>,
  ): Promise<ZaloSession | null> {
    const cookieObj = typeof cookies === 'string' ? this.parseCookieString(cookies) : cookies;

    const imei = this.config?.imei ?? this.generateImei();

    try {
      // Verify session by hitting a lightweight profile endpoint
      const response = await fetch(`${ZaloPersonalAdapter.CHAT_BASE}/api/login/getLoginInfo`, {
        method: 'GET',
        headers: {
          'Cookie': this.formatCookies(cookieObj),
          'User-Agent': this.getUserAgent(),
        },
      });

      if (!response.ok) return null;

      const data = await response.json() as {
        error_code?: number;
        data?: { uid?: string };
      };

      if (data.error_code !== 0 || !data.data?.uid) return null;

      return {
        cookies: cookieObj,
        imei,
        userId: data.data.uid,
      };
    } catch {
      return null;
    }
  }

  // ─── Private: Message Polling ─────────────────────────────────

  private startPolling(): void {
    if (!this.config) return;

    const interval = this.config.pollInterval ?? 3000;
    this.pollTimer = setInterval(() => {
      this.pollMessages().catch((err) => {
        this.log('error', 'Message poll error', { error: String(err) });
      });
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll for new messages since the last known timestamp.
   */
  private async pollMessages(): Promise<void> {
    if (!this.connected || !this.session) return;

    try {
      const response = await this.apiRequest('GET', '/api/message/list', {
        lastTimestamp: this.lastMessageTimestamp,
        count: 50,
      });

      if (!response.ok) {
        this.log('warn', `Poll returned status ${response.status}`);
        return;
      }

      const data = await response.json() as {
        error_code?: number;
        data?: ZaloMessage[];
      };

      if (data.error_code !== 0 || !data.data || !Array.isArray(data.data)) return;

      for (const msg of data.data) {
        // Skip our own messages
        if (msg.fromUid === this.session.userId) continue;

        // Skip messages older than or equal to last known
        if (msg.ts <= this.lastMessageTimestamp) continue;

        // Update timestamp
        if (msg.ts > this.lastMessageTimestamp) {
          this.lastMessageTimestamp = msg.ts;
        }

        // Determine content type based on message type field
        const contentType = this.mapContentType(msg.type);

        // Emit inbound
        this.emitInbound(msg.fromUid, msg.content, contentType);
      }
    } catch (err: unknown) {
      this.log('error', 'Failed to poll messages', { error: String(err) });
    }
  }

  // ─── Private: API Helpers ─────────────────────────────────────

  /**
   * Make an authenticated API request to the Zalo chat API.
   */
  private async apiRequest(
    method: string,
    path: string,
    params?: Record<string, unknown>,
  ): Promise<Response> {
    if (!this.session) {
      throw new Error('Zalo Personal adapter has no active session');
    }

    const baseUrl = ZaloPersonalAdapter.API_BASE;
    const url = new URL(path, baseUrl);

    // For GET requests, append params as query string
    if (method === 'GET' && params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': this.formatCookies(this.session.cookies),
        'User-Agent': this.getUserAgent(),
      },
    };

    // For POST requests, send params as JSON body
    if (method !== 'GET' && params) {
      options.body = JSON.stringify(params);
    }

    return fetch(url.toString(), options);
  }

  /**
   * Map Zalo message type numbers to content type strings.
   * Type 0 = text, 1 = image, 2 = voice, 3 = video, 4 = file, etc.
   */
  private mapContentType(type: number): 'text' | 'image' | 'audio' | 'video' | 'file' | 'other' {
    switch (type) {
      case 0: return 'text';
      case 1: return 'image';
      case 2: return 'audio';
      case 3: return 'video';
      case 4: return 'file';
      default: return 'other';
    }
  }

  /**
   * Parse a cookie string (from browser format) into a key-value record.
   */
  private parseCookieString(cookieStr: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    try {
      // Try JSON parse first (might be a serialized object)
      const parsed = JSON.parse(cookieStr);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, string>;
      }
    } catch {
      // Not JSON — parse as semicolon-separated cookie string
    }

    for (const pair of cookieStr.split(';')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        cookies[key] = value;
      }
    }
    return cookies;
  }

  /**
   * Format a cookies record into a Cookie header string.
   */
  private formatCookies(cookies: Record<string, string>): string {
    return Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  /**
   * Get the user agent string (configurable or default).
   */
  private getUserAgent(): string {
    return (
      this.config?.userAgent ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
  }

  /**
   * Generate a pseudo-random IMEI for device binding.
   * Zalo uses this to identify the "device" making the login request.
   */
  private generateImei(): string {
    const chars = '0123456789abcdef';
    let imei = '';
    for (let i = 0; i < 32; i++) {
      imei += chars[Math.floor(Math.random() * chars.length)];
    }
    return imei;
  }
}
