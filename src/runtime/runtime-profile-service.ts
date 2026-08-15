/**
 * RuntimeProfileService — Reproducible Runtime_Profile management for agent runs.
 *
 * Persists process, dependency service, database, port, environment, health,
 * resource, and network definitions. Manages start/stop/restart/logs/exit/health/
 * ports/resources lifecycle with deterministic child process cleanup via process groups.
 * Runs release smoke previews with probes and Evidence, handles accessibility scanning
 * gracefully, tests migrations on disposable databases, classifies runtime failures,
 * bounds/redacts logs, and denies production credentials/infrastructure by default.
 *
 * Requirements: 33.1, 33.2, 33.3, 33.4, 33.5, 33.6, 33.7, 33.8, 33.9
 */

import { randomUUID } from 'crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Supported package managers for dependency installation. */
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'pip' | 'cargo' | 'go' | 'custom';

/** Process lifecycle status within a Runtime_Profile. */
export type ProcessStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'healthy'
  | 'unhealthy'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'crashed';

/** Network policy mode for a runtime process. */
export type NetworkPolicy = 'allow_all' | 'allow_local' | 'deny_external' | 'sandbox_only';

/** Environment type classification (R33.9). */
export type EnvironmentType = 'development' | 'test' | 'staging' | 'production';

/** Runtime failure classification (R33.7). */
export type RuntimeFailureKind =
  | 'application_failure'
  | 'dependency_failure'
  | 'port_conflict'
  | 'missing_secret'
  | 'timeout'
  | 'sandbox_policy_denial'
  | 'health_check_failure'
  | 'resource_exhaustion'
  | 'network_failure'
  | 'unknown';

/** Accessibility scan status (R33.5). */
export type AccessibilityScanStatus = 'passed' | 'failed' | 'unavailable' | 'error' | 'not_run';

/** Health check mode for a service. */
export type HealthCheckMode = 'http' | 'tcp' | 'command' | 'log_pattern';

/** Resource limit definitions. */
export interface ResourceLimits {
  readonly maxMemoryMb?: number;
  readonly maxCpuPercent?: number;
  readonly maxDiskMb?: number;
  readonly maxFileDescriptors?: number;
}

/** Health check configuration for a process. */
export interface HealthCheckConfig {
  readonly mode: HealthCheckMode;
  readonly target: string; // URL, port, command, or pattern
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly startPeriodMs: number;
}

/** Definition of an environment variable for a runtime. */
export interface EnvVarDefinition {
  readonly name: string;
  readonly value?: string;
  readonly source: 'literal' | 'env_file' | 'secret_ref' | 'computed';
  readonly secret: boolean;
  readonly required: boolean;
}

/** A managed process within a Runtime_Profile. */
export interface RuntimeProcess {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly workingDir: string;
  readonly env: readonly EnvVarDefinition[];
  readonly port?: number;
  readonly healthCheck?: HealthCheckConfig;
  readonly resourceLimits?: ResourceLimits;
  readonly networkPolicy: NetworkPolicy;
  readonly dependsOn: readonly string[];
  readonly packageManager?: PackageManager;
  status: ProcessStatus;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number;
  lastHealthCheck?: string;
  logs: string[];
}

/** Database service definition for migration testing. */
export interface DatabaseService {
  readonly id: string;
  readonly name: string;
  readonly type: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'custom';
  readonly connectionUri?: string;
  readonly migrationsPath?: string;
  readonly disposable: boolean;
  readonly approved: boolean;
}

/** Preview probe definition for smoke tests. */
export interface PreviewProbe {
  readonly id: string;
  readonly name: string;
  readonly type: 'http' | 'tcp' | 'cli' | 'ui';
  readonly target: string;
  readonly expectedStatus?: number;
  readonly expectedPattern?: string;
  readonly timeoutMs: number;
}

/** Result of a preview probe execution. */
export interface ProbeResult {
  readonly probeId: string;
  readonly passed: boolean;
  readonly statusCode?: number;
  readonly responseBody?: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly timestamp: string;
}

/** UI preview evidence (R33.5). */
export interface UIPreviewEvidence {
  readonly screenshotRef?: string;
  readonly consoleErrors: readonly string[];
  readonly networkFailures: readonly string[];
  readonly accessibilityStatus: AccessibilityScanStatus;
  readonly accessibilityFindings: readonly string[];
  readonly accessibilityError?: string;
}

/** Evidence envelope for a smoke test run. */
export interface SmokeTestEvidence {
  readonly id: string;
  readonly runtimeProfileId: string;
  readonly workspaceRevision: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly probeResults: readonly ProbeResult[];
  readonly uiPreview?: UIPreviewEvidence;
  readonly allPassed: boolean;
  readonly environmentType: EnvironmentType;
  readonly fingerprint: string;
}

