/**
 * Goal, Schedule, Reminder, and Feedback schemas (V1).
 *
 * Defines Zod schemas and TypeScript types for:
 * - GoalV1: owner-scoped same-session goals with state lifecycle
 * - GoalRevisionV1: immutable change history records
 * - ScheduleV1: bounded catch-up schedules
 * - ReminderV1: session-local reminders (no external notification guarantee)
 * - FeedbackEntryV1: locally stored feedback separated from model context
 * - FeedbackInjectionEventV1: explicit injection event payload
 *
 * Requirements: 20.4, 20.6–20.7, 29.1, 29.3–29.4, 42.1–42.3
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SequenceSchema } from '../contracts/primitives.js';
import { ActorRefSchema } from '../contracts/actor.js';

// ─── Goal State ─────────────────────────────────────────────────

export const GoalStateSchema = z.enum(['active', 'completed', 'abandoned']);
export type GoalState = z.infer<typeof GoalStateSchema>;

// ─── GoalV1 ─────────────────────────────────────────────────────

export const GoalV1Schema = z.object({
  goalId: IdentifierSchema,
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  state: GoalStateSchema.default('active'),
  revision: z.number().int().positive(),
  dependencies: z.array(IdentifierSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  schemaVersion: z.literal(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).passthrough();

export type GoalV1 = z.infer<typeof GoalV1Schema>;

// ─── Goal Change Types ──────────────────────────────────────────

export const GoalChangeTypeSchema = z.enum([
  'created',
  'title_changed',
  'description_changed',
  'state_changed',
  'dependencies_changed',
  'metadata_changed',
]);
export type GoalChangeType = z.infer<typeof GoalChangeTypeSchema>;

// ─── GoalRevisionV1 ─────────────────────────────────────────────

export const GoalRevisionV1Schema = z.object({
  revisionId: IdentifierSchema,
  goalId: IdentifierSchema,
  sessionId: IdentifierSchema,
  revision: z.number().int().positive(),
  previousRevision: z.number().int().nonnegative().nullable(),
  changeType: GoalChangeTypeSchema,
  changeDelta: z.record(z.string(), z.unknown()),
  actor: ActorRefSchema,
  createdAt: TimestampSchema,
}).passthrough();

export type GoalRevisionV1 = z.infer<typeof GoalRevisionV1Schema>;

// ─── Schedule State ─────────────────────────────────────────────

export const ScheduleStateSchema = z.enum(['active', 'paused', 'completed', 'cancelled']);
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

// ─── ScheduleV1 ─────────────────────────────────────────────────

export const ScheduleV1Schema = z.object({
  scheduleId: IdentifierSchema,
  sessionId: IdentifierSchema,
  goalId: IdentifierSchema.nullable().default(null),
  ownerId: IdentifierSchema,
  cronExpression: z.string().nullable().default(null),
  intervalMs: z.number().int().positive().nullable().default(null),
  nextOccurrenceAt: TimestampSchema,
  lastTriggeredAt: TimestampSchema.nullable().default(null),
  missedCount: z.number().int().nonnegative().default(0),
  maxCatchUp: z.number().int().positive().default(1),
  state: ScheduleStateSchema.default('active'),
  payload: z.record(z.string(), z.unknown()).default({}),
  schemaVersion: z.literal(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).passthrough();

export type ScheduleV1 = z.infer<typeof ScheduleV1Schema>;

// ─── Reminder State ─────────────────────────────────────────────

export const ReminderStateSchema = z.enum(['pending', 'surfaced', 'acknowledged', 'dismissed']);
export type ReminderState = z.infer<typeof ReminderStateSchema>;

// ─── ReminderV1 ─────────────────────────────────────────────────

export const ReminderV1Schema = z.object({
  reminderId: IdentifierSchema,
  sessionId: IdentifierSchema,
  scheduleId: IdentifierSchema,
  goalId: IdentifierSchema.nullable().default(null),
  message: z.string().min(1),
  dueAt: TimestampSchema,
  acknowledgedAt: TimestampSchema.nullable().default(null),
  state: ReminderStateSchema.default('pending'),
  schemaVersion: z.literal(1),
  createdAt: TimestampSchema,
}).passthrough();

export type ReminderV1 = z.infer<typeof ReminderV1Schema>;

// ─── Feedback Kind ──────────────────────────────────────────────

export const FeedbackKindSchema = z.enum([
  'general',
  'thumbs_up',
  'thumbs_down',
  'correction',
  'suggestion',
]);
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

// ─── FeedbackEntryV1 ────────────────────────────────────────────

export const FeedbackEntryV1Schema = z.object({
  feedbackId: IdentifierSchema,
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
  kind: FeedbackKindSchema.default('general'),
  content: z.string().default(''),
  targetEventId: IdentifierSchema.nullable().default(null),
  targetSequence: SequenceSchema.nullable().default(null),
  injected: z.boolean().default(false),
  injectionEventId: IdentifierSchema.nullable().default(null),
  revision: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  schemaVersion: z.literal(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).passthrough();

export type FeedbackEntryV1 = z.infer<typeof FeedbackEntryV1Schema>;

// ─── Feedback Injection Event Payload ───────────────────────────

/**
 * The payload for a `feedback.injected` session event.
 * This event is appended to the Session_Log when feedback is selected
 * for model context.
 *
 * Requirements: 29.4
 */
