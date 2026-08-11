/**
 * Skill Bundle Reconciliation - Canonical bundles, fingerprints, dependency
 * invalidation, and no-op recomputation.
 *
 * Core responsibilities:
 * - Canonicalize skill IDs as ascending unique lists
 * - Canonicalize evidence/reasons as stable sorted data
 * - Fingerprint all applicable agent, duplicate, taxonomy, override, catalog,
 *   and assignment inputs
 * - Recompute every and only affected subjects after input changes
 * - Emit no row or event mutation when unchanged inputs already match the
 *   complete desired state
 *
 * Requirements: 10.10–10.12, 10.20
 */

import { createHash } from 'node:crypto';

import type { AssignmentEvidence } from './assignment-evidence';
import { computeEvidenceFingerprint } from './assignment-evidence';
import type { SkillTaxonomySnapshot } from './skill-taxonomy';
import type { ReviewedOverrideSnapshot } from './reviewed-override';
import type { AuthoritativeSkillCatalogSnapshot } from './agent-skills-service';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * A canonical skill bundle: ascending unique skill IDs with stable
 * evidence and reasons. Identical inputs always produce identical bundles.
 *
 * Requirement 10.10: Each Skill_Bundle is sorted by ascending Skill_ID
 * and contains each Skill_ID exactly once.
 */
export interface CanonicalSkillBundle {
  /** Ascending unique skill IDs */
  readonly skillIds: readonly string[];
  /** Canonically ordered evidence records */
  readonly evidence: readonly AssignmentEvidence[];
  /** Canonical assignment reasons keyed by skillId */
  readonly reasons: readonly CanonicalAssignmentReason[];
  /** Stable content fingerprint of the bundle */
  readonly bundleFingerprint: string;
}

/**
 * A canonical assignment reason: one deterministic reason per skillId.
 * Sorted by skillId for stable output.
 */
export interface CanonicalAssignmentReason {
  readonly skillId: string;
  readonly reason: string;
}

/**
 * Input fingerprint capturing ALL inputs that may affect a subject's bundle.
 * When any fingerprint component changes, the subject must be recomputed.
 *
 * Requirement 10.12: Recompute every affected Skill_Bundle when inputs change.
 */
export interface ReconciliationInputFingerprint {
  /** Fingerprint of the agent definition (hash of all relevant fields) */
  readonly agentFingerprint: string;
  /** Fingerprint of duplicate group membership/outcomes */
  readonly duplicateFingerprint: string;
  /** Fingerprint of the taxonomy snapshot */
  readonly taxonomyFingerprint: string;
  /** Fingerprint of the override snapshot */
  readonly overrideFingerprint: string;
  /** Fingerprint of the authoritative catalog snapshot */
  readonly catalogFingerprint: string;
  /** Fingerprint of current assignments in the store */
  readonly assignmentFingerprint: string;
  /** Combined input fingerprint (SHA-256 of all components) */
  readonly combinedFingerprint: string;
}

/**
 * Describes one subject (agent) eligible for reconciliation.
 */
export interface ReconciliationSubject {
  /** Agent identity */
  readonly agentId: string;
  /** Source paths associated with this subject */
  readonly sourcePaths: readonly string[];
  /** Duplicate group ID (null if not a duplicate) */
  readonly duplicateGroupId: string | null;
  /** Department for taxonomy resolution */
  readonly department: string;
  /** Specialty for taxonomy resolution */
  readonly specialty: string;
  /** System prompt content fingerprint */
  readonly systemPromptFingerprint: string;
}

/**
 * The result of computing reconciliation for a single subject.
 */
export interface ReconciliationResult {
  readonly agentId: string;
  readonly bundle: CanonicalSkillBundle | null;
  readonly inputFingerprint: ReconciliationInputFingerprint;
  readonly action: ReconciliationAction;
  /** Whether any row/event mutation would be emitted */
  readonly mutationRequired: boolean;
}

/**
 * The action determined by reconciliation.
 * - 'no-op': inputs match desired state, emit no mutations
 * - 'recompute': inputs changed, bundle recomputed
 * - 'blocked': cannot produce a valid bundle
 */
export type ReconciliationAction = 'no-op' | 'recompute' | 'blocked';

/**
 * Dependency graph entry: maps a subject to its input dependencies.
 * Used for determining which subjects need recomputation after changes.
 */
