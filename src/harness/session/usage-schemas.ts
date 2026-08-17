/**
 * Usage Accounting Schemas — Replay-Aware Token, Cost, Latency, and Budget Contracts
 *
 * Defines canonical Zod schemas for:
 * - Token subdivisions (provider-reported exclusive or deterministic estimates)
 * - Cost entries with currency separation
 * - Latency attribution
 * - Budget configuration and gating
 * - Currency conversion records
 * - Metric classification (reported, estimated, mixed, partial, unavailable)
 * - Insight projection records
 *
 * Requirements: 17.1–17.7, 48.1–48.22
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SequenceSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Metric Classification ──────────────────────────────────────

export const MetricClassificationSchema = z.enum([
  'reported',
  'estimated',
  'mixed',
  'partial',
  'unavailable',
]);

export type MetricClassification = z.infer<typeof MetricClassificationSchema>;

// ─── Token Subdivision (exclusive, non-overlapping) ─────────────

export const TokenSubdivisionSchema = z.object({
  /** Uncached input tokens */
  uncachedInput: z.number().int().nonnegative().finite(),
  /** Cache read tokens */
  cacheRead: z.number().int().nonnegative().finite(),
  /** Cache write tokens */
  cacheWrite: z.number().int().nonnegative().finite(),
  /** Output tokens */
  output: z.number().int().nonnegative().finite(),
  /** Reasoning tokens */
  reasoning: z.number().int().nonnegative().finite(),
}).passthrough();

export type TokenSubdivision = z.infer<typeof TokenSubdivisionSchema>;

// ─── Uncertainty Marker for Estimates ───────────────────────────

export const UncertaintyBoundsSchema = z.object({
  lowerBound: z.number().nonnegative().finite(),
  upperBound: z.number().nonnegative().finite(),
  confidence: z.number().min(0).max(1).finite(),
}).passthrough();

export type UncertaintyBounds = z.infer<typeof UncertaintyBoundsSchema>;

// ─── Estimator Identity ─────────────────────────────────────────

