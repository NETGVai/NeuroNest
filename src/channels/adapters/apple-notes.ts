// ─── Apple Notes Adapter ────────────────────────────────────────
// Full ChannelAdapter implementation for Apple Notes on macOS.
// Uses osascript (AppleScript) to create, search, and append to
// notes in the Notes app. Supports structured inbound commands
// parsed as productivity actions. macOS only — returns SDK_MISSING
// on other platforms.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.2, REQ 7.6

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
 * Zod schema for Apple Notes adapter configuration.
 * - defaultFolder: folder name in Notes to operate on (defaults to "Notes")
 * - pollIntervalMs: how often to poll for new notes (optional, default 5000ms)
 */
export const AppleNotesConfigSchema = z.object({
  defaultFolder: z.string().default('Notes'),
  pollIntervalMs: z.number().int().min(1000).default(5000),
});

export type AppleNotesConfig = z.infer<typeof AppleNotesConfigSchema>;

// ─── AppleScript Helpers ────────────────────────────────────────

/**
 * Escape a string for safe inclusion in AppleScript string literals.
 * Escapes backslashes and double-quote characters.
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * AppleScript to create a new note with a title and body in the specified folder.
 */
function buildCreateNoteScript(folder: string, title: string, body: string): string {
  const escapedFolder = escapeAppleScript(folder);
  const escapedTitle = escapeAppleScript(title);
  const escapedBody = escapeAppleScript(body);

  return `
tell application "Notes"
  set targetFolder to folder "${escapedFolder}" of default account
  set newNote to make new note at targetFolder with properties {name:"${escapedTitle}", body:"${escapedBody}"}
  return id of newNote
end tell
  `.trim();
}

/**
 * AppleScript to search notes by name containing the query string.
 * Returns pipe-separated list of "id|name" pairs.
 */
function buildSearchNotesScript(folder: string, query: string): string {
  const escapedFolder = escapeAppleScript(folder);
  const escapedQuery = escapeAppleScript(query);

  return `
tell application "Notes"
  set targetFolder to folder "${escapedFolder}" of default account
  set matchingNotes to every note of targetFolder whose name contains "${escapedQuery}"
  set resultList to ""
  repeat with n in matchingNotes
    set resultList to resultList & (id of n) & "|" & (name of n) & linefeed
  end repeat
  return resultList
end tell
  `.trim();
}

/**
 * AppleScript to append text to an existing note identified by its name.
 */
function buildAppendNoteScript(folder: string, noteName: string, textToAppend: string): string {
  const escapedFolder = escapeAppleScript(folder);
  const escapedName = escapeAppleScript(noteName);
  const escapedText = escapeAppleScript(textToAppend);

  return `
tell application "Notes"
  set targetFolder to folder "${escapedFolder}" of default account
  set targetNote to first note of targetFolder whose name is "${escapedName}"
  set currentBody to body of targetNote
  set body of targetNote to currentBody & "<br>" & "${escapedText}"
  return "ok"
end tell
  `.trim();
}

/**
 * AppleScript to get the body content of a note by name.
 */
function buildReadNoteScript(folder: string, noteName: string): string {
  const escapedFolder = escapeAppleScript(folder);
  const escapedName = escapeAppleScript(noteName);

  return `
tell application "Notes"
  set targetFolder to folder "${escapedFolder}" of default account
  set targetNote to first note of targetFolder whose name is "${escapedName}"
  return plaintext of targetNote
end tell
  `.trim();
}

/**
 * AppleScript to list all notes in the specified folder.
 * Returns pipe-separated "id|name" pairs.
 */
function buildListNotesScript(folder: string): string {
  const escapedFolder = escapeAppleScript(folder);

  return `
tell application "Notes"
  set targetFolder to folder "${escapedFolder}" of default account
  set allNotes to every note of targetFolder
  set resultList to ""
  repeat with n in allNotes
    set resultList to resultList & (id of n) & "|" & (name of n) & linefeed
  end repeat
  return resultList
end tell
  `.trim();
}

// ─── Command Parsing ────────────────────────────────────────────

interface NoteCommand {
  action: 'create' | 'search' | 'append' | 'read' | 'list';
  title?: string;
  body?: string;
  query?: string;
}

/**
 * Parse a natural language or structured command for note operations.
 * Supports patterns like:
 *   "create note: Title | Body content"
 *   "search notes: query"
 *   "append to: NoteName | Additional text"
 *   "read note: NoteName"
 *   "list notes"
 */
