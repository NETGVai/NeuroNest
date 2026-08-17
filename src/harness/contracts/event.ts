/**
 * Session Event V1
 *
 * The canonical append-only event envelope for the Session_Log. Each event
 * carries a stable identity, session/branch context, monotonic sequence,
 * schema version, integrity chain, and typed payload.
 *
 * Requirements: 3.1–3.2, 12.1
 */

import { z } from 'zod';
import {
  IdentifierSchema,
  SequenceSchema,
  TimestampSchema,
  IntegrityHashSchema,
} from './primitives';
import { ActorRefSchema } from './actor';
import { ScopeDescriptorV1Schema } from './scope';

// ─── Event Payload Base ─────────────────────────────────────────

/**
 * All event payloads must declare a `type` discriminator.
 * Passthrough preserves unknown compatible fields for forward compatibility.
 */
export const SessionEventPayloadV1Schema = z.object({
  type: IdentifierSchema,
}).passthrough();

export type SessionEventPayloadV1 = z.infer<typeof SessionEventPayloadV1Schema>;

// ─── Session Event Envelope ─────────────────────────────────────

export const SessionEventV1Schema = z.object({
  eventId: IdentifierSchema,
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  sequence: SequenceSchema,
  schemaVersion: z.literal(1),
  eventType: IdentifierSchema,
  payload: SessionEventPayloadV1Schema,
  idempotencyKey: z.string().optional(),
  occurredAt: TimestampSchema,
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
  previousIntegrityHash: IntegrityHashSchema.nullable(),
  integrityHash: IntegrityHashSchema,
}).passthrough();

export type SessionEventV1 = z.infer<typeof SessionEventV1Schema>;

// ─── Boundary Parser ────────────────────────────────────────────

/**
 * Typed result for event parsing at boundaries.
 * Incompatible schema versions produce an `unavailable` outcome.
 */
export type EventParseResult =
  | { ok: true; event: SessionEventV1 }
  | { ok: false; unavailable: true; reason: string; rawEventType?: string };

/**
 * Parse a session event at a process or database boundary.
 * Returns a typed unavailable outcome for incompatible schemas
 * rather than throwing.
 */
export function parseSessionEvent(raw: unknown): EventParseResult {
  const result = SessionEventV1Schema.safeParse(raw);
  if (result.success) {
    return { ok: true, event: result.data };
  }

  const rawType = typeof raw === 'object' && raw !== null && 'eventType' in raw
    ? String((raw as Record<string, unknown>)['eventType'])
    : undefined;

  return {
    ok: false,
    unavailable: true,
    reason: result.error.message,
    rawEventType: rawType,
  };
}
