/**
 * Cron Scheduler — Configurable cron-scheduled triggers
 *
 * Manages cron job registration, validation, and execution for cloud agent triggers.
 *
 * Task 22.1
 */

import type { CronTrigger } from './server';

interface ScheduledJob {
  trigger: CronTrigger;
  callback: () => void;
  intervalHandle?: ReturnType<typeof setInterval>;
}

/**
 * Lightweight cron scheduler that supports standard cron expressions.
 * Uses interval-based checking to avoid native cron dependencies in production.
 */
export class CronScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Check every 60 seconds for matching cron expressions
    this.checkInterval = setInterval(() => this.tick(), 60_000);
  }

  /** Validate a cron expression (5 or 6 fields) */
  static isValidExpression(expression: string): boolean {
    const parts = expression.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      return false;
    }

    // Basic validation: each field should contain valid cron characters
    const cronFieldPattern = /^[\d*,\-/]+$/;
    return parts.every(p => cronFieldPattern.test(p));
  }

  /** Register a cron trigger with its callback */
  register(trigger: CronTrigger, callback: () => void): void {
    this.jobs.set(trigger.id, { trigger, callback });
  }

  /** Unregister a cron trigger */
  unregister(triggerId: string): void {
    this.jobs.delete(triggerId);
  }

  /** Check if current time matches a cron expression */
  private matchesCron(expression: string, now: Date): boolean {
    const parts = expression.trim().split(/\s+/);
    const minute = now.getMinutes();
    const hour = now.getHours();
    const dayOfMonth = now.getDate();
    const month = now.getMonth() + 1;
    const dayOfWeek = now.getDay();

    return (
      this.matchField(parts[0], minute, 0, 59) &&
      this.matchField(parts[1], hour, 0, 23) &&
      this.matchField(parts[2], dayOfMonth, 1, 31) &&
      this.matchField(parts[3], month, 1, 12) &&
      this.matchField(parts[4], dayOfWeek, 0, 6)
    );
  }

  /** Match a single cron field against a value */
  private matchField(field: string, value: number, min: number, max: number): boolean {
    if (field === '*') return true;

    // Handle comma-separated values
    const parts = field.split(',');
    for (const part of parts) {
      // Handle range with step (e.g., 1-5/2)
      if (part.includes('/')) {
        const [range, stepStr] = part.split('/');
        const step = parseInt(stepStr, 10);
        let start = min;
        let end = max;

        if (range !== '*') {
          if (range.includes('-')) {
            [start, end] = range.split('-').map(Number);
          } else {
            start = parseInt(range, 10);
          }
        }

        for (let i = start; i <= end; i += step) {
          if (i === value) return true;
        }
      }
      // Handle range (e.g., 1-5)
      else if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (value >= start && value <= end) return true;
      }
      // Handle single value
      else {
        if (parseInt(part, 10) === value) return true;
      }
    }

    return false;
  }

  /** Tick — check all registered jobs against current time */
  private tick(): void {
    const now = new Date();
    for (const [, job] of this.jobs) {
      if (job.trigger.active && this.matchesCron(job.trigger.schedule, now)) {
        try {
          job.callback();
        } catch (err) {
          console.error(`[cron-scheduler] Error executing trigger ${job.trigger.id}:`, err);
        }
      }
    }
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /** Get all registered trigger IDs */
  getRegisteredTriggers(): string[] {
    return Array.from(this.jobs.keys());
  }
}
