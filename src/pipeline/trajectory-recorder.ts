/**
 * TrajectoryRecorder — Export and import session event streams as JSONL
 * trajectories for debugging, replay, and evaluation.
 *
 * Exports the full typed event stream from the pipeline_events table for a
 * given session, prepending a config fingerprint header line. Supports two
 * replay modes:
 *   - inspect: step-through in UI (consumer drives iteration)
 *   - re-execute: rerun actions against a scratch workspace
 *
 * Gated behind the `trajectory_recording` feature flag.
 *
 * Requirements: 23.1, 23.2
 */

import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import { generateEventId } from './event-log.js';

// ─── Interfaces ────────────────────────────────────────────────

/**
 * Configuration fingerprint identifying the environment used to produce
 * a trajectory. Used to detect drift between recording and replay.
 */
export interface TrajectoryConfig {
  configFingerprint: string; // hash of models + mode + prompts version
  sessionId: string;
}

/**
 * A single entry in a trajectory JSONL export.
 */
export interface TrajectoryEntry {
  seq: number;
  kind: string;
  payload: unknown;
  timestamp: number;
}

/**
 * Replay mode determines how the trajectory is consumed:
 * - 'inspect': step-through in UI, read-only examination
 * - 're-execute': rerun actions against a scratch workspace for regression comparison
 */
export type ReplayMode = 'inspect' | 're-execute';

/**
 * Metadata stored alongside an imported trajectory for replay.
 */
export interface TrajectoryReplayContext {
  mode: ReplayMode;
  configFingerprint: string;
  sessionId: string;
  entries: TrajectoryEntry[];
}

// ─── Internal row type ─────────────────────────────────────────

interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  kind: string;
  payload_json: string;
  created_at: number;
}

// ─── TrajectoryRecorder ────────────────────────────────────────

export class TrajectoryRecorder {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem | null;

  // Prepared statements
  private readonly stmtGetEvents: Database.Statement;
  private readonly stmtInsertTrajectory: Database.Statement;
  private readonly stmtGetEventCount: Database.Statement;

  constructor(db: Database.Database, featureGate: FeatureGateSystem | null = null) {
    this.db = db;
    this.featureGate = featureGate;

    this.stmtGetEvents = db.prepare(
      'SELECT id, session_id, seq, kind, payload_json, created_at FROM pipeline_events WHERE session_id = ? ORDER BY seq ASC',
    );

    this.stmtInsertTrajectory = db.prepare(
      'INSERT OR REPLACE INTO trajectories (id, session_id, config_fingerprint, event_count, exported_at) VALUES (?, ?, ?, ?, ?)',
    );

    this.stmtGetEventCount = db.prepare(
      'SELECT COUNT(*) AS cnt FROM pipeline_events WHERE session_id = ?',
    );
  }

  /**
   * Check whether trajectory recording is enabled via the feature gate.
   */
  isEnabled(): boolean {
    if (!this.featureGate) return true; // No gate → always enabled (for testing)
    return this.featureGate.isEnabled('trajectory_recording');
  }

  /**
   * Export session event streams as JSONL. The first line is a header
   * containing the config fingerprint and session metadata. Subsequent
   * lines are typed TrajectoryEntry objects.
   *
   * Returns an AsyncIterable<string> where each yielded value is one
   * JSONL line (no trailing newline — consumer adds separators).
   *
   * Records the export in the `trajectories` table for auditability.
   */
  async *export(sessionId: string, config: TrajectoryConfig): AsyncIterable<string> {
    if (!this.isEnabled()) {
      return;
    }

    // Emit header line with config fingerprint
    const header = {
      type: 'trajectory_header',
      configFingerprint: config.configFingerprint,
      sessionId: config.sessionId,
      exportedAt: Date.now(),
    };
    yield JSON.stringify(header);

    // Stream events as JSONL entries
    const rows = this.stmtGetEvents.all(sessionId) as EventRow[];
    let eventCount = 0;

    for (const row of rows) {
      const entry: TrajectoryEntry = {
        seq: row.seq,
        kind: row.kind,
        payload: parsePayload(row.payload_json),
        timestamp: row.created_at,
      };
      yield JSON.stringify(entry);
      eventCount++;
    }

    // Record the export in the trajectories table
    this.stmtInsertTrajectory.run(
      generateEventId(),
      sessionId,
      config.configFingerprint,
      eventCount,
      Date.now(),
    );
  }

  /**
   * Import a trajectory from a JSONL file path for replay. Reads the
   * file, validates the header, and returns parsed TrajectoryEntry[].
   *
   * The first line must be a trajectory_header. All subsequent lines
   * must be valid TrajectoryEntry JSON objects.
   *
   * @param path - Absolute path to the JSONL trajectory file
   * @returns Parsed trajectory entries (excluding header)
   */
  async importForReplay(path: string): Promise<TrajectoryEntry[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const fs = await import('fs');
    const readline = await import('readline');

    const fileStream = fs.createReadStream(path, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const entries: TrajectoryEntry[] = [];
    let isFirstLine = true;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = JSON.parse(trimmed);

      if (isFirstLine) {
        // Validate header
        if (parsed.type !== 'trajectory_header') {
          throw new Error(
            `Invalid trajectory file: first line must be a trajectory_header, got type="${parsed.type}"`,
          );
        }
        isFirstLine = false;
        continue;
      }

      // Validate entry shape
      const entry: TrajectoryEntry = {
        seq: parsed.seq,
        kind: parsed.kind,
        payload: parsed.payload,
        timestamp: parsed.timestamp,
      };

      if (typeof entry.seq !== 'number' || typeof entry.kind !== 'string' || typeof entry.timestamp !== 'number') {
        throw new Error(
          `Invalid trajectory entry at seq=${parsed.seq}: missing required fields (seq, kind, timestamp)`,
        );
      }

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Prepare a replay context from imported entries, associating a replay mode.
   * This structures the data for consumers that drive either inspect or
   * re-execute replay.
   */
  prepareReplay(
    entries: TrajectoryEntry[],
    mode: ReplayMode,
    config: TrajectoryConfig,
  ): TrajectoryReplayContext {
    return {
      mode,
      configFingerprint: config.configFingerprint,
      sessionId: config.sessionId,
      entries,
    };
  }

  /**
   * Get the count of events for a session (useful for progress indication).
   */
  getEventCount(sessionId: string): number {
    const row = this.stmtGetEventCount.get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Defensive payload parser — corrupted JSON should not crash the export.
 */
function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
