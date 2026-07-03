/**
 * ApprovalGate — Backend service for managing file change approval decisions.
 *
 * Handles the approval workflow when a task completes with file modifications:
 * - Sends approval requests to the renderer via IPC
 * - Processes user decisions (approve_all, reject_all, selective)
 * - On approve: signals the agent loop to proceed with commit
 * - On reject: reverts all files to pre-task state using captured beforeContent
 * - Persists decisions to the `approval_decisions` SQLite table
 *
 * Feature-gated via `production_ux_approval_gate` — all methods are no-ops
 * when the flag is disabled.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type {
  ApprovalRequest,
  ApprovalDecision,
  ChangeSummary,
  DiffHunk,
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

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Timeout for an approval request before auto-rejecting (10 minutes). */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// ─── ApprovalGate Implementation ────────────────────────────────

export class ApprovalGate {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly ipcSend: ((channel: string, data: unknown) => void) | null;

  // Prepared statements (lazily cached)
  private readonly stmtInsertDecision: Database.Statement;
  private readonly stmtGetChangesBySession: Database.Statement;

  // Pending approval state — only one approval can be active at a time
  private pendingApproval: PendingApproval | null = null;

  constructor(
    db: Database.Database,
    featureGate: FeatureGateSystem,
    ipcSend?: (channel: string, data: unknown) => void,
  ) {
    this.db = db;
    this.featureGate = featureGate;
    this.ipcSend = ipcSend ?? null;

    this.stmtInsertDecision = this.db.prepare(`
      INSERT INTO approval_decisions (id, session_id, decision, approved_files, rejected_files)
      VALUES (@id, @sessionId, @decision, @approvedFiles, @rejectedFiles)
    `);

    this.stmtGetChangesBySession = this.db.prepare(`
      SELECT id, session_id, file_path, operation, tool_call_id, before_content, after_content, size_delta, timestamp, created_at
      FROM change_tracking
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Determine whether the approval gate should be shown.
   *
   * The gate is shown if and only if the task completed with at least
   * one file modification (created, modified, or deleted).
   *
   * Requirement 11.1: Gate shown when agent completes a task that modifies files.
   */
  shouldShowGate(changeSummary: ChangeSummary): boolean {
    if (!this.isEnabled()) return false;

    const totalChanges =
      changeSummary.created.length +
      changeSummary.modified.length +
      changeSummary.deleted.length;

    return totalChanges > 0;
  }

  /**
   * Send an approval request to the renderer and wait for user decision.
   *
   * Returns a promise that resolves when the user makes a decision.
   * The promise auto-rejects (reject_all) after APPROVAL_TIMEOUT_MS.
   *
   * Requirements: 11.1, 11.2, 11.5
   */
  requestApproval(
    sessionId: string,
    changeSummary: ChangeSummary,
  ): Promise<ApprovalDecision> {
    if (!this.isEnabled()) {
      // When disabled, auto-approve all changes
      return Promise.resolve({ action: 'approve_all' });
    }

    // Build diff hunks from the change tracking data
    const hunks = this.buildDiffHunks(sessionId);

    const request: ApprovalRequest = {
      sessionId,
      changeSummary,
      hunks,
      mode: hunks.length > 10 ? 'full' : 'per-hunk',
    };

    return new Promise<ApprovalDecision>((resolve) => {
      // Clean up any previous pending approval
      this.dismissPending();

      // Set up auto-reject timeout
      const timer = setTimeout(() => {
        if (this.pendingApproval) {
          this.pendingApproval = null;
          const decision: ApprovalDecision = { action: 'reject_all' };
          resolve(decision);
        }
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApproval = { request, resolve, timer };

      // Emit the approval request event to the renderer
      this.emitApprovalRequest(request);
    });
  }

  /**
   * Handle a user decision from the renderer (via `approval:respond` IPC).
   *
   * Processes the decision:
   * - approve_all: persist decision, allow commit to proceed
   * - reject_all: revert all files, persist decision
   * - selective: approve selected files, revert rejected ones, persist decision
   *
   * Requirements: 11.2, 11.3, 11.4
   */
  handleDecision(decision: ApprovalDecision): void {
    if (!this.pendingApproval) {
      console.warn('[ApprovalGate] No pending approval to resolve.');
      return;
    }

    const { request, resolve, timer } = this.pendingApproval;
    this.pendingApproval = null;
    clearTimeout(timer);

    // Persist the decision
    this.persistDecision(request.sessionId, decision);

    // Execute the decision
    switch (decision.action) {
      case 'reject_all':
        this.revertAllChanges(request.sessionId);
        break;
      case 'selective':
        this.revertSelectedFiles(request.sessionId, decision.rejected);
        break;
      case 'approve_all':
        // No action needed — files are already in their modified state
        break;
    }

    // Resolve the promise so the agent loop can continue
    resolve(decision);
  }

  /**
   * Dismiss the current pending approval (auto-approve).
   *
   * Called when a new task starts or the gate is explicitly dismissed.
   *
   * Requirement 11.5: Gate remains accessible until dismissed or new task starts.
   */
  dismissPending(): void {
    if (this.pendingApproval) {
      clearTimeout(this.pendingApproval.timer);
      this.pendingApproval.resolve({ action: 'approve_all' });
      this.pendingApproval = null;
    }
  }

  /**
   * Check if there is a pending approval request.
   */
  hasPendingApproval(): boolean {
    return this.pendingApproval !== null;
  }

  /**
   * Get the current pending approval request (if any).
   */
  getPendingRequest(): ApprovalRequest | null {
    return this.pendingApproval?.request ?? null;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check if the feature gate is enabled.
   */
  private isEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_approval_gate');
  }

  /**
   * Build diff hunks from the change tracking records for a session.
   */
  private buildDiffHunks(sessionId: string): DiffHunk[] {
    const rows = this.stmtGetChangesBySession.all(sessionId) as ChangeTrackingRow[];
    const hunks: DiffHunk[] = [];

    for (const row of rows) {
      if (row.operation === 'modified' && row.before_content && row.after_content) {
        // Build a simple hunk from the modification
        const beforeLines = row.before_content.split('\n');
        const afterLines = row.after_content.split('\n');

        hunks.push({
          filePath: row.file_path,
          oldStart: 1,
          oldLines: beforeLines.length,
          newStart: 1,
          newLines: afterLines.length,
          content: this.buildUnifiedDiff(beforeLines, afterLines),
        });
      } else if (row.operation === 'created' && row.after_content) {
        const afterLines = row.after_content.split('\n');
        hunks.push({
          filePath: row.file_path,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: afterLines.length,
          content: afterLines.map((line) => `+${line}`).join('\n'),
        });
      } else if (row.operation === 'deleted' && row.before_content) {
        const beforeLines = row.before_content.split('\n');
        hunks.push({
          filePath: row.file_path,
          oldStart: 1,
          oldLines: beforeLines.length,
          newStart: 0,
          newLines: 0,
          content: beforeLines.map((line) => `-${line}`).join('\n'),
        });
      }
    }

    return hunks;
  }

  /**
   * Build a simple unified diff content string from before/after lines.
   */
  private buildUnifiedDiff(beforeLines: string[], afterLines: string[]): string {
    const result: string[] = [];

    // Simple line-by-line diff (not optimal, but functional for display)
    const maxLen = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < maxLen; i++) {
      const before = beforeLines[i];
      const after = afterLines[i];

      if (before === after) {
        result.push(` ${before ?? ''}`);
      } else {
        if (before !== undefined) {
          result.push(`-${before}`);
        }
        if (after !== undefined) {
          result.push(`+${after}`);
        }
      }
    }

    return result.join('\n');
  }

  /**
   * Emit the approval request event to the renderer via IPC.
   */
  private emitApprovalRequest(request: ApprovalRequest): void {
    if (!this.ipcSend) return;

    try {
      this.ipcSend('agent:approval-request', request);
    } catch (e) {
      console.warn(
        '[ApprovalGate] Failed to emit approval request:',
        (e as Error)?.message ?? e,
      );
    }
  }

  /**
   * Persist the approval decision to the database.
   */
  private persistDecision(sessionId: string, decision: ApprovalDecision): void {
    const approvedFiles: string[] = [];
    const rejectedFiles: string[] = [];

    if (decision.action === 'selective') {
      approvedFiles.push(...decision.approved);
      rejectedFiles.push(...decision.rejected);
    }

    this.stmtInsertDecision.run({
      id: randomUUID(),
      sessionId,
      decision: decision.action,
      approvedFiles: JSON.stringify(approvedFiles),
      rejectedFiles: JSON.stringify(rejectedFiles),
    });
  }

  /**
   * Revert all file changes for a session to pre-task state.
   *
   * Requirement 11.4: On reject, revert all files to beforeContent.
   */
  private revertAllChanges(sessionId: string): void {
    const rows = this.stmtGetChangesBySession.all(sessionId) as ChangeTrackingRow[];

    // Process in reverse chronological order for safety
    const reversedRows = [...rows].reverse();

    for (const row of reversedRows) {
      this.revertSingleFile(row);
    }
  }

  /**
   * Revert only the rejected files in a selective approval.
   */
  private revertSelectedFiles(sessionId: string, rejectedFilePaths: string[]): void {
    const rows = this.stmtGetChangesBySession.all(sessionId) as ChangeTrackingRow[];
    const rejectedSet = new Set(rejectedFilePaths);

    // Process in reverse chronological order
    const reversedRows = [...rows].reverse();

    for (const row of reversedRows) {
      if (rejectedSet.has(row.file_path)) {
        this.revertSingleFile(row);
      }
    }
  }

  /**
   * Revert a single file change to its pre-modification state.
   */
  private revertSingleFile(row: ChangeTrackingRow): void {
    try {
      switch (row.operation) {
        case 'created':
          // File was created during task — delete it to revert
          if (fs.existsSync(row.file_path)) {
            fs.unlinkSync(row.file_path);
            // Clean up empty parent directories if needed
            this.cleanupEmptyDir(path.dirname(row.file_path));
          }
          break;

        case 'modified':
          // File was modified — restore before_content
          if (row.before_content !== null) {
            fs.writeFileSync(row.file_path, row.before_content, 'utf-8');
          }
          break;

        case 'deleted':
          // File was deleted during task — restore it
          if (row.before_content !== null) {
            const dir = path.dirname(row.file_path);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(row.file_path, row.before_content, 'utf-8');
          }
          break;
      }
    } catch (e) {
      console.warn(
        `[ApprovalGate] Failed to revert ${row.file_path}:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  /**
   * Remove empty parent directories after file deletion (non-recursive, single level).
   */
  private cleanupEmptyDir(dirPath: string): void {
    try {
      const entries = fs.readdirSync(dirPath);
      if (entries.length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch {
      // Ignore — directory may not exist or may have contents
    }
  }
}
