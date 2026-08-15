/**
 * Bundle Selection Service
 *
 * Derives five-dimensional capabilities from task context (linked requirements,
 * design, Task acceptance criteria, Repository_Map impact, risk, tools, and
 * deliverables), resolves against the existing versioned five-dimensional taxonomy
 * and one immutable authoritative catalog snapshot, combines compatible existing,
 * generated, and imported skills into a complete minimal sufficient
 * Runtime_Skill_Bundle with a declared deterministic tie-break, and persists
 * candidate coverage and exclusion explanations for review.
 *
 * Requirements: 50.1, 50.2, 50.3
 */

import { createHash } from 'node:crypto';
import type {
  SkillTaxonomySnapshot,
  TaxonomyInput,
  TaxonomyResolutionResult,
  TaxonomyDimension,
} from './skill-taxonomy.js';
import {
  resolveTaxonomy,
  normalizeText,
} from './skill-taxonomy.js';
import type {
  AuthoritativeSkillCatalogSnapshot,
  SkillCatalogEntry,
} from './agent-skills-service.js';

// ─── Input Types ─────────────────────────────────────────────────

/**
 * Context from which five-dimensional capabilities are derived.
 * Gathers information from linked requirements, design, task acceptance
 * criteria, Repository_Map impact, risk, tools, and deliverables.
 */
export interface TaskCapabilityContext {
  /** Task identifier for fingerprint binding */
  readonly taskId: string;
  /** Linked requirement descriptions */
  readonly requirements: readonly string[];
  /** Linked design node descriptions */
  readonly designNodes: readonly string[];
  /** Task acceptance criteria */
  readonly acceptanceCriteria: readonly string[];
  /** Repository_Map impact analysis results */
  readonly repositoryMapImpact: readonly RepositoryImpactItem[];
  /** Identified risk factors */
  readonly risks: readonly string[];
  /** Required tools from task definition */
  readonly requiredTools: readonly string[];
  /** Expected deliverables */
  readonly deliverables: readonly string[];
}

/**
 * A single file/symbol impact from the Repository_Map.
 */
export interface RepositoryImpactItem {
  /** File or symbol path */
  readonly path: string;
  /** Language or technology detected */
  readonly language: string;
  /** Impact kind */
  readonly kind: 'file' | 'symbol' | 'dependency' | 'configuration' | 'test';
}

// ─── Derived Capabilities ────────────────────────────────────────

/**
 * The five dimensions from the existing taxonomy.
 */
export type CapabilityDimension =
  | 'capability'
  | 'technology'
  | 'deliverable'
  | 'workflow_pattern'
  | 'domain_context';

/**
 * A single derived capability across the five dimensions.
 */
export interface DerivedCapability {
  /** Normalized capability key */
  readonly key: string;
  /** Which dimension this belongs to */
  readonly dimension: CapabilityDimension;
  /** Raw source text from which it was derived */
  readonly source: string;
  /** Where in the task context it was derived from */
  readonly derivedFrom: CapabilityDerivationSource;
}

export type CapabilityDerivationSource =
  | 'requirement'
  | 'design_node'
  | 'acceptance_criteria'
  | 'repository_map'
  | 'risk'
  | 'tool'
  | 'deliverable';

// ─── Bundle Selection Types ──────────────────────────────────────

/**
 * A candidate skill considered for bundle inclusion.
 */
export interface BundleCandidate {
  /** Skill ID from catalog */
  readonly skillId: string;
  /** Skill name */
  readonly name: string;
  /** Capabilities this skill covers */
  readonly coveredCapabilities: readonly string[];
  /** Number of uncovered capabilities this would address */
  readonly coverageGain: number;
  /** Permission/dependency count (lower is better) */
  readonly permissionWeight: number;
  /** Evaluation/quality tier (higher is better) */
  readonly qualityTier: number;
  /** Context/cost budget estimate (lower is better) */
  readonly costBudget: number;
  /** Whether the skill is from safety/compatibility required category */
  readonly safetyRequired: boolean;
  /** Whether this skill has an explicit approved assignment */
  readonly explicitlyAssigned: boolean;
  /** Skill version */
  readonly version: string;
}

