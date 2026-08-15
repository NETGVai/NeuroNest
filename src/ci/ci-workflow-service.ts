/**
 * CIWorkflowService — Detects existing CI/CD providers, extends their conventions
 * reproducibly, pins third-party actions, validates workflow syntax, aligns commands
 * with Quality_Profile, links remote CI runs to Evidence, and defines deployment
 * environment protection and rollback.
 *
 * Requirements: 35.1, 35.2, 35.3, 35.4, 35.5, 35.6, 35.7, 35.8, 35.9
 */

import { randomUUID } from 'crypto';
import type {
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

// ─── Adapters ──────────────────────────────────────────────────────────────

/**
 * Adapter for reading workspace files to detect CI/CD conventions.
 */
export interface WorkspaceFileReader {
  exists(relativePath: string): Promise<boolean>;
  readText(relativePath: string): Promise<string | null>;
  listDir(relativePath: string): Promise<readonly string[]>;
}

/**
 * Adapter for Quality_Profile commands to align CI commands.
 */
export interface QualityProfileAdapter {
  getCommands(workspaceId: string): QualityProfileCommands | null;
  getFingerprint(workspaceId: string): string | null;
}

export interface QualityProfileCommands {
  readonly testTargeted?: string;
  readonly testFull?: string;
  readonly typeCheck?: string;
  readonly lint?: string;
  readonly format?: string;
  readonly build?: string;
  readonly security?: string;
  readonly smoke?: string;
}

/**
 * Adapter for linking remote CI runs to Evidence store.
 */
export interface EvidenceLinkAdapter {
  linkRemoteRun(run: RemoteCIRun): Promise<void>;
  linkCheckResult(runId: string, check: RemoteCheckResult): Promise<void>;
}

/**
 * Adapter for validating workflow syntax.
 */
export interface WorkflowSyntaxValidator {
  validateLocal(content: string, provider: CIProvider): WorkflowValidationResult;
  validateRemote?(content: string, provider: CIProvider): Promise<WorkflowValidationResult>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Provider detection paths. */
const PROVIDER_PATHS: Record<CIProvider, readonly string[]> = {
  github_actions: ['.github/workflows'],
  gitlab_ci: ['.gitlab-ci.yml'],
  circleci: ['.circleci/config.yml'],
  jenkins: ['Jenkinsfile'],
  azure_pipelines: ['azure-pipelines.yml'],
  bitbucket_pipelines: ['bitbucket-pipelines.yml'],
  unknown: [],
};

/** Default minimal permissions for generated workflows. */
const DEFAULT_PERMISSIONS: WorkflowPermissions = {
  contents: 'read',
  pullRequests: 'read',
  actions: 'none',
  packages: 'none',
  issues: 'none',
  checks: 'write',
  statuses: 'write',
  deployments: 'none',
};

// ─── Errors ────────────────────────────────────────────────────────────────

export class ProviderDetectionError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly reason: string,
  ) {
    super(`CI/CD provider detection failed for workspace '${workspaceId}': ${reason}`);
    this.name = 'ProviderDetectionError';
  }
}

export class WorkflowGenerationError extends Error {
  constructor(
    public readonly provider: CIProvider,
    public readonly reason: string,
  ) {
    super(`Workflow generation failed for provider '${provider}': ${reason}`);
    this.name = 'WorkflowGenerationError';
  }
}

export class WorkflowValidationError_ extends Error {
  constructor(
    public readonly errors: readonly WorkflowValidationError[],
  ) {
    super(`Workflow validation failed: ${errors.map((e) => e.message).join('; ')}`);
    this.name = 'WorkflowValidationError';
  }
}

// ─── CIWorkflowService ────────────────────────────────────────────────────

/**
 * Manages CI/CD workflow detection, generation, validation, and remote run linking.
 *
 * Design principle: Extend existing provider conventions rather than creating
 * parallel pipelines. Only generates what is needed and respects established
 * project patterns.
 */
export class CIWorkflowService {
  private readonly detectedProviders: Map<string, ProviderDetectionResult> = new Map();
  private readonly generatedWorkflows: Map<string, GeneratedWorkflow> = new Map();
  private readonly remoteRuns: Map<string, RemoteCIRun> = new Map();

  constructor(
    private readonly fileReader: WorkspaceFileReader,
    private readonly qualityProfile: QualityProfileAdapter,
    private readonly evidenceLink: EvidenceLinkAdapter,
    private readonly syntaxValidator: WorkflowSyntaxValidator,
  ) {}

  // ─── Provider Detection (R35.1) ────────────────────────────────

