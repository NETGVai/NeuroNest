// ─── Gmail Adapter ──────────────────────────────────────────────
// Full ChannelAdapter implementation for Gmail email integration.
// Communicates with the Gmail API using OAuth 2.0 for sending,
// reading, searching emails, and polling for new messages.
// Emits inbound messages when new emails arrive.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.2, REQ 10.3

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Gmail adapter configuration.
 * Uses OAuth 2.0 with client credentials and a refresh token for
 * persistent access without re-authentication.
 */
export const GmailConfigSchema = z.object({
  /** Google OAuth 2.0 client ID */
  clientId: z.string().min(1),
  /** Google OAuth 2.0 client secret */
  clientSecret: z.string().min(1),
  /** OAuth 2.0 refresh token for persistent access */
  refreshToken: z.string().min(1),
  /** Polling interval in ms for new email checks (default: 30000ms = 30s) */
  pollingIntervalMs: z.number().int().min(5000).default(30000),
});

export type GmailConfig = z.infer<typeof GmailConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported Gmail command actions */
type GmailAction = 'send' | 'read-inbox' | 'search' | 'read-message' | 'get-labels';

/** Parsed inbound command structure */
interface GmailCommand {
  action: GmailAction;
  to?: string;
  subject?: string;
  body?: string;
  query?: string;
  messageId?: string;
  maxResults?: number;
}

/** Gmail message summary (for inbox listing) */
interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  isUnread: boolean;
}

/** Gmail full message detail */
interface GmailMessageDetail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  labels: string[];
}

/** Raw Gmail API message structure */
interface GmailApiMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string; size?: number };
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string; size?: number };
      parts?: Array<{
        mimeType?: string;
        body?: { data?: string; size?: number };
      }>;
    }>;
    mimeType?: string;
  };
  snippet?: string;
  internalDate?: string;
}

// ─── Gmail Adapter ──────────────────────────────────────────────

