import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ChatEventPayloadV1Schema,
  ChatEventRouteV1Schema,
  ChatResponseIdentityV1Schema,
  ChatStreamErrorClassV1Schema,
  RetryMetadataV1Schema,
  type ChatEventPayloadV1,
  type ChatEventRouteV1,
  type ChatEventTypeV1,
  type ChatResponseIdentityV1,
} from '../harness/contracts/chat-stream-event';
import {
  DEFAULT_MAX_PROXY_FRAME_BYTES,
  type ProxyStreamFrame,
} from './proxy-stream-decoder';

/**
 * Validates untrusted proxy frames and converts them to provider-neutral
 * canonical stream payloads. Correlation and route authority always come from
 * trusted main-process context, never from the wire frame.
 *
 * Requirements: 8.1–8.3, 12.3, 15.1, 15.8
 */

export const MAX_PROXY_WIRE_TEXT_LENGTH = 100_000;
export const MAX_PROXY_WIRE_SUMMARY_LENGTH = 4_096;

const WireIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const WireRevisionSchema = z.number().int().nonnegative().finite();
const WireOrderSchema = z.number().int().nonnegative().finite();
const WireDeltaSchema = z.string().min(1).max(MAX_PROXY_WIRE_TEXT_LENGTH);
const WireSummarySchema = z.string().min(1).max(MAX_PROXY_WIRE_SUMMARY_LENGTH);
const WireOptionalSummarySchema = z.string().max(MAX_PROXY_WIRE_SUMMARY_LENGTH).optional();
const WireBaseShape = { schemaVersion: z.literal(1) };

const WireResponseStartedSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('response.started'),
    agentId: WireIdentifierSchema.optional(),
    retry: RetryMetadataV1Schema.optional(),
  })
  .strict();

const WireAnswerDeltaSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('answer.delta'),
    blockId: WireIdentifierSchema,
    blockIndex: WireOrderSchema,
    delta: WireDeltaSchema,
    contentType: z.enum(['text', 'code', 'markdown']).default('markdown'),
  })
  .strict();

const WireReasoningDeltaSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('reasoning.delta'),
    blockId: WireIdentifierSchema,
    blockIndex: WireOrderSchema,
    delta: WireDeltaSchema,
    label: z
      .enum(['model-provided-reasoning', 'model-provided-reasoning-summary'])
      .default('model-provided-reasoning-summary'),
  })
  .strict();

const WireThinkingStepSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('thinking.step.upserted'),
    stepId: WireIdentifierSchema,
    revision: WireRevisionSchema,
    orderIndex: WireOrderSchema,
    kind: z.enum([
      'planning',
      'searching',
      'coding',
      'tool_use',
      'waiting',
      'completion',
      'failure',
      'cancellation',
    ]),
    state: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
    label: WireSummarySchema,
    startedAt: z.string().datetime().optional(),
    terminalAt: z.string().datetime().optional(),
  })
  .strict();

const WireToolSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('tool.upserted'),
    callId: WireIdentifierSchema,
    revision: WireRevisionSchema,
    modelOrderIndex: WireOrderSchema,
    toolName: WireIdentifierSchema,
    status: z.enum([
      'requested',
      'awaiting_approval',
      'running',
      'succeeded',
      'failed',
      'cancelled',
    ]),
    details: z
      .object({
        inputValueId: WireIdentifierSchema.optional(),
        outputValueId: WireIdentifierSchema.optional(),
        inputSummary: WireOptionalSummarySchema,
        outputSummary: WireOptionalSummarySchema,
        errorSummary: WireOptionalSummarySchema,
      })
      .strict()
      .optional(),
    providerBlock: z
      .object({
        blockId: WireIdentifierSchema,
        blockIndex: WireOrderSchema,
        arguments: z.string().max(MAX_PROXY_WIRE_TEXT_LENGTH),
      })
      .strict()
      .optional(),
  })
  .strict();

const WireTaskSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('task.upserted'),
    taskId: WireIdentifierSchema,
    revision: WireRevisionSchema,
    orderIndex: WireOrderSchema,
    description: WireSummarySchema,
    status: z.enum(['queued', 'running', 'blocked', 'waiting', 'completed', 'failed', 'cancelled']),
    progress: z.number().min(0).max(1).finite().optional(),
    outcome: WireOptionalSummarySchema,
    errorSummary: WireOptionalSummarySchema,
  })
  .strict();

const WireApprovalSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('approval.upserted'),
    collaborationId: WireIdentifierSchema,
    revision: WireRevisionSchema,
    orderIndex: WireOrderSchema,
    actionSummary: WireSummarySchema,
    scopeSummary: WireOptionalSummarySchema,
    riskSummary: WireOptionalSummarySchema,
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'superseded']),
    contractRevision: WireRevisionSchema,
    contractDigest: z.string().regex(/^sha256:[a-fA-F0-9]{64}$/u),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const WireUsageSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('usage.reported'),
    blockId: WireIdentifierSchema,
    blockIndex: WireOrderSchema,
    inputTokens: z.number().int().nonnegative().finite(),
    outputTokens: z.number().int().nonnegative().finite(),
    cacheReadTokens: z.number().int().nonnegative().finite().optional(),
    cacheWriteTokens: z.number().int().nonnegative().finite().optional(),
    totalTokens: z.number().int().nonnegative().finite(),
  })
  .strict();

const WireCompletedSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('response.completed'),
    blockId: WireIdentifierSchema,
    blockIndex: WireOrderSchema,
    anchorId: WireIdentifierSchema,
    promptFingerprint: z.string().min(1).max(512),
    finishReason: z.enum(['stop', 'tool_use', 'length', 'content_filter', 'error']),
  })
  .strict();

const WireStoppedSchema = z
  .object({
    ...WireBaseShape,
    type: z.literal('response.stopped'),
    reason: WireOptionalSummarySchema,
    retry: RetryMetadataV1Schema.optional(),
  })
  .strict();

const WireFailureShape = {
  errorId: WireIdentifierSchema,
  errorClass: ChatStreamErrorClassV1Schema,
  summary: WireSummarySchema,
  correlationId: WireIdentifierSchema.optional(),
  retry: RetryMetadataV1Schema,
};

const WireInterruptedSchema = z
  .object({
    ...WireBaseShape,
    ...WireFailureShape,
    type: z.literal('response.interrupted'),
  })
  .strict();

const WireFailedSchema = z
  .object({
    ...WireBaseShape,
    ...WireFailureShape,
    type: z.literal('response.failed'),
    partialContentRetained: z.boolean(),
  })
  .strict();

export const ProxyWireEventV1Schema = z.discriminatedUnion('type', [
  WireResponseStartedSchema,
  WireAnswerDeltaSchema,
  WireReasoningDeltaSchema,
  WireThinkingStepSchema,
  WireToolSchema,
  WireTaskSchema,
  WireApprovalSchema,
  WireUsageSchema,
  WireCompletedSchema,
  WireStoppedSchema,
  WireInterruptedSchema,
  WireFailedSchema,
]);
export type ProxyWireEventV1 = z.infer<typeof ProxyWireEventV1Schema>;

const OPTIONAL_CARD_TYPES = new Set<ChatEventTypeV1>([
  'thinking.step.upserted',
  'tool.upserted',
  'task.upserted',
  'approval.upserted',
]);

export interface StreamNormalizationContextV1 {
  identity: ChatResponseIdentityV1;
  route: ChatEventRouteV1;
  receivedAt?: () => string;
}

export type StreamNormalizationErrorCode =
  | 'invalid_context'
  | 'malformed_json'
  | 'malformed_frame'
  | 'unsupported_event';

export interface StreamNormalizationError {
  code: StreamNormalizationErrorCode;
  summary: string;
  recoverable: boolean;
}

export type StreamNormalizationResult =
  | { ok: true; event: ChatEventPayloadV1 }
  | { ok: false; error: StreamNormalizationError };

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function stableKey(
  context: StreamNormalizationContextV1,
  kind: string,
  entityId: string,
): string {
  return `chat:${kind}:${digest([
    context.identity.sourceIdentity.sessionId,
    context.identity.sourceIdentity.branchId,
    context.identity.turnId,
    entityId,
  ])}`;
}

function blockIdentity(
  context: StreamNormalizationContextV1,
  kind: string,
  entityId: string,
) {
  return {
    stableKey: stableKey(context, kind, entityId),
    sourceIdentity: {
      sessionId: context.identity.sourceIdentity.sessionId,
      branchId: context.identity.sourceIdentity.branchId,
      turnId: context.identity.turnId,
      entityId,
    },
  };
}

function providerBlock(
  context: StreamNormalizationContextV1,
  blockIndex: number,
  block: Record<string, unknown>,
  receivedAt: string,
) {
  return {
    turnId: context.identity.turnId,
    routeId: context.route.routeId,
    blockIndex,
    block,
    receivedAt,
    schemaVersion: 1 as const,
  };
}

function normalizationError(
  code: StreamNormalizationErrorCode,
  summary: string,
  recoverable = true,
): StreamNormalizationResult {
  return { ok: false, error: { code, summary, recoverable } };
}

function rawEventType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const type = (value as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : undefined;
}

