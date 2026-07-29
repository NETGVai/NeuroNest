/**
 * Diff Review System — Implementation of structured diff annotation and review.
 *
 * Enables annotating session diffs with comments, change requests, and approvals,
 * then formatting those annotations as follow-up instructions for agent context.
 *
 * Key behaviours:
 *   - getDiff() presents changes in structured diff format with file paths, line numbers, context
 *   - addAnnotation() stores annotations with file path, line range, and content in SQLite
 *   - Supports annotation types: comment, request-change, approve-section
 *   - submitAnnotations() formats annotations as follow-up instructions for agent context
 *   - markStaleAnnotations() flags annotations where start > end or lines no longer exist
 *   - Applies null-check guard pattern when `diff_review` flag is disabled
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { randomUUID } from 'node:crypto';
import { safeExecFileSync } from '../security/safe-exec.js';
import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type {
  AnnotationType,
  DiffAnnotation,
  DiffHunk,
  SessionDiff,
  IDiffReviewSystem,
} from './diff-review-system.js';

// ─── Configuration ──────────────────────────────────────────────

export interface DiffReviewSystemConfig {
  /** Working directory for git operations. Defaults to process.cwd(). */
  cwd?: string;
  /** Number of context lines around each hunk in diff output. Default: 3. */
  contextLines?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const VALID_ANNOTATION_TYPES: ReadonlySet<AnnotationType> = new Set([
  'comment',
  'request-change',
  'approve-section',
]);

const DEFAULT_CONTEXT_LINES = 3;

// ─── DiffReviewSystem Implementation ────────────────────────────

/**
 * Presents agent-generated diffs in structured format with inline
 * annotation support that feeds back to agents as follow-up instructions.
 */
export class DiffReviewSystem implements IDiffReviewSystem {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly callbackEngine: CallbackEngine;
  private readonly cwd: string;
  private readonly contextLines: number;

  // ─── Prepared statements (lazily cached) ──────────────────────

  private readonly stmtInsert: Database.Statement;
  private readonly stmtSelectBySession: Database.Statement;
  private readonly stmtMarkStale: Database.Statement;
  private readonly stmtSelectNonStale: Database.Statement;

  constructor(
    db: Database.Database,
    featureGate: FeatureGateSystem,
    callbackEngine: CallbackEngine,
    config?: DiffReviewSystemConfig,
  ) {
    this.db = db;
    this.featureGate = featureGate;
    this.callbackEngine = callbackEngine;
    this.cwd = config?.cwd ?? process.cwd();
    this.contextLines = config?.contextLines ?? DEFAULT_CONTEXT_LINES;

    // Prepare statements for efficient reuse
    this.stmtInsert = this.db.prepare(`
      INSERT INTO diff_annotations (id, session_id, file_path, start_line, end_line, type, content, author, stale, created_at)
      VALUES (@id, @sessionId, @filePath, @startLine, @endLine, @type, @content, @author, @stale, @createdAt)
    `);

    this.stmtSelectBySession = this.db.prepare(`
      SELECT id, session_id, file_path, start_line, end_line, type, content, author, stale, created_at
      FROM diff_annotations
      WHERE session_id = ?
      ORDER BY file_path, start_line
    `);

    this.stmtMarkStale = this.db.prepare(`
      UPDATE diff_annotations SET stale = 1 WHERE id = ?
    `);

    this.stmtSelectNonStale = this.db.prepare(`
      SELECT id, session_id, file_path, start_line, end_line, type, content, author, stale, created_at
      FROM diff_annotations
      WHERE session_id = ? AND stale = 0
      ORDER BY file_path, start_line
    `);
  }

  // ─── IDiffReviewSystem Implementation ─────────────────────────

  /**
   * Get the structured diff for a session including all annotations.
   *
   * Presents changes with file paths, line numbers, and context.
   * Returns empty SessionDiff when feature gate is disabled.
   *
   * Requirement 6.1: Present changes in structured diff format.
   * Requirement 6.6: Zero overhead when disabled.
   */
  async getDiff(sessionId: string): Promise<SessionDiff> {
    // Null-check guard: zero overhead when disabled (Requirement 6.6)
    if (!this.featureGate.isEnabled('diff_review')) {
      return { sessionId, hunks: [], annotations: [] };
    }

    // Parse git diff output into structured hunks
    const hunks = this.parseGitDiff();

    // Retrieve all annotations for this session
    const annotations = this.getAnnotationsForSession(sessionId);

    return { sessionId, hunks, annotations };
  }

