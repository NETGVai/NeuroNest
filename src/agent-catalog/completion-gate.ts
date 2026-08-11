/**
 * Completion Gate — Pure Independent Two-Axis Evaluation
 *
 * Recomputes quality and skill invariants from finalized report records.
 * The gate passes if and only if BOTH independent axes pass:
 *
 *   passed = qualityInvariantPassed AND skillInvariantPassed
 *
 * Truth table (strict conjunction):
 *   (true, true)   → pass
 *   (true, false)  → fail
 *   (false, true)  → fail
 *   (false, false) → fail
 *
 * Neither axis compensates for the other:
 * - Extraction_Override affects only structural quality checks; it never
 *   waives the Universal_Per_Agent_Invariant (exact 25/25/25/25=100) or
 *   skills.
 * - Reference_Free_Agent exempts only domain pattern minima; density,
 *   exact scoring, and appropriate skills remain mandatory.
 * - Copied_Boilerplate_Finding is informational only; it does not
 *   independently fail the gate unless a blocking criterion also fails.
 * - Manual_Review_Block is always blocking on the skill axis.
 * - Failure is irreversible: once either axis fails, it cannot recover.
 *
 * Requirements: 1.15, 6.4–6.6, 6.12, 9.9, 9.12–9.16, 10.18, 10.21, 10.22
 */

import type { QualityAxisResult } from './quality-status-collector';
import type {
  QualityValidationReport,
  PerFileQualityResult,
} from './quality-report-builder';
import type {
  PopulationSkillValidationResult,
  SourceSkillResult,
  EffectiveAgentSkillResult,
} from '../agent-skills/population-skill-validator';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Skill axis input — a minimal interface matching the shape produced by
 * `PopulationSkillValidationResult.passed` and related data.
 * Used by the legacy single-call gate overload.
 */
export interface SkillAxisInput {
  readonly passed: boolean;
  readonly blockingPaths: readonly string[];
  readonly blockingAgentIds: readonly string[];
  readonly blockingFindingCodes: readonly string[];
}

/**
 * Blocking finding codes that can appear in the gate decision.
 */
export type BlockingFindingCode =
  // Quality axis
  | 'EMPTY_CATALOG'
  | 'QUALITY_PATH_SET_INEQUALITY'
  | 'PARSE_FAILURE'
  | 'STRUCTURE_REJECTED'
  | 'AUTHENTICITY_FAILURE'
  | 'DIMENSION_SCORE_NOT_25'
  | 'TOTAL_SCORE_NOT_100'
  | 'QUALITY_CRITERION_FAILURE'
  | 'WORKFLOW_COUNTS_BELOW_MINIMA'
  | 'REPORT_NOT_STRUCTURALLY_VALID'
  | 'VALIDATION_SYSTEM_ERROR'
  | 'VALIDATION_TIMEOUT'
  // Skill axis
  | 'SKILL_COVERAGE_INEQUALITY'
  | 'EMPTY_SKILL_BUNDLE'
  | 'MANUAL_REVIEW_BLOCK'
  | 'SKILL_CATALOG_RESOLUTION_FAILURE'
  | 'UNCOVERED_MATERIAL_CAPABILITY'
  | 'EXTRANEOUS_ASSIGNMENT'
  | 'DUPLICATE_SKILL_DEFICIENCY'
  | 'SKILL_PERSISTENCE_FAILURE'
  | 'SKILL_SOURCE_BLOCKED'
  | 'SKILL_EFFECTIVE_BLOCKED';

/**
 * The gate decision — immutable result of evaluating the two-axis conjunction.
 */
export interface GateDecision {
  readonly passed: boolean;
  readonly qualityInvariantPassed: boolean;
  readonly skillInvariantPassed: boolean;
  readonly blockingFindingCodes: readonly string[];
  readonly blockingPaths: readonly string[];
  readonly blockingAgentIds: readonly string[];
}

// ─────────────────────────────────────────────
// Quality Axis — Recompute from Finalized Report
// ─────────────────────────────────────────────

interface QualityAxisEvaluation {
  passed: boolean;
  findingCodes: Set<string>;
  blockingPaths: Set<string>;
}

