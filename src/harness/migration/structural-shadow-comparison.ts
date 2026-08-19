/**
 * Structural Shadow Comparison
 *
 * Compares identical normalized inputs across legacy-visible and canonical-shadow
 * paths, verifying structural equivalence at the node/block level. Unexpected
 * divergences block rollout advancement while allowlisted lossy legacy differences
 * are counted and typed.
 *
 * Comparison dimensions:
 * - Node/block stable keys, kinds, order, revisions, source ranges, terminal outcomes
 * - Content digests and fallback decisions
 * - Action eligibility, disabled reasons, and confirmation states
 * - Unread and reader behavior
 * - Persistence/replay checkpoints
 * - Semantic snapshots and focus transitions
 *
 * Forbidden divergences that ALWAYS block advancement:
 * - Content loss (durable content absent in canonical)
 * - Duplicate nodes (canonical produces extra nodes for same turn)
 * - False success (terminal state shown as completed when it's not)
 * - Authority/redaction mismatch (action or protected content differs)
 * - Focus loss (focused node missing in canonical projection)
 * - Anchor failure (semantic anchor absent or broken)
 *
 * Requirements: 21.1–21.6, 22.4, 22.9–22.10
 */

import type { ChatNodeV1 } from '../contracts/chat-node.js';
import type {
  ResponseCompositionV1,
  ResponseBlockV1,
  ResponseBlockKind,
  ResponseBlockStatus,
} from '../contracts/response-composition.js';

// ─── Divergence Classification ──────────────────────────────────

/**
 * All possible structural divergence kinds detected during shadow comparison.
 */
export type StructuralDivergenceKind =
  // Node-level divergences
  | 'node_key_mismatch'
  | 'node_kind_mismatch'
  | 'node_order_mismatch'
  | 'node_revision_mismatch'
  | 'node_source_range_mismatch'
  | 'node_terminal_outcome_mismatch'
  | 'node_missing_in_canonical'
  | 'node_missing_in_legacy'
  | 'node_duplicate_in_canonical'
  // Block-level divergences
  | 'block_key_mismatch'
  | 'block_kind_mismatch'
  | 'block_order_mismatch'
  | 'block_revision_mismatch'
  | 'block_status_mismatch'
  | 'block_content_digest_mismatch'
  | 'block_fallback_decision_mismatch'
  // Action divergences
  | 'action_eligibility_mismatch'
  | 'action_reason_mismatch'
  | 'action_confirmation_mismatch'
  // Reader/unread divergences
  | 'unread_count_mismatch'
  | 'reader_behavior_mismatch'
  // Checkpoint divergences
  | 'checkpoint_hash_mismatch'
  | 'checkpoint_revision_mismatch'
  // Focus/anchor divergences
  | 'semantic_anchor_mismatch'
  | 'focus_transition_mismatch'
  // Fatal: never allowed
  | 'content_loss'
  | 'duplicate_node'
  | 'false_success'
  | 'authority_mismatch'
  | 'redaction_mismatch'
  | 'focus_loss'
  | 'anchor_failure';

/**
 * Typed reasons why a legacy-only divergence is expected and allowlisted.
 * These represent known lossy behaviors in the legacy path that the canonical
 * path intentionally improves upon.
 */
export type AllowlistedDivergenceReason =
  | 'legacy_lacks_block_stable_keys'
  | 'legacy_lacks_composition_structure'
  | 'legacy_status_granularity'
  | 'legacy_coalesced_ordering'
  | 'legacy_missing_semantic_anchor'
  | 'legacy_approximate_source_range'
  | 'legacy_untyped_action_eligibility'
  | 'legacy_reader_heuristic_difference'
  | 'legacy_checkpoint_format_incompatible';

// ─── Divergence Records ─────────────────────────────────────────

/**
 * A single structural divergence record with redacted content suitable
 * for diagnostics without leaking user data.
 */
export interface StructuralDivergenceRecord {
  /** Unique identifier for this divergence */
  readonly divergenceId: string;
  /** Classification of the divergence */
  readonly kind: StructuralDivergenceKind;
  /** Whether this divergence is allowlisted as an expected legacy loss */
  readonly allowlisted: boolean;
  /** Typed reason for allowlisting (only present when allowlisted=true) */
  readonly allowlistReason?: AllowlistedDivergenceReason;
  /** Redacted structural description (no user content) */
  readonly description: string;
  /** Affected node stable key (if applicable) */
  readonly nodeStableKey?: string;
  /** Affected block stable key (if applicable) */
  readonly blockStableKey?: string;
  /** Legacy value summary (redacted, structural only) */
  readonly legacySummary?: string;
  /** Canonical value summary (redacted, structural only) */
  readonly canonicalSummary?: string;
  /** Timestamp when detected */
  readonly detectedAt: string;
}

