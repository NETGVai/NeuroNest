/**
 * Edit History Tracker — Rolling window of recent edits with undo awareness.
 *
 * Records file edits (by user or agent) with unified diffs, maintains a rolling
 * window of the most recent entries, persists to SQLite, and provides compressed
 * summaries for token-efficient inclusion in multi-turn conversations.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EditEntry } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum entries in the rolling window. */
const DEFAULT_MAX_ENTRIES = 50;

/** Default maximum total diff size in bytes (1MB). */
const DEFAULT_MAX_DIFF_SIZE_BYTES = 1_048_576;

/** Threshold above which a single diff is summarized (50KB). */
const LARGE_DIFF_THRESHOLD_BYTES = 51_200;

// ---------------------------------------------------------------------------
// Edit History Tracker
// ---------------------------------------------------------------------------

export class EditHistoryTracker {
  private readonly db: Database.Database;
  private readonly maxEntries: number;
  private readonly maxDiffSizeBytes: number;
  private readonly sessionId: string;

  // Prepared statements (initialized in constructor)
  private readonly stmtInsert: Database.Statement;
  private readonly stmtDeleteOldest: Database.Statement;
  private readonly stmtMarkReverted: Database.Statement;
  private readonly stmtGetRecent: Database.Statement;
  private readonly stmtGetRecentByFile: Database.Statement;
  private readonly stmtGetCount: Database.Statement;
  private readonly stmtGetTotalDiffSize: Database.Statement;

