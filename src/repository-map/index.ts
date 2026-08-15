/**
 * Repository Map — Module entry point
 *
 * Exports RepositoryMapService, ImpactAnalyzer, DispatchReadinessEvaluator,
 * ContextInclusionManager, IndexingBoundary, Wave2AuthorityCheckpoint,
 * and all related types.
 *
 * Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6, 29.7, 29.8, 29.9
 */

export { RepositoryMapService, computeContentHash, computeWorkspaceRevision } from './repository-map-service.js';
export { ImpactAnalyzer } from './impact-analyzer.js';
export { DispatchReadinessEvaluator } from './dispatch-readiness-evaluator.js';
export { ContextInclusionManager } from './context-inclusion-manager.js';
export { IndexingBoundary, DEFAULT_INDEXING_BOUNDARY } from './indexing-boundary.js';
export { Wave2AuthorityCheckpoint } from './wave2-authority-checkpoint.js';
export type { ImpactAnalysisOptions, ContextItem, DiagnosticEntry, ImpactAnalyzerConfig } from './impact-analyzer.js';
export type {
  StaleMapPolicy,
  QualityProfileConfig,
  DispatchReadiness,
  DispatchReadinessResult,
  ImpactSummary,
  DispatchDiagnostic,
} from './dispatch-readiness-evaluator.js';
export type {
  AutomaticInclusion,
  InclusionInspection,
} from './context-inclusion-manager.js';
export type {
  IndexingBoundaryConfig,
  BoundaryCheckResult,
} from './indexing-boundary.js';
export type {
  CheckpointCheckStatus,
  CheckpointCheck,
  Wave2CheckpointResult,
  MarkdownAuthorityState,
  SqliteAuthorityState,
  TaskbarParityState,
  CycleDetectionState,
} from './wave2-authority-checkpoint.js';
export type {
  RepositoryMap,
  RepositoryMapVersion,
  FileNode,
  SymbolNode,
  SymbolKind,
  Range,
  ImportEdge,
  DependencyEdge,
  BuildConfig,
  TestConfig,
  SchemaNode,
  MigrationNode,
  ApiContractNode,
  GitState,
  OwnershipEntry,
  FileEvent,
  FileEventKind,
  QueryMethod,
  QueryMetadata,
  QueryResult,
  ImpactEntry,
  ImpactAnalysisResult,
  FreshnessStatus,
  FreshnessInfo,
} from './types.js';
