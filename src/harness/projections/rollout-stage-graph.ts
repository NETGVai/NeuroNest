/**
 * Rollout Stage Graph — 7-stage migration pipeline with ownership enforcement.
 *
 * Encodes stages 0–6 with declared ingress, projection, renderer, and mutation
 * owners. Rejects any stage where more than one projection owner can mutate a
 * session/turn. Advancement only occurs when stage evidence passes.
 *
 * Extends the existing ProjectionOwnershipGuard with the full stage graph from
 * design section 16.1.
 *
 * Requirements: 21.1, 21.6, 21.12, 22.9–22.10, 22.12
 */

import {
  PROJECTION_PARTICIPANTS,
  type ProjectionParticipant,
} from './projection-ownership.js';

// ─── Stage Identifiers ──────────────────────────────────────────

/**
 * The seven rollout stages, ordered 0–6. Each stage has exactly one
 * declared owner for ingress, projection, rendering, and mutation.
 */
export type RolloutStageId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const ROLLOUT_STAGE_IDS: readonly RolloutStageId[] = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

export const ROLLOUT_STAGE_NAMES: Readonly<Record<RolloutStageId, string>> = Object.freeze({
  0: 'legacy_only',
  1: 'normalize_and_shadow',
  2: 'hidden_canonical_read_model',
  3: 'canonical_generic_timeline',
  4: 'typed_surfaces',
  5: 'canonical_interaction_owner',
  6: 'retirement',
});

// ─── Ownership Declaration ──────────────────────────────────────

/**
 * Declared ownership at a given stage. Exactly one projection owner
 * may mutate Chat_Nodes for a session/turn.
 */
export interface StageOwnershipDeclaration {
  readonly stageId: RolloutStageId;
  readonly name: string;
  readonly ingressOwner: string;
  readonly projectionOwner: ProjectionParticipant;
  readonly rendererOwner: string;
  readonly mutationOwner: ProjectionParticipant;
}

const EXISTING_IPC = 'ExistingIPC';
const ADAPTER_NORMALIZED = 'AdapterNormalizedFacts';
const ADAPTER_OR_CANONICAL = 'AdapterNormalized/CanonicalProducers';
const LEGACY_RENDERER = 'LegacyRenderer';
const CANONICAL_GENERIC = 'CanonicalGenericBlocks';
const TYPED_SURFACES = 'TypedSurfaces';
const TYPED_SURFACES_ONLY = 'TypedSurfacesOnly';
const EXISTING_AUTHORITIES = 'ExistingAuthorities';
const TYPED_AUTHORITY_PORT = 'TypedAuthorityPort';
const TYPED_AUTHORITIES_ONLY = 'TypedAuthoritiesOnly';

/**
 * The complete stage ownership table matching design section 16.1.
 */
export const STAGE_OWNERSHIP: Readonly<Record<RolloutStageId, StageOwnershipDeclaration>> = Object.freeze({
  0: Object.freeze({
    stageId: 0 as RolloutStageId,
    name: 'legacy_only',
    ingressOwner: EXISTING_IPC,
    projectionOwner: PROJECTION_PARTICIPANTS.legacyAdapter,
    rendererOwner: LEGACY_RENDERER,
    mutationOwner: PROJECTION_PARTICIPANTS.legacyAdapter,
  }),
  1: Object.freeze({
    stageId: 1 as RolloutStageId,
    name: 'normalize_and_shadow',
    ingressOwner: EXISTING_IPC,
    projectionOwner: PROJECTION_PARTICIPANTS.legacyAdapter,
    rendererOwner: LEGACY_RENDERER,
    mutationOwner: PROJECTION_PARTICIPANTS.legacyAdapter,
  }),
  2: Object.freeze({
    stageId: 2 as RolloutStageId,
    name: 'hidden_canonical_read_model',
    ingressOwner: ADAPTER_NORMALIZED,
    projectionOwner: PROJECTION_PARTICIPANTS.legacyAdapter,
    rendererOwner: LEGACY_RENDERER,
    mutationOwner: PROJECTION_PARTICIPANTS.legacyAdapter,
  }),
  3: Object.freeze({
    stageId: 3 as RolloutStageId,
    name: 'canonical_generic_timeline',
    ingressOwner: ADAPTER_NORMALIZED,
    projectionOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
    rendererOwner: CANONICAL_GENERIC,
    mutationOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
  }),
  4: Object.freeze({
    stageId: 4 as RolloutStageId,
    name: 'typed_surfaces',
    ingressOwner: ADAPTER_NORMALIZED,
    projectionOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
    rendererOwner: TYPED_SURFACES,
    mutationOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
  }),
  5: Object.freeze({
    stageId: 5 as RolloutStageId,
    name: 'canonical_interaction_owner',
    ingressOwner: ADAPTER_OR_CANONICAL,
    projectionOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
    rendererOwner: TYPED_SURFACES,
    mutationOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
  }),
  6: Object.freeze({
    stageId: 6 as RolloutStageId,
    name: 'retirement',
    ingressOwner: ADAPTER_OR_CANONICAL,
    projectionOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
    rendererOwner: TYPED_SURFACES_ONLY,
    mutationOwner: PROJECTION_PARTICIPANTS.canonicalProjection,
  }),
});

