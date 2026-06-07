/**
 * Task Tracker — Agent-accessible task management tool.
 *
 * Lets agents create, update, and track tasks within a conversation.
 * Tasks are visible in the UI and persist across sessions.
 *
 * 12-factor-agent-improvements task 12 wires `task.transition`
 * Pipeline_Events from every public mutation method on this class
 * (Requirement 2.5). The wiring follows the same fail-soft, optional-
 * dependency shape used by `ApprovalQueue` (task 13):
 *
 *   - `EventLog` is an OPTIONAL constructor dependency. Existing callers
 *     that pass only `db` keep working unchanged (Requirement 4.6 — no
 *     breaking changes). Pass an `EventLog` to opt into emission.
 *   - All emit calls are gated by
 *       `PERF_FLAGS.UNIFIED_EVENT_LOG || PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW`.
 *     Phase 0 has the shadow flag on so events flow into the log even
 *     though the reducer's output does not yet reach the prompt. Phase 1
 *     keeps emits on; Phase 2 removes the shadow flag and inlines the
 *     active branch.
 *   - All emits are wrapped in fail-soft try/catch — telemetry failure
 *     MUST NOT block the task-update flow.
 *   - Per design.md "Event kinds":
 *       task.transition → { taskId, from, to, by }
 *     Where `from` is the previous status (or `null` for fresh creates),
 *     `to` is the new status (e.g. `'todo' | 'in_progress' | 'done' |
 *     'blocked' | 'deleted'`), and `by` is the agent id (when known).
 *     The reducer's `applyTaskTransition` only looks at `taskId` and
 *     `to`, so the wider vocabulary on the wire is forward-compatible.
 *   - `deleteTask` emits `task.transition` with `to: 'deleted'` so
 *     downstream consumers (the reducer, the dashboard) can drop the
 *     task from any cached open/blocked bucket. The reducer's default
 *     case treats `'deleted'` as terminal — same effect as `'done'`.
 *
 * The mutation methods accept an optional `sessionId` argument so the
 * IPC handler can pin events to a session. When omitted, the emit is
 * skipped silently — a session-less event is unreachable for the
 * Unified_State_Reducer which keys off `sessionId`.
 *
 * Audit (per task 12 acceptance criteria — direct SQL writes to task
 * tables that bypass this class):
 *
 *   - `tracked_tasks` (THIS class's table): every write goes through
 *     `createTask` / `updateTask` / `deleteTask`. A repo-wide grep
 *     `grep -r "INTO tracked_tasks\\|UPDATE tracked_tasks\\|FROM
 *     tracked_tasks" src/ --include="*.ts"` returns matches in this
 *     file only (run during task 12 implementation). No migration
 *     required.
 *   - `agent_tasks` (used by `EnhancedAgentManager` in
 *     `src/agents/enhanced-agent-manager.ts`): separate manager class
 *     with its own lifecycle. Out of scope for `TaskTracker`. Already
 *     covered by the `Dual_Write_Reconciler` (task 28) in
 *     Requirement 6.8.
 *   - `subagent_tasks` (used by `GooseFeaturesService` in
 *     `src/agents/goose-features-service.ts`): same — separate manager,
 *     covered by the reconciler.
 *   - `scheduled_tasks` (used by `TaskScheduler` in
 *     `src/pipeline/task-scheduler.ts`): unrelated cron-style table,
 *     not a TaskTracker analogue. No reconciliation needed because the
 *     UI-visible tasks live in `tracked_tasks`.
 *
 * If a future PR introduces a code path that writes `tracked_tasks`
 * directly (instead of going through this class), code review SHALL
 * flag it and route the write through `TaskTracker` so the emitter
 * stays the single source of truth.
 *
 * Validates: Requirements 2.5
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import type { EventLog, EventKind } from './event-log.js';

export interface TrackedTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  agentId: string;
  parentId?: string; // For subtasks
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export class TaskTracker {
  private db: any;
  private readonly eventLog: EventLog | null;

  constructor(db: any, eventLog?: EventLog | null) {
    this.db = db;
    this.eventLog = eventLog ?? null;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tracked_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'todo',
          priority TEXT NOT NULL DEFAULT 'medium',
          agent_id TEXT NOT NULL DEFAULT 'user',
          parent_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        )
      `);
    } catch (e) { console.warn('[TaskTracker] Table creation failed:', e); }
  }

  createTask(projectId: string, title: string, description: string = '', priority: TrackedTask['priority'] = 'medium', agentId: string = 'user', parentId?: string, sessionId?: string): TrackedTask {
    const task: TrackedTask = {
      id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId, title, description, status: 'todo', priority, agentId, parentId,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    let inserted = false;
    try {
      this.db.prepare(
        'INSERT INTO tracked_tasks (id, project_id, title, description, status, priority, agent_id, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(task.id, task.projectId, task.title, task.description, task.status, task.priority, task.agentId, task.parentId || null, task.createdAt, task.updatedAt);
      inserted = true;
    } catch (e) { console.warn('[TaskTracker] Insert failed:', e); }

    // Pipeline_Event emission for `task.transition` (Requirement 2.5).
    // A fresh create transitions from `null` → `'todo'`. Skip if the
    // insert itself failed — emitting a transition for a row that
    // doesn't exist would corrupt reducer state.
    if (inserted) {
      this.emitTransition(sessionId, {
        taskId: task.id,
        from: null,
        to: task.status,
        by: agentId,
      });
    }
    return task;
  }

  updateTask(taskId: string, updates: Partial<Pick<TrackedTask, 'title' | 'description' | 'status' | 'priority'>>, sessionId?: string, by?: string): void {
    // Capture the previous status BEFORE the UPDATE so the emitted
    // transition has an accurate `from`. We only emit when the status
    // actually changed — a title/description/priority edit is not a
    // task.transition (Requirement 2.5 wires the *transition* event,
    // not a generic mutation event).
    let previousStatus: TrackedTask['status'] | null = null;
    if (updates.status !== undefined) {
      const existing = this.getTask(taskId);
      previousStatus = existing ? existing.status : null;
    }

    try {
      const sets: string[] = ['updated_at = ?'];
      const vals: any[] = [Date.now()];
      if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
      if (updates.description !== undefined) { sets.push('description = ?'); vals.push(updates.description); }
      if (updates.status !== undefined) {
        sets.push('status = ?'); vals.push(updates.status);
        if (updates.status === 'done') { sets.push('completed_at = ?'); vals.push(Date.now()); }
      }
      if (updates.priority !== undefined) { sets.push('priority = ?'); vals.push(updates.priority); }
      vals.push(taskId);
      this.db.prepare(`UPDATE tracked_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } catch {}

    if (updates.status !== undefined && updates.status !== previousStatus) {
      this.emitTransition(sessionId, {
        taskId,
        from: previousStatus,
        to: updates.status,
        by: by ?? null,
      });
    }
  }

  getTasks(projectId: string, status?: string): TrackedTask[] {
    try {
      let query = 'SELECT * FROM tracked_tasks WHERE project_id = ?';
      const params: any[] = [projectId];
      if (status) { query += ' AND status = ?'; params.push(status); }
      query += ' ORDER BY created_at DESC';
      const rows = this.db.prepare(query).all(...params) as any[];
      return rows.map(this.rowToTask);
    } catch { return []; }
  }

  getTask(taskId: string): TrackedTask | null {
    try {
      const row = this.db.prepare('SELECT * FROM tracked_tasks WHERE id = ?').get(taskId) as any;
      return row ? this.rowToTask(row) : null;
    } catch { return null; }
  }

  getSubtasks(parentId: string): TrackedTask[] {
    try {
      const rows = this.db.prepare('SELECT * FROM tracked_tasks WHERE parent_id = ? ORDER BY created_at ASC').all(parentId) as any[];
      return rows.map(this.rowToTask);
    } catch { return []; }
  }

  deleteTask(taskId: string, sessionId?: string, by?: string): void {
    // Capture the previous status BEFORE the DELETE so the emitted
    // transition has an accurate `from`. We also need to enumerate
    // subtasks because the SQL deletes them in the same statement;
    // each one becomes its own transition event so the reducer can
    // drop them from any cached open/blocked bucket.
    let parent: TrackedTask | null = null;
    let subtasks: TrackedTask[] = [];
    try {
      parent = this.getTask(taskId);
      subtasks = this.getSubtasks(taskId);
    } catch {}

    try { this.db.prepare('DELETE FROM tracked_tasks WHERE id = ? OR parent_id = ?').run(taskId, taskId); } catch {}

    if (parent) {
      this.emitTransition(sessionId, {
        taskId: parent.id,
        from: parent.status,
        to: 'deleted',
        by: by ?? null,
      });
    }
    for (const sub of subtasks) {
      this.emitTransition(sessionId, {
        taskId: sub.id,
        from: sub.status,
        to: 'deleted',
        by: by ?? null,
      });
    }
  }

  getStats(projectId: string): { total: number; todo: number; inProgress: number; done: number; blocked: number } {
    try {
      const rows = this.db.prepare(
        'SELECT status, COUNT(*) as count FROM tracked_tasks WHERE project_id = ? GROUP BY status'
      ).all(projectId) as any[];
      const stats = { total: 0, todo: 0, inProgress: 0, done: 0, blocked: 0 };
      for (const r of rows) {
        const count = r.count || 0;
        stats.total += count;
        if (r.status === 'todo') stats.todo = count;
        else if (r.status === 'in_progress') stats.inProgress = count;
        else if (r.status === 'done') stats.done = count;
        else if (r.status === 'blocked') stats.blocked = count;
      }
      return stats;
    } catch { return { total: 0, todo: 0, inProgress: 0, done: 0, blocked: 0 }; }
  }

  /**
   * Get a formatted summary for injection into agent prompts.
   */
  getContextString(projectId: string): string {
    const tasks = this.getTasks(projectId);
    if (tasks.length === 0) return '';
    let ctx = '## Current Tasks\n\n';
    for (const t of tasks.slice(0, 20)) {
      const icon = t.status === 'done' ? '✅' : t.status === 'in_progress' ? '⚡' : t.status === 'blocked' ? '🚫' : '📋';
      ctx += `${icon} [${t.status}] ${t.title}${t.description ? ' — ' + t.description.slice(0, 100) : ''}\n`;
    }
    return ctx;
  }

  private rowToTask(row: any): TrackedTask {
    return {
      id: row.id, projectId: row.project_id, title: row.title, description: row.description,
      status: row.status, priority: row.priority, agentId: row.agent_id, parentId: row.parent_id,
      createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    };
  }

  /**
   * Fail-soft Pipeline_Event emit. Skipped when:
   *   - no EventLog was supplied at construction (legacy callers), OR
   *   - the request has no `sessionId` (the reducer keys off sessionId
   *     and an unkeyed event would never resurface), OR
   *   - both the active and shadow flag are off (Phase 2 cleanup pre-
   *     condition; this branch becomes unreachable once the shadow flag
   *     is removed in task 39).
   *
   * Any thrown error from the EventLog is logged at warn level and
   * swallowed — a telemetry failure MUST NOT regress the user-visible
   * task-update flow.
   */
  private emitTransition(
    sessionId: string | undefined,
    payload: { taskId: string; from: string | null; to: string; by: string | null },
  ): void {
    if (!this.eventLog) return;
    if (!sessionId) return;
    if (!PERF_FLAGS.UNIFIED_EVENT_LOG && !PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW) return;

    try {
      // Fire-and-forget; the EventLog buffers internally and flushes on
      // its own 100ms timer. We deliberately do not await.
      const kind: EventKind = 'task.transition';
      void this.eventLog.emit({ sessionId, kind, payload });
    } catch (err) {
      // Defensive: `emit` itself returns `Promise.resolve()` after an
      // in-memory enqueue, so this branch only fires on truly exotic
      // errors. The task-update flow continues either way.
      console.warn('[task-tracker] event emit failed:', (err as Error)?.message);
    }
  }
}