  /**
   * Add an annotation to a diff with file path, line range, and content.
   *
   * Validates annotation type and stores in SQLite.
   * Returns a no-op annotation stub when feature gate is disabled.
   *
   * Requirement 6.2: Store annotation with file path, line range, content.
   * Requirement 6.4: Support annotation types: comment, request-change, approve-section.
   * Requirement 6.6: Zero overhead when disabled.
   */
  addAnnotation(
    sessionId: string,
    annotation: Omit<DiffAnnotation, 'id' | 'createdAt' | 'stale'>,
  ): DiffAnnotation {
    // Null-check guard: return stub when disabled (Requirement 6.6)
    if (!this.featureGate.isEnabled('diff_review')) {
      return {
        ...annotation,
        id: '',
        createdAt: '',
        stale: true,
      };
    }

    // Validate annotation type (Requirement 6.4)
    if (!VALID_ANNOTATION_TYPES.has(annotation.type)) {
      throw new Error(
        `Invalid annotation type: '${annotation.type}'. Must be one of: comment, request-change, approve-section`,
      );
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const stale = false;

    const record: DiffAnnotation = {
      ...annotation,
      id,
      createdAt,
      stale,
    };

    // Persist to SQLite
    this.stmtInsert.run({
      id,
      sessionId,
      filePath: record.filePath,
      startLine: record.startLine,
      endLine: record.endLine,
      type: record.type,
      content: record.content,
      author: record.author,
      stale: stale ? 1 : 0,
      createdAt,
    });

    return record;
  }

  /**
   * Format all non-stale annotations as follow-up instructions for agent context.
   *
   * Generates a structured text block that can be injected into the agent's
   * next iteration context, grouped by file path.
   *
   * Requirement 6.3: Format annotations as follow-up instructions.
   * Requirement 6.6: Zero overhead when disabled.
   */
  async submitAnnotations(sessionId: string): Promise<string> {
    // Null-check guard: return empty string when disabled (Requirement 6.6)
    if (!this.featureGate.isEnabled('diff_review')) {
      return '';
    }

    const rows = this.stmtSelectNonStale.all(sessionId) as AnnotationRow[];
    const annotations = rows.map(rowToAnnotation);

    if (annotations.length === 0) {
      return '';
    }

    // Format annotations grouped by file path
    const formatted = this.formatAnnotationsAsInstructions(annotations);

    // Emit lifecycle event for annotation submission
    await this.callbackEngine.emit({
      event: 'on-task-complete',
      sessionId,
      iteration: 0,
      output: { type: 'annotations-submitted', count: annotations.length },
    });

    return formatted;
  }

  /**
   * Flag annotations as stale where start > end or referenced lines no longer exist.
   *
   * Returns the list of annotations that were marked stale.
   *
   * Requirement 6.5: Flag annotations as stale when line ranges are invalid
   *                   or lines no longer exist due to subsequent changes.
   * Requirement 6.6: Zero overhead when disabled.
   */
  async markStaleAnnotations(sessionId: string): Promise<DiffAnnotation[]> {
    // Null-check guard: return empty array when disabled (Requirement 6.6)
    if (!this.featureGate.isEnabled('diff_review')) {
      return [];
    }

    const rows = this.stmtSelectBySession.all(sessionId) as AnnotationRow[];
    const annotations = rows.map(rowToAnnotation);
    const staleAnnotations: DiffAnnotation[] = [];

    // Get current file line counts for existence checking
    const fileLineCounts = this.getFileLineCounts(annotations);

    for (const annotation of annotations) {
      // Skip already-stale annotations
      if (annotation.stale) continue;

      let isStale = false;

      // Check if start > end (invalid range)
      if (annotation.startLine > annotation.endLine) {
        isStale = true;
      }

      // Check if referenced lines no longer exist in the file
      if (!isStale) {
        const lineCount = fileLineCounts.get(annotation.filePath);
        if (lineCount === null) {
          // File no longer exists
          isStale = true;
        } else if (lineCount !== undefined && lineCount !== null && annotation.endLine > lineCount) {
          isStale = true;
        }
      }

      if (isStale) {
        this.stmtMarkStale.run(annotation.id);
        annotation.stale = true;
        staleAnnotations.push(annotation);
      }
    }

    return staleAnnotations;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Parse git diff output into structured DiffHunk objects.
   *
   * Uses `git diff` with unified format to extract file paths,
   * line numbers, and change content.
   */
  private parseGitDiff(): DiffHunk[] {
    let diffOutput: string;
    try {
      const result = safeExecFileSync('git', ['diff', `-U${this.contextLines}`], {
        cwd: this.cwd,
        timeout: 30_000,
      });
      diffOutput = result.stdout;
    } catch {
      // No diff available or git not initialized
      return [];
    }

    if (!diffOutput.trim()) {
      return [];
    }

    return this.parseDiffOutput(diffOutput);
  }

  /**
   * Parse unified diff output into DiffHunk objects.
   */
  private parseDiffOutput(diffOutput: string): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    const lines = diffOutput.split('\n');
    let currentFile = '';
    let hunkContent: string[] = [];
    let currentHunkHeader: { oldStart: number; oldLines: number; newStart: number; newLines: number } | null = null;

    for (const line of lines) {
      // Detect file path from diff header
      const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (fileMatch) {
        // Flush previous hunk if any
        if (currentHunkHeader && currentFile) {
          hunks.push({
            filePath: currentFile,
            oldStart: currentHunkHeader.oldStart,
            oldLines: currentHunkHeader.oldLines,
            newStart: currentHunkHeader.newStart,
            newLines: currentHunkHeader.newLines,
            content: hunkContent.join('\n'),
          });
          hunkContent = [];
          currentHunkHeader = null;
        }
        currentFile = fileMatch[2] ?? '';
        continue;
      }

      // Detect hunk header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        // Flush previous hunk if any
        if (currentHunkHeader && currentFile) {
          hunks.push({
            filePath: currentFile,
            oldStart: currentHunkHeader.oldStart,
            oldLines: currentHunkHeader.oldLines,
            newStart: currentHunkHeader.newStart,
            newLines: currentHunkHeader.newLines,
            content: hunkContent.join('\n'),
          });
        }

        currentHunkHeader = {
          oldStart: parseInt(hunkMatch[1] ?? '1', 10),
          oldLines: parseInt(hunkMatch[2] ?? '1', 10),
          newStart: parseInt(hunkMatch[3] ?? '1', 10),
          newLines: parseInt(hunkMatch[4] ?? '1', 10),
        };
        hunkContent = [];
        continue;
      }

      // Skip other diff metadata lines (---, +++, index lines)
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
        continue;
      }

      // Accumulate hunk content lines
      if (currentHunkHeader) {
        hunkContent.push(line);
      }
    }

