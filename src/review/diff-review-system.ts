/**
 * Diff Review System — Interfaces for structured diff annotation and review.
 *
 * Enables annotating session diffs with comments, change requests, and approvals,
 * then formatting those annotations as follow-up instructions for agent context.
 *
 * Requirements: 6.1–6.6
 */

// ─── Types ──────────────────────────────────────────────────────

/** Annotation types for diff review */
export type AnnotationType = 'comment' | 'request-change' | 'approve-section';

/** A single annotation on a diff */
export interface DiffAnnotation {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  type: AnnotationType;
  content: string;
  author: string;
  createdAt: string;
  stale: boolean;
}

/** A structured diff hunk */
export interface DiffHunk {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

/** Complete diff for a session */
export interface SessionDiff {
  sessionId: string;
  hunks: DiffHunk[];
  annotations: DiffAnnotation[];
}

/** Diff Review System interface */
export interface IDiffReviewSystem {
  getDiff(sessionId: string): Promise<SessionDiff>;
  addAnnotation(sessionId: string, annotation: Omit<DiffAnnotation, 'id' | 'createdAt' | 'stale'>): DiffAnnotation;
  submitAnnotations(sessionId: string): Promise<string>;  // returns formatted instructions
  markStaleAnnotations(sessionId: string): Promise<DiffAnnotation[]>;
}
