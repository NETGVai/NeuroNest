/**
 * Insight Projection Service — Durable, Paging/Compaction/Fork-Invariant Insights
 *
 * Projects usage, cost, latency, and provenance records into stable insight totals
 * that persist across paging, checkpoint restoration, compaction, and forks.
 *
 * Key invariants:
 * - Insight totals are stable across paging/compaction operations (Requirement 48.8, 48.9, 48.17)
 * - Forked sessions correctly separate inherited parent history from child activity (Requirement 48.10, 48.18)
 * - Currency totals remain separate unless a versioned conversion links them (Requirement 48.20, 48.21)
 * - Mixed/partial/unavailable fields are distinguished (Requirement 48.5, 48.11, 48.22)
 * - Each metric is classified and retains contributing source sequences (Requirement 48.15)
 *
 * Requirements: 48.1–48.22
 */

import crypto from 'node:crypto';
import {
  type InsightRecord,
  type UsageRecord,
  type CostEntry,
  type LatencyEntry,
  type CurrencyConversion,
  type MetricClassification,
} from './usage-schemas';

// ─── Types ──────────────────────────────────────────────────────

export interface InsightProjectionConfig {
  sessionId: string;
  branchId: string;
  /** Parent session ID if this is a fork */
  parentSessionId?: string;
  /** Fork point sequence in parent */
  forkPoint?: number;
  /** Inherited totals from parent session at fork point */
  inheritedTotals?: {
    inputTokens: number;
    outputTokens: number;
    costByCurrency: Record<string, number>;
  };
}

export interface RouteProvenance {
  routeId: string;
  providerId: string;
  modelId: string;
  adapterId?: string | undefined;
  profileId?: string | undefined;
  promptFingerprint?: string | undefined;
  completionAnchorId?: string | undefined;
}

export interface TurnInsight {
  turnId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costByCurrency: Record<string, number>;
  timeToFirstTokenMs: number;
  modelTimeMs: number;
  toolTimeMs: number;
  throughputTokensPerSec: number;
  classification: MetricClassification;
  route: RouteProvenance;
  sourceSequence: number;
}

// ─── Insight Projection Service ─────────────────────────────────

export class InsightProjectionService {
  private readonly config: InsightProjectionConfig;

  /** Accumulated turn-level insights indexed by turnId */
  private readonly turnInsights: Map<string, TurnInsight> = new Map();
  /** Running aggregates for session-level totals */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalReasoningTokens = 0;
  private readonly costByCurrency: Map<string, number> = new Map();
  private totalTimeToFirstTokenMs = 0;
  private latencyCount = 0;
  private totalModelTimeMs = 0;
  private totalToolTimeMs = 0;
  private totalThroughput = 0;
  private turnCount = 0;
  private stepCount = 0;
  private lastVerifiedSequence = 0;
  private projectionRevision = 0;
  /** Source sequence range */
  private minSequence = Infinity;
  private maxSequence = 0;
  /** Last active route */
  private activeRoute: { routeId: string; providerId: string; modelId: string } | undefined;
  /** Overall classification across all metrics */
  private overallClassification: MetricClassification = 'unavailable';
  /** Conversion records for cross-currency operations */
  private readonly conversions: CurrencyConversion[] = [];
  /** Track unique turn IDs we've seen */
  private readonly seenTurnIds: Set<string> = new Set();

  constructor(config: InsightProjectionConfig) {
    this.config = config;
  }

  // ─── Projection from Usage Records ─────────────────────────

  /**
   * Project a batch of usage records into insight totals.
   * Maintains stable totals that are invariant under paging/compaction.
   *
   * Requirement 48.1: Derive token subdivisions from durable records.
   * Requirement 48.8: Retain unchanged totals when paging removes nodes.
   * Requirement 48.9: Retain pre-compaction records and distinguish projected occupancy.
   * Requirement 48.17: Preserve totals under paging/checkpoint/compaction/replay changes.
   */
  projectUsageRecords(records: UsageRecord[]): void {
    for (const record of records) {
      // Only project non-replay billable activity for this session
      if (record.isReplay) continue;

      const { tokenSubdivisions } = record;

      this.totalInputTokens += tokenSubdivisions.uncachedInput;
      this.totalOutputTokens += tokenSubdivisions.output;
      this.totalCacheReadTokens += tokenSubdivisions.cacheRead;
      this.totalCacheWriteTokens += tokenSubdivisions.cacheWrite;
      this.totalReasoningTokens += tokenSubdivisions.reasoning;

      // Track unique turns
      if (!this.seenTurnIds.has(record.turnId)) {
        this.seenTurnIds.add(record.turnId);
        this.turnCount++;
      }
      this.stepCount++;

      // Update sequence range
      this.minSequence = Math.min(this.minSequence, record.sourceSequence);
      this.maxSequence = Math.max(this.maxSequence, record.sourceSequence);
      this.lastVerifiedSequence = Math.max(this.lastVerifiedSequence, record.sourceSequence);

      // Update active route
      this.activeRoute = {
        routeId: record.routeId,
        providerId: record.providerId,
        modelId: record.modelId,
      };

      // Update overall classification
      this.overallClassification = this.mergeClassification(
        this.overallClassification,
        record.classification,
      );

      // Build or update turn insight
      this.updateTurnInsight(record);
    }

    this.projectionRevision++;
  }