export interface DependencyEdge {
  /** Subject agent ID */
  readonly subjectAgentId: string;
  /** Dependency type */
  readonly dependencyKind: DependencyKind;
  /** Identifier of the dependency (rule ID, override ID, catalog skill ID, etc.) */
  readonly dependencyId: string;
}

/**
 * Types of dependencies that can trigger recomputation.
 */
export type DependencyKind =
  | 'agent-definition'
  | 'duplicate-group'
  | 'taxonomy-rule'
  | 'reviewed-override'
  | 'catalog-entry'
  | 'assignment-store';

/**
 * Represents a change to an input that may require recomputation.
 */
export interface InputChange {
  readonly kind: DependencyKind;
  readonly id: string;
}

/**
 * Previously stored reconciliation state for a subject.
 * Used to detect no-op conditions.
 */
export interface StoredBundleState {
  readonly agentId: string;
  readonly inputFingerprint: string;
  readonly bundleFingerprint: string;
  readonly skillIds: readonly string[];
}

// ─────────────────────────────────────────────
// Canonical Bundle Construction
// ─────────────────────────────────────────────

/**
 * Creates a canonical skill bundle from raw skill IDs and evidence.
 *
 * Canonicalization rules:
 * - Skill IDs: deduplicated, sorted ascending lexicographically
 * - Evidence: sorted by (skillId, capabilityKey, source.kind, source ID)
 * - Reasons: one per skill ID, sorted by skillId, derived from first evidence
 * - Fingerprint: stable SHA-256 of canonical content
 *
 * Requirement 10.10: Identical inputs produce identical bundles.
 */
export function createCanonicalBundle(
  rawSkillIds: readonly string[],
  rawEvidence: readonly AssignmentEvidence[],
): CanonicalSkillBundle {
  // Deduplicate and sort skill IDs ascending
  const skillIds = canonicalizeSkillIds(rawSkillIds);

  // Canonically sort evidence
  const evidence = canonicalizeEvidence(rawEvidence);

  // Derive one reason per skill ID from evidence
  const reasons = deriveCanonicalReasons(skillIds, evidence);

  // Compute stable fingerprint
  const bundleFingerprint = computeBundleFingerprint(skillIds, evidence);

  return Object.freeze({
    skillIds: Object.freeze(skillIds),
    evidence: Object.freeze(evidence),
    reasons: Object.freeze(reasons),
    bundleFingerprint,
  });
}

/**
 * Deduplicates and sorts skill IDs into ascending unique list.
 * This is the canonical representation for any skill bundle.
 */
export function canonicalizeSkillIds(rawIds: readonly string[]): string[] {
  const unique = [...new Set(rawIds)];
  unique.sort((a, b) => a.localeCompare(b));
  return unique;
}

/**
 * Sorts evidence into canonical order:
 * 1. skillId ascending
 * 2. capabilityKey ascending
 * 3. source.kind ascending ('reviewed-override' < 'taxonomy' alphabetically)
 * 4. source identifier ascending (ruleId or overrideId)
 */
export function canonicalizeEvidence(
  rawEvidence: readonly AssignmentEvidence[],
): AssignmentEvidence[] {
  return [...rawEvidence].sort(compareEvidenceCanonical);
}

/**
 * Derives one canonical reason per skill ID from sorted evidence.
 * Uses the first evidence entry for each skill ID (after canonical sort).
 * Sorted by skillId for stable output.
 */
export function deriveCanonicalReasons(
  skillIds: readonly string[],
  sortedEvidence: readonly AssignmentEvidence[],
): CanonicalAssignmentReason[] {
  const reasons: CanonicalAssignmentReason[] = [];

  for (const skillId of skillIds) {
    const firstEvidence = sortedEvidence.find(e => e.skillId === skillId);
    const reason = firstEvidence
      ? firstEvidence.reason
      : `Skill ${skillId} assigned without explicit evidence`;
    reasons.push(Object.freeze({ skillId, reason }));
  }

  return reasons;
}

// ─────────────────────────────────────────────
// Fingerprinting
// ─────────────────────────────────────────────

/**
 * Computes a stable SHA-256 fingerprint for a canonical bundle.
 * Identical skill IDs and evidence produce identical fingerprints
 * regardless of the order they were originally provided.
 */