/**
 * Evaluates the quality invariant independently from finalized report records.
 *
 * Passes ONLY when ALL of the following hold:
 * 1. Non-empty catalog scope (discoveredCount > 0)
 * 2. Complete quality path equality
 * 3. Report is structurally valid
 * 4. Every per-file result: exact 25/25/25/25=100, no blocking findings
 * 5. No blocking catalog findings (timeout, system errors)
 * 6. Workflow counts not below minima
 *
 * Extraction_Override: structural findings become informational but exact
 * 25/25/25/25=100 and skill requirements remain mandatory (Req 1.15).
 *
 * Reference_Free_Agent: exempts only domain pattern minima; density ≥ 0.30,
 * Domain Depth 25, total 100 remain required.
 *
 * Copied_Boilerplate_Finding: informational only.
 */
function evaluateQualityAxisFromReport(
  report: QualityValidationReport,
): QualityAxisEvaluation {
  const findingCodes = new Set<string>();
  const blockingPaths = new Set<string>();
  let passed = true;

  // Check 1: Non-empty catalog (Req 9.12)
  if (report.discoveredCount === 0) {
    passed = false;
    findingCodes.add('EMPTY_CATALOG');
  }

  // Check 2: Quality path equality (Req 6.8, 9.7)
  if (!report.evaluatedPathSet.equal) {
    passed = false;
    findingCodes.add('QUALITY_PATH_SET_INEQUALITY');
  }

  // Check 3: Report structural validity
  if (!report.reportStructurallyValid) {
    passed = false;
    findingCodes.add('REPORT_NOT_STRUCTURALLY_VALID');
  }

  // Check 4: Every per-file result satisfies quality invariants
  for (const result of report.perFileResults) {
    const sourceCodes = evaluatePerFileQuality(result);
    if (sourceCodes.length > 0) {
      passed = false;
      blockingPaths.add(result.sourcePath);
      for (const code of sourceCodes) {
        findingCodes.add(code);
      }
    }
  }

  // Check 5: Catalog-level blocking findings
  for (const finding of report.catalogFindings) {
    if (finding.classification === 'blocking') {
      passed = false;
      if (finding.code === 'EMPTY_CATALOG') {
        findingCodes.add('EMPTY_CATALOG');
      } else if (finding.code === 'VALIDATION_SYSTEM_ERROR') {
        findingCodes.add('VALIDATION_SYSTEM_ERROR');
      } else if (finding.code === 'VALIDATION_TIMEOUT') {
        findingCodes.add('VALIDATION_TIMEOUT');
      } else {
        findingCodes.add('QUALITY_CRITERION_FAILURE');
      }
    }
    // Informational (e.g., COPIED_BOILERPLATE) does not fail
  }

  // Check 6: Workflow counts below minima (Req 9.13, 9.14)
  if (report.workflowCatalog.workflowCountsBelowMinima) {
    passed = false;
    findingCodes.add('WORKFLOW_COUNTS_BELOW_MINIMA');
  }

  return { passed, findingCodes, blockingPaths };
}

/**
 * Evaluates a single per-file quality result for blocking conditions.
 *
 * Extraction_Override (Req 1.15): structural findings become informational
 * when extractionOverrideApplied is true. Exact scores still required.
 *
 * Copied_Boilerplate: informational findings do not independently fail.
 */
