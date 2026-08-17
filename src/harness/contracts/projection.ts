/**
 * Projection Envelope V1
 *
 * Wraps any projection value with session context, revision tracking,
 * source sequence, staleness indicator, and confirmed command identifiers.
 *
 * Requirements: 3.1–3.2, 35.3
 */

import { z } from 'zod';
import {
  IdentifierSchema,
  SequenceSchema,
  TimestampSchema,
  IntegrityHashSchema,
} from './primitives';

/**
 * Generic projection envelope. The `value` field carries the
 * projection-specific payload of type T.
 */
export function createProjectionEnvelopeV1Schema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    sessionId: IdentifierSchema,
    branchId: IdentifierSchema,
    projectionKind: IdentifierSchema,
    projectionRevision: z.number().int().positive(),
    sourceSequence: SequenceSchema,
    schemaVersion: z.literal(1),
    checkpointHash: IntegrityHashSchema,
    generatedAt: TimestampSchema,
    stale: z.boolean(),
    value: valueSchema,
    confirmedCommandIds: z.array(IdentifierSchema),
  }).passthrough();
}

/**
 * Untyped projection envelope for boundary parsing where the
 * value type is not yet known.
 */
export const ProjectionEnvelopeV1Schema = createProjectionEnvelopeV1Schema(z.unknown());

export type ProjectionEnvelopeV1<T = unknown> = {
  sessionId: string;
  branchId: string;
  projectionKind: string;
  projectionRevision: number;
  sourceSequence: number;
  schemaVersion: 1;
  checkpointHash: string;
  generatedAt: string;
  stale: boolean;
  value: T;
  confirmedCommandIds: string[];
};

// ─── Boundary Parser ────────────────────────────────────────────

export type ProjectionParseResult =
  | { ok: true; envelope: ProjectionEnvelopeV1 }
  | { ok: false; unavailable: true; reason: string };

/**
 * Parse a projection envelope at a boundary. Returns a typed unavailable
 * outcome for incompatible structures rather than throwing.
 */
export function parseProjectionEnvelope(raw: unknown): ProjectionParseResult {
  const result = ProjectionEnvelopeV1Schema.safeParse(raw);
  if (result.success) {
    return { ok: true, envelope: result.data as ProjectionEnvelopeV1 };
  }
  return {
    ok: false,
    unavailable: true,
    reason: result.error.message,
  };
}
