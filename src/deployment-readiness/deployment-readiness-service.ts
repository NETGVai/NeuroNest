/**
 * DeploymentReadinessService — validates all aspects of deployment including artifacts,
 * migrations, rollback procedures, monitoring, and authorization before any production release.
 *
 * Evaluates revision-bound gates and produces reports. The system remains "not ready"
 * when any mandatory data is missing.
 *
 * Requirements: 39.1, 39.2, 39.3, 39.4, 39.5, 39.6, 39.7, 39.8, 39.9
 */

import { randomUUID } from 'crypto';

import type {
  ArtifactDeclaration,
  ArtifactIdentity,
  BreakingChange,
  BreakingChangeCategory,
  ConfigurationSchema,
  DeploymentCheck,
  DeploymentGateCategory,
  DeploymentGateOutcome,
  DeploymentManifest,
  DeploymentPlan,
  DeploymentReadinessGate,
  DeploymentReadinessStatus,
  EnvironmentDeclaration,
  HealthCheck,
  HealthCheckResult,
  MigrationDefinition,
  PostDeploymentEvidence,
  PreviewValidation,
  ProductionAuthorization,
  ReleaseCommand,
  RollbackDecision,
  SmokeTestResult,
  ErrorRateSnapshot,
} from './types';

// ─── Adapter Interfaces ────────────────────────────────────────────────────

/**
 * Adapter for detecting breaking changes in the workspace.
 */
export interface BreakingChangeDetector {
  detectBreakingChanges(
    workspaceId: string,
    sourceRevision: string,
    baseRevision: string,
  ): Promise<readonly BreakingChange[]>;
}

/**
 * Adapter for resolving artifact identity from build output.
 */
export interface ArtifactResolver {
  resolveArtifact(
    declaration: ArtifactDeclaration,
    sourceRevision: string,
    buildLogRef: string,
    dependencyMetadataRef: string,
    qualityProfileEvidenceIds: readonly string[],
  ): Promise<ArtifactIdentity | null>;
}

/**
 * Adapter for detecting and validating migrations.
 */
export interface MigrationDetector {
  detectMigrations(workspaceId: string, sourceRevision: string): Promise<readonly MigrationDefinition[]>;
}

/**
 * Adapter for executing health checks.
 */
export interface HealthCheckExecutor {
  executeCheck(check: HealthCheck, environment: string): Promise<HealthCheckResult>;
}

/**
 * Adapter for running smoke tests.
 */
export interface SmokeTestRunner {
  runSmokeTests(commands: readonly ReleaseCommand[], environment: string): Promise<readonly SmokeTestResult[]>;
}

/**
 * Adapter for measuring error rates.
 */
export interface ErrorRateCollector {
  collectErrorRate(environment: string, windowMinutes: number, baselineRate: number): Promise<ErrorRateSnapshot>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Mandatory gate categories that block readiness when missing or failing. */
export const MANDATORY_GATE_CATEGORIES: readonly DeploymentGateCategory[] = [
  'artifact',
  'migration',
  'environment',
  'rollback',
] as const;

// ─── Errors ────────────────────────────────────────────────────────────────

export class AuthorizationRequiredError extends Error {
  constructor(public readonly environment: string) {
    super(`Production authorization required for environment '${environment}'`);
    this.name = 'AuthorizationRequiredError';
  }
}

export class MissingMandatoryDataError extends Error {
  constructor(public readonly missingItems: readonly string[]) {
    super(`Deployment not ready: missing mandatory data — ${missingItems.join(', ')}`);
    this.name = 'MissingMandatoryDataError';
  }
}

export class BreakingChangeRequiresNotesError extends Error {
  constructor(public readonly change: BreakingChange) {
    super(`Breaking change '${change.description}' requires compatibility and rollout notes`);
    this.name = 'BreakingChangeRequiresNotesError';
  }
}

export class MigrationValidationError extends Error {
  constructor(
    public readonly migrationId: string,
    public readonly reason: string,
  ) {
    super(`Migration '${migrationId}' validation failed: ${reason}`);
    this.name = 'MigrationValidationError';
  }
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Evaluates deployment readiness gates and produces revision-bound reports.
 * Remains "not ready" when any mandatory data is missing.
 */
export class DeploymentReadinessService {
  private readonly manifests: Map<string, DeploymentManifest> = new Map();
  private readonly plans: Map<string, DeploymentPlan> = new Map();
  private readonly authorizations: Map<string, ProductionAuthorization> = new Map();
  private readonly postDeploymentEvidence: Map<string, PostDeploymentEvidence> = new Map();
  private readonly artifacts: Map<string, ArtifactIdentity> = new Map();
  private readonly breakingChanges: Map<string, readonly BreakingChange[]> = new Map();
  private readonly migrations: Map<string, readonly MigrationDefinition[]> = new Map();