function parseNoteCommand(content: string): NoteCommand | null {
  const lower = content.toLowerCase().trim();

  if (lower.startsWith('create note:') || lower.startsWith('create:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    const parts = rest.split('|').map((p) => p.trim());
    return {
      action: 'create',
      title: parts[0] || 'Untitled',
      body: parts[1] || '',
    };
  }

  if (lower.startsWith('search notes:') || lower.startsWith('search:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'search', query: rest };
  }

  if (lower.startsWith('append to:') || lower.startsWith('append:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    const parts = rest.split('|').map((p) => p.trim());
    return {
      action: 'append',
      title: parts[0] || '',
      body: parts[1] || '',
    };
  }

  if (lower.startsWith('read note:') || lower.startsWith('read:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'read', title: rest };
  }

  if (lower === 'list notes' || lower === 'list') {
    return { action: 'list' };
  }

  return null;
}

// ─── Apple Notes Adapter ────────────────────────────────────────

export class AppleNotesAdapter extends BaseChannelAdapter {
  readonly channelId = 'apple-notes';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Apple Notes',
    emoji: '📝',
    description: 'Create, search, and manage notes via AppleScript',
    actionTags: ['create note', 'search notes', 'append to note', 'read note'],
    sortOrder: 1010,
  };

  readonly configSchema = AppleNotesConfigSchema;

  private defaultFolder = 'Notes';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 5000;
  private lastKnownNoteCount = 0;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // macOS-only check
    if (process.platform !== 'darwin') {
      return this.sdkMissing('macOS (Apple Notes requires macOS and the Notes app)');
    }

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config ?? {});
    if (!parsed.success) {
      const msg = `Invalid Apple Notes config: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.defaultFolder = parsed.data.defaultFolder;
    this.pollIntervalMs = parsed.data.pollIntervalMs;

    // Verify osascript is available
    try {
      await execFileAsync('osascript', ['-e', 'return "ok"']);
    } catch {
      return this.sdkMissing('osascript (AppleScript command-line tool)');
    }

    // Verify Notes app access by listing notes in the folder
    try {
      const noteCount = await this.getNoteCount();
      this.lastKnownNoteCount = noteCount;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.authFailed(
        `Cannot access Notes folder "${this.defaultFolder}". Ensure Notes app is set up and the folder exists. Error: ${detail}`,
      );
    }

    // Start polling for new notes (inbound trigger)
    this.pollTimer = setInterval(() => {
      void this.pollForNewNotes();
    }, this.pollIntervalMs);

    this.connected = true;
    this.log('info', 'Connected', { channelId: this.channelId, folder: this.defaultFolder });

    return {
      success: true,
      message: `Apple Notes adapter connected (folder: ${this.defaultFolder})`,
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
      return { success: false, message: 'Apple Notes adapter is not connected' };
    }

    if (!message.content) {
      return { success: false, message: 'Message content is required' };
    }

    // Parse the outgoing message as a command
    const command = parseNoteCommand(message.content);

    if (!command) {
      // Default: create a new note with the message content
      return this.executeCommand({
        action: 'create',
        title: `NeuroNest - ${new Date().toLocaleString()}`,
        body: message.content,
      });
    }

    return this.executeCommand(command);
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Execute a parsed note command via AppleScript.
   */
  private async executeCommand(command: NoteCommand): Promise<SendResult> {
    try {
      switch (command.action) {
        case 'create': {
          const script = buildCreateNoteScript(
            this.defaultFolder,
            command.title || 'Untitled',
            command.body || '',
          );
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          return {
            success: true,
            message: `Note created: "${command.title}" (id: ${stdout.trim()})`,
          };
        }

        case 'search': {
          const script = buildSearchNotesScript(
            this.defaultFolder,
            command.query || '',
          );
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          const results = stdout.trim();
          if (!results) {
            return { success: true, message: 'No notes found matching the query.' };
          }
          return { success: true, message: `Found notes:\n${results}` };
        }

        case 'append': {
          if (!command.title) {
            return { success: false, message: 'Note name is required for append' };
          }
          const script = buildAppendNoteScript(
            this.defaultFolder,
            command.title,
            command.body || '',
          );
          await execFileAsync('osascript', ['-e', script]);
          return {
            success: true,
            message: `Appended to note "${command.title}"`,
          };
        }

        case 'read': {
          if (!command.title) {
            return { success: false, message: 'Note name is required for read' };
          }
          const script = buildReadNoteScript(this.defaultFolder, command.title);
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          return { success: true, message: stdout.trim() };
        }

        case 'list': {
          const script = buildListNotesScript(this.defaultFolder);
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          const results = stdout.trim();
          if (!results) {
            return { success: true, message: 'No notes found in folder.' };
          }
          return { success: true, message: `Notes:\n${results}` };
        }

        default:
          return { success: false, message: `Unknown command action: ${(command as NoteCommand).action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Apple Notes command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Command failed: ${errMsg}` };
    }
  }

  /**
   * Get the count of notes in the configured folder.
   */
  private async getNoteCount(): Promise<number> {
    const script = `
tell application "Notes"
  set targetFolder to folder "${escapeAppleScript(this.defaultFolder)}" of default account
  return count of notes of targetFolder
end tell
    `.trim();

    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    const count = parseInt(stdout.trim(), 10);
    return isNaN(count) ? 0 : count;
  }

  /**
   * Poll for new notes by checking the note count. When new notes
   * appear, emit an inbound message for the latest note content.
   * This allows external note creation to trigger AI processing.
   */
  private async pollForNewNotes(): Promise<void> {
    if (!this.connected || !this.ctx) return;

    try {
      const currentCount = await this.getNoteCount();

      if (currentCount > this.lastKnownNoteCount) {
        // New notes have appeared — fetch the latest note content
        const script = `
tell application "Notes"
  set targetFolder to folder "${escapeAppleScript(this.defaultFolder)}" of default account
  set latestNote to first note of targetFolder
  return (name of latestNote) & "|" & (plaintext of latestNote)
end tell
        `.trim();

        const { stdout } = await execFileAsync('osascript', ['-e', script]);
        const output = stdout.trim();
        const separatorIdx = output.indexOf('|');

        if (separatorIdx > 0) {
          const noteName = output.slice(0, separatorIdx);
          const noteContent = output.slice(separatorIdx + 1);

          // Emit inbound message with the note content as a command
          this.emitInbound(
            `notes://${this.defaultFolder}/${noteName}`,
            noteContent,
            'text',
          );
        }

        this.lastKnownNoteCount = currentCount;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('warn', 'Poll for new notes failed', { error: errMsg });
    }
  }
}
