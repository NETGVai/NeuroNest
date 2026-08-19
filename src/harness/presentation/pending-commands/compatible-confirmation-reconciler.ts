import type { ActionRiskV1, AuthorityRefV1 } from '../../contracts/response-support';

/** Fields that must remain unchanged for a projected action to remain compatible. */
export interface ActionCompatibilitySnapshot {
  readonly sourceRevision: number;
  readonly scopeDigest?: string;
  readonly argumentsDigest?: string;
  readonly owner: AuthorityRefV1;
  readonly risk?: ActionRiskV1;
  readonly toolVersion?: string;
  readonly planRevision?: number;
  readonly expiresAt?: string;
  readonly approvalDigest?: string;
}

export type ProjectedActionOutcome =
  | 'confirmed'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'superseded';

export type TransportReceiptState = 'none' | 'accepted' | 'rejected';

export interface PendingActionSubmission<TAuthorityState> {
  readonly commandId: string;
  readonly actionId: string;
  readonly expectedProjectionRevision: number;
  readonly compatibility: ActionCompatibilitySnapshot;
  /** Last authority-projected state; never replaced by a transport receipt. */
  readonly authorityState: TAuthorityState;
}

export interface ProjectedActionSnapshot {
  readonly actionId: string;
  readonly compatibility: ActionCompatibilitySnapshot;
}

export interface ProjectedActionResolution<TAuthorityState> {
  readonly commandId: string;
  readonly actionId: string;
  readonly outcome: ProjectedActionOutcome;
  readonly observedSourceRevision: number;
  /** Echo of the exact compatibility snapshot to which the authority responded. */
  readonly compatibility: ActionCompatibilitySnapshot;
  readonly authorityState: TAuthorityState;
}

export interface ActionConfirmationProjection<TAuthorityState> {
  readonly projectionRevision: number;
  readonly projectedAt: string;
  readonly actions?: readonly ProjectedActionSnapshot[];
  readonly resolutions: readonly ProjectedActionResolution<TAuthorityState>[];
}

export interface PendingActionReconciliationView<TAuthorityState> {
  readonly commandId: string;
  readonly actionId: string;
  readonly status: 'pending' | ProjectedActionOutcome;
  readonly submissionPending: boolean;
  readonly transportReceipt: TransportReceiptState;
  readonly authorityState: TAuthorityState;
  readonly controlsValid: boolean;
  readonly invalidatedFields: readonly CompatibilityField[];
  readonly expectedProjectionRevision: number;
  readonly confirmingProjectionRevision?: number;
}

export type CompatibilityField =
  | 'sourceRevision'
  | 'scopeDigest'
  | 'argumentsDigest'
  | 'owner'
  | 'risk'
  | 'toolVersion'
  | 'planRevision'
  | 'expiresAt'
  | 'approvalDigest';

export interface ActionReconciliationResult {
  readonly applied: boolean;
  readonly reason?: 'stale_projection';
  readonly projectionRevision: number;
  readonly settledCommandIds: readonly string[];
  readonly invalidatedActionIds: readonly string[];
  readonly ignoredResolutionCount: number;
}

interface MutablePendingAction<TAuthorityState> {
  commandId: string;
  actionId: string;
  expectedProjectionRevision: number;
  compatibility: ActionCompatibilitySnapshot;
  status: 'pending' | ProjectedActionOutcome;
  submissionPending: boolean;
  transportReceipt: TransportReceiptState;
  authorityState: TAuthorityState;
  controlsValid: boolean;
  invalidatedFields: CompatibilityField[];
  confirmingProjectionRevision?: number;
}

/**
 * Reconciles renderer-local submission state with authority-owned projections.
 *
 * Transport receipts can only annotate submission progress. A durable outcome is
 * accepted only from a newer projection that names the exact command and action,
 * carries a compatible action snapshot, and does not precede the expected source
 * revision. The last projected domain state is retained until that point.
 *
 * Requirements: 8.7, 9.5-9.12, 10.6, 13.9-13.11, 14.11.
 */
export class CompatibleConfirmationReconciler<TAuthorityState> {
  private readonly entries = new Map<string, MutablePendingAction<TAuthorityState>>();
  private lastProjectionRevision: number;

  constructor(initialProjectionRevision = 0) {
    this.lastProjectionRevision = initialProjectionRevision;
  }

  track(submission: PendingActionSubmission<TAuthorityState>): PendingActionReconciliationView<TAuthorityState> {
    const entry: MutablePendingAction<TAuthorityState> = {
      ...submission,
      status: 'pending',
      submissionPending: true,
      transportReceipt: 'none',
      controlsValid: true,
      invalidatedFields: [],
    };
    this.entries.set(submission.commandId, entry);
    return toView(entry);
  }

  get(commandId: string): PendingActionReconciliationView<TAuthorityState> | undefined {
    const entry = this.entries.get(commandId);
    return entry === undefined ? undefined : toView(entry);
  }

  getProjectionRevision(): number {
    return this.lastProjectionRevision;
  }

  /** Records transport progress without changing projected domain state. */
  recordTransportReceipt(commandId: string, actionId: string, accepted: boolean): boolean {
    const entry = this.entries.get(commandId);
    if (entry === undefined || entry.actionId !== actionId || entry.status !== 'pending') {
      return false;
    }
    entry.transportReceipt = accepted ? 'accepted' : 'rejected';
    return true;
  }

