/**
 * Keyed Composition Reconciler
 *
 * Reconciles canonical chat-node and block stable keys without remounting
 * unchanged handles. Retains focus, disclosure, selected tool, inspector
 * identity, and local measurement state across updates.
 *
 * Detects ambiguous keys before mount and replaces only the affected block
 * or whole composition according to parser scope.
 *
 * Requirements: 2.4, 2.8, 4.3, 4.10, 7.7, 18.13–18.14, 22.4
 */

import type {
  ResponseBlockKind,
  ResponseBlockV1,
  ResponseCompositionV1,
} from '../../harness/contracts/response-composition';
import type {
  RegistrySurfaceHandle,
  ResponseSurfaceContext,
} from './response-surface-registry';

// ─── Types ──────────────────────────────────────────────────────

/**
 * A surface registry interface that the reconciler delegates to for
 * block-level render/update/dispose operations.
 */
export interface CompositionSurfaceRegistry {
  render(rawBlock: unknown, context: ResponseSurfaceContext): RegistrySurfaceHandle;
  update(handle: RegistrySurfaceHandle, rawBlock: unknown, context: ResponseSurfaceContext): RegistrySurfaceHandle;
  dispose(handle: RegistrySurfaceHandle): void;
}

/** Local state preserved across updates for a single block. */
export interface BlockLocalState {
  /** Whether the block's disclosure is expanded. */
  readonly expanded?: boolean;
  /** Currently selected tool call ID within this block. */
  readonly selectedToolId?: string;
  /** Inspector identity for opened detail views. */
  readonly inspectorId?: string;
  /** Local measurement cache (e.g., height). */
  readonly measuredHeight?: number;
  /** Whether this block holds keyboard focus. */
  readonly hasFocus?: boolean;
}

/** A mounted block entry tracked by the reconciler. */
export interface MountedBlockEntry {
  readonly stableKey: string;
  readonly kind: ResponseBlockKind;
  readonly handle: RegistrySurfaceHandle;
  readonly contentRevision: number;
  localState: BlockLocalState;
}

/** A mounted composition tracked by the reconciler. */
export interface MountedComposition {
  readonly chatNodeStableKey: string;
  readonly compositionId: string;
  readonly semanticAnchor: string;
  sourceRevision: number;
  blocks: Map<string, MountedBlockEntry>;
  /** Declared block order by stable key. */
  blockOrder: string[];
  /** Whether this composition is in fallback mode (ambiguous keys). */
  fallbackMode: boolean;
  /** Composition-level fallback handle when ambiguous keys are detected. */
  fallbackHandle?: RegistrySurfaceHandle;
}

/** Result of a reconciliation pass. */
export interface ReconciliationResult {
  /** Blocks that were newly mounted. */
  readonly mounted: readonly string[];
  /** Blocks that were updated in place (not remounted). */
  readonly updated: readonly string[];
  /** Blocks that were disposed. */
  readonly disposed: readonly string[];
  /** Whether the composition entered or exited fallback mode. */
  readonly fallbackChanged: boolean;
  /** Whether a full remount was necessary (ambiguous keys or kind change). */
  readonly fullRemount: boolean;
}

/** Events emitted by the reconciler for external integration. */
export interface ReconcilerEventSink {
  onBlockMounted?(compositionId: string, blockKey: string): void;
  onBlockUpdated?(compositionId: string, blockKey: string): void;
  onBlockDisposed?(compositionId: string, blockKey: string): void;
  onCompositionMounted?(chatNodeKey: string, compositionId: string): void;
  onCompositionDisposed?(chatNodeKey: string, compositionId: string): void;
  onCompositionFallback?(chatNodeKey: string, compositionId: string, reason: string): void;
}

export interface KeyedCompositionReconcilerOptions {
  readonly registry: CompositionSurfaceRegistry;
  readonly context: ResponseSurfaceContext;
  readonly events?: ReconcilerEventSink;
}

// ─── Duplicate Key Detection ────────────────────────────────────

