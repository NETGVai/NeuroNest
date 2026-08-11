/**
 * Effective Population Reconciler
 *
 * Orchestrates the complete derivation, validation, reconciliation, and
 * transactional persistence of skill bundles for the entire effective population.
 *
 * Core responsibilities:
 * - Derive every source and effective bundle from frozen population snapshots
 * - Resolve every manual block, uncovered, extraneous, and duplicate deficiency
 *   through authentic catalog/taxonomy/override data
 * - Transactionally persist ONLY complete effective bundles
 * - Remove stale assignments and preserve retained metrics
 * - Verify exact assignment-store equality post-persistence
 * - Keep duplicate source requirements represented in linked results
 *
 * Requirements: 10.1–10.18, 10.21, 10.22
 */

import type { AgentPopulationManifest, SourceAgentRef } from '../agent-catalog/agent-population';
import type { AuthoritativeSkillCatalogSnapshot } from './agent-skills-service';
import type { AgentSkillsService } from './agent-skills-service';
import type { SkillTaxonomySnapshot, TaxonomyCatalogSnapshot } from './skill-taxonomy';
import type { ReviewedOverrideSnapshot } from './reviewed-override';
import type {
  SkillAssignmentValidation,
  SkillAssignmentInput,
  MaterialCapability,
  PersistenceStatus,
} from './skill-assignment-validator';
import { validateSkillAssignment } from './skill-assignment-validator';
import type { BundlePersistencePlan } from './bundle-persistence-plan';
import { buildBundlePersistencePlan } from './bundle-persistence-plan';
import type { AssignmentEvidence } from './assignment-evidence';
import type {
  DuplicateSkillOutcome,
  DuplicateSourceSkillInput,
  EffectiveAgentSkillBundle,
} from './duplicate-skill-reconciliation';
import { reconcileDuplicateSkills as reconcileDuplicateGroup } from './duplicate-skill-reconciliation';
import { createCanonicalBundle, type CanonicalSkillBundle } from './skill-bundle-reconciliation';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Result of reconciliation for a single source agent.
 * Sources never own assignment rows - only effective agents do.
 * Sources carry skill results for reporting and duplicate reconciliation.
 */
