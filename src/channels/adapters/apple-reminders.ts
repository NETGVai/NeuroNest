// ─── Apple Reminders Adapter ────────────────────────────────────
// Full ChannelAdapter implementation for Apple Reminders on macOS.
// Uses osascript (AppleScript) to create, list, and complete
// reminders in the Reminders app. Supports structured inbound
// commands parsed as productivity actions. macOS only — returns
// SDK_MISSING on other platforms.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.2, REQ 7.7

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
 * Zod schema for Apple Reminders adapter configuration.
 * - defaultList: list name in Reminders to operate on (defaults to "Reminders")
 * - pollIntervalMs: how often to poll for new/changed reminders (optional, default 5000ms)
 */
export const AppleRemindersConfigSchema = z.object({
  defaultList: z.string().default('Reminders'),
  pollIntervalMs: z.number().int().min(1000).default(5000),
});

export type AppleRemindersConfig = z.infer<typeof AppleRemindersConfigSchema>;

// ─── AppleScript Helpers ────────────────────────────────────────

/**
 * Escape a string for safe inclusion in AppleScript string literals.
 * Escapes backslashes and double-quote characters.
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * AppleScript to create a new reminder in the specified list.
 */
function buildCreateReminderScript(listName: string, name: string, dueDate?: string, notes?: string): string {
  const escapedList = escapeAppleScript(listName);
  const escapedName = escapeAppleScript(name);

  let properties = `name:"${escapedName}"`;
  if (notes) {
    properties += `, body:"${escapeAppleScript(notes)}"`;
  }

  let script = `
tell application "Reminders"
  set targetList to list "${escapedList}"
  set newReminder to make new reminder at end of targetList with properties {${properties}}`;

  if (dueDate) {
    const escapedDate = escapeAppleScript(dueDate);
    script += `
  set due date of newReminder to date "${escapedDate}"`;
  }

  script += `
  return id of newReminder
end tell`;

  return script.trim();
}

/**
 * AppleScript to list all incomplete reminders in the specified list.
 * Returns pipe-separated "id|name|dueDate" lines.
 */
function buildListRemindersScript(listName: string): string {
  const escapedList = escapeAppleScript(listName);

  return `
tell application "Reminders"
  set targetList to list "${escapedList}"
  set incompleteReminders to (every reminder of targetList whose completed is false)
  set resultList to ""
  repeat with r in incompleteReminders
    set dueDateStr to ""
    try
      set dueDateStr to (due date of r) as string
    end try
    set resultList to resultList & (id of r) & "|" & (name of r) & "|" & dueDateStr & linefeed
  end repeat
  return resultList
end tell
  `.trim();
}

/**
 * AppleScript to complete (mark as done) a reminder by name.
 */
function buildCompleteReminderScript(listName: string, reminderName: string): string {
  const escapedList = escapeAppleScript(listName);
  const escapedName = escapeAppleScript(reminderName);

  return `
tell application "Reminders"
  set targetList to list "${escapedList}"
  set targetReminder to first reminder of targetList whose name is "${escapedName}"
  set completed of targetReminder to true
  return "ok"
end tell
  `.trim();
}

/**
 * AppleScript to search reminders by name containing the query string.
 * Returns pipe-separated "id|name|completed" lines.
 */
function buildSearchRemindersScript(listName: string, query: string): string {
  const escapedList = escapeAppleScript(listName);
  const escapedQuery = escapeAppleScript(query);

  return `
tell application "Reminders"
  set targetList to list "${escapedList}"
  set matchingReminders to (every reminder of targetList whose name contains "${escapedQuery}")
  set resultList to ""
  repeat with r in matchingReminders
    set completedStr to "incomplete"
    if completed of r then
      set completedStr to "completed"
    end if
    set resultList to resultList & (id of r) & "|" & (name of r) & "|" & completedStr & linefeed
  end repeat
  return resultList
end tell
  `.trim();
}

/**
 * AppleScript to get the count of incomplete reminders in the specified list.
 */
