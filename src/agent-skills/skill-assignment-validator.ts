/**
 * Skill Assignment Validator
 *
 * Validates skill assignments for agents by resolving taxonomy rules against
 * the authoritative catalog snapshot and producing validated skill bundles.
 *
 * Core responsibilities:
 * - Expand typed selectors (SkillSelector and CategorySelector) against ONE
 *   immutable authoritative catalog snapshot
 * - Reject unresolved, multiply-resolved, disabled, and uninstalled Skill_IDs
 * - Produce ascending unique candidate bundles with deterministic evidence
 * - Validate bidirectional coverage: capability-to-skill AND skill-to-evidence
 * - Always report complete material capabilities, uncovered capabilities,
 *   extraneous assignments, catalog resolution details, and manual-review state
 * - Prohibit persistence of empty or blocked partial bundles
 * - Preserve Quality_Scorer definitions, point allocations, and scoring behavior
 *
 * Requirements: 10.2–10.7, 10.10, 10.12, 10.16, 10.18, 10.20
 */

import type {
  TaxonomyCatalogSnapshot,
  SkillTaxonomySnapshot,
  TaxonomyInput,
  TaxonomyResolutionResult,
} from './skill-taxonomy';
import {
  resolveTaxonomy,
} from './skill-taxonomy';
import type { ReviewedOverrideSnapshot, ReviewedOverride } from './reviewed-override';
import { getEligibleOverridesForAgent } from './reviewed-override';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Codes for why a manual review is required.
 */
export type ManualReviewBlockCode =
  | 'UNKNOWN_TAXONOMY'
  | 'EMPTY_MAPPING'
  | 'NO_SUITABLE_SKILL'
  | 'UNRECOVERABLE_AGENT';

/**
 * Manual review block produced when deterministic evidence cannot produce
 * a suitable non-empty skill bundle.
 */
export interface ManualReviewBlock {
  readonly code: ManualReviewBlockCode;
  readonly dimensions: readonly string[];
  readonly capabilityKeys: readonly string[];
  readonly message: string;
}

/**
 * Material capability extracted from agent definition.
 */
export interface MaterialCapability {
  readonly capabilityKey: string;
  readonly displayName: string;
  readonly materiality:
    | 'responsibility'
    | 'supported-operation'
    | 'required-expertise'
    | 'deliverable-dependency';
  readonly evidence: readonly CapabilityEvidence[];
}

/**
 * Evidence supporting a material capability extraction.
 */
export interface CapabilityEvidence {
  readonly origin:
    | 'department'
    | 'specialty'
    | 'system-prompt-capability'
    | 'system-prompt-technology'
    | 'deliverable';
  readonly normalizedText: string;
}

/**
 * Catalog resolution detail for one assigned skill ID.
 * Always present in results for every skill ID in the bundle.
 */
export interface CatalogResolutionDetail {
  readonly skillId: string;
  readonly status: 'resolved' | 'unresolved' | 'multiply-resolved';
  readonly resolvedIdentity: string | null;
  readonly matchCount: number;
  readonly enabled: boolean | null;
  readonly installed: boolean | null;
  readonly category: string | null;
}

/**
 * Assignment evidence connecting a skill ID to a material capability.
 * Ordered by skillId, capabilityKey, source kind, ruleId/overrideId.
 */
export interface AssignmentEvidence {
  readonly skillId: string;
  readonly capabilityKey: string;
  readonly reason: string;
  readonly source:
    | { readonly kind: 'taxonomy'; readonly ruleId: string }
    | {
        readonly kind: 'reviewed-override';
        readonly overrideId: string;
        readonly reviewerId: string;
        readonly rationale: string;
      };
}

/**
 * Persistence status for a skill bundle.
 * - committed: bundle was persisted (or would be, for validation)
 * - rolled-back: transaction failed
 * - blocked: not eligible for persistence
 */
export type PersistenceStatus =
  | { readonly state: 'committed'; readonly changed: boolean }
  | { readonly state: 'rolled-back'; readonly errorCode: string }
  | { readonly state: 'blocked'; readonly reasons: readonly string[] };

