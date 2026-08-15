/**
 * CI/CD Workflow Integration types — provider detection, workflow generation,
 * deployment environments, and remote run correlation.
 *
 * Requirements: 35.1, 35.2, 35.3, 35.4, 35.5, 35.6, 35.7, 35.8, 35.9
 */

// ─── Provider Detection ────────────────────────────────────────────────────

/**
 * Supported CI/CD providers that can be detected from workspace files.
 */
export type CIProvider =
  | 'github_actions'
  | 'gitlab_ci'
  | 'circleci'
  | 'jenkins'
  | 'azure_pipelines'
  | 'bitbucket_pipelines'
  | 'unknown';

/**
 * Result of detecting CI/CD provider and existing conventions in a workspace.
 */
export interface ProviderDetectionResult {
  readonly provider: CIProvider;
  readonly workflowFiles: readonly string[];
  readonly conventions: WorkflowConventions;
  readonly detectedAt: string;
  readonly workspaceId: string;
}

/**
 * Existing conventions detected from the project's CI/CD configuration.
 */
export interface WorkflowConventions {
  readonly nodeVersion?: string;
  readonly packageManager: 'npm' | 'yarn' | 'pnpm' | 'unknown';
  readonly cacheStrategy?: CacheStrategy;
  readonly matrixStrategy?: MatrixStrategy;
  readonly branchProtection?: BranchProtection;
  readonly existingJobs: readonly string[];
  readonly secretReferences: readonly string[];
  readonly pinningPolicy: PinningPolicy;
  readonly tokenPermissions: readonly TokenPermission[];
}

/**
 * Cache configuration detected in existing workflows.
 */
export interface CacheStrategy {
  readonly paths: readonly string[];
  readonly keyPattern: string;
  readonly restoreKeys?: readonly string[];
}

/**
 * Matrix configuration detected in existing workflows.
 */
export interface MatrixStrategy {
  readonly axes: readonly MatrixAxis[];
  readonly failFast: boolean;
}

export interface MatrixAxis {
  readonly name: string;
  readonly values: readonly string[];
}

/**
 * Branch protection detected from workflow comments or conventions.
 */
export interface BranchProtection {
  readonly requiredChecks: readonly string[];
  readonly requireUpToDate: boolean;
  readonly protectedBranches: readonly string[];
}

/**
 * Policy for how third-party actions/images/plugins are pinned.
 */
export interface PinningPolicy {
  readonly actionsUseSHA: boolean;
  readonly imagesUseDigest: boolean;
  readonly pluginsUseExact: boolean;
}

/**
 * Token permission found in existing workflows.
 */
export interface TokenPermission {
  readonly scope: string;
  readonly level: 'read' | 'write' | 'none';
}

// ─── Workflow Stage Definitions ────────────────────────────────────────────

/**
 * A workflow stage with its dependencies and failure behavior.
 */
export interface WorkflowStage {
  readonly id: string;
  readonly name: string;
  readonly category: WorkflowStageCategory;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly dependsOn: readonly string[];
  readonly failureBehavior: FailureBehavior;
  readonly condition?: string;
  readonly timeoutMinutes: number;
  readonly qualityProfileAlignment: QualityProfileAlignment;
}

/**
 * Categories of workflow stages.
 */
export type WorkflowStageCategory =
  | 'install'
  | 'cache'
  | 'lint'
  | 'type_check'
  | 'test'
  | 'build'
  | 'security'
  | 'artifacts'
  | 'preview'
  | 'deployment';

/**
 * How the pipeline reacts when a stage fails.
 */
export interface FailureBehavior {
  readonly action: 'stop' | 'continue' | 'retry';
  readonly maxRetries?: number;
  readonly retryDelaySeconds?: number;
  readonly allowFailure?: boolean;
}

/**
 * Alignment between CI command and local Quality_Profile.
 */
export interface QualityProfileAlignment {
  readonly aligned: boolean;
  readonly localCommand?: string;
  readonly ciCommand: string;
  readonly differences?: readonly string[];
  readonly documentedReason?: string;
}

// ─── Third-Party Action Pinning ────────────────────────────────────────────

/**
 * A third-party action/image/plugin reference with pinning information.
 */
export interface PinnedReference {
  readonly kind: 'action' | 'image' | 'plugin';
  readonly name: string;
  readonly version: string;
  readonly pin: string;
  readonly pinKind: 'sha' | 'digest' | 'exact_version' | 'unpinned';
  readonly source?: string;
}

// ─── Secrets and Permissions ───────────────────────────────────────────────

