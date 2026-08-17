/**
 * Usage Accountant — Replay-Aware Token, Context, Cache, Cost, and Latency Accounting
 *
 * Responsibilities:
 * - Ingest provider-reported exclusive token subdivisions or deterministic estimates
 * - Gate operations against budget limits (session, model, provider)
 * - Attribute cost and latency to immutable request/turn/route identities
 * - Validate finite values, units, and provenance
 * - Separate currencies without forced conversion
 * - Track replay vs billable activity
 * - Emit structured diagnostics for invalid records
 *
 * Key invariants:
 * - No token is counted in more than one subdivision total
 * - Replayed events do not generate duplicate billing
 * - Budget gating uses the configured policy (stop, ask, fallback)
 * - Currency totals remain separate unless a versioned conversion links them
 *
 * Requirements: 17.1–17.7, 48.1–48.5, 48.15, 48.19
 */

import crypto from 'node:crypto';
import {
  UsageRecordSchema,
  CostEntrySchema,
  LatencyEntrySchema,
  UsageIngestionInputSchema,
  CurrencyConversionSchema,
  TokenSubdivisionSchema,
  type UsageRecord,
  type CostEntry,
  type LatencyEntry,
  type BudgetConfig,
  type BudgetGateResult,
  type UsageIngestionInput,
  type UsageDiagnostic,
  type CurrencyConversion,
  type MetricClassification,
  type TokenSubdivision,
  type UncertaintyBounds,
  type EstimatorIdentity,
} from './usage-schemas';

// ─── Deterministic Estimator Interface ──────────────────────────

export interface TokenEstimator {
  /** Estimator identity and version */
  identity: EstimatorIdentity;
  /** Produce token estimates from whatever context is available */
  estimate(context: {
    requestId: string;
    modelId: string;
    promptTokenHint?: number;
    completionTokenHint?: number;
  }): { subdivisions: TokenSubdivision; uncertainty: Record<string, UncertaintyBounds> };
}

// ─── Usage Accountant Configuration ─────────────────────────────

export interface UsageAccountantConfig {
  /** Session this accountant operates on */
  sessionId: string;
  /** Branch identity */
  branchId: string;
  /** Budget configuration, if any */
  budget?: BudgetConfig;
  /** Token estimator for when provider data is absent */
  estimator?: TokenEstimator;
}

// ─── Usage Accountant ───────────────────────────────────────────

export class UsageAccountant {
  private readonly config: UsageAccountantConfig;
  /** In-memory usage records indexed by idempotency key for dedup */
  private readonly usageRecords: Map<string, UsageRecord> = new Map();
  /** Cost entries indexed by idempotency key */
  private readonly costEntries: Map<string, CostEntry> = new Map();
  /** Latency entries indexed by idempotency key */
  private readonly latencyEntries: Map<string, LatencyEntry> = new Map();
  /** Diagnostics accumulated during ingestion */
  private readonly diagnostics: UsageDiagnostic[] = [];
  /** Currency conversion records */
  private readonly conversions: CurrencyConversion[] = [];
  /** Running totals per currency for budget gating */
  private readonly totalTokensByModel: Map<string, number> = new Map();
  private readonly totalCostByCurrency: Map<string, number> = new Map();
  private totalBillableTokens = 0;
  private totalContextTokens = 0;

  constructor(config: UsageAccountantConfig) {
    this.config = config;
  }

  // ─── Ingestion ──────────────────────────────────────────────