/**
 * Reason why a skill was excluded from the bundle.
 */
export interface ExclusionExplanation {
  /** Skill ID that was excluded */
  readonly skillId: string;
  /** Skill name */
  readonly name: string;
  /** Why it was excluded */
  readonly reason: ExclusionReason;
  /** Human-readable explanation */
  readonly explanation: string;
}

export type ExclusionReason =
  | 'not_needed'
  | 'subset_of_selected'
  | 'incompatible'
  | 'disabled'
  | 'uninstalled'
  | 'lower_priority'
  | 'higher_cost'
  | 'fewer_capabilities'
  | 'deterministic_tiebreak';

/**
 * The result of bundle selection: either a resolved minimal bundle
 * or a blocked status requiring manual resolution.
 */
export type BundleSelectionResult =
  | BundleSelectionSuccess
  | BundleSelectionBlocked;

export interface BundleSelectionSuccess {
  readonly status: 'resolved';
  /** The selected minimal sufficient bundle (sorted by skill ID) */
  readonly bundle: readonly BundleCandidate[];
  /** All derived capabilities */
  readonly derivedCapabilities: readonly DerivedCapability[];
  /** Coverage mapping: capability key → covering skill IDs */
  readonly coverageMap: ReadonlyMap<string, readonly string[]>;
  /** Explanations for why other skills were excluded */
  readonly exclusions: readonly ExclusionExplanation[];
  /** Bundle fingerprint */
  readonly bundleFingerprint: string;
  /** Catalog fingerprint at resolution time */
  readonly catalogFingerprint: string;
  /** Task fingerprint */
  readonly taskFingerprint: string;
  /** Taxonomy version used */
  readonly taxonomyVersion: number;
}

export interface BundleSelectionBlocked {
  readonly status: 'blocked';
  /** The reason dispatch is blocked */
  readonly blockReason: BundleBlockReason;
  /** Human-readable explanation */
  readonly explanation: string;
  /** Capabilities that remain uncovered */
  readonly uncoveredCapabilities: readonly string[];
  /** Equivalent candidates that could not be deterministically resolved */
  readonly ambiguousCandidates: readonly BundleCandidate[];
}

export type BundleBlockReason =
  | 'uncovered_capabilities'
  | 'ambiguous_tiebreak'
  | 'no_capabilities_derived'
  | 'catalog_empty';

// ─── Persistence Types ───────────────────────────────────────────

/**
 * Record persisted for review of bundle selection decisions.
 */
export interface BundleSelectionRecord {
  /** Unique record ID */
  readonly recordId: string;
  /** Task ID */
  readonly taskId: string;
  /** Derived capabilities */
  readonly derivedCapabilities: readonly DerivedCapability[];
  /** Selected bundle skill IDs */
  readonly selectedSkillIds: readonly string[];
  /** Coverage map serialized */
  readonly coverageMap: Record<string, readonly string[]>;
  /** Exclusion explanations */
  readonly exclusions: readonly ExclusionExplanation[];
  /** Bundle fingerprint */
  readonly bundleFingerprint: string;
  /** Catalog fingerprint */
  readonly catalogFingerprint: string;
  /** Task fingerprint */
  readonly taskFingerprint: string;
  /** Taxonomy version */
  readonly taxonomyVersion: number;
  /** Timestamp */
  readonly createdAt: number;
}

/**
 * Persistence interface for bundle selection records.
 */
export interface BundleSelectionPersistence {
  saveRecord(record: BundleSelectionRecord): void;
  getRecordByTask(taskId: string): BundleSelectionRecord | null;
}

// ─── Explicit Assignment Provider ────────────────────────────────

/**
 * Provider for explicit approved assignments and safety requirements.
 */
export interface AssignmentProvider {
  /** Get explicitly approved skill assignments for a task */
  getExplicitAssignments(taskId: string): readonly string[];
  /** Get safety/compatibility required skill IDs */
  getSafetyRequiredSkills(): readonly string[];
}

// ─── Bundle Selection Service ────────────────────────────────────

