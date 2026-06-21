/**
 * SchedulerService — Cron-style task scheduling with headless execution.
 *
 * Supports registering tasks with cron schedule expressions, evaluating
 * which schedules are due for execution, persisting schedule definitions
 * that survive restarts, and wiring task execution through HeadlessMode.
 * Implements retry policy (default: 2 retries, 5-minute backoff) and
 * user notification on task failure.
 *
 * Requires: headless_mode Feature_Gate as a prerequisite (Req 22.1).
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { HeadlessMode, type HeadlessConfig, type HeadlessResult } from './headless-mode.js';
import type { AgentLoopConfig } from '../pipeline/agent-loop.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** Retry policy for scheduled task execution */
export interface RetryPolicy {
  /** Maximum number of retry attempts (default: 2) */
  maxRetries: number;
  /** Backoff duration between retries in minutes (default: 5) */
  backoffMinutes: number;
}

/** A single scheduled task definition */
export interface ScheduleDefinition {
  id: string;
  name: string;
  /** Cron expression (minute hour dayOfMonth month dayOfWeek) */
  cron: string;
  /** Headless task configuration to execute when schedule fires */
  taskDefinition: object;
  /** Permission policy for headless execution */
  permissionPolicy: string;
  /** Retry policy on failure */
  retryPolicy: RetryPolicy;
  /** Whether this schedule is active */
  enabled: boolean;
}

/** Result of a scheduled task execution */
export interface ScheduledTaskResult {
  scheduleId: string;
  scheduleName: string;
  executedAt: string;
  success: boolean;
  output: unknown;
  costUsd?: number;
  durationMs: number;
  attempt: number;
  error?: string;
}

/**
 * Minimal interface for ExecutionTraceService dependency.
 * Kept loose to avoid tight coupling — only needs result storage.
 */
export interface TraceServiceLike {
  startTrace(sessionId: string, messageId: string): string;
  addEntry(traceId: string, entry: Record<string, unknown>): void;
  completeTrace(traceId: string): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default retry policy */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMinutes: 5,
};

// ─── SQL Schema ─────────────────────────────────────────────────

/**
 * SQL statement to create the scheduled_tasks table.
 * Should be executed conditionally when scheduled_tasks feature gate is enabled.
 *
 * Requirements: 22.3, 22.4
 */
export const SCHEDULED_TASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  task_definition TEXT NOT NULL,
  permission_policy TEXT NOT NULL DEFAULT 'deny-all',
  retry_max INTEGER NOT NULL DEFAULT 2,
  retry_backoff_minutes INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_last_run ON scheduled_tasks(last_run_at);