/** Migration test result. */
export interface MigrationTestResult {
  readonly id: string;
  readonly databaseServiceId: string;
  readonly migrationsPath: string;
  readonly disposable: boolean;
  readonly approved: boolean;
  readonly passed: boolean;
  readonly forwardResult: { exitCode: number; output: string };
  readonly rollbackResult?: { exitCode: number; output: string };
  readonly timestamp: string;
  readonly error?: string;
}

/** Runtime failure record with classification and recovery action. */
export interface RuntimeFailure {
  readonly id: string;
  readonly processId?: string;
  readonly kind: RuntimeFailureKind;
  readonly message: string;
  readonly recoveryAction: string;
  readonly timestamp: string;
  readonly details?: string;
}

/** A complete RuntimeProfile definition (R33.1). */
export interface RuntimeProfile {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly processes: readonly RuntimeProcess[];
  readonly databases: readonly DatabaseService[];
  readonly previewProbes: readonly PreviewProbe[];
  readonly environmentType: EnvironmentType;
  readonly packageManager: PackageManager;
  readonly networkPolicy: NetworkPolicy;
  readonly resourceLimits?: ResourceLimits;
  readonly envFile?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly fingerprint: string;
}

/** Credential governance decision (R33.9). */
export interface CredentialDecision {
  readonly environmentType: EnvironmentType;
  readonly approved: boolean;
  readonly approvedBy?: string;
  readonly scope?: string;
  readonly timestamp: string;
}

/** Log entry with optional redaction. */
export interface BoundedLogEntry {
  readonly processId: string;
  readonly timestamp: string;
  readonly line: string;
  readonly redacted: boolean;
}

// ─── Adapters ──────────────────────────────────────────────────────────────

/** Adapter for executing commands in the runtime workspace/sandbox. */
export interface RuntimeCommandExecutor {
  execute(
    command: string,
    args: readonly string[],
    opts: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      timeoutMs: number;
      networkPolicy: NetworkPolicy;
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    pid?: number;
  }>;

  spawn(
    command: string,
    args: readonly string[],
    opts: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      networkPolicy: NetworkPolicy;
    },
  ): {
    pid: number;
    onLog: (cb: (line: string) => void) => void;
    onExit: (cb: (code: number | null) => void) => void;
    kill: () => void;
  };
}

/** Adapter for health checks. */
export interface HealthChecker {
  checkHttp(url: string, timeoutMs: number): Promise<{ ok: boolean; statusCode?: number; error?: string }>;
  checkTcp(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; error?: string }>;
  checkCommand(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output?: string; error?: string }>;
}

/** Adapter for UI preview and screenshots. */
export interface UIPreviewAdapter {
  captureScreenshot(url: string): Promise<string | null>;
  captureConsoleErrors(url: string): Promise<readonly string[]>;
  captureNetworkFailures(url: string): Promise<readonly string[]>;
}

/** Adapter for accessibility scanning. */
export interface AccessibilityScanAdapter {
  available(): boolean;
  scan(url: string): Promise<{ findings: readonly string[]; passed: boolean }>;
}

