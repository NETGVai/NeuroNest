/**
 * Duplicate Skill Reconciliation
 *
 * Compares each duplicate source Agent_File's required Skill_ID values to
 * the Skill_Bundle of the Effective_Registered_Agent and identifies preserved,
 * incompatible, or lost required skills.
 *
 * If source derivation cannot determine required IDs (because parsing, taxonomy,
 * override, or catalog resolution is blocked), reconciliation is 'unresolved'.
 *
 * Any incompatible, lost, or unresolved outcome blocks every linked source
 * and the effective agent.
 *
 * Requirements: 10.8, 10.9
 */

import type { TaxonomyCatalogSnapshot } from './skill-taxonomy';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Classification of a single source-required skill ID relative to
 * the effective registered agent's bundle.
 *
 * - preserved: present in the effective bundle, eligible (enabled+installed),
 *   and supported by effective evidence for the same normalized capability.
 * - incompatible: present by ID but disabled/uninstalled/multiply-resolved,
 *   or its effective evidence supports a conflicting capability.
 * - lost: eligible and required by the source but absent from the effective bundle.
 * - unresolved: source derivation cannot determine required IDs because
 *   parsing, taxonomy, override, or catalog resolution is blocked.
 */
export type DuplicateSkillClassification =
  | 'preserved'
  | 'incompatible'
  | 'lost'
  | 'unresolved';

/**
 * A single reconciliation outcome for one source-required skill ID.
 */
export interface DuplicateSkillOutcome {
  readonly duplicateGroupId: string;
  readonly sourcePath: string;
  readonly effectiveAgentId: string;
  readonly requiredSkillId: string | null;
  readonly classification: DuplicateSkillClassification;
  readonly reason: string;
}

/**
 * Represents a source agent in a duplicate group with its independently
 * derived required skill IDs and capability evidence.
 */
export interface DuplicateSourceSkillInput {
  readonly sourcePath: string;
  readonly duplicateGroupId: string;
  readonly effectiveAgentId: string;
  /**
   * The independently derived required skill IDs for this source.
   * null means derivation is blocked (parse/taxonomy/override/catalog failure).
   */
  readonly requiredSkillIds: readonly string[] | null;
  /**
   * Capability keys each required skill was derived from.
   * Maps skillId → capability keys it supports.
   */
  readonly requiredSkillCapabilities: ReadonlyMap<string, readonly string[]>;
  /**
   * Whether the source skill derivation was blocked.
   * When true, all outcomes are 'unresolved'.
   */
  readonly derivationBlocked: boolean;
  /** Reason for block, if applicable */
  readonly blockReason?: string;
}

/**
 * Represents the effective registered agent's validated skill bundle.
 */
export interface EffectiveAgentSkillBundle {
  readonly effectiveAgentId: string;
  readonly skillIds: readonly string[];
  /**
   * Capability keys each effective skill supports (from evidence).
   * Maps skillId → capability keys.
   */
  readonly skillCapabilities: ReadonlyMap<string, readonly string[]>;
}

/**
 * Complete reconciliation result for one duplicate group.
 */
export interface DuplicateSkillReconciliationResult {
  readonly duplicateGroupId: string;
  readonly effectiveAgentId: string;
  readonly outcomes: readonly DuplicateSkillOutcome[];
  readonly blocked: boolean;
  readonly blockingSourcePaths: readonly string[];
  readonly blockingEffective: boolean;
}

// ─────────────────────────────────────────────
// Core Reconciliation Logic
// ─────────────────────────────────────────────

/**
 * Performs Duplicate_Skill_Reconciliation for a single duplicate group.
 *
 * For each source in the group, compares its independently derived required
 * skill IDs against the effective agent's bundle. Each required ID is classified:
 *
 * - preserved: the ID is in the effective bundle AND eligible in the catalog
 *   AND the effective evidence supports the same normalized capability.
 * - incompatible: the ID is present in the effective bundle by string match
 *   BUT is disabled/uninstalled/multiply-resolved in the catalog snapshot,
 *   OR the effective evidence supports a conflicting (different) capability.
 * - lost: the ID is NOT in the effective bundle but IS eligible in the catalog.
 * - unresolved: derivation for this source is blocked.
 *
 * Any non-preserved outcome blocks every linked source and the effective agent.
 *
 * Requirements: 10.8, 10.9
 */