// ─── Transition Rules ───────────────────────────────────────────

/**
 * Allowed forward and backward transitions for each stage. Transitions
 * may only proceed one step at a time; skipping is never allowed.
 */
export const STAGE_TRANSITIONS: Readonly<Record<RolloutStageId, readonly RolloutStageId[]>> = Object.freeze({
  0: Object.freeze([1] as const),
  1: Object.freeze([0, 2] as const),
  2: Object.freeze([1, 3] as const),
  3: Object.freeze([2, 4] as const),
  4: Object.freeze([3, 5] as const),
  5: Object.freeze([4, 6] as const),
  6: Object.freeze([5] as const),
});

// ─── Stage Evidence ─────────────────────────────────────────────

/**
 * Evidence required before advancing from one stage to the next.
 * All evidence items must pass before a forward transition is accepted.
 */
export type StageEvidenceKind =
  | 'adapter_fixtures'
  | 'row_block_parity'
  | 'ipc_gates'
  | 'accessibility_gate'
  | 'security_gate'
  | 'performance_parity'
  | 'surface_family_parity'
  | 'action_confirmation_parity'
  | 'composer_parity'
  | 'manual_acceptance'
  | 'soak_pass';

export interface StageEvidenceItem {
  readonly kind: StageEvidenceKind;
  readonly passed: boolean;
  readonly revision: number;
  readonly checkedAt: number;
}

/**
 * Evidence required for each forward transition (from → to).
 */
export const FORWARD_EVIDENCE_REQUIREMENTS: Readonly<Record<string, readonly StageEvidenceKind[]>> = Object.freeze({
  '0->1': Object.freeze(['adapter_fixtures'] as const),
  '1->2': Object.freeze(['row_block_parity', 'ipc_gates'] as const),
  '2->3': Object.freeze(['accessibility_gate', 'security_gate', 'performance_parity'] as const),
  '3->4': Object.freeze(['surface_family_parity'] as const),
  '4->5': Object.freeze(['action_confirmation_parity', 'composer_parity'] as const),
  '5->6': Object.freeze(['manual_acceptance', 'soak_pass'] as const),
});

// ─── Scope ──────────────────────────────────────────────────────

export interface RolloutStageScope {
  readonly sessionId: string;
  readonly branchId: string;
  readonly turnId: string;
  readonly windowId: string;
  readonly rolloutEpoch: string;
}

// ─── Transition Result ──────────────────────────────────────────

export type StageTransitionResult =
  | { readonly accepted: true; readonly fromStage: RolloutStageId; readonly toStage: RolloutStageId; readonly revision: number }
  | { readonly accepted: false; readonly reason: StageTransitionRejectionReason; readonly currentStage: RolloutStageId };

export type StageTransitionRejectionReason =
  | 'invalid_transition'
  | 'evidence_not_met'
  | 'same_stage'
  | 'concurrent_owner_conflict';

// ─── Mutation Result ────────────────────────────────────────────

export type StageMutationResult<T> =
  | { readonly accepted: true; readonly value: T; readonly owner: ProjectionParticipant }
  | { readonly accepted: false; readonly reason: StageMutationRejectionReason; readonly activeOwner: ProjectionParticipant; readonly currentStage: RolloutStageId };

export type StageMutationRejectionReason =
  | 'participant_ineligible'
  | 'inactive_owner'
  | 'concurrent_session_conflict';

// ─── Snapshot ───────────────────────────────────────────────────

export interface RolloutStageSnapshot {
  readonly scope: RolloutStageScope;
  readonly stageId: RolloutStageId;
  readonly stageName: string;
  readonly ownership: StageOwnershipDeclaration;
  readonly revision: number;
  readonly startedAt: number;
}

// ─── Registry (per-window concurrent session tracking) ──────────

