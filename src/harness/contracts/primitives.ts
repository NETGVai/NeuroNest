/**
 * Shared primitive schemas used across all canonical contracts.
 */

import { z } from 'zod';

/** ISO 8601 timestamp string. */
export const TimestampSchema = z.string().datetime();

/** Non-empty identifier string. */
export const IdentifierSchema = z.string().min(1);

/** Positive integer for sequence numbers. */
export const SequenceSchema = z.number().int().nonnegative();

/** Positive schema version. */
export const SchemaVersionSchema = z.number().int().positive();

/** A stable content-addressable hash digest. */
export const IntegrityHashSchema = z.string().min(1);

/** Contract reference for tool or capability versioning. */
export const ContractRefSchema = z.object({
  name: IdentifierSchema,
  version: IdentifierSchema,
}).passthrough();

/** Retention descriptor for tool values and attachments. */
export const RetentionDescriptorSchema = z.object({
  policy: z.enum(['session', 'durable', 'ephemeral']),
  expiresAt: TimestampSchema.optional(),
}).passthrough();

export type ContractRef = z.infer<typeof ContractRefSchema>;
export type RetentionDescriptor = z.infer<typeof RetentionDescriptorSchema>;