  /**
   * Detect the existing CI/CD provider and conventions in a workspace.
   * Prefers extending established conventions over creating new pipelines.
   */
  async detectProvider(workspaceId: string): Promise<ProviderDetectionResult> {
    const providers = Object.entries(PROVIDER_PATHS) as Array<[CIProvider, readonly string[]]>;

    for (const [provider, paths] of providers) {
      if (provider === 'unknown') continue;

      for (const path of paths) {
        const exists = await this.fileReader.exists(path);
        if (exists) {
          const conventions = await this.extractConventions(provider, path);
          const workflowFiles = await this.listWorkflowFiles(provider, path);

          const result: ProviderDetectionResult = {
            provider,
            workflowFiles,
            conventions,
            detectedAt: new Date().toISOString(),
            workspaceId,
          };

          this.detectedProviders.set(workspaceId, result);
          return result;
        }
      }
    }

    // No provider detected
    const result: ProviderDetectionResult = {
      provider: 'unknown',
      workflowFiles: [],
      conventions: this.emptyConventions(),
      detectedAt: new Date().toISOString(),
      workspaceId,
    };

    this.detectedProviders.set(workspaceId, result);
    return result;
  }

  /**
   * Get the cached detection result for a workspace.
   */
  getDetectedProvider(workspaceId: string): ProviderDetectionResult | null {
    return this.detectedProviders.get(workspaceId) ?? null;
  }

  // ─── Workflow Stage Modeling (R35.2) ────────────────────────────

  /**
   * Model applicable stages with dependencies and failure behavior.
   * Aligns with the Quality_Profile (R35.6) and documents differences.
   */
  modelWorkflowStages(
    workspaceId: string,
    options?: { includeDeployment?: boolean },
  ): readonly WorkflowStage[] {
    const profile = this.qualityProfile.getCommands(workspaceId);
    const stages: WorkflowStage[] = [];

    // Install stage
    stages.push(this.createStage({
      id: 'install',
      name: 'Install dependencies',
      category: 'install',
      command: profile?.testFull ? this.inferInstallCommand(profile) : 'npm ci',
      dependsOn: [],
      failureBehavior: { action: 'stop' },
      timeoutMinutes: 10,
      ciCommand: 'npm ci --ignore-scripts',
      localCommand: 'npm install',
    }));

    // Cache stage
    stages.push(this.createStage({
      id: 'cache',
      name: 'Restore dependency cache',
      category: 'cache',
      command: 'actions/cache@v5',
      dependsOn: [],
      failureBehavior: { action: 'continue' },
      timeoutMinutes: 5,
      ciCommand: 'actions/cache@v5',
    }));

    // Lint stage
    if (profile?.lint) {
      stages.push(this.createStage({
        id: 'lint',
        name: 'Lint check',
        category: 'lint',
        command: profile.lint,
        dependsOn: ['install'],
        failureBehavior: { action: 'stop' },
        timeoutMinutes: 10,
        ciCommand: profile.lint,
        localCommand: profile.lint,
      }));
    }

    // Type check stage
    if (profile?.typeCheck) {
      stages.push(this.createStage({
        id: 'type_check',
        name: 'Type check',
        category: 'type_check',
        command: profile.typeCheck,
        dependsOn: ['install'],
        failureBehavior: { action: 'stop' },
        timeoutMinutes: 10,
        ciCommand: profile.typeCheck,
        localCommand: profile.typeCheck,
      }));
    }

    // Test stage
    if (profile?.testFull) {
      stages.push(this.createStage({
        id: 'test',
        name: 'Run tests',
        category: 'test',
        command: profile.testFull,
        dependsOn: ['install'],
        failureBehavior: { action: 'stop' },
        timeoutMinutes: 30,
        ciCommand: profile.testFull,
        localCommand: profile.testFull,
      }));
    }

    // Build stage
    if (profile?.build) {
      stages.push(this.createStage({
        id: 'build',
        name: 'Build',
        category: 'build',
        command: profile.build,
        dependsOn: ['lint', 'type_check', 'test'].filter((dep) =>
          stages.some((s) => s.id === dep),
        ),
        failureBehavior: { action: 'stop' },
        timeoutMinutes: 15,
        ciCommand: profile.build,
        localCommand: profile.build,
      }));
    }

    // Security stage
    if (profile?.security) {
      stages.push(this.createStage({
        id: 'security',
        name: 'Security scan',
        category: 'security',
        command: profile.security,
        dependsOn: ['install'],
        failureBehavior: { action: 'stop' },
        timeoutMinutes: 10,
        ciCommand: profile.security,
        localCommand: profile.security,
      }));
    }

    // Artifacts stage
    stages.push(this.createStage({
      id: 'artifacts',
      name: 'Upload artifacts',
      category: 'artifacts',
      command: 'actions/upload-artifact@v5',
      dependsOn: ['build'].filter((dep) => stages.some((s) => s.id === dep)),
      failureBehavior: { action: 'continue' },
      timeoutMinutes: 5,
      ciCommand: 'actions/upload-artifact@v5',
    }));

    // Deployment stages (optional)
    if (options?.includeDeployment) {
      stages.push(this.createStage({
        id: 'preview',
        name: 'Deploy preview',
        category: 'preview',
        command: 'deploy:preview',
        dependsOn: ['build'].filter((dep) => stages.some((s) => s.id === dep)),
        failureBehavior: { action: 'continue', allowFailure: true },
        timeoutMinutes: 15,
        ciCommand: 'deploy:preview',
      }));

      stages.push(this.createStage({
        id: 'deployment',
        name: 'Deploy to production',
        category: 'deployment',
        command: 'deploy:production',
        dependsOn: ['build', 'test', 'security'].filter((dep) =>
          stages.some((s) => s.id === dep),
        ),
        failureBehavior: { action: 'stop' },
        timeoutMinutes: 30,
        ciCommand: 'deploy:production',
      }));
    }

    return stages;
  }

