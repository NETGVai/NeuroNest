/**
 * Prompt Conflict Policy Service
 *
 * Applies typed conflict policy, records conflicting sources and resolution,
 * and blocks prompt assembly whenever a mandatory conflict or any required
 * conflict-handling step remains unresolved or fails.
 *
 * Correlates disclosed assets with tools, artifacts, validation, review,
 * latency, tokens, cost, and feedback without unsupported causal claims.
 *
 * Provides step-end revalidation evidence confirming loaded assets naturally
 * unload and every revalidation produces auditable Evidence.
 *
 * Requirements: 43.4, 43.5, 43.6, 51.4, 51.7
 */

import type {
  SkillMetadataEntry,
  LoadedBody,
  LoadedAsset,
  DisclosureEvent,
  ProgressiveDisclosurePlanner,
} from './progressive-disclosure.js';
import type {
  PromptManifestAssembler,
  AssembledPromptManifest,
  ValidatedBundleSkill,
} from './prompt-manifest-assembler.js';
import type { DisclosureUIStateService } from './disclosure-ui-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity of a conflict — mandatory blocks assembly; advisory does not. */
export type ConflictSeverity = 'mandatory' | 'advisory';

/** Current state of a conflict record. */
export type ConflictStatus = 'unresolved' | 'resolved' | 'failed';

/** Typed conflict condition describing the nature of the conflict. */
export type ConflictCondition =
  | 'trigger_overlap'
  | 'exclusive_skills'
  | 'budget_contention'
  | 'version_mismatch'
  | 'dependency_cycle'
  | 'capability_overlap'
  | 'safety_override';

/** A typed conflict record between two skill sources. */
export interface ConflictRecord {
  id: string;
  condition: ConflictCondition;
  severity: ConflictSeverity;
  status: ConflictStatus;
  /** First conflicting source */
  sourceA: ConflictSource;
  /** Second conflicting source */
  sourceB: ConflictSource;
  /** Resolution details when resolved */
  resolution?: ConflictResolution;
  /** When the conflict was detected */
  detectedAt: number;
  /** When the conflict was resolved or failed */
  resolvedAt?: number;
  /** Error message when status is 'failed' */
  failureReason?: string;
}

/** Identifies one side of a conflict. */
export interface ConflictSource {
  skillId: string;
  version: string;
  contentFingerprint: string;
  category: string;
  /** The specific instruction or trigger that conflicts */
  conflictingElement: string;
}

/** Resolution record for a resolved conflict. */
export interface ConflictResolution {
  /** Which source was preferred */
  preferredSource: 'sourceA' | 'sourceB' | 'merged' | 'excluded_both';
  /** Reason for the resolution */
  reason: string;
  /** Who or what resolved the conflict */
  resolvedBy: string;
  /** Resulting merged or selected content fingerprint */
  resultFingerprint: string;
}

/** Result of attempting to assemble a prompt through the conflict policy. */
export type ConflictCheckedAssemblyResult =
  | { status: 'assembled'; manifest: AssembledPromptManifest }
  | { status: 'blocked'; unresolvedConflicts: ConflictRecord[]; failedConflicts: ConflictRecord[] };

/** Correlation record linking a disclosed asset to runtime metrics. */
export interface AssetCorrelationRecord {
  id: string;
  runId: string;
  stepId: string;
  skillId: string;
  assetId?: string;
  /** Metrics correlated to this asset (not causal claims). */
  correlations: AssetCorrelationMetrics;
  /** Timestamp of the correlation capture */
  capturedAt: number;
}

/** Runtime metrics correlated (not caused by) a disclosed asset. */
export interface AssetCorrelationMetrics {
  /** Tool events associated with the step where this asset was disclosed */
  toolEventIds: string[];
  /** Artifacts produced during the step */
  artifactIds: string[];
  /** Validation results from the step */
  validationIds: string[];
  /** Review decisions made during the step */
  reviewDecisionIds: string[];
  /** Latency in milliseconds for the step */
  latencyMs?: number;
  /** Input + output tokens for the step */
  tokensUsed?: number;
  /** Cost in microcents for the step */
  costMicrocents?: number;
  /** Model feedback scores if available */
  feedbackScores?: Record<string, number>;
}

