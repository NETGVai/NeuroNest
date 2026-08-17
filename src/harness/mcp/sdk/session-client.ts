/**
 * SessionMcpClient — Typed Client SDK for neuronest.session.v1.*
 *
 * Provides typed methods for all session MCP surfaces. Each method maps
 * to a JSON-RPC call over stdio. The client uses canonical domain types
 * (SessionEventV1, ProjectionEnvelopeV1, etc.) in its public interface
 * and does NOT expose protocol-specific types (JSON-RPC envelopes,
 * transport details).
 *
 * Requirements: 25.1, 30.9–30.10, 32.1–32.2
 */

import { z } from 'zod';
import { StdioTransport } from './stdio-transport';
import {
  SESSION_NAMESPACE,
  SessionEventsAppendResultSchema,
  SessionEventsReadResultSchema,
  SessionEventsVerifyResultSchema,
  SessionsForkResultSchema,
  SessionsResumeResultSchema,
  SessionProjectionsTimelineResultSchema,
  SessionProjectionsHeaderResultSchema,
  SessionProjectionsInsightsResultSchema,
  SessionProjectionsWorkbenchResultSchema,
  SessionProjectionsTrajectoryResultSchema,
  SessionQuerySearchResultSchema,
  SessionQueryExportResultSchema,
  SessionCompactionPlanResultSchema,
  SessionCompactionCommitResultSchema,
  SessionSpillReadRangeResultSchema,
  SessionAttachmentsPrepareResultSchema,
  SessionAttachmentsCommitResultSchema,
  SessionAttachmentsReadRangeResultSchema,
  SessionGoalsCreateResultSchema,
  SessionGoalsUpdateResultSchema,
  SessionGoalsListResultSchema,
  SessionDiagnosticsHealthResultSchema,
} from './session-schemas';
import type { ScopeDescriptorV1 } from '../../contracts/scope';
import type { ActorRef } from '../../contracts/actor';

// ─── Public Domain Types (no protocol leakage) ──────────────────

export interface AppendEventParams {
  sessionId: string;
  branchId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
}

export interface AppendEventResult {
  eventId: string;
  sequence: number;
  integrityHash: string;
}

export interface ReadEventsParams {
  sessionId: string;
  branchId: string;
  fromSequence?: number;
  toSequence?: number;
  limit?: number;
}

export interface ReadEventsResult {
  events: Record<string, unknown>[];
  hasMore: boolean;
}

export interface VerifyEventsParams {
  sessionId: string;
  branchId: string;
  fromSequence?: number;
  toSequence?: number;
}

export interface VerifyEventsResult {
  valid: boolean;
  verifiedThrough: number;
  firstInvalidSequence?: number | undefined;
  reason?: string | undefined;
}

export interface ForkSessionParams {
  parentSessionId: string;
  parentBranchId: string;
  forkSequence: number;
  newBranchId?: string;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
}

export interface ForkSessionResult {
  sessionId: string;
  branchId: string;
  forkSequence: number;
  lineageRecorded: boolean;
}

export interface ResumeSessionParams {
  sessionId: string;
  branchId: string;
  fromCheckpoint?: string;
  actor: ActorRef;
}

export interface ResumeSessionResult {
  sessionId: string;
  branchId: string;
  resumedFromSequence: number;
  checkpointUsed: boolean;
}

export interface TimelineQueryParams {
  sessionId: string;
  branchId: string;
  afterSequence?: number;
  limit?: number;
  direction?: 'forward' | 'backward';
}

export interface TimelineQueryResult {
  projectionRevision: number;
  sourceSequence: number;
  stale: boolean;
  nodes: Record<string, unknown>[];
  hasMore: boolean;
  confirmedCommandIds: string[];
}

export interface HeaderQueryParams {
  sessionId: string;
}

export interface HeaderQueryResult {
  projectionRevision: number;
  sourceSequence: number;
  stale: boolean;
  header: Record<string, unknown>;
  confirmedCommandIds: string[];
}

export interface InsightsQueryParams {
  sessionId: string;
  branchId?: string;
  metricKinds?: string[];
}

export interface InsightsQueryResult {
  projectionRevision: number;
  sourceSequence: number;
  stale: boolean;
  insights: Record<string, unknown>;
  confirmedCommandIds: string[];
}

export interface SearchParams {
  sessionId: string;
  branchId?: string;
  query: string;
  scope?: ScopeDescriptorV1;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  results: Array<{
    eventId: string;
    sequence: number;
    snippet: string;
    score: number;
  }>;
  total: number;
  hasMore: boolean;
}

export interface ExportParams {
  sessionId: string;
  branchId: string;
  fromSequence?: number;
  toSequence?: number;
  format?: 'json_lines';
}

export interface ExportResult {
  exportId: string;
  lineCount: number;
  manifestHash: string;
  omissions?: string[] | undefined;
}

export interface CompactionPlanParams {
  sessionId: string;
  branchId: string;
  targetTokens?: number;
}