/**
 * Result of skill assignment validation for a single subject.
 *
 * Every field is always present and deterministically ordered:
 * - skillIds: ascending unique (empty only when blocked)
 * - materialCapabilities: complete list from extraction
 * - evidence: canonical ordering by skillId/capabilityKey/source
 * - catalogResolution: one detail per assigned skill ID
 * - uncoveredMaterialCapabilities: always present (empty when fully covered)
 * - extraneousAssignments: always present (empty when all have evidence)
 * - manualReviewBlock: null when assignment is valid
 * - valid: true only when bundle is non-empty, all IDs resolve,
 *   bidirectional coverage passes, and no blocking conditions exist
 * - persistenceStatus: blocked unless valid is true
 */
export interface SkillAssignmentValidation {
  readonly skillIds: readonly string[];
  readonly materialCapabilities: readonly MaterialCapability[];
  readonly evidence: readonly AssignmentEvidence[];
  readonly catalogResolution: readonly CatalogResolutionDetail[];
  readonly uncoveredMaterialCapabilities: readonly MaterialCapability[];
  readonly extraneousAssignments: readonly string[];
  readonly manualReviewBlock: ManualReviewBlock | null;
  readonly valid: boolean;
  readonly persistenceStatus: PersistenceStatus;
}

/**
 * Input for skill assignment validation.
 */
export interface SkillAssignmentInput {
  /** Agent identity for override matching */
  readonly agentId?: string;
  /** Source path for override matching */
  readonly sourcePath?: string;
  /** Agent department (used for taxonomy resolution) */
  readonly department?: string;
  /** Agent specialty (used for taxonomy resolution) */
  readonly specialty?: string;
  /** Capabilities referenced in the agent definition */
  readonly capabilities?: readonly string[];
  /** Technologies referenced in the agent definition */
  readonly technologies?: readonly string[];
  /** Deliverables referenced in the agent definition */
  readonly deliverables?: readonly string[];
  /** Material capabilities already extracted from the agent */
  readonly materialCapabilities?: readonly MaterialCapability[];
}

// ─────────────────────────────────────────────
// Main Validation Function
// ─────────────────────────────────────────────

/**
 * Validates skill assignment for a given agent input against taxonomy,
 * reviewed overrides, and the authoritative catalog snapshot.
 *
 * Algorithm:
 * 1. Extract and sort material capabilities from input.
 * 2. Match all applicable taxonomy rules and valid overrides.
 * 3. Expand typed category selectors through the immutable snapshot;
 *    resolve explicit skill IDs exactly.
 * 4. Reject unresolved, multiply resolved, disabled, and uninstalled IDs.
 * 5. Build a unique ascending candidate bundle and deterministic evidence.
 * 6. Validate capability-to-skill coverage: each material capability must
 *    have at least one assigned eligible skill whose metadata declares support.
 * 7. Validate skill-to-evidence coverage: each assigned skill must have
 *    grounded evidence for at least one material capability.
 * 8. Report unsupported IDs as Extraneous_Assignment; report every
 *    uncovered capability.
 * 9. If no suitable non-empty result can be derived, emit Manual_Review_Block,
 *    leave the proposed bundle empty, and prohibit persistence.
 *
 * A successful result always has a non-empty sorted unique bundle.
 * A blocked result may show valid partial candidates for diagnosis,
 * but does not satisfy Requirement 10.2 and is never persisted as
 * a completed assignment.
 *
 * Requirement 10.20: This function does NOT modify Quality_Scorer inputs,
 * rule definitions, dimension scores, or total in any way.
 */
