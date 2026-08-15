/**
 * StreamingChunkCollector — Receives provisional semantic chunks in order and
 * aggregates them into a stable Change_Set while maintaining position context.
 *
 * Supports streaming cancellation and resumption. Chunks are typed by file URI,
 * operation kind, and hunk identity so cross-URI application is prevented.
 *
 * Requirements: 5.4, 5.5, 5.6, 7.1, 7.2
 */

import type { ChangeSet, FileOperation, ModifyOperation } from './types';

/**
 * A semantic chunk represents a typed piece of a streaming edit proposal.
 */
export interface SemanticChunk {
  /** Unique identifier for this chunk within the stream */
  readonly chunkId: string;
  /** The file URI this chunk targets — prevents cross-URI application */
  readonly targetUri: string;
  /** The kind of operation this chunk belongs to */
  readonly operationKind: FileOperation['kind'];
  /** Hunk identity within the file (line range or region identifier) */
  readonly hunkId: string;
  /** The content fragment (additions or proposed content) */
  readonly content: string;
  /** Sequence number to maintain order */
  readonly sequence: number;
  /** Whether this is the final chunk for this hunk */
  readonly isFinal: boolean;
}

/**
 * Position context tracks where each chunk belongs within the Change_Set.
 */
export interface PositionContext {
  /** The file URI */
  readonly targetUri: string;
  /** The operation kind */
  readonly operationKind: FileOperation['kind'];
  /** The hunk identifier */
  readonly hunkId: string;
  /** Accumulated content so far for this position */
  readonly accumulatedContent: string;
  /** Number of chunks received for this position */
  readonly chunkCount: number;
  /** Whether the position is finalized */
  readonly finalized: boolean;
}

/**
 * Stream state tracks the overall state of the streaming session.
 */
export type StreamState = 'active' | 'paused' | 'cancelled' | 'completed' | 'failed';

/**
 * Result of collecting chunks into a Change_Set.
 */
export interface CollectionResult {
  /** The file operations derived from collected chunks */
  readonly operations: readonly FileOperation[];
  /** Position contexts for all tracked hunks */
  readonly positions: readonly PositionContext[];
  /** The current stream state */
  readonly streamState: StreamState;
  /** Whether the collection is complete (all hunks finalized) */
  readonly isComplete: boolean;
}

/**
 * StreamingChunkCollector aggregates provisional semantic chunks into one
 * stable Change_Set maintaining order and position context.
 */
export class StreamingChunkCollector {
  /** Position contexts keyed by `targetUri::hunkId` */
  private readonly positions = new Map<string, PositionContext>();
  /** Ordered chunks received so far */
  private readonly chunks: SemanticChunk[] = [];
  /** Current stream state */
  private state: StreamState = 'active';
  /** The Change_Set ID being streamed into */
  private readonly changeSetId: string;
  /** Base hashes for modify/delete/rename/move operations */
  private readonly baseHashes = new Map<string, string>();

  constructor(changeSetId: string) {
    this.changeSetId = changeSetId;
  }

  /**
   * Returns the current stream state.
   */
  get streamState(): StreamState {
    return this.state;
  }

  /**
   * Returns the Change_Set ID this collector is streaming into.
   */
  get targetChangeSetId(): string {
    return this.changeSetId;
  }

  /**
   * Sets the base hash for a file URI (needed for modify/delete operations).
   */
  setBaseHash(targetUri: string, baseHash: string): void {
    this.baseHashes.set(targetUri, baseHash);
  }

  /**
   * Receives a provisional semantic chunk and aggregates it into position context.
   * Throws if the stream is cancelled or completed, or if the chunk targets a
   * different URI than expected for its hunk.
   */
  addChunk(chunk: SemanticChunk): void {
    if (this.state === 'cancelled') {
      throw new Error(
        `Cannot add chunk to cancelled stream for Change_Set ${this.changeSetId}`
      );
    }
    if (this.state === 'completed') {
      throw new Error(
        `Cannot add chunk to completed stream for Change_Set ${this.changeSetId}`
      );
    }
    if (this.state === 'failed') {
      throw new Error(
        `Cannot add chunk to failed stream for Change_Set ${this.changeSetId}`
      );
    }

    const positionKey = `${chunk.targetUri}::${chunk.hunkId}`;
    const existing = this.positions.get(positionKey);

    // Prevent cross-URI application: check that an existing position has the same targetUri
    if (existing && existing.targetUri !== chunk.targetUri) {
      throw new Error(
        `Cross-URI application rejected: chunk targets '${chunk.targetUri}' ` +
          `but position '${positionKey}' is bound to '${existing.targetUri}'`
      );
    }

    // Prevent adding to finalized positions
    if (existing?.finalized) {
      throw new Error(
        `Cannot add chunk to finalized position '${positionKey}' ` +
          `in Change_Set ${this.changeSetId}`
      );
    }

    // Accumulate content
    const accumulatedContent = (existing?.accumulatedContent ?? '') + chunk.content;
    const chunkCount = (existing?.chunkCount ?? 0) + 1;

    const updatedPosition: PositionContext = {
      targetUri: chunk.targetUri,
      operationKind: chunk.operationKind,
      hunkId: chunk.hunkId,
      accumulatedContent,
      chunkCount,
      finalized: chunk.isFinal,
    };

    this.positions.set(positionKey, updatedPosition);
    this.chunks.push(chunk);
  }

