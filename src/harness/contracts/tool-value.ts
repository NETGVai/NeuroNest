/**
 * Canonical Tool Value V1
 *
 * The validated provider-independent tool result retained before model-facing
 * formatting or user-interface rendering. Immutable once committed.
 *
 * Requirements: 13.1, 34.1, 35.3
 */

import { z } from 'zod';
import {
  IdentifierSchema,
  TimestampSchema,
  IntegrityHashSchema,
  ContractRefSchema,
  RetentionDescriptorSchema,
} from './primitives';

export const CanonicalToolValueV1Schema = z.object({
  canonicalValueId: IdentifierSchema,
  callId: IdentifierSchema,
  toolContract: ContractRefSchema,
  mediaType: z.string().min(1),
  value: z.unknown(),
  valueDigest: IntegrityHashSchema,
  retention: RetentionDescriptorSchema,
  createdAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type CanonicalToolValueV1 = z.infer<typeof CanonicalToolValueV1Schema>;