export function computeBundleFingerprint(
  skillIds: readonly string[],
  evidence: readonly AssignmentEvidence[],
): string {
  const hash = createHash('sha256');

  // Hash skill IDs (already canonical ascending unique)
  hash.update('skills:');
  hash.update(JSON.stringify(skillIds));
  hash.update('\n');

  // Hash evidence fingerprint (uses canonical ordering internally)
  const evidenceFp = computeEvidenceFingerprint(evidence);
  hash.update('evidence:');
  hash.update(evidenceFp);
  hash.update('\n');

  return `bundle-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Computes a fingerprint for agent definition inputs relevant to skill
 * assignment: department, specialty, and system prompt content.
 *
 * Only content that affects skill derivation is fingerprinted.
 * Quality_Scorer inputs are NOT included here (Requirement 10.20).
 */
export function computeAgentInputFingerprint(
  agentId: string,
  department: string,
  specialty: string,
  systemPromptHash: string,
): string {
  const hash = createHash('sha256');
  hash.update('agent-input:');
  hash.update(JSON.stringify({ agentId, department, specialty }));
  hash.update('\n');
  hash.update('prompt-hash:');
  hash.update(systemPromptHash);
  return `agent-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Computes a fingerprint for duplicate group membership and outcomes.
 * Null group ID produces a deterministic "no-duplicate" fingerprint.
 */
export function computeDuplicateFingerprint(
  duplicateGroupId: string | null,
  memberAgentIds: readonly string[],
): string {
  if (duplicateGroupId === null) {
    return 'dup-none';
  }
  const hash = createHash('sha256');
  hash.update('duplicate:');
  hash.update(JSON.stringify({
    groupId: duplicateGroupId,
    members: [...memberAgentIds].sort(),
  }));
  return `dup-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Computes a fingerprint for current assignment store state for a subject.
 * Uses sorted skill IDs from the assignment store.
 * Empty assignments produce a deterministic "empty" fingerprint.
 */
export function computeAssignmentStoreFingerprint(
  currentAssignedSkillIds: readonly string[],
): string {
  if (currentAssignedSkillIds.length === 0) {
    return 'assign-empty';
  }
  const sorted = [...currentAssignedSkillIds].sort();
  const hash = createHash('sha256');
  hash.update('assignments:');
  hash.update(JSON.stringify(sorted));
  return `assign-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Combines all individual input fingerprints into one combined fingerprint.
 * A change in ANY component fingerprint produces a different combined fingerprint.
 *
 * This is used to detect whether a subject needs recomputation.
 */
export function computeCombinedInputFingerprint(
  agentFingerprint: string,
  duplicateFingerprint: string,
  taxonomyFingerprint: string,
  overrideFingerprint: string,
  catalogFingerprint: string,
  assignmentFingerprint: string,
): string {
  const hash = createHash('sha256');
  hash.update('combined-input:');
  hash.update(JSON.stringify({
    agent: agentFingerprint,
    duplicate: duplicateFingerprint,
    taxonomy: taxonomyFingerprint,
    override: overrideFingerprint,
    catalog: catalogFingerprint,
    assignment: assignmentFingerprint,
  }));
  return `input-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Builds a complete ReconciliationInputFingerprint from component fingerprints.
 */
export function buildInputFingerprint(params: {
  agentFingerprint: string;
  duplicateFingerprint: string;
  taxonomyFingerprint: string;
  overrideFingerprint: string;
  catalogFingerprint: string;
  assignmentFingerprint: string;
}): ReconciliationInputFingerprint {
  const combined = computeCombinedInputFingerprint(
    params.agentFingerprint,
    params.duplicateFingerprint,
    params.taxonomyFingerprint,
    params.overrideFingerprint,
    params.catalogFingerprint,
    params.assignmentFingerprint,
  );
  return Object.freeze({
    ...params,
    combinedFingerprint: combined,
  });
}

// ─────────────────────────────────────────────
// Dependency Graph & Invalidation
// ─────────────────────────────────────────────

/**
 * Builds the dependency graph for a set of reconciliation subjects.
 * Each subject depends on:
 * - Its own agent definition
 * - Its duplicate group (if any)
 * - All taxonomy rules that matched its dimensions
 * - All overrides applicable to it
 * - All catalog entries resolved for it
 * - Its current assignment store state
 *
 * Requirement 10.12: When inputs change, recompute every affected bundle.
 */
export function buildDependencyGraph(
  subjects: readonly ReconciliationSubject[],
  taxonomy: SkillTaxonomySnapshot,
  overrides: ReviewedOverrideSnapshot,
  _catalog: AuthoritativeSkillCatalogSnapshot,
  resolvedSkillIdsByAgent: ReadonlyMap<string, readonly string[]>,
): readonly DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const subject of subjects) {
    // Agent definition dependency
    edges.push(Object.freeze({
      subjectAgentId: subject.agentId,
      dependencyKind: 'agent-definition' as const,
      dependencyId: subject.agentId,
    }));

    // Duplicate group dependency
    if (subject.duplicateGroupId) {
      edges.push(Object.freeze({
        subjectAgentId: subject.agentId,
        dependencyKind: 'duplicate-group' as const,
        dependencyId: subject.duplicateGroupId,
      }));
    }

    // Taxonomy rule dependencies (all rules in snapshot could potentially match)
    for (const rule of taxonomy.rules) {
      edges.push(Object.freeze({
        subjectAgentId: subject.agentId,
        dependencyKind: 'taxonomy-rule' as const,
        dependencyId: rule.ruleId,
      }));
    }

    // Override dependencies (all overrides that could apply to this agent)
    for (const override of overrides.overrides) {
      const sel = override.agentSelector;
      const matchesAgent =
        (sel.agentId && sel.agentId === subject.agentId) ||
        (sel.sourcePath && subject.sourcePaths.includes(sel.sourcePath));
      if (matchesAgent) {
        edges.push(Object.freeze({
          subjectAgentId: subject.agentId,
          dependencyKind: 'reviewed-override' as const,
          dependencyId: override.overrideId,
        }));
      }
    }

    // Catalog entry dependencies (resolved skill IDs for this agent)
    const resolvedIds = resolvedSkillIdsByAgent.get(subject.agentId) ?? [];
    for (const skillId of resolvedIds) {
      edges.push(Object.freeze({
        subjectAgentId: subject.agentId,
        dependencyKind: 'catalog-entry' as const,
        dependencyId: skillId,
      }));
    }

    // Assignment store dependency
    edges.push(Object.freeze({
      subjectAgentId: subject.agentId,
      dependencyKind: 'assignment-store' as const,
      dependencyId: subject.agentId,
    }));
  }

  return Object.freeze(edges);
}

/**
 * Given a set of input changes and a dependency graph, determines which
 * subject agent IDs need recomputation.
 *
 * Requirement 10.12: Recompute every AND ONLY affected subjects.
 * A subject is affected if any of its dependency edges match a changed input.
 */
export function findAffectedSubjects(
  changes: readonly InputChange[],
  dependencyGraph: readonly DependencyEdge[],
): readonly string[] {
  const affected = new Set<string>();

  for (const change of changes) {
    for (const edge of dependencyGraph) {
      if (edge.dependencyKind === change.kind && edge.dependencyId === change.id) {
        affected.add(edge.subjectAgentId);
      }
    }
  }

  // Ascending unique sorted output for determinism
  return Object.freeze([...affected].sort());
}

/**
 * Determines whether a subject needs recomputation by comparing its
 * current input fingerprint against its stored state.
 *
 * Requirement 10.11: Unchanged inputs produce no mutations.
 */
export function needsRecomputation(
  currentInputFingerprint: ReconciliationInputFingerprint,
  storedState: StoredBundleState | null,
): boolean {
  if (storedState === null) {
    // Never been reconciled — always needs computation
    return true;
  }
  return currentInputFingerprint.combinedFingerprint !== storedState.inputFingerprint;
}

// ─────────────────────────────────────────────
// No-Op Detection
// ─────────────────────────────────────────────

/**
 * Determines whether a reconciliation would be a no-op: the desired
 * canonical bundle exactly matches the current stored state.
 *
 * No-op condition (Requirement 10.11):
 * - Bundle fingerprint matches stored bundle fingerprint
 * - Skill IDs exactly match stored skill IDs (ascending unique)
 * - Input fingerprint matches stored input fingerprint
 *
 * When all conditions are met, emit no row or event mutation.
 * Requirement 10.10, 10.20: Preserve scorer behavior, produce no side effects.
 */
export function isNoOpReconciliation(
  desiredBundle: CanonicalSkillBundle,
  currentInputFingerprint: ReconciliationInputFingerprint,
  storedState: StoredBundleState | null,
): boolean {
  if (storedState === null) {
    return false;
  }

  // Check fingerprint match
  if (desiredBundle.bundleFingerprint !== storedState.bundleFingerprint) {
    return false;
  }

  // Check input fingerprint match
  if (currentInputFingerprint.combinedFingerprint !== storedState.inputFingerprint) {
    return false;
  }

  // Check skill IDs exactly match (both are canonical ascending unique)
  if (desiredBundle.skillIds.length !== storedState.skillIds.length) {
    return false;
  }
  for (let i = 0; i < desiredBundle.skillIds.length; i++) {
    if (desiredBundle.skillIds[i] !== storedState.skillIds[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Builds a ReconciliationResult for a no-op case.
 * No row or event mutation will be emitted.
 */
export function buildNoOpResult(
  agentId: string,
  bundle: CanonicalSkillBundle,
  inputFingerprint: ReconciliationInputFingerprint,
): ReconciliationResult {
  return Object.freeze({
    agentId,
    bundle,
    inputFingerprint,
    action: 'no-op' as const,
    mutationRequired: false,
  });
}

/**
 * Builds a ReconciliationResult for a recompute case.
 * Row and/or event mutations will be emitted.
 */
export function buildRecomputeResult(
  agentId: string,
  bundle: CanonicalSkillBundle,
  inputFingerprint: ReconciliationInputFingerprint,
): ReconciliationResult {
  return Object.freeze({
    agentId,
    bundle,
    inputFingerprint,
    action: 'recompute' as const,
    mutationRequired: true,
  });
}

/**
 * Builds a ReconciliationResult for a blocked case.
 * No mutation will be emitted, but the subject is in a failed state.
 */
export function buildBlockedResult(
  agentId: string,
  inputFingerprint: ReconciliationInputFingerprint,
): ReconciliationResult {
  return Object.freeze({
    agentId,
    bundle: null,
    inputFingerprint,
    action: 'blocked' as const,
    mutationRequired: false,
  });
}

// ─────────────────────────────────────────────
// Full Reconciliation Orchestration
// ─────────────────────────────────────────────

/**
 * Reconciles a single subject: computes input fingerprint, checks for no-op,
 * and determines whether mutation is required.
 *
 * This is the core reconciliation logic that enforces:
 * - Requirement 10.10: Canonical deterministic output
 * - Requirement 10.11: No mutation on unchanged recomputation
 * - Requirement 10.12: Recompute when inputs change
 * - Requirement 10.20: Does not modify Quality_Scorer behavior
 *
 * @param desiredSkillIds - The desired skill IDs for this subject (will be canonicalized)
 * @param desiredEvidence - The desired evidence (will be canonicalized)
 * @param inputComponents - Individual fingerprint components for inputs
 * @param storedState - Previously stored bundle state (null if first time)
 */
export function reconcileSubject(
  agentId: string,
  desiredSkillIds: readonly string[],
  desiredEvidence: readonly AssignmentEvidence[],
  inputComponents: {
    agentFingerprint: string;
    duplicateFingerprint: string;
    taxonomyFingerprint: string;
    overrideFingerprint: string;
    catalogFingerprint: string;
    assignmentFingerprint: string;
  },
  storedState: StoredBundleState | null,
): ReconciliationResult {
  // Build canonical bundle from desired state
  const bundle = createCanonicalBundle(desiredSkillIds, desiredEvidence);

  // Build complete input fingerprint
  const inputFingerprint = buildInputFingerprint(inputComponents);

  // Check for no-op: unchanged inputs already match desired state
  if (isNoOpReconciliation(bundle, inputFingerprint, storedState)) {
    return buildNoOpResult(agentId, bundle, inputFingerprint);
  }

  // Inputs changed or first computation: recompute required
  return buildRecomputeResult(agentId, bundle, inputFingerprint);
}

/**
 * Reconciles multiple subjects, applying dependency invalidation to determine
 * which subjects need recomputation and which are no-ops.
 *
 * @param subjects - All subjects eligible for reconciliation
 * @param changes - Input changes since last reconciliation (empty for first run)
 * @param dependencyGraph - Pre-built dependency graph
 * @param desiredBundles - Map of agentId -> desired (skillIds, evidence)
 * @param inputFingerprints - Map of agentId -> fingerprint components
 * @param storedStates - Map of agentId -> previously stored state
 */
export function reconcilePopulation(
  subjects: readonly ReconciliationSubject[],
  changes: readonly InputChange[],
  dependencyGraph: readonly DependencyEdge[],
  desiredBundles: ReadonlyMap<string, {
    skillIds: readonly string[];
    evidence: readonly AssignmentEvidence[];
  } | null>,
  inputFingerprints: ReadonlyMap<string, {
    agentFingerprint: string;
    duplicateFingerprint: string;
    taxonomyFingerprint: string;
    overrideFingerprint: string;
    catalogFingerprint: string;
    assignmentFingerprint: string;
  }>,
  storedStates: ReadonlyMap<string, StoredBundleState>,
): readonly ReconciliationResult[] {
  // Determine affected subjects from changes
  const affectedAgentIds = changes.length > 0
    ? new Set(findAffectedSubjects(changes, dependencyGraph))
    : new Set(subjects.map(s => s.agentId)); // First run: all subjects

  const results: ReconciliationResult[] = [];

  for (const subject of subjects) {
    const stored = storedStates.get(subject.agentId) ?? null;
    const desired = desiredBundles.get(subject.agentId);
    const components = inputFingerprints.get(subject.agentId);

    if (!components) {
      // Cannot compute fingerprint: blocked
      const fp = buildInputFingerprint({
        agentFingerprint: 'unknown',
        duplicateFingerprint: 'unknown',
        taxonomyFingerprint: 'unknown',
        overrideFingerprint: 'unknown',
        catalogFingerprint: 'unknown',
        assignmentFingerprint: 'unknown',
      });
      results.push(buildBlockedResult(subject.agentId, fp));
      continue;
    }

    // If not affected by changes and has stored state, check for no-op
    if (!affectedAgentIds.has(subject.agentId) && stored !== null) {
      const inputFp = buildInputFingerprint(components);
      if (inputFp.combinedFingerprint === stored.inputFingerprint) {
        // Not affected and fingerprint matches: definite no-op
        const bundle = desired
          ? createCanonicalBundle(desired.skillIds, desired.evidence)
          : null;
        if (bundle) {
          results.push(buildNoOpResult(subject.agentId, bundle, inputFp));
        } else {
          results.push(buildBlockedResult(subject.agentId, inputFp));
        }
        continue;
      }
    }

    // Subject is affected or has no stored state: reconcile
    if (desired === null || desired === undefined) {
      const fp = buildInputFingerprint(components);
      results.push(buildBlockedResult(subject.agentId, fp));
      continue;
    }

    const result = reconcileSubject(
      subject.agentId,
      desired.skillIds,
      desired.evidence,
      components,
      stored,
    );
    results.push(result);
  }

  return Object.freeze(results);
}

// ─────────────────────────────────────────────
// Internal: Canonical Evidence Comparator
// ─────────────────────────────────────────────

/**
 * Canonical evidence comparator for deterministic ordering.
 * Matches the ordering defined in assignment-evidence.ts but is
 * self-contained for this module's independence.
 *
 * Order: skillId → capabilityKey → source.kind → source identifier
 */
function compareEvidenceCanonical(
  a: AssignmentEvidence,
  b: AssignmentEvidence,
): number {
  // 1. skillId ascending
  const skillCmp = a.skillId.localeCompare(b.skillId);
  if (skillCmp !== 0) return skillCmp;

  // 2. capabilityKey ascending
  const capCmp = a.capabilityKey.localeCompare(b.capabilityKey);
  if (capCmp !== 0) return capCmp;

  // 3. source.kind ascending
  const kindCmp = a.source.kind.localeCompare(b.source.kind);
  if (kindCmp !== 0) return kindCmp;

  // 4. source identifier ascending
  const aId = a.source.kind === 'taxonomy'
    ? a.source.ruleId
    : a.source.overrideId;
  const bId = b.source.kind === 'taxonomy'
    ? b.source.ruleId
    : b.source.overrideId;
  return aId.localeCompare(bId);
}
