/**
 * Quality Status Collector — Exhaustive Fail-Closed Quality Axis
 *
 * Records immediate and deferred failures without short-circuiting remaining
 * source evaluation. Once the collector transitions to a failed state, failure
 * is irreversible through finalization.
 *
 * Compares every recorded actual catalog count with applicable minima and
 * includes timeout/system failures, empty-catalog failure, and aggregate
 * discrepancies in the final quality axis decision.
 *
 * Requirements: 1.13–1.16, 2.8, 3.7–3.9, 4.10–4.11, 5.14–5.16, 6.6, 6.9,
 *              6.11, 6.12, 8.4, 8.8, 9.8–9.16
 */

import type {
  AggregateStatusDiscrepancy,
  CatalogQualityFinding,
  CatalogSourceValidation,
  CatalogValidationResult,
  WorkflowCatalogValidation,
} from './catalog-validator';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** A single quality deficiency recorded during collection. */
export interface QualityDeficiency {
  readonly code: string;
  readonly sourcePath: string | null;
  readonly scope:
    | 'parse'
    | 'structure'
    | 'authenticity'
    | 'score'
    | 'dimension'
    | 'catalog-count'
    | 'coverage'
    | 'reporting'
    | 'timeout'
    | 'system'
    | 'empty-catalog'
    | 'aggregate-discrepancy';
  readonly message: string;
  readonly immediate: boolean;
}

/** The overall quality axis result after exhaustive collection and finalization. */
export interface QualityAxisResult {
  /** True only when every source and catalog criterion passes without any deficiency. */
  readonly passed: boolean;
  /** All collected deficiencies in stable order; empty when passed is true. */
  readonly deficiencies: readonly QualityDeficiency[];
  /** Source paths that contributed blocking deficiencies. */
  readonly blockingPaths: readonly string[];
  /** True when the collector entered failure before finalization (irreversible). */
  readonly failedDuringCollection: boolean;
  /** The empty-catalog reason if the catalog had zero agents. */
  readonly emptyCatalog: boolean;
  /** Count of timeout/system errors recorded. */
  readonly systemErrorCount: number;
  /** Count of aggregate status discrepancies recorded. */
  readonly aggregateDiscrepancyCount: number;
}

// ─────────────────────────────────────────────
// Mutable Collector
// ─────────────────────────────────────────────

/**
 * Internal mutable collector that accumulates deficiencies while keeping
 * failure irreversible. Used by `collectQualityStatus` internally.
 */
class QualityStatusCollector {
  private failed = false;
  private readonly deficiencies: QualityDeficiency[] = [];
  private readonly blockingPathSet = new Set<string>();
  private emptyCatalog = false;
  private systemErrorCount = 0;
  private aggregateDiscrepancyCount = 0;

  /**
   * Records a deficiency and marks the collector as failed.
   * Failure is irreversible — once failed, remains failed through finalization.
   */
  recordDeficiency(deficiency: QualityDeficiency): void {
    this.deficiencies.push(deficiency);
    // Failure is irreversible; every deficiency fails the axis
    this.failed = true;
    if (deficiency.sourcePath !== null) {
      this.blockingPathSet.add(deficiency.sourcePath);
    }
    if (deficiency.scope === 'empty-catalog') {
      this.emptyCatalog = true;
    }
    if (deficiency.scope === 'timeout' || deficiency.scope === 'system') {
      this.systemErrorCount++;
    }
    if (deficiency.scope === 'aggregate-discrepancy') {
      this.aggregateDiscrepancyCount++;
    }
  }

  /** True if any deficiency has been recorded. Irreversible. */
  get isFailed(): boolean {
    return this.failed;
  }

