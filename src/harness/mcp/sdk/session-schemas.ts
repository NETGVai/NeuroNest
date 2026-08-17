/**
 * Session Namespace JSON-RPC Schemas
 *
 * Versioned request/response schemas for `neuronest.session.v1.*` methods.
 * These schemas define the wire format for the session MCP server.
 * Protocol-specific types (JSON-RPC envelopes) are NOT exposed here—
 * only the method params and results using canonical domain types.
 *
 * Requirements: 30.3, 30.9, 32.2
 */

import { z } from 'zod';
import { IdentifierSchema, SequenceSchema } from '../../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../../contracts/scope';
import { ActorRefSchema } from '../../contracts/actor';

// ─── Namespace ──────────────────────────────────────────────────

export const SESSION_NAMESPACE = 'neuronest.session.v1' as const;

// ─── events.append ──────────────────────────────────────────────

export const SessionEventsAppendParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  eventType: IdentifierSchema,
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().optional(),
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
});

export const SessionEventsAppendResultSchema = z.object({
  eventId: IdentifierSchema,
  sequence: SequenceSchema,
  integrityHash: z.string().min(1),
});

// ─── events.read ────────────────────────────────────────────────

export const SessionEventsReadParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  fromSequence: SequenceSchema.optional(),
  toSequence: SequenceSchema.optional(),
  limit: z.number().int().positive().optional(),
});

export const SessionEventsReadResultSchema = z.object({
  events: z.array(z.record(z.string(), z.unknown())),
  hasMore: z.boolean(),
});

// ─── events.verify ──────────────────────────────────────────────

export const SessionEventsVerifyParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  fromSequence: SequenceSchema.optional(),
  toSequence: SequenceSchema.optional(),
});

export const SessionEventsVerifyResultSchema = z.object({
  valid: z.boolean(),
  verifiedThrough: SequenceSchema,
  firstInvalidSequence: SequenceSchema.optional(),
  reason: z.string().optional(),
});

// ─── sessions.fork ──────────────────────────────────────────────

export const SessionsForkParamsSchema = z.object({
  parentSessionId: IdentifierSchema,
  parentBranchId: IdentifierSchema,
  forkSequence: SequenceSchema,
  newBranchId: IdentifierSchema.optional(),
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
});

export const SessionsForkResultSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  forkSequence: SequenceSchema,
  lineageRecorded: z.boolean(),
});

// ─── sessions.resume ────────────────────────────────────────────

export const SessionsResumeParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  fromCheckpoint: z.string().optional(),
  actor: ActorRefSchema,
});

export const SessionsResumeResultSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  resumedFromSequence: SequenceSchema,
  checkpointUsed: z.boolean(),
});

// ─── projections.timeline ───────────────────────────────────────

export const SessionProjectionsTimelineParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  afterSequence: SequenceSchema.optional(),
  limit: z.number().int().positive().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
});

export const SessionProjectionsTimelineResultSchema = z.object({
  projectionRevision: z.number().int().positive(),
  sourceSequence: SequenceSchema,
  stale: z.boolean(),
  nodes: z.array(z.record(z.string(), z.unknown())),
  hasMore: z.boolean(),
  confirmedCommandIds: z.array(IdentifierSchema),
});

// ─── projections.header ─────────────────────────────────────────

export const SessionProjectionsHeaderParamsSchema = z.object({
  sessionId: IdentifierSchema,
});

export const SessionProjectionsHeaderResultSchema = z.object({
  projectionRevision: z.number().int().positive(),
  sourceSequence: SequenceSchema,
  stale: z.boolean(),
  header: z.record(z.string(), z.unknown()),
  confirmedCommandIds: z.array(IdentifierSchema),
});

// ─── projections.insights ───────────────────────────────────────

export const SessionProjectionsInsightsParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema.optional(),
  metricKinds: z.array(z.string()).optional(),
});

