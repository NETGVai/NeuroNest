import { z } from 'zod';
import { ActorRefSchema } from './actor';
import { SessionEventV1Schema } from './event';
import {
  CompletionAnchorBlockV1Schema,
  ContentBlockV1Schema,
  ProviderBlockEnvelopeV1Schema,
  ReasoningBlockV1Schema as ProviderReasoningBlockV1Schema,
  ToolCallBlockV1Schema,
  UsageBlockV1Schema,
} from './provider-block';
import { IdentifierSchema, IntegrityHashSchema, TimestampSchema } from './primitives';
import { ResponseBlockStableKeyV1Schema, ResponseSourceIdentityV1Schema } from './response-composition';
import { ResponseDigestSchema } from './response-support';
import { ScopeDescriptorV1Schema } from './scope';

/**
 * Correlated chat stream contracts carried by the existing SessionEventV1
 * storage envelope. These schemas intentionally do not introduce another
 * durable event envelope or another response/block identity authority.
 *
 * Requirements: 8.1–8.3, 10.1, 11.1–11.9, 12.1–12.9, 13.1–13.9,
 * 15.3–15.5, 15.8
 */

export const CHAT_STREAM_CONTRACT_VERSION = 1 as const;
export const MAX_CHAT_STREAM_TEXT_LENGTH = 100_000;
export const MAX_CHAT_STREAM_SUMMARY_LENGTH = 4_096;
export const MAX_RETRY_AFTER_MS = 86_400_000;

const RevisionSchema = z.number().int().nonnegative().finite();
const OrderIndexSchema = z.number().int().nonnegative().finite();
const BoundedTextSchema = z.string().max(MAX_CHAT_STREAM_TEXT_LENGTH);
const NonEmptyDeltaSchema = z.string().min(1).max(MAX_CHAT_STREAM_TEXT_LENGTH);
const SummarySchema = z.string().min(1).max(MAX_CHAT_STREAM_SUMMARY_LENGTH);
const OptionalSummarySchema = z.string().max(MAX_CHAT_STREAM_SUMMARY_LENGTH).optional();

export const ChatEventTypeV1Schema = z.enum([
  'response.started',
  'answer.delta',
  'reasoning.delta',
  'thinking.step.upserted',
  'tool.upserted',
  'task.upserted',
  'approval.upserted',
  'usage.reported',
  'block.error',
  'response.completed',
  'response.stopped',
  'response.interrupted',
  'response.failed',
]);
export type ChatEventTypeV1 = z.infer<typeof ChatEventTypeV1Schema>;

/** Compatibility alias for the design-level ChatEventType name. */
export const ChatEventTypeSchema = ChatEventTypeV1Schema;
export type ChatEventType = ChatEventTypeV1;

export const ChatEventRouteV1Schema = z
  .object({
    routeId: IdentifierSchema,
    transportClass: z.enum(['neuronest-cloud-proxy', 'local-provider']),
    provider: IdentifierSchema,
    model: IdentifierSchema,
    edition: z.enum(['community', 'professional', 'enterprise']),
  })
  .strict();
export type ChatEventRouteV1 = z.infer<typeof ChatEventRouteV1Schema>;

/**
 * Stable response identity. `sourceIdentity.entityId` is the same responseId;
 * session/branch/turn values are checked against SessionEventV1 by the
 * specialized envelope schema below.
 */
export const ChatResponseIdentityV1Schema = z
  .object({
    conversationId: IdentifierSchema,
    turnId: IdentifierSchema,
    responseId: IdentifierSchema,
    requestId: IdentifierSchema,
    attempt: z.number().int().nonnegative().finite(),
    sourceIdentity: ResponseSourceIdentityV1Schema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.sourceIdentity.turnId !== identity.turnId) {
      context.addIssue({
        code: 'custom',
        path: ['sourceIdentity', 'turnId'],
        message: 'response source identity must use the correlated turnId',
      });
    }
    if (identity.sourceIdentity.entityId !== identity.responseId) {
      context.addIssue({
        code: 'custom',
        path: ['sourceIdentity', 'entityId'],
        message: 'response source identity entityId must equal responseId',
      });
    }
  });
export type ChatResponseIdentityV1 = z.infer<typeof ChatResponseIdentityV1Schema>;

