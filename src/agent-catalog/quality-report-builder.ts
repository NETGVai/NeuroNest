/**
 * Quality Report Builder
 *
 * Constructs the canonical quality validation report from a frozen CatalogManifest
 * and per-source validation results. The builder:
 *
 * - Always emits exactly one PerFileResult per manifest source path.
 * - Uses `unavailable` scores after unrecoverable parse/extraction failures.
 * - Computes exact missing/extra/duplicate path deltas independently.
 * - Produces structurally valid zero-count/zero-result reports for empty catalogs.
 * - Derives discoveredCount from the frozen manifest alone.
 * - Canonicalizes all arrays by stable sort and freezes serialized output.
 *
 * Requirements: 6.8, 8.5–8.9, 9.1–9.7, 9.10–9.12
 */

import type { CatalogManifest } from './catalog-discovery';
import type {
  AggregateStatusDiscrepancy,
  AvailableQualityScore,
  CatalogQualityFinding,
  CatalogSourceValidation,
  CatalogValidationResult,
  WorkflowCatalogValidation,
} from './catalog-validator';
import type { CatalogDuplicateRelationship } from './catalog-duplicates';
import type { QualityAnalysis } from './quality-scorer';
import type { StructuralValidation } from './agent-file-parser';

// ─────────────────────────────────────────────
// Report Models
// ─────────────────────────────────────────────

export type ParseStatusReport = 'success' | 'recovered' | 'failed' | 'failed-to-read';

export interface AvailableScoreReport {
  readonly promptSpecificity: AvailableQualityScore;
  readonly deliverableStructure: AvailableQualityScore;
  readonly workflowCompleteness: AvailableQualityScore;
  readonly domainDepth: AvailableQualityScore;
  readonly total: AvailableQualityScore;
}

export interface PerFileQualityResult {
  readonly agentName: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly parseStatus: ParseStatusReport;
  readonly extractionOverrideApplied: boolean;
  readonly promptSpecificity: AvailableQualityScore;
  readonly deliverableStructure: AvailableQualityScore;
  readonly workflowCompleteness: AvailableQualityScore;
  readonly domainDepth: AvailableQualityScore;
  readonly total: AvailableQualityScore;
  readonly scoreEvidence: QualityAnalysis | null;
  readonly structure: StructuralValidation | null;
  readonly duplicates: readonly CatalogDuplicateRelationship[];
  readonly findings: readonly CatalogQualityFinding[];
}

export interface PathSetDelta {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly duplicate: readonly string[];
}

export interface PathSetCheck {
  readonly manifestPaths: readonly string[];
  readonly reportedPaths: readonly string[];
  readonly delta: PathSetDelta;
  readonly equal: boolean;
}

export interface QualityValidationReport {
  readonly schemaVersion: 2;
  readonly catalogRoot: string;
  readonly discoveredCount: number;
  readonly perFileResults: readonly PerFileQualityResult[];
  readonly evaluatedPathSet: PathSetCheck;
  readonly workflowCatalog: WorkflowCatalogValidation;
  readonly aggregateStatusDiscrepancies: readonly AggregateStatusDiscrepancy[];
  readonly catalogFindings: readonly CatalogQualityFinding[];
  readonly reportStructurallyValid: boolean;
}

// ─────────────────────────────────────────────
// Path Set Equality
// ─────────────────────────────────────────────

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

/**
 * Computes path set equality and exact deltas independently from the frozen
 * manifest and the reported source paths. Duplicate detection is performed
 * before set conversion, capturing source paths that appear more than once.
 */
export function computePathSetCheck(
  manifestPaths: readonly string[],
  reportedPaths: readonly string[],
): PathSetCheck {
  // Sort manifest paths canonically for the output
  const sortedManifestPaths = [...manifestPaths].sort(compareText);

  // Detect duplicates in reported paths (paths appearing more than once)
  const reportedCountMap = new Map<string, number>();
  for (const path of reportedPaths) {
    reportedCountMap.set(path, (reportedCountMap.get(path) ?? 0) + 1);
  }
  const duplicatePaths = [...reportedCountMap.entries()]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort(compareText);

  // Sort reported paths canonically
  const sortedReportedPaths = [...reportedPaths].sort(compareText);

  // Compute missing: manifest paths not in reported set
  const reportedSet = new Set(reportedPaths);
  const missing = sortedManifestPaths
    .filter((path) => !reportedSet.has(path))
    .sort(compareText);

  // Compute extra: reported paths not in manifest set
  const manifestSet = new Set(manifestPaths);
  const extra = [...new Set(reportedPaths)]
    .filter((path) => !manifestSet.has(path))
    .sort(compareText);

  const equal = missing.length === 0
    && extra.length === 0
    && duplicatePaths.length === 0;

  return Object.freeze({
    manifestPaths: Object.freeze(sortedManifestPaths),
    reportedPaths: Object.freeze(sortedReportedPaths),
    delta: Object.freeze({
      missing: Object.freeze(missing),
      extra: Object.freeze(extra),
      duplicate: Object.freeze(duplicatePaths),
    }),
    equal,
  });
}

