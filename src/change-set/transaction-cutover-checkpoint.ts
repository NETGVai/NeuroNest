/**
 * TransactionCutoverCheckpoint — Blocks downstream mutation waves until
 * review, checkpoint, rollback, and provenance parity evidence passes.
 *
 * This service acts as the final gate for Wave 4, verifying that:
 * - All agent writes are routed through ChangeSetCoordinator
 * - Direct write bypasses are disabled behind compatibility gates
 * - Crash recovery works at every journal boundary
 * - Review, checkpoint, rollback, and provenance parity evidence is collected
 *
 * Requirements: 26.8, 28.4
 */

import { randomUUID } from 'node:crypto';

// ─── Cutover Checkpoint Types ───────────────────────────────────────────────

/**
 * Evidence kinds required for the cutover checkpoint to pass.
 */
export type CutoverEvidenceKind =
  | 'review_parity'
  | 'checkpoint_parity'
  | 'rollback_parity'
  | 'provenance_parity'
  | 'write_routing_enforcement'
  | 'crash_recovery_validation'
  | 'journal_boundary_test';

/**
 * State of a cutover evidence item.
 */
export type CutoverEvidenceState = 'pending' | 'passed' | 'failed' | 'stale';

/**
 * A single piece of evidence for the cutover checkpoint.
 */
export interface CutoverEvidence {
  /** Unique evidence ID. */
  readonly id: string;
  /** Kind of evidence. */
  readonly kind: CutoverEvidenceKind;
  /** Current state. */
  state: CutoverEvidenceState;
  /** Description of what was validated. */
  readonly description: string;
  /** Timestamp of validation. */
  readonly validatedAt: string;
  /** Workspace revision at validation time. */
  readonly workspaceRevision?: string | undefined;
  /** Details of the validation result. */
  readonly details: string;
  /** Fingerprint of the evidence (for staleness checks). */
  readonly fingerprint: string;
}

/**
 * Result of a crash recovery test at a journal boundary.
 */
export interface CrashRecoveryTestResult {
  /** Journal boundary being tested. */
  readonly boundary: string;
  /** Whether recovery succeeded. */
  readonly recovered: boolean;
  /** Whether workspace reached consistent state. */
  readonly consistent: boolean;
  /** Pre-crash fingerprint. */
  readonly preCrashFingerprint: string;
  /** Post-recovery fingerprint. */
  readonly postRecoveryFingerprint: string;
  /** Error (if recovery failed). */
  readonly error?: string;
}

/**
 * Overall state of the transaction cutover checkpoint.
 */
export type CutoverCheckpointState =
  | 'collecting_evidence'
  | 'validating'
  | 'passed'
  | 'failed'
  | 'blocked';

/**
 * The full cutover checkpoint state.
 */
export interface CutoverCheckpoint {
  /** Unique checkpoint ID. */
  readonly id: string;
  /** Current state. */
  state: CutoverCheckpointState;
  /** All collected evidence. */
  readonly evidence: CutoverEvidence[];
  /** Required evidence kinds that must pass. */
  readonly requiredEvidence: readonly CutoverEvidenceKind[];
  /** Whether downstream mutation waves are blocked. */
  downstreamBlocked: boolean;
  /** Reason downstream is blocked (if applicable). */
  blockReason?: string | undefined;
  /** Timestamp created. */
  readonly createdAt: string;
  /** Timestamp of last evaluation. */
  evaluatedAt?: string | undefined;
  /** Crash recovery test results. */
  readonly crashRecoveryResults: CrashRecoveryTestResult[];
}

// ─── TransactionCutoverCheckpointService ────────────────────────────────────

/**
 * TransactionCutoverCheckpointService blocks downstream mutation waves
 * until all required evidence passes.
 *
 * The key invariant is: downstream waves (5+) CANNOT proceed until this
 * checkpoint validates review, checkpoint, rollback, and provenance parity.
 */
export class TransactionCutoverCheckpointService {
  /** The active cutover checkpoint. */
  private checkpoint: CutoverCheckpoint;

  /** All required evidence kinds for the cutover to pass. */
  private static readonly REQUIRED_EVIDENCE: readonly CutoverEvidenceKind[] = [
    'review_parity',
    'checkpoint_parity',
    'rollback_parity',
    'provenance_parity',
    'write_routing_enforcement',
    'crash_recovery_validation',
    'journal_boundary_test',
  ];

  constructor() {
    this.checkpoint = {
      id: randomUUID(),
      state: 'collecting_evidence',
      evidence: [],
      requiredEvidence: TransactionCutoverCheckpointService.REQUIRED_EVIDENCE,
      downstreamBlocked: true,
      blockReason: 'Cutover checkpoint: awaiting review, checkpoint, rollback, and provenance parity evidence',
      createdAt: new Date().toISOString(),
      crashRecoveryResults: [],
    };
  }