function rawRevision(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const revision = (value as Record<string, unknown>)['revision'];
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

/** Main-process normalizer; raw frame content is never copied into errors. */
export class StreamEventNormalizer {
  constructor(private readonly context: StreamNormalizationContextV1) {}

  normalize(input: ProxyStreamFrame | string): StreamNormalizationResult {
    const contextResult = this.validateContext();
    if (contextResult !== undefined) return contextResult;

    const frame = typeof input === 'string' ? { data: input } : input;
    if (Buffer.byteLength(frame.data, 'utf8') > DEFAULT_MAX_PROXY_FRAME_BYTES) {
      return normalizationError(
        'malformed_frame',
        'A proxy stream event exceeded the configured limit.',
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(frame.data) as unknown;
    } catch {
      if (frame.event !== undefined && OPTIONAL_CARD_TYPES.has(frame.event as ChatEventTypeV1)) {
        return this.malformedOptionalCard(frame.event as ChatEventTypeV1, undefined);
      }
      return normalizationError('malformed_json', 'A proxy stream frame could not be decoded.');
    }

    const embeddedType = rawEventType(raw);
    const eventHint = frame.event === undefined || frame.event === 'message' ? undefined : frame.event;
    if (eventHint !== undefined && embeddedType !== undefined && eventHint !== embeddedType) {
      if (OPTIONAL_CARD_TYPES.has(eventHint as ChatEventTypeV1)) {
        return this.malformedOptionalCard(eventHint as ChatEventTypeV1, raw);
      }
      return normalizationError('malformed_frame', 'A proxy stream frame had inconsistent metadata.');
    }

    if (embeddedType === undefined && eventHint !== undefined && typeof raw === 'object' && raw !== null) {
      raw = { ...(raw as Record<string, unknown>), type: eventHint };
    }

    const effectiveType = rawEventType(raw) ?? eventHint;
    const parsed = ProxyWireEventV1Schema.safeParse(raw);
    if (!parsed.success) {
      if (effectiveType !== undefined && OPTIONAL_CARD_TYPES.has(effectiveType as ChatEventTypeV1)) {
        return this.malformedOptionalCard(effectiveType as ChatEventTypeV1, raw);
      }
      const code = effectiveType === undefined ? 'malformed_frame' : 'unsupported_event';
      return normalizationError(code, 'A proxy stream event did not match the supported contract.');
    }

    return this.toCanonical(parsed.data);
  }

  /** Compatibility alias emphasizing that input is one decoded frame. */
  normalizeFrame(frame: ProxyStreamFrame): StreamNormalizationResult {
    return this.normalize(frame);
  }

  normalizeMany(frames: readonly ProxyStreamFrame[]): StreamNormalizationResult[] {
    return frames.map((frame) => this.normalize(frame));
  }

  private validateContext(): StreamNormalizationResult | undefined {
    if (
      !ChatResponseIdentityV1Schema.safeParse(this.context.identity).success ||
      !ChatEventRouteV1Schema.safeParse(this.context.route).success
    ) {
      return normalizationError(
        'invalid_context',
        'The stream normalization context was invalid.',
        false,
      );
    }
    return undefined;
  }

  private malformedOptionalCard(
    affectedEventType: ChatEventTypeV1,
    raw: unknown,
  ): StreamNormalizationResult {
    const fingerprint = digest([
      this.context.identity.requestId,
      affectedEventType,
      typeof raw === 'string' ? raw : JSON.stringify(raw) ?? 'unavailable',
    ]).slice(0, 24);
    const entityId = `unavailable-${affectedEventType.replaceAll('.', '-')}-${fingerprint}`;
    const cardName =
      affectedEventType === 'thinking.step.upserted'
        ? 'activity'
        : affectedEventType.split('.')[0] ?? 'optional';
    const event = {
      schemaVersion: 1 as const,
      type: 'block.error' as const,
      identity: this.context.identity,
      route: this.context.route,
      blockIdentity: blockIdentity(this.context, 'error', entityId),
      errorId: `malformed-${fingerprint}`,
      errorClass: 'malformed_block' as const,
      summary: `The ${cardName} card could not be displayed.`,
      correlationId: this.context.identity.requestId,
      recoverable: true,
      affectedEventType,
      ...(rawRevision(raw) === undefined ? {} : { lastVerifiedRevision: rawRevision(raw) }),
    };
    const validated = ChatEventPayloadV1Schema.safeParse(event);
    return validated.success
      ? { ok: true, event: validated.data }
      : normalizationError('invalid_context', 'A recoverable card error could not be created.', false);
  }

  private toCanonical(wire: ProxyWireEventV1): StreamNormalizationResult {
    const common = {
      schemaVersion: 1 as const,
      identity: this.context.identity,
      route: this.context.route,
    };
    const receivedAt = (this.context.receivedAt ?? (() => new Date().toISOString()))();
    let event: unknown;

    switch (wire.type) {
      case 'response.started':
        event = {
          ...common,
          type: wire.type,
          responseStableKey: stableKey(this.context, 'response', this.context.identity.responseId),
          ...(wire.agentId === undefined ? {} : { agentId: wire.agentId }),
          ...(wire.retry === undefined ? {} : { retry: wire.retry }),
        };
        break;
      case 'answer.delta':
        event = {
          ...common,
          type: wire.type,
          blockIdentity: blockIdentity(this.context, 'answer', wire.blockId),
          delta: wire.delta,
          providerBlock: providerBlock(
            this.context,
            wire.blockIndex,
            {
              kind: 'content',
              blockId: wire.blockId,
              contentType: wire.contentType,
              text: wire.delta,
              isFinal: false,
            },
            receivedAt,
          ),
        };
        break;
      case 'reasoning.delta':
        event = {
          ...common,
          type: wire.type,
          blockIdentity: blockIdentity(this.context, 'reasoning', wire.blockId),
          delta: wire.delta,
          label: wire.label,
          providerBlock: providerBlock(
            this.context,
            wire.blockIndex,
            {
              kind: 'reasoning',
              blockId: wire.blockId,
              summary: wire.delta,
              redacted: false,
            },
            receivedAt,
          ),
        };
        break;
      case 'thinking.step.upserted':
        event = {
          ...common,
          ...wire,
          blockIdentity: blockIdentity(this.context, 'thinking', wire.stepId),
        };
        break;
      case 'tool.upserted': {
        const { providerBlock: wireProviderBlock, ...tool } = wire;
        event = {
          ...common,
          ...tool,
          blockIdentity: blockIdentity(this.context, 'tool', wire.callId),
          ...(wireProviderBlock === undefined
            ? {}
            : {
                providerBlock: providerBlock(
                  this.context,
                  wireProviderBlock.blockIndex,
                  {
                    kind: 'tool_call',
                    blockId: wireProviderBlock.blockId,
                    callId: wire.callId,
                    toolName: wire.toolName,
                    arguments: wireProviderBlock.arguments,
                    modelOrderIndex: wire.modelOrderIndex,
                  },
                  receivedAt,
                ),
              }),
        };
        break;
      }
      case 'task.upserted':
        event = {
          ...common,
          ...wire,
          blockIdentity: blockIdentity(this.context, 'task', wire.taskId),
        };
        break;
      case 'approval.upserted':
        event = {
          ...common,
          ...wire,
          blockIdentity: blockIdentity(this.context, 'approval', wire.collaborationId),
        };
        break;
      case 'usage.reported':
        event = {
          ...common,
          type: wire.type,
          providerBlock: providerBlock(
            this.context,
            wire.blockIndex,
            {
              kind: 'usage',
              blockId: wire.blockId,
              inputTokens: wire.inputTokens,
              outputTokens: wire.outputTokens,
              ...(wire.cacheReadTokens === undefined
                ? {}
                : { cacheReadTokens: wire.cacheReadTokens }),
              ...(wire.cacheWriteTokens === undefined
                ? {}
                : { cacheWriteTokens: wire.cacheWriteTokens }),
              totalTokens: wire.totalTokens,
            },
            receivedAt,
          ),
        };
        break;
      case 'response.completed':
        event = {
          ...common,
          type: wire.type,
          terminalState: 'completed',
          partialContentRetained: true,
          providerBlock: providerBlock(
            this.context,
            wire.blockIndex,
            {
              kind: 'completion_anchor',
              blockId: wire.blockId,
              anchorId: wire.anchorId,
              promptFingerprint: wire.promptFingerprint,
              finishReason: wire.finishReason,
            },
            receivedAt,
          ),
        };
        break;
      case 'response.stopped':
        event = {
          ...common,
          type: wire.type,
          terminalState: 'stopped',
          partialContentRetained: true,
          ...(wire.reason === undefined ? {} : { reason: wire.reason }),
          ...(wire.retry === undefined ? {} : { retry: wire.retry }),
        };
        break;
      case 'response.interrupted':
        event = {
          ...common,
          ...wire,
          correlationId: wire.correlationId ?? this.context.identity.requestId,
          terminalState: 'interrupted',
          partialContentRetained: true,
        };
        break;
      case 'response.failed':
        event = {
          ...common,
          ...wire,
          correlationId: wire.correlationId ?? this.context.identity.requestId,
          terminalState: 'failed',
        };
        break;
    }

    const validated = ChatEventPayloadV1Schema.safeParse(event);
    return validated.success
      ? { ok: true, event: validated.data }
      : normalizationError('malformed_frame', 'A proxy stream event could not be normalized.');
  }
}