  /**
   * Pauses the stream. Chunks can be added after resuming.
   */
  pause(): void {
    if (this.state === 'active') {
      this.state = 'paused';
    }
  }

  /**
   * Resumes a paused stream.
   */
  resume(): void {
    if (this.state === 'paused') {
      this.state = 'active';
    }
  }

  /**
   * Cancels the stream. No more chunks can be added.
   */
  cancel(): void {
    if (this.state !== 'completed' && this.state !== 'failed') {
      this.state = 'cancelled';
    }
  }

  /**
   * Marks the stream as failed.
   */
  fail(): void {
    if (this.state !== 'completed') {
      this.state = 'failed';
    }
  }

  /**
   * Marks the stream as completed. No more chunks can be added.
   */
  complete(): void {
    if (this.state === 'active' || this.state === 'paused') {
      this.state = 'completed';
    }
  }

  /**
   * Returns all position contexts.
   */
  getPositions(): readonly PositionContext[] {
    return Array.from(this.positions.values());
  }

  /**
   * Returns the position context for a specific targetUri and hunkId.
   */
  getPosition(targetUri: string, hunkId: string): PositionContext | undefined {
    return this.positions.get(`${targetUri}::${hunkId}`);
  }

  /**
   * Returns the total number of chunks received.
   */
  get chunkCount(): number {
    return this.chunks.length;
  }

  /**
   * Computes whether all positions are finalized (stream is fully received).
   */
  get isComplete(): boolean {
    if (this.positions.size === 0) return false;
    return Array.from(this.positions.values()).every((p) => p.finalized);
  }

  /**
   * Aggregates collected chunks into FileOperation[] for the Change_Set.
   * Groups by targetUri and produces the appropriate operation for each file.
   */
  toOperations(): readonly FileOperation[] {
    // Group positions by targetUri
    const byUri = new Map<string, PositionContext[]>();
    for (const position of this.positions.values()) {
      const existing = byUri.get(position.targetUri) ?? [];
      existing.push(position);
      byUri.set(position.targetUri, existing);
    }

    const operations: FileOperation[] = [];

    for (const [uri, positions] of byUri) {
      // Determine operation kind from the first position (all positions for a URI should agree)
      const operationKind = positions[0].operationKind;

      // Combine content from all hunks for this file in order
      const combinedContent = positions
        .sort((a, b) => a.hunkId.localeCompare(b.hunkId))
        .map((p) => p.accumulatedContent)
        .join('');

      const baseHash = this.baseHashes.get(uri);

      switch (operationKind) {
        case 'create':
          operations.push({
            kind: 'create',
            targetUri: uri,
            proposedBlob: combinedContent,
          });
          break;
        case 'modify':
          operations.push({
            kind: 'modify',
            targetUri: uri,
            baseHash: baseHash ?? '',
            proposedBlob: combinedContent,
          } as ModifyOperation);
          break;
        case 'delete':
          operations.push({
            kind: 'delete',
            targetUri: uri,
            baseHash: baseHash ?? '',
          });
          break;
        case 'rename':
          operations.push({
            kind: 'rename',
            sourceUri: uri,
            targetUri: combinedContent, // For rename, content is the new URI
            baseHash: baseHash ?? '',
          });
          break;
        case 'move':
          operations.push({
            kind: 'move',
            sourceUri: uri,
            targetUri: combinedContent, // For move, content is the new URI
            baseHash: baseHash ?? '',
          });
          break;
      }
    }

    return Object.freeze(operations);
  }

  /**
   * Produces the full collection result including state and completeness.
   */
  collect(): CollectionResult {
    return {
      operations: this.toOperations(),
      positions: this.getPositions(),
      streamState: this.state,
      isComplete: this.isComplete,
    };
  }
}
