/**
 * Prompt Manifest Assembler
 *
 * Orders prompt content deterministically, enforces category budgets,
 * records omissions, and injects bodies/assets only from validated bundles
 * under active triggers or Level 3 validated need.
 *
 * Requirements: 51.1, 51.2, 51.3, 51.5
 *
 * Design component: PromptAssembler (Section 14 of design.md)
 */

import type {
  SkillMetadataEntry,
  LoadedBody,
  LoadedAsset,
  DisclosureState,
  ProgressiveDisclosurePlanner,
} from './progressive-disclosure.js';
import type { DisclosureUIStateService, DisclosureEvidence } from './disclosure-ui-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Categories for prompt content ordering. */
export type PromptCategory =
  | 'task_constraints'
  | 'safety'
  | 'dependencies'
  | 'pins'
  | 'priority'
  | 'standard';

/** A single entry in the assembled prompt manifest. */
export interface PromptManifestEntry {
  /** Position in the final prompt (0-indexed) */
  position: number;
  /** The skill this entry belongs to */
  skillId: string;
  /** The category determining ordering precedence */
  category: PromptCategory;
  /** Content type: body or asset */
  contentType: 'body' | 'reference' | 'script';
  /** Tokens allocated to this entry */
  tokens: number;
  /** Content fingerprint (no source text in manifest) */
  contentFingerprint: string;
  /** Provenance information */
  provenance: string;
  /** Version of the skill */
  version: string;
  /** Asset ID for Level 3 content */
  assetId?: string;
}

/** Record of an omission (content that was left out). */
export interface OmissionRecord {
  skillId: string;
  contentType: 'body' | 'reference' | 'script';
  assetId?: string;
  reason: OmissionReason;
  tokens: number;
  category: PromptCategory;
  /** Timestamp of the omission */
  omittedAt: number;
}

/** Reasons for omitting content. */
export type OmissionReason =
  | 'budget_exceeded'
  | 'category_budget_exceeded'
  | 'excluded'
  | 'no_active_trigger'
  | 'level3_not_validated'
  | 'conflict_unresolved'
  | 'fail_closed'
  | 'lower_priority';

/** Token budget configuration by category. */
export interface CategoryBudgets {
  task_constraints: number;
  safety: number;
  dependencies: number;
  pins: number;
  priority: number;
  standard: number;
}

/** Configuration for the prompt assembler. */
export interface PromptAssemblerConfig {
  /** Total token budget for the assembled prompt */
  totalTokenBudget: number;
  /** Per-category token budgets */
  categoryBudgets: CategoryBudgets;
  /** Reserve tokens for the response */
  responseReserve: number;
}

/** The fully assembled prompt manifest. */
export interface AssembledPromptManifest {
  /** Ordered entries in the manifest */
  entries: PromptManifestEntry[];
  /** Records of omitted content */
  omissions: OmissionRecord[];
  /** Total tokens used */
  totalTokens: number;
  /** Tokens by category */
  tokensByCategory: Record<PromptCategory, number>;
  /** Assembly timestamp */
  assembledAt: number;
  /** Run ID this manifest belongs to */
  runId: string;
  /** Step ID this manifest belongs to */
  stepId: string;
}

/** A validated skill from the runtime bundle that is eligible for injection. */
export interface ValidatedBundleSkill {
  skillId: string;
  version: string;
  /** The category this skill belongs to in the prompt ordering. */
  category: PromptCategory;
  /** Whether this skill has an active trigger or assignment. */
  hasActiveTrigger: boolean;
  /** Whether this skill's body has been validated for Level 3. */
  level3Validated: boolean;
  /** Explicit dependency order (lower = earlier). */
  dependencyOrder: number;
  /** Whether this skill relates to safety (safety precedence). */
  isSafety: boolean;
  /** Whether this skill is a task constraint. */
  isTaskConstraint: boolean;
}

// ---------------------------------------------------------------------------
// Prompt Manifest Assembler
// ---------------------------------------------------------------------------

export class PromptManifestAssembler {
  private config: PromptAssemblerConfig;
  private currentRunId = '';
  private currentStepId = '';

  constructor(config: PromptAssemblerConfig) {
    this.config = config;
  }

