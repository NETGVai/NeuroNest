/**
 * State-Compatible Rollback for Structured Response Renderer
 *
 * Captures gate state with projection checkpoint, draft snapshot, reader anchor,
 * and inspector selection. Rollback is only allowed when the target stage can
 * represent current durable state. When incompatible, writes are blocked, the
 * last compatible state is retained, authority-derived recovery is shown, and
 * a compatible checkpoint is obtained. Neither representation is ever deleted.
 *
 * Requirements: 13.1–13.12, 21.6, 22.9–22.10
 */

import {
  ProjectionOwnershipGuard,
  type ProjectionOwnerState,
  type ProjectionOwnershipSnapshot,
  type ProjectionTransitionResult,
} from '../../harness/projections/projection-ownership';

// ─── Stage Definitions ──────────────────────────────────────────

/**
 * Rollout stages 0–6 as defined by the design document section 16.1.
 */
export type RendererRolloutStage = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Maps rollout stages to their projection owner states.
 */
export const STAGE_OWNER_STATE: Readonly<Record<RendererRolloutStage, ProjectionOwnerState>> = Object.freeze({
  0: 'legacy_visible',
  1: 'legacy_visible',     // legacy visible, canonical shadow
  2: 'canonical_shadow',   // legacy visible, canonical shadow (hidden structural comparison)
  3: 'canonical_cutover',  // canonical generic timeline visible
  4: 'canonical_cutover',  // typed surfaces visible
  5: 'canonical_only',     // canonical interaction owner
  6: 'canonical_only',     // legacy retired
});

/**
 * Allowed backward (rollback) transitions from the design flowchart.
 * Stage 0 has no rollback (nothing to revert to).
 * Stage 6 has no rollback (retirement is final — must re-enable from 5).
 */
export const ALLOWED_ROLLBACK_EDGES: Readonly<Record<RendererRolloutStage, RendererRolloutStage | null>> = Object.freeze({
  0: null,
  1: 0,
  2: 1,
  3: 2,   // state-compatible rollback
  4: 3,   // state-compatible rollback
  5: 4,   // block writes then rollback
  6: null, // retirement is not reversible through rollback
});

// ─── State Capture Types ────────────────────────────────────────

export interface ProjectionCheckpoint {
  readonly revisionId: number;
  readonly checkpointHash: string;
  readonly sourceSequence: number;
  readonly nodeCount: number;
  readonly capturedAt: string;
}

export interface DraftSnapshot {
  readonly sessionId: string;
  readonly revision: number;
  readonly hasContent: boolean;
  readonly hasAttachments: boolean;
  readonly hasPendingSubmission: boolean;
  readonly capturedAt: string;
}

export interface ReaderAnchorSnapshot {
  readonly semanticAnchor: string | null;
  readonly offsetDip: number;
  readonly followsBottom: boolean;
  readonly lastReadStableKey: string | null;
  readonly unreadCount: number;
  readonly capturedAt: string;
}

export interface InspectorSelectionSnapshot {
  readonly isOpen: boolean;
  readonly selectedKind: string | null;
  readonly selectedIdentity: string | null;
  readonly sourceRevision: number | null;
  readonly capturedAt: string;
}

/**
 * Complete captured gate state used for rollback compatibility checks.
 */
export interface GateStateCapture {
  readonly stage: RendererRolloutStage;
  readonly projectionCheckpoint: ProjectionCheckpoint;
  readonly draftSnapshot: DraftSnapshot;
  readonly readerAnchor: ReaderAnchorSnapshot;
  readonly inspectorSelection: InspectorSelectionSnapshot;
  readonly ownershipSnapshot: ProjectionOwnershipSnapshot;
  readonly capturedAt: string;
}

// ─── Rollback Result Types ──────────────────────────────────────

export type RollbackVerdict = 'compatible' | 'incompatible' | 'blocked_pending_drain';

export interface RollbackCompatibilityResult {
  readonly verdict: RollbackVerdict;
  readonly fromStage: RendererRolloutStage;
  readonly toStage: RendererRolloutStage;
  /** Whether the target stage can represent all durable state */
  readonly canRepresentDurableState: boolean;
  /** Specific incompatibilities found */
  readonly incompatibilities: readonly RollbackIncompatibility[];
  /** Whether writes are blocked due to incompatibility */
  readonly writesBlocked: boolean;
  /** Authority-derived recovery information when incompatible */
  readonly recoveryInfo: RecoveryInfo | null;
  /** The last compatible state retained */
  readonly lastCompatibleCapture: GateStateCapture | null;
  readonly checkedAt: string;
}

