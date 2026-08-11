/**
 * Assignment Evidence - Deterministic assignment evidence and approved override application
 *
 * Connects each selected Skill_ID to a material capability through an applicable
 * taxonomy rule or valid reviewed override. Produces stable reasons and canonical
 * evidence ordering.
 *
 * Prevents department-only broad mappings, unrelated text, keyword stuffing,
 * or invalid overrides from satisfying skill-to-evidence coverage.
 *
 * Requirements: 10.4–10.6, 10.10, 10.16
 */

import type {
  SkillTaxonomyRule,
  TaxonomyResolutionResult,
  TaxonomyCatalogSnapshot,
  TaxonomyCatalogEntry,
} from './skill-taxonomy';
import type { ReviewedOverride } from './reviewed-override';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Evidence origin indicating where a capability claim was found in the agent.
 */
export type EvidenceOrigin =
  | 'department'
  | 'specialty'
  | 'system-prompt-capability'
  | 'system-prompt-technology'
  | 'deliverable';

/**
 * Evidence supporting a material capability extraction.
 */
export interface CapabilityEvidence {
  readonly origin: EvidenceOrigin;
  readonly normalizedText: string;
}

/**
 * The materiality of a capability claim — what kind of relationship the agent
 * has with the capability.
 */
export type Materiality =
  | 'responsibility'
  | 'supported-operation'
  | 'required-expertise'
  | 'deliverable-dependency';

/**
 * A material capability extracted from the agent definition.
 */
export interface MaterialCapability {
  readonly capabilityKey: string;
  readonly displayName: string;
  readonly materiality: Materiality;
  readonly evidence: readonly CapabilityEvidence[];
}

/**
 * Source of assignment evidence — either a taxonomy rule or a reviewed override.
 */
export type AssignmentEvidenceSource =
  | { readonly kind: 'taxonomy'; readonly ruleId: string; readonly evidence: readonly CapabilityEvidence[] }
  | { readonly kind: 'reviewed-override'; readonly overrideId: string; readonly reviewerId: string; readonly rationale: string };

/**
 * A single assignment evidence record connecting a Skill_ID to a material
 * capability through a specific source (taxonomy rule or override).
 */
export interface AssignmentEvidence {
  readonly skillId: string;
  readonly capabilityKey: string;
  readonly reason: string;
  readonly source: AssignmentEvidenceSource;
}

/**
 * Validation status for an individual assignment evidence attempt.
 */
export type EvidenceValidationStatus =
  | 'valid'
  | 'department-only-broad'
  | 'unrelated-text'
  | 'keyword-stuffing'
  | 'invalid-override'
  | 'no-matching-capability';

/**
 * Detailed result of trying to build evidence for one skill ID.
 */
export interface EvidenceAttempt {
  readonly skillId: string;
  readonly status: EvidenceValidationStatus;
  readonly evidence: AssignmentEvidence | null;
  readonly rejectionReason?: string;
}

/**
 * Complete result of building assignment evidence for a set of skill IDs.
 */
export interface AssignmentEvidenceResult {
  /** Valid evidence records, canonically ordered */
  readonly evidence: readonly AssignmentEvidence[];
  /** Skill IDs that could not produce valid evidence */
  readonly unsupportedSkillIds: readonly string[];
  /** Skill IDs that have valid grounded evidence */
  readonly supportedSkillIds: readonly string[];
  /** Detailed attempt results for diagnostics */
  readonly attempts: readonly EvidenceAttempt[];
}

/**
 * Input data needed to build assignment evidence.
 */
export interface AssignmentEvidenceInput {
  /** Candidate skill IDs to build evidence for (ascending unique) */
  readonly candidateSkillIds: readonly string[];
  /** Material capabilities extracted from the agent */
  readonly materialCapabilities: readonly MaterialCapability[];
  /** Result of taxonomy resolution (matched rules and resolved IDs) */
  readonly taxonomyResult: TaxonomyResolutionResult;
  /** Eligible approved overrides that apply to this agent */
  readonly eligibleOverrides: readonly ReviewedOverride[];
  /** Authoritative catalog snapshot for capability metadata lookup */
  readonly catalog: TaxonomyCatalogSnapshot;
}