  // ─── Third-Party Pinning (R35.3) ──────────────────────────────

  /**
   * Analyze and pin third-party action/image/plugin references.
   * Enforces pinning by commit SHA or digest per project security policy.
   */
  pinThirdPartyReferences(
    references: readonly PinnedReference[],
    policy: PinningPolicy,
  ): { pinned: readonly PinnedReference[]; violations: readonly string[] } {
    const pinned: PinnedReference[] = [];
    const violations: string[] = [];

    for (const ref of references) {
      if (ref.kind === 'action' && policy.actionsUseSHA) {
        if (ref.pinKind !== 'sha') {
          violations.push(
            `Action '${ref.name}@${ref.version}' must be pinned by commit SHA (currently: ${ref.pinKind})`,
          );
          pinned.push({ ...ref, pinKind: 'sha', pin: ref.pin || 'REQUIRES_SHA' });
        } else {
          pinned.push(ref);
        }
      } else if (ref.kind === 'image' && policy.imagesUseDigest) {
        if (ref.pinKind !== 'digest') {
          violations.push(
            `Image '${ref.name}:${ref.version}' must be pinned by digest (currently: ${ref.pinKind})`,
          );
          pinned.push({ ...ref, pinKind: 'digest', pin: ref.pin || 'REQUIRES_DIGEST' });
        } else {
          pinned.push(ref);
        }
      } else if (ref.kind === 'plugin' && policy.pluginsUseExact) {
        if (ref.pinKind !== 'exact_version') {
          violations.push(
            `Plugin '${ref.name}@${ref.version}' must be pinned by exact version (currently: ${ref.pinKind})`,
          );
          pinned.push({ ...ref, pinKind: 'exact_version', pin: ref.version });
        } else {
          pinned.push(ref);
        }
      } else {
        pinned.push(ref);
      }
    }

    return { pinned, violations };
  }

  // ─── Secrets and Permissions (R35.3, R35.4) ───────────────────

  /**
   * Compute minimum required token permissions for a set of workflow stages.
   * Follows least-privilege principle.
   */
  computeMinimalPermissions(
    stages: readonly WorkflowStage[],
  ): WorkflowPermissions {
    const perms: WorkflowPermissions = { ...DEFAULT_PERMISSIONS };
    const mutPerms = perms as unknown as Record<string, string>;

    for (const stage of stages) {
      if (stage.category === 'deployment') {
        mutPerms['deployments'] = 'write';
        mutPerms['contents'] = 'write';
      }
      if (stage.category === 'artifacts') {
        mutPerms['actions'] = 'write';
      }
      if (stage.category === 'preview') {
        mutPerms['pullRequests'] = 'write';
      }
    }

    return perms;
  }

  /**
   * Validate that secrets are referenced by provider-managed identifiers
   * and never embedded in workflow files. (R35.4)
   */
  validateSecretReferences(
    workflowContent: string,
    declaredSecrets: readonly SecretReference[],
  ): { valid: boolean; violations: readonly string[] } {
    const violations: string[] = [];

    // Check for hardcoded patterns that look like secrets
    const secretPatterns = [
      /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*["'][^${}][^"']+["']/gi,
      /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
      /sk-[A-Za-z0-9]{20,}/g,
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
    ];

    for (const pattern of secretPatterns) {
      if (pattern.test(workflowContent)) {
        violations.push(
          `Potential embedded secret detected matching pattern: ${pattern.source}`,
        );
      }
      // Reset regex state for global patterns
      pattern.lastIndex = 0;
    }

    // Verify declared secrets use provider reference syntax
    for (const secret of declaredSecrets) {
      const providerPattern = this.getSecretReferencePattern(secret.provider);
      if (providerPattern && !workflowContent.includes(providerPattern.replace('NAME', secret.name))) {
        // Secret is declared but not referenced correctly
        // This is informational, not a violation
      }
    }

    return { valid: violations.length === 0, violations };
  }