/**
 * A secret reference used in a workflow. Values are never stored.
 */
export interface SecretReference {
  readonly name: string;
  readonly provider: 'github' | 'gitlab' | 'vault' | 'environment' | 'unknown';
  readonly usage: string;
  readonly required: boolean;
}

/**
 * Minimal token permissions for a workflow job.
 */
export interface WorkflowPermissions {
  readonly contents: 'read' | 'write' | 'none';
  readonly pullRequests: 'read' | 'write' | 'none';
  readonly actions: 'read' | 'write' | 'none';
  readonly packages: 'read' | 'write' | 'none';
  readonly issues: 'read' | 'write' | 'none';
  readonly checks: 'read' | 'write' | 'none';
  readonly statuses: 'read' | 'write' | 'none';
  readonly deployments: 'read' | 'write' | 'none';
}

// ─── Deployment Environment ────────────────────────────────────────────────

/**
 * Deployment environment definition with protection rules.
 */
export interface DeploymentEnvironment {
  readonly name: string;
  readonly protection: EnvironmentProtection;
  readonly concurrency: ConcurrencyPolicy;
  readonly cancellation: CancellationPolicy;
  readonly rollback: RollbackPolicy;
  readonly artifactProvenance: ArtifactProvenance;
}

/**
 * Protection rules for a deployment environment.
 */
export interface EnvironmentProtection {
  readonly requiredReviewers: number;
  readonly waitTimer?: number;
  readonly branchPolicy: readonly string[];
  readonly deploymentBranchPolicy: 'protected' | 'custom' | 'any';
}

/**
 * Concurrency policy for deployment jobs.
 */
export interface ConcurrencyPolicy {
  readonly group: string;
  readonly cancelInProgress: boolean;
  readonly maxParallel?: number;
}

/**
 * Cancellation policy for deployment jobs.
 */
export interface CancellationPolicy {
  readonly onNewPush: boolean;
  readonly onManualTrigger: boolean;
  readonly gracePeriodSeconds: number;
}

/**
 * Rollback policy for a deployment.
 */
export interface RollbackPolicy {
  readonly automatic: boolean;
  readonly healthCheckUrl?: string;
  readonly healthCheckIntervalSeconds?: number;
  readonly healthCheckTimeoutSeconds?: number;
  readonly previousArtifactRetention: number;
}

/**
 * Artifact provenance (SLSA) configuration.
 */
export interface ArtifactProvenance {
  readonly enabled: boolean;
  readonly level: 'slsa1' | 'slsa2' | 'slsa3';
  readonly attestation: boolean;
  readonly signingEnabled: boolean;
  readonly checksumAlgorithm: 'sha256' | 'sha512';
}

// ─── Remote Run Correlation ────────────────────────────────────────────────

/**
 * A remote CI run linked to a Release_Candidate and Task.
 */
export interface RemoteCIRun {
  readonly id: string;
  readonly provider: CIProvider;
  readonly externalRunId: string;
  readonly externalUrl: string;
  readonly commit: string;
  readonly branch: string;
  readonly taskId?: string;
  readonly releaseCandidateId?: string;
  readonly status: RemoteRunStatus;
  readonly checks: readonly RemoteCheckResult[];
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export type RemoteRunStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

/**
 * Individual check result from a remote CI run.
 */
export interface RemoteCheckResult {
  readonly name: string;
  readonly status: RemoteRunStatus;
  readonly conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'skipped';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly output?: string;
  readonly detailsUrl?: string;
}

// ─── Syntax Validation ─────────────────────────────────────────────────────

/**
 * Result of validating workflow syntax.
 */
export interface WorkflowValidationResult {
  readonly valid: boolean;
  readonly errors: readonly WorkflowValidationError[];
  readonly warnings: readonly string[];
  readonly validatedAt: string;
  readonly method: 'local' | 'api';
}

export interface WorkflowValidationError {
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

// ─── Generated Workflow ────────────────────────────────────────────────────

/**
 * A complete generated workflow ready for extension into existing CI/CD.
 */
export interface GeneratedWorkflow {
  readonly id: string;
  readonly provider: CIProvider;
  readonly fileName: string;
  readonly content: string;
  readonly stages: readonly WorkflowStage[];
  readonly permissions: WorkflowPermissions;
  readonly secrets: readonly SecretReference[];
  readonly pinnedReferences: readonly PinnedReference[];
  readonly deploymentEnvironments: readonly DeploymentEnvironment[];
  readonly validation: WorkflowValidationResult;
  readonly qualityProfileFingerprint: string;
  readonly generatedAt: string;
}