function findDuplicateKey(blocks: readonly ResponseBlockV1[]): string | undefined {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.stableKey)) {
      return block.stableKey;
    }
    seen.add(block.stableKey);
  }
  return undefined;
}

// ─── Reconciler ─────────────────────────────────────────────────

/**
 * Manages the lifecycle of compositions and their blocks via stable key
 * reconciliation. Block handles are reused across updates when their key
 * and kind remain unchanged.
 */
export class KeyedCompositionReconciler {
  private readonly registry: CompositionSurfaceRegistry;
  private context: ResponseSurfaceContext;
  private readonly events: ReconcilerEventSink;
  private readonly compositions = new Map<string, MountedComposition>();

  constructor(options: KeyedCompositionReconcilerOptions) {
    this.registry = options.registry;
    this.context = options.context;
    this.events = options.events ?? {};
  }

  /**
   * Mount a new composition. If the chat-node key already has a mounted
   * composition, the existing one is disposed first.
   */
  mount(composition: ResponseCompositionV1): ReconciliationResult {
    const { chatNodeStableKey } = composition;

    // Dispose existing composition for this node if present
    if (this.compositions.has(chatNodeStableKey)) {
      this.disposeComposition(chatNodeStableKey);
    }

    // Check for ambiguous keys before mounting
    const duplicateKey = findDuplicateKey(composition.blocks);
    if (duplicateKey !== undefined) {
      return this.mountFallback(composition, `duplicate_block_key:${duplicateKey}`);
    }

    const mounted: string[] = [];
    const blocks = new Map<string, MountedBlockEntry>();
    const blockOrder: string[] = [];

    for (const block of composition.blocks) {
      const handle = this.registry.render(block, this.context);
      const entry: MountedBlockEntry = {
        stableKey: block.stableKey,
        kind: block.kind,
        handle,
        contentRevision: block.contentRevision,
        localState: {},
      };
      blocks.set(block.stableKey, entry);
      blockOrder.push(block.stableKey);
      mounted.push(block.stableKey);
      this.events.onBlockMounted?.(composition.compositionId, block.stableKey);
    }

    const mountedComposition: MountedComposition = {
      chatNodeStableKey,
      compositionId: composition.compositionId,
      semanticAnchor: composition.semanticAnchor,
      sourceRevision: composition.sourceRevision,
      blocks,
      blockOrder,
      fallbackMode: false,
    };
    this.compositions.set(chatNodeStableKey, mountedComposition);
    this.events.onCompositionMounted?.(chatNodeStableKey, composition.compositionId);

    return {
      mounted,
      updated: [],
      disposed: [],
      fallbackChanged: false,
      fullRemount: false,
    };
  }

  /**
   * Update an existing composition with new block data. Reconciles by
   * stable key to avoid remounting unchanged blocks.
   *
   * If the composition isn't currently mounted, this performs a mount.
   */
  update(composition: ResponseCompositionV1): ReconciliationResult {
    const { chatNodeStableKey } = composition;
    const existing = this.compositions.get(chatNodeStableKey);

    if (!existing) {
      return this.mount(composition);
    }

    // If previously in fallback mode, attempt recovery
    if (existing.fallbackMode) {
      const duplicateKey = findDuplicateKey(composition.blocks);
      if (duplicateKey !== undefined) {
        // Still ambiguous — update fallback
        return this.updateFallback(existing, composition, `duplicate_block_key:${duplicateKey}`);
      }
      // Recover from fallback: dispose fallback and do full mount
      this.disposeComposition(chatNodeStableKey);
      const result = this.mount(composition);
      return { ...result, fallbackChanged: true, fullRemount: true };
    }

    // Check for newly ambiguous keys
    const duplicateKey = findDuplicateKey(composition.blocks);
    if (duplicateKey !== undefined) {
      // Dispose all block handles and switch to fallback
      this.disposeAllBlocks(existing);
      return this.mountFallback(composition, `duplicate_block_key:${duplicateKey}`);
    }

    return this.reconcileBlocks(existing, composition);
  }

