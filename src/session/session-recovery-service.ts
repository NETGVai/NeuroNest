/**
 * SessionRecoveryService — Persists session state so renderer reload/crash
 * restores from the last-committed sequence without replaying mutating tools.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.6
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface ToolCallRecord {
  id: string;
  sequenceNumber: number;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Whether this tool call mutates state (e.g., file writes, git operations) */
  mutating: boolean;
  /** Status of the tool call at time of persistence */
  status: 'completed' | 'in-flight' | 'failed' | 'cancelled';
  result?: unknown;
  startedAt: string;
  completedAt?: string;
}

export interface SessionSnapshot {
  id: string;
  sessionId: string;
  /** Monotonically increasing sequence position in the timeline */
  sequenceNumber: number;
  /** Serialized context state at this point */
  contextState: Record<string, unknown>;
  /** Tool calls that have been committed (completed) up to this point */
  committedToolCalls: ToolCallRecord[];
  /** Tool calls that were in-flight at snapshot time */
  inFlightToolCalls: ToolCallRecord[];
  /** Timestamp of the snapshot */
  createdAt: string;
  /** Hash fingerprint of the session state for integrity verification */
  fingerprint: string;
}

export interface RecoveryResult {
  success: boolean;
  sessionId: string;
  restoredSequence: number;
  /** Tool calls that were completed and should NOT be replayed */
  skippedMutatingTools: ToolCallRecord[];
  /** Tool calls that were in-flight at crash time (need user decision) */
  interruptedTools: ToolCallRecord[];
  contextState: Record<string, unknown>;
  error?: string;
}

export interface SessionRecoveryConfig {
  /** Maximum number of snapshots to retain per session */
  maxSnapshotsPerSession?: number;
  /** Auto-snapshot interval in milliseconds (default: 5000) */
  snapshotIntervalMs?: number;
}

// ─── Service ────────────────────────────────────────────────────

export class SessionRecoveryService {
  private readonly maxSnapshots: number;
  private readonly snapshotIntervalMs: number;
  private autoSnapshotTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(
    private readonly db: any,
    config?: SessionRecoveryConfig,
  ) {
    this.maxSnapshots = config?.maxSnapshotsPerSession ?? 20;
    this.snapshotIntervalMs = config?.snapshotIntervalMs ?? 5000;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        context_state TEXT NOT NULL,
        committed_tool_calls TEXT NOT NULL,
        in_flight_tool_calls TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_snapshots_session
        ON session_snapshots(session_id, sequence_number DESC);
    `);
  }

  /**
   * Persist a session snapshot at the current sequence position.
   * This is the checkpoint that recovery will restore from.
   */
  persistSnapshot(
    sessionId: string,
    sequenceNumber: number,
    contextState: Record<string, unknown>,
    committedToolCalls: ToolCallRecord[],
    inFlightToolCalls: ToolCallRecord[],
  ): SessionSnapshot {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const fingerprint = this.computeFingerprint(sessionId, sequenceNumber, contextState);

    const snapshot: SessionSnapshot = {
      id,
      sessionId,
      sequenceNumber,
      contextState,
      committedToolCalls,
      inFlightToolCalls,
      createdAt,
      fingerprint,
    };

    this.db
      .prepare(
        `INSERT INTO session_snapshots
         (id, session_id, sequence_number, context_state, committed_tool_calls, in_flight_tool_calls, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        sequenceNumber,
        JSON.stringify(contextState),
        JSON.stringify(committedToolCalls),
        JSON.stringify(inFlightToolCalls),
        fingerprint,
        createdAt,
      );

    // Prune old snapshots beyond retention limit
    this.pruneSnapshots(sessionId);

    return snapshot;
  }

  /**
   * Restore a session from the last-committed sequence number.
   * Does NOT replay completed mutating tool calls.
   */
  recover(sessionId: string): RecoveryResult {
    const row = this.db
      .prepare(
        `SELECT id, session_id, sequence_number, context_state, committed_tool_calls, in_flight_tool_calls, fingerprint, created_at
         FROM session_snapshots
         WHERE session_id = ?
         ORDER BY sequence_number DESC
         LIMIT 1`,
      )
      .get(sessionId) as any;

    if (!row) {
      return {
        success: false,
        sessionId,
        restoredSequence: 0,
        skippedMutatingTools: [],
        interruptedTools: [],
        contextState: {},
        error: `No recovery snapshot found for session: ${sessionId}`,
      };
    }

    const committedToolCalls: ToolCallRecord[] = JSON.parse(row.committed_tool_calls);
    const inFlightToolCalls: ToolCallRecord[] = JSON.parse(row.in_flight_tool_calls);

    // Separate mutating tool calls that must NOT be replayed
    const skippedMutatingTools = committedToolCalls.filter((tc) => tc.mutating);

    return {
      success: true,
      sessionId,
      restoredSequence: row.sequence_number,
      skippedMutatingTools,
      interruptedTools: inFlightToolCalls,
      contextState: JSON.parse(row.context_state),
    };
  }