  /**
   * Finalize collection and produce the immutable quality axis result.
   * The collector remains failed if it was failed at any point during collection.
   */
  finalize(): QualityAxisResult {
    const blockingPaths = [...this.blockingPathSet].sort();
    const sortedDeficiencies = [...this.deficiencies].sort(
      (a, b) =>
        (a.sourcePath ?? '').localeCompare(b.sourcePath ?? '') ||
        a.scope.localeCompare(b.scope) ||
        a.code.localeCompare(b.code) ||
        a.message.localeCompare(b.message),
    );
    return Object.freeze({
      passed: !this.failed,
      deficiencies: Object.freeze(sortedDeficiencies),
      blockingPaths: Object.freeze(blockingPaths),
      failedDuringCollection: this.failed,
      emptyCatalog: this.emptyCatalog,
      systemErrorCount: this.systemErrorCount,
      aggregateDiscrepancyCount: this.aggregateDiscrepancyCount,
    });
  }
}

// ─────────────────────────────────────────────
// Deficiency factories
// ─────────────────────────────────────────────

function deficiency(
  code: string,
  sourcePath: string | null,
  scope: QualityDeficiency['scope'],
  message: string,
  immediate: boolean,
): QualityDeficiency {
  return Object.freeze({ code, sourcePath, scope, message, immediate });
}

// ─────────────────────────────────────────────
// Source-level deficiency collection
// ─────────────────────────────────────────────

function collectSourceDeficiencies(
  collector: QualityStatusCollector,
  source: CatalogSourceValidation,
): void {
  const { sourcePath } = source;

  // Parse failures (immediate per Req 1.13, 6.9, 9.9)
  if (source.parseStatus === 'failed' || source.parseStatus === 'failed-to-read') {
    collector.recordDeficiency(deficiency(
      'PARSE_FAILURE',
      sourcePath,
      'parse',
      `Parsing failed for ${sourcePath}: status=${source.parseStatus}`,
      true,
    ));
  }

  // Structural rejection without extraction override (immediate per Req 1.14)
  if (!source.structuralAccepted && source.parseStatus !== 'failed' && source.parseStatus !== 'failed-to-read') {
    collector.recordDeficiency(deficiency(
      'STRUCTURE_REJECTED',
      sourcePath,
      'structure',
      `Structural validation failed without extraction override: ${sourcePath}`,
      true,
    ));
  }

  // Authenticity failures (deferred per Req 5.14-5.16)
  if (source.authenticity !== null && !source.authenticity.valid) {
    collector.recordDeficiency(deficiency(
      'AUTHENTICITY_FAILURE',
      sourcePath,
      'authenticity',
      `Authenticity validation failed for ${sourcePath}`,
      false,
    ));
  }

  // Exact dimension score failures (deferred per Req 2.8, 3.7, 4.10, 5.15, 6.6)
  if (!source.exactScoreInvariant.passed) {
    for (const dimensionKey of Object.keys(source.exactScoreInvariant) as (keyof typeof source.exactScoreInvariant)[]) {
      if (dimensionKey === 'passed') continue;
      if (!source.exactScoreInvariant[dimensionKey]) {
        const score = source.scores[dimensionKey as keyof typeof source.scores];
        collector.recordDeficiency(deficiency(
          `DIMENSION_SCORE_NOT_25`,
          sourcePath,
          'dimension',
          `${dimensionKey} must equal 25; found ${String(score)} for ${sourcePath}`,
          false,
        ));
      }
    }
    // Total score invariant
    if (!source.exactScoreInvariant.total) {
      collector.recordDeficiency(deficiency(
        'TOTAL_SCORE_NOT_100',
        sourcePath,
        'score',
        `Total score must equal 100; found ${String(source.scores.total)} for ${sourcePath}`,
        false,
      ));
    }
  }

  // Independent quality criteria failures (deferred per Req 2.8, 3.8, 3.9, 4.11, 5.14)
  for (const dimension of Object.values(source.dimensions)) {
    for (const criterion of dimension.criteria) {
      if (criterion.applicable && !criterion.passed) {
        collector.recordDeficiency(deficiency(
          `QUALITY_CRITERION_${criterion.criterion.replace(/([A-Z])/g, '_$1').toUpperCase()}`,
          sourcePath,
          'score',
          `${criterion.criterion} expected ${String(criterion.expected)} (${criterion.comparison}); actual ${String(criterion.actual)} for ${sourcePath}`,
          false,
        ));
      }
    }
  }

  // Timeout/system errors from findings
  for (const finding of source.findings) {
    if (finding.code === 'VALIDATION_SYSTEM_ERROR' && finding.classification === 'blocking') {
      collector.recordDeficiency(deficiency(
        'VALIDATION_SYSTEM_ERROR',
        sourcePath,
        'system',
        finding.message,
        true,
      ));
    }
    if (finding.code === 'VALIDATION_TIMEOUT' && finding.classification === 'blocking') {
      collector.recordDeficiency(deficiency(
        'VALIDATION_TIMEOUT',
        sourcePath,
        'timeout',
        finding.message,
        true,
      ));
    }
  }

  // Blocking duplicate deficiencies (deferred — duplicates detected after source validation)
  for (const relationship of source.duplicateRelationships) {
    if (relationship.classification === 'blocking') {
      collector.recordDeficiency(deficiency(
        relationship.code,
        sourcePath,
        'coverage',
        `Blocking duplicate relationship: ${relationship.resolutionReason}; related: ${relationship.relatedSourcePath}`,
        false,
      ));
    }
  }
}