/**
 * BundleSelectionService implements the RuntimeCapabilityResolver logic:
 *
 * 1. Derives required capabilities from task context across 5 dimensions
 * 2. Resolves against one immutable taxonomy snapshot and one catalog snapshot
 * 3. Selects the minimal sufficient bundle using deterministic tie-break
 * 4. Persists coverage and exclusion explanations
 *
 * The deterministic tie-break order (from design doc §20):
 * 1. Required safety/compatibility
 * 2. Explicit approved assignment
 * 3. Greatest uncovered-capability coverage
 * 4. Fewer permissions and dependencies
 * 5. Higher passing evaluation/quality tier
 * 6. Lower context/cost budget
 * 7. Canonical skill ID and version (lexicographic)
 *
 * If equivalent candidates remain after the declared ordering or any
 * capability is uncovered, dispatch is blocked for manual resolution.
 */
export class BundleSelectionService {
  constructor(
    private readonly persistence: BundleSelectionPersistence,
    private readonly assignmentProvider: AssignmentProvider,
  ) {}

  /**
   * Derive five-dimensional capabilities from task context and select
   * the minimal sufficient bundle.
   *
   * @param context - Task capability context with all linked information
   * @param taxonomySnapshot - The versioned taxonomy snapshot to resolve against
   * @param catalogSnapshot - The immutable authoritative catalog snapshot
   * @returns A resolved bundle or a blocked status
   */
  selectBundle(
    context: TaskCapabilityContext,
    taxonomySnapshot: SkillTaxonomySnapshot,
    catalogSnapshot: AuthoritativeSkillCatalogSnapshot,
  ): BundleSelectionResult {
    // Step 1: Derive capabilities from all context sources
    const derivedCapabilities = this.deriveCapabilities(context);

    if (derivedCapabilities.length === 0) {
      return {
        status: 'blocked',
        blockReason: 'no_capabilities_derived',
        explanation: 'No capabilities could be derived from the task context. The task may need more detailed requirements, acceptance criteria, or deliverables.',
        uncoveredCapabilities: [],
        ambiguousCandidates: [],
      };
    }

    // Step 2: Resolve capabilities through taxonomy against catalog
    const requiredCapabilityKeys = this.deduplicateCapabilityKeys(derivedCapabilities);

    if (catalogSnapshot.entries.length === 0) {
      return {
        status: 'blocked',
        blockReason: 'catalog_empty',
        explanation: 'The authoritative catalog snapshot contains no entries. Skills must be published before bundle selection can proceed.',
        uncoveredCapabilities: [...requiredCapabilityKeys],
        ambiguousCandidates: [],
      };
    }

    // Step 3: Build candidates from catalog entries
    const candidates = this.buildCandidates(
      requiredCapabilityKeys,
      catalogSnapshot,
      context.taskId,
    );

    // Step 4: Select minimal sufficient bundle using greedy set-cover
    // with deterministic tie-break
    const selectionResult = this.selectMinimalBundle(
      requiredCapabilityKeys,
      candidates,
    );

    if (selectionResult.status === 'blocked') {
      return selectionResult;
    }

    // Step 5: Compute fingerprints and build coverage map
    const coverageMap = this.buildCoverageMap(
      selectionResult.bundle,
      requiredCapabilityKeys,
    );
    const taskFingerprint = this.computeTaskFingerprint(context);
    const bundleFingerprint = this.computeBundleFingerprint(selectionResult.bundle);

    // Step 6: Build exclusion explanations
    const exclusions = this.buildExclusions(
      candidates,
      selectionResult.bundle,
      requiredCapabilityKeys,
    );

    // Step 7: Persist the record
    const record: BundleSelectionRecord = {
      recordId: generateId(),
      taskId: context.taskId,
      derivedCapabilities,
      selectedSkillIds: selectionResult.bundle.map(c => c.skillId).sort(),
      coverageMap: Object.fromEntries(coverageMap),
      exclusions,
      bundleFingerprint,
      catalogFingerprint: catalogSnapshot.fingerprint,
      taskFingerprint,
      taxonomyVersion: taxonomySnapshot.version,
      createdAt: Date.now(),
    };
    this.persistence.saveRecord(record);

    return {
      status: 'resolved',
      bundle: selectionResult.bundle,
      derivedCapabilities,
      coverageMap,
      exclusions,
      bundleFingerprint,
      catalogFingerprint: catalogSnapshot.fingerprint,
      taskFingerprint,
      taxonomyVersion: taxonomySnapshot.version,
    };
  }

