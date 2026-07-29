/**
 * Drift Reconciler — Conflict detection and resolution for concurrent context writes.
 *
 * Detects when different agents write to the same Context_Entry within a configurable
 * conflict window (default 5 seconds). Applies last-writer-wins by default, with an
 * optional strict mode that pauses execution for manual resolution.
 *
 * Drift events are persisted to the gcf_drift_events SQLite table and emitted as
 * "context_drift" events for IPC notification to the renderer.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DriftEvent } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftCheckResult {
  isDrift: boolean;
  event?: DriftEvent;
}

export interface DriftReconcilerOptions {
  /** Time window (ms) within which concurrent writes from different agents trigger drift. Default: 5000. */
  conflictWindowMs: number;
  /** When true, pauses execution on drift for manual resolution instead of last-writer-wins. */
  strictMode: boolean;
}

/** Listener callback for drift events. */
export type DriftEventListener = (event: DriftEvent) => void;

/** IPC send function signature for notifying the renderer. */
export type IPCSendFn = (channel: string, data: unknown) => void;

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/** Tracks the most recent write per entry for drift detection. */
interface WriteRecord {
  entryId: string;
  agentId: string;
  hash: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Drift Reconciler
// ---------------------------------------------------------------------------

export class DriftReconciler {
  private readonly db: Database.Database;
  private readonly options: DriftReconcilerOptions;

  /** In-memory write tracking: entryId → most recent write record. */
  private readonly writeLog = new Map<string, WriteRecord>();

  /** Event listeners for drift events. */
  private readonly listeners: DriftEventListener[] = [];

  /** Optional IPC send function for renderer notifications. */
  private ipcSend: IPCSendFn | null = null;

  // Prepared statements (lazy-initialized)
  private stmtInsertEvent!: Database.Statement;
  private stmtGetEvents!: Database.Statement;
  private stmtGetEventsAll!: Database.Statement;
  private stmtResolve!: Database.Statement;

