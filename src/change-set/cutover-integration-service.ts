/**
 * CutoverIntegrationService — Integrates merge restoration, write routing,
 * crash recovery fault testing, and the transaction cutover checkpoint into
 * one coordinated service that gates downstream mutation waves.
 *
 * This service:
 * 1. On every restore request, delegates to MergeRestorationService which always
 *    opens the merge workflow (even without conflicts), preserves both states,
 *    and leaves restoration unapplied when safety cannot be proven.
 * 2. Projects user edits, agent edits, approvals, validation, and restores
 *    chronologically with source attribution through the timeline.
 * 3. Routes all agent proposal writes through ChangeSetCoordinator via
 *    WriteRoutingEnforcer, disables direct write bypasses behind compatibility
 *    gates, and fault-tests crash recovery at every journal boundary.
 * 4. Blocks downstream mutation waves until review, checkpoint, rollback, and
 *    provenance parity evidence passes via TransactionCutoverCheckpointService.
 *
 * Requirements: 5.1, 9.7, 9.8, 26.8, 28.4
 */

import type { ChangeSet, FileOperation } from './types';
import type { ChangeSetCoordinator } from './change-set-coordinator';
import type { ChangeTransactionService, TransactionJournal } from './change-transaction-service';
import {
  MergeRestorationService,
  type MergeWorkspaceAdapter,
  type CheckpointContentAdapter,
  type MergeWorkflow,
  type ChangeTimelineEntry,
} from './merge-restoration-service';
import {
  WriteRoutingEnforcer,
  type WriteRequest,
  type WriteRoutingResult,
  type DirectWriteGateConfig,
} from './write-routing-enforcer';
import {
  TransactionCutoverCheckpointService,
  type CutoverCheckpoint,
  type CutoverEvidenceKind,
  type CrashRecoveryTestResult,
} from './transaction-cutover-checkpoint';

// ─── Integration Types ──────────────────────────────────────────────────────

/**
 * Journal boundaries where crash recovery is fault-tested.
 */
export type JournalBoundary =
  | 'before_journal_create'
  | 'after_journal_create'
  | 'before_disk_apply'
  | 'during_disk_apply'
  | 'after_disk_apply'
  | 'before_model_apply'
  | 'after_model_apply'
  | 'before_commit'
  | 'after_commit';

/**
 * All journal boundaries in order for systematic testing.
 */
export const ALL_JOURNAL_BOUNDARIES: readonly JournalBoundary[] = [
  'before_journal_create',
  'after_journal_create',
  'before_disk_apply',
  'during_disk_apply',
  'after_disk_apply',
  'before_model_apply',
  'after_model_apply',
  'before_commit',
  'after_commit',
];

/**
 * Result of a full crash recovery fault test across journal boundaries.
 */
export interface CrashRecoveryFaultTestResult {
  /** Boundary that was tested. */
  readonly boundary: JournalBoundary;
  /** Whether the system recovered to a consistent state. */
  readonly recovered: boolean;
  /** Whether the recovered state matches pre-crash or post-apply (both valid). */
  readonly consistent: boolean;
  /** The fingerprint before the simulated crash. */
  readonly preCrashFingerprint: string;
  /** The fingerprint after recovery. */
  readonly postRecoveryFingerprint: string;
  /** Whether rollback was required. */
  readonly rollbackRequired: boolean;
  /** Error detail if recovery failed. */
  readonly error?: string;
}

/**
 * Parity evidence that must be collected before downstream waves proceed.
 */
export interface ParityEvidence {
  /** Whether review flow is working correctly. */
  readonly reviewParity: boolean;
  /** Whether checkpoints are being created correctly. */
  readonly checkpointParity: boolean;
  /** Whether rollback works at every boundary. */
  readonly rollbackParity: boolean;
  /** Whether provenance is being recorded correctly. */
  readonly provenanceParity: boolean;
  /** Whether write routing enforcement is active. */
  readonly writeRoutingEnforcement: boolean;
  /** Whether crash recovery passes at all boundaries. */
  readonly crashRecoveryValidation: boolean;
  /** Whether journal boundary tests pass. */
  readonly journalBoundaryTest: boolean;
}

/**
 * Adapter for accessing workspace state during crash recovery testing.
 */
