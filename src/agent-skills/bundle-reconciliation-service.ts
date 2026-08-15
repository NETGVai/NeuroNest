/**
 * Bundle Reconciliation Service
 *
 * Wraps AgentSkillsService.reconcileAgentSkillBundle() as the sole write path
 * for runtime skill assignments. Handles atomic additions, removals, and
 * retentions while preserving valid historical execution evidence.
 *
 * Persists complete derivation metadata: rankings, inclusion/exclusion reasons,
 * catalog/task/bundle fingerprints, reconciliation results, and reviewer actions.
 *
 * Disables legacy keyword-only and startup assignment mutation after parity
 * and rollback validation.
 *
 * Requirements: 50.4, 50.5, 50.8, 50.9
 */

import { createHash } from 'node:crypto';
import { AgentSkillsService } from './agent-skills-service.js';
import type {
  BundlePersistencePlan,
  BundlePersistenceStatus,
  CurrentAssignment,
} from './bundle-persistence-plan.js';
import {
  buildBundlePersistencePlan,
} from './bundle-persistence-plan.js';
import type { AssignmentEvidence } from './assignment-evidence.js';
import type { BundleSelectionSuccess, ExclusionExplanation } from './bundle-selection-service.js';

// ─── Configuration ───────────────────────────────────────────────

/**
 * Configuration for legacy mutation controls.
 */
export interface LegacyMutationConfig {
  /** Whether legacy keyword-only routing is disabled */
  readonly keywordRoutingDisabled: boolean;
  /** Whether startup assignment mappings are disabled */
  readonly startupMappingsDisabled: boolean;
  /** Whether parity validation has passed */
  readonly parityValidated: boolean;
  /** Whether rollback validation has passed */
  readonly rollbackValidated: boolean;
}

// ─── Derivation Metadata ─────────────────────────────────────────

/**
 * Complete derivation metadata persisted alongside each reconciliation.
 *
 * Requirement 50.8: Persist capability derivation, candidate rankings,
 * inclusion and exclusion reasons, catalog fingerprint, task fingerprint,
 * bundle fingerprint, reconciliation result, and reviewer action.
 */
export interface ReconciliationDerivation {
  /** Unique derivation record ID */
  readonly derivationId: string;
  /** Agent this derivation applies to */
  readonly agentId: string;
  /** Task triggering the reconciliation */
  readonly taskId: string;
  /** Candidate rankings in deterministic order */
  readonly candidateRankings: readonly CandidateRanking[];
  /** Inclusion reasons for each selected skill */
  readonly inclusionReasons: readonly InclusionReason[];
  /** Exclusion reasons for skills not selected */
  readonly exclusionReasons: readonly ExclusionExplanation[];
  /** Catalog fingerprint at reconciliation time */
  readonly catalogFingerprint: string;
  /** Task fingerprint */
  readonly taskFingerprint: string;
  /** Bundle fingerprint */
  readonly bundleFingerprint: string;
  /** Reconciliation result status */
  readonly reconciliationResult: ReconciliationResultSummary;
  /** Reviewer action (if any) */
  readonly reviewerAction: ReviewerAction | null;
  /** Timestamp of reconciliation */
  readonly reconciledAt: string;
}

/**
 * A ranked candidate with position and deterministic tie-break factors.
 */
export interface CandidateRanking {
  readonly rank: number;
  readonly skillId: string;
  readonly skillName: string;
  readonly coverageGain: number;
  readonly permissionWeight: number;
  readonly qualityTier: number;
  readonly costBudget: number;
  readonly safetyRequired: boolean;
  readonly explicitlyAssigned: boolean;
  readonly selected: boolean;
}

/**
 * Reason a skill was included in the bundle.
 */
export interface InclusionReason {
  readonly skillId: string;
  readonly reason: string;
  readonly category: 'safety_required' | 'explicit_assignment' | 'capability_coverage';
  readonly coveredCapabilities: readonly string[];
}

/**
 * Summary of reconciliation outcome.
 */
export interface ReconciliationResultSummary {
  readonly state: 'committed' | 'rolled-back';
  readonly changed: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly retainedCount: number;
}

/**
 * Reviewer action recorded for audit.
 */
export interface ReviewerAction {
  readonly reviewerId: string;
  readonly action: 'approved' | 'rejected' | 'modified';
  readonly rationale: string;
  readonly timestamp: string;
}

// ─── Historical Evidence ─────────────────────────────────────────

/**
 * Historical evidence preserved for retained assignments.
 *
 * Requirement 50.5: Preserve valid historical execution counts, success rates,
 * timing metrics, proficiency data, and prior version evidence.
 */