  /**
   * Assemble the prompt manifest from the current disclosure state.
   *
   * Orders content deterministically by:
   * 1. Task constraints (highest precedence)
   * 2. Safety
   * 3. Dependencies
   * 4. Pins (explicit user pinning)
   * 5. Priority (skill priority value)
   * 6. Standard (canonical ID and version)
   *
   * Requirement 51.1: Inject Skill_Body only from validated bundle on active trigger/assignment.
   * Requirement 51.2: Inject Level 3 assets only after validated need.
   * Requirement 51.3: Deterministic ordering.
   * Requirement 51.5: Enforce token budgets and record omissions.
   */
  assemble(
    planner: ProgressiveDisclosurePlanner,
    uiState: DisclosureUIStateService,
    validatedBundle: ValidatedBundleSkill[],
  ): AssembledPromptManifest {
    const state = planner.getState();
    const entries: PromptManifestEntry[] = [];
    const omissions: OmissionRecord[] = [];
    const tokensByCategory: Record<PromptCategory, number> = {
      task_constraints: 0,
      safety: 0,
      dependencies: 0,
      pins: 0,
      priority: 0,
      standard: 0,
    };
    let totalTokens = 0;
    const effectiveBudget = this.config.totalTokenBudget - this.config.responseReserve;

    // Build a lookup of validated bundle skills
    const bundleLookup = new Map<string, ValidatedBundleSkill>();
    for (const skill of validatedBundle) {
      bundleLookup.set(skill.skillId, skill);
    }

    // Collect eligible candidates (only from validated bundle with active triggers)
    const candidates = this.collectCandidates(state, bundleLookup, uiState, planner);

    // Sort candidates deterministically
    const sorted = this.sortCandidates(candidates, bundleLookup, state.metadataIndex);

    // Assemble in sorted order, enforcing budgets
    let position = 0;
    for (const candidate of sorted) {
      const category = candidate.category;
      const categoryBudget = this.config.categoryBudgets[category];
      const categoryUsed = tokensByCategory[category];

      // Check category budget
      if (categoryUsed + candidate.tokens > categoryBudget) {
        omissions.push({
          skillId: candidate.skillId,
          contentType: candidate.contentType,
          assetId: candidate.assetId,
          reason: 'category_budget_exceeded',
          tokens: candidate.tokens,
          category,
          omittedAt: Date.now(),
        });
        continue;
      }

      // Check total budget
      if (totalTokens + candidate.tokens > effectiveBudget) {
        omissions.push({
          skillId: candidate.skillId,
          contentType: candidate.contentType,
          assetId: candidate.assetId,
          reason: 'budget_exceeded',
          tokens: candidate.tokens,
          category,
          omittedAt: Date.now(),
        });
        continue;
      }

      // Add to manifest
      entries.push({
        position,
        skillId: candidate.skillId,
        category,
        contentType: candidate.contentType,
        tokens: candidate.tokens,
        contentFingerprint: candidate.fingerprint,
        provenance: candidate.provenance,
        version: candidate.version,
        assetId: candidate.assetId,
      });

      tokensByCategory[category] += candidate.tokens;
      totalTokens += candidate.tokens;
      position++;

      // Record evidence for the disclosure
      uiState.recordEvidence({
        skillId: candidate.skillId,
        promptPosition: position - 1,
        action: 'load',
        fingerprint: candidate.fingerprint,
        provenance: candidate.provenance,
        tokens: candidate.tokens,
      });
    }

    return {
      entries,
      omissions,
      totalTokens,
      tokensByCategory,
      assembledAt: Date.now(),
      runId: this.currentRunId,
      stepId: this.currentStepId,
    };
  }

