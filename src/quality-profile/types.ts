/**
 * Quality_Profile types — project-specific commands, thresholds, policies,
 * and required evidence for tests, lint, types, builds, security, performance, and documentation.
 *
 * Requirements: 31.1, 31.2, 31.3, 31.4, 31.5, 31.6, 31.7, 31.8, 31.9, 31.10
 */

// ─── Quality Check Categories ──────────────────────────────────────────────

/**
 * Categories of quality checks supported by the profile.
 */
export type QualityCheckCategory =
  | 'test_targeted'
  | 'test_full'
  | 'type_check'
  | 'lint'
  | 'format'
  | 'build'
  | 'package'
  | 'security'
  | 'smoke';

/**
 * Whether a gate is mandatory or advisory.
 */
export type GatePolicy = 'mandatory' | 'advisory' | 'disabled';

/**
 * Outcome of a quality check run.
 */
export type QualityCheckOutcome =
  | 'pass'
  | 'fail'
  | 'flaky'
  | 'blocked'
  | 'cancelled'
  | 'stale'
  | 'timeout';

// ─── Quality Command Definitions ───────────────────────────────────────────

/**
 * A single quality check command definition within the profile.
 */
export interface QualityCommand {
  readonly id: string;
  readonly category: QualityCheckCategory;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs: number;
  readonly gatePolicy: GatePolicy;
  readonly description: string;
  /** File patterns this check targets (used for targeted selection). */
  readonly targetPatterns?: readonly string[] | undefined;
  /** Whether this command produces file output (e.g., auto-fix). */
  readonly mayModifyFiles: boolean;
}

/**
 * The complete Quality_Profile for a project workspace.
 */
export interface QualityProfile {
  readonly workspaceId: string;
  readonly version: number;
  readonly commands: readonly QualityCommand[];
  readonly detectedAt: string;
  readonly configuredAt: string;
  readonly fingerprint: string;
}

// ─── Baseline Capture ──────────────────────────────────────────────────────

/**
 * A snapshot of pre-existing failures before any change is applied.
 */
export interface QualityBaseline {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceRevision: string;
  readonly capturedAt: string;
  readonly failures: readonly BaselineFailure[];
  readonly fingerprint: string;
}

/**
 * A known pre-existing failure in the baseline.
 */
export interface BaselineFailure {
  readonly category: QualityCheckCategory;
  readonly commandId: string;
  readonly exitCode: number;
  readonly diagnosticIdentities: readonly DiagnosticIdentity[];
  readonly summary: string;
}

// ─── Diagnostic Correlation ────────────────────────────────────────────────

/**
 * Unique identity for a diagnostic, bound to exact file, revision, and version.
 */
export interface DiagnosticIdentity {
  readonly uri: string;
  readonly revision: string;
  readonly documentVersion: number;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly severity: DiagnosticSeverity;
  readonly source: string;
  readonly code: string;
  readonly message: string;
  /** Content-based fingerprint for deduplication. */
  readonly fingerprint: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * State of a diagnostic in relation to checks.
 */
export type DiagnosticState =
  | 'active'
  | 'stale'
  | 'duplicate'
  | 'resolved'
  | 'baseline';

/**
 * A correlated diagnostic with full provenance.
 */
export interface CorrelatedDiagnostic {
  readonly identity: DiagnosticIdentity;
  readonly state: DiagnosticState;
  readonly changeSetId: string | undefined;
  readonly taskId: string | undefined;
  readonly runId: string | undefined;
  readonly remediationAttempts: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

// ─── Flaky Test Detection ──────────────────────────────────────────────────

/**
 * Information about a test identified as flaky.
 */
export interface FlakyTestRecord {
  readonly testId: string;
  readonly testName: string;
  readonly uri: string;
  readonly category: QualityCheckCategory;
  readonly passCount: number;
  readonly failCount: number;
  readonly totalRetries: number;
  readonly lastFlakeAt: string;
  readonly reportedSeparately: boolean;
}

// ─── Targeted Check Selection ──────────────────────────────────────────────

/**
 * Input for selecting which targeted checks to run.
 */
export interface CheckSelectionInput {
  readonly changedFiles: readonly string[];
  readonly impactedFiles: readonly string[];
  readonly taskAcceptanceCriteria: readonly string[];
  readonly configChanges: readonly string[];
  readonly workspaceRevision: string;
}

/**
 * A selected check with the reason it was chosen.
 */
export interface SelectedCheck {
  readonly command: QualityCommand;
  readonly reason: CheckSelectionReason;
  readonly targetFiles: readonly string[];
}

export type CheckSelectionReason =
  | 'changed_file_match'
  | 'dependency_impact'
  | 'acceptance_criteria'
  | 'config_change'
  | 'mandatory_gate';

// ─── Check Execution Results ───────────────────────────────────────────────

/**
 * Result of executing a quality check.
 */
export interface QualityCheckResult {
  readonly id: string;
  readonly commandId: string;
  readonly category: QualityCheckCategory;
  readonly workspaceRevision: string;
  readonly runtimeProfileId: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number;
  readonly outcome: QualityCheckOutcome;
  readonly summary: string;
  readonly boundedOutput: string;
  readonly fullLogRef: string | undefined;
  readonly modifiedFiles: readonly string[];
  readonly diagnostics: readonly DiagnosticIdentity[];
  readonly changeSetId: string | undefined;
  readonly taskId: string | undefined;
  readonly runId: string | undefined;
  readonly retryCount: number;
  readonly isRetryPass: boolean;
  readonly fingerprint: string;
}

/**
 * Streaming progress update during a quality check.
 */
export interface QualityCheckProgress {
  readonly commandId: string;
  readonly category: QualityCheckCategory;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly elapsedMs: number;
  readonly summaryLine: string;
  readonly outputLines: number;
}

// ─── Runtime Profile Gate Execution ────────────────────────────────────────

/**
 * Configuration for running a mandatory gate in an isolated Runtime_Profile.
 */
export interface IsolatedGateConfig {
  readonly runtimeProfileId: string;
  readonly workspaceRevision: string;
  readonly commands: readonly QualityCommand[];
  readonly environment: Readonly<Record<string, string>>;
  readonly isolation: 'process' | 'container' | 'sandbox';
  readonly networkPolicy: 'allow' | 'deny' | 'restricted';
}

/**
 * Result of a full mandatory gate run in isolated Runtime_Profile.
 */
export interface IsolatedGateResult {
  readonly id: string;
  readonly runtimeProfileId: string;
  readonly workspaceRevision: string;
  readonly results: readonly QualityCheckResult[];
  readonly allPassed: boolean;
  readonly modifiedFiles: readonly string[];
  readonly routedToChangeSet: boolean;
  readonly changeSetId: string | undefined;
  readonly rolledBack: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly fingerprint: string;
}