`.trim();

/**
 * Initialize the scheduled_tasks SQLite table if it doesn't exist.
 * Called conditionally when the scheduled_tasks feature gate is enabled.
 *
 * @param db - A database instance with an exec() method (e.g., better-sqlite3)
 */
export function initScheduledTasksTable(db: { exec: (sql: string) => void }): void {
  db.exec(SCHEDULED_TASKS_TABLE_SQL);
}

// ─── Cron Evaluation ────────────────────────────────────────────

/**
 * Parsed cron expression fields.
 * Each field is either a set of valid numbers or '*' (any value).
 */
interface ParsedCron {
  minutes: Set<number> | '*';
  hours: Set<number> | '*';
  daysOfMonth: Set<number> | '*';
  months: Set<number> | '*';
  daysOfWeek: Set<number> | '*';
}

/**
 * Parse a standard 5-field cron expression into structured sets.
 *
 * Supports:
 * - Exact values: "5"
 * - Lists: "1,3,5"
 * - Ranges: "1-5"
 * - Steps: "*​/15", "1-30/5"
 * - Wildcard: "*"
 *
 * Fields: minute(0-59) hour(0-23) dayOfMonth(1-31) month(1-12) dayOfWeek(0-6, 0=Sunday)
 */
export function parseCronExpression(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const daysOfMonth = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const daysOfWeek = parseField(parts[4], 0, 6);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
    return null;
  }

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Parse a single cron field into a set of valid values or '*'.
 */
function parseField(field: string, min: number, max: number): Set<number> | '*' | null {
  if (field === '*') {
    return '*';
  }

  const values = new Set<number>();

  // Split by comma for list support
  const segments = field.split(',');

  for (const segment of segments) {
    // Check for step: */N or range/N
    const stepMatch = segment.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) return null;

      let rangeStart = min;
      let rangeEnd = max;

      if (base !== '*') {
        const rangeMatch = base.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          rangeStart = parseInt(rangeMatch[1], 10);
          rangeEnd = parseInt(rangeMatch[2], 10);
        } else {
          rangeStart = parseInt(base, 10);
          rangeEnd = max;
        }
      }

      if (isNaN(rangeStart) || isNaN(rangeEnd)) return null;
      if (rangeStart < min || rangeEnd > max) return null;

      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.add(i);
      }
      continue;
    }

    // Check for range: N-M
    const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (isNaN(start) || isNaN(end)) return null;
      if (start < min || end > max || start > end) return null;

      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const val = parseInt(segment, 10);
    if (isNaN(val) || val < min || val > max) return null;
    values.add(val);
  }

  return values.size > 0 ? values : null;
}

/**
 * Check if a given Date matches a parsed cron expression.
 */
export function cronMatchesTime(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const dayOfWeek = date.getDay(); // 0=Sunday

  if (parsed.minutes !== '*' && !parsed.minutes.has(minute)) return false;
  if (parsed.hours !== '*' && !parsed.hours.has(hour)) return false;
  if (parsed.daysOfMonth !== '*' && !parsed.daysOfMonth.has(dayOfMonth)) return false;
  if (parsed.months !== '*' && !parsed.months.has(month)) return false;
  if (parsed.daysOfWeek !== '*' && !parsed.daysOfWeek.has(dayOfWeek)) return false;

  return true;
}

// ─── SchedulerService Class ─────────────────────────────────────

export class SchedulerService {
  private schedules: ScheduleDefinition[] = [];
  private loaded = false;

  constructor(
    private readonly configPath: string,
    private readonly traceService: TraceServiceLike | null,
    private readonly notifyUser: (message: string) => void,
  ) {}

  /**
   * Evaluate all enabled schedules against the current time.
   * Returns the subset of schedules that are due for execution.
   *
   * Requirement 22.1: Support cron-style schedule expressions
   * Requirement 22.2: Execute associated task in headless mode when trigger fires
   */
  evaluateDueSchedules(now: Date): ScheduleDefinition[] {
    this.ensureLoaded();

    const due: ScheduleDefinition[] = [];

    for (const schedule of this.schedules) {
      if (!schedule.enabled) continue;

      const parsed = parseCronExpression(schedule.cron);
      if (!parsed) {
        // Invalid cron expression — skip and warn
        this.notifyUser(
          `[SchedulerService] Invalid cron expression for schedule "${schedule.name}": ${schedule.cron}`,
        );
        continue;
      }

      if (cronMatchesTime(parsed, now)) {
        due.push(schedule);
      }
    }

    return due;
  }

  /**
   * Persist schedule definitions to a JSON configuration file.
   * This ensures schedule state survives application restarts.
   *
   * Requirement 22.3: Persist schedule definitions that survive restarts
   */
  persistSchedules(schedules: ScheduleDefinition[]): void {
    this.schedules = [...schedules];
    this.loaded = true;

    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(schedules, null, 2);
    fs.writeFileSync(this.configPath, json, 'utf-8');
  }

  /**
   * Load schedule definitions from the persisted configuration file.
   * Returns empty array if file doesn't exist or is invalid.
   */
  loadSchedules(): ScheduleDefinition[] {
    if (!fs.existsSync(this.configPath)) {
      this.schedules = [];
      this.loaded = true;
      return [];
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        this.schedules = [];
        this.loaded = true;
        return [];
      }

      this.schedules = parsed.map((item: unknown) => this.validateSchedule(item)).filter(
        (s): s is ScheduleDefinition => s !== null,
      );
      this.loaded = true;
      return this.schedules;
    } catch {
      this.schedules = [];
      this.loaded = true;
      return [];
    }
  }

  /**
   * Register a new schedule definition.
   * Automatically persists the updated schedule list.
   */
  registerSchedule(schedule: Omit<ScheduleDefinition, 'id'>): ScheduleDefinition {
    this.ensureLoaded();

    const newSchedule: ScheduleDefinition = {
      ...schedule,
      id: randomUUID(),
    };

    this.schedules.push(newSchedule);
    this.persistSchedules(this.schedules);

    return newSchedule;
  }

  /**
   * Remove a schedule by ID.
   * Returns true if the schedule was found and removed.
   */
  removeSchedule(id: string): boolean {
    this.ensureLoaded();

    const initialLength = this.schedules.length;
    this.schedules = this.schedules.filter((s) => s.id !== id);

    if (this.schedules.length < initialLength) {
      this.persistSchedules(this.schedules);
      return true;
    }

    return false;
  }

  /**
   * Get all registered schedules.
   */
  getSchedules(): ScheduleDefinition[] {
    this.ensureLoaded();
    return [...this.schedules];
  }

  /**
   * Execute a scheduled task through HeadlessMode with retry policy.
   *
   * Requirement 22.2: Execute in headless mode with configured permissions
   * Requirement 22.4: Store result in ExecutionTraceService
   * Requirement 22.5: Retry on failure with configurable retry policy
   */
  async executeScheduledTask(
    schedule: ScheduleDefinition,
    loopConfig: AgentLoopConfig,
    executor: (config: AgentLoopConfig, task: object) => Promise<{ success: boolean; output: unknown; costUsd?: number }>,
  ): Promise<ScheduledTaskResult> {
    const { retryPolicy } = schedule;
    const maxAttempts = retryPolicy.maxRetries + 1; // initial + retries
    let lastResult: ScheduledTaskResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Wait for backoff before retry (not on first attempt)
      if (attempt > 1) {
        const backoffMs = retryPolicy.backoffMinutes * 60 * 1000;
        await this.sleep(backoffMs);
      }

      const headlessConfig: HeadlessConfig = {
        taskDefinition: schedule.taskDefinition,
        permissionPolicy: schedule.permissionPolicy as HeadlessConfig['permissionPolicy'],
        outputFormat: 'json',
      };

      const startTime = Date.now();
      let headlessResult: HeadlessResult;

      try {
        headlessResult = await HeadlessMode.run(headlessConfig, loopConfig, executor);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);

        lastResult = {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          executedAt: new Date().toISOString(),
          success: false,
          output: null,
          durationMs,
          attempt,
          error: errorMessage,
        };
        continue;
      }

      const success = headlessResult.exitCode === 0;
      lastResult = {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        executedAt: new Date().toISOString(),
        success,
        output: headlessResult.output,
        costUsd: headlessResult.costUsd,
        durationMs: headlessResult.durationMs,
        attempt,
        error: success ? undefined : `Exit code: ${headlessResult.exitCode}`,
      };

      // Store result in trace service (Req 22.4)
      if (this.traceService) {
        try {
          const traceId = this.traceService.startTrace(
            `scheduled_${schedule.id}`,
            `sched_msg_${Date.now()}`,
          );
          this.traceService.addEntry(traceId, {
            timestamp: lastResult.executedAt,
            type: 'scheduled_task_result',
            toolName: `schedule:${schedule.name}`,
            result: {
              success: lastResult.success,
              attempt: lastResult.attempt,
              costUsd: lastResult.costUsd,
              durationMs: lastResult.durationMs,
              error: lastResult.error,
            },
          });
          await this.traceService.completeTrace(traceId);
        } catch {
          // Trace recording is best-effort — don't fail the task
        }
      }

      // If successful, stop retrying
      if (success) {
        return lastResult;
      }
    }

    // All attempts failed — notify user (Req 22.5)
    if (lastResult && !lastResult.success) {
      this.notifyUser(
        `[SchedulerService] Scheduled task "${schedule.name}" failed after ${maxAttempts} attempt(s). ` +
        `Last error: ${lastResult.error ?? 'Unknown error'}`,
      );
    }

    return lastResult!;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Ensure schedules are loaded from disk.
   */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loadSchedules();
    }
  }

  /**
   * Validate and normalize a raw schedule object.
   */
  private validateSchedule(raw: unknown): ScheduleDefinition | null {
    if (typeof raw !== 'object' || raw === null) return null;

    const obj = raw as Record<string, unknown>;

    if (typeof obj['id'] !== 'string' || !obj['id']) return null;
    if (typeof obj['name'] !== 'string' || !obj['name']) return null;
    if (typeof obj['cron'] !== 'string' || !obj['cron']) return null;
    if (typeof obj['taskDefinition'] !== 'object' || obj['taskDefinition'] === null) return null;

    const retryPolicy: RetryPolicy = {
      maxRetries: DEFAULT_RETRY_POLICY.maxRetries,
      backoffMinutes: DEFAULT_RETRY_POLICY.backoffMinutes,
    };

    if (typeof obj['retryPolicy'] === 'object' && obj['retryPolicy'] !== null) {
      const rp = obj['retryPolicy'] as Record<string, unknown>;
      if (typeof rp['maxRetries'] === 'number' && rp['maxRetries'] >= 0) {
        retryPolicy.maxRetries = rp['maxRetries'];
      }
      if (typeof rp['backoffMinutes'] === 'number' && rp['backoffMinutes'] > 0) {
        retryPolicy.backoffMinutes = rp['backoffMinutes'];
      }
    }

    return {
      id: obj['id'] as string,
      name: obj['name'] as string,
      cron: obj['cron'] as string,
      taskDefinition: obj['taskDefinition'] as object,
      permissionPolicy: typeof obj['permissionPolicy'] === 'string' ? obj['permissionPolicy'] : 'deny-all',
      retryPolicy,
      enabled: obj['enabled'] !== false, // default to enabled
    };
  }

  /**
   * Sleep helper for backoff between retry attempts.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
