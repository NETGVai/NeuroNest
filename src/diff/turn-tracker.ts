/**
 * Turn Tracker — Per-turn file change tracking for the DiffViewer.
 *
 * Hooks into agent-loop tool execution to record all file modifications per turn.
 * Stores before/after content and unified patch for each file change.
 * Groups changes by conversation turn index with agent attribution.
 * Persists to diff_turns and diff_turn_files tables.
 *
 * Requirements: 15.1, 15.5
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface DiffTurn {
  id: string;
  sessionId: string;
  turnIndex: number;
  agentId: string | null;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  linesAdded: number;
  linesRemoved: number;
  checkpointId: string | null;
  createdAt: number;
}

export interface DiffTurnFile {
  id: string;
  turnId: string;
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted';
  beforeContent: string | null;
  afterContent: string | null;
  patch: string;
}

export interface FileChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted';
  beforeContent: string | null;
  afterContent: string | null;
}

export interface TurnSummary {
  id: string;
  turnIndex: number;
  agentId: string | null;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  linesAdded: number;
  linesRemoved: number;
  createdAt: number;
}

// ─── Unified Diff Generation ────────────────────────────────────

/**
 * Compute a unified diff between two text strings.
 * Returns a unified diff string with hunk headers.
 */
export function computeUnifiedPatch(
  filePath: string,
  oldText: string,
  newText: string,
  contextLines = 3,
): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Compute edit operations using Myers-like approach (simplified LCS)
  const ops = computeEditOps(oldLines, newLines);

  if (ops.length === 0) {
    return '';
  }

  // Build hunks with context
  const hunks = buildUnifiedHunks(oldLines, newLines, ops, contextLines);

  if (hunks.length === 0) {
    return '';
  }

  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  return header + hunks.join('\n') + '\n';
}

type EditOp =
  | { type: 'equal'; oldIdx: number; newIdx: number }
  | { type: 'delete'; oldIdx: number }
  | { type: 'insert'; newIdx: number };

function computeEditOps(oldLines: string[], newLines: string[]): EditOp[] {
  const m = oldLines.length;
  const n = newLines.length;

  // LCS via dynamic programming
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce edit operations
  const ops: EditOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: 'equal', oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'insert', newIdx: j - 1 });
      j--;
    } else {
      ops.unshift({ type: 'delete', oldIdx: i - 1 });
      i--;
    }
  }

  return ops;
}

function buildUnifiedHunks(
  oldLines: string[],
  newLines: string[],
  ops: EditOp[],
  context: number,
): string[] {
  // Find ranges of changes and group with context
  const changeIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== 'equal') {
      changeIndices.push(idx);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group contiguous changes (with context overlap merging)
  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = Math.max(0, changeIndices[0] - context);
  let groupEnd = Math.min(ops.length - 1, changeIndices[0] + context);

  for (let c = 1; c < changeIndices.length; c++) {
    const nextStart = Math.max(0, changeIndices[c] - context);
    const nextEnd = Math.min(ops.length - 1, changeIndices[c] + context);

    if (nextStart <= groupEnd + 1) {
      // Merge with current group
      groupEnd = nextEnd;
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = nextStart;
      groupEnd = nextEnd;
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  // Build hunk strings
  const hunks: string[] = [];
  for (const group of groups) {
    let oldStart = 1;
    let newStart = 1;

    // Calculate starting line numbers
    for (let idx = 0; idx < group.start; idx++) {
      const op = ops[idx];
      if (op.type === 'equal' || op.type === 'delete') oldStart++;
      if (op.type === 'equal' || op.type === 'insert') newStart++;
    }

    let oldCount = 0;
    let newCount = 0;
    const lines: string[] = [];

    for (let idx = group.start; idx <= group.end; idx++) {
      const op = ops[idx];
      if (op.type === 'equal') {
        lines.push(` ${oldLines[op.oldIdx]}`);
        oldCount++;
        newCount++;
      } else if (op.type === 'delete') {
        lines.push(`-${oldLines[op.oldIdx]}`);
        oldCount++;
      } else if (op.type === 'insert') {
        lines.push(`+${newLines[op.newIdx]}`);
        newCount++;
      }
    }

    const hunkHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    hunks.push(hunkHeader + '\n' + lines.join('\n'));
  }

  return hunks;
}

// ─── Line Count Utilities ───────────────────────────────────────

/**
 * Count lines added and removed from a patch string.
 */
export function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }

  return { added, removed };
}

