/**
 * Goal & Feedback Projection Surfaces
 *
 * Provides queryable projected state for goals and feedback entries derived
 * from Session_Log events and the underlying service stores.
 *
 * Projections:
 * - GoalProjectionV1: current goal state with revision, dependencies, and trajectory summary
 * - FeedbackProjectionV1: feedback entries with injection status
 * - GoalTimelineNodeV1: Chat_Node representation for goal events in the canonical timeline
 *
 * These projections integrate with the existing ProjectionService and
 * ScopedQueryService infrastructure.
 *
 * Requirements: 20.4, 20.6–20.7, 29.1, 29.3–29.4, 42.1–42.3
 */

import type { SharedDatabase } from '../database/shared-database.js';
import type { GoalV1, GoalRevisionV1, ScheduleV1, FeedbackEntryV1 } from './schemas.js';
import type { GoalService } from './goal-service.js';
import type { FeedbackService } from './feedback-service.js';

// ─── Projection Types ───────────────────────────────────────────

/**
 * Projected goal state for UI consumption.
 * Includes trajectory-style summary fields (Requirement 42.1–42.3).
 */
export interface GoalProjectionV1 {
  goalId: string;
  sessionId: string;
  ownerId: string;
  title: string;
  description: string;
  state: 'active' | 'completed' | 'abandoned';
  revision: number;
  dependencies: string[];
  dependencyStates: Array<{ goalId: string; state: string; title: string }>;
  revisionCount: number;
  lastChangeType: string;
  hasSchedule: boolean;
  overdueReminders: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Projected feedback entry for UI consumption.
 */
export interface FeedbackProjectionV1 {
  feedbackId: string;
  sessionId: string;
  ownerId: string;
  kind: string;
  content: string;
  targetEventId: string | null;
  targetSequence: number | null;
  injected: boolean;
  injectionEventId: string | null;
  createdAt: string;
}

/**
 * Goal timeline node for the Canonical_Timeline.
 * Represents a goal.revised event projected as a compact inline summary
 * (Requirement 42.1–42.2).
 */
export interface GoalTimelineNodeV1 {
  nodeType: 'goal_summary';
  goalId: string;
  revision: number;
  title: string;
  state: 'active' | 'completed' | 'abandoned';
  changeType: string;
  progress: GoalProgressV1;
}

/**
 * Goal progress summary for trajectory views (Requirement 42.2).
 */
export interface GoalProgressV1 {
  totalDependencies: number;
  completedDependencies: number;
  hasOverdueSchedule: boolean;
}

/**
 * Combined session goals/feedback projection result.
 */
export interface SessionGoalFeedbackProjectionV1 {
  sessionId: string;
  goals: GoalProjectionV1[];
  feedback: FeedbackProjectionV1[];
  projectedAt: string;
}

// ─── GoalFeedbackProjectionService ─────────────────────────────

export class GoalFeedbackProjectionService {
  private readonly db: SharedDatabase;
  private readonly goalService: GoalService;
  private readonly feedbackService: FeedbackService;

  constructor(
    db: SharedDatabase,
    goalService: GoalService,
    feedbackService: FeedbackService
  ) {
    this.db = db;
    this.goalService = goalService;
    this.feedbackService = feedbackService;
  }

  /**
   * Project the full goal state for a session and owner.
   * Enriches raw goal data with dependency states, schedule status, and
   * overdue reminder counts.
   */
  projectGoals(sessionId: string, ownerId: string): GoalProjectionV1[] {
    const goals = this.goalService.queryGoals(sessionId, ownerId);
    return goals.map((goal) => this.enrichGoalProjection(goal));
  }

  /**
   * Project a single goal's full state.
   */
  projectGoal(goalId: string): GoalProjectionV1 | null {
    const goal = this.goalService.getGoalById(goalId);
    if (!goal) return null;
    return this.enrichGoalProjection(goal);
  }

  /**
   * Project feedback entries for a session and owner.
   */
  projectFeedback(sessionId: string, ownerId: string): FeedbackProjectionV1[] {
    const entries = this.feedbackService.queryFeedback(sessionId, ownerId);
    return entries.map((entry) => this.toFeedbackProjection(entry));
  }

  /**
   * Project the combined session goals and feedback state.
   * This is the primary projection surface for the session MCP server.
   */
  projectSession(sessionId: string, ownerId: string): SessionGoalFeedbackProjectionV1 {
    return {
      sessionId,
      goals: this.projectGoals(sessionId, ownerId),
      feedback: this.projectFeedback(sessionId, ownerId),
      projectedAt: new Date().toISOString(),
    };
  }