  reconcile(projection: ActionConfirmationProjection<TAuthorityState>): ActionReconciliationResult {
    if (projection.projectionRevision <= this.lastProjectionRevision) {
      return {
        applied: false,
        reason: 'stale_projection',
        projectionRevision: projection.projectionRevision,
        settledCommandIds: [],
        invalidatedActionIds: [],
        ignoredResolutionCount: projection.resolutions.length,
      };
    }

    this.lastProjectionRevision = projection.projectionRevision;
    const invalidatedActionIds = new Set<string>();
    const incompatibleActions = new Set<string>();

    for (const projectedAction of projection.actions ?? []) {
      for (const entry of this.entries.values()) {
        if (entry.status !== 'pending' || entry.actionId !== projectedAction.actionId) continue;
        const changed = changedCompatibilityFields(entry.compatibility, projectedAction.compatibility);
        if (changed.length === 0) continue;
        entry.controlsValid = false;
        entry.invalidatedFields = mergeFields(entry.invalidatedFields, changed);
        invalidatedActionIds.add(entry.actionId);
        incompatibleActions.add(entry.actionId);
      }
    }

    const settledCommandIds: string[] = [];
    let ignoredResolutionCount = 0;

    for (const entry of this.entries.values()) {
      if (entry.status !== 'pending') continue;

      const exact = projection.resolutions.filter(
        (resolution) => resolution.commandId === entry.commandId && resolution.actionId === entry.actionId,
      );
      const compatible = exact.filter(
        (resolution) =>
          !incompatibleActions.has(entry.actionId)
          && resolution.observedSourceRevision >= entry.compatibility.sourceRevision
          && changedCompatibilityFields(entry.compatibility, resolution.compatibility).length === 0,
      );

      ignoredResolutionCount += projection.resolutions.filter(
        (resolution) => resolution.commandId === entry.commandId,
      ).length - compatible.length;

      if (compatible.length === 0 || projection.projectionRevision <= entry.expectedProjectionRevision) {
        continue;
      }

      const selected = selectResolution(compatible);
      entry.status = selected.outcome;
      entry.submissionPending = false;
      entry.authorityState = selected.authorityState;
      entry.confirmingProjectionRevision = projection.projectionRevision;
      settledCommandIds.push(entry.commandId);
    }

    const knownCommandIds = new Set(this.entries.keys());
    ignoredResolutionCount += projection.resolutions.filter(
      (resolution) => !knownCommandIds.has(resolution.commandId),
    ).length;

    return {
      applied: true,
      projectionRevision: projection.projectionRevision,
      settledCommandIds,
      invalidatedActionIds: [...invalidatedActionIds],
      ignoredResolutionCount,
    };
  }
}

export function changedCompatibilityFields(
  expected: ActionCompatibilitySnapshot,
  observed: ActionCompatibilitySnapshot,
): CompatibilityField[] {
  const changed: CompatibilityField[] = [];
  if (expected.sourceRevision !== observed.sourceRevision) changed.push('sourceRevision');
  if (expected.scopeDigest !== observed.scopeDigest) changed.push('scopeDigest');
  if (expected.argumentsDigest !== observed.argumentsDigest) changed.push('argumentsDigest');
  if (!sameOwner(expected.owner, observed.owner)) changed.push('owner');
  if (expected.risk !== observed.risk) changed.push('risk');
  if (expected.toolVersion !== observed.toolVersion) changed.push('toolVersion');
  if (expected.planRevision !== observed.planRevision) changed.push('planRevision');
  if (expected.expiresAt !== observed.expiresAt) changed.push('expiresAt');
  if (expected.approvalDigest !== observed.approvalDigest) changed.push('approvalDigest');
  return changed;
}

function sameOwner(left: AuthorityRefV1, right: AuthorityRefV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.authorityKind === right.authorityKind
    && left.authorityId === right.authorityId;
}

function mergeFields(
  current: readonly CompatibilityField[],
  next: readonly CompatibilityField[],
): CompatibilityField[] {
  return [...new Set([...current, ...next])];
}

function selectResolution<TAuthorityState>(
  resolutions: readonly ProjectedActionResolution<TAuthorityState>[],
): ProjectedActionResolution<TAuthorityState> {
  // A compatible positive confirmation wins over conflicting negative responses.
  return resolutions.find((resolution) => resolution.outcome === 'completed')
    ?? resolutions.find((resolution) => resolution.outcome === 'confirmed')
    ?? resolutions[0];
}

function toView<TAuthorityState>(
  entry: MutablePendingAction<TAuthorityState>,
): PendingActionReconciliationView<TAuthorityState> {
  return {
    commandId: entry.commandId,
    actionId: entry.actionId,
    status: entry.status,
    submissionPending: entry.submissionPending,
    transportReceipt: entry.transportReceipt,
    authorityState: entry.authorityState,
    controlsValid: entry.controlsValid,
    invalidatedFields: [...entry.invalidatedFields],
    expectedProjectionRevision: entry.expectedProjectionRevision,
    ...(entry.confirmingProjectionRevision === undefined
      ? {}
      : { confirmingProjectionRevision: entry.confirmingProjectionRevision }),
  };
}
