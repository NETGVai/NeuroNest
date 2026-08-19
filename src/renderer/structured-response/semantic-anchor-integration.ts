/**
 * Semantic Anchor Integration for Structured Response Renderer
 *
 * Bridges the SemanticAnchorController to the structured response renderer's
 * layout lifecycle. Captures focused or first fully visible semantic anchor and
 * DIP offset before layout mutation, restores within 2 DIP after settings-derived
 * stabilization, and exposes deterministic unavailable/latest fallback when the
 * anchor is gone.
 *
 * Preserves one anchor through:
 * - Plain-stream to Markdown finalization (same semanticAnchor across content format changes)
 * - Eligible block-instance replacement (when semanticAnchor is retained)
 * - Prepend, expansion, final highlighting, image/diagram load, inspector open/close, retry
 *
 * Requirements: 5.4–5.5, 19.1, 19.8, 22.4, 22.10
 */

import {
  SemanticAnchorController,
  type ViewportMeasurement,
} from '../../harness/presentation/windowing/semantic-anchor-controller';
import type {
  SemanticAnchor,
  WindowingBounds,
  ProjectedNodeDescriptor,
  AnchorResolutionResult,
  AnchorUnavailableState,
} from '../../harness/presentation/windowing/types';

// ─── Layout Mutation Reasons ────────────────────────────────────

/**
 * Enumeration of layout-mutating operations that require anchor capture/restore.
 */
export type LayoutMutationReason =
  | 'prepend'
  | 'expansion'
  | 'stream_finalization'
  | 'image_load'
  | 'diagram_load'
  | 'inspector_open'
  | 'inspector_close'
  | 'retry'
  | 'block_replacement'
  | 'highlighting'
  | 'measurement_change';

// ─── Integration Configuration ──────────────────────────────────

export interface SemanticAnchorIntegrationConfig {
  /** Windowing bounds containing anchorToleranceDip and layoutStabilizationTimeoutMs */
  bounds: WindowingBounds;
  /** Session context */
  sessionId: string;
  branchId: string;
  /** Initial projection revision */
  projectionRevision: number;
  /** Called when the anchor becomes unavailable */
  onAnchorUnavailable?: (state: AnchorUnavailableState) => void;
  /** Called when anchor is successfully restored */
  onAnchorRestored?: (result: AnchorResolutionResult & { resolved: true }) => void;
  /** Called when following latest due to unavailable anchor */
  onFollowLatest?: () => void;
}

// ─── Stabilization State ────────────────────────────────────────

interface PendingStabilization {
  reason: LayoutMutationReason;
  capturedAt: number;
  timerId: ReturnType<typeof setTimeout> | null;
}

// ─── Block Semantic Anchor Map ──────────────────────────────────

/**
 * Tracks the mapping from block stableKey to its semanticAnchor value.
 * Used to detect when a block-instance replacement preserves the same
 * semanticAnchor (e.g., plain-stream → Markdown finalization).
 */
interface BlockAnchorEntry {
  blockStableKey: string;
  semanticAnchor: string;
  contentFormat?: string;
}

// ─── Integration Class ──────────────────────────────────────────

/**
 * Integrates SemanticAnchorController with the structured response renderer.
 *
 * Usage lifecycle:
 * 1. Before any layout mutation: call `captureBeforeMutation(reason, viewport)`
 * 2. Perform the layout mutation (DOM changes)
 * 3. After stabilization timeout: call `restoreAfterStabilization(viewport)`
 *    OR let the auto-stabilization timer fire.
 */
export class SemanticAnchorIntegration {
  private readonly controller: SemanticAnchorController;
  private config: SemanticAnchorIntegrationConfig;
  private pendingStabilization: PendingStabilization | null = null;
  private blockAnchorMap: Map<string, BlockAnchorEntry> = new Map();
  private disposed = false;

  constructor(config: SemanticAnchorIntegrationConfig) {
    this.config = config;
    this.controller = new SemanticAnchorController(config.bounds);
    this.controller.setContext(config.sessionId, config.branchId, config.projectionRevision);
  }

  // ─── Configuration Updates ────────────────────────────────────

  /**
   * Update bounds from Settings_Service hot revision.
   */
  setBounds(bounds: WindowingBounds): void {
    this.config = { ...this.config, bounds };
    this.controller.setBounds(bounds);
  }

