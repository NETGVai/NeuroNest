import { createHash } from 'node:crypto';

/**
 * Lifecycle-only normalization for the production legacy response adapter.
 *
 * This module deliberately owns no durable message/session store. The adapter
 * supplies parsed envelopes and owns delivery/fact deduplication; this class
 * retains only terminal precedence needed to reject false completion facts.
 */

export type LegacyLifecycleFamily =
  | 'start'
  | 'token'
  | 'reasoning'
  | 'completion'
  | 'cancellation'
  | 'error'
  | 'retry'
  | 'reconnect'
  | 'duplicate_delivery';

export type LegacyLifecycleChannel =
  | 'chat-response'
  | 'chat:stream'
  | 'chat:done'
  | 'chat:error'
  | 'chat:stream-chunk';

export interface LegacyLifecycleEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly deliveryId: string;
  readonly family: LegacyLifecycleFamily;
  readonly channel: LegacyLifecycleChannel;
  readonly sessionId: string;
  readonly branchId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly attempt: number;
  readonly ordinal?: number;
  readonly occurredAt: string;
  readonly agent?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly payload: unknown;
}

export type NormalizedChatEventTypeV1 =
  | 'message.assistant'
  | 'assistant.state'
  | 'assistant.delta'
  | 'assistant.reasoning'
  | 'retry'
  | 'error'
  | 'connection.state'
  | 'turn.tail';

export interface NormalizedChatEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventType: NormalizedChatEventTypeV1;
  readonly sessionId: string;
  readonly branchId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly attempt: number;
  readonly logicalSequence: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type NormalizedTerminalStateV1 = 'completed' | 'cancelled' | 'failed';

export interface LifecycleNormalizationDiagnosticV1 {
  readonly code: 'terminal_conflict';
  readonly correlationId: string;
  readonly retainedState: NormalizedTerminalStateV1;
  readonly rejectedState: NormalizedTerminalStateV1;
}

export interface LifecycleNormalizationResultV1 {
  readonly events: readonly NormalizedChatEventV1[];
  readonly terminalConflict: boolean;
  readonly diagnostic?: LifecycleNormalizationDiagnosticV1;
}

type JsonRecord = Record<string, unknown>;

interface TerminalRecord {
  readonly state: NormalizedTerminalStateV1;
  readonly precedence: 1 | 2 | 3;
}