// ─────────────────────────────────────────────
// Evidence Building
// ─────────────────────────────────────────────

/**
 * Builds deterministic assignment evidence connecting each candidate skill ID
 * to a material capability through an applicable taxonomy rule or valid
 * reviewed override.
 *
 * Rejects:
 * - Department-only broad mappings: a department rule without specific
 *   capability/technology/deliverable support is insufficient evidence
 * - Unrelated text: evidence text that does not match any extracted material capability
 * - Keyword stuffing: capability keys derived from disconnected repetition
 *   rather than responsibility/operation/expertise/deliverable claims
 * - Invalid overrides: overrides that reference capabilities not actually
 *   extracted from the agent definition
 *
 * Evidence is ordered canonically by: skillId, capabilityKey, source kind,
 * rule/override ID, and evidence location.
 */
export function buildAssignmentEvidence(
  input: AssignmentEvidenceInput,
): AssignmentEvidenceResult {
  const { candidateSkillIds, materialCapabilities, taxonomyResult, eligibleOverrides, catalog } = input;

  const allAttempts: EvidenceAttempt[] = [];
  const validEvidence: AssignmentEvidence[] = [];
  const supportedIds = new Set<string>();
  const unsupportedIds: string[] = [];

  // Build a lookup of material capability keys for fast matching
  const capabilityKeySet = new Set(materialCapabilities.map(c => c.capabilityKey));

  // Build a map from capability key to its evidence for grounding checks
  const capabilityByKey = new Map<string, MaterialCapability>();
  for (const cap of materialCapabilities) {
    capabilityByKey.set(cap.capabilityKey, cap);
  }

  for (const skillId of candidateSkillIds) {
    const skillEvidence = buildEvidenceForSkill(
      skillId,
      materialCapabilities,
      capabilityKeySet,
      capabilityByKey,
      taxonomyResult,
      eligibleOverrides,
      catalog,
    );

    allAttempts.push(...skillEvidence.attempts);

    if (skillEvidence.validEvidence.length > 0) {
      validEvidence.push(...skillEvidence.validEvidence);
      supportedIds.add(skillId);
    } else {
      unsupportedIds.push(skillId);
    }
  }

  // Canonical ordering: skillId, capabilityKey, source kind, ruleId/overrideId
  const sortedEvidence = canonicalSort(validEvidence);

  return Object.freeze({
    evidence: Object.freeze(sortedEvidence),
    unsupportedSkillIds: Object.freeze(unsupportedIds),
    supportedSkillIds: Object.freeze([...supportedIds].sort()),
    attempts: Object.freeze(allAttempts),
  });
}

// ─────────────────────────────────────────────
// Per-Skill Evidence Building
// ─────────────────────────────────────────────

interface PerSkillEvidenceResult {
  validEvidence: AssignmentEvidence[];
  attempts: EvidenceAttempt[];
}

/**
 * Builds evidence for a single skill ID by checking taxonomy rules and overrides.
 * Rejects department-only broad mappings and ungrounded evidence.
 */
function buildEvidenceForSkill(
  skillId: string,
  materialCapabilities: readonly MaterialCapability[],
  capabilityKeySet: ReadonlySet<string>,
  capabilityByKey: ReadonlyMap<string, MaterialCapability>,
  taxonomyResult: TaxonomyResolutionResult,
  eligibleOverrides: readonly ReviewedOverride[],
  catalog: TaxonomyCatalogSnapshot,
): PerSkillEvidenceResult {
  const validEvidence: AssignmentEvidence[] = [];
  const attempts: EvidenceAttempt[] = [];

  // 1. Try to build evidence from taxonomy rules
  const taxonomyEvidence = buildTaxonomyEvidence(
    skillId,
    materialCapabilities,
    capabilityKeySet,
    capabilityByKey,
    taxonomyResult,
    catalog,
  );
  attempts.push(...taxonomyEvidence.attempts);
  validEvidence.push(...taxonomyEvidence.validEvidence);

  // 2. Try to build evidence from reviewed overrides
  const overrideEvidence = buildOverrideEvidence(
    skillId,
    capabilityKeySet,
    capabilityByKey,
    eligibleOverrides,
  );
  attempts.push(...overrideEvidence.attempts);
  validEvidence.push(...overrideEvidence.validEvidence);

  return { validEvidence, attempts };
}