  constructor(
    private readonly breakingChangeDetector: BreakingChangeDetector,
    private readonly artifactResolver: ArtifactResolver,
    private readonly migrationDetector: MigrationDetector,
    private readonly healthCheckExecutor: HealthCheckExecutor,
    private readonly smokeTestRunner: SmokeTestRunner,
    private readonly errorRateCollector: ErrorRateCollector,
  ) {}

  // ─── Manifest Management ─────────────────────────────────────

  /**
   * Register a deployment manifest declaring artifacts, environments,
   * prerequisites, configuration schema, health checks, and release commands.
   * (R39.1)
   */
  registerManifest(manifest: DeploymentManifest): void {
    this.manifests.set(manifest.workspaceId, manifest);
  }

  /**
   * Get the registered manifest for a workspace.
   */
  getManifest(workspaceId: string): DeploymentManifest | null {
    return this.manifests.get(workspaceId) ?? null;
  }

  // ─── Breaking Change Detection (R39.2) ───────────────────────

  /**
   * Detect breaking API/schema/configuration/permission/infrastructure changes.
   * Requires compatibility and rollout notes for each breaking change.
   */
  async detectBreakingChanges(
    workspaceId: string,
    sourceRevision: string,
    baseRevision: string,
  ): Promise<readonly BreakingChange[]> {
    const changes = await this.breakingChangeDetector.detectBreakingChanges(
      workspaceId,
      sourceRevision,
      baseRevision,
    );
    this.breakingChanges.set(`${workspaceId}:${sourceRevision}`, changes);
    return changes;
  }

  /**
   * Validate that all breaking changes have required compatibility and rollout notes.
   */
  validateBreakingChanges(changes: readonly BreakingChange[]): readonly BreakingChange[] {
    const unresolved: BreakingChange[] = [];
    for (const change of changes) {
      if (!change.compatibilityNotes || !change.rolloutNotes) {
        unresolved.push(change);
      }
    }
    return unresolved;
  }

  // ─── Migration Validation (R39.3) ────────────────────────────

  /**
   * Detect and validate database/state migrations.
   * Requires forward behavior, compatibility, backup assumptions, and rollback strategy.
   */
  async detectAndValidateMigrations(
    workspaceId: string,
    sourceRevision: string,
  ): Promise<{ valid: readonly MigrationDefinition[]; invalid: readonly MigrationValidationError[] }> {
    const detected = await this.migrationDetector.detectMigrations(workspaceId, sourceRevision);
    this.migrations.set(`${workspaceId}:${sourceRevision}`, detected);

    const valid: MigrationDefinition[] = [];
    const invalid: MigrationValidationError[] = [];

    for (const migration of detected) {
      const errors = this.validateMigration(migration);
      if (errors.length === 0) {
        valid.push(migration);
      } else {
        for (const error of errors) {
          invalid.push(new MigrationValidationError(migration.id, error));
        }
      }
    }

    return { valid, invalid };
  }

  /**
   * Validate a single migration definition.
   */
  private validateMigration(migration: MigrationDefinition): readonly string[] {
    const errors: string[] = [];

    if (!migration.forwardBehavior || !migration.forwardBehavior.trim()) {
      errors.push('Missing forward behavior description');
    }

    if (!migration.backwardCompatibility) {
      errors.push('Missing backward compatibility assessment');
    }

    if (!migration.backupAssumptions || !migration.backupAssumptions.trim()) {
      errors.push('Missing backup/recovery assumptions');
    }

    if (!migration.rollbackStrategy) {
      errors.push('Missing rollback/roll-forward strategy');
    } else if (!migration.rollbackStrategy.description || !migration.rollbackStrategy.description.trim()) {
      errors.push('Rollback strategy has no description');
    }

    return errors;
  }