export interface PreservedHistoricalEvidence {
  readonly agentId: string;
  readonly skillId: string;
  readonly totalExecutions: number;
  readonly successfulExecutions: number;
  readonly successRate: number;
  readonly avgExecutionTimeMs: number;
  readonly proficiencyLevel: string;
  readonly lastUsedAt: string | null;
  readonly learnedAt: string;
}

// ─── Reconciliation Input ────────────────────────────────────────

/**
 * Input to the reconciliation service. Contains the bundle selection
 * result and any reviewer actions.
 */
export interface ReconciliationInput {
  /** The agent to reconcile assignments for */
  readonly agentId: string;
  /** Task triggering reconciliation */
  readonly taskId: string;
  /** Resolved bundle from BundleSelectionService */
  readonly bundleSelection: BundleSelectionSuccess;
  /** Evidence for the assignment */
  readonly evidence: readonly AssignmentEvidence[];
  /** Optional reviewer action */
  readonly reviewerAction?: ReviewerAction;
}

// ─── Reconciliation Output ───────────────────────────────────────

/**
 * Complete output from a reconciliation attempt.
 */
export interface ReconciliationOutput {
  /** Persistence status */
  readonly status: BundlePersistenceStatus;
  /** Preserved historical evidence for retained assignments */
  readonly preservedEvidence: readonly PreservedHistoricalEvidence[];
  /** Complete derivation metadata for audit */
  readonly derivation: ReconciliationDerivation;
}

// ─── Legacy Mutation Guard ───────────────────────────────────────

/**
 * Error thrown when a legacy mutation path attempts to modify runtime assignments.
 *
 * Requirement 50.9: Legacy keyword-only one-skill routing and startup mappings
 * that bypass authoritative validation SHALL NOT mutate runtime assignment.
 */
export class LegacyMutationBlockedError extends Error {
  constructor(
    public readonly source: 'keyword_routing' | 'startup_mapping',
    message: string,
  ) {
    super(message);
    this.name = 'LegacyMutationBlockedError';
  }
}

// ─── Derivation Persistence ──────────────────────────────────────

/**
 * Interface for persisting reconciliation derivation records.
 */
export interface DerivationPersistence {
  saveDerivation(derivation: ReconciliationDerivation): void;
  getDerivation(derivationId: string): ReconciliationDerivation | null;
  getDerivationByTask(agentId: string, taskId: string): ReconciliationDerivation | null;
}

// ─── Service ─────────────────────────────────────────────────────

/**
 * BundleReconciliationService is the sole authorized write path for
 * runtime skill assignments after parity validation.
 *
 * It orchestrates:
 * 1. Reading current assignments and evidence
 * 2. Planning the reconciliation (additions, removals, retentions)
 * 3. Preserving historical evidence for retained assignments
 * 4. Invoking AgentSkillsService.reconcileAgentSkillBundle() atomically
 * 5. Persisting derivation metadata for audit
 * 6. Blocking legacy mutation paths
 *
 * Requirements: 50.4, 50.5, 50.8, 50.9
 */
export class BundleReconciliationService {
  private legacyConfig: LegacyMutationConfig;

  constructor(
    private readonly agentSkillsService: AgentSkillsService,
    private readonly derivationPersistence: DerivationPersistence,
    legacyConfig?: Partial<LegacyMutationConfig>,
  ) {
    this.legacyConfig = {
      keywordRoutingDisabled: legacyConfig?.keywordRoutingDisabled ?? false,
      startupMappingsDisabled: legacyConfig?.startupMappingsDisabled ?? false,
      parityValidated: legacyConfig?.parityValidated ?? false,
      rollbackValidated: legacyConfig?.rollbackValidated ?? false,
    };
  }

  /**
   * Reconcile a complete skill bundle atomically through AgentSkillsService.
   *
   * This is the single authorized write path for runtime assignments.
   *
   * Requirement 50.4: Invoke AgentSkillsService.reconcileAgentSkillBundle()
   * atomically for additions, removals, retained assignments, Evidence rows,
   * and bundle fingerprint.
   *
   * @param input - Reconciliation input with bundle selection and evidence
   * @returns Complete reconciliation output with status, preserved evidence, and derivation
   */
  async reconcile(input: ReconciliationInput): Promise<ReconciliationOutput> {
    const { agentId, taskId, bundleSelection, evidence, reviewerAction } = input;

    // Step 1: Read current assignments to identify retained/stale/added
    const currentAssignments = await this.agentSkillsService.getCurrentAssignments(agentId);

    // Step 2: Preserve historical evidence for retained assignments
    const desiredSkillIds = bundleSelection.bundle.map(c => c.skillId).sort();
    const preservedEvidence = this.preserveHistoricalEvidence(
      currentAssignments,
      desiredSkillIds,
    );

    // Step 3: Get current evidence fingerprint for no-op detection
    const currentEvidenceFingerprint =
      await this.agentSkillsService.getCurrentEvidenceFingerprint(agentId);

    // Step 4: Build the deterministic persistence plan
    const plan = buildBundlePersistencePlan({
      agentId,
      desiredSkillIds,
      evidence,
      currentAssignments,
      inputFingerprint: this.computeInputFingerprint(
        agentId,
        taskId,
        bundleSelection.catalogFingerprint,
        bundleSelection.taskFingerprint,
        bundleSelection.bundleFingerprint,
      ),
      catalogFingerprint: bundleSelection.catalogFingerprint,
      currentEvidenceFingerprint,
    });

    // Step 5: Execute atomic reconciliation through AgentSkillsService
    const status = await this.agentSkillsService.reconcileAgentSkillBundle(plan);

    // Step 6: Build and persist derivation metadata
    const derivation = this.buildDerivation(
      agentId,
      taskId,
      bundleSelection,
      plan,
      status,
      reviewerAction ?? null,
    );
    this.derivationPersistence.saveDerivation(derivation);

    return {
      status,
      preservedEvidence,
      derivation,
    };
  }

