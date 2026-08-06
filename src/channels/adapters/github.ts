// ─── GitHub Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for GitHub using node:https.
// Creates issues on repositories via the REST API. Send-only adapter
// with no external SDK dependency.
//
// Requirements: REQ 13.1, REQ 13.2, REQ 13.3, REQ 13.4, REQ 18.1,
// REQ 21.1, REQ 22.1

import { z } from 'zod';
import * as https from 'node:https';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { redactString } from '../redact';

// ─── Config Schema (REQ 5.1, REQ 13.1) ─────────────────────────

/**
 * Zod schema for GitHub adapter configuration.
 * Missing `username` and missing `token` produce two distinct error messages
 * via separate Zod issue entries per field (REQ 13.1).
 */
export const GitHubConfigSchema = z.object({
  username: z.string().min(1),
  token: z.string().min(1),
});

type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

// ─── GitHub Adapter ─────────────────────────────────────────────

export class GitHubAdapter implements ChannelAdapter {
  readonly channelId = 'github';

  readonly capabilities: AdapterCapabilities = {
    direction: 'send-only',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'push',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'GitHub',
    emoji: '🐙',
    description: 'Issues via REST API',
    actionTags: ['create issue', 'send message'],
    sortOrder: 50,
  };

  readonly configSchema = GitHubConfigSchema;

  private connected = false;
  private ctx: AdapterContext | null = null;
  private config: GitHubConfig | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
      const msg = `GitHub configuration invalid: missing or empty fields: ${fields}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;
    const { username, token } = this.config;

    // Authenticate via GET /user (REQ 13.2)
    try {
      const response = await this.apiRequest('/user', 'GET', undefined, token);

      if (response.statusCode !== 200) {
        const msg =
          response.statusCode === 401 || response.statusCode === 403
            ? 'GitHub authentication failed. Check your personal access token.'
            : `GitHub API returned HTTP ${response.statusCode}`;
        const code = response.statusCode === 401 || response.statusCode === 403
          ? 'AUTH_FAILED' as const
          : 'PROVIDER_ERROR' as const;
        return {
          success: false,
          message: msg,
          error: { code, message: msg },
        };
      }

      // Verify login field is a non-empty string
      let body: any;
      try {
        body = JSON.parse(response.body);
      } catch {
        const msg = 'GitHub API returned invalid JSON from /user';
        return {
          success: false,
          message: msg,
          error: { code: 'PROVIDER_ERROR', message: msg },
        };
      }

      if (typeof body.login !== 'string' || body.login.length === 0) {
        const msg = 'GitHub API /user response missing valid login field';
        return {
          success: false,
          message: msg,
          error: { code: 'AUTH_FAILED', message: msg },
        };
      }

      this.connected = true;
      context.logger.info('Connected', { username });
      return {
        success: true,
        message: `GitHub connected as ${body.login}`,
      };
    } catch (err: any) {
      const mapped = this.mapApiError(err, token);
      return {
        success: false,
        message: mapped.message,
        error: { code: mapped.code, message: mapped.message },
      };
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'GitHub adapter is not connected' };
    }

    // Validate owner/repo format (REQ 13.4)
    const parts = message.to.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { success: false, message: 'Recipient must be owner/repo format' };
    }

    const [owner, repo] = parts;
    const { token } = this.config;

    // POST to /repos/{owner}/{repo}/issues (REQ 13.3)
    const payload = JSON.stringify({
      title: message.content.slice(0, 100),
      body: message.content,
    });

    try {
      const response = await this.apiRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        'POST',
        payload,
        token,
      );

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { success: true, message: `Issue created on ${owner}/${repo}` };
      }

      const msg = `GitHub API error: HTTP ${response.statusCode}`;
      if (this.ctx) {
        this.ctx.logger.error('Send failed', { error: msg });
      }
      return { success: false, message: msg };
    } catch (err: any) {
      const mapped = this.mapApiError(err, token);
      if (this.ctx) {
        this.ctx.logger.error('Send failed', { error: mapped.message });
      }
      return { success: false, message: mapped.message };
    }
  }

  // ─── Private: GitHub API request ────────────────────────────────

  private apiRequest(
    path: string,
    method: string,
    body: string | undefined,
    token: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'NeuroNest-GitHubAdapter',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }

      const options: https.RequestOptions = {
        hostname: 'api.github.com',
        path,
        method,
        headers,
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('GitHub API request timed out') as any;
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }

  // ─── Private: Error mapping (REQ 21.1) ──────────────────────────

  private mapApiError(
    err: any,
    token: string,
  ): { code: 'AUTH_FAILED' | 'NETWORK_ERROR' | 'PROVIDER_ERROR'; message: string } {
    // Network-level errors → NETWORK_ERROR
    const networkCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE'];
    if (networkCodes.includes(err.code)) {
      return {
        code: 'NETWORK_ERROR',
        message: `Network error communicating with GitHub API: ${err.code}`,
      };
    }

    // Redact token from any error message (REQ 18.1, REQ 18.4)
    const rawMessage = err.message ?? String(err);
    const safeMessage = redactString(rawMessage, [token]);

    return {
      code: 'PROVIDER_ERROR',
      message: safeMessage,
    };
  }
}
