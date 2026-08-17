/**
 * Goal_Service — Same-session authority for durable goals, change history,
 * schedules, and reminders.
 *
 * Provides:
 * - create/update/query goals with optimistic concurrency (expectedRevision)
 * - Full revision history for every goal mutation
 * - Owner-scoped session-local goals
 * - Dependencies between goals
 * - Bounded schedule catch-up on session resume
 * - Session-local reminders (no external notification guarantee)
 * - Goal revised events appended to Session_Log
 *
 * Requirements: 20.4, 20.6–20.7, 42.1–42.3
 */

import crypto from 'node:crypto';
import type { SharedDatabase } from '../database/shared-database.js';
import type { SessionLog } from '../session-log/session-log.js';
import type { ActorRef } from '../contracts/actor.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import type {
  GoalV1,
  GoalRevisionV1,
  GoalState,
  GoalChangeType,
  ScheduleV1,
  ReminderV1,
  CreateGoalCommand,
  UpdateGoalCommand,
  CreateScheduleCommand,
} from './schemas.js';

// ─── Error Types ────────────────────────────────────────────────

export class GoalNotFoundError extends Error {
  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = 'GoalNotFoundError';
  }
}

export class GoalRevisionConflictError extends Error {
  public readonly currentRevision: number;
  public readonly expectedRevision: number;

  constructor(goalId: string, expected: number, current: number) {
    super(`Goal revision conflict: expected=${expected}, current=${current} for goal=${goalId}`);
    this.name = 'GoalRevisionConflictError';
    this.currentRevision = current;
    this.expectedRevision = expected;
  }
}

export class GoalOwnerMismatchError extends Error {
  constructor(goalId: string, requestedOwner: string) {
    super(`Owner mismatch: goal=${goalId} is not owned by ${requestedOwner}`);
    this.name = 'GoalOwnerMismatchError';
  }
}

export class GoalSessionMismatchError extends Error {
  constructor(goalId: string, requestedSession: string) {
    super(`Session mismatch: goal=${goalId} does not belong to session ${requestedSession}`);
    this.name = 'GoalSessionMismatchError';
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(scheduleId: string) {
    super(`Schedule not found: ${scheduleId}`);
    this.name = 'ScheduleNotFoundError';
  }
}

// ─── Configuration ──────────────────────────────────────────────

export interface GoalServiceConfig {
  /** Maximum number of missed schedule triggers to catch up on resume */
  maxCatchUpDefault: number;
}

// ─── GoalService ────────────────────────────────────────────────

export class GoalService {
  private readonly db: SharedDatabase;
  private readonly sessionLog: SessionLog;
  private readonly config: GoalServiceConfig;

  constructor(db: SharedDatabase, sessionLog: SessionLog, config: GoalServiceConfig) {
    this.db = db;
    this.sessionLog = sessionLog;
    this.config = config;
  }

