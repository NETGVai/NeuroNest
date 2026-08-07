// ─── Things 3 Adapter ───────────────────────────────────────────
// Full ChannelAdapter implementation for Things 3 on macOS.
// Uses the Things URL scheme (things:///add, things:///show,
// things:///json) and AppleScript to create tasks, list tasks,
// complete tasks, and create projects. Supports structured inbound
// commands parsed as productivity actions. macOS only — returns
// SDK_MISSING on other platforms.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.2, REQ 7.8

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
 * Zod schema for Things 3 adapter configuration.
 * - authToken: Things URL scheme auth token (optional, for x-callback-url authentication)
 * - pollIntervalMs: how often to poll for task changes (optional, default 10000ms)
 * - defaultList: default list/area to create tasks in (optional)
 */
export const Things3ConfigSchema = z.object({
  authToken: z.string().optional(),
  pollIntervalMs: z.number().int().min(1000).default(10000),
  defaultList: z.string().optional(),
});

export type Things3Config = z.infer<typeof Things3ConfigSchema>;

// ─── AppleScript Helpers ────────────────────────────────────────

/**
 * Escape a string for safe inclusion in AppleScript string literals.
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * AppleScript to create a new task in Things 3.
 */
function buildCreateTaskScript(title: string, notes?: string, list?: string, dueDate?: string): string {
  const escapedTitle = escapeAppleScript(title);
  let props = `name:"${escapedTitle}"`;

  if (notes) {
    props += `, notes:"${escapeAppleScript(notes)}"`;
  }

  let targetClause = '';
  if (list) {
    targetClause = ` in list "${escapeAppleScript(list)}"`;
  }

  let dueDateClause = '';
  if (dueDate) {
    dueDateClause = `, due date:date "${escapeAppleScript(dueDate)}"`;
  }

  return `
tell application "Things3"
  set newToDo to make new to do with properties {${props}${dueDateClause}}${targetClause}
  return id of newToDo
end tell
  `.trim();
}

/**
 * AppleScript to list tasks in Things 3 (from a given list/area, or Inbox).
 */
function buildListTasksScript(listName?: string): string {
  if (listName) {
    const escapedList = escapeAppleScript(listName);
    return `
tell application "Things3"
  set taskList to to dos of list "${escapedList}"
  set resultList to ""
  repeat with t in taskList
    set resultList to resultList & (id of t) & "|" & (name of t) & "|" & (status of t) & linefeed
  end repeat
  return resultList
end tell
    `.trim();
  }

  return `
tell application "Things3"
  set taskList to to dos of list "Inbox"
  set resultList to ""
  repeat with t in taskList
    set resultList to resultList & (id of t) & "|" & (name of t) & "|" & (status of t) & linefeed
  end repeat
  return resultList
end tell
  `.trim();
}

/**
 * AppleScript to complete a task by name in Things 3.
 */
function buildCompleteTaskScript(taskName: string): string {
  const escapedName = escapeAppleScript(taskName);
  return `
tell application "Things3"
  set targetToDo to first to do whose name is "${escapedName}"
  set status of targetToDo to completed
  return id of targetToDo
end tell
  `.trim();
}

/**
 * AppleScript to create a project in Things 3.
 */
function buildCreateProjectScript(projectName: string, notes?: string): string {
  const escapedName = escapeAppleScript(projectName);
  let props = `name:"${escapedName}"`;

  if (notes) {
    props += `, notes:"${escapeAppleScript(notes)}"`;
  }

  return `
tell application "Things3"
  set newProject to make new project with properties {${props}}
  return id of newProject
end tell
  `.trim();
}

/**
 * AppleScript to list projects in Things 3.
 */
function buildListProjectsScript(): string {
  return `
tell application "Things3"
  set projectList to projects
  set resultList to ""
  repeat with p in projectList
    set resultList to resultList & (id of p) & "|" & (name of p) & linefeed
  end repeat
  return resultList
end tell
  `.trim();
}

/**
 * AppleScript to get a count of tasks in the Inbox.
 */
function buildInboxCountScript(): string {
  return `
tell application "Things3"
  return count of to dos of list "Inbox"
end tell
  `.trim();
}

// ─── URL Scheme Helpers ─────────────────────────────────────────

/**
 * Build a Things URL scheme URL for the 'add' command.
 * Reference: https://culturedcode.com/things/support/articles/2803573/
 */
function buildThingsAddUrl(title: string, opts?: { notes?: string | undefined; list?: string | undefined; when?: string | undefined; authToken?: string | undefined }): string {
  const params = new URLSearchParams();
  params.set('title', title);
  if (opts?.notes) params.set('notes', opts.notes);
  if (opts?.list) params.set('list', opts.list);
  if (opts?.when) params.set('when', opts.when);
  if (opts?.authToken) params.set('auth-token', opts.authToken);
  return `things:///add?${params.toString()}`;
}