  /**
   * Ingest usage data from a provider response or estimate.
   * Returns the created UsageRecord or null if rejected/deduplicated.
   *
   * Requirement 17.1: Record exclusive subdivisions without double-counting.
   * Requirement 17.2: Apply deterministic estimator with uncertainty when absent.
   * Requirement 17.3: Distinguish replay from billable activity.
   */
  ingest(input: UsageIngestionInput): UsageRecord | null {
    // Validate input schema
    const parseResult = UsageIngestionInputSchema.safeParse(input);
    if (!parseResult.success) {
      this.emitDiagnostic({
        code: 'invalid_schema',
        message: `Invalid usage ingestion input: ${parseResult.error.message}`,
        field: parseResult.error.issues[0]?.path?.join('.'),
        value: undefined,
      });
      return null;
    }

    const validated = parseResult.data;

    // Idempotency check — skip duplicates (Requirement 17.3)
    if (this.usageRecords.has(validated.idempotencyKey)) {
      this.emitDiagnostic({
        code: 'duplicate_record',
        message: `Duplicate usage record with idempotency key: ${validated.idempotencyKey}`,
        recordId: validated.idempotencyKey,
      });
      return null;
    }

    // Determine token subdivisions and classification
    let subdivisions: TokenSubdivision;
    let classification: MetricClassification;
    let estimator: EstimatorIdentity | undefined;
    let uncertaintyBounds: Record<string, UncertaintyBounds> | undefined;

    if (validated.reportedSubdivisions) {
      // Provider-reported: exclusive subdivisions (Requirement 17.1)
      subdivisions = validated.reportedSubdivisions;
      classification = 'reported';
    } else if (this.config.estimator) {
      // Apply deterministic estimator with uncertainty (Requirement 17.2)
      const estimate = this.config.estimator.estimate({
        requestId: validated.requestId,
        modelId: validated.modelId,
      });
      subdivisions = estimate.subdivisions;
      uncertaintyBounds = estimate.uncertainty;
      estimator = this.config.estimator.identity;
      classification = 'estimated';
    } else {
      // No provider data and no estimator — mark unavailable
      subdivisions = {
        uncachedInput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
      };
      classification = 'unavailable';
    }

    // Validate subdivision values are finite and non-negative
    const subdivisionValidation = TokenSubdivisionSchema.safeParse(subdivisions);
    if (!subdivisionValidation.success) {
      this.emitDiagnostic({
        code: 'non_finite_value',
        message: `Token subdivision contains invalid value: ${subdivisionValidation.error.message}`,
        field: 'tokenSubdivisions',
        value: subdivisions,
        recordId: validated.idempotencyKey,
      });
      return null;
    }

    // Build usage record
    const usageId = crypto.randomUUID();
    const now = new Date().toISOString();

    const usageRecord: UsageRecord = {
      usageId,
      sessionId: this.config.sessionId,
      branchId: this.config.branchId,
      turnId: validated.turnId,
      requestId: validated.requestId,
      toolCallId: validated.toolCallId,
      completionAnchorId: validated.completionAnchorId,
      tokenSubdivisions: subdivisions,
      classification,
      estimator,
      uncertaintyBounds,
      routeId: validated.routeId,
      providerId: validated.providerId,
      modelId: validated.modelId,
      scope: { schemaVersion: 1, sessionId: this.config.sessionId },
      idempotencyKey: validated.idempotencyKey,
      isReplay: validated.isReplay,
      sourceSequence: validated.sourceSequence,
      schemaVersion: 1,
      recordedAt: now,
    };

    // Validate the full usage record
    const recordValidation = UsageRecordSchema.safeParse(usageRecord);
    if (!recordValidation.success) {
      this.emitDiagnostic({
        code: 'invalid_schema',
        message: `Constructed usage record failed validation: ${recordValidation.error.message}`,
        recordId: usageId,
      });
      return null;
    }

    // Store the record
    this.usageRecords.set(validated.idempotencyKey, usageRecord);

    // Update running totals only for non-replay billable activity (Requirement 17.3)
    if (!validated.isReplay) {
      const totalTokens = subdivisions.uncachedInput +
        subdivisions.cacheRead +
        subdivisions.cacheWrite +
        subdivisions.output +
        subdivisions.reasoning;
      this.totalBillableTokens += totalTokens;
      this.totalContextTokens += subdivisions.uncachedInput + subdivisions.cacheRead;

      // Track per-model totals
      const modelKey = validated.modelId;
      this.totalTokensByModel.set(
        modelKey,
        (this.totalTokensByModel.get(modelKey) ?? 0) + totalTokens,
      );
    }

    // Ingest cost if provided (Requirement 17.7)
    if (validated.cost) {
      this.ingestCost(usageRecord, validated.cost, validated.isReplay);
    }

    // Ingest latency if provided (Requirement 17.7)
    if (validated.latency) {
      this.ingestLatency(usageRecord, validated.latency, validated.isReplay);
    }

    return usageRecord;
  }

  // ─── Cost Ingestion ─────────────────────────────────────────

  private ingestCost(
    usage: UsageRecord,
    cost: { amount: number; currencyId: string },
    isReplay: boolean,
  ): CostEntry | null {
    const costId = crypto.randomUUID();
    const costKey = `cost:${usage.idempotencyKey}`;

    if (this.costEntries.has(costKey)) {
      return null;
    }

    const entry: CostEntry = {
      costId,
      usageId: usage.usageId,
      sessionId: usage.sessionId,
      branchId: usage.branchId,
      turnId: usage.turnId,
      requestId: usage.requestId,
      routeId: usage.routeId,
      providerId: usage.providerId,
      modelId: usage.modelId,
      amount: cost.amount,
      currencyId: cost.currencyId,
      classification: usage.classification,
      uncertaintyBounds: undefined,
      isReplay,
      idempotencyKey: costKey,
      sourceSequence: usage.sourceSequence,
      schemaVersion: 1,
      recordedAt: usage.recordedAt,
    };

    const validation = CostEntrySchema.safeParse(entry);
    if (!validation.success) {
      this.emitDiagnostic({
        code: 'non_finite_value',
        message: `Cost entry validation failed: ${validation.error.message}`,
        field: 'cost',
        recordId: costId,
      });
      return null;
    }

    this.costEntries.set(costKey, entry);

    // Update running cost totals only for non-replay (Requirement 17.3)
    if (!isReplay) {
      this.totalCostByCurrency.set(
        cost.currencyId,
        (this.totalCostByCurrency.get(cost.currencyId) ?? 0) + cost.amount,
      );
    }

    return entry;
  }