  /**
   * Build a goal timeline node for the Canonical_Timeline.
   * Used when projecting `goal.revised` events into Chat_Nodes.
   *
   * Requirements: 42.1–42.2
   */
  buildGoalTimelineNode(goalId: string, revision: number): GoalTimelineNodeV1 | null {
    const goal = this.goalService.getGoalById(goalId);
    if (!goal) return null;

    const revisions = this.goalService.getGoalRevisions(goalId);
    const targetRevision = revisions.find((r) => r.revision === revision);
    const changeType = targetRevision?.changeType ?? 'created';

    const progress = this.computeGoalProgress(goal);

    return {
      nodeType: 'goal_summary',
      goalId: goal.goalId,
      revision: goal.revision,
      title: goal.title,
      state: goal.state,
      changeType,
      progress,
    };
  }

  /**
   * Get all goal timeline nodes for a session.
   * Returns one compact summary per goal (Requirement 42.12 — no duplicates).
   */
  getGoalTimelineNodes(sessionId: string, ownerId: string): GoalTimelineNodeV1[] {
    const goals = this.goalService.queryGoals(sessionId, ownerId);
    return goals.map((goal) => {
      const progress = this.computeGoalProgress(goal);
      const revisions = this.goalService.getGoalRevisions(goal.goalId);
      const lastRevision = revisions[revisions.length - 1];

      return {
        nodeType: 'goal_summary' as const,
        goalId: goal.goalId,
        revision: goal.revision,
        title: goal.title,
        state: goal.state,
        changeType: lastRevision?.changeType ?? 'created',
        progress,
      };
    });
  }

  // ─── Internal Helpers ─────────────────────────────────────────

  private enrichGoalProjection(goal: GoalV1): GoalProjectionV1 {
    // Resolve dependency states
    const dependencyStates = goal.dependencies.map((depId) => {
      const dep = this.goalService.getGoalById(depId);
      return {
        goalId: depId,
        state: dep?.state ?? 'unknown',
        title: dep?.title ?? 'Unknown goal',
      };
    });

    // Count revisions
    const revisions = this.goalService.getGoalRevisions(goal.goalId);
    const lastRevision = revisions[revisions.length - 1];

    // Check for schedules and overdue reminders
    const scheduleInfo = this.getScheduleInfo(goal.goalId, goal.sessionId);

    return {
      goalId: goal.goalId,
      sessionId: goal.sessionId,
      ownerId: goal.ownerId,
      title: goal.title,
      description: goal.description,
      state: goal.state,
      revision: goal.revision,
      dependencies: goal.dependencies,
      dependencyStates,
      revisionCount: revisions.length,
      lastChangeType: lastRevision?.changeType ?? 'created',
      hasSchedule: scheduleInfo.hasSchedule,
      overdueReminders: scheduleInfo.overdueCount,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    };
  }

  private getScheduleInfo(goalId: string, sessionId: string): { hasSchedule: boolean; overdueCount: number } {
    const scheduleRow = this.db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM harness_schedules WHERE goalId = ? AND sessionId = ? AND state = 'active'`
    ).get(goalId, sessionId) as { cnt: number };

    const overdueRow = this.db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM harness_reminders
       WHERE goalId = ? AND sessionId = ? AND state IN ('pending', 'surfaced')`
    ).get(goalId, sessionId) as { cnt: number };

    return {
      hasSchedule: scheduleRow.cnt > 0,
      overdueCount: overdueRow.cnt,
    };
  }

  private computeGoalProgress(goal: GoalV1): GoalProgressV1 {
    const totalDependencies = goal.dependencies.length;
    let completedDependencies = 0;

    for (const depId of goal.dependencies) {
      const dep = this.goalService.getGoalById(depId);
      if (dep?.state === 'completed') {
        completedDependencies++;
      }
    }

    const scheduleInfo = this.getScheduleInfo(goal.goalId, goal.sessionId);

    return {
      totalDependencies,
      completedDependencies,
      hasOverdueSchedule: scheduleInfo.overdueCount > 0,
    };
  }

  private toFeedbackProjection(entry: FeedbackEntryV1): FeedbackProjectionV1 {
    return {
      feedbackId: entry.feedbackId,
      sessionId: entry.sessionId,
      ownerId: entry.ownerId,
      kind: entry.kind,
      content: entry.content,
      targetEventId: entry.targetEventId,
      targetSequence: entry.targetSequence,
      injected: entry.injected,
      injectionEventId: entry.injectionEventId,
      createdAt: entry.createdAt,
    };
  }
}
