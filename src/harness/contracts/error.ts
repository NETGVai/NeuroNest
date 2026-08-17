/**
 * Error V1
 *
 * Typed structured error for harness domain operations. Errors carry
 * classification, source, and provenance without revealing internal
 * details in contexts where redaction is required.
 *
 * Requirements: 3.2, 34.4
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from './primitives';
import { ScopeDescriptorV1Schema } from './scope';

export const ErrorSeveritySchema = z.enum(['fatal', 'error', 'warning', 'info']);

export const ErrorClassSchema = z.enum([
  'validation',
  'integrity',
  'contention',
  'timeout',
  'unavailable',
  'authorization',
  'boundary_violation',
  'schema_incompatible',
  'resource_exhausted',
  'internal',
]);

export const ErrorV1Schema = z.object({
  errorId: IdentifierSchema,
  errorClass: ErrorClassSchema,
  severity: ErrorSeveritySchema,
  message: z.string(),
  code: z.string().optional(),
  source: IdentifierSchema.optional(),
  correlationId: IdentifierSchema.optional(),
  scope: ScopeDescriptorV1Schema.optional(),
  redacted: z.boolean().default(false),
  occurredAt: TimestampSchema,
  details: z.record(z.string(), z.unknown()).optional(),
  schemaVersion: z.literal(1),
}).passthrough();

export type ErrorV1 = z.infer<typeof ErrorV1Schema>;
export type ErrorSeverity = z.infer<typeof ErrorSeveritySchema>;
export type ErrorClass = z.infer<typeof ErrorClassSchema>;
