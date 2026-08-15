/**
 * CI/CD module — AI-powered code review checks and workflow management.
 *
 * Exports:
 * - CICheckService: AI-powered code review checks on file changes
 * - CIWorkflowService: CI/CD provider detection, workflow generation, and remote run correlation
 * - Types: Full type definitions for both services
 */

export { CICheckService } from './ci-check-service';
export type { CICheck, CICheckRun } from './ci-check-service';

export { CIWorkflowService } from './ci-workflow-service';
export type {
  WorkspaceFileReader,
  QualityProfileAdapter,
  QualityProfileCommands,
  EvidenceLinkAdapter,
  WorkflowSyntaxValidator,
} from './ci-workflow-service';

export type {
  CIProvider,
  ProviderDetectionResult,
  WorkflowConventions,
  CacheStrategy,
  MatrixStrategy,
  BranchProtection,
  PinningPolicy,
  TokenPermission,
  WorkflowStage,
  WorkflowStageCategory,
  FailureBehavior,
  QualityProfileAlignment,
  PinnedReference,
  SecretReference,
  WorkflowPermissions,
  DeploymentEnvironment,
  EnvironmentProtection,
  ConcurrencyPolicy,
  CancellationPolicy,
  RollbackPolicy,
  ArtifactProvenance,
  RemoteCIRun,
  RemoteRunStatus,
  RemoteCheckResult,
  WorkflowValidationResult,
  WorkflowValidationError,
  GeneratedWorkflow,
} from './types';