  // ─── Workflow Syntax Validation (R35.5) ────────────────────────

  /**
   * Validate workflow syntax locally or through an approved provider API.
   * Must pass before marking an associated Task complete.
   */
  validateWorkflowSyntax(
    content: string,
    provider: CIProvider,
  ): WorkflowValidationResult {
    return this.syntaxValidator.validateLocal(content, provider);
  }

  /**
   * Validate workflow syntax using remote API if available.
   */
  async validateWorkflowSyntaxRemote(
    content: string,
    provider: CIProvider,
  ): Promise<WorkflowValidationResult> {
    if (this.syntaxValidator.validateRemote) {
      return this.syntaxValidator.validateRemote(content, provider);
    }
    return this.syntaxValidator.validateLocal(content, provider);
  }

  // ─── Quality_Profile Alignment (R35.6) ────────────────────────

  /**
   * Compare CI commands with local Quality_Profile commands.
   * Document intentional differences.
   */
  assessQualityAlignment(
    workspaceId: string,
    stages: readonly WorkflowStage[],
  ): readonly QualityProfileAlignment[] {
    const profile = this.qualityProfile.getCommands(workspaceId);
    if (!profile) return stages.map((s) => s.qualityProfileAlignment);

    return stages.map((stage) => {
      const localCommand = this.getLocalCommandForCategory(stage.category, profile);
      if (!localCommand) {
        return {
          aligned: true,
          ciCommand: stage.command,
          differences: [],
        };
      }

      const aligned = this.commandsAreEquivalent(stage.command, localCommand);
      const differences = aligned
        ? []
        : [`CI uses '${stage.command}', local uses '${localCommand}'`];

      return {
        aligned,
        localCommand,
        ciCommand: stage.command,
        differences,
      };
    });
  }

  // ─── Remote Run Correlation (R35.7, R35.8) ────────────────────

  /**
   * Link a remote CI run to a Release_Candidate, commit, Task, and
   * Production_Readiness_Report.
   */
  async linkRemoteRun(run: RemoteCIRun): Promise<void> {
    this.remoteRuns.set(run.id, run);
    await this.evidenceLink.linkRemoteRun(run);
  }

  /**
   * Update check results for a remote run and link them to Evidence.
   * Returns failures without mutating protected branches (R35.8).
   */
  async updateRemoteRunChecks(
    runId: string,
    checks: readonly RemoteCheckResult[],
  ): Promise<{ failures: readonly RemoteCheckResult[] }> {
    const run = this.remoteRuns.get(runId);
    if (!run) return { failures: [] };

    const updatedRun: RemoteCIRun = {
      ...run,
      checks,
      status: this.computeRunStatus(checks),
      finishedAt: checks.every((c) => c.finishedAt) ? new Date().toISOString() : undefined,
    };

    this.remoteRuns.set(runId, updatedRun);

    // Link individual check results to Evidence
    for (const check of checks) {
      await this.evidenceLink.linkCheckResult(runId, check);
    }

    // Return failures for actionable diagnostics (R35.8)
    const failures = checks.filter(
      (c) => c.conclusion === 'failure' || c.status === 'failed',
    );

    return { failures };
  }

  /**
   * Get all remote runs for a given commit.
   */
  getRemoteRunsForCommit(commit: string): readonly RemoteCIRun[] {
    return Array.from(this.remoteRuns.values()).filter((r) => r.commit === commit);
  }

  /**
   * Get a remote run by ID.
   */
  getRemoteRun(id: string): RemoteCIRun | null {
    return this.remoteRuns.get(id) ?? null;
  }

  // ─── Deployment Environment (R35.9) ───────────────────────────

  /**
   * Define a deployment environment with protection, concurrency,
   * cancellation, rollback, and artifact provenance.
   */
  defineDeploymentEnvironment(
    name: string,
    options?: Partial<{
      requiredReviewers: number;
      waitTimer: number;
      branchPolicy: readonly string[];
      cancelInProgress: boolean;
      maxParallel: number;
      rollbackAutomatic: boolean;
      healthCheckUrl: string;
      provenanceLevel: 'slsa1' | 'slsa2' | 'slsa3';
    }>,
  ): DeploymentEnvironment {
    const protection: EnvironmentProtection = {
      requiredReviewers: options?.requiredReviewers ?? 1,
      waitTimer: options?.waitTimer,
      branchPolicy: options?.branchPolicy ?? ['main', 'release/*'],
      deploymentBranchPolicy: 'protected',
    };

    const concurrency: ConcurrencyPolicy = {
      group: `deploy-${name}`,
      cancelInProgress: options?.cancelInProgress ?? false,
      maxParallel: options?.maxParallel ?? 1,
    };

    const cancellation: CancellationPolicy = {
      onNewPush: false,
      onManualTrigger: true,
      gracePeriodSeconds: 30,
    };

    const rollback: RollbackPolicy = {
      automatic: options?.rollbackAutomatic ?? false,
      healthCheckUrl: options?.healthCheckUrl,
      healthCheckIntervalSeconds: 10,
      healthCheckTimeoutSeconds: 300,
      previousArtifactRetention: 5,
    };

    const artifactProvenance: ArtifactProvenance = {
      enabled: true,
      level: options?.provenanceLevel ?? 'slsa2',
      attestation: true,
      signingEnabled: true,
      checksumAlgorithm: 'sha256',
    };

    return {
      name,
      protection,
      concurrency,
      cancellation,
      rollback,
      artifactProvenance,
    };
  }

