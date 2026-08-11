/**
 * Validation Report Integration — Complete Quality and Skill Report
 *
 * Extends schema-versioned report models with exactly one complete per-file
 * record per discovered path and one effective skill record per effective
 * identity. Combines quality results (from quality-report-builder) with
 * skill results (from population-skill-validator) into a unified report.
 *
 * Always includes:
 * - Assigned skill IDs (bundles)
 * - Assignment reasons and evidence
 * - Catalog resolution details
 * - Material capabilities, uncovered capabilities, extraneous assignments
 * - Manual review blocks
 * - Duplicate skill reconciliation outcomes
 * - Persistence status
 *
 * Computes quality equality and two-namespace skill equality independently
 * with missing/extra/duplicate deltas.
 *
 * Requirements: 9.1–9.16, 10.16–10.19
 */

import type { CatalogManifest } from './catalog-discovery';
import type { AgentPopulationManifest } from './agent-population';
import type {
  CatalogQualityFinding,
  WorkflowCatalogValidation,
  AggregateStatusDiscrepancy,
} from './catalog-validator';
import type { CatalogDuplicateRelationship } from './catalog-duplicates';
import type { QualityAnalysis } from './quality-scorer';
import type { StructuralValidation } from './agent-file-parser';
import type {
  SourceSkillResult,
  EffectiveAgentSkillResult,
  PopulationSkillValidationResult,
} from '../agent-skills/population-skill-validator';
import type {
  AssignmentEvidence,
  CatalogResolutionDetail,
  ManualReviewBlock,
  MaterialCapability,
  PersistenceStatus,
} from '../agent-skills/skill-assignment-validator';
import type { DuplicateSkillOutcome } from '../agent-skills/duplicate-skill-reconciliation';
import type {
  PerFileQualityResult,
  QualityValidationReport,
  PathSetCheck,
} from './quality-report-builder';
import { computePathSetCheck } from './quality-report-builder';

// ─────────────────────────────────────────────
// Integrated Report Models
// ─────────────────────────────────────────────

/**
 * Skill-related fields always present in per-file results.
 * All arrays are always present, including empty arrays when no items apply.
 */
export interface PerFileSkillFields {
  /** Ascending unique skill IDs (empty only when blocked). */
  readonly assignedSkillIds: readonly string[];
  /** Deterministic assignment evidence ordered by skillId/capabilityKey/source. */
  readonly assignmentEvidence: readonly AssignmentEvidence[];
  /** One reason per assigned skill ID. */
  readonly assignmentReasons: readonly { readonly skillId: string; readonly reason: string }[];
  /** One resolution detail per assigned skill ID. */
  readonly catalogResolution: readonly CatalogResolutionDetail[];
  /** Complete material capabilities extracted from the agent. */
  readonly materialCapabilities: readonly MaterialCapability[];
  /** Always-present list; empty when fully covered. */
  readonly uncoveredMaterialCapabilities: readonly MaterialCapability[];
  /** Always-present list; empty when all have evidence. */
  readonly extraneousAssignments: readonly string[];
  /** Manual review block or null when assignment is valid. */
  readonly manualReviewBlock: ManualReviewBlock | null;
  /** Duplicate skill reconciliation outcomes for this source. */
  readonly duplicateSkillReconciliation: readonly DuplicateSkillOutcome[];
  /** Committed, rolled-back, or blocked persistence status. */
  readonly persistenceStatus: PersistenceStatus;
}

/**
 * Complete integrated per-file result with both quality and skill data.
 * Exactly one record per discovered source path.
 */
export interface IntegratedPerFileResult extends PerFileSkillFields {
  // Quality fields (from PerFileQualityResult)
  readonly agentName: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly linkedEffectiveAgentId: string | null;
  readonly parseStatus: string;
  readonly extractionOverrideApplied: boolean;
  readonly promptSpecificity: number | 'unavailable';
  readonly deliverableStructure: number | 'unavailable';
  readonly workflowCompleteness: number | 'unavailable';
  readonly domainDepth: number | 'unavailable';
  readonly total: number | 'unavailable';
  readonly scoreEvidence: QualityAnalysis | null;
  readonly structure: StructuralValidation | null;
  readonly duplicates: readonly CatalogDuplicateRelationship[];
  readonly findings: readonly CatalogQualityFinding[];
}

/**
 * Effective agent skill result with all required fields.
 * Exactly one record per effective registered agent identity.
 */
