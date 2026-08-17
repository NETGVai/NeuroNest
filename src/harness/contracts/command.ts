/**
 * Command V1
 *
 * Base command envelope for all mutating operations in the harness domain.
 * Every command carries actor, scope, expected revision, idempotency key,
 * and authority target.
 *
 * Requirements: 3.2, 12.1, 34.5
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from './primitives';
import { ActorRefSchema } from './actor';
import { ScopeDescriptorV1Schema } from './scope';
import { IdempotencyKeySchema } from './idempotency';

export const CommandV1Schema = z.object({
  commandId: IdentifierSchema,
  commandType: IdentifierSchema,
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
  idempotencyKey: IdempotencyKeySchema,
  expectedRevision: z.number().int().nonnegative().optional(),
  sourceProjectionRevision: z.number().int().nonnegative().optional(),
  authorityTarget: IdentifierSchema,
  payload: z.record(z.string(), z.unknown()),
  issuedAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

/** Command outcome discriminated by status. */
export const CommandOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), commandId: IdentifierSchema }).passthrough(),
  z.object({ status: z.literal('committed'), commandId: IdentifierSchema, revision: z.number().int() }).passthrough(),
  z.object({ status: z.literal('rejected'), commandId: IdentifierSchema, reason: z.string() }).passthrough(),
  z.object({ status: z.literal('stale'), commandId: IdentifierSchema, currentRevision: z.number().int() }).passthrough(),
  z.object({ status: z.literal('unavailable'), commandId: IdentifierSchema, reason: z.string() }).passthrough(),
  z.object({ status: z.literal('unresolved'), commandId: IdentifierSchema }).passthrough(),
]);

export type CommandV1 = z.infer<typeof CommandV1Schema>;
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>;