// ─── Comparison Inputs ──────────────────────────────────────────

/**
 * Snapshot of the legacy-visible path's structural projection.
 */
export interface LegacyVisibleSnapshot {
  /** Session identity */
  readonly sessionId: string;
  /** Branch identity */
  readonly branchId: string;
  /** Ordered node projections from the legacy-visible path */
  readonly nodes: readonly LegacyNodeSnapshot[];
  /** Reader state from the legacy path */
  readonly reader: LegacyReaderSnapshot;
  /** Checkpoint from the legacy path */
  readonly checkpoint: LegacyCheckpointSnapshot;
  /** Focus/anchor state */
  readonly focus: LegacyFocusSnapshot;
}

export interface LegacyNodeSnapshot {
  /** Stable key (may be absent in older legacy formats) */
  readonly stableKey?: string;
  /** Node kind */
  readonly nodeKind: string;
  /** Source sequence range */
  readonly sourceSequenceStart: number;
  readonly sourceSequenceEnd: number;
  /** Content revision */
  readonly contentRevision: number;
  /** Turn identity */
  readonly turnId?: string;
  /** Terminal outcome (for turn tails) */
  readonly terminalOutcome?: string;
  /** Content digest (hash of durable content, not raw content) */
  readonly contentDigest?: string;
  /** Block snapshots (if composition data is available) */
  readonly blocks?: readonly LegacyBlockSnapshot[];
  /** Actions eligible on this node */
  readonly actions?: readonly LegacyActionSnapshot[];
}

export interface LegacyBlockSnapshot {
  readonly stableKey?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly contentRevision?: number;
  readonly contentDigest?: string;
  readonly fallbackApplied?: boolean;
}

export interface LegacyActionSnapshot {
  readonly actionId: string;
  readonly eligible: boolean;
  readonly disabledReason?: string;
  readonly confirmed?: boolean;
}

export interface LegacyReaderSnapshot {
  readonly followsBottom: boolean;
  readonly unreadCount: number;
  readonly lastReadStableKey?: string;
}

export interface LegacyCheckpointSnapshot {
  readonly revision: number;
  readonly hash?: string;
}

export interface LegacyFocusSnapshot {
  readonly focusedNodeStableKey?: string;
  readonly semanticAnchor?: string;
  readonly anchorOffsetDip?: number;
}

/**
 * Snapshot of the canonical-shadow path's structural projection.
 */
export interface CanonicalShadowSnapshot {
  /** Session identity */
  readonly sessionId: string;
  /** Branch identity */
  readonly branchId: string;
  /** Ordered canonical chat nodes */
  readonly nodes: readonly CanonicalNodeSnapshot[];
  /** Compositions attached to assistant nodes */
  readonly compositions: readonly CanonicalCompositionSnapshot[];
  /** Reader state from canonical projection */
  readonly reader: CanonicalReaderSnapshot;
  /** Checkpoint from canonical projection */
  readonly checkpoint: CanonicalCheckpointSnapshot;
  /** Focus/anchor state */
  readonly focus: CanonicalFocusSnapshot;
}

export interface CanonicalNodeSnapshot {
  readonly stableKey: string;
  readonly nodeKind: string;
  readonly sourceSequenceStart: number;
  readonly sourceSequenceEnd: number;
  readonly contentRevision: number;
  readonly turnId?: string;
  readonly terminalOutcome?: string;
  readonly contentDigest?: string;
}

export interface CanonicalCompositionSnapshot {
  readonly compositionId: string;
  readonly chatNodeStableKey: string;
  readonly semanticAnchor: string;
  readonly sourceRevision: number;
  readonly blocks: readonly CanonicalBlockSnapshot[];
  readonly actions: readonly CanonicalActionSnapshot[];
}

export interface CanonicalBlockSnapshot {
  readonly stableKey: string;
  readonly kind: ResponseBlockKind;
  readonly status: ResponseBlockStatus;
  readonly contentRevision: number;
  readonly contentDigest: string;
  readonly fallbackApplied: boolean;
  readonly semanticAnchor: string;
}

export interface CanonicalActionSnapshot {
  readonly actionId: string;
  readonly eligible: boolean;
  readonly disabledReason?: string;
  readonly confirmed?: boolean;
}

export interface CanonicalReaderSnapshot {
  readonly followsBottom: boolean;
  readonly unreadCount: number;
  readonly lastReadStableKey?: string;
}

export interface CanonicalCheckpointSnapshot {
  readonly revision: number;
  readonly hash: string;
}

export interface CanonicalFocusSnapshot {
  readonly focusedNodeStableKey?: string;
  readonly semanticAnchor?: string;
  readonly anchorOffsetDip?: number;
}

// ─── Comparison Result ──────────────────────────────────────────

