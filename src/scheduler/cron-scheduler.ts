/**
 * Cron Scheduler — Scheduled Automations
 *
 * Lightweight scheduler that runs agent tasks at configured intervals.
 * Jobs are stored in SQLite and survive app restarts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { EventLogCompactor } from '../pipeline/event-log-compactor';
import type { SessionTelemetryService } from '../session/session-telemetry';

export interface ScheduledJob {
  id: string;
  projectId: string;
  name: string;
  schedule: string; // 'hourly' | 'daily' | 'weekly' | cron expression
  task: string;     // The prompt to send to the AI
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface JobResult {
  jobId: string;
  output: string;
  success: boolean;
  runAt: string;
}

type JobCallback = (job: ScheduledJob) => Promise<void>;

/**
 * Parse a schedule string into milliseconds interval.
 */
function parseScheduleMs(schedule: string): number {
  switch (schedule.toLowerCase()) {
    case 'every-5-min': return 5 * 60 * 1000;
    case 'every-15-min': return 15 * 60 * 1000;
    case 'every-30-min': return 30 * 60 * 1000;
    case 'hourly': return 60 * 60 * 1000;
    case 'every-4-hours': return 4 * 60 * 60 * 1000;
    case 'daily': return 24 * 60 * 60 * 1000;
    case 'weekly': return 7 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000; // Default to daily
  }
}

/**
 * Compute the milliseconds from `now` until the next occurrence of `hour:minute`
 * in local time. If the target time has already passed today, the result points
 * at the same time tomorrow.
 */