  // ─── Latency Ingestion ──────────────────────────────────────

  private ingestLatency(
    usage: UsageRecord,
    latency: {
      timeToFirstTokenMs: number;
      modelTimeMs: number;
      toolTimeMs?: number | undefined;
      throughputTokensPerSec?: number | undefined;
    },
    isReplay: boolean,
  ): LatencyEntry | null {
    const latencyId = crypto.randomUUID();
    const latencyKey = `latency:${usage.idempotencyKey}`;

    if (this.latencyEntries.has(latencyKey)) {
      return null;
    }

    const entry: LatencyEntry = {
      latencyId,
      usageId: usage.usageId,
      sessionId: usage.sessionId,
      branchId: usage.branchId,
      turnId: usage.turnId,
      requestId: usage.requestId,
      routeId: usage.routeId,
      providerId: usage.providerId,
      modelId: usage.modelId,
      timeToFirstTokenMs: latency.timeToFirstTokenMs,
      modelTimeMs: latency.modelTimeMs,
      toolTimeMs: latency.toolTimeMs ?? 0,
      throughputTokensPerSec: latency.throughputTokensPerSec ?? 0,
      classification: usage.classification,
      isReplay,
      idempotencyKey: latencyKey,
      sourceSequence: usage.sourceSequence,
      schemaVersion: 1,
      recordedAt: usage.recordedAt,
    };

    const validation = LatencyEntrySchema.safeParse(entry);
    if (!validation.success) {
      this.emitDiagnostic({
        code: 'non_finite_value',
        message: `Latency entry validation failed: ${validation.error.message}`,
        field: 'latency',
        recordId: latencyId,
      });
      return null;
    }

    this.latencyEntries.set(latencyKey, entry);
    return entry;
  }

  // ─── Budget Gating (Requirement 17.5, 17.6) ────────────────

  /**
   * Gate a request against configured budgets.
   * Returns the gating result including whether the operation is allowed.
   *
   * Requirement 17.5: Gate against per-session, model, and provider budgets.
   * Requirement 17.6: Apply stop/ask/fallback policy when threshold reached.
   */
  gateBudget(params: {
    modelId: string;
    providerId: string;
    estimatedTokens?: number;
    estimatedCost?: { amount: number; currencyId: string };
  }): BudgetGateResult {
    const budget = this.config.budget;

    // No budget configured — allow
    if (!budget) {
      return { allowed: true };
    }

    // Check token budget
    if (budget.maxTokens !== null) {
      const projected = this.totalBillableTokens + (params.estimatedTokens ?? 0);
      if (projected >= budget.maxTokens) {
        return {
          allowed: false,
          appliedPolicy: budget.exhaustionPolicy,
          exceededDimension: 'tokens',
          currentValue: this.totalBillableTokens,
          limitValue: budget.maxTokens,
        };
      }
    }

    // Check context budget
    if (budget.maxContextTokens !== null) {
      if (this.totalContextTokens >= budget.maxContextTokens) {
        return {
          allowed: false,
          appliedPolicy: budget.exhaustionPolicy,
          exceededDimension: 'context',
          currentValue: this.totalContextTokens,
          limitValue: budget.maxContextTokens,
        };
      }
    }

    // Check cost budget per currency
    if (budget.maxCost !== null && params.estimatedCost) {
      const currencyId = params.estimatedCost.currencyId;
      const maxCostMap = budget.maxCost as Record<string, number>;
      const limit = maxCostMap[currencyId];
      if (limit !== undefined) {
        const currentCost = this.totalCostByCurrency.get(currencyId) ?? 0;
        const projected = currentCost + params.estimatedCost.amount;
        if (projected >= limit) {
          return {
            allowed: false,
            appliedPolicy: budget.exhaustionPolicy,
            exceededDimension: 'cost',
            currentValue: currentCost,
            limitValue: limit,
            currencyId,
          };
        }
      }
    }

    // Check model-specific overrides
    if (budget.modelOverrides) {
      const overrides = budget.modelOverrides as Record<string, { maxTokens?: number | null; maxContextTokens?: number | null; maxCost?: Record<string, number> | null }>;
      const modelOverride = overrides[params.modelId];
      if (modelOverride?.maxTokens !== undefined && modelOverride.maxTokens !== null) {
        const modelTokens = this.totalTokensByModel.get(params.modelId) ?? 0;
        if (modelTokens + (params.estimatedTokens ?? 0) >= modelOverride.maxTokens) {
          return {
            allowed: false,
            appliedPolicy: budget.exhaustionPolicy,
            exceededDimension: 'tokens',
            currentValue: modelTokens,
            limitValue: modelOverride.maxTokens,
          };
        }
      }
    }

    return { allowed: true };
  }

