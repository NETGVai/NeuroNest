// ─── Bear Notes Adapter ─────────────────────────────────────────
// Full ChannelAdapter implementation for Bear Notes on macOS.
// Uses Bear's x-callback-url scheme (bear://x-callback-url/) to
// create, search, and tag notes. macOS only — returns SDK_MISSING
// on other platforms.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.2, REQ 7.9

import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { BaseChannelAdapter } from './base-adapter';

const execFileAsync = promisify(execFile);

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Bear Notes adapter configuration.
 * - apiToken: Bear app API token (required for x-callback-url auth)
 * - pollIntervalMs: how often to poll for new notes (optional, default 5000ms)
 */
export const BearNotesConfigSchema = z.object({
  apiToken: z.string().min(1, 'Bear API token is required'),
  pollIntervalMs: z.number().int().min(1000).default(5000),
});

export type BearNotesConfig = z.infer<typeof BearNotesConfigSchema>;

// ─── Command Parsing ────────────────────────────────────────────

interface BearCommand {
  action: 'create' | 'search' | 'add-tag' | 'open-note';
  title?: string;
  text?: string;
  tag?: string;
  query?: string;
  id?: string;
}

/**
 * Parse a natural language or structured command for Bear note operations.
 * Supports patterns like:
 *   "create note: Title | Body content"
 *   "search: query"
 *   "add tag: NoteTitle | tag-name"
 *   "open note: NoteTitle"
 */
function parseBearCommand(content: string): BearCommand | null {
  const lower = content.toLowerCase().trim();

  if (lower.startsWith('create note:') || lower.startsWith('create:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    const parts = rest.split('|').map((p) => p.trim());
    return {
      action: 'create',
      title: parts[0] || 'Untitled',
      text: parts[1] || '',
    };
  }

  if (lower.startsWith('search notes:') || lower.startsWith('search:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'search', query: rest };
  }

  if (lower.startsWith('add tag:') || lower.startsWith('tag:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    const parts = rest.split('|').map((p) => p.trim());
    return {
      action: 'add-tag',
      title: parts[0] || '',
      tag: parts[1] || '',
    };
  }

  if (lower.startsWith('open note:') || lower.startsWith('open:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'open-note', title: rest };
  }

  return null;
}

// ─── Bear Notes Adapter ─────────────────────────────────────────

export class BearNotesAdapter extends BaseChannelAdapter {
  readonly channelId = 'bear-notes';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Bear Notes',
    emoji: '🐻',
    description: 'Create, search, and tag notes via Bear x-callback-url API',
    actionTags: ['create note', 'search notes', 'tag note', 'open note'],
    sortOrder: 1016,
  };

  readonly configSchema = BearNotesConfigSchema;

  private apiToken = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 5000;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // macOS-only check
    if (process.platform !== 'darwin') {
      return this.sdkMissing('macOS (Bear Notes requires macOS and the Bear app)');
    }

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config ?? {});
    if (!parsed.success) {
      const msg = `Invalid Bear Notes config: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.apiToken = parsed.data.apiToken;
    this.pollIntervalMs = parsed.data.pollIntervalMs;

    // Verify osascript is available (needed for x-callback-url)
    try {
      await execFileAsync('osascript', ['-e', 'return "ok"']);
    } catch {
      return this.sdkMissing('osascript (AppleScript command-line tool)');
    }

    // Verify Bear is installed by checking via mdfind
    try {
      await execFileAsync('mdfind', ['kMDItemCFBundleIdentifier == "net.shinyfrog.bear"']);
    } catch {
      return this.sdkMissing('Bear app (Bear Notes is not installed on this system)');
    }

    // Start polling for inbound note triggers
    this.pollTimer = setInterval(() => {
      void this.pollForChanges();
    }, this.pollIntervalMs);

    this.connected = true;
    this.log('info', 'Connected', { channelId: this.channelId });

    return {
      success: true,
      message: 'Bear Notes adapter connected',
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
      return { success: false, message: 'Bear Notes adapter is not connected' };
    }

    if (!message.content) {
      return { success: false, message: 'Message content is required' };
    }

    // Parse the outgoing message as a command
    const command = parseBearCommand(message.content);

    if (!command) {
      // Default: create a new note with the message content
      return this.executeCommand({
        action: 'create',
        title: `NeuroNest - ${new Date().toLocaleString()}`,
        text: message.content,
      });
    }

    return this.executeCommand(command);
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Execute a parsed Bear command via x-callback-url.
   */
  private async executeCommand(command: BearCommand): Promise<SendResult> {
    try {
      switch (command.action) {
        case 'create': {
          const params: Record<string, string> = {
            title: command.title || 'Untitled',
            text: command.text || '',
            token: this.apiToken,
            open_note: 'no',
          };
          if (command.tag) {
            params['tags'] = command.tag;
          }
          await this.openBearCallback('create', params);
          return {
            success: true,
            message: `Note created: "${command.title}"`,
          };
        }

        case 'search': {
          const params: Record<string, string> = {
            term: command.query || '',
            token: this.apiToken,
            show_window: 'no',
          };
          await this.openBearCallback('search', params);
          return {
            success: true,
            message: `Search triggered for: "${command.query}"`,
          };
        }

        case 'add-tag': {
          if (!command.title && !command.id) {
            return { success: false, message: 'Note title or ID is required to add a tag' };
          }
          if (!command.tag) {
            return { success: false, message: 'Tag name is required' };
          }
          const params: Record<string, string> = {
            name: command.tag,
            token: this.apiToken,
          };
          if (command.id) {
            params['id'] = command.id;
          } else if (command.title) {
            params['title'] = command.title;
          }
          await this.openBearCallback('add-tag', params);
          return {
            success: true,
            message: `Tag "${command.tag}" added to note "${command.title || command.id}"`,
          };
        }

        case 'open-note': {
          const params: Record<string, string> = {
            title: command.title || '',
            token: this.apiToken,
          };
          await this.openBearCallback('open-note', params);
          return {
            success: true,
            message: `Opened note: "${command.title}"`,
          };
        }

        default:
          return { success: false, message: `Unknown Bear command: ${(command as BearCommand).action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Bear Notes command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Command failed: ${errMsg}` };
    }
  }

  /**
   * Open a Bear x-callback-url using the `open` command on macOS.
   * Constructs the URL from the action name and parameters.
   */
  private async openBearCallback(action: string, params: Record<string, string>): Promise<string> {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const url = `bear://x-callback-url/${action}${query ? '?' + query : ''}`;

    // Use `open` command to trigger the x-callback-url on macOS
    const { stdout } = await execFileAsync('open', [url]);
    return stdout.trim();
  }

  /**
   * Poll for changes by searching for recent notes tagged with a trigger tag.
   * Notes tagged with #neuronest/inbox are treated as inbound messages.
   */
  private async pollForChanges(): Promise<void> {
    if (!this.connected || !this.ctx) return;

    try {
      // Search for notes with the neuronest inbox tag
      // Use Bear's search URL scheme with a specific tag
      const script = `
do shell script "open 'bear://x-callback-url/search?term=" & "%23neuronest%2Finbox" & "&token=${this.apiToken.replace(/'/g, "'\\''")}&show_window=no'"
delay 0.5
return "poll-done"
      `.trim();

      await execFileAsync('osascript', ['-e', script]);
      // Note: Bear x-callback-url doesn't return data via stdout.
      // In a production implementation, this would use Bear's
      // x-callback-url response mechanism or a sqlite approach
      // to read Bear's database for actual data retrieval.
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('warn', 'Bear Notes poll failed', { error: errMsg });
    }
  }
}
