/**
 * Task Completion Notifier — Listens to BackgroundTaskRegistry lifecycle events
 * and injects system messages into the conversation thread.
 *
 * On task completion/failure/kill, builds a formatted notification containing
 * the command, terminal state, exit code, and last 10 lines of combined output.
 * Optionally sends an IPC event to the renderer for UI notification.
 *
 * Requirements: 15.7, 15.10, 15.12
 */

import type { BackgroundTaskRegistry, TaskOutput } from './background-task-registry.js';

// ─── Types ──────────────────────────────────────────────────────

/** Terminal event type for notifications */
export type TaskTerminalEvent = 'completed' | 'failed' | 'killed';

/** Notification message injected into the conversation */
export interface TaskNotificationMessage {
  /** Role of the message (always 'system' for task notifications) */
  role: 'system';
  /** Formatted notification content */
  content: string;
  /** Metadata for UI rendering */
  metadata: {
    type: 'background-task-notification';
    taskId: string;
    event: TaskTerminalEvent;
    exitCode: number | undefined;
    command: string;
    timestamp: number;
  };
}

/** Callback to inject a system message into the conversation */
export type MessageInjectionCallback = (message: TaskNotificationMessage) => void;

/** Callback to send IPC event to renderer (optional) */
export type IPCNotificationCallback = (channel: string, data: unknown) => void;

/** Configuration for the task completion notifier */
export interface TaskCompletionNotifierConfig {
  /** Number of output lines to include in notification (default: 10) */
  outputLineCount: number;
  /** Whether to send IPC notifications to the renderer (default: true) */
  sendIPCNotifications: boolean;
}

// ─── Notification Formatting ────────────────────────────────────

/**
 * Format the last N lines of combined stdout+stderr output for display.
 * Interleaves stdout and stderr, preferring the most recent lines.
 */
export function formatOutputLines(output: TaskOutput | undefined, lineCount: number): string {
  if (!output) {
    return '(no output captured)';
  }

  // Combine stdout and stderr, taking the last N lines total
  const combined = [...output.stdout, ...output.stderr];
  const lastLines = combined.slice(-lineCount);

  if (lastLines.length === 0) {
    return '(no output captured)';
  }

  return lastLines.join('\n');
}

/**
 * Build a formatted notification message for a terminal task event.
 *
 * Format:
 *   [Background Task] {command} {completed|failed|killed} (exit code: {code})
 *
 *   {last 10 lines of stdout+stderr}
 */
export function buildNotificationContent(
  command: string,
  args: string[],
  event: TaskTerminalEvent,
  exitCode: number | undefined,
  output: TaskOutput | undefined,
  lineCount: number = 10,
): string {
  const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
  const exitCodeStr = exitCode !== undefined ? `exit code: ${exitCode}` : 'no exit code';
  const header = `[Background Task] ${fullCommand} ${event} (${exitCodeStr})`;
  const outputText = formatOutputLines(output, lineCount);

  return `${header}\n\n${outputText}`;
}

/**
 * Build the full TaskNotificationMessage object.
 */
export function buildNotificationMessage(
  taskId: string,
  command: string,
  args: string[],
  event: TaskTerminalEvent,
  exitCode: number | undefined,
  output: TaskOutput | undefined,
  lineCount: number = 10,
): TaskNotificationMessage {
  return {
    role: 'system',
    content: buildNotificationContent(command, args, event, exitCode, output, lineCount),
    metadata: {
      type: 'background-task-notification',
      taskId,
      event,
      exitCode,
      command: args.length > 0 ? `${command} ${args.join(' ')}` : command,
      timestamp: Date.now(),
    },
  };
}

// ─── Task Completion Notifier ───────────────────────────────────

const DEFAULT_CONFIG: TaskCompletionNotifierConfig = {
  outputLineCount: 10,
  sendIPCNotifications: true,
};

/**
 * Attaches to a BackgroundTaskRegistry and injects system messages into the
 * conversation stream on task completion, failure, or kill.
 */
export class TaskCompletionNotifier {
  private registry: BackgroundTaskRegistry;
  private messageCallback: MessageInjectionCallback;
  private ipcCallback: IPCNotificationCallback | null;
  private config: TaskCompletionNotifierConfig;
  private attached: boolean = false;

  // Store bound handlers so we can remove them on detach
  private onCompleted: ((evt: { taskId: string; exitCode: number }) => void) | null = null;
  private onFailed: ((evt: { taskId: string; error: string }) => void) | null = null;
  private onKilled: ((evt: { taskId: string }) => void) | null = null;

  constructor(
    registry: BackgroundTaskRegistry,
    messageCallback: MessageInjectionCallback,
    ipcCallback?: IPCNotificationCallback | null,
    config?: Partial<TaskCompletionNotifierConfig>,
  ) {
    this.registry = registry;
    this.messageCallback = messageCallback;
    this.ipcCallback = ipcCallback ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start listening to registry events. Idempotent — calling attach()
   * multiple times has no additional effect.
   */
  attach(): void {
    if (this.attached) return;

    this.onCompleted = (evt) => this.handleEvent(evt.taskId, 'completed', evt.exitCode);
    this.onFailed = (evt) => this.handleEvent(evt.taskId, 'failed', undefined);
    this.onKilled = (evt) => this.handleEvent(evt.taskId, 'killed', undefined);

    this.registry.on('task:completed', this.onCompleted);
    this.registry.on('task:failed', this.onFailed);
    this.registry.on('task:killed', this.onKilled);

    this.attached = true;
  }

  /**
   * Stop listening to registry events.
   */
  detach(): void {
    if (!this.attached) return;

    if (this.onCompleted) this.registry.off('task:completed', this.onCompleted);
    if (this.onFailed) this.registry.off('task:failed', this.onFailed);
    if (this.onKilled) this.registry.off('task:killed', this.onKilled);

    this.onCompleted = null;
    this.onFailed = null;
    this.onKilled = null;
    this.attached = false;
  }

  /** Whether the notifier is currently attached to the registry */
  isAttached(): boolean {
    return this.attached;
  }

  // ─── Private ────────────────────────────────────────────────────

  private handleEvent(taskId: string, event: TaskTerminalEvent, exitCode: number | undefined): void {
    const record = this.registry.getTask(taskId);
    if (!record) return;

    // For failed tasks, get exit code from record if not passed directly
    const effectiveExitCode = exitCode ?? record.exitCode;

    const output = this.registry.getOutput(taskId);

    const message = buildNotificationMessage(
      taskId,
      record.command,
      record.args,
      event,
      effectiveExitCode,
      output,
      this.config.outputLineCount,
    );

    // Inject system message into conversation
    this.messageCallback(message);

    // Send IPC notification to renderer if configured
    if (this.config.sendIPCNotifications && this.ipcCallback) {
      this.ipcCallback('background-task:notification', {
        taskId,
        event,
        exitCode: effectiveExitCode,
        command: record.command,
        args: record.args,
        timestamp: message.metadata.timestamp,
      });
    }
  }
}
