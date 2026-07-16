/**
 * Hunk Tracker Service
 *
 * Records which file regions were modified by which tool call, enabling
 * granular rewind/undo operations at the hunk level rather than full-file level.
 *
 * Every file-modifying tool call produces a hunk record with full attribution:
 * agent, session, pass, turn, and tool-call identifiers. External file changes
 * detected via the file-event-emitter are also recorded with external attribution.
 *
 * Validates: Requirements 14.1, 14.3
 */

// ─── Interfaces ─────────────────────────────────────────────────

/** A single recorded hunk representing a file region modification. */
export interface HunkRecord {
  /** Absolute file path that was modified. */
  file: string;
  /** Start line of the modified region (1-indexed). */
  startLine: number;
  /** End line of the modified region (1-indexed, inclusive). */
  endLine: number;
  /** Tool call ID that produced this hunk. */
  toolCallId: string;
  /** ISO-8601 timestamp of when the hunk was recorded. */
  timestamp: string;
  /** Content before the modification. */
  oldContent: string;
  /** Content after the modification. */
  newContent: string;
  /** Attribution kind: agent-produced or external. */
  kind: 'agent' | 'external';
  /** Agent identifier (empty for external hunks). */
  agentId: string;
  /** Session identifier. */
  sessionId: string;
  /** Pass identifier (for Loop Engine passes). */
  passId: string;
  /** Turn identifier within the session. */
  turnId: string;
}

/** Event payload for recording an agent-produced hunk. */
export interface AgentHunkEvent {
  file: string;
  startLine: number;
  endLine: number;
  toolCallId: string;
  oldContent: string;
  newContent: string;
  agentId: string;
  sessionId: string;
  passId: string;
  turnId: string;
}

/** Event payload for recording an external file change. */
export interface ExternalHunkEvent {
  file: string;
  startLine: number;
  endLine: number;
  oldContent: string;
  newContent: string;
  sessionId: string;
}

/** Options for constructing the HunkTracker. */
export interface HunkTrackerOptions {
  /**
   * Optional SQLite-like persistence adapter. When provided, hunks are
   * also persisted for the Rewind Service (task 4.9). When omitted,
   * hunks are stored in memory only.
   */
  persistence?: HunkPersistenceAdapter;
}

/**
 * Adapter interface for optional SQLite persistence.
 * Implementations handle the actual database operations.
 */
export interface HunkPersistenceAdapter {
  insert(record: HunkRecord): void;
  queryByToolCallId(toolCallId: string): HunkRecord[];
  queryByFile(file: string): HunkRecord[];
  queryBySession(sessionId: string): HunkRecord[];
}

// ─── HunkTracker Implementation ─────────────────────────────────

/**
 * The HunkTracker service records file-region modifications with full attribution
 * and provides query methods for retrieving hunks by tool call, file, or session.
 *
 * Integrates as a hook called after every file-write tool succeeds.
 */
export class HunkTracker {
  /** In-memory hunk store. */
  private hunks: HunkRecord[] = [];

  /** Index: toolCallId → hunk indices for fast lookup. */
  private byToolCallId: Map<string, number[]> = new Map();

  /** Index: file path → hunk indices for fast lookup. */
  private byFile: Map<string, number[]> = new Map();

  /** Index: sessionId → hunk indices for fast lookup. */
  private bySession: Map<string, number[]> = new Map();

  /** Optional persistence adapter for SQLite storage. */
  private persistence: HunkPersistenceAdapter | null;

  constructor(options?: HunkTrackerOptions) {
    this.persistence = options?.persistence ?? null;
  }

  /**
   * Record a hunk produced by an agent tool call.
   * Called after every file-write tool succeeds.
   *
   * Validates: Requirement 14.1 — attributes hunks to agent, session, pass, turn, tool-call.
   */
  recordAgentHunk(event: AgentHunkEvent): void {
    const record: HunkRecord = {
      file: event.file,
      startLine: event.startLine,
      endLine: event.endLine,
      toolCallId: event.toolCallId,
      timestamp: new Date().toISOString(),
      oldContent: event.oldContent,
      newContent: event.newContent,
      kind: 'agent',
      agentId: event.agentId,
      sessionId: event.sessionId,
      passId: event.passId,
      turnId: event.turnId,
    };

    this.storeRecord(record);
  }