export function validateSkillAssignment(
  input: SkillAssignmentInput,
  taxonomy: SkillTaxonomySnapshot,
  overrides: ReviewedOverrideSnapshot,
  catalog: TaxonomyCatalogSnapshot,
): SkillAssignmentValidation {
  // Step 1: Build material capabilities from input
  const materialCapabilities = buildMaterialCapabilities(input);

  // Step 2: Build taxonomy input and resolve against catalog
  const taxonomyInput: TaxonomyInput = buildTaxonomyInput(input);
  const taxonomyResult = resolveTaxonomy(taxonomyInput, taxonomy, catalog);

  // Step 3: Get applicable reviewed overrides and resolve their skill IDs
  const eligibleOverrides = getEligibleOverridesForAgent(
    overrides,
    input.agentId,
    input.sourcePath,
  );
  const overrideResolution = resolveOverrideSkills(eligibleOverrides, catalog);

  // Step 4: Merge all resolved skill IDs into ascending unique candidates
  const candidateSkillIds = mergeAndSortSkillIds(
    taxonomyResult.resolvedSkillIds,
    overrideResolution.resolved,
  );

  // Step 5: Detect unmapped dimensions (for Manual_Review_Block decisions)
  const unmappedDimensions = detectUnmappedDimensions(input, taxonomy, taxonomyResult);

  // Step 6: Check if taxonomy mappings are unknown/empty
  // If no candidates from any source AND unmapped dimensions exist → block
  if (candidateSkillIds.length === 0) {
    const block = buildManualReviewBlock(input, unmappedDimensions, materialCapabilities);
    return buildBlockedResult(materialCapabilities, block);
  }

  // Step 7: If all candidates came from overrides only AND taxonomy is unmapped → block
  // Taxonomy MUST be able to deterministically produce results for completion
  if (
    unmappedDimensions.length > 0 &&
    taxonomyResult.resolvedSkillIds.length === 0
  ) {
    const block = buildManualReviewBlock(input, unmappedDimensions, materialCapabilities);
    return buildBlockedResult(materialCapabilities, block);
  }

  // Step 8: Build catalog resolution details for every candidate skill ID
  const catalogResolution = buildCatalogResolution(candidateSkillIds, catalog);

  // Step 9: Filter to only resolved, enabled, installed IDs
  // Reject any ID that fails catalog resolution checks
  const { acceptedIds } = filterAcceptedIds(catalogResolution);

  // If filtering removed ALL candidates, produce a block
  if (acceptedIds.length === 0) {
    const block: ManualReviewBlock = Object.freeze({
      code: 'NO_SUITABLE_SKILL' as ManualReviewBlockCode,
      dimensions: Object.freeze(unmappedDimensions),
      capabilityKeys: Object.freeze(materialCapabilities.map(c => c.capabilityKey)),
      message: 'Manual review required: all resolved skill IDs are disabled, ' +
        'uninstalled, or otherwise ineligible in the authoritative catalog. ' +
        'No fallback skill assigned.',
    });
    return buildBlockedResultWithResolution(materialCapabilities, block, catalogResolution);
  }

  // Step 10: Build deterministic evidence for accepted IDs
  const evidence = buildEvidence(acceptedIds, taxonomyResult, eligibleOverrides);

  // Step 11: Validate bidirectional coverage
  // Direction 1: capability-to-skill — each material capability maps to ≥1 assigned skill
  const uncoveredCapabilities = findUncoveredCapabilities(
    materialCapabilities,
    acceptedIds,
    catalog,
    evidence,
  );

  // Direction 2: skill-to-evidence — each assigned skill has valid evidence
  const extraneousAssignments = findExtraneousAssignments(acceptedIds, evidence);

  // Step 12: Determine overall validity
  const hasUncovered = uncoveredCapabilities.length > 0;
  const hasExtraneous = extraneousAssignments.length > 0;
  const valid = !hasUncovered && !hasExtraneous;

  // Step 13: Build persistence status
  // Prohibit persistence of empty or blocked partial bundles
  const persistenceStatus: PersistenceStatus = valid
    ? Object.freeze({ state: 'committed' as const, changed: true })
    : Object.freeze({
        state: 'blocked' as const,
        reasons: Object.freeze(buildBlockReasons(hasUncovered, hasExtraneous, uncoveredCapabilities, extraneousAssignments)),
      });

  return Object.freeze({
    skillIds: Object.freeze(acceptedIds),
    materialCapabilities: Object.freeze(materialCapabilities),
    evidence: Object.freeze(evidence),
    catalogResolution: Object.freeze(catalogResolution),
    uncoveredMaterialCapabilities: Object.freeze(uncoveredCapabilities),
    extraneousAssignments: Object.freeze(extraneousAssignments),
    manualReviewBlock: null,
    valid,
    persistenceStatus,
  });
}

// ─────────────────────────────────────────────
// Internal: Material Capability Building
// ─────────────────────────────────────────────

/**
 * Builds material capabilities from input. Uses pre-extracted capabilities
 * when provided, otherwise derives minimal capabilities from department/specialty.
 * Capabilities are sorted by capabilityKey for determinism.
 */
