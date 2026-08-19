import type {
  ResponseBlockV1,
  ResponseCompositionV1,
} from '../contracts/response-composition.js';
import type { ResolvedBound } from '../settings/bound-descriptor.js';
import type {
  ResponseCompositionDeltaV1,
  ResponseCompositionProjectionDiagnosticV1,
} from './response-composition-projector.js';

const STREAM_COALESCE_BOUND = 'renderer.updateRateMs';
const COALESCIBLE_BLOCK_KINDS = new Set<ResponseBlockV1['kind']>([
  'narrative',
  'reasoning',
]);

export interface StreamCoalesceSettingsSource {
  resolveBound(key: string): ResolvedBound | undefined;
}

export interface KeyedCompositionPublicationV1 {
  readonly schemaVersion: 1;
  readonly publicationRevision: number;
  readonly projectionRevision: number;
  readonly sourceSequence: number;
  readonly settingsSourceRevision: number;
  readonly added: readonly ResponseCompositionV1[];
  readonly updated: readonly ResponseCompositionV1[];
  readonly removed: readonly string[];
  readonly diagnostics: readonly ResponseCompositionProjectionDiagnosticV1[];
}

export interface PublicationAcceptance {
  readonly durableAccepted: boolean;
  readonly published: boolean;
  readonly scheduled: boolean;
}

export type CompositionPublicationSink = (
  publication: KeyedCompositionPublicationV1,
) => void;

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shareComposition(
  previous: ResponseCompositionV1 | undefined,
  next: ResponseCompositionV1,
): ResponseCompositionV1 {
  if (previous === undefined || previous.chatNodeStableKey !== next.chatNodeStableKey) {
    return next;
  }

  const previousBlocks = new Map(previous.blocks.map((block) => [block.stableKey, block]));
  const blocks = next.blocks.map((block) => {
    const prior = previousBlocks.get(block.stableKey);
    return prior !== undefined && jsonEqual(prior, block) ? prior : block;
  });

  const sameBlockOrderAndInstances = blocks.length === previous.blocks.length
    && blocks.every((block, index) => block === previous.blocks[index]);
  const sameCompositionFields = previous.schemaVersion === next.schemaVersion
    && previous.compositionId === next.compositionId
    && previous.chatNodeStableKey === next.chatNodeStableKey
    && previous.semanticAnchor === next.semanticAnchor
    && previous.sourceRevision === next.sourceRevision;

  if (sameBlockOrderAndInstances && sameCompositionFields) return previous;
  return { ...next, blocks };
}

function hasFinalizedContent(block: ResponseBlockV1): boolean {
  if (block.kind === 'narrative') return block.content.finalized;
  if (block.kind === 'reasoning') return block.content.finalized;
  return false;
}

function isOnlyCoalescibleVisualChange(
  previous: ResponseCompositionV1,
  next: ResponseCompositionV1,
): boolean {
  if (
    previous.schemaVersion !== next.schemaVersion
    || previous.compositionId !== next.compositionId
    || previous.chatNodeStableKey !== next.chatNodeStableKey
    || previous.semanticAnchor !== next.semanticAnchor
    || previous.blocks.length !== next.blocks.length
  ) {
    return false;
  }

  let changedBlockCount = 0;
  for (let index = 0; index < next.blocks.length; index++) {
    const priorBlock = previous.blocks[index]!;
    const nextBlock = next.blocks[index]!;
    if (priorBlock.stableKey !== nextBlock.stableKey || priorBlock.kind !== nextBlock.kind) {
      return false;
    }
    if (jsonEqual(priorBlock, nextBlock)) continue;

    changedBlockCount++;
    if (
      !COALESCIBLE_BLOCK_KINDS.has(nextBlock.kind)
      || nextBlock.status !== 'streaming'
      || hasFinalizedContent(nextBlock)
    ) {
      return false;
    }
  }

  return changedBlockCount > 0 || previous.sourceRevision !== next.sourceRevision;
}

/**
 * Retains every accepted durable composition while publishing only the latest visual
 * state at a Settings-derived cadence. Non-streaming changes (including structured
 * blocks, declared-order changes, removals, and terminal outcomes) bypass coalescing.
 *
 * AbortSignal and cancelPendingWork() cancel only obsolete timer work. The durable map
 * is intentionally retained so resume() or a later accepted delta publishes the full
 * cumulative state rather than a truncated suffix.
 */
export class KeyedCompositionPublisher {
  private durable = new Map<string, ResponseCompositionV1>();
  private published = new Map<string, ResponseCompositionV1>();
  private pendingDiagnostics: ResponseCompositionProjectionDiagnosticV1[] = [];
  private projectionRevision = 0;
  private sourceSequence = -1;
  private publicationRevision = 0;
  private lastPublishedAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abortCleanup: (() => void) | undefined;
  private scheduleGeneration = 0;

  constructor(
    private readonly settings: StreamCoalesceSettingsSource,
    private readonly sink: CompositionPublicationSink,
  ) {
    this.resolveCoalesceBound();
  }

