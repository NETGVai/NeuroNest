// NeuroNest Channel Manager
// Unified connection manager for all messaging platform integrations.
// Each SDK is dynamically required so the app won't crash if a package is missing.
/* eslint-disable @typescript-eslint/no-require-imports, no-empty, @typescript-eslint/ban-ts-comment */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// ── Public types ────────────────────────────────────────────────────

export interface ChannelConnection {
  id: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

export interface IncomingMessage {
  channelId: string;
  from: string;
  content: string;
  timestamp: Date;
}

export type ConnectResult = {
  success: boolean;
  message: string;
  qrCode?: string;
};

export type SendResult = {
  success: boolean;
  message: string;
};

// ── Internal handle kept per active channel ─────────────────────────

interface ChannelHandle {
  connection: ChannelConnection;
  /** Platform-specific teardown */
  stop: () => void;
  /** Platform-specific send */
  send: (to: string, message: string) => Promise<SendResult>;
}

// ── Supported channel IDs that have real SDK wiring ─────────────────

const SUPPORTED_CHANNELS = new Set([
  'whatsapp',
  'telegram',
  'discord',
  'slack',
  'email',
  'github',
]);

// ── ChannelManager ──────────────────────────────────────────────────

export class ChannelManager {
  private channels = new Map<string, ChannelHandle>();
  private emitter = new EventEmitter();

  // ── Public API ──────────────────────────────────────────────────

