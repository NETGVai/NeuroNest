/**
 * Loop Receipt — Data structures for recording rewind availability,
 * blob hashes, and post-verify tree hashes.
 *
 * Loop receipts provide an audit trail for the checkpoint timeline,
 * recording which tool calls have rewind snapshots available and
 * their associated content-addressed blob hashes.
 *
 * Validates: Requirements 14.9, 14.11
 */

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * A single receipt entry for a tool call's snapshot state.
 * Records whether rewind is available and the blob hash for each file.
 */
export interface LoopReceiptEntry {
  /** Tool call ID this receipt is for. */
  toolCallId: string;
  /** Whether a rewind snapshot exists for this tool call. */
  rewindAvailable: boolean;
  /** SHA-256 blob hash of the pre-image snapshot (empty if no snapshot). */
  blobHash: string;
  /** Absolute file path that was snapshotted. */
  file: string;
  /** ISO-8601 timestamp when the snapshot was taken. */
  timestamp: string;
  /** Size in bytes of the snapshotted content. */
  size: number;
}

/**
 * Complete Loop receipt for a session run.
 * Contains per-call entries and the post-verify tree hash.
 */
export interface LoopReceipt {
  /** Session identifier. */
  sessionId: string;
  /** All receipt entries (one per file per tool call). */
  entries: LoopReceiptEntry[];
  /** Post-verify tree hash computed after verification passes. */
  postVerifyTreeHash: string;
  /** ISO-8601 timestamp when the receipt was finalized. */
  finalizedAt: string;
}

/**
 * Extended timeline event carrying hunk attribution data.
 * Used by the checkpoint:timeline-v2 IPC channel.
 */
export interface TimelineV2Event {
  /** Unique event identifier. */
  id: string;
  /** Kind of attribution: agent-produced, tool-call, pass boundary, or external. */
  kind: 'agent' | 'tool-call' | 'pass' | 'external';
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /** Agent identifier that produced this change. */
  agentId: string;
  /** Tool call ID (empty for pass/external events). */
  toolCallId: string;
  /** Pass number (for Loop Engine pass boundaries). */
  passNumber: number | null;
  /** Files affected by this event. */
  filesAffected: string[];
  /** Whether a rewind snapshot is available for this tool call. */
  rewindAvailable: boolean;
  /** Description of the event. */
  description: string;
}

/**
 * Response shape for the checkpoint:timeline-v2 IPC channel.
 */
export interface TimelineV2Response {
  /** Ordered list of timeline events with attribution. */
  events: TimelineV2Event[];
  /** Loop receipt data (null if no receipt available). */
  receipts: LoopReceipt | null;
}

// ─── LoopReceiptBuilder ─────────────────────────────────────────

/**
 * Builder for constructing Loop receipts from Hunk Tracker and Rewind Service data.
 *
 * Used by the main process to assemble receipt data before sending to the renderer.
 *
 * Validates: Requirement 14.11 — record rewind availability, blob hash, post-verify tree hash
 */
export class LoopReceiptBuilder {
  private sessionId: string;
  private entries: LoopReceiptEntry[] = [];
  private postVerifyTreeHash: string = '';

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Add a receipt entry for a tool call's file snapshot.
   */
  addEntry(entry: Omit<LoopReceiptEntry, 'timestamp'> & { timestamp?: string }): void {
    this.entries.push({
      toolCallId: entry.toolCallId,
      rewindAvailable: entry.rewindAvailable,
      blobHash: entry.blobHash,
      file: entry.file,
      timestamp: entry.timestamp || new Date().toISOString(),
      size: entry.size,
    });
  }

  /**
   * Record that a tool call has no snapshot (rewind not available).
   */
  addUnavailableEntry(toolCallId: string, file: string): void {
    this.entries.push({
      toolCallId,
      rewindAvailable: false,
      blobHash: '',
      file,
      timestamp: new Date().toISOString(),
      size: 0,
    });
  }

  /**
   * Set the post-verify tree hash (computed after all verifications pass).
   */
  setPostVerifyTreeHash(hash: string): void {
    this.postVerifyTreeHash = hash;
  }

  /**
   * Build the final immutable receipt.
   */
  build(): LoopReceipt {
    return {
      sessionId: this.sessionId,
      entries: [...this.entries],
      postVerifyTreeHash: this.postVerifyTreeHash,
      finalizedAt: new Date().toISOString(),
    };
  }

  /**
   * Get the number of entries recorded so far.
   */
  size(): number {
    return this.entries.length;
  }

  /**
   * Get all entries for a specific tool call.
   */
  getEntriesForCall(toolCallId: string): LoopReceiptEntry[] {
    return this.entries.filter((e) => e.toolCallId === toolCallId);
  }
}