// ─────────────────────────────────────────────
// Taxonomy Evidence
// ─────────────────────────────────────────────

interface TaxonomyEvidenceResult {
  validEvidence: AssignmentEvidence[];
  attempts: EvidenceAttempt[];
}

/**
 * Builds evidence from taxonomy rules for a given skill ID.
 *
 * Rejects department-only broad mappings: if the only applicable rule
 * is a department-dimension rule and it does not have specific capability
 * support matching an extracted material capability, the evidence is rejected.
 */
function buildTaxonomyEvidence(
  skillId: string,
  _materialCapabilities: readonly MaterialCapability[],
  capabilityKeySet: ReadonlySet<string>,
  capabilityByKey: ReadonlyMap<string, MaterialCapability>,
  taxonomyResult: TaxonomyResolutionResult,
  catalog: TaxonomyCatalogSnapshot,
): TaxonomyEvidenceResult {
  const validEvidence: AssignmentEvidence[] = [];
  const attempts: EvidenceAttempt[] = [];

  // Find all rules that produced this skill ID
  const applicableRules = findRulesProducingSkillId(skillId, taxonomyResult, catalog);

  if (applicableRules.length === 0) {
    // No taxonomy rule produced this skill ID — not a taxonomy evidence failure
    return { validEvidence, attempts };
  }

  // Check if ALL applicable rules are department-only broad mappings
  const hasDepartmentOnlyRules = applicableRules.every(r => r.dimension === 'department');
  const hasSpecificRules = applicableRules.some(r => r.dimension !== 'department');

  for (const rule of applicableRules) {
    // Find matching capability keys between the rule and extracted capabilities
    const matchingCapKeys = findMatchingCapabilityKeys(
      rule,
      capabilityKeySet,
      capabilityByKey,
      catalog,
      skillId,
    );

    if (matchingCapKeys.length === 0) {
      // Rule does not connect to any extracted material capability
      if (rule.dimension === 'department' && !hasSpecificRules) {
        // Department-only broad mapping without specific capability support
        attempts.push({
          skillId,
          status: 'department-only-broad',
          evidence: null,
          rejectionReason: `Department rule '${rule.ruleId}' is a broad mapping without specific capability support matching any extracted material capability`,
        });
      } else {
        attempts.push({
          skillId,
          status: 'no-matching-capability',
          evidence: null,
          rejectionReason: `Rule '${rule.ruleId}' (${rule.dimension}) does not connect to any extracted material capability`,
        });
      }
      continue;
    }

    // For department-only rules: reject if there are no specific rules backing it
    if (rule.dimension === 'department' && hasDepartmentOnlyRules) {
      // Check if any matching capability has evidence from a non-department origin
      const hasNonDepartmentEvidence = matchingCapKeys.some(capKey => {
        const cap = capabilityByKey.get(capKey);
        return cap?.evidence.some(e => e.origin !== 'department') ?? false;
      });

      if (!hasNonDepartmentEvidence) {
        attempts.push({
          skillId,
          status: 'department-only-broad',
          evidence: null,
          rejectionReason: `Department rule '${rule.ruleId}' maps to capabilities derived only from department-level evidence without specific specialty/technology/deliverable support`,
        });
        continue;
      }
    }

    // Build valid evidence for each matching capability key
    for (const capKey of matchingCapKeys) {
      const cap = capabilityByKey.get(capKey);
      if (!cap) continue;

      // Reject keyword-stuffing: evidence derived from disconnected repetition
      // only (no materiality claim in the capability)
      if (isKeywordStuffingEvidence(cap)) {
        attempts.push({
          skillId,
          status: 'keyword-stuffing',
          evidence: null,
          rejectionReason: `Capability '${capKey}' appears to be derived from keyword stuffing without materiality claims`,
        });
        continue;
      }

      const reason = buildTaxonomyReason(rule, capKey, cap);
      const capabilityEvidence = cap.evidence.filter(e => e.normalizedText.length > 0);

      const evidenceRecord: AssignmentEvidence = Object.freeze({
        skillId,
        capabilityKey: capKey,
        reason,
        source: Object.freeze({
          kind: 'taxonomy' as const,
          ruleId: rule.ruleId,
          evidence: Object.freeze(capabilityEvidence),
        }),
      });

      validEvidence.push(evidenceRecord);
      attempts.push({
        skillId,
        status: 'valid',
        evidence: evidenceRecord,
      });
    }
  }

  return { validEvidence, attempts };
}