  /**
   * Guards against legacy keyword-only routing attempts.
   *
   * Requirement 50.9: Legacy keyword-only one-skill routing that bypasses
   * authoritative validation SHALL NOT mutate runtime assignment.
   *
   * @throws LegacyMutationBlockedError when legacy routing is disabled
   */
  guardKeywordRouting(agentId: string, skillId: string): void {
    if (this.legacyConfig.keywordRoutingDisabled) {
      throw new LegacyMutationBlockedError(
        'keyword_routing',
        `Legacy keyword-only routing blocked for agent '${agentId}' skill '${skillId}'. ` +
        'Use BundleReconciliationService.reconcile() through the authoritative bundle path.',
      );
    }
  }

  /**
   * Guards against legacy startup assignment mapping attempts.
   *
   * Requirement 50.9: Startup mappings that bypass authoritative validation
   * SHALL NOT mutate runtime assignment.
   *
   * @throws LegacyMutationBlockedError when startup mappings are disabled
   */
  guardStartupMapping(agentId: string, skillIds: readonly string[]): void {
    if (this.legacyConfig.startupMappingsDisabled) {
      throw new LegacyMutationBlockedError(
        'startup_mapping',
        `Legacy startup assignment mapping blocked for agent '${agentId}' with ` +
        `${skillIds.length} skill(s). Use BundleReconciliationService.reconcile() ` +
        'through the authoritative bundle path.',
      );
    }
  }

  /**
   * Enables legacy mutation blocking after parity and rollback validation.
   *
   * Both parity and rollback must pass before legacy paths are disabled.
   * This is the controlled cutover mechanism.
   */
  enableLegacyBlocking(config: {
    parityValidated: boolean;
    rollbackValidated: boolean;
  }): void {
    if (config.parityValidated && config.rollbackValidated) {
      this.legacyConfig = {
        keywordRoutingDisabled: true,
        startupMappingsDisabled: true,
        parityValidated: true,
        rollbackValidated: true,
      };
    }
  }

  /**
   * Disables legacy mutation blocking (rollback path).
   */
  disableLegacyBlocking(): void {
    this.legacyConfig = {
      keywordRoutingDisabled: false,
      startupMappingsDisabled: false,
      parityValidated: this.legacyConfig.parityValidated,
      rollbackValidated: this.legacyConfig.rollbackValidated,
    };
  }

  /**
   * Returns the current legacy mutation configuration.
   */
  getLegacyConfig(): Readonly<LegacyMutationConfig> {
    return { ...this.legacyConfig };
  }

  /**
   * Preserve historical evidence for assignments that are being retained.
   *
   * Requirement 50.5: Preserve valid historical execution counts, success rates,
   * timing metrics, proficiency data, and prior version evidence for retained
   * assignments.
   */
  private preserveHistoricalEvidence(
    currentAssignments: readonly CurrentAssignment[],
    desiredSkillIds: readonly string[],
  ): PreservedHistoricalEvidence[] {
    const desiredSet = new Set(desiredSkillIds);
    const preserved: PreservedHistoricalEvidence[] = [];

    for (const assignment of currentAssignments) {
      if (desiredSet.has(assignment.skillId)) {
        // This assignment is being retained — preserve its historical data
        preserved.push({
          agentId: assignment.agentId,
          skillId: assignment.skillId,
          totalExecutions: assignment.totalExecutions,
          successfulExecutions: assignment.successfulExecutions,
          successRate: assignment.successRate,
          avgExecutionTimeMs: assignment.avgExecutionTimeMs,
          proficiencyLevel: assignment.proficiencyLevel,
          lastUsedAt: assignment.lastUsedAt,
          learnedAt: assignment.learnedAt,
        });
      }
    }

    return preserved;
  }

