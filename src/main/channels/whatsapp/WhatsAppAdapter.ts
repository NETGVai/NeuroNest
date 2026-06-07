/**
 * WhatsAppAdapter — bridges WhatsAppClient to the ChannelManager interface.
 * Handles QR→base64 image conversion, rate limiting, and message routing.
 */

import { WhatsAppClient, NormalizedMessage, WAStatus } from './WhatsAppClient';
import type { ConnectResult, SendResult, IncomingMessage } from '../../../channels/channel-manager';

// Dynamic import for qrcode (CJS package)
let qrcodeModule: any = null;
async function getQRCode(): Promise<any> {
  if (!qrcodeModule) {
    try { qrcodeModule = require('qrcode'); } catch {
      try { qrcodeModule = await (new Function('s', 'return import(s)'))('qrcode'); } catch {}
    }
  }
  return qrcodeModule;
}

// Simple rate limiter
class RateLimiter {
  private timestamps: number[] = [];
  constructor(private maxPerMinute: number = 30) {}

  canSend(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60000);
    return this.timestamps.length < this.maxPerMinute;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }
}

export class WhatsAppAdapter {
  private client: WhatsAppClient;
  private rateLimiter = new RateLimiter(30);
  private lastQR: string | null = null;
  private lastQRBase64: string | null = null;
  private onMessageHandler: ((msg: IncomingMessage) => void) | null = null;
  private onStatusHandler: ((status: any) => void) | null = null;
  private onQRHandler: ((qrBase64: string) => void) | null = null;

  constructor(config?: { pairingPhoneNumber?: string }) {
    this.client = new WhatsAppClient();
    if (config?.pairingPhoneNumber) {
      this.client.setPairingPhone(config.pairingPhoneNumber);
    }
    this.wireEvents();
  }

  private wireEvents(): void {
    this.client.on('qr', async (qr: string) => {
      this.lastQR = qr;
      // Convert QR string to base64 data URL
      try {
        const qrcode = await getQRCode();
        if (qrcode) {
          const dataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 2 });
          this.lastQRBase64 = dataUrl;
          if (this.onQRHandler) this.onQRHandler(dataUrl);
          if (this.onStatusHandler) {
            this.onStatusHandler({ channelId: 'whatsapp', status: 'qr_required', qrDataUrl: dataUrl });
          }
        }
      } catch (e: any) {
        console.error('[WhatsApp:Adapter] QR encode error:', e?.message);
        // Fallback: send raw QR string
        if (this.onStatusHandler) {
          this.onStatusHandler({ channelId: 'whatsapp', status: 'qr_required', qrCode: qr });
        }
      }
    });

    this.client.on('status', (status: WAStatus) => {
      if (this.onStatusHandler) {
        this.onStatusHandler({ channelId: 'whatsapp', status });
      }
    });

    this.client.on('message', (msg: NormalizedMessage) => {
      if (this.onMessageHandler) {
        this.onMessageHandler({
          channelId: 'whatsapp',
          from: msg.userId,
          content: msg.text || '',
          timestamp: new Date(msg.timestamp),
        });
      }
    });

    this.client.on('error', (err: Error) => {
      console.error('[WhatsApp:Adapter] Error:', err.message);
      if (this.onStatusHandler) {
        this.onStatusHandler({ channelId: 'whatsapp', status: 'error', error: err.message });
      }
    });

    this.client.on('logout', () => {
      if (this.onStatusHandler) {
        this.onStatusHandler({ channelId: 'whatsapp', status: 'disconnected', error: 'Logged out' });
      }
    });
  }

  async connect(): Promise<ConnectResult> {
    try {
      await this.client.start();
      return new Promise<ConnectResult>((resolve) => {
        let resolved = false;
        const done = (r: ConnectResult) => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(r);
          }
        };

        const onStatus = (s: WAStatus) => {
          if (s === 'connected') {
            done({ success: true, message: 'WhatsApp connected!' });
          }
        };

        const onQR = async (qr: string) => {
          const qrcode = await getQRCode();
          let qrData = qr;
          if (qrcode) {
            try { qrData = await qrcode.toDataURL(qr, { width: 256, margin: 2 }); } catch {}
          }
          done({ success: true, message: 'Scan QR code to connect', qrCode: qrData });
        };

        const onError = (err: Error) => {
          done({ success: false, message: err.message });
        };

        this.client.on('status', onStatus);
        this.client.on('qr', onQR);
        this.client.on('error', onError);

        const cleanup = () => {
          this.client.removeListener('status', onStatus);
          this.client.removeListener('qr', onQR);
          this.client.removeListener('error', onError);
        };

        setTimeout(() => {
          const s = this.client.getStatus();
          if (s === 'connected') done({ success: true, message: 'Connected' });
          else if (s === 'qr_required') done({ success: true, message: 'Waiting for QR scan', qrCode: this.lastQRBase64 || this.lastQR || '' });
          else done({ success: false, message: 'WhatsApp connection timed out. WhatsApp may be blocking Baileys connections (HTTP 405). Try again later.' });
        }, 20000);
      });
    } catch (e: any) {
      return { success: false, message: e?.message || 'Connection failed' };
    }
  }

  async disconnect(): Promise<void> {
    await this.client.stop();
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  async sendMessage(to: string, message: string): Promise<SendResult> {
    if (!this.rateLimiter.canSend()) {
      return { success: false, message: 'Rate limit exceeded (30/min). Try again shortly.' };
    }
    try {
      // Allow digits, @, ., letters (for @lid, @s.whatsapp.net, @g.us formats)
      const cleanTo = to.replace(/[^0-9a-zA-Z@._-]/g, '');
      if (!cleanTo) return { success: false, message: 'Invalid recipient' };
      await this.client.sendMessage(cleanTo, message);
      this.rateLimiter.record();
      return { success: true, message: 'Sent via WhatsApp' };
    } catch (e: any) {
      return { success: false, message: e?.message || 'Send failed' };
    }
  }

  getStatus(): WAStatus {
    return this.client.getStatus();
  }

  getLastQR(): string | null {
    return this.lastQRBase64 || this.lastQR;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.onMessageHandler = handler;
  }

  onStatus(handler: (status: any) => void): void {
    this.onStatusHandler = handler;
  }

  onQR(handler: (qrBase64: string) => void): void {
    this.onQRHandler = handler;
  }
}