export const SessionProjectionsInsightsResultSchema = z.object({
  projectionRevision: z.number().int().positive(),
  sourceSequence: SequenceSchema,
  stale: z.boolean(),
  insights: z.record(z.string(), z.unknown()),
  confirmedCommandIds: z.array(IdentifierSchema),
});

// ─── query.search ───────────────────────────────────────────────

export const SessionQuerySearchParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema.optional(),
  query: z.string().min(1),
  scope: ScopeDescriptorV1Schema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const SessionQuerySearchResultSchema = z.object({
  results: z.array(z.object({
    eventId: IdentifierSchema,
    sequence: SequenceSchema,
    snippet: z.string(),
    score: z.number(),
  }).passthrough()),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

// ─── query.export ───────────────────────────────────────────────

export const SessionQueryExportParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  fromSequence: SequenceSchema.optional(),
  toSequence: SequenceSchema.optional(),
  format: z.enum(['json_lines']).optional(),
});

export const SessionQueryExportResultSchema = z.object({
  exportId: IdentifierSchema,
  lineCount: z.number().int().nonnegative(),
  manifestHash: z.string().min(1),
  omissions: z.array(z.string()).optional(),
});

// ─── compaction.plan ────────────────────────────────────────────

export const SessionCompactionPlanParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  targetTokens: z.number().int().positive().optional(),
});

export const SessionCompactionPlanResultSchema = z.object({
  planId: IdentifierSchema,
  sourceRange: z.object({
    fromSequence: SequenceSchema,
    toSequence: SequenceSchema,
  }),
  strategy: z.string(),
  estimatedReduction: z.number().nonnegative(),
});

// ─── compaction.commit ──────────────────────────────────────────

export const SessionCompactionCommitParamsSchema = z.object({
  planId: IdentifierSchema,
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  actor: ActorRefSchema,
});

export const SessionCompactionCommitResultSchema = z.object({
  committed: z.boolean(),
  newSequence: SequenceSchema.optional(),
  compactionEventId: IdentifierSchema.optional(),
});

// ─── spill.readRange ────────────────────────────────────────────

export const SessionSpillReadRangeParamsSchema = z.object({
  locator: z.string().min(1),
  byteOffset: z.number().int().nonnegative().optional(),
  byteLength: z.number().int().positive().optional(),
  scope: ScopeDescriptorV1Schema,
});

export const SessionSpillReadRangeResultSchema = z.object({
  data: z.string(),
  mediaType: z.string(),
  totalBytes: z.number().int().nonnegative(),
  returnedBytes: z.number().int().nonnegative(),
});

// ─── attachments.prepare ────────────────────────────────────────

export const SessionAttachmentsPrepareParamsSchema = z.object({
  sessionId: IdentifierSchema,
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  byteSize: z.number().int().positive(),
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
});

export const SessionAttachmentsPrepareResultSchema = z.object({
  attachmentId: IdentifierSchema,
  uploadRef: z.string().min(1),
  stage: z.literal('validating'),
});

// ─── attachments.commit ─────────────────────────────────────────

export const SessionAttachmentsCommitParamsSchema = z.object({
  attachmentId: IdentifierSchema,
  sessionId: IdentifierSchema,
  contentDigest: z.string().min(1),
  idempotencyKey: z.string(),
  actor: ActorRefSchema,
});

export const SessionAttachmentsCommitResultSchema = z.object({
  attachmentId: IdentifierSchema,
  committed: z.boolean(),
  eventId: IdentifierSchema.optional(),
});

// ─── attachments.readRange ──────────────────────────────────────

export const SessionAttachmentsReadRangeParamsSchema = z.object({
  attachmentId: IdentifierSchema,
  sessionId: IdentifierSchema,
  byteOffset: z.number().int().nonnegative().optional(),
  byteLength: z.number().int().positive().optional(),
  scope: ScopeDescriptorV1Schema,
});

export const SessionAttachmentsReadRangeResultSchema = z.object({
  attachmentId: IdentifierSchema,
  data: z.string(),
  mediaType: z.string(),
  totalBytes: z.number().int().nonnegative(),
  returnedBytes: z.number().int().nonnegative(),
});