/** Stable identity for an independently projected response block/entity. */
export const ChatBlockIdentityV1Schema = z
  .object({
    stableKey: ResponseBlockStableKeyV1Schema,
    sourceIdentity: ResponseSourceIdentityV1Schema,
  })
  .strict();
export type ChatBlockIdentityV1 = z.infer<typeof ChatBlockIdentityV1Schema>;

export const RetryMetadataV1Schema = z
  .object({
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().max(MAX_RETRY_AFTER_MS).optional(),
    previousRequestId: IdentifierSchema.optional(),
    previousAttempt: z.number().int().nonnegative().finite().optional(),
    completionAnchorId: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if ((metadata.previousRequestId === undefined) !== (metadata.previousAttempt === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'previousRequestId and previousAttempt must be supplied together',
      });
    }
    if (!metadata.retryable && metadata.retryAfterMs !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['retryAfterMs'],
        message: 'a non-retryable response cannot declare a retry delay',
      });
    }
  });
export type RetryMetadataV1 = z.infer<typeof RetryMetadataV1Schema>;

export const ChatStreamErrorClassV1Schema = z.enum([
  'validation',
  'malformed_block',
  'unsupported_schema',
  'proxy_authentication',
  'proxy_entitlement',
  'proxy_quota',
  'proxy_rate_limit',
  'network',
  'stream_gap',
  'persistence',
  'cancelled',
  'internal',
]);
export type ChatStreamErrorClassV1 = z.infer<typeof ChatStreamErrorClassV1Schema>;

const StrictContentBlockV1Schema = ContentBlockV1Schema.extend({
  text: NonEmptyDeltaSchema,
  isFinal: z.literal(false),
}).strict();

const StrictReasoningBlockV1Schema = ProviderReasoningBlockV1Schema.extend({
  summary: NonEmptyDeltaSchema,
  redacted: z.literal(false),
}).strict();

const StrictToolCallBlockV1Schema = ToolCallBlockV1Schema.strict();
const StrictUsageBlockV1Schema = UsageBlockV1Schema.strict();
const StrictCompletionAnchorBlockV1Schema = CompletionAnchorBlockV1Schema.strict();

export const AnswerProviderBlockEnvelopeV1Schema = ProviderBlockEnvelopeV1Schema.extend({
  block: StrictContentBlockV1Schema,
}).strict();
export type AnswerProviderBlockEnvelopeV1 = z.infer<typeof AnswerProviderBlockEnvelopeV1Schema>;

export const ReasoningProviderBlockEnvelopeV1Schema = ProviderBlockEnvelopeV1Schema.extend({
  block: StrictReasoningBlockV1Schema,
}).strict();
export type ReasoningProviderBlockEnvelopeV1 = z.infer<typeof ReasoningProviderBlockEnvelopeV1Schema>;

export const ToolProviderBlockEnvelopeV1Schema = ProviderBlockEnvelopeV1Schema.extend({
  block: StrictToolCallBlockV1Schema,
}).strict();
export type ToolProviderBlockEnvelopeV1 = z.infer<typeof ToolProviderBlockEnvelopeV1Schema>;

export const UsageProviderBlockEnvelopeV1Schema = ProviderBlockEnvelopeV1Schema.extend({
  block: StrictUsageBlockV1Schema,
}).strict();
export type UsageProviderBlockEnvelopeV1 = z.infer<typeof UsageProviderBlockEnvelopeV1Schema>;

export const CompletionProviderBlockEnvelopeV1Schema = ProviderBlockEnvelopeV1Schema.extend({
  block: StrictCompletionAnchorBlockV1Schema,
}).strict();
export type CompletionProviderBlockEnvelopeV1 = z.infer<typeof CompletionProviderBlockEnvelopeV1Schema>;

const CorrelatedPayloadBaseShape = {
  schemaVersion: z.literal(CHAT_STREAM_CONTRACT_VERSION),
  identity: ChatResponseIdentityV1Schema,
  route: ChatEventRouteV1Schema,
};

export const ResponseStartedV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('response.started'),
    responseStableKey: ResponseBlockStableKeyV1Schema,
    agentId: IdentifierSchema.optional(),
    retry: RetryMetadataV1Schema.optional(),
  })
  .strict();
export type ResponseStartedV1 = z.infer<typeof ResponseStartedV1Schema>;