/** Step-end revalidation evidence confirming unload and audit. */
export interface StepEndRevalidationEvidence {
  id: string;
  runId: string;
  stepId: string;
  /** Skill IDs that were loaded at step start */
  assetsLoadedAtStart: string[];
  /** Skill IDs confirmed unloaded at step end */
  assetsUnloadedAtEnd: string[];
  /** Whether all assets were naturally unloaded */
  allUnloaded: boolean;
  /** Any assets that failed to unload */
  failedUnloads: string[];
  /** Timestamp of the revalidation */
  revalidatedAt: number;
  /** Whether the revalidation produced complete auditable evidence */
  auditComplete: boolean;
  /** Linked disclosure event IDs for the unload evidence */
  linkedEventIds: string[];
}

// ---------------------------------------------------------------------------
// Prompt Conflict Policy Service
// ---------------------------------------------------------------------------

export class PromptConflictPolicyService {
  private conflicts: Map<string, ConflictRecord> = new Map();
  private correlations: AssetCorrelationRecord[] = [];
  private revalidationEvidence: StepEndRevalidationEvidence[] = [];
  private currentRunId = '';
  private currentStepId = '';

  /**
   * Set the run/step context.
   */
  setContext(runId: string, stepId: string): void {
    this.currentRunId = runId;
    this.currentStepId = stepId;
  }

  // -------------------------------------------------------------------------
  // Conflict Detection and Registration
  // -------------------------------------------------------------------------

