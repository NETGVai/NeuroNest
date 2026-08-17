/**
 * Insight Presentation Schemas
 *
 * Zod schemas for concise and detailed insight views, classified metric
 * display models, provenance retention, and redacted attributed export.
 *
 * Values are derived exclusively from Projection_Service records (InsightRecord),
 * never from mounted Chat_Nodes (Requirement 48.16).
 *
 * Requirements: 48.1-48.22
 */

import { z } from 'zod';
import { IdentifierSchema, SequenceSchema, TimestampSchema } from '../../contracts/primitives';
import { MetricClassificationSchema } from '../../session/usage-schemas';

// ─── Classified Metric Value ────────────────────────────────────

/**
 * A single metric value with its classification and provenance.
 * Distinguishes reported, estimated, mixed, partial, and unavailable states
 * (Requirement 48.5, 48.11, 48.15, 48.22).
 */
export const ClassifiedMetricSchema = z.object({
  /** The metric's numeric value (must be finite). */
  value: z.number().finite(),
  /** Unit for the metric (e.g. 'tokens', 'ms', 'tokens/s', ratio). */
  unit: z.string().min(1),
  /** Classification of the metric source. */
  classification: MetricClassificationSchema,
  /** Last verified source sequence for this metric. */
  lastVerifiedSequence: SequenceSchema,
  /** Whether this field has verified components vs missing/estimated. */
  hasVerifiedComponent: z.boolean(),
});

export type ClassifiedMetric = z.infer<typeof ClassifiedMetricSchema>;

// ─── Route Provenance Display ───────────────────────────────────

/**
 * Route/provider/model provenance for display (Requirement 48.2, 48.7).
 */
export const RouteProvenanceDisplaySchema = z.object({
  routeId: IdentifierSchema,
  providerId: IdentifierSchema,
  modelId: IdentifierSchema,
  adapterId: IdentifierSchema.optional(),
  profileId: IdentifierSchema.optional(),
  promptFingerprint: IdentifierSchema.optional(),
  completionAnchorId: IdentifierSchema.optional(),
});

export type RouteProvenanceDisplay = z.infer<typeof RouteProvenanceDisplaySchema>;

// ─── Cost Display ───────────────────────────────────────────────

/**
 * A cost entry per currency with classification (Requirement 48.20).
 */
export const CostDisplayEntrySchema = z.object({
  currencyId: IdentifierSchema,
  amount: z.number().nonnegative().finite(),
  classification: MetricClassificationSchema,
});

export type CostDisplayEntry = z.infer<typeof CostDisplayEntrySchema>;

/**
 * Currency conversion display (Requirement 48.21).
 */
export const ConversionDisplaySchema = z.object({
  sourceCurrencyId: IdentifierSchema,
  targetCurrencyId: IdentifierSchema,
  sourceAmount: z.number().nonnegative().finite(),
  convertedAmount: z.number().nonnegative().finite(),
  conversionRate: z.number().positive().finite(),
  conversionVersion: IdentifierSchema,
  sourceSequenceRange: z.object({ from: SequenceSchema, to: SequenceSchema }),
});

export type ConversionDisplay = z.infer<typeof ConversionDisplaySchema>;

// ─── Budget State Display ───────────────────────────────────────

export const BudgetStateDisplaySchema = z.object({
  tokensRemaining: z.number().int().nullable(),
  costRemaining: z.record(z.string(), z.number().finite()).nullable(),
  contextRemaining: z.number().int().nullable(),
});

export type BudgetStateDisplay = z.infer<typeof BudgetStateDisplaySchema>;

// ─── Concise Insight View ───────────────────────────────────────

/**
 * The concise default insight set for Session_Header display (Requirement 48.6).
 * Shows context pressure, token totals, cache status, cost/unavailable, active route, budget.
 */
export const ConciseInsightViewSchema = z.object({
  /** Context occupancy / pressure metric. */
  contextPressure: ClassifiedMetricSchema,
  /** Total input tokens. */
  totalInputTokens: ClassifiedMetricSchema,
  /** Total output tokens. */
  totalOutputTokens: ClassifiedMetricSchema,
  /** Cache hit ratio or status. */
  cacheStatus: ClassifiedMetricSchema,
  /** Cost per currency or unavailable. */
  costs: z.array(CostDisplayEntrySchema),
  /** Active route provenance. */
  activeRoute: RouteProvenanceDisplaySchema.nullable(),
  /** Budget state if available. */
  budgetState: BudgetStateDisplaySchema.nullable(),
  /** Overall classification for the concise view. */
  overallClassification: MetricClassificationSchema,
  /** Source sequence range. */
  sourceSequenceRange: z.object({ from: SequenceSchema, to: SequenceSchema }),
  /** Last verified source sequence. */
  lastVerifiedSequence: SequenceSchema,
});

export type ConciseInsightView = z.infer<typeof ConciseInsightViewSchema>;

// ─── Detailed Insight View ──────────────────────────────────────

/**
 * The detailed insight view opened on demand (Requirement 48.7).
 * Adds token subdivisions, latency, counts, and full provenance.
 */