const ATTEMPT_SEQUENCE_SPAN = 1_000_000;
const PHASE_SEQUENCE = {
  start: 0,
  token: 100_000,
  reasoning: 200_000,
  reconnect: 700_000,
  retry: 800_000,
  terminalContent: 900_000,
  terminal: 990_000,
} as const;

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function firstString(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function optionalInteger(record: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function optionalBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function optionalStringArray(record: JsonRecord, key: string): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return [...value];
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function correlationId(event: LegacyLifecycleEnvelopeV1): string {
  return [event.sessionId, event.branchId, event.turnId, event.messageId].join(':');
}

function sequence(attempt: number, phase: number, ordinal = 0): number {
  return attempt * ATTEMPT_SEQUENCE_SPAN + phase + ordinal;
}

function terminalStateFor(event: LegacyLifecycleEnvelopeV1): NormalizedTerminalStateV1 | null {
  if (event.family === 'completion') return 'completed';
  if (event.family === 'cancellation') return 'cancelled';
  if (event.family === 'error') return 'failed';
  return null;
}

/**
 * Maps parsed legacy families to durable normalized facts.
 *
 * Explicit cancellation/failure facts outrank inferred completion. A terminal
 * conflict remains unchanged unless the later payload is explicitly marked
 * `reconciliation: true`, which represents an authority-issued correction.
 */
export class LegacyResponseLifecycleNormalizer {
  private readonly terminals = new Map<string, TerminalRecord>();

  normalize(event: LegacyLifecycleEnvelopeV1): LifecycleNormalizationResultV1 {
    const payload = asRecord(event.payload);
    const terminalState = terminalStateFor(event);
    if (terminalState !== null) {
      const terminalDecision = this.acceptTerminal(event, payload, terminalState);
      if (!terminalDecision.accepted) {
        return {
          events: [],
          terminalConflict: true,
          diagnostic: {
            code: 'terminal_conflict',
            correlationId: correlationId(event),
            retainedState: terminalDecision.retainedState,
            rejectedState: terminalState,
          },
        };
      }
    }

    const events = this.mapFamily(event, payload);
    return { events, terminalConflict: false };
  }

  private acceptTerminal(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
    state: NormalizedTerminalStateV1,
  ): { accepted: true } | { accepted: false; retainedState: NormalizedTerminalStateV1 } {
    const key = correlationId(event);
    const reconciliation = payload.reconciliation === true;
    const precedence: 1 | 2 | 3 = reconciliation
      ? 3
      : state === 'completed'
        ? 1
        : 2;
    const current = this.terminals.get(key);

    if (current && current.state !== state && precedence <= current.precedence) {
      return { accepted: false, retainedState: current.state };
    }

    if (!current || current.state !== state || precedence > current.precedence) {
      this.terminals.set(key, { state, precedence });
    }
    return { accepted: true };
  }

  private mapFamily(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
  ): readonly NormalizedChatEventV1[] {
    switch (event.family) {
      case 'start':
        return [
          this.fact(event, 'message.assistant', PHASE_SEQUENCE.start, {
            content: '',
            finalized: false,
            provider: event.provider,
            model: event.model,
            agent: event.agent,
          }),
          this.fact(event, 'assistant.state', PHASE_SEQUENCE.start + 1, {
            state: firstString(payload, 'state') ?? 'reasoning',
          }),
        ];
      case 'token': {
        const ordinal = event.ordinal ?? optionalInteger(payload, 'ordinal') ?? 0;
        return [
          this.fact(event, 'assistant.delta', PHASE_SEQUENCE.token + ordinal, {
            // `chunk` is the DispatchBridge `chat:stream-chunk` alias; the
            // other keys cover `chat-response`/`chat:stream` payloads.
            text: firstString(payload, 'text', 'content', 'token', 'chunk') ?? '',
            ordinal,
            partial: true,
          }),
        ];
      }
      case 'reasoning': {
        const ordinal = event.ordinal ?? optionalInteger(payload, 'ordinal') ?? 0;
        return [
          this.fact(event, 'assistant.reasoning', PHASE_SEQUENCE.reasoning + ordinal, {
            text: firstString(payload, 'text', 'content', 'reasoning') ?? '',
            ordinal,
            category: firstString(payload, 'category') ?? 'summary',
          }),
        ];
      }
      case 'completion':
        return this.completionFacts(event, payload);
      case 'cancellation':
        return this.cancellationFacts(event, payload);
      case 'error':
        return this.errorFacts(event, payload);
      case 'retry':
        return this.retryFacts(event, payload);
      case 'reconnect':
        return this.reconnectFacts(event, payload);
      case 'duplicate_delivery':
        return [];
    }
  }

  private completionFacts(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
  ): readonly NormalizedChatEventV1[] {
    const facts: NormalizedChatEventV1[] = [];
    const content = firstString(payload, 'content', 'text', 'finalContent');
    if (content !== undefined) {
      facts.push(
        this.fact(event, 'message.assistant', PHASE_SEQUENCE.terminalContent, {
          content,
          finalized: true,
          provider: event.provider,
          model: event.model,
          agent: event.agent,
        }),
      );
    }
    facts.push(
      this.fact(event, 'assistant.state', PHASE_SEQUENCE.terminal, {
        state: 'completed',
      }),
      this.fact(event, 'turn.tail', PHASE_SEQUENCE.terminal + 1, {
        outcome: 'completed',
      }),
    );
    return facts;
  }

  private cancellationFacts(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
  ): readonly NormalizedChatEventV1[] {
    const facts = this.partialContentFacts(event, payload);
    const phase = firstString(payload, 'state', 'outcome') === 'cancelling'
      ? 'cancelling'
      : 'cancelled';
    facts.push(
      this.fact(event, 'assistant.state', PHASE_SEQUENCE.terminal, {
        state: phase,
        reason: firstString(payload, 'reason', 'summary'),
      }),
    );
    if (phase === 'cancelled') {
      facts.push(
        this.fact(event, 'turn.tail', PHASE_SEQUENCE.terminal + 1, {
          outcome: 'cancelled',
          reason: firstString(payload, 'reason', 'summary'),
        }),
      );
    }
    return facts;
  }

  private errorFacts(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
  ): readonly NormalizedChatEventV1[] {
    const facts = this.partialContentFacts(event, payload);
    facts.push(
      this.fact(event, 'error', PHASE_SEQUENCE.terminal - 1, {
        summary: firstString(payload, 'summary', 'message', 'error') ?? 'Assistant response failed',
        errorClass: firstString(payload, 'errorClass', 'code'),
        affectedAuthority: firstString(payload, 'affectedAuthority', 'authority'),
        lastVerifiedState: firstString(payload, 'lastVerifiedState'),
        correlationId: correlationId(event),
      }),
      this.fact(event, 'assistant.state', PHASE_SEQUENCE.terminal, {
        state: 'failed',
      }),
      this.fact(event, 'turn.tail', PHASE_SEQUENCE.terminal + 1, {
        outcome: 'failed',
      }),
    );
    return facts;
  }

  private retryFacts(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
  ): readonly NormalizedChatEventV1[] {
    const retryPayload: JsonRecord = {
      attempt: optionalInteger(payload, 'attempt', 'nextAttempt') ?? event.attempt,
      retryBudget: optionalInteger(payload, 'retryBudget'),
      finiteLimit: optionalInteger(payload, 'finiteLimit', 'retryLimit'),
      nextDelayMs: optionalInteger(payload, 'nextDelayMs', 'delayMs'),
      route: firstString(payload, 'route'),
      errorClass: firstString(payload, 'errorClass'),
    };
    return [
      this.fact(event, 'retry', PHASE_SEQUENCE.retry, retryPayload),
      this.fact(event, 'assistant.state', PHASE_SEQUENCE.retry + 1, {
        state: 'retrying',
        attempt: retryPayload.attempt,
      }),
    ];
  }

  private reconnectFacts(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
  ): readonly NormalizedChatEventV1[] {
    const state = firstString(payload, 'state') ?? 'reconnecting';
    return [
      this.fact(event, 'connection.state', PHASE_SEQUENCE.reconnect, {
        state,
        attemptCount: optionalInteger(payload, 'attemptCount', 'reconnectAttempt') ?? event.attempt,
        affectedCapabilities: optionalStringArray(payload, 'affectedCapabilities'),
        cancellationAvailable: optionalBoolean(payload, 'cancellationAvailable'),
      }),
    ];
  }

  private partialContentFacts(
    event: LegacyLifecycleEnvelopeV1,
    payload: JsonRecord,
  ): NormalizedChatEventV1[] {
    const partialContent = firstString(payload, 'partialContent', 'content');
    if (partialContent === undefined) return [];
    const ordinal = event.ordinal ?? optionalInteger(payload, 'ordinal') ?? 0;
    return [
      this.fact(event, 'assistant.delta', PHASE_SEQUENCE.terminalContent + ordinal, {
        text: partialContent,
        ordinal,
        partial: true,
        source: 'terminal',
      }),
    ];
  }

  private fact(
    event: LegacyLifecycleEnvelopeV1,
    eventType: NormalizedChatEventTypeV1,
    phaseSequence: number,
    rawPayload: JsonRecord,
  ): NormalizedChatEventV1 {
    const payload = Object.fromEntries(
      Object.entries(rawPayload).filter(([, value]) => value !== undefined),
    );
    const logicalSequence = sequence(event.attempt, phaseSequence);
    const identity = {
      schemaVersion: 1,
      sessionId: event.sessionId,
      branchId: event.branchId,
      turnId: event.turnId,
      messageId: event.messageId,
      attempt: event.attempt,
      eventType,
      logicalSequence,
      payload,
    };
    return {
      schemaVersion: 1,
      eventId: `legacy-v1:${createHash('sha256').update(stableSerialize(identity)).digest('hex')}`,
      eventType,
      sessionId: event.sessionId,
      branchId: event.branchId,
      turnId: event.turnId,
      messageId: event.messageId,
      attempt: event.attempt,
      logicalSequence,
      occurredAt: event.occurredAt,
      payload,
    };
  }
}
