/**
 * Message Queue Service — Steer/Queue/Spec messaging mode.
 * 
 * Four modes:
 * - send: Normal send (default) — message goes directly to the pipeline
 * - steer: Redirect in-progress agent — interrupts current work and redirects
 * - queue: Queue for later — message is queued and processed after current work completes
 * - spec: Spec mode — triggers the grill-me pre-flight interview to clarify
 *         scope/decisions before handing the build off to the orchestrator
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export type MessageMode = 'send' | 'steer' | 'queue' | 'spec';

export interface QueuedMessage {
  id: string;
  project_id: string;
  message: string;
  mode: MessageMode;
  priority: number;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  created_at: string;
  processed_at: string | null;
}

export interface MessageModeConfig {
  project_id: string;
  default_mode: MessageMode;
  auto_process_queue: boolean;
}

export class MessageQueueService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Get message mode config for a project */
  getModeConfig(projectId: string): MessageModeConfig {
    const row = this.db.prepare('SELECT * FROM message_mode_config WHERE project_id = ?').get(projectId) as any;
    if (row) {
      return {
        project_id: row.project_id,
        default_mode: row.default_mode,
        auto_process_queue: !!row.auto_process_queue,
      };
    }
    // Create default
    this.db.prepare(
      'INSERT INTO message_mode_config (project_id) VALUES (?)'
    ).run(projectId);
    return { project_id: projectId, default_mode: 'send', auto_process_queue: true };
  }

  /** Update message mode config */
  setModeConfig(projectId: string, updates: Partial<MessageModeConfig>): MessageModeConfig {
    this.getModeConfig(projectId); // ensure exists
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.default_mode !== undefined) { fields.push('default_mode = ?'); values.push(updates.default_mode); }
    if (updates.auto_process_queue !== undefined) { fields.push('auto_process_queue = ?'); values.push(updates.auto_process_queue ? 1 : 0); }
    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`UPDATE message_mode_config SET ${fields.join(', ')} WHERE project_id = ?`).run(...values, projectId);
    }
    return this.getModeConfig(projectId);
  }

  /** Add a message to the queue */
  enqueue(projectId: string, message: string, mode: MessageMode = 'queue', priority = 0): QueuedMessage {
    const id = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO message_queue (id, project_id, message, mode, priority) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, message, mode, priority);
    return this.db.prepare('SELECT * FROM message_queue WHERE id = ?').get(id) as QueuedMessage;
  }

  /** Get pending messages in queue order (priority DESC, created_at ASC) */
  getPending(projectId: string): QueuedMessage[] {
    return this.db.prepare(
      `SELECT * FROM message_queue WHERE project_id = ? AND status = 'pending'
       ORDER BY priority DESC, created_at ASC`
    ).all(projectId) as QueuedMessage[];
  }

  /** Get next message to process */
  dequeue(projectId: string): QueuedMessage | null {
    const msg = this.db.prepare(
      `SELECT * FROM message_queue WHERE project_id = ? AND status = 'pending'
       ORDER BY priority DESC, created_at ASC LIMIT 1`
    ).get(projectId) as QueuedMessage | undefined;
    if (msg) {
      this.db.prepare(
        "UPDATE message_queue SET status = 'processing', processed_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(msg.id);
      return { ...msg, status: 'processing' };
    }
    return null;
  }

  /** Mark a queued message as completed */
  complete(messageId: string): void {
    this.db.prepare("UPDATE message_queue SET status = 'completed' WHERE id = ?").run(messageId);
  }

  /** Cancel a queued message */
  cancel(messageId: string): void {
    this.db.prepare("UPDATE message_queue SET status = 'cancelled' WHERE id = ?").run(messageId);
  }

  /** Cancel all pending messages for a project */
  cancelAll(projectId: string): number {
    const result = this.db.prepare(
      "UPDATE message_queue SET status = 'cancelled' WHERE project_id = ? AND status = 'pending'"
    ).run(projectId);
    return result.changes;
  }

  /** Get queue stats */
  getStats(projectId: string): { pending: number; processing: number; completed: number; cancelled: number } {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) as count FROM message_queue WHERE project_id = ? GROUP BY status`
    ).all(projectId) as { status: string; count: number }[];
    const stats = { pending: 0, processing: 0, completed: 0, cancelled: 0 };
    for (const row of rows) {
      if (row.status in stats) (stats as any)[row.status] = row.count;
    }
    return stats;
  }

  /** Get recent messages (all statuses) */
  getRecent(projectId: string, limit = 20): QueuedMessage[] {
    return this.db.prepare(
      'SELECT * FROM message_queue WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(projectId, limit) as QueuedMessage[];
  }
}
