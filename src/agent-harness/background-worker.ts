/**
 * Background Worker — cron/watch task scheduler with single-instance guarantee.
 *
 * Manages background agent tasks that execute on cron schedules or file-watch triggers.
 * Enforces single-instance execution, respects Security Posture and Budget Manager limits,
 * records failures in Audit Chain, and retries with exponential backoff (max 3 retries).
 *
 * Persistence: background_tasks SQLite table (migration 063).
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BackgroundTask, CronTrigger, WatchTrigger } from './types';
import type { AuditChainInterface } from '../devops-engine/audit-chain';
import type { SecurityPosture } from './security-posture';
import type { ExtendedBudgetManager } from '../pipeline/budget-manager-extended';

// ─── Constants ──────────────────────────────────────────────────

/** Base delay for exponential backoff (in milliseconds). */
const BASE_BACKOFF_MS = 1000;

/** Default maximum number of retries for failed tasks. */
const DEFAULT_MAX_RETRIES = 3;

// ─── Interfaces ─────────────────────────────────────────────────

/** The handler function executed when a background task fires. */
export type TaskHandler = (task: BackgroundTask) => Promise<void>;

export interface BackgroundWorkerInterface {
  /** Register a new background task in 'idle' status, stored in background_tasks table. */
  register(
    task: Omit<BackgroundTask, 'id' | 'lastRun' | 'nextRun' | 'status' | 'retryCount'>
  ): BackgroundTask;

  /** Execute a task (checks single-instance guarantee, respects security posture + budget). */
  execute(taskId: string): Promise<void>;

  /** Get all registered tasks with their current status. */
  listTasks(): BackgroundTask[];

  /** Cancel a running or scheduled task (sets status to 'disabled'). */
  cancel(taskId: string): void;

  /** Check if a task is currently executing. */
  isRunning(taskId: string): boolean;

  /** Register a handler function for task execution. */
  setHandler(handler: TaskHandler): void;
}

// ─── Database Row Shape ─────────────────────────────────────────

interface BackgroundTaskRow {
  id: string;
  agent_id: string;
  name: string;
  trigger_json: string;
  status: string;
  last_run: number | null;
  next_run: number | null;
  retry_count: number;
  max_retries: number;
  created_at: number;
}

/** Convert a database row into a BackgroundTask object. */
function rowToTask(row: BackgroundTaskRow): BackgroundTask {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    trigger: JSON.parse(row.trigger_json) as CronTrigger | WatchTrigger,
    status: row.status as BackgroundTask['status'],
    lastRun: row.last_run,
    nextRun: row.next_run,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
  };
}

// ─── Cron Parsing Utilities ─────────────────────────────────────

/**
 * Validates a cron expression has the expected 5-field format.
 * Standard cron: minute hour day-of-month month day-of-week
 */
function isValidCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  // Basic field validation (each field should have valid cron characters)
  const cronFieldPattern = /^[\d*,/\-]+$/;
  return parts.every((part) => cronFieldPattern.test(part));
}

/**
 * Compute the next execution time from a cron expression relative to a reference time.
 * Simplified implementation — computes approximate next run.
 */
function computeNextCronRun(expression: string, from: number): number {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return from + 60000; // fallback: 1 minute

  const minutePart = parts[0];

  // Parse the minute field to get the interval
  if (minutePart && minutePart.startsWith('*/')) {
    const interval = parseInt(minutePart.slice(2), 10);
    if (!isNaN(interval) && interval > 0) {
      return from + interval * 60 * 1000;
    }
  }

  // For fixed minute values or complex expressions, default to 1-minute intervals
  // A production implementation would use a full cron parser library
  return from + 60 * 1000;
}

/**
 * Calculate the exponential backoff delay for a given retry count.
 * Delay = BASE_BACKOFF_MS * 2^retryCount
 */
function computeBackoffDelay(retryCount: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, retryCount);
}

// ─── BackgroundWorker Implementation ────────────────────────────

export interface BackgroundWorkerDeps {
  db: Database.Database;
  auditChain?: AuditChainInterface;
  securityPosture?: SecurityPosture;
  budgetManager?: ExtendedBudgetManager;
}

/**
 * Creates a BackgroundWorker instance backed by the provided SQLite database.
 * The `background_tasks` table must already exist (created by migration 063).
 */