  /**
   * Set the run/step context for assembly.
   */
  setContext(runId: string, stepId: string): void {
    this.currentRunId = runId;
    this.currentStepId = stepId;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<PromptAssemblerConfig> {
    return this.config;
  }

  /**
   * Update the configuration.
   */
  updateConfig(config: Partial<PromptAssemblerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Collect candidates eligible for inclusion in the prompt.
   *
   * Requirement 51.1: Only inject from validated bundle with active trigger/assignment.
   * Requirement 51.2: Level 3 assets only after validated need.
   */
  private collectCandidates(
    state: DisclosureState,
    bundleLookup: Map<string, ValidatedBundleSkill>,
    uiState: DisclosureUIStateService,
    planner: ProgressiveDisclosurePlanner,
  ): AssemblyCandidate[] {
    const candidates: AssemblyCandidate[] = [];

    // Process Level 2 bodies (only from validated bundle with active trigger)
    for (const [skillId, body] of state.loadedBodies) {
      const bundleSkill = bundleLookup.get(skillId);

      // Requirement 51.1: Only from validated bundle
      if (!bundleSkill) {
        continue;
      }

      // Requirement 51.1: Only with active trigger/assignment
      if (!bundleSkill.hasActiveTrigger) {
        continue;
      }

      // Skip excluded skills
      if (uiState.isExcluded(skillId)) {
        continue;
      }

      // Skip fail-closed skills
      if (planner.isFailClosed(skillId)) {
        continue;
      }

      const category = this.determineCategory(bundleSkill, uiState.isPinned(skillId));

      candidates.push({
        skillId,
        contentType: 'body',
        tokens: body.tokens,
        fingerprint: body.contentFingerprint,
        provenance: body.provenance,
        version: body.version,
        category,
        priority: bundleSkill.dependencyOrder,
      });
    }

    // Process Level 3 assets (only after validated Level 3 need)
    for (const [_key, asset] of state.loadedAssets) {
      const bundleSkill = bundleLookup.get(asset.skillId);

      // Requirement 51.2: Only from validated bundle
      if (!bundleSkill) {
        continue;
      }

      // Requirement 51.2: Only after Level 3 validation
      if (!bundleSkill.level3Validated) {
        continue;
      }

      // Skip excluded skills
      if (uiState.isExcluded(asset.skillId)) {
        continue;
      }

      const category = this.determineCategory(bundleSkill, uiState.isPinned(asset.skillId));

      candidates.push({
        skillId: asset.skillId,
        contentType: asset.assetType,
        tokens: asset.tokens,
        fingerprint: asset.declaredFingerprint,
        provenance: `${asset.skillId}:${asset.assetId}`,
        version: bundleSkill.version,
        category,
        priority: bundleSkill.dependencyOrder,
        assetId: asset.assetId,
      });
    }

    return candidates;
  }

  /**
   * Determine the category for a candidate based on its bundle properties and pin status.
   */
  private determineCategory(bundleSkill: ValidatedBundleSkill, isPinned: boolean): PromptCategory {
    if (bundleSkill.isTaskConstraint) return 'task_constraints';
    if (bundleSkill.isSafety) return 'safety';
    if (bundleSkill.dependencyOrder < 100) return 'dependencies';
    if (isPinned) return 'pins';
    if (bundleSkill.category !== 'standard') return bundleSkill.category;
    return 'standard';
  }

  /**
   * Sort candidates in deterministic order per Requirement 51.3:
   * task constraints > safety > dependencies > pins > priority > canonical ID > version
   */
  private sortCandidates(
    candidates: AssemblyCandidate[],
    bundleLookup: Map<string, ValidatedBundleSkill>,
    metadataIndex: ReadonlyMap<string, SkillMetadataEntry>,
  ): AssemblyCandidate[] {
    const categoryOrder: Record<PromptCategory, number> = {
      task_constraints: 0,
      safety: 1,
      dependencies: 2,
      pins: 3,
      priority: 4,
      standard: 5,
    };

    return [...candidates].sort((a, b) => {
      // 1. Category precedence
      const catDiff = categoryOrder[a.category] - categoryOrder[b.category];
      if (catDiff !== 0) return catDiff;

      // 2. Within same category: dependency order
      if (a.priority !== b.priority) return a.priority - b.priority;

      // 3. Skill priority from metadata
      const metaA = metadataIndex.get(a.skillId);
      const metaB = metadataIndex.get(b.skillId);
      const priA = metaA?.priority ?? Infinity;
      const priB = metaB?.priority ?? Infinity;
      if (priA !== priB) return priA - priB;

      // 4. Canonical ID (alphabetical)
      const idCmp = a.skillId.localeCompare(b.skillId);
      if (idCmp !== 0) return idCmp;

      // 5. Version (semver string comparison)
      return a.version.localeCompare(b.version);
    });
  }
}

// ---------------------------------------------------------------------------
// Internal candidate type
// ---------------------------------------------------------------------------

interface AssemblyCandidate {
  skillId: string;
  contentType: 'body' | 'reference' | 'script';
  tokens: number;
  fingerprint: string;
  provenance: string;
  version: string;
  category: PromptCategory;
  priority: number;
  assetId?: string;
}