/**
 * Tracks per-session stage instances to enforce that no two windows
 * or sessions have conflicting projection owners for the same turn.
 */
export class RolloutStageRegistry {
  private readonly instances = new Map<string, RolloutStageEnforcer>();

  private static scopeKey(sessionId: string, branchId: string, turnId: string): string {
    return `${sessionId}::${branchId}::${turnId}`;
  }

  /**
   * Register or retrieve an enforcer for a scope. If an enforcer already
   * exists for the same session/branch/turn, it is returned (enforcing
   * single-window ownership). Different windows for the same logical
   * turn must use the same enforcer instance.
   */
  getOrCreate(scope: RolloutStageScope, initialStage?: RolloutStageId): RolloutStageEnforcer {
    const key = RolloutStageRegistry.scopeKey(scope.sessionId, scope.branchId, scope.turnId);
    let existing = this.instances.get(key);
    if (existing) {
      // Validate no conflicting window claims the same turn at a different stage
      if (existing.snapshot().scope.windowId !== scope.windowId) {
        existing.registerWindow(scope.windowId);
      }
      return existing;
    }
    existing = new RolloutStageEnforcer(scope, initialStage);
    this.instances.set(key, existing);
    return existing;
  }

  /**
   * Check if any concurrent enforcer exists for the same session/branch/turn.
   */
  has(sessionId: string, branchId: string, turnId: string): boolean {
    return this.instances.has(RolloutStageRegistry.scopeKey(sessionId, branchId, turnId));
  }

  /**
   * Remove a scope (e.g., after session end or window close).
   */
  remove(sessionId: string, branchId: string, turnId: string): boolean {
    return this.instances.delete(RolloutStageRegistry.scopeKey(sessionId, branchId, turnId));
  }

  /**
   * Recover all enforcers after process restart using persisted snapshots.
   */
  restoreFromSnapshots(snapshots: readonly RolloutStageSnapshot[]): void {
    for (const snapshot of snapshots) {
      const key = RolloutStageRegistry.scopeKey(
        snapshot.scope.sessionId,
        snapshot.scope.branchId,
        snapshot.scope.turnId,
      );
      if (!this.instances.has(key)) {
        const enforcer = new RolloutStageEnforcer(snapshot.scope, snapshot.stageId);
        this.instances.set(key, enforcer);
      }
    }
  }

  /**
   * Get all current snapshots (for persistence/recovery).
   */
  allSnapshots(): readonly RolloutStageSnapshot[] {
    return [...this.instances.values()].map((e) => e.snapshot());
  }

  /**
   * Clear all instances (for testing or shutdown).
   */
  clear(): void {
    this.instances.clear();
  }

  get size(): number {
    return this.instances.size;
  }
}

// ─── Enforcer ───────────────────────────────────────────────────

/**
 * RolloutStageEnforcer encodes the complete 7-stage (0–6) rollout pipeline
 * with declared ingress, projection, renderer, and mutation owners.
 *
 * It rejects:
 * - Any stage where more than one projection owner can mutate a session/turn
 * - Transitions that skip stages
 * - Forward transitions without passing evidence
 * - Mutations by non-owners
 *
 * Backward transitions (rollbacks) do not require evidence.
 */
export class RolloutStageEnforcer {
  private currentStage: RolloutStageId;
  private revision = 0;
  private readonly scope: RolloutStageScope;
  private readonly startedAt: number;
  private readonly windows: Set<string>;
  private evidence: Map<string, StageEvidenceItem[]>;

  constructor(scope: RolloutStageScope, initialStage: RolloutStageId = 0) {
    this.scope = Object.freeze({ ...scope });
    this.currentStage = initialStage;
    this.startedAt = Date.now();
    this.windows = new Set([scope.windowId]);
    this.evidence = new Map();
  }

  // ─── Queries ────────────────────────────────────────────────

  snapshot(): RolloutStageSnapshot {
    return Object.freeze({
      scope: this.scope,
      stageId: this.currentStage,
      stageName: ROLLOUT_STAGE_NAMES[this.currentStage],
      ownership: STAGE_OWNERSHIP[this.currentStage],
      revision: this.revision,
      startedAt: this.startedAt,
    });
  }

  getCurrentStage(): RolloutStageId {
    return this.currentStage;
  }

  getOwnership(): StageOwnershipDeclaration {
    return STAGE_OWNERSHIP[this.currentStage];
  }

  getProjectionOwner(): ProjectionParticipant {
    return STAGE_OWNERSHIP[this.currentStage].projectionOwner;
  }