  accept(
    delta: ResponseCompositionDeltaV1,
    signal?: AbortSignal,
  ): PublicationAcceptance {
    for (const composition of [...delta.added, ...delta.updated]) {
      const previous = this.durable.get(composition.chatNodeStableKey);
      this.durable.set(
        composition.chatNodeStableKey,
        shareComposition(previous, composition),
      );
    }
    for (const stableKey of delta.removed) this.durable.delete(stableKey);

    this.projectionRevision = Math.max(this.projectionRevision, delta.projectionRevision);
    this.sourceSequence = Math.max(this.sourceSequence, delta.sourceSequence);
    this.pendingDiagnostics.push(...delta.diagnostics);

    if (signal?.aborted) {
      this.cancelPendingWork();
      return { durableAccepted: true, published: false, scheduled: false };
    }

    return this.requestPublication(signal);
  }

  resume(signal?: AbortSignal): PublicationAcceptance {
    if (signal?.aborted) {
      this.cancelPendingWork();
      return { durableAccepted: true, published: false, scheduled: false };
    }
    return this.requestPublication(signal);
  }

  flush(): boolean {
    if (!this.hasPendingPublication()) return false;

    const bound = this.resolveCoalesceBound();
    this.clearScheduledWork();

    const nextPublished = new Map<string, ResponseCompositionV1>();
    const added: ResponseCompositionV1[] = [];
    const updated: ResponseCompositionV1[] = [];
    const removed: string[] = [];

    for (const [stableKey, durableComposition] of this.durable) {
      const prior = this.published.get(stableKey);
      const shared = shareComposition(prior, durableComposition);
      nextPublished.set(stableKey, shared);
      if (prior === undefined) added.push(shared);
      else if (shared !== prior) updated.push(shared);
    }
    for (const stableKey of this.published.keys()) {
      if (!nextPublished.has(stableKey)) removed.push(stableKey);
    }

    const diagnostics = this.pendingDiagnostics;
    const publication: KeyedCompositionPublicationV1 = {
      schemaVersion: 1,
      publicationRevision: this.publicationRevision + 1,
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceSequence,
      settingsSourceRevision: bound.sourceRevision,
      added,
      updated,
      removed,
      diagnostics,
    };

    this.sink(publication);
    this.published = nextPublished;
    this.pendingDiagnostics = [];
    this.publicationRevision = publication.publicationRevision;
    this.lastPublishedAt = Date.now();
    return true;
  }

  cancelPendingWork(): void {
    this.clearScheduledWork();
  }

  dispose(): void {
    this.clearScheduledWork();
  }

  hasPendingWork(): boolean {
    return this.timer !== undefined;
  }

  getDurableComposition(stableKey: string): ResponseCompositionV1 | undefined {
    return this.durable.get(stableKey);
  }

  getPublishedComposition(stableKey: string): ResponseCompositionV1 | undefined {
    return this.published.get(stableKey);
  }

  getPublicationRevision(): number {
    return this.publicationRevision;
  }

  private requestPublication(signal?: AbortSignal): PublicationAcceptance {
    if (!this.hasPendingPublication()) {
      return { durableAccepted: true, published: false, scheduled: false };
    }

    if (this.requiresImmediatePublication()) {
      return {
        durableAccepted: true,
        published: this.flush(),
        scheduled: false,
      };
    }

    this.schedule(signal);
    return { durableAccepted: true, published: false, scheduled: this.timer !== undefined };
  }

  private requiresImmediatePublication(): boolean {
    if (this.pendingDiagnostics.length > 0 && this.sameCompositionState()) return true;
    if (this.durable.size !== this.published.size) return true;

    for (const [stableKey, next] of this.durable) {
      const previous = this.published.get(stableKey);
      if (previous === undefined || !isOnlyCoalescibleVisualChange(previous, next)) {
        if (previous !== next) return true;
      }
    }
    return false;
  }

  private sameCompositionState(): boolean {
    if (this.durable.size !== this.published.size) return false;
    for (const [stableKey, composition] of this.durable) {
      if (this.published.get(stableKey) !== composition) return false;
    }
    return true;
  }

  private hasPendingPublication(): boolean {
    return this.pendingDiagnostics.length > 0 || !this.sameCompositionState();
  }

  private schedule(signal?: AbortSignal): void {
    const bound = this.resolveCoalesceBound();
    this.clearScheduledWork();

    const elapsed = this.lastPublishedAt === undefined
      ? bound.value
      : Math.max(0, Date.now() - this.lastPublishedAt);
    const delay = Math.max(0, bound.value - elapsed);
    if (delay === 0) {
      this.flush();
      return;
    }

    const generation = ++this.scheduleGeneration;
    if (signal !== undefined) {
      const abort = () => {
        if (generation === this.scheduleGeneration) this.cancelPendingWork();
      };
      signal.addEventListener('abort', abort, { once: true });
      this.abortCleanup = () => signal.removeEventListener('abort', abort);
    }

    this.timer = setTimeout(() => {
      if (generation !== this.scheduleGeneration) return;
      this.timer = undefined;
      this.abortCleanup?.();
      this.abortCleanup = undefined;
      this.flush();
    }, delay);
  }

  private clearScheduledWork(): void {
    this.scheduleGeneration++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortCleanup?.();
    this.abortCleanup = undefined;
  }

  private resolveCoalesceBound(): ResolvedBound {
    const resolved = this.settings.resolveBound(STREAM_COALESCE_BOUND);
    if (resolved === undefined) {
      throw new Error(
        `Operational bound "${STREAM_COALESCE_BOUND}" is required for keyed composition publication`,
      );
    }
    return resolved;
  }
}
