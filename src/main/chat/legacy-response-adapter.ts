import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/**
 * Shipped renderer channels accepted at the main-process compatibility boundary.
 *
 * `chat:stream-chunk` is a dispatch-side streaming channel that carries the same
 * logical event families as `chat:stream`/`chat:done`/`chat:error` combined
 * into one payload shape (`{ start, chunk, done, error }`). Every legacy channel
 * feeds the same canonical ingestion path in `legacy-canonical-ingestion.ts`;
 * none of these channels may be rendered directly by the renderer.
 */
export const LegacyEventChannelSchema = z.enum([
  'chat-response',
  'chat:stream',
  'chat:done',
  'chat:error',
  'chat:stream-chunk',
]);

export const LegacyEventFamilySchema = z.enum([
  'start',
  'token',
  'reasoning',
  'completion',
  'cancellation',
  'error',
  'retry',
  'reconnect',
  'duplicate_delivery',
]);

const LegacyIdentitySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]*$/, 'must be an opaque legacy identity');
const LegacyLabelSchema = z.string().min(1).max(256);
const LegacyTimestampSchema = z.string().datetime({ offset: true });
const LegacyPayloadObjectSchema = z.object({}).passthrough();

export const LegacyStartPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  start: z.boolean().optional(),
});

export const LegacyTokenPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  token: z.string().optional(),
  delta: z.string().optional(),
  content: z.string().optional(),
  chunk: z.string().optional(),
}).superRefine((value, context) => {
  if (
    value.token === undefined &&
    value.delta === undefined &&
    value.content === undefined &&
    value.chunk === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'token payload requires token, delta, content, or chunk',
    });
  }
});

export const LegacyReasoningPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  reasoning: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
}).superRefine((value, context) => {
  if (value.reasoning === undefined && value.summary === undefined && value.content === undefined) {
    context.addIssue({ code: 'custom', message: 'reasoning payload requires reasoning, summary, or content' });
  }
});

export const LegacyCompletionPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  content: z.string().optional(),
  usage: z.unknown().optional(),
  reasoning: z.string().optional(),
});

export const LegacyCancellationPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  reason: z.string().optional(),
  partial: z.string().optional(),
  cancelled: z.boolean().optional(),
});

export const LegacyErrorPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  error: z.string().optional(),
  message: z.string().optional(),
  partial: z.string().optional(),
}).superRefine((value, context) => {
  if (value.error === undefined && value.message === undefined) {
    context.addIssue({ code: 'custom', message: 'error payload requires error or message' });
  }
});

export const LegacyRetryPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  attempt: z.number().int().nonnegative().optional(),
  nextAttempt: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  budget: z.number().nonnegative().optional(),
  delayMs: z.number().nonnegative().optional(),
  errorClass: z.string().max(256).optional(),
});

export const LegacyReconnectPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  state: z.enum(['reconnecting', 'restored', 'interrupted']).optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  capabilities: z.array(z.string().max(128)).max(128).optional(),
  cancellationAvailable: z.boolean().optional(),
});

export const LegacyDuplicateDeliveryPayloadV1Schema = LegacyPayloadObjectSchema.extend({
  originalDeliveryId: LegacyIdentitySchema.optional(),
});

const envelopeBase = z.object({
  schemaVersion: z.literal(1),
  deliveryId: LegacyIdentitySchema,
  channel: LegacyEventChannelSchema,
  sessionId: LegacyIdentitySchema,
  branchId: LegacyIdentitySchema,
  turnId: LegacyIdentitySchema,
  messageId: LegacyIdentitySchema,
  attempt: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative().optional(),
  occurredAt: LegacyTimestampSchema,
  occurrence: z.number().int().positive(),
  agent: LegacyLabelSchema.optional(),
  provider: LegacyLabelSchema.optional(),
  model: LegacyLabelSchema.optional(),
});