export interface CrashRecoveryWorkspaceAdapter {
  /** Computes a workspace fingerprint for the given URIs. */
  computeFingerprint(uris: string[]): string;
  /** Simulates a crash at a given boundary and returns whether recovery succeeds. */
  simulateCrashAtBoundary(
    boundary: JournalBoundary,
    affectedUris: string[]
  ): { recovered: boolean; consistent: boolean; postFingerprint: string };
}

// ─── CutoverIntegrationService ──────────────────────────────────────────────

/**
 * CutoverIntegrationService ties together merge restoration, write routing,
 * crash recovery testing, and the cutover checkpoint into a cohesive gate
 * that blocks downstream mutation waves until parity is proven.
 */
export class CutoverIntegrationService {
  private readonly mergeService: MergeRestorationService;
  private readonly writeEnforcer: WriteRoutingEnforcer;
  private readonly cutoverCheckpoint: TransactionCutoverCheckpointService;
  private readonly crashAdapter: CrashRecoveryWorkspaceAdapter;

  /** Crash recovery test results by boundary. */
  private readonly crashRecoveryResults = new Map<JournalBoundary, CrashRecoveryFaultTestResult>();

  /** Whether all parity checks have been run. */
  private parityValidated = false;

  constructor(
    mergeService: MergeRestorationService,
    writeEnforcer: WriteRoutingEnforcer,
    cutoverCheckpoint: TransactionCutoverCheckpointService,
    crashAdapter: CrashRecoveryWorkspaceAdapter
  ) {
    this.mergeService = mergeService;
    this.writeEnforcer = writeEnforcer;
    this.cutoverCheckpoint = cutoverCheckpoint;
    this.crashAdapter = crashAdapter;
  }

  // ─── Merge Restoration (Req 9.7) ─────────────────────────────────────────

  /**
   * Initiates a restore that always opens the merge workflow, even without
   * detected conflicts. Delegates to MergeRestorationService.
   *
   * Key invariant: The merge workflow is ALWAYS opened. If safety cannot be
   * proven, the restoration is left unapplied and both states are preserved.
   */
  initiateRestore(
    checkpointId: string,
    targetUris: readonly string[],
    actorId: string
  ): MergeWorkflow {
    return this.mergeService.initiateRestore(checkpointId, targetUris, actorId);
  }

  /**
   * Attempts a file merge within an active workflow.
   */
  attemptFileMerge(
    workflowId: string,
    uri: string,
    resolvedContent?: string
  ): boolean {
    return this.mergeService.attemptFileMerge(workflowId, uri, resolvedContent);
  }

  /**
   * Completes a merge workflow — proves or denies safety.
   */
  completeMerge(workflowId: string): MergeWorkflow {
    return this.mergeService.completeMerge(workflowId);
  }

  /**
   * Gets preserved states (current and target) for a workflow.
   */
  getPreservedStates(workflowId: string): {
    current: Record<string, string | null>;
    target: Record<string, string | null>;
  } | null {
    return this.mergeService.getPreservedStates(workflowId);
  }

  // ─── Timeline Projection (Req 9.8) ───────────────────────────────────────

  /**
   * Records a user edit in the chronological timeline.
   */
  recordUserEdit(
    actorId: string,
    targetUri: string,
    description: string,
    changeSetId?: string
  ): ChangeTimelineEntry {
    return this.mergeService.recordUserEdit(actorId, targetUri, description, changeSetId);
  }

  /**
   * Records an agent edit in the chronological timeline.
   */
  recordAgentEdit(
    actorId: string,
    targetUri: string,
    description: string,
    changeSetId?: string,
    runId?: string,
    taskId?: string
  ): ChangeTimelineEntry {
    return this.mergeService.recordAgentEdit(actorId, targetUri, description, changeSetId, runId, taskId);
  }

  /**
   * Records an approval in the chronological timeline.
   */
  recordApproval(
    actorId: string,
    description: string,
    changeSetId?: string
  ): ChangeTimelineEntry {
    return this.mergeService.recordApproval(actorId, description, changeSetId);
  }

  /**
   * Records a validation event in the chronological timeline.
   */
  recordValidation(
    description: string,
    changeSetId?: string,
    runId?: string
  ): ChangeTimelineEntry {
    return this.mergeService.recordValidation(description, changeSetId, runId);
  }

  /**
   * Gets the full chronological timeline.
   */
  getTimeline(): readonly ChangeTimelineEntry[] {
    return this.mergeService.getTimeline();
  }

  // ─── Write Routing (Req 5.1, 28.4) ───────────────────────────────────────