  /**
   * Submits evidence for the cutover checkpoint.
   */
  submitEvidence(
    kind: CutoverEvidenceKind,
    passed: boolean,
    description: string,
    details: string,
    fingerprint: string,
    workspaceRevision?: string
  ): CutoverEvidence {
    const evidence: CutoverEvidence = {
      id: randomUUID(),
      kind,
      state: passed ? 'passed' : 'failed',
      description,
      validatedAt: new Date().toISOString(),
      workspaceRevision,
      details,
      fingerprint,
    };

    // Replace any existing evidence of the same kind
    const existingIndex = this.checkpoint.evidence.findIndex((e) => e.kind === kind);
    if (existingIndex >= 0) {
      (this.checkpoint.evidence as CutoverEvidence[]).splice(existingIndex, 1, evidence);
    } else {
      (this.checkpoint.evidence as CutoverEvidence[]).push(evidence);
    }

    return evidence;
  }

  /**
   * Records a crash recovery test result.
   */
  recordCrashRecoveryTest(result: CrashRecoveryTestResult): void {
    (this.checkpoint.crashRecoveryResults as CrashRecoveryTestResult[]).push(result);
  }

  /**
   * Evaluates the checkpoint — determines if all required evidence passes
   * and whether downstream waves can be unblocked.
   */
  evaluate(): CutoverCheckpoint {
    this.checkpoint.state = 'validating';
    this.checkpoint.evaluatedAt = new Date().toISOString();

    // Check that all required evidence kinds are present and passed
    const missingEvidence: CutoverEvidenceKind[] = [];
    const failedEvidence: CutoverEvidenceKind[] = [];

    for (const required of this.checkpoint.requiredEvidence) {
      const evidence = this.checkpoint.evidence.find((e) => e.kind === required);
      if (!evidence) {
        missingEvidence.push(required);
      } else if (evidence.state !== 'passed') {
        failedEvidence.push(required);
      }
    }

    // Check crash recovery results
    const crashRecoveryPassed = this.checkpoint.crashRecoveryResults.length > 0 &&
      this.checkpoint.crashRecoveryResults.every((r) => r.recovered && r.consistent);

    if (missingEvidence.length === 0 && failedEvidence.length === 0 && crashRecoveryPassed) {
      this.checkpoint.state = 'passed';
      this.checkpoint.downstreamBlocked = false;
      delete this.checkpoint.blockReason;
    } else {
      this.checkpoint.state = 'failed';
      this.checkpoint.downstreamBlocked = true;

      const reasons: string[] = [];
      if (missingEvidence.length > 0) {
        reasons.push(`Missing evidence: ${missingEvidence.join(', ')}`);
      }
      if (failedEvidence.length > 0) {
        reasons.push(`Failed evidence: ${failedEvidence.join(', ')}`);
      }
      if (!crashRecoveryPassed) {
        reasons.push('Crash recovery validation incomplete or failed');
      }
      this.checkpoint.blockReason = reasons.join('; ');
    }

    return { ...this.checkpoint };
  }

  /**
   * Checks if downstream mutation waves are allowed to proceed.
   *
   * Requirement 28.4: Block downstream waves until parity evidence passes.
   */
  isDownstreamAllowed(): boolean {
    return !this.checkpoint.downstreamBlocked;
  }

  /**
   * Gets the block reason if downstream is blocked.
   */
  getBlockReason(): string | undefined {
    return this.checkpoint.blockReason;
  }

  /**
   * Gets the current checkpoint state.
   */
  getCheckpoint(): Readonly<CutoverCheckpoint> {
    return { ...this.checkpoint };
  }

  /**
   * Gets the state of a specific evidence kind.
   */
  getEvidenceState(kind: CutoverEvidenceKind): CutoverEvidenceState {
    const evidence = this.checkpoint.evidence.find((e) => e.kind === kind);
    return evidence?.state ?? 'pending';
  }

  /**
   * Marks evidence as stale (e.g., when workspace revision changes).
   */
  markEvidenceStale(kind: CutoverEvidenceKind): void {
    const evidence = this.checkpoint.evidence.find((e) => e.kind === kind);
    if (evidence) {
      evidence.state = 'stale';
      // Re-block downstream when evidence becomes stale
      this.checkpoint.downstreamBlocked = true;
      this.checkpoint.blockReason = `Evidence ${kind} became stale`;
      this.checkpoint.state = 'blocked';
    }
  }

  /**
   * Resets the checkpoint for re-evaluation.
   */
  reset(): void {
    this.checkpoint = {
      id: randomUUID(),
      state: 'collecting_evidence',
      evidence: [],
      requiredEvidence: TransactionCutoverCheckpointService.REQUIRED_EVIDENCE,
      downstreamBlocked: true,
      blockReason: 'Cutover checkpoint reset: awaiting evidence',
      createdAt: new Date().toISOString(),
      crashRecoveryResults: [],
    };
  }
}