  constructor(
    db: Database.Database,
    options: { maxEntries?: number; maxDiffSizeBytes?: number; sessionId?: string },
  ) {
    this.db = db;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxDiffSizeBytes = options.maxDiffSizeBytes ?? DEFAULT_MAX_DIFF_SIZE_BYTES;
    this.sessionId = options.sessionId ?? 'default';

    this.stmtInsert = this.db.prepare(`
      INSERT INTO gcf_edit_history (id, session_id, file_path, diff, actor, reverted, timestamp, diff_size_bytes)
      VALUES (@id, @session_id, @file_path, @diff, @actor, @reverted, @timestamp, @diff_size_bytes)
    `);

    this.stmtDeleteOldest = this.db.prepare(`
      DELETE FROM gcf_edit_history
      WHERE session_id = ? AND id IN (
        SELECT id FROM gcf_edit_history
        WHERE session_id = ?
        ORDER BY timestamp ASC
        LIMIT ?
      )
    `);

    this.stmtMarkReverted = this.db.prepare(`
      UPDATE gcf_edit_history SET reverted = 1 WHERE id = ? AND session_id = ?
    `);

    this.stmtGetRecent = this.db.prepare(`
      SELECT id, file_path, diff, actor, reverted, timestamp
      FROM gcf_edit_history
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    this.stmtGetRecentByFile = this.db.prepare(`
      SELECT id, file_path, diff, actor, reverted, timestamp
      FROM gcf_edit_history
      WHERE session_id = ? AND file_path = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    this.stmtGetCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM gcf_edit_history WHERE session_id = ?
    `);

    this.stmtGetTotalDiffSize = this.db.prepare(`
      SELECT COALESCE(SUM(diff_size_bytes), 0) as total FROM gcf_edit_history WHERE session_id = ?
    `);
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Record a new edit. Enforces rolling window (max entries) and total diff size limit.
   * Large diffs (>50KB) are summarized with a truncation marker.
   */
  recordEdit(filePath: string, diff: string, actor: 'user' | string): void {
    const id = crypto.randomUUID();
    const timestamp = Date.now();

    // Summarize large diffs (>50KB)
    let storedDiff = diff;
    const rawDiffSize = Buffer.byteLength(diff, 'utf8');
    if (rawDiffSize > LARGE_DIFF_THRESHOLD_BYTES) {
      storedDiff = this.summarizeLargeDiff(diff, rawDiffSize);
    }

    const diffSizeBytes = Buffer.byteLength(storedDiff, 'utf8');

    // Enforce rolling window: delete oldest if at capacity
    const countRow = this.stmtGetCount.get(this.sessionId) as { count: number };
    if (countRow.count >= this.maxEntries) {
      const excess = countRow.count - this.maxEntries + 1;
      this.stmtDeleteOldest.run(this.sessionId, this.sessionId, excess);
    }

    // Insert the new entry
    this.stmtInsert.run({
      id,
      session_id: this.sessionId,
      file_path: filePath,
      diff: storedDiff,
      actor,
      reverted: 0,
      timestamp,
      diff_size_bytes: diffSizeBytes,
    });

    // Enforce total diff size limit: remove oldest until under budget
    this.enforceDiffSizeLimit();
  }

  /**
   * Mark an edit as reverted (undone). The edit remains in history with reverted=true
   * so the LLM knows not to reference the undone change.
   */
  markReverted(editId: string): void {
    this.stmtMarkReverted.run(editId, this.sessionId);
  }

  /**
   * Retrieve recent edits with optional file filter and limit.
   * Returns entries ordered by most recent first.
   */
  getRecentEdits(options?: { fileFilter?: string; limit?: number }): EditEntry[] {
    const limit = options?.limit ?? this.maxEntries;

    let rows: DbEditRow[];
    if (options?.fileFilter) {
      rows = this.stmtGetRecentByFile.all(this.sessionId, options.fileFilter, limit) as DbEditRow[];
    } else {
      rows = this.stmtGetRecent.all(this.sessionId, limit) as DbEditRow[];
    }

    return rows.map((row) => this.rowToEditEntry(row));
  }

  /**
   * Generate a compressed summary of edit history for multi-turn conversations
   * exceeding the given number of exchanges. Groups edits by file and provides
   * a brief overview rather than full diffs.
   */
  getCompressedSummary(maxExchanges: number): string {
    if (maxExchanges <= 5) {
      // For short conversations, return full edits (within limits)
      const edits = this.getRecentEdits({ limit: this.maxEntries });
      return this.buildFullSummary(edits);
    }

    // For longer conversations, group by file and summarize
    const edits = this.getRecentEdits({ limit: this.maxEntries });
    return this.buildCompressedSummary(edits);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  /**
   * Summarize a diff that exceeds the large diff threshold.
   * Truncates to a prefix with a marker indicating total size.
   */
  private summarizeLargeDiff(diff: string, totalBytes: number): string {
    // Keep the first ~4KB as a preview
    const previewBytes = 4096;
    const preview = Buffer.from(diff, 'utf8').subarray(0, previewBytes).toString('utf8');
    // Ensure we don't cut in the middle of a UTF-8 character
    const safePreview = preview.replace(/[\uD800-\uDBFF]$/, '');
    return `${safePreview}\n... [truncated, ${totalBytes} bytes total]`;
  }

  /**
   * Enforce the total diff size limit by removing oldest entries until
   * total stored diff bytes are within the configured maximum.
   */
  private enforceDiffSizeLimit(): void {
    const totalRow = this.stmtGetTotalDiffSize.get(this.sessionId) as { total: number };
    if (totalRow.total <= this.maxDiffSizeBytes) return;

    // Keep deleting the oldest entry until we're under the limit
    const deleteOldest = this.db.prepare(`
      DELETE FROM gcf_edit_history
      WHERE session_id = ? AND id = (
        SELECT id FROM gcf_edit_history
        WHERE session_id = ?
        ORDER BY timestamp ASC
        LIMIT 1
      )
    `);

    let total = totalRow.total;
    while (total > this.maxDiffSizeBytes) {
      const beforeRow = this.stmtGetTotalDiffSize.get(this.sessionId) as { total: number };
      deleteOldest.run(this.sessionId, this.sessionId);
      const afterRow = this.stmtGetTotalDiffSize.get(this.sessionId) as { total: number };
      if (afterRow.total >= beforeRow.total) break; // Safety: avoid infinite loop
      total = afterRow.total;
    }
  }

  /**
   * Build a full summary listing each edit entry (for short conversations).
   */
  private buildFullSummary(edits: EditEntry[]): string {
    if (edits.length === 0) return 'No recent edits.';

    const lines: string[] = ['Recent edits:'];
    for (const edit of edits) {
      const revertedMarker = edit.reverted ? ' [REVERTED]' : '';
      const time = new Date(edit.timestamp).toISOString();
      lines.push(`- ${edit.filePath} by ${edit.actor} at ${time}${revertedMarker}`);
      lines.push(`  ${this.diffOneLiner(edit.diff)}`);
    }
    return lines.join('\n');
  }

  /**
   * Build a compressed summary grouping edits by file (for longer conversations).
   */
  private buildCompressedSummary(edits: EditEntry[]): string {
    if (edits.length === 0) return 'No recent edits.';

    // Group by file path
    const byFile = new Map<string, EditEntry[]>();
    for (const edit of edits) {
      const group = byFile.get(edit.filePath) ?? [];
      group.push(edit);
      byFile.set(edit.filePath, group);
    }

    const lines: string[] = ['Edit history summary:'];
    for (const [filePath, fileEdits] of byFile) {
      const revertedCount = fileEdits.filter((e) => e.reverted).length;
      const actors = [...new Set(fileEdits.map((e) => e.actor))];
      const oldest = fileEdits[fileEdits.length - 1];
      const newest = fileEdits[0];

      let summary = `- ${filePath}: ${fileEdits.length} edit(s) by ${actors.join(', ')}`;
      if (revertedCount > 0) {
        summary += ` (${revertedCount} reverted)`;
      }
      summary += ` [${new Date(oldest.timestamp).toISOString()} → ${new Date(newest.timestamp).toISOString()}]`;
      lines.push(summary);
    }

    return lines.join('\n');
  }

  /**
   * Produce a one-line summary of a diff for the full summary view.
   */
  private diffOneLiner(diff: string): string {
    const lines = diff.split('\n');
    const additions = lines.filter((l) => l.startsWith('+')).length;
    const deletions = lines.filter((l) => l.startsWith('-')).length;
    return `+${additions}/-${deletions} lines`;
  }

  /** Convert a raw database row to an EditEntry. */
  private rowToEditEntry(row: DbEditRow): EditEntry {
    return {
      id: row.id,
      filePath: row.file_path,
      diff: row.diff,
      actor: row.actor,
      timestamp: row.timestamp,
      reverted: row.reverted === 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Database Row Type
// ---------------------------------------------------------------------------

interface DbEditRow {
  id: string;
  file_path: string;
  diff: string;
  actor: string;
  reverted: number;
  timestamp: number;
}