/**
 * Complete result of a structural shadow comparison run.
 */
export interface StructuralComparisonResult {
  /** Session compared */
  readonly sessionId: string;
  /** Whether the comparison passes (no forbidden divergences) */
  readonly passes: boolean;
  /** Whether advancement is blocked (any forbidden divergence present) */
  readonly gateBlocked: boolean;
  /** Total nodes compared */
  readonly totalNodesCompared: number;
  /** Total blocks compared */
  readonly totalBlocksCompared: number;
  /** All divergences detected */
  readonly divergences: readonly StructuralDivergenceRecord[];
  /** Count of allowlisted (expected) divergences */
  readonly allowlistedCount: number;
  /** Count of unexpected divergences (blocks advancement) */
  readonly unexpectedCount: number;
  /** Count of forbidden divergences (always blocks) */
  readonly forbiddenCount: number;
  /** Counters by divergence kind */
  readonly countersByKind: Readonly<Record<string, number>>;
  /** Comparison timestamp */
  readonly comparedAt: string;
}

// ─── Configuration ──────────────────────────────────────────────

export interface StructuralShadowComparisonConfig {
  /** Maximum divergence records to retain (bounded for memory) */
  readonly maxRecords?: number;
  /** Whether to perform deep content-digest comparison */
  readonly deepContentComparison?: boolean;
  /** Custom allowlist extensions (for testing only) */
  readonly customAllowlist?: readonly AllowlistedDivergenceReason[];
}

// ─── Forbidden Divergence Kinds ─────────────────────────────────

/**
 * Divergence kinds that ALWAYS block advancement regardless of allowlisting.
 * These represent data integrity or safety failures that cannot be tolerated.
 */
const FORBIDDEN_DIVERGENCES: ReadonlySet<StructuralDivergenceKind> = new Set([
  'content_loss',
  'duplicate_node',
  'false_success',
  'authority_mismatch',
  'redaction_mismatch',
  'focus_loss',
  'anchor_failure',
]);

// ─── Default Allowlist ──────────────────────────────────────────

/**
 * Maps divergence kinds to their default allowlist reasons when the legacy
 * path is known to lack the equivalent capability.
 */
const DEFAULT_ALLOWLIST: ReadonlyMap<StructuralDivergenceKind, AllowlistedDivergenceReason> = new Map([
  ['block_key_mismatch', 'legacy_lacks_block_stable_keys'],
  ['block_kind_mismatch', 'legacy_lacks_composition_structure'],
  ['block_order_mismatch', 'legacy_lacks_composition_structure'],
  ['block_status_mismatch', 'legacy_status_granularity'],
  ['block_revision_mismatch', 'legacy_lacks_composition_structure'],
  ['node_order_mismatch', 'legacy_coalesced_ordering'],
  ['node_source_range_mismatch', 'legacy_approximate_source_range'],
  ['action_eligibility_mismatch', 'legacy_untyped_action_eligibility'],
  ['action_reason_mismatch', 'legacy_untyped_action_eligibility'],
  ['reader_behavior_mismatch', 'legacy_reader_heuristic_difference'],
  ['checkpoint_hash_mismatch', 'legacy_checkpoint_format_incompatible'],
  ['semantic_anchor_mismatch', 'legacy_missing_semantic_anchor'],
]);

// ─── Structural Shadow Comparison Engine ────────────────────────

/**
 * StructuralShadowComparison runs both legacy-visible and canonical-shadow
 * paths on the same normalized input, then compares their structural projections
 * for equivalence. Divergences are classified as allowlisted (expected legacy
 * losses) or forbidden (data integrity failures that block advancement).
 *
 * This is the full comparison engine referenced in design section 16.3 (Parity gates).
 */
export class StructuralShadowComparison {
  private readonly config: StructuralShadowComparisonConfig;
  private divergenceCounter = 0;
  private readonly activeAllowlist: ReadonlySet<AllowlistedDivergenceReason>;

  constructor(config: StructuralShadowComparisonConfig = {}) {
    this.config = config;
    const reasons = new Set<AllowlistedDivergenceReason>(DEFAULT_ALLOWLIST.values());
    if (config.customAllowlist) {
      for (const reason of config.customAllowlist) {
        reasons.add(reason);
      }
    }
    this.activeAllowlist = reasons;
  }