function buildCountRemindersScript(listName: string): string {
  const escapedList = escapeAppleScript(listName);

  return `
tell application "Reminders"
  set targetList to list "${escapedList}"
  return count of (every reminder of targetList whose completed is false)
end tell
  `.trim();
}

// ─── Command Parsing ────────────────────────────────────────────

interface ReminderCommand {
  action: 'create' | 'list' | 'complete' | 'search';
  name?: string | undefined;
  dueDate?: string | undefined;
  notes?: string | undefined;
  query?: string | undefined;
}

/**
 * Parse a natural language or structured command for reminder operations.
 * Supports patterns like:
 *   "create reminder: Buy milk | 2024-01-15 | Don't forget oat milk"
 *   "list reminders"
 *   "complete: Buy milk"
 *   "search reminders: milk"
 */
function parseReminderCommand(content: string): ReminderCommand | null {
  const lower = content.toLowerCase().trim();

  if (lower.startsWith('create reminder:') || lower.startsWith('create:') || lower.startsWith('remind me:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    const parts = rest.split('|').map((p) => p.trim());
    return {
      action: 'create',
      name: parts[0] || 'Untitled Reminder',
      dueDate: parts[1] || undefined,
      notes: parts[2] || undefined,
    };
  }

  if (lower.startsWith('complete:') || lower.startsWith('done:') || lower.startsWith('finish:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'complete', name: rest };
  }

  if (lower.startsWith('search reminders:') || lower.startsWith('search:') || lower.startsWith('find:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'search', query: rest };
  }

  if (lower === 'list reminders' || lower === 'list' || lower === 'show reminders') {
    return { action: 'list' };
  }

  return null;
}

// ─── Apple Reminders Adapter ────────────────────────────────────

export class AppleRemindersAdapter extends BaseChannelAdapter {
  readonly channelId = 'apple-reminders';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Apple Reminders',
    emoji: '⏰',
    description: 'Create, list, and complete reminders via AppleScript',
    actionTags: ['create reminder', 'list reminders', 'complete reminder', 'search reminders'],
    sortOrder: 1011,
  };

  readonly configSchema = AppleRemindersConfigSchema;

  private defaultList = 'Reminders';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 5000;
  private lastKnownReminderCount = 0;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // macOS-only check
    if (process.platform !== 'darwin') {
      return this.sdkMissing('macOS (Apple Reminders requires macOS and the Reminders app)');
    }

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config ?? {});
    if (!parsed.success) {
      const msg = `Invalid Apple Reminders config: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.defaultList = parsed.data.defaultList;
    this.pollIntervalMs = parsed.data.pollIntervalMs;

    // Verify osascript is available
    try {
      await execFileAsync('osascript', ['-e', 'return "ok"']);
    } catch {
      return this.sdkMissing('osascript (AppleScript command-line tool)');
    }

    // Verify Reminders app access by counting reminders in the list
    try {
      const count = await this.getReminderCount();
      this.lastKnownReminderCount = count;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.authFailed(
        `Cannot access Reminders list "${this.defaultList}". Ensure Reminders app is set up and the list exists. Error: ${detail}`,
      );
    }

    // Start polling for new reminders (inbound trigger)
    this.pollTimer = setInterval(() => {
      void this.pollForNewReminders();
    }, this.pollIntervalMs);

    this.connected = true;
    this.log('info', 'Connected', { channelId: this.channelId, list: this.defaultList });

    return {
      success: true,
      message: `Apple Reminders adapter connected (list: ${this.defaultList})`,
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
      return { success: false, message: 'Apple Reminders adapter is not connected' };
    }

    if (!message.content) {
      return { success: false, message: 'Message content is required' };
    }

    // Parse the outgoing message as a command
    const command = parseReminderCommand(message.content);

    if (!command) {
      // Default: create a new reminder with the message content
      return this.executeCommand({
        action: 'create',
        name: message.content,
      });
    }

    return this.executeCommand(command);
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Execute a parsed reminder command via AppleScript.
   */
  private async executeCommand(command: ReminderCommand): Promise<SendResult> {
    try {
      switch (command.action) {
        case 'create': {
          const script = buildCreateReminderScript(
            this.defaultList,
            command.name || 'Untitled Reminder',
            command.dueDate,
            command.notes,
          );
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          return {
            success: true,
            message: `Reminder created: "${command.name}" (id: ${stdout.trim()})`,
          };
        }

        case 'list': {
          const script = buildListRemindersScript(this.defaultList);
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          const results = stdout.trim();
          if (!results) {
            return { success: true, message: 'No incomplete reminders found.' };
          }
          // Format output for readability
          const lines = results.split('\n').filter((l) => l.trim());
          const formatted = lines
            .map((line) => {
              const [_id, name, dueDate] = line.split('|');
              return dueDate ? `• ${name} (due: ${dueDate})` : `• ${name}`;
            })
            .join('\n');
          return { success: true, message: `Reminders:\n${formatted}` };
        }

        case 'complete': {
          if (!command.name) {
            return { success: false, message: 'Reminder name is required for complete' };
          }
          const script = buildCompleteReminderScript(this.defaultList, command.name);
          await execFileAsync('osascript', ['-e', script]);
          return {
            success: true,
            message: `Reminder completed: "${command.name}"`,
          };
        }

        case 'search': {
          const script = buildSearchRemindersScript(
            this.defaultList,
            command.query || '',
          );
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          const results = stdout.trim();
          if (!results) {
            return { success: true, message: 'No reminders found matching the query.' };
          }
          // Format output for readability
          const lines = results.split('\n').filter((l) => l.trim());
          const formatted = lines
            .map((line) => {
              const [_id, name, status] = line.split('|');
              return `• ${name} [${status}]`;
            })
            .join('\n');
          return { success: true, message: `Found reminders:\n${formatted}` };
        }

        default:
          return { success: false, message: `Unknown command action: ${(command as ReminderCommand).action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Apple Reminders command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Command failed: ${errMsg}` };
    }
  }

  /**
   * Get the count of incomplete reminders in the configured list.
   */
  private async getReminderCount(): Promise<number> {
    const script = buildCountRemindersScript(this.defaultList);
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    const count = parseInt(stdout.trim(), 10);
    return isNaN(count) ? 0 : count;
  }

  /**
   * Poll for new reminders by checking the incomplete count. When new
   * reminders appear, emit an inbound message for the latest reminder.
   * This allows external reminder creation to trigger AI processing.
   */
  private async pollForNewReminders(): Promise<void> {
    if (!this.connected || !this.ctx) return;

    try {
      const currentCount = await this.getReminderCount();

      if (currentCount > this.lastKnownReminderCount) {
        // New reminders have appeared — fetch the latest one
        const script = `
tell application "Reminders"
  set targetList to list "${escapeAppleScript(this.defaultList)}"
  set latestReminder to last reminder of targetList whose completed is false
  set dueDateStr to ""
  try
    set dueDateStr to (due date of latestReminder) as string
  end try
  return (name of latestReminder) & "|" & dueDateStr
end tell
        `.trim();

        const { stdout } = await execFileAsync('osascript', ['-e', script]);
        const output = stdout.trim();
        const separatorIdx = output.indexOf('|');

        if (separatorIdx >= 0) {
          const reminderName = output.slice(0, separatorIdx);
          const dueDate = output.slice(separatorIdx + 1);

          const content = dueDate
            ? `New reminder: ${reminderName} (due: ${dueDate})`
            : `New reminder: ${reminderName}`;

          // Emit inbound message with the reminder info
          this.emitInbound(
            `reminders://${this.defaultList}/${reminderName}`,
            content,
            'text',
          );
        }

        this.lastKnownReminderCount = currentCount;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('warn', 'Poll for new reminders failed', { error: errMsg });
    }
  }
}