  /**
   * Derive capabilities across all five dimensions from task context.
   *
   * Requirement 50.1: Derive required capabilities from linked requirements,
   * design, Task acceptance criteria, Repository_Map impact, risk, tools,
   * and deliverables.
   */
  deriveCapabilities(context: TaskCapabilityContext): DerivedCapability[] {
    const capabilities: DerivedCapability[] = [];

    // From requirements → capability dimension
    for (const req of context.requirements) {
      const key = normalizeCapabilityKey(req);
      if (key) {
        capabilities.push({
          key,
          dimension: 'capability',
          source: req,
          derivedFrom: 'requirement',
        });
      }
    }

    // From design nodes → capability + workflow_pattern
    for (const design of context.designNodes) {
      const key = normalizeCapabilityKey(design);
      if (key) {
        capabilities.push({
          key,
          dimension: 'capability',
          source: design,
          derivedFrom: 'design_node',
        });
      }
      // Check for workflow patterns in design nodes
      const pattern = extractWorkflowPattern(design);
      if (pattern) {
        capabilities.push({
          key: pattern,
          dimension: 'workflow_pattern',
          source: design,
          derivedFrom: 'design_node',
        });
      }
    }

    // From acceptance criteria → capability
    for (const criteria of context.acceptanceCriteria) {
      const key = normalizeCapabilityKey(criteria);
      if (key) {
        capabilities.push({
          key,
          dimension: 'capability',
          source: criteria,
          derivedFrom: 'acceptance_criteria',
        });
      }
    }

    // From Repository_Map impact → technology dimension
    for (const impact of context.repositoryMapImpact) {
      if (impact.language) {
        const key = normalizeCapabilityKey(impact.language);
        if (key) {
          capabilities.push({
            key,
            dimension: 'technology',
            source: impact.language,
            derivedFrom: 'repository_map',
          });
        }
      }
    }

    // From risks → domain_context
    for (const risk of context.risks) {
      const key = normalizeCapabilityKey(risk);
      if (key) {
        capabilities.push({
          key,
          dimension: 'domain_context',
          source: risk,
          derivedFrom: 'risk',
        });
      }
    }

    // From required tools → technology dimension
    for (const tool of context.requiredTools) {
      const key = normalizeCapabilityKey(tool);
      if (key) {
        capabilities.push({
          key,
          dimension: 'technology',
          source: tool,
          derivedFrom: 'tool',
        });
      }
    }

    // From deliverables → deliverable dimension
    for (const deliverable of context.deliverables) {
      const key = normalizeCapabilityKey(deliverable);
      if (key) {
        capabilities.push({
          key,
          dimension: 'deliverable',
          source: deliverable,
          derivedFrom: 'deliverable',
        });
      }
    }

    return capabilities;
  }

  /**
   * Deduplicate capability keys from derived capabilities.
   */
  private deduplicateCapabilityKeys(capabilities: readonly DerivedCapability[]): string[] {
    const seen = new Set<string>();
    for (const cap of capabilities) {
      seen.add(cap.key);
    }
    return [...seen].sort();
  }

