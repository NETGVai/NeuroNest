import { createHash } from 'node:crypto';

/** Event families accepted by the legacy response compatibility boundary. */
export type LegacyDeduplicationFamily =
  | 'start'
  | 'token'
  | 'reasoning'
  | 'completion'
  | 'cancellation'
  | 'error'
  | 'retry'
  | 'reconnect'
  | 'duplicate_delivery';

/**
 * The immutable fields used to identify one logical fact. Transport-only fields
 * such as channel, deliveryId, and occurredAt are intentionally excluded from
 * the deterministic event ID.
 */
export interface LegacyDeduplicationInputV1 {
  deliveryId: string;
  channel?:
    | 'chat-response'
    | 'chat:stream'
    | 'chat:done'
    | 'chat:error'
    | 'chat:stream-chunk';
  family: LegacyDeduplicationFamily;
  sessionId: string;
  branchId: string;
  turnId: string;
  messageId: string;
  attempt: number;
  ordinal?: number;
  payload: unknown;
  authoritativeReconciliation?: boolean;
}

export interface LegacyDuplicateLedgerOptions {
  /** Maximum retained transport delivery identities. */
  deliveryCapacity?: number;
  /** Maximum retained accepted logical facts. */
  factCapacity?: number;
}

export interface LegacyDuplicateCountersV1 {
  accepted: number;
  transportDuplicates: number;
  semanticDuplicates: number;
  ordinalConflicts: number;
  authoritativeReconciliations: number;
  deliveryEvictions: number;
  factEvictions: number;
}

export interface LegacyDuplicateLedgerSnapshotV1 extends LegacyDuplicateCountersV1 {
  deliveryLedgerSize: number;
  factLedgerSize: number;
  ordinalLedgerSize: number;
}

/** Redacted by construction: it contains identities and digests, never payload. */
export interface LegacyOrdinalConflictDiagnosticV1 {
  schemaVersion: 1;
  reasonCode: 'ORDINAL_PAYLOAD_CONFLICT';
  severity: 'warning';
  correlationId: string;
  logicalSlotId: string;
  authoritativeEventId: string;
  conflictingEventId: string;
  occurrences: number;
}

export type LegacyDuplicateDecisionV1 =
  | {
      kind: 'accepted';
      accepted: true;
      duplicate: false;
      eventId: string;
      payloadDigest: string;
      visibleRevisionDelta: 1;
      reconciled: boolean;
    }
  | {
      kind: 'transport_duplicate' | 'semantic_duplicate';
      accepted: false;
      duplicate: true;
      eventId?: string;
      visibleRevisionDelta: 0;
    }
  | {
      kind: 'ordinal_conflict';
      accepted: false;
      duplicate: false;
      eventId: string;
      visibleRevisionDelta: 0;
      diagnostic: LegacyOrdinalConflictDiagnosticV1;
    };

interface AcceptedFact {
  eventId: string;
  logicalSlotId: string;
  payloadDigest: string;
}

const DEFAULT_DELIVERY_CAPACITY = 8_192;
const DEFAULT_FACT_CAPACITY = 16_384;

function requireCapacity(name: string, value: number | undefined, fallback: number): number {
  const capacity = value ?? fallback;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return capacity;
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\u0000${value}`, 'utf8').digest('hex');
}

/**
 * Canonical JSON-like serialization for hashing validated event payloads.
 * Object key order does not affect semantic identity; array order does.
 */
export function canonicalizeLegacyEventPayload(value: unknown): string {
  const ancestors = new Set<object>();

  const visit = (candidate: unknown): string => {
    if (candidate === null) return 'null';

    switch (typeof candidate) {
      case 'string':
        return JSON.stringify(candidate);
      case 'boolean':
        return candidate ? 'true' : 'false';
      case 'number':
        if (Number.isNaN(candidate)) return 'number:NaN';
        if (candidate === Infinity) return 'number:Infinity';
        if (candidate === -Infinity) return 'number:-Infinity';
        if (Object.is(candidate, -0)) return 'number:-0';
        return `number:${candidate}`;
      case 'bigint':
        return `bigint:${candidate.toString()}`;
      case 'undefined':
        return 'undefined';
      case 'symbol':
        return `symbol:${String(candidate.description ?? '')}`;
      case 'function':
        return 'function';
      case 'object': {
        const object = candidate as object;
        if (ancestors.has(object)) return 'circular';
        ancestors.add(object);
        try {
          if (Array.isArray(candidate)) {
            return `[${candidate.map((entry) => visit(entry)).join(',')}]`;
          }
          if (candidate instanceof Date) {
            return `date:${Number.isNaN(candidate.getTime()) ? 'invalid' : candidate.toISOString()}`;
          }
          const record = candidate as Record<string, unknown>;
          const entries = Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`);
          return `{${entries.join(',')}}`;
        } finally {
          ancestors.delete(object);
        }
      }
    }

    throw new TypeError(`Unsupported payload type: ${typeof candidate}`);
  };

  return visit(value);
}

function logicalIdentity(input: LegacyDeduplicationInputV1): string {
  return canonicalizeLegacyEventPayload({
    schemaVersion: 1,
    sessionId: input.sessionId,
    branchId: input.branchId,
    turnId: input.turnId,
    messageId: input.messageId,
    attempt: input.attempt,
    family: input.family,
    ordinal: input.ordinal ?? null,
  });
}

export function computeLegacyPayloadDigest(payload: unknown): string {
  return digest('legacy-response-payload-v1', canonicalizeLegacyEventPayload(payload));
}

export function computeLegacyLogicalSlotId(input: LegacyDeduplicationInputV1): string {
  return `legacy-slot-v1:${digest('legacy-response-slot-v1', logicalIdentity(input))}`;
}

