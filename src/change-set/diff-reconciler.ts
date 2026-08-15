/**
 * DiffReconciler — Compares the streamed provisional state against the worker-computed
 * canonical diff, reconciles any discrepancies (position shifts, duplicate chunks, etc.),
 * and produces the final reconciled Change_Set for review.
 *
 * Ensures what the user reviews matches the canonical output exactly.
 *
 * Requirements: 5.4, 5.5, 5.6, 7.1, 7.2
 */

import type { FileOperation } from './types';
import type { CollectionResult, PositionContext } from './streaming-chunk-collector';
import type { CanonicalDiffResult, FileDiff } from './canonical-diff-computer';

/**
 * Describes a discrepancy found between provisional and canonical state.
 */
export interface Discrepancy {
  /** The file URI where the discrepancy was found */
  readonly targetUri: string;
  /** The type of discrepancy */
  readonly kind: 'content_mismatch' | 'position_shift' | 'missing_file' | 'extra_file' | 'duplicate_chunk';
  /** Human-readable description */
  readonly description: string;
  /** The provisional value (if applicable) */
  readonly provisionalValue?: string;
  /** The canonical value (if applicable) */
  readonly canonicalValue?: string;
}

/**
 * The result of reconciling provisional and canonical state.
 */
export interface ReconciliationResult {
  /** The final reconciled operations matching canonical output */
  readonly operations: readonly FileOperation[];
  /** List of discrepancies that were corrected */
  readonly discrepancies: readonly Discrepancy[];
  /** Whether any reconciliation was needed */
  readonly hadDiscrepancies: boolean;
  /** Whether the reconciliation was successful */
  readonly success: boolean;
  /** The canonical diff fingerprint (from the worker result) */
  readonly canonicalFingerprint: string;
}

/**
 * DiffReconciler ensures the streamed provisional state matches the canonical diff
 * exactly before presenting the review view.
 */
export class DiffReconciler {
  /**
   * Reconciles the streamed provisional state against the worker-computed canonical diff.
   *
   * The canonical diff is always authoritative. When discrepancies are found, the
   * reconciler produces operations from the canonical state, not the provisional state.
   *
   * @param provisional The collected result from the streaming chunk collector
   * @param canonical The canonical diff result from the worker
   * @returns The final reconciled result for review
   */
  reconcile(provisional: CollectionResult, canonical: CanonicalDiffResult): ReconciliationResult {
    if (!canonical.success) {
      return {
        operations: [],
        discrepancies: [{
          targetUri: '*',
          kind: 'content_mismatch',
          description: 'Canonical diff computation failed',
        }],
        hadDiscrepancies: true,
        success: false,
        canonicalFingerprint: canonical.fingerprint,
      };
    }

    const discrepancies: Discrepancy[] = [];
    const reconciledOperations: FileOperation[] = [];

    // Build a map of provisional operations by targetUri
    const provisionalByUri = new Map<string, FileOperation>();
    for (const op of provisional.operations) {
      const uri = this.getOperationUri(op);
      provisionalByUri.set(uri, op);
    }

    // Build a map of provisional position contexts by targetUri
    const provisionalPositionsByUri = new Map<string, PositionContext[]>();
    for (const pos of provisional.positions) {
      const existing = provisionalPositionsByUri.get(pos.targetUri) ?? [];
      existing.push(pos);
      provisionalPositionsByUri.set(pos.targetUri, existing);
    }

    // Process each file in the canonical diff
    for (const fileDiff of canonical.fileDiffs) {
      const provisionalOp = provisionalByUri.get(fileDiff.targetUri);

      // Check for missing file in provisional state
      if (!provisionalOp) {
        discrepancies.push({
          targetUri: fileDiff.targetUri,
          kind: 'missing_file',
          description: `File '${fileDiff.targetUri}' present in canonical diff but missing from provisional state`,
        });
      } else {
        // Compare content between provisional and canonical
        const provisionalContent = this.getOperationContent(provisionalOp);
        const canonicalContent = fileDiff.proposedContent;

        if (provisionalContent !== canonicalContent) {
          discrepancies.push({
            targetUri: fileDiff.targetUri,
            kind: 'content_mismatch',
            description: `Content mismatch for '${fileDiff.targetUri}': provisional differs from canonical`,
            provisionalValue: provisionalContent ?? undefined,
            canonicalValue: canonicalContent ?? undefined,
          });
        }

        // Check for position shifts
        const positions = provisionalPositionsByUri.get(fileDiff.targetUri);
        if (positions) {
          this.detectPositionShifts(fileDiff, positions, discrepancies);
        }

        // Check for duplicate chunks
        this.detectDuplicateChunks(fileDiff.targetUri, positions ?? [], discrepancies);
      }

      // Always use the canonical output for the reconciled operations
      reconciledOperations.push(this.fileDiffToOperation(fileDiff));

      // Remove from provisional map (to detect extras later)
      provisionalByUri.delete(fileDiff.targetUri);
    }

    // Check for files in provisional that are not in canonical (extra files)
    for (const [uri] of provisionalByUri) {
      discrepancies.push({
        targetUri: uri,
        kind: 'extra_file',
        description: `File '${uri}' present in provisional state but not in canonical diff`,
      });
    }

    return {
      operations: Object.freeze(reconciledOperations),
      discrepancies: Object.freeze(discrepancies),
      hadDiscrepancies: discrepancies.length > 0,
      success: true,
      canonicalFingerprint: canonical.fingerprint,
    };
  }