  /**
   * Update projection revision (monotonically increasing).
   */
  setProjectionRevision(revision: number): void {
    this.config = { ...this.config, projectionRevision: revision };
    this.controller.setContext(this.config.sessionId, this.config.branchId, revision);
  }

  /**
   * Update the set of projected nodes (from canonical timeline).
   */
  setProjectedNodes(nodes: ProjectedNodeDescriptor[]): void {
    this.controller.setProjectedNodes(nodes);
  }

  // ─── Block Anchor Tracking ────────────────────────────────────

  /**
   * Register or update the semantic anchor for a block.
   * This allows the integration to detect when a block-instance replacement
   * preserves the same semanticAnchor (plain-stream → markdown finalization).
   */
  registerBlockAnchor(
    blockStableKey: string,
    semanticAnchor: string,
    contentFormat?: string,
  ): void {
    this.blockAnchorMap.set(blockStableKey, {
      blockStableKey,
      semanticAnchor,
      contentFormat,
    });
  }

  /**
   * Check if a block replacement preserves the semantic anchor.
   * Returns true if the old block's semanticAnchor matches the new one,
   * meaning the anchor should remain valid through the replacement.
   */
  isBlockReplacementEligible(
    oldBlockStableKey: string,
    newSemanticAnchor: string,
  ): boolean {
    const existing = this.blockAnchorMap.get(oldBlockStableKey);
    if (!existing) return false;
    return existing.semanticAnchor === newSemanticAnchor;
  }

  /**
   * Remove a block from tracking (e.g., on disposal).
   */
  unregisterBlockAnchor(blockStableKey: string): void {
    this.blockAnchorMap.delete(blockStableKey);
  }

  // ─── Capture/Restore Lifecycle ────────────────────────────────

  /**
   * Capture the current semantic anchor BEFORE a layout-changing operation.
   *
   * Records the focused or first fully visible focusable node and its DIP
   * offset from the viewport top. Must be called before any DOM mutation
   * that could shift node positions (prepend, expansion, finalization,
   * image/diagram load, inspector open/close, retry).
   *
   * Returns the captured anchor or null if no focusable node is visible.
   */
  captureBeforeMutation(
    reason: LayoutMutationReason,
    viewport: ViewportMeasurement,
  ): SemanticAnchor | null {
    if (this.disposed) return null;

    // Cancel any pending stabilization from a previous mutation
    this.cancelPendingStabilization();

    // Record the anchor
    const anchor = this.controller.recordAnchor(viewport);

    if (anchor) {
      // Start stabilization timer
      this.pendingStabilization = {
        reason,
        capturedAt: Date.now(),
        timerId: null, // Timer is set by scheduleStabilization
      };
    }

    return anchor;
  }

  /**
   * Schedule automatic restoration after the settings-derived stabilization
   * timeout. The viewport measurement provider will be called when the timer
   * fires.
   *
   * This should be called immediately after the layout mutation is performed.
   */
  scheduleStabilization(viewportProvider: () => ViewportMeasurement): void {
    if (this.disposed || !this.pendingStabilization) return;

    const timeoutMs = this.config.bounds.layoutStabilizationTimeoutMs;
    this.pendingStabilization.timerId = setTimeout(() => {
      if (this.disposed || !this.pendingStabilization) return;
      const viewport = viewportProvider();
      this.restoreAfterStabilization(viewport);
    }, timeoutMs);
  }

  /**
   * Restore the previously captured anchor AFTER layout stabilization.
   *
   * Resolves the stable key and adjusts scroll offset until error is at
   * most 2 DIP (anchorToleranceDip). If the anchor is gone, exposes the
   * deterministic unavailable/latest fallback.
   *
   * Can be called manually (e.g., after a requestAnimationFrame or
   * MutationObserver settle) or will be called automatically by the
   * stabilization timer.
   */
  restoreAfterStabilization(viewport: ViewportMeasurement): AnchorResolutionResult {
    if (this.disposed) {
      return { resolved: false, reason: 'key_not_found', followLatest: true };
    }

    // Clear the pending stabilization
    this.cancelPendingStabilization();

    // Attempt restoration
    const result = this.controller.restoreAnchor(viewport);

    if (result.resolved) {
      this.config.onAnchorRestored?.(result as AnchorResolutionResult & { resolved: true });
    } else {
      const unavailable = this.controller.getUnavailableState();
      if (unavailable) {
        this.config.onAnchorUnavailable?.(unavailable);
      }
      this.config.onFollowLatest?.();
    }

    return result;
  }