  async connect(channelId: string, config: any): Promise<ConnectResult> {
    // If already connected, disconnect first
    if (this.channels.has(channelId)) {
      await this.disconnect(channelId);
    }

    if (!SUPPORTED_CHANNELS.has(channelId)) {
      return {
        success: false,
        message: `Channel "${channelId}" is not supported yet. The required SDK needs to be installed and a connector implemented.`,
      };
    }

    try {
      switch (channelId) {
        case 'whatsapp':
          return await this.connectWhatsApp(channelId, config);
        case 'telegram':
          return await this.connectTelegram(channelId, config);
        case 'discord':
          return await this.connectDiscord(channelId, config);
        case 'slack':
          return await this.connectSlack(channelId, config);
        case 'email':
          return await this.connectEmail(channelId, config);
        case 'github':
          return await this.connectGitHub(channelId, config);
        default:
          return { success: false, message: `No connector for "${channelId}".` };
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error(`[ChannelManager] connect(${channelId}) failed:`, msg);
      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'error', error: msg },
        stop: () => {},
        send: async () => ({ success: false, message: 'Channel is in error state' }),
      });
      return { success: false, message: msg };
    }
  }

  async disconnect(channelId: string): Promise<void> {
    const handle = this.channels.get(channelId);
    if (!handle) return;
    try {
      handle.stop();
    } catch (err: any) {
      console.error(`[ChannelManager] disconnect(${channelId}) error:`, err?.message);
    }
    handle.connection.status = 'disconnected';
    handle.connection.error = undefined;
    this.channels.delete(channelId);
    console.log(`[ChannelManager] ${channelId} disconnected`);
  }

  async sendMessage(channelId: string, to: string, message: string): Promise<SendResult> {
    const handle = this.channels.get(channelId);
    if (!handle) {
      return { success: false, message: `Channel "${channelId}" is not connected.` };
    }
    if (handle.connection.status !== 'connected') {
      return { success: false, message: `Channel "${channelId}" is ${handle.connection.status}, not connected.` };
    }
    try {
      return await handle.send(to, message);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error(`[ChannelManager] sendMessage(${channelId}) error:`, msg);
      return { success: false, message: msg };
    }
  }

  getStatus(channelId: string): ChannelConnection {
    const handle = this.channels.get(channelId);
    return handle?.connection ?? { id: channelId, status: 'disconnected' };
  }

  getAllStatuses(): ChannelConnection[] {
    return Array.from(this.channels.values()).map((h) => ({ ...h.connection }));
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.emitter.on('message', handler);
  }

  onStatusChange(handler: (status: { channelId: string; status: string; qrCode?: string; error?: string }) => void): void {
    this.emitter.on('status-change', handler);
  }

  stopAll(): void {
    for (const [id] of this.channels) {
      try {
        this.channels.get(id)?.stop();
      } catch (err: any) {
        console.error(`[ChannelManager] stopAll – error stopping ${id}:`, err?.message);
      }
    }
    this.channels.clear();
    this.emitter.removeAllListeners();
    console.log('[ChannelManager] all channels stopped');
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private upsertHandle(channelId: string, handle: ChannelHandle): void {
    this.channels.set(channelId, handle);
  }

  private emit(msg: IncomingMessage): void {
    this.emitter.emit('message', msg);
  }

  // ── WhatsApp (Cloud API or Baileys) ──────────────────────────────

  private whatsAppAdapter: any = null;

  private async connectWhatsApp(channelId: string, _config: any): Promise<ConnectResult> {
    const mode = _config?.mode || 'auto';

    // Explicit mode selection
    if (mode === 'baileys' || mode === 'qr') {
      return this.connectWhatsAppBaileys(channelId, _config);
    }
    if (mode === 'cloud') {
      return this.connectWhatsAppCloud(channelId, _config);
    }
    // Auto: if Cloud API credentials provided, use Cloud API; otherwise try Baileys
    if (_config?.accessToken && _config?.phoneNumberId) {
      return this.connectWhatsAppCloud(channelId, _config);
    }
    return this.connectWhatsAppBaileys(channelId, _config);
  }

  // Cloud API mode — official, reliable, never blocked
  private async connectWhatsAppCloud(channelId: string, _config: any): Promise<ConnectResult> {
    const accessToken = _config?.accessToken || '';
    const phoneNumberId = _config?.phoneNumberId || '';
    const verifyToken = _config?.verifyToken || 'neuronest-whatsapp-verify';

    if (!accessToken || !phoneNumberId) {
      return { 
        success: false, 
        message: 'WhatsApp Cloud API requires an Access Token and Phone Number ID.\n\n' +
          'Setup steps:\n' +
          '1. Go to developers.facebook.com → Create App → Business type\n' +
          '2. Add WhatsApp product → API Setup\n' +
          '3. Copy the "Temporary access token" and "Phone number ID"\n' +
          '4. Connect with: /channel whatsapp accessToken=<token> phoneNumberId=<id>\n\n' +
          'The Cloud API is free for up to 1,000 conversations/month.\n' +
          'Note: Baileys (QR code method) is no longer supported — WhatsApp blocks it with HTTP 405.'
      };
    }

    const https = require('node:https');
    const verify = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const req = https.get('https://graph.facebook.com/v21.0/' + phoneNumberId, {
        headers: { 'Authorization': 'Bearer ' + accessToken }, timeout: 10000,
      }, (res: any) => {
        let body = '';
        res.on('data', (c: any) => body += c);
        res.on('end', () => {
          if (res.statusCode < 300) resolve({ ok: true });
          else { try { resolve({ ok: false, error: JSON.parse(body)?.error?.message || 'HTTP ' + res.statusCode }); } catch { resolve({ ok: false, error: 'HTTP ' + res.statusCode }); } }
        });
      });
      req.on('error', (e: any) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    });

    if (!verify.ok) {
      return { success: false, message: 'API verification failed: ' + verify.error };
    }

    // Start a local webhook server to receive incoming messages from WhatsApp
    const http = require('node:http');
    let webhookServer: any = null;
    const webhookPort = 9876;

    try {
      webhookServer = http.createServer((req: any, res: any) => {
        // Webhook verification (GET request from Meta)
        if (req.method === 'GET' && req.url?.includes('hub.mode=subscribe')) {
          const url = new URL(req.url, 'http://localhost');
          const mode = url.searchParams.get('hub.mode');
          const token = url.searchParams.get('hub.verify_token');
          const challenge = url.searchParams.get('hub.challenge');
          if (mode === 'subscribe' && token === verifyToken) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(challenge);
            return;
          }
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        // Incoming message webhook (POST from Meta)
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => body += chunk);
          req.on('end', () => {
            res.writeHead(200);
            res.end('OK');
            try {
              const data = JSON.parse(body);
              const entry = data?.entry?.[0];
              const changes = entry?.changes?.[0];
              const value = changes?.value;
              const messages = value?.messages;
              if (messages && messages.length > 0) {
                for (const msg of messages) {
                  if (msg.type === 'text' && msg.text?.body) {
                    this.emit({
                      channelId,
                      from: msg.from || 'unknown',
                      content: msg.text.body,
                      timestamp: new Date((msg.timestamp || 0) * 1000),
                    });
                  }
                }
              }
            } catch (e: any) {
              console.error('[WhatsApp:Cloud] Webhook parse error:', e?.message);
            }
          });
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      });

      webhookServer.listen(webhookPort, '0.0.0.0');
      console.log('[WhatsApp:Cloud] Webhook server listening on port', webhookPort);
    } catch (e: any) {
      console.warn('[WhatsApp:Cloud] Could not start webhook server:', e?.message);
      // Continue anyway — outbound messaging still works
    }

    this.upsertHandle(channelId, {
      connection: { id: channelId, status: 'connected' },
      stop: () => {
        if (webhookServer) { try { webhookServer.close(); } catch { /* best-effort */ } }
      },
      send: async (to: string, message: string) => {
        const payload = JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/[^0-9]/g, ''), type: 'text', text: { body: message } });
        return new Promise((resolve) => {
          const req = https.request('https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 15000,
          }, (res: any) => {
            let body = '';
            res.on('data', (c: any) => body += c);
            res.on('end', () => {
              if (res.statusCode < 300) resolve({ success: true, message: 'Sent via WhatsApp' });
              else { try { resolve({ success: false, message: JSON.parse(body)?.error?.message || 'HTTP ' + res.statusCode }); } catch { resolve({ success: false, message: 'HTTP ' + res.statusCode }); } }
            });
          });
          req.on('error', (e: any) => resolve({ success: false, message: e.message }));
          req.write(payload); req.end();
        });
      },
    });

    this.emitter.emit('status-change', { channelId, status: 'connected' });
    return { success: true, message: 'WhatsApp Cloud API connected! Webhook on port ' + webhookPort + '. Configure your Meta webhook URL to point to this machine.' };
  }

  // Baileys mode — uses browser fingerprinting and pairing code auth to avoid 405 blocks
  private async connectWhatsAppBaileys(channelId: string, _config: any): Promise<ConnectResult> {
    try {
      const { WhatsAppAdapter } = require('../main/channels/whatsapp');

      if (this.whatsAppAdapter) {
        await this.whatsAppAdapter.disconnect();
      }

      // Support pairing code auth: /channel whatsapp pairingCode=+1234567890
      const pairingPhoneNumber = _config?.pairingCode || _config?.phoneNumber || null;
      this.whatsAppAdapter = new WhatsAppAdapter(
        pairingPhoneNumber ? { pairingPhoneNumber } : undefined
      );

      this.whatsAppAdapter.onMessage((msg: IncomingMessage) => { this.emit(msg); });
      this.whatsAppAdapter.onStatus((status: any) => {
        this.emitter.emit('status-change', status);
        const handle = this.channels.get(channelId);
        if (handle) {
          if (status.status === 'connected') { handle.connection.status = 'connected'; handle.connection.error = undefined; }
          else if (status.status === 'error' || status.status === 'disconnected') { handle.connection.status = status.status === 'error' ? 'error' : 'disconnected'; handle.connection.error = status.error; }
          else { handle.connection.status = 'connecting'; }
        }
      });

      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'connecting' },
        stop: () => { if (this.whatsAppAdapter) this.whatsAppAdapter.disconnect().catch(() => {}); },
        send: async (to: string, message: string) => {
          if (!this.whatsAppAdapter) return { success: false, message: 'Not connected' };
          return this.whatsAppAdapter.sendMessage(to, message);
        },
      });

      this.emitter.emit('status-change', { channelId, status: 'connecting' });
      return await this.whatsAppAdapter.connect();
    } catch (e: any) {
      return { success: false, message: 'Baileys connection failed: ' + (e?.message || '') };
    }
  }

  // ── Telegram via grammy ──────────────────────────────────────────

  private async connectTelegram(channelId: string, config: any): Promise<ConnectResult> {
    let BotClass: any;

    try {
      const importMod = new Function('s', 'return import(s)');
      const grammy = await importMod('grammy').catch(() => null);
      if (!grammy) throw new Error('not installed');
      BotClass = grammy.Bot;
    } catch {
      return {
        success: false,
        message: 'Telegram SDK not installed. Run: npm install grammy',
      };
    }

    const botToken = config?.botToken;
    if (!botToken) {
      return { success: false, message: 'Telegram bot token is required. Add it in channel settings.' };
    }

    this.upsertHandle(channelId, {
      connection: { id: channelId, status: 'connecting' },
      stop: () => {},
      send: async () => ({ success: false, message: 'Still connecting' }),
    });

    try {
      const bot = new BotClass(botToken);

      // Incoming messages
      bot.on('message:text', (ctx: any) => {
        try {
          // Send typing indicator while processing
          ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});

          this.emit({
            channelId,
            from: String(ctx.from?.id ?? ctx.chat?.id ?? 'unknown'),
            content: ctx.message?.text ?? '',
            timestamp: new Date((ctx.message?.date ?? 0) * 1000),
          });
        } catch (err: any) {
          console.error('[ChannelManager] Telegram message parse error:', err?.message);
        }
      });

      // Start polling with auto-reconnect on error
      bot.catch((err: any) => {
        console.error('[ChannelManager] Telegram bot error (will auto-recover):', err?.message);
      });

      bot.start({
        onStart: () => {
          console.log('[ChannelManager] Telegram bot started polling');
        },
      });

      const stopFn = () => {
        try { bot.stop(); } catch { /* ignore */ }
      };

      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'connected' },
        stop: stopFn,
        send: async (to: string, message: string) => {
          try {
            // Show typing indicator before sending
            await bot.api.sendChatAction(to, 'typing').catch(() => {});
            await bot.api.sendMessage(to, message, { parse_mode: 'Markdown' }).catch(async () => {
              // Fallback: send without markdown if parsing fails
              await bot.api.sendMessage(to, message);
            });
            return { success: true, message: 'Message sent via Telegram' };
          } catch (err: any) {
            return { success: false, message: err?.message ?? 'Telegram send failed' };
          }
        },
      });

      console.log('[ChannelManager] Telegram connected');
      return { success: true, message: 'Telegram bot connected and polling for messages' };
    } catch (err: any) {
      const msg = err?.message ?? 'Telegram connection failed';
      console.error('[ChannelManager] Telegram error:', msg);
      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'error', error: msg },
        stop: () => {},
        send: async () => ({ success: false, message: 'Channel is in error state' }),
      });
      return { success: false, message: msg };
    }
  }

  // ── Discord via discord.js ───────────────────────────────────────

  private async connectDiscord(channelId: string, config: any): Promise<ConnectResult> {
    let ClientClass: any;
    let GatewayIntentBits: any;

    try {
      const importMod = new Function('s', 'return import(s)');
      const discordjs = await importMod('discord.js').catch(() => null);
      if (!discordjs) throw new Error('not installed');
      ClientClass = discordjs.Client;
      GatewayIntentBits = discordjs.GatewayIntentBits;
    } catch {
      return {
        success: false,
        message: 'Discord SDK not installed. Run: npm install discord.js',
      };
    }

    const token = config?.token;
    if (!token) {
      return { success: false, message: 'Discord bot token is required. Add it in channel settings.' };
    }

    this.upsertHandle(channelId, {
      connection: { id: channelId, status: 'connecting' },
      stop: () => {},
      send: async () => ({ success: false, message: 'Still connecting' }),
    });

    try {
      const client = new ClientClass({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      // Incoming messages
      client.on('messageCreate', (msg: any) => {
        try {
          if (msg.author?.bot) return;
          this.emit({
            channelId,
            from: msg.author?.tag ?? msg.author?.id ?? 'unknown',
            content: msg.content ?? '',
            timestamp: msg.createdAt ?? new Date(),
          });
        } catch (err: any) {
          console.error('[ChannelManager] Discord message parse error:', err?.message);
        }
      });

      await client.login(token);

      const stopFn = () => {
        try { client.destroy(); } catch { /* ignore */ }
      };

      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'connected' },
        stop: stopFn,
        send: async (to: string, message: string) => {
          try {
            const channel = await client.channels.fetch(to);
            if (!channel || !('send' in channel)) {
              return { success: false, message: `Discord channel ${to} not found or not a text channel` };
            }
            // Show typing indicator
            if ('sendTyping' in channel) await (channel as any).sendTyping().catch(() => {});
            // Split long messages (Discord 2000 char limit)
            if (message.length > 1900) {
              const chunks = message.match(/[\s\S]{1,1900}/g) || [message];
              for (const chunk of chunks) await (channel as any).send(chunk);
            } else {
              await (channel as any).send(message);
            }
            return { success: true, message: 'Message sent via Discord' };
          } catch (err: any) {
            return { success: false, message: err?.message ?? 'Discord send failed' };
          }
        },
      });

      console.log('[ChannelManager] Discord connected');
      return { success: true, message: 'Discord bot connected and listening for messages' };
    } catch (err: any) {
      const msg = err?.message ?? 'Discord connection failed';
      console.error('[ChannelManager] Discord error:', msg);
      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'error', error: msg },
        stop: () => {},
        send: async () => ({ success: false, message: 'Channel is in error state' }),
      });
      return { success: false, message: msg };
    }
  }

  // ── Slack via @slack/bolt ────────────────────────────────────────

  private async connectSlack(channelId: string, config: any): Promise<ConnectResult> {
    let AppClass: any;

    try {
      const importMod = new Function('s', 'return import(s)');
      const bolt = await importMod('@slack/bolt').catch(() => null);
      if (!bolt) throw new Error('not installed');
      AppClass = bolt.App;
    } catch {
      return {
        success: false,
        message: 'Slack SDK not installed. Run: npm install @slack/bolt',
      };
    }

    const botToken = config?.botToken;
    const appToken = config?.appToken;
    if (!botToken || !appToken) {
      return {
        success: false,
        message: 'Slack requires both a Bot Token (xoxb-...) and an App Token (xapp-...). Add them in channel settings.',
      };
    }

    this.upsertHandle(channelId, {
      connection: { id: channelId, status: 'connecting' },
      stop: () => {},
      send: async () => ({ success: false, message: 'Still connecting' }),
    });

    try {
      const app = new AppClass({
        token: botToken,
        appToken: appToken,
        socketMode: true,
      });

      // Incoming messages
      app.message(async ({ message: msg }: any) => {
        try {
          if (msg.subtype) return; // skip bot messages, edits, etc.
          this.emit({
            channelId,
            from: msg.user ?? 'unknown',
            content: msg.text ?? '',
            timestamp: new Date(parseFloat(msg.ts ?? '0') * 1000),
          });
        } catch (err: any) {
          console.error('[ChannelManager] Slack message parse error:', err?.message);
        }
      });

      await app.start();

      const stopFn = () => {
        try { app.stop(); } catch { /* ignore */ }
      };

      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'connected' },
        stop: stopFn,
        send: async (to: string, message: string) => {
          try {
            await app.client.chat.postMessage({
              channel: to,
              text: message,
            });
            return { success: true, message: 'Message sent via Slack' };
          } catch (err: any) {
            return { success: false, message: err?.message ?? 'Slack send failed' };
          }
        },
      });

      console.log('[ChannelManager] Slack connected (socket mode)');
      return { success: true, message: 'Slack bot connected in socket mode and listening for messages' };
    } catch (err: any) {
      const msg = err?.message ?? 'Slack connection failed';
      console.error('[ChannelManager] Slack error:', msg);
      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'error', error: msg },
        stop: () => {},
        send: async () => ({ success: false, message: 'Channel is in error state' }),
      });
      return { success: false, message: msg };
    }
  }

  // ── Email via nodemailer ─────────────────────────────────────────

  private async connectEmail(channelId: string, config: any): Promise<ConnectResult> {
    let nodemailer: any;

    try {
      // @ts-expect-error — nodemailer has no types
      const importMod = new Function('s', 'return import(s)');
      nodemailer = await importMod('nodemailer').catch(() => null);
      if (!nodemailer) throw new Error('not installed');
    } catch {
      return {
        success: false,
        message: 'Email SDK not installed. Run: npm install nodemailer',
      };
    }

    const smtpHost = config?.smtpHost;
    const smtpPort = parseInt(config?.smtpPort ?? '587', 10);
    const username = config?.username;
    const password = config?.password;

    if (!smtpHost || !username || !password) {
      return {
        success: false,
        message: 'Email requires SMTP host, username, and password. Add them in channel settings.',
      };
    }

    this.upsertHandle(channelId, {
      connection: { id: channelId, status: 'connecting' },
      stop: () => {},
      send: async () => ({ success: false, message: 'Still connecting' }),
    });

    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: username, pass: password },
      });

      // Verify SMTP connection
      await transporter.verify();

      const stopFn = () => {
        try { transporter.close(); } catch { /* ignore */ }
      };

      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'connected' },
        stop: stopFn,
        send: async (to: string, message: string) => {
          try {
            await transporter.sendMail({
              from: username,
              to,
              subject: 'NeuroNest Message',
              text: message,
            });
            return { success: true, message: 'Email sent successfully' };
          } catch (err: any) {
            return { success: false, message: err?.message ?? 'Email send failed' };
          }
        },
      });

      console.log('[ChannelManager] Email SMTP connected');
      return {
        success: true,
        message: 'Email connected (send-only — incoming messages require IMAP which is not yet supported)',
      };
    } catch (err: any) {
      const msg = err?.message ?? 'Email connection failed';
      console.error('[ChannelManager] Email error:', msg);
      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'error', error: msg },
        stop: () => {},
        send: async () => ({ success: false, message: 'Channel is in error state' }),
      });
      return { success: false, message: msg };
    }
  }

  // ── GitHub via REST API ─────────────────────────────────────────

  private async connectGitHub(channelId: string, config: any): Promise<ConnectResult> {
    const username = config?.username || '';
    const token = config?.token || '';

    if (!username || !token) {
      return { success: false, message: 'GitHub username and personal access token are required.' };
    }

    // Validate credentials by calling the GitHub API
    const https = require('node:https');

    const validateResult = await new Promise<{ valid: boolean; user?: string; error?: string }>((resolve) => {
      const req = https.request('https://api.github.com/user', {
        method: 'GET',
        headers: {
          'Authorization': 'token ' + token,
          'User-Agent': 'NeuroNest/1.0',
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 15000,
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode === 200 && parsed.login) {
              resolve({ valid: true, user: parsed.login });
            } else {
              resolve({ valid: false, error: parsed.message || 'Authentication failed (HTTP ' + res.statusCode + ')' });
            }
          } catch {
            resolve({ valid: false, error: 'Invalid response from GitHub API' });
          }
        });
      });
      req.on('error', (e: any) => resolve({ valid: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ valid: false, error: 'Request timed out' }); });
      req.end();
    });

    if (!validateResult.valid) {
      const errMsg = 'GitHub authentication failed: ' + (validateResult.error || 'Unknown error');
      this.upsertHandle(channelId, {
        connection: { id: channelId, status: 'error', error: errMsg },
        stop: () => {},
        send: async () => ({ success: false, message: errMsg }),
      });
      this.emitter.emit('status', { channelId, status: 'error', error: errMsg });
      return { success: false, message: errMsg };
    }

    console.log('[ChannelManager] GitHub connected as:', validateResult.user);

    this.upsertHandle(channelId, {
      connection: { id: channelId, status: 'connected' },
      stop: () => {
        console.log('[ChannelManager] GitHub disconnected');
      },
      send: async (to: string, message: string) => {
        // "send" for GitHub = create an issue on the specified repo
        try {
          const [owner, repo] = to.split('/');
          if (!owner || !repo) return { success: false, message: 'Recipient must be owner/repo format' };
          const body = JSON.stringify({ title: message.slice(0, 100), body: message });
          const result = await new Promise<{ success: boolean; message: string }>((resolve) => {
            const req2 = https.request('https://api.github.com/repos/' + owner + '/' + repo + '/issues', {
              method: 'POST',
              headers: {
                'Authorization': 'token ' + token,
                'User-Agent': 'NeuroNest/1.0',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
              timeout: 15000,
            }, (res2: any) => {
              let d = '';
              res2.on('data', (c: any) => d += c);
              res2.on('end', () => {
                if (res2.statusCode === 201) {
                  resolve({ success: true, message: 'Issue created' });
                } else {
                  resolve({ success: false, message: 'Failed: HTTP ' + res2.statusCode });
                }
              });
            });
            req2.on('error', (e: any) => resolve({ success: false, message: e.message }));
            req2.write(body);
            req2.end();
          });
          return result;
        } catch (e: any) {
          return { success: false, message: e.message };
        }
      },
    });

    this.emitter.emit('status', { channelId, status: 'connected' });
    return { success: true, message: 'Connected to GitHub as ' + validateResult.user };
  }
}