  /**
   * Dispose a mounted composition by its chat-node stable key.
   * Returns true if a composition was found and disposed.
   */
  dispose(chatNodeStableKey: string): boolean {
    return this.disposeComposition(chatNodeStableKey);
  }

  /**
   * Dispose all mounted compositions.
   */
  disposeAll(): void {
    for (const key of [...this.compositions.keys()]) {
      this.disposeComposition(key);
    }
  }

  /**
   * Get the current mounted composition state.
   */
  getComposition(chatNodeStableKey: string): MountedComposition | undefined {
    return this.compositions.get(chatNodeStableKey);
  }

  /**
   * Get all mounted composition keys.
   */
  getMountedKeys(): readonly string[] {
    return [...this.compositions.keys()];
  }

  /**
   * Check if a composition is currently mounted.
   */
  isMounted(chatNodeStableKey: string): boolean {
    return this.compositions.has(chatNodeStableKey);
  }

  /**
   * Get the block order for a composition.
   */
  getBlockOrder(chatNodeStableKey: string): readonly string[] | undefined {
    return this.compositions.get(chatNodeStableKey)?.blockOrder;
  }

  /**
   * Get local state for a specific block within a composition.
   */
  getBlockLocalState(chatNodeStableKey: string, blockKey: string): BlockLocalState | undefined {
    return this.compositions.get(chatNodeStableKey)?.blocks.get(blockKey)?.localState;
  }

  /**
   * Set local state for a specific block. State is preserved across updates
   * as long as the block key persists.
   */
  setBlockLocalState(chatNodeStableKey: string, blockKey: string, state: BlockLocalState): void {
    const entry = this.compositions.get(chatNodeStableKey)?.blocks.get(blockKey);
    if (entry) {
      entry.localState = { ...entry.localState, ...state };
    }
  }

  /**
   * Update the surface context for future render/update operations.
   */
  updateContext(context: ResponseSurfaceContext): void {
    this.context = context;
  }

  // ─── Private Methods ────────────────────────────────────────────

  private reconcileBlocks(
    existing: MountedComposition,
    composition: ResponseCompositionV1,
  ): ReconciliationResult {
    const mounted: string[] = [];
    const updated: string[] = [];
    const disposed: string[] = [];

    const nextBlockKeys = new Set(composition.blocks.map((b) => b.stableKey));
    const prevBlockKeys = new Set(existing.blocks.keys());

    // 1. Dispose removed blocks
    for (const prevKey of prevBlockKeys) {
      if (!nextBlockKeys.has(prevKey)) {
        const entry = existing.blocks.get(prevKey)!;
        this.registry.dispose(entry.handle);
        existing.blocks.delete(prevKey);
        disposed.push(prevKey);
        this.events.onBlockDisposed?.(composition.compositionId, prevKey);
      }
    }

    // 2. Mount new blocks or update existing ones
    for (const block of composition.blocks) {
      const existingEntry = existing.blocks.get(block.stableKey);

      if (!existingEntry) {
        // New block: mount it
        const handle = this.registry.render(block, this.context);
        const entry: MountedBlockEntry = {
          stableKey: block.stableKey,
          kind: block.kind,
          handle,
          contentRevision: block.contentRevision,
          localState: {},
        };
        existing.blocks.set(block.stableKey, entry);
        mounted.push(block.stableKey);
        this.events.onBlockMounted?.(composition.compositionId, block.stableKey);
      } else if (existingEntry.kind !== block.kind) {
        // Kind changed: dispose and remount (cannot update across kinds)
        const savedState = existingEntry.localState;
        this.registry.dispose(existingEntry.handle);
        const handle = this.registry.render(block, this.context);
        const entry: MountedBlockEntry = {
          stableKey: block.stableKey,
          kind: block.kind,
          handle,
          contentRevision: block.contentRevision,
          localState: savedState, // Preserve local state across kind changes
        };
        existing.blocks.set(block.stableKey, entry);
        disposed.push(block.stableKey);
        mounted.push(block.stableKey);
        this.events.onBlockDisposed?.(composition.compositionId, block.stableKey);
        this.events.onBlockMounted?.(composition.compositionId, block.stableKey);
      } else if (existingEntry.contentRevision !== block.contentRevision) {
        // Same kind, content changed: update in place
        const updatedHandle = this.registry.update(existingEntry.handle, block, this.context);
        const entry: MountedBlockEntry = {
          stableKey: block.stableKey,
          kind: block.kind,
          handle: updatedHandle,
          contentRevision: block.contentRevision,
          localState: existingEntry.localState, // Preserve local state
        };
        existing.blocks.set(block.stableKey, entry);
        updated.push(block.stableKey);
        this.events.onBlockUpdated?.(composition.compositionId, block.stableKey);
      }
      // else: same key, same kind, same revision — no-op, handle preserved
    }

    // 3. Update declared order
    existing.blockOrder = composition.blocks.map((b) => b.stableKey);

    // 4. Update source revision
    existing.sourceRevision = composition.sourceRevision;

    return {
      mounted,
      updated,
      disposed,
      fallbackChanged: false,
      fullRemount: false,
    };
  }

