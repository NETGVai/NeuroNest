/**
 * Insight Presentation Surface
 *
 * Derives concise and detailed insight views from InsightProjectionService
 * records exclusively. Values are never obtained from mounted Chat_Nodes.
 *
 * Key responsibilities:
 * - Render concise default insight set for Session_Header (Requirement 48.6)
 * - Render detailed insight view on demand (Requirement 48.7)
 * - Distinguish reported/estimated/mixed/partial/unavailable classifications (Requirement 48.5, 48.11, 48.15, 48.22)
 * - Retain last verified source sequence for partial/unavailable fields (Requirement 48.22)
 * - Maintain totals invariant across paging/compaction (Requirement 48.8, 48.9, 48.17)
 * - Separate inherited parent metrics from child billable activity in forks (Requirement 48.10, 48.18)
 * - Keep currency totals separate unless conversion exists (Requirement 48.20, 48.21)
 * - Expose redacted attributed export (Requirement 48.12)
 *
 * Requirements: 48.1-48.22
 */

import crypto from 'node:crypto';
import type {
  InsightRecord,
  MetricClassification,
  CurrencyConversion,
} from '../../session/usage-schemas';
import type {
  ConciseInsightView,
  DetailedInsightView,
  ClassifiedMetric,
  CostDisplayEntry,
  ConversionDisplay,
  RouteProvenanceDisplay,
  BudgetStateDisplay,
  InsightExportRecord,
  RedactionDeclaration,
} from './insight-schemas';

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for insight presentation rendering.
 */
export interface InsightPresentationConfig {
  /**
   * Fields to redact from export. Key is field path, value is redaction reason.
   */
  redactedFields?: Record<string, 'privacy' | 'authority' | 'scope' | 'incomplete'>;
}

export const DEFAULT_INSIGHT_PRESENTATION_CONFIG: InsightPresentationConfig = {
  redactedFields: {},
};

// ─── Helper: Build ClassifiedMetric ─────────────────────────────

/**
 * Build a ClassifiedMetric from a numeric value, unit, and classification.
 * Retains the last verified source sequence for provenance.
 */
function buildClassifiedMetric(
  value: number,
  unit: string,
  classification: MetricClassification,
  lastVerifiedSequence: number,
): ClassifiedMetric {
  return {
    value,
    unit,
    classification,
    lastVerifiedSequence,
    hasVerifiedComponent: classification === 'reported' || classification === 'mixed',
  };
}

/**
 * Determine classification for a derived metric field.
 * If value is 0 and overall classification is 'unavailable', the field is unavailable.
 * Otherwise, inherit the overall classification.
 */
function fieldClassification(
  value: number,
  overall: MetricClassification,
): MetricClassification {
  if (value === 0 && overall === 'unavailable') return 'unavailable';
  return overall;
}

// ─── Concise Insight Derivation ─────────────────────────────────

/**
 * Derive the concise insight view for Session_Header display.
 *
 * Requirement 48.6: Display concise default insight set.
 * Requirement 48.16: Derive from projection records, not mounted Chat_Nodes.
 * Requirement 48.22: Preserve last verified source sequence for mixed/partial/unavailable.
 */