export const FeedbackInjectionPayloadV1Schema = z.object({
  type: z.literal('feedback.injected'),
  feedbackId: IdentifierSchema,
  feedbackRevision: z.number().int().positive(),
  kind: FeedbackKindSchema,
  content: z.string(),
  targetEventId: IdentifierSchema.nullable().default(null),
  targetSequence: SequenceSchema.nullable().default(null),
  injectedAt: TimestampSchema,
}).passthrough();

export type FeedbackInjectionPayloadV1 = z.infer<typeof FeedbackInjectionPayloadV1Schema>;

// ─── Goal Revised Event Payload ─────────────────────────────────

/**
 * The payload for a `goal.revised` session event.
 * Appended to Session_Log when a goal is created or updated.
 *
 * Requirements: 20.4, 42.1–42.3
 */
export const GoalRevisedPayloadV1Schema = z.object({
  type: z.literal('goal.revised'),
  goalId: IdentifierSchema,
  revision: z.number().int().positive(),
  title: z.string(),
  state: GoalStateSchema,
  changeType: GoalChangeTypeSchema,
}).passthrough();

export type GoalRevisedPayloadV1 = z.infer<typeof GoalRevisedPayloadV1Schema>;

// ─── Command Schemas ────────────────────────────────────────────

export const CreateGoalCommandSchema = z.object({
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  dependencies: z.array(IdentifierSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateGoalCommand = z.infer<typeof CreateGoalCommandSchema>;

export const UpdateGoalCommandSchema = z.object({
  goalId: IdentifierSchema,
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
  expectedRevision: z.number().int().positive(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  state: GoalStateSchema.optional(),
  dependencies: z.array(IdentifierSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateGoalCommand = z.infer<typeof UpdateGoalCommandSchema>;

export const CreateScheduleCommandSchema = z.object({
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
  goalId: IdentifierSchema.nullable().default(null),
  cronExpression: z.string().nullable().default(null),
  intervalMs: z.number().int().positive().nullable().default(null),
  nextOccurrenceAt: TimestampSchema,
  maxCatchUp: z.number().int().positive().default(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type CreateScheduleCommand = z.infer<typeof CreateScheduleCommandSchema>;

export const RecordFeedbackCommandSchema = z.object({
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
  kind: FeedbackKindSchema.default('general'),
  content: z.string().default(''),
  targetEventId: IdentifierSchema.nullable().default(null),
  targetSequence: SequenceSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RecordFeedbackCommand = z.infer<typeof RecordFeedbackCommandSchema>;

export const InjectFeedbackCommandSchema = z.object({
  feedbackId: IdentifierSchema,
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
});
export type InjectFeedbackCommand = z.infer<typeof InjectFeedbackCommandSchema>;
