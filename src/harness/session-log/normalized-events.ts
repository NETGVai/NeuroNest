import { createHash } from 'node:crypto';
import { ActorRefSchema, type ActorRef } from '../contracts/actor.js';
import {
  ChatEventEnvelopeV1Schema,
  ChatEventPayloadV1Schema,
  type ChatEventEnvelopeV1,
  type ChatEventPayloadV1,
} from '../contracts/chat-stream-event.js';
import type { SessionEventPayloadV1 } from '../contracts/event.js';
import { TimestampSchema } from '../contracts/primitives.js';
import { ScopeDescriptorV1Schema, type ScopeDescriptorV1 } from '../contracts/scope.js';
import type { SessionLog } from './session-log.js';
import type { AppendReceipt, AtomicEventBatchCommand } from './types.js';

/**
 * Durable fact kinds accepted from the production legacy-response boundary.
 * Presentation-only state is intentionally absent from this closed list.
 */
export type NormalizedSessionEventTypeV1 =
  | 'message.assistant'
  | 'assistant.state'
  | 'assistant.delta'
  | 'assistant.reasoning'
  | 'retry'
  | 'error'
  | 'connection.state'
  | 'response.block'
  | 'response.action'
  | 'response.artifact'
  | 'turn.tail';

export interface NormalizedChatEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventType: NormalizedSessionEventTypeV1;
  readonly sessionId: string;
  readonly branchId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly attempt: number;
  readonly logicalSequence: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Compatibility shape emitted by pre-versioned normalization prototypes.
 * It is accepted only through the explicit V0 -> V1 upcaster below.
 */
