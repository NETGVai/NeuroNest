import type { ChatEventPayloadV1, ChatResponseIdentityV1 } from '../harness/contracts/chat-stream-event';
import type { ProxyStreamFrame } from './proxy-stream-decoder';
import {
  StreamEventNormalizer,
  type StreamNormalizationError,
  type StreamNormalizationResult,
} from './stream-event-normalizer';

/**
 * Orders and correlates decoded proxy frames before durable SessionLog append.
 * The proxy's frame index is transport ordering metadata only; SessionLog owns
 * the durable sequence assigned later inside its append transaction.
 *
 * Requirements: 8.1–8.3, 13.8, 15.3–15.5
 */

export const DEFAULT_MAX_PROXY_REORDER_WINDOW = 32;

export interface ProxyFrameCorrelationV1 {
  readonly sessionId: string;
  readonly branchId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly responseId: string;
  readonly requestId: string;
  readonly attempt: number;
}

export interface CorrelatedProxyFrameV1 {
  readonly frameIndex: number;
  readonly idempotencyKey: string;
  readonly correlation: ProxyFrameCorrelationV1;
  readonly frame: ProxyStreamFrame;
}

export interface AcceptedChatStreamEventV1 {
  readonly frameIndex: number;
  readonly idempotencyKey: string;
  readonly event: ChatEventPayloadV1;
}

export type IgnoredProxyFrameReason =
  | 'duplicate_idempotency_key'
  | 'stale_frame'
  | 'mismatched_scope'
  | 'mismatched_request'
  | 'mismatched_entity'
  | 'stale_entity_revision'
  | 'duplicate_terminal'
  | 'disposed_response'
  | 'stream_closed';

export interface IgnoredProxyFrameV1 {
  readonly frameIndex: number;
  readonly reason: IgnoredProxyFrameReason;
}

export type ProxyFrameGuardErrorCode =
  | 'invalid_delivery'
  | 'unrecoverable_gap'
  | StreamNormalizationError['code'];

export interface ProxyFrameGuardErrorV1 {
  readonly code: ProxyFrameGuardErrorCode;
  readonly summary: string;
  readonly recoverable: boolean;
  readonly frameIndex?: number;
}

export interface ProxyFrameGuardResultV1 {
  readonly accepted: readonly AcceptedChatStreamEventV1[];
  readonly ignored: readonly IgnoredProxyFrameV1[];
  readonly errors: readonly ProxyFrameGuardErrorV1[];
  readonly buffered: boolean;
  readonly nextExpectedFrameIndex: number;
}

export interface ChatStreamIngestionGuardOptions {
  readonly maxReorderWindow?: number;
  readonly initialFrameIndex?: number;
}

interface MutableGuardResult {
  accepted: AcceptedChatStreamEventV1[];
  ignored: IgnoredProxyFrameV1[];
  errors: ProxyFrameGuardErrorV1[];
  buffered: boolean;
}

const TERMINAL_TYPES = new Set<ChatEventPayloadV1['type']>([
  'response.completed',
  'response.stopped',
  'response.interrupted',
  'response.failed',
]);

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function correlationFrom(identity: ChatResponseIdentityV1): ProxyFrameCorrelationV1 {
  return {
    sessionId: identity.sourceIdentity.sessionId,
    branchId: identity.sourceIdentity.branchId,
    conversationId: identity.conversationId,
    turnId: identity.turnId,
    responseId: identity.responseId,
    requestId: identity.requestId,
    attempt: identity.attempt,
  };
}

function entityIdentity(event: ChatEventPayloadV1): { id: string; revision?: number } | undefined {
  switch (event.type) {
    case 'thinking.step.upserted':
      return { id: event.stepId, revision: event.revision };
    case 'tool.upserted':
      return { id: event.callId, revision: event.revision };
    case 'task.upserted':
      return { id: event.taskId, revision: event.revision };
    case 'approval.upserted':
      return { id: event.collaborationId, revision: event.revision };
    case 'answer.delta':
    case 'reasoning.delta':
    case 'block.error':
      return { id: event.blockIdentity.sourceIdentity.entityId };
    default:
      return undefined;
  }
}