export interface RollbackIncompatibility {
  readonly kind:
    | 'projection_checkpoint_incompatible'
    | 'draft_has_pending_submission'
    | 'draft_has_canonical_attachments'
    | 'inspector_has_canonical_only_entity'
    | 'pending_decisions_require_canonical'
    | 'pending_actions_require_canonical'
    | 'anchor_not_representable'
    | 'ownership_transition_invalid';
  readonly description: string;
  readonly affectedIdentity?: string;
}

export interface RecoveryInfo {
  readonly reason: string;
  readonly requiredAction: 'obtain_compatible_checkpoint' | 'drain_pending_actions' | 'await_decision_settlement';
  readonly authorityRef: string;
  readonly retainedState: 'last_compatible' | 'current';
}

// ─── Pending Action / Decision Tracking ─────────────────────────

export interface PendingAction {
  readonly actionId: string;
  readonly kind: string;
  readonly requiresCanonicalProjection: boolean;
  readonly submittedAt: string;
}

export interface PendingDecision {
  readonly decisionId: string;
  readonly collaborationKey: string;
  readonly requiresCanonicalProjection: boolean;
  readonly submittedAt: string;
}

// ─── Main Service ───────────────────────────────────────────────

/**
 * State-compatible rollback service for the structured response renderer.
 *
 * Invariants:
 * - Rollback is only performed when the target stage can represent all current durable state
 * - When incompatible, writes are blocked and last compatible state is retained
 * - Neither legacy nor canonical representation is ever deleted
 * - Recovery information is always authority-derived
 */
export class StateCompatibleRollbackService {
  private captures: Map<RendererRolloutStage, GateStateCapture> = new Map();
  private currentStage: RendererRolloutStage;
  private writesBlocked = false;
  private blockReason: RollbackIncompatibility[] = [];
  private pendingActions: PendingAction[] = [];
  private pendingDecisions: PendingDecision[] = [];
  private lastCompatibleCapture: GateStateCapture | null = null;

  constructor(initialStage: RendererRolloutStage = 0) {
    this.currentStage = initialStage;
  }

  // ─── State Capture ──────────────────────────────────────────────

  /**
   * Capture the current gate state for future rollback compatibility checks.
   * Should be called after a successful stage advancement or when durable state
   * stabilizes at the current stage.
   */
  captureGateState(
    stage: RendererRolloutStage,
    checkpoint: ProjectionCheckpoint,
    draft: DraftSnapshot,
    anchor: ReaderAnchorSnapshot,
    inspector: InspectorSelectionSnapshot,
    ownership: ProjectionOwnershipSnapshot,
  ): GateStateCapture {
    const now = new Date().toISOString();
    const capture: GateStateCapture = Object.freeze({
      stage,
      projectionCheckpoint: Object.freeze({ ...checkpoint }),
      draftSnapshot: Object.freeze({ ...draft }),
      readerAnchor: Object.freeze({ ...anchor }),
      inspectorSelection: Object.freeze({ ...inspector }),
      ownershipSnapshot: ownership,
      capturedAt: now,
    });

    this.captures.set(stage, capture);
    this.lastCompatibleCapture = capture;
    return capture;
  }

  // ─── Compatibility Checking ─────────────────────────────────────