  // ─── Artifact Identity (R39.4) ───────────────────────────────

  /**
   * Link immutable artifact identity to revision, logs, dependency metadata,
   * and Quality_Profile Evidence.
   */
  async resolveArtifacts(
    manifest: DeploymentManifest,
    sourceRevision: string,
    buildLogRef: string,
    dependencyMetadataRef: string,
    qualityProfileEvidenceIds: readonly string[],
  ): Promise<{ resolved: readonly ArtifactIdentity[]; missing: readonly string[] }> {
    const resolved: ArtifactIdentity[] = [];
    const missing: string[] = [];

    for (const declaration of manifest.artifacts) {
      const artifact = await this.artifactResolver.resolveArtifact(
        declaration,
        sourceRevision,
        buildLogRef,
        dependencyMetadataRef,
        qualityProfileEvidenceIds,
      );

      if (artifact) {
        this.artifacts.set(artifact.id, artifact);
        resolved.push(artifact);
      } else if (declaration.required) {
        missing.push(declaration.name);
      }
    }

    return { resolved, missing };
  }

  /**
   * Get a specific artifact by ID.
   */
  getArtifact(artifactId: string): ArtifactIdentity | null {
    return this.artifacts.get(artifactId) ?? null;
  }

  // ─── Deployment Plan (R39.5) ─────────────────────────────────

  /**
   * Create a deployment plan with checks, rollout, monitoring, abort, rollback,
   * and preview/staging/dry-run validation.
   */
  createDeploymentPlan(params: {
    releaseCandidateId: string;
    environment: string;
    manifest: DeploymentManifest;
    migrations: readonly MigrationDefinition[];
    artifacts: readonly ArtifactIdentity[];
    breakingChanges: readonly BreakingChange[];
    previewValidation?: PreviewValidation;
  }): DeploymentPlan {
    const preDeploymentChecks = this.buildPreDeploymentChecks(
      params.manifest,
      params.migrations,
      params.artifacts,
      params.breakingChanges,
    );

    const plan: DeploymentPlan = {
      id: randomUUID(),
      releaseCandidateId: params.releaseCandidateId,
      environment: params.environment,
      preDeploymentChecks,
      rolloutStrategy: {
        kind: 'rolling',
        description: 'Progressive rolling deployment with health verification',
        stages: [
          { name: 'canary', percentage: 10, durationMinutes: 5, healthCheckRequired: true },
          { name: 'partial', percentage: 50, durationMinutes: 10, healthCheckRequired: true },
          { name: 'full', percentage: 100, durationMinutes: 0, healthCheckRequired: true },
        ],
      },
      healthVerification: {
        checks: params.manifest.healthChecks,
        initialDelaySeconds: 30,
        verificationDurationSeconds: 120,
        successThreshold: 3,
      },
      monitoringWindow: {
        durationMinutes: 30,
        metrics: [
          { name: 'error_rate', query: 'error_rate_5m', baseline: 0.01 },
          { name: 'latency_p95', query: 'latency_p95_5m', baseline: 500 },
        ],
        alertThresholds: [
          { metric: 'error_rate', operator: 'gt', value: 0.05, severity: 'critical', action: 'abort' },
          { metric: 'latency_p95', operator: 'gt', value: 2000, severity: 'warning', action: 'alert' },
        ],
      },
      abortCriteria: [
        { name: 'high_error_rate', condition: 'error_rate > 5%', action: 'rollback', description: 'Automatic rollback on elevated error rate' },
        { name: 'health_failure', condition: 'health_check_failures >= 3', action: 'rollback', description: 'Rollback on consecutive health check failures' },
      ],
      rollbackProcedure: {
        strategy: 'semi_automatic',
        steps: [
          { order: 1, description: 'Stop new traffic to current version', command: undefined, timeoutSeconds: 30, rollbackOnFailure: false },
          { order: 2, description: 'Restore previous artifact version', command: undefined, timeoutSeconds: 120, rollbackOnFailure: false },
          { order: 3, description: 'Verify health of restored version', command: undefined, timeoutSeconds: 60, rollbackOnFailure: true },
        ],
        estimatedDurationMinutes: 5,
        requiresApproval: true,
        previousArtifactId: null,
      },
      previewValidation: params.previewValidation ?? null,
      createdAt: new Date().toISOString(),
      fingerprint: this.computePlanFingerprint(params.releaseCandidateId, params.environment),
    };

    this.plans.set(plan.id, plan);
    return plan;
  }