// ─── Database Persistence Layer ─────────────────────────────────

export interface TurnTrackerStore {
  insertTurn(turn: DiffTurn): void;
  insertTurnFile(file: DiffTurnFile): void;
  getTurnsForSession(sessionId: string): DiffTurn[];
  getFilesForTurn(turnId: string): DiffTurnFile[];
  getTurn(turnId: string): DiffTurn | null;
  updateTurnStats(turnId: string, stats: Pick<DiffTurn, 'filesAdded' | 'filesModified' | 'filesDeleted' | 'linesAdded' | 'linesRemoved'>): void;
}

/**
 * SQLite-backed persistence for diff turn tracking.
 * Operates against diff_turns and diff_turn_files tables.
 */
export class SqliteTurnTrackerStore implements TurnTrackerStore {
  private stmtInsertTurn: Database.Statement;
  private stmtInsertFile: Database.Statement;
  private stmtGetTurns: Database.Statement;
  private stmtGetFiles: Database.Statement;
  private stmtGetTurn: Database.Statement;
  private stmtUpdateStats: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtInsertTurn = db.prepare(`
      INSERT INTO diff_turns (id, session_id, turn_index, agent_id, files_added, files_modified, files_deleted, lines_added, lines_removed, checkpoint_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertFile = db.prepare(`
      INSERT INTO diff_turn_files (id, turn_id, file_path, change_type, before_content, after_content, patch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetTurns = db.prepare(
      'SELECT * FROM diff_turns WHERE session_id = ? ORDER BY turn_index ASC',
    );

    this.stmtGetFiles = db.prepare(
      'SELECT * FROM diff_turn_files WHERE turn_id = ?',
    );

    this.stmtGetTurn = db.prepare(
      'SELECT * FROM diff_turns WHERE id = ?',
    );

    this.stmtUpdateStats = db.prepare(`
      UPDATE diff_turns
      SET files_added = ?, files_modified = ?, files_deleted = ?, lines_added = ?, lines_removed = ?
      WHERE id = ?
    `);
  }

  insertTurn(turn: DiffTurn): void {
    this.stmtInsertTurn.run(
      turn.id,
      turn.sessionId,
      turn.turnIndex,
      turn.agentId,
      turn.filesAdded,
      turn.filesModified,
      turn.filesDeleted,
      turn.linesAdded,
      turn.linesRemoved,
      turn.checkpointId,
      turn.createdAt,
    );
  }

  insertTurnFile(file: DiffTurnFile): void {
    this.stmtInsertFile.run(
      file.id,
      file.turnId,
      file.filePath,
      file.changeType,
      file.beforeContent,
      file.afterContent,
      file.patch,
    );
  }

  getTurnsForSession(sessionId: string): DiffTurn[] {
    const rows = this.stmtGetTurns.all(sessionId) as any[];
    return rows.map(this.mapTurnRow);
  }

  getFilesForTurn(turnId: string): DiffTurnFile[] {
    const rows = this.stmtGetFiles.all(turnId) as any[];
    return rows.map(this.mapFileRow);
  }

  getTurn(turnId: string): DiffTurn | null {
    const row = this.stmtGetTurn.get(turnId) as any;
    if (!row) return null;
    return this.mapTurnRow(row);
  }

  updateTurnStats(
    turnId: string,
    stats: Pick<DiffTurn, 'filesAdded' | 'filesModified' | 'filesDeleted' | 'linesAdded' | 'linesRemoved'>,
  ): void {
    this.stmtUpdateStats.run(
      stats.filesAdded,
      stats.filesModified,
      stats.filesDeleted,
      stats.linesAdded,
      stats.linesRemoved,
      turnId,
    );
  }

  private mapTurnRow(row: any): DiffTurn {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      agentId: row.agent_id || null,
      filesAdded: row.files_added,
      filesModified: row.files_modified,
      filesDeleted: row.files_deleted,
      linesAdded: row.lines_added,
      linesRemoved: row.lines_removed,
      checkpointId: row.checkpoint_id || null,
      createdAt: row.created_at,
    };
  }

