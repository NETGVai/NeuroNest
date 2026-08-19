import type { AuthorityRefV1 } from '../../contracts/response-support';

/**
 * Authority-owned duplicate protection for consequential submissions.
 *
 * The guard reserves an action/key pair synchronously before transport starts,
 * so rapid activations cannot race. Ambiguous transport outcomes remain
 * reserved. A replay is possible only when both caller policy and a prior,
 * matching authority receipt explicitly permit it.
 *
 * Requirements: 13.8, 14.11, 20.5
 */

export type ProtectedActionClassV1 =
  | 'authority_command'
  | 'durable_follow_up'
  | 'recovery';

export type ReplayPolicyV1 = 'never' | 'authority_receipt';

export type ProtectedSubmissionStateV1 =
  | 'pending'
  | 'transport_ambiguous'
  | 'accepted'
  | 'rejected';

export type DuplicateProtectionFailureReasonV1 =
  | 'missing_idempotency_key'
  | 'duplicate_pending'
  | 'duplicate_accepted'
  | 'replay_not_authorized';

export interface NonIdempotentSubmissionRequestV1 {
  actionId: string;
  actionClass: ProtectedActionClassV1;
  idempotencyKey?: string;
  replayPolicy: ReplayPolicyV1;
}

export interface SubmissionReservationV1 {
  authority: AuthorityRefV1;
  actionId: string;
  actionClass: ProtectedActionClassV1;
  idempotencyKey: string;
  attempt: number;
  replay: boolean;
}

export type SubmissionReservationResultV1 =
  | { accepted: true; reservation: SubmissionReservationV1 }
  | {
      accepted: false;
      reason: DuplicateProtectionFailureReasonV1;
      state?: ProtectedSubmissionStateV1;
    };

export interface AuthoritySubmissionReceiptV1 {
  schemaVersion: 1;
  receiptId: string;
  authority: AuthorityRefV1;
  actionId: string;
  idempotencyKey: string;
  attempt: number;
  outcome: 'accepted' | 'rejected';
  replayAuthorization: 'forbidden' | 'authorized';
}

export type ReceiptRecordFailureReasonV1 =
  | 'authority_mismatch'
  | 'reservation_not_found'
  | 'reservation_mismatch'
  | 'receipt_already_recorded';

export type ReceiptRecordResultV1 =
  | { recorded: true; state: 'accepted' | 'rejected' }
  | { recorded: false; reason: ReceiptRecordFailureReasonV1 };

export interface ProtectedSubmissionSnapshotV1 {
  actionId: string;
  actionClass: ProtectedActionClassV1;
  idempotencyKey: string;
  attempt: number;
  state: ProtectedSubmissionStateV1;
  receipt?: AuthoritySubmissionReceiptV1;
}

interface ProtectedSubmissionEntry {
  actionId: string;
  actionClass: ProtectedActionClassV1;
  idempotencyKey: string;
  attempt: number;
  state: ProtectedSubmissionStateV1;
  receipt?: AuthoritySubmissionReceiptV1;
}

function sameAuthority(left: AuthorityRefV1, right: AuthorityRefV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.authorityKind === right.authorityKind &&
    left.authorityId === right.authorityId;
}

function operationIdentity(actionId: string, idempotencyKey: string): string {
  return JSON.stringify([actionId, idempotencyKey]);
}

function copyAuthority(authority: AuthorityRefV1): AuthorityRefV1 {
  return Object.freeze({ ...authority });
}

function copyReceipt(receipt: AuthoritySubmissionReceiptV1): AuthoritySubmissionReceiptV1 {
  return Object.freeze({
    ...receipt,
    authority: copyAuthority(receipt.authority),
  });
}

/**
 * One instance belongs to exactly one command authority. Idempotency keys never
 * move to renderer-local or cross-authority state.
 */
export class OwningAuthorityDuplicateGuard {
  private readonly authority: AuthorityRefV1;
  private readonly submissions = new Map<string, ProtectedSubmissionEntry>();

  constructor(authority: AuthorityRefV1) {
    this.authority = copyAuthority(authority);
  }

  getAuthority(): AuthorityRefV1 {
    return copyAuthority(this.authority);
  }