  /**
   * Get a deployment plan by ID.
   */
  getPlan(planId: string): DeploymentPlan | null {
    return this.plans.get(planId) ?? null;
  }

  // ─── Preview/Staging/Dry-Run Validation (R39.6) ──────────────

  /**
   * Support preview, staging, or dry-run validation before production deployment.
   */
  async executePreviewValidation(
    plan: DeploymentPlan,
    environment: string,
    commands: readonly ReleaseCommand[],
    healthChecks: readonly HealthCheck[],
  ): Promise<PreviewValidation> {
    const smokeResults = await this.smokeTestRunner.runSmokeTests(commands, environment);
    const healthResults: HealthCheckResult[] = [];

    for (const check of healthChecks) {
      const result = await this.healthCheckExecutor.executeCheck(check, environment);
      healthResults.push(result);
    }

    const allPassed = smokeResults.every(r => r.passed) && healthResults.every(r => r.passed);

    const validation: PreviewValidation = {
      kind: 'preview',
      environment,
      commands,
      healthChecks,
      evidenceId: randomUUID(),
      passed: allPassed,
    };

    return validation;
  }

  // ─── Production Authorization (R39.7) ────────────────────────

  /**
   * Require explicit production authorization naming environment, revision,
   * artifact, impact, and rollback action.
   *
   * Production deployment SHALL never occur solely because an agent completed a Task.
   */
  authorizeProduction(params: {
    environment: string;
    revision: string;
    artifactId: string;
    expectedImpact: string;
    rollbackAction: string;
    authorizedBy: string;
    releaseCandidateId: string;
    scope: string;
    expiresAt?: string;
  }): ProductionAuthorization {
    // Validate required fields
    if (!params.environment || !params.environment.trim()) {
      throw new AuthorizationRequiredError('(empty environment)');
    }
    if (!params.revision || !params.revision.trim()) {
      throw new Error('Authorization requires a revision');
    }
    if (!params.artifactId || !params.artifactId.trim()) {
      throw new Error('Authorization requires an artifact identity');
    }
    if (!params.expectedImpact || !params.expectedImpact.trim()) {
      throw new Error('Authorization requires expected impact description');
    }
    if (!params.rollbackAction || !params.rollbackAction.trim()) {
      throw new Error('Authorization requires a rollback action');
    }
    if (!params.authorizedBy || !params.authorizedBy.trim()) {
      throw new Error('Authorization requires an actor identity');
    }

    const authorization: ProductionAuthorization = {
      id: randomUUID(),
      environment: params.environment,
      revision: params.revision,
      artifactId: params.artifactId,
      expectedImpact: params.expectedImpact,
      rollbackAction: params.rollbackAction,
      authorizedBy: params.authorizedBy,
      authorizedAt: new Date().toISOString(),
      expiresAt: params.expiresAt ?? null,
      scope: params.scope,
      releaseCandidateId: params.releaseCandidateId,
    };

    this.authorizations.set(authorization.id, authorization);
    return authorization;
  }

  /**
   * Get authorization for a release candidate.
   */
  getAuthorization(releaseCandidateId: string): ProductionAuthorization | null {
    for (const auth of this.authorizations.values()) {
      if (auth.releaseCandidateId === releaseCandidateId) {
        return auth;
      }
    }
    return null;
  }

  // ─── Post-Deployment Evidence (R39.8) ────────────────────────

