/**
 * DiffView — Diff view for proposed code changes and syntax highlighting.
 *
 * Stub implementation providing diff computation, syntax highlighting
 * data structures, and approval workflow for code changes.
 *
 * Requirements: 12.2–12.5, 12.8–12.11
 */

// ─── Types ──────────────────────────────────────────────────────

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  lineNumber: number;
  content: string;
}

export interface DiffResult {
  filePath: string;
  original: string;
  proposed: string;
  hunks: DiffHunk[];
  totalAdded: number;
  totalRemoved: number;
}

export interface DiffHunk {
  startLine: number;
  endLine: number;
  lines: DiffLine[];
}

export interface SyntaxToken {
  type: 'keyword' | 'string' | 'number' | 'comment' | 'identifier' | 'operator' | 'punctuation' | 'plain';
  value: string;
  start: number;
  end: number;
}

export interface HighlightedLine {
  lineNumber: number;
  tokens: SyntaxToken[];
  raw: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface CodeChange {
  id: string;
  filePath: string;
  diff: DiffResult;
  status: ApprovalStatus;
  createdAt: Date;
}

// ─── DiffView ───────────────────────────────────────────────────

export class DiffView {
  private pendingChanges = new Map<string, CodeChange>();

  /**
   * Compute a diff between original and proposed content.
   * Requirements: 12.2, 12.3
   */
  computeDiff(filePath: string, original: string, proposed: string): DiffResult {
    const originalLines = original.split('\n');
    const proposedLines = proposed.split('\n');

    const lines: DiffLine[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    // Simple line-by-line diff (stub — real impl would use Myers diff)
    const maxLen = Math.max(originalLines.length, proposedLines.length);
    for (let i = 0; i < maxLen; i++) {
      const origLine = i < originalLines.length ? originalLines[i] : undefined;
      const propLine = i < proposedLines.length ? proposedLines[i] : undefined;

      if (origLine === propLine) {
        lines.push({ type: 'unchanged', lineNumber: i + 1, content: origLine! });
      } else {
        if (origLine !== undefined) {
          lines.push({ type: 'removed', lineNumber: i + 1, content: origLine });
          totalRemoved++;
        }
        if (propLine !== undefined) {
          lines.push({ type: 'added', lineNumber: i + 1, content: propLine });
          totalAdded++;
        }
      }
    }

    const hunks: DiffHunk[] = [];
    if (lines.some((l) => l.type !== 'unchanged')) {
      hunks.push({
        startLine: 1,
        endLine: maxLen,
        lines,
      });
    }

    return { filePath, original, proposed, hunks, totalAdded, totalRemoved };
  }

  /**
   * Create a pending code change for user approval.
   * Requirements: 12.3, 12.4
   */
  proposeChange(filePath: string, original: string, proposed: string): CodeChange {
    const diff = this.computeDiff(filePath, original, proposed);
    const change: CodeChange = {
      id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      diff,
      status: 'pending',
      createdAt: new Date(),
    };
    this.pendingChanges.set(change.id, change);
    return change;
  }

  /**
   * Approve a pending change.
   * Requirements: 12.4
   */
  approveChange(changeId: string): CodeChange {
    const change = this.pendingChanges.get(changeId);
    if (!change) throw new Error(`Change not found: ${changeId}`);
    change.status = 'approved';
    return change;
  }

  /**
   * Reject a pending change.
   */
  rejectChange(changeId: string): CodeChange {
    const change = this.pendingChanges.get(changeId);
    if (!change) throw new Error(`Change not found: ${changeId}`);
    change.status = 'rejected';
    return change;
  }

  /**
   * Get all pending changes.
   */
  getPendingChanges(): CodeChange[] {
    return Array.from(this.pendingChanges.values()).filter((c) => c.status === 'pending');
  }

  /**
   * Stub syntax highlighting for a code string.
   * Requirements: 12.5
   */
  highlightSyntax(code: string, language: string): HighlightedLine[] {
    // Stub: return plain tokens for each line
    return code.split('\n').map((line, i) => ({
      lineNumber: i + 1,
      tokens: [{ type: 'plain' as const, value: line, start: 0, end: line.length }],
      raw: line,
    }));
  }
}