  /**
   * Project cost entries into insight totals.
   * Preserves separate currency totals (Requirement 48.20).
   */
  projectCostEntries(entries: CostEntry[]): void {
    for (const entry of entries) {
      if (entry.isReplay) continue;

      this.costByCurrency.set(
        entry.currencyId,
        (this.costByCurrency.get(entry.currencyId) ?? 0) + entry.amount,
      );

      // Update turn insight cost
      const turnInsight = this.turnInsights.get(entry.turnId);
      if (turnInsight) {
        turnInsight.costByCurrency[entry.currencyId] =
          (turnInsight.costByCurrency[entry.currencyId] ?? 0) + entry.amount;
      }
    }
  }

  /**
   * Project latency entries into insight totals.
   *
   * Requirement 48.1: Derive time to first token, throughput, model time, tool time.
   */
  projectLatencyEntries(entries: LatencyEntry[]): void {
    for (const entry of entries) {
      if (entry.isReplay) continue;

      this.totalTimeToFirstTokenMs += entry.timeToFirstTokenMs;
      this.totalModelTimeMs += entry.modelTimeMs;
      this.totalToolTimeMs += entry.toolTimeMs;
      this.totalThroughput += entry.throughputTokensPerSec;
      this.latencyCount++;

      // Update turn insight latency
      const turnInsight = this.turnInsights.get(entry.turnId);
      if (turnInsight) {
        turnInsight.timeToFirstTokenMs = entry.timeToFirstTokenMs;
        turnInsight.modelTimeMs = entry.modelTimeMs;
        turnInsight.toolTimeMs = entry.toolTimeMs;
        turnInsight.throughputTokensPerSec = entry.throughputTokensPerSec;
      }
    }
  }

  /**
   * Register a currency conversion for cross-currency insight display.
   *
   * Requirement 48.21: Retain source amounts, currency IDs, conversion version, rate, and range.
   */
  registerConversion(conversion: CurrencyConversion): void {
    this.conversions.push(conversion);
  }

  // ─── Insight Snapshot ───────────────────────────────────────

  /**
   * Build the current insight record.
   * This is the durable projection that persists across paging and compaction.
   *
   * Requirement 48.16: Derive from projection records, not mounted Chat_Nodes.
   * Requirement 48.17: Preserve totals under paging/checkpoint/compaction/replay.
   * Requirement 48.10: Separate inherited metrics from child activity on fork.
   * Requirement 48.18: Label each metric with contributing session lineage.
   */
  buildInsight(): InsightRecord {
    const now = new Date().toISOString();
    const contextOccupancy = this.totalInputTokens + this.totalCacheReadTokens;

    const cacheHitRatio = this.computeCacheHitRatio();
    const avgTimeToFirstToken = this.latencyCount > 0
      ? this.totalTimeToFirstTokenMs / this.latencyCount
      : 0;
    const avgThroughput = this.latencyCount > 0
      ? this.totalThroughput / this.latencyCount
      : 0;

    const costByCurrencyObj: Record<string, number> = {};
    for (const [currency, amount] of this.costByCurrency) {
      costByCurrencyObj[currency] = amount;
    }

    const insight: InsightRecord = {
      insightId: crypto.randomUUID(),
      sessionId: this.config.sessionId,
      branchId: this.config.branchId,
      contextOccupancy,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      cacheHitRatio,
      costByCurrency: costByCurrencyObj,
      costClassification: this.costByCurrency.size > 0 ? this.overallClassification : 'unavailable',
      avgTimeToFirstTokenMs: avgTimeToFirstToken,
      avgThroughputTokensPerSec: avgThroughput,
      totalModelTimeMs: this.totalModelTimeMs,
      totalToolTimeMs: this.totalToolTimeMs,
      turnCount: this.turnCount,
      stepCount: this.stepCount,
      activeRoute: this.activeRoute,
      budgetState: undefined,
      sourceSequenceRange: {
        from: this.minSequence === Infinity ? 0 : this.minSequence,
        to: this.maxSequence,
      },
      includesInheritedMetrics: this.config.parentSessionId !== undefined,
      lineage: this.config.parentSessionId
        ? {
            parentSessionId: this.config.parentSessionId,
            forkPoint: this.config.forkPoint,
            inheritedTotals: this.config.inheritedTotals,
          }
        : undefined,
      lastVerifiedSequence: this.lastVerifiedSequence,
      projectionRevision: this.projectionRevision,
      schemaVersion: 1,
      projectedAt: now,
    };

    return insight;
  }