  getMutationOwner(): ProjectionParticipant {
    return STAGE_OWNERSHIP[this.currentStage].mutationOwner;
  }

  getRegisteredWindows(): readonly string[] {
    return [...this.windows];
  }

  // ─── Window Registration ────────────────────────────────────

  /**
   * Register an additional window accessing this scope.
   * All windows share the same stage and ownership.
   */
  registerWindow(windowId: string): void {
    this.windows.add(windowId);
  }

  unregisterWindow(windowId: string): boolean {
    return this.windows.delete(windowId);
  }

  // ─── Evidence Management ────────────────────────────────────

  /**
   * Record evidence for a specific forward transition.
   */
  recordEvidence(fromStage: RolloutStageId, toStage: RolloutStageId, item: StageEvidenceItem): void {
    const key = `${fromStage}->${toStage}`;
    const existing = this.evidence.get(key) ?? [];
    // Replace existing evidence of the same kind
    const filtered = existing.filter((e) => e.kind !== item.kind);
    filtered.push(item);
    this.evidence.set(key, filtered);
  }

  /**
   * Check if all required evidence passes for a forward transition.
   */
  hasRequiredEvidence(fromStage: RolloutStageId, toStage: RolloutStageId): boolean {
    const key = `${fromStage}->${toStage}`;
    const required = FORWARD_EVIDENCE_REQUIREMENTS[key];
    if (!required || required.length === 0) {
      return true;
    }

    const recorded = this.evidence.get(key) ?? [];
    return required.every((kind) => {
      const item = recorded.find((e) => e.kind === kind);
      return item !== undefined && item.passed;
    });
  }

  /**
   * Get the evidence status for a transition.
   */
  getEvidenceStatus(fromStage: RolloutStageId, toStage: RolloutStageId): {
    readonly required: readonly StageEvidenceKind[];
    readonly satisfied: readonly StageEvidenceKind[];
    readonly missing: readonly StageEvidenceKind[];
  } {
    const key = `${fromStage}->${toStage}`;
    const required = FORWARD_EVIDENCE_REQUIREMENTS[key] ?? [];
    const recorded = this.evidence.get(key) ?? [];

    const satisfied = required.filter((kind) => {
      const item = recorded.find((e) => e.kind === kind);
      return item !== undefined && item.passed;
    });
    const missing = required.filter((kind) => !satisfied.includes(kind));

    return Object.freeze({ required, satisfied, missing });
  }

  // ─── Transitions ────────────────────────────────────────────

  /**
   * Attempt a stage transition. Forward transitions require evidence;
   * backward transitions (rollbacks) do not.
   */
  transition(toStage: RolloutStageId): StageTransitionResult {
    if (toStage === this.currentStage) {
      return Object.freeze({
        accepted: false,
        reason: 'same_stage' as const,
        currentStage: this.currentStage,
      });
    }

    // Check if the transition is in the allowed graph
    const allowed = STAGE_TRANSITIONS[this.currentStage];
    if (!allowed.includes(toStage)) {
      return Object.freeze({
        accepted: false,
        reason: 'invalid_transition' as const,
        currentStage: this.currentStage,
      });
    }

    // Forward transitions require evidence
    const isForward = toStage > this.currentStage;
    if (isForward && !this.hasRequiredEvidence(this.currentStage, toStage)) {
      return Object.freeze({
        accepted: false,
        reason: 'evidence_not_met' as const,
        currentStage: this.currentStage,
      });
    }

    const fromStage = this.currentStage;
    this.currentStage = toStage;
    this.revision += 1;

    return Object.freeze({
      accepted: true,
      fromStage,
      toStage,
      revision: this.revision,
    });
  }

  // ─── Mutation Enforcement ───────────────────────────────────

  /**
   * Attempt a mutation by a given participant at the current stage.
   * Enforces that exactly one projection owner can mutate.
   */
  attemptMutation<T>(participant: ProjectionParticipant, mutation: () => T): StageMutationResult<T> {
    const ownership = STAGE_OWNERSHIP[this.currentStage];

    // Check if participant is the declared mutation owner
    if (ownership.mutationOwner !== participant) {
      // Determine the rejection reason
      const isAnyOwnerEligible = ROLLOUT_STAGE_IDS.some(
        (s) => STAGE_OWNERSHIP[s].mutationOwner === participant,
      );
      const reason: StageMutationRejectionReason = isAnyOwnerEligible
        ? 'inactive_owner'
        : 'participant_ineligible';

      return Object.freeze({
        accepted: false,
        reason,
        activeOwner: ownership.mutationOwner,
        currentStage: this.currentStage,
      });
    }

    // Execute the mutation
    const value = mutation();
    return Object.freeze({
      accepted: true,
      value,
      owner: participant,
    });
  }

