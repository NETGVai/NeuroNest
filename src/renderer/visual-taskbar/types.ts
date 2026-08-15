/**
 * Visual_Taskbar shared types for the planning projection model.
 *
 * These types define the entities, links, snapshots, deltas, and view models
 * used by both the compact bar and the expandable planning view.
 *
 * Requirements: 10.1, 10.2, 10.6, 10.7, 10.12
 */

import type { TaskStatus } from '../../planning/types.js';
import type { TraceLinkRelationship } from '../../planning/trace-link-service.js';

/** Entity kinds displayed in the Visual_Taskbar */
export type TaskbarEntityKind =
  | 'requirement'
  | 'design_node'
  | 'task'
  | 'execution';

/** Priority levels for taskbar entities */
export type TaskbarPriority = 'critical' | 'high' | 'medium' | 'low';

/** Status for taskbar entities (superset covering all entity kinds) */
export type TaskbarEntityStatus =
  | TaskStatus
  | 'covered'
  | 'uncovered'
  | 'partial'
  | 'implemented'
  | 'unimplemented'
  | 'active';

/** A typed link between entities in the taskbar projection */
export interface TaskbarTypedLink {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationship: TraceLinkRelationship;
  sourceKind: TaskbarEntityKind;
  targetKind: TaskbarEntityKind;
}

/** An entity displayed in the Visual_Taskbar */
export interface TaskbarEntity {
  id: string;
  kind: TaskbarEntityKind;
  title: string;
  status: TaskbarEntityStatus;
  priority: TaskbarPriority;
  workspaceId: string;
  component?: string;
  requirementId?: string;
  parentId?: string;
  fingerprint: string;
  /** File path associated with this entity */
  file?: string;
  /** Agent assigned to this entity */
  agent?: string;
  /** Run ID associated with this entity */
  runId?: string;
  /** Risk level */
  risk?: TaskbarRiskLevel;
  /** Release milestone */
  milestone?: string;
}

/** Entity counts for the compact bar display */
export interface EntityCounts {
  requirements: number;
  designNodes: number;
  tasks: number;
  executions: number;
}

/** A versioned snapshot sent from the main process */
export interface ProjectionSnapshot {
  version: number;
  workspaceId: string;
  entities: TaskbarEntity[];
  links: TaskbarTypedLink[];
  timestamp: string;
}

/** Delta operation types */
export type DeltaOperation =
  | { type: 'add'; entity: TaskbarEntity }
  | { type: 'update'; entityId: string; changes: Partial<TaskbarEntity> }
  | { type: 'remove'; entityId: string }
  | { type: 'add_link'; link: TaskbarTypedLink }
  | { type: 'remove_link'; linkId: string };

/** An ordered delta applied on top of a snapshot */
export interface ProjectionDelta {
  baseVersion: number;
  newVersion: number;
  workspaceId: string;
  operations: DeltaOperation[];
  timestamp: string;
}

/** View modes supported by the Visual_Taskbar */
export type ViewMode = 'compact' | 'list' | 'kanban' | 'dependency-graph';

/** Risk level for taskbar entities */
export type TaskbarRiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';

/** Filter criteria for narrowing visible entities */
export interface TaskbarFilter {
  status?: TaskbarEntityStatus[];
  priority?: TaskbarPriority[];
  kind?: TaskbarEntityKind[];
  requirementId?: string;
  component?: string;
  workspaceId?: string;
  file?: string;
  agent?: string;
  run?: string;
  risk?: TaskbarRiskLevel[];
  milestone?: string;
}

/** Selection state persisted per workspace/session */
export interface TaskbarSelection {
  selectedEntityId: string | null;
  expandedEntityIds: string[];
}

/** Combined session state for the Visual_Taskbar */
export interface TaskbarSessionState {
  workspaceId: string;
  sessionId: string;
  viewMode: ViewMode;
  filter: TaskbarFilter;
  selection: TaskbarSelection;
}

/** Compact bar view model */
export interface CompactBarViewModel {
  counts: EntityCounts;
  statusSummary: Record<TaskbarEntityStatus, number>;
  hasWarnings: boolean;
}

/** List view item */
export interface ListViewItem {
  entity: TaskbarEntity;
  depth: number;
  linkCount: number;
}

/** Kanban column */
export interface KanbanColumn {
  status: TaskbarEntityStatus;
  label: string;
  entities: TaskbarEntity[];
}

/** Dependency graph node */
export interface DependencyGraphNode {
  entity: TaskbarEntity;
  incomingEdges: TaskbarTypedLink[];
  outgoingEdges: TaskbarTypedLink[];
}

// ═══════════════════════════════════════════════════════════════
// Entity Detail Types (Requirements: 10.3, 10.4, 10.5)
// ═══════════════════════════════════════════════════════════════

/** A linked reference to another entity or resource */
export interface LinkedReference {
  id: string;
  kind: string;
  title: string;
  status?: string;
}

/** Detail view model for a selected entity */
export interface DetailViewModel {
  entity: TaskbarEntity;
  linkedDesign: LinkedReference[];
  linkedTasks: LinkedReference[];
  linkedRuns: LinkedReference[];
  linkedChangeSets: LinkedReference[];
  linkedEvidence: LinkedReference[];
  rationale: string | null;
  files: string[];
  dependencies: LinkedReference[];
  scope: { inclusions: string[]; exclusions: string[] };
  agent: LinkedReference | null;
  permissions: string[];
  status: TaskbarEntityStatus;
}

// ═══════════════════════════════════════════════════════════════
// Integrity Warning Types (Requirement: 10.8)
// ═══════════════════════════════════════════════════════════════

/** Severity levels for integrity warnings */
export type WarningSeverity = 'error' | 'warning' | 'info';

/** Types of integrity warnings */
export type IntegrityWarningKind =
  | 'orphan_requirement'
  | 'unimplemented_design_node'
  | 'incomplete_task'
  | 'unresolved_dependency'
  | 'completed_task_lacking_evidence';

/** An integrity warning for a planning entity */
export interface IntegrityWarning {
  kind: IntegrityWarningKind;
  severity: WarningSeverity;
  entityId: string;
  entityKind: TaskbarEntityKind;
  message: string;
}

// ═══════════════════════════════════════════════════════════════
// Live Update Types (Requirement: 10.10)
// ═══════════════════════════════════════════════════════════════

/** Domain event from the main process */
export interface DomainEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: ProjectionDelta | ProjectionSnapshot;
}

/** Latency record for SLA tracking */
export interface UpdateLatencyRecord {
  eventId: string;
  receivedAt: number;
  appliedAt: number;
  latencyMs: number;
}