export const AnswerDeltaV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('answer.delta'),
    blockIdentity: ChatBlockIdentityV1Schema,
    delta: NonEmptyDeltaSchema,
    providerBlock: AnswerProviderBlockEnvelopeV1Schema,
  })
  .strict();
export type AnswerDeltaV1 = z.infer<typeof AnswerDeltaV1Schema>;

export const ReasoningDeltaV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('reasoning.delta'),
    blockIdentity: ChatBlockIdentityV1Schema,
    delta: NonEmptyDeltaSchema,
    label: z.enum(['model-provided-reasoning', 'model-provided-reasoning-summary']),
    providerBlock: ReasoningProviderBlockEnvelopeV1Schema,
  })
  .strict();
export type ReasoningDeltaV1 = z.infer<typeof ReasoningDeltaV1Schema>;

export const ThinkingStepKindV1Schema = z.enum([
  'planning',
  'searching',
  'coding',
  'tool_use',
  'waiting',
  'completion',
  'failure',
  'cancellation',
]);
export type ThinkingStepKindV1 = z.infer<typeof ThinkingStepKindV1Schema>;

export const ThinkingStepStateV1Schema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
export type ThinkingStepStateV1 = z.infer<typeof ThinkingStepStateV1Schema>;

export const ThinkingStepUpsertV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('thinking.step.upserted'),
    blockIdentity: ChatBlockIdentityV1Schema,
    stepId: IdentifierSchema,
    revision: RevisionSchema,
    orderIndex: OrderIndexSchema,
    kind: ThinkingStepKindV1Schema,
    state: ThinkingStepStateV1Schema,
    label: SummarySchema,
    startedAt: TimestampSchema.optional(),
    terminalAt: TimestampSchema.optional(),
  })
  .strict();
export type ThinkingStepUpsertV1 = z.infer<typeof ThinkingStepUpsertV1Schema>;

export const ToolUpsertStatusV1Schema = z.enum([
  'requested',
  'awaiting_approval',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type ToolUpsertStatusV1 = z.infer<typeof ToolUpsertStatusV1Schema>;

export const ToolUpsertDetailsV1Schema = z
  .object({
    inputValueId: IdentifierSchema.optional(),
    outputValueId: IdentifierSchema.optional(),
    inputSummary: OptionalSummarySchema,
    outputSummary: OptionalSummarySchema,
    errorSummary: OptionalSummarySchema,
  })
  .strict();
export type ToolUpsertDetailsV1 = z.infer<typeof ToolUpsertDetailsV1Schema>;

export const ToolUpsertV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('tool.upserted'),
    blockIdentity: ChatBlockIdentityV1Schema,
    callId: IdentifierSchema,
    revision: RevisionSchema,
    modelOrderIndex: OrderIndexSchema,
    toolName: IdentifierSchema,
    status: ToolUpsertStatusV1Schema,
    details: ToolUpsertDetailsV1Schema.optional(),
    providerBlock: ToolProviderBlockEnvelopeV1Schema.optional(),
  })
  .strict();
export type ToolUpsertV1 = z.infer<typeof ToolUpsertV1Schema>;

export const TaskUpsertStatusV1Schema = z.enum([
  'queued',
  'running',
  'blocked',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskUpsertStatusV1 = z.infer<typeof TaskUpsertStatusV1Schema>;

export const TaskUpsertV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('task.upserted'),
    blockIdentity: ChatBlockIdentityV1Schema,
    taskId: IdentifierSchema,
    revision: RevisionSchema,
    orderIndex: OrderIndexSchema,
    description: SummarySchema,
    status: TaskUpsertStatusV1Schema,
    progress: z.number().min(0).max(1).finite().optional(),
    outcome: OptionalSummarySchema,
    errorSummary: OptionalSummarySchema,
  })
  .strict();
export type TaskUpsertV1 = z.infer<typeof TaskUpsertV1Schema>;

export const ApprovalUpsertStatusV1Schema = z.enum(['pending', 'approved', 'rejected', 'expired', 'superseded']);
export type ApprovalUpsertStatusV1 = z.infer<typeof ApprovalUpsertStatusV1Schema>;