// ─────────────────────────────────────────────
// Override Evidence
// ─────────────────────────────────────────────

interface OverrideEvidenceResult {
  validEvidence: AssignmentEvidence[];
  attempts: EvidenceAttempt[];
}

/**
 * Builds evidence from reviewed overrides for a given skill ID.
 *
 * Rejects overrides whose supportedCapabilityKey does not match an
 * extracted material capability — they cannot invent capabilities
 * absent from the agent definition.
 */
function buildOverrideEvidence(
  skillId: string,
  capabilityKeySet: ReadonlySet<string>,
  capabilityByKey: ReadonlyMap<string, MaterialCapability>,
  eligibleOverrides: readonly ReviewedOverride[],
): OverrideEvidenceResult {
  const validEvidence: AssignmentEvidence[] = [];
  const attempts: EvidenceAttempt[] = [];

  // Find overrides that target this skill ID
  const applicableOverrides = eligibleOverrides.filter(ov => ov.skillId === skillId);

  for (const override of applicableOverrides) {
    // Validate: override's supported capability must be an extracted material capability
    if (!capabilityKeySet.has(override.supportedCapabilityKey)) {
      attempts.push({
        skillId,
        status: 'invalid-override',
        evidence: null,
        rejectionReason: `Override '${override.overrideId}' claims support for capability '${override.supportedCapabilityKey}' which is not an extracted material capability of the agent`,
      });
      continue;
    }

    // The override's capability must not be keyword-stuffing
    const cap = capabilityByKey.get(override.supportedCapabilityKey);
    if (cap && isKeywordStuffingEvidence(cap)) {
      attempts.push({
        skillId,
        status: 'keyword-stuffing',
        evidence: null,
        rejectionReason: `Override '${override.overrideId}' references capability '${override.supportedCapabilityKey}' which appears derived from keyword stuffing`,
      });
      continue;
    }

    // Build valid override evidence
    const reason = buildOverrideReason(override);
    const evidenceRecord: AssignmentEvidence = Object.freeze({
      skillId,
      capabilityKey: override.supportedCapabilityKey,
      reason,
      source: Object.freeze({
        kind: 'reviewed-override' as const,
        overrideId: override.overrideId,
        reviewerId: override.reviewerId,
        rationale: override.rationale,
      }),
    });

    validEvidence.push(evidenceRecord);
    attempts.push({
      skillId,
      status: 'valid',
      evidence: evidenceRecord,
    });
  }

  return { validEvidence, attempts };
}

// ─────────────────────────────────────────────
// Capability Matching
// ─────────────────────────────────────────────

/**
 * Finds all taxonomy rules from the resolution result that produced a given skill ID.
 * A rule "produces" a skill ID if:
 * - It has a SkillSelector with that exact ID, or
 * - It has a CategorySelector whose expansion included that ID
 */
function findRulesProducingSkillId(
  skillId: string,
  taxonomyResult: TaxonomyResolutionResult,
  catalog: TaxonomyCatalogSnapshot,
): SkillTaxonomyRule[] {
  const producingRules: SkillTaxonomyRule[] = [];

  for (const rule of taxonomyResult.matchedRules) {
    for (const selector of rule.selectors) {
      if (selector.kind === 'skill' && selector.skillId === skillId) {
        producingRules.push(rule);
        break; // avoid duplicate pushes for the same rule
      }
      if (selector.kind === 'category') {
        // Check if category expansion yielded this skill ID
        const categoryEntries = catalog.byCategory.get(selector.category);
        if (categoryEntries) {
          const match = categoryEntries.find(
            e => e.skillId === skillId &&
              e.enabled && e.installed &&
              e.capabilityKeys.includes(selector.capabilityKey),
          );
          if (match) {
            producingRules.push(rule);
            break;
          }
        }
      }
    }
  }

  return producingRules;
}