export interface IntegratedEffectiveAgentSkillResult {
  readonly agentId: string;
  readonly agentName: string;
  readonly origin: 'static' | 'imported' | 'retained-static' | 'retained-import';
  readonly sourcePaths: readonly string[];
  readonly assignedSkillIds: readonly string[];
  readonly assignmentEvidence: readonly AssignmentEvidence[];
  readonly assignmentReasons: readonly { readonly skillId: string; readonly reason: string }[];
  readonly catalogResolution: readonly CatalogResolutionDetail[];
  readonly materialCapabilities: readonly MaterialCapability[];
  readonly uncoveredMaterialCapabilities: readonly MaterialCapability[];
  readonly extraneousAssignments: readonly string[];
  readonly manualReviewBlock: ManualReviewBlock | null;
  readonly duplicateSkillReconciliation: readonly DuplicateSkillOutcome[];
  readonly persistenceStatus: PersistenceStatus;
  readonly inputFingerprint: string;
  readonly bundleFingerprint: string | null;
}

/**
 * Identity set check for effective agent IDs —
 * parallel to PathSetCheck but for agent identities.
 */
export interface IdentitySetCheck {
  readonly expectedIds: readonly string[];
  readonly reportedIds: readonly string[];
  readonly delta: IdentitySetDelta;
  readonly equal: boolean;
}

export interface IdentitySetDelta {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly duplicate: readonly string[];
}

/**
 * Dual-namespace coverage check verifying both source paths
 * and effective agent identities form exact bijections.
 * Computed independently from quality path equality.
 */
export interface DualNamespaceCoverageCheck {
  readonly sourcePaths: PathSetCheck;
  readonly effectiveAgentIds: IdentitySetCheck;
  readonly equal: boolean;
}

/**
 * The complete integrated validation report combining quality and skill data.
 * Schema version 2, with all required fields for both axes.
 */
export interface IntegratedValidationReport {
  readonly schemaVersion: 2;
  readonly catalogRoot: string;
  readonly discoveredCount: number;
  readonly effectiveAgentCount: number;
  readonly taxonomyVersion: number;
  readonly catalogFingerprint: string | null;

  // Quality results and checks
  readonly perFileResults: readonly IntegratedPerFileResult[];
  readonly evaluatedPathSet: PathSetCheck;
  readonly reportedPathSet: PathSetCheck;
  readonly workflowCatalog: WorkflowCatalogValidation;
  readonly aggregateStatusDiscrepancies: readonly AggregateStatusDiscrepancy[];

  // Skill results and checks
  readonly effectiveAgentSkillResults: readonly IntegratedEffectiveAgentSkillResult[];
  readonly skillCoverage: DualNamespaceCoverageCheck;

  // Combined
  readonly catalogFindings: readonly CatalogQualityFinding[];
  readonly reportStructurallyValid: boolean;
}

// ─────────────────────────────────────────────
// Identity Set Equality
// ─────────────────────────────────────────────

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

/**
 * Computes identity set equality and exact deltas independently from
 * the expected effective agent IDs and the reported effective agent IDs.
 * Duplicate detection is performed before set conversion.
 */