// ─────────────────────────────────────────────
// Per-File Result Construction
// ─────────────────────────────────────────────

const UNAVAILABLE_SCORES: AvailableScoreReport = Object.freeze({
  promptSpecificity: 'unavailable',
  deliverableStructure: 'unavailable',
  workflowCompleteness: 'unavailable',
  domainDepth: 'unavailable',
  total: 'unavailable',
});

function buildPerFileResult(
  sourcePath: string,
  sourceHash: string,
  source: CatalogSourceValidation | null,
): PerFileQualityResult {
  if (!source) {
    // No validation result was produced for this manifest path
    return Object.freeze({
      agentName: deriveAgentName(sourcePath),
      sourcePath,
      sourceHash,
      parseStatus: 'failed-to-read' as ParseStatusReport,
      extractionOverrideApplied: false,
      ...UNAVAILABLE_SCORES,
      scoreEvidence: null,
      structure: null,
      duplicates: Object.freeze([]),
      findings: Object.freeze([
        Object.freeze({
          code: 'MISSING_VALIDATION_RESULT',
          sourcePath,
          scope: 'catalog' as const,
          classification: 'blocking' as const,
          message: `No validation result was produced for manifest path: ${sourcePath}`,
        }),
      ]),
    });
  }

  return Object.freeze({
    agentName: source.agentName,
    sourcePath: source.sourcePath,
    sourceHash,
    parseStatus: normalizeParseStatus(source.parseStatus),
    extractionOverrideApplied: source.extractionOverrideApplied,
    promptSpecificity: source.scores.promptSpecificity,
    deliverableStructure: source.scores.deliverableStructure,
    workflowCompleteness: source.scores.workflowCompleteness,
    domainDepth: source.scores.domainDepth,
    total: source.scores.total,
    scoreEvidence: source.qualityAnalysis,
    structure: source.structural,
    duplicates: Object.freeze([...source.duplicateRelationships].sort(
      (a, b) => compareText(a.sourcePath, b.sourcePath)
        || compareText(a.relatedSourcePath, b.relatedSourcePath)
        || compareText(a.kind, b.kind),
    )),
    findings: Object.freeze([...source.findings].sort(
      (a, b) => compareText(a.sourcePath ?? '', b.sourcePath ?? '')
        || compareText(a.scope, b.scope)
        || compareText(a.code, b.code)
        || compareText(a.message, b.message),
    )),
  });
}

function normalizeParseStatus(status: string): ParseStatusReport {
  switch (status) {
    case 'success': return 'success';
    case 'recovered': return 'recovered';
    case 'failed': return 'failed';
    case 'failed-to-read': return 'failed-to-read';
    default: return 'failed';
  }
}

function deriveAgentName(sourcePath: string): string {
  const fileName = sourcePath.split('/').pop() ?? sourcePath;
  return fileName
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim() || 'Unnamed Agent';
}

// ─────────────────────────────────────────────
// Report Builder
// ─────────────────────────────────────────────

/**
 * Constructs a complete canonical quality validation report from a frozen
 * CatalogManifest and the validation result. Emits exactly one PerFileResult
 * per manifest entry, derives counts from the manifest alone, and computes
 * path equality independently.
 */
