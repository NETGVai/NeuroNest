// ─── Cron Adapter ───────────────────────────────────────────────
// Full ChannelAdapter implementation for a local cron/scheduler.
// Stores schedules in memory, uses setTimeout to trigger at
// scheduled times, and emits inbound messages when triggered.
// Supports cron expressions (via a lightweight parser) and simple
// interval-based schedules. Exposes create, list, and delete
// operations through the send method.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.4, REQ 10.5

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Cron adapter configuration.
 * Minimal — the cron adapter runs entirely locally.
 */
export const CronConfigSchema = z.object({
  /** Optional timezone for schedule evaluation (default: system local) */
  timezone: z.string().optional(),
  /** Maximum number of schedules allowed (default: 100) */
  maxSchedules: z.number().int().min(1).max(1000).default(100),
});

export type CronConfig = z.infer<typeof CronConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported cron command actions (REQ 10.4, 10.5) */
type CronAction = 'create' | 'list' | 'delete' | 'get';

/** A stored schedule entry */
export interface CronSchedule {
  id: string;
  name: string;
  /** Cron expression (e.g., "star/5 * * * *") or interval string (e.g., "every 30s") */
  expression: string;
  /** The message content emitted when the schedule fires */
  payload: string;
  /** Whether the schedule is currently active */
  active: boolean;
  /** Unix timestamp when the schedule was created */
  createdAt: number;
  /** Unix timestamp of the last trigger (0 if never triggered) */
  lastTriggeredAt: number;
  /** Number of times this schedule has fired */
  triggerCount: number;
}

/** Parsed inbound command structure */
interface CronCommand {
  action: CronAction;
  id?: string;
  name?: string;
  expression?: string;
  payload?: string;
}

/** Internal timer entry associated with a schedule */
interface ScheduleTimer {
  scheduleId: string;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  type: 'timeout' | 'interval';
}

// ─── Cron Expression Utilities ──────────────────────────────────

/**
 * Parses a simple interval expression and returns the interval in milliseconds.
 * Supports formats like:
 *   - 'every 30s'  → 30000
 *   - 'every 5m'   → 300000
 *   - 'every 1h'   → 3600000
 *   - 'every 2d'   → 172800000
 *
 * Returns null if the expression doesn't match the simple interval pattern.
 */
function parseSimpleInterval(expression: string): number | null {
  const match = expression.match(/^every\s+(\d+)\s*([smhd])$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * (multipliers[unit] ?? 1000);
}

/**
 * Parses a standard 5-field cron expression and returns the next
 * execution time in milliseconds from now.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Supports: numbers, '*', and step values (e.g., '*​/5')
 *
 * Returns the delay in ms until the next matching time.
 */
function getNextCronDelay(expression: string): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  // Validate that each field looks like a cron field
  const cronFieldRegex = /^(\*|\d+)(\/(d+))?$/;
  for (const part of parts) {
    if (!part.match(/^(\*|\d+)(\/\d+)?$/)) return null;
  }

  const now = new Date();
  const [minField, hourField, domField, monField, dowField] = parts;

  // Try each minute in the next 24 hours to find the next match
  const maxSearch = 24 * 60; // Search up to 24 hours ahead
  for (let offset = 1; offset <= maxSearch; offset++) {
    const candidate = new Date(now.getTime() + offset * 60 * 1000);
    candidate.setSeconds(0, 0);

    if (
      matchesCronField(minField, candidate.getMinutes()) &&
      matchesCronField(hourField, candidate.getHours()) &&
      matchesCronField(domField, candidate.getDate()) &&
      matchesCronField(monField, candidate.getMonth() + 1) &&
      matchesCronField(dowField, candidate.getDay())
    ) {
      return candidate.getTime() - now.getTime();
    }
  }

  // If no match found within 24 hours, default to 24h
  return 24 * 60 * 60 * 1000;
}

/**
 * Checks whether a given value matches a cron field expression.
 * Supports: '*', exact number, step values (e.g., '*​/5', '10/2')
 */