  /**
   * Routes a write request through the enforcer. Agent writes are routed
   * through ChangeSetCoordinator when the gate is enabled.
   */
  routeWrite(request: WriteRequest): WriteRoutingResult {
    const result = this.writeEnforcer.routeWrite(request);

    // Record in timeline when appropriate
    if (result.allowed && request.origin === 'agent') {
      this.mergeService.recordAgentEdit(
        request.runId ?? 'unknown-agent',
        request.targetUri,
        `Agent write routed through coordinator`,
        result.changeSetId,
        request.runId,
        request.taskId
      );
    }

    return result;
  }

  /**
   * Whether direct write bypasses are disabled (cutover complete).
   */
  isDirectWriteBypassDisabled(): boolean {
    return this.writeEnforcer.isDirectWriteBypassDisabled();
  }

  /**
   * Updates the gate configuration during staged rollout.
   */
  updateWriteGateConfig(config: Partial<DirectWriteGateConfig>): void {
    this.writeEnforcer.updateConfig(config);
  }

  // ─── Crash Recovery Fault Testing (Req 26.8) ─────────────────────────────

  /**
   * Runs crash recovery fault tests at every journal boundary.
   * Each test simulates a crash at the boundary and verifies that the system
   * recovers to a consistent state.
   */
  runCrashRecoveryTests(affectedUris: string[]): CrashRecoveryFaultTestResult[] {
    const results: CrashRecoveryFaultTestResult[] = [];
    const preFingerprint = this.crashAdapter.computeFingerprint(affectedUris);

    for (const boundary of ALL_JOURNAL_BOUNDARIES) {
      const result = this.runSingleCrashRecoveryTest(boundary, affectedUris, preFingerprint);
      results.push(result);
      this.crashRecoveryResults.set(boundary, result);

      // Record in the cutover checkpoint
      this.cutoverCheckpoint.recordCrashRecoveryTest({
        boundary,
        recovered: result.recovered,
        consistent: result.consistent,
        preCrashFingerprint: result.preCrashFingerprint,
        postRecoveryFingerprint: result.postRecoveryFingerprint,
        error: result.error,
      });
    }

    return results;
  }