  /**
   * Get the last committed sequence number for a session.
   */
  getLastCommittedSequence(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT sequence_number FROM session_snapshots
         WHERE session_id = ?
         ORDER BY sequence_number DESC
         LIMIT 1`,
      )
      .get(sessionId) as { sequence_number: number } | undefined;

    return row?.sequence_number ?? 0;
  }

  /**
   * Mark a tool call as completed in the current session state.
   * This ensures it won't be replayed on recovery.
   */
  commitToolCall(sessionId: string, toolCallId: string): void {
    // Get the latest snapshot
    const row = this.db
      .prepare(
        `SELECT id, in_flight_tool_calls, committed_tool_calls
         FROM session_snapshots
         WHERE session_id = ?
         ORDER BY sequence_number DESC
         LIMIT 1`,
      )
      .get(sessionId) as any;

    if (!row) return;

    const inFlight: ToolCallRecord[] = JSON.parse(row.in_flight_tool_calls);
    const committed: ToolCallRecord[] = JSON.parse(row.committed_tool_calls);

    const toolCallIndex = inFlight.findIndex((tc) => tc.id === toolCallId);
    if (toolCallIndex >= 0) {
      const toolCall = inFlight[toolCallIndex];
      toolCall.status = 'completed';
      toolCall.completedAt = new Date().toISOString();
      inFlight.splice(toolCallIndex, 1);
      committed.push(toolCall);

      this.db
        .prepare(
          `UPDATE session_snapshots
           SET in_flight_tool_calls = ?, committed_tool_calls = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(inFlight), JSON.stringify(committed), row.id);
    }
  }

  /**
   * Start auto-snapshotting for a session.
   */
  startAutoSnapshot(
    sessionId: string,
    getState: () => {
      sequenceNumber: number;
      contextState: Record<string, unknown>;
      committedToolCalls: ToolCallRecord[];
      inFlightToolCalls: ToolCallRecord[];
    },
  ): void {
    this.stopAutoSnapshot(sessionId);

    const timer = setInterval(() => {
      const state = getState();
      this.persistSnapshot(
        sessionId,
        state.sequenceNumber,
        state.contextState,
        state.committedToolCalls,
        state.inFlightToolCalls,
      );
    }, this.snapshotIntervalMs);

    this.autoSnapshotTimers.set(sessionId, timer);
  }

  /**
   * Stop auto-snapshotting for a session.
   */
  stopAutoSnapshot(sessionId: string): void {
    const timer = this.autoSnapshotTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.autoSnapshotTimers.delete(sessionId);
    }
  }

  /**
   * Clear all snapshots for a session.
   */
  clearSession(sessionId: string): void {
    this.stopAutoSnapshot(sessionId);
    this.db.prepare('DELETE FROM session_snapshots WHERE session_id = ?').run(sessionId);
  }

  /**
   * Dispose all timers and clean up.
   */
  dispose(): void {
    for (const [sessionId] of this.autoSnapshotTimers) {
      this.stopAutoSnapshot(sessionId);
    }
  }

  private pruneSnapshots(sessionId: string): void {
    this.db
      .prepare(
        `DELETE FROM session_snapshots
         WHERE session_id = ? AND id NOT IN (
           SELECT id FROM session_snapshots
           WHERE session_id = ?
           ORDER BY sequence_number DESC
           LIMIT ?
         )`,
      )
      .run(sessionId, sessionId, this.maxSnapshots);
  }

  private computeFingerprint(
    sessionId: string,
    sequenceNumber: number,
    contextState: Record<string, unknown>,
  ): string {
    const content = `${sessionId}:${sequenceNumber}:${JSON.stringify(contextState)}`;
    // Simple hash for integrity check
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `fp_${Math.abs(hash).toString(36)}`;
  }
}