    // Flush final hunk
    if (currentHunkHeader && currentFile) {
      hunks.push({
        filePath: currentFile,
        oldStart: currentHunkHeader.oldStart,
        oldLines: currentHunkHeader.oldLines,
        newStart: currentHunkHeader.newStart,
        newLines: currentHunkHeader.newLines,
        content: hunkContent.join('\n'),
      });
    }

    return hunks;
  }

  /**
   * Retrieve all annotations for a session from SQLite.
   */
  private getAnnotationsForSession(sessionId: string): DiffAnnotation[] {
    const rows = this.stmtSelectBySession.all(sessionId) as AnnotationRow[];
    return rows.map(rowToAnnotation);
  }

  /**
   * Get the line count of each file referenced in the annotations.
   * Returns a Map of filePath → lineCount (or null if file doesn't exist).
   */
  private getFileLineCounts(annotations: DiffAnnotation[]): Map<string, number | null> {
    const result = new Map<string, number | null>();
    const uniqueFiles = new Set(annotations.map((a) => a.filePath));

    for (const filePath of uniqueFiles) {
      try {
        const wcResult = safeExecFileSync('wc', ['-l', filePath], {
          cwd: this.cwd,
          timeout: 5_000,
        });
        const output = wcResult.stdout.trim();
        const count = parseInt(output, 10);
        result.set(filePath, isNaN(count) ? null : count);
      } catch {
        // File doesn't exist or can't be read
        result.set(filePath, null);
      }
    }

    return result;
  }

  /**
   * Format annotations as follow-up instructions grouped by file.
   *
   * Produces a human-readable and machine-parseable instruction block
   * suitable for injection into agent context.
   */
  private formatAnnotationsAsInstructions(annotations: DiffAnnotation[]): string {
    // Group by file path
    const byFile = new Map<string, DiffAnnotation[]>();
    for (const annotation of annotations) {
      const existing = byFile.get(annotation.filePath) ?? [];
      existing.push(annotation);
      byFile.set(annotation.filePath, existing);
    }

    const sections: string[] = [];
    sections.push('## Review Annotations\n');
    sections.push('The following review annotations require attention:\n');

    for (const [filePath, fileAnnotations] of byFile) {
      sections.push(`### ${filePath}\n`);

      for (const annotation of fileAnnotations) {
        const typeLabel = this.getTypeLabel(annotation.type);
        const lineRange = annotation.startLine === annotation.endLine
          ? `line ${annotation.startLine}`
          : `lines ${annotation.startLine}–${annotation.endLine}`;

        sections.push(`- **[${typeLabel}]** (${lineRange}, by ${annotation.author}): ${annotation.content}`);
      }

      sections.push('');
    }

    return sections.join('\n').trim();
  }

  /**
   * Get a human-readable label for an annotation type.
   */
  private getTypeLabel(type: AnnotationType): string {
    switch (type) {
      case 'comment':
        return 'Comment';
      case 'request-change':
        return 'Change Requested';
      case 'approve-section':
        return 'Approved';
    }
  }
}

// ─── Row Type & Mapping ─────────────────────────────────────────

/** Raw row shape from SQLite query */
interface AnnotationRow {
  id: string;
  session_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  type: string;
  content: string;
  author: string;
  stale: number;
  created_at: string;
}

/** Convert a SQLite row to a DiffAnnotation domain object */
function rowToAnnotation(row: AnnotationRow): DiffAnnotation {
  return {
    id: row.id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    type: row.type as AnnotationType,
    content: row.content,
    author: row.author,
    stale: row.stale === 1,
    createdAt: row.created_at,
  };
}