  /**
   * Run a full structural comparison between legacy-visible and canonical-shadow
   * snapshots produced from the same normalized input.
   */
  compare(
    legacy: LegacyVisibleSnapshot,
    canonical: CanonicalShadowSnapshot,
  ): StructuralComparisonResult {
    const divergences: StructuralDivergenceRecord[] = [];
    const maxRecords = this.config.maxRecords ?? 500;
    let totalNodesCompared = 0;
    let totalBlocksCompared = 0;

    const addDivergence = (record: StructuralDivergenceRecord): void => {
      if (divergences.length < maxRecords) {
        divergences.push(record);
      }
    };

    // 1. Compare node-level structure
    const nodeResult = this.compareNodes(legacy.nodes, canonical.nodes);
    totalNodesCompared = Math.max(legacy.nodes.length, canonical.nodes.length);
    for (const div of nodeResult) {
      addDivergence(div);
    }

    // 2. Compare block-level structure (compositions)
    const blockResult = this.compareCompositions(
      legacy.nodes,
      canonical.compositions,
    );
    totalBlocksCompared = blockResult.blocksCompared;
    for (const div of blockResult.divergences) {
      addDivergence(div);
    }

    // 3. Compare action eligibility, reasons, and confirmations
    const actionResult = this.compareActions(legacy.nodes, canonical.compositions);
    for (const div of actionResult) {
      addDivergence(div);
    }

    // 4. Compare unread/reader behavior
    const readerResult = this.compareReaderState(legacy.reader, canonical.reader);
    for (const div of readerResult) {
      addDivergence(div);
    }

    // 5. Compare checkpoints
    const checkpointResult = this.compareCheckpoints(
      legacy.checkpoint,
      canonical.checkpoint,
    );
    for (const div of checkpointResult) {
      addDivergence(div);
    }

    // 6. Compare focus transitions and semantic anchors
    const focusResult = this.compareFocus(legacy.focus, canonical.focus);
    for (const div of focusResult) {
      addDivergence(div);
    }

    // Compute counters
    const countersByKind: Record<string, number> = {};
    let allowlistedCount = 0;
    let unexpectedCount = 0;
    let forbiddenCount = 0;

    for (const div of divergences) {
      countersByKind[div.kind] = (countersByKind[div.kind] ?? 0) + 1;
      if (FORBIDDEN_DIVERGENCES.has(div.kind)) {
        forbiddenCount++;
      } else if (div.allowlisted) {
        allowlistedCount++;
      } else {
        unexpectedCount++;
      }
    }

    const gateBlocked = forbiddenCount > 0 || unexpectedCount > 0;

    return {
      sessionId: legacy.sessionId,
      passes: !gateBlocked,
      gateBlocked,
      totalNodesCompared,
      totalBlocksCompared,
      divergences,
      allowlistedCount,
      unexpectedCount,
      forbiddenCount,
      countersByKind,
      comparedAt: new Date().toISOString(),
    };
  }

  /**
   * Check if a divergence kind is strictly forbidden and can never be allowlisted.
   */
  isForbidden(kind: StructuralDivergenceKind): boolean {
    return FORBIDDEN_DIVERGENCES.has(kind);
  }

  /**
   * Get the set of forbidden divergence kinds.
   */
  getForbiddenKinds(): ReadonlySet<StructuralDivergenceKind> {
    return FORBIDDEN_DIVERGENCES;
  }

  // ─── Node Comparison ────────────────────────────────────────────