export const ApprovalUpsertV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('approval.upserted'),
    blockIdentity: ChatBlockIdentityV1Schema,
    collaborationId: IdentifierSchema,
    revision: RevisionSchema,
    orderIndex: OrderIndexSchema,
    actionSummary: SummarySchema,
    scopeSummary: OptionalSummarySchema,
    riskSummary: OptionalSummarySchema,
    status: ApprovalUpsertStatusV1Schema,
    contractRevision: RevisionSchema,
    contractDigest: ResponseDigestSchema,
    expiresAt: TimestampSchema.optional(),
  })
  .strict();
export type ApprovalUpsertV1 = z.infer<typeof ApprovalUpsertV1Schema>;

export const UsageReportedV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('usage.reported'),
    providerBlock: UsageProviderBlockEnvelopeV1Schema,
  })
  .strict();
export type UsageReportedV1 = z.infer<typeof UsageReportedV1Schema>;

export const BlockScopedErrorV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('block.error'),
    blockIdentity: ChatBlockIdentityV1Schema,
    errorId: IdentifierSchema,
    errorClass: ChatStreamErrorClassV1Schema,
    summary: SummarySchema,
    correlationId: IdentifierSchema,
    recoverable: z.boolean(),
    affectedEventType: ChatEventTypeV1Schema.optional(),
    lastVerifiedRevision: RevisionSchema.optional(),
  })
  .strict();
export type BlockScopedErrorV1 = z.infer<typeof BlockScopedErrorV1Schema>;

export const ResponseTerminalStateV1Schema = z.enum(['completed', 'stopped', 'interrupted', 'failed']);
export type ResponseTerminalStateV1 = z.infer<typeof ResponseTerminalStateV1Schema>;

export const ResponseCompletedV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('response.completed'),
    terminalState: z.literal('completed'),
    partialContentRetained: z.literal(true),
    providerBlock: CompletionProviderBlockEnvelopeV1Schema,
  })
  .strict();
export type ResponseCompletedV1 = z.infer<typeof ResponseCompletedV1Schema>;

export const ResponseStoppedV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    type: z.literal('response.stopped'),
    terminalState: z.literal('stopped'),
    partialContentRetained: z.literal(true),
    reason: OptionalSummarySchema,
    retry: RetryMetadataV1Schema.optional(),
  })
  .strict();
export type ResponseStoppedV1 = z.infer<typeof ResponseStoppedV1Schema>;

const FailureFields = {
  errorId: IdentifierSchema,
  errorClass: ChatStreamErrorClassV1Schema,
  summary: SummarySchema,
  correlationId: IdentifierSchema,
  retry: RetryMetadataV1Schema,
};

export const ResponseInterruptedV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    ...FailureFields,
    type: z.literal('response.interrupted'),
    terminalState: z.literal('interrupted'),
    partialContentRetained: z.literal(true),
  })
  .strict();
export type ResponseInterruptedV1 = z.infer<typeof ResponseInterruptedV1Schema>;

export const ResponseFailedV1Schema = z
  .object({
    ...CorrelatedPayloadBaseShape,
    ...FailureFields,
    type: z.literal('response.failed'),
    terminalState: z.literal('failed'),
    partialContentRetained: z.boolean(),
  })
  .strict();
export type ResponseFailedV1 = z.infer<typeof ResponseFailedV1Schema>;

export const ResponseTerminalV1Schema = z.discriminatedUnion('type', [
  ResponseCompletedV1Schema,
  ResponseStoppedV1Schema,
  ResponseInterruptedV1Schema,
  ResponseFailedV1Schema,
]);
export type ResponseTerminalV1 = z.infer<typeof ResponseTerminalV1Schema>;

export const ChatEventPayloadV1Schema = z.discriminatedUnion('type', [
  ResponseStartedV1Schema,
  AnswerDeltaV1Schema,
  ReasoningDeltaV1Schema,
  ThinkingStepUpsertV1Schema,
  ToolUpsertV1Schema,
  TaskUpsertV1Schema,
  ApprovalUpsertV1Schema,
  UsageReportedV1Schema,
  BlockScopedErrorV1Schema,
  ResponseCompletedV1Schema,
  ResponseStoppedV1Schema,
  ResponseInterruptedV1Schema,
  ResponseFailedV1Schema,
]);
export type ChatEventPayloadV1 = z.infer<typeof ChatEventPayloadV1Schema>;

function providerEnvelopeFromPayload(
  payload: ChatEventPayloadV1,
): z.infer<typeof ProviderBlockEnvelopeV1Schema> | undefined {
  return 'providerBlock' in payload ? payload.providerBlock : undefined;
}