  /**
   * Build insight with budget state information.
   *
   * Requirement 48.6: Display budget state in session header.
   */
  buildInsightWithBudget(budgetState: {
    tokensRemaining: number | null;
    costRemaining: Record<string, number> | null;
    contextRemaining: number | null;
  }): InsightRecord {
    const insight = this.buildInsight();
    insight.budgetState = budgetState;
    return insight;
  }

  // ─── Fork-Aware Projection (Requirement 48.10, 48.18) ──────

  /**
   * Get the child-only (non-inherited) totals for a forked session.
   * Since the InsightProjectionService only projects records that are actually
   * submitted to it (child session activity), the totals already represent
   * child-only activity. This method returns them explicitly for clarity.
   */
  getChildOnlyTotals(): {
    inputTokens: number;
    outputTokens: number;
    costByCurrency: Record<string, number>;
  } {
    const costByCurrency: Record<string, number> = {};
    for (const [currency, amount] of this.costByCurrency) {
      costByCurrency[currency] = amount;
    }

    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      costByCurrency,
    };
  }

  // ─── Turn-Level Insights ────────────────────────────────────

  /**
   * Get insight for a specific turn.
   *
   * Requirement 48.2: Derive per-turn route, provider, model, adapter provenance.
   */
  getTurnInsight(turnId: string): TurnInsight | undefined {
    return this.turnInsights.get(turnId);
  }

  /** Get all turn insights */
  getAllTurnInsights(): TurnInsight[] {
    return [...this.turnInsights.values()];
  }

  // ─── Projection Metadata ────────────────────────────────────

  /** Get the current projection revision */
  getProjectionRevision(): number {
    return this.projectionRevision;
  }

  /** Get the last verified source sequence */
  getLastVerifiedSequence(): number {
    return this.lastVerifiedSequence;
  }

  /** Get overall metric classification */
  getOverallClassification(): MetricClassification {
    return this.overallClassification;
  }

  /** Get registered conversions */
  getConversions(): CurrencyConversion[] {
    return [...this.conversions];
  }

  // ─── Private Helpers ────────────────────────────────────────

  private computeCacheHitRatio(): number {
    const totalReads = this.totalCacheReadTokens;
    const totalInputPlusCacheRead = this.totalInputTokens + this.totalCacheReadTokens;
    if (totalInputPlusCacheRead === 0) return 0;
    return totalReads / totalInputPlusCacheRead;
  }

  private updateTurnInsight(record: UsageRecord): void {
    const existing = this.turnInsights.get(record.turnId);
    if (existing) {
      // Accumulate within turn
      existing.inputTokens += record.tokenSubdivisions.uncachedInput;
      existing.outputTokens += record.tokenSubdivisions.output;
      existing.cacheReadTokens += record.tokenSubdivisions.cacheRead;
      existing.cacheWriteTokens += record.tokenSubdivisions.cacheWrite;
      existing.reasoningTokens += record.tokenSubdivisions.reasoning;
      existing.sourceSequence = Math.max(existing.sourceSequence, record.sourceSequence);
      existing.classification = this.mergeClassification(existing.classification, record.classification);
    } else {
      this.turnInsights.set(record.turnId, {
        turnId: record.turnId,
        inputTokens: record.tokenSubdivisions.uncachedInput,
        outputTokens: record.tokenSubdivisions.output,
        cacheReadTokens: record.tokenSubdivisions.cacheRead,
        cacheWriteTokens: record.tokenSubdivisions.cacheWrite,
        reasoningTokens: record.tokenSubdivisions.reasoning,
        costByCurrency: {},
        timeToFirstTokenMs: 0,
        modelTimeMs: 0,
        toolTimeMs: 0,
        throughputTokensPerSec: 0,
        classification: record.classification,
        route: {
          routeId: record.routeId,
          providerId: record.providerId,
          modelId: record.modelId,
          completionAnchorId: record.completionAnchorId,
        },
        sourceSequence: record.sourceSequence,
      });
    }
  }

  /**
   * Merge two classifications using the dominance hierarchy:
   * unavailable < partial < estimated < mixed < reported
   * If different non-unavailable types combine, the result is 'mixed'.
   */
  private mergeClassification(a: MetricClassification, b: MetricClassification): MetricClassification {
    if (a === 'unavailable') return b;
    if (b === 'unavailable') return a;
    if (a === b) return a;
    return 'mixed';
  }
}
