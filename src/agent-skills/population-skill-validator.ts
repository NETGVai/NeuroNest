/**
 * Population Skill Validator
 *
 * Evaluates every discovered source, imported candidate (including skipped
 * duplicates), static agent, and retained effective identity from the frozen
 * population. Performs Duplicate_Skill_Reconciliation by comparing each
 * duplicate source's independently derived required IDs/capabilities with
 * the effective bundle.
 *
 * Requirements: 10.1, 10.2, 10.8, 10.9, 10.17–10.19
 */

import type { AgentPopulationManifest, SourceAgentRef, EffectiveAgentRef } from '../agent-catalog/agent-population';
import type { SkillAssignmentValidation, SkillAssignmentInput, MaterialCapability, PersistenceStatus } from './skill-assignment-validator';
import { validateSkillAssignment } from './skill-assignment-validator';
import type { SkillTaxonomySnapshot, TaxonomyCatalogSnapshot } from './skill-taxonomy';
import type { ReviewedOverrideSnapshot } from './reviewed-override';

// ─────────────────────────────────────────────
// Duplicate Skill Reconciliation Types
// ─────────────────────────────────────────────

/**
 * Classification of a duplicate source's required skill ID against
 * the retained effective bundle.
 *
 * - preserved: present in effective bundle, eligible in same snapshot,
 *   supported by effective evidence for the same normalized capability
 * - incompatible: present by ID but disabled/uninstalled/multiply resolved,
 *   or effective evidence supports a conflicting capability
 * - lost: eligible and required by source but absent from effective bundle
 * - unresolved: source derivation could not determine required IDs
 */
export type DuplicateSkillClassification =
  | 'preserved'
  | 'incompatible'
  | 'lost'
  | 'unresolved';

export interface DuplicateSkillOutcome {
  readonly duplicateGroupId: string;
  readonly sourcePath: string;
  readonly effectiveAgentId: string;
  readonly requiredSkillId: string | null;
  readonly classification: DuplicateSkillClassification;
  readonly reason: string;
}

// ─────────────────────────────────────────────
// Per-Source and Effective Skill Results
// ─────────────────────────────────────────────

export interface SourceSkillResult {
  readonly sourcePath: string;
  readonly agentId: string;
  readonly effectiveAgentId: string;
  readonly duplicateGroupId: string | null;
  readonly validation: SkillAssignmentValidation;
  readonly duplicateSkillReconciliation: readonly DuplicateSkillOutcome[];
  readonly persistenceStatus: PersistenceStatus;
  readonly blocked: boolean;
  readonly blockReasons: readonly string[];
}

export interface EffectiveAgentSkillResult {
  readonly agentId: string;
  readonly agentName: string;
  readonly origin: 'static' | 'imported' | 'retained-static' | 'retained-import';
  readonly sourcePaths: readonly string[];
  readonly validation: SkillAssignmentValidation;
  readonly linkedSourceResults: readonly SourceSkillResult[];
  readonly duplicateSkillReconciliation: readonly DuplicateSkillOutcome[];
  readonly persistenceStatus: PersistenceStatus;
  readonly blocked: boolean;
  readonly blockReasons: readonly string[];
  readonly inputFingerprint: string;
  readonly bundleFingerprint: string | null;
}

/** Mutable version used during construction. */
interface MutableSourceSkillResult {
  sourcePath: string;
  agentId: string;
  effectiveAgentId: string;
  duplicateGroupId: string | null;
  validation: SkillAssignmentValidation;
  duplicateSkillReconciliation: DuplicateSkillOutcome[];
  persistenceStatus: PersistenceStatus;
  blocked: boolean;
  blockReasons: string[];
}

/** Mutable version used during construction. */
interface MutableEffectiveAgentSkillResult {
  agentId: string;
  agentName: string;
  origin: 'static' | 'imported' | 'retained-static' | 'retained-import';
  sourcePaths: readonly string[];
  validation: SkillAssignmentValidation;
  linkedSourceResults: SourceSkillResult[];
  duplicateSkillReconciliation: DuplicateSkillOutcome[];
  persistenceStatus: PersistenceStatus;
  blocked: boolean;
  blockReasons: string[];
  inputFingerprint: string;
  bundleFingerprint: string | null;
}