// ─────────────────────────────────────────────
// Catalog-level deficiency collection
// ─────────────────────────────────────────────

function collectCatalogCountDeficiencies(
  collector: QualityStatusCollector,
  workflowCatalog: WorkflowCatalogValidation,
): void {
  // Compare every actual catalog count with applicable minima (Req 4.10, 4.11, 9.13, 9.14)
  for (const [, count] of Object.entries(workflowCatalog.counts)) {
    if (!count.passed) {
      collector.recordDeficiency(deficiency(
        `WORKFLOW_CATALOG_COUNT_BELOW_MINIMUM`,
        null,
        'catalog-count',
        `${count.criterion} requires at least ${count.minimum}; found ${count.actual}`,
        false,
      ));
    }
  }
}

function collectEmptyCatalogDeficiency(
  collector: QualityStatusCollector,
  discoveredCount: number,
): void {
  // Req 8.8, 9.11, 9.12: Empty catalog always fails closed
  if (discoveredCount === 0) {
    collector.recordDeficiency(deficiency(
      'EMPTY_CATALOG',
      null,
      'empty-catalog',
      'Complete_Catalog contains zero Agent_Files',
      true,
    ));
  }
}

function collectAggregateDiscrepancies(
  collector: QualityStatusCollector,
  discrepancies: readonly AggregateStatusDiscrepancy[],
): void {
  // Req 6.12, 3.8: aggregate discrepancies where individual passing but
  // aggregate status disagrees
  for (const discrepancy of discrepancies) {
    // Use individual results for the gate (Req 6.12, 3.8).
    // The discrepancy itself is informational BUT if individual results
    // indicate failure, that's captured elsewhere. The discrepancy is only
    // recorded as a quality issue when there's genuine disagreement.
    collector.recordDeficiency(deficiency(
      'AGGREGATE_STATUS_DISCREPANCY',
      discrepancy.sourcePath,
      'aggregate-discrepancy',
      discrepancy.message,
      false,
    ));
  }
}

function collectCatalogFindingDeficiencies(
  collector: QualityStatusCollector,
  catalogFindings: readonly CatalogQualityFinding[],
): void {
  // Catalog-level blocking findings (Req 9.15, 9.16)
  for (const finding of catalogFindings) {
    if (finding.classification === 'blocking') {
      // Already captured via workflow counts; but any other blocking catalog
      // finding should fail closed too
      if (!finding.code.startsWith('WORKFLOW_CATALOG_')) {
        collector.recordDeficiency(deficiency(
          finding.code,
          finding.sourcePath,
          'coverage',
          finding.message,
          false,
        ));
      }
    }
  }
}