  /**
   * Build BundleCandidates from catalog entries that might cover
   * required capabilities.
   *
   * Requirement 50.2: Resolve through the versioned five-dimensional taxonomy
   * against one immutable authoritative catalog snapshot.
   */
  private buildCandidates(
    requiredKeys: readonly string[],
    catalog: AuthoritativeSkillCatalogSnapshot,
    taskId: string,
  ): BundleCandidate[] {
    const explicitAssignments = new Set(
      this.assignmentProvider.getExplicitAssignments(taskId)
    );
    const safetyRequired = new Set(
      this.assignmentProvider.getSafetyRequiredSkills()
    );
    const requiredKeySet = new Set(requiredKeys);

    const candidates: BundleCandidate[] = [];

    for (const entry of catalog.entries) {
      // Only consider enabled and installed skills
      if (!entry.enabled || !entry.installed) continue;

      // Determine which required capabilities this skill covers
      const coveredCapabilities = this.computeCoveredCapabilities(
        entry,
        requiredKeySet,
      );

      // Skip skills that cover nothing we need
      if (coveredCapabilities.length === 0 && !safetyRequired.has(entry.skillId) && !explicitAssignments.has(entry.skillId)) {
        continue;
      }

      // Compute permission weight from metadata (lower is better)
      const permissionWeight = this.computePermissionWeight(entry);

      // Compute quality tier (higher is better)
      const qualityTier = this.computeQualityTier(entry);

      // Compute cost budget (lower is better)
      const costBudget = this.computeCostBudget(entry);

      candidates.push({
        skillId: entry.skillId,
        name: entry.name,
        coveredCapabilities,
        coverageGain: coveredCapabilities.length,
        permissionWeight,
        qualityTier,
        costBudget,
        safetyRequired: safetyRequired.has(entry.skillId),
        explicitlyAssigned: explicitAssignments.has(entry.skillId),
        version: entry.version,
      });
    }

    return candidates;
  }

  /**
   * Determine which required capabilities a catalog entry covers.
   * Uses normalized key matching against capability, technology, and deliverable keys.
   */
  private computeCoveredCapabilities(
    entry: SkillCatalogEntry,
    requiredKeys: ReadonlySet<string>,
  ): string[] {
    const covered: string[] = [];

    // Check each required capability against the entry's keys
    for (const reqKey of requiredKeys) {
      const normalizedReq = reqKey.toLowerCase();

      // Direct match in capabilityKeys
      const hasCapabilityMatch = entry.capabilityKeys.some(
        k => k.toLowerCase() === normalizedReq || normalizedReq.includes(k.toLowerCase()) || k.toLowerCase().includes(normalizedReq)
      );

      // Match in technologyKeys
      const hasTechMatch = entry.technologyKeys.some(
        k => k.toLowerCase() === normalizedReq || normalizedReq.includes(k.toLowerCase()) || k.toLowerCase().includes(normalizedReq)
      );

      // Match in deliverableKeys
      const hasDeliverableMatch = entry.deliverableKeys.some(
        k => k.toLowerCase() === normalizedReq || normalizedReq.includes(k.toLowerCase()) || k.toLowerCase().includes(normalizedReq)
      );

      if (hasCapabilityMatch || hasTechMatch || hasDeliverableMatch) {
        covered.push(reqKey);
      }
    }

    return covered;
  }

  /**
   * Compute permission weight for tie-breaking. Lower means fewer permissions.
   */
  private computePermissionWeight(entry: SkillCatalogEntry): number {
    // Use tag count and metadata size as proxy for permission/dependency weight
    return entry.capabilityKeys.length + entry.technologyKeys.length + entry.deliverableKeys.length;
  }

  /**
   * Compute quality tier for tie-breaking. Higher means better quality.
   */
  private computeQualityTier(entry: SkillCatalogEntry): number {
    // Default tier: 50 (middle). Could be extended with evaluation data.
    return 50;
  }

  /**
   * Compute cost budget for tie-breaking. Lower means cheaper.
   */
  private computeCostBudget(entry: SkillCatalogEntry): number {
    // Default budget estimate based on description length (proxy for complexity)
    return Math.min(100, Math.max(1, Math.ceil(entry.description.length / 100)));
  }