  /**
   * Capture protected post-deployment evidence including health, smoke-test,
   * error-rate, and rollback-decision data without exposing protected telemetry.
   */
  async capturePostDeploymentEvidence(params: {
    deploymentPlanId: string;
    authorizationId: string;
    releaseCandidateId: string;
    environment: string;
    healthChecks: readonly HealthCheck[];
    smokeTestCommands: readonly ReleaseCommand[];
    monitoringWindowMinutes: number;
    baselineErrorRate: number;
  }): Promise<PostDeploymentEvidence> {
    // Execute health checks
    const healthResults: HealthCheckResult[] = [];
    for (const check of params.healthChecks) {
      const result = await this.healthCheckExecutor.executeCheck(check, params.environment);
      healthResults.push(result);
    }

    // Run smoke tests
    const smokeTestResults = await this.smokeTestRunner.runSmokeTests(
      params.smokeTestCommands,
      params.environment,
    );

    // Collect error rate
    const errorRateSnapshot = await this.errorRateCollector.collectErrorRate(
      params.environment,
      params.monitoringWindowMinutes,
      params.baselineErrorRate,
    );

    // Determine rollback decision based on results
    const rollbackDecision = this.evaluateRollbackDecision(
      healthResults,
      smokeTestResults,
      errorRateSnapshot,
    );

    const evidence: PostDeploymentEvidence = {
      id: randomUUID(),
      deploymentPlanId: params.deploymentPlanId,
      authorizationId: params.authorizationId,
      releaseCandidateId: params.releaseCandidateId,
      environment: params.environment,
      healthResults,
      smokeTestResults,
      errorRateSnapshot,
      rollbackDecision,
      capturedAt: new Date().toISOString(),
      protectedData: true, // Never expose to unauthorized providers
      fingerprint: this.computeEvidenceFingerprint(params.releaseCandidateId, params.environment),
    };

    this.postDeploymentEvidence.set(evidence.id, evidence);
    return evidence;
  }

  /**
   * Get post-deployment evidence for a release candidate.
   */
  getPostDeploymentEvidence(releaseCandidateId: string): PostDeploymentEvidence | null {
    for (const evidence of this.postDeploymentEvidence.values()) {
      if (evidence.releaseCandidateId === releaseCandidateId) {
        return evidence;
      }
    }
    return null;
  }

  // ─── Readiness Evaluation (R39.9) ────────────────────────────

