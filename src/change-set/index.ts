/**
 * Change_Set module — immutable multi-file change proposals and shadow preview models.
 */

export type {
  ChangeSet,
  ChangeSetState,
  CreateChangeSetParams,
  AddOperationParams,
  FileOperation,
  CreateOperation,
  ModifyOperation,
  RenameOperation,
  MoveOperation,
  DeleteOperation,
  RiskLevel,
  ValidationStatus,
  FileOperationSummary,
  ChangeSetProvenance,
} from './types';

export { VALID_STATE_TRANSITIONS, TERMINAL_STATES } from './types';

export {
  ChangeSetService,
  InvalidStateTransitionError,
  ImmutableOperationError,
  BaseHashValidationError,
} from './change-set-service';
export type { HashResolver } from './change-set-service';

export {
  ShadowModelService,
  buildShadowModelUri,
  parseShadowModelUri,
  isShadowModelUri,
  SHADOW_MODEL_SCHEME,
} from './shadow-model-service';
export type { ShadowModel, CreateShadowModelParams } from './shadow-model-service';

export { StreamingChunkCollector } from './streaming-chunk-collector';
export type {
  SemanticChunk,
  PositionContext,
  StreamState,
  CollectionResult,
} from './streaming-chunk-collector';

export { CanonicalDiffComputer } from './canonical-diff-computer';
export type {
  DiffHunk,
  FileDiff,
  DiffInput,
  CanonicalDiffResult,
} from './canonical-diff-computer';

export { DiffReconciler } from './diff-reconciler';
export type {
  Discrepancy,
  ReconciliationResult,
} from './diff-reconciler';

export { DiffWorkerCoordinator, DEFAULT_THRESHOLDS, createCancellationToken } from './diff-worker-coordinator';
export type {
  DiffWorkerThresholds,
  DiffLatencyDiagnostic,
  DiffWorker,
  CancellationToken,
  ProgressiveDiffSlice,
  ProgressiveSliceCallback,
} from './diff-worker-coordinator';

export { FileFidelityValidator } from './file-fidelity-validator';
export type {
  LineEnding,
  IndentationStyle,
  EncodingType,
  FileFidelityInfo,
  FileMetadata,
  FidelityViolation,
  FidelityViolationSeverity,
  FidelityValidationResult,
  FidelityValidationOptions,
} from './file-fidelity-validator';

export { ChangeSetCoordinator } from './change-set-coordinator';
export type {
  ProposeOperationParams,
  CreateProposalParams,
  ConsolidationResult,
} from './change-set-coordinator';

export { SemanticStreamingService, DEFAULT_STREAMING_PROFILE } from './semantic-streaming-service';
export type {
  IncompleteAction,
  ProvisionalDiffRegion,
  ProvisionalDiffSnapshot,
  StreamingPerformanceProfile,
  IncompleteActionResult,
  StreamingSession,
} from './semantic-streaming-service';

export { ChangeTransactionService } from './change-transaction-service';
export type {
  PreconditionFailureKind,
  PreconditionFailure,
  ConflictResolutionAction,
  TransactionConflict,
  JournalState,
  InverseOperation,
  TransactionJournal,
  ValidationResult,
  TransactionResult,
  WorkspaceAdapter,
  PathPolicyAdapter,
  ApprovalPolicyAdapter,
  ModelAdapter,
  AppliedOperation,
  FaultInjectionPoint,
  FaultInjectionConfig,
} from './change-transaction-service';

export { CheckpointProvenanceService } from './checkpoint-provenance-service';
export type {
  CheckpointProvenance,
  ApprovalRecord,
  ValidationState,
  TransactionCheckpoint,
  RetentionPolicy,
  GroupedUndoEntry,
  RestoreScope,
  RestorePreview,
  RestoreFilePreview,
  RestoreConflict,
  ProhibitedGitOperation,
  GitConsentDecision,
  CheckpointEquivalenceAdapter,
  PlatformUndoAdapter,
} from './checkpoint-provenance-service';

export { MergeRestorationService } from './merge-restoration-service';
export type {
  EditSource,
  TimelineEntryKind,
  ChangeTimelineEntry,
  MergeWorkflowState,
  MergeRestorationOutcome,
  MergeWorkflow,
  MergeFileEntry,
  MergeWorkspaceAdapter,
  CheckpointContentAdapter,
} from './merge-restoration-service';

export { WriteRoutingEnforcer } from './write-routing-enforcer';
export type {
  WriteOrigin,
  WriteRoutingDecision,
  WriteRequest,
  WriteRoutingResult,
  WriteRoutingAuditEntry,
  DirectWriteGateConfig,
} from './write-routing-enforcer';

export { TransactionCutoverCheckpointService } from './transaction-cutover-checkpoint';
export type {
  CutoverEvidenceKind,
  CutoverEvidenceState,
  CutoverEvidence,
  CrashRecoveryTestResult,
  CutoverCheckpointState,
  CutoverCheckpoint,
} from './transaction-cutover-checkpoint';

export { CutoverIntegrationService, ALL_JOURNAL_BOUNDARIES } from './cutover-integration-service';
export type {
  JournalBoundary,
  CrashRecoveryFaultTestResult,
  ParityEvidence,
  CrashRecoveryWorkspaceAdapter,
} from './cutover-integration-service';