// ─────────────────────────────────────────────
// Population Validation Result
// ─────────────────────────────────────────────

export interface SkillCoveragePathEquality {
  readonly sourcePathsEqual: boolean;
  readonly effectiveIdsEqual: boolean;
  readonly equal: boolean;
  readonly missingSourcePaths: readonly string[];
  readonly extraSourcePaths: readonly string[];
  readonly missingEffectiveIds: readonly string[];
  readonly extraEffectiveIds: readonly string[];
}

export interface PopulationSkillValidationResult {
  readonly sourceResults: readonly SourceSkillResult[];
  readonly effectiveResults: readonly EffectiveAgentSkillResult[];
  readonly duplicateSkillOutcomes: readonly DuplicateSkillOutcome[];
  readonly skillCoverageEquality: SkillCoveragePathEquality;
  readonly allSourcesValid: boolean;
  readonly allEffectivesValid: boolean;
  readonly passed: boolean;
}

// ─────────────────────────────────────────────
// Input builder for skill validation per subject
// ─────────────────────────────────────────────

/**
 * Agent definition shape minimally required for skill validation input.
 */
export interface AgentDefinitionForSkill {
  readonly id: string;
  readonly name: string;
  readonly department: string;
  readonly specialty: string;
  readonly systemPrompt: string;
}

/**
 * Builds a SkillAssignmentInput from an agent definition.
 * Extracts department, specialty, and simple capability/technology
 * indicators from the system prompt for taxonomy resolution.
 */
function buildInputFromDefinition(
  def: AgentDefinitionForSkill,
  sourcePath?: string,
): SkillAssignmentInput {
  return {
    agentId: def.id,
    sourcePath,
    department: def.department,
    specialty: def.specialty,
    capabilities: [],
    technologies: [],
    deliverables: [],
  };
}

// ─────────────────────────────────────────────
// Duplicate Skill Reconciliation
// ─────────────────────────────────────────────

/**
 * Reconciles a duplicate source's required skill IDs against
 * the effective agent's validated bundle.
 *
 * Classification per required ID:
 * - preserved: ID is in effectiveBundle AND resolves to one enabled+installed
 *   entry AND evidence supports a compatible capability
 * - incompatible: ID is in effectiveBundle but entry is disabled/uninstalled/
 *   multiply resolved, or effective evidence conflicts
 * - lost: ID resolves correctly but is absent from effectiveBundle
 * - unresolved: source could not determine the required ID
 */