function collectPathSetDeficiency(
  collector: QualityStatusCollector,
  discoveredCount: number,
  processedCount: number,
): void {
  // Req 8.4, 6.8: path-set equality check
  if (discoveredCount !== processedCount) {
    collector.recordDeficiency(deficiency(
      'PATH_SET_INEQUALITY',
      null,
      'reporting',
      `Discovered count (${discoveredCount}) does not equal processed count (${processedCount})`,
      false,
    ));
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Exhaustively collects quality status from a completed catalog validation result.
 *
 * The function iterates over every source and every catalog-level check without
 * short-circuiting. Once any deficiency is recorded, the quality axis is failed
 * and remains failed irreversibly through finalization.
 *
 * This implements the "quality axis" of the Completion_Gate from the design:
 * - Non-empty catalog scope
 * - Complete quality path equality
 * - Authenticity
 * - Independent score criteria
 * - Exact 100 for every discovered source
 * - Timeout/system error inclusion
 * - Empty-catalog failure
 * - Aggregate status discrepancy recording
 */
export function collectQualityStatus(result: CatalogValidationResult): QualityAxisResult {
  const collector = new QualityStatusCollector();

  // 1. Check empty catalog FIRST (Req 8.8, 9.11, 9.12)
  //    Even an empty catalog produces a structurally valid report,
  //    but the quality axis always fails.
  collectEmptyCatalogDeficiency(collector, result.discoveredCount);

  // 2. Collect path-set / reporting deficiencies (Req 8.4, 6.8)
  collectPathSetDeficiency(collector, result.discoveredCount, result.processedCount);

  // 3. Iterate EVERY source without short-circuiting (Req 6.9, 6.11, 9.8)
  //    Even after failures, continue evaluating to collect ALL deficiencies.
  for (const source of result.perSource) {
    collectSourceDeficiencies(collector, source);
  }

  // 4. Catalog-level workflow count minima (Req 4.10, 4.11, 9.13, 9.14)
  collectCatalogCountDeficiencies(collector, result.workflowCatalog);

  // 5. Catalog-level blocking findings beyond workflow counts
  collectCatalogFindingDeficiencies(collector, result.catalogFindings);

  // 6. Aggregate status discrepancies (Req 6.12, 3.8)
  //    These are informational in isolation but recorded for completeness.
  //    The gate uses individual results, not aggregate; the discrepancy
  //    is evidence of an internal inconsistency.
  collectAggregateDiscrepancies(collector, result.aggregateStatusDiscrepancies);

  // 7. Finalize: failure is irreversible; all deficiencies collected
  return collector.finalize();
}

/**
 * Collects quality status with additional timeout/system error injection.
 * Used when validation encounters external failures that are not captured
 * in the CatalogValidationResult itself (e.g., timeout during discovery
 * or report construction).
 */
export function collectQualityStatusWithErrors(
  result: CatalogValidationResult,
  externalErrors: readonly { readonly code: string; readonly message: string; readonly scope: 'timeout' | 'system' }[],
): QualityAxisResult {
  const collector = new QualityStatusCollector();

  // External errors first (Req 9.15: system errors fail closed)
  for (const error of externalErrors) {
    collector.recordDeficiency(deficiency(
      error.code,
      null,
      error.scope,
      error.message,
      true,
    ));
  }

  // Then normal collection; collector is already failed if external errors exist
  collectEmptyCatalogDeficiency(collector, result.discoveredCount);
  collectPathSetDeficiency(collector, result.discoveredCount, result.processedCount);

  for (const source of result.perSource) {
    collectSourceDeficiencies(collector, source);
  }

  collectCatalogCountDeficiencies(collector, result.workflowCatalog);
  collectCatalogFindingDeficiencies(collector, result.catalogFindings);
  collectAggregateDiscrepancies(collector, result.aggregateStatusDiscrepancies);

  return collector.finalize();
}

/**
 * Creates a quality axis result for an empty catalog (zero agents discovered).
 * Per Req 8.8, 9.11, 9.12: structurally valid report but always fails the gate.
 */
export function collectEmptyCatalogStatus(): QualityAxisResult {
  const collector = new QualityStatusCollector();
  collector.recordDeficiency(deficiency(
    'EMPTY_CATALOG',
    null,
    'empty-catalog',
    'Complete_Catalog contains zero Agent_Files',
    true,
  ));
  return collector.finalize();
}