export interface CompactionPlanResult {
  planId: string;
  sourceRange: { fromSequence: number; toSequence: number };
  strategy: string;
  estimatedReduction: number;
}

export interface CompactionCommitParams {
  planId: string;
  sessionId: string;
  branchId: string;
  actor: ActorRef;
}

export interface CompactionCommitResult {
  committed: boolean;
  newSequence?: number | undefined;
  compactionEventId?: string | undefined;
}

export interface SpillReadRangeParams {
  locator: string;
  byteOffset?: number;
  byteLength?: number;
  scope: ScopeDescriptorV1;
}

export interface SpillReadRangeResult {
  data: string;
  mediaType: string;
  totalBytes: number;
  returnedBytes: number;
}

export interface AttachmentPrepareParams {
  sessionId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
}

export interface AttachmentPrepareResult {
  attachmentId: string;
  uploadRef: string;
  stage: 'validating';
}

export interface AttachmentCommitParams {
  attachmentId: string;
  sessionId: string;
  contentDigest: string;
  idempotencyKey: string;
  actor: ActorRef;
}

export interface AttachmentCommitResult {
  attachmentId: string;
  committed: boolean;
  eventId?: string | undefined;
}

export interface AttachmentReadRangeParams {
  attachmentId: string;
  sessionId: string;
  byteOffset?: number;
  byteLength?: number;
  scope: ScopeDescriptorV1;
}

export interface AttachmentReadRangeResult {
  attachmentId: string;
  data: string;
  mediaType: string;
  totalBytes: number;
  returnedBytes: number;
}

export interface WorkbenchQueryParams {
  sessionId: string;
}

export interface WorkbenchQueryResult {
  projectionRevision: number;
  sourceSequence: number;
  stale: boolean;
  workbench: {
    draftText: string;
    contextItems: Record<string, unknown>[];
    attachments: Record<string, unknown>[];
    queueActions: Record<string, unknown>[];
  };
  confirmedCommandIds: string[];
}

export interface TrajectoryQueryParams {
  sessionId: string;
  branchId?: string;
  includeJobs?: boolean;
  includeSubagents?: boolean;
  includeWorkflows?: boolean;
}

export interface TrajectoryQueryResult {
  projectionRevision: number;
  sourceSequence: number;
  stale: boolean;
  trajectory: {
    plans: Record<string, unknown>[];
    jobs?: Record<string, unknown>[] | undefined;
    subagents?: Record<string, unknown>[] | undefined;
    workflows?: Record<string, unknown>[] | undefined;
    resultInjections: Record<string, unknown>[];
    [key: string]: unknown;
  };
  confirmedCommandIds: string[];
}

export interface GoalCreateParams {
  sessionId: string;
  title: string;
  description?: string;
  dependencies?: string[];
  schedule?: {
    kind: 'once' | 'recurring';
    at?: string;
    interval?: string;
  };
  actor: ActorRef;
  scope: ScopeDescriptorV1;
  idempotencyKey: string;
}

export interface GoalCreateResult {
  goalId: string;
  status: 'created' | 'rejected' | 'duplicate';
  revision: number;
  reason?: string | undefined;
}

export interface GoalUpdateParams {
  goalId: string;
  sessionId: string;
  expectedRevision: number;
  title?: string;
  description?: string;
  state?: 'active' | 'completed' | 'abandoned';
  dependencies?: string[];
  actor: ActorRef;
}

export interface GoalUpdateResult {
  goalId: string;
  updated: boolean;
  revision: number;
  reason?: string | undefined;
}

export interface GoalListParams {
  sessionId: string;
  states?: Array<'active' | 'completed' | 'abandoned'>;
  limit?: number;
}

export interface GoalListResult {
  goals: Array<{
    goalId: string;
    title: string;
    state: 'active' | 'completed' | 'abandoned';
    revision: number;
    dependencyCount: number;
    hasSchedule: boolean;
  }>;
  total: number;
}

export interface SessionHealthResult {
  processVersion: string;
  protocolVersion: string;
  uptime: number;
  draining: boolean;
  databaseConnected: boolean;
  databaseCompatible: boolean;
  observedSchemaVersion?: string | undefined;
  migrationState?: 'idle' | 'in_progress' | 'failed' | undefined;
  requiredAuthoritiesAvailable: boolean;
}

// ─── Client Implementation ──────────────────────────────────────

export class SessionMcpClient {
  private transport: StdioTransport;

  constructor(transport: StdioTransport) {
    this.transport = transport;
  }

  private method(name: string): string {
    return `${SESSION_NAMESPACE}.${name}`;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const raw = await this.transport.call(this.method(method), params);
    return schema.parse(raw);
  }

  // ─── Events ─────────────────────────────────────────────────

  async appendEvent(params: AppendEventParams): Promise<AppendEventResult> {
    return this.rpc('events.append', params as unknown as Record<string, unknown>, SessionEventsAppendResultSchema);
  }