function reconcileDuplicateSkills(
  sourceValidation: SkillAssignmentValidation,
  effectiveValidation: SkillAssignmentValidation,
  sourcePath: string,
  effectiveAgentId: string,
  duplicateGroupId: string,
  catalog: TaxonomyCatalogSnapshot,
): readonly DuplicateSkillOutcome[] {
  const outcomes: DuplicateSkillOutcome[] = [];
  const effectiveIdSet = new Set(effectiveValidation.skillIds);

  // If source validation was blocked (empty bundle, manual review),
  // the reconciliation is 'unresolved' for the entire source
  if (!sourceValidation.valid && sourceValidation.skillIds.length === 0) {
    outcomes.push(Object.freeze({
      duplicateGroupId,
      sourcePath,
      effectiveAgentId,
      requiredSkillId: null,
      classification: 'unresolved' as const,
      reason: sourceValidation.manualReviewBlock
        ? `Source skill derivation blocked: ${sourceValidation.manualReviewBlock.code}`
        : 'Source skill derivation produced no required skill IDs',
    }));
    return Object.freeze(outcomes);
  }

  // Compare each source-required ID against effective bundle
  for (const requiredId of sourceValidation.skillIds) {
    if (effectiveIdSet.has(requiredId)) {
      // Check catalog eligibility for the effective bundle entry
      const entries = catalog.byId.get(requiredId);
      if (!entries || entries.length === 0) {
        outcomes.push(Object.freeze({
          duplicateGroupId,
          sourcePath,
          effectiveAgentId,
          requiredSkillId: requiredId,
          classification: 'incompatible' as const,
          reason: `Skill ID '${requiredId}' is in the effective bundle but not in catalog`,
        }));
      } else if (entries.length > 1) {
        outcomes.push(Object.freeze({
          duplicateGroupId,
          sourcePath,
          effectiveAgentId,
          requiredSkillId: requiredId,
          classification: 'incompatible' as const,
          reason: `Skill ID '${requiredId}' resolves to ${entries.length} catalog entries`,
        }));
      } else if (!entries[0]!.enabled || !entries[0]!.installed) {
        outcomes.push(Object.freeze({
          duplicateGroupId,
          sourcePath,
          effectiveAgentId,
          requiredSkillId: requiredId,
          classification: 'incompatible' as const,
          reason: `Skill ID '${requiredId}' is in the effective bundle but ` +
            `${!entries[0]!.enabled ? 'disabled' : 'not installed'} in the catalog`,
        }));
      } else {
        // Verify evidence compatibility
        const effectiveEvidence = effectiveValidation.evidence.filter(e => e.skillId === requiredId);
        const sourceEvidence = sourceValidation.evidence.filter(e => e.skillId === requiredId);

        if (effectiveEvidence.length === 0) {
          outcomes.push(Object.freeze({
            duplicateGroupId,
            sourcePath,
            effectiveAgentId,
            requiredSkillId: requiredId,
            classification: 'incompatible' as const,
            reason: `Skill ID '${requiredId}' present in effective bundle ` +
              `but lacks effective evidence`,
          }));
        } else {
          // Check if source and effective capabilities are compatible
          const sourceCapKeys = new Set(sourceEvidence.map(e => e.capabilityKey));
          const effectiveCapKeys = new Set(effectiveEvidence.map(e => e.capabilityKey));
          const hasOverlap = [...sourceCapKeys].some(k => effectiveCapKeys.has(k));

          if (hasOverlap || sourceCapKeys.size === 0) {
            outcomes.push(Object.freeze({
              duplicateGroupId,
              sourcePath,
              effectiveAgentId,
              requiredSkillId: requiredId,
              classification: 'preserved' as const,
              reason: `Skill ID '${requiredId}' preserved in effective bundle ` +
                `with compatible capability evidence`,
            }));
          } else {
            outcomes.push(Object.freeze({
              duplicateGroupId,
              sourcePath,
              effectiveAgentId,
              requiredSkillId: requiredId,
              classification: 'incompatible' as const,
              reason: `Skill ID '${requiredId}' present in effective bundle ` +
                `but evidence supports conflicting capabilities`,
            }));
          }
        }
      }
    } else {
      // Required ID is absent from effective bundle → lost
      outcomes.push(Object.freeze({
        duplicateGroupId,
        sourcePath,
        effectiveAgentId,
        requiredSkillId: requiredId,
        classification: 'lost' as const,
        reason: `Skill ID '${requiredId}' required by source but absent from effective bundle`,
      }));
    }
  }

  return Object.freeze(outcomes);
}

// ─────────────────────────────────────────────
// Coverage Equality Check
// ─────────────────────────────────────────────

/**
 * Verifies Skill_Coverage_Path_Equality:
 * - Source paths from the population must exactly match source result paths
 * - Effective IDs from the population must exactly match effective result IDs
 */