  private compareNodes(
    legacyNodes: readonly LegacyNodeSnapshot[],
    canonicalNodes: readonly CanonicalNodeSnapshot[],
  ): StructuralDivergenceRecord[] {
    const divergences: StructuralDivergenceRecord[] = [];

    // Check for nodes present in legacy but missing in canonical (content loss)
    const canonicalKeySet = new Set(canonicalNodes.map(n => n.stableKey));
    const canonicalTurnIds = new Set(canonicalNodes.filter(n => n.turnId).map(n => n.turnId));

    for (const legacyNode of legacyNodes) {
      if (legacyNode.stableKey && !canonicalKeySet.has(legacyNode.stableKey)) {
        // If the legacy node has content, this is content loss
        if (legacyNode.contentDigest) {
          divergences.push(this.createDivergence(
            'content_loss',
            `Node with durable content present in legacy but absent in canonical`,
            legacyNode.stableKey,
            undefined,
            `kind=${legacyNode.nodeKind}, rev=${legacyNode.contentRevision}`,
            'absent',
          ));
        } else {
          divergences.push(this.createDivergence(
            'node_missing_in_canonical',
            `Node present in legacy but absent in canonical projection`,
            legacyNode.stableKey,
            undefined,
            `kind=${legacyNode.nodeKind}`,
            'absent',
          ));
        }
      }
    }

    // Check for duplicate nodes in canonical (same turnId with multiple entries)
    const canonicalTurnCounts = new Map<string, number>();
    for (const node of canonicalNodes) {
      if (node.turnId && node.nodeKind === 'message') {
        const count = canonicalTurnCounts.get(node.turnId) ?? 0;
        canonicalTurnCounts.set(node.turnId, count + 1);
      }
    }
    for (const [turnId, count] of canonicalTurnCounts) {
      if (count > 1) {
        divergences.push(this.createDivergence(
          'duplicate_node',
          `Canonical projection has ${count} message nodes for the same turn`,
          undefined,
          undefined,
          'expected=1',
          `actual=${count}, turnId=${turnId}`,
        ));
      }
    }

    // Check for nodes in canonical but not in legacy
    const legacyKeySet = new Set(
      legacyNodes.filter(n => n.stableKey).map(n => n.stableKey!),
    );
    for (const canonicalNode of canonicalNodes) {
      if (!legacyKeySet.has(canonicalNode.stableKey) && legacyKeySet.size > 0) {
        divergences.push(this.createDivergence(
          'node_missing_in_legacy',
          `Node present in canonical but absent in legacy projection`,
          canonicalNode.stableKey,
          undefined,
          'absent',
          `kind=${canonicalNode.nodeKind}`,
        ));
      }
    }

    // Compare aligned nodes by order
    const alignedPairs = this.alignNodesByKey(legacyNodes, canonicalNodes);
    for (const { legacy, canonical, index } of alignedPairs) {
      // Kind mismatch
      if (legacy.nodeKind !== canonical.nodeKind) {
        divergences.push(this.createDivergence(
          'node_kind_mismatch',
          `Node kind differs at position ${index}`,
          canonical.stableKey,
          undefined,
          `kind=${legacy.nodeKind}`,
          `kind=${canonical.nodeKind}`,
        ));
      }

      // Source range mismatch
      if (
        legacy.sourceSequenceStart !== canonical.sourceSequenceStart ||
        legacy.sourceSequenceEnd !== canonical.sourceSequenceEnd
      ) {
        divergences.push(this.createDivergence(
          'node_source_range_mismatch',
          `Node source range differs`,
          canonical.stableKey,
          undefined,
          `range=[${legacy.sourceSequenceStart},${legacy.sourceSequenceEnd}]`,
          `range=[${canonical.sourceSequenceStart},${canonical.sourceSequenceEnd}]`,
        ));
      }

      // Revision mismatch
      if (legacy.contentRevision !== canonical.contentRevision) {
        divergences.push(this.createDivergence(
          'node_revision_mismatch',
          `Node content revision differs`,
          canonical.stableKey,
          undefined,
          `rev=${legacy.contentRevision}`,
          `rev=${canonical.contentRevision}`,
        ));
      }

      // Terminal outcome mismatch (critical: false success detection)
      if (legacy.terminalOutcome !== canonical.terminalOutcome) {
        if (canonical.terminalOutcome === 'completed' && legacy.terminalOutcome !== 'completed') {
          divergences.push(this.createDivergence(
            'false_success',
            `Canonical shows completed but legacy shows ${legacy.terminalOutcome ?? 'no terminal'}`,
            canonical.stableKey,
            undefined,
            `outcome=${legacy.terminalOutcome ?? 'none'}`,
            `outcome=${canonical.terminalOutcome}`,
          ));
        } else {
          divergences.push(this.createDivergence(
            'node_terminal_outcome_mismatch',
            `Terminal outcome differs`,
            canonical.stableKey,
            undefined,
            `outcome=${legacy.terminalOutcome ?? 'none'}`,
            `outcome=${canonical.terminalOutcome ?? 'none'}`,
          ));
        }
      }

      // Content digest mismatch (content loss detection)
      if (
        this.config.deepContentComparison !== false &&
        legacy.contentDigest &&
        canonical.contentDigest &&
        legacy.contentDigest !== canonical.contentDigest
      ) {
        divergences.push(this.createDivergence(
          'content_loss',
          `Node content digest differs — possible durable content loss`,
          canonical.stableKey,
          undefined,
          `digest=${legacy.contentDigest.slice(0, 16)}...`,
          `digest=${canonical.contentDigest.slice(0, 16)}...`,
        ));
      }
    }

    // Order comparison
    const legacyOrder = legacyNodes.filter(n => n.stableKey).map(n => n.stableKey!);
    const canonicalOrder = canonicalNodes.map(n => n.stableKey);
    if (!this.arraysEqual(legacyOrder, canonicalOrder) && legacyOrder.length > 0 && canonicalOrder.length > 0) {
      divergences.push(this.createDivergence(
        'node_order_mismatch',
        `Node ordering differs between legacy and canonical projections`,
        undefined,
        undefined,
        `count=${legacyOrder.length}`,
        `count=${canonicalOrder.length}`,
      ));
    }

    return divergences;
  }

  // ─── Block/Composition Comparison ─────────────────────────────