  private mapFileRow(row: any): DiffTurnFile {
    return {
      id: row.id,
      turnId: row.turn_id,
      filePath: row.file_path,
      changeType: row.change_type as 'added' | 'modified' | 'deleted',
      beforeContent: row.before_content || null,
      afterContent: row.after_content || null,
      patch: row.patch,
    };
  }
}

// ─── In-Memory Store (for testing / non-persistent use) ─────────

/**
 * In-memory implementation of TurnTrackerStore.
 * Useful for testing and scenarios where persistence isn't needed.
 */
export class InMemoryTurnTrackerStore implements TurnTrackerStore {
  private turns: Map<string, DiffTurn> = new Map();
  private files: Map<string, DiffTurnFile[]> = new Map();

  insertTurn(turn: DiffTurn): void {
    this.turns.set(turn.id, { ...turn });
    this.files.set(turn.id, []);
  }

  insertTurnFile(file: DiffTurnFile): void {
    const turnFiles = this.files.get(file.turnId);
    if (turnFiles) {
      turnFiles.push({ ...file });
    }
  }

  getTurnsForSession(sessionId: string): DiffTurn[] {
    return Array.from(this.turns.values())
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => a.turnIndex - b.turnIndex);
  }

  getFilesForTurn(turnId: string): DiffTurnFile[] {
    return this.files.get(turnId) || [];
  }

  getTurn(turnId: string): DiffTurn | null {
    return this.turns.get(turnId) || null;
  }

  updateTurnStats(
    turnId: string,
    stats: Pick<DiffTurn, 'filesAdded' | 'filesModified' | 'filesDeleted' | 'linesAdded' | 'linesRemoved'>,
  ): void {
    const turn = this.turns.get(turnId);
    if (turn) {
      turn.filesAdded = stats.filesAdded;
      turn.filesModified = stats.filesModified;
      turn.filesDeleted = stats.filesDeleted;
      turn.linesAdded = stats.linesAdded;
      turn.linesRemoved = stats.linesRemoved;
    }
  }
}

// ─── Turn Tracker Service ───────────────────────────────────────

/**
 * TurnTracker — Lazy-initialized singleton that hooks into agent-loop tool
 * execution to record all file modifications per turn.
 *
 * Usage:
 *   const tracker = TurnTracker.getInstance(store);
 *   tracker.beginTurn(sessionId, turnIndex, agentId);
 *   tracker.recordFileChange({ filePath, changeType, beforeContent, afterContent });
 *   tracker.commitTurn();
 *
 * Design: Hooks into the agent-loop by being called after each file_write,
 * str_replace, or file_delete tool execution completes.
 */
export class TurnTracker {
  private static instance: TurnTracker | null = null;

  private currentTurn: DiffTurn | null = null;
  private pendingChanges: FileChange[] = [];

  private constructor(private store: TurnTrackerStore) {}

  /**
   * Get or create the singleton TurnTracker instance.
   * Follows the project's lazy-initialization singleton pattern.
   */
  static getInstance(store: TurnTrackerStore): TurnTracker {
    if (!TurnTracker.instance) {
      TurnTracker.instance = new TurnTracker(store);
    }
    return TurnTracker.instance;
  }

  /**
   * Reset the singleton (useful for testing).
   */
  static resetInstance(): void {
    TurnTracker.instance = null;
  }

  /**
   * Begin tracking a new conversation turn.
   * Any uncommitted changes from a previous turn are discarded.
   */
  beginTurn(sessionId: string, turnIndex: number, agentId: string | null = null): void {
    // Auto-commit any pending turn
    if (this.currentTurn && this.pendingChanges.length > 0) {
      this.commitTurn();
    }

    this.currentTurn = {
      id: randomUUID(),
      sessionId,
      turnIndex,
      agentId,
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      linesAdded: 0,
      linesRemoved: 0,
      checkpointId: null,
      createdAt: Date.now(),
    };
    this.pendingChanges = [];
  }

  /**
   * Record a file change within the current turn.
   * Called after each file-modifying tool execution (file_write, str_replace, file_delete).
   */
  recordFileChange(change: FileChange): void {
    if (!this.currentTurn) {
      // No turn active — ignore (defensive, shouldn't happen in normal flow)
      return;
    }
    this.pendingChanges.push(change);
  }