export function reconcileDuplicateSkills(
  sources: readonly DuplicateSourceSkillInput[],
  effectiveBundle: EffectiveAgentSkillBundle,
  catalog: TaxonomyCatalogSnapshot,
): DuplicateSkillReconciliationResult {
  if (sources.length === 0) {
    return {
      duplicateGroupId: '',
      effectiveAgentId: effectiveBundle.effectiveAgentId,
      outcomes: [],
      blocked: false,
      blockingSourcePaths: [],
      blockingEffective: false,
    };
  }

  const duplicateGroupId = sources[0]!.duplicateGroupId;
  const outcomes: DuplicateSkillOutcome[] = [];
  const blockingSourcePaths = new Set<string>();
  let blockingEffective = false;

  const effectiveSkillSet = new Set(effectiveBundle.skillIds);

  for (const source of sources) {
    // If derivation is blocked, all outcomes are unresolved
    if (source.derivationBlocked || source.requiredSkillIds === null) {
      outcomes.push({
        duplicateGroupId: source.duplicateGroupId,
        sourcePath: source.sourcePath,
        effectiveAgentId: source.effectiveAgentId,
        requiredSkillId: null,
        classification: 'unresolved',
        reason: source.blockReason ??
          'Source skill derivation is blocked (parse, taxonomy, override, or catalog failure)',
      });
      blockingSourcePaths.add(source.sourcePath);
      blockingEffective = true;
      continue;
    }

    // If source has no required skills (empty derivation), it's trivially satisfied
    if (source.requiredSkillIds.length === 0) {
      continue;
    }

    for (const requiredId of source.requiredSkillIds) {
      const classification = classifyRequiredSkill(
        requiredId,
        source,
        effectiveBundle,
        effectiveSkillSet,
        catalog,
      );

      outcomes.push({
        duplicateGroupId: source.duplicateGroupId,
        sourcePath: source.sourcePath,
        effectiveAgentId: source.effectiveAgentId,
        requiredSkillId: requiredId,
        classification: classification.classification,
        reason: classification.reason,
      });

      if (classification.classification !== 'preserved') {
        blockingSourcePaths.add(source.sourcePath);
        blockingEffective = true;
      }
    }
  }

  // Sort outcomes deterministically
  const sortedOutcomes = [...outcomes].sort(compareOutcomes);

  return {
    duplicateGroupId,
    effectiveAgentId: effectiveBundle.effectiveAgentId,
    outcomes: Object.freeze(sortedOutcomes),
    blocked: blockingSourcePaths.size > 0 || blockingEffective,
    blockingSourcePaths: Object.freeze([...blockingSourcePaths].sort()),
    blockingEffective,
  };
}

// ─────────────────────────────────────────────
// Internal Classification
// ─────────────────────────────────────────────

interface ClassificationResult {
  readonly classification: DuplicateSkillClassification;
  readonly reason: string;
}

/**
 * Classifies a single required skill ID from a source against the effective bundle.
 */