export interface NormalizedChatEventV0 {
  readonly schemaVersion: 0;
  readonly eventId: string;
  readonly eventType: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly attempt?: number;
  readonly logicalSequence?: number;
  readonly occurredAt?: string;
  readonly timestamp?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type NormalizedChatEventInput = NormalizedChatEventV0 | NormalizedChatEventV1;

export interface NormalizedAppendContext {
  readonly actor: ActorRef;
  readonly scope: ScopeDescriptorV1;
}

/**
 * A lifecycle event accepted by ordering/correlation guards and ready for the
 * durable authority boundary. The source idempotency key is scoped and hashed
 * before storage so untrusted transport metadata never becomes event identity.
 */
export interface AcceptedChatLifecycleEventV1 {
  readonly idempotencyKey: string;
  readonly event: ChatEventPayloadV1;
  readonly occurredAt?: string;
}

/**
 * The output shape produced by ChatStreamIngestionGuard.accept() (task 7.3).
 *
 * The guard emits events already sorted by canonical frame order and scoped
 * to one correlated request. `frameIndex` is transport-only ordering metadata
 * and is deliberately not carried into durable storage; SessionLog assigns
 * its own transactional sequence when the batch commits.
 */
export interface AcceptedChatStreamEventV1Like {
  readonly frameIndex: number;
  readonly idempotencyKey: string;
  readonly event: ChatEventPayloadV1;
  readonly occurredAt?: string;
}

export interface DurableChatLifecycleAppendResult {
  readonly receipts: readonly AppendReceipt[];
  /** Newly committed events only, in SessionLog sequence order. */
  readonly committedEvents: readonly ChatEventEnvelopeV1[];
  /**
   * Error raised by a projection observer after the durable commit completed.
   * When present, the append itself is authoritative: `receipts` and
   * `committedEvents` describe the persisted state and callers may resume
   * projection from the SessionLog. Absent when no observer was invoked or the
   * observer completed cleanly.
   */
  readonly observerError?: Error;
}

/** Invoked synchronously only after the append transaction has committed. */
export type CommittedChatLifecycleObserver = (
  events: readonly ChatEventEnvelopeV1[],
) => void;

/**
 * Behavior when a projection observer throws after a successful commit.
 *
 * `rethrow` (default) preserves compatibility with existing callers that treat
 * observer failures as a caller-visible signal. `isolate` returns the observer
 * error inside the result so the durable commit is not obscured by a
 * projection-side failure; callers can inspect `observerError` and choose
 * whether to retry notification.
 */
export type ChatLifecycleObserverErrorPolicy = 'rethrow' | 'isolate';

export interface AppendAcceptedChatLifecycleOptions {
  readonly observerErrorPolicy?: ChatLifecycleObserverErrorPolicy;
}

const LEGACY_EVENT_TYPE_MAP: Readonly<Record<string, NormalizedSessionEventTypeV1>> = {
  'assistant.token': 'assistant.delta',
  'assistant.thought': 'assistant.reasoning',
  connection: 'connection.state',
  'structured.block': 'response.block',
  action: 'response.action',
  artifact: 'response.artifact',
  terminal: 'turn.tail',
};

const EVENT_TYPES = new Set<NormalizedSessionEventTypeV1>([
  'message.assistant',
  'assistant.state',
  'assistant.delta',
  'assistant.reasoning',
  'retry',
  'error',
  'connection.state',
  'response.block',
  'response.action',
  'response.artifact',
  'turn.tail',
]);

const RENDERER_LOCAL_KEYS = new Set([
  'uiState',
  'rendererState',
  'focusState',
  'disclosureState',
  'measurementState',
  'scrollState',
]);

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new Error(`Normalized event ${field} must not be empty`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Normalized event ${field} must be a non-negative integer`);
  }
  return value;
}

function canonicalEventType(eventType: string): NormalizedSessionEventTypeV1 {
  const mapped = LEGACY_EVENT_TYPE_MAP[eventType] ?? eventType;
  if (!EVENT_TYPES.has(mapped as NormalizedSessionEventTypeV1)) {
    throw new Error(`Unsupported normalized event type: ${eventType}`);
  }
  return mapped as NormalizedSessionEventTypeV1;
}

function withoutRendererState(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key, value]) =>
      !RENDERER_LOCAL_KEYS.has(key) && value !== undefined
    ),
  );
}

function upcastPayload(
  eventType: NormalizedSessionEventTypeV1,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const clean = withoutRendererState(payload);
  switch (eventType) {
    case 'assistant.delta':
      return { ...clean, text: clean.text ?? clean.token ?? clean.content ?? '' };
    case 'assistant.reasoning':
      return { ...clean, text: clean.text ?? clean.reasoning ?? clean.content ?? '' };
    case 'assistant.state':
      return { ...clean, state: clean.state ?? clean.activityState ?? 'unknown' };
    case 'connection.state':
      return { ...clean, state: clean.state ?? clean.connectionState ?? 'unknown' };
    case 'turn.tail':
      return { ...clean, outcome: clean.outcome ?? clean.state ?? 'completed' };
    default:
      return clean;
  }
}

/** Upcast one normalized compatibility event without changing its durable identity. */
export function upcastNormalizedChatEvent(input: NormalizedChatEventInput): NormalizedChatEventV1 {
  if (input.schemaVersion === 1) {
    canonicalEventType(input.eventType);
    return {
      ...input,
      eventId: requireNonEmpty(input.eventId, 'eventId'),
      sessionId: requireNonEmpty(input.sessionId, 'sessionId'),
      branchId: requireNonEmpty(input.branchId, 'branchId'),
      turnId: requireNonEmpty(input.turnId, 'turnId'),
      messageId: requireNonEmpty(input.messageId, 'messageId'),
      attempt: requireNonNegativeInteger(input.attempt, 'attempt'),
      logicalSequence: requireNonNegativeInteger(input.logicalSequence, 'logicalSequence'),
      payload: withoutRendererState(input.payload),
    };
  }

  const eventType = canonicalEventType(input.eventType);
  return {
    schemaVersion: 1,
    eventId: requireNonEmpty(input.eventId, 'eventId'),
    eventType,
    sessionId: requireNonEmpty(input.sessionId, 'sessionId'),
    branchId: requireNonEmpty(input.branchId ?? 'main', 'branchId'),
    turnId: requireNonEmpty(input.turnId, 'turnId'),
    messageId: requireNonEmpty(input.messageId, 'messageId'),
    attempt: requireNonNegativeInteger(input.attempt ?? 0, 'attempt'),
    logicalSequence: requireNonNegativeInteger(input.logicalSequence ?? 0, 'logicalSequence'),
    occurredAt: requireNonEmpty(
      input.occurredAt ?? input.timestamp ?? '1970-01-01T00:00:00.000Z',
      'occurredAt',
    ),
    payload: upcastPayload(eventType, input.payload),
  };
}

function canonicalPayload(event: NormalizedChatEventV1): SessionEventPayloadV1 {
  const payload = withoutRendererState(event.payload);
  const common = {
    type: event.eventType,
    normalizedEventId: event.eventId,
    turnId: event.turnId,
    messageId: event.messageId,
    attempt: event.attempt,
    logicalSequence: event.logicalSequence,
  };

  switch (event.eventType) {
    case 'message.assistant':
      return {
        ...common,
        text: payload.text ?? payload.content ?? '',
        finalized: payload.finalized === true,
        provider: payload.provider,
        model: payload.model,
        agent: payload.agent,
      };
    case 'assistant.state':
      return {
        ...common,
        activityState: payload.activityState ?? payload.state ?? 'unknown',
        reason: payload.reason,
      };
    case 'assistant.delta':
      return {
        ...common,
        text: payload.text ?? payload.content ?? payload.token ?? '',
        ordinal: payload.ordinal,
        partial: payload.partial,
        source: payload.source,
      };
    case 'assistant.reasoning':
      return {
        ...common,
        text: payload.text ?? payload.content ?? payload.reasoning ?? '',
        ordinal: payload.ordinal,
        category: payload.category ?? 'summary',
        protected: payload.protected,
      };
    case 'connection.state':
      return {
        ...common,
        connectionState: payload.connectionState ?? payload.state ?? 'unknown',
        attemptCount: payload.attemptCount,
        affectedCapabilities: payload.affectedCapabilities,
        cancellationAvailable: payload.cancellationAvailable,
      };
    case 'retry':
      return {
        ...common,
        originalAnchorId: payload.originalAnchorId ?? event.messageId,
        retryBudget: payload.retryBudget,
        finiteLimit: payload.finiteLimit,
        nextDelayMs: payload.nextDelayMs,
        route: payload.route,
        errorClass: payload.errorClass,
      };
    case 'error':
      return {
        ...common,
        errorId: payload.errorId ?? event.eventId,
        message: payload.message ?? payload.summary ?? 'Assistant response failed',
        errorClass: payload.errorClass ?? 'unknown',
        affectedAuthority: payload.affectedAuthority,
        lastVerifiedState: payload.lastVerifiedState,
        correlationId: payload.correlationId,
        redacted: payload.redacted ?? true,
      };
    case 'turn.tail':
      return {
        ...common,
        outcome: payload.outcome ?? 'completed',
        reason: payload.reason,
      };
    case 'response.block':
      return {
        ...common,
        blockId: payload.blockId,
        blockKind: payload.blockKind,
        operation: payload.operation,
        declaredOrder: payload.declaredOrder,
        contentRevision: payload.contentRevision,
        block: payload.block,
      };
    case 'response.action':
      return {
        ...common,
        actionId: payload.actionId,
        actionKind: payload.actionKind,
        state: payload.state,
        authorityRef: payload.authorityRef,
        action: payload.action,
      };
    case 'response.artifact':
      return {
        ...common,
        artifactId: payload.artifactId,
        artifactKind: payload.artifactKind,
        state: payload.state,
        detailLocator: payload.detailLocator,
        artifact: payload.artifact,
      };
  }
}

/** Map a normalized fact to the existing SessionLog atomic append contract. */
export function mapNormalizedChatEvent(
  input: NormalizedChatEventInput,
  context: NormalizedAppendContext,
): AtomicEventBatchCommand['events'][number] & { sessionId: string; branchId: string } {
  const event = upcastNormalizedChatEvent(input);
  return {
    sessionId: event.sessionId,
    branchId: event.branchId,
    eventId: event.eventId,
    eventType: event.eventType,
    payload: canonicalPayload(event),
    actor: context.actor,
    scope: context.scope,
    occurredAt: event.occurredAt,
    idempotencyKey: `normalized:${event.eventId}`,
  };
}

/**
 * Append a normalized fact batch in one transaction.
 *
 * A batch cannot cross a session or branch because doing so would weaken the
 * SessionLog's sequence, hash-chain, and lineage guarantees.
 */
export function appendNormalizedChatEvents(
  log: SessionLog,
  inputs: readonly NormalizedChatEventInput[],
  context: NormalizedAppendContext,
): AppendReceipt[] {
  if (inputs.length === 0) return [];

  const mapped = inputs.map((input) => mapNormalizedChatEvent(input, context));
  const { sessionId, branchId } = mapped[0];
  if (mapped.some((event) => event.sessionId !== sessionId || event.branchId !== branchId)) {
    throw new Error('Normalized event batch must contain exactly one session and branch');
  }

  return log.appendBatch({
    sessionId,
    branchId,
    events: mapped.map(({ sessionId: _sessionId, branchId: _branchId, ...event }) => event),
  });
}

/** Append one normalized fact through the same idempotent batch path. */
export function appendNormalizedChatEvent(
  log: SessionLog,
  input: NormalizedChatEventInput,
  context: NormalizedAppendContext,
): AppendReceipt {
  return appendNormalizedChatEvents(log, [input], context)[0];
}

function durableLifecycleIdentity(input: AcceptedChatLifecycleEventV1): string {
  const identity = input.event.identity;
  return createHash('sha256')
    .update([
      identity.sourceIdentity.sessionId,
      identity.sourceIdentity.branchId,
      identity.requestId,
      String(identity.attempt),
      input.idempotencyKey,
    ].join('\u0000'))
    .digest('hex');
}

function mapAcceptedChatLifecycleEvent(
  input: AcceptedChatLifecycleEventV1,
  context: NormalizedAppendContext,
): AtomicEventBatchCommand['events'][number] & { sessionId: string; branchId: string } {
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 512) {
    throw new Error('Accepted chat lifecycle idempotencyKey must contain 1 to 512 characters');
  }

  const parsedPayload = ChatEventPayloadV1Schema.safeParse(input.event);
  if (!parsedPayload.success) {
    throw new Error('Accepted chat lifecycle event did not match the canonical contract');
  }
  if (input.occurredAt !== undefined && !TimestampSchema.safeParse(input.occurredAt).success) {
    throw new Error('Accepted chat lifecycle occurredAt must be an ISO timestamp');
  }

  const payload = parsedPayload.data;
  const sessionId = payload.identity.sourceIdentity.sessionId;
  const branchId = payload.identity.sourceIdentity.branchId;
  if (context.scope.sessionId !== undefined && context.scope.sessionId !== sessionId) {
    throw new Error('Accepted chat lifecycle event did not match the append scope');
  }

  const durableIdentity = durableLifecycleIdentity({ ...input, event: payload });
  return {
    sessionId,
    branchId,
    eventId: `chat-event:${durableIdentity}`,
    eventType: payload.type,
    payload,
    actor: context.actor,
    scope: context.scope,
    occurredAt: input.occurredAt,
    idempotencyKey: `chat-lifecycle:${durableIdentity}`,
  };
}

/**
 * Atomically append accepted canonical response lifecycle events, then expose
 * only newly committed SessionLog envelopes to projection consumers.
 *
 * Contract:
 *   - The whole batch commits or nothing commits (SessionLog transactional
 *     append). A single event that fails validation, integrity, or persistence
 *     rolls the transaction back and no observer runs.
 *   - Duplicate deliveries (same durable identity) return their original
 *     receipts, are filtered out of `committedEvents`, and do not re-invoke
 *     the observer. This is safe for cancellation, retry, and renderer reload
 *     replays because the durable state is unchanged.
 *   - The observer runs synchronously AFTER the write transaction commits and
 *     AFTER the durable rows have been read back through the SessionLog
 *     boundary. Observers therefore observe only truly persisted events.
 *   - An observer failure never rolls back the commit. By default it is
 *     re-thrown so callers can react; the `isolate` policy captures it in
 *     `observerError` and allows callers to distinguish a durable commit
 *     with a failed projection notification from a durable commit failure.
 *   - Any prefix committed before an atomic append failure is retained
 *     verbatim, preserving partial answers, reasoning, tool activity, task
 *     progress, and approval state across cancellation, transport failure,
 *     and renderer reload.
 */
export function appendAcceptedChatLifecycleEvents(
  log: SessionLog,
  inputs: readonly AcceptedChatLifecycleEventV1[],
  context: NormalizedAppendContext,
  observer?: CommittedChatLifecycleObserver,
  options: AppendAcceptedChatLifecycleOptions = {},
): DurableChatLifecycleAppendResult {
  if (inputs.length === 0) return { receipts: [], committedEvents: [] };
  if (!ActorRefSchema.safeParse(context.actor).success) {
    throw new Error('Accepted chat lifecycle actor was invalid');
  }
  if (!ScopeDescriptorV1Schema.safeParse(context.scope).success) {
    throw new Error('Accepted chat lifecycle scope was invalid');
  }

  const mapped = inputs.map((input) => mapAcceptedChatLifecycleEvent(input, context));
  const { sessionId, branchId } = mapped[0];
  if (mapped.some((event) => event.sessionId !== sessionId || event.branchId !== branchId)) {
    throw new Error('Accepted chat lifecycle batch must contain exactly one session and branch');
  }

  const receipts = log.appendBatch({
    sessionId,
    branchId,
    events: mapped.map(({ sessionId: _sessionId, branchId: _branchId, ...event }) => event),
  });
  const committedReceipts = receipts.filter((receipt) => !receipt.alreadyExists);
  if (committedReceipts.length === 0) {
    return { receipts, committedEvents: [] };
  }

  const committedIds = new Set(committedReceipts.map((receipt) => receipt.eventId));
  const firstSequence = Math.min(...committedReceipts.map((receipt) => receipt.sequence));
  const lastSequence = Math.max(...committedReceipts.map((receipt) => receipt.sequence));
  const committedEvents = log.readRange({
    sessionId,
    branchId,
    fromSequence: firstSequence,
    toSequence: lastSequence,
  }).filter((event) => committedIds.has(event.eventId)).map((event) => {
    const parsed = ChatEventEnvelopeV1Schema.safeParse(event);
    if (!parsed.success) {
      throw new Error('Committed chat lifecycle event failed durable read-back validation');
    }
    return parsed.data;
  });

  if (committedEvents.length !== committedReceipts.length) {
    throw new Error('Committed chat lifecycle events could not be read back completely');
  }

  if (observer === undefined) {
    return { receipts, committedEvents };
  }

  const policy: ChatLifecycleObserverErrorPolicy =
    options.observerErrorPolicy ?? 'rethrow';
  try {
    observer(committedEvents);
    return { receipts, committedEvents };
  } catch (rawError) {
    const observerError = rawError instanceof Error ? rawError : new Error(String(rawError));
    if (policy === 'rethrow') throw observerError;
    return { receipts, committedEvents, observerError };
  }
}

/**
 * Convenience adapter: durably append the output of `ChatStreamIngestionGuard`
 * (task 7.3) using the same atomic-and-idempotent boundary as
 * `appendAcceptedChatLifecycleEvents`.
 *
 * The guard already correlates events to one request, orders them by frame
 * index, and rejects duplicates. This adapter preserves that array order,
 * discards the transport-only frame index, and forwards each event with its
 * scoped idempotency key so retries or replays remain safe.
 */
export function appendAcceptedChatStreamEvents(
  log: SessionLog,
  inputs: readonly AcceptedChatStreamEventV1Like[],
  context: NormalizedAppendContext,
  observer?: CommittedChatLifecycleObserver,
  options: AppendAcceptedChatLifecycleOptions = {},
): DurableChatLifecycleAppendResult {
  const lifecycleInputs: AcceptedChatLifecycleEventV1[] = inputs.map((input) => ({
    idempotencyKey: input.idempotencyKey,
    event: input.event,
    occurredAt: input.occurredAt,
  }));
  return appendAcceptedChatLifecycleEvents(
    log,
    lifecycleInputs,
    context,
    observer,
    options,
  );
}