  /**
   * Check if a participant can mutate at the current stage without
   * actually executing a mutation.
   */
  canMutate(participant: ProjectionParticipant): boolean {
    return STAGE_OWNERSHIP[this.currentStage].mutationOwner === participant;
  }

  /**
   * Validate that at most one projection owner exists for the current stage.
   * This is a structural invariant check — it always returns true for valid
   * stage configurations but can be used as a runtime assertion.
   */
  validateSingleOwnerInvariant(): boolean {
    const ownership = STAGE_OWNERSHIP[this.currentStage];
    // The invariant is that projectionOwner and mutationOwner are the same participant
    return ownership.projectionOwner === ownership.mutationOwner;
  }
}

// ─── Validation Utilities ───────────────────────────────────────

/**
 * Validate that the stage graph has no stage where more than one
 * projection owner can mutate. This is a compile-time/startup assertion.
 */
export function validateStageGraphIntegrity(): {
  readonly valid: boolean;
  readonly violations: readonly string[];
} {
  const violations: string[] = [];

  for (const stageId of ROLLOUT_STAGE_IDS) {
    const ownership = STAGE_OWNERSHIP[stageId];

    // Rule 1: projectionOwner and mutationOwner must be the same
    if (ownership.projectionOwner !== ownership.mutationOwner) {
      violations.push(
        `Stage ${stageId} (${ownership.name}): projection owner ` +
        `'${ownership.projectionOwner}' differs from mutation owner '${ownership.mutationOwner}'`,
      );
    }

    // Rule 2: Only LegacyResponseAdapter and CanonicalProjectionService can be projection owners
    const validOwners: ProjectionParticipant[] = [
      PROJECTION_PARTICIPANTS.legacyAdapter,
      PROJECTION_PARTICIPANTS.canonicalProjection,
    ];
    if (!validOwners.includes(ownership.projectionOwner)) {
      violations.push(
        `Stage ${stageId} (${ownership.name}): invalid projection owner '${ownership.projectionOwner}'`,
      );
    }

    // Rule 3: ChatPanel, ChatService, timeline, richResponseServices can never be owners
    const forbiddenOwners: ProjectionParticipant[] = [
      PROJECTION_PARTICIPANTS.chatPanel,
      PROJECTION_PARTICIPANTS.chatService,
      PROJECTION_PARTICIPANTS.timeline,
      PROJECTION_PARTICIPANTS.richResponseServices,
    ];
    if (forbiddenOwners.includes(ownership.projectionOwner)) {
      violations.push(
        `Stage ${stageId} (${ownership.name}): forbidden participant '${ownership.projectionOwner}' declared as owner`,
      );
    }
  }

  // Rule 4: Transition graph must be symmetric for rollback and single-step
  for (const stageId of ROLLOUT_STAGE_IDS) {
    const targets = STAGE_TRANSITIONS[stageId];
    for (const target of targets) {
      // Every forward/backward edge must only connect adjacent stages
      if (Math.abs(target - stageId) > 1) {
        violations.push(
          `Stage ${stageId}: transition to stage ${target} skips intermediate stages`,
        );
      }
    }
  }

  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze([...violations]),
  });
}

/**
 * Check that two concurrent scopes for the same session/turn do not have
 * conflicting projection owners (i.e., they are at the same stage).
 */
export function validateConcurrentOwnership(
  scopeA: RolloutStageSnapshot,
  scopeB: RolloutStageSnapshot,
): { readonly compatible: boolean; readonly reason?: string } {
  // Different sessions are always compatible
  if (scopeA.scope.sessionId !== scopeB.scope.sessionId ||
      scopeA.scope.branchId !== scopeB.scope.branchId ||
      scopeA.scope.turnId !== scopeB.scope.turnId) {
    return Object.freeze({ compatible: true });
  }

  // Same session/branch/turn must have the same stage
  if (scopeA.stageId !== scopeB.stageId) {
    return Object.freeze({
      compatible: false,
      reason: `Concurrent windows at different stages (${scopeA.stageId} vs ${scopeB.stageId}) for session ${scopeA.scope.sessionId}, turn ${scopeA.scope.turnId}`,
    });
  }

  return Object.freeze({ compatible: true });
}