function buildMaterialCapabilities(input: SkillAssignmentInput): MaterialCapability[] {
  if (input.materialCapabilities && input.materialCapabilities.length > 0) {
    // Use pre-extracted capabilities, sorted for determinism
    return [...input.materialCapabilities].sort((a, b) =>
      a.capabilityKey.localeCompare(b.capabilityKey),
    );
  }

  // Derive minimal capabilities from agent dimensions
  const caps: MaterialCapability[] = [];

  if (input.department && input.department.trim()) {
    caps.push({
      capabilityKey: `dept-${normalizeKey(input.department)}`,
      displayName: `${input.department} department capability`,
      materiality: 'responsibility',
      evidence: [{ origin: 'department', normalizedText: input.department.toLowerCase().trim() }],
    });
  }

  if (input.specialty && input.specialty.trim()) {
    caps.push({
      capabilityKey: `spec-${normalizeKey(input.specialty)}`,
      displayName: `${input.specialty} specialty capability`,
      materiality: 'required-expertise',
      evidence: [{ origin: 'specialty', normalizedText: input.specialty.toLowerCase().trim() }],
    });
  }

  if (input.capabilities) {
    for (const cap of input.capabilities) {
      if (cap.trim()) {
        caps.push({
          capabilityKey: `cap-${normalizeKey(cap)}`,
          displayName: `${cap} capability`,
          materiality: 'supported-operation',
          evidence: [{ origin: 'system-prompt-capability', normalizedText: cap.toLowerCase().trim() }],
        });
      }
    }
  }

  if (input.technologies) {
    for (const tech of input.technologies) {
      if (tech.trim()) {
        caps.push({
          capabilityKey: `tech-${normalizeKey(tech)}`,
          displayName: `${tech} technology capability`,
          materiality: 'required-expertise',
          evidence: [{ origin: 'system-prompt-technology', normalizedText: tech.toLowerCase().trim() }],
        });
      }
    }
  }

  if (input.deliverables) {
    for (const deliv of input.deliverables) {
      if (deliv.trim()) {
        caps.push({
          capabilityKey: `deliv-${normalizeKey(deliv)}`,
          displayName: `${deliv} deliverable dependency`,
          materiality: 'deliverable-dependency',
          evidence: [{ origin: 'deliverable', normalizedText: deliv.toLowerCase().trim() }],
        });
      }
    }
  }

  return caps.sort((a, b) => a.capabilityKey.localeCompare(b.capabilityKey));
}

/**
 * Normalizes a string into a key-safe format for capability keys.
 */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ─────────────────────────────────────────────
// Internal: Taxonomy Input Building
// ─────────────────────────────────────────────

function buildTaxonomyInput(input: SkillAssignmentInput): TaxonomyInput {
  const ti: TaxonomyInput = {};
  if (input.department) (ti as { department?: string }).department = input.department;
  if (input.specialty) (ti as { specialty?: string }).specialty = input.specialty;
  if (input.capabilities) (ti as { capabilities?: readonly string[] }).capabilities = [...input.capabilities];
  if (input.technologies) (ti as { technologies?: readonly string[] }).technologies = [...input.technologies];
  if (input.deliverables) (ti as { deliverables?: readonly string[] }).deliverables = [...input.deliverables];
  return ti;
}

// ─────────────────────────────────────────────
// Internal: Override Resolution
// ─────────────────────────────────────────────

/**
 * Resolves override skill IDs against the authoritative catalog snapshot.
 * An override skill ID is accepted ONLY when:
 * - It resolves to exactly one catalog entry (byId)
 * - That entry is enabled AND installed
 *
 * Requirement 10.3: Treat a category label as a Skill_ID only when
 * exactly one such entry has that Skill_ID.
 */
function resolveOverrideSkills(
  overrides: readonly ReviewedOverride[],
  catalog: TaxonomyCatalogSnapshot,
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const ov of overrides) {
    const entries = catalog.byId.get(ov.skillId);
    if (!entries || entries.length === 0) {
      unresolved.push(ov.skillId);
    } else if (entries.length > 1) {
      // Multiply resolved — reject
      unresolved.push(ov.skillId);
    } else {
      const entry = entries[0]!;
      if (entry.enabled && entry.installed) {
        resolved.push(ov.skillId);
      } else {
        // Disabled or uninstalled — reject
        unresolved.push(ov.skillId);
      }
    }
  }

  return { resolved: [...new Set(resolved)].sort(), unresolved };
}

