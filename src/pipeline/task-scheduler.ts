/**
 * Task Scheduler — Cron-based recurring task automation.
 *
 * Schedule tasks in natural language: "Every day at 9 AM, check PRs."
 * Tasks run automatically while the app is active.
 * Missed tasks are marked and can be triggered manually.
 */

export interface ScheduledTask {
  id: string;
  projectId: string;
  name: string;
  description: string;
  schedule: string; // Cron expression or natural language
  cronExpr: string; // Parsed cron expression
  command: string;  // What to execute (prompt or shell command)
  type: 'prompt' | 'command';
  enabled: boolean;
  lastRun: number | null;
  lastStatus: 'done' | 'failed' | 'missed' | null;
  nextRun: number | null;
  createdAt: number;
}

/**
 * Parse natural language schedule into a simplified interval in minutes.
 */
function parseSchedule(text: string): { intervalMs: number; description: string } {
  const lower = text.toLowerCase();

  if (/every\s+(\d+)\s*min/i.test(lower)) {
    const mins = parseInt(lower.match(/every\s+(\d+)\s*min/i)![1]);
    return { intervalMs: mins * 60 * 1000, description: `Every ${mins} minutes` };
  }
  if (/every\s+(\d+)\s*hour/i.test(lower)) {
    const hrs = parseInt(lower.match(/every\s+(\d+)\s*hour/i)![1]);
    return { intervalMs: hrs * 60 * 60 * 1000, description: `Every ${hrs} hours` };
  }
  if (/every\s*day|daily/i.test(lower)) {
    return { intervalMs: 24 * 60 * 60 * 1000, description: 'Daily' };
  }
  if (/every\s*week|weekly/i.test(lower)) {
    return { intervalMs: 7 * 24 * 60 * 60 * 1000, description: 'Weekly' };
  }
  if (/every\s*hour|hourly/i.test(lower)) {
    return { intervalMs: 60 * 60 * 1000, description: 'Hourly' };
  }
  // Default: every 4 hours
  return { intervalMs: 4 * 60 * 60 * 1000, description: 'Every 4 hours' };
}

export class TaskScheduler {
  private db: any;
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private onExecute: ((task: ScheduledTask) => Promise<void>) | null = null;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          schedule TEXT NOT NULL,
          cron_expr TEXT NOT NULL DEFAULT '',
          command TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'prompt',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run INTEGER,
          last_status TEXT,
          next_run INTEGER,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (e) { console.warn('[TaskScheduler] Table creation failed:', e); }
  }

  /**
   * Set the execution callback.
   */
  setExecutor(fn: (task: ScheduledTask) => Promise<void>): void {
    this.onExecute = fn;
  }

  /**
   * Create a scheduled task.
   */
  createTask(projectId: string, name: string, schedule: string, command: string, type: 'prompt' | 'command' = 'prompt'): ScheduledTask {
    const parsed = parseSchedule(schedule);
    const task: ScheduledTask = {
      id: `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId, name, description: parsed.description, schedule,
      cronExpr: parsed.description, command, type, enabled: true,
      lastRun: null, lastStatus: null, nextRun: Date.now() + parsed.intervalMs,
      createdAt: Date.now(),
    };

    try {
      this.db.prepare(
        'INSERT INTO scheduled_tasks (id, project_id, name, description, schedule, cron_expr, command, type, enabled, last_run, last_status, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(task.id, task.projectId, task.name, task.description, task.schedule, task.cronExpr, task.command, task.type, 1, null, null, task.nextRun, task.createdAt);
    } catch (e) { console.warn('[TaskScheduler] Insert failed:', e); }

    this.startTimer(task);
    return task;
  }

  /**
   * Get all scheduled tasks for a project.
   */
  getTasks(projectId: string): ScheduledTask[] {
    try {
      const rows = this.db.prepare('SELECT * FROM scheduled_tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[];
      return rows.map(this.rowToTask);
    } catch { return []; }
  }

  /**
   * Get all scheduled tasks across all projects.
   */
  getAllTasks(): ScheduledTask[] {
    try {
      const rows = this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY next_run ASC').all() as any[];
      return rows.map(this.rowToTask);
    } catch { return []; }
  }

  /**
   * Run a task immediately.
   */
  async runNow(taskId: string): Promise<{ success: boolean; error?: string }> {
    const task = this.getTask(taskId);
    if (!task) return { success: false, error: 'Task not found' };

    try {
      if (this.onExecute) {
        await this.onExecute(task);
      }
      this.updateStatus(taskId, 'done');
      return { success: true };
    } catch (e: any) {
      this.updateStatus(taskId, 'failed');
      return { success: false, error: e.message };
    }
  }

  /**
   * Delete a scheduled task.
   */
  deleteTask(taskId: string): void {
    this.stopTimer(taskId);
    try { this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId); } catch {}
  }

  /**
   * Enable/disable a task.
   */
  setEnabled(taskId: string, enabled: boolean): void {
    try {
      this.db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, taskId);
      if (enabled) {
        const task = this.getTask(taskId);
        if (task) this.startTimer(task);
      } else {
        this.stopTimer(taskId);
      }
    } catch {}
  }

  /**
   * Start all enabled timers (call on app startup).
   */
  startAll(): void {
    const tasks = this.getAllTasks();
    for (const task of tasks) {
      if (task.enabled) {
        // Check for missed tasks
        if (task.nextRun && task.nextRun < Date.now()) {
          this.updateStatus(task.id, 'missed');
        }
        this.startTimer(task);
      }
    }
  }

  /**
   * Stop all timers (call on app shutdown).
   */
  stopAll(): void {
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  // ─── Private ────────────────────────────────────────────

  private getTask(taskId: string): ScheduledTask | null {
    try {
      const row = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(taskId) as any;
      return row ? this.rowToTask(row) : null;
    } catch { return null; }
  }

  private startTimer(task: ScheduledTask): void {
    this.stopTimer(task.id);
    const parsed = parseSchedule(task.schedule);

    const timer = setInterval(async () => {
      if (this.onExecute) {
        try {
          await this.onExecute(task);
          this.updateStatus(task.id, 'done');
        } catch {
          this.updateStatus(task.id, 'failed');
        }
      }
    }, parsed.intervalMs);

    this.timers.set(task.id, timer);
  }

  private stopTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) { clearInterval(timer); this.timers.delete(taskId); }
  }

  private updateStatus(taskId: string, status: 'done' | 'failed' | 'missed'): void {
    try {
      const parsed = parseSchedule(this.getTask(taskId)?.schedule || 'every 4 hours');
      this.db.prepare('UPDATE scheduled_tasks SET last_run = ?, last_status = ?, next_run = ? WHERE id = ?')
        .run(Date.now(), status, Date.now() + parsed.intervalMs, taskId);
    } catch {}
  }

  private rowToTask(row: any): ScheduledTask {
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description,
      schedule: row.schedule, cronExpr: row.cron_expr, command: row.command, type: row.type,
      enabled: !!row.enabled, lastRun: row.last_run, lastStatus: row.last_status,
      nextRun: row.next_run, createdAt: row.created_at,
    };
  }
}