  /**
   * Check whether rollback from `fromStage` to `toStage` is compatible
   * with the current durable state.
   */
  checkRollbackCompatibility(
    fromStage: RendererRolloutStage,
    toStage: RendererRolloutStage,
  ): RollbackCompatibilityResult {
    const now = new Date().toISOString();
    const incompatibilities: RollbackIncompatibility[] = [];

    // Validate the edge is an allowed backward transition
    const allowedTarget = ALLOWED_ROLLBACK_EDGES[fromStage];
    if (allowedTarget === null || allowedTarget !== toStage) {
      incompatibilities.push({
        kind: 'ownership_transition_invalid',
        description: `Rollback from stage ${fromStage} to ${toStage} is not an allowed backward edge`,
      });
    }

    // Check projection checkpoint compatibility
    const targetCapture = this.captures.get(toStage);
    if (targetCapture) {
      // Verify the target can represent all current durable state
      const currentCapture = this.captures.get(fromStage);
      if (currentCapture) {
        this.checkProjectionCompatibility(currentCapture, targetCapture, toStage, incompatibilities);
        this.checkDraftCompatibility(currentCapture, targetCapture, toStage, incompatibilities);
        this.checkInspectorCompatibility(currentCapture, toStage, incompatibilities);
        this.checkAnchorCompatibility(currentCapture, targetCapture, toStage, incompatibilities);
      }
    }

    // Check pending actions that require canonical projection
    this.checkPendingActionsCompatibility(toStage, incompatibilities);

    // Check pending decisions that require canonical projection
    this.checkPendingDecisionsCompatibility(toStage, incompatibilities);

    const canRepresent = incompatibilities.length === 0;
    let verdict: RollbackVerdict;
    let recoveryInfo: RecoveryInfo | null = null;

    if (canRepresent) {
      verdict = 'compatible';
    } else if (this.hasDrainableIncompatibilities(incompatibilities)) {
      verdict = 'blocked_pending_drain';
      recoveryInfo = {
        reason: 'Pending actions or decisions must settle before rollback can proceed',
        requiredAction: 'drain_pending_actions',
        authorityRef: 'projection-service',
        retainedState: 'current',
      };
    } else {
      verdict = 'incompatible';
      recoveryInfo = this.deriveRecoveryInfo(incompatibilities);
    }

    return Object.freeze({
      verdict,
      fromStage,
      toStage,
      canRepresentDurableState: canRepresent,
      incompatibilities: Object.freeze([...incompatibilities]),
      writesBlocked: verdict === 'incompatible',
      recoveryInfo,
      lastCompatibleCapture: this.lastCompatibleCapture,
      checkedAt: now,
    });
  }

  // ─── Rollback Execution ─────────────────────────────────────────

  /**
   * Attempt to perform a state-compatible rollback from the current stage
   * to the target stage.
   *
   * Returns the compatibility result. If compatible, transitions the stage.
   * If incompatible, blocks writes and retains last compatible state.
   */
  attemptRollback(
    targetStage: RendererRolloutStage,
    guard?: ProjectionOwnershipGuard,
  ): RollbackCompatibilityResult {
    const result = this.checkRollbackCompatibility(this.currentStage, targetStage);

    if (result.verdict === 'compatible') {
      // Transition the ownership guard if provided
      if (guard) {
        const targetOwnerState = STAGE_OWNER_STATE[targetStage];
        const transitionResult = guard.transition(targetOwnerState);
        if (!transitionResult.accepted) {
          // Ownership guard rejected the transition — treat as incompatible
          const ownershipIncompat: RollbackIncompatibility = {
            kind: 'ownership_transition_invalid',
            description: `Ownership guard rejected transition to ${targetOwnerState}`,
          };
          return Object.freeze({
            ...result,
            verdict: 'incompatible' as const,
            canRepresentDurableState: false,
            writesBlocked: true,
            incompatibilities: Object.freeze([
              ...result.incompatibilities,
              ownershipIncompat,
            ]),
            recoveryInfo: {
              reason: 'Ownership guard rejected the stage transition',
              requiredAction: 'obtain_compatible_checkpoint' as const,
              authorityRef: 'projection-ownership-guard',
              retainedState: 'last_compatible' as const,
            },
          }) as RollbackCompatibilityResult;
        }
      }

      // Perform the rollback
      this.currentStage = targetStage;
      this.writesBlocked = false;
      this.blockReason = [];
    } else if (result.verdict === 'incompatible') {
      // Block writes and retain last compatible state
      this.writesBlocked = true;
      this.blockReason = [...result.incompatibilities];
    }
    // For 'blocked_pending_drain', writes remain as-is but rollback doesn't proceed

    return result;
  }

  // ─── Write Blocking ─────────────────────────────────────────────

  /**
   * Check if writes are currently blocked due to an incompatible rollback attempt.
   */
  areWritesBlocked(): boolean {
    return this.writesBlocked;
  }

  /**
   * Get the reasons writes are blocked.
   */
  getBlockReasons(): readonly RollbackIncompatibility[] {
    return Object.freeze([...this.blockReason]);
  }

  /**
   * Clear the write block after a compatible checkpoint has been obtained.
   * This is called by the recovery flow once state is reconciled.
   */
  clearWriteBlock(): void {
    this.writesBlocked = false;
    this.blockReason = [];
  }

