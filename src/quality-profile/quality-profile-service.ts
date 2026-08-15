/**
 * QualityProfileService — Detects or defines quality commands, captures baselines,
 * selects targeted checks, correlates diagnostics, detects flakes, and routes
 * check-created files through Change_Set review or rollback.
 *
 * Requirements: 31.1, 31.2, 31.3, 31.4, 31.5, 31.6, 31.7, 31.8, 31.9, 31.10
 */

import { randomUUID } from 'crypto';
import type {
  QualityProfile,
  QualityCommand,
  QualityCheckCategory,
  GatePolicy,
  QualityBaseline,
  BaselineFailure,
  DiagnosticIdentity,
  CorrelatedDiagnostic,
  FlakyTestRecord,
  CheckSelectionInput,
  SelectedCheck,
  CheckSelectionReason,
  QualityCheckResult,
  QualityCheckOutcome,
  QualityCheckProgress,
  IsolatedGateConfig,
  IsolatedGateResult,
} from './types';

// ─── Adapters ──────────────────────────────────────────────────────────────

/**
 * Adapter for detecting project commands from workspace files.
 */
export interface CommandDetector {
  detect(workspacePath: string): Promise<DetectedCommands>;
}

export interface DetectedCommands {
  readonly testTargeted?: string;
  readonly testFull?: string;
  readonly typeCheck?: string;
  readonly lint?: string;
  readonly format?: string;
  readonly build?: string;
  readonly package?: string;
  readonly security?: string;
  readonly smoke?: string;
}

/**
 * Adapter for executing quality check commands.
 */
export interface QualityCheckExecutor {
  execute(
    command: QualityCommand,
    workspacePath: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<QualityExecutionResult>;
}

export interface QualityExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly modifiedFiles: readonly string[];
  readonly timedOut: boolean;
}

/**
 * Adapter for Change_Set creation for check-modified files.
 */
export interface CheckMutationRouter {
  routeToChangeSet(
    taskId: string,
    runId: string,
    files: readonly string[],
    source: string,
  ): Promise<string>;
  rollback(files: readonly string[], workspaceRevision: string): Promise<void>;
}

/**
 * Adapter for streaming progress updates to chat.
 */
export interface ProgressStreamer {
  streamProgress(progress: QualityCheckProgress): void;
  streamSummary(summary: string): void;
}

/**
 * Adapter for isolated runtime execution.
 */