  // ─── Currency Conversion (Requirement 48.20, 48.21) ─────────

  /**
   * Register a versioned currency conversion record.
   * Preserves source amounts and both currency identities.
   */
  registerConversion(conversion: CurrencyConversion): boolean {
    const validation = CurrencyConversionSchema.safeParse(conversion);
    if (!validation.success) {
      this.emitDiagnostic({
        code: 'invalid_schema',
        message: `Currency conversion validation failed: ${validation.error.message}`,
        field: 'conversion',
      });
      return false;
    }
    this.conversions.push(conversion);
    return true;
  }

  // ─── Validation and Diagnostics (Requirement 48.19) ─────────

  /**
   * Validate a raw metric record and reject invalid entries.
   * Returns a diagnostic if rejected, null if valid.
   */
  validateMetricRecord(record: unknown): UsageDiagnostic | null {
    // Check for non-finite numeric values
    if (typeof record === 'object' && record !== null) {
      const issues = this.findNonFiniteValues(record as Record<string, unknown>, '');
      if (issues.length > 0) {
        const diagnostic: UsageDiagnostic = {
          code: 'non_finite_value',
          message: `Non-finite numeric values found: ${issues.join(', ')}`,
          field: issues[0],
        };
        this.diagnostics.push(diagnostic);
        return diagnostic;
      }
    }

    // Check for invalid schema
    const usageResult = UsageIngestionInputSchema.safeParse(record);
    if (!usageResult.success) {
      const diagnostic: UsageDiagnostic = {
        code: 'invalid_schema',
        message: usageResult.error.message,
        field: usageResult.error.issues[0]?.path?.join('.'),
      };
      this.diagnostics.push(diagnostic);
      return diagnostic;
    }

    return null;
  }

  private findNonFiniteValues(obj: Record<string, unknown>, prefix: string): string[] {
    const issues: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'number' && !Number.isFinite(value)) {
        issues.push(path);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        issues.push(...this.findNonFiniteValues(value as Record<string, unknown>, path));
      }
    }
    return issues;
  }

  // ─── Query Interface ────────────────────────────────────────

  /** Get all usage records for this session (non-replay only by default) */
  getBillableRecords(): UsageRecord[] {
    return [...this.usageRecords.values()].filter(r => !r.isReplay);
  }

  /** Get all usage records including replay */
  getAllRecords(): UsageRecord[] {
    return [...this.usageRecords.values()];
  }

  /** Get cost entries (non-replay by default) */
  getBillableCostEntries(): CostEntry[] {
    return [...this.costEntries.values()].filter(e => !e.isReplay);
  }

  /** Get all cost entries */
  getAllCostEntries(): CostEntry[] {
    return [...this.costEntries.values()];
  }

  /** Get latency entries */
  getLatencyEntries(): LatencyEntry[] {
    return [...this.latencyEntries.values()];
  }

  /** Get total cost per currency (billable only) */
  getTotalCostByCurrency(): Map<string, number> {
    return new Map(this.totalCostByCurrency);
  }

  /** Get total billable tokens */
  getTotalBillableTokens(): number {
    return this.totalBillableTokens;
  }

  /** Get total context tokens */
  getTotalContextTokens(): number {
    return this.totalContextTokens;
  }

  /** Get all diagnostics */
  getDiagnostics(): UsageDiagnostic[] {
    return [...this.diagnostics];
  }

  /** Get conversions */
  getConversions(): CurrencyConversion[] {
    return [...this.conversions];
  }

  /** Check if a record already exists (idempotency check) */
  hasRecord(idempotencyKey: string): boolean {
    return this.usageRecords.has(idempotencyKey);
  }

  // ─── Internal Helpers ───────────────────────────────────────

  private emitDiagnostic(diagnostic: Omit<UsageDiagnostic, 'code'> & { code: UsageDiagnostic['code'] }): void {
    this.diagnostics.push(diagnostic as UsageDiagnostic);
  }
}
