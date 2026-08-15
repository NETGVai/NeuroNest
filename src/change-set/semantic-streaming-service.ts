/**
 * SemanticStreamingService — Orchestrates the full streaming-to-canonical pipeline
 * for Change_Set proposals.
 *
 * Responsibilities:
 * 1. Updates one stable Change_Set identity from typed file, operation, Hunk, and
 *    semantic chunks while preventing cross-URI application.
 * 2. Renders provisional additions, removals, and unchanged regions within the active
 *    profile threshold without committing them to disk absent explicit staged-autonomy
 *    rollback policy.
 * 3. Recomputes a deterministic final diff from unchanged base and canonical output,
 *    replacing drifted provisional state.
 * 4. Marks cancelled or failed streams incomplete with Discard, Retry, and
 *    Preserve Partial Draft actions.
 *
 * Requirements: 5.6, 5.7, 7.1, 7.2, 7.3, 7.4, 7.5
 */

import { StreamingChunkCollector } from './streaming-chunk-collector';
import type { SemanticChunk, CollectionResult, StreamState } from './streaming-chunk-collector';
import { CanonicalDiffComputer } from './canonical-diff-computer';
import type { DiffInput } from './canonical-diff-computer';
import { DiffReconciler } from './diff-reconciler';
import type { ReconciliationResult } from './diff-reconciler';
import { ChangeSetService } from './change-set-service';
import type { ChangeSet, FileOperation } from './types';
import { ShadowModelService } from './shadow-model-service';

/**
 * Actions available when a stream is marked incomplete (cancelled or failed).
 */
export type IncompleteAction = 'discard' | 'retry' | 'preserve_partial_draft';

/**
 * Represents a provisional diff region for rendering in the UI.
 */
export interface ProvisionalDiffRegion {
  /** The target file URI */
  readonly targetUri: string;
  /** The kind of region */
  readonly kind: 'addition' | 'removal' | 'unchanged';
  /** Start line in the provisional content */
  readonly startLine: number;
  /** Number of lines in this region */
  readonly lineCount: number;
  /** The content of this region */
  readonly content: string;
}

/**
 * Result of provisional diff rendering for a single file.
 */
export interface ProvisionalDiffSnapshot {
  /** The target file URI */
  readonly targetUri: string;
  /** Regions of additions, removals, and unchanged content */
  readonly regions: readonly ProvisionalDiffRegion[];
  /** Whether the provisional state is complete for this file */
  readonly isComplete: boolean;
  /** Time taken to compute this provisional diff (ms) */
  readonly computeTimeMs: number;
}

/**
 * Performance profile for rendering thresholds.
 */
export interface StreamingPerformanceProfile {
  /** Maximum milliseconds for provisional diff computation (default: 100) */
  readonly maxProvisionalDiffMs: number;
  /** Maximum lines to process in a single provisional render pass */
  readonly maxProvisionalLines: number;
  /** Whether staged autonomy rollback policy is active */
  readonly stagedAutonomyEnabled: boolean;
}

/**
 * Result of handling an incomplete stream action.
 */
export interface IncompleteActionResult {
  /** The action that was taken */
  readonly action: IncompleteAction;
  /** The resulting Change_Set state */
  readonly changeSet: ChangeSet;
  /** Whether the action was successful */
  readonly success: boolean;
  /** Human-readable explanation */
  readonly message: string;
}

/**
 * State of an active streaming session.
 */
export interface StreamingSession {
  /** The Change_Set ID being streamed into */
  readonly changeSetId: string;
  /** The collector aggregating chunks */
  readonly collector: StreamingChunkCollector;
  /** Base content for each file URI (for provisional diff) */
  readonly baseContents: Map<string, string>;
  /** Most recent provisional snapshots per file */
  readonly provisionalSnapshots: Map<string, ProvisionalDiffSnapshot>;
  /** Whether the canonical diff has been computed and reconciled */
  readonly isReconciled: boolean;
  /** The reconciliation result (null until stream completes) */
  readonly reconciliation: ReconciliationResult | null;
}

/** Default streaming performance profile */
export const DEFAULT_STREAMING_PROFILE: StreamingPerformanceProfile = {
  maxProvisionalDiffMs: 100,
  maxProvisionalLines: 5000,
  stagedAutonomyEnabled: false,
};

