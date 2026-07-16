/**
 * Prompt Queue — session-scoped FIFO queue for messages submitted during an active turn.
 *
 * Key semantics:
 * - Messages submitted during a running turn enter a session-scoped FIFO queue
 * - Queued prompts display order, editable text, cancel action, and queued state
 * - Queue drains in order after the current turn reaches a terminal state
 * - Queued prompts SHALL NOT mutate the current turn's IntentAnchor
 * - Application restart preserves queued prompts for resumable sessions
 * - Queue cancellation does not affect the active turn
 *
 * Backed by SQLite for persistence across restarts.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  orderIdx: number;
  text: string;
  status: 'queued' | 'draining' | 'completed' | 'cancelled';
  createdAt: string;
  drainedAt: string | null;
}

export interface PromptQueueStats {
  queued: number;
  draining: number;
  completed: number;
  cancelled: number;
}

// ─── Database Row ───────────────────────────────────────────────

interface PromptQueueRow {
  id: string;
  session_id: string;
  order_idx: number;
  text: string;
  status: string;
  created_at: string;
  drained_at: string | null;
}

function rowToPrompt(row: PromptQueueRow): QueuedPrompt {
  return {
    id: row.id,
    sessionId: row.session_id,
    orderIdx: row.order_idx,
    text: row.text,
    status: row.status as QueuedPrompt['status'],
    createdAt: row.created_at,
    drainedAt: row.drained_at,
  };
}

// ─── PromptQueue ────────────────────────────────────────────────

export class PromptQueue {
  private db: Database.Database;
  private ensureTableStmt: boolean = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    if (this.ensureTableStmt) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_queue (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          order_idx INTEGER NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          drained_at TEXT
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_prompt_queue_session
        ON prompt_queue(session_id, status, order_idx)
      `);
      this.ensureTableStmt = true;
    } catch (e) {
      console.warn('[PromptQueue] Table creation failed:', e);
    }
  }

  /**
   * Enqueue a prompt for a session.
   * Assigns the next order index automatically.
   *
   * Requirement 22.1
   */
  enqueue(sessionId: string, text: string): QueuedPrompt {
    const id = randomUUID();
    const nextIdx = this.getNextOrderIdx(sessionId);

    this.db.prepare(
      `INSERT INTO prompt_queue (id, session_id, order_idx, text, status)
       VALUES (?, ?, ?, ?, 'queued')`,
    ).run(id, sessionId, nextIdx, text);

    return this.get(id)!;
  }

  /**
   * Get all queued (pending) prompts for a session in FIFO order.
   *
   * Requirement 22.2
   */
  getPending(sessionId: string): QueuedPrompt[] {
    const rows = this.db.prepare(
      `SELECT * FROM prompt_queue
       WHERE session_id = ? AND status = 'queued'
       ORDER BY order_idx ASC`,
    ).all(sessionId) as PromptQueueRow[];
    return rows.map(rowToPrompt);
  }

  /**
   * Drain the next prompt from the queue (mark as draining).
   * Called after the current turn reaches a terminal state.
   *
   * Requirement 22.3
   */
  drain(sessionId: string): QueuedPrompt | null {
    const row = this.db.prepare(
      `SELECT * FROM prompt_queue
       WHERE session_id = ? AND status = 'queued'
       ORDER BY order_idx ASC LIMIT 1`,
    ).get(sessionId) as PromptQueueRow | undefined;

    if (!row) return null;

    this.db.prepare(
      `UPDATE prompt_queue
       SET status = 'draining', drained_at = datetime('now')
       WHERE id = ?`,
    ).run(row.id);

    return { ...rowToPrompt(row), status: 'draining' };
  }

  /**
   * Mark a drained prompt as completed.
   */
  complete(promptId: string): void {
    this.db.prepare(
      `UPDATE prompt_queue SET status = 'completed' WHERE id = ?`,
    ).run(promptId);
  }

  /**
   * Cancel a specific queued prompt.
   * Does NOT affect the active turn.
   *
   * Requirement 22.6
   */
  cancel(promptId: string): boolean {
    const result = this.db.prepare(
      `UPDATE prompt_queue SET status = 'cancelled' WHERE id = ? AND status = 'queued'`,
    ).run(promptId);
    return result.changes > 0;
  }

  /**
   * Cancel all queued prompts for a session.
   * Does NOT affect the active turn.
   *
   * Requirement 22.6
   */
  cancelAll(sessionId: string): number {
    const result = this.db.prepare(
      `UPDATE prompt_queue SET status = 'cancelled' WHERE session_id = ? AND status = 'queued'`,
    ).run(sessionId);
    return result.changes;
  }

  /**
   * Update the text of a queued prompt (editable while queued).
   *
   * Requirement 22.2
   */
  updateText(promptId: string, newText: string): boolean {
    const result = this.db.prepare(
      `UPDATE prompt_queue SET text = ? WHERE id = ? AND status = 'queued'`,
    ).run(newText, promptId);
    return result.changes > 0;
  }

  /**
   * Reorder a prompt within the queue (move to new position).
   */
  reorder(promptId: string, newOrderIdx: number): boolean {
    const result = this.db.prepare(
      `UPDATE prompt_queue SET order_idx = ? WHERE id = ? AND status = 'queued'`,
    ).run(newOrderIdx, promptId);
    return result.changes > 0;
  }

  /**
   * Get queue stats for a session.
   */
  getStats(sessionId: string): PromptQueueStats {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) as count FROM prompt_queue WHERE session_id = ? GROUP BY status`,
    ).all(sessionId) as { status: string; count: number }[];

    const stats: PromptQueueStats = { queued: 0, draining: 0, completed: 0, cancelled: 0 };
    for (const row of rows) {
      if (row.status in stats) {
        (stats as any)[row.status] = row.count;
      }
    }
    return stats;
  }

  /**
   * Get a specific prompt by ID.
   */
  get(promptId: string): QueuedPrompt | null {
    const row = this.db.prepare(
      `SELECT * FROM prompt_queue WHERE id = ?`,
    ).get(promptId) as PromptQueueRow | undefined;
    return row ? rowToPrompt(row) : null;
  }

  /**
   * Check if there are pending prompts to drain.
   */
  hasPending(sessionId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM prompt_queue WHERE session_id = ? AND status = 'queued' LIMIT 1`,
    ).get(sessionId);
    return !!row;
  }

  /**
   * Drain all prompts in order (for batch processing after turn terminal state).
   * Returns prompts in FIFO order.
   *
   * Requirement 22.3
   */
  drainAll(sessionId: string): QueuedPrompt[] {
    const rows = this.db.prepare(
      `SELECT * FROM prompt_queue
       WHERE session_id = ? AND status = 'queued'
       ORDER BY order_idx ASC`,
    ).all(sessionId) as PromptQueueRow[];

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE prompt_queue
       SET status = 'draining', drained_at = datetime('now')
       WHERE id IN (${placeholders})`,
    ).run(...ids);

    return rows.map((r) => ({ ...rowToPrompt(r), status: 'draining' as const }));
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private getNextOrderIdx(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT MAX(order_idx) as max_idx FROM prompt_queue WHERE session_id = ?`,
    ).get(sessionId) as { max_idx: number | null } | undefined;
    return (row?.max_idx ?? -1) + 1;
  }
}