/**
 * A strict specialization of SessionEventV1 for chat streams. SessionLog still
 * owns sequence allocation, integrity chaining, and durable persistence.
 */
export const ChatEventEnvelopeV1Schema = SessionEventV1Schema.extend({
  eventType: ChatEventTypeV1Schema,
  payload: ChatEventPayloadV1Schema,
  idempotencyKey: IdentifierSchema,
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
  integrityHash: IntegrityHashSchema,
})
  .strict()
  .superRefine((event, context) => {
    if (event.eventType !== event.payload.type) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'type'],
        message: 'payload type must match the SessionEventV1 eventType',
      });
    }

    const identity = event.payload.identity;
    if (identity.sourceIdentity.sessionId !== event.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'identity', 'sourceIdentity', 'sessionId'],
        message: 'response identity sessionId must match the SessionEventV1 sessionId',
      });
    }
    if (identity.sourceIdentity.branchId !== event.branchId) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'identity', 'sourceIdentity', 'branchId'],
        message: 'response identity branchId must match the SessionEventV1 branchId',
      });
    }
    if (event.scope.sessionId !== undefined && event.scope.sessionId !== event.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'sessionId'],
        message: 'event scope sessionId must match the SessionEventV1 sessionId',
      });
    }

    const providerEnvelope = providerEnvelopeFromPayload(event.payload);
    if (providerEnvelope !== undefined) {
      if (providerEnvelope.turnId !== identity.turnId) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'providerBlock', 'turnId'],
          message: 'provider block turnId must match the correlated response turnId',
        });
      }
      if (providerEnvelope.routeId !== event.payload.route.routeId) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'providerBlock', 'routeId'],
          message: 'provider block routeId must match the correlated route',
        });
      }
    }

    if ('blockIdentity' in event.payload) {
      const blockIdentity = event.payload.blockIdentity;
      if (
        blockIdentity.sourceIdentity.sessionId !== event.sessionId ||
        blockIdentity.sourceIdentity.branchId !== event.branchId ||
        blockIdentity.sourceIdentity.turnId !== identity.turnId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'blockIdentity', 'sourceIdentity'],
          message: 'block identity must match the correlated session, branch, and turn',
        });
      }
      const expectedEntityId =
        event.payload.type === 'tool.upserted'
          ? event.payload.callId
          : providerEnvelope?.block.blockId;
      if (
        expectedEntityId !== undefined &&
        expectedEntityId !== blockIdentity.sourceIdentity.entityId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'blockIdentity', 'sourceIdentity', 'entityId'],
          message:
            event.payload.type === 'tool.upserted'
              ? 'tool block identity entityId must match callId'
              : 'block identity entityId must match the provider blockId',
        });
      }
    }

    if ('delta' in event.payload && providerEnvelope !== undefined) {
      const providerText =
        providerEnvelope.block.kind === 'content'
          ? providerEnvelope.block.text
          : providerEnvelope.block.kind === 'reasoning'
            ? providerEnvelope.block.summary
            : undefined;
      if (providerText !== event.payload.delta) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'delta'],
          message: 'delta text must match the provider block payload',
        });
      }
    }
  });
export type ChatEventEnvelopeV1 = z.infer<typeof ChatEventEnvelopeV1Schema>;

export type ChatEventEnvelopeParseResultV1 =
  | { ok: true; event: ChatEventEnvelopeV1 }
  | { ok: false; unavailable: true; reason: string; rawEventType?: string };

/** Non-throwing process/network/database boundary parser. */
export function parseChatEventEnvelopeV1(raw: unknown): ChatEventEnvelopeParseResultV1 {
  const parsed = ChatEventEnvelopeV1Schema.safeParse(raw);
  if (parsed.success) return { ok: true, event: parsed.data };

  let rawEventType: string | undefined;
  try {
    if (typeof raw === 'object' && raw !== null && 'eventType' in raw) {
      rawEventType = String((raw as Record<string, unknown>)['eventType']);
    }
  } catch {
    // Hostile boundary values remain unavailable without escaping an exception.
  }

  return {
    ok: false,
    unavailable: true,
    reason: parsed.error.message,
    ...(rawEventType === undefined ? {} : { rawEventType }),
  };
}
