/**
 * Idempotency Key V1
 *
 * A stable operation identity used to ensure replayed durable mutations
 * have one committed effect.
 *
 * Requirements: 3.2, 34.3
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from './primitives';

export const IdempotencyKeySchema = z.object({
  key: IdentifierSchema,
  producer: IdentifierSchema,
  createdAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