export function computeIdentitySetCheck(
  expectedIds: readonly string[],
  reportedIds: readonly string[],
): IdentitySetCheck {
  const sortedExpectedIds = [...expectedIds].sort(compareText);

  // Detect duplicates in reported IDs
  const reportedCountMap = new Map<string, number>();
  for (const id of reportedIds) {
    reportedCountMap.set(id, (reportedCountMap.get(id) ?? 0) + 1);
  }
  const duplicateIds = [...reportedCountMap.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort(compareText);

  const sortedReportedIds = [...reportedIds].sort(compareText);

  // Missing: expected IDs not in reported set
  const reportedSet = new Set(reportedIds);
  const missing = sortedExpectedIds
    .filter((id) => !reportedSet.has(id))
    .sort(compareText);

  // Extra: reported IDs not in expected set
  const expectedSet = new Set(expectedIds);
  const extra = [...new Set(reportedIds)]
    .filter((id) => !expectedSet.has(id))
    .sort(compareText);

  const equal = missing.length === 0
    && extra.length === 0
    && duplicateIds.length === 0;

  return Object.freeze({
    expectedIds: Object.freeze(sortedExpectedIds),
    reportedIds: Object.freeze(sortedReportedIds),
    delta: Object.freeze({
      missing: Object.freeze(missing),
      extra: Object.freeze(extra),
      duplicate: Object.freeze(duplicateIds),
    }),
    equal,
  });
}

// ─────────────────────────────────────────────
// Assignment Reasons
// ─────────────────────────────────────────────

/**
 * Derives canonical assignment reasons from evidence, one per assigned skill ID.
 * Each reason summarizes why the skill was assigned.
 */
function buildAssignmentReasons(
  skillIds: readonly string[],
  evidence: readonly AssignmentEvidence[],
): readonly { readonly skillId: string; readonly reason: string }[] {
  return skillIds.map((skillId) => {
    const evidenceForSkill = evidence.filter((e) => e.skillId === skillId);
    if (evidenceForSkill.length === 0) {
      return Object.freeze({ skillId, reason: 'No evidence (extraneous)' });
    }
    // Use the first evidence reason as the canonical reason
    return Object.freeze({ skillId, reason: evidenceForSkill[0]!.reason });
  });
}

// ─────────────────────────────────────────────
// Per-File Skill Fields Construction
// ─────────────────────────────────────────────

/**
 * Default blocked skill fields when no skill result is available for a source.
 */
function blockedSkillFields(): PerFileSkillFields {
  return Object.freeze({
    assignedSkillIds: Object.freeze([]),
    assignmentEvidence: Object.freeze([]),
    assignmentReasons: Object.freeze([]),
    catalogResolution: Object.freeze([]),
    materialCapabilities: Object.freeze([]),
    uncoveredMaterialCapabilities: Object.freeze([]),
    extraneousAssignments: Object.freeze([]),
    manualReviewBlock: null,
    duplicateSkillReconciliation: Object.freeze([]),
    persistenceStatus: Object.freeze({
      state: 'blocked' as const,
      reasons: Object.freeze(['No skill validation result available for this source']),
    }),
  });
}

/**
 * Constructs skill fields from a source skill result.
 */
function buildPerFileSkillFields(sourceResult: SourceSkillResult): PerFileSkillFields {
  const validation = sourceResult.validation;
  const reasons = buildAssignmentReasons(validation.skillIds, validation.evidence);

  return Object.freeze({
    assignedSkillIds: Object.freeze([...validation.skillIds]),
    assignmentEvidence: Object.freeze([...validation.evidence]),
    assignmentReasons: Object.freeze(reasons),
    catalogResolution: Object.freeze([...validation.catalogResolution]),
    materialCapabilities: Object.freeze([...validation.materialCapabilities]),
    uncoveredMaterialCapabilities: Object.freeze([...validation.uncoveredMaterialCapabilities]),
    extraneousAssignments: Object.freeze([...validation.extraneousAssignments]),
    manualReviewBlock: validation.manualReviewBlock,
    duplicateSkillReconciliation: Object.freeze([...sourceResult.duplicateSkillReconciliation]),
    persistenceStatus: sourceResult.persistenceStatus,
  });
}

// ─────────────────────────────────────────────
// Effective Result Construction
// ─────────────────────────────────────────────

function buildIntegratedEffectiveResult(
  effective: EffectiveAgentSkillResult,
): IntegratedEffectiveAgentSkillResult {
  const validation = effective.validation;
  const reasons = buildAssignmentReasons(validation.skillIds, validation.evidence);

  return Object.freeze({
    agentId: effective.agentId,
    agentName: effective.agentName,
    origin: effective.origin,
    sourcePaths: Object.freeze([...effective.sourcePaths]),
    assignedSkillIds: Object.freeze([...validation.skillIds]),
    assignmentEvidence: Object.freeze([...validation.evidence]),
    assignmentReasons: Object.freeze(reasons),
    catalogResolution: Object.freeze([...validation.catalogResolution]),
    materialCapabilities: Object.freeze([...validation.materialCapabilities]),
    uncoveredMaterialCapabilities: Object.freeze([...validation.uncoveredMaterialCapabilities]),
    extraneousAssignments: Object.freeze([...validation.extraneousAssignments]),
    manualReviewBlock: validation.manualReviewBlock,
    duplicateSkillReconciliation: Object.freeze([...effective.duplicateSkillReconciliation]),
    persistenceStatus: effective.persistenceStatus,
    inputFingerprint: effective.inputFingerprint,
    bundleFingerprint: effective.bundleFingerprint,
  });
}

// ─────────────────────────────────────────────
// Integrated Per-File Result Construction
// ─────────────────────────────────────────────

/**
 * Merges quality per-file results with skill per-file results into
 * an integrated record. Each record always has all skill fields present.
 */
function buildIntegratedPerFileResult(
  qualityResult: PerFileQualityResult,
  sourceResult: SourceSkillResult | undefined,
  linkedEffectiveAgentId: string | null,
): IntegratedPerFileResult {
  const skillFields = sourceResult
    ? buildPerFileSkillFields(sourceResult)
    : blockedSkillFields();

  return Object.freeze({
    // Quality fields
    agentName: qualityResult.agentName,
    sourcePath: qualityResult.sourcePath,
    sourceHash: qualityResult.sourceHash,
    linkedEffectiveAgentId,
    parseStatus: qualityResult.parseStatus,
    extractionOverrideApplied: qualityResult.extractionOverrideApplied,
    promptSpecificity: qualityResult.promptSpecificity,
    deliverableStructure: qualityResult.deliverableStructure,
    workflowCompleteness: qualityResult.workflowCompleteness,
    domainDepth: qualityResult.domainDepth,
    total: qualityResult.total,
    scoreEvidence: qualityResult.scoreEvidence,
    structure: qualityResult.structure,
    duplicates: qualityResult.duplicates,
    findings: qualityResult.findings,
    // Skill fields (always present)
    ...skillFields,
  });
}

// ─────────────────────────────────────────────
// Dual-Namespace Skill Coverage Equality
// ─────────────────────────────────────────────

/**
 * Computes the dual-namespace skill coverage check independently.
 *
 * Verifies:
 * 1. Source paths from the population exactly match per-file skill result paths
 * 2. Effective agent IDs from the population exactly match effective result IDs
 *
 * Both checks are independent of quality path equality.
 * Missing, extra, and duplicate deltas are computed for both namespaces.
 *
 * Requirements: 10.17
 */
export function computeDualNamespaceCoverage(
  population: AgentPopulationManifest,
  perFileResults: readonly IntegratedPerFileResult[],
  effectiveResults: readonly IntegratedEffectiveAgentSkillResult[],
): DualNamespaceCoverageCheck {
  // Source path equality: expected from population vs reported from per-file results
  const expectedSourcePaths = population.discoveredSources.map((s) => s.sourcePath);
  const reportedSourcePaths = perFileResults.map((r) => r.sourcePath);
  const sourcePaths = computePathSetCheck(expectedSourcePaths, reportedSourcePaths);

  // Effective identity equality: expected from population vs reported from effective results
  const expectedEffectiveIds = [...population.effectiveAgentIds];
  const reportedEffectiveIds = effectiveResults.map((r) => r.agentId);
  const effectiveAgentIds = computeIdentitySetCheck(expectedEffectiveIds, reportedEffectiveIds);

  const equal = sourcePaths.equal && effectiveAgentIds.equal;

  return Object.freeze({
    sourcePaths,
    effectiveAgentIds,
    equal,
  });
}

// ─────────────────────────────────────────────
// Report Builder
// ─────────────────────────────────────────────

/**
 * Input for building the integrated validation report.
 */
export interface IntegratedReportInput {
  readonly manifest: CatalogManifest;
  readonly population: AgentPopulationManifest;
  readonly qualityReport: QualityValidationReport;
  readonly skillValidation: PopulationSkillValidationResult;
  readonly taxonomyVersion: number;
  readonly catalogFingerprint: string | null;
}

/**
 * Builds the complete integrated validation report combining quality and skill results.
 *
 * Algorithm:
 * 1. Start from the quality report per-file results (one per manifest path).
 * 2. For each per-file result, find the matching source skill result and
 *    merge skill fields into the integrated record.
 * 3. Build effective agent skill results from population validation.
 * 4. Compute quality path equality (from quality report).
 * 5. Compute dual-namespace skill coverage equality independently.
 * 6. All arrays are canonically sorted and frozen.
 *
 * Requirements: 9.1–9.16, 10.16–10.19
 */
export function buildIntegratedValidationReport(
  input: IntegratedReportInput,
): IntegratedValidationReport {
  const {
    manifest,
    population,
    qualityReport,
    skillValidation,
    taxonomyVersion,
    catalogFingerprint,
  } = input;

  // Build index of source skill results by source path
  const sourceSkillByPath = new Map<string, SourceSkillResult>();
  for (const sr of skillValidation.sourceResults) {
    sourceSkillByPath.set(sr.sourcePath, sr);
  }

  // Build index of source-to-effective links from population
  const sourceEffectiveMap = new Map<string, string>();
  for (const source of population.discoveredSources) {
    sourceEffectiveMap.set(source.sourcePath, source.effectiveAgentId);
  }

  // Build integrated per-file results (one per quality result, which is one per manifest path)
  const integratedPerFileResults = qualityReport.perFileResults.map((qr) => {
    const sourceResult = sourceSkillByPath.get(qr.sourcePath);
    const linkedEffectiveId = sourceEffectiveMap.get(qr.sourcePath) ?? null;
    return buildIntegratedPerFileResult(qr, sourceResult, linkedEffectiveId);
  });

  // Sort per-file results canonically by sourcePath
  const sortedPerFileResults = [...integratedPerFileResults].sort(
    (a, b) => compareText(a.sourcePath, b.sourcePath),
  );

  // Build integrated effective agent results
  const integratedEffectiveResults = skillValidation.effectiveResults.map(
    buildIntegratedEffectiveResult,
  );

  // Sort effective results by agentId
  const sortedEffectiveResults = [...integratedEffectiveResults].sort(
    (a, b) => compareText(a.agentId, b.agentId),
  );

  // Quality path equality (from quality report, already computed)
  const evaluatedPathSet = qualityReport.evaluatedPathSet;

  // Reported path set: independently verify the integrated per-file results
  const manifestPaths = manifest.entries.map((e) => e.sourcePath);
  const reportedPaths = sortedPerFileResults.map((r) => r.sourcePath);
  const reportedPathSet = computePathSetCheck(manifestPaths, reportedPaths);

  // Dual-namespace skill coverage equality (independent of quality path equality)
  const skillCoverage = computeDualNamespaceCoverage(
    population,
    sortedPerFileResults,
    sortedEffectiveResults,
  );

  // Counts from frozen inputs
  const discoveredCount = manifest.entries.length;
  const effectiveAgentCount = population.effectiveAgents.length;

  // Report structural validity: both quality path equality and
  // result counts match the frozen inputs
  const reportStructurallyValid = evaluatedPathSet.equal
    && reportedPathSet.equal
    && sortedPerFileResults.length === discoveredCount
    && sortedEffectiveResults.length === effectiveAgentCount;

  // Canonicalize catalog findings
  const catalogFindings = [...qualityReport.catalogFindings].sort(
    (a, b) => compareText(a.sourcePath ?? '', b.sourcePath ?? '')
      || compareText(a.scope, b.scope)
      || compareText(a.code, b.code)
      || compareText(a.message, b.message),
  );

  // Canonicalize aggregate status discrepancies
  const aggregateStatusDiscrepancies = [...qualityReport.aggregateStatusDiscrepancies].sort(
    (a, b) => compareText(a.sourcePath ?? '', b.sourcePath ?? '')
      || compareText(a.scope, b.scope),
  );

  return Object.freeze({
    schemaVersion: 2 as const,
    catalogRoot: manifest.rootPath,
    discoveredCount,
    effectiveAgentCount,
    taxonomyVersion,
    catalogFingerprint,
    perFileResults: Object.freeze(sortedPerFileResults),
    evaluatedPathSet,
    reportedPathSet,
    workflowCatalog: qualityReport.workflowCatalog,
    aggregateStatusDiscrepancies: Object.freeze(aggregateStatusDiscrepancies),
    effectiveAgentSkillResults: Object.freeze(sortedEffectiveResults),
    skillCoverage,
    catalogFindings: Object.freeze(catalogFindings),
    reportStructurallyValid,
  });
}

/**
 * Builds an integrated report for an empty catalog.
 * Structurally valid zero-count report with EMPTY_CATALOG finding.
 */
export function buildEmptyIntegratedReport(
  catalogRoot: string,
  taxonomyVersion: number,
  catalogFingerprint: string | null,
): IntegratedValidationReport {
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

  const emptyIdentitySet: IdentitySetCheck = Object.freeze({
    expectedIds: Object.freeze([]),
    reportedIds: Object.freeze([]),
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
    effectiveAgentCount: 0,
    taxonomyVersion,
    catalogFingerprint,
    perFileResults: Object.freeze([]),
    evaluatedPathSet: emptyPathSet,
    reportedPathSet: emptyPathSet,
    workflowCatalog: emptyWorkflowCatalog,
    aggregateStatusDiscrepancies: Object.freeze([]),
    effectiveAgentSkillResults: Object.freeze([]),
    skillCoverage: Object.freeze({
      sourcePaths: emptyPathSet,
      effectiveAgentIds: emptyIdentitySet,
      equal: true,
    }),
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
 * Serializes the integrated report to canonical JSON with sorted keys.
 */
export function serializeIntegratedReport(report: IntegratedValidationReport): string {
  return JSON.stringify(report, canonicalReplacer, 2);
}

function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return sorted;
}