function evaluatePerFileQuality(result: PerFileQualityResult): string[] {
  const codes: string[] = [];

  // Parse failure is always blocking (Req 6.9, 9.9)
  if (result.parseStatus === 'failed' || result.parseStatus === 'failed-to-read') {
    codes.push('PARSE_FAILURE');
    return codes;
  }

  // Structure rejection: blocking ONLY when extraction override did NOT apply
  if (
    result.structure !== null &&
    !result.structure.strictValid &&
    !result.extractionOverrideApplied
  ) {
    codes.push('STRUCTURE_REJECTED');
  }

  // Exact score invariant: 25/25/25/25=100 (Req 6.4, 6.5, 6.6)
  // Applies regardless of Extraction_Override or Reference_Free status
  if (result.promptSpecificity !== 25) {
    codes.push('DIMENSION_SCORE_NOT_25');
  }
  if (result.deliverableStructure !== 25) {
    codes.push('DIMENSION_SCORE_NOT_25');
  }
  if (result.workflowCompleteness !== 25) {
    codes.push('DIMENSION_SCORE_NOT_25');
  }
  if (result.domainDepth !== 25) {
    codes.push('DIMENSION_SCORE_NOT_25');
  }
  if (result.total !== 100) {
    codes.push('TOTAL_SCORE_NOT_100');
  }

  // Blocking findings in per-file result
  for (const finding of result.findings) {
    if (finding.classification === 'blocking') {
      if (finding.code === 'VALIDATION_SYSTEM_ERROR') {
        codes.push('VALIDATION_SYSTEM_ERROR');
      } else if (finding.code === 'VALIDATION_TIMEOUT') {
        codes.push('VALIDATION_TIMEOUT');
      } else if (
        finding.code === 'AUTHENTICITY_FAILURE' ||
        finding.scope === 'authenticity'
      ) {
        codes.push('AUTHENTICITY_FAILURE');
      } else {
        codes.push('QUALITY_CRITERION_FAILURE');
      }
    }
  }

  return codes;
}

// ─────────────────────────────────────────────
// Skill Axis — Recompute from Finalized Results
// ─────────────────────────────────────────────

interface SkillAxisEvaluation {
  passed: boolean;
  findingCodes: Set<string>;
  blockingAgentIds: Set<string>;
}

/**
 * Evaluates the skill invariant independently from finalized skill results.
 *
 * Passes ONLY when ALL of the following hold:
 * 1. Skill_Coverage_Path_Equality satisfied (both namespaces)
 * 2. Every source result is not blocked
 * 3. Every effective result: non-empty bundle, bidirectional evidence,
 *    committed persistence, no manual review block
 * 4. All duplicate reconciliation outcomes are 'preserved'
 *
 * Neither Extraction_Override nor Reference_Free_Agent waives any skill check.
 */
function evaluateSkillAxisFromResults(
  skillResult: PopulationSkillValidationResult,
): SkillAxisEvaluation {
  const findingCodes = new Set<string>();
  const blockingAgentIds = new Set<string>();
  let passed = true;

  // Check 1: Skill_Coverage_Path_Equality (Req 10.17)
  if (!skillResult.skillCoverageEquality.equal) {
    passed = false;
    findingCodes.add('SKILL_COVERAGE_INEQUALITY');
  }

  // Check 2: Every source result must not be blocked (Req 10.18)
  for (const source of skillResult.sourceResults) {
    const sourceCodes = evaluateSourceSkillResult(source);
    if (sourceCodes.length > 0) {
      passed = false;
      blockingAgentIds.add(source.agentId);
      for (const code of sourceCodes) {
        findingCodes.add(code);
      }
    }
  }

  // Check 3: Every effective result must pass (Req 10.18)
  for (const effective of skillResult.effectiveResults) {
    const effectiveCodes = evaluateEffectiveSkillResult(effective);
    if (effectiveCodes.length > 0) {
      passed = false;
      blockingAgentIds.add(effective.agentId);
      for (const code of effectiveCodes) {
        findingCodes.add(code);
      }
    }
  }

  // Check 4: All duplicate outcomes must be 'preserved' (Req 10.8, 10.9)
  for (const outcome of skillResult.duplicateSkillOutcomes) {
    if (outcome.classification !== 'preserved') {
      passed = false;
      findingCodes.add('DUPLICATE_SKILL_DEFICIENCY');
      blockingAgentIds.add(outcome.effectiveAgentId);
    }
  }

  return { passed, findingCodes, blockingAgentIds };
}

/**
 * Evaluates a single source skill result for blocking conditions.
 */
function evaluateSourceSkillResult(source: SourceSkillResult): string[] {
  const codes: string[] = [];

  if (source.blocked) {
    codes.push('SKILL_SOURCE_BLOCKED');
  }

  const validation = source.validation;

  if (validation.manualReviewBlock !== null) {
    codes.push('MANUAL_REVIEW_BLOCK');
  }
  if (validation.skillIds.length === 0) {
    codes.push('EMPTY_SKILL_BUNDLE');
  }
  if (validation.uncoveredMaterialCapabilities.length > 0) {
    codes.push('UNCOVERED_MATERIAL_CAPABILITY');
  }
  if (validation.extraneousAssignments.length > 0) {
    codes.push('EXTRANEOUS_ASSIGNMENT');
  }

  for (const detail of validation.catalogResolution) {
    if (
      detail.status !== 'resolved' ||
      detail.enabled !== true ||
      detail.installed !== true
    ) {
      codes.push('SKILL_CATALOG_RESOLUTION_FAILURE');
      break;
    }
  }

  for (const outcome of source.duplicateSkillReconciliation) {
    if (outcome.classification !== 'preserved') {
      codes.push('DUPLICATE_SKILL_DEFICIENCY');
      break;
    }
  }

  return codes;
}