  /**
   * Detects position shifts between the provisional positions and canonical diff.
   */
  private detectPositionShifts(
    fileDiff: FileDiff,
    positions: PositionContext[],
    discrepancies: Discrepancy[]
  ): void {
    // If the canonical has hunks, check that provisional positions align
    if (fileDiff.hunks.length === 0) return;

    // Check if the combined provisional content length differs significantly,
    // which would indicate position shifts
    const totalProvisionalLength = positions.reduce(
      (sum, p) => sum + p.accumulatedContent.length,
      0
    );
    const canonicalLength = (fileDiff.proposedContent ?? '').length;

    if (totalProvisionalLength !== canonicalLength && totalProvisionalLength > 0) {
      discrepancies.push({
        targetUri: fileDiff.targetUri,
        kind: 'position_shift',
        description:
          `Position shift detected for '${fileDiff.targetUri}': ` +
          `provisional length (${totalProvisionalLength}) differs from ` +
          `canonical length (${canonicalLength})`,
        provisionalValue: String(totalProvisionalLength),
        canonicalValue: String(canonicalLength),
      });
    }
  }

  /**
   * Detects duplicate chunks in the provisional positions.
   */
  private detectDuplicateChunks(
    targetUri: string,
    positions: PositionContext[],
    discrepancies: Discrepancy[]
  ): void {
    const contentSet = new Set<string>();
    for (const pos of positions) {
      if (pos.accumulatedContent && contentSet.has(pos.accumulatedContent)) {
        discrepancies.push({
          targetUri,
          kind: 'duplicate_chunk',
          description:
            `Duplicate chunk detected for '${targetUri}' in hunk '${pos.hunkId}'`,
          provisionalValue: pos.accumulatedContent,
        });
      }
      if (pos.accumulatedContent) {
        contentSet.add(pos.accumulatedContent);
      }
    }
  }

  /**
   * Converts a FileDiff to the appropriate FileOperation using canonical content.
   */
  private fileDiffToOperation(fileDiff: FileDiff): FileOperation {
    switch (fileDiff.kind) {
      case 'create':
        return {
          kind: 'create',
          targetUri: fileDiff.targetUri,
          proposedBlob: fileDiff.proposedContent ?? '',
        };
      case 'modify':
        return {
          kind: 'modify',
          targetUri: fileDiff.targetUri,
          baseHash: fileDiff.baseHash,
          proposedBlob: fileDiff.proposedContent ?? '',
        };
      case 'delete':
        return {
          kind: 'delete',
          targetUri: fileDiff.targetUri,
          baseHash: fileDiff.baseHash,
        };
    }
  }

  /**
   * Extracts the primary URI from a FileOperation.
   */
  private getOperationUri(op: FileOperation): string {
    if (op.kind === 'rename' || op.kind === 'move') {
      return op.sourceUri;
    }
    return op.targetUri;
  }

  /**
   * Extracts the proposed content from a FileOperation.
   */
  private getOperationContent(op: FileOperation): string | null {
    switch (op.kind) {
      case 'create':
        return op.proposedBlob;
      case 'modify':
        return op.proposedBlob;
      case 'delete':
        return null;
      case 'rename':
      case 'move':
        return null;
    }
  }
}