  async readEvents(params: ReadEventsParams): Promise<ReadEventsResult> {
    return this.rpc('events.read', params as unknown as Record<string, unknown>, SessionEventsReadResultSchema);
  }

  async verifyEvents(params: VerifyEventsParams): Promise<VerifyEventsResult> {
    return this.rpc('events.verify', params as unknown as Record<string, unknown>, SessionEventsVerifyResultSchema);
  }

  // ─── Sessions ───────────────────────────────────────────────

  async forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
    return this.rpc('sessions.fork', params as unknown as Record<string, unknown>, SessionsForkResultSchema);
  }

  async resumeSession(params: ResumeSessionParams): Promise<ResumeSessionResult> {
    return this.rpc('sessions.resume', params as unknown as Record<string, unknown>, SessionsResumeResultSchema);
  }

  // ─── Projections ────────────────────────────────────────────

  async getTimeline(params: TimelineQueryParams): Promise<TimelineQueryResult> {
    return this.rpc('projections.timeline', params as unknown as Record<string, unknown>, SessionProjectionsTimelineResultSchema);
  }

  async getHeader(params: HeaderQueryParams): Promise<HeaderQueryResult> {
    return this.rpc('projections.header', params as unknown as Record<string, unknown>, SessionProjectionsHeaderResultSchema);
  }

  async getInsights(params: InsightsQueryParams): Promise<InsightsQueryResult> {
    return this.rpc('projections.insights', params as unknown as Record<string, unknown>, SessionProjectionsInsightsResultSchema);
  }

  async getWorkbench(params: WorkbenchQueryParams): Promise<WorkbenchQueryResult> {
    return this.rpc('projections.workbench', params as unknown as Record<string, unknown>, SessionProjectionsWorkbenchResultSchema);
  }

  async getTrajectory(params: TrajectoryQueryParams): Promise<TrajectoryQueryResult> {
    return this.rpc('projections.trajectory', params as unknown as Record<string, unknown>, SessionProjectionsTrajectoryResultSchema);
  }

  // ─── Query ──────────────────────────────────────────────────

  async search(params: SearchParams): Promise<SearchResult> {
    return this.rpc('query.search', params as unknown as Record<string, unknown>, SessionQuerySearchResultSchema);
  }

  async exportSession(params: ExportParams): Promise<ExportResult> {
    return this.rpc('query.export', params as unknown as Record<string, unknown>, SessionQueryExportResultSchema);
  }

  // ─── Compaction ─────────────────────────────────────────────

  async planCompaction(params: CompactionPlanParams): Promise<CompactionPlanResult> {
    return this.rpc('compaction.plan', params as unknown as Record<string, unknown>, SessionCompactionPlanResultSchema);
  }

  async commitCompaction(params: CompactionCommitParams): Promise<CompactionCommitResult> {
    return this.rpc('compaction.commit', params as unknown as Record<string, unknown>, SessionCompactionCommitResultSchema);
  }

  // ─── Spill ──────────────────────────────────────────────────

  async readSpillRange(params: SpillReadRangeParams): Promise<SpillReadRangeResult> {
    return this.rpc('spill.readRange', params as unknown as Record<string, unknown>, SessionSpillReadRangeResultSchema);
  }

  // ─── Attachments ────────────────────────────────────────────

  async prepareAttachment(params: AttachmentPrepareParams): Promise<AttachmentPrepareResult> {
    return this.rpc('attachments.prepare', params as unknown as Record<string, unknown>, SessionAttachmentsPrepareResultSchema);
  }

  async commitAttachment(params: AttachmentCommitParams): Promise<AttachmentCommitResult> {
    return this.rpc('attachments.commit', params as unknown as Record<string, unknown>, SessionAttachmentsCommitResultSchema);
  }

  async readAttachmentRange(params: AttachmentReadRangeParams): Promise<AttachmentReadRangeResult> {
    return this.rpc('attachments.readRange', params as unknown as Record<string, unknown>, SessionAttachmentsReadRangeResultSchema);
  }

  // ─── Diagnostics ────────────────────────────────────────────

  async getHealth(): Promise<SessionHealthResult> {
    return this.rpc('diagnostics.health', {}, SessionDiagnosticsHealthResultSchema);
  }

  // ─── Goals ──────────────────────────────────────────────────

  async createGoal(params: GoalCreateParams): Promise<GoalCreateResult> {
    return this.rpc('goals.create', params as unknown as Record<string, unknown>, SessionGoalsCreateResultSchema);
  }

  async updateGoal(params: GoalUpdateParams): Promise<GoalUpdateResult> {
    return this.rpc('goals.update', params as unknown as Record<string, unknown>, SessionGoalsUpdateResultSchema);
  }

  async listGoals(params: GoalListParams): Promise<GoalListResult> {
    return this.rpc('goals.list', params as unknown as Record<string, unknown>, SessionGoalsListResultSchema);
  }
}