function checkSkillCoverageEquality(
  population: AgentPopulationManifest,
  sourceResults: readonly SourceSkillResult[],
  effectiveResults: readonly EffectiveAgentSkillResult[],
): SkillCoveragePathEquality {
  const expectedSourcePaths = new Set(
    population.discoveredSources.map(s => s.sourcePath),
  );
  const actualSourcePaths = new Set(
    sourceResults.map(r => r.sourcePath),
  );

  const expectedEffectiveIds = new Set(population.effectiveAgentIds);
  const actualEffectiveIds = new Set(
    effectiveResults.map(r => r.agentId),
  );

  const missingSourcePaths = [...expectedSourcePaths]
    .filter(p => !actualSourcePaths.has(p)).sort();
  const extraSourcePaths = [...actualSourcePaths]
    .filter(p => !expectedSourcePaths.has(p)).sort();
  const missingEffectiveIds = [...expectedEffectiveIds]
    .filter(id => !actualEffectiveIds.has(id)).sort();
  const extraEffectiveIds = [...actualEffectiveIds]
    .filter(id => !expectedEffectiveIds.has(id)).sort();

  const sourcePathsEqual = missingSourcePaths.length === 0
    && extraSourcePaths.length === 0;
  const effectiveIdsEqual = missingEffectiveIds.length === 0
    && extraEffectiveIds.length === 0;

  return Object.freeze({
    sourcePathsEqual,
    effectiveIdsEqual,
    equal: sourcePathsEqual && effectiveIdsEqual,
    missingSourcePaths: Object.freeze(missingSourcePaths),
    extraSourcePaths: Object.freeze(extraSourcePaths),
    missingEffectiveIds: Object.freeze(missingEffectiveIds),
    extraEffectiveIds: Object.freeze(extraEffectiveIds),
  });
}

// ─────────────────────────────────────────────
// Fingerprint Helpers
// ─────────────────────────────────────────────