  /**
   * Select the minimal sufficient bundle using a greedy set-cover algorithm
   * with the declared deterministic tie-break ordering.
   *
   * Requirement 50.3: Combine compatible existing, generated, and imported
   * skills into a complete bundle with no sufficient proper subset and a
   * declared deterministic tie-break.
   *
   * Tie-break order:
   * 1. Required safety/compatibility
   * 2. Explicit approved assignment
   * 3. Greatest uncovered-capability coverage
   * 4. Fewer permissions and dependencies
   * 5. Higher passing evaluation/quality tier
   * 6. Lower context/cost budget
   * 7. Canonical skill ID and version (lexicographic)
   */
  private selectMinimalBundle(
    requiredKeys: readonly string[],
    candidates: readonly BundleCandidate[],
  ): BundleSelectionSuccess | BundleSelectionBlocked {
    const selected: BundleCandidate[] = [];
    const coveredKeys = new Set<string>();
    const requiredKeySet = new Set(requiredKeys);

    // Phase 1: Include safety-required skills first
    const safetyCandidates = candidates.filter(c => c.safetyRequired);
    for (const candidate of this.sortByTieBreak(safetyCandidates, coveredKeys, requiredKeySet)) {
      selected.push(candidate);
      for (const key of candidate.coveredCapabilities) {
        coveredKeys.add(key);
      }
    }

    // Phase 2: Include explicitly assigned skills
    const explicitCandidates = candidates.filter(c => c.explicitlyAssigned && !c.safetyRequired);
    for (const candidate of this.sortByTieBreak(explicitCandidates, coveredKeys, requiredKeySet)) {
      if (!selected.some(s => s.skillId === candidate.skillId)) {
        selected.push(candidate);
        for (const key of candidate.coveredCapabilities) {
          coveredKeys.add(key);
        }
      }
    }

    // Phase 3: Greedy set-cover for remaining uncovered capabilities
    const remainingCandidates = candidates.filter(
      c => !c.safetyRequired && !c.explicitlyAssigned
    );

    while (coveredKeys.size < requiredKeySet.size) {
      // Compute coverage gain for each remaining candidate
      const withGain = remainingCandidates
        .filter(c => !selected.some(s => s.skillId === c.skillId))
        .map(c => ({
          ...c,
          coverageGain: c.coveredCapabilities.filter(k => !coveredKeys.has(k)).length,
        }))
        .filter(c => c.coverageGain > 0);

      if (withGain.length === 0) {
        // No more candidates can cover remaining capabilities
        const uncovered = [...requiredKeySet].filter(k => !coveredKeys.has(k));
        return {
          status: 'blocked',
          blockReason: 'uncovered_capabilities',
          explanation: `${uncovered.length} required capability(ies) cannot be covered by any available skill: ${uncovered.join(', ')}`,
          uncoveredCapabilities: uncovered,
          ambiguousCandidates: [],
        };
      }

      // Sort by deterministic tie-break
      const sorted = this.sortByTieBreak(withGain, coveredKeys, requiredKeySet);

      // Check for ambiguous tie at position 0
      if (sorted.length >= 2) {
        const first = sorted[0]!;
        const second = sorted[1]!;
        if (this.compareCandidates(first, second, coveredKeys, requiredKeySet) === 0) {
          // Ambiguous tie — block dispatch
          return {
            status: 'blocked',
            blockReason: 'ambiguous_tiebreak',
            explanation: `Deterministic tie-break could not resolve between skills "${first.name}" (${first.skillId}) and "${second.name}" (${second.skillId}). Manual resolution required.`,
            uncoveredCapabilities: [...requiredKeySet].filter(k => !coveredKeys.has(k)),
            ambiguousCandidates: [first, second],
          };
        }
      }

      // Select the best candidate
      const best = sorted[0]!;
      selected.push(best);
      for (const key of best.coveredCapabilities) {
        coveredKeys.add(key);
      }
    }

    // Phase 4: Verify minimality — try removing each non-safety, non-explicit skill
    const minimal = this.ensureMinimal(selected, requiredKeySet);

    // Sort by skill ID for deterministic output
    minimal.sort((a, b) => a.skillId.localeCompare(b.skillId));

    return {
      status: 'resolved',
      bundle: minimal,
      derivedCapabilities: [],
      coverageMap: new Map(),
      exclusions: [],
      bundleFingerprint: '',
      catalogFingerprint: '',
      taskFingerprint: '',
      taxonomyVersion: 0,
    };
  }

  /**
   * Sort candidates by the deterministic tie-break ordering.
   */
  private sortByTieBreak(
    candidates: readonly BundleCandidate[],
    coveredKeys: ReadonlySet<string>,
    requiredKeys: ReadonlySet<string>,
  ): BundleCandidate[] {
    return [...candidates].sort((a, b) =>
      this.compareCandidates(a, b, coveredKeys, requiredKeys)
    );
  }