  // ─── Pending Action/Decision Management ─────────────────────────

  /**
   * Register a pending action that may affect rollback compatibility.
   */
  registerPendingAction(action: PendingAction): void {
    this.pendingActions.push(action);
  }

  /**
   * Settle (remove) a pending action after it completes or is rejected.
   */
  settlePendingAction(actionId: string): void {
    this.pendingActions = this.pendingActions.filter((a) => a.actionId !== actionId);
  }

  /**
   * Register a pending decision that may affect rollback compatibility.
   */
  registerPendingDecision(decision: PendingDecision): void {
    this.pendingDecisions.push(decision);
  }

  /**
   * Settle (remove) a pending decision after it is confirmed/rejected/expired.
   */
  settlePendingDecision(decisionId: string): void {
    this.pendingDecisions = this.pendingDecisions.filter((d) => d.decisionId !== decisionId);
  }

  /**
   * Get all currently pending actions.
   */
  getPendingActions(): readonly PendingAction[] {
    return Object.freeze([...this.pendingActions]);
  }

  /**
   * Get all currently pending decisions.
   */
  getPendingDecisions(): readonly PendingDecision[] {
    return Object.freeze([...this.pendingDecisions]);
  }

  // ─── Stage Queries ──────────────────────────────────────────────

  /**
   * Get the current rollout stage.
   */
  getCurrentStage(): RendererRolloutStage {
    return this.currentStage;
  }

  /**
   * Get the captured state for a given stage.
   */
  getCapturedState(stage: RendererRolloutStage): GateStateCapture | null {
    return this.captures.get(stage) ?? null;
  }

  /**
   * Get the last known compatible capture.
   */
  getLastCompatibleCapture(): GateStateCapture | null {
    return this.lastCompatibleCapture;
  }