/**
 * SemanticStreamingService orchestrates the end-to-end streaming pipeline:
 * chunk collection → provisional rendering → canonical reconciliation.
 */
export class SemanticStreamingService {
  private readonly changeSetService: ChangeSetService;
  private readonly shadowModelService: ShadowModelService;
  private readonly diffComputer: CanonicalDiffComputer;
  private readonly diffReconciler: DiffReconciler;
  private readonly sessions: Map<string, StreamingSession> = new Map();
  private readonly profile: StreamingPerformanceProfile;

  constructor(options?: {
    changeSetService?: ChangeSetService;
    shadowModelService?: ShadowModelService;
    diffComputer?: CanonicalDiffComputer;
    diffReconciler?: DiffReconciler;
    profile?: Partial<StreamingPerformanceProfile>;
  }) {
    this.changeSetService = options?.changeSetService ?? new ChangeSetService();
    this.shadowModelService = options?.shadowModelService ?? new ShadowModelService();
    this.diffComputer = options?.diffComputer ?? new CanonicalDiffComputer();
    this.diffReconciler = options?.diffReconciler ?? new DiffReconciler();
    this.profile = { ...DEFAULT_STREAMING_PROFILE, ...options?.profile };
  }

  /**
   * Starts a new streaming session for a Change_Set.
   * The Change_Set must be in 'streaming' state.
   */
  startSession(changeSetId: string): StreamingSession {
    const changeSet = this.changeSetService.get(changeSetId);
    if (!changeSet) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }
    if (changeSet.state !== 'streaming') {
      throw new Error(
        `Cannot start streaming session for Change_Set ${changeSetId}: ` +
          `state is '${changeSet.state}', expected 'streaming'`
      );
    }
    if (this.sessions.has(changeSetId)) {
      throw new Error(
        `Streaming session already active for Change_Set ${changeSetId}`
      );
    }

    const session: StreamingSession = {
      changeSetId,
      collector: new StreamingChunkCollector(changeSetId),
      baseContents: new Map(),
      provisionalSnapshots: new Map(),
      isReconciled: false,
      reconciliation: null,
    };