// ─── projections.workbench ──────────────────────────────────────

export const SessionProjectionsWorkbenchParamsSchema = z.object({
  sessionId: IdentifierSchema,
});

export const SessionProjectionsWorkbenchResultSchema = z.object({
  projectionRevision: z.number().int().positive(),
  sourceSequence: SequenceSchema,
  stale: z.boolean(),
  workbench: z.object({
    draftText: z.string(),
    contextItems: z.array(z.record(z.string(), z.unknown())),
    attachments: z.array(z.record(z.string(), z.unknown())),
    queueActions: z.array(z.record(z.string(), z.unknown())),
  }).passthrough(),
  confirmedCommandIds: z.array(IdentifierSchema),
});

// ─── projections.trajectory ─────────────────────────────────────

export const SessionProjectionsTrajectoryParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema.optional(),
  includeJobs: z.boolean().optional(),
  includeSubagents: z.boolean().optional(),
  includeWorkflows: z.boolean().optional(),
});

export const SessionProjectionsTrajectoryResultSchema = z.object({
  projectionRevision: z.number().int().positive(),
  sourceSequence: SequenceSchema,
  stale: z.boolean(),
  trajectory: z.object({
    plans: z.array(z.record(z.string(), z.unknown())),
    jobs: z.array(z.record(z.string(), z.unknown())).optional(),
    subagents: z.array(z.record(z.string(), z.unknown())).optional(),
    workflows: z.array(z.record(z.string(), z.unknown())).optional(),
    resultInjections: z.array(z.record(z.string(), z.unknown())),
  }).passthrough(),
  confirmedCommandIds: z.array(IdentifierSchema),
});

// ─── goals.create ───────────────────────────────────────────────

export const SessionGoalsCreateParamsSchema = z.object({
  sessionId: IdentifierSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  dependencies: z.array(IdentifierSchema).optional(),
  schedule: z.object({
    kind: z.enum(['once', 'recurring']),
    at: z.string().optional(),
    interval: z.string().optional(),
  }).optional(),
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
  idempotencyKey: z.string(),
});

