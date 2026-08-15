/**
 * Deployment, Migration, Artifact, and Rollback Readiness types.
 *
 * Declares artifacts, environments, prerequisites, configuration schema, health checks,
 * release commands, breaking change detection, migration strategies, immutable artifact
 * identity, deployment plans, production authorization, and post-deployment evidence.
 *
 * Requirements: 39.1, 39.2, 39.3, 39.4, 39.5, 39.6, 39.7, 39.8, 39.9
 */

// ─── Artifact Declaration ──────────────────────────────────────────────────

/**
 * Immutable identity for a build artifact linked to revision, logs, and metadata.
 */
export interface ArtifactIdentity {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly checksumAlgorithm: 'sha256' | 'sha512';
  readonly sourceRevision: string;
  readonly buildLogRef: string;
  readonly dependencyMetadataRef: string;
  readonly qualityProfileEvidenceIds: readonly string[];
  readonly createdAt: string;
  readonly size: number;
  readonly format: string;
}

/**
 * A declared build artifact within the deployment manifest.
 */
export interface ArtifactDeclaration {
  readonly name: string;
  readonly buildCommand: string;
  readonly outputPath: string;
  readonly format: string;
  readonly required: boolean;
}

// ─── Environment Declaration ───────────────────────────────────────────────

/**
 * Target deployment environment definition.
 */
export interface EnvironmentDeclaration {
  readonly name: string;
  readonly kind: 'preview' | 'staging' | 'production' | 'custom';
  readonly url?: string;
  readonly region?: string;
  readonly requiresAuthorization: boolean;
  readonly protectionRules: EnvironmentProtectionRules;
}

/**
 * Protection rules governing a deployment environment.
 */
export interface EnvironmentProtectionRules {
  readonly requiredApprovers: number;
  readonly waitTimerMinutes: number;
  readonly branchRestrictions: readonly string[];
  readonly allowedActors: readonly string[];
}

// ─── Prerequisites and Configuration ───────────────────────────────────────

/**
 * Runtime and infrastructure prerequisites for deployment.
 */
export interface DeploymentPrerequisite {
  readonly name: string;
  readonly kind: 'runtime' | 'infrastructure' | 'service' | 'secret' | 'permission';
  readonly version?: string;
  readonly description: string;
  readonly required: boolean;
  readonly verificationCommand?: string;
}

/**
 * Configuration schema for deployable artifacts.
 */
export interface ConfigurationSchema {
  readonly entries: readonly ConfigurationEntry[];
  readonly version: string;
  readonly fingerprint: string;
}

/**
 * A single configuration entry.
 */
export interface ConfigurationEntry {
  readonly key: string;
  readonly type: 'string' | 'number' | 'boolean' | 'secret' | 'url' | 'enum';
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly description: string;
  readonly sensitive: boolean;
  readonly allowedValues?: readonly string[];
}

// ─── Health Checks ─────────────────────────────────────────────────────────

/**
 * Health check definition for post-deployment verification.
 */
export interface HealthCheck {
  readonly id: string;
  readonly name: string;
  readonly kind: 'http' | 'tcp' | 'command' | 'custom';
  readonly target: string;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly successThreshold: number;
  readonly failureThreshold: number;
  readonly expectedStatus?: number;
  readonly expectedBody?: string;
}

// ─── Release Commands ──────────────────────────────────────────────────────

/**
 * Named release command for deployment lifecycle phases.
 */
export interface ReleaseCommand {
  readonly name: string;
  readonly phase: ReleasePhase;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  readonly rollbackOnFailure: boolean;
  readonly description: string;
}

export type ReleasePhase =
  | 'pre_deploy'
  | 'deploy'
  | 'post_deploy'
  | 'rollback'
  | 'health_verify'
  | 'smoke_test';

// ─── Breaking Change Detection ─────────────────────────────────────────────

/**
 * Categories of breaking changes to detect.
 */
export type BreakingChangeCategory =
  | 'api'
  | 'schema'
  | 'migration'
  | 'configuration'
  | 'permission'
  | 'infrastructure';

/**
 * A detected breaking change requiring compatibility and rollout notes.
 */
export interface BreakingChange {
  readonly id: string;
  readonly category: BreakingChangeCategory;
  readonly description: string;
  readonly affectedComponents: readonly string[];
  readonly severity: 'critical' | 'major' | 'minor';
  readonly compatibilityNotes: string | null;
  readonly rolloutNotes: string | null;
  readonly detectedAt: string;
  readonly sourceFiles: readonly string[];
}

