/**
 * Visual_Taskbar — Shared model, view adapters, and services.
 *
 * Exports the PlanningProjectionStore (single source of truth),
 * view adapters (compact, list, Kanban, dependency-graph),
 * SelectionAndFilterStore for workspace/session persistence,
 * EntityDetailService for entity detail resolution,
 * IntegrityWarningService for planning integrity checks,
 * and LiveUpdateCoordinator for event-driven projection updates.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.10, 10.11, 10.12
 */

export { PlanningProjectionStore } from './planning-projection-store.js';
export type { ProjectionChangeListener } from './planning-projection-store.js';

export {
  CompactBarViewAdapter,
  ListViewAdapter,
  KanbanViewAdapter,
  DependencyGraphViewAdapter,
  applyFilter,
} from './view-adapters.js';

export { SelectionAndFilterStore } from './selection-filter-store.js';
export type { SessionStateListener } from './selection-filter-store.js';

export { EntityDetailService } from './entity-detail-service.js';
export { IntegrityWarningService } from './integrity-warning-service.js';
export { LiveUpdateCoordinator } from './live-update-coordinator.js';
export type { BatchAppliedListener, LiveUpdateCoordinatorConfig } from './live-update-coordinator.js';

export type {
  TaskbarEntity,
  TaskbarTypedLink,
  TaskbarEntityKind,
  TaskbarEntityStatus,
  TaskbarPriority,
  TaskbarRiskLevel,
  TaskbarFilter,
  TaskbarSelection,
  TaskbarSessionState,
  ProjectionSnapshot,
  ProjectionDelta,
  DeltaOperation,
  EntityCounts,
  ViewMode,
  CompactBarViewModel,
  ListViewItem,
  KanbanColumn,
  DependencyGraphNode,
  DetailViewModel,
  LinkedReference,
  IntegrityWarning,
  IntegrityWarningKind,
  WarningSeverity,
  DomainEvent,
  UpdateLatencyRecord,
} from './types.js';