  /**
   * Register a typed conflict between two sources.
   *
   * Requirement 51.4: Apply typed conflict policy, record both sources and resolution.
   */
  registerConflict(
    condition: ConflictCondition,
    severity: ConflictSeverity,
    sourceA: ConflictSource,
    sourceB: ConflictSource,
  ): ConflictRecord {
    const id = `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: ConflictRecord = {
      id,
      condition,
      severity,
      status: 'unresolved',
      sourceA,
      sourceB,
      detectedAt: Date.now(),
    };
    this.conflicts.set(id, record);
    return record;
  }

  /**
   * Resolve a conflict with a typed resolution.
   *
   * Requirement 51.4: Record both sources and the resolution.
   */
  resolveConflict(conflictId: string, resolution: ConflictResolution): boolean {
    const record = this.conflicts.get(conflictId);
    if (!record || record.status !== 'unresolved') return false;

    record.status = 'resolved';
    record.resolution = resolution;
    record.resolvedAt = Date.now();
    return true;
  }

  /**
   * Mark a conflict as failed (handling step could not complete).
   *
   * Requirement 51.4: Block assembly when any required conflict-handling step fails.
   */
  failConflict(conflictId: string, reason: string): boolean {
    const record = this.conflicts.get(conflictId);
    if (!record) return false;

    record.status = 'failed';
    record.failureReason = reason;
    record.resolvedAt = Date.now();
    return true;
  }

  /**
   * Get all current conflicts.
   */
  getConflicts(): readonly ConflictRecord[] {
    return Array.from(this.conflicts.values());
  }

  /**
   * Get unresolved mandatory conflicts that block assembly.
   */
  getBlockingConflicts(): ConflictRecord[] {
    return Array.from(this.conflicts.values()).filter(
      c => c.severity === 'mandatory' && c.status === 'unresolved',
    );
  }

  /**
   * Get failed conflicts that block assembly.
   */
  getFailedConflicts(): ConflictRecord[] {
    return Array.from(this.conflicts.values()).filter(
      c => c.status === 'failed',
    );
  }

  /**
   * Check if assembly is blocked by unresolved or failed conflicts.
   *
   * Requirement 51.4: Block assembly when a mandatory conflict is unresolved
   * or when conflict-handling fails.
   */
  isAssemblyBlocked(): boolean {
    return this.getBlockingConflicts().length > 0 || this.getFailedConflicts().length > 0;
  }

  // -------------------------------------------------------------------------
  // Conflict-Checked Assembly
  // -------------------------------------------------------------------------

  /**
   * Attempt to assemble the prompt, blocked by any unresolved mandatory conflict
   * or any failed conflict-handling step.
   *
   * Requirement 51.4: Block prompt assembly whenever a mandatory conflict or any
   * required conflict-handling step remains unresolved or fails.
   */
  assembleWithConflictCheck(
    assembler: PromptManifestAssembler,
    planner: ProgressiveDisclosurePlanner,
    uiState: DisclosureUIStateService,
    validatedBundle: ValidatedBundleSkill[],
  ): ConflictCheckedAssemblyResult {
    const unresolvedConflicts = this.getBlockingConflicts();
    const failedConflicts = this.getFailedConflicts();

    if (unresolvedConflicts.length > 0 || failedConflicts.length > 0) {
      return {
        status: 'blocked',
        unresolvedConflicts,
        failedConflicts,
      };
    }

    const manifest = assembler.assemble(planner, uiState, validatedBundle);
    return { status: 'assembled', manifest };
  }

  /**
   * Detect conflicts between skills in a validated bundle based on their metadata.
   * Returns newly registered conflicts.
   */
  detectConflicts(
    validatedBundle: ValidatedBundleSkill[],
    metadataIndex: ReadonlyMap<string, SkillMetadataEntry>,
  ): ConflictRecord[] {
    const newConflicts: ConflictRecord[] = [];

    for (let i = 0; i < validatedBundle.length; i++) {
      const skillA = validatedBundle[i];
      const metaA = metadataIndex.get(skillA.skillId);
      if (!metaA) continue;

      for (let j = i + 1; j < validatedBundle.length; j++) {
        const skillB = validatedBundle[j];
        const metaB = metadataIndex.get(skillB.skillId);
        if (!metaB) continue;

        // Check exclusive skills (mutual exclusion)
        if (metaA.exclusions.includes(skillB.skillId) || metaB.exclusions.includes(skillA.skillId)) {
          const conflict = this.registerConflict(
            'exclusive_skills',
            'mandatory',
            {
              skillId: skillA.skillId,
              version: skillA.version,
              contentFingerprint: '',
              category: skillA.category,
              conflictingElement: `excludes: ${skillB.skillId}`,
            },
            {
              skillId: skillB.skillId,
              version: skillB.version,
              contentFingerprint: '',
              category: skillB.category,
              conflictingElement: `excluded by: ${skillA.skillId}`,
            },
          );
          newConflicts.push(conflict);
        }

        // Check trigger overlap
        const sharedTriggers = metaA.triggers.filter(t => metaB.triggers.includes(t));
        if (sharedTriggers.length > 0) {
          const conflict = this.registerConflict(
            'trigger_overlap',
            'advisory',
            {
              skillId: skillA.skillId,
              version: skillA.version,
              contentFingerprint: '',
              category: skillA.category,
              conflictingElement: `triggers: ${sharedTriggers.join(', ')}`,
            },
            {
              skillId: skillB.skillId,
              version: skillB.version,
              contentFingerprint: '',
              category: skillB.category,
              conflictingElement: `triggers: ${sharedTriggers.join(', ')}`,
            },
          );
          newConflicts.push(conflict);
        }
      }
    }

    return newConflicts;
  }

  // -------------------------------------------------------------------------
  // Correlation Tracking (Requirement 51.7)
  // -------------------------------------------------------------------------

  /**
   * Record a correlation between a disclosed asset and runtime metrics.
   *
   * Requirement 51.7: Correlate disclosed skills with tools, artifacts, validation,
   * review, latency, tokens, cost, and feedback without claiming unsupported causality.
   */
  recordCorrelation(
    skillId: string,
    metrics: AssetCorrelationMetrics,
    assetId?: string,
  ): AssetCorrelationRecord {
    const record: AssetCorrelationRecord = {
      id: `corr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId: this.currentRunId,
      stepId: this.currentStepId,
      skillId,
      assetId,
      correlations: metrics,
      capturedAt: Date.now(),
    };
    this.correlations.push(record);
    return record;
  }

  /**
   * Get all correlation records.
   */
  getCorrelations(): readonly AssetCorrelationRecord[] {
    return this.correlations;
  }

  /**
   * Get correlations for a specific skill.
   */
  getCorrelationsForSkill(skillId: string): AssetCorrelationRecord[] {
    return this.correlations.filter(c => c.skillId === skillId);
  }

  /**
   * Get correlations for a specific step.
   */
  getCorrelationsForStep(stepId: string): AssetCorrelationRecord[] {
    return this.correlations.filter(c => c.stepId === stepId);
  }

  // -------------------------------------------------------------------------
  // Step-End Revalidation Evidence (Requirement 43.6)
  // -------------------------------------------------------------------------

  /**
   * Perform step-end revalidation: confirm that loaded assets naturally unload
   * and produce auditable evidence of each unload.
   *
   * Requirement 43.6: Verify existing loaded assets naturally unload and every
   * step-end revalidation produces auditable Evidence.
   */
  performStepEndRevalidation(
    planner: ProgressiveDisclosurePlanner,
  ): StepEndRevalidationEvidence {
    // Capture current loaded state before step-end
    const state = planner.getState();
    const loadedSkillIds = Array.from(state.loadedBodies.keys());
    const loadedAssetKeys = Array.from(state.loadedAssets.keys());
    const allLoadedAtStart = [...loadedSkillIds, ...loadedAssetKeys];

    // Perform step-end unload
    planner.endStep();

    // Verify all assets were unloaded
    const postState = planner.getState();
    const remainingBodies = Array.from(postState.loadedBodies.keys());
    const remainingAssets = Array.from(postState.loadedAssets.keys());
    const failedUnloads = [...remainingBodies, ...remainingAssets];
    const allUnloaded = failedUnloads.length === 0;

    // Collect linked disclosure event IDs for the unloads
    const events = planner.getDisclosureEvents();
    const unloadEventIds = events
      .filter(e => e.action === 'unload' && e.stepId === this.currentStepId)
      .map(e => e.id);

    // Verify which skills actually got unloaded
    const unloadedAtEnd = allLoadedAtStart.filter(id => !failedUnloads.includes(id));

    const evidence: StepEndRevalidationEvidence = {
      id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId: this.currentRunId,
      stepId: this.currentStepId,
      assetsLoadedAtStart: allLoadedAtStart,
      assetsUnloadedAtEnd: unloadedAtEnd,
      allUnloaded,
      failedUnloads,
      revalidatedAt: Date.now(),
      auditComplete: allUnloaded && unloadEventIds.length >= allLoadedAtStart.length,
      linkedEventIds: unloadEventIds,
    };

    this.revalidationEvidence.push(evidence);
    return evidence;
  }

  /**
   * Get all step-end revalidation evidence.
   */
  getRevalidationEvidence(): readonly StepEndRevalidationEvidence[] {
    return this.revalidationEvidence;
  }

  /**
   * Get revalidation evidence for a specific step.
   */
  getRevalidationEvidenceForStep(stepId: string): StepEndRevalidationEvidence | undefined {
    return this.revalidationEvidence.find(e => e.stepId === stepId);
  }

  // -------------------------------------------------------------------------
  // State Management
  // -------------------------------------------------------------------------

  /**
   * Reset all state for a new run.
   */
  reset(): void {
    this.conflicts.clear();
    this.correlations = [];
    this.revalidationEvidence = [];
    this.currentRunId = '';
    this.currentStepId = '';
  }

  /**
   * Clear only conflicts (e.g., after a new bundle is computed).
   */
  clearConflicts(): void {
    this.conflicts.clear();
  }
}