export const SessionGoalsCreateResultSchema = z.object({
  goalId: IdentifierSchema,
  status: z.enum(['created', 'rejected', 'duplicate']),
  revision: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

// ─── goals.update ───────────────────────────────────────────────

export const SessionGoalsUpdateParamsSchema = z.object({
  goalId: IdentifierSchema,
  sessionId: IdentifierSchema,
  expectedRevision: z.number().int().nonnegative(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  state: z.enum(['active', 'completed', 'abandoned']).optional(),
  dependencies: z.array(IdentifierSchema).optional(),
  actor: ActorRefSchema,
});

export const SessionGoalsUpdateResultSchema = z.object({
  goalId: IdentifierSchema,
  updated: z.boolean(),
  revision: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

// ─── goals.list ─────────────────────────────────────────────────

export const SessionGoalsListParamsSchema = z.object({
  sessionId: IdentifierSchema,
  states: z.array(z.enum(['active', 'completed', 'abandoned'])).optional(),
  limit: z.number().int().positive().optional(),
});

export const SessionGoalsListResultSchema = z.object({
  goals: z.array(z.object({
    goalId: IdentifierSchema,
    title: z.string(),
    state: z.enum(['active', 'completed', 'abandoned']),
    revision: z.number().int().nonnegative(),
    dependencyCount: z.number().int().nonnegative(),
    hasSchedule: z.boolean(),
  }).passthrough()),
  total: z.number().int().nonnegative(),
});

// ─── diagnostics.health ─────────────────────────────────────────

export const SessionDiagnosticsHealthParamsSchema = z.object({}).optional();

export const SessionDiagnosticsHealthResultSchema = z.object({
  processVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  uptime: z.number().nonnegative(),
  draining: z.boolean(),
  databaseConnected: z.boolean(),
  databaseCompatible: z.boolean(),
  observedSchemaVersion: z.string().optional(),
  migrationState: z.enum(['idle', 'in_progress', 'failed']).optional(),
  requiredAuthoritiesAvailable: z.boolean(),
});

// ─── Method Registry ────────────────────────────────────────────

export const SESSION_METHODS = {
  'neuronest.session.v1.events.append': {
    params: SessionEventsAppendParamsSchema,
    result: SessionEventsAppendResultSchema,
  },
  'neuronest.session.v1.events.read': {
    params: SessionEventsReadParamsSchema,
    result: SessionEventsReadResultSchema,
  },
  'neuronest.session.v1.events.verify': {
    params: SessionEventsVerifyParamsSchema,
    result: SessionEventsVerifyResultSchema,
  },
  'neuronest.session.v1.sessions.fork': {
    params: SessionsForkParamsSchema,
    result: SessionsForkResultSchema,
  },
  'neuronest.session.v1.sessions.resume': {
    params: SessionsResumeParamsSchema,
    result: SessionsResumeResultSchema,
  },
  'neuronest.session.v1.projections.timeline': {
    params: SessionProjectionsTimelineParamsSchema,
    result: SessionProjectionsTimelineResultSchema,
  },
  'neuronest.session.v1.projections.header': {
    params: SessionProjectionsHeaderParamsSchema,
    result: SessionProjectionsHeaderResultSchema,
  },
  'neuronest.session.v1.projections.insights': {
    params: SessionProjectionsInsightsParamsSchema,
    result: SessionProjectionsInsightsResultSchema,
  },
  'neuronest.session.v1.query.search': {
    params: SessionQuerySearchParamsSchema,
    result: SessionQuerySearchResultSchema,
  },
  'neuronest.session.v1.query.export': {
    params: SessionQueryExportParamsSchema,
    result: SessionQueryExportResultSchema,
  },
  'neuronest.session.v1.compaction.plan': {
    params: SessionCompactionPlanParamsSchema,
    result: SessionCompactionPlanResultSchema,
  },
  'neuronest.session.v1.compaction.commit': {
    params: SessionCompactionCommitParamsSchema,
    result: SessionCompactionCommitResultSchema,
  },
  'neuronest.session.v1.spill.readRange': {
    params: SessionSpillReadRangeParamsSchema,
    result: SessionSpillReadRangeResultSchema,
  },
  'neuronest.session.v1.attachments.prepare': {
    params: SessionAttachmentsPrepareParamsSchema,
    result: SessionAttachmentsPrepareResultSchema,
  },
  'neuronest.session.v1.attachments.commit': {
    params: SessionAttachmentsCommitParamsSchema,
    result: SessionAttachmentsCommitResultSchema,
  },
  'neuronest.session.v1.attachments.readRange': {
    params: SessionAttachmentsReadRangeParamsSchema,
    result: SessionAttachmentsReadRangeResultSchema,
  },
  'neuronest.session.v1.projections.workbench': {
    params: SessionProjectionsWorkbenchParamsSchema,
    result: SessionProjectionsWorkbenchResultSchema,
  },
  'neuronest.session.v1.projections.trajectory': {
    params: SessionProjectionsTrajectoryParamsSchema,
    result: SessionProjectionsTrajectoryResultSchema,
  },
  'neuronest.session.v1.goals.create': {
    params: SessionGoalsCreateParamsSchema,
    result: SessionGoalsCreateResultSchema,
  },
  'neuronest.session.v1.goals.update': {
    params: SessionGoalsUpdateParamsSchema,
    result: SessionGoalsUpdateResultSchema,
  },
  'neuronest.session.v1.goals.list': {
    params: SessionGoalsListParamsSchema,
    result: SessionGoalsListResultSchema,
  },
  'neuronest.session.v1.diagnostics.health': {
    params: SessionDiagnosticsHealthParamsSchema,
    result: SessionDiagnosticsHealthResultSchema,
  },
} as const;

export type SessionMethodName = keyof typeof SESSION_METHODS;
