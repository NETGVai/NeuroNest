/**
 * Planning authority types for Markdown and SQLite planning services.
 *
 * Requirements: 11.1, 11.3, 11.8, 11.10
 */

/** Authority designation for planning entities */
export type AuthoritySource = 'markdown' | 'sqlite';

/** Kinds of planning entities extracted from Markdown */
export type PlanningEntityKind = 'requirement' | 'design_node' | 'acceptance_criterion' | 'section';

/** Task status values (SQLite-authoritative) */
export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'needs_review'
  | 'cancelled';

/** Source range within a Markdown file */
export interface SourceRange {
  startLine: number;
  endLine: number;
}

/** A stable ID embedded in Markdown (e.g., <!-- id: REQ-001 -->) */
export interface EmbeddedId {
  id: string;
  line: number;
}

/** A parsed entity extracted from Markdown */
export interface ParsedEntity {
  id: string | null;
  kind: PlanningEntityKind;
  title: string;
  sourceRange: SourceRange;
  sourceFingerprint: string;
  headingLevel: number;
}

/** A planning source file tracked by the system */
export interface PlanningSource {
  id: string;
  workspaceId: string;
  filePath: string;
  sourceType: 'requirement' | 'design' | 'task_list';
  sourceHash: string;
  parseVersion: number;
  indexedRevision: string | null;
  fingerprint: string;
}

/** An indexed planning entity */
export interface PlanningEntity {
  id: string;
  sourceId: string;
  workspaceId: string;
  kind: PlanningEntityKind;
  title: string | null;
  sourceRangeStart: number | null;
  sourceRangeEnd: number | null;
  sourceFingerprint: string;
  fingerprint: string;
  isTombstone: boolean;
}

/** A task record (SQLite-authoritative) */
export interface PlanningTask {
  id: string;
  workspaceId: string;
  entityId: string | null;
  title: string;
  status: TaskStatus;
  priority: 'critical' | 'high' | 'medium' | 'low';
  risk: 'high' | 'medium' | 'low';
  readinessFingerprint: string | null;
  fingerprint: string;
  isTombstone: boolean;
}

/** A discrepancy between Markdown source and index */
export interface SourceIndexDiscrepancy {
  entityId: string;
  kind: 'content_changed' | 'entity_missing' | 'entity_added' | 'id_missing';
  sourceFingerprint: string;
  indexFingerprint: string | null;
  description: string;
  affectsReadiness: boolean;
}

/** Migration preview entry for entities missing stable IDs */
export interface MigrationPreviewEntry {
  title: string;
  kind: PlanningEntityKind;
  sourceRange: SourceRange;
  suggestedId: string;
  reason: string;
}

/** Tombstone record for preserving history */
export interface TombstoneRecord {
  id: string;
  entityType: string;
  originalEntityId: string;
  newEntityId: string | null;
  reason: 'renamed' | 'imported' | 'deleted' | 'merged' | 'superseded';
  metadata: Record<string, unknown>;
  createdAt: string;
}
