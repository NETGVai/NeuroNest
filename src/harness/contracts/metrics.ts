/**
 * Metrics Record V1
 *
 * Typed metrics for token usage, latency, cost, and operational measurements
 * with provenance and unit awareness.
 *
 * Requirements: 29.8, 34.7
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from './primitives';
import { ScopeDescriptorV1Schema } from './scope';

export const MetricUnitSchema = z.enum([
  'tokens',
  'bytes',
  'milliseconds',
  'seconds',
  'count',
  'currency_usd_micros',
]);

export const MetricsRecordV1Schema = z.object({
  metricId: IdentifierSchema,
  metricName: IdentifierSchema,
  value: z.number().finite(),
  unit: MetricUnitSchema,
  scope: ScopeDescriptorV1Schema,
  sessionId: IdentifierSchema.optional(),
  turnId: IdentifierSchema.optional(),
  routeId: IdentifierSchema.optional(),
  sourceRevision: z.number().int().nonnegative(),
  recordedAt: TimestampSchema,
  provenance: z.string().optional(),
  schemaVersion: z.literal(1),
}).passthrough();

export type MetricsRecordV1 = z.infer<typeof MetricsRecordV1Schema>;
export type MetricUnit = z.infer<typeof MetricUnitSchema>;