/**
 * Build a Things URL scheme URL for the 'show' command.
 * Exported for use by command execution when navigating to a task/project.
 */
export function buildThingsShowUrl(id?: string, query?: string, authToken?: string): string {
  const params = new URLSearchParams();
  if (id) params.set('id', id);
  if (query) params.set('query', query);
  if (authToken) params.set('auth-token', authToken);
  return `things:///show?${params.toString()}`;
}

// ─── Command Parsing ────────────────────────────────────────────

interface ThingsCommand {
  action: 'create-task' | 'list-tasks' | 'complete-task' | 'create-project' | 'list-projects';
  title?: string | undefined;
  notes?: string | undefined;
  list?: string | undefined;
  dueDate?: string | undefined;
  query?: string | undefined;
}

/**
 * Parse a natural language or structured command for Things 3 operations.
 * Supports patterns like:
 *   "create task: Buy groceries | Need milk and eggs"
 *   "list tasks"
 *   "list tasks: Work"
 *   "complete task: Buy groceries"
 *   "create project: Home Renovation | Planning phase"
 *   "list projects"
 */
function parseThingsCommand(content: string): ThingsCommand | null {
  const lower = content.toLowerCase().trim();

  if (lower.startsWith('create task:') || lower.startsWith('add task:') || lower.startsWith('add:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    const parts = rest.split('|').map((p) => p.trim());
    return {
      action: 'create-task',
      title: parts[0] || 'Untitled Task',
      notes: parts[1] || undefined,
      list: parts[2] || undefined,
    };
  }

  if (lower.startsWith('complete task:') || lower.startsWith('complete:') || lower.startsWith('done:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'complete-task', title: rest };
  }

  if (lower.startsWith('create project:') || lower.startsWith('new project:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    const parts = rest.split('|').map((p) => p.trim());
    return {
      action: 'create-project',
      title: parts[0] || 'Untitled Project',
      notes: parts[1] || undefined,
    };
  }

  if (lower.startsWith('list tasks:') || lower.startsWith('tasks:')) {
    const rest = content.slice(content.indexOf(':') + 1).trim();
    return { action: 'list-tasks', list: rest || undefined };
  }

  if (lower === 'list tasks' || lower === 'tasks') {
    return { action: 'list-tasks' };
  }

  if (lower === 'list projects' || lower === 'projects') {
    return { action: 'list-projects' };
  }

  return null;
}

// ─── Things 3 Adapter ───────────────────────────────────────────

export class Things3Adapter extends BaseChannelAdapter {
  readonly channelId = 'things-3';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Things 3',
    emoji: '✅',
    description: 'Create, list, and complete tasks and projects via Things URL scheme',
    actionTags: ['create task', 'list tasks', 'complete task', 'create project'],
    sortOrder: 1020,
  };

  readonly configSchema = Things3ConfigSchema;

  private authToken: string | undefined;
  private defaultList: string | undefined;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 10000;
  private lastKnownInboxCount = 0;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // macOS-only check
    if (process.platform !== 'darwin') {
      return this.sdkMissing('macOS (Things 3 requires macOS)');
    }

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config ?? {});
    if (!parsed.success) {
      const msg = `Invalid Things 3 config: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.authToken = parsed.data.authToken;
    this.pollIntervalMs = parsed.data.pollIntervalMs;
    this.defaultList = parsed.data.defaultList;

    // Verify osascript is available
    try {
      await execFileAsync('osascript', ['-e', 'return "ok"']);
    } catch {
      return this.sdkMissing('osascript (AppleScript command-line tool)');
    }

    // Verify Things 3 is installed and accessible
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'tell application "Things3" to return name',
      ]);
      if (!stdout.trim()) {
        return this.sdkMissing('Things 3 application');
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.authFailed(
        `Cannot access Things 3. Ensure the app is installed and running. Error: ${detail}`,
      );
    }

    // Get initial inbox count for polling
    try {
      this.lastKnownInboxCount = await this.getInboxCount();
    } catch {
      // Non-fatal — start with 0
      this.lastKnownInboxCount = 0;
    }

    // Start polling for new inbox tasks (inbound trigger)
    this.pollTimer = setInterval(() => {
      void this.pollForNewTasks();
    }, this.pollIntervalMs);

    this.connected = true;
    this.log('info', 'Connected', { channelId: this.channelId });

    return {
      success: true,
      message: 'Things 3 adapter connected',
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
      return { success: false, message: 'Things 3 adapter is not connected' };
    }

    if (!message.content) {
      return { success: false, message: 'Message content is required' };
    }

    // Parse the outgoing message as a command
    const command = parseThingsCommand(message.content);

    if (!command) {
      // Default: create a new task with the message content as title
      return this.executeCommand({
        action: 'create-task',
        title: message.content,
        list: this.defaultList ?? undefined,
      });
    }

    return this.executeCommand(command);
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Execute a parsed Things 3 command via AppleScript.
   */
  private async executeCommand(command: ThingsCommand): Promise<SendResult> {
    try {
      switch (command.action) {
        case 'create-task': {
          const script = buildCreateTaskScript(
            command.title || 'Untitled Task',
            command.notes,
            command.list || this.defaultList,
            command.dueDate,
          );
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          const taskId = stdout.trim();

          // Also build Things URL for reference
          const thingsUrl = buildThingsAddUrl(command.title || 'Untitled Task', {
            notes: command.notes,
            list: command.list || this.defaultList,
            authToken: this.authToken,
          });

          return {
            success: true,
            message: `Task created: "${command.title}" (id: ${taskId}, url: ${thingsUrl})`,
          };
        }

        case 'list-tasks': {
          const script = buildListTasksScript(command.list || this.defaultList);
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          const results = stdout.trim();
          if (!results) {
            return { success: true, message: 'No tasks found.' };
          }
          // Format output nicely
          const formatted = results
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => {
              const [id, name, status] = line.split('|');
              return `- [${status?.trim() === 'completed' ? 'x' : ' '}] ${name?.trim()} (${id?.trim()})`;
            })
            .join('\n');
          return { success: true, message: `Tasks:\n${formatted}` };
        }

        case 'complete-task': {
          if (!command.title) {
            return { success: false, message: 'Task name is required for completion' };
          }
          const script = buildCompleteTaskScript(command.title);
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          return {
            success: true,
            message: `Task completed: "${command.title}" (id: ${stdout.trim()})`,
          };
        }

        case 'create-project': {
          const script = buildCreateProjectScript(
            command.title || 'Untitled Project',
            command.notes,
          );
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          return {
            success: true,
            message: `Project created: "${command.title}" (id: ${stdout.trim()})`,
          };
        }

        case 'list-projects': {
          const script = buildListProjectsScript();
          const { stdout } = await execFileAsync('osascript', ['-e', script]);
          const results = stdout.trim();
          if (!results) {
            return { success: true, message: 'No projects found.' };
          }
          const formatted = results
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => {
              const [id, name] = line.split('|');
              return `- ${name?.trim()} (${id?.trim()})`;
            })
            .join('\n');
          return { success: true, message: `Projects:\n${formatted}` };
        }

        default:
          return { success: false, message: `Unknown command action: ${(command as ThingsCommand).action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Things 3 command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Command failed: ${errMsg}` };
    }
  }

  /**
   * Get the count of tasks in the Inbox.
   */
  private async getInboxCount(): Promise<number> {
    const script = buildInboxCountScript();
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    const count = parseInt(stdout.trim(), 10);
    return isNaN(count) ? 0 : count;
  }

  /**
   * Poll for new inbox tasks. When new tasks appear, emit an inbound
   * message with the latest task info. This allows externally created
   * tasks (e.g., from Siri, Apple Watch, or the Things app) to
   * trigger AI processing.
   */
  private async pollForNewTasks(): Promise<void> {
    if (!this.connected || !this.ctx) return;

    try {
      const currentCount = await this.getInboxCount();

      if (currentCount > this.lastKnownInboxCount) {
        // New tasks have appeared — fetch the latest inbox task
        const script = `
tell application "Things3"
  set latestToDo to first to do of list "Inbox"
  return (name of latestToDo) & "|" & (notes of latestToDo)
end tell
        `.trim();

        const { stdout } = await execFileAsync('osascript', ['-e', script]);
        const output = stdout.trim();
        const separatorIdx = output.indexOf('|');

        if (separatorIdx >= 0) {
          const taskName = output.slice(0, separatorIdx);
          const taskNotes = output.slice(separatorIdx + 1);

          // Emit inbound message with the task info as content
          const content = taskNotes
            ? `New task: ${taskName} | Notes: ${taskNotes}`
            : `New task: ${taskName}`;

          this.emitInbound(
            `things3://inbox/${encodeURIComponent(taskName)}`,
            content,
            'text',
          );
        }

        this.lastKnownInboxCount = currentCount;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('warn', 'Poll for new tasks failed', { error: errMsg });
    }
  }
}