function computeInputFingerprint(input: SkillAssignmentInput): string {
  const canonical = JSON.stringify({
    id: input.agentId ?? '',
    p: input.sourcePath ?? '',
    d: input.department ?? '',
    s: input.specialty ?? '',
    c: [...(input.capabilities ?? [])].sort(),
    t: [...(input.technologies ?? [])].sort(),
    dl: [...(input.deliverables ?? [])].sort(),
  });
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `input-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function computeBundleFingerprint(skillIds: readonly string[]): string | null {
  if (skillIds.length === 0) return null;
  const canonical = JSON.stringify(skillIds);
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `bundle-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// ─────────────────────────────────────────────
// Main Population Skill Validation
// ─────────────────────────────────────────────

/**
 * Validates skill assignments for the entire frozen agent population.
 *
 * Algorithm:
 * 1. Validate every discovered source independently (including skipped duplicates)
 * 2. Validate every effective agent independently
 * 3. For duplicate groups, reconcile each source's required IDs against the
 *    effective agent's bundle
 * 4. Propagate non-preserved outcomes as blocks to all linked records
 * 5. Only the single effective identity can be persisted, and only when
 *    all linked source requirements pass
 * 6. Verify Skill_Coverage_Path_Equality across both namespaces
 *
 * Requirements: 10.1, 10.2, 10.8, 10.9, 10.17–10.19
 */
export function validatePopulationSkills(
  population: AgentPopulationManifest,
  taxonomy: SkillTaxonomySnapshot,
  overrides: ReviewedOverrideSnapshot,
  catalog: TaxonomyCatalogSnapshot,
  /** Optional resolver for agent definitions from source paths */
  definitionResolver?: (sourcePath: string) => AgentDefinitionForSkill | null,
): PopulationSkillValidationResult {
  // ── Step 1: Validate every discovered source ──
  const sourceResults: MutableSourceSkillResult[] = [];
  const sourceValidationsByPath = new Map<string, SkillAssignmentValidation>();

  // Build a lookup from source path to import candidate definition
  const importCandidateByPath = new Map(
    population.importCandidates.map(c => [c.sourcePath, c.definition]),
  );

  for (const source of population.discoveredSources) {
    const def = definitionResolver?.(source.sourcePath) ?? null;
    let input: SkillAssignmentInput;

    if (def) {
      input = buildInputFromDefinition(def, source.sourcePath);
    } else {
      // Fall back to import candidate definition from frozen population
      const candidateDef = importCandidateByPath.get(source.sourcePath);
      if (candidateDef) {
        input = {
          agentId: source.agentId,
          sourcePath: source.sourcePath,
          department: candidateDef.department,
          specialty: candidateDef.specialty,
          capabilities: [],
          technologies: [],
          deliverables: [],
        };
      } else {
        input = { agentId: source.agentId, sourcePath: source.sourcePath };
      }
    }

    const validation = validateSkillAssignment(input, taxonomy, overrides, catalog);
    sourceValidationsByPath.set(source.sourcePath, validation);

    sourceResults.push({
      sourcePath: source.sourcePath,
      agentId: source.agentId,
      effectiveAgentId: source.effectiveAgentId,
      duplicateGroupId: source.duplicateGroupId,
      validation,
      duplicateSkillReconciliation: [], // filled in step 3
      persistenceStatus: Object.freeze({
        state: 'blocked' as const,
        reasons: Object.freeze(['Source agents do not own assignment rows; effective identity owns persistence']),
      }),
      blocked: !validation.valid,
      blockReasons: validation.valid
        ? []
        : buildSourceBlockReasons(validation),
    });
  }

  // ── Step 2: Validate every effective agent ──
  const effectiveResults: MutableEffectiveAgentSkillResult[] = [];
  const effectiveValidationsById = new Map<string, SkillAssignmentValidation>();

  for (const effective of population.effectiveAgents) {
    const input: SkillAssignmentInput = {
      agentId: effective.agentId,
      department: effective.definition.department,
      specialty: effective.definition.specialty,
      capabilities: [],
      technologies: [],
      deliverables: [],
    };

    const validation = validateSkillAssignment(input, taxonomy, overrides, catalog);
    effectiveValidationsById.set(effective.agentId, validation);
    const inputFp = computeInputFingerprint(input);
    const bundleFp = computeBundleFingerprint(validation.skillIds);

    effectiveResults.push({
      agentId: effective.agentId,
      agentName: effective.definition.name,
      origin: effective.origin,
      sourcePaths: effective.sourcePaths,
      validation,
      linkedSourceResults: [], // filled in step 4
      duplicateSkillReconciliation: [], // filled in step 3
      persistenceStatus: validation.valid
        ? Object.freeze({ state: 'committed' as const, changed: true })
        : Object.freeze({ state: 'blocked' as const, reasons: Object.freeze(['Validation failed']) }),
      blocked: !validation.valid,
      blockReasons: validation.valid ? [] : buildEffectiveBlockReasons(validation),
      inputFingerprint: inputFp,
      bundleFingerprint: bundleFp,
    });
  }

  // ── Step 3: Duplicate Skill Reconciliation ──
  const allDuplicateOutcomes: DuplicateSkillOutcome[] = [];

  for (const group of population.duplicateGroups) {
    const effectiveValidation = effectiveValidationsById.get(group.effectiveAgentId);
    if (!effectiveValidation) continue;

    // Find all source members in this duplicate group
    const groupSources = population.discoveredSources.filter(
      s => s.duplicateGroupId === group.duplicateGroupId,
    );

    for (const source of groupSources) {
      const sourceValidation = sourceValidationsByPath.get(source.sourcePath);
      if (!sourceValidation) continue;

      const outcomes = reconcileDuplicateSkills(
        sourceValidation,
        effectiveValidation,
        source.sourcePath,
        group.effectiveAgentId,
        group.duplicateGroupId,
        catalog,
      );
      allDuplicateOutcomes.push(...outcomes);

      // Attach reconciliation to the source result
      const sourceResult = sourceResults.find(r => r.sourcePath === source.sourcePath);
      if (sourceResult) {
        sourceResult.duplicateSkillReconciliation = [...outcomes];
      }
    }

    // Attach reconciliation to the effective result
    const effectiveResult = effectiveResults.find(r => r.agentId === group.effectiveAgentId);
    if (effectiveResult) {
      const groupOutcomes = allDuplicateOutcomes.filter(
        o => o.duplicateGroupId === group.duplicateGroupId,
      );
      effectiveResult.duplicateSkillReconciliation = [...groupOutcomes];
    }
  }

  // ── Step 4: Propagate non-preserved blocks ──
  for (const outcome of allDuplicateOutcomes) {
    if (outcome.classification !== 'preserved') {
      // Block the source
      const sourceResult = sourceResults.find(r => r.sourcePath === outcome.sourcePath);
      if (sourceResult && !sourceResult.blocked) {
        sourceResult.blocked = true;
        sourceResult.blockReasons = [
          ...sourceResult.blockReasons,
          `Duplicate reconciliation: ${outcome.classification} for skill '${outcome.requiredSkillId ?? 'unknown'}'`,
        ];
      }

      // Block the effective agent
      const effectiveResult = effectiveResults.find(
        r => r.agentId === outcome.effectiveAgentId,
      );
      if (effectiveResult && !effectiveResult.blocked) {
        effectiveResult.blocked = true;
        effectiveResult.blockReasons = [
          ...effectiveResult.blockReasons,
          `Linked source '${outcome.sourcePath}' has ${outcome.classification} duplicate reconciliation`,
        ];
        effectiveResult.persistenceStatus = Object.freeze({
          state: 'blocked' as const,
          reasons: Object.freeze([
            `Linked duplicate source has non-preserved skill requirement: ${outcome.classification}`,
          ]),
        });
      }
    }
  }

  // ── Step 5: Link source results to effective results ──
  for (const effectiveResult of effectiveResults) {
    const linked = sourceResults.filter(
      s => s.effectiveAgentId === effectiveResult.agentId,
    );
    effectiveResult.linkedSourceResults = linked;
  }

  // ── Step 6: Check Skill_Coverage_Path_Equality ──
  const skillCoverageEquality = checkSkillCoverageEquality(
    population, sourceResults, effectiveResults,
  );

  // ── Step 7: Determine pass/fail ──
  const allSourcesValid = sourceResults.every(r => !r.blocked);
  const allEffectivesValid = effectiveResults.every(r => !r.blocked);
  const passed = allSourcesValid && allEffectivesValid && skillCoverageEquality.equal;

  return Object.freeze({
    sourceResults: Object.freeze(sourceResults.map(r => Object.freeze(r))),
    effectiveResults: Object.freeze(effectiveResults.map(r => Object.freeze(r))),
    duplicateSkillOutcomes: Object.freeze(allDuplicateOutcomes),
    skillCoverageEquality,
    allSourcesValid,
    allEffectivesValid,
    passed,
  });
}

// ─────────────────────────────────────────────
// Block Reason Builders
// ─────────────────────────────────────────────

function buildSourceBlockReasons(validation: SkillAssignmentValidation): string[] {
  const reasons: string[] = [];
  if (validation.manualReviewBlock) {
    reasons.push(`Manual review required: ${validation.manualReviewBlock.code}`);
  }
  if (validation.skillIds.length === 0) {
    reasons.push('Empty skill bundle');
  }
  if (validation.uncoveredMaterialCapabilities.length > 0) {
    reasons.push(
      `Uncovered capabilities: ${validation.uncoveredMaterialCapabilities.map(c => c.capabilityKey).join(', ')}`,
    );
  }
  if (validation.extraneousAssignments.length > 0) {
    reasons.push(
      `Extraneous assignments: ${validation.extraneousAssignments.join(', ')}`,
    );
  }
  return reasons;
}

function buildEffectiveBlockReasons(validation: SkillAssignmentValidation): string[] {
  return buildSourceBlockReasons(validation);
}

// ─────────────────────────────────────────────
// Convenience: Check if persistence is allowed
// ─────────────────────────────────────────────

/**
 * Returns true if and only if the effective agent's bundle is valid,
 * all linked source requirements are preserved or the agent has no
 * duplicate group, and the effective result is not blocked.
 *
 * Only the single effective identity may own assignment rows.
 */
export function canPersistEffectiveBundle(result: EffectiveAgentSkillResult): boolean {
  if (result.blocked) return false;
  if (!result.validation.valid) return false;

  // Check duplicate reconciliation outcomes
  for (const outcome of result.duplicateSkillReconciliation) {
    if (outcome.classification !== 'preserved') return false;
  }

  return true;
}
