/**
 * WhatsAppClient — core Baileys socket wrapper.
 * Handles connection lifecycle, QR auth, reconnect with exponential backoff,
 * and message normalization.
 */

import { EventEmitter } from 'events';
import { getAuthDir, clearAuth } from './AuthStore';

export interface NormalizedMessage {
  id: string;
  userId: string;
  channel: 'whatsapp';
  text?: string;
  media?: { mimetype?: string; url?: string };
  timestamp: number;
  raw?: any;
}

export type WAStatus = 'disconnected' | 'connecting' | 'qr_required' | 'connected';

// Dynamic import helper — prevents TS from converting to require()
const dynamicImport = new Function('specifier', 'return import(specifier)');

export class WhatsAppClient extends EventEmitter {
  private sock: any = null;
  private status: WAStatus = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnects = 15;
  private reconnectTimer: any = null;
  private stopped = false;
  private pairingPhoneNumber: string | null = null;
  private sentMessageIds: Set<string> = new Set();
  private ownerJid: string | null = null;   // e.g. 16472933484@s.whatsapp.net
  private ownerLid: string | null = null;   // e.g. 171841725423819@lid

  getStatus(): WAStatus { return this.status; }

  /** Set phone number for pairing code auth (alternative to QR scan) */
  setPairingPhone(phoneNumber: string): void {
    // Strip non-digits, ensure no leading +
    this.pairingPhoneNumber = phoneNumber.replace(/[^0-9]/g, '');
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    await this.createSocket();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock) {
      try { this.sock.end(undefined); } catch {}
      this.sock = null;
    }
    this.setStatus('disconnected');
  }

  async logout(): Promise<void> {
    await this.stop();
    clearAuth();
    console.log('[WhatsApp] Logged out and cleared auth');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp not connected');
    }
    // Normalize JID — support both @s.whatsapp.net and @lid formats
    let normalizedJid = jid;
    if (!jid.includes('@')) {
      normalizedJid = jid + '@s.whatsapp.net';
    }
    // LID format (e.g. 171841725423819@lid) is valid as-is
    console.log('[WhatsApp] Sending message to:', normalizedJid, 'text:', text.slice(0, 50));
    const result = await this.sock.sendMessage(normalizedJid, { text });
    // Track the message ID so we don't process our own reply as an incoming message
    if (result?.key?.id) {
      this.sentMessageIds.add(result.key.id);
      // Clean up old IDs after 5 minutes to prevent memory leak
      setTimeout(() => this.sentMessageIds.delete(result.key.id), 300000);
    }
  }

  private setStatus(s: WAStatus) {
    this.status = s;
    this.emit('status', s);
  }

  private async createSocket(): Promise<void> {
    // Use @whiskeysockets/baileys from GitHub master (has 405 fixes)
    let baileys: any;
    try {
      baileys = await dynamicImport('@whiskeysockets/baileys');
      console.log('[WhatsApp] Using @whiskeysockets/baileys (master)');
    } catch {
      try {
        baileys = await dynamicImport('baileys');
        console.log('[WhatsApp] Using baileys package');
      } catch (e: any) {
        this.setStatus('disconnected');
        this.emit('error', new Error('Baileys SDK not found. Run: npm install'));
        return;
      }
    }
    const makeWASocket = baileys.default ?? baileys.makeWASocket;
    const useMultiFileAuthState = baileys.useMultiFileAuthState;
    const DisconnectReason = baileys.DisconnectReason;
    const Browsers = baileys.Browsers;

    const authDir = getAuthDir();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const isRegistered = !!state.creds?.registered;

    console.log('[WhatsApp] Creating socket, registered:', isRegistered, 'attempt:', this.reconnectAttempts);
    this.setStatus('connecting');

    // Use browser fingerprint that WhatsApp recognizes as legitimate
    // The browser array is [platform, appName, appVersion]
    // WhatsApp displays this as "Google Chrome (<platform>)" in Linked Devices
    const browserConfig = ['NeuroNest 🧠', 'Chrome', '126.0.0.0'];

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: browserConfig,
      // Connection parameters that reduce 405 blocks
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      // Retry connection config
      retryRequestDelayMs: 250,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 25000,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    // Capture owner LID when it becomes available
    sock.ev.on('creds.update', () => {
      if (sock.user?.id && !this.ownerJid) {
        this.ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      }
    });

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WhatsApp] QR code received');
        this.setStatus('qr_required');
        this.emit('qr', qr);
        this.reconnectAttempts = 0; // Reset on QR — user interaction expected
      }

      if (connection === 'open') {
        console.log('[WhatsApp] Connected!');
        this.reconnectAttempts = 0;
        this.setStatus('connected');
        // Capture owner JID for message filtering (owner-only mode)
        if (sock.user?.id) {
          // sock.user.id is like "16472933484:11@s.whatsapp.net"
          const rawId = sock.user.id.split(':')[0];
          this.ownerJid = rawId + '@s.whatsapp.net';
          console.log('[WhatsApp] Owner JID:', this.ownerJid);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason?.loggedOut;
        console.log('[WhatsApp] Closed, code:', statusCode, 'loggedOut:', loggedOut);

        if (loggedOut) {
          clearAuth();
          this.setStatus('disconnected');
          this.emit('logout');
          return;
        }

        // 405 = WhatsApp blocking unofficial clients
        // Strategy: wait longer between retries (WhatsApp rate-limits aggressively)
        // Allow up to 5 attempts with increasing delays before giving up
        if (statusCode === 405) {
          // Clear stale auth on first 405 — old credentials from outdated library versions
          // cause persistent 405s even after upgrading
          if (this.reconnectAttempts === 0) {
            console.log('[WhatsApp] Clearing stale auth state (may be from old library version)');
            clearAuth();
          }

          if (this.reconnectAttempts >= 5) {
            this.setStatus('disconnected');
            this.emit('error', new Error(
              'WhatsApp connection blocked (HTTP 405) after multiple retries. ' +
              'Options:\n' +
              '1. Wait 5-10 minutes and try again (WhatsApp rate-limits)\n' +
              '2. Use WhatsApp Cloud API mode instead (official, never blocked)\n' +
              '3. Try pairing code auth: /channel whatsapp pairingCode=<your_phone_number>'
            ));
            return;
          }
          // Longer delays for 405: 30s, 60s, 90s, 120s, 150s
          const delay = 30000 * (this.reconnectAttempts + 1);
          this.reconnectAttempts++;
          console.log('[WhatsApp] 405 block — retrying in', delay / 1000, 's (attempt', this.reconnectAttempts, ')');
          this.setStatus('connecting');
          this.reconnectTimer = setTimeout(() => this.createSocket(), delay);
          return;
        }

        if (!this.stopped && this.reconnectAttempts < this.maxReconnects) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          this.reconnectAttempts++;
          console.log('[WhatsApp] Reconnecting in', delay, 'ms (attempt', this.reconnectAttempts + ')');
          this.setStatus('connecting');
          this.reconnectTimer = setTimeout(() => this.createSocket(), delay);
        } else if (!this.stopped) {
          this.setStatus('disconnected');
          this.emit('error', new Error('Max reconnect attempts reached'));
        }
      }
    });

    // Incoming messages — OWNER ONLY
    // Only process messages from the device owner's self-chat.
    // Messages from other users or groups are ignored for security.
    sock.ev.on('messages.upsert', (m: any) => {
      try {
        for (const msg of (m.messages ?? [])) {
          // Skip status broadcasts
          if (msg.key.remoteJid === 'status@broadcast') continue;
          if (msg.broadcast) continue;

          // Skip group messages (JIDs ending in @g.us)
          if (msg.key.remoteJid?.endsWith('@g.us')) continue;

          // OWNER-ONLY: only process messages from the owner's own JID or LID
          const sender = msg.key.remoteJid ?? '';
          const senderBase = sender.split(':')[0]; // strip device suffix
          const ownerBase = this.ownerJid?.split('@')[0] ?? '';
          const ownerLidBase = this.ownerLid?.split('@')[0] ?? '';

          const isOwnerPN = ownerBase && senderBase.startsWith(ownerBase);
          const isOwnerLid = ownerLidBase && senderBase.startsWith(ownerLidBase);
          const isSelfChat = sender === this.ownerJid || isOwnerPN || isOwnerLid || sender.endsWith('@lid');

          if (!isSelfChat) {
            // Message from someone else — ignore silently
            continue;
          }

          // Skip messages sent by this linked device (NeuroNest's own replies)
          if (msg.key.fromMe && this.sentMessageIds.has(msg.key.id)) {
            continue;
          }

          const text = msg.message?.conversation
            ?? msg.message?.extendedTextMessage?.text
            ?? '';
          if (!text) continue;

          const normalized: NormalizedMessage = {
            id: msg.key.id ?? '',
            userId: msg.key.remoteJid ?? 'unknown',
            channel: 'whatsapp',
            text,
            timestamp: (msg.messageTimestamp ?? 0) * 1000,
            raw: msg,
          };

          console.log('[WhatsApp] Owner message:', text.slice(0, 50));
          this.emit('message', normalized);
        }
      } catch (err: any) {
        console.error('[WhatsApp] Message parse error:', err?.message);
      }
    });

    // If not registered and a phone number is provided, try pairing code auth
    if (!isRegistered && this.pairingPhoneNumber) {
      try {
        // Wait a moment for socket to initialize
        await new Promise(r => setTimeout(r, 3000));
        if (sock.requestPairingCode) {
          const code = await sock.requestPairingCode(this.pairingPhoneNumber);
          console.log('[WhatsApp] Pairing code:', code);
          this.emit('pairing-code', code);
        }
      } catch (e: any) {
        console.warn('[WhatsApp] Pairing code request failed:', e?.message);
        // Fall back to QR — it will be emitted via connection.update
      }
    }
  }
}