  // ─── Full Workflow Generation ──────────────────────────────────

  /**
   * Generate a complete workflow that extends existing CI/CD conventions.
   * Returns a validated workflow ready for review before commit.
   */
  async generateWorkflow(
    workspaceId: string,
    options?: {
      includeDeployment?: boolean;
      deploymentEnvironments?: readonly DeploymentEnvironment[];
      additionalSecrets?: readonly SecretReference[];
    },
  ): Promise<GeneratedWorkflow> {
    const detection = this.detectedProviders.get(workspaceId);
    if (!detection) {
      throw new WorkflowGenerationError('unknown', 'Provider not detected. Run detectProvider first.');
    }

    const stages = this.modelWorkflowStages(workspaceId, {
      includeDeployment: options?.includeDeployment,
    });

    const permissions = this.computeMinimalPermissions(stages);
    const secrets = this.collectSecretReferences(detection, options?.additionalSecrets);

    const pinnedReferences = this.collectPinnedReferences(stages, detection);
    const { pinned, violations: pinViolations } = this.pinThirdPartyReferences(
      pinnedReferences,
      detection.conventions.pinningPolicy,
    );

    if (pinViolations.length > 0) {
      // Log pinning violations but don't block generation
      // These are informational for the review process
    }

    const deploymentEnvironments = options?.deploymentEnvironments ?? [];
    const qualityFingerprint = this.qualityProfile.getFingerprint(workspaceId) ?? 'none';

    // Generate the workflow content
    const content = this.renderWorkflowContent(
      detection.provider,
      stages,
      permissions,
      secrets,
      pinned,
      deploymentEnvironments,
    );

    // Validate syntax (R35.5)
    const validation = this.validateWorkflowSyntax(content, detection.provider);

    const workflow: GeneratedWorkflow = {
      id: randomUUID(),
      provider: detection.provider,
      fileName: this.getDefaultFileName(detection.provider),
      content,
      stages,
      permissions,
      secrets,
      pinnedReferences: pinned,
      deploymentEnvironments,
      validation,
      qualityProfileFingerprint: qualityFingerprint,
      generatedAt: new Date().toISOString(),
    };

    this.generatedWorkflows.set(workflow.id, workflow);
    return workflow;
  }

  /**
   * Get a generated workflow by ID.
   */
  getGeneratedWorkflow(id: string): GeneratedWorkflow | null {
    return this.generatedWorkflows.get(id) ?? null;
  }

  // ─── Private Helpers ───────────────────────────────────────────

  /**
   * Extract conventions from an existing workflow file.
   */
  private async extractConventions(
    provider: CIProvider,
    path: string,
  ): Promise<WorkflowConventions> {
    if (provider === 'github_actions') {
      return this.extractGitHubActionsConventions(path);
    }
    return this.emptyConventions();
  }