function classifyRequiredSkill(
  requiredId: string,
  source: DuplicateSourceSkillInput,
  effectiveBundle: EffectiveAgentSkillBundle,
  effectiveSkillSet: Set<string>,
  catalog: TaxonomyCatalogSnapshot,
): ClassificationResult {
  // Check if the ID is in the effective bundle
  const inEffective = effectiveSkillSet.has(requiredId);

  if (!inEffective) {
    // ID not in effective bundle — check if it's eligible in catalog
    const catalogEntries = catalog.byId.get(requiredId);
    if (!catalogEntries || catalogEntries.length === 0) {
      // Not in catalog at all — incompatible (cannot be resolved)
      return {
        classification: 'incompatible',
        reason: `Skill ID "${requiredId}" is not present in the effective bundle ` +
          `and is not found in the authoritative catalog`,
      };
    }
    if (catalogEntries.length > 1) {
      return {
        classification: 'incompatible',
        reason: `Skill ID "${requiredId}" is absent from the effective bundle ` +
          `and is multiply-resolved in the catalog (${catalogEntries.length} entries)`,
      };
    }
    const entry = catalogEntries[0]!;
    if (!entry.enabled || !entry.installed) {
      return {
        classification: 'incompatible',
        reason: `Skill ID "${requiredId}" is absent from the effective bundle ` +
          `and is ${!entry.enabled ? 'disabled' : 'not installed'} in the catalog`,
      };
    }
    // Eligible in catalog but absent from effective bundle → lost
    return {
      classification: 'lost',
      reason: `Skill ID "${requiredId}" is eligible in the catalog ` +
        `but absent from the effective agent's bundle`,
    };
  }

  // ID is in effective bundle — check catalog eligibility
  const catalogEntries = catalog.byId.get(requiredId);
  if (!catalogEntries || catalogEntries.length === 0) {
    return {
      classification: 'incompatible',
      reason: `Skill ID "${requiredId}" is in the effective bundle ` +
        `but not found in the authoritative catalog`,
    };
  }
  if (catalogEntries.length > 1) {
    return {
      classification: 'incompatible',
      reason: `Skill ID "${requiredId}" is in the effective bundle ` +
        `but is multiply-resolved in the catalog (${catalogEntries.length} entries)`,
    };
  }
  const entry = catalogEntries[0]!;
  if (!entry.enabled) {
    return {
      classification: 'incompatible',
      reason: `Skill ID "${requiredId}" is in the effective bundle ` +
        `but is disabled in the catalog`,
    };
  }
  if (!entry.installed) {
    return {
      classification: 'incompatible',
      reason: `Skill ID "${requiredId}" is in the effective bundle ` +
        `but is not installed in the catalog`,
    };
  }

  // Check capability alignment
  const sourceCapabilities = source.requiredSkillCapabilities.get(requiredId) ?? [];
  const effectiveCapabilities = effectiveBundle.skillCapabilities.get(requiredId) ?? [];

  // If source has no capability requirements for this skill, consider it preserved
  // (the skill is present and eligible, no capability conflict can occur)
  if (sourceCapabilities.length === 0) {
    return {
      classification: 'preserved',
      reason: `Skill ID "${requiredId}" is present in the effective bundle, ` +
        `eligible in the catalog, and the source has no specific capability requirements`,
    };
  }

  // Check if effective evidence supports the same normalized capability
  // At least one source capability must appear in effective capabilities
  const effectiveCapSet = new Set(effectiveCapabilities);
  const hasOverlap = sourceCapabilities.some(cap => effectiveCapSet.has(cap));

  if (hasOverlap) {
    return {
      classification: 'preserved',
      reason: `Skill ID "${requiredId}" is present in the effective bundle, ` +
        `eligible in the catalog, and effective evidence supports ` +
        `the same capability`,
    };
  }

  // No capability overlap — conflicting evidence
  return {
    classification: 'incompatible',
    reason: `Skill ID "${requiredId}" is present in the effective bundle ` +
      `but effective evidence supports conflicting capabilities ` +
      `(source requires [${sourceCapabilities.join(', ')}], ` +
      `effective supports [${effectiveCapabilities.join(', ')}])`,
  };
}

// ─────────────────────────────────────────────
// Deterministic Ordering
// ─────────────────────────────────────────────

/**
 * Comparator for deterministic outcome ordering.
 * Order: sourcePath → requiredSkillId → classification
 */
function compareOutcomes(a: DuplicateSkillOutcome, b: DuplicateSkillOutcome): number {
  const pathCmp = a.sourcePath.localeCompare(b.sourcePath);
  if (pathCmp !== 0) return pathCmp;

  const idA = a.requiredSkillId ?? '';
  const idB = b.requiredSkillId ?? '';
  const idCmp = idA.localeCompare(idB);
  if (idCmp !== 0) return idCmp;

  return a.classification.localeCompare(b.classification);
}

// ─────────────────────────────────────────────
// Block Propagation
// ─────────────────────────────────────────────

/**
 * Determines whether a reconciliation result blocks completion for
 * a given source path. A source is blocked if ANY of its outcomes
 * is non-preserved (incompatible, lost, or unresolved).
 *
 * Requirement 10.9: IF Duplicate_Skill_Reconciliation identifies an
 * incompatible or lost required Skill_ID or remains unresolved,
 * THEN THE Completion_Gate SHALL fail for every affected Discovered_Agent
 * and Effective_Registered_Agent.
 */
export function isSourceBlocked(
  result: DuplicateSkillReconciliationResult,
  sourcePath: string,
): boolean {
  return result.blockingSourcePaths.includes(sourcePath);
}

/**
 * Determines whether the effective agent is blocked by reconciliation.
 * The effective agent is blocked if ANY linked source has a non-preserved outcome.
 */
export function isEffectiveBlocked(
  result: DuplicateSkillReconciliationResult,
): boolean {
  return result.blockingEffective;
}

/**
 * Returns all non-preserved outcomes that cause blocking.
 */
export function getBlockingOutcomes(
  result: DuplicateSkillReconciliationResult,
): readonly DuplicateSkillOutcome[] {
  return result.outcomes.filter(o => o.classification !== 'preserved');
}