  /**
   * Advance to a new stage (forward movement). Captures are preserved.
   */
  advanceStage(stage: RendererRolloutStage): void {
    this.currentStage = stage;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check whether the projection checkpoint at the target stage can represent
   * the current state.
   */
  private checkProjectionCompatibility(
    current: GateStateCapture,
    target: GateStateCapture,
    toStage: RendererRolloutStage,
    incompatibilities: RollbackIncompatibility[],
  ): void {
    // Stages 3+ use canonical projection; rolling back to stage 2 or below
    // requires the legacy representation to be current
    if (current.stage >= 3 && toStage < 3) {
      // Check if the projection checkpoint has diverged beyond what legacy can represent
      if (
        current.projectionCheckpoint.revisionId > target.projectionCheckpoint.revisionId &&
        current.projectionCheckpoint.checkpointHash !== target.projectionCheckpoint.checkpointHash
      ) {
        incompatibilities.push({
          kind: 'projection_checkpoint_incompatible',
          description:
            `Current projection revision ${current.projectionCheckpoint.revisionId} ` +
            `cannot be represented by target stage ${toStage} ` +
            `(last compatible revision: ${target.projectionCheckpoint.revisionId})`,
        });
      }
    }
  }

  /**
   * Check draft/attachment compatibility with the target stage.
   */
  private checkDraftCompatibility(
    current: GateStateCapture,
    _target: GateStateCapture,
    toStage: RendererRolloutStage,
    incompatibilities: RollbackIncompatibility[],
  ): void {
    // If the draft has a pending submission that requires canonical projection
    if (current.draftSnapshot.hasPendingSubmission && toStage < 3) {
      incompatibilities.push({
        kind: 'draft_has_pending_submission',
        description: 'Draft has a pending submission that requires canonical projection for confirmation',
        affectedIdentity: current.draftSnapshot.sessionId,
      });
    }

    // If draft has attachments that were added through canonical-only attachment APIs
    if (current.draftSnapshot.hasAttachments && current.stage >= 5 && toStage < 5) {
      incompatibilities.push({
        kind: 'draft_has_canonical_attachments',
        description: 'Draft has attachments added through canonical interaction APIs',
        affectedIdentity: current.draftSnapshot.sessionId,
      });
    }
  }

  /**
   * Check inspector selection compatibility.
   */
  private checkInspectorCompatibility(
    current: GateStateCapture,
    toStage: RendererRolloutStage,
    incompatibilities: RollbackIncompatibility[],
  ): void {
    // If inspector is open with a canonical-only entity type
    if (current.inspectorSelection.isOpen && current.inspectorSelection.selectedKind) {
      const canonicalOnlyKinds = ['trajectory', 'provenance', 'insight'];
      if (canonicalOnlyKinds.includes(current.inspectorSelection.selectedKind) && toStage < 3) {
        incompatibilities.push({
          kind: 'inspector_has_canonical_only_entity',
          description:
            `Inspector has a '${current.inspectorSelection.selectedKind}' entity open ` +
            `that cannot be represented at stage ${toStage}`,
          affectedIdentity: current.inspectorSelection.selectedIdentity ?? undefined,
        });
      }
    }
  }

  /**
   * Check reader anchor compatibility with the target stage.
   */
  private checkAnchorCompatibility(
    current: GateStateCapture,
    target: GateStateCapture,
    toStage: RendererRolloutStage,
    incompatibilities: RollbackIncompatibility[],
  ): void {
    // If the current anchor references a semantic anchor that only exists
    // in the canonical projection and we're rolling back to legacy-only
    if (
      current.readerAnchor.semanticAnchor &&
      toStage < 2 &&
      current.stage >= 3 &&
      !target.readerAnchor.semanticAnchor
    ) {
      // Anchor fallback will be used — this is not blocking, but documented
      // We only flag this as incompatible if the anchor cannot possibly be recovered
      // The documented fallback (latest/focus) handles this gracefully
      // So we do NOT push an incompatibility here — the anchor controller
      // handles this through its unavailable/fallback path
    }
  }

  /**
   * Check pending actions compatibility with the target stage.
   */
  private checkPendingActionsCompatibility(
    toStage: RendererRolloutStage,
    incompatibilities: RollbackIncompatibility[],
  ): void {
    for (const action of this.pendingActions) {
      if (action.requiresCanonicalProjection && toStage < 3) {
        incompatibilities.push({
          kind: 'pending_actions_require_canonical',
          description:
            `Pending action '${action.actionId}' (${action.kind}) requires canonical projection ` +
            `which is not available at stage ${toStage}`,
          affectedIdentity: action.actionId,
        });
      }
    }
  }

  /**
   * Check pending decisions compatibility with the target stage.
   */
  private checkPendingDecisionsCompatibility(
    toStage: RendererRolloutStage,
    incompatibilities: RollbackIncompatibility[],
  ): void {
    for (const decision of this.pendingDecisions) {
      if (decision.requiresCanonicalProjection && toStage < 3) {
        incompatibilities.push({
          kind: 'pending_decisions_require_canonical',
          description:
            `Pending decision '${decision.decisionId}' (key: ${decision.collaborationKey}) ` +
            `requires canonical projection which is not available at stage ${toStage}`,
          affectedIdentity: decision.decisionId,
        });
      }
    }
  }

  /**
   * Check if any incompatibilities are drainable (pending actions/decisions that may settle).
   */
  private hasDrainableIncompatibilities(incompatibilities: RollbackIncompatibility[]): boolean {
    return (
      incompatibilities.length > 0 &&
      incompatibilities.every(
        (i) =>
          i.kind === 'pending_actions_require_canonical' ||
          i.kind === 'pending_decisions_require_canonical' ||
          i.kind === 'draft_has_pending_submission',
      )
    );
  }

  /**
   * Derive authority-based recovery information from incompatibilities.
   */
  private deriveRecoveryInfo(incompatibilities: RollbackIncompatibility[]): RecoveryInfo {
    // Prioritize the most actionable recovery path
    const hasProjectionIncompat = incompatibilities.some(
      (i) => i.kind === 'projection_checkpoint_incompatible',
    );
    const hasPendingDecisions = incompatibilities.some(
      (i) => i.kind === 'pending_decisions_require_canonical',
    );

    if (hasPendingDecisions) {
      return {
        reason: 'Pending decisions must settle before rollback is possible',
        requiredAction: 'await_decision_settlement',
        authorityRef: 'collaboration-authority',
        retainedState: 'last_compatible',
      };
    }

    if (hasProjectionIncompat) {
      return {
        reason: 'Current projection state cannot be represented at the target stage',
        requiredAction: 'obtain_compatible_checkpoint',
        authorityRef: 'projection-service',
        retainedState: 'last_compatible',
      };
    }

    return {
      reason: 'Rollback blocked due to state incompatibility',
      requiredAction: 'obtain_compatible_checkpoint',
      authorityRef: 'projection-service',
      retainedState: 'last_compatible',
    };
  }
}