export class GmailAdapter extends BaseChannelAdapter {
  readonly channelId = 'gmail';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Gmail',
    emoji: '📧',
    description: 'Email sending, reading, and search via Gmail API',
    actionTags: ['send', 'inbox', 'search', 'watch'],
    sortOrder: 1050,
  };

  readonly configSchema = GmailConfigSchema;

  private config: GmailConfig | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastHistoryId: string | null = null;

  /** Base URL for the Gmail API */
  private readonly API_BASE = 'https://gmail.googleapis.com/gmail/v1';
  /** Token endpoint for Google OAuth */
  private readonly TOKEN_URL = 'https://oauth2.googleapis.com/token';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Gmail adapter requires client ID, client secret, and refresh token.\n\n' +
        'Setup steps:\n' +
        '1. Create a project in Google Cloud Console\n' +
        '2. Enable the Gmail API\n' +
        '3. Create OAuth 2.0 credentials (client ID + client secret)\n' +
        '4. Generate a refresh token with scopes:\n' +
        '   - https://www.googleapis.com/auth/gmail.readonly\n' +
        '   - https://www.googleapis.com/auth/gmail.send\n' +
        '   - https://www.googleapis.com/auth/gmail.modify\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Obtain an access token using the refresh token
    try {
      const tokenResult = await this.refreshAccessToken();
      if (!tokenResult.success) {
        return tokenResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to authenticate with Gmail: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Get initial history ID for change detection
    try {
      const profile = await this.getProfile();
      this.lastHistoryId = profile.historyId;
    } catch (err: unknown) {
      this.log('warn', 'Could not fetch initial profile for history tracking', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Start polling for new messages
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'gmail' });

    return {
      success: true,
      message: 'Gmail connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.config = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.lastHistoryId = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Gmail adapter is not connected' };
    }

    // Ensure token is fresh
    await this.ensureValidToken();

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      // Default to read-inbox if we can't parse
      return this.readInbox(10);
    }

    try {
      switch (command.action) {
        case 'send':
          return this.sendEmail(
            command.to ?? message.to,
            command.subject ?? 'No Subject',
            command.body ?? message.content,
          );

        case 'read-inbox':
          return this.readInbox(command.maxResults ?? 10);

        case 'search':
          return this.searchEmails(command.query ?? '', command.maxResults ?? 10);

        case 'read-message':
          if (!command.messageId) {
            return { success: false, message: 'Message ID required for read-message' };
          }
          return this.readMessage(command.messageId);

        case 'get-labels':
          return this.getLabels();

        default:
          return { success: false, message: `Unknown Gmail action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Gmail operation failed: ${errMsg}` };
    }
  }

  // ─── Private: OAuth Token Management ────────────────────────────

  /**
   * Refresh the access token using the stored refresh token.
   * Google OAuth tokens expire after ~1 hour.
   */
  private async refreshAccessToken(): Promise<ConnectResult> {
    if (!this.config) {
      return {
        success: false,
        message: 'Not configured',
        error: { code: 'CONFIG_INVALID', message: 'Not configured' },
      };
    }

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(this.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        return this.authFailed(
          'Invalid client credentials or refresh token. ' +
          'Please verify your Google OAuth credentials and generate a new refresh token.',
        );
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `Gmail token refresh failed (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    const result = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!result.access_token) {
      return this.authFailed('No access token returned from Google.');
    }

    this.accessToken = result.access_token;
    // Set expiry with a 60-second buffer
    this.tokenExpiresAt = Date.now() + ((result.expires_in ?? 3600) - 60) * 1000;

    return { success: true, message: 'Token refreshed' };
  }

  /**
   * Ensure we have a valid access token, refreshing if needed.
   */
  private async ensureValidToken(): Promise<void> {
    if (Date.now() >= this.tokenExpiresAt) {
      const result = await this.refreshAccessToken();
      if (!result.success) {
        throw new Error(`Token refresh failed: ${result.message}`);
      }
    }
  }

  // ─── Private: Gmail Operations ──────────────────────────────────

  /**
   * Send an email via Gmail API.
   * Constructs a raw RFC 2822 message and sends via messages.send.
   */
  private async sendEmail(to: string, subject: string, body: string): Promise<SendResult> {
    const rawMessage = this.createRawEmail(to, subject, body);

    const response = await this.apiFetch('/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: rawMessage }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Send email failed: ${errorBody}` };
    }

    const result = (await response.json()) as { id?: string; threadId?: string };

    return {
      success: true,
      message: JSON.stringify({
        action: 'send',
        status: 'sent',
        messageId: result.id,
        threadId: result.threadId,
        to,
        subject,
      }),
    };
  }

  /**
   * Read inbox messages. Returns a list of recent messages
   * from the INBOX label.
   */
  private async readInbox(maxResults: number): Promise<SendResult> {
    return this.searchEmails('in:inbox', maxResults);
  }

  /**
   * Search emails using Gmail query syntax.
   * Returns message summaries matching the query.
   */
  private async searchEmails(query: string, maxResults: number): Promise<SendResult> {
    const params = new URLSearchParams({
      q: query || 'in:inbox',
      maxResults: String(Math.min(maxResults, 50)),
    });

    const listResponse = await this.apiFetch(
      `/users/me/messages?${params.toString()}`,
    );

    if (!listResponse.ok) {
      const errorBody = await listResponse.text();
      return { success: false, message: `Search failed: ${errorBody}` };
    }

    const listResult = (await listResponse.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
      resultSizeEstimate?: number;
    };

    if (!listResult.messages || listResult.messages.length === 0) {
      return {
        success: true,
        message: JSON.stringify({ messages: [], totalEstimate: 0 }),
      };
    }

    // Fetch metadata for each message (batch of summaries)
    const summaries: GmailMessageSummary[] = [];
    const messagesToFetch = listResult.messages.slice(0, maxResults);

    for (const msg of messagesToFetch) {
      try {
        const summary = await this.fetchMessageSummary(msg.id);
        if (summary) summaries.push(summary);
      } catch {
        // Skip messages that fail to fetch
      }
    }

    return {
      success: true,
      message: JSON.stringify({
        messages: summaries,
        totalEstimate: listResult.resultSizeEstimate ?? summaries.length,
      }, null, 2),
    };
  }

  /**
   * Read a specific message by ID.
   * Returns the full message detail including body content.
   */
  private async readMessage(messageId: string): Promise<SendResult> {
    const response = await this.apiFetch(
      `/users/me/messages/${messageId}?format=full`,
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Read message failed: ${errorBody}` };
    }

    const raw = (await response.json()) as GmailApiMessage;
    const detail = this.parseFullMessage(raw);

    return {
      success: true,
      message: JSON.stringify(detail, null, 2),
    };
  }

  /**
   * Get all labels for the authenticated account.
   */
  private async getLabels(): Promise<SendResult> {
    const response = await this.apiFetch('/users/me/labels');

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get labels failed: ${errorBody}` };
    }

    const result = (await response.json()) as {
      labels?: Array<{ id: string; name: string; type: string }>;
    };

    return {
      success: true,
      message: JSON.stringify({
        labels: (result.labels ?? []).map((l) => ({
          id: l.id,
          name: l.name,
          type: l.type,
        })),
      }, null, 2),
    };
  }

  // ─── Private: Profile & History ─────────────────────────────────

  /**
   * Get the user's Gmail profile including historyId for
   * incremental change detection.
   */
  private async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    const response = await this.apiFetch('/users/me/profile');
    if (!response.ok) {
      throw new Error(`Profile fetch failed: ${response.status}`);
    }
    const result = (await response.json()) as {
      emailAddress?: string;
      historyId?: string;
    };
    return {
      emailAddress: result.emailAddress ?? '',
      historyId: result.historyId ?? '',
    };
  }

  // ─── Private: Polling for new messages ──────────────────────────

  /**
   * Start polling for new messages using Gmail history API.
   * Emits inbound messages when new emails arrive.
   * @satisfies REQ 10.2
   */
  private startPolling(): void {
    if (!this.config) return;

    this.pollTimer = setInterval(() => {
      this.pollForNewMessages().catch((err) => {
        this.log('error', 'Gmail polling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.pollingIntervalMs);
  }

  /**
   * Stop the polling timer.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Parse message content into a structured Gmail command.
   */
  private parseCommand(content: string): GmailCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as GmailCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "send to <email> subject <subject> body <body>"
    const sendMatch = content.match(
      /^send\s+(?:to\s+)?(\S+@\S+)\s+(?:subject\s+)?["']?([^"'\n]+)["']?\s+(?:body\s+)?(.+)$/is,
    );
    if (sendMatch) {
      return {
        action: 'send',
        to: sendMatch[1],
        subject: sendMatch[2]?.trim(),
        body: sendMatch[3]?.trim(),
      };
    }

    // Pattern: "read inbox" or "inbox"
    if (/^(?:read\s+)?inbox$/i.test(lower)) {
      return { action: 'read-inbox' };
    }

    // Pattern: "search <query>"
    const searchMatch = content.match(/^search\s+(.+)$/i);
    if (searchMatch) {
      return { action: 'search', query: searchMatch[1]?.trim() };
    }

    // Pattern: "read <messageId>"
    const readMatch = content.match(/^read\s+(\w+)$/i);
    if (readMatch && !readMatch[1]?.includes('inbox')) {
      return { action: 'read-message', messageId: readMatch[1] };
    }

    // Pattern: "labels" or "get labels"
    if (/^(?:get\s+)?labels$/i.test(lower)) {
      return { action: 'get-labels' };
    }

    return null;
  }

  /**
   * Create a base64url-encoded RFC 2822 email message.
   */
  private createRawEmail(to: string, subject: string, body: string): string {
    const emailLines = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ];
    const email = emailLines.join('\r\n');
    return Buffer.from(email).toString('base64url');
  }

  /**
   * Make an authenticated request to the Gmail API.
   */
  private async apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
    await this.ensureValidToken();

    const url = path.startsWith('http') ? path : `${this.API_BASE}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }

  /**
   * Fetch a lightweight message summary (headers + snippet) by ID.
   */
  private async fetchMessageSummary(messageId: string): Promise<GmailMessageSummary | null> {
    const response = await this.apiFetch(
      `/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    );

    if (!response.ok) return null;

    const raw = (await response.json()) as GmailApiMessage;
    const headers = raw.payload?.headers ?? [];

    const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
    const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
    const date = headers.find((h) => h.name.toLowerCase() === 'date')?.value ?? '';

    return {
      id: raw.id,
      threadId: raw.threadId,
      from,
      subject,
      snippet: raw.snippet ?? '',
      date,
      isUnread: raw.labelIds?.includes('UNREAD') ?? false,
    };
  }

  /**
   * Parse a full Gmail API message into a structured detail object.
   */
  private parseFullMessage(raw: GmailApiMessage): GmailMessageDetail {
    const headers = raw.payload?.headers ?? [];

    const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
    const to = headers.find((h) => h.name.toLowerCase() === 'to')?.value ?? '';
    const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
    const date = headers.find((h) => h.name.toLowerCase() === 'date')?.value ?? '';

    // Extract body: try plain text first, then HTML
    let body = '';
    const payload = raw.payload;
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    } else if (payload?.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
      const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
      const part = textPart ?? htmlPart;
      if (part?.body?.data) {
        body = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }

    return {
      id: raw.id,
      threadId: raw.threadId,
      from,
      to,
      subject,
      body,
      date,
      labels: raw.labelIds ?? [],
    };
  }

  /**
   * Poll for new messages using Gmail history API.
   * Emits inbound messages when new emails arrive.
   */
  private async pollForNewMessages(): Promise<void> {
    if (!this.lastHistoryId) return;

    await this.ensureValidToken();

    const params = new URLSearchParams({
      startHistoryId: this.lastHistoryId,
      historyTypes: 'messageAdded',
    });

    const response = await this.apiFetch(`/users/me/history?${params.toString()}`);

    if (!response.ok) {
      // If history ID is too old, refresh it
      if (response.status === 404) {
        const profile = await this.getProfile();
        this.lastHistoryId = profile.historyId;
      }
      return;
    }

    const result = (await response.json()) as {
      history?: Array<{
        messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }>;
      }>;
      historyId?: string;
    };

    // Update history ID for next poll
    if (result.historyId) {
      this.lastHistoryId = result.historyId;
    }

    // Emit inbound for each new message in INBOX
    if (result.history) {
      for (const entry of result.history) {
        if (!entry.messagesAdded) continue;
        for (const added of entry.messagesAdded) {
          if (added.message.labelIds?.includes('INBOX')) {
            try {
              const summary = await this.fetchMessageSummary(added.message.id);
              if (summary) {
                this.emitInbound(
                  summary.from,
                  `New email: "${summary.subject}" - ${summary.snippet}`,
                  'text',
                );
              }
            } catch {
              // Skip messages that fail to fetch
            }
          }
        }
      }
    }
  }
}