  private mountFallback(
    composition: ResponseCompositionV1,
    reason: string,
  ): ReconciliationResult {
    const { chatNodeStableKey } = composition;

    // Render composition as a single fallback block
    const fallbackInput = {
      scope: 'composition' as const,
      status: 'unavailable' as const,
      correlationId: composition.compositionId,
      permittedSummary: `Composition has ambiguous block identities`,
    };
    const fallbackHandle = this.registry.render(fallbackInput, this.context);

    const mountedComposition: MountedComposition = {
      chatNodeStableKey,
      compositionId: composition.compositionId,
      semanticAnchor: composition.semanticAnchor,
      sourceRevision: composition.sourceRevision,
      blocks: new Map(),
      blockOrder: [],
      fallbackMode: true,
      fallbackHandle,
    };
    this.compositions.set(chatNodeStableKey, mountedComposition);
    this.events.onCompositionFallback?.(chatNodeStableKey, composition.compositionId, reason);

    return {
      mounted: [],
      updated: [],
      disposed: [],
      fallbackChanged: true,
      fullRemount: true,
    };
  }

  private updateFallback(
    existing: MountedComposition,
    composition: ResponseCompositionV1,
    reason: string,
  ): ReconciliationResult {
    // Update the fallback handle
    if (existing.fallbackHandle) {
      const fallbackInput = {
        scope: 'composition' as const,
        status: 'unavailable' as const,
        correlationId: composition.compositionId,
        permittedSummary: `Composition has ambiguous block identities`,
      };
      this.registry.update(existing.fallbackHandle, fallbackInput, this.context);
    }
    existing.sourceRevision = composition.sourceRevision;
    this.events.onCompositionFallback?.(existing.chatNodeStableKey, composition.compositionId, reason);

    return {
      mounted: [],
      updated: [],
      disposed: [],
      fallbackChanged: false,
      fullRemount: false,
    };
  }

  private disposeAllBlocks(existing: MountedComposition): void {
    for (const [key, entry] of existing.blocks) {
      this.registry.dispose(entry.handle);
      this.events.onBlockDisposed?.(existing.compositionId, key);
    }
    existing.blocks.clear();
    existing.blockOrder = [];
  }

  private disposeComposition(chatNodeStableKey: string): boolean {
    const existing = this.compositions.get(chatNodeStableKey);
    if (!existing) {
      return false;
    }

    // Dispose all block handles
    for (const [key, entry] of existing.blocks) {
      this.registry.dispose(entry.handle);
      this.events.onBlockDisposed?.(existing.compositionId, key);
    }

    // Dispose fallback handle if present
    if (existing.fallbackHandle) {
      this.registry.dispose(existing.fallbackHandle);
    }

    this.compositions.delete(chatNodeStableKey);
    this.events.onCompositionDisposed?.(chatNodeStableKey, existing.compositionId);
    return true;
  }
}