// ─────────────────────────────────────────────
// Internal: Merge and Sort
// ─────────────────────────────────────────────

/**
 * Merges taxonomy-resolved and override-resolved skill IDs into a
 * single ascending unique sorted list. Requirement 10.10: each Skill_Bundle
 * sorted by ascending Skill_ID and containing each Skill_ID exactly once.
 */
function mergeAndSortSkillIds(
  taxonomyIds: readonly string[],
  overrideIds: readonly string[],
): string[] {
  const merged = new Set([...taxonomyIds, ...overrideIds]);
  return [...merged].sort();
}

// ─────────────────────────────────────────────
// Internal: Unmapped Dimension Detection
// ─────────────────────────────────────────────

/**
 * Detects which input dimensions have no applicable taxonomy rules.
 * An unmapped dimension means the taxonomy cannot deterministically
 * produce appropriate skill assignments for that agent dimension.
 *
 * Requirement 10.7: IF applicable department, specialty, or Skill_Taxonomy
 * mapping is unknown or empty, THEN assign Manual_Review_Block.
 */
function detectUnmappedDimensions(
  input: SkillAssignmentInput,
  _taxonomy: SkillTaxonomySnapshot,
  taxonomyResult: TaxonomyResolutionResult,
): string[] {
  const unmapped: string[] = [];

  if (input.department && input.department.trim().length > 0) {
    const hasDeptRule = taxonomyResult.matchedRules.some(r => r.dimension === 'department');
    if (!hasDeptRule) {
      unmapped.push(`department:${input.department}`);
    }
  }

  if (input.specialty && input.specialty.trim().length > 0) {
    const hasSpecRule = taxonomyResult.matchedRules.some(r => r.dimension === 'specialty');
    if (!hasSpecRule) {
      unmapped.push(`specialty:${input.specialty}`);
    }
  }

  if (input.capabilities) {
    for (const cap of input.capabilities) {
      if (cap.trim().length > 0) {
        const hasCapRule = taxonomyResult.matchedRules.some(r => r.dimension === 'capability');
        if (!hasCapRule) {
          unmapped.push(`capability:${cap}`);
          break; // report once per dimension
        }
      }
    }
  }

  if (input.technologies) {
    for (const tech of input.technologies) {
      if (tech.trim().length > 0) {
        const hasTechRule = taxonomyResult.matchedRules.some(r => r.dimension === 'technology');
        if (!hasTechRule) {
          unmapped.push(`technology:${tech}`);
          break;
        }
      }
    }
  }

  if (input.deliverables) {
    for (const deliv of input.deliverables) {
      if (deliv.trim().length > 0) {
        const hasDelivRule = taxonomyResult.matchedRules.some(r => r.dimension === 'deliverable');
        if (!hasDelivRule) {
          unmapped.push(`deliverable:${deliv}`);
          break;
        }
      }
    }
  }

  return unmapped;
}

// ─────────────────────────────────────────────
// Internal: Manual Review Block Construction
// ─────────────────────────────────────────────

/**
 * Builds the appropriate ManualReviewBlock based on why assignment failed.
 * Never assigns a generic fallback skill.
 */
function buildManualReviewBlock(
  _input: SkillAssignmentInput,
  unmappedDimensions: string[],
  materialCapabilities: readonly MaterialCapability[],
): ManualReviewBlock {
  const capabilityKeys = materialCapabilities.map(c => c.capabilityKey);

  if (unmappedDimensions.length > 0) {
    const code: ManualReviewBlockCode = unmappedDimensions.some(d => d.startsWith('department:'))
      ? 'UNKNOWN_TAXONOMY'
      : 'EMPTY_MAPPING';

    return Object.freeze({
      code,
      dimensions: Object.freeze([...unmappedDimensions]),
      capabilityKeys: Object.freeze([...capabilityKeys]),
      message: `Manual review required: no taxonomy rules match dimensions ` +
        `[${unmappedDimensions.join(', ')}]. No fallback skill assigned.`,
    });
  }

  return Object.freeze({
    code: 'NO_SUITABLE_SKILL' as ManualReviewBlockCode,
    dimensions: Object.freeze([]),
    capabilityKeys: Object.freeze([...capabilityKeys]),
    message: `Manual review required: taxonomy rules resolved but no suitable ` +
      `enabled/installed skill found in the authoritative catalog. ` +
      `No fallback skill assigned.`,
  });
}