  private compareCompositions(
    legacyNodes: readonly LegacyNodeSnapshot[],
    canonicalCompositions: readonly CanonicalCompositionSnapshot[],
  ): { divergences: StructuralDivergenceRecord[]; blocksCompared: number } {
    const divergences: StructuralDivergenceRecord[] = [];
    let blocksCompared = 0;

    // Build a map from node key to composition
    const compositionsByNodeKey = new Map<string, CanonicalCompositionSnapshot>();
    for (const comp of canonicalCompositions) {
      compositionsByNodeKey.set(comp.chatNodeStableKey, comp);
    }

    for (const legacyNode of legacyNodes) {
      if (!legacyNode.blocks || !legacyNode.stableKey) continue;

      const composition = compositionsByNodeKey.get(legacyNode.stableKey);
      if (!composition) {
        // Legacy has blocks but canonical has no composition — allowed if legacy
        // lacks proper composition structure
        if (legacyNode.blocks.length > 0) {
          divergences.push(this.createDivergence(
            'block_key_mismatch',
            `Legacy node has ${legacyNode.blocks.length} blocks but no canonical composition`,
            legacyNode.stableKey,
            undefined,
            `blockCount=${legacyNode.blocks.length}`,
            'no composition',
          ));
        }
        continue;
      }

      // Compare blocks
      const legacyBlocks = legacyNode.blocks;
      const canonicalBlocks = composition.blocks;
      blocksCompared += Math.max(legacyBlocks.length, canonicalBlocks.length);

      // Block count/order comparison
      if (legacyBlocks.length !== canonicalBlocks.length) {
        divergences.push(this.createDivergence(
          'block_order_mismatch',
          `Block count differs for composition`,
          legacyNode.stableKey,
          undefined,
          `count=${legacyBlocks.length}`,
          `count=${canonicalBlocks.length}`,
        ));
      }

      // Compare individual blocks by position
      const minLen = Math.min(legacyBlocks.length, canonicalBlocks.length);
      for (let i = 0; i < minLen; i++) {
        const legacyBlock = legacyBlocks[i]!;
        const canonicalBlock = canonicalBlocks[i]!;

        // Kind mismatch
        if (legacyBlock.kind && legacyBlock.kind !== canonicalBlock.kind) {
          divergences.push(this.createDivergence(
            'block_kind_mismatch',
            `Block kind differs at position ${i}`,
            legacyNode.stableKey,
            canonicalBlock.stableKey,
            `kind=${legacyBlock.kind}`,
            `kind=${canonicalBlock.kind}`,
          ));
        }

        // Status mismatch
        if (legacyBlock.status && legacyBlock.status !== canonicalBlock.status) {
          divergences.push(this.createDivergence(
            'block_status_mismatch',
            `Block status differs at position ${i}`,
            legacyNode.stableKey,
            canonicalBlock.stableKey,
            `status=${legacyBlock.status}`,
            `status=${canonicalBlock.status}`,
          ));
        }

        // Content digest mismatch (content loss detection)
        if (
          this.config.deepContentComparison !== false &&
          legacyBlock.contentDigest &&
          canonicalBlock.contentDigest &&
          legacyBlock.contentDigest !== canonicalBlock.contentDigest
        ) {
          divergences.push(this.createDivergence(
            'content_loss',
            `Block content digest differs — possible content loss at position ${i}`,
            legacyNode.stableKey,
            canonicalBlock.stableKey,
            `digest=${legacyBlock.contentDigest.slice(0, 16)}...`,
            `digest=${canonicalBlock.contentDigest.slice(0, 16)}...`,
          ));
        }

        // Fallback decision mismatch
        if (
          legacyBlock.fallbackApplied !== undefined &&
          legacyBlock.fallbackApplied !== canonicalBlock.fallbackApplied
        ) {
          divergences.push(this.createDivergence(
            'block_fallback_decision_mismatch',
            `Fallback decision differs at position ${i}`,
            legacyNode.stableKey,
            canonicalBlock.stableKey,
            `fallback=${legacyBlock.fallbackApplied}`,
            `fallback=${canonicalBlock.fallbackApplied}`,
          ));
        }

        // Revision mismatch
        if (
          legacyBlock.contentRevision !== undefined &&
          legacyBlock.contentRevision !== canonicalBlock.contentRevision
        ) {
          divergences.push(this.createDivergence(
            'block_revision_mismatch',
            `Block content revision differs at position ${i}`,
            legacyNode.stableKey,
            canonicalBlock.stableKey,
            `rev=${legacyBlock.contentRevision}`,
            `rev=${canonicalBlock.contentRevision}`,
          ));
        }
      }
    }

    return { divergences, blocksCompared };
  }

  // ─── Action Comparison ────────────────────────────────────────