  /**
   * Atomically reserves a non-idempotent action before transport submission.
   */
  reserve(request: NonIdempotentSubmissionRequestV1): SubmissionReservationResultV1 {
    if (!request.idempotencyKey || request.idempotencyKey.trim().length === 0) {
      return { accepted: false, reason: 'missing_idempotency_key' };
    }

    const identity = operationIdentity(request.actionId, request.idempotencyKey);
    const existing = this.submissions.get(identity);

    if (existing === undefined) {
      return this.createReservation(request, request.idempotencyKey, identity, 1, false);
    }

    if (existing.state === 'pending' || existing.state === 'transport_ambiguous') {
      return {
        accepted: false,
        reason: 'duplicate_pending',
        state: existing.state,
      };
    }

    const replayAuthorized =
      request.replayPolicy === 'authority_receipt' &&
      existing.receipt?.replayAuthorization === 'authorized';

    if (!replayAuthorized) {
      return {
        accepted: false,
        reason: existing.state === 'accepted'
          ? 'duplicate_accepted'
          : 'replay_not_authorized',
        state: existing.state,
      };
    }

    return this.createReservation(
      request,
      request.idempotencyKey,
      identity,
      existing.attempt + 1,
      true,
    );
  }

  /**
   * Keeps an uncertain transport attempt reserved. A reconnect cannot resubmit
   * it unless a later authority receipt explicitly authorizes replay.
   */
  markTransportAmbiguous(reservation: SubmissionReservationV1): boolean {
    const entry = this.getMatchingEntry(reservation);
    if (entry === undefined || entry.state !== 'pending') return false;
    entry.state = 'transport_ambiguous';
    return true;
  }

  /**
   * Records the owning authority's durable receipt. Projection confirmation is
   * intentionally separate; acceptance alone continues to block duplicates.
   */
  recordReceipt(
    reservation: SubmissionReservationV1,
    receipt: AuthoritySubmissionReceiptV1,
  ): ReceiptRecordResultV1 {
    if (!sameAuthority(this.authority, receipt.authority)) {
      return { recorded: false, reason: 'authority_mismatch' };
    }

    const entry = this.getMatchingEntry(reservation);
    if (entry === undefined) {
      return { recorded: false, reason: 'reservation_not_found' };
    }
    if (
      receipt.actionId !== reservation.actionId ||
      receipt.idempotencyKey !== reservation.idempotencyKey ||
      receipt.attempt !== reservation.attempt
    ) {
      return { recorded: false, reason: 'reservation_mismatch' };
    }
    if (entry.receipt !== undefined || entry.state === 'accepted' || entry.state === 'rejected') {
      return { recorded: false, reason: 'receipt_already_recorded' };
    }

    entry.receipt = copyReceipt(receipt);
    entry.state = receipt.outcome;
    return { recorded: true, state: receipt.outcome };
  }

  getSnapshot(actionId: string, idempotencyKey: string): ProtectedSubmissionSnapshotV1 | undefined {
    const entry = this.submissions.get(operationIdentity(actionId, idempotencyKey));
    if (entry === undefined) return undefined;
    return {
      actionId: entry.actionId,
      actionClass: entry.actionClass,
      idempotencyKey: entry.idempotencyKey,
      attempt: entry.attempt,
      state: entry.state,
      receipt: entry.receipt === undefined ? undefined : copyReceipt(entry.receipt),
    };
  }

  private createReservation(
    request: NonIdempotentSubmissionRequestV1,
    idempotencyKey: string,
    identity: string,
    attempt: number,
    replay: boolean,
  ): SubmissionReservationResultV1 {
    const entry: ProtectedSubmissionEntry = {
      actionId: request.actionId,
      actionClass: request.actionClass,
      idempotencyKey,
      attempt,
      state: 'pending',
    };
    this.submissions.set(identity, entry);

    return {
      accepted: true,
      reservation: Object.freeze({
        authority: copyAuthority(this.authority),
        actionId: request.actionId,
        actionClass: request.actionClass,
        idempotencyKey,
        attempt,
        replay,
      }),
    };
  }

  private getMatchingEntry(
    reservation: SubmissionReservationV1,
  ): ProtectedSubmissionEntry | undefined {
    if (!sameAuthority(this.authority, reservation.authority)) return undefined;
    const entry = this.submissions.get(
      operationIdentity(reservation.actionId, reservation.idempotencyKey),
    );
    if (entry?.attempt !== reservation.attempt) return undefined;
    return entry;
  }
}