function matchesCronField(field: string, value: number): boolean {
  if (field === '*') return true;

  if (field.includes('/')) {
    const [base, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;
    const baseValue = base === '*' ? 0 : parseInt(base, 10);
    if (isNaN(baseValue)) return false;
    return (value - baseValue) % step === 0 && value >= baseValue;
  }

  const exact = parseInt(field, 10);
  return !isNaN(exact) && exact === value;
}

// ─── Cron Adapter ───────────────────────────────────────────────

export class CronAdapter extends BaseChannelAdapter {
  readonly channelId = 'cron';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'push',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Cron',
    emoji: '⏰',
    description: 'Local scheduler — create timed triggers that emit messages on schedule',
    actionTags: ['create schedule', 'list schedules', 'delete schedule'],
    sortOrder: 1130,
  };

  readonly configSchema = CronConfigSchema;

  private config: CronConfig | null = null;
  private schedules = new Map<string, CronSchedule>();
  private timers = new Map<string, ScheduleTimer>();
  private idCounter = 0;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Cron adapter configuration is invalid.\n\n' +
        'Configuration:\n' +
        '  timezone?: string (optional, defaults to system local)\n' +
        '  maxSchedules?: number (1-1000, default: 100)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;
    this.connected = true;
    this.log('info', 'Connected', { timezone: this.config.timezone ?? 'system', maxSchedules: this.config.maxSchedules });

    return {
      success: true,
      message: `Cron adapter connected. Max schedules: ${this.config.maxSchedules}`,
    };
  }

  async disconnect(): Promise<void> {
    // Clear all timers
    for (const timerEntry of this.timers.values()) {
      if (timerEntry.type === 'interval') {
        clearInterval(timerEntry.timer);
      } else {
        clearTimeout(timerEntry.timer);
      }
    }
    this.timers.clear();
    this.schedules.clear();

    this.connected = false;
    this.config = null;
    this.ctx = null;
    this.idCounter = 0;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected) {
      return { success: false, message: 'Cron adapter is not connected' };
    }

    // Parse the outbound message as a cron command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message: 'Invalid cron command. Supported actions: create, list, delete, get',
      };
    }

    switch (command.action) {
      case 'create':
        return this.handleCreate(command);
      case 'list':
        return this.handleList();
      case 'delete':
        return this.handleDelete(command);
      case 'get':
        return this.handleGet(command);
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // ─── Command Parsing ──────────────────────────────────────────

  /**
   * Parses a message content string into a CronCommand.
   * Supports JSON format: { "action": "create", "name": "...", "expression": "...", "payload": "..." }
   * Also supports simple text format: "create <name> <expression> <payload>"
   */
  private parseCommand(content: string): CronCommand | null {
    // Try JSON format first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
        return {
          action: parsed.action as CronAction,
          id: parsed.id,
          name: parsed.name,
          expression: parsed.expression,
          payload: parsed.payload,
        };
      }
    } catch {
      // Not JSON, try text format
    }

    // Simple text format
    const lower = content.toLowerCase().trim();

    if (lower === 'list' || lower === 'list schedules') {
      return { action: 'list' };
    }

    if (lower.startsWith('delete ')) {
      const id = content.slice(7).trim();
      return { action: 'delete', id };
    }

    if (lower.startsWith('get ')) {
      const id = content.slice(4).trim();
      return { action: 'get', id };
    }

    // create <name> | <expression> | <payload>
    if (lower.startsWith('create ')) {
      const rest = content.slice(7).trim();
      const parts = rest.split('|').map((p) => p.trim());
      if (parts.length >= 2) {
        return {
          action: 'create',
          name: parts[0],
          expression: parts[1],
          payload: parts[2] ?? `Schedule "${parts[0]}" triggered`,
        };
      }
    }

    return null;
  }

  // ─── Command Handlers ─────────────────────────────────────────

  private handleCreate(command: CronCommand): SendResult {
    if (!this.config) {
      return { success: false, message: 'Adapter not configured' };
    }

    if (!command.name || !command.expression) {
      return {
        success: false,
        message: 'Create requires name and expression. Use: create <name> | <expression> | <payload>',
      };
    }

    if (this.schedules.size >= this.config.maxSchedules) {
      return {
        success: false,
        message: `Maximum schedule limit reached (${this.config.maxSchedules}). Delete existing schedules first.`,
      };
    }

    const id = `cron-${++this.idCounter}-${Date.now()}`;
    const schedule: CronSchedule = {
      id,
      name: command.name,
      expression: command.expression,
      payload: command.payload ?? `Schedule "${command.name}" triggered`,
      active: true,
      createdAt: Date.now(),
      lastTriggeredAt: 0,
      triggerCount: 0,
    };

    this.schedules.set(id, schedule);

    // Start the timer for this schedule
    const started = this.startScheduleTimer(schedule);
    if (!started) {
      this.schedules.delete(id);
      return {
        success: false,
        message: `Invalid schedule expression: "${command.expression}". Use cron format (e.g., "*/5 * * * *") or interval format (e.g., "every 30s").`,
      };
    }

    this.log('info', 'Schedule created', { id, name: command.name, expression: command.expression });

    return {
      success: true,
      message: JSON.stringify({
        action: 'created',
        schedule: {
          id,
          name: schedule.name,
          expression: schedule.expression,
          payload: schedule.payload,
          active: schedule.active,
          createdAt: schedule.createdAt,
        },
      }),
    };
  }

  private handleList(): SendResult {
    const scheduleList = Array.from(this.schedules.values()).map((s) => ({
      id: s.id,
      name: s.name,
      expression: s.expression,
      payload: s.payload,
      active: s.active,
      createdAt: s.createdAt,
      lastTriggeredAt: s.lastTriggeredAt,
      triggerCount: s.triggerCount,
    }));

    return {
      success: true,
      message: JSON.stringify({ action: 'list', schedules: scheduleList, count: scheduleList.length }),
    };
  }

  private handleDelete(command: CronCommand): SendResult {
    if (!command.id) {
      return { success: false, message: 'Delete requires a schedule ID' };
    }

    const schedule = this.schedules.get(command.id);
    if (!schedule) {
      return { success: false, message: `Schedule not found: ${command.id}` };
    }

    // Stop the timer
    this.stopScheduleTimer(command.id);
    this.schedules.delete(command.id);

    this.log('info', 'Schedule deleted', { id: command.id, name: schedule.name });

    return {
      success: true,
      message: JSON.stringify({ action: 'deleted', id: command.id, name: schedule.name }),
    };
  }

  private handleGet(command: CronCommand): SendResult {
    if (!command.id) {
      return { success: false, message: 'Get requires a schedule ID' };
    }

    const schedule = this.schedules.get(command.id);
    if (!schedule) {
      return { success: false, message: `Schedule not found: ${command.id}` };
    }

    return {
      success: true,
      message: JSON.stringify({ action: 'get', schedule }),
    };
  }

  // ─── Timer Management ─────────────────────────────────────────

  /**
   * Starts a timer for the given schedule. Returns true if the expression
   * was valid and a timer was successfully started, false otherwise.
   */
  private startScheduleTimer(schedule: CronSchedule): boolean {
    // Try simple interval format first
    const intervalMs = parseSimpleInterval(schedule.expression);
    if (intervalMs !== null) {
      const timer = setInterval(() => {
        this.fireSchedule(schedule.id);
      }, intervalMs);

      this.timers.set(schedule.id, {
        scheduleId: schedule.id,
        timer,
        type: 'interval',
      });
      return true;
    }

    // Try cron expression
    const delay = getNextCronDelay(schedule.expression);
    if (delay !== null) {
      this.scheduleCronExecution(schedule.id, schedule.expression);
      return true;
    }

    return false;
  }

  /**
   * Schedules the next execution of a cron-expression-based schedule.
   * Uses setTimeout to fire at the next matching time, then re-schedules.
   */
  private scheduleCronExecution(scheduleId: string, expression: string): void {
    const delay = getNextCronDelay(expression);
    if (delay === null) return;

    const timer = setTimeout(() => {
      this.fireSchedule(scheduleId);
      // Re-schedule for next occurrence (if schedule still exists and is active)
      const schedule = this.schedules.get(scheduleId);
      if (schedule && schedule.active) {
        this.scheduleCronExecution(scheduleId, expression);
      }
    }, delay);

    this.timers.set(scheduleId, {
      scheduleId,
      timer,
      type: 'timeout',
    });
  }

  /**
   * Fires a schedule: emits an inbound message with the schedule's payload
   * and updates tracking metadata.
   */
  private fireSchedule(scheduleId: string): void {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || !schedule.active || !this.connected) return;

    // Update trigger metadata
    schedule.lastTriggeredAt = Date.now();
    schedule.triggerCount++;

    // Emit inbound message (REQ 10.4)
    const content = JSON.stringify({
      type: 'schedule-trigger',
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      expression: schedule.expression,
      payload: schedule.payload,
      triggerCount: schedule.triggerCount,
      timestamp: new Date().toISOString(),
    });

    this.emitInbound(`schedule:${schedule.id}`, content);

    this.log('info', 'Schedule triggered', {
      id: schedule.id,
      name: schedule.name,
      triggerCount: schedule.triggerCount,
    });
  }

  /**
   * Stops and removes the timer for a given schedule ID.
   */
  private stopScheduleTimer(scheduleId: string): void {
    const timerEntry = this.timers.get(scheduleId);
    if (!timerEntry) return;

    if (timerEntry.type === 'interval') {
      clearInterval(timerEntry.timer);
    } else {
      clearTimeout(timerEntry.timer);
    }

    this.timers.delete(scheduleId);
  }

  // ─── Public Accessors (for testing) ───────────────────────────

  /** Returns the number of currently stored schedules */
  getScheduleCount(): number {
    return this.schedules.size;
  }

  /** Returns a copy of all stored schedules */
  getSchedules(): CronSchedule[] {
    return Array.from(this.schedules.values());
  }
}