export const EstimatorIdentitySchema = z.object({
  estimatorId: IdentifierSchema,
  version: IdentifierSchema,
  inputs: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type EstimatorIdentity = z.infer<typeof EstimatorIdentitySchema>;

// ─── Usage Record ───────────────────────────────────────────────

export const UsageRecordSchema = z.object({
  /** Unique record identity */
  usageId: IdentifierSchema,
  /** Session this record belongs to */
  sessionId: IdentifierSchema,
  /** Branch identity */
  branchId: IdentifierSchema,
  /** Turn/request identity for attribution */
  turnId: IdentifierSchema,
  /** Specific request ID */
  requestId: IdentifierSchema,
  /** Optional tool call ID for tool-level attribution */
  toolCallId: IdentifierSchema.optional(),
  /** Completion anchor identity */
  completionAnchorId: IdentifierSchema.optional(),
  /** Provider-reported exclusive token subdivisions */
  tokenSubdivisions: TokenSubdivisionSchema,
  /** Classification of this metric record */
  classification: MetricClassificationSchema,
  /** If estimated, the estimator identity and uncertainty */
  estimator: EstimatorIdentitySchema.optional(),
  /** If estimated, the uncertainty bounds per subdivision */
  uncertaintyBounds: z.record(z.string(), UncertaintyBoundsSchema).optional(),
  /** Route identity for attribution */
  routeId: IdentifierSchema,
  /** Provider identity */
  providerId: IdentifierSchema,
  /** Model identity */
  modelId: IdentifierSchema,
  /** Scope descriptor */
  scope: ScopeDescriptorV1Schema,
  /** Idempotency key to prevent replay duplicates */
  idempotencyKey: IdentifierSchema,
  /** Whether this is a replayed historical record (non-billable) */
  isReplay: z.boolean(),
  /** Source event sequence for provenance */
  sourceSequence: SequenceSchema,
  /** Durable source sequences that contributed to this record */
  sourceSequences: z.array(SequenceSchema).optional(),
  /** Schema version */
  schemaVersion: z.literal(1),
  /** Recorded timestamp */
  recordedAt: TimestampSchema,
}).passthrough();

export type UsageRecord = z.infer<typeof UsageRecordSchema>;

// ─── Cost Entry ─────────────────────────────────────────────────

export const CostEntrySchema = z.object({
  /** Unique cost entry identity */
  costId: IdentifierSchema,
  /** Linked usage record */
  usageId: IdentifierSchema,
  /** Session identity */
  sessionId: IdentifierSchema,
  /** Branch identity */
  branchId: IdentifierSchema,
  /** Turn/request identity for attribution */
  turnId: IdentifierSchema,
  /** Request identity */
  requestId: IdentifierSchema,
  /** Route identity */
  routeId: IdentifierSchema,
  /** Provider identity */
  providerId: IdentifierSchema,
  /** Model identity */
  modelId: IdentifierSchema,
  /** Amount in the smallest unit of the currency (e.g., micros) */
  amount: z.number().nonnegative().finite(),
  /** Currency identity (e.g., 'usd_micros', 'eur_micros') */
  currencyId: IdentifierSchema,
  /** Classification of this cost */
  classification: MetricClassificationSchema,
  /** Uncertainty bounds if estimated */
  uncertaintyBounds: UncertaintyBoundsSchema.optional(),
  /** Whether this is a replayed record (non-billable) */
  isReplay: z.boolean(),
  /** Idempotency key */
  idempotencyKey: IdentifierSchema,
  /** Source sequence */
  sourceSequence: SequenceSchema,
  /** Schema version */
  schemaVersion: z.literal(1),
  /** Recorded timestamp */
  recordedAt: TimestampSchema,
}).passthrough();

export type CostEntry = z.infer<typeof CostEntrySchema>;

// ─── Latency Entry ──────────────────────────────────────────────

export const LatencyEntrySchema = z.object({
  /** Unique latency entry identity */
  latencyId: IdentifierSchema,
  /** Linked usage record */
  usageId: IdentifierSchema,
  /** Session identity */
  sessionId: IdentifierSchema,
  /** Branch identity */
  branchId: IdentifierSchema,
  /** Turn/request identity */
  turnId: IdentifierSchema,
  /** Request identity */
  requestId: IdentifierSchema,
  /** Route identity */
  routeId: IdentifierSchema,
  /** Provider identity */
  providerId: IdentifierSchema,
  /** Model identity */
  modelId: IdentifierSchema,
  /** Time to first token in milliseconds */
  timeToFirstTokenMs: z.number().nonnegative().finite(),
  /** Total model time in milliseconds */
  modelTimeMs: z.number().nonnegative().finite(),
  /** Total tool time in milliseconds */
  toolTimeMs: z.number().nonnegative().finite(),
  /** Throughput (tokens per second) */
  throughputTokensPerSec: z.number().nonnegative().finite(),
  /** Classification */
  classification: MetricClassificationSchema,
  /** Whether this is a replayed record */
  isReplay: z.boolean(),
  /** Idempotency key */
  idempotencyKey: IdentifierSchema,
  /** Source sequence */
  sourceSequence: SequenceSchema,
  /** Schema version */
  schemaVersion: z.literal(1),
  /** Recorded timestamp */
  recordedAt: TimestampSchema,
}).passthrough();

export type LatencyEntry = z.infer<typeof LatencyEntrySchema>;

// ─── Budget Configuration ───────────────────────────────────────

export const BudgetPolicySchema = z.enum(['stop', 'ask', 'fallback']);
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const BudgetConfigSchema = z.object({
  /** Budget configuration identity */
  budgetId: IdentifierSchema,
  /** Scope for this budget */
  scope: ScopeDescriptorV1Schema,
  /** Maximum token budget (null = unlimited) */
  maxTokens: z.number().int().positive().finite().nullable(),
  /** Maximum context tokens */
  maxContextTokens: z.number().int().positive().finite().nullable(),
  /** Maximum cost budget per currency */
  maxCost: z.record(z.string(), z.number().positive().finite()).nullable(),
  /** Maximum latency budget in ms */
  maxLatencyMs: z.number().positive().finite().nullable(),
  /** Policy to apply when budget is exhausted */
  exhaustionPolicy: BudgetPolicySchema,
  /** Model-specific overrides */
  modelOverrides: z.record(z.string(), z.object({
    maxTokens: z.number().int().positive().finite().nullable().optional(),
    maxContextTokens: z.number().int().positive().finite().nullable().optional(),
    maxCost: z.record(z.string(), z.number().positive().finite()).nullable().optional(),
  })).optional(),
  /** Provider-specific overrides */
  providerOverrides: z.record(z.string(), z.object({
    maxTokens: z.number().int().positive().finite().nullable().optional(),
    maxCost: z.record(z.string(), z.number().positive().finite()).nullable().optional(),
  })).optional(),
  /** Source revision for provenance */
  sourceRevision: z.number().int().nonnegative(),
  /** Schema version */
  schemaVersion: z.literal(1),
}).passthrough();

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// ─── Budget Gating Result ───────────────────────────────────────

export const BudgetGateResultSchema = z.object({
  /** Whether the operation is allowed */
  allowed: z.boolean(),
  /** The policy applied if blocked */
  appliedPolicy: BudgetPolicySchema.optional(),
  /** Which budget dimension was exceeded */
  exceededDimension: z.enum(['tokens', 'context', 'cost', 'latency']).optional(),
  /** Current usage value at the time of gating */
  currentValue: z.number().nonnegative().finite().optional(),
  /** The limit that was exceeded */
  limitValue: z.number().positive().finite().optional(),
  /** Currency ID if cost limit exceeded */
  currencyId: IdentifierSchema.optional(),
}).passthrough();

export type BudgetGateResult = z.infer<typeof BudgetGateResultSchema>;

// ─── Currency Conversion Record ─────────────────────────────────

export const CurrencyConversionSchema = z.object({
  /** Conversion record identity */
  conversionId: IdentifierSchema,
  /** Source currency */
  sourceCurrencyId: IdentifierSchema,
  /** Target currency */
  targetCurrencyId: IdentifierSchema,
  /** Conversion rate (target/source) */
  conversionRate: z.number().positive().finite(),
  /** Version of this conversion record */
  conversionVersion: IdentifierSchema,
  /** Source amount retained */
  sourceAmount: z.number().nonnegative().finite(),
  /** Converted value */
  convertedAmount: z.number().nonnegative().finite(),
  /** Source sequence range */
  sourceSequenceRange: z.object({
    from: SequenceSchema,
    to: SequenceSchema,
  }),
  /** Schema version */
  schemaVersion: z.literal(1),
  /** Recorded timestamp */
  recordedAt: TimestampSchema,
}).passthrough();

export type CurrencyConversion = z.infer<typeof CurrencyConversionSchema>;

// ─── Insight Record ─────────────────────────────────────────────

export const InsightRecordSchema = z.object({
  /** Unique insight identity */
  insightId: IdentifierSchema,
  /** Session identity */
  sessionId: IdentifierSchema,
  /** Branch identity */
  branchId: IdentifierSchema,
  /** Context occupancy (current) */
  contextOccupancy: z.number().int().nonnegative().finite(),
  /** Total input tokens (all turns) */
  totalInputTokens: z.number().int().nonnegative().finite(),
  /** Total output tokens */
  totalOutputTokens: z.number().int().nonnegative().finite(),
  /** Total cache read tokens */
  totalCacheReadTokens: z.number().int().nonnegative().finite(),
  /** Total cache write tokens */
  totalCacheWriteTokens: z.number().int().nonnegative().finite(),
  /** Cache hit ratio (0-1) */
  cacheHitRatio: z.number().min(0).max(1).finite(),
  /** Cost totals per currency */
  costByCurrency: z.record(z.string(), z.number().nonnegative().finite()),
  /** Cost uncertainty marker */
  costClassification: MetricClassificationSchema,
  /** Average time to first token in ms */
  avgTimeToFirstTokenMs: z.number().nonnegative().finite(),
  /** Average throughput */
  avgThroughputTokensPerSec: z.number().nonnegative().finite(),
  /** Total model time */
  totalModelTimeMs: z.number().nonnegative().finite(),
  /** Total tool time */
  totalToolTimeMs: z.number().nonnegative().finite(),
  /** Turn count */
  turnCount: z.number().int().nonnegative(),
  /** Step count */
  stepCount: z.number().int().nonnegative(),
  /** Active route info */
  activeRoute: z.object({
    routeId: IdentifierSchema,
    providerId: IdentifierSchema,
    modelId: IdentifierSchema,
  }).optional(),
  /** Budget state */
  budgetState: z.object({
    tokensRemaining: z.number().int().nullable(),
    costRemaining: z.record(z.string(), z.number().finite()).nullable(),
    contextRemaining: z.number().int().nullable(),
  }).optional(),
  /** Source sequence range this insight covers */
  sourceSequenceRange: z.object({
    from: SequenceSchema,
    to: SequenceSchema,
  }),
  /** Whether this insight includes inherited parent metrics (fork) */
  includesInheritedMetrics: z.boolean(),
  /** Lineage info for fork-aware separation */
  lineage: z.object({
    parentSessionId: IdentifierSchema.optional(),
    forkPoint: SequenceSchema.optional(),
    inheritedTotals: z.object({
      inputTokens: z.number().int().nonnegative().finite(),
      outputTokens: z.number().int().nonnegative().finite(),
      costByCurrency: z.record(z.string(), z.number().nonnegative().finite()),
    }).optional(),
  }).optional(),
  /** Last verified source sequence */
  lastVerifiedSequence: SequenceSchema,
  /** Projection revision */
  projectionRevision: z.number().int().nonnegative(),
  /** Schema version */
  schemaVersion: z.literal(1),
  /** Projected at timestamp */
  projectedAt: TimestampSchema,
}).passthrough();

export type InsightRecord = z.infer<typeof InsightRecordSchema>;

// ─── Usage Ingestion Input ──────────────────────────────────────

export const UsageIngestionInputSchema = z.object({
  /** Request identity */
  requestId: IdentifierSchema,
  /** Turn identity */
  turnId: IdentifierSchema,
  /** Optional tool call identity */
  toolCallId: IdentifierSchema.optional(),
  /** Completion anchor */
  completionAnchorId: IdentifierSchema.optional(),
  /** Provider-reported token subdivisions (exclusive, non-overlapping) */
  reportedSubdivisions: TokenSubdivisionSchema.optional(),
  /** Provider identity */
  providerId: IdentifierSchema,
  /** Model identity */
  modelId: IdentifierSchema,
  /** Route identity */
  routeId: IdentifierSchema,
  /** Cost amount and currency (optional) */
  cost: z.object({
    amount: z.number().nonnegative().finite(),
    currencyId: IdentifierSchema,
  }).optional(),
  /** Latency measurements (optional) */
  latency: z.object({
    timeToFirstTokenMs: z.number().nonnegative().finite(),
    modelTimeMs: z.number().nonnegative().finite(),
    toolTimeMs: z.number().nonnegative().finite().optional(),
    throughputTokensPerSec: z.number().nonnegative().finite().optional(),
  }).optional(),
  /** Source event sequence */
  sourceSequence: SequenceSchema,
  /** Idempotency key for deduplication */
  idempotencyKey: IdentifierSchema,
  /** Whether this is a replay of historical data */
  isReplay: z.boolean(),
}).passthrough();

export type UsageIngestionInput = z.infer<typeof UsageIngestionInputSchema>;

// ─── Validation Diagnostic ──────────────────────────────────────

export const UsageDiagnosticSchema = z.object({
  code: z.enum([
    'invalid_schema',
    'non_finite_value',
    'unsupported_unit',
    'inconsistent_source_range',
    'incompatible_provenance',
    'duplicate_record',
    'budget_exceeded',
  ]),
  message: z.string(),
  field: z.string().optional(),
  value: z.unknown().optional(),
  recordId: IdentifierSchema.optional(),
}).passthrough();

export type UsageDiagnostic = z.infer<typeof UsageDiagnosticSchema>;