function expectedBlockEntityId(event: ChatEventPayloadV1): string | undefined {
  switch (event.type) {
    case 'thinking.step.upserted':
      return event.stepId;
    case 'tool.upserted':
      return event.callId;
    case 'task.upserted':
      return event.taskId;
    case 'approval.upserted':
      return event.collaborationId;
    case 'answer.delta':
    case 'reasoning.delta':
      return event.providerBlock.block.blockId;
    default:
      return undefined;
  }
}

/** Stateful per network request; do not share an instance between requests. */
export class ChatStreamIngestionGuard {
  private readonly expectedCorrelation: ProxyFrameCorrelationV1;
  private readonly maxReorderWindow: number;
  private readonly bufferedFrames = new Map<number, CorrelatedProxyFrameV1>();
  private readonly observedIdempotencyKeys = new Set<string>();
  private readonly entityRevisions = new Map<string, number>();
  private nextExpectedFrameIndex: number;
  private terminalAccepted = false;
  private closed = false;

  constructor(
    private readonly normalizer: StreamEventNormalizer,
    identity: ChatResponseIdentityV1,
    options: ChatStreamIngestionGuardOptions = {},
  ) {
    this.expectedCorrelation = correlationFrom(identity);
    this.maxReorderWindow = positiveInteger(
      options.maxReorderWindow,
      DEFAULT_MAX_PROXY_REORDER_WINDOW,
    );
    this.nextExpectedFrameIndex = nonNegativeInteger(options.initialFrameIndex, 0);
  }

  accept(delivery: CorrelatedProxyFrameV1): ProxyFrameGuardResultV1 {
    const result: MutableGuardResult = { accepted: [], ignored: [], errors: [], buffered: false };

    if (this.closed) {
      result.ignored.push({ frameIndex: delivery.frameIndex, reason: 'stream_closed' });
      return this.complete(result);
    }

    if (!this.validDelivery(delivery)) {
      result.errors.push({
        code: 'invalid_delivery',
        summary: 'A proxy frame had invalid ordering metadata.',
        recoverable: false,
      });
      return this.complete(result);
    }

    const correlationReason = this.correlationMismatch(delivery.correlation);
    if (correlationReason !== undefined) {
      result.ignored.push({ frameIndex: delivery.frameIndex, reason: correlationReason });
      return this.complete(result);
    }

    if (this.observedIdempotencyKeys.has(delivery.idempotencyKey)) {
      result.ignored.push({
        frameIndex: delivery.frameIndex,
        reason: 'duplicate_idempotency_key',
      });
      return this.complete(result);
    }

    if (delivery.frameIndex < this.nextExpectedFrameIndex) {
      result.ignored.push({ frameIndex: delivery.frameIndex, reason: 'stale_frame' });
      return this.complete(result);
    }

    if (delivery.frameIndex > this.nextExpectedFrameIndex) {
      const gap = delivery.frameIndex - this.nextExpectedFrameIndex;
      if (gap > this.maxReorderWindow || this.bufferedFrames.size >= this.maxReorderWindow) {
        this.rejectGap(result, delivery.frameIndex);
        return this.complete(result);
      }
      if (this.bufferedFrames.has(delivery.frameIndex)) {
        result.ignored.push({ frameIndex: delivery.frameIndex, reason: 'stale_frame' });
        return this.complete(result);
      }
      this.bufferedFrames.set(delivery.frameIndex, delivery);
      this.observedIdempotencyKeys.add(delivery.idempotencyKey);
      result.buffered = true;
      return this.complete(result);
    }

    this.observedIdempotencyKeys.add(delivery.idempotencyKey);
    this.processInOrder(delivery, result);
    this.nextExpectedFrameIndex += 1;

    while (!this.closed) {
      const buffered = this.bufferedFrames.get(this.nextExpectedFrameIndex);
      if (buffered === undefined) break;
      this.bufferedFrames.delete(this.nextExpectedFrameIndex);
      this.processInOrder(buffered, result);
      this.nextExpectedFrameIndex += 1;
    }

    result.buffered = this.bufferedFrames.size > 0;
    return this.complete(result);
  }