  /**
   * Runs a crash recovery test at a single boundary.
   */
  runSingleCrashRecoveryTest(
    boundary: JournalBoundary,
    affectedUris: string[],
    preFingerprint?: string
  ): CrashRecoveryFaultTestResult {
    const preFp = preFingerprint ?? this.crashAdapter.computeFingerprint(affectedUris);

    try {
      const { recovered, consistent, postFingerprint } =
        this.crashAdapter.simulateCrashAtBoundary(boundary, affectedUris);

      const result: CrashRecoveryFaultTestResult = {
        boundary,
        recovered,
        consistent,
        preCrashFingerprint: preFp,
        postRecoveryFingerprint: postFingerprint,
        rollbackRequired: boundary !== 'after_commit',
      };

      return result;
    } catch (err) {
      return {
        boundary,
        recovered: false,
        consistent: false,
        preCrashFingerprint: preFp,
        postRecoveryFingerprint: 'unknown',
        rollbackRequired: true,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Gets crash recovery test results for all tested boundaries.
   */
  getCrashRecoveryResults(): ReadonlyMap<JournalBoundary, CrashRecoveryFaultTestResult> {
    return this.crashRecoveryResults;
  }

  // ─── Cutover Checkpoint (Req 26.8, 28.4) ─────────────────────────────────

  /**
   * Submits parity evidence to the cutover checkpoint.
   * All evidence kinds must pass before downstream waves are allowed.
   */
  submitParityEvidence(evidence: ParityEvidence, workspaceRevision?: string): void {
    const submit = (
      kind: CutoverEvidenceKind,
      passed: boolean,
      description: string,
      details: string
    ) => {
      this.cutoverCheckpoint.submitEvidence(
        kind,
        passed,
        description,
        details,
        `fp-${kind}-${Date.now()}`,
        workspaceRevision
      );
    };

    submit(
      'review_parity',
      evidence.reviewParity,
      'Review flow parity',
      evidence.reviewParity ? 'All review operations produce correct state' : 'Review flow has gaps'
    );

    submit(
      'checkpoint_parity',
      evidence.checkpointParity,
      'Checkpoint creation parity',
      evidence.checkpointParity ? 'Pre/post checkpoints created correctly' : 'Checkpoint creation failed'
    );

    submit(
      'rollback_parity',
      evidence.rollbackParity,
      'Rollback recovery parity',
      evidence.rollbackParity ? 'Rollback restores exact prior state' : 'Rollback produced inconsistency'
    );

    submit(
      'provenance_parity',
      evidence.provenanceParity,
      'Provenance recording parity',
      evidence.provenanceParity ? 'All provenance fields recorded correctly' : 'Missing provenance data'
    );

    submit(
      'write_routing_enforcement',
      evidence.writeRoutingEnforcement,
      'Write routing enforcement active',
      evidence.writeRoutingEnforcement
        ? 'All agent writes routed through ChangeSetCoordinator'
        : 'Direct write bypasses detected'
    );

    submit(
      'crash_recovery_validation',
      evidence.crashRecoveryValidation,
      'Crash recovery at journal boundaries',
      evidence.crashRecoveryValidation
        ? 'Recovery succeeds at all boundaries'
        : 'Crash recovery failed at one or more boundaries'
    );

    submit(
      'journal_boundary_test',
      evidence.journalBoundaryTest,
      'Journal boundary fault testing',
      evidence.journalBoundaryTest
        ? 'All journal boundaries produce consistent recovery'
        : 'Journal boundary tests incomplete or failed'
    );

    this.parityValidated = true;
  }

  /**
   * Evaluates the cutover checkpoint and determines if downstream waves
   * are allowed to proceed.
   */
  evaluateCutover(): CutoverCheckpoint {
    return this.cutoverCheckpoint.evaluate();
  }

  /**
   * Whether downstream mutation waves are allowed.
   */
  isDownstreamAllowed(): boolean {
    return this.cutoverCheckpoint.isDownstreamAllowed();
  }

  /**
   * Gets the reason downstream is blocked (if blocked).
   */
  getBlockReason(): string | undefined {
    return this.cutoverCheckpoint.getBlockReason();
  }

  /**
   * Gets the full cutover checkpoint state.
   */
  getCutoverCheckpoint(): Readonly<CutoverCheckpoint> {
    return this.cutoverCheckpoint.getCheckpoint();
  }

  /**
   * Whether parity evidence has been validated.
   */
  isParityValidated(): boolean {
    return this.parityValidated;
  }

  /**
   * Marks a specific evidence kind as stale (e.g., after workspace changes).
   */
  markEvidenceStale(kind: CutoverEvidenceKind): void {
    this.cutoverCheckpoint.markEvidenceStale(kind);
    this.parityValidated = false;
  }

  /**
   * Resets the entire cutover checkpoint for re-evaluation.
   */
  resetCutover(): void {
    this.cutoverCheckpoint.reset();
    this.crashRecoveryResults.clear();
    this.parityValidated = false;
  }

  // ─── Full Cutover Validation ──────────────────────────────────────────────

  /**
   * Runs the full cutover validation sequence:
   * 1. Verifies write routing enforcement is active
   * 2. Runs crash recovery fault tests at all journal boundaries
   * 3. Collects all parity evidence
   * 4. Evaluates the cutover checkpoint
   *
   * Returns whether downstream waves are allowed to proceed.
   */
  runFullCutoverValidation(
    affectedUris: string[],
    parityEvidence: Omit<ParityEvidence, 'crashRecoveryValidation' | 'journalBoundaryTest' | 'writeRoutingEnforcement'>,
    workspaceRevision?: string
  ): { allowed: boolean; checkpoint: CutoverCheckpoint; crashResults: CrashRecoveryFaultTestResult[] } {
    // Step 1: Run crash recovery tests
    const crashResults = this.runCrashRecoveryTests(affectedUris);
    const allCrashPassed = crashResults.every((r) => r.recovered && r.consistent);

    // Step 2: Check write routing enforcement
    const writeRoutingActive = this.writeEnforcer.isDirectWriteBypassDisabled() ||
      this.writeEnforcer.getConfig().changeSetGateEnabled;

    // Step 3: Submit combined evidence
    this.submitParityEvidence({
      ...parityEvidence,
      writeRoutingEnforcement: writeRoutingActive,
      crashRecoveryValidation: allCrashPassed,
      journalBoundaryTest: allCrashPassed,
    }, workspaceRevision);

    // Step 4: Evaluate
    const checkpoint = this.evaluateCutover();

    return {
      allowed: !checkpoint.downstreamBlocked,
      checkpoint,
      crashResults,
    };
  }
}