  private compareActions(
    legacyNodes: readonly LegacyNodeSnapshot[],
    canonicalCompositions: readonly CanonicalCompositionSnapshot[],
  ): StructuralDivergenceRecord[] {
    const divergences: StructuralDivergenceRecord[] = [];

    const compositionsByNodeKey = new Map<string, CanonicalCompositionSnapshot>();
    for (const comp of canonicalCompositions) {
      compositionsByNodeKey.set(comp.chatNodeStableKey, comp);
    }

    for (const legacyNode of legacyNodes) {
      if (!legacyNode.actions || !legacyNode.stableKey) continue;

      const composition = compositionsByNodeKey.get(legacyNode.stableKey);
      if (!composition) continue;

      const canonicalActions = composition.actions;
      const legacyActions = legacyNode.actions;

      // Build action maps
      const legacyActionMap = new Map(legacyActions.map(a => [a.actionId, a]));
      const canonicalActionMap = new Map(canonicalActions.map(a => [a.actionId, a]));

      for (const [actionId, legacyAction] of legacyActionMap) {
        const canonicalAction = canonicalActionMap.get(actionId);
        if (!canonicalAction) {
          divergences.push(this.createDivergence(
            'action_eligibility_mismatch',
            `Action ${actionId} eligible in legacy but absent in canonical`,
            legacyNode.stableKey,
            undefined,
            `eligible=${legacyAction.eligible}`,
            'absent',
          ));
          continue;
        }

        if (legacyAction.eligible !== canonicalAction.eligible) {
          // Check for authority mismatch — if legacy says NOT eligible but canonical says eligible,
          // that could expose unauthorized actions
          if (!legacyAction.eligible && canonicalAction.eligible) {
            divergences.push(this.createDivergence(
              'authority_mismatch',
              `Action ${actionId} ineligible in legacy but eligible in canonical — potential authority bypass`,
              legacyNode.stableKey,
              undefined,
              `eligible=false, reason=${legacyAction.disabledReason ?? 'none'}`,
              `eligible=true`,
            ));
          } else {
            divergences.push(this.createDivergence(
              'action_eligibility_mismatch',
              `Action ${actionId} eligibility differs`,
              legacyNode.stableKey,
              undefined,
              `eligible=${legacyAction.eligible}`,
              `eligible=${canonicalAction.eligible}`,
            ));
          }
        }

        if (legacyAction.disabledReason !== canonicalAction.disabledReason) {
          divergences.push(this.createDivergence(
            'action_reason_mismatch',
            `Action ${actionId} disabled reason differs`,
            legacyNode.stableKey,
            undefined,
            `reason=${legacyAction.disabledReason ?? 'none'}`,
            `reason=${canonicalAction.disabledReason ?? 'none'}`,
          ));
        }

        if (legacyAction.confirmed !== canonicalAction.confirmed) {
          divergences.push(this.createDivergence(
            'action_confirmation_mismatch',
            `Action ${actionId} confirmation state differs`,
            legacyNode.stableKey,
            undefined,
            `confirmed=${legacyAction.confirmed ?? 'undefined'}`,
            `confirmed=${canonicalAction.confirmed ?? 'undefined'}`,
          ));
        }
      }
    }

    return divergences;
  }

  // ─── Reader/Unread Comparison ─────────────────────────────────

  private compareReaderState(
    legacy: LegacyReaderSnapshot,
    canonical: CanonicalReaderSnapshot,
  ): StructuralDivergenceRecord[] {
    const divergences: StructuralDivergenceRecord[] = [];

    if (legacy.unreadCount !== canonical.unreadCount) {
      divergences.push(this.createDivergence(
        'unread_count_mismatch',
        `Unread count differs`,
        undefined,
        undefined,
        `unread=${legacy.unreadCount}`,
        `unread=${canonical.unreadCount}`,
      ));
    }

    if (legacy.followsBottom !== canonical.followsBottom) {
      divergences.push(this.createDivergence(
        'reader_behavior_mismatch',
        `Reader follows-bottom state differs`,
        undefined,
        undefined,
        `followsBottom=${legacy.followsBottom}`,
        `followsBottom=${canonical.followsBottom}`,
      ));
    }

    if (
      legacy.lastReadStableKey !== canonical.lastReadStableKey &&
      legacy.lastReadStableKey !== undefined &&
      canonical.lastReadStableKey !== undefined
    ) {
      divergences.push(this.createDivergence(
        'reader_behavior_mismatch',
        `Last-read stable key differs`,
        undefined,
        undefined,
        `lastRead=${legacy.lastReadStableKey}`,
        `lastRead=${canonical.lastReadStableKey}`,
      ));
    }

    return divergences;
  }

  // ─── Checkpoint Comparison ────────────────────────────────────