// ─── Migration Strategy ────────────────────────────────────────────────────

/**
 * Database or state migration definition with forward/rollback strategy.
 */
export interface MigrationDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly forwardBehavior: string;
  readonly backwardCompatibility: BackwardCompatibility;
  readonly backupAssumptions: string;
  readonly rollbackStrategy: RollbackStrategy;
  readonly sourceFile: string;
  readonly order: number;
  readonly required: boolean;
}

/**
 * Backward compatibility status for a migration.
 */
export interface BackwardCompatibility {
  readonly compatible: boolean;
  readonly reason: string;
  readonly affectedVersions: readonly string[];
}

/**
 * Rollback or roll-forward strategy.
 */
export interface RollbackStrategy {
  readonly kind: 'rollback' | 'roll_forward' | 'manual';
  readonly description: string;
  readonly command?: string;
  readonly estimatedDuration?: string;
  readonly dataLossRisk: 'none' | 'minimal' | 'significant';
  readonly requiresDowntime: boolean;
}

// ─── Deployment Plan ───────────────────────────────────────────────────────

/**
 * Complete deployment plan with checks, rollout, monitoring, and abort criteria.
 */
export interface DeploymentPlan {
  readonly id: string;
  readonly releaseCandidateId: string;
  readonly environment: string;
  readonly preDeploymentChecks: readonly DeploymentCheck[];
  readonly rolloutStrategy: RolloutStrategy;
  readonly healthVerification: HealthVerification;
  readonly monitoringWindow: MonitoringWindow;
  readonly abortCriteria: readonly AbortCriterion[];
  readonly rollbackProcedure: RollbackProcedure;
  readonly previewValidation: PreviewValidation | null;
  readonly createdAt: string;
  readonly fingerprint: string;
}

/**
 * A pre-deployment check with pass/fail status.
 */
export interface DeploymentCheck {
  readonly name: string;
  readonly kind: 'artifact' | 'migration' | 'configuration' | 'dependency' | 'health' | 'custom';
  readonly required: boolean;
  readonly description: string;
  readonly passed: boolean | null;
  readonly evidenceId: string | null;
}

/**
 * Rollout strategy for progressive deployment.
 */
export interface RolloutStrategy {
  readonly kind: 'all_at_once' | 'canary' | 'blue_green' | 'rolling' | 'feature_flag';
  readonly stages?: readonly RolloutStage[];
  readonly description: string;
}

export interface RolloutStage {
  readonly name: string;
  readonly percentage: number;
  readonly durationMinutes: number;
  readonly healthCheckRequired: boolean;
}

/**
 * Post-deployment health verification.
 */
export interface HealthVerification {
  readonly checks: readonly HealthCheck[];
  readonly initialDelaySeconds: number;
  readonly verificationDurationSeconds: number;
  readonly successThreshold: number;
}

/**
 * Monitoring window after deployment.
 */
export interface MonitoringWindow {
  readonly durationMinutes: number;
  readonly metrics: readonly MonitoringMetric[];
  readonly alertThresholds: readonly AlertThreshold[];
}

export interface MonitoringMetric {
  readonly name: string;
  readonly query: string;
  readonly baseline?: number;
}

export interface AlertThreshold {
  readonly metric: string;
  readonly operator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq';
  readonly value: number;
  readonly severity: 'warning' | 'critical';
  readonly action: 'alert' | 'abort';
}

/**
 * Conditions for aborting a deployment.
 */
export interface AbortCriterion {
  readonly name: string;
  readonly condition: string;
  readonly action: 'rollback' | 'pause' | 'alert';
  readonly description: string;
}

/**
 * Rollback procedure for a deployment.
 */
export interface RollbackProcedure {
  readonly strategy: 'automatic' | 'manual' | 'semi_automatic';
  readonly steps: readonly RollbackStep[];
  readonly estimatedDurationMinutes: number;
  readonly requiresApproval: boolean;
  readonly previousArtifactId: string | null;
}

export interface RollbackStep {
  readonly order: number;
  readonly description: string;
  readonly command?: string;
  readonly timeoutSeconds: number;
  readonly rollbackOnFailure: boolean;
}

/**
 * Preview/staging/dry-run validation configuration.
 */