export function deriveConciseInsightView(insight: InsightRecord): ConciseInsightView {
  const seq = insight.lastVerifiedSequence;
  const classification = insight.costClassification;

  const costs: CostDisplayEntry[] = Object.entries(insight.costByCurrency).map(
    ([currencyId, amount]) => ({
      currencyId,
      amount,
      classification,
    }),
  );

  const activeRoute: RouteProvenanceDisplay | null = insight.activeRoute
    ? {
        routeId: insight.activeRoute.routeId,
        providerId: insight.activeRoute.providerId,
        modelId: insight.activeRoute.modelId,
      }
    : null;

  const budgetState: BudgetStateDisplay | null = insight.budgetState
    ? {
        tokensRemaining: insight.budgetState.tokensRemaining,
        costRemaining: insight.budgetState.costRemaining,
        contextRemaining: insight.budgetState.contextRemaining,
      }
    : null;

  // Context pressure is the context occupancy as a classified metric
  const contextPressure = buildClassifiedMetric(
    insight.contextOccupancy,
    'tokens',
    fieldClassification(insight.contextOccupancy, classification),
    seq,
  );

  const totalInputTokens = buildClassifiedMetric(
    insight.totalInputTokens,
    'tokens',
    fieldClassification(insight.totalInputTokens, classification),
    seq,
  );

  const totalOutputTokens = buildClassifiedMetric(
    insight.totalOutputTokens,
    'tokens',
    fieldClassification(insight.totalOutputTokens, classification),
    seq,
  );

  const cacheStatus = buildClassifiedMetric(
    insight.cacheHitRatio,
    'ratio',
    fieldClassification(insight.cacheHitRatio, classification),
    seq,
  );

  return {
    contextPressure,
    totalInputTokens,
    totalOutputTokens,
    cacheStatus,
    costs,
    activeRoute,
    budgetState,
    overallClassification: classification,
    sourceSequenceRange: insight.sourceSequenceRange,
    lastVerifiedSequence: seq,
  };
}

// ─── Detailed Insight Derivation ────────────────────────────────

/**
 * Derive the detailed insight view for on-demand display.
 *
 * Requirement 48.7: Display token subdivisions, cache metrics, cost uncertainty,
 * time to first token, throughput, model time, tool time, counts, and provenance.
 * Requirement 48.10, 48.18: Identify inherited historical metrics and child-session
 * billable activity separately.
 */
export function deriveDetailedInsightView(
  insight: InsightRecord,
  conversions?: CurrencyConversion[],
): DetailedInsightView {
  const seq = insight.lastVerifiedSequence;
  const classification = insight.costClassification;

  const tokenSubdivisions = {
    uncachedInput: buildClassifiedMetric(
      insight.totalInputTokens,
      'tokens',
      fieldClassification(insight.totalInputTokens, classification),
      seq,
    ),
    cacheRead: buildClassifiedMetric(
      insight.totalCacheReadTokens,
      'tokens',
      fieldClassification(insight.totalCacheReadTokens, classification),
      seq,
    ),
    cacheWrite: buildClassifiedMetric(
      insight.totalCacheWriteTokens,
      'tokens',
      fieldClassification(insight.totalCacheWriteTokens, classification),
      seq,
    ),
    output: buildClassifiedMetric(
      insight.totalOutputTokens,
      'tokens',
      fieldClassification(insight.totalOutputTokens, classification),
      seq,
    ),
    reasoning: buildClassifiedMetric(
      0, // reasoning not stored on InsightRecord directly, derived from turns
      'tokens',
      'unavailable',
      seq,
    ),
  };

  const costs: CostDisplayEntry[] = Object.entries(insight.costByCurrency).map(
    ([currencyId, amount]) => ({
      currencyId,
      amount,
      classification,
    }),
  );

  const conversionDisplays: ConversionDisplay[] = (conversions ?? []).map((c) => ({
    sourceCurrencyId: c.sourceCurrencyId,
    targetCurrencyId: c.targetCurrencyId,
    sourceAmount: c.sourceAmount,
    convertedAmount: c.convertedAmount,
    conversionRate: c.conversionRate,
    conversionVersion: c.conversionVersion,
    sourceSequenceRange: c.sourceSequenceRange,
  }));

  const routeProvenance: RouteProvenanceDisplay | null = insight.activeRoute
    ? {
        routeId: insight.activeRoute.routeId,
        providerId: insight.activeRoute.providerId,
        modelId: insight.activeRoute.modelId,
      }
    : null;

  const budgetState: BudgetStateDisplay | null = insight.budgetState
    ? {
        tokensRemaining: insight.budgetState.tokensRemaining,
        costRemaining: insight.budgetState.costRemaining,
        contextRemaining: insight.budgetState.contextRemaining,
      }
    : null;

  const lineage = insight.lineage
    ? {
        parentSessionId: insight.lineage.parentSessionId,
        forkPoint: insight.lineage.forkPoint,
        inheritedTotals: insight.lineage.inheritedTotals,
      }
    : null;

  return {
    tokenSubdivisions,
    cacheHitRatio: buildClassifiedMetric(
      insight.cacheHitRatio,
      'ratio',
      fieldClassification(insight.cacheHitRatio, classification),
      seq,
    ),
    costs,
    costClassification: classification,
    timeToFirstToken: buildClassifiedMetric(
      insight.avgTimeToFirstTokenMs,
      'ms',
      fieldClassification(insight.avgTimeToFirstTokenMs, classification),
      seq,
    ),
    throughput: buildClassifiedMetric(
      insight.avgThroughputTokensPerSec,
      'tokens/s',
      fieldClassification(insight.avgThroughputTokensPerSec, classification),
      seq,
    ),
    modelTime: buildClassifiedMetric(
      insight.totalModelTimeMs,
      'ms',
      fieldClassification(insight.totalModelTimeMs, classification),
      seq,
    ),
    toolTime: buildClassifiedMetric(
      insight.totalToolTimeMs,
      'ms',
      fieldClassification(insight.totalToolTimeMs, classification),
      seq,
    ),
    turnCount: buildClassifiedMetric(
      insight.turnCount,
      'count',
      fieldClassification(insight.turnCount, classification),
      seq,
    ),
    stepCount: buildClassifiedMetric(
      insight.stepCount,
      'count',
      fieldClassification(insight.stepCount, classification),
      seq,
    ),
    routeProvenance,
    conversions: conversionDisplays,
    budgetState,
    lineage,
    sourceSequenceRange: insight.sourceSequenceRange,
    lastVerifiedSequence: seq,
    overallClassification: classification,
  };
}