  constructor(db: Database.Database, options: DriftReconcilerOptions) {
    this.db = db;
    this.options = options;
    this.prepareStatements();
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Check a write operation for drift. Call this before or during each context write.
   *
   * Drift is detected when:
   * 1. A previous write to the same entryId exists in the write log
   * 2. The previous write was from a DIFFERENT agent
   * 3. The previous write occurred within the conflict window (default 5s)
   * 4. The content hashes DIFFER (identical rewrites are not drift - Req 6.6)
   *
   * If drift is detected in normal mode (last-writer-wins), the event is logged
   * and the latest write proceeds. In strict mode, the event is flagged for
   * manual resolution.
   */
  checkWrite(entryId: string, agentId: string, newHash: string): DriftCheckResult {
    const now = Date.now();
    const previous = this.writeLog.get(entryId);

    // Record the current write (always update the log)
    this.writeLog.set(entryId, {
      entryId,
      agentId,
      hash: newHash,
      timestamp: now,
    });

    // No previous write — no drift possible
    if (!previous) {
      return { isDrift: false };
    }

    // Same agent — not a concurrent conflict
    if (previous.agentId === agentId) {
      return { isDrift: false };
    }

    // Outside conflict window — not concurrent
    const elapsed = now - previous.timestamp;
    if (elapsed > this.options.conflictWindowMs) {
      return { isDrift: false };
    }

    // Same hash — identical rewrite, not actual drift (Req 6.6)
    if (previous.hash === newHash) {
      return { isDrift: false };
    }

    // ─── Drift detected ─────────────────────────────────────────

    const resolvedValue = this.options.strictMode ? 'manual' : 'latest';

    const driftEvent: DriftEvent = {
      id: randomUUID(),
      entryId,
      agent1Id: previous.agentId,
      agent2Id: agentId,
      value1Hash: previous.hash,
      value2Hash: newHash,
      resolvedValue,
      timestamp: now,
    };

    // Persist to SQLite (Req 6.4)
    this.persistEvent(driftEvent);

    // Emit "context_drift" event (Req 6.1)
    this.emitDriftEvent(driftEvent);

    // Send IPC notification to renderer (Req 6.3)
    this.notifyRenderer(driftEvent);

    return { isDrift: true, event: driftEvent };
  }

  /**
   * Retrieve the conflict log from SQLite, ordered by timestamp descending.
   * Optionally limited to a maximum number of entries.
   */
  getConflictLog(limit?: number): DriftEvent[] {
    const rows = limit != null
      ? (this.stmtGetEvents.all(limit) as DriftEventRow[])
      : (this.stmtGetEventsAll.all() as DriftEventRow[]);

    return rows.map(this.rowToEvent);
  }

  /**
   * Resolve a conflict manually by accepting either the latest or previous value.
   * Updates the resolved_value field in SQLite. Used in strict mode when a user
   * makes a manual decision via the Context_Manager_UI.
   */
  resolveConflict(eventId: string, resolution: 'accept_latest' | 'accept_previous'): void {
    const resolvedValue = resolution === 'accept_latest' ? 'latest' : 'previous';
    this.stmtResolve.run(resolvedValue, eventId);
  }

  // ─── Event Subscription ───────────────────────────────────────

  /**
   * Register a listener for drift events.
   */
  onDrift(listener: DriftEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Set the IPC send function for renderer notifications.
   */
  setIPCSend(fn: IPCSendFn): void {
    this.ipcSend = fn;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private prepareStatements(): void {
    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO gcf_drift_events (id, entry_id, agent1_id, agent2_id, value1_hash, value2_hash, resolved_value, timestamp)
      VALUES (@id, @entry_id, @agent1_id, @agent2_id, @value1_hash, @value2_hash, @resolved_value, @timestamp)
    `);

    this.stmtGetEvents = this.db.prepare(`
      SELECT * FROM gcf_drift_events ORDER BY timestamp DESC LIMIT ?
    `);

    this.stmtGetEventsAll = this.db.prepare(`
      SELECT * FROM gcf_drift_events ORDER BY timestamp DESC
    `);

    this.stmtResolve = this.db.prepare(`
      UPDATE gcf_drift_events SET resolved_value = ? WHERE id = ?
    `);
  }

  /** Persist a drift event to the gcf_drift_events table. */
  private persistEvent(event: DriftEvent): void {
    this.stmtInsertEvent.run({
      id: event.id,
      entry_id: event.entryId,
      agent1_id: event.agent1Id,
      agent2_id: event.agent2Id,
      value1_hash: event.value1Hash,
      value2_hash: event.value2Hash,
      resolved_value: event.resolvedValue,
      timestamp: event.timestamp,
    });
  }

  /** Emit drift event to all registered listeners. */
  private emitDriftEvent(event: DriftEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // Log but don't propagate listener errors
        console.warn('[DriftReconciler] Listener error:', err);
      }
    }
  }

  /** Send IPC notification to the renderer process. */
  private notifyRenderer(event: DriftEvent): void {
    if (this.ipcSend) {
      try {
        this.ipcSend('context:drift-detected', {
          eventId: event.id,
          entryId: event.entryId,
          agent1Id: event.agent1Id,
          agent2Id: event.agent2Id,
          value1Hash: event.value1Hash,
          value2Hash: event.value2Hash,
          resolvedValue: event.resolvedValue,
          timestamp: event.timestamp,
        });
      } catch (err) {
        console.warn('[DriftReconciler] IPC notification error:', err);
      }
    }
  }

  /** Convert a raw database row to a DriftEvent. */
  private rowToEvent(row: DriftEventRow): DriftEvent {
    return {
      id: row.id,
      entryId: row.entry_id,
      agent1Id: row.agent1_id,
      agent2Id: row.agent2_id,
      value1Hash: row.value1_hash,
      value2Hash: row.value2_hash,
      resolvedValue: row.resolved_value as DriftEvent['resolvedValue'],
      timestamp: row.timestamp,
    };
  }
}

// ---------------------------------------------------------------------------
// Database Row Type
// ---------------------------------------------------------------------------

interface DriftEventRow {
  id: string;
  entry_id: string;
  agent1_id: string;
  agent2_id: string;
  value1_hash: string;
  value2_hash: string;
  resolved_value: string;
  timestamp: number;
}