export interface PreviewValidation {
  readonly kind: 'preview' | 'staging' | 'dry_run';
  readonly environment: string;
  readonly commands: readonly ReleaseCommand[];
  readonly healthChecks: readonly HealthCheck[];
  readonly evidenceId: string | null;
  readonly passed: boolean | null;
}

// ─── Production Authorization ──────────────────────────────────────────────

/**
 * Explicit production authorization with environment, revision, artifact, impact, and rollback.
 */
export interface ProductionAuthorization {
  readonly id: string;
  readonly environment: string;
  readonly revision: string;
  readonly artifactId: string;
  readonly expectedImpact: string;
  readonly rollbackAction: string;
  readonly authorizedBy: string;
  readonly authorizedAt: string;
  readonly expiresAt: string | null;
  readonly scope: string;
  readonly releaseCandidateId: string;
}

// ─── Post-Deployment Evidence ──────────────────────────────────────────────

/**
 * Post-deployment evidence capturing health, smoke-test, error-rate, and rollback decision.
 */
export interface PostDeploymentEvidence {
  readonly id: string;
  readonly deploymentPlanId: string;
  readonly authorizationId: string;
  readonly releaseCandidateId: string;
  readonly environment: string;
  readonly healthResults: readonly HealthCheckResult[];
  readonly smokeTestResults: readonly SmokeTestResult[];
  readonly errorRateSnapshot: ErrorRateSnapshot | null;
  readonly rollbackDecision: RollbackDecision | null;
  readonly capturedAt: string;
  readonly protectedData: boolean;
  readonly fingerprint: string;
}

export interface HealthCheckResult {
  readonly checkId: string;
  readonly passed: boolean;
  readonly responseTime: number;
  readonly statusCode?: number;
  readonly details: string;
  readonly checkedAt: string;
}

export interface SmokeTestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly output: string;
  readonly command: string;
}

export interface ErrorRateSnapshot {
  readonly windowMinutes: number;
  readonly errorCount: number;
  readonly requestCount: number;
  readonly errorRate: number;
  readonly baselineErrorRate: number;
  readonly withinThreshold: boolean;
}

export interface RollbackDecision {
  readonly triggered: boolean;
  readonly reason: string | null;
  readonly actor: string;
  readonly decidedAt: string;
  readonly action: 'rollback' | 'proceed' | 'investigate';
}

// ─── Deployment Readiness Status ───────────────────────────────────────────

/**
 * Outcome of a deployment readiness gate evaluation.
 */
export type DeploymentGateOutcome =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'stale'
  | 'waived'
  | 'not_applicable'
  | 'missing';

/**
 * A single deployment readiness gate in the Production_Readiness_Report.
 */
export interface DeploymentReadinessGate {
  readonly name: string;
  readonly category: DeploymentGateCategory;
  readonly outcome: DeploymentGateOutcome;
  readonly required: boolean;
  readonly evidenceId: string | null;
  readonly description: string;
  readonly blockerReason: string | null;
}

export type DeploymentGateCategory =
  | 'artifact'
  | 'migration'
  | 'environment'
  | 'rollback'
  | 'authorization'
  | 'health'
  | 'preview'
  | 'breaking_change'
  | 'configuration';

/**
 * Complete deployment readiness status for a Release_Candidate.
 */
export interface DeploymentReadinessStatus {
  readonly releaseCandidateId: string;
  readonly ready: boolean;
  readonly gates: readonly DeploymentReadinessGate[];
  readonly missingMandatoryData: readonly string[];
  readonly breakingChanges: readonly BreakingChange[];
  readonly migrations: readonly MigrationDefinition[];
  readonly artifacts: readonly ArtifactIdentity[];
  readonly authorization: ProductionAuthorization | null;
  readonly postDeploymentEvidence: PostDeploymentEvidence | null;
  readonly evaluatedAt: string;
  readonly fingerprint: string;
}

// ─── Deployment Manifest ───────────────────────────────────────────────────

/**
 * Complete deployment manifest for a project declaring all deployment-related metadata.
 */
export interface DeploymentManifest {
  readonly workspaceId: string;
  readonly version: string;
  readonly artifacts: readonly ArtifactDeclaration[];
  readonly environments: readonly EnvironmentDeclaration[];
  readonly prerequisites: readonly DeploymentPrerequisite[];
  readonly configurationSchema: ConfigurationSchema;
  readonly healthChecks: readonly HealthCheck[];
  readonly releaseCommands: readonly ReleaseCommand[];
  readonly createdAt: string;
  readonly fingerprint: string;
}