    this.sessions.set(changeSetId, session);
    return session;
  }

  /**
   * Registers base content for a file URI, needed for provisional diff rendering
   * and canonical diff computation.
   */
  registerBaseContent(changeSetId: string, targetUri: string, content: string, baseHash?: string): void {
    const session = this.getSession(changeSetId);
    session.baseContents.set(targetUri, content);
    if (baseHash) {
      session.collector.setBaseHash(targetUri, baseHash);
    }
  }

  /**
   * Adds a semantic chunk to the streaming session.
   * Updates the stable Change_Set identity and prevents cross-URI application.
   * Returns the provisional diff snapshot for the affected file.
   */
  addChunk(changeSetId: string, chunk: SemanticChunk): ProvisionalDiffSnapshot | null {
    const session = this.getSession(changeSetId);

    // Delegate to collector — validates cross-URI, sequence, finalization
    session.collector.addChunk(chunk);

    // Compute provisional diff within profile threshold
    return this.computeProvisionalDiff(session, chunk.targetUri);
  }

  /**
   * Completes a streaming session: transitions the Change_Set to 'ready',
   * computes the canonical final diff, and reconciles any drift from
   * the provisional state.
   */
  completeStream(changeSetId: string): ReconciliationResult {
    const session = this.getSession(changeSetId);
    const collector = session.collector;

    // Mark the stream as completed
    collector.complete();

    // Get the final provisional operations from the collector
    const collectionResult = collector.collect();

    // Gather base/proposed blobs for canonical diff computation
    const diffInputs = this.buildDiffInputs(session, collectionResult);

    // Compute the canonical diff from immutable base and final proposed blobs
    const canonicalResult = this.diffComputer.compute(diffInputs);

    // Reconcile provisional state against canonical output
    const reconciliation = this.diffReconciler.reconcile(collectionResult, canonicalResult);

    // Replace the provisional state with canonical operations
    this.applyReconciliation(session, reconciliation);

    // Transition the Change_Set to ready with canonical operations
    const finalOps = reconciliation.success ? reconciliation.operations : collectionResult.operations;
    this.updateChangeSetOperations(changeSetId, finalOps);
    this.changeSetService.transition(changeSetId, 'ready');

    // Update shadow models with canonical content
    this.updateShadowModels(session, reconciliation);

    // Mark session as reconciled
    (session as { isReconciled: boolean }).isReconciled = true;
    (session as { reconciliation: ReconciliationResult | null }).reconciliation = reconciliation;

    return reconciliation;
  }

  /**
   * Handles a cancelled or failed stream by marking it incomplete and offering
   * Discard, Retry, and Preserve Partial Draft actions.
   * Before transitioning, pushes any collected operations to the Change_Set
   * so they are available for 'preserve_partial_draft'.
   */
  markIncomplete(changeSetId: string, reason: 'cancelled' | 'failed'): void {
    const session = this.getSession(changeSetId);
    const collector = session.collector;

    if (reason === 'cancelled') {
      collector.cancel();
    } else {
      collector.fail();
    }

    // Push collected operations to the Change_Set while still in streaming state
    // so 'preserve_partial_draft' can find them
    const collectionResult = collector.collect();
    if (collectionResult.operations.length > 0) {
      for (const op of collectionResult.operations) {
        this.changeSetService.addOperation(changeSetId, op);
      }
    }

    // Transition the Change_Set to 'incomplete'
    this.changeSetService.transition(changeSetId, 'incomplete');
  }

  /**
   * Executes an action on an incomplete Change_Set.
   */
  handleIncompleteAction(changeSetId: string, action: IncompleteAction): IncompleteActionResult {
    const changeSet = this.changeSetService.get(changeSetId);
    if (!changeSet) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }
    if (changeSet.state !== 'incomplete') {
      throw new Error(
        `Cannot handle incomplete action for Change_Set ${changeSetId}: ` +
          `state is '${changeSet.state}', expected 'incomplete'`
      );
    }

    switch (action) {
      case 'discard': {
        // Reject the Change_Set and clean up
        const rejected = this.changeSetService.transition(changeSetId, 'rejected');
        this.cleanupSession(changeSetId);
        return {
          action: 'discard',
          changeSet: rejected,
          success: true,
          message: `Change_Set ${changeSetId} discarded`,
        };
      }

      case 'retry': {
        // Transition back to 'ready' to allow re-streaming
        // We need to create a new streaming session
        const readied = this.changeSetService.transition(changeSetId, 'ready');
        this.cleanupSession(changeSetId);
        return {
          action: 'retry',
          changeSet: readied,
          success: true,
          message: `Change_Set ${changeSetId} ready for retry`,
        };
      }

      case 'preserve_partial_draft': {
        // Preserve whatever was streamed so far as a ready Change_Set.
        // Since operations can only be added in 'streaming' state, we transition
        // back through streaming to add the partial operations, then to ready.
        // Instead of mutating the existing Change_Set (which is already 'incomplete'),
        // we transition directly to 'ready' — the operations that were already added
        // during streaming are preserved in the Change_Set.
        const preserved = this.changeSetService.transition(changeSetId, 'ready');
        this.cleanupSession(changeSetId);
        return {
          action: 'preserve_partial_draft',
          changeSet: preserved,
          success: true,
          message: `Change_Set ${changeSetId} preserved as partial draft`,
        };
      }
    }
  }

  /**
   * Gets the current provisional diff snapshot for a file in the streaming session.
   */
  getProvisionalSnapshot(
    changeSetId: string,
    targetUri: string
  ): ProvisionalDiffSnapshot | null {
    const session = this.sessions.get(changeSetId);
    if (!session) return null;
    return session.provisionalSnapshots.get(targetUri) ?? null;
  }

  /**
   * Gets all provisional snapshots for the streaming session.
   */
  getAllProvisionalSnapshots(changeSetId: string): ProvisionalDiffSnapshot[] {
    const session = this.sessions.get(changeSetId);
    if (!session) return [];
    return Array.from(session.provisionalSnapshots.values());
  }

  /**
   * Returns the current streaming state of a session.
   */
  getStreamState(changeSetId: string): StreamState | null {
    const session = this.sessions.get(changeSetId);
    if (!session) return null;
    return session.collector.streamState;
  }

  /**
   * Returns whether the streaming session has been reconciled.
   */
  isReconciled(changeSetId: string): boolean {
    const session = this.sessions.get(changeSetId);
    return session?.isReconciled ?? false;
  }

  /**
   * Returns the reconciliation result if available.
   */
  getReconciliation(changeSetId: string): ReconciliationResult | null {
    const session = this.sessions.get(changeSetId);
    return session?.reconciliation ?? null;
  }

  /**
   * Checks if a session exists for the given Change_Set.
   */
  hasSession(changeSetId: string): boolean {
    return this.sessions.has(changeSetId);
  }

  /**
   * Returns the active performance profile.
   */
  getProfile(): StreamingPerformanceProfile {
    return { ...this.profile };
  }

  /**
   * Provides access to the underlying ChangeSetService.
   */
  get service(): ChangeSetService {
    return this.changeSetService;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Gets a session or throws if not found.
   */
  private getSession(changeSetId: string): StreamingSession {
    const session = this.sessions.get(changeSetId);
    if (!session) {
      throw new Error(
        `No active streaming session for Change_Set ${changeSetId}`
      );
    }
    return session;
  }

  /**
   * Computes a provisional diff for a file within the performance profile threshold.
   * Does NOT commit to disk — only produces regions for rendering.
   */
  private computeProvisionalDiff(
    session: StreamingSession,
    targetUri: string
  ): ProvisionalDiffSnapshot | null {
    const startTime = performance.now();
    const baseContent = session.baseContents.get(targetUri);

    // Find any position for this URI to check if we have data to render
    const hunkIds = this.findHunkIds(session, targetUri);
    if (hunkIds.length === 0) return null;

    const firstHunkId = hunkIds[0]!;
    const position = session.collector.getPosition(targetUri, firstHunkId);

    if (!position) return null;

    // Compute provisional content from all positions for this URI
    const allPositions = this.getPositionsForUri(session, targetUri);
    const provisionalContent = allPositions
      .sort((a, b) => a.hunkId.localeCompare(b.hunkId))
      .map((p) => p.accumulatedContent)
      .join('');

    // Compute provisional diff regions within profile threshold
    const regions = this.computeRegions(baseContent ?? '', provisionalContent, targetUri);
    const computeTimeMs = performance.now() - startTime;

    // If we exceed the profile threshold, return a truncated snapshot
    const withinThreshold = computeTimeMs <= this.profile.maxProvisionalDiffMs;

    const snapshot: ProvisionalDiffSnapshot = {
      targetUri,
      regions: withinThreshold ? regions : regions.slice(0, 50), // Truncate if too slow
      isComplete: allPositions.every((p) => p.finalized),
      computeTimeMs,
    };

    session.provisionalSnapshots.set(targetUri, snapshot);
    return snapshot;
  }

  /**
   * Computes provisional diff regions (additions, removals, unchanged) from
   * base and provisional content.
   */
  private computeRegions(
    baseContent: string,
    provisionalContent: string,
    targetUri: string
  ): ProvisionalDiffRegion[] {
    const baseLines = baseContent ? baseContent.split('\n') : [];
    const proposedLines = provisionalContent ? provisionalContent.split('\n') : [];
    const regions: ProvisionalDiffRegion[] = [];

    // Guard against exceeding the max provisional lines in the profile
    if (baseLines.length + proposedLines.length > this.profile.maxProvisionalLines) {
      // Return simplified regions for large files
      if (baseLines.length > 0) {
        regions.push({
          targetUri,
          kind: 'removal',
          startLine: 0,
          lineCount: baseLines.length,
          content: baseContent,
        });
      }
      if (proposedLines.length > 0) {
        regions.push({
          targetUri,
          kind: 'addition',
          startLine: 0,
          lineCount: proposedLines.length,
          content: provisionalContent,
        });
      }
      return regions;
    }

    // Simple line-level diff for provisional rendering
    let baseIdx = 0;
    let propIdx = 0;

    while (baseIdx < baseLines.length || propIdx < proposedLines.length) {
      if (baseIdx < baseLines.length && propIdx < proposedLines.length) {
        if (baseLines[baseIdx] === proposedLines[propIdx]) {
          // Unchanged region
          const startLine = propIdx;
          let count = 0;
          const content: string[] = [];
          while (
            baseIdx < baseLines.length &&
            propIdx < proposedLines.length &&
            baseLines[baseIdx] === proposedLines[propIdx]
          ) {
            content.push(proposedLines[propIdx]!);
            baseIdx++;
            propIdx++;
            count++;
          }
          regions.push({
            targetUri,
            kind: 'unchanged',
            startLine,
            lineCount: count,
            content: content.join('\n'),
          });
        } else {
          // Find the extent of the changed region
          // Look ahead for a re-sync point
          const resyncBase = this.findResync(baseLines, proposedLines, baseIdx, propIdx);

          if (resyncBase !== null) {
            // Emit removals from base
            const removedLines = baseLines.slice(baseIdx, resyncBase.baseEnd);
            if (removedLines.length > 0) {
              regions.push({
                targetUri,
                kind: 'removal',
                startLine: baseIdx,
                lineCount: removedLines.length,
                content: removedLines.join('\n'),
              });
            }
            // Emit additions from proposed
            const addedLines = proposedLines.slice(propIdx, resyncBase.propEnd);
            if (addedLines.length > 0) {
              regions.push({
                targetUri,
                kind: 'addition',
                startLine: propIdx,
                lineCount: addedLines.length,
                content: addedLines.join('\n'),
              });
            }
            baseIdx = resyncBase.baseEnd;
            propIdx = resyncBase.propEnd;
          } else {
            // No resync found — remaining lines are all changed
            const removedLines = baseLines.slice(baseIdx);
            if (removedLines.length > 0) {
              regions.push({
                targetUri,
                kind: 'removal',
                startLine: baseIdx,
                lineCount: removedLines.length,
                content: removedLines.join('\n'),
              });
            }
            const addedLines = proposedLines.slice(propIdx);
            if (addedLines.length > 0) {
              regions.push({
                targetUri,
                kind: 'addition',
                startLine: propIdx,
                lineCount: addedLines.length,
                content: addedLines.join('\n'),
              });
            }
            break;
          }
        }
      } else if (baseIdx < baseLines.length) {
        // Remaining base lines are removals
        const removedLines = baseLines.slice(baseIdx);
        regions.push({
          targetUri,
          kind: 'removal',
          startLine: baseIdx,
          lineCount: removedLines.length,
          content: removedLines.join('\n'),
        });
        break;
      } else {
        // Remaining proposed lines are additions
        const addedLines = proposedLines.slice(propIdx);
        regions.push({
          targetUri,
          kind: 'addition',
          startLine: propIdx,
          lineCount: addedLines.length,
          content: addedLines.join('\n'),
        });
        break;
      }
    }

    return regions;
  }

  /**
   * Find a re-synchronization point where base and proposed lines match again.
   */
  private findResync(
    baseLines: string[],
    proposedLines: string[],
    baseStart: number,
    propStart: number
  ): { baseEnd: number; propEnd: number } | null {
    const maxLookahead = 20; // Limit search to keep provisional rendering fast

    for (let bOff = 1; bOff <= maxLookahead && baseStart + bOff < baseLines.length; bOff++) {
      for (let pOff = 1; pOff <= maxLookahead && propStart + pOff < proposedLines.length; pOff++) {
        if (baseLines[baseStart + bOff] === proposedLines[propStart + pOff]) {
          return { baseEnd: baseStart + bOff, propEnd: propStart + pOff };
        }
      }
    }

    // Try matching just base advancement
    for (let bOff = 1; bOff <= maxLookahead && baseStart + bOff < baseLines.length; bOff++) {
      if (baseLines[baseStart + bOff] === proposedLines[propStart]) {
        return { baseEnd: baseStart + bOff, propEnd: propStart };
      }
    }

    // Try matching just proposed advancement
    for (let pOff = 1; pOff <= maxLookahead && propStart + pOff < proposedLines.length; pOff++) {
      if (baseLines[baseStart] === proposedLines[propStart + pOff]) {
        return { baseEnd: baseStart, propEnd: propStart + pOff };
      }
    }

    return null;
  }

  /**
   * Gets all position contexts for a target URI from the collector.
   */
  private getPositionsForUri(
    session: StreamingSession,
    targetUri: string
  ): Array<{ hunkId: string; accumulatedContent: string; finalized: boolean }> {
    return session.collector
      .getPositions()
      .filter((p) => p.targetUri === targetUri)
      .map((p) => ({
        hunkId: p.hunkId,
        accumulatedContent: p.accumulatedContent,
        finalized: p.finalized,
      }));
  }

  /**
   * Finds hunk IDs for a given target URI.
   */
  private findHunkIds(session: StreamingSession, targetUri: string): string[] {
    const positions = session.collector
      .getPositions()
      .filter((p) => p.targetUri === targetUri);
    return positions.map((p) => p.hunkId);
  }

  /**
   * Builds DiffInput[] from session state for canonical diff computation.
   */
  private buildDiffInputs(
    session: StreamingSession,
    collectionResult: CollectionResult
  ): DiffInput[] {
    const inputs: DiffInput[] = [];
    const processedUris = new Set<string>();

    for (const op of collectionResult.operations) {
      const uri = op.targetUri;
      if (processedUris.has(uri)) continue;
      processedUris.add(uri);

      const baseBlob = session.baseContents.get(uri) ?? null;
      const proposedBlob = this.getOperationContent(op);

      let kind: 'create' | 'modify' | 'delete';
      if (op.kind === 'create') {
        kind = 'create';
      } else if (op.kind === 'delete') {
        kind = 'delete';
      } else {
        kind = 'modify';
      }

      inputs.push({
        targetUri: uri,
        kind,
        baseBlob,
        proposedBlob,
      });
    }

    return inputs;
  }

  /**
   * Applies reconciliation by updating the session state.
   */
  private applyReconciliation(
    session: StreamingSession,
    reconciliation: ReconciliationResult
  ): void {
    // Clear provisional snapshots — they're replaced by canonical state
    session.provisionalSnapshots.clear();

    // Re-compute provisional snapshots from canonical operations
    for (const op of reconciliation.operations) {
      if (op.kind === 'create' || op.kind === 'modify') {
        const baseContent = session.baseContents.get(op.targetUri) ?? '';
        const proposedContent = op.kind === 'create' ? op.proposedBlob : op.proposedBlob;
        const regions = this.computeRegions(baseContent, proposedContent, op.targetUri);

        session.provisionalSnapshots.set(op.targetUri, {
          targetUri: op.targetUri,
          regions,
          isComplete: true,
          computeTimeMs: 0,
        });
      }
    }
  }

  /**
   * Updates the Change_Set operations with the final reconciled operations.
   */
  private updateChangeSetOperations(
    changeSetId: string,
    operations: readonly FileOperation[]
  ): void {
    // Since ChangeSetService only allows adding operations during streaming state,
    // and we're still in streaming state here, we add them individually
    const changeSet = this.changeSetService.get(changeSetId);
    if (!changeSet) return;

    // We need to rebuild the Change_Set with canonical operations.
    // The service allows adding operations only in streaming state.
    for (const op of operations) {
      this.changeSetService.addOperation(changeSetId, op);
    }
  }

  /**
   * Updates shadow models with canonical content after reconciliation.
   */
  private updateShadowModels(
    session: StreamingSession,
    reconciliation: ReconciliationResult
  ): void {
    // Dispose any existing shadow models for this Change_Set
    this.shadowModelService.disposeByChangeSet(session.changeSetId);

    // Create new shadow models from canonical content
    for (const op of reconciliation.operations) {
      if (op.kind === 'create' || op.kind === 'modify') {
        const baseContent = session.baseContents.get(op.targetUri) ?? null;
        this.shadowModelService.create({
          changeSetId: session.changeSetId,
          originalUri: op.targetUri,
          baseContent,
          proposedContent: op.proposedBlob,
        });
      } else if (op.kind === 'delete') {
        const baseContent = session.baseContents.get(op.targetUri) ?? null;
        this.shadowModelService.create({
          changeSetId: session.changeSetId,
          originalUri: op.targetUri,
          baseContent,
          proposedContent: null,
        });
      }
    }
  }

  /**
   * Cleans up a streaming session.
   */
  private cleanupSession(changeSetId: string): void {
    this.sessions.delete(changeSetId);
  }

  /**
   * Gets the proposed content from a file operation.
   */
  private getOperationContent(op: FileOperation): string | null {
    switch (op.kind) {
      case 'create':
        return op.proposedBlob;
      case 'modify':
        return op.proposedBlob;
      case 'delete':
      case 'rename':
      case 'move':
        return null;
    }
  }
}