export const LegacyFamilyEnvelopeSchemas = {
  start: envelopeBase.extend({ family: z.literal('start'), payload: LegacyStartPayloadV1Schema }).strict(),
  token: envelopeBase.extend({ family: z.literal('token'), payload: LegacyTokenPayloadV1Schema }).strict(),
  reasoning: envelopeBase.extend({ family: z.literal('reasoning'), payload: LegacyReasoningPayloadV1Schema }).strict(),
  completion: envelopeBase.extend({ family: z.literal('completion'), payload: LegacyCompletionPayloadV1Schema }).strict(),
  cancellation: envelopeBase.extend({ family: z.literal('cancellation'), payload: LegacyCancellationPayloadV1Schema }).strict(),
  error: envelopeBase.extend({ family: z.literal('error'), payload: LegacyErrorPayloadV1Schema }).strict(),
  retry: envelopeBase.extend({ family: z.literal('retry'), payload: LegacyRetryPayloadV1Schema }).strict(),
  reconnect: envelopeBase.extend({ family: z.literal('reconnect'), payload: LegacyReconnectPayloadV1Schema }).strict(),
  duplicate_delivery: envelopeBase.extend({ family: z.literal('duplicate_delivery'), payload: LegacyDuplicateDeliveryPayloadV1Schema }).strict(),
} as const;

const FAMILY_CHANNELS = {
  start: new Set(['chat-response', 'chat:stream', 'chat:stream-chunk']),
  token: new Set(['chat-response', 'chat:stream', 'chat:stream-chunk']),
  reasoning: new Set(['chat-response', 'chat:stream', 'chat:done', 'chat:stream-chunk']),
  completion: new Set(['chat-response', 'chat:done', 'chat:stream-chunk']),
  cancellation: new Set(['chat-response', 'chat:done', 'chat:error', 'chat:stream-chunk']),
  error: new Set(['chat-response', 'chat:error', 'chat:stream-chunk']),
  retry: new Set(['chat-response', 'chat:error']),
  reconnect: new Set(['chat-response', 'chat:stream', 'chat:done', 'chat:error', 'chat:stream-chunk']),
  duplicate_delivery: new Set([
    'chat-response',
    'chat:stream',
    'chat:done',
    'chat:error',
    'chat:stream-chunk',
  ]),
} satisfies Record<LegacyEventFamily, ReadonlySet<string>>;

export type LegacyEventChannel = z.infer<typeof LegacyEventChannelSchema>;
export type LegacyEventFamily = z.infer<typeof LegacyEventFamilySchema>;
export type LegacyEventEnvelopeV1 = z.infer<(typeof LegacyFamilyEnvelopeSchemas)[LegacyEventFamily]>;

export const LegacyAdapterDiagnosticV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    diagnosticId: LegacyIdentitySchema,
    correlationId: LegacyIdentitySchema,
    reasonCode: z.enum([
      'INVALID_CONTRACT',
      'UNSUPPORTED_VERSION',
      'MISSING_REQUIRED_FIELD',
      'UNSUPPORTED_FAMILY_CHANNEL',
    ]),
    scope: z.literal('legacy_event_envelope'),
    severity: z.literal('error'),
    channel: LegacyEventChannelSchema.optional(),
    family: LegacyEventFamilySchema.optional(),
    observedSize: z.number().int().nonnegative().max(10_000_000).optional(),
    occurrences: z.literal(1),
  })
  .strict();

export type LegacyAdapterDiagnosticV1 = z.infer<typeof LegacyAdapterDiagnosticV1Schema>;

export interface LegacyIngressContextV1 {
  /** Stable main-process ingress scope, for example a BrowserWindow or dispatch identity. */
  ingressScopeId?: string;
  sessionId?: string;
  branchId?: string;
  turnId?: string;
  messageId?: string;
  attempt?: number;
  /** Stable hint for a currently active legacy turn when neither turn nor message IDs exist. */
  correlationHint?: string;
}

export interface LegacyCorrelationKey {
  sessionId: string;
  branchId: string;
  turnId: string;
  messageId: string;
  attempt: number;
}

export interface LegacyCorrelationRecord extends LegacyCorrelationKey {
  correlationKey: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  occurrences: number;
  providers: readonly string[];
  models: readonly string[];
  agents: readonly string[];
  channels: readonly LegacyEventChannel[];
  ordinals: readonly number[];
  firstFamily: LegacyEventFamily;
  lastFamily: LegacyEventFamily;
}