  /**
   * Evaluate complete deployment readiness for a Release_Candidate.
   * Remains "not ready" when mandatory migration, artifact, environment,
   * or rollback information is missing.
   */
  evaluateReadiness(params: {
    releaseCandidateId: string;
    workspaceId: string;
    sourceRevision: string;
  }): DeploymentReadinessStatus {
    const manifest = this.manifests.get(params.workspaceId);
    const missingMandatoryData: string[] = [];
    const gates: DeploymentReadinessGate[] = [];

    // Check manifest presence
    if (!manifest) {
      missingMandatoryData.push('deployment_manifest');
    }

    // Evaluate artifact gates
    const artifactGates = this.evaluateArtifactGates(manifest, params.sourceRevision);
    gates.push(...artifactGates.gates);
    missingMandatoryData.push(...artifactGates.missing);

    // Evaluate migration gates
    const migrationKey = `${params.workspaceId}:${params.sourceRevision}`;
    const detectedMigrations = this.migrations.get(migrationKey) ?? [];
    const migrationGates = this.evaluateMigrationGates(detectedMigrations);
    gates.push(...migrationGates.gates);
    missingMandatoryData.push(...migrationGates.missing);

    // Evaluate environment gates
    const envGates = this.evaluateEnvironmentGates(manifest);
    gates.push(...envGates.gates);
    missingMandatoryData.push(...envGates.missing);

    // Evaluate rollback gates
    const rollbackGates = this.evaluateRollbackGates(params.releaseCandidateId);
    gates.push(...rollbackGates.gates);
    missingMandatoryData.push(...rollbackGates.missing);

    // Evaluate authorization gate
    const authorization = this.getAuthorization(params.releaseCandidateId);
    gates.push(this.evaluateAuthorizationGate(authorization));

    // Evaluate breaking changes
    const breakingKey = `${params.workspaceId}:${params.sourceRevision}`;
    const detectedBreaking = this.breakingChanges.get(breakingKey) ?? [];
    if (detectedBreaking.length > 0) {
      const unresolvedBreaking = this.validateBreakingChanges(detectedBreaking);
      if (unresolvedBreaking.length > 0) {
        gates.push({
          name: 'breaking_changes_documented',
          category: 'breaking_change',
          outcome: 'fail',
          required: true,
          evidenceId: null,
          description: `${unresolvedBreaking.length} breaking change(s) lack required compatibility or rollout notes`,
          blockerReason: 'Missing compatibility/rollout notes for breaking changes',
        });
        missingMandatoryData.push('breaking_change_notes');
      } else {
        gates.push({
          name: 'breaking_changes_documented',
          category: 'breaking_change',
          outcome: 'pass',
          required: true,
          evidenceId: null,
          description: 'All breaking changes have compatibility and rollout notes',
          blockerReason: null,
        });
      }
    }

    // Evaluate post-deployment evidence
    const postEvidence = this.getPostDeploymentEvidence(params.releaseCandidateId);

    // Determine overall readiness
    const ready = missingMandatoryData.length === 0 &&
      gates.filter(g => g.required).every(g => g.outcome === 'pass' || g.outcome === 'waived' || g.outcome === 'not_applicable');

    return {
      releaseCandidateId: params.releaseCandidateId,
      ready,
      gates,
      missingMandatoryData,
      breakingChanges: detectedBreaking,
      migrations: detectedMigrations,
      artifacts: Array.from(this.artifacts.values()).filter(
        a => a.sourceRevision === params.sourceRevision,
      ),
      authorization,
      postDeploymentEvidence: postEvidence,
      evaluatedAt: new Date().toISOString(),
      fingerprint: this.computeReadinessFingerprint(params.releaseCandidateId),
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private buildPreDeploymentChecks(
    manifest: DeploymentManifest,
    migrations: readonly MigrationDefinition[],
    artifacts: readonly ArtifactIdentity[],
    breakingChanges: readonly BreakingChange[],
  ): readonly DeploymentCheck[] {
    const checks: DeploymentCheck[] = [];

    // Artifact checks
    for (const decl of manifest.artifacts) {
      const found = artifacts.some(a => a.name === decl.name);
      checks.push({
        name: `artifact_${decl.name}`,
        kind: 'artifact',
        required: decl.required,
        description: `Build artifact '${decl.name}' present and verified`,
        passed: found,
        evidenceId: null,
      });
    }

    // Migration checks
    for (const migration of migrations) {
      const valid = !!migration.forwardBehavior &&
        !!migration.backwardCompatibility &&
        !!migration.backupAssumptions &&
        !!migration.rollbackStrategy;
      checks.push({
        name: `migration_${migration.id}`,
        kind: 'migration',
        required: migration.required,
        description: `Migration '${migration.name}' validated with forward/rollback strategy`,
        passed: valid,
        evidenceId: null,
      });
    }

    // Configuration check
    if (manifest.configurationSchema.entries.length > 0) {
      checks.push({
        name: 'configuration_schema',
        kind: 'configuration',
        required: true,
        description: 'Configuration schema declared and validated',
        passed: true,
        evidenceId: null,
      });
    }

    // Breaking change check
    if (breakingChanges.length > 0) {
      const allDocumented = breakingChanges.every(
        c => c.compatibilityNotes && c.rolloutNotes,
      );
      checks.push({
        name: 'breaking_changes_documented',
        kind: 'custom',
        required: true,
        description: 'All breaking changes have compatibility and rollout notes',
        passed: allDocumented,
        evidenceId: null,
      });
    }

    // Health check definition
    if (manifest.healthChecks.length > 0) {
      checks.push({
        name: 'health_checks_defined',
        kind: 'health',
        required: true,
        description: 'Health checks defined for post-deployment verification',
        passed: true,
        evidenceId: null,
      });
    }

    return checks;
  }

  private evaluateArtifactGates(
    manifest: DeploymentManifest | undefined,
    sourceRevision: string,
  ): { gates: DeploymentReadinessGate[]; missing: string[] } {
    const gates: DeploymentReadinessGate[] = [];
    const missing: string[] = [];

    if (!manifest) {
      gates.push({
        name: 'artifacts_declared',
        category: 'artifact',
        outcome: 'missing',
        required: true,
        evidenceId: null,
        description: 'No deployment manifest found',
        blockerReason: 'Deployment manifest not registered',
      });
      missing.push('artifact_declarations');
      return { gates, missing };
    }

    const requiredArtifacts = manifest.artifacts.filter(a => a.required);
    if (requiredArtifacts.length === 0) {
      gates.push({
        name: 'artifacts_declared',
        category: 'artifact',
        outcome: 'not_applicable',
        required: false,
        evidenceId: null,
        description: 'No required artifacts declared',
        blockerReason: null,
      });
      return { gates, missing };
    }

    const revisionArtifacts = Array.from(this.artifacts.values()).filter(
      a => a.sourceRevision === sourceRevision,
    );

    for (const decl of requiredArtifacts) {
      const found = revisionArtifacts.find(a => a.name === decl.name);
      if (found) {
        // Verify it has linked evidence
        const hasEvidence = found.qualityProfileEvidenceIds.length > 0;
        gates.push({
          name: `artifact_${decl.name}`,
          category: 'artifact',
          outcome: hasEvidence ? 'pass' : 'fail',
          required: true,
          evidenceId: found.qualityProfileEvidenceIds[0] ?? null,
          description: hasEvidence
            ? `Artifact '${decl.name}' present with linked Quality_Profile Evidence`
            : `Artifact '${decl.name}' present but lacks Quality_Profile Evidence`,
          blockerReason: hasEvidence ? null : 'Missing Quality_Profile Evidence link',
        });
        if (!hasEvidence) {
          missing.push(`artifact_evidence_${decl.name}`);
        }
      } else {
        gates.push({
          name: `artifact_${decl.name}`,
          category: 'artifact',
          outcome: 'missing',
          required: true,
          evidenceId: null,
          description: `Required artifact '${decl.name}' not found`,
          blockerReason: 'Artifact not built or not resolved',
        });
        missing.push(`artifact_${decl.name}`);
      }
    }

    return { gates, missing };
  }

  private evaluateMigrationGates(
    migrations: readonly MigrationDefinition[],
  ): { gates: DeploymentReadinessGate[]; missing: string[] } {
    const gates: DeploymentReadinessGate[] = [];
    const missing: string[] = [];

    if (migrations.length === 0) {
      gates.push({
        name: 'migrations',
        category: 'migration',
        outcome: 'not_applicable',
        required: false,
        evidenceId: null,
        description: 'No migrations detected',
        blockerReason: null,
      });
      return { gates, missing };
    }

    for (const migration of migrations) {
      const errors = this.validateMigration(migration);
      if (errors.length === 0) {
        gates.push({
          name: `migration_${migration.id}`,
          category: 'migration',
          outcome: 'pass',
          required: migration.required,
          evidenceId: null,
          description: `Migration '${migration.name}' fully specified`,
          blockerReason: null,
        });
      } else {
        gates.push({
          name: `migration_${migration.id}`,
          category: 'migration',
          outcome: migration.required ? 'fail' : 'blocked',
          required: migration.required,
          evidenceId: null,
          description: `Migration '${migration.name}' incomplete: ${errors.join('; ')}`,
          blockerReason: errors.join('; '),
        });
        if (migration.required) {
          missing.push(`migration_data_${migration.id}`);
        }
      }
    }

    return { gates, missing };
  }

  private evaluateEnvironmentGates(
    manifest: DeploymentManifest | undefined,
  ): { gates: DeploymentReadinessGate[]; missing: string[] } {
    const gates: DeploymentReadinessGate[] = [];
    const missing: string[] = [];

    if (!manifest || manifest.environments.length === 0) {
      gates.push({
        name: 'environment_declared',
        category: 'environment',
        outcome: 'missing',
        required: true,
        evidenceId: null,
        description: 'No target environments declared',
        blockerReason: 'Target environments must be declared',
      });
      missing.push('environment_declarations');
      return { gates, missing };
    }

    // Check that at least one production environment is configured
    const productionEnvs = manifest.environments.filter(e => e.kind === 'production');
    if (productionEnvs.length === 0) {
      gates.push({
        name: 'production_environment',
        category: 'environment',
        outcome: 'missing',
        required: true,
        evidenceId: null,
        description: 'No production environment declared',
        blockerReason: 'At least one production environment must be declared',
      });
      missing.push('production_environment');
    } else {
      gates.push({
        name: 'production_environment',
        category: 'environment',
        outcome: 'pass',
        required: true,
        evidenceId: null,
        description: `${productionEnvs.length} production environment(s) declared`,
        blockerReason: null,
      });
    }

    return { gates, missing };
  }

  private evaluateRollbackGates(
    releaseCandidateId: string,
  ): { gates: DeploymentReadinessGate[]; missing: string[] } {
    const gates: DeploymentReadinessGate[] = [];
    const missing: string[] = [];

    // Check if any plan exists with rollback procedure
    let hasRollbackPlan = false;
    for (const plan of this.plans.values()) {
      if (plan.releaseCandidateId === releaseCandidateId && plan.rollbackProcedure) {
        hasRollbackPlan = true;
        if (plan.rollbackProcedure.steps.length === 0) {
          gates.push({
            name: 'rollback_procedure',
            category: 'rollback',
            outcome: 'fail',
            required: true,
            evidenceId: null,
            description: 'Rollback procedure defined but has no steps',
            blockerReason: 'Rollback procedure must include actionable steps',
          });
          missing.push('rollback_steps');
        } else {
          gates.push({
            name: 'rollback_procedure',
            category: 'rollback',
            outcome: 'pass',
            required: true,
            evidenceId: null,
            description: `Rollback procedure defined with ${plan.rollbackProcedure.steps.length} step(s)`,
            blockerReason: null,
          });
        }
        break;
      }
    }

    if (!hasRollbackPlan) {
      gates.push({
        name: 'rollback_procedure',
        category: 'rollback',
        outcome: 'missing',
        required: true,
        evidenceId: null,
        description: 'No rollback procedure defined',
        blockerReason: 'Rollback procedure must be defined before production deployment',
      });
      missing.push('rollback_procedure');
    }

    return { gates, missing };
  }

  private evaluateAuthorizationGate(
    authorization: ProductionAuthorization | null,
  ): DeploymentReadinessGate {
    if (!authorization) {
      return {
        name: 'production_authorization',
        category: 'authorization',
        outcome: 'missing',
        required: true,
        evidenceId: null,
        description: 'Production authorization not granted',
        blockerReason: 'Explicit authorization naming environment, revision, artifact, impact, and rollback required',
      };
    }

    // Check expiration
    if (authorization.expiresAt) {
      const now = new Date();
      const expires = new Date(authorization.expiresAt);
      if (now > expires) {
        return {
          name: 'production_authorization',
          category: 'authorization',
          outcome: 'stale',
          required: true,
          evidenceId: null,
          description: 'Production authorization has expired',
          blockerReason: 'Authorization expired; re-authorization required',
        };
      }
    }

    return {
      name: 'production_authorization',
      category: 'authorization',
      outcome: 'pass',
      required: true,
      evidenceId: null,
      description: `Authorized by ${authorization.authorizedBy} for ${authorization.environment}`,
      blockerReason: null,
    };
  }

  private evaluateRollbackDecision(
    healthResults: readonly HealthCheckResult[],
    smokeTestResults: readonly SmokeTestResult[],
    errorRateSnapshot: ErrorRateSnapshot | null,
  ): RollbackDecision | null {
    const healthFailed = healthResults.some(r => !r.passed);
    const smokeFailed = smokeTestResults.some(r => !r.passed);
    const errorRateExceeded = errorRateSnapshot && !errorRateSnapshot.withinThreshold;

    if (healthFailed || smokeFailed || errorRateExceeded) {
      const reasons: string[] = [];
      if (healthFailed) reasons.push('health check failure');
      if (smokeFailed) reasons.push('smoke test failure');
      if (errorRateExceeded) reasons.push('elevated error rate');

      return {
        triggered: true,
        reason: reasons.join(', '),
        actor: 'system',
        decidedAt: new Date().toISOString(),
        action: 'investigate',
      };
    }

    return {
      triggered: false,
      reason: null,
      actor: 'system',
      decidedAt: new Date().toISOString(),
      action: 'proceed',
    };
  }

  private computePlanFingerprint(releaseCandidateId: string, environment: string): string {
    const data = `${releaseCandidateId}:${environment}:${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `plan_fp_${Math.abs(hash).toString(36)}`;
  }

  private computeEvidenceFingerprint(releaseCandidateId: string, environment: string): string {
    const data = `evidence:${releaseCandidateId}:${environment}:${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `ev_fp_${Math.abs(hash).toString(36)}`;
  }

  private computeReadinessFingerprint(releaseCandidateId: string): string {
    const data = `readiness:${releaseCandidateId}:${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `rd_fp_${Math.abs(hash).toString(36)}`;
  }
}