// ─────────────────────────────────────────────
// Internal: Blocked Result Builders
// ─────────────────────────────────────────────

/**
 * Builds a fully blocked result when no suitable assignment can be made.
 * Reports complete material capabilities and uncovered list.
 * Prohibits persistence of empty or blocked partial bundles.
 */
function buildBlockedResult(
  materialCapabilities: readonly MaterialCapability[],
  block: ManualReviewBlock,
): SkillAssignmentValidation {
  return Object.freeze({
    skillIds: Object.freeze([]),
    materialCapabilities: Object.freeze([...materialCapabilities]),
    evidence: Object.freeze([]),
    catalogResolution: Object.freeze([]),
    uncoveredMaterialCapabilities: Object.freeze([...materialCapabilities]),
    extraneousAssignments: Object.freeze([]),
    manualReviewBlock: block,
    valid: false,
    persistenceStatus: Object.freeze({
      state: 'blocked' as const,
      reasons: Object.freeze([block.message]),
    }),
  });
}

/**
 * Builds a blocked result that includes catalog resolution details
 * (used when candidates were found but all were ineligible).
 */
function buildBlockedResultWithResolution(
  materialCapabilities: readonly MaterialCapability[],
  block: ManualReviewBlock,
  catalogResolution: readonly CatalogResolutionDetail[],
): SkillAssignmentValidation {
  return Object.freeze({
    skillIds: Object.freeze([]),
    materialCapabilities: Object.freeze([...materialCapabilities]),
    evidence: Object.freeze([]),
    catalogResolution: Object.freeze([...catalogResolution]),
    uncoveredMaterialCapabilities: Object.freeze([...materialCapabilities]),
    extraneousAssignments: Object.freeze([]),
    manualReviewBlock: block,
    valid: false,
    persistenceStatus: Object.freeze({
      state: 'blocked' as const,
      reasons: Object.freeze([block.message]),
    }),
  });
}

// ─────────────────────────────────────────────
// Internal: Catalog Resolution
// ─────────────────────────────────────────────

/**
 * Builds catalog resolution details for every candidate skill ID.
 * Each ID gets exactly one CatalogResolutionDetail record reporting
 * its resolution status, enabled/installed state, and identity.
 *
 * Requirement 10.16: One Catalog_Resolution_Detail with resolution
 * identity or unresolved status and individual enabled/installed states
 * for every assigned Skill_ID.
 */
function buildCatalogResolution(
  skillIds: readonly string[],
  catalog: TaxonomyCatalogSnapshot,
): CatalogResolutionDetail[] {
  return skillIds.map(skillId => {
    const entries = catalog.byId.get(skillId);
    if (!entries || entries.length === 0) {
      return {
        skillId,
        status: 'unresolved' as const,
        resolvedIdentity: null,
        matchCount: 0,
        enabled: null,
        installed: null,
        category: null,
      };
    }
    if (entries.length > 1) {
      return {
        skillId,
        status: 'multiply-resolved' as const,
        resolvedIdentity: null,
        matchCount: entries.length,
        enabled: null,
        installed: null,
        category: null,
      };
    }
    const entry = entries[0]!;
    return {
      skillId,
      status: 'resolved' as const,
      resolvedIdentity: entry.skillId,
      matchCount: 1,
      enabled: entry.enabled,
      installed: entry.installed,
      category: entry.category,
    };
  });
}

// ─────────────────────────────────────────────
// Internal: Accepted ID Filtering
// ─────────────────────────────────────────────

/**
 * Filters candidate skill IDs to only those that pass all catalog checks:
 * - Resolves to exactly one entry
 * - Entry is enabled (true)
 * - Entry is installed (true)
 *
 * Requirement 10.3: Every assigned Skill_ID must resolve to exactly one
 * Skill_Catalog_Entry whose enabled and installed states both equal true.
 *
 * Requirement 10.18: Unresolved, multiply resolved, disabled, or
 * uninstalled Skill_ID causes completion failure.
 */