// ─── Redacted Attributed Export ─────────────────────────────────

/**
 * Build a redacted attributed export record from an insight projection.
 *
 * Requirement 48.12: Include metric source, reported/estimated status,
 * uncertainty, route provenance, sequence range, and redaction declarations.
 *
 * @param insight The InsightRecord from Projection_Service.
 * @param conversions Currency conversion records.
 * @param config Presentation configuration specifying redacted fields.
 * @returns The InsightExportRecord with redaction declarations.
 */
export function buildInsightExport(
  insight: InsightRecord,
  conversions: CurrencyConversion[],
  config: InsightPresentationConfig = DEFAULT_INSIGHT_PRESENTATION_CONFIG,
): InsightExportRecord {
  const seq = insight.lastVerifiedSequence;
  const classification = insight.costClassification;
  const now = new Date().toISOString();

  // Build redaction declarations
  const redactions: RedactionDeclaration[] = [];
  const redactedFields = config.redactedFields ?? {};
  for (const [field, reason] of Object.entries(redactedFields)) {
    redactions.push({ field, reason, redactedAt: now });
  }

  // Mark unavailable fields as 'incomplete' redaction
  if (classification === 'unavailable' || classification === 'partial') {
    if (Object.keys(insight.costByCurrency).length === 0) {
      redactions.push({ field: 'costMetrics', reason: 'incomplete', redactedAt: now });
    }
  }

  const tokenMetrics = {
    totalInput: buildClassifiedMetric(
      insight.totalInputTokens,
      'tokens',
      fieldClassification(insight.totalInputTokens, classification),
      seq,
    ),
    totalOutput: buildClassifiedMetric(
      insight.totalOutputTokens,
      'tokens',
      fieldClassification(insight.totalOutputTokens, classification),
      seq,
    ),
    cacheRead: buildClassifiedMetric(
      insight.totalCacheReadTokens,
      'tokens',
      fieldClassification(insight.totalCacheReadTokens, classification),
      seq,
    ),
    cacheWrite: buildClassifiedMetric(
      insight.totalCacheWriteTokens,
      'tokens',
      fieldClassification(insight.totalCacheWriteTokens, classification),
      seq,
    ),
    reasoning: buildClassifiedMetric(
      0,
      'tokens',
      'unavailable',
      seq,
    ),
    contextOccupancy: buildClassifiedMetric(
      insight.contextOccupancy,
      'tokens',
      fieldClassification(insight.contextOccupancy, classification),
      seq,
    ),
    cacheHitRatio: buildClassifiedMetric(
      insight.cacheHitRatio,
      'ratio',
      fieldClassification(insight.cacheHitRatio, classification),
      seq,
    ),
  };

  const costMetrics = Object.entries(insight.costByCurrency).map(
    ([currencyId, amount]) => ({
      currencyId,
      amount,
      classification,
      uncertaintyBounds: null,
    }),
  );

  const latencyMetrics = {
    avgTimeToFirstToken: buildClassifiedMetric(
      insight.avgTimeToFirstTokenMs,
      'ms',
      fieldClassification(insight.avgTimeToFirstTokenMs, classification),
      seq,
    ),
    avgThroughput: buildClassifiedMetric(
      insight.avgThroughputTokensPerSec,
      'tokens/s',
      fieldClassification(insight.avgThroughputTokensPerSec, classification),
      seq,
    ),
    totalModelTime: buildClassifiedMetric(
      insight.totalModelTimeMs,
      'ms',
      fieldClassification(insight.totalModelTimeMs, classification),
      seq,
    ),
    totalToolTime: buildClassifiedMetric(
      insight.totalToolTimeMs,
      'ms',
      fieldClassification(insight.totalToolTimeMs, classification),
      seq,
    ),
  };

  const conversionDisplays: ConversionDisplay[] = conversions.map((c) => ({
    sourceCurrencyId: c.sourceCurrencyId,
    targetCurrencyId: c.targetCurrencyId,
    sourceAmount: c.sourceAmount,
    convertedAmount: c.convertedAmount,
    conversionRate: c.conversionRate,
    conversionVersion: c.conversionVersion,
    sourceSequenceRange: c.sourceSequenceRange,
  }));

  const routeProvenance: RouteProvenanceDisplay | null = insight.activeRoute
    ? {
        routeId: insight.activeRoute.routeId,
        providerId: insight.activeRoute.providerId,
        modelId: insight.activeRoute.modelId,
      }
    : null;

  const lineage = insight.lineage
    ? {
        parentSessionId: insight.lineage.parentSessionId,
        forkPoint: insight.lineage.forkPoint,
        inheritedTotals: insight.lineage.inheritedTotals,
      }
    : null;

  return {
    exportId: crypto.randomUUID(),
    sessionId: insight.sessionId,
    branchId: insight.branchId,
    exportedAt: now,
    tokenMetrics,
    costMetrics,
    latencyMetrics,
    counts: {
      turns: insight.turnCount,
      steps: insight.stepCount,
    },
    routeProvenance,
    conversions: conversionDisplays,
    lineage,
    sourceSequenceRange: insight.sourceSequenceRange,
    overallClassification: classification,
    lastVerifiedSequence: seq,
    projectionRevision: insight.projectionRevision,
    redactions,
    schemaVersion: 1,
  };
}

// ─── Presentation Helpers ───────────────────────────────────────

/**
 * Determine if an insight view has any unavailable or partial fields.
 * Useful for deciding whether to show a "data incomplete" indicator.
 */
export function hasIncompleteData(concise: ConciseInsightView): boolean {
  return (
    concise.overallClassification === 'unavailable' ||
    concise.overallClassification === 'partial' ||
    concise.contextPressure.classification === 'unavailable' ||
    concise.cacheStatus.classification === 'unavailable'
  );
}

/**
 * Determine whether insight represents a forked session with inherited metrics.
 */
export function isForkInsight(insight: InsightRecord): boolean {
  return insight.includesInheritedMetrics && insight.lineage !== undefined;
}

/**
 * Get the display label for a classification.
 */
export function classificationLabel(classification: MetricClassification): string {
  switch (classification) {
    case 'reported':
      return 'Provider-reported';
    case 'estimated':
      return 'Estimated';
    case 'mixed':
      return 'Mixed (reported + estimated)';
    case 'partial':
      return 'Partial';
    case 'unavailable':
      return 'Unavailable';
  }
}