  private compareCheckpoints(
    legacy: LegacyCheckpointSnapshot,
    canonical: CanonicalCheckpointSnapshot,
  ): StructuralDivergenceRecord[] {
    const divergences: StructuralDivergenceRecord[] = [];

    if (legacy.revision !== canonical.revision) {
      divergences.push(this.createDivergence(
        'checkpoint_revision_mismatch',
        `Checkpoint revision differs`,
        undefined,
        undefined,
        `rev=${legacy.revision}`,
        `rev=${canonical.revision}`,
      ));
    }

    if (legacy.hash && canonical.hash && legacy.hash !== canonical.hash) {
      divergences.push(this.createDivergence(
        'checkpoint_hash_mismatch',
        `Checkpoint hash differs`,
        undefined,
        undefined,
        `hash=${legacy.hash.slice(0, 16)}...`,
        `hash=${canonical.hash.slice(0, 16)}...`,
      ));
    }

    return divergences;
  }

  // ─── Focus/Anchor Comparison ──────────────────────────────────

  private compareFocus(
    legacy: LegacyFocusSnapshot,
    canonical: CanonicalFocusSnapshot,
  ): StructuralDivergenceRecord[] {
    const divergences: StructuralDivergenceRecord[] = [];

    // Focus loss detection: if legacy has focus but canonical doesn't
    if (legacy.focusedNodeStableKey && !canonical.focusedNodeStableKey) {
      divergences.push(this.createDivergence(
        'focus_loss',
        `Focused node present in legacy but missing in canonical`,
        legacy.focusedNodeStableKey,
        undefined,
        `focused=${legacy.focusedNodeStableKey}`,
        'no focus',
      ));
    }

    // Semantic anchor comparison
    if (
      legacy.semanticAnchor &&
      canonical.semanticAnchor &&
      legacy.semanticAnchor !== canonical.semanticAnchor
    ) {
      divergences.push(this.createDivergence(
        'semantic_anchor_mismatch',
        `Semantic anchor identity differs`,
        undefined,
        undefined,
        `anchor=${legacy.semanticAnchor}`,
        `anchor=${canonical.semanticAnchor}`,
      ));
    }

    // Anchor failure: if canonical claims to have an anchor but it points to nowhere
    if (canonical.semanticAnchor && canonical.focusedNodeStableKey === undefined && legacy.focusedNodeStableKey) {
      divergences.push(this.createDivergence(
        'anchor_failure',
        `Canonical has semantic anchor but no focused node — anchor resolution failed`,
        undefined,
        undefined,
        `anchor=${canonical.semanticAnchor}`,
        'unresolvable',
      ));
    }

    // Focus transition comparison (DIP offset)
    if (
      legacy.anchorOffsetDip !== undefined &&
      canonical.anchorOffsetDip !== undefined &&
      legacy.semanticAnchor === canonical.semanticAnchor
    ) {
      const drift = Math.abs(legacy.anchorOffsetDip - canonical.anchorOffsetDip);
      if (drift > 2) {
        divergences.push(this.createDivergence(
          'focus_transition_mismatch',
          `Anchor offset drift exceeds 2 DIP`,
          undefined,
          undefined,
          `offset=${legacy.anchorOffsetDip}`,
          `offset=${canonical.anchorOffsetDip}`,
        ));
      }
    }

    return divergences;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private createDivergence(
    kind: StructuralDivergenceKind,
    description: string,
    nodeStableKey?: string,
    blockStableKey?: string,
    legacySummary?: string,
    canonicalSummary?: string,
  ): StructuralDivergenceRecord {
    this.divergenceCounter++;
    const isForbidden = FORBIDDEN_DIVERGENCES.has(kind);
    const allowlistReason = isForbidden ? undefined : DEFAULT_ALLOWLIST.get(kind);
    const isAllowlisted = !isForbidden && allowlistReason !== undefined;

    return {
      divergenceId: `structural-div-${this.divergenceCounter}`,
      kind,
      allowlisted: isAllowlisted,
      allowlistReason: isAllowlisted ? allowlistReason : undefined,
      description,
      nodeStableKey,
      blockStableKey,
      legacySummary,
      canonicalSummary,
      detectedAt: new Date().toISOString(),
    };
  }

  private alignNodesByKey(
    legacyNodes: readonly LegacyNodeSnapshot[],
    canonicalNodes: readonly CanonicalNodeSnapshot[],
  ): Array<{ legacy: LegacyNodeSnapshot; canonical: CanonicalNodeSnapshot; index: number }> {
    const pairs: Array<{ legacy: LegacyNodeSnapshot; canonical: CanonicalNodeSnapshot; index: number }> = [];
    const canonicalMap = new Map(canonicalNodes.map(n => [n.stableKey, n]));

    let index = 0;
    for (const legacyNode of legacyNodes) {
      if (!legacyNode.stableKey) continue;
      const canonical = canonicalMap.get(legacyNode.stableKey);
      if (canonical) {
        pairs.push({ legacy: legacyNode, canonical, index });
      }
      index++;
    }

    return pairs;
  }

  private arraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
