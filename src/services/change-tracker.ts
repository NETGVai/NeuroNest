/**
 * ChangeTracker — Tracks all file modifications during agent task execution.
 *
 * Records file creation, modification, and deletion events to the `change_tracking`
 * SQLite table. Provides before-state capture for diff support and aggregated
 * change summaries for the Change Summary Panel.
 *
 * Feature-gated via `production_ux_change_summary` — all methods are no-ops
 * when the flag is disabled (zero overhead).
 *
 * Requirements: 7.1, 7.2, 7.4, 8.1
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type {
  FileChangeEvent,
  ChangeSummary,
  FileChangeRecord,
} from '../shared/production-ux-types.js';

// ─── Internal Types ─────────────────────────────────────────────

interface ChangeTrackingRow {
  id: string;
  session_id: string;
  file_path: string;
  operation: 'created' | 'modified' | 'deleted';
  tool_call_id: string;
  before_content: string | null;
  after_content: string | null;
  size_delta: number | null;
  timestamp: number;
  created_at: string;
}

interface TaskExecutionRow {
  id: string;
  session_id: string;
  started_at: number;
  completed_at: number | null;
  total_iterations: number;
  total_tool_calls: number;
  status: string;
  execution_mode: string;
}

// ─── ChangeTracker Implementation ───────────────────────────────

export class ChangeTracker {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;

  // Prepared statements (lazily cached)
  private readonly stmtInsertChange: Database.Statement;
  private readonly stmtSelectBySession: Database.Statement;
  private readonly stmtDeleteBySession: Database.Statement;
  private readonly stmtInsertTaskExecution: Database.Statement;
  private readonly stmtUpdateTaskExecution: Database.Statement;
  private readonly stmtGetTaskExecution: Database.Statement;

  constructor(db: Database.Database, featureGate: FeatureGateSystem) {
    this.db = db;
    this.featureGate = featureGate;

    // Prepare statements for efficient reuse
    this.stmtInsertChange = this.db.prepare(`
      INSERT INTO change_tracking (id, session_id, file_path, operation, tool_call_id, before_content, after_content, size_delta, timestamp)
      VALUES (@id, @sessionId, @filePath, @operation, @toolCallId, @beforeContent, @afterContent, @sizeDelta, @timestamp)
    `);

    this.stmtSelectBySession = this.db.prepare(`
      SELECT id, session_id, file_path, operation, tool_call_id, before_content, after_content, size_delta, timestamp, created_at
      FROM change_tracking
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);

    this.stmtDeleteBySession = this.db.prepare(`
      DELETE FROM change_tracking WHERE session_id = ?
    `);

    this.stmtInsertTaskExecution = this.db.prepare(`
      INSERT INTO task_executions (id, session_id, started_at, status, execution_mode, total_iterations, total_tool_calls)
      VALUES (@id, @sessionId, @startedAt, @status, @executionMode, @totalIterations, @totalToolCalls)
    `);

    this.stmtUpdateTaskExecution = this.db.prepare(`
      UPDATE task_executions
      SET completed_at = @completedAt, total_iterations = @totalIterations, total_tool_calls = @totalToolCalls, status = @status
      WHERE session_id = @sessionId AND status = 'running'
    `);

    this.stmtGetTaskExecution = this.db.prepare(`
      SELECT id, session_id, started_at, completed_at, total_iterations, total_tool_calls, status, execution_mode
      FROM task_executions
      WHERE session_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Start tracking for a new task session.
   * Creates a task_executions row with status 'running'.
   *
   * No-op when feature gate is disabled.
   */
  startTask(sessionId: string): void {
    if (!this.isEnabled()) return;

    this.stmtInsertTaskExecution.run({
      id: randomUUID(),
      sessionId,
      startedAt: Date.now(),
      status: 'running',
      executionMode: 'autopilot',
      totalIterations: 0,
      totalToolCalls: 0,
    });
  }

  /**
   * Record a file change event to the change_tracking table.
   *
   * Persists the file path, operation type, tool call ID, optional
   * before/after content, and computed size delta.
   *
   * No-op when feature gate is disabled.
   */
  recordChange(event: FileChangeEvent): void {
    if (!this.isEnabled()) return;

    // Compute size delta when before content is available
    let sizeDelta: number | null = null;
    let afterContent: string | null = null;

    if (event.type === 'modified' || event.type === 'created') {
      try {
        afterContent = fs.readFileSync(event.filePath, 'utf-8');
        if (event.beforeContent != null) {
          sizeDelta = Buffer.byteLength(afterContent, 'utf-8') - Buffer.byteLength(event.beforeContent, 'utf-8');
        } else if (event.type === 'created') {
          sizeDelta = Buffer.byteLength(afterContent, 'utf-8');
        }
      } catch {
        // File may have been immediately deleted or is binary — skip content capture
      }
    } else if (event.type === 'deleted' && event.beforeContent != null) {
      sizeDelta = -Buffer.byteLength(event.beforeContent, 'utf-8');
    }

    // Extract sessionId from the first part of the existing records or use a lookup
    // For change_tracking, we need the session_id. The event doesn't carry it directly,
    // so we need to find the running task execution for this context.
    // We'll get the session from the most recent running task execution.
    const sessionId = this.getActiveSessionId();
    if (!sessionId) return;

    this.stmtInsertChange.run({
      id: randomUUID(),
      sessionId,
      filePath: event.filePath,
      operation: event.type,
      toolCallId: event.toolCallId,
      beforeContent: event.beforeContent ?? null,
      afterContent,
      sizeDelta,
      timestamp: event.timestamp,
    });
  }

  /**
   * Record a file change event with an explicit session ID.
   *
   * This is the preferred method when the session ID is known directly
   * (e.g., from the agent loop context).
   *
   * No-op when feature gate is disabled.
   */
  recordChangeForSession(sessionId: string, event: FileChangeEvent): void {
    if (!this.isEnabled()) return;

    let sizeDelta: number | null = null;
    let afterContent: string | null = null;

    if (event.type === 'modified' || event.type === 'created') {
      try {
        afterContent = fs.readFileSync(event.filePath, 'utf-8');
        if (event.beforeContent != null) {
          sizeDelta = Buffer.byteLength(afterContent, 'utf-8') - Buffer.byteLength(event.beforeContent, 'utf-8');
        } else if (event.type === 'created') {
          sizeDelta = Buffer.byteLength(afterContent, 'utf-8');
        }
      } catch {
        // File may have been immediately deleted or is binary — skip content capture
      }
    } else if (event.type === 'deleted' && event.beforeContent != null) {
      sizeDelta = -Buffer.byteLength(event.beforeContent, 'utf-8');
    }

    this.stmtInsertChange.run({
      id: randomUUID(),
      sessionId,
      filePath: event.filePath,
      operation: event.type,
      toolCallId: event.toolCallId,
      beforeContent: event.beforeContent ?? null,
      afterContent,
      sizeDelta,
      timestamp: event.timestamp,
    });
  }

  /**
   * Capture file content before a write operation for diff support.
   *
   * Returns the current file content as a string, or null if the file
   * does not exist (indicating a new file creation).
   *
   * No-op when feature gate is disabled (returns null).
   *
   * Requirement 8.1: Capture file content before and after modification.
   */
  captureBeforeState(filePath: string): string | null {
    if (!this.isEnabled()) return null;

    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      // File doesn't exist yet — this is a creation event
      return null;
    }
  }

  /**
   * Get the complete change summary for a completed or running task session.
   *
   * Groups all recorded changes by operation type (created, modified, deleted),
   * includes total tool calls and iterations from the task execution record,
   * and computes the duration.
   *
   * Returns an empty summary when feature gate is disabled.
   *
   * Requirements: 7.1, 7.2, 7.4
   */
  getSummary(sessionId: string): ChangeSummary {
    if (!this.isEnabled()) {
      return {
        sessionId,
        created: [],
        modified: [],
        deleted: [],
        totalToolCalls: 0,
        totalIterations: 0,
        durationMs: 0,
      };
    }

    const rows = this.stmtSelectBySession.all(sessionId) as ChangeTrackingRow[];
    const taskExecution = this.stmtGetTaskExecution.get(sessionId) as TaskExecutionRow | undefined;

    const created: FileChangeRecord[] = [];
    const modified: FileChangeRecord[] = [];
    const deleted: FileChangeRecord[] = [];

    for (const row of rows) {
      const record: FileChangeRecord = {
        filePath: row.file_path,
        timestamp: row.timestamp,
        toolCallId: row.tool_call_id,
        sizeDelta: row.size_delta ?? undefined,
      };

      switch (row.operation) {
        case 'created':
          created.push(record);
          break;
        case 'modified':
          modified.push(record);
          break;
        case 'deleted':
          deleted.push(record);
          break;
      }
    }

    const totalToolCalls = taskExecution?.total_tool_calls ?? 0;
    const totalIterations = taskExecution?.total_iterations ?? Math.max(1, rows.length > 0 ? 1 : 0);

    let durationMs = 0;
    if (taskExecution) {
      const endTime = taskExecution.completed_at ?? Date.now();
      durationMs = endTime - taskExecution.started_at;
    } else if (rows.length > 0) {
      // Fallback: compute duration from first to last change timestamp
      durationMs = rows[rows.length - 1].timestamp - rows[0].timestamp;
    }

    return {
      sessionId,
      created,
      modified,
      deleted,
      totalToolCalls,
      totalIterations,
      durationMs,
    };
  }

  /**
   * Clear all tracking data for a session.
   *
   * Removes change_tracking rows and updates the task_execution status.
   *
   * No-op when feature gate is disabled.
   */
  clearSession(sessionId: string): void {
    if (!this.isEnabled()) return;

    this.stmtDeleteBySession.run(sessionId);
  }

  /**
   * Update the task execution record with final metrics.
   *
   * Called by the agent loop when a task completes or fails.
   */
  completeTask(sessionId: string, status: 'completed' | 'failed' | 'cancelled', totalIterations: number, totalToolCalls: number): void {
    if (!this.isEnabled()) return;

    this.stmtUpdateTaskExecution.run({
      sessionId,
      completedAt: Date.now(),
      totalIterations,
      totalToolCalls,
      status,
    });
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check if the feature gate is enabled.
   */
  private isEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_change_summary');
  }

  /**
   * Get the session ID of the currently running task execution.
   */
  private getActiveSessionId(): string | null {
    const row = this.db.prepare(
      `SELECT session_id FROM task_executions WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
    ).get() as { session_id: string } | undefined;

    return row?.session_id ?? null;
  }
}