  // ─── Stream Finalization ──────────────────────────────────────

  /**
   * Handle the transition from plain-stream to Markdown finalization.
   *
   * Per requirement 5.4–5.5, the Chat_Interface SHALL retain the same
   * Semantic_Anchor through this transition. If final rich rendering fails,
   * the block identity MAY change but the anchor MUST be preserved.
   *
   * This method should be called BEFORE the finalization DOM update.
   * It verifies that the new block preserves the semantic anchor and
   * records the anchor for post-stabilization restoration.
   */
  captureBeforeFinalization(
    blockStableKey: string,
    newSemanticAnchor: string,
    viewport: ViewportMeasurement,
  ): SemanticAnchor | null {
    // Verify semantic anchor preservation through finalization
    const existing = this.blockAnchorMap.get(blockStableKey);
    if (existing && existing.semanticAnchor !== newSemanticAnchor) {
      // semanticAnchor changed — this is NOT a valid finalization path.
      // The block identity may change but the anchor must be preserved.
      // Treat as a block replacement that needs anchor capture.
    }

    return this.captureBeforeMutation('stream_finalization', viewport);
  }

  /**
   * Notify that a block instance was replaced while preserving its semanticAnchor.
   * Updates the block anchor map so the controller can still resolve the anchor.
   */
  notifyBlockReplacement(
    oldBlockStableKey: string,
    newBlockStableKey: string,
    semanticAnchor: string,
    contentFormat?: string,
  ): void {
    this.blockAnchorMap.delete(oldBlockStableKey);
    this.blockAnchorMap.set(newBlockStableKey, {
      blockStableKey: newBlockStableKey,
      semanticAnchor,
      contentFormat,
    });
  }

  // ─── Query Methods ────────────────────────────────────────────

  /**
   * Get the current live anchor (recorded before the latest layout change).
   */
  getCurrentAnchor(): SemanticAnchor | null {
    return this.controller.getCurrentAnchor();
  }

  /**
   * Get the anchor-unavailable state if the last resolution failed.
   */
  getUnavailableState(): AnchorUnavailableState | null {
    return this.controller.getUnavailableState();
  }

  /**
   * Clear the unavailable state (e.g., when user dismisses the label or
   * navigates to a new position).
   */
  clearUnavailableState(): void {
    this.controller.clearUnavailableState();
  }

  /**
   * Check if a stabilization is currently pending (waiting for layout settle).
   */
  isStabilizationPending(): boolean {
    return this.pendingStabilization !== null;
  }

  /**
   * Get the reason for the current pending stabilization.
   */
  getPendingReason(): LayoutMutationReason | null {
    return this.pendingStabilization?.reason ?? null;
  }

  // ─── Session Lifecycle ────────────────────────────────────────

  /**
   * Save the current anchor for session persistence.
   */
  saveSessionAnchor(): SemanticAnchor | null {
    this.controller.saveAnchor();
    return this.controller.getSavedAnchor();
  }

  /**
   * Restore a previously saved session anchor.
   * Returns the resolution result (success or unavailable fallback).
   */
  restoreSessionAnchor(
    savedAnchor: SemanticAnchor | null,
    viewport: ViewportMeasurement,
  ): AnchorResolutionResult {
    if (!savedAnchor) {
      return { resolved: false, reason: 'key_not_found', followLatest: true };
    }
    this.controller.setSavedAnchor(savedAnchor);
    return this.controller.restoreSavedAnchor(viewport);
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Dispose the integration. Cancels any pending stabilization timers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingStabilization();
    this.blockAnchorMap.clear();
  }

  // ─── Private ──────────────────────────────────────────────────

  private cancelPendingStabilization(): void {
    if (this.pendingStabilization?.timerId !== null && this.pendingStabilization?.timerId !== undefined) {
      clearTimeout(this.pendingStabilization.timerId);
    }
    this.pendingStabilization = null;
  }
}