export const DetailedInsightViewSchema = z.object({
  /** Token subdivisions. */
  tokenSubdivisions: z.object({
    uncachedInput: ClassifiedMetricSchema,
    cacheRead: ClassifiedMetricSchema,
    cacheWrite: ClassifiedMetricSchema,
    output: ClassifiedMetricSchema,
    reasoning: ClassifiedMetricSchema,
  }),
  /** Cache hit ratio. */
  cacheHitRatio: ClassifiedMetricSchema,
  /** Costs per currency. */
  costs: z.array(CostDisplayEntrySchema),
  /** Cost uncertainty classification. */
  costClassification: MetricClassificationSchema,
  /** Time to first token. */
  timeToFirstToken: ClassifiedMetricSchema,
  /** Throughput. */
  throughput: ClassifiedMetricSchema,
  /** Model time. */
  modelTime: ClassifiedMetricSchema,
  /** Tool time. */
  toolTime: ClassifiedMetricSchema,
  /** Turn count. */
  turnCount: ClassifiedMetricSchema,
  /** Step count. */
  stepCount: ClassifiedMetricSchema,
  /** Route provenance. */
  routeProvenance: RouteProvenanceDisplaySchema.nullable(),
  /** Conversion records (Requirement 48.21). */
  conversions: z.array(ConversionDisplaySchema),
  /** Budget state. */
  budgetState: BudgetStateDisplaySchema.nullable(),
  /** Lineage info for fork-aware display (Requirement 48.10, 48.18). */
  lineage: z.object({
    parentSessionId: IdentifierSchema.optional(),
    forkPoint: SequenceSchema.optional(),
    inheritedTotals: z.object({
      inputTokens: z.number().int().nonnegative().finite(),
      outputTokens: z.number().int().nonnegative().finite(),
      costByCurrency: z.record(z.string(), z.number().nonnegative().finite()),
    }).optional(),
  }).nullable(),
  /** Source sequence range. */
  sourceSequenceRange: z.object({ from: SequenceSchema, to: SequenceSchema }),
  /** Last verified source sequence. */
  lastVerifiedSequence: SequenceSchema,
  /** Overall classification. */
  overallClassification: MetricClassificationSchema,
});

export type DetailedInsightView = z.infer<typeof DetailedInsightViewSchema>;

// ─── Redacted Attributed Export ─────────────────────────────────

/**
 * Redaction declaration entry for export (Requirement 48.12).
 */
export const RedactionDeclarationSchema = z.object({
  field: z.string().min(1),
  reason: z.enum(['privacy', 'authority', 'scope', 'incomplete']),
  redactedAt: TimestampSchema,
});

export type RedactionDeclaration = z.infer<typeof RedactionDeclarationSchema>;

/**
 * Attributed export record — includes metric source, classification,
 * uncertainty, route provenance, sequence range, and redaction declarations
 * (Requirement 48.12).
 */
export const InsightExportRecordSchema = z.object({
  /** Export identity. */
  exportId: IdentifierSchema,
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** Branch identity. */
  branchId: IdentifierSchema,
  /** Exported at timestamp. */
  exportedAt: TimestampSchema,
  /** Token metrics with classification and provenance. */
  tokenMetrics: z.object({
    totalInput: ClassifiedMetricSchema,
    totalOutput: ClassifiedMetricSchema,
    cacheRead: ClassifiedMetricSchema,
    cacheWrite: ClassifiedMetricSchema,
    reasoning: ClassifiedMetricSchema,
    contextOccupancy: ClassifiedMetricSchema,
    cacheHitRatio: ClassifiedMetricSchema,
  }),
  /** Cost metrics per currency. */
  costMetrics: z.array(z.object({
    currencyId: IdentifierSchema,
    amount: z.number().nonnegative().finite(),
    classification: MetricClassificationSchema,
    uncertaintyBounds: z.object({
      lowerBound: z.number().nonnegative().finite(),
      upperBound: z.number().nonnegative().finite(),
      confidence: z.number().min(0).max(1).finite(),
    }).nullable(),
  })),
  /** Latency metrics. */
  latencyMetrics: z.object({
    avgTimeToFirstToken: ClassifiedMetricSchema,
    avgThroughput: ClassifiedMetricSchema,
    totalModelTime: ClassifiedMetricSchema,
    totalToolTime: ClassifiedMetricSchema,
  }),
  /** Counts. */
  counts: z.object({
    turns: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
  }),
  /** Route provenance. */
  routeProvenance: RouteProvenanceDisplaySchema.nullable(),
  /** Conversions. */
  conversions: z.array(ConversionDisplaySchema),
  /** Session lineage (fork info). */
  lineage: z.object({
    parentSessionId: IdentifierSchema.optional(),
    forkPoint: SequenceSchema.optional(),
    inheritedTotals: z.object({
      inputTokens: z.number().int().nonnegative().finite(),
      outputTokens: z.number().int().nonnegative().finite(),
      costByCurrency: z.record(z.string(), z.number().nonnegative().finite()),
    }).optional(),
  }).nullable(),
  /** Source sequence range. */
  sourceSequenceRange: z.object({ from: SequenceSchema, to: SequenceSchema }),
  /** Reported vs estimated status (overall). */
  overallClassification: MetricClassificationSchema,
  /** Last verified source sequence. */
  lastVerifiedSequence: SequenceSchema,
  /** Projection revision at export time. */
  projectionRevision: z.number().int().nonnegative(),
  /** Redaction declarations. */
  redactions: z.array(RedactionDeclarationSchema),
  /** Schema version. */
  schemaVersion: z.literal(1),
});

export type InsightExportRecord = z.infer<typeof InsightExportRecordSchema>;