export function msUntilNextDailyAt(hour: number, minute: number, now: Date = new Date()): number {
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/** Retention window for `metric_samples` rows (30 days, in ms). */
export const METRIC_SAMPLES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete `metric_samples` rows older than 30 days.
 *
 * Returns the number of rows deleted. Safe to call when the table does not
 * exist yet (returns 0). Used by the daily 03:00 prune job registered in
 * `CronScheduler.startAll()`.
 *
 * Spec: 12-factor-agent-improvements task 3, Requirements 5.1 & 5.2.
 */
export function pruneMetricSamples(db: Database.Database, now: number = Date.now()): number {
  const cutoff = now - METRIC_SAMPLES_RETENTION_MS;
  try {
    const result = db.prepare('DELETE FROM metric_samples WHERE recorded_at < ?').run(cutoff);
    return result.changes;
  } catch (err: any) {
    // Table may not exist on databases that have not yet run migration 030.
    // Treat as a no-op rather than crashing the scheduler.
    if (typeof err?.message === 'string' && err.message.includes('no such table')) {
      return 0;
    }
    throw err;
  }
}

export class CronScheduler {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private internalTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private callback: JobCallback | null = null;
  private readonly metrics: SessionTelemetryService | undefined;

  constructor(private db: Database.Database, metrics?: SessionTelemetryService) {
    this.metrics = metrics;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        task TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Set the callback that executes when a job triggers.
   */
  onJobTrigger(callback: JobCallback): void {
    this.callback = callback;
  }

  /**
   * Add a new scheduled job.
   */
  addJob(projectId: string, name: string, schedule: string, task: string): ScheduledJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    const intervalMs = parseScheduleMs(schedule);
    const nextRun = new Date(Date.now() + intervalMs).toISOString();

    this.db.prepare(
      'INSERT INTO scheduled_jobs (id, project_id, name, schedule, task, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, projectId, name, schedule, task, nextRun, now);

    const job = this.getJob(id)!;
    this.startTimer(job);
    return job;
  }

  /**
   * Remove a scheduled job.
   */
  removeJob(id: string): boolean {
    this.stopTimer(id);
    return this.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Pause a job (disable without deleting).
   */
  pauseJob(id: string): boolean {
    this.stopTimer(id);
    return this.db.prepare('UPDATE scheduled_jobs SET enabled = 0 WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Resume a paused job.
   */
  resumeJob(id: string): boolean {
    const result = this.db.prepare('UPDATE scheduled_jobs SET enabled = 1 WHERE id = ?').run(id);
    if (result.changes > 0) {
      const job = this.getJob(id);
      if (job) this.startTimer(job);
      return true;
    }
    return false;
  }

  /**
   * List all jobs, optionally filtered by project.
   */
  listJobs(projectId?: string): ScheduledJob[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM scheduled_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC').all();
    return (rows as any[]).map(this.rowToJob);
  }

  /**
   * Get a single job by ID.
   */
  getJob(id: string): ScheduledJob | null {
    const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as any;
    return row ? this.rowToJob(row) : null;
  }

  /**
   * Start all enabled job timers. Call on app startup.
   */
  startAll(): void {
    const jobs = this.db.prepare('SELECT * FROM scheduled_jobs WHERE enabled = 1').all() as any[];
    for (const row of jobs) {
      this.startTimer(this.rowToJob(row));
    }
    console.log(`[Scheduler] Started ${jobs.length} scheduled jobs`);

    // Internal daily housekeeping: prune metric_samples > 30 days old at 03:00 local.
    // Spec: 12-factor-agent-improvements task 3, Requirements 5.1 & 5.2.
    this.scheduleDailyAt('metric_samples_prune', 3, 0, () => {
      try {
        const deleted = pruneMetricSamples(this.db);
        if (deleted > 0) {
          console.log(`[Scheduler] Pruned ${deleted} metric_samples row(s) older than 30 days`);
        }
      } catch (err: any) {
        console.error('[Scheduler] metric_samples prune failed:', err?.message ?? err);
      }
    });

    // Internal daily housekeeping: collapse old contiguous tool.start /
    // tool.success runs into tool.batch events at 03:30 local — runs
    // after the metric_samples prune so the two jobs don't fight for
    // the SQLite write lock at the same instant.
    // Spec: 12-factor-agent-improvements task 31, Requirement 1.5.
    this.scheduleDailyAt('event_log_compaction', 3, 30, async () => {
      try {
        const compactor = new EventLogCompactor(this.db, this.metrics);
        const result = await compactor.runCompaction();
        if (result.eventsCollapsed > 0) {
          console.log(
            `[Scheduler] Compacted ${result.eventsCollapsed} pipeline_events row(s) ` +
            `across ${result.sessionsProcessed} session(s)`,
          );
        }
      } catch (err: any) {
        console.error('[Scheduler] event_log compaction failed:', err?.message ?? err);
      }
    });
  }

  /**
   * Stop all timers. Call on app shutdown.
   */
  stopAll(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    for (const [, timer] of this.internalTimers) {
      clearTimeout(timer);
    }
    this.internalTimers.clear();
  }

  /**
   * Schedule an internal (non-user) task to run daily at the given local time.
   * Re-arms a fresh timeout after each run so clock drift cannot accumulate.
   *
   * Used for housekeeping like the `metric_samples` 30-day prune. Internal
   * tasks are NOT persisted in `scheduled_jobs` and are NOT visible through
   * the public `listJobs` / `addJob` API.
   */
  private scheduleDailyAt(name: string, hour: number, minute: number, fn: () => void | Promise<void>): void {
    if (this.internalTimers.has(name)) return;
    const arm = (): void => {
      const delay = msUntilNextDailyAt(hour, minute);
      const timer = setTimeout(async () => {
        try {
          await fn();
        } catch (err: any) {
          console.error(`[Scheduler] Internal task "${name}" failed:`, err?.message ?? err);
        } finally {
          // Re-arm for the next day. Guard against `stopAll` having cleared the map.
          if (this.internalTimers.has(name)) {
            this.internalTimers.delete(name);
            arm();
          }
        }
      }, delay);
      this.internalTimers.set(name, timer);
    };
    arm();
  }

  private startTimer(job: ScheduledJob): void {
    if (this.timers.has(job.id)) return; // Already running

    const intervalMs = parseScheduleMs(job.schedule);
    const timer = setInterval(async () => {
      if (!this.callback) return;
      try {
        // Update last_run_at
        const now = new Date().toISOString();
        this.db.prepare('UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?')
          .run(now, new Date(Date.now() + intervalMs).toISOString(), job.id);

        await this.callback(job);
      } catch (err: any) {
        console.error(`[Scheduler] Job "${job.name}" failed:`, err.message);
      }
    }, intervalMs);

    this.timers.set(job.id, timer);
  }

  private stopTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  private rowToJob(row: any): ScheduledJob {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      schedule: row.schedule,
      task: row.task,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at || null,
      nextRunAt: row.next_run_at || null,
      createdAt: row.created_at,
    };
  }
}