  /**
   * Commit the current turn with all recorded file changes.
   * Computes patches, line counts, and persists to the store.
   * Returns the committed turn ID, or null if there was nothing to commit.
   */
  commitTurn(checkpointId?: string): string | null {
    if (!this.currentTurn) {
      return null;
    }

    if (this.pendingChanges.length === 0) {
      // No changes in this turn — still persist the turn record for completeness
      this.currentTurn.checkpointId = checkpointId || null;
      this.store.insertTurn(this.currentTurn);
      const turnId = this.currentTurn.id;
      this.currentTurn = null;
      this.pendingChanges = [];
      return turnId;
    }

    // Compute stats and persist
    let filesAdded = 0;
    let filesModified = 0;
    let filesDeleted = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    const turnFiles: DiffTurnFile[] = [];

    for (const change of this.pendingChanges) {
      const patch = this.computePatch(change);
      const { added, removed } = countPatchLines(patch);

      totalLinesAdded += added;
      totalLinesRemoved += removed;

      switch (change.changeType) {
        case 'added':
          filesAdded++;
          break;
        case 'modified':
          filesModified++;
          break;
        case 'deleted':
          filesDeleted++;
          break;
      }

      turnFiles.push({
        id: randomUUID(),
        turnId: this.currentTurn.id,
        filePath: change.filePath,
        changeType: change.changeType,
        beforeContent: change.beforeContent,
        afterContent: change.afterContent,
        patch,
      });
    }

    // Update turn stats
    this.currentTurn.filesAdded = filesAdded;
    this.currentTurn.filesModified = filesModified;
    this.currentTurn.filesDeleted = filesDeleted;
    this.currentTurn.linesAdded = totalLinesAdded;
    this.currentTurn.linesRemoved = totalLinesRemoved;
    this.currentTurn.checkpointId = checkpointId || null;

    // Persist turn
    this.store.insertTurn(this.currentTurn);

    // Persist file changes
    for (const file of turnFiles) {
      this.store.insertTurnFile(file);
    }

    const turnId = this.currentTurn.id;
    this.currentTurn = null;
    this.pendingChanges = [];

    return turnId;
  }

  /**
   * Attach a checkpoint ID to the current (uncommitted) turn.
   */
  setCheckpointId(checkpointId: string): void {
    if (this.currentTurn) {
      this.currentTurn.checkpointId = checkpointId;
    }
  }

  /**
   * Get the current turn being tracked (or null if no turn is active).
   */
  getCurrentTurn(): DiffTurn | null {
    return this.currentTurn ? { ...this.currentTurn } : null;
  }

  /**
   * Get the count of pending (uncommitted) file changes.
   */
  getPendingChangeCount(): number {
    return this.pendingChanges.length;
  }

  /**
   * Get all turns for a session.
   */
  getTurnsForSession(sessionId: string): TurnSummary[] {
    const turns = this.store.getTurnsForSession(sessionId);
    return turns.map((t) => ({
      id: t.id,
      turnIndex: t.turnIndex,
      agentId: t.agentId,
      filesAdded: t.filesAdded,
      filesModified: t.filesModified,
      filesDeleted: t.filesDeleted,
      linesAdded: t.linesAdded,
      linesRemoved: t.linesRemoved,
      createdAt: t.createdAt,
    }));
  }

  /**
   * Get file changes for a specific turn.
   */
  getFilesForTurn(turnId: string): DiffTurnFile[] {
    return this.store.getFilesForTurn(turnId);
  }

  /**
   * Compute a unified patch for a single file change.
   */
  private computePatch(change: FileChange): string {
    const before = change.beforeContent || '';
    const after = change.afterContent || '';

    if (change.changeType === 'added') {
      // New file — all lines are additions
      const lines = after.split('\n');
      const header = `--- /dev/null\n+++ b/${change.filePath}\n`;
      const hunk = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join('\n');
      return header + hunk + '\n';
    }

    if (change.changeType === 'deleted') {
      // Deleted file — all lines are removals
      const lines = before.split('\n');
      const header = `--- a/${change.filePath}\n+++ /dev/null\n`;
      const hunk = `@@ -1,${lines.length} +0,0 @@\n` + lines.map((l) => `-${l}`).join('\n');
      return header + hunk + '\n';
    }

    // Modified — compute unified diff
    return computeUnifiedPatch(change.filePath, before, after);
  }
}
