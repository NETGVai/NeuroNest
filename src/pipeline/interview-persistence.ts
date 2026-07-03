/**
 * InterviewPersistence — SQLite-backed persistence for interview state.
 *
 * Uses the `interview_transcripts` table from migration 040 to persist
 * interview turns as JSON. Supports save (upsert), load, findIncomplete,
 * and delete operations.
 *
 * Persists after each turn AND during partial progress (in-flight questions,
 * draft recommendations) so mid-turn crashes are recoverable.
 *
 * Requirements: 9.1, 9.2, 9.3
 */

import type Database from 'better-sqlite3';
import type { InterviewPersistence, InterviewState, InterviewTurn } from './spec-interview-engine.js';

// ─── DB Row Shape ───────────────────────────────────────────────

interface InterviewRow {
  id: string;
  session_id: string;
  message_hash: string;
  complexity: string;
  status: string;
  turns: string; // JSON-serialized InterviewTurn[]
  original_message: string;
  max_questions: number;
  created_at: number;
  updated_at: number;
}

// ─── Implementation ─────────────────────────────────────────────

export class SqliteInterviewPersistence implements InterviewPersistence {
  private readonly upsertStmt: Database.Statement;
  private readonly loadStmt: Database.Statement;
  private readonly findIncompleteStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO interview_transcripts
        (id, session_id, message_hash, complexity, status, turns, original_message, max_questions, created_at, updated_at)
      VALUES
        (@id, @session_id, @message_hash, @complexity, @status, @turns, @original_message, @max_questions, @created_at, @updated_at)
    `);

    this.loadStmt = db.prepare(`
      SELECT id, session_id, message_hash, complexity, status, turns, original_message, max_questions, created_at, updated_at
      FROM interview_transcripts
      WHERE id = ?
    `);

    this.findIncompleteStmt = db.prepare(`
      SELECT id, session_id, message_hash, complexity, status, turns, original_message, max_questions, created_at, updated_at
      FROM interview_transcripts
      WHERE session_id = ? AND status NOT IN ('completed', 'cancelled', 'skipped')
      ORDER BY updated_at DESC
    `);

    this.deleteStmt = db.prepare(`
      DELETE FROM interview_transcripts WHERE id = ?
    `);
  }

  /**
   * Persist (upsert) the full InterviewState, serializing turns as JSON.
   * Called after each turn completes AND during partial progress (in-flight
   * questions) so that mid-turn crashes are recoverable.
   *
   * Requirement 9.1
   */
  save(state: InterviewState): void {
    this.upsertStmt.run({
      id: state.id,
      session_id: state.sessionId,
      message_hash: state.messageHash,
      complexity: state.complexity,
      status: state.status,
      turns: JSON.stringify(state.turns),
      original_message: state.originalMessage,
      max_questions: state.maxQuestions,
      created_at: state.createdAt,
      updated_at: state.updatedAt,
    });
  }

  /**
   * Load an interview by ID, deserializing the JSON turns column.
   * Returns null if no interview with the given ID exists.
   *
   * Requirement 9.2
   */
  load(interviewId: string): InterviewState | null {
    const row = this.loadStmt.get(interviewId) as InterviewRow | undefined;
    if (!row) return null;
    return this.rowToState(row);
  }

  /**
   * Find all incomplete interviews for a given session.
   * "Incomplete" = status NOT IN ('completed', 'cancelled', 'skipped').
   * Used on restart to detect interviews that need resumption.
   *
   * Requirement 9.2
   */
  findIncomplete(sessionId: string): InterviewState[] {
    const rows = this.findIncompleteStmt.all(sessionId) as InterviewRow[];
    return rows.map((row) => this.rowToState(row));
  }

  /**
   * Delete an interview record entirely.
   */
  delete(interviewId: string): void {
    this.deleteStmt.run(interviewId);
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private rowToState(row: InterviewRow): InterviewState {
    const turns: InterviewTurn[] = JSON.parse(row.turns);
    return {
      id: row.id,
      sessionId: row.session_id,
      messageHash: row.message_hash,
      complexity: row.complexity as InterviewState['complexity'],
      status: row.status as InterviewState['status'],
      turns,
      maxQuestions: row.max_questions,
      originalMessage: row.original_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