export function buildQualityReport(
  manifest: CatalogManifest,
  validationResult: CatalogValidationResult,
): QualityValidationReport {
  // Build index of validation results by source path
  const resultsByPath = new Map<string, CatalogSourceValidation>();
  for (const source of validationResult.perSource) {
    resultsByPath.set(source.sourcePath, source);
  }

  // Emit exactly one PerFileResult per manifest entry (sorted by sourcePath)
  const sortedEntries = [...manifest.entries].sort(
    (a, b) => compareText(a.sourcePath, b.sourcePath),
  );
  const perFileResults = sortedEntries.map((entry) => buildPerFileResult(
    entry.sourcePath,
    entry.sourceHash,
    resultsByPath.get(entry.sourcePath) ?? null,
  ));

  // Derive path set from manifest (truth) and reported paths independently
  const manifestPaths = manifest.entries.map((e) => e.sourcePath);
  const reportedPaths = perFileResults.map((r) => r.sourcePath);
  const evaluatedPathSet = computePathSetCheck(manifestPaths, reportedPaths);

  // Discovered count is derived solely from the frozen manifest
  const discoveredCount = manifest.entries.length;

  // Report structural validity: discovered count equals manifest cardinality,
  // each discovered path appears exactly once, no outside paths
  const reportStructurallyValid = evaluatedPathSet.equal
    && perFileResults.length === discoveredCount;

  // Canonicalize catalog findings
  const catalogFindings = [...validationResult.catalogFindings].sort(
    (a, b) => compareText(a.sourcePath ?? '', b.sourcePath ?? '')
      || compareText(a.scope, b.scope)
      || compareText(a.code, b.code)
      || compareText(a.message, b.message),
  );

  // Canonicalize aggregate status discrepancies
  const aggregateStatusDiscrepancies = [...validationResult.aggregateStatusDiscrepancies].sort(
    (a, b) => compareText(a.sourcePath ?? '', b.sourcePath ?? '')
      || compareText(a.scope, b.scope),
  );

  return Object.freeze({
    schemaVersion: 2 as const,
    catalogRoot: manifest.rootPath,
    discoveredCount,
    perFileResults: Object.freeze(perFileResults),
    evaluatedPathSet,
    workflowCatalog: validationResult.workflowCatalog,
    aggregateStatusDiscrepancies: Object.freeze(aggregateStatusDiscrepancies),
    catalogFindings: Object.freeze(catalogFindings),
    reportStructurallyValid,
  });
}

/**
 * Builds a structurally valid report for an empty catalog. The report has zero
 * discovered count, zero per-file results, and satisfies report structural
 * validity while still representing an EMPTY_CATALOG blocking condition.
 */
export function buildEmptyCatalogReport(catalogRoot: string): QualityValidationReport {
  const emptyPathSet: PathSetCheck = Object.freeze({
    manifestPaths: Object.freeze([]),
    reportedPaths: Object.freeze([]),
    delta: Object.freeze({
      missing: Object.freeze([]),
      extra: Object.freeze([]),
      duplicate: Object.freeze([]),
    }),
    equal: true,
  });

  const emptyWorkflowCatalog: WorkflowCatalogValidation = Object.freeze({
    counts: Object.freeze({
      sequentialProcessMinimum: Object.freeze({
        criterion: 'sequentialProcessMinimum' as const,
        ruleId: 'workflow-completeness.sequential-process',
        actual: 0,
        minimum: 3,
        passed: false,
      }),
      decisionMinimum: Object.freeze({
        criterion: 'decisionMinimum' as const,
        ruleId: 'workflow-completeness.decisions',
        actual: 0,
        minimum: 2,
        passed: false,
      }),
      errorHandlingMinimum: Object.freeze({
        criterion: 'errorHandlingMinimum' as const,
        ruleId: 'workflow-completeness.error-handling',
        actual: 0,
        minimum: 2,
        passed: false,
      }),
      iterationMinimum: Object.freeze({
        criterion: 'iterationMinimum' as const,
        ruleId: 'workflow-completeness.iteration',
        actual: 0,
        minimum: 2,
        passed: false,
      }),
    }),
    workflowCountsBelowMinima: true,
    passed: false,
  });

  return Object.freeze({
    schemaVersion: 2 as const,
    catalogRoot,
    discoveredCount: 0,
    perFileResults: Object.freeze([]),
    evaluatedPathSet: emptyPathSet,
    workflowCatalog: emptyWorkflowCatalog,
    aggregateStatusDiscrepancies: Object.freeze([]),
    catalogFindings: Object.freeze([
      Object.freeze({
        code: 'EMPTY_CATALOG',
        sourcePath: null,
        scope: 'catalog' as const,
        classification: 'blocking' as const,
        message: 'Complete_Catalog contains zero Agent_Files',
      }),
    ]),
    reportStructurallyValid: true,
  });
}

// ─────────────────────────────────────────────
// Canonical JSON Serialization
// ─────────────────────────────────────────────

/**
 * Serializes a quality report to canonical JSON. Arrays are already sorted by
 * the builder; this function produces deterministic output with stable key order.
 */
export function serializeQualityReport(report: QualityValidationReport): string {
  return JSON.stringify(report, canonicalReplacer, 2);
}

/**
 * JSON replacer that ensures deterministic object key ordering and canonical
 * serialization of frozen report structures.
 */
function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  // Sort object keys for canonical output
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return sorted;
}