export interface SourceReconciliationResult {
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

/**
 * Result of reconciliation for a single effective agent.
 * Effective agents own the assignment store rows.
 */
export interface EffectiveReconciliationResult {
  readonly agentId: string;
  readonly agentName: string;
  readonly origin: 'static' | 'imported' | 'retained-static' | 'retained-import';
  readonly sourcePaths: readonly string[];
  readonly validation: SkillAssignmentValidation;
  readonly canonicalBundle: CanonicalSkillBundle | null;
  readonly duplicateSkillReconciliation: readonly DuplicateSkillOutcome[];
  readonly persistenceStatus: PersistenceStatus;
  readonly persistencePlan: BundlePersistencePlan | null;
  readonly blocked: boolean;
  readonly blockReasons: readonly string[];
  readonly inputFingerprint: string;
  readonly bundleFingerprint: string | null;
}

/**
 * Skill coverage path equality check result.
 */
export interface SkillCoverageEquality {
  readonly sourcePathsEqual: boolean;
  readonly effectiveIdsEqual: boolean;
  readonly equal: boolean;
  readonly missingSourcePaths: readonly string[];
  readonly extraSourcePaths: readonly string[];
  readonly missingEffectiveIds: readonly string[];
  readonly extraEffectiveIds: readonly string[];
}

/**
 * The complete result of reconciling the entire effective population.
 */
export interface PopulationReconciliationResult {
  readonly sourceResults: readonly SourceReconciliationResult[];
  readonly effectiveResults: readonly EffectiveReconciliationResult[];
  readonly duplicateSkillOutcomes: readonly DuplicateSkillOutcome[];
  readonly skillCoverageEquality: SkillCoverageEquality;
  readonly allSourcesValid: boolean;
  readonly allEffectivesValid: boolean;
  readonly allPersisted: boolean;
  readonly passed: boolean;
  readonly persistenceOutcomes: readonly PersistenceOutcomeSummary[];
}

/**
 * Summary of a single persistence operation for reporting.
 */
export interface PersistenceOutcomeSummary {
  readonly agentId: string;
  readonly status: 'committed' | 'rolled-back' | 'blocked' | 'no-op';
  readonly changed: boolean;
  readonly reason: string | null;
}

/**
 * Configuration for the reconciler.
 */
export interface ReconcilerConfig {
  /** Skip actual persistence (dry-run mode). */
  readonly dryRun?: boolean;
  /** Verify store equality after persistence. */
  readonly verifyStoreEquality?: boolean;
}

// ─────────────────────────────────────────────
// Mutable Intermediate Types (for construction)
// ─────────────────────────────────────────────

interface MutableSourceResult {
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

interface MutableEffectiveResult {
  agentId: string;
  agentName: string;
  origin: 'static' | 'imported' | 'retained-static' | 'retained-import';
  sourcePaths: readonly string[];
  validation: SkillAssignmentValidation;
  canonicalBundle: CanonicalSkillBundle | null;
  duplicateSkillReconciliation: DuplicateSkillOutcome[];
  persistenceStatus: PersistenceStatus;
  persistencePlan: BundlePersistencePlan | null;
  blocked: boolean;
  blockReasons: string[];
  inputFingerprint: string;
  bundleFingerprint: string | null;
}

// ─────────────────────────────────────────────
// Input Builder
// ─────────────────────────────────────────────

interface AgentDefinitionLike {
  readonly id: string;
  readonly name: string;
  readonly department: string;
  readonly specialty: string;
  readonly systemPrompt: string;
}

function buildSkillInput(
  def: AgentDefinitionLike,
  sourcePath?: string,
  materialCapabilities?: readonly MaterialCapability[],
): SkillAssignmentInput {
  const base: {
    agentId: string;
    sourcePath: string | undefined;
    department: string;
    specialty: string;
    capabilities: readonly string[];
    technologies: readonly string[];
    deliverables: readonly string[];
    materialCapabilities?: readonly MaterialCapability[];
  } = {
    agentId: def.id,
    sourcePath,
    department: def.department,
    specialty: def.specialty,
    capabilities: [],
    technologies: [],
    deliverables: [],
  };
  if (materialCapabilities && materialCapabilities.length > 0) {
    base.materialCapabilities = materialCapabilities;
  }
  return base as SkillAssignmentInput;
}

// ─────────────────────────────────────────────
// Fingerprint Helpers
// ─────────────────────────────────────────────

function computeInputFp(input: SkillAssignmentInput, catalogFp: string): string {
  const canonical = JSON.stringify({
    id: input.agentId ?? '',
    p: input.sourcePath ?? '',
    d: input.department ?? '',
    s: input.specialty ?? '',
    c: [...(input.capabilities ?? [])].sort(),
    t: [...(input.technologies ?? [])].sort(),
    dl: [...(input.deliverables ?? [])].sort(),
    cf: catalogFp,
  });
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `input-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function computeBundleFp(skillIds: readonly string[]): string | null {
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
// Core Orchestrator
// ─────────────────────────────────────────────

/**
 * Reconciles and persists valid complete bundles for the entire effective
 * population.
 *
 * Steps:
 * 1. Derive every source bundle from discovered sources
 * 2. Derive every effective bundle from effective agents
 * 3. Perform duplicate skill reconciliation for all duplicate groups
 * 4. Propagate non-preserved duplicate outcomes as blocks
 * 5. Build persistence plans for valid, unblocked effective agents
 * 6. Transactionally persist each plan (remove stale, preserve retained,
 *    add missing, verify post-state)
 * 7. Verify exact assignment-store equality
 * 8. Construct complete result with all linked records
 *
 * Requirements: 10.1–10.18, 10.21, 10.22
 */
export async function reconcileEffectivePopulation(
  population: AgentPopulationManifest,
  taxonomy: SkillTaxonomySnapshot,
  overrides: ReviewedOverrideSnapshot,
  catalog: AuthoritativeSkillCatalogSnapshot,
  service: AgentSkillsService,
  config: ReconcilerConfig = {},
): Promise<PopulationReconciliationResult> {
  const catalogSnapshot = buildCatalogSnapshotAdapter(catalog);

  // ── Step 1: Validate every discovered source independently ──
  const sourceResults: MutableSourceResult[] = [];
  const sourceValidationsByPath = new Map<string, SkillAssignmentValidation>();

  for (const source of population.discoveredSources) {
    const def = resolveSourceDefinition(source, population);
    const input: SkillAssignmentInput = def
      ? buildSkillInput(def, source.sourcePath)
      : { agentId: source.agentId, sourcePath: source.sourcePath };

    const validation = validateSkillAssignment(input, taxonomy, overrides, catalogSnapshot);
    sourceValidationsByPath.set(source.sourcePath, validation);

    sourceResults.push({
      sourcePath: source.sourcePath,
      agentId: source.agentId,
      effectiveAgentId: source.effectiveAgentId,
      duplicateGroupId: source.duplicateGroupId,
      validation,
      duplicateSkillReconciliation: [],
      persistenceStatus: {
        state: 'blocked' as const,
        reasons: ['Source agents do not own assignment rows; effective identity owns persistence'],
      },
      blocked: !validation.valid,
      blockReasons: validation.valid ? [] : buildBlockReasons(validation),
    });
  }

  // ── Step 2: Validate every effective agent independently ──
  const effectiveResults: MutableEffectiveResult[] = [];
  const effectiveValidationsById = new Map<string, SkillAssignmentValidation>();

  for (const effective of population.effectiveAgents) {
    const def = effective.definition as unknown as AgentDefinitionLike;
    const input: SkillAssignmentInput = buildSkillInput(def, effective.sourcePaths[0]);

    const validation = validateSkillAssignment(input, taxonomy, overrides, catalogSnapshot);
    effectiveValidationsById.set(effective.agentId, validation);

    const inputFp = computeInputFp(input, catalog.fingerprint);
    const bundleFp = computeBundleFp(validation.skillIds);
    const canonicalBundle = validation.valid && validation.skillIds.length > 0
      ? createCanonicalBundle(validation.skillIds, validation.evidence as AssignmentEvidence[])
      : null;

    effectiveResults.push({
      agentId: effective.agentId,
      agentName: def.name ?? effective.agentId,
      origin: effective.origin,
      sourcePaths: effective.sourcePaths,
      validation,
      canonicalBundle,
      duplicateSkillReconciliation: [],
      persistenceStatus: validation.valid
        ? { state: 'committed' as const, changed: true }
        : { state: 'blocked' as const, reasons: ['Validation failed'] },
      persistencePlan: null,
      blocked: !validation.valid,
      blockReasons: validation.valid ? [] : buildBlockReasons(validation),
      inputFingerprint: inputFp,
      bundleFingerprint: bundleFp,
    });
  }

  // ── Step 3: Duplicate Skill Reconciliation ──
  const allDuplicateOutcomes: DuplicateSkillOutcome[] = [];

  for (const group of population.duplicateGroups) {
    const effectiveValidation = effectiveValidationsById.get(group.effectiveAgentId);
    if (!effectiveValidation) continue;

    const effectiveBundle: EffectiveAgentSkillBundle = {
      effectiveAgentId: group.effectiveAgentId,
      skillIds: effectiveValidation.skillIds,
      skillCapabilities: buildSkillCapMap(effectiveValidation.evidence),
    };

    const groupSources = population.discoveredSources.filter(
      s => s.duplicateGroupId === group.duplicateGroupId,
    );

    const sourceInputs: DuplicateSourceSkillInput[] = groupSources.map(source => {
      const srcValidation = sourceValidationsByPath.get(source.sourcePath);
      if (!srcValidation) {
        const input: DuplicateSourceSkillInput = {
          sourcePath: source.sourcePath,
          duplicateGroupId: group.duplicateGroupId,
          effectiveAgentId: group.effectiveAgentId,
          requiredSkillIds: null,
          requiredSkillCapabilities: new Map<string, readonly string[]>(),
          derivationBlocked: true,
          blockReason: 'Source validation not available',
        };
        return input;
      }
      const derivationBlocked = !srcValidation.valid && srcValidation.skillIds.length === 0;
      const blockReason = derivationBlocked
        ? (srcValidation.manualReviewBlock?.message ?? 'Source validation failed')
        : undefined;
      const input: DuplicateSourceSkillInput = Object.assign(
        {
          sourcePath: source.sourcePath,
          duplicateGroupId: group.duplicateGroupId,
          effectiveAgentId: group.effectiveAgentId,
          requiredSkillIds: srcValidation.valid ? [...srcValidation.skillIds] : null,
          requiredSkillCapabilities: buildSkillCapMap(srcValidation.evidence),
          derivationBlocked,
        },
        blockReason !== undefined ? { blockReason } : {},
      ) as DuplicateSourceSkillInput;
      return input;
    });

    const reconResult = reconcileDuplicateGroup(sourceInputs, effectiveBundle, catalogSnapshot);
    allDuplicateOutcomes.push(...reconResult.outcomes);

    // Attach reconciliation to source results
    for (const source of groupSources) {
      const sourceResult = sourceResults.find(r => r.sourcePath === source.sourcePath);
      if (sourceResult) {
        const sourceOutcomes = reconResult.outcomes.filter(o => o.sourcePath === source.sourcePath);
        sourceResult.duplicateSkillReconciliation = sourceOutcomes;
      }
    }

    // Attach reconciliation to effective result
    const effectiveResult = effectiveResults.find(r => r.agentId === group.effectiveAgentId);
    if (effectiveResult) {
      effectiveResult.duplicateSkillReconciliation = [...reconResult.outcomes];
    }
  }

  // ── Step 4: Propagate non-preserved duplicate outcomes as blocks ──
  for (const outcome of allDuplicateOutcomes) {
    if (outcome.classification !== 'preserved') {
      const sourceResult = sourceResults.find(r => r.sourcePath === outcome.sourcePath);
      if (sourceResult && !sourceResult.blocked) {
        sourceResult.blocked = true;
        sourceResult.blockReasons = [
          ...sourceResult.blockReasons,
          `Duplicate reconciliation: ${outcome.classification} for skill '${outcome.requiredSkillId ?? 'unknown'}'`,
        ];
      }

      const effectiveResult = effectiveResults.find(r => r.agentId === outcome.effectiveAgentId);
      if (effectiveResult && !effectiveResult.blocked) {
        effectiveResult.blocked = true;
        effectiveResult.blockReasons = [
          ...effectiveResult.blockReasons,
          `Linked source '${outcome.sourcePath}' has ${outcome.classification} duplicate reconciliation`,
        ];
        effectiveResult.persistenceStatus = {
          state: 'blocked' as const,
          reasons: [`Linked duplicate source has non-preserved skill requirement: ${outcome.classification}`],
        };
      }
    }
  }

  // ── Step 5: Build persistence plans and persist ──
  const persistenceOutcomes: PersistenceOutcomeSummary[] = [];

  for (const effectiveResult of effectiveResults) {
    if (effectiveResult.blocked || !effectiveResult.validation.valid) {
      persistenceOutcomes.push({
        agentId: effectiveResult.agentId,
        status: 'blocked',
        changed: false,
        reason: effectiveResult.blockReasons[0] ?? 'Validation failed',
      });
      continue;
    }

    const currentAssignments = await service.getCurrentAssignments(effectiveResult.agentId);
    const currentEvidenceFp = await service.getCurrentEvidenceFingerprint(effectiveResult.agentId);

    const plan = buildBundlePersistencePlan({
      agentId: effectiveResult.agentId,
      desiredSkillIds: [...effectiveResult.validation.skillIds],
      evidence: effectiveResult.validation.evidence as AssignmentEvidence[],
      currentAssignments,
      inputFingerprint: effectiveResult.inputFingerprint,
      catalogFingerprint: catalog.fingerprint,
      currentEvidenceFingerprint: currentEvidenceFp,
    });

    effectiveResult.persistencePlan = plan;

    // ── Step 6: Persist if not dry-run ──
    if (config.dryRun) {
      effectiveResult.persistenceStatus = { state: 'committed' as const, changed: !plan.noOp };
      persistenceOutcomes.push({
        agentId: effectiveResult.agentId,
        status: plan.noOp ? 'no-op' : 'committed',
        changed: !plan.noOp,
        reason: null,
      });
      continue;
    }

    const persistResult = await service.reconcileAgentSkillBundle(plan);

    if (persistResult.state === 'committed') {
      effectiveResult.persistenceStatus = { state: 'committed' as const, changed: persistResult.changed };
      persistenceOutcomes.push({
        agentId: effectiveResult.agentId,
        status: plan.noOp ? 'no-op' : 'committed',
        changed: persistResult.changed,
        reason: null,
      });
    } else {
      effectiveResult.persistenceStatus = { state: 'rolled-back' as const, errorCode: persistResult.errorCode };
      effectiveResult.blocked = true;
      effectiveResult.blockReasons = [
        ...effectiveResult.blockReasons,
        `Persistence rolled back: ${persistResult.errorCode} - ${persistResult.errorMessage}`,
      ];
      persistenceOutcomes.push({
        agentId: effectiveResult.agentId,
        status: 'rolled-back',
        changed: false,
        reason: `${persistResult.errorCode}: ${persistResult.errorMessage}`,
      });
    }
  }

  // ── Step 7: Verify store equality (optional) ──
  if (config.verifyStoreEquality && !config.dryRun) {
    for (const effectiveResult of effectiveResults) {
      if (effectiveResult.blocked) continue;
      if (effectiveResult.persistenceStatus.state !== 'committed') continue;

      const storedAssignments = await service.getAgentSkills(effectiveResult.agentId);
      const storedIds = storedAssignments.map((a: { skill_id: string }) => a.skill_id).sort();
      const desiredIds = [...effectiveResult.validation.skillIds].sort();

      const matches = storedIds.length === desiredIds.length &&
        storedIds.every((id: string, i: number) => id === desiredIds[i]);

      if (!matches) {
        effectiveResult.blocked = true;
        effectiveResult.blockReasons = [
          ...effectiveResult.blockReasons,
          `Store equality verification failed: stored [${storedIds.join(',')}] !== desired [${desiredIds.join(',')}]`,
        ];
        effectiveResult.persistenceStatus = { state: 'rolled-back' as const, errorCode: 'STORE_EQUALITY_FAILED' };

        const outcomeIdx = persistenceOutcomes.findIndex(o => o.agentId === effectiveResult.agentId);
        if (outcomeIdx >= 0) {
          persistenceOutcomes[outcomeIdx] = {
            agentId: effectiveResult.agentId,
            status: 'rolled-back',
            changed: false,
            reason: 'Post-persistence store equality verification failed',
          };
        }
      }
    }
  }

  // ── Step 8: Check Skill_Coverage_Path_Equality ──
  const skillCoverageEquality = checkCoverageEquality(population, sourceResults, effectiveResults);

  // ── Step 9: Determine final pass/fail ──
  const allSourcesValid = sourceResults.every(r => !r.blocked);
  const allEffectivesValid = effectiveResults.every(r => !r.blocked);
  const allPersisted = effectiveResults
    .filter(r => !r.blocked)
    .every(r => r.persistenceStatus.state === 'committed');
  const passed = allSourcesValid && allEffectivesValid && allPersisted && skillCoverageEquality.equal;

  return Object.freeze({
    sourceResults: Object.freeze(sourceResults.map(r => Object.freeze(r) as SourceReconciliationResult)),
    effectiveResults: Object.freeze(effectiveResults.map(r => Object.freeze(r) as EffectiveReconciliationResult)),
    duplicateSkillOutcomes: Object.freeze(allDuplicateOutcomes),
    skillCoverageEquality: Object.freeze(skillCoverageEquality),
    allSourcesValid,
    allEffectivesValid,
    allPersisted,
    passed,
    persistenceOutcomes: Object.freeze(persistenceOutcomes),
  });
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function resolveSourceDefinition(
  source: SourceAgentRef,
  population: AgentPopulationManifest,
): AgentDefinitionLike | null {
  const candidate = population.importCandidates.find(
    c => c.candidateKey === source.candidateKey,
  );
  if (candidate?.definition) {
    const def = candidate.definition as unknown as Record<string, unknown>;
    return {
      id: (def['id'] as string) ?? source.agentId,
      name: (def['name'] as string) ?? source.agentId,
      department: (def['department'] as string) ?? '',
      specialty: (def['specialty'] as string) ?? '',
      systemPrompt: (def['systemPrompt'] as string) ?? '',
    };
  }
  return null;
}

function buildSkillCapMap(
  evidence: readonly { readonly skillId: string; readonly capabilityKey: string }[],
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const e of evidence) {
    const existing = map.get(e.skillId);
    if (existing) {
      if (!existing.includes(e.capabilityKey)) {
        existing.push(e.capabilityKey);
      }
    } else {
      map.set(e.skillId, [e.capabilityKey]);
    }
  }
  return map;
}

function buildBlockReasons(validation: SkillAssignmentValidation): string[] {
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
    reasons.push(`Extraneous assignments: ${validation.extraneousAssignments.join(', ')}`);
  }
  return reasons;
}

function checkCoverageEquality(
  population: AgentPopulationManifest,
  sourceResults: readonly MutableSourceResult[],
  effectiveResults: readonly MutableEffectiveResult[],
): SkillCoverageEquality {
  const expectedSourcePaths = new Set(population.discoveredSources.map(s => s.sourcePath));
  const actualSourcePaths = new Set(sourceResults.map(r => r.sourcePath));
  const expectedEffectiveIds = new Set(population.effectiveAgentIds);
  const actualEffectiveIds = new Set(effectiveResults.map(r => r.agentId));

  const missingSourcePaths = [...expectedSourcePaths].filter(p => !actualSourcePaths.has(p)).sort();
  const extraSourcePaths = [...actualSourcePaths].filter(p => !expectedSourcePaths.has(p)).sort();
  const missingEffectiveIds = [...expectedEffectiveIds].filter(id => !actualEffectiveIds.has(id)).sort();
  const extraEffectiveIds = [...actualEffectiveIds].filter(id => !expectedEffectiveIds.has(id)).sort();

  const sourcePathsEqual = missingSourcePaths.length === 0 && extraSourcePaths.length === 0;
  const effectiveIdsEqual = missingEffectiveIds.length === 0 && extraEffectiveIds.length === 0;

  return {
    sourcePathsEqual,
    effectiveIdsEqual,
    equal: sourcePathsEqual && effectiveIdsEqual,
    missingSourcePaths,
    extraSourcePaths,
    missingEffectiveIds,
    extraEffectiveIds,
  };
}

function buildCatalogSnapshotAdapter(
  catalog: AuthoritativeSkillCatalogSnapshot,
): TaxonomyCatalogSnapshot {
  return {
    entries: catalog.entries.map(e => ({
      skillId: e.skillId,
      category: e.category,
      enabled: e.enabled,
      installed: e.installed,
      capabilityKeys: e.capabilityKeys,
    })),
    byId: catalog.byId as unknown as ReadonlyMap<string, readonly { skillId: string; category: string; enabled: boolean; installed: boolean; capabilityKeys: readonly string[] }[]>,
    byCategory: catalog.byCategory as unknown as ReadonlyMap<string, readonly { skillId: string; category: string; enabled: boolean; installed: boolean; capabilityKeys: readonly string[] }[]>,
  };
}