  /**
   * Compare two candidates using the full deterministic tie-break.
   * Returns negative if a should come first, positive if b should come first,
   * zero if they are equivalent (ambiguous).
   *
   * Order:
   * 1. Safety/compatibility required (true before false)
   * 2. Explicit approved assignment (true before false)
   * 3. Greatest uncovered-capability coverage (more before fewer)
   * 4. Fewer permissions and dependencies (lower before higher)
   * 5. Higher passing evaluation/quality tier (higher before lower)
   * 6. Lower context/cost budget (lower before higher)
   * 7. Canonical skill ID and version (lexicographic ascending)
   */
  compareCandidates(
    a: BundleCandidate,
    b: BundleCandidate,
    coveredKeys: ReadonlySet<string>,
    requiredKeys: ReadonlySet<string>,
  ): number {
    // 1. Safety/compatibility required
    if (a.safetyRequired !== b.safetyRequired) {
      return a.safetyRequired ? -1 : 1;
    }

    // 2. Explicit approved assignment
    if (a.explicitlyAssigned !== b.explicitlyAssigned) {
      return a.explicitlyAssigned ? -1 : 1;
    }

    // 3. Greatest uncovered-capability coverage
    const aGain = a.coveredCapabilities.filter(k => !coveredKeys.has(k)).length;
    const bGain = b.coveredCapabilities.filter(k => !coveredKeys.has(k)).length;
    if (aGain !== bGain) {
      return bGain - aGain; // More gain comes first
    }

    // 4. Fewer permissions and dependencies
    if (a.permissionWeight !== b.permissionWeight) {
      return a.permissionWeight - b.permissionWeight; // Lower comes first
    }

    // 5. Higher passing evaluation/quality tier
    if (a.qualityTier !== b.qualityTier) {
      return b.qualityTier - a.qualityTier; // Higher comes first
    }

    // 6. Lower context/cost budget
    if (a.costBudget !== b.costBudget) {
      return a.costBudget - b.costBudget; // Lower comes first
    }

    // 7. Canonical skill ID and version (lexicographic)
    const idCmp = a.skillId.localeCompare(b.skillId);
    if (idCmp !== 0) return idCmp;

    return a.version.localeCompare(b.version);
  }

  /**
   * Ensure the selected bundle is minimal — no proper subset covers all
   * required capabilities.
   */
  private ensureMinimal(
    selected: BundleCandidate[],
    requiredKeys: ReadonlySet<string>,
  ): BundleCandidate[] {
    // Try removing each non-safety, non-explicit skill and check if coverage holds
    const result = [...selected];

    for (let i = result.length - 1; i >= 0; i--) {
      const candidate = result[i]!;
      // Never remove safety or explicitly assigned skills
      if (candidate.safetyRequired || candidate.explicitlyAssigned) continue;

      // Check if removing this candidate still covers everything
      const remaining = result.filter((_, idx) => idx !== i);
      const coveredWithout = new Set<string>();
      for (const r of remaining) {
        for (const k of r.coveredCapabilities) {
          coveredWithout.add(k);
        }
      }

      // Check if all required keys are still covered
      let allCovered = true;
      for (const key of requiredKeys) {
        if (!coveredWithout.has(key)) {
          allCovered = false;
          break;
        }
      }

      if (allCovered) {
        result.splice(i, 1);
      }
    }

    return result;
  }

  /**
   * Build the coverage map: capability key → skill IDs that cover it.
   */
  private buildCoverageMap(
    bundle: readonly BundleCandidate[],
    requiredKeys: readonly string[],
  ): Map<string, readonly string[]> {
    const map = new Map<string, string[]>();

    for (const key of requiredKeys) {
      map.set(key, []);
    }

    for (const candidate of bundle) {
      for (const key of candidate.coveredCapabilities) {
        const existing = map.get(key);
        if (existing) {
          existing.push(candidate.skillId);
        }
      }
    }

    // Freeze the arrays
    const result = new Map<string, readonly string[]>();
    for (const [key, ids] of map) {
      result.set(key, Object.freeze([...ids].sort()));
    }

    return result;
  }