export type LegacyEnvelopeParseResult =
  | { accepted: true; envelope: LegacyEventEnvelopeV1; correlation: LegacyCorrelationRecord }
  | { accepted: false; diagnostic: LegacyAdapterDiagnosticV1 };

export type LegacyIdentityKind = 'delivery' | 'session' | 'branch' | 'turn' | 'message';

export interface LegacyResponseAdapterOptions {
  identityFactory?: (kind: LegacyIdentityKind) => string;
  clock?: () => Date;
  defaultIngressScopeId?: string;
}

const ingressMetadataSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    deliveryId: LegacyIdentitySchema.optional(),
    sessionId: LegacyIdentitySchema.optional(),
    branchId: LegacyIdentitySchema.optional(),
    turnId: LegacyIdentitySchema.optional(),
    messageId: LegacyIdentitySchema.optional(),
    attempt: z.number().int().nonnegative().optional(),
    ordinal: z.number().int().nonnegative().optional(),
    occurredAt: LegacyTimestampSchema.optional(),
    occurrence: z.number().int().positive().optional(),
    agent: LegacyLabelSchema.optional(),
    provider: LegacyLabelSchema.optional(),
    model: LegacyLabelSchema.optional(),
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function boundedObservedSize(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Math.min(serialized.length, 10_000_000);
  } catch {
    return undefined;
  }
}

function inferFamily(channel: LegacyEventChannel, raw: Record<string, unknown>): LegacyEventFamily {
  const explicit = LegacyEventFamilySchema.safeParse(raw.family);
  if (explicit.success) return explicit.data;
  if (raw.duplicateDelivery === true || raw.duplicate_delivery === true) return 'duplicate_delivery';
  if (raw.cancelled === true || raw.canceled === true) return 'cancellation';
  if (raw.retry === true || raw.nextAttempt !== undefined) return 'retry';
  if (raw.reconnect === true || raw.reconnecting === true) return 'reconnect';

  if (channel === 'chat:stream') {
    if (raw.start === true || (raw.token === '' && raw.start !== false)) return 'start';
    if (raw.reasoning !== undefined && raw.token === undefined) return 'reasoning';
    return 'token';
  }
  if (channel === 'chat:stream-chunk') {
    // DispatchBridge encodes lifecycle transitions inside one channel using
    // { start, done, error, chunk } payload discriminators. Reasoning arrives
    // alongside a done flag; error carries a string error field.
    if (raw.error !== undefined) return 'error';
    if (raw.done === true) return 'completion';
    if (raw.start === true) return 'start';
    if (raw.reasoning !== undefined && raw.chunk === undefined && raw.token === undefined) {
      return 'reasoning';
    }
    return 'token';
  }
  if (channel === 'chat:done') return 'completion';
  if (channel === 'chat:error') return 'error';
  if (raw.error !== undefined) return 'error';
  if (raw.reasoning !== undefined && raw.content === undefined) return 'reasoning';
  if (raw.streaming === true && raw.done !== true) return raw.start === true ? 'start' : 'token';
  return 'completion';
}

function copyRecord(record: MutableCorrelationRecord): LegacyCorrelationRecord {
  return {
    sessionId: record.sessionId,
    branchId: record.branchId,
    turnId: record.turnId,
    messageId: record.messageId,
    attempt: record.attempt,
    correlationKey: record.correlationKey,
    firstOccurredAt: record.firstOccurredAt,
    lastOccurredAt: record.lastOccurredAt,
    occurrences: record.occurrences,
    providers: [...record.providers],
    models: [...record.models],
    agents: [...record.agents],
    channels: [...record.channels],
    ordinals: [...record.ordinals],
    firstFamily: record.firstFamily,
    lastFamily: record.lastFamily,
  };
}

interface MutableCorrelationRecord extends LegacyCorrelationKey {
  correlationKey: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  occurrences: number;
  providers: Set<string>;
  models: Set<string>;
  agents: Set<string>;
  channels: Set<LegacyEventChannel>;
  ordinals: Set<number>;
  firstFamily: LegacyEventFamily;
  lastFamily: LegacyEventFamily;
  latestProvider?: string;
  latestModel?: string;
  latestAgent?: string;
}