function filterAcceptedIds(
  resolutions: readonly CatalogResolutionDetail[],
): { acceptedIds: string[]; rejectedDetails: CatalogResolutionDetail[] } {
  const acceptedIds: string[] = [];
  const rejectedDetails: CatalogResolutionDetail[] = [];

  for (const detail of resolutions) {
    if (
      detail.status === 'resolved' &&
      detail.enabled === true &&
      detail.installed === true
    ) {
      acceptedIds.push(detail.skillId);
    } else {
      rejectedDetails.push(detail);
    }
  }

  // Maintain ascending unique order (should already be from input)
  return { acceptedIds: [...new Set(acceptedIds)].sort(), rejectedDetails };
}

// ─────────────────────────────────────────────
// Internal: Evidence Building
// ─────────────────────────────────────────────

/**
 * Builds deterministic assignment evidence for accepted skill IDs.
 * Evidence connects each assigned skill to material capabilities through
 * taxonomy rules or reviewed overrides.
 *
 * Evidence is ordered by: skillId, capabilityKey, source kind, ruleId/overrideId.
 * Requirement 10.10: Deterministic ordering for identical inputs.
 */
function buildEvidence(
  skillIds: readonly string[],
  taxonomyResult: TaxonomyResolutionResult,
  overrides: readonly ReviewedOverride[],
): AssignmentEvidence[] {
  const evidence: AssignmentEvidence[] = [];

  for (const skillId of skillIds) {
    // Collect evidence from taxonomy rules
    for (const rule of taxonomyResult.matchedRules) {
      const matchesSkill = rule.selectors.some(sel => {
        if (sel.kind === 'skill') return sel.skillId === skillId;
        // CategorySelector: check if this skill was resolved from category expansion
        // We verify by checking taxonomy resolution results
        return false;
      });

      if (matchesSkill) {
        const capKey = rule.supportedCapabilityKeys.length > 0
          ? rule.supportedCapabilityKeys[0]!
          : 'unknown';
        evidence.push({
          skillId,
          capabilityKey: capKey,
          reason: `Taxonomy rule ${rule.ruleId} matched dimension ${rule.dimension}`,
          source: { kind: 'taxonomy', ruleId: rule.ruleId },
        });
      }
    }

    // Check category selectors that resolved to this skill ID
    for (const rule of taxonomyResult.matchedRules) {
      for (const sel of rule.selectors) {
        if (sel.kind === 'category') {
          // Check if this skillId was produced by category expansion
          const resolution = taxonomyResult.resolutions.find(
            r => r.selector === sel && r.resolvedSkillIds.includes(skillId),
          );
          if (resolution) {
            const capKey = rule.supportedCapabilityKeys.length > 0
              ? rule.supportedCapabilityKeys[0]!
              : sel.capabilityKey;
            // Avoid duplicate evidence (same rule+skill)
            const alreadyAdded = evidence.some(
              e => e.skillId === skillId && e.source.kind === 'taxonomy' &&
                e.source.ruleId === rule.ruleId,
            );
            if (!alreadyAdded) {
              evidence.push({
                skillId,
                capabilityKey: capKey,
                reason: `Taxonomy rule ${rule.ruleId} category expansion ` +
                  `(${sel.category}/${sel.capabilityKey}) matched dimension ${rule.dimension}`,
                source: { kind: 'taxonomy', ruleId: rule.ruleId },
              });
            }
          }
        }
      }
    }

    // Collect evidence from reviewed overrides
    for (const ov of overrides) {
      if (ov.skillId === skillId) {
        evidence.push({
          skillId,
          capabilityKey: ov.supportedCapabilityKey,
          reason: `Reviewed override ${ov.overrideId} by ${ov.reviewerId}`,
          source: {
            kind: 'reviewed-override',
            overrideId: ov.overrideId,
            reviewerId: ov.reviewerId,
            rationale: ov.rationale,
          },
        });
      }
    }
  }

  // Sort canonically: skillId → capabilityKey → source kind → ruleId/overrideId
  return evidence.sort(compareEvidence);
}

/**
 * Canonical evidence comparator for deterministic ordering.
 * Order: skillId → capabilityKey → source kind → ruleId/overrideId
 */