  /**
   * Build exclusion explanations for candidates not selected.
   */
  private buildExclusions(
    allCandidates: readonly BundleCandidate[],
    selected: readonly BundleCandidate[],
    requiredKeys: readonly string[],
  ): ExclusionExplanation[] {
    const selectedIds = new Set(selected.map(s => s.skillId));
    const exclusions: ExclusionExplanation[] = [];

    for (const candidate of allCandidates) {
      if (selectedIds.has(candidate.skillId)) continue;

      const reason = this.determineExclusionReason(candidate, selected, requiredKeys);
      exclusions.push({
        skillId: candidate.skillId,
        name: candidate.name,
        reason: reason.reason,
        explanation: reason.explanation,
      });
    }

    return exclusions;
  }

  /**
   * Determine the reason a candidate was excluded.
   */
  private determineExclusionReason(
    candidate: BundleCandidate,
    selected: readonly BundleCandidate[],
    requiredKeys: readonly string[],
  ): { reason: ExclusionReason; explanation: string } {
    // Check if all of its capabilities are already covered by selected skills
    const selectedCoverage = new Set<string>();
    for (const s of selected) {
      for (const k of s.coveredCapabilities) {
        selectedCoverage.add(k);
      }
    }

    const uniqueContribution = candidate.coveredCapabilities.filter(
      k => !selectedCoverage.has(k)
    );

    if (candidate.coveredCapabilities.length === 0) {
      return {
        reason: 'not_needed',
        explanation: `Skill "${candidate.name}" does not cover any required capability.`,
      };
    }

    if (uniqueContribution.length === 0) {
      // All of its capabilities are covered by selected — it's a subset
      return {
        reason: 'subset_of_selected',
        explanation: `All capabilities covered by "${candidate.name}" are already provided by the selected bundle.`,
      };
    }

    // It has unique capabilities but was not selected — deterministic tiebreak
    return {
      reason: 'deterministic_tiebreak',
      explanation: `Skill "${candidate.name}" was not selected due to deterministic tie-break ordering (coverage gain, permissions, quality, cost, or ID precedence).`,
    };
  }

  /**
   * Compute a fingerprint for the task context.
   */
  private computeTaskFingerprint(context: TaskCapabilityContext): string {
    const hash = createHash('sha256');
    hash.update(`task:${context.taskId}\n`);
    hash.update(`reqs:${context.requirements.join('|')}\n`);
    hash.update(`design:${context.designNodes.join('|')}\n`);
    hash.update(`criteria:${context.acceptanceCriteria.join('|')}\n`);
    hash.update(`impact:${context.repositoryMapImpact.map(i => `${i.path}:${i.language}`).join('|')}\n`);
    hash.update(`risks:${context.risks.join('|')}\n`);
    hash.update(`tools:${context.requiredTools.join('|')}\n`);
    hash.update(`deliverables:${context.deliverables.join('|')}\n`);
    return `task-${hash.digest('hex').slice(0, 32)}`;
  }

  /**
   * Compute a fingerprint for the selected bundle.
   */
  private computeBundleFingerprint(bundle: readonly BundleCandidate[]): string {
    const hash = createHash('sha256');
    hash.update('bundle:');
    const sorted = [...bundle].sort((a, b) => a.skillId.localeCompare(b.skillId));
    for (const candidate of sorted) {
      hash.update(`${candidate.skillId}@${candidate.version}\n`);
    }
    return `bundle-${hash.digest('hex').slice(0, 32)}`;
  }
}

// ─── Helper Functions ────────────────────────────────────────────

/**
 * Normalize a capability key for consistent matching.
 * Returns empty string for empty/whitespace-only input.
 */
export function normalizeCapabilityKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract workflow pattern from design node text.
 */
function extractWorkflowPattern(text: string): string | null {
  const patterns = [
    'pipeline',
    'fan-out',
    'fan-in',
    'expert-pool',
    'producer-reviewer',
    'supervisor',
    'hierarchical-delegation',
  ];

  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Generate a unique identifier.
 */
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `bsr-${timestamp}-${random}`;
}