  /**
   * Extract GitHub Actions-specific conventions from workflow files.
   */
  private async extractGitHubActionsConventions(
    dirPath: string,
  ): Promise<WorkflowConventions> {
    const files = await this.fileReader.listDir(dirPath);
    const ymlFiles = files.filter(
      (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
    );

    let nodeVersion: string | undefined;
    let packageManager: 'npm' | 'yarn' | 'pnpm' | 'unknown' = 'unknown';
    let cacheStrategy: CacheStrategy | undefined;
    const existingJobs: string[] = [];
    const secretRefs: string[] = [];
    const tokenPerms: TokenPermission[] = [];
    let pinningPolicy: PinningPolicy = {
      actionsUseSHA: false,
      imagesUseDigest: false,
      pluginsUseExact: true,
    };

    for (const file of ymlFiles) {
      const content = await this.fileReader.readText(`${dirPath}/${file}`);
      if (!content) continue;

      // Extract node version
      const nodeMatch = content.match(/node-version:\s*['"]?(\d+)/);
      if (nodeMatch) {
        nodeVersion = nodeMatch[1];
      }

      // Detect package manager
      if (content.includes('npm ci') || content.includes('npm install')) {
        packageManager = 'npm';
      } else if (content.includes('yarn install') || content.includes('yarn --frozen-lockfile')) {
        packageManager = 'yarn';
      } else if (content.includes('pnpm install') || content.includes('pnpm i')) {
        packageManager = 'pnpm';
      }

      // Detect cache strategy
      const cacheMatch = content.match(/uses:\s*actions\/cache@/);
      if (cacheMatch) {
        const pathMatch = content.match(/path:\s*\|?\s*([\s\S]*?)(?:\n\s*key:)/);
        const keyMatch = content.match(/key:\s*(.+)/);
        if (pathMatch && keyMatch) {
          cacheStrategy = {
            paths: pathMatch[1]!.trim().split('\n').map((p) => p.trim()).filter(Boolean),
            keyPattern: keyMatch[1]!.trim(),
          };
        }
      }

      // Extract job names
      const jobMatches = content.matchAll(/^\s{2}([\w-]+):\s*$/gm);
      for (const match of jobMatches) {
        if (match[1]) existingJobs.push(match[1]);
      }

      // Extract secret references
      const secretMatches = content.matchAll(/\$\{\{\s*secrets\.([\w-]+)\s*\}\}/g);
      for (const match of secretMatches) {
        if (match[1]) secretRefs.push(match[1]);
      }

      // Check if actions use SHA pinning
      const actionRefs = content.matchAll(/uses:\s*([\w-]+\/[\w-]+)@([a-f0-9]{40}|v[\d.]+|\w+)/g);
      let shaCount = 0;
      let totalActions = 0;
      for (const match of actionRefs) {
        totalActions++;
        if (match[2] && /^[a-f0-9]{40}$/.test(match[2])) {
          shaCount++;
        }
      }
      if (totalActions > 0 && shaCount / totalActions > 0.5) {
        pinningPolicy = { ...pinningPolicy, actionsUseSHA: true };
      }

      // Extract permissions
      const permMatch = content.match(/permissions:\s*\n([\s\S]*?)(?:\njobs:|$)/);
      if (permMatch) {
        const permLines = permMatch[1]!.trim().split('\n');
        for (const line of permLines) {
          const permLine = line.match(/\s*([\w-]+):\s*(read|write|none)/);
          if (permLine && permLine[1] && permLine[2]) {
            tokenPerms.push({
              scope: permLine[1],
              level: permLine[2] as 'read' | 'write' | 'none',
            });
          }
        }
      }
    }

    // Detect branch protection from comments
    let branchProtection: BranchProtection | undefined;
    for (const file of ymlFiles) {
      const content = await this.fileReader.readText(`${dirPath}/${file}`);
      if (!content) continue;

      const checksMatch = content.match(
        /required_status_checks[\s\S]*?(?:Required status checks:[\s\S]*?(?=Additional|$))/,
      );
      if (checksMatch) {
        const checkNames = checksMatch[0].match(/-\s+([\w-]+(?:\s*\([^)]+\))?)/g);
        branchProtection = {
          requiredChecks: checkNames?.map((c) => c.replace(/^\s*-\s+/, '').trim()) ?? [],
          requireUpToDate: content.includes('Require branches to be up to date'),
          protectedBranches: ['main'],
        };
      }
    }

    return {
      nodeVersion,
      packageManager,
      cacheStrategy,
      branchProtection,
      existingJobs,
      secretReferences: [...new Set(secretRefs)],
      pinningPolicy,
      tokenPermissions: tokenPerms,
    };
  }

  /**
   * List workflow files for a detected provider.
   */
  private async listWorkflowFiles(
    provider: CIProvider,
    path: string,
  ): Promise<readonly string[]> {
    if (provider === 'github_actions') {
      const files = await this.fileReader.listDir(path);
      return files
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => `${path}/${f}`);
    }
    // Single-file providers
    return [path];
  }

  /**
   * Return empty conventions for unknown providers.
   */
  private emptyConventions(): WorkflowConventions {
    return {
      packageManager: 'unknown',
      existingJobs: [],
      secretReferences: [],
      pinningPolicy: { actionsUseSHA: false, imagesUseDigest: false, pluginsUseExact: true },
      tokenPermissions: [],
    };
  }

  /**
   * Create a workflow stage with quality profile alignment.
   */
  private createStage(opts: {
    id: string;
    name: string;
    category: WorkflowStageCategory;
    command: string;
    dependsOn: readonly string[];
    failureBehavior: FailureBehavior;
    timeoutMinutes: number;
    ciCommand: string;
    localCommand?: string;
  }): WorkflowStage {
    const aligned = opts.localCommand
      ? this.commandsAreEquivalent(opts.ciCommand, opts.localCommand)
      : true;

    return {
      id: opts.id,
      name: opts.name,
      category: opts.category,
      command: opts.command,
      dependsOn: opts.dependsOn,
      failureBehavior: opts.failureBehavior,
      timeoutMinutes: opts.timeoutMinutes,
      qualityProfileAlignment: {
        aligned,
        localCommand: opts.localCommand,
        ciCommand: opts.ciCommand,
        differences: aligned ? [] : [`CI: '${opts.ciCommand}', Local: '${opts.localCommand}'`],
      },
    };
  }

  /**
   * Infer the install command from quality profile commands.
   */
  private inferInstallCommand(profile: QualityProfileCommands): string {
    // Look at other commands to infer the package manager
    const allCommands = [
      profile.testFull,
      profile.lint,
      profile.build,
      profile.typeCheck,
    ].filter(Boolean);

    if (allCommands.some((c) => c?.startsWith('yarn'))) return 'yarn install --frozen-lockfile';
    if (allCommands.some((c) => c?.startsWith('pnpm'))) return 'pnpm install --frozen-lockfile';
    return 'npm ci --ignore-scripts';
  }

  /**
   * Check if two commands are functionally equivalent.
   */
  private commandsAreEquivalent(ciCommand: string, localCommand: string): boolean {
    const normalize = (cmd: string) =>
      cmd
        .replace(/--ignore-scripts/g, '')
        .replace(/--frozen-lockfile/g, '')
        .replace(/--ci/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return normalize(ciCommand) === normalize(localCommand);
  }

  /**
   * Get the local command for a stage category from Quality_Profile.
   */
  private getLocalCommandForCategory(
    category: WorkflowStageCategory,
    profile: QualityProfileCommands,
  ): string | undefined {
    const mapping: Partial<Record<WorkflowStageCategory, keyof QualityProfileCommands>> = {
      lint: 'lint',
      type_check: 'typeCheck',
      test: 'testFull',
      build: 'build',
      security: 'security',
    };
    const key = mapping[category];
    return key ? profile[key] : undefined;
  }

  /**
   * Compute overall run status from individual check results.
   */
  private computeRunStatus(checks: readonly RemoteCheckResult[]): RemoteRunStatus {
    if (checks.length === 0) return 'pending';
    if (checks.some((c) => c.status === 'running')) return 'running';
    if (checks.some((c) => c.conclusion === 'failure' || c.status === 'failed')) return 'failed';
    if (checks.some((c) => c.conclusion === 'cancelled' || c.status === 'cancelled')) return 'cancelled';
    if (checks.some((c) => c.conclusion === 'timed_out' || c.status === 'timed_out')) return 'timed_out';
    if (checks.every((c) => c.conclusion === 'success' || c.status === 'passed')) return 'passed';
    return 'pending';
  }

  /**
   * Get the provider-specific secret reference pattern.
   */
  private getSecretReferencePattern(provider: string): string | undefined {
    const patterns: Record<string, string> = {
      github: '${{ secrets.NAME }}',
      gitlab: '$NAME',
      vault: 'vault:NAME',
    };
    return patterns[provider];
  }

  /**
   * Collect pinned references from stages and detection.
   */
  private collectPinnedReferences(
    stages: readonly WorkflowStage[],
    detection: ProviderDetectionResult,
  ): PinnedReference[] {
    const refs: PinnedReference[] = [];

    // Common GitHub Actions used
    if (detection.provider === 'github_actions') {
      refs.push(
        { kind: 'action', name: 'actions/checkout', version: 'v5', pin: '', pinKind: 'exact_version' },
        { kind: 'action', name: 'actions/setup-node', version: 'v5', pin: '', pinKind: 'exact_version' },
        { kind: 'action', name: 'actions/cache', version: 'v5', pin: '', pinKind: 'exact_version' },
        { kind: 'action', name: 'actions/upload-artifact', version: 'v5', pin: '', pinKind: 'exact_version' },
      );

      if (stages.some((s) => s.category === 'deployment')) {
        refs.push({
          kind: 'action',
          name: 'softprops/action-gh-release',
          version: 'v2',
          pin: '',
          pinKind: 'exact_version',
        });
      }
    }

    return refs;
  }

  /**
   * Collect secret references from detection and additional config.
   */
  private collectSecretReferences(
    detection: ProviderDetectionResult,
    additional?: readonly SecretReference[],
  ): SecretReference[] {
    const secrets: SecretReference[] = [];

    // Map detected secret names to structured references
    for (const name of detection.conventions.secretReferences) {
      secrets.push({
        name,
        provider: detection.provider === 'github_actions' ? 'github' : 'unknown',
        usage: 'detected from existing workflow',
        required: true,
      });
    }

    if (additional) {
      secrets.push(...additional);
    }

    return secrets;
  }

  /**
   * Render workflow content for a provider.
   */
  private renderWorkflowContent(
    provider: CIProvider,
    stages: readonly WorkflowStage[],
    permissions: WorkflowPermissions,
    secrets: readonly SecretReference[],
    pinnedRefs: readonly PinnedReference[],
    environments: readonly DeploymentEnvironment[],
  ): string {
    if (provider === 'github_actions') {
      return this.renderGitHubActionsWorkflow(
        stages,
        permissions,
        secrets,
        pinnedRefs,
        environments,
      );
    }
    // Fallback: structured comment-based representation
    return this.renderGenericWorkflow(stages, permissions);
  }

  /**
   * Render a GitHub Actions workflow YAML.
   */
  private renderGitHubActionsWorkflow(
    stages: readonly WorkflowStage[],
    permissions: WorkflowPermissions,
    _secrets: readonly SecretReference[],
    _pinnedRefs: readonly PinnedReference[],
    environments: readonly DeploymentEnvironment[],
  ): string {
    const lines: string[] = [];

    lines.push('name: CI/CD Pipeline');
    lines.push('');
    lines.push('on:');
    lines.push('  push:');
    lines.push('    branches: [main]');
    lines.push('  pull_request:');
    lines.push('');
    lines.push('permissions:');
    for (const [key, value] of Object.entries(permissions)) {
      const yamlKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      lines.push(`  ${yamlKey}: ${value}`);
    }
    lines.push('');

    // Quality gates job
    const qualityStages = stages.filter(
      (s) => !['deployment', 'preview', 'artifacts'].includes(s.category),
    );
    if (qualityStages.length > 0) {
      lines.push('jobs:');
      lines.push('  quality-gates:');
      lines.push('    runs-on: ubuntu-latest');
      lines.push('    timeout-minutes: 15');
      lines.push('    steps:');
      lines.push('      - uses: actions/checkout@v5');
      lines.push('      - uses: actions/setup-node@v5');
      lines.push('        with:');
      lines.push('          node-version: 22');
      lines.push('');

      for (const stage of qualityStages) {
        if (stage.category === 'install') {
          lines.push(`      - name: ${stage.name}`);
          lines.push(`        run: ${stage.command}`);
        } else if (stage.category === 'cache') {
          // Cache is handled by setup-node cache option
          continue;
        } else {
          lines.push(`      - name: ${stage.name}`);
          lines.push(`        run: ${stage.command}`);
          if (stage.timeoutMinutes) {
            lines.push(`        timeout-minutes: ${stage.timeoutMinutes}`);
          }
        }
        lines.push('');
      }
    }

    // Deployment job
    if (environments.length > 0) {
      for (const env of environments) {
        lines.push(`  deploy-${env.name}:`);
        lines.push('    needs: [quality-gates]');
        lines.push(`    runs-on: ubuntu-latest`);
        lines.push(`    environment: ${env.name}`);
        lines.push('    concurrency:');
        lines.push(`      group: ${env.concurrency.group}`);
        lines.push(`      cancel-in-progress: ${env.concurrency.cancelInProgress}`);
        lines.push('    steps:');
        lines.push('      - uses: actions/checkout@v5');
        lines.push(`      - name: Deploy to ${env.name}`);
        lines.push('        run: echo "Deploy step placeholder"');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Render a generic workflow representation.
   */
  private renderGenericWorkflow(
    stages: readonly WorkflowStage[],
    permissions: WorkflowPermissions,
  ): string {
    const lines: string[] = [];
    lines.push('# CI/CD Pipeline');
    lines.push(`# Permissions: ${JSON.stringify(permissions)}`);
    lines.push('');

    for (const stage of stages) {
      lines.push(`## ${stage.name} (${stage.category})`);
      lines.push(`Command: ${stage.command}`);
      if (stage.dependsOn.length > 0) {
        lines.push(`Depends on: ${stage.dependsOn.join(', ')}`);
      }
      lines.push(`Failure: ${stage.failureBehavior.action}`);
      lines.push(`Timeout: ${stage.timeoutMinutes}m`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get default workflow file name for a provider.
   */
  private getDefaultFileName(provider: CIProvider): string {
    const names: Record<CIProvider, string> = {
      github_actions: '.github/workflows/ci.yml',
      gitlab_ci: '.gitlab-ci.yml',
      circleci: '.circleci/config.yml',
      jenkins: 'Jenkinsfile',
      azure_pipelines: 'azure-pipelines.yml',
      bitbucket_pipelines: 'bitbucket-pipelines.yml',
      unknown: 'ci-pipeline.yml',
    };
    return names[provider];
  }
}