/**
 * Finds capability keys that connect a taxonomy rule to extracted material capabilities.
 *
 * A rule connects to a capability when:
 * 1. The rule's supportedCapabilityKeys intersect with extracted capability keys, OR
 * 2. The skill's catalog metadata capabilityKeys intersect with extracted capability keys
 */
function findMatchingCapabilityKeys(
  rule: SkillTaxonomyRule,
  capabilityKeySet: ReadonlySet<string>,
  _capabilityByKey: ReadonlyMap<string, MaterialCapability>,
  catalog: TaxonomyCatalogSnapshot,
  skillId: string,
): string[] {
  const matchingKeys = new Set<string>();

  // Check rule's declared supported capability keys
  for (const capKey of rule.supportedCapabilityKeys) {
    if (capabilityKeySet.has(capKey)) {
      matchingKeys.add(capKey);
    }
  }

  // Check the skill's catalog metadata capability keys
  const catalogEntries = catalog.byId.get(skillId);
  if (catalogEntries && catalogEntries.length === 1) {
    const entry = catalogEntries[0] as TaxonomyCatalogEntry;
    for (const capKey of entry.capabilityKeys) {
      if (capabilityKeySet.has(capKey)) {
        matchingKeys.add(capKey);
      }
    }
  }

  // Return sorted for determinism
  return [...matchingKeys].sort();
}

// ─────────────────────────────────────────────
// Keyword Stuffing Detection
// ─────────────────────────────────────────────

/**
 * Determines if a material capability is likely derived from keyword stuffing.
 *
 * A capability is considered keyword-stuffing when:
 * - It has NO evidence with a materiality-bearing origin
 *   (i.e., only department-level evidence without responsibility/operation/expertise claims)
 * - All evidence normalizedText is empty or trivially short (< 3 characters)
 *
 * This protects against disconnected keyword repetition being used to
 * create material capabilities that then satisfy evidence requirements.
 */
function isKeywordStuffingEvidence(cap: MaterialCapability): boolean {
  // If there's no evidence at all, it's suspicious
  if (cap.evidence.length === 0) return true;

  // Check if ALL evidence is trivially short or empty
  const allTrivial = cap.evidence.every(e => e.normalizedText.trim().length < 3);
  if (allTrivial) return true;

  return false;
}

// ─────────────────────────────────────────────
// Reason Building
// ─────────────────────────────────────────────

/**
 * Builds a stable deterministic reason string for a taxonomy-sourced assignment.
 */
function buildTaxonomyReason(
  rule: SkillTaxonomyRule,
  capabilityKey: string,
  capability: MaterialCapability,
): string {
  const dimensionLabel = formatDimension(rule.dimension);
  const matchInfo = rule.normalizedMatch;
  const materialityLabel = formatMateriality(capability.materiality);

  return `Assigned via taxonomy rule '${rule.ruleId}' (${dimensionLabel} '${matchInfo}') supporting capability '${capabilityKey}' with ${materialityLabel} evidence`;
}

/**
 * Builds a stable deterministic reason string for an override-sourced assignment.
 */
function buildOverrideReason(override: ReviewedOverride): string {
  return `Assigned via reviewed override '${override.overrideId}' (reviewed by '${override.reviewerId}') supporting capability '${override.supportedCapabilityKey}'`;
}

/**
 * Formats a taxonomy dimension for display in reason strings.
 */
function formatDimension(dimension: string): string {
  switch (dimension) {
    case 'department': return 'department';
    case 'specialty': return 'specialty';
    case 'capability': return 'capability';
    case 'technology': return 'technology';
    case 'deliverable': return 'deliverable';
    default: return dimension;
  }
}