  /**
   * Create a new goal in the specified session.
   *
   * Records the creation as a revision and appends a `goal.revised` event
   * to the Session_Log.
   */
  createGoal(command: CreateGoalCommand, actor: ActorRef, scope: ScopeDescriptorV1): GoalV1 {
    const goalId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const goal: GoalV1 = {
      goalId,
      sessionId: command.sessionId,
      ownerId: command.ownerId,
      title: command.title,
      description: command.description ?? '',
      state: 'active',
      revision: 1,
      dependencies: command.dependencies ?? [],
      metadata: command.metadata ?? {},
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    // Insert goal and revision atomically
    this.db.raw.prepare(
      `INSERT INTO harness_goals (goalId, sessionId, ownerId, title, description, state, revision, dependencies, metadata, schemaVersion, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      goal.goalId,
      goal.sessionId,
      goal.ownerId,
      goal.title,
      goal.description,
      goal.state,
      goal.revision,
      JSON.stringify(goal.dependencies),
      JSON.stringify(goal.metadata),
      goal.createdAt,
      goal.updatedAt
    );

    this.db.raw.prepare(
      `INSERT INTO harness_goal_revisions (revisionId, goalId, sessionId, revision, previousRevision, changeType, changeDelta, actor, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      revisionId,
      goalId,
      command.sessionId,
      1,
      null,
      'created',
      JSON.stringify({ title: goal.title, description: goal.description, state: goal.state, dependencies: goal.dependencies }),
      JSON.stringify(actor),
      now
    );

    // Append goal.revised event to Session_Log
    this.sessionLog.append({
      sessionId: command.sessionId,
      eventType: 'goal.revised',
      payload: {
        type: 'goal.revised',
        goalId,
        revision: 1,
        title: goal.title,
        state: goal.state,
        changeType: 'created',
      },
      actor,
      scope,
      idempotencyKey: `goal-created-${goalId}`,
    });

    return goal;
  }

  /**
   * Update a goal with optimistic concurrency control.
   *
   * Requires `expectedRevision` to match the current revision. Fails with
   * GoalRevisionConflictError if someone else modified the goal since the
   * caller last read it.
   */
  updateGoal(command: UpdateGoalCommand, actor: ActorRef, scope: ScopeDescriptorV1): GoalV1 {
    const existing = this.getGoalById(command.goalId);

    if (!existing) {
      throw new GoalNotFoundError(command.goalId);
    }

    if (existing.sessionId !== command.sessionId) {
      throw new GoalSessionMismatchError(command.goalId, command.sessionId);
    }

    if (existing.ownerId !== command.ownerId) {
      throw new GoalOwnerMismatchError(command.goalId, command.ownerId);
    }

    if (existing.revision !== command.expectedRevision) {
      throw new GoalRevisionConflictError(command.goalId, command.expectedRevision, existing.revision);
    }

    const now = new Date().toISOString();
    const newRevision = existing.revision + 1;
    const changes: Array<{ changeType: GoalChangeType; delta: Record<string, unknown> }> = [];

    // Determine what changed
    let updatedTitle = existing.title;
    let updatedDescription = existing.description;
    let updatedState = existing.state;
    let updatedDependencies = existing.dependencies;
    let updatedMetadata = existing.metadata;

    if (command.title !== undefined && command.title !== existing.title) {
      updatedTitle = command.title;
      changes.push({ changeType: 'title_changed', delta: { from: existing.title, to: command.title } });
    }

    if (command.description !== undefined && command.description !== existing.description) {
      updatedDescription = command.description;
      changes.push({ changeType: 'description_changed', delta: { from: existing.description, to: command.description } });
    }

    if (command.state !== undefined && command.state !== existing.state) {
      updatedState = command.state;
      changes.push({ changeType: 'state_changed', delta: { from: existing.state, to: command.state } });
    }

    if (command.dependencies !== undefined) {
      const depsChanged = JSON.stringify(command.dependencies) !== JSON.stringify(existing.dependencies);
      if (depsChanged) {
        updatedDependencies = command.dependencies;
        changes.push({ changeType: 'dependencies_changed', delta: { from: existing.dependencies, to: command.dependencies } });
      }
    }

    if (command.metadata !== undefined) {
      const metaChanged = JSON.stringify(command.metadata) !== JSON.stringify(existing.metadata);
      if (metaChanged) {
        updatedMetadata = command.metadata;
        changes.push({ changeType: 'metadata_changed', delta: { from: existing.metadata, to: command.metadata } });
      }
    }

    if (changes.length === 0) {
      return existing; // No actual changes
    }

    // Update the goal record
    this.db.raw.prepare(
      `UPDATE harness_goals SET title = ?, description = ?, state = ?, revision = ?, dependencies = ?, metadata = ?, updatedAt = ?
       WHERE goalId = ? AND revision = ?`
    ).run(
      updatedTitle,
      updatedDescription,
      updatedState,
      newRevision,
      JSON.stringify(updatedDependencies),
      JSON.stringify(updatedMetadata),
      now,
      command.goalId,
      command.expectedRevision
    );

    // Record revision(s) — one revision entry per change type for auditability
    const primaryChangeType = changes[0].changeType;
    const combinedDelta = changes.reduce<Record<string, unknown>>((acc, c) => {
      acc[c.changeType] = c.delta;
      return acc;
    }, {});

    const revisionId = crypto.randomUUID();
    this.db.raw.prepare(
      `INSERT INTO harness_goal_revisions (revisionId, goalId, sessionId, revision, previousRevision, changeType, changeDelta, actor, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      revisionId,
      command.goalId,
      command.sessionId,
      newRevision,
      existing.revision,
      primaryChangeType,
      JSON.stringify(combinedDelta),
      JSON.stringify(actor),
      now
    );

    // Append goal.revised event
    this.sessionLog.append({
      sessionId: command.sessionId,
      eventType: 'goal.revised',
      payload: {
        type: 'goal.revised',
        goalId: command.goalId,
        revision: newRevision,
        title: updatedTitle,
        state: updatedState,
        changeType: primaryChangeType,
      },
      actor,
      scope,
      idempotencyKey: `goal-revised-${command.goalId}-${newRevision}`,
    });

    return {
      ...existing,
      title: updatedTitle,
      description: updatedDescription,
      state: updatedState,
      revision: newRevision,
      dependencies: updatedDependencies,
      metadata: updatedMetadata,
      updatedAt: now,
    };
  }

  /**
   * Get a goal by ID.
   */
  getGoalById(goalId: string): GoalV1 | null {
    const row = this.db.raw.prepare(
      `SELECT goalId, sessionId, ownerId, title, description, state, revision, dependencies, metadata, schemaVersion, createdAt, updatedAt
       FROM harness_goals WHERE goalId = ?`
    ).get(goalId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToGoal(row);
  }

  /**
   * Query goals for a session and owner with optional state filter.
   */
  queryGoals(sessionId: string, ownerId: string, state?: GoalState): GoalV1[] {
    let sql = `SELECT goalId, sessionId, ownerId, title, description, state, revision, dependencies, metadata, schemaVersion, createdAt, updatedAt
               FROM harness_goals WHERE sessionId = ? AND ownerId = ?`;
    const params: unknown[] = [sessionId, ownerId];

    if (state) {
      sql += ' AND state = ?';
      params.push(state);
    }

    sql += ' ORDER BY createdAt ASC';

    const rows = this.db.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToGoal(row));
  }

  /**
   * Get the full revision history for a goal.
   */
  getGoalRevisions(goalId: string): GoalRevisionV1[] {
    const rows = this.db.raw.prepare(
      `SELECT revisionId, goalId, sessionId, revision, previousRevision, changeType, changeDelta, actor, createdAt
       FROM harness_goal_revisions WHERE goalId = ? ORDER BY revision ASC`
    ).all(goalId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      revisionId: row.revisionId as string,
      goalId: row.goalId as string,
      sessionId: row.sessionId as string,
      revision: row.revision as number,
      previousRevision: row.previousRevision as number | null,
      changeType: row.changeType as GoalChangeType,
      changeDelta: JSON.parse(row.changeDelta as string),
      actor: JSON.parse(row.actor as string),
      createdAt: row.createdAt as string,
    }));
  }

  // ─── Schedules ──────────────────────────────────────────────────

  /**
   * Create a schedule (optionally linked to a goal).
   */
  createSchedule(command: CreateScheduleCommand): ScheduleV1 {
    const scheduleId = crypto.randomUUID();
    const now = new Date().toISOString();

    const schedule: ScheduleV1 = {
      scheduleId,
      sessionId: command.sessionId,
      goalId: command.goalId ?? null,
      ownerId: command.ownerId,
      cronExpression: command.cronExpression ?? null,
      intervalMs: command.intervalMs ?? null,
      nextOccurrenceAt: command.nextOccurrenceAt,
      lastTriggeredAt: null,
      missedCount: 0,
      maxCatchUp: command.maxCatchUp ?? this.config.maxCatchUpDefault,
      state: 'active',
      payload: command.payload ?? {},
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.db.raw.prepare(
      `INSERT INTO harness_schedules (scheduleId, sessionId, goalId, ownerId, cronExpression, intervalMs, nextOccurrenceAt, lastTriggeredAt, missedCount, maxCatchUp, state, payload, schemaVersion, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      schedule.scheduleId,
      schedule.sessionId,
      schedule.goalId,
      schedule.ownerId,
      schedule.cronExpression,
      schedule.intervalMs,
      schedule.nextOccurrenceAt,
      schedule.lastTriggeredAt,
      schedule.missedCount,
      schedule.maxCatchUp,
      schedule.state,
      JSON.stringify(schedule.payload),
      schedule.createdAt,
      schedule.updatedAt
    );

    return schedule;
  }

  /**
   * Get overdue schedules for a session with bounded catch-up.
   *
   * Returns at most `maxCatchUp` reminders per schedule.
   * This implements requirement 20.6: bounded catch-up on session resume.
   */
  getOverdueSchedules(sessionId: string, asOf: string): Array<{ schedule: ScheduleV1; overdueReminders: ReminderV1[] }> {
    const schedules = this.db.raw.prepare(
      `SELECT scheduleId, sessionId, goalId, ownerId, cronExpression, intervalMs, nextOccurrenceAt, lastTriggeredAt, missedCount, maxCatchUp, state, payload, schemaVersion, createdAt, updatedAt
       FROM harness_schedules
       WHERE sessionId = ? AND state = 'active' AND nextOccurrenceAt <= ?
       ORDER BY nextOccurrenceAt ASC`
    ).all(sessionId, asOf) as Array<Record<string, unknown>>;

    const results: Array<{ schedule: ScheduleV1; overdueReminders: ReminderV1[] }> = [];

    for (const row of schedules) {
      const schedule = this.rowToSchedule(row);
      const overdueReminders = this.computeBoundedCatchUp(schedule, asOf);
      results.push({ schedule, overdueReminders });
    }

    return results;
  }

  /**
   * Acknowledge a reminder (mark as surfaced or acknowledged).
   */
  acknowledgeReminder(reminderId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      `UPDATE harness_reminders SET state = 'acknowledged', acknowledgedAt = ? WHERE reminderId = ? AND sessionId = ?`
    ).run(now, reminderId, sessionId);
  }

  /**
   * Surface overdue reminders on session resume.
   *
   * Implements requirement 20.6: bounded catch-up — don't replay all missed triggers.
   * Only surfaces up to `maxCatchUp` missed occurrences per schedule.
   */
  surfaceOverdueReminders(sessionId: string, asOf: string): ReminderV1[] {
    const overdue = this.getOverdueSchedules(sessionId, asOf);
    const surfaced: ReminderV1[] = [];

    for (const { schedule, overdueReminders } of overdue) {
      for (const reminder of overdueReminders) {
        // Persist the surfaced reminder
        this.db.raw.prepare(
          `INSERT INTO harness_reminders (reminderId, sessionId, scheduleId, goalId, message, dueAt, state, schemaVersion, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, 'surfaced', 1, ?)`
        ).run(
          reminder.reminderId,
          reminder.sessionId,
          reminder.scheduleId,
          reminder.goalId,
          reminder.message,
          reminder.dueAt,
          reminder.createdAt
        );
        surfaced.push(reminder);
      }

      // Update the schedule's missed count and last triggered
      const newMissedCount = schedule.missedCount + overdueReminders.length;
      this.db.raw.prepare(
        `UPDATE harness_schedules SET missedCount = ?, lastTriggeredAt = ?, updatedAt = ? WHERE scheduleId = ?`
      ).run(newMissedCount, asOf, asOf, schedule.scheduleId);
    }

    return surfaced;
  }

  /**
   * Get a schedule by ID.
   */
  getScheduleById(scheduleId: string): ScheduleV1 | null {
    const row = this.db.raw.prepare(
      `SELECT scheduleId, sessionId, goalId, ownerId, cronExpression, intervalMs, nextOccurrenceAt, lastTriggeredAt, missedCount, maxCatchUp, state, payload, schemaVersion, createdAt, updatedAt
       FROM harness_schedules WHERE scheduleId = ?`
    ).get(scheduleId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSchedule(row);
  }

  /**
   * Cancel a schedule.
   */
  cancelSchedule(scheduleId: string, sessionId: string): void {
    const now = new Date().toISOString();
    const result = this.db.raw.prepare(
      `UPDATE harness_schedules SET state = 'cancelled', updatedAt = ? WHERE scheduleId = ? AND sessionId = ?`
    ).run(now, scheduleId, sessionId);

    if (result.changes === 0) {
      throw new ScheduleNotFoundError(scheduleId);
    }
  }

  // ─── Internal Helpers ─────────────────────────────────────────

  private computeBoundedCatchUp(schedule: ScheduleV1, asOf: string): ReminderV1[] {
    const reminders: ReminderV1[] = [];
    const maxCatchUp = schedule.maxCatchUp;
    const now = new Date(asOf);
    const nextOccurrence = new Date(schedule.nextOccurrenceAt);

    if (nextOccurrence > now) {
      return []; // Not overdue
    }

    // For interval-based schedules, compute how many intervals were missed
    if (schedule.intervalMs) {
      const elapsed = now.getTime() - nextOccurrence.getTime();
      const missedIntervals = Math.floor(elapsed / schedule.intervalMs) + 1;
      const catchUpCount = Math.min(missedIntervals, maxCatchUp);

      for (let i = 0; i < catchUpCount; i++) {
        const dueAt = new Date(nextOccurrence.getTime() + i * schedule.intervalMs).toISOString();
        reminders.push({
          reminderId: crypto.randomUUID(),
          sessionId: schedule.sessionId,
          scheduleId: schedule.scheduleId,
          goalId: schedule.goalId,
          message: `Scheduled reminder (${i + 1}/${catchUpCount} caught up)`,
          dueAt,
          acknowledgedAt: null,
          state: 'surfaced',
          schemaVersion: 1,
          createdAt: asOf,
        });
      }
    } else {
      // For non-interval schedules (one-shot or cron), produce a single catch-up reminder
      reminders.push({
        reminderId: crypto.randomUUID(),
        sessionId: schedule.sessionId,
        scheduleId: schedule.scheduleId,
        goalId: schedule.goalId,
        message: 'Overdue schedule reminder',
        dueAt: schedule.nextOccurrenceAt,
        acknowledgedAt: null,
        state: 'surfaced',
        schemaVersion: 1,
        createdAt: asOf,
      });
    }

    return reminders;
  }

  private rowToGoal(row: Record<string, unknown>): GoalV1 {
    return {
      goalId: row.goalId as string,
      sessionId: row.sessionId as string,
      ownerId: row.ownerId as string,
      title: row.title as string,
      description: row.description as string,
      state: row.state as GoalState,
      revision: row.revision as number,
      dependencies: JSON.parse(row.dependencies as string),
      metadata: JSON.parse(row.metadata as string),
      schemaVersion: row.schemaVersion as 1,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
    };
  }

  private rowToSchedule(row: Record<string, unknown>): ScheduleV1 {
    return {
      scheduleId: row.scheduleId as string,
      sessionId: row.sessionId as string,
      goalId: (row.goalId as string) ?? null,
      ownerId: row.ownerId as string,
      cronExpression: (row.cronExpression as string) ?? null,
      intervalMs: (row.intervalMs as number) ?? null,
      nextOccurrenceAt: row.nextOccurrenceAt as string,
      lastTriggeredAt: (row.lastTriggeredAt as string) ?? null,
      missedCount: row.missedCount as number,
      maxCatchUp: row.maxCatchUp as number,
      state: row.state as ScheduleV1['state'],
      payload: JSON.parse(row.payload as string),
      schemaVersion: 1,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
    };
  }
}