  /**
   * Record a hunk from an external file change (not matched to an agent mutation).
   * Called by the file-event-emitter for changes detected outside tool execution.
   *
   * Validates: Requirement 14.2 — external hunks attributed separately.
   */
  recordExternalHunk(event: ExternalHunkEvent): void {
    const record: HunkRecord = {
      file: event.file,
      startLine: event.startLine,
      endLine: event.endLine,
      toolCallId: '',
      timestamp: new Date().toISOString(),
      oldContent: event.oldContent,
      newContent: event.newContent,
      kind: 'external',
      agentId: '',
      sessionId: event.sessionId,
      passId: '',
      turnId: '',
    };

    this.storeRecord(record);
  }

  /**
   * Record a hunk using a raw HunkRecord (for direct use or testing).
   */
  recordHunk(record: HunkRecord): void {
    this.storeRecord(record);
  }

  /**
   * Get all hunks produced by a specific tool call.
   *
   * Validates: Requirement 14.3 — getHunksForCall(callId).
   */
  getHunksForCall(callId: string): HunkRecord[] {
    const indices = this.byToolCallId.get(callId);
    if (!indices) return [];
    return indices.map((i) => this.hunks[i]);
  }

  /**
   * Get all hunks affecting a specific file path.
   *
   * Validates: Requirement 14.3 — getHunksForFile(path).
   */
  getHunksForFile(path: string): HunkRecord[] {
    const indices = this.byFile.get(path);
    if (!indices) return [];
    return indices.map((i) => this.hunks[i]);
  }

  /**
   * Get all hunks associated with a specific session.
   * Useful for session-level rewind operations.
   */
  getHunksBySession(sessionId: string): HunkRecord[] {
    const indices = this.bySession.get(sessionId);
    if (!indices) return [];
    return indices.map((i) => this.hunks[i]);
  }

  /**
   * Get attribution information for a specific file and optional line range.
   * Returns hunks that overlap with the specified range.
   */
  getAttribution(path: string, range?: { startLine: number; endLine: number }): HunkRecord[] {
    const fileHunks = this.getHunksForFile(path);
    if (!range) return fileHunks;

    return fileHunks.filter(
      (h) => h.startLine <= range.endLine && h.endLine >= range.startLine,
    );
  }

  /**
   * Get total number of recorded hunks.
   */
  size(): number {
    return this.hunks.length;
  }

  /**
   * Clear all in-memory hunks (useful for testing or session cleanup).
   */
  clear(): void {
    this.hunks = [];
    this.byToolCallId = new Map();
    this.byFile = new Map();
    this.bySession = new Map();
  }

  // ─── Private ────────────────────────────────────────────────────

  private storeRecord(record: HunkRecord): void {
    const index = this.hunks.length;
    this.hunks.push(record);

    // Index by toolCallId (skip empty for external hunks)
    if (record.toolCallId) {
      const callIndices = this.byToolCallId.get(record.toolCallId) ?? [];
      callIndices.push(index);
      this.byToolCallId.set(record.toolCallId, callIndices);
    }

    // Index by file path
    const fileIndices = this.byFile.get(record.file) ?? [];
    fileIndices.push(index);
    this.byFile.set(record.file, fileIndices);

    // Index by session
    if (record.sessionId) {
      const sessionIndices = this.bySession.get(record.sessionId) ?? [];
      sessionIndices.push(index);
      this.bySession.set(record.sessionId, sessionIndices);
    }

    // Persist if adapter is available
    if (this.persistence) {
      try {
        this.persistence.insert(record);
      } catch (e) {
        // Fail-soft: persistence failure should not break tracking
        // eslint-disable-next-line no-console
        console.warn('[hunk-tracker] persistence insert failed:', (e as Error)?.message);
      }
    }
  }
}