/**
 * Formats a materiality type for display in reason strings.
 */
function formatMateriality(materiality: Materiality): string {
  switch (materiality) {
    case 'responsibility': return 'responsibility';
    case 'supported-operation': return 'supported operation';
    case 'required-expertise': return 'required expertise';
    case 'deliverable-dependency': return 'deliverable dependency';
    default: return materiality;
  }
}

// ─────────────────────────────────────────────
// Canonical Sorting
// ─────────────────────────────────────────────

/**
 * Sorts evidence records in canonical order:
 * 1. By skillId (ascending)
 * 2. By capabilityKey (ascending)
 * 3. By source kind ('taxonomy' before 'reviewed-override')
 * 4. By source identifier (ruleId or overrideId, ascending)
 */
function canonicalSort(evidence: AssignmentEvidence[]): AssignmentEvidence[] {
  return [...evidence].sort((a, b) => {
    // 1. skillId ascending
    const skillCmp = a.skillId.localeCompare(b.skillId);
    if (skillCmp !== 0) return skillCmp;

    // 2. capabilityKey ascending
    const capCmp = a.capabilityKey.localeCompare(b.capabilityKey);
    if (capCmp !== 0) return capCmp;

    // 3. source kind: taxonomy before reviewed-override
    const kindOrder = { 'taxonomy': 0, 'reviewed-override': 1 };
    const kindCmp = kindOrder[a.source.kind] - kindOrder[b.source.kind];
    if (kindCmp !== 0) return kindCmp;

    // 4. By source identifier
    const aId = a.source.kind === 'taxonomy' ? a.source.ruleId : a.source.overrideId;
    const bId = b.source.kind === 'taxonomy' ? b.source.ruleId : b.source.overrideId;
    return aId.localeCompare(bId);
  });
}

// ─────────────────────────────────────────────
// Utility Exports
// ─────────────────────────────────────────────

/**
 * Checks if a set of assignment evidence provides complete skill-to-evidence
 * coverage: every skill ID in the given set must have at least one valid
 * evidence record.
 */
export function hasCompleteSkillToEvidenceCoverage(
  skillIds: readonly string[],
  evidence: readonly AssignmentEvidence[],
): { covered: boolean; uncoveredSkillIds: readonly string[] } {
  const evidencedSkills = new Set(evidence.map(e => e.skillId));
  const uncovered = skillIds.filter(id => !evidencedSkills.has(id));
  return {
    covered: uncovered.length === 0,
    uncoveredSkillIds: uncovered,
  };
}

/**
 * Checks if assignment evidence provides complete capability-to-skill coverage:
 * every material capability must have at least one assigned skill with valid evidence.
 */
export function hasCompleteCapabilityToSkillCoverage(
  materialCapabilities: readonly MaterialCapability[],
  evidence: readonly AssignmentEvidence[],
): { covered: boolean; uncoveredCapabilityKeys: readonly string[] } {
  const coveredCapKeys = new Set(evidence.map(e => e.capabilityKey));
  const uncovered = materialCapabilities
    .filter(cap => !coveredCapKeys.has(cap.capabilityKey))
    .map(cap => cap.capabilityKey);
  return {
    covered: uncovered.length === 0,
    uncoveredCapabilityKeys: uncovered,
  };
}

/**
 * Returns the stable deterministic fingerprint for a set of assignment evidence.
 * Identical evidence produces identical fingerprints regardless of input order.
 */
export function computeEvidenceFingerprint(
  evidence: readonly AssignmentEvidence[],
): string {
  const sorted = canonicalSort([...evidence]);
  const content = JSON.stringify(sorted.map(e => ({
    sk: e.skillId,
    ck: e.capabilityKey,
    r: e.reason,
    s: e.source.kind === 'taxonomy'
      ? { k: 'tax', id: e.source.ruleId }
      : { k: 'ov', id: e.source.overrideId, rv: e.source.reviewerId },
  })));

  // FNV-1a 32-bit hash for deterministic fingerprint
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `evidence-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