export function createBackgroundWorker(deps: BackgroundWorkerDeps): BackgroundWorkerInterface {
  const { db, auditChain, securityPosture, budgetManager } = deps;

  // ─── In-memory tracking of running tasks (single-instance guarantee) ──
  const runningTasks = new Set<string>();

  // ─── Task handler reference ─────────────────────────────────
  let taskHandler: TaskHandler | null = null;

  // ─── Prepared Statements ────────────────────────────────────

  const insertStmt = db.prepare(`
    INSERT INTO background_tasks (id, agent_id, name, trigger_json, status, last_run, next_run, retry_count, max_retries, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getByIdStmt = db.prepare(`
    SELECT * FROM background_tasks WHERE id = ?
  `);

  const getAllStmt = db.prepare(`
    SELECT * FROM background_tasks ORDER BY created_at ASC
  `);

  const updateStatusStmt = db.prepare(`
    UPDATE background_tasks SET status = ?, last_run = ?, next_run = ?, retry_count = ? WHERE id = ?
  `);

  const cancelStmt = db.prepare(`
    UPDATE background_tasks SET status = 'disabled' WHERE id = ?
  `);

  // ─── Core Methods ───────────────────────────────────────────

  function register(
    task: Omit<BackgroundTask, 'id' | 'lastRun' | 'nextRun' | 'status' | 'retryCount'>
  ): BackgroundTask {
    // Validate trigger
    if (task.trigger.type === 'cron') {
      if (!isValidCronExpression(task.trigger.expression)) {
        throw new Error(`Invalid cron expression: ${task.trigger.expression}`);
      }
    } else if (task.trigger.type === 'watch') {
      if (!task.trigger.patterns || task.trigger.patterns.length === 0) {
        throw new Error('Watch trigger must have at least one pattern');
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;

    // Compute initial next run time for cron tasks
    let nextRun: number | null = null;
    if (task.trigger.type === 'cron') {
      nextRun = computeNextCronRun(task.trigger.expression, now);
    }

    const triggerJson = JSON.stringify(task.trigger);

    insertStmt.run(
      id,
      task.agentId,
      task.name,
      triggerJson,
      'idle',
      null, // lastRun
      nextRun,
      0, // retryCount
      maxRetries,
      now,
    );

    return {
      id,
      agentId: task.agentId,
      name: task.name,
      trigger: task.trigger,
      status: 'idle',
      lastRun: null,
      nextRun,
      retryCount: 0,
      maxRetries,
    };
  }

  async function execute(taskId: string): Promise<void> {
    // 1. Single-instance check: reject if already running
    if (runningTasks.has(taskId)) {
      throw new Error(`Task ${taskId} is already running (single-instance guarantee)`);
    }

    // 2. Load task from database
    const row = getByIdStmt.get(taskId) as BackgroundTaskRow | undefined;
    if (!row) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const task = rowToTask(row);

    // 3. Reject if task is disabled
    if (task.status === 'disabled') {
      throw new Error(`Task ${taskId} is disabled and cannot be executed`);
    }

    // 4. Check Security Posture (if available)
    if (securityPosture) {
      const needsApproval = securityPosture.requiresApproval(
        'background-task-execute',
        0.3, // background tasks have moderate risk
        task.agentId,
      );
      if (needsApproval) {
        throw new Error(`Task ${taskId} requires approval under current security posture`);
      }
    }

    // 5. Check Budget Manager (if available)
    if (budgetManager) {
      const canRun = budgetManager.canStartRun();
      if (!canRun) {
        throw new Error(`Task ${taskId} blocked by daily budget stop-loss`);
      }
    }

    // 6. Mark as running (single-instance tracking)
    runningTasks.add(taskId);
    const startTime = Date.now();

    // Update status in database
    updateStatusStmt.run('running', task.lastRun, task.nextRun, task.retryCount, taskId);

    try {
      // 7. Execute the task handler
      if (taskHandler) {
        await taskHandler(task);
      }

      // 8. Success: update status and compute next run
      const now = Date.now();
      let nextRun: number | null = null;
      if (task.trigger.type === 'cron') {
        nextRun = computeNextCronRun(task.trigger.expression, now);
      }

      updateStatusStmt.run('idle', now, nextRun, 0, taskId);

      // Record success in audit chain
      if (auditChain) {
        auditChain.append({
          timestamp: now,
          agentId: task.agentId,
          toolName: 'background-worker:execute',
          arguments: { taskId, taskName: task.name },
          resultSummary: 'Task completed successfully',
          duration: now - startTime,
          cost: 0,
        });
      }
    } catch (error) {
      // 9. Failure: record and possibly retry
      const now = Date.now();
      const newRetryCount = task.retryCount + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Record failure in audit chain
      if (auditChain) {
        auditChain.append({
          timestamp: now,
          agentId: task.agentId,
          toolName: 'background-worker:execute',
          arguments: { taskId, taskName: task.name },
          resultSummary: `Task failed: ${errorMessage}`,
          duration: now - startTime,
          cost: 0,
        });
      }

      if (newRetryCount >= task.maxRetries) {
        // Max retries exhausted — mark as failed
        updateStatusStmt.run('failed', now, null, newRetryCount, taskId);
      } else {
        // Schedule retry with exponential backoff
        const backoffDelay = computeBackoffDelay(newRetryCount);
        const retryAt = now + backoffDelay;
        updateStatusStmt.run('idle', now, retryAt, newRetryCount, taskId);
      }
    } finally {
      // 10. Release single-instance lock
      runningTasks.delete(taskId);
    }
  }

  function listTasks(): BackgroundTask[] {
    const rows = getAllStmt.all() as BackgroundTaskRow[];
    return rows.map((row) => {
      const task = rowToTask(row);
      // Augment with in-memory running state
      if (runningTasks.has(task.id)) {
        task.status = 'running';
      }
      return task;
    });
  }

  function cancel(taskId: string): void {
    const row = getByIdStmt.get(taskId) as BackgroundTaskRow | undefined;
    if (!row) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Mark as disabled in database
    cancelStmt.run(taskId);

    // If currently running, remove from tracking (the execute() will handle cleanup)
    // Note: This does not interrupt an in-flight execution — it prevents future scheduling
    runningTasks.delete(taskId);
  }

  function isRunning(taskId: string): boolean {
    return runningTasks.has(taskId);
  }

  function setHandler(handler: TaskHandler): void {
    taskHandler = handler;
  }

  return {
    register,
    execute,
    listTasks,
    cancel,
    isRunning,
    setHandler,
  };
}

// ─── Exported Utilities ─────────────────────────────────────────

export {
  isValidCronExpression,
  computeNextCronRun,
  computeBackoffDelay,
  DEFAULT_MAX_RETRIES,
  BASE_BACKOFF_MS,
};