function compareEvidence(a: AssignmentEvidence, b: AssignmentEvidence): number {
  const idCmp = a.skillId.localeCompare(b.skillId);
  if (idCmp !== 0) return idCmp;

  const capCmp = a.capabilityKey.localeCompare(b.capabilityKey);
  if (capCmp !== 0) return capCmp;

  const kindCmp = a.source.kind.localeCompare(b.source.kind);
  if (kindCmp !== 0) return kindCmp;

  // Within same kind, sort by identifier
  if (a.source.kind === 'taxonomy' && b.source.kind === 'taxonomy') {
    return a.source.ruleId.localeCompare(b.source.ruleId);
  }
  if (a.source.kind === 'reviewed-override' && b.source.kind === 'reviewed-override') {
    return a.source.overrideId.localeCompare(b.source.overrideId);
  }

  return 0;
}

// ─────────────────────────────────────────────
// Internal: Bidirectional Coverage Checks
// ─────────────────────────────────────────────

/**
 * Direction 1 (capability-to-skill): Find material capabilities that
 * lack assigned enabled and installed skill coverage.
 *
 * A capability is "covered" when at least one assigned skill:
 * - Has the capability key in its catalog entry's capabilityKeys, OR
 * - Has evidence explicitly linking it to this capability
 *
 * Requirement 10.5: Every Material_Capability maps to at least one
 * assigned enabled and installed Skill_Catalog_Entry.
 */
function findUncoveredCapabilities(
  capabilities: readonly MaterialCapability[],
  acceptedIds: readonly string[],
  catalog: TaxonomyCatalogSnapshot,
  evidence: readonly AssignmentEvidence[],
): MaterialCapability[] {
  if (capabilities.length === 0) return [];
  if (acceptedIds.length === 0) return [...capabilities];

  // Build set of capability keys covered by catalog metadata
  const catalogCoveredKeys = new Set<string>();
  for (const skillId of acceptedIds) {
    const entries = catalog.byId.get(skillId);
    if (entries && entries.length === 1) {
      const entry = entries[0]!;
      for (const capKey of entry.capabilityKeys) {
        catalogCoveredKeys.add(capKey);
      }
    }
  }

  // Build set of capability keys covered by evidence
  const evidenceCoveredKeys = new Set<string>();
  for (const ev of evidence) {
    if (acceptedIds.includes(ev.skillId)) {
      evidenceCoveredKeys.add(ev.capabilityKey);
    }
  }

  // A capability is uncovered if neither catalog nor evidence covers it
  return capabilities.filter(
    cap => !catalogCoveredKeys.has(cap.capabilityKey) &&
      !evidenceCoveredKeys.has(cap.capabilityKey),
  );
}

/**
 * Direction 2 (skill-to-evidence): Find assigned skills that have
 * no valid evidence connecting them to a material capability.
 *
 * A skill is "extraneous" when it has no AssignmentEvidence at all,
 * meaning it is supported only by unrelated content, disconnected
 * keyword repetition, or no valid evidence.
 *
 * Requirement 10.6: IF an assigned Skill_ID is supported only by unrelated
 * content, disconnected keyword repetition, or no valid Assignment_Evidence,
 * THEN record as Extraneous_Assignment and block completion.
 */
function findExtraneousAssignments(
  acceptedIds: readonly string[],
  evidence: readonly AssignmentEvidence[],
): string[] {
  const evidencedSkills = new Set(evidence.map(e => e.skillId));
  return acceptedIds.filter(id => !evidencedSkills.has(id));
}

// ─────────────────────────────────────────────
// Internal: Block Reasons
// ─────────────────────────────────────────────

/**
 * Builds descriptive block reasons for bidirectional coverage failures.
 */
function buildBlockReasons(
  hasUncovered: boolean,
  hasExtraneous: boolean,
  uncoveredCapabilities: readonly MaterialCapability[],
  extraneousAssignments: readonly string[],
): string[] {
  const reasons: string[] = [];

  if (hasUncovered) {
    const keys = uncoveredCapabilities.map(c => c.capabilityKey).join(', ');
    reasons.push(
      `Bidirectional coverage failed: uncovered material capabilities [${keys}]`,
    );
  }

  if (hasExtraneous) {
    reasons.push(
      `Bidirectional coverage failed: extraneous assignments [${extraneousAssignments.join(', ')}]`,
    );
  }

  return reasons;
}