/**
 * Main-process compatibility boundary for legacy chat event identities.
 *
 * This class intentionally owns only ephemeral correlation records. It does not
 * normalize facts, deduplicate deliveries, persist messages, or project nodes;
 * those responsibilities are implemented by later migration tasks.
 */
export class LegacyResponseAdapter {
  private readonly identityFactory: (kind: LegacyIdentityKind) => string;
  private readonly clock: () => Date;
  private readonly defaultIngressScopeId: string;
  private readonly assignedSessions = new Map<string, string>();
  private readonly assignedBranches = new Map<string, string>();
  private readonly assignedTurns = new Map<string, string>();
  private readonly assignedMessages = new Map<string, string>();
  private readonly deliveryByObject = new WeakMap<object, string>();
  private readonly correlations = new Map<string, MutableCorrelationRecord>();
  private diagnosticSequence = 0;

  constructor(options: LegacyResponseAdapterOptions = {}) {
    this.identityFactory = options.identityFactory ?? ((kind) => `legacy-${kind}-${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date());
    this.defaultIngressScopeId = options.defaultIngressScopeId ?? 'main-chat-ingress';
  }

  accept(
    raw: unknown,
    channel: string,
    context: LegacyIngressContextV1 = {},
  ): LegacyEnvelopeParseResult {
    return this.parseEnvelope(raw, channel, context);
  }

  parseEnvelope(
    raw: unknown,
    channelInput: string,
    context: LegacyIngressContextV1 = {},
  ): LegacyEnvelopeParseResult {
    const channelResult = LegacyEventChannelSchema.safeParse(channelInput);
    if (!channelResult.success || !isRecord(raw)) {
      return this.reject(raw, 'INVALID_CONTRACT', channelResult.success ? channelResult.data : undefined);
    }
    const channel = channelResult.data;

    let family: LegacyEventFamily;
    try {
      family = inferFamily(channel, raw);
    } catch {
      return this.reject(raw, 'INVALID_CONTRACT', channel);
    }

    if (!FAMILY_CHANNELS[family].has(channel)) {
      return this.reject(raw, 'UNSUPPORTED_FAMILY_CHANNEL', channel, family);
    }

    const rawPayload = isRecord(raw.payload) ? raw.payload : raw;
    const payloadResult = LegacyFamilyEnvelopeSchemas[family].shape.payload.safeParse(rawPayload);
    if (!payloadResult.success) {
      return this.reject(raw, 'INVALID_CONTRACT', channel, family);
    }

    const rawMessageId = firstDefined(ownValue(raw, 'messageId'), ownValue(raw, 'msgId'));
    const metadataResult = ingressMetadataSchema.safeParse({
      schemaVersion: ownValue(raw, 'schemaVersion'),
      deliveryId: ownValue(raw, 'deliveryId'),
      sessionId: ownValue(raw, 'sessionId'),
      branchId: ownValue(raw, 'branchId'),
      turnId: ownValue(raw, 'turnId'),
      messageId: rawMessageId,
      attempt: ownValue(raw, 'attempt'),
      ordinal: ownValue(raw, 'ordinal'),
      occurredAt: ownValue(raw, 'occurredAt'),
      occurrence: ownValue(raw, 'occurrence'),
      agent: ownValue(raw, 'agent'),
      provider: ownValue(raw, 'provider'),
      model: ownValue(raw, 'model'),
    });
    if (!metadataResult.success) {
      const unsupportedVersion = ownValue(raw, 'schemaVersion') !== undefined && ownValue(raw, 'schemaVersion') !== 1;
      return this.reject(raw, unsupportedVersion ? 'UNSUPPORTED_VERSION' : 'INVALID_CONTRACT', channel, family);
    }

    const contextResult = ingressMetadataSchema.pick({
      sessionId: true,
      branchId: true,
      turnId: true,
      messageId: true,
      attempt: true,
    }).safeParse({
      sessionId: context.sessionId,
      branchId: context.branchId,
      turnId: context.turnId,
      messageId: context.messageId,
      attempt: context.attempt,
    });
    const scopeResult = LegacyIdentitySchema.safeParse(context.ingressScopeId ?? this.defaultIngressScopeId);
    const hintResult = context.correlationHint === undefined
      ? { success: true as const, data: 'active-turn' }
      : LegacyIdentitySchema.safeParse(context.correlationHint);
    if (!contextResult.success || !scopeResult.success || !hintResult.success) {
      return this.reject(raw, 'INVALID_CONTRACT', channel, family);
    }

    const metadata = metadataResult.data;
    const boundary = contextResult.data;
    const ingressScopeId = scopeResult.data;
    const sessionId = metadata.sessionId ?? boundary.sessionId ?? this.assign(this.assignedSessions, ingressScopeId, 'session');
    const branchSeed = `${ingressScopeId}|${sessionId}`;
    const branchId = metadata.branchId ?? boundary.branchId ?? this.assign(this.assignedBranches, branchSeed, 'branch');
    const attempt = metadata.attempt ?? boundary.attempt ?? 0;
    const suppliedMessageId = metadata.messageId ?? boundary.messageId;
    const suppliedTurnId = metadata.turnId ?? boundary.turnId;
    const identityScope = `${sessionId}|${branchId}`;

    let turnId = suppliedTurnId;
    let messageId = suppliedMessageId;
    if (messageId !== undefined && turnId === undefined) {
      turnId = this.assign(this.assignedTurns, `${identityScope}|message:${messageId}`, 'turn');
    } else if (turnId !== undefined && messageId === undefined) {
      messageId = this.assign(this.assignedMessages, `${identityScope}|turn:${turnId}`, 'message');
    } else if (turnId === undefined && messageId === undefined) {
      const hint = hintResult.data;
      turnId = this.assign(this.assignedTurns, `${identityScope}|hint:${hint}`, 'turn');
      messageId = this.assign(this.assignedMessages, `${identityScope}|hint:${hint}`, 'message');
    }

    // The branches above always resolve both values; the guard protects future edits.
    if (turnId === undefined || messageId === undefined) {
      return this.reject(raw, 'MISSING_REQUIRED_FIELD', channel, family);
    }

    const key = LegacyResponseAdapter.correlationKey({ sessionId, branchId, turnId, messageId, attempt });
    const previous = this.correlations.get(key);
    const inherited = previous ?? this.findLatestRelated(sessionId, branchId, turnId, messageId, attempt);
    const provider = metadata.provider ?? inherited?.latestProvider;
    const model = metadata.model ?? inherited?.latestModel;
    const agent = metadata.agent ?? inherited?.latestAgent;
    const occurrence = metadata.occurrence ?? ((previous?.occurrences ?? 0) + 1);
    const occurredAt = metadata.occurredAt ?? this.clock().toISOString();
    const deliveryId = metadata.deliveryId ?? this.deliveryIdentity(raw);

    const candidate = {
      schemaVersion: 1 as const,
      deliveryId,
      family,
      channel,
      sessionId,
      branchId,
      turnId,
      messageId,
      attempt,
      ordinal: metadata.ordinal,
      occurredAt,
      occurrence,
      agent,
      provider,
      model,
      payload: payloadResult.data,
    };
    const envelopeResult = LegacyFamilyEnvelopeSchemas[family].safeParse(candidate);
    if (!envelopeResult.success) {
      return this.reject(raw, 'INVALID_CONTRACT', channel, family);
    }

    const correlation = this.record(envelopeResult.data);
    return { accepted: true, envelope: envelopeResult.data, correlation };
  }

  getCorrelation(key: LegacyCorrelationKey): LegacyCorrelationRecord | undefined {
    const record = this.correlations.get(LegacyResponseAdapter.correlationKey(key));
    return record === undefined ? undefined : copyRecord(record);
  }

  getCorrelationsForTurn(
    sessionId: string,
    branchId: string,
    turnId: string,
    messageId: string,
  ): readonly LegacyCorrelationRecord[] {
    return [...this.correlations.values()]
      .filter((record) =>
        record.sessionId === sessionId &&
        record.branchId === branchId &&
        record.turnId === turnId &&
        record.messageId === messageId)
      .sort((left, right) => left.attempt - right.attempt)
      .map(copyRecord);
  }

  static correlationKey(key: LegacyCorrelationKey): string {
    return JSON.stringify([key.sessionId, key.branchId, key.turnId, key.messageId, key.attempt]);
  }

  private assign(
    assignments: Map<string, string>,
    assignmentKey: string,
    kind: LegacyIdentityKind,
  ): string {
    const existing = assignments.get(assignmentKey);
    if (existing !== undefined) return existing;
    const assigned = this.identityFactory(kind);
    const parsed = LegacyIdentitySchema.safeParse(assigned);
    if (!parsed.success) throw new Error(`Legacy identity factory returned an invalid ${kind} identity`);
    assignments.set(assignmentKey, parsed.data);
    return parsed.data;
  }

  private deliveryIdentity(raw: Record<string, unknown>): string {
    const existing = this.deliveryByObject.get(raw);
    if (existing !== undefined) return existing;
    const assigned = this.identityFactory('delivery');
    const parsed = LegacyIdentitySchema.parse(assigned);
    this.deliveryByObject.set(raw, parsed);
    return parsed;
  }

  private findLatestRelated(
    sessionId: string,
    branchId: string,
    turnId: string,
    messageId: string,
    attempt: number,
  ): MutableCorrelationRecord | undefined {
    return [...this.correlations.values()]
      .filter((record) =>
        record.sessionId === sessionId &&
        record.branchId === branchId &&
        record.turnId === turnId &&
        record.messageId === messageId &&
        record.attempt <= attempt)
      .sort((left, right) => right.attempt - left.attempt)[0];
  }

  private record(envelope: LegacyEventEnvelopeV1): LegacyCorrelationRecord {
    const key = LegacyResponseAdapter.correlationKey(envelope);
    let record = this.correlations.get(key);
    if (record === undefined) {
      record = {
        sessionId: envelope.sessionId,
        branchId: envelope.branchId,
        turnId: envelope.turnId,
        messageId: envelope.messageId,
        attempt: envelope.attempt,
        correlationKey: key,
        firstOccurredAt: envelope.occurredAt,
        lastOccurredAt: envelope.occurredAt,
        occurrences: 0,
        providers: new Set(),
        models: new Set(),
        agents: new Set(),
        channels: new Set(),
        ordinals: new Set(),
        firstFamily: envelope.family,
        lastFamily: envelope.family,
      };
      this.correlations.set(key, record);
    }

    record.lastOccurredAt = envelope.occurredAt;
    record.occurrences += 1;
    record.lastFamily = envelope.family;
    if (envelope.provider !== undefined) {
      record.providers.add(envelope.provider);
      record.latestProvider = envelope.provider;
    }
    if (envelope.model !== undefined) {
      record.models.add(envelope.model);
      record.latestModel = envelope.model;
    }
    if (envelope.agent !== undefined) {
      record.agents.add(envelope.agent);
      record.latestAgent = envelope.agent;
    }
    record.channels.add(envelope.channel);
    if (envelope.ordinal !== undefined) record.ordinals.add(envelope.ordinal);
    return copyRecord(record);
  }

  private reject(
    raw: unknown,
    reasonCode: LegacyAdapterDiagnosticV1['reasonCode'],
    channel?: LegacyEventChannel,
    family?: LegacyEventFamily,
  ): LegacyEnvelopeParseResult {
    this.diagnosticSequence += 1;
    const diagnostic: LegacyAdapterDiagnosticV1 = {
      schemaVersion: 1,
      diagnosticId: `legacy-rejection-${this.diagnosticSequence}`,
      correlationId: 'legacy-event-boundary',
      reasonCode,
      scope: 'legacy_event_envelope',
      severity: 'error',
      channel,
      family,
      observedSize: boundedObservedSize(raw),
      occurrences: 1,
    };
    return { accepted: false, diagnostic: LegacyAdapterDiagnosticV1Schema.parse(diagnostic) };
  }
}
