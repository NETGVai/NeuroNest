// ─── iMessage Adapter ───────────────────────────────────────────
// Full ChannelAdapter implementation for iMessage on macOS.
// Uses AppleScript (osascript) to send messages and polls the
// Messages app SQLite database (~Library/Messages/chat.db) for
// new inbound messages. macOS only — returns SDK_MISSING on other
// platforms.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.1, REQ 6.2

import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { BaseChannelAdapter } from './base-adapter';

const execFileAsync = promisify(execFile);

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for iMessage adapter configuration.
 * - pollIntervalMs: how often to poll chat.db for new messages (default 3000ms)
 * - dbPath: override path to chat.db (optional, for testing)
 */
export const IMessageConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(500).default(3000),
  dbPath: z.string().optional(),
});

export type IMessageConfig = z.infer<typeof IMessageConfigSchema>;

// ─── Constants ──────────────────────────────────────────────────

/** Default path to the Messages SQLite database on macOS. */
const DEFAULT_CHAT_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Messages',
  'chat.db',
);

/**
 * AppleScript template for sending an iMessage.
 * Uses the Messages app to send a text message to a recipient
 * identified by phone number or Apple ID (email).
 */
function buildSendScript(recipient: string, text: string): string {
  // Escape backslashes and double quotes for AppleScript string literals
  const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  return `
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${escapedRecipient}" of targetService
  send "${escapedText}" to targetBuddy
end tell
  `.trim();
}

// ─── iMessage Adapter ───────────────────────────────────────────

export class IMessageAdapter extends BaseChannelAdapter {
  readonly channelId = 'imessage';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'iMessage',
    emoji: '🍎',
    description: 'Via AppleScript bridge',
    actionTags: ['send message', 'receive message', 'send media'],
    sortOrder: 1001,
  };

  readonly configSchema = IMessageConfigSchema;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private dbPath: string = DEFAULT_CHAT_DB_PATH;
  private pollIntervalMs = 3000;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // macOS-only check
    if (process.platform !== 'darwin') {
      return this.sdkMissing('macOS (iMessage requires macOS and the Messages app)');
    }

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config ?? {});
    if (!parsed.success) {
      const msg = `Invalid iMessage config: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.pollIntervalMs = parsed.data.pollIntervalMs;
    this.dbPath = parsed.data.dbPath ?? DEFAULT_CHAT_DB_PATH;

    // Verify chat.db is accessible by reading the latest ROWID
    try {
      const latestRowId = await this.queryLatestRowId();
      this.lastRowId = latestRowId;
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? err.message : String(err);
      const msg = `Cannot access Messages database at ${this.dbPath}. Ensure Full Disk Access is granted. Error: ${detail}`;
      return {
        success: false,
        message: msg,
        error: { code: 'AUTH_FAILED', message: msg },
      };
    }

    // Verify osascript is available
    try {
      await execFileAsync('osascript', ['-e', 'return "ok"']);
    } catch {
      return this.sdkMissing('osascript (AppleScript command-line tool)');
    }

    // Start polling for new messages
    this.pollTimer = setInterval(() => {
      void this.pollNewMessages();
    }, this.pollIntervalMs);

    this.connected = true;
    this.log('info', 'Connected', { channelId: this.channelId, dbPath: this.dbPath });

    return {
      success: true,
      message: 'iMessage adapter connected via AppleScript bridge',
    };
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected) {
      return { success: false, message: 'iMessage adapter is not connected' };
    }

    if (!message.to || !message.content) {
      return { success: false, message: 'Recipient (to) and content are required' };
    }

    const script = buildSendScript(message.to, message.content);

    try {
      await execFileAsync('osascript', ['-e', script]);
      return { success: true, message: 'Message sent via iMessage' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Failed to send iMessage', { to: message.to, error: errMsg });
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Query the Messages chat.db for the latest ROWID in the message table.
   * Uses sqlite3 CLI since better-sqlite3 may not be available.
   */
  private async queryLatestRowId(): Promise<number> {
    const { stdout } = await execFileAsync('sqlite3', [
      this.dbPath,
      'SELECT MAX(ROWID) FROM message;',
    ]);
    const parsed = parseInt(stdout.trim(), 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Poll for new messages since lastRowId. Emits inbound messages
   * for each new row found.
   */
  private async pollNewMessages(): Promise<void> {
    if (!this.connected || !this.ctx) return;

    try {
      // Query new messages joined with handle table to get sender info
      const query = `
SELECT
  m.ROWID,
  m.text,
  m.date,
  m.is_from_me,
  h.id AS sender_id
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE m.ROWID > ${this.lastRowId}
  AND m.is_from_me = 0
  AND m.text IS NOT NULL
  AND m.text != ''
ORDER BY m.ROWID ASC
LIMIT 50;
      `.trim();

      const { stdout } = await execFileAsync('sqlite3', [
        '-separator',
        '|',
        this.dbPath,
        query,
      ]);

      if (!stdout.trim()) return;

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 5) continue;

        const rowId = parseInt(parts[0]!, 10);
        const text = parts[1] ?? '';
        // parts[2] = date (Apple epoch, unused for now)
        // parts[3] = is_from_me (always 0 here)
        const senderId = parts[4] ?? 'unknown';

        if (isNaN(rowId)) continue;

        // Update high-water mark
        if (rowId > this.lastRowId) {
          this.lastRowId = rowId;
        }

        // Emit the inbound message with sender's Apple ID or phone number
        this.emitInbound(senderId, text, 'text');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('warn', 'Poll failed', { error: errMsg });
    }
  }
}