  /**
   * Build complete derivation metadata for persistence.
   *
   * Requirement 50.8: Persist derivation, rankings, reasons,
   * catalog/task/bundle fingerprints, reconciliation result, and reviewer action.
   */
  private buildDerivation(
    agentId: string,
    taskId: string,
    bundleSelection: BundleSelectionSuccess,
    plan: BundlePersistencePlan,
    status: BundlePersistenceStatus,
    reviewerAction: ReviewerAction | null,
  ): ReconciliationDerivation {
    // Build candidate rankings
    const candidateRankings = this.buildCandidateRankings(bundleSelection);

    // Build inclusion reasons
    const inclusionReasons = this.buildInclusionReasons(bundleSelection);

    // Build reconciliation result summary
    const reconciliationResult: ReconciliationResultSummary = {
      state: status.state,
      changed: status.state === 'committed' ? (status as any).changed ?? true : false,
      errorCode: status.state === 'rolled-back' ? (status as any).errorCode : undefined,
      errorMessage: status.state === 'rolled-back' ? (status as any).errorMessage : undefined,
      addedCount: plan.addedSkillIds.length,
      removedCount: plan.staleAssignments.length,
      retainedCount: plan.retainedSkillIds.length,
    };

    return {
      derivationId: generateDerivationId(),
      agentId,
      taskId,
      candidateRankings,
      inclusionReasons,
      exclusionReasons: bundleSelection.exclusions,
      catalogFingerprint: bundleSelection.catalogFingerprint,
      taskFingerprint: bundleSelection.taskFingerprint,
      bundleFingerprint: bundleSelection.bundleFingerprint,
      reconciliationResult,
      reviewerAction,
      reconciledAt: new Date().toISOString(),
    };
  }

  /**
   * Build candidate rankings from the bundle selection result.
   */
  private buildCandidateRankings(bundleSelection: BundleSelectionSuccess): CandidateRanking[] {
    const rankings: CandidateRanking[] = [];

    // Selected candidates first, then excluded
    let rank = 1;
    for (const candidate of bundleSelection.bundle) {
      rankings.push({
        rank: rank++,
        skillId: candidate.skillId,
        skillName: candidate.name,
        coverageGain: candidate.coverageGain,
        permissionWeight: candidate.permissionWeight,
        qualityTier: candidate.qualityTier,
        costBudget: candidate.costBudget,
        safetyRequired: candidate.safetyRequired,
        explicitlyAssigned: candidate.explicitlyAssigned,
        selected: true,
      });
    }

    // Add excluded candidates with their rankings
    for (const exclusion of bundleSelection.exclusions) {
      rankings.push({
        rank: rank++,
        skillId: exclusion.skillId,
        skillName: exclusion.name,
        coverageGain: 0,
        permissionWeight: 0,
        qualityTier: 0,
        costBudget: 0,
        safetyRequired: false,
        explicitlyAssigned: false,
        selected: false,
      });
    }

    return rankings;
  }

  /**
   * Build inclusion reasons for each skill in the bundle.
   */
  private buildInclusionReasons(bundleSelection: BundleSelectionSuccess): InclusionReason[] {
    const reasons: InclusionReason[] = [];

    for (const candidate of bundleSelection.bundle) {
      let category: InclusionReason['category'];
      let reason: string;

      if (candidate.safetyRequired) {
        category = 'safety_required';
        reason = `Skill '${candidate.name}' is required for safety/compatibility.`;
      } else if (candidate.explicitlyAssigned) {
        category = 'explicit_assignment';
        reason = `Skill '${candidate.name}' has an explicit approved assignment.`;
      } else {
        category = 'capability_coverage';
        reason = `Skill '${candidate.name}' covers ${candidate.coveredCapabilities.length} required capability(ies): ${candidate.coveredCapabilities.join(', ')}.`;
      }

      reasons.push({
        skillId: candidate.skillId,
        reason,
        category,
        coveredCapabilities: candidate.coveredCapabilities,
      });
    }

    return reasons;
  }

  /**
   * Compute the combined input fingerprint for plan creation.
   */
  private computeInputFingerprint(
    agentId: string,
    taskId: string,
    catalogFingerprint: string,
    taskFingerprint: string,
    bundleFingerprint: string,
  ): string {
    const hash = createHash('sha256');
    hash.update('reconciliation-input:');
    hash.update(JSON.stringify({
      agentId,
      taskId,
      catalogFingerprint,
      taskFingerprint,
      bundleFingerprint,
    }));
    return `input-${hash.digest('hex').slice(0, 32)}`;
  }
}

// ─── Utilities ───────────────────────────────────────────────────

/**
 * Generate a unique derivation record ID.
 */
function generateDerivationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `deriv-${timestamp}-${random}`;
}