export interface IsolatedRuntimeExecutor {
  executeInIsolation(
    command: QualityCommand,
    config: IsolatedGateConfig,
  ): Promise<QualityExecutionResult>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Maximum bounded output stored per check result. */
export const MAX_BOUNDED_OUTPUT = 10_000;

/** Maximum retries for flake detection. */
export const MAX_FLAKE_RETRIES = 3;

/** Default timeout for quality commands (60s). */
export const DEFAULT_TIMEOUT_MS = 60_000;

// ─── Errors ────────────────────────────────────────────────────────────────

export class ProfileNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Quality profile not found for workspace '${workspaceId}'`);
    this.name = 'ProfileNotFoundError';
  }
}

export class BaselineCaptureError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly reason: string,
  ) {
    super(`Failed to capture baseline for workspace '${workspaceId}': ${reason}`);
    this.name = 'BaselineCaptureError';
  }
}

export class IsolatedGateError extends Error {
  constructor(
    public readonly runtimeProfileId: string,
    public readonly reason: string,
  ) {
    super(`Isolated gate execution failed in runtime '${runtimeProfileId}': ${reason}`);
    this.name = 'IsolatedGateError';
  }
}

// ─── QualityProfileService ─────────────────────────────────────────────────

/**
 * Manages quality profiles, baselines, targeted check selection,
 * diagnostic correlation, flake detection, and isolated gate execution.
 */
export class QualityProfileService {
  private readonly profiles: Map<string, QualityProfile> = new Map();
  private readonly baselines: Map<string, QualityBaseline> = new Map();
  private readonly checkResults: Map<string, QualityCheckResult> = new Map();
  private readonly correlatedDiagnostics: Map<string, CorrelatedDiagnostic> = new Map();
  private readonly flakyTests: Map<string, FlakyTestRecord> = new Map();
  private readonly isolatedResults: Map<string, IsolatedGateResult> = new Map();

  constructor(
    private readonly commandDetector: CommandDetector,
    private readonly executor: QualityCheckExecutor,
    private readonly mutationRouter: CheckMutationRouter,
    private readonly progressStreamer: ProgressStreamer,
    private readonly isolatedExecutor: IsolatedRuntimeExecutor,
  ) {}

  // ─── Profile Detection and Management (R31.1) ──────────────────

  /**
   * Detect or define the quality commands for a workspace.
   * Scans package.json, Makefile, pyproject.toml, etc. for commands.
   */
  async detectOrDefineProfile(
    workspaceId: string,
    workspacePath: string,
    overrides?: Partial<Record<QualityCheckCategory, string>>,
  ): Promise<QualityProfile> {
    const detected = await this.commandDetector.detect(workspacePath);
    const commands = this.buildCommands(detected, overrides);
    const now = new Date().toISOString();

    const profile: QualityProfile = {
      workspaceId,
      version: (this.profiles.get(workspaceId)?.version ?? 0) + 1,
      commands,
      detectedAt: now,
      configuredAt: now,
      fingerprint: this.computeProfileFingerprint(commands),
    };

    this.profiles.set(workspaceId, profile);
    return profile;
  }

  /**
   * Get the current quality profile for a workspace.
   */
  getProfile(workspaceId: string): QualityProfile | null {
    return this.profiles.get(workspaceId) ?? null;
  }

  /**
   * Update a specific command in the profile.
   */
  updateCommand(
    workspaceId: string,
    category: QualityCheckCategory,
    updates: Partial<Pick<QualityCommand, 'command' | 'args' | 'timeoutMs' | 'gatePolicy'>>,
  ): QualityProfile | null {
    const profile = this.profiles.get(workspaceId);
    if (!profile) return null;

    const updatedCommands = profile.commands.map((cmd) => {
      if (cmd.category === category) {
        return { ...cmd, ...updates };
      }
      return cmd;
    });

    const updated: QualityProfile = {
      ...profile,
      version: profile.version + 1,
      commands: updatedCommands,
      configuredAt: new Date().toISOString(),
      fingerprint: this.computeProfileFingerprint(updatedCommands),
    };

    this.profiles.set(workspaceId, updated);
    return updated;
  }

  // ─── Baseline Capture (R31.2) ──────────────────────────────────

  /**
   * Capture a baseline of pre-existing failures before modification.
   * This distinguishes regressions from pre-existing problems.
   */
  async captureBaseline(
    workspaceId: string,
    workspacePath: string,
    workspaceRevision: string,
  ): Promise<QualityBaseline> {
    const profile = this.profiles.get(workspaceId);
    if (!profile) {
      throw new ProfileNotFoundError(workspaceId);
    }

    const failures: BaselineFailure[] = [];

    for (const command of profile.commands) {
      if (command.gatePolicy === 'disabled') continue;

      try {
        const result = await this.executor.execute(command, workspacePath);

        if (result.exitCode !== 0) {
          const diagnostics = this.extractDiagnostics(
            result.stdout + '\n' + result.stderr,
            workspaceRevision,
          );

          failures.push({
            category: command.category,
            commandId: command.id,
            exitCode: result.exitCode,
            diagnosticIdentities: diagnostics,
            summary: this.buildCheckSummary(command, result.exitCode, result.stdout),
          });
        }
      } catch (error) {
        // Record the detection failure but don't block baseline capture
        failures.push({
          category: command.category,
          commandId: command.id,
          exitCode: -1,
          diagnosticIdentities: [],
          summary: `Baseline capture failed: ${(error as Error).message}`,
        });
      }
    }

    const baseline: QualityBaseline = {
      id: randomUUID(),
      workspaceId,
      workspaceRevision,
      capturedAt: new Date().toISOString(),
      failures,
      fingerprint: this.computeBaselineFingerprint(failures),
    };

    this.baselines.set(workspaceId, baseline);
    return baseline;
  }

  /**
   * Get the current baseline for a workspace.
   */
  getBaseline(workspaceId: string): QualityBaseline | null {
    return this.baselines.get(workspaceId) ?? null;
  }

  /**
   * Check if a diagnostic was already failing in the baseline.
   */
  isBaselineFailure(workspaceId: string, diagnostic: DiagnosticIdentity): boolean {
    const baseline = this.baselines.get(workspaceId);
    if (!baseline) return false;

    return baseline.failures.some((f) =>
      f.diagnosticIdentities.some((d) => d.fingerprint === diagnostic.fingerprint),
    );
  }

  // ─── Targeted Check Selection (R31.3) ──────────────────────────

  /**
   * Select which targeted checks to run based on changed files,
   * dependency impact, acceptance criteria, and configuration.
   */
  selectTargetedChecks(
    workspaceId: string,
    input: CheckSelectionInput,
  ): readonly SelectedCheck[] {
    const profile = this.profiles.get(workspaceId);
    if (!profile) return [];

    const selected: SelectedCheck[] = [];
    const allAffectedFiles = [...new Set([...input.changedFiles, ...input.impactedFiles])];

    for (const command of profile.commands) {
      if (command.gatePolicy === 'disabled') continue;

      const reasons = this.matchCheckToInput(command, input, allAffectedFiles);

      if (reasons.length > 0) {
        selected.push({
          command,
          reason: reasons[0]!, // Primary reason (safe: length > 0)
          targetFiles: this.filterTargetFiles(command, allAffectedFiles),
        });
      } else if (command.gatePolicy === 'mandatory') {
        // Mandatory gates always run
        selected.push({
          command,
          reason: 'mandatory_gate',
          targetFiles: allAffectedFiles,
        });
      }
    }

    return selected;
  }

  // ─── Continuous Check Execution (R31.3, R31.5) ─────────────────

  /**
   * Execute a targeted check, streaming progress summaries while
   * preserving bounded full logs as evidence.
   */
  async executeCheck(
    command: QualityCommand,
    workspacePath: string,
    params: {
      workspaceRevision: string;
      taskId?: string | undefined;
      runId?: string | undefined;
      changeSetId?: string | undefined;
      runtimeProfileId?: string | undefined;
    },
  ): Promise<QualityCheckResult> {
    const startedAt = new Date().toISOString();

    // Stream initial progress
    this.progressStreamer.streamProgress({
      commandId: command.id,
      category: command.category,
      status: 'running',
      elapsedMs: 0,
      summaryLine: `Running ${command.description}...`,
      outputLines: 0,
    });

    let result: QualityExecutionResult;
    try {
      result = await this.executor.execute(command, workspacePath);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const failedResult = this.buildCheckResult(
        command,
        { exitCode: -1, stdout: '', stderr: (error as Error).message, startedAt, finishedAt, modifiedFiles: [], timedOut: false },
        {
          workspaceRevision: params.workspaceRevision,
          runtimeProfileId: params.runtimeProfileId,
          taskId: params.taskId,
          runId: params.runId,
          changeSetId: params.changeSetId,
        },
        'blocked',
      );
      this.checkResults.set(failedResult.id, failedResult);

      this.progressStreamer.streamProgress({
        commandId: command.id,
        category: command.category,
        status: 'failed',
        elapsedMs: Date.now() - new Date(startedAt).getTime(),
        summaryLine: `${command.description} failed: ${(error as Error).message}`,
        outputLines: 0,
      });

      return failedResult;
    }

    // Determine outcome
    const outcome = this.determineCheckOutcome(result);

    // Build the result
    const checkResult = this.buildCheckResult(
      command,
      result,
      {
        workspaceRevision: params.workspaceRevision,
        runtimeProfileId: params.runtimeProfileId,
        taskId: params.taskId,
        runId: params.runId,
        changeSetId: params.changeSetId,
      },
      outcome,
    );
    this.checkResults.set(checkResult.id, checkResult);

    // Handle file modifications (R31.10)
    if (result.modifiedFiles.length > 0 && params.taskId && params.runId) {
      await this.routeModifiedFiles(
        checkResult,
        result.modifiedFiles,
        params.taskId,
        params.runId,
        params.workspaceRevision,
      );
    }

    // Stream final summary (R31.5)
    this.progressStreamer.streamProgress({
      commandId: command.id,
      category: command.category,
      status: outcome === 'pass' ? 'completed' : 'failed',
      elapsedMs: new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime(),
      summaryLine: checkResult.summary,
      outputLines: (result.stdout + result.stderr).split('\n').length,
    });

    this.progressStreamer.streamSummary(checkResult.summary);

    return checkResult;
  }

  // ─── Diagnostics Correlation (R31.6, R31.7, R31.8) ────────────

  /**
   * Correlate a diagnostic to its exact identity (URI, revision, version).
   * Ignores stale, duplicate, and already-resolved diagnostics.
   */
  correlateDiagnostic(
    diagnostic: DiagnosticIdentity,
    context: {
      workspaceId: string;
      changeSetId?: string;
      taskId?: string;
      runId?: string;
    },
  ): CorrelatedDiagnostic | null {
    const existing = this.correlatedDiagnostics.get(diagnostic.fingerprint);

    // Check if this is a duplicate of an already-tracked diagnostic
    if (existing) {
      if (existing.state === 'resolved') {
        // Already resolved — don't trigger a fix (R31.8)
        return null;
      }
      if (existing.state === 'stale') {
        // Stale — don't trigger a fix (R31.8)
        return null;
      }
      // Update last seen
      const updated: CorrelatedDiagnostic = {
        ...existing,
        lastSeenAt: new Date().toISOString(),
      };
      this.correlatedDiagnostics.set(diagnostic.fingerprint, updated);
      return null; // Duplicate — already tracked
    }

    // Check if this is a baseline failure
    if (context.workspaceId && this.isBaselineFailure(context.workspaceId, diagnostic)) {
      const baselineDiag: CorrelatedDiagnostic = {
        identity: diagnostic,
        state: 'baseline',
        changeSetId: context.changeSetId,
        taskId: context.taskId,
        runId: context.runId,
        remediationAttempts: 0,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      this.correlatedDiagnostics.set(diagnostic.fingerprint, baselineDiag);
      return null; // Baseline failure — don't trigger fix
    }

    // New active diagnostic
    const correlated: CorrelatedDiagnostic = {
      identity: diagnostic,
      state: 'active',
      changeSetId: context.changeSetId,
      taskId: context.taskId,
      runId: context.runId,
      remediationAttempts: 0,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };

    this.correlatedDiagnostics.set(diagnostic.fingerprint, correlated);
    return correlated;
  }

  /**
   * Mark a diagnostic as resolved.
   */
  resolveDiagnostic(fingerprint: string): void {
    const existing = this.correlatedDiagnostics.get(fingerprint);
    if (existing) {
      this.correlatedDiagnostics.set(fingerprint, {
        ...existing,
        state: 'resolved',
        lastSeenAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Mark a diagnostic as stale (e.g., revision changed).
   */
  staleDiagnostic(fingerprint: string): void {
    const existing = this.correlatedDiagnostics.get(fingerprint);
    if (existing) {
      this.correlatedDiagnostics.set(fingerprint, {
        ...existing,
        state: 'stale',
        lastSeenAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Increment remediation attempts for a diagnostic.
   */
  recordRemediationAttempt(fingerprint: string): void {
    const existing = this.correlatedDiagnostics.get(fingerprint);
    if (existing) {
      this.correlatedDiagnostics.set(fingerprint, {
        ...existing,
        remediationAttempts: existing.remediationAttempts + 1,
        lastSeenAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Get all active (non-stale, non-resolved, non-duplicate) diagnostics.
   */
  getActiveDiagnostics(): readonly CorrelatedDiagnostic[] {
    return Array.from(this.correlatedDiagnostics.values()).filter(
      (d) => d.state === 'active',
    );
  }

  /**
   * Get diagnostics correlated to a specific change set, task, or run.
   */
  getDiagnosticsForEntity(params: {
    changeSetId?: string;
    taskId?: string;
    runId?: string;
  }): readonly CorrelatedDiagnostic[] {
    return Array.from(this.correlatedDiagnostics.values()).filter((d) => {
      if (params.changeSetId && d.changeSetId === params.changeSetId) return true;
      if (params.taskId && d.taskId === params.taskId) return true;
      if (params.runId && d.runId === params.runId) return true;
      return false;
    });
  }

  // ─── Flaky Test Detection (R31.9) ─────────────────────────────

  /**
   * Detect flaky tests by comparing retries. A test that fails then passes
   * on retry is reported separately rather than as an unqualified success.
   */
  async detectFlakes(
    command: QualityCommand,
    workspacePath: string,
    params: { workspaceRevision: string; taskId?: string; runId?: string },
  ): Promise<{ result: QualityCheckResult; flakes: readonly FlakyTestRecord[] }> {
    const firstRun = await this.executeCheck(command, workspacePath, params);

    if (firstRun.outcome === 'pass') {
      return { result: firstRun, flakes: [] };
    }

    // Retry to detect flakiness
    const detectedFlakes: FlakyTestRecord[] = [];
    let retryResult = firstRun;

    for (let retry = 0; retry < MAX_FLAKE_RETRIES; retry++) {
      retryResult = await this.executeCheck(command, workspacePath, params);

      if (retryResult.outcome === 'pass') {
        // The test passed on retry — this is a flake
        const flakeRecord: FlakyTestRecord = {
          testId: `${command.id}-retry-${retry}`,
          testName: command.description,
          uri: command.cwd ?? workspacePath,
          category: command.category,
          passCount: 1,
          failCount: retry + 1,
          totalRetries: retry + 1,
          lastFlakeAt: new Date().toISOString(),
          reportedSeparately: true,
        };

        detectedFlakes.push(flakeRecord);
        this.flakyTests.set(flakeRecord.testId, flakeRecord);

        // Mark the result as flaky, not a clean pass (R31.9)
        const flakyResult: QualityCheckResult = {
          ...retryResult,
          outcome: 'flaky',
          isRetryPass: true,
          retryCount: retry + 1,
          summary: `${command.description}: flaky (passed on retry ${retry + 1}/${MAX_FLAKE_RETRIES})`,
        };

        this.checkResults.set(flakyResult.id, flakyResult);
        return { result: flakyResult, flakes: detectedFlakes };
      }
    }

    // All retries failed — genuine failure
    return { result: retryResult, flakes: [] };
  }

  /**
   * Get all known flaky tests.
   */
  getFlakyTests(): readonly FlakyTestRecord[] {
    return Array.from(this.flakyTests.values());
  }

  /**
   * Check if a test is known to be flaky.
   */
  isFlaky(testId: string): boolean {
    return this.flakyTests.has(testId);
  }

  // ─── Isolated Runtime_Profile Gate Execution (R31.4) ──────────

  /**
   * Run every mandatory gate in an isolated reproducible Runtime_Profile.
   * Route check-created files through Change_Set review or rollback (R31.10).
   */
  async runIsolatedGates(
    config: IsolatedGateConfig,
    _workspacePath: string,
    context: { taskId?: string | undefined; runId?: string | undefined },
  ): Promise<IsolatedGateResult> {
    const startedAt = new Date().toISOString();
    const results: QualityCheckResult[] = [];
    const allModifiedFiles: string[] = [];
    let allPassed = true;

    for (const command of config.commands) {
      if (command.gatePolicy !== 'mandatory') continue;

      try {
        const execResult = await this.isolatedExecutor.executeInIsolation(command, config);
        const outcome = this.determineCheckOutcome(execResult);
        const checkResult = this.buildCheckResult(
          command,
          execResult,
          {
            workspaceRevision: config.workspaceRevision,
            runtimeProfileId: config.runtimeProfileId,
            taskId: context.taskId,
            runId: context.runId,
          },
          outcome,
        );

        results.push(checkResult);
        this.checkResults.set(checkResult.id, checkResult);

        if (outcome !== 'pass' && outcome !== 'flaky') {
          allPassed = false;
        }

        if (execResult.modifiedFiles.length > 0) {
          allModifiedFiles.push(...execResult.modifiedFiles);
        }

        // Stream progress
        this.progressStreamer.streamProgress({
          commandId: command.id,
          category: command.category,
          status: outcome === 'pass' ? 'completed' : 'failed',
          elapsedMs:
            new Date(execResult.finishedAt).getTime() -
            new Date(execResult.startedAt).getTime(),
          summaryLine: checkResult.summary,
          outputLines: (execResult.stdout + execResult.stderr).split('\n').length,
        });
      } catch (error) {
        allPassed = false;
        const failResult: QualityCheckResult = {
          id: randomUUID(),
          commandId: command.id,
          category: command.category,
          workspaceRevision: config.workspaceRevision,
          runtimeProfileId: config.runtimeProfileId,
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: -1,
          outcome: 'blocked',
          summary: `${command.description}: blocked - ${(error as Error).message}`,
          boundedOutput: (error as Error).message,
          fullLogRef: undefined,
          modifiedFiles: [],
          diagnostics: [],
          changeSetId: undefined,
          taskId: context.taskId,
          runId: context.runId,
          retryCount: 0,
          isRetryPass: false,
          fingerprint: randomUUID(),
        };
        results.push(failResult);
        this.checkResults.set(failResult.id, failResult);
      }
    }

    // Route modified files through Change_Set review or rollback (R31.10)
    let routedToChangeSet = false;
    let changeSetId: string | undefined;
    let rolledBack = false;

    if (allModifiedFiles.length > 0) {
      if (context.taskId && context.runId) {
        try {
          changeSetId = await this.mutationRouter.routeToChangeSet(
            context.taskId,
            context.runId,
            allModifiedFiles,
            `isolated-gate:${config.runtimeProfileId}`,
          );
          routedToChangeSet = true;
        } catch {
          // Rollback modified files before finalizing gate result
          await this.mutationRouter.rollback(allModifiedFiles, config.workspaceRevision);
          rolledBack = true;
        }
      } else {
        // No task/run context — rollback
        await this.mutationRouter.rollback(allModifiedFiles, config.workspaceRevision);
        rolledBack = true;
      }
    }

    const finishedAt = new Date().toISOString();
    const gateResult: IsolatedGateResult = {
      id: randomUUID(),
      runtimeProfileId: config.runtimeProfileId,
      workspaceRevision: config.workspaceRevision,
      results,
      allPassed,
      modifiedFiles: allModifiedFiles,
      routedToChangeSet,
      changeSetId,
      rolledBack,
      startedAt,
      finishedAt,
      fingerprint: this.computeGateResultFingerprint(results),
    };

    this.isolatedResults.set(gateResult.id, gateResult);
    return gateResult;
  }

  // ─── Query Methods ─────────────────────────────────────────────

  /**
   * Get a check result by ID.
   */
  getCheckResult(id: string): QualityCheckResult | null {
    return this.checkResults.get(id) ?? null;
  }

  /**
   * Get all check results for a task.
   */
  getResultsForTask(taskId: string): readonly QualityCheckResult[] {
    return Array.from(this.checkResults.values()).filter((r) => r.taskId === taskId);
  }

  /**
   * Get all check results for a run.
   */
  getResultsForRun(runId: string): readonly QualityCheckResult[] {
    return Array.from(this.checkResults.values()).filter((r) => r.runId === runId);
  }

  /**
   * Get an isolated gate result by ID.
   */
  getIsolatedGateResult(id: string): IsolatedGateResult | null {
    return this.isolatedResults.get(id) ?? null;
  }

  // ─── Private Helpers ───────────────────────────────────────────

  /**
   * Build QualityCommand definitions from detected and override commands.
   */
  private buildCommands(
    detected: DetectedCommands,
    overrides?: Partial<Record<QualityCheckCategory, string>>,
  ): QualityCommand[] {
    const commands: QualityCommand[] = [];
    const categories: Array<{
      category: QualityCheckCategory;
      detectedKey: keyof DetectedCommands;
      defaultDescription: string;
      defaultGate: GatePolicy;
      patterns?: readonly string[];
      mayModify: boolean;
    }> = [
      { category: 'test_targeted', detectedKey: 'testTargeted', defaultDescription: 'Run targeted tests', defaultGate: 'mandatory', patterns: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'], mayModify: false },
      { category: 'test_full', detectedKey: 'testFull', defaultDescription: 'Run full test suite', defaultGate: 'mandatory', mayModify: false },
      { category: 'type_check', detectedKey: 'typeCheck', defaultDescription: 'Type check', defaultGate: 'mandatory', patterns: ['**/*.ts', '**/*.tsx'], mayModify: false },
      { category: 'lint', detectedKey: 'lint', defaultDescription: 'Lint check', defaultGate: 'mandatory', patterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'], mayModify: true },
      { category: 'format', detectedKey: 'format', defaultDescription: 'Format check', defaultGate: 'advisory', patterns: ['**/*'], mayModify: true },
      { category: 'build', detectedKey: 'build', defaultDescription: 'Build project', defaultGate: 'mandatory', mayModify: true },
      { category: 'package', detectedKey: 'package', defaultDescription: 'Package check', defaultGate: 'advisory', patterns: ['**/package.json', '**/package-lock.json', '**/yarn.lock'], mayModify: false },
      { category: 'security', detectedKey: 'security', defaultDescription: 'Security scan', defaultGate: 'mandatory', patterns: ['**/package.json', '**/package-lock.json'], mayModify: false },
      { category: 'smoke', detectedKey: 'smoke', defaultDescription: 'Smoke test', defaultGate: 'mandatory', mayModify: false },
    ];

    for (const cat of categories) {
      const commandStr =
        overrides?.[cat.category] ?? detected[cat.detectedKey];
      if (commandStr) {
        commands.push({
          id: `qp-${cat.category}`,
          category: cat.category,
          command: commandStr,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          gatePolicy: cat.defaultGate,
          description: cat.defaultDescription,
          targetPatterns: cat.patterns,
          mayModifyFiles: cat.mayModify,
        });
      }
    }

    return commands;
  }

  /**
   * Match a command to the selection input to determine relevance.
   */
  private matchCheckToInput(
    command: QualityCommand,
    input: CheckSelectionInput,
    allAffectedFiles: readonly string[],
  ): CheckSelectionReason[] {
    const reasons: CheckSelectionReason[] = [];

    // Check if changed files match the command's target patterns
    if (command.targetPatterns && command.targetPatterns.length > 0) {
      const hasMatch = allAffectedFiles.some((file) =>
        command.targetPatterns!.some((pattern) => this.matchesPattern(file, pattern)),
      );
      if (hasMatch) {
        reasons.push('changed_file_match');
      }
    }

    // Config changes always trigger related checks
    if (input.configChanges.length > 0) {
      const configPatterns = ['package.json', 'tsconfig.json', '.eslintrc', 'pyproject.toml', 'Makefile'];
      const hasConfigMatch = input.configChanges.some((f) =>
        configPatterns.some((p) => f.includes(p)),
      );
      if (hasConfigMatch) {
        reasons.push('config_change');
      }
    }

    // Check if impacted files trigger this check
    if (input.impactedFiles.length > 0 && command.targetPatterns) {
      const hasImpact = input.impactedFiles.some((file) =>
        command.targetPatterns!.some((pattern) => this.matchesPattern(file, pattern)),
      );
      if (hasImpact && !reasons.includes('changed_file_match')) {
        reasons.push('dependency_impact');
      }
    }

    // Check acceptance criteria keywords
    if (input.taskAcceptanceCriteria.length > 0) {
      const criteriaKeywords: Record<QualityCheckCategory, readonly string[]> = {
        test_targeted: ['test', 'unit test', 'spec'],
        test_full: ['test suite', 'all tests', 'regression'],
        type_check: ['type', 'typescript', 'type-safe'],
        lint: ['lint', 'code quality', 'eslint'],
        format: ['format', 'prettier', 'style'],
        build: ['build', 'compile', 'bundle'],
        package: ['package', 'dependency', 'npm'],
        security: ['security', 'vulnerability', 'audit'],
        smoke: ['smoke', 'integration', 'e2e'],
      };

      const keywords = criteriaKeywords[command.category] ?? [];
      const criteriaText = input.taskAcceptanceCriteria.join(' ').toLowerCase();
      const hasKeywordMatch = keywords.some((kw) => criteriaText.includes(kw));
      if (hasKeywordMatch) {
        reasons.push('acceptance_criteria');
      }
    }

    return reasons;
  }

  /**
   * Filter files relevant to a specific command based on target patterns.
   */
  private filterTargetFiles(
    command: QualityCommand,
    files: readonly string[],
  ): readonly string[] {
    if (!command.targetPatterns || command.targetPatterns.length === 0) {
      return files;
    }
    return files.filter((file) =>
      command.targetPatterns!.some((pattern) => this.matchesPattern(file, pattern)),
    );
  }

  /**
   * Simple glob pattern matching.
   */
  private matchesPattern(filePath: string, pattern: string): boolean {
    // Handle recursive glob prefix
    if (pattern.startsWith('**/')) {
      const suffix = pattern.slice(3);
      // Match any file path that matches the suffix portion
      return this.matchesPattern(filePath, suffix) ||
        this.matchesPattern(filePath.split('/').pop() ?? filePath, suffix);
    }

    // Handle simple extension match like *.ts
    if (pattern.startsWith('*.') && !pattern.slice(2).includes('*')) {
      const ext = pattern.slice(1); // e.g., ".ts"
      return filePath.endsWith(ext);
    }

    // Handle patterns like *.test.* or *.spec.*
    if (pattern.includes('*')) {
      // Convert glob pattern to a simple regex
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      try {
        const regex = new RegExp(regexStr);
        const fileName = filePath.split('/').pop() ?? filePath;
        return regex.test(fileName) || regex.test(filePath);
      } catch {
        // Fallback: simple substring matching
        const parts = pattern.split('*').filter(Boolean);
        let pos = 0;
        for (const part of parts) {
          const idx = filePath.indexOf(part, pos);
          if (idx === -1) return false;
          pos = idx + part.length;
        }
        return true;
      }
    }

    // Direct substring match
    return filePath.includes(pattern);
  }

  /**
   * Build a check result from execution data.
   */
  private buildCheckResult(
    command: QualityCommand,
    result: QualityExecutionResult,
    params: {
      workspaceRevision: string;
      runtimeProfileId: string | undefined;
      taskId: string | undefined;
      runId: string | undefined;
      changeSetId?: string | undefined;
    },
    outcome: QualityCheckOutcome,
  ): QualityCheckResult {
    const combinedOutput = result.stdout + (result.stderr ? '\n' + result.stderr : '');
    const boundedOutput = this.truncateOutput(combinedOutput);
    const diagnostics = this.extractDiagnostics(combinedOutput, params.workspaceRevision);

    return {
      id: randomUUID(),
      commandId: command.id,
      category: command.category,
      workspaceRevision: params.workspaceRevision,
      runtimeProfileId: params.runtimeProfileId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      exitCode: result.exitCode,
      outcome,
      summary: this.buildCheckSummary(command, result.exitCode, combinedOutput),
      boundedOutput,
      fullLogRef: undefined,
      modifiedFiles: [...result.modifiedFiles],
      diagnostics,
      changeSetId: params.changeSetId,
      taskId: params.taskId,
      runId: params.runId,
      retryCount: 0,
      isRetryPass: false,
      fingerprint: this.computeCheckFingerprint(command, params.workspaceRevision, result.exitCode),
    };
  }

  /**
   * Determine the outcome of a check execution.
   */
  private determineCheckOutcome(result: QualityExecutionResult): QualityCheckOutcome {
    if (result.timedOut) return 'timeout';
    return result.exitCode === 0 ? 'pass' : 'fail';
  }

  /**
   * Route modified files through Change_Set review or rollback (R31.10).
   */
  private async routeModifiedFiles(
    checkResult: QualityCheckResult,
    modifiedFiles: readonly string[],
    taskId: string,
    runId: string,
    workspaceRevision: string,
  ): Promise<void> {
    try {
      const changeSetId = await this.mutationRouter.routeToChangeSet(
        taskId,
        runId,
        modifiedFiles,
        `quality-check:${checkResult.id}`,
      );
      // Update the result with the change set reference
      const updated: QualityCheckResult = { ...checkResult, changeSetId };
      this.checkResults.set(checkResult.id, updated);
    } catch {
      // Rollback the modifications
      await this.mutationRouter.rollback(modifiedFiles, workspaceRevision);
    }
  }

  /**
   * Extract diagnostics from command output.
   */
  private extractDiagnostics(
    output: string,
    revision: string,
  ): DiagnosticIdentity[] {
    const diagnostics: DiagnosticIdentity[] = [];
    const lines = output.split('\n');

    // Match common diagnostic patterns:
    // TypeScript: src/file.ts(10,5): error TS2322: message
    // ESLint: src/file.ts:10:5 error message (rule)
    // Generic: file:line:col: severity: message
    const patterns = [
      /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)$/,
      /^(.+?):(\d+):(\d+)\s+(error|warning|info)\s+(.+?)\s+(\S+)$/,
      /^(.+?):(\d+):(\d+):\s*(error|warning|info|hint):\s*(.+?)(?:\s+\[(\S+)\])?$/,
    ];

    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const uri = match[1];
          const lineStr = match[2];
          const colStr = match[3];
          const severity = match[4];
          const rest = match.slice(5);

          if (!uri || !lineStr || !colStr || !severity) continue;

          const code = rest.length > 1 ? (rest[rest.length - 1] ?? '') : (rest[0] ?? '');
          const message = rest.length > 1 ? (rest[0] ?? '') : (rest[0] ?? '');

          const diag: DiagnosticIdentity = {
            uri: uri.trim(),
            revision,
            documentVersion: 0,
            line: parseInt(lineStr, 10),
            column: parseInt(colStr, 10),
            severity: severity as DiagnosticIdentity['severity'],
            source: 'quality-check',
            code: code.trim(),
            message: message.trim(),
            fingerprint: this.computeDiagnosticFingerprint(
              uri.trim(),
              parseInt(lineStr, 10),
              parseInt(colStr, 10),
              code.trim(),
              message.trim(),
            ),
          };
          diagnostics.push(diag);
          break;
        }
      }
    }

    return diagnostics;
  }

  /**
   * Build a human-readable summary for a check.
   */
  private buildCheckSummary(
    command: QualityCommand,
    exitCode: number,
    output: string,
  ): string {
    const status = exitCode === 0 ? 'passed' : 'failed';
    const lineCount = output.split('\n').length;
    return `${command.description}: ${status} (exit ${exitCode}, ${lineCount} output lines)`;
  }

  /**
   * Truncate output to bounded size.
   */
  private truncateOutput(output: string): string {
    if (output.length <= MAX_BOUNDED_OUTPUT) return output;
    return output.slice(0, MAX_BOUNDED_OUTPUT) + '\n... [truncated]';
  }

  /**
   * Compute a fingerprint for the quality profile.
   */
  private computeProfileFingerprint(commands: readonly QualityCommand[]): string {
    const data = JSON.stringify(commands.map((c) => ({ id: c.id, cmd: c.command, cat: c.category })));
    return `qp_${this.simpleHash(data)}`;
  }

  /**
   * Compute a fingerprint for a baseline.
   */
  private computeBaselineFingerprint(failures: readonly BaselineFailure[]): string {
    const data = JSON.stringify(failures.map((f) => ({ cat: f.category, exit: f.exitCode })));
    return `bl_${this.simpleHash(data)}`;
  }

  /**
   * Compute a fingerprint for a check result.
   */
  private computeCheckFingerprint(
    command: QualityCommand,
    revision: string,
    exitCode: number,
  ): string {
    return `cr_${this.simpleHash(`${command.id}:${revision}:${exitCode}`)}`;
  }

  /**
   * Compute a fingerprint for a gate result.
   */
  private computeGateResultFingerprint(results: readonly QualityCheckResult[]): string {
    const data = results.map((r) => `${r.commandId}:${r.outcome}`).join('|');
    return `gr_${this.simpleHash(data)}`;
  }

  /**
   * Compute a fingerprint for a diagnostic.
   */
  private computeDiagnosticFingerprint(
    uri: string,
    line: number,
    column: number,
    code: string,
    message: string,
  ): string {
    return `dg_${this.simpleHash(`${uri}:${line}:${column}:${code}:${message}`)}`;
  }

  /**
   * Simple string hash.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