  /** Reject a trailing missing frame when the transport closes. */
  finish(): ProxyFrameGuardResultV1 {
    const result: MutableGuardResult = { accepted: [], ignored: [], errors: [], buffered: false };
    if (!this.closed && this.bufferedFrames.size > 0) {
      const firstBuffered = Math.min(...this.bufferedFrames.keys());
      this.rejectGap(result, firstBuffered);
    } else {
      this.closed = true;
    }
    return this.complete(result);
  }

  private validDelivery(delivery: CorrelatedProxyFrameV1): boolean {
    return (
      Number.isSafeInteger(delivery.frameIndex) &&
      delivery.frameIndex >= 0 &&
      delivery.idempotencyKey.length > 0 &&
      delivery.idempotencyKey.length <= 512
    );
  }

  private correlationMismatch(
    actual: ProxyFrameCorrelationV1,
  ): 'mismatched_scope' | 'mismatched_request' | undefined {
    if (
      actual.sessionId !== this.expectedCorrelation.sessionId ||
      actual.branchId !== this.expectedCorrelation.branchId
    ) {
      return 'mismatched_scope';
    }
    if (
      actual.conversationId !== this.expectedCorrelation.conversationId ||
      actual.turnId !== this.expectedCorrelation.turnId ||
      actual.responseId !== this.expectedCorrelation.responseId ||
      actual.requestId !== this.expectedCorrelation.requestId ||
      actual.attempt !== this.expectedCorrelation.attempt
    ) {
      return 'mismatched_request';
    }
    return undefined;
  }

  private processInOrder(delivery: CorrelatedProxyFrameV1, result: MutableGuardResult): void {
    const normalized = this.normalizer.normalizeFrame(delivery.frame);
    if (!normalized.ok) {
      this.recordNormalizationError(normalized, delivery.frameIndex, result);
      return;
    }

    const event = normalized.event;
    if (this.terminalAccepted) {
      result.ignored.push({
        frameIndex: delivery.frameIndex,
        reason: TERMINAL_TYPES.has(event.type) ? 'duplicate_terminal' : 'disposed_response',
      });
      return;
    }

    const expectedEntityId = expectedBlockEntityId(event);
    if (
      expectedEntityId !== undefined &&
      'blockIdentity' in event &&
      event.blockIdentity.sourceIdentity.entityId !== expectedEntityId
    ) {
      result.ignored.push({ frameIndex: delivery.frameIndex, reason: 'mismatched_entity' });
      return;
    }

    const entity = entityIdentity(event);
    if (entity?.revision !== undefined) {
      const revisionKey = `${event.type}\u0000${entity.id}`;
      const currentRevision = this.entityRevisions.get(revisionKey);
      if (currentRevision !== undefined && entity.revision <= currentRevision) {
        result.ignored.push({
          frameIndex: delivery.frameIndex,
          reason: 'stale_entity_revision',
        });
        return;
      }
      this.entityRevisions.set(revisionKey, entity.revision);
    }

    if (TERMINAL_TYPES.has(event.type)) this.terminalAccepted = true;
    result.accepted.push({
      frameIndex: delivery.frameIndex,
      idempotencyKey: delivery.idempotencyKey,
      event,
    });
  }

  private recordNormalizationError(
    normalized: Extract<StreamNormalizationResult, { ok: false }>,
    frameIndex: number,
    result: MutableGuardResult,
  ): void {
    result.errors.push({ ...normalized.error, frameIndex });
  }

  private rejectGap(result: MutableGuardResult, frameIndex: number): void {
    this.closed = true;
    this.bufferedFrames.clear();
    result.errors.push({
      code: 'unrecoverable_gap',
      summary: 'The proxy stream contained an unrecoverable frame gap.',
      recoverable: false,
      frameIndex,
    });
  }

  private complete(result: MutableGuardResult): ProxyFrameGuardResultV1 {
    return {
      ...result,
      nextExpectedFrameIndex: this.nextExpectedFrameIndex,
    };
  }
}