/**
 * Evaluates a single effective agent skill result for blocking conditions.
 * Effective agents own persistence rows and require committed status.
 */
function evaluateEffectiveSkillResult(
  effective: EffectiveAgentSkillResult,
): string[] {
  const codes: string[] = [];

  if (effective.blocked) {
    codes.push('SKILL_EFFECTIVE_BLOCKED');
  }

  const validation = effective.validation;

  if (validation.manualReviewBlock !== null) {
    codes.push('MANUAL_REVIEW_BLOCK');
  }
  if (validation.skillIds.length === 0) {
    codes.push('EMPTY_SKILL_BUNDLE');
  }
  if (validation.uncoveredMaterialCapabilities.length > 0) {
    codes.push('UNCOVERED_MATERIAL_CAPABILITY');
  }
  if (validation.extraneousAssignments.length > 0) {
    codes.push('EXTRANEOUS_ASSIGNMENT');
  }

  for (const detail of validation.catalogResolution) {
    if (
      detail.status !== 'resolved' ||
      detail.enabled !== true ||
      detail.installed !== true
    ) {
      codes.push('SKILL_CATALOG_RESOLUTION_FAILURE');
      break;
    }
  }

  // Persistence must be committed (Req 10.14, 10.15, 10.18)
  if (effective.persistenceStatus.state !== 'committed') {
    codes.push('SKILL_PERSISTENCE_FAILURE');
  }

  for (const outcome of effective.duplicateSkillReconciliation) {
    if (outcome.classification !== 'preserved') {
      codes.push('DUPLICATE_SKILL_DEFICIENCY');
      break;
    }
  }

  return codes;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Evaluates the two-axis completion gate from pre-computed axis results.
 *
 * This overload accepts a pre-computed `QualityAxisResult` (from the
 * quality-status-collector) and a minimal `SkillAxisInput`. It preserves
 * backward compatibility with code that already computes axes separately.
 *
 * The truth table is strict:
 * - qualityInvariantPassed=true AND skillInvariantPassed=true → passed=true
 * - Any other combination → passed=false
 *
 * Requirements 10.21, 10.22
 */
export function evaluateCompletionGate(
  qualityAxis: QualityAxisResult,
  skillAxis: SkillAxisInput,
): GateDecision;

/**
 * Evaluates the two-axis completion gate by recomputing both axes
 * from finalized report records.
 *
 * This overload directly inspects the quality report and skill validation
 * result, enforcing:
 * - Four-case conjunction truth table
 * - Irreversible fail-closed findings
 * - Non-empty catalog
 * - Complete reports/equalities
 * - Exact 25/25/25/25=100
 * - Eligible non-empty bundles
 * - Bidirectional evidence
 * - Duplicate success
 * - Committed persistence
 *
 * Extraction_Override, reference-free exemptions, and copied boilerplate are
 * limited to their specified quality semantics; neither axis compensates for
 * the other.
 *
 * Requirements: 1.15, 6.4–6.6, 6.12, 9.9, 9.12–9.16, 10.18, 10.21, 10.22
 */
export function evaluateCompletionGate(
  qualityReport: QualityValidationReport,
  skillResult: PopulationSkillValidationResult,
): GateDecision;

// Implementation: discriminate between overloads by checking shape
export function evaluateCompletionGate(
  qualityInput: QualityAxisResult | QualityValidationReport,
  skillInput: SkillAxisInput | PopulationSkillValidationResult,
): GateDecision {
  // Discriminate: QualityValidationReport has `schemaVersion` and `perFileResults`
  if (isQualityReport(qualityInput)) {
    return evaluateFromReports(
      qualityInput as QualityValidationReport,
      skillInput as PopulationSkillValidationResult,
    );
  }
  // Legacy overload: pre-computed axis results
  return evaluateFromAxes(
    qualityInput as QualityAxisResult,
    skillInput as SkillAxisInput,
  );
}

/** Type guard: QualityValidationReport has schemaVersion and perFileResults */
function isQualityReport(
  input: QualityAxisResult | QualityValidationReport,
): input is QualityValidationReport {
  return (
    'schemaVersion' in input &&
    'perFileResults' in input &&
    'discoveredCount' in input
  );
}

/**
 * Full report-based evaluation — recomputes both axes from finalized records.
 */
function evaluateFromReports(
  qualityReport: QualityValidationReport,
  skillResult: PopulationSkillValidationResult,
): GateDecision {
  const qualityEval = evaluateQualityAxisFromReport(qualityReport);
  const skillEval = evaluateSkillAxisFromResults(skillResult);

  const passed = qualityEval.passed && skillEval.passed;

  const allCodes = new Set<string>([
    ...qualityEval.findingCodes,
    ...skillEval.findingCodes,
  ]);
  const blockingFindingCodes = [...allCodes].sort();
  const blockingPaths = [...qualityEval.blockingPaths].sort();
  const blockingAgentIds = [...skillEval.blockingAgentIds].sort();

  return Object.freeze({
    passed,
    qualityInvariantPassed: qualityEval.passed,
    skillInvariantPassed: skillEval.passed,
    blockingFindingCodes: Object.freeze(blockingFindingCodes),
    blockingPaths: Object.freeze(blockingPaths),
    blockingAgentIds: Object.freeze(blockingAgentIds),
  });
}

/**
 * Legacy axis-based evaluation — uses pre-computed QualityAxisResult and SkillAxisInput.
 */
function evaluateFromAxes(
  qualityAxis: QualityAxisResult,
  skillAxis: SkillAxisInput,
): GateDecision {
  const qualityInvariantPassed = qualityAxis.passed;
  const skillInvariantPassed = skillAxis.passed;
  const passed = qualityInvariantPassed && skillInvariantPassed;

  const qualityFindingCodes: string[] = qualityAxis.deficiencies.map(d => d.code);
  const skillFindingCodes: string[] = [...skillAxis.blockingFindingCodes];
  const allFindingCodes = [
    ...new Set([...qualityFindingCodes, ...skillFindingCodes]),
  ].sort();

  const allBlockingPaths = [
    ...new Set([...qualityAxis.blockingPaths, ...skillAxis.blockingPaths]),
  ].sort();

  const blockingAgentIds = [...skillAxis.blockingAgentIds].sort();

  return Object.freeze({
    passed,
    qualityInvariantPassed,
    skillInvariantPassed,
    blockingFindingCodes: Object.freeze(allFindingCodes),
    blockingPaths: Object.freeze(allBlockingPaths),
    blockingAgentIds: Object.freeze(blockingAgentIds),
  });
}

/**
 * Evaluates only the quality axis. Returns a gate decision where
 * skillInvariantPassed is false (skills not evaluated) and passed is false.
 */
export function evaluateQualityOnlyGate(
  qualityReport: QualityValidationReport,
): GateDecision {
  const qualityEval = evaluateQualityAxisFromReport(qualityReport);

  return Object.freeze({
    passed: false,
    qualityInvariantPassed: qualityEval.passed,
    skillInvariantPassed: false,
    blockingFindingCodes: Object.freeze([...qualityEval.findingCodes].sort()),
    blockingPaths: Object.freeze([...qualityEval.blockingPaths].sort()),
    blockingAgentIds: Object.freeze([]),
  });
}

/**
 * Evaluates the completion gate for an empty catalog.
 * Always fails with EMPTY_CATALOG. Per Req 9.12: empty catalog fails
 * closed regardless of report structural validity.
 */
export function evaluateEmptyCatalogGate(): GateDecision {
  return Object.freeze({
    passed: false,
    qualityInvariantPassed: false,
    skillInvariantPassed: false,
    blockingFindingCodes: Object.freeze(['EMPTY_CATALOG']),
    blockingPaths: Object.freeze([]),
    blockingAgentIds: Object.freeze([]),
  });
}