export function computeLegacyLogicalEventId(input: LegacyDeduplicationInputV1): string {
  const payloadDigest = computeLegacyPayloadDigest(input.payload);
  return `legacy-event-v1:${digest(
    'legacy-response-event-v1',
    `${logicalIdentity(input)}\u0000${payloadDigest}`,
  )}`;
}

/**
 * Bounded in-memory duplicate ledgers for the legacy ingress adapter.
 *
 * This class stores only transport IDs, deterministic event IDs, and digests.
 * It cannot retain message payloads or mutate a projection. Callers publish a
 * fact only when `accept(...).accepted` is true, which guarantees duplicate and
 * conflict paths have a visible revision delta of zero.
 */
export class LegacyResponseDuplicateLedgers {
  private readonly deliveryCapacity: number;
  private readonly factCapacity: number;
  private readonly deliveryLedger = new Map<string, true>();
  private readonly factLedger = new Map<string, AcceptedFact>();
  private readonly ordinalLedger = new Map<string, string>();
  private readonly conflictOccurrences = new Map<string, number>();
  private readonly counters: LegacyDuplicateCountersV1 = {
    accepted: 0,
    transportDuplicates: 0,
    semanticDuplicates: 0,
    ordinalConflicts: 0,
    authoritativeReconciliations: 0,
    deliveryEvictions: 0,
    factEvictions: 0,
  };

  constructor(options: LegacyDuplicateLedgerOptions = {}) {
    this.deliveryCapacity = requireCapacity(
      'deliveryCapacity',
      options.deliveryCapacity,
      DEFAULT_DELIVERY_CAPACITY,
    );
    this.factCapacity = requireCapacity('factCapacity', options.factCapacity, DEFAULT_FACT_CAPACITY);
  }

  accept(input: LegacyDeduplicationInputV1): LegacyDuplicateDecisionV1 {
    if (this.deliveryLedger.has(input.deliveryId)) {
      this.counters.transportDuplicates += 1;
      return {
        kind: 'transport_duplicate',
        accepted: false,
        duplicate: true,
        visibleRevisionDelta: 0,
      };
    }
    this.rememberDelivery(input.deliveryId);

    const payloadDigest = computeLegacyPayloadDigest(input.payload);
    const eventId = computeLegacyLogicalEventId(input);
    const logicalSlotId = computeLegacyLogicalSlotId(input);

    if (this.factLedger.has(eventId)) {
      this.counters.semanticDuplicates += 1;
      return {
        kind: 'semantic_duplicate',
        accepted: false,
        duplicate: true,
        eventId,
        visibleRevisionDelta: 0,
      };
    }

    const authoritativeEventId = this.ordinalLedger.get(logicalSlotId);
    if (authoritativeEventId !== undefined && !input.authoritativeReconciliation) {
      this.counters.ordinalConflicts += 1;
      const conflictKey = `${logicalSlotId}\u0000${eventId}`;
      const occurrences = (this.conflictOccurrences.get(conflictKey) ?? 0) + 1;
      this.conflictOccurrences.set(conflictKey, occurrences);
      return {
        kind: 'ordinal_conflict',
        accepted: false,
        duplicate: false,
        eventId,
        visibleRevisionDelta: 0,
        diagnostic: {
          schemaVersion: 1,
          reasonCode: 'ORDINAL_PAYLOAD_CONFLICT',
          severity: 'warning',
          correlationId: `legacy-correlation-v1:${digest(
            'legacy-response-correlation-v1',
            canonicalizeLegacyEventPayload({
              sessionId: input.sessionId,
              branchId: input.branchId,
              turnId: input.turnId,
              messageId: input.messageId,
              attempt: input.attempt,
            }),
          )}`,
          logicalSlotId,
          authoritativeEventId,
          conflictingEventId: eventId,
          occurrences,
        },
      };
    }

    const reconciled = authoritativeEventId !== undefined;
    this.rememberFact({ eventId, logicalSlotId, payloadDigest });
    this.ordinalLedger.set(logicalSlotId, eventId);
    this.counters.accepted += 1;
    if (reconciled) this.counters.authoritativeReconciliations += 1;

    return {
      kind: 'accepted',
      accepted: true,
      duplicate: false,
      eventId,
      payloadDigest,
      visibleRevisionDelta: 1,
      reconciled,
    };
  }

  snapshot(): Readonly<LegacyDuplicateLedgerSnapshotV1> {
    return Object.freeze({
      ...this.counters,
      deliveryLedgerSize: this.deliveryLedger.size,
      factLedgerSize: this.factLedger.size,
      ordinalLedgerSize: this.ordinalLedger.size,
    });
  }

  private rememberDelivery(deliveryId: string): void {
    this.deliveryLedger.set(deliveryId, true);
    while (this.deliveryLedger.size > this.deliveryCapacity) {
      const oldest = this.deliveryLedger.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deliveryLedger.delete(oldest);
      this.counters.deliveryEvictions += 1;
    }
  }

  private rememberFact(fact: AcceptedFact): void {
    this.factLedger.set(fact.eventId, fact);
    while (this.factLedger.size > this.factCapacity) {
      const oldestEventId = this.factLedger.keys().next().value as string | undefined;
      if (oldestEventId === undefined) break;
      const oldest = this.factLedger.get(oldestEventId);
      this.factLedger.delete(oldestEventId);
      if (oldest && this.ordinalLedger.get(oldest.logicalSlotId) === oldestEventId) {
        this.ordinalLedger.delete(oldest.logicalSlotId);
      }
      this.counters.factEvictions += 1;
    }
  }
}
