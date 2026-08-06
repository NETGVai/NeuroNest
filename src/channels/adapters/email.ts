// ─── Email Adapter ──────────────────────────────────────────────
// Full ChannelAdapter implementation for SMTP email via nodemailer.
// Send-only adapter that creates a transporter, verifies SMTP
// connectivity on connect, and dispatches messages via sendMail.
//
// Requirements: REQ 4.6, REQ 5.1, REQ 7.1, REQ 12.1, REQ 12.2,
// REQ 12.3, REQ 12.4, REQ 21.1, REQ 22.1

import { z } from 'zod';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import type { ErrorCode } from '../types/errors';
import { safeImport } from '../import-validator';
import { redactString } from '../redact';
import { APP_NAME } from '../../branding';

// ─── Config Schema (REQ 5.1, REQ 12.1) ─────────────────────────

/**
 * Zod schema for Email adapter configuration.
 * Required fields: smtpHost, username, password.
 * Zod validation runs in ChannelManager.connect before adapter.connect (REQ 5.1),
 * so missing required fields cannot reach createTransport — REQ 12.1's ordering
 * constraint is guaranteed structurally.
 */
export const EmailConfigSchema = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  username: z.string().min(1),
  password: z.string().min(1),
});

type EmailConfig = z.infer<typeof EmailConfigSchema>;

// ─── Email Adapter ──────────────────────────────────────────────

export class EmailAdapter implements ChannelAdapter {
  readonly channelId = 'email';

  readonly capabilities: AdapterCapabilities = {
    direction: 'send-only',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'push',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Email',
    emoji: '📧',
    description: 'SMTP send via nodemailer',
    actionTags: ['send email'],
    sortOrder: 60,
  };

  readonly configSchema = EmailConfigSchema;

  private connected = false;
  private ctx: AdapterContext | null = null;
  private config: EmailConfig | null = null;
  private transporter: any = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
      const msg = `Email configuration invalid: missing or empty fields: ${fields}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;
    const { smtpHost, smtpPort, username, password } = this.config;

    // Load nodemailer via safeImport (REQ 7.1)
    let nodemailer: any;
    try {
      nodemailer = await safeImport('nodemailer');
    } catch {
      const msg = 'nodemailer not installed. Run: npm install nodemailer';
      return {
        success: false,
        message: msg,
        error: { code: 'SDK_MISSING', message: msg },
      };
    }

    // Create transporter and verify connectivity (REQ 12.2)
    try {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: username,
          pass: password,
        },
      });

      await this.transporter.verify();

      this.connected = true;
      context.logger.info('Connected', { host: smtpHost, port: smtpPort });
      return {
        success: true,
        message: `Email connected to ${smtpHost}:${smtpPort}`,
      };
    } catch (err: any) {
      this.transporter = null;
      const mapped = this.mapSmtpError(err, password);
      return {
        success: false,
        message: mapped.message,
        error: { code: mapped.code, message: mapped.message },
      };
    }
  }

  async disconnect(): Promise<void> {
    if (this.transporter) {
      try {
        this.transporter.close();
      } catch {
        // Ignore close errors during disconnect
      }
      this.transporter = null;
    }
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.transporter || !this.config) {
      return { success: false, message: 'Email adapter is not connected' };
    }

    const { username } = this.config;

    try {
      await this.transporter.sendMail({
        from: username,
        to: message.to,
        subject: `${APP_NAME} Message`,
        text: message.content,
      });

      return { success: true, message: `Email sent to ${message.to}` };
    } catch (err: any) {
      const mapped = this.mapSmtpError(err, this.config.password);
      if (this.ctx) {
        this.ctx.logger.error('Send failed', { error: mapped.message });
      }
      return { success: false, message: mapped.message };
    }
  }

  // ─── Private: SMTP error mapping (REQ 21.1) ────────────────────

  private mapSmtpError(
    err: any,
    password: string,
  ): { code: ErrorCode; message: string } {
    const errCode = err.code ?? '';

    // EAUTH → AUTH_FAILED
    if (errCode === 'EAUTH') {
      return {
        code: 'AUTH_FAILED',
        message: 'SMTP authentication failed. Check username and password.',
      };
    }

    // ECONNREFUSED / ETIMEDOUT → NETWORK_ERROR
    if (errCode === 'ECONNREFUSED' || errCode === 'ETIMEDOUT') {
      return {
        code: 'NETWORK_ERROR',
        message: `SMTP network error: ${errCode}`,
      };
    }

    // Other → PROVIDER_ERROR with redacted message
    const rawMessage = err.message ?? String(err);
    const safeMessage = redactString(rawMessage, [password]);
    return {
      code: 'PROVIDER_ERROR',
      message: safeMessage,
    };
  }
}
