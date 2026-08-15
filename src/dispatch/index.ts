/**
 * Dispatch module — Run creation, state management, task dispatch, and agent routing.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.8
 */

export {
  RunCoordinator,
  IllegalTransitionError,
  RunNotFoundError,
  DuplicateRunError,
  VALID_RUN_TRANSITIONS,
  TERMINAL_RUN_STATES,
  type RunState,
  type AgentRun,
  type CreateRunParams,
} from './run-coordinator.js';

export {
  DispatchService,
  type DispatchPlan,
  type DispatchBudget,
  type DispatchDecision,
  type DispatchResult,
  type BulkDispatchResult,
  type DispatchableTask,
  type TaskStatusUpdater,
} from './dispatch-service.js';

export {
  AgentRouter,
  type CapabilityCategory,
  type RoutingMode,
  type RoutingDeficiency,
  type AgentEvaluation,
  type RoutingScores,
  type RoutingFingerprints,
  type RouteDecision,
  type TaskRoutingRequirements,
  type AgentDescriptor,
  type RoutingRequest,
} from './agent-router.js';

export {
  WorkspaceIsolationService,
  type DependencyStatus,
  type TaskDependency,
  type FileScope,
  type ScopeOverlap,
  type IsolationLevel,
  type WorkspaceLease,
  type GuardedFallbackEvidence,
  type UnavailabilityReason,
  type WorkspaceIsolationPolicy,
  type SchedulingResult,
  type IsolationResult,
  type ResolvedRunWorkspace,
  type RiskNotification,
} from './workspace-isolation.js';

export {
  OrchestrationTopologyService,
  TopologyPrimitiveUnavailableError,
  TopologyValidationError,
  ArtifactContractError,
  type OrchestrationTopology,
  type TopologyType,
  type PipelineTopology,
  type PipelineStage,
  type FanOutFanInTopology,
  type FanOutBranch,
  type MergeConfig,
  type ExpertPoolTopology,
  type ExpertAgent,
  type ProducerReviewerTopology,
  type SupervisorTopology,
  type HierarchicalDelegationTopology,
  type DelegationNode,
  type ExecutionModeType,
  type ExecutionMode,
  type AgentRole,
  type MergeSemantics,
  type RoleDependency,
  type ArtifactContract,
  type ArtifactCheck,
  type ArtifactDestination,
  type ArtifactFailureHandling,
  type ExecutableOrchestrationPlan,
  type AvailablePrimitives,
} from './orchestration-topology.js';