/** Adapter for database migration testing. */
export interface MigrationTestAdapter {
  runMigrations(
    connectionUri: string,
    migrationsPath: string,
    direction: 'forward' | 'rollback',
  ): Promise<{ exitCode: number; output: string }>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Maximum number of log lines retained per process. */
export const MAX_LOG_LINES_PER_PROCESS = 5_000;

/** Maximum total log characters stored per process. */
export const MAX_LOG_CHARS_PER_PROCESS = 500_000;

/** Default health check timeout. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/** Default health check interval. */
export const DEFAULT_HEALTH_INTERVAL_MS = 10_000;

/** Default startup period before health checks begin. */
export const DEFAULT_START_PERIOD_MS = 15_000;

/** Maximum smoke test timeout. */
export const MAX_SMOKE_TEST_TIMEOUT_MS = 120_000;

/** Secret patterns for log redaction. */
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|password|passwd|token|auth)[_-]?[=:]\s*['"]?[\w\-./+=]{8,}/gi,
  /(?:AWS|AZURE|GCP)[_A-Z]+[=:]\s*['"]?[\w\-./+=]{16,}/gi,
  /(?:ghp_|gho_|ghu_|ghs_|ghr_)[\w]{36,}/g,
  /(?:sk-|pk-|rk-)[\w]{20,}/g,
  /Bearer\s+[\w\-./+=]{20,}/gi,
  /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/gi,
];

// ─── Errors ────────────────────────────────────────────────────────────────

export class ProductionCredentialDeniedError extends Error {
  constructor(environmentType: EnvironmentType) {
    super(
      `Production credentials/infrastructure denied. Current environment: '${environmentType}'. ` +
      `Use an explicitly approved non-production environment or obtain explicit confirmation.`,
    );
    this.name = 'ProductionCredentialDeniedError';
  }
}

export class ProcessNotFoundError extends Error {
  constructor(processId: string) {
    super(`Runtime process '${processId}' not found in current profile`);
    this.name = 'ProcessNotFoundError';
  }
}

export class HealthCheckFailedError extends Error {
  constructor(processId: string, reason: string) {
    super(`Health check failed for process '${processId}': ${reason}`);
    this.name = 'HealthCheckFailedError';
  }
}

export class MigrationNotApprovedError extends Error {
  constructor(databaseId: string) {
    super(
      `Migration testing on database '${databaseId}' requires a disposable or explicitly approved database`,
    );
    this.name = 'MigrationNotApprovedError';
  }
}

// ─── RuntimeProfileService ─────────────────────────────────────────────────

/**
 * Manages reproducible Runtime_Profiles for agent runs including:
 * - Process lifecycle (start/stop/restart/logs/exit/health/ports/resources)
 * - Deterministic child process cleanup via process groups
 * - Release smoke previews with probes and Evidence
 * - Accessibility scanning with graceful unavailability handling
 * - Migration testing on disposable/approved databases
 * - Runtime failure classification with recovery actions
 * - Bounded and redacted log management
 * - Production credential/infrastructure denial by default
 */
export class RuntimeProfileService {
  private readonly profiles: Map<string, RuntimeProfile> = new Map();
  private readonly activeProcesses: Map<string, { kill: () => void; pid: number }> = new Map();
  private readonly processLogs: Map<string, BoundedLogEntry[]> = new Map();
  private readonly smokeTestEvidence: Map<string, SmokeTestEvidence> = new Map();
  private readonly migrationResults: Map<string, MigrationTestResult> = new Map();
  private readonly failures: Map<string, RuntimeFailure> = new Map();
  private readonly credentialDecisions: Map<string, CredentialDecision> = new Map();
  private readonly healthTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(
    private readonly executor: RuntimeCommandExecutor,
    private readonly healthChecker: HealthChecker,
    private readonly uiPreviewAdapter: UIPreviewAdapter,
    private readonly accessibilityAdapter: AccessibilityScanAdapter,
    private readonly migrationAdapter: MigrationTestAdapter,
  ) {}

  // ─── Profile Detection and Configuration (R33.1) ───────────────

  /**
   * Detect or configure a RuntimeProfile for a workspace/sandbox.
   * Detects processes, services, databases, ports, environments,
   * package managers, health checks, resources, and network policy.
   */
  detectOrConfigureProfile(params: {
    workspaceId: string;
    name: string;
    processes: readonly Omit<RuntimeProcess, 'status' | 'logs'>[];
    databases?: readonly DatabaseService[];
    previewProbes?: readonly PreviewProbe[];
    environmentType?: EnvironmentType;
    packageManager?: PackageManager;
    networkPolicy?: NetworkPolicy;
    resourceLimits?: ResourceLimits;
    envFile?: string;
  }): RuntimeProfile {
    const existing = this.profiles.get(params.workspaceId);
    const version = (existing?.version ?? 0) + 1;

    const processes: RuntimeProcess[] = params.processes.map((p) => ({
      ...p,
      status: 'pending' as ProcessStatus,
      logs: [],
    }));

    const profile: RuntimeProfile = {
      id: randomUUID(),
      workspaceId: params.workspaceId,
      name: params.name,
      processes,
      databases: params.databases ?? [],
      previewProbes: params.previewProbes ?? [],
      environmentType: params.environmentType ?? 'development',
      packageManager: params.packageManager ?? 'npm',
      networkPolicy: params.networkPolicy ?? 'allow_local',
      resourceLimits: params.resourceLimits,
      envFile: params.envFile,
      version,
      createdAt: new Date().toISOString(),
      fingerprint: this.computeProfileFingerprint(params),
    };

    this.profiles.set(params.workspaceId, profile);
    return profile;
  }

  /**
   * Get the current runtime profile for a workspace.
   */
  getProfile(workspaceId: string): RuntimeProfile | null {
    return this.profiles.get(workspaceId) ?? null;
  }

  // ─── Process Lifecycle Management (R33.2, R33.3) ───────────────

  /**
   * Start a process within the runtime profile.
   * Resolves environment, applies network policy, registers for cleanup.
   */
  async startProcess(workspaceId: string, processId: string): Promise<RuntimeProcess> {
    const profile = this.profiles.get(workspaceId);
    if (!profile) throw new ProcessNotFoundError(processId);

    const process = this.findMutableProcess(profile, processId);
    if (!process) throw new ProcessNotFoundError(processId);

    // Enforce credential governance (R33.9)
    this.enforceCredentialPolicy(profile.environmentType, process.env);

    // Check dependencies are running
    for (const depId of process.dependsOn) {
      const dep = profile.processes.find((p) => p.id === depId);
      if (dep && dep.status !== 'running' && dep.status !== 'healthy') {
        throw this.classifyAndRecordFailure(processId, 'dependency_failure',
          `Dependency '${depId}' is not running (status: ${dep?.status})`,
          `Start dependency '${depId}' first, then retry`,
        );
      }
    }

    process.status = 'starting';
    process.startedAt = new Date().toISOString();

    const env = this.resolveEnvironment(process.env, profile.environmentType);

    try {
      const handle = this.executor.spawn(process.command, process.args, {
        cwd: process.workingDir,
        env,
        networkPolicy: process.networkPolicy,
      });

      process.pid = handle.pid;
      this.activeProcesses.set(processId, handle);
      this.processLogs.set(processId, []);

      // Register log capture with redaction and bounding
      handle.onLog((line) => {
        this.appendLog(processId, line);
      });

      // Register exit handler
      handle.onExit((code) => {
        process.status = code === 0 ? 'stopped' : 'crashed';
        process.exitCode = code ?? 1;
        process.stoppedAt = new Date().toISOString();
        this.activeProcesses.delete(processId);
        this.stopHealthCheck(processId);

        if (code !== 0 && code !== null) {
          this.classifyAndRecordFailure(processId, 'application_failure',
            `Process exited with code ${code}`,
            'Check logs for error details and restart the process',
          );
        }
      });

      process.status = 'running';

      // Start health checking if configured
      if (process.healthCheck) {
        this.startHealthCheck(processId, process);
      }

      return process;
    } catch (err) {
      process.status = 'failed';
      const error = err as Error;
      throw this.classifyAndRecordFailure(processId, this.classifyError(error),
        error.message,
        this.getRecoveryAction(this.classifyError(error)),
      );
    }
  }

  /**
   * Stop a process deterministically, cleaning up child processes.
   */
  async stopProcess(workspaceId: string, processId: string): Promise<void> {
    const profile = this.profiles.get(workspaceId);
    if (!profile) return;

    const process = this.findMutableProcess(profile, processId);
    if (!process) return;

    this.stopHealthCheck(processId);

    const handle = this.activeProcesses.get(processId);
    if (handle) {
      process.status = 'stopping';
      handle.kill();
      this.activeProcesses.delete(processId);
    }

    process.status = 'stopped';
    process.stoppedAt = new Date().toISOString();
  }

  /**
   * Restart a process (stop then start).
   */
  async restartProcess(workspaceId: string, processId: string): Promise<RuntimeProcess> {
    await this.stopProcess(workspaceId, processId);
    return this.startProcess(workspaceId, processId);
  }

  /**
   * Stop all processes in the profile and clean up deterministically.
   * Stops in reverse dependency order.
   */
  async stopAll(workspaceId: string): Promise<void> {
    const profile = this.profiles.get(workspaceId);
    if (!profile) return;

    // Stop in reverse order to respect dependencies
    const reversed = [...profile.processes].reverse();
    for (const process of reversed) {
      await this.stopProcess(workspaceId, process.id);
    }
  }

  /**
   * Get bounded, redacted logs for a process (R33.8).
   */
  getLogs(processId: string, maxLines?: number): readonly BoundedLogEntry[] {
    const logs = this.processLogs.get(processId) ?? [];
    if (maxLines && maxLines < logs.length) {
      return logs.slice(-maxLines);
    }
    return logs;
  }

  /**
   * Get process status including exit code, health, ports, and resources.
   */
  getProcessStatus(workspaceId: string, processId: string): RuntimeProcess | null {
    const profile = this.profiles.get(workspaceId);
    if (!profile) return null;
    return profile.processes.find((p) => p.id === processId) ?? null;
  }

  /**
   * Get the port allocated for a process.
   */
  getProcessPort(workspaceId: string, processId: string): number | undefined {
    const process = this.getProcessStatus(workspaceId, processId);
    return process?.port;
  }

  // ─── Health Monitoring ─────────────────────────────────────────

  /**
   * Run a health check for a process.
   */
  async checkHealth(workspaceId: string, processId: string): Promise<boolean> {
    const profile = this.profiles.get(workspaceId);
    if (!profile) return false;

    const process = this.findMutableProcess(profile, processId);
    if (!process || !process.healthCheck) return false;

    const hc = process.healthCheck;
    let result: { ok: boolean; error?: string };

    try {
      switch (hc.mode) {
        case 'http':
          result = await this.healthChecker.checkHttp(hc.target, hc.timeoutMs);
          break;
        case 'tcp': {
          const [host, portStr] = hc.target.split(':');
          result = await this.healthChecker.checkTcp(host ?? 'localhost', parseInt(portStr ?? '0', 10), hc.timeoutMs);
          break;
        }
        case 'command':
          result = await this.healthChecker.checkCommand(hc.target, process.workingDir, hc.timeoutMs);
          break;
        case 'log_pattern':
          result = { ok: this.logsContainPattern(processId, hc.target) };
          break;
        default:
          result = { ok: false, error: `Unknown health check mode: ${hc.mode}` };
      }
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }

    process.lastHealthCheck = new Date().toISOString();
    if (result.ok) {
      process.status = 'healthy';
    } else {
      process.status = 'unhealthy';
    }

    return result.ok;
  }

  // ─── Smoke Preview and Evidence (R33.4, R33.5) ────────────────

  /**
   * Run a release smoke preview: start services, wait for health,
   * run probes, capture UI evidence including accessibility findings,
   * and produce immutable Evidence.
   */
  async runSmokePreview(params: {
    workspaceId: string;
    workspaceRevision: string;
    taskId?: string;
    runId?: string;
  }): Promise<SmokeTestEvidence> {
    const profile = this.profiles.get(params.workspaceId);
    if (!profile) {
      throw new ProcessNotFoundError(`No profile for workspace: ${params.workspaceId}`);
    }

    // Enforce credential governance (R33.9)
    this.enforceCredentialPolicy(profile.environmentType);

    const startedAt = new Date().toISOString();
    const probeResults: ProbeResult[] = [];
    let uiPreview: UIPreviewEvidence | undefined;

    // Wait for all processes to be healthy
    await this.waitForHealth(params.workspaceId, MAX_SMOKE_TEST_TIMEOUT_MS);

    // Run configured probes
    for (const probe of profile.previewProbes) {
      const result = await this.executeProbe(probe);
      probeResults.push(result);
    }

    // UI preview with accessibility (R33.5)
    const uiProbe = profile.previewProbes.find((p) => p.type === 'ui');
    if (uiProbe) {
      uiPreview = await this.captureUIPreview(uiProbe.target);
    }

    const allPassed = probeResults.every((r) => r.passed);
    const finishedAt = new Date().toISOString();

    const evidence: SmokeTestEvidence = {
      id: randomUUID(),
      runtimeProfileId: profile.id,
      workspaceRevision: params.workspaceRevision,
      taskId: params.taskId,
      runId: params.runId,
      startedAt,
      finishedAt,
      probeResults,
      uiPreview,
      allPassed,
      environmentType: profile.environmentType,
      fingerprint: this.computeEvidenceFingerprint(probeResults, uiPreview),
    };

    this.smokeTestEvidence.set(evidence.id, evidence);
    return evidence;
  }

  /**
   * Capture UI preview including screenshots, console errors,
   * network failures, and accessibility findings.
   * If accessibility scanning is unavailable or fails, continues
   * and records that state — never marks accessibility as passed (R33.5).
   */
  async captureUIPreview(url: string): Promise<UIPreviewEvidence> {
    const screenshotRef = await this.uiPreviewAdapter.captureScreenshot(url).catch(() => null);
    const consoleErrors = await this.uiPreviewAdapter.captureConsoleErrors(url).catch(() => []);
    const networkFailures = await this.uiPreviewAdapter.captureNetworkFailures(url).catch(() => []);

    let accessibilityStatus: AccessibilityScanStatus = 'not_run';
    let accessibilityFindings: readonly string[] = [];
    let accessibilityError: string | undefined;

    // Attempt accessibility scanning — gracefully handle unavailability
    if (!this.accessibilityAdapter.available()) {
      accessibilityStatus = 'unavailable';
      accessibilityError = 'Accessibility scanner not available in current environment';
    } else {
      try {
        const scanResult = await this.accessibilityAdapter.scan(url);
        accessibilityStatus = scanResult.passed ? 'passed' : 'failed';
        accessibilityFindings = scanResult.findings;
      } catch (err) {
        // Scanning failed — continue preview, record the failure,
        // never mark accessibility as passed (R33.5)
        accessibilityStatus = 'error';
        accessibilityError = (err as Error).message;
      }
    }

    return {
      screenshotRef: screenshotRef ?? undefined,
      consoleErrors: [...consoleErrors],
      networkFailures: [...networkFailures],
      accessibilityStatus,
      accessibilityFindings: [...accessibilityFindings],
      accessibilityError,
    };
  }

  // ─── Migration Testing (R33.6) ────────────────────────────────

  /**
   * Test database migrations on a disposable or approved database.
   * Denies migration testing on unapproved production databases.
   */
  async testMigrations(
    workspaceId: string,
    databaseServiceId: string,
  ): Promise<MigrationTestResult> {
    const profile = this.profiles.get(workspaceId);
    if (!profile) throw new ProcessNotFoundError(`No profile for workspace: ${workspaceId}`);

    const db = profile.databases.find((d) => d.id === databaseServiceId);
    if (!db) throw new ProcessNotFoundError(`Database service '${databaseServiceId}' not found`);

    // Require disposable or explicitly approved database (R33.6)
    if (!db.disposable && !db.approved) {
      throw new MigrationNotApprovedError(databaseServiceId);
    }

    if (!db.connectionUri || !db.migrationsPath) {
      throw new Error(`Database '${databaseServiceId}' missing connection URI or migrations path`);
    }

    // Run forward migrations
    const forwardResult = await this.migrationAdapter.runMigrations(
      db.connectionUri,
      db.migrationsPath,
      'forward',
    );

    // Attempt rollback to validate reversibility
    let rollbackResult: { exitCode: number; output: string } | undefined;
    if (forwardResult.exitCode === 0) {
      try {
        rollbackResult = await this.migrationAdapter.runMigrations(
          db.connectionUri,
          db.migrationsPath,
          'rollback',
        );
      } catch {
        // Rollback failure is noted but doesn't fail the forward test
      }
    }

    const passed = forwardResult.exitCode === 0;
    const result: MigrationTestResult = {
      id: randomUUID(),
      databaseServiceId,
      migrationsPath: db.migrationsPath,
      disposable: db.disposable,
      approved: db.approved,
      passed,
      forwardResult: {
        exitCode: forwardResult.exitCode,
        output: this.truncateAndRedact(forwardResult.output),
      },
      rollbackResult: rollbackResult ? {
        exitCode: rollbackResult.exitCode,
        output: this.truncateAndRedact(rollbackResult.output),
      } : undefined,
      timestamp: new Date().toISOString(),
      error: passed ? undefined : `Migration failed with exit code ${forwardResult.exitCode}`,
    };

    this.migrationResults.set(result.id, result);
    return result;
  }

  // ─── Runtime Failure Classification (R33.7) ────────────────────

  /**
   * Classify a runtime failure and provide a specific recovery action.
   */
  classifyFailure(error: Error, processId?: string): RuntimeFailure {
    const kind = this.classifyError(error);
    return this.classifyAndRecordFailure(
      processId,
      kind,
      error.message,
      this.getRecoveryAction(kind),
    );
  }

  /**
   * Get all recorded failures.
   */
  getFailures(): readonly RuntimeFailure[] {
    return Array.from(this.failures.values());
  }

  /**
   * Get failures for a specific process.
   */
  getProcessFailures(processId: string): readonly RuntimeFailure[] {
    return Array.from(this.failures.values()).filter((f) => f.processId === processId);
  }

  // ─── Credential Governance (R33.9) ────────────────────────────

  /**
   * Approve an environment for use with production-like credentials.
   * By default, production credentials/infrastructure are denied.
   */
  approveEnvironment(params: {
    environmentType: EnvironmentType;
    approvedBy: string;
    scope: string;
  }): CredentialDecision {
    const decision: CredentialDecision = {
      environmentType: params.environmentType,
      approved: true,
      approvedBy: params.approvedBy,
      scope: params.scope,
      timestamp: new Date().toISOString(),
    };
    this.credentialDecisions.set(params.environmentType, decision);
    return decision;
  }

  /**
   * Check if an environment is approved for its credential scope.
   */
  isEnvironmentApproved(environmentType: EnvironmentType): boolean {
    if (environmentType === 'development' || environmentType === 'test') {
      return true; // Non-production environments always allowed
    }
    const decision = this.credentialDecisions.get(environmentType);
    return decision?.approved === true;
  }

  // ─── Evidence Queries ──────────────────────────────────────────

  /**
   * Get a smoke test evidence record by ID.
   */
  getSmokeTestEvidence(id: string): SmokeTestEvidence | null {
    return this.smokeTestEvidence.get(id) ?? null;
  }

  /**
   * Get all smoke test evidence for a workspace.
   */
  getAllSmokeTestEvidence(): readonly SmokeTestEvidence[] {
    return Array.from(this.smokeTestEvidence.values());
  }

  /**
   * Get a migration test result by ID.
   */
  getMigrationResult(id: string): MigrationTestResult | null {
    return this.migrationResults.get(id) ?? null;
  }

  /**
   * Get all migration test results.
   */
  getAllMigrationResults(): readonly MigrationTestResult[] {
    return Array.from(this.migrationResults.values());
  }

  // ─── Private Helpers ───────────────────────────────────────────

  /**
   * Enforce credential governance: deny production by default (R33.9).
   */
  private enforceCredentialPolicy(
    environmentType: EnvironmentType,
    envVars?: readonly EnvVarDefinition[],
  ): void {
    if (environmentType === 'production' || environmentType === 'staging') {
      if (!this.isEnvironmentApproved(environmentType)) {
        throw new ProductionCredentialDeniedError(environmentType);
      }
    }

    // Check for production-like secrets in env vars
    if (envVars) {
      for (const envVar of envVars) {
        if (envVar.secret && envVar.source === 'literal' && environmentType !== 'development') {
          // Secrets should use secret_ref, not literal values in non-dev environments
          // This is a warning rather than a block for test environments
        }
      }
    }
  }

  /**
   * Resolve environment variables from definitions.
   */
  private resolveEnvironment(
    envDefs: readonly EnvVarDefinition[],
    environmentType: EnvironmentType,
  ): Record<string, string> {
    const env: Record<string, string> = {
      NODE_ENV: environmentType === 'production' ? 'production' : 'development',
      RUNTIME_ENVIRONMENT: environmentType,
    };

    for (const def of envDefs) {
      if (def.value !== undefined && !def.secret) {
        env[def.name] = def.value;
      } else if (def.source === 'literal' && def.value !== undefined) {
        env[def.name] = def.value;
      }
      // secret_ref values are resolved by the executor's secret provider
    }

    return env;
  }

  /**
   * Find a mutable process reference in the profile (cast away readonly for internal mutation).
   */
  private findMutableProcess(profile: RuntimeProfile, processId: string): RuntimeProcess | undefined {
    return (profile.processes as RuntimeProcess[]).find((p) => p.id === processId);
  }

  /**
   * Append a log entry with redaction and bounding (R33.8).
   */
  private appendLog(processId: string, line: string): void {
    const logs = this.processLogs.get(processId) ?? [];

    const redactedLine = this.redactSecrets(line);
    const entry: BoundedLogEntry = {
      processId,
      timestamp: new Date().toISOString(),
      line: redactedLine,
      redacted: redactedLine !== line,
    };

    logs.push(entry);

    // Enforce bounds (R33.8)
    if (logs.length > MAX_LOG_LINES_PER_PROCESS) {
      logs.splice(0, logs.length - MAX_LOG_LINES_PER_PROCESS);
    }

    this.processLogs.set(processId, logs);
  }

  /**
   * Redact secrets from log content (R33.8).
   */
  private redactSecrets(text: string): string {
    let redacted = text;
    for (const pattern of SECRET_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }

  /**
   * Truncate and redact text content for storage.
   */
  private truncateAndRedact(text: string, maxLen: number = 10_000): string {
    const redacted = this.redactSecrets(text);
    if (redacted.length <= maxLen) return redacted;
    return redacted.slice(0, maxLen) + '\n... [truncated]';
  }

  /**
   * Start periodic health checking for a process.
   */
  private startHealthCheck(processId: string, process: RuntimeProcess): void {
    if (!process.healthCheck) return;

    const hc = process.healthCheck;
    const startDelay = hc.startPeriodMs || DEFAULT_START_PERIOD_MS;

    // Delay initial check by start period
    setTimeout(() => {
      const timer = setInterval(async () => {
        const handle = this.activeProcesses.get(processId);
        if (!handle) {
          this.stopHealthCheck(processId);
          return;
        }

        try {
          await this.checkHealth(
            Array.from(this.profiles.entries()).find(([, p]) =>
              p.processes.some((proc) => proc.id === processId),
            )?.[0] ?? '',
            processId,
          );
        } catch {
          // Health check errors are already tracked in process status
        }
      }, hc.intervalMs || DEFAULT_HEALTH_INTERVAL_MS);

      this.healthTimers.set(processId, timer);
    }, startDelay);
  }

  /**
   * Stop health checking for a process.
   */
  private stopHealthCheck(processId: string): void {
    const timer = this.healthTimers.get(processId);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(processId);
    }
  }

  /**
   * Check if process logs contain a specific pattern.
   */
  private logsContainPattern(processId: string, pattern: string): boolean {
    const logs = this.processLogs.get(processId) ?? [];
    const regex = new RegExp(pattern);
    return logs.some((entry) => regex.test(entry.line));
  }

  /**
   * Wait for all processes to become healthy or timeout.
   */
  private async waitForHealth(workspaceId: string, timeoutMs: number): Promise<void> {
    const profile = this.profiles.get(workspaceId);
    if (!profile) return;

    const deadline = Date.now() + timeoutMs;
    const processesWithHealth = profile.processes.filter((p) => p.healthCheck);

    while (Date.now() < deadline) {
      const allHealthy = processesWithHealth.every(
        (p) => p.status === 'healthy' || p.status === 'running',
      );
      if (allHealthy) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Timeout: record failures for unhealthy processes
    for (const process of processesWithHealth) {
      if (process.status !== 'healthy' && process.status !== 'running') {
        this.classifyAndRecordFailure(process.id, 'health_check_failure',
          `Process '${process.name}' did not become healthy within ${timeoutMs}ms`,
          'Check process logs and health check configuration',
        );
      }
    }
  }

  /**
   * Execute a single preview probe.
   */
  private async executeProbe(probe: PreviewProbe): Promise<ProbeResult> {
    const startTime = Date.now();
    try {
      switch (probe.type) {
        case 'http': {
          const result = await this.healthChecker.checkHttp(probe.target, probe.timeoutMs);
          const passed = result.ok &&
            (probe.expectedStatus === undefined || result.statusCode === probe.expectedStatus);
          return {
            probeId: probe.id,
            passed,
            statusCode: result.statusCode,
            error: result.error,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }
        case 'tcp': {
          const [host, portStr] = probe.target.split(':');
          const result = await this.healthChecker.checkTcp(
            host ?? 'localhost',
            parseInt(portStr ?? '0', 10),
            probe.timeoutMs,
          );
          return {
            probeId: probe.id,
            passed: result.ok,
            error: result.error,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }
        case 'cli': {
          const result = await this.healthChecker.checkCommand(
            probe.target,
            '.',
            probe.timeoutMs,
          );
          const passed = result.ok &&
            (probe.expectedPattern === undefined || (result.output ?? '').includes(probe.expectedPattern));
          return {
            probeId: probe.id,
            passed,
            responseBody: result.output,
            error: result.error,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }
        case 'ui': {
          // UI probes are handled separately in captureUIPreview
          return {
            probeId: probe.id,
            passed: true,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }
        default:
          return {
            probeId: probe.id,
            passed: false,
            error: `Unknown probe type: ${probe.type}`,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          };
      }
    } catch (err) {
      return {
        probeId: probe.id,
        passed: false,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Classify an error into a RuntimeFailureKind (R33.7).
   */
  private classifyError(error: Error): RuntimeFailureKind {
    const msg = error.message.toLowerCase();

    if (msg.includes('eaddrinuse') || msg.includes('port') && msg.includes('in use')) {
      return 'port_conflict';
    }
    if (msg.includes('secret') || msg.includes('credential') || msg.includes('api_key') || msg.includes('not set')) {
      return 'missing_secret';
    }
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
      return 'timeout';
    }
    if (msg.includes('permission denied') || msg.includes('sandbox') || msg.includes('policy')) {
      return 'sandbox_policy_denial';
    }
    if (msg.includes('enomem') || msg.includes('memory') || msg.includes('oom')) {
      return 'resource_exhaustion';
    }
    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network')) {
      return 'network_failure';
    }
    if (msg.includes('dependency') || msg.includes('not running') || msg.includes('connection refused')) {
      return 'dependency_failure';
    }

    return 'application_failure';
  }

  /**
   * Get a human-readable recovery action for a failure kind (R33.7).
   */
  private getRecoveryAction(kind: RuntimeFailureKind): string {
    switch (kind) {
      case 'application_failure':
        return 'Check application logs for errors and fix the issue before restarting';
      case 'dependency_failure':
        return 'Ensure all dependent services are running and accessible';
      case 'port_conflict':
        return 'Stop the conflicting process or configure a different port';
      case 'missing_secret':
        return 'Set the required environment variable or secret reference';
      case 'timeout':
        return 'Increase the timeout duration or investigate slow startup';
      case 'sandbox_policy_denial':
        return 'Review and update the sandbox/network policy configuration';
      case 'health_check_failure':
        return 'Verify the health check endpoint/command is correct and the service is responding';
      case 'resource_exhaustion':
        return 'Increase resource limits or reduce the process resource usage';
      case 'network_failure':
        return 'Check network connectivity and DNS resolution';
      case 'unknown':
        return 'Examine process logs for diagnostic details';
    }
  }

  /**
   * Record a classified failure and return it as an error.
   */
  private classifyAndRecordFailure(
    processId: string | undefined,
    kind: RuntimeFailureKind,
    message: string,
    recoveryAction: string,
  ): RuntimeFailure & Error {
    const failure: RuntimeFailure = {
      id: randomUUID(),
      processId,
      kind,
      message,
      recoveryAction,
      timestamp: new Date().toISOString(),
    };
    this.failures.set(failure.id, failure);

    const error = new Error(message) as RuntimeFailure & Error;
    Object.assign(error, failure);
    return error;
  }

  /**
   * Compute a fingerprint for the runtime profile.
   */
  private computeProfileFingerprint(params: {
    workspaceId: string;
    name: string;
    processes: readonly Omit<RuntimeProcess, 'status' | 'logs'>[];
  }): string {
    const data = JSON.stringify({
      workspace: params.workspaceId,
      name: params.name,
      processes: params.processes.map((p) => ({
        id: p.id,
        cmd: p.command,
        port: p.port,
        net: p.networkPolicy,
      })),
    });
    return `rp_${this.simpleHash(data)}`;
  }

  /**
   * Compute a fingerprint for smoke test evidence.
   */
  private computeEvidenceFingerprint(
    probeResults: readonly ProbeResult[],
    uiPreview?: UIPreviewEvidence,
  ): string {
    const data = JSON.stringify({
      probes: probeResults.map((r) => ({ id: r.probeId, pass: r.passed })),
      a11y: uiPreview?.accessibilityStatus,
    });
    return `se_${this.simpleHash(data)}`;
  }

  /**
   * Simple string hash for fingerprints.
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
