/**
 * Production Readiness Report types — consolidated, traceable status of functional,
 * quality, security, operational, deployment, and documentation gates for a Release_Candidate.
 *
 * Requirements: 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7, 40.8, 40.9, 40.10, 40.11
 */

// ─── Gate Outcome ──────────────────────────────────────────────────────────

/**
 * Outcome of a readiness gate evaluation.
 * pass, fail, blocked, stale, waived, or not_applicable
 */
export type GateOutcome =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'stale'
  | 'waived'
  | 'not_applicable';

// ─── Gate Categories (R40.2) ───────────────────────────────────────────────

/**
 * Categories covered by the Production_Readiness_Report.
 */
export type GateCategory =
  | 'requirements_verification'
  | 'design_decisions'
  | 'change_sets'
  | 'code_review'
  | 'tests_coverage'
  | 'diagnostics'
  | 'build'
  | 'security'
  | 'dependencies'
  | 'runtime_smoke_tests'
  | 'performance'
  | 'accessibility'
  | 'ci'
  | 'deployment'
  | 'migrations'
  | 'rollback'
  | 'documentation'
  | 'waivers';

// ─── Readiness Gate (R40.3) ────────────────────────────────────────────────

/**
 * A single gate in the Production_Readiness_Report.
 * Shows outcome with actor, timestamp, revision, and drill-down reference.
 */
export interface ReadinessGate {
  readonly id: string;
  readonly name: string;
  readonly category: GateCategory;
  readonly outcome: GateOutcome;
  readonly mandatory: boolean;
  readonly actor: string;
  readonly timestamp: string;
  readonly revision: string;
  readonly evidenceId: string | null;
  readonly description: string;
  readonly blockerReason: string | null;
  readonly drillDownRef: DrillDownRef | null;
}

/**
 * Drill-down reference for navigating to the source of a gate result (R40.5).
 */
export interface DrillDownRef {
  readonly kind:
    | 'requirement'
    | 'task'
    | 'agent_run'
    | 'tool_event'
    | 'command_output'
    | 'diff'
    | 'artifact'
    | 'approval'
    | 'evidence';
  readonly id: string;
  readonly label: string;
  readonly uri?: string;
}

// ─── Staleness Fingerprints (R40.4) ───────────────────────────────────────

/**
 * Fingerprints used to determine evidence staleness.
 * Evidence is stale when any relevant fingerprint differs from the current Release_Candidate.
 */
export interface StalenessFingerprints {
  readonly sourceRevision: string;
  readonly lockfileHash: string;
  readonly runtimeProfileFingerprint: string;
  readonly environmentFingerprint: string;
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly requiredInputFingerprints: Readonly<Record<string, string>>;
}

// ─── Waiver (R40.9) ───────────────────────────────────────────────────────

/**
 * A waiver for a gate, requiring actor, reason, scope, review/expiry date,
 * and compensating control.
 */
export interface ReadinessWaiver {
  readonly id: string;
  readonly gateId: string;
  readonly actor: string;
  readonly reason: string;
  readonly scope: string;
  readonly reviewDate: string;
  readonly expiryDate: string | null;
  readonly compensatingControl: string;
  readonly grantedAt: string;
  readonly releaseCandidateId: string;
}

// ─── Documentation Handoff (R40.6) ────────────────────────────────────────

/**
 * Handoff documentation package.
 */
export interface HandoffDocumentation {
  readonly architecture: DocumentationSection | null;
  readonly setup: DocumentationSection | null;
  readonly localCommands: DocumentationSection | null;
  readonly configurationSchema: DocumentationSection | null;
  readonly interfaces: DocumentationSection | null;
  readonly operations: DocumentationSection | null;
  readonly monitoring: DocumentationSection | null;
  readonly limitations: DocumentationSection | null;
  readonly migrations: DocumentationSection | null;
  readonly rollback: DocumentationSection | null;
}

/**
 * A documentation section with content and validation results.
 */
export interface DocumentationSection {
  readonly title: string;
  readonly content: string;
  readonly valid: boolean;
  readonly issues: readonly DocumentationIssue[];
}

/**
 * A documentation issue detected during validation (R40.7).
 */
export interface DocumentationIssue {
  readonly kind: 'removed_command' | 'missing_file' | 'invalid_link' | 'obsolete_config';
  readonly description: string;
  readonly reference: string;
  readonly severity: 'error' | 'warning';
}

// ─── Readiness Levels (R40.11) ─────────────────────────────────────────────

/**
 * Readiness status at different levels.
 */
export type ReadinessLevel = 'requirement' | 'task' | 'release' | 'project';

/**
 * Readiness summary at a given level with shortest-path resolution info.
 */
export interface ReadinessSummary {
  readonly level: ReadinessLevel;
  readonly entityId: string;
  readonly entityLabel: string;
  readonly ready: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly blockedCount: number;
  readonly staleCount: number;
  readonly waivedCount: number;
  readonly notApplicableCount: number;
  readonly blockers: readonly BlockerInfo[];
}

/**
 * Information about a blocker with resolution guidance.
 */
export interface BlockerInfo {
  readonly gateId: string;
  readonly gateName: string;
  readonly category: GateCategory;
  readonly reason: string;
  readonly shortestPathAction: string;
}

// ─── Release Candidate ─────────────────────────────────────────────────────

/**
 * A Release_Candidate that the report is generated for.
 */
export interface ReleaseCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: string;
  readonly label: string;
  readonly createdAt: string;
  readonly fingerprints: StalenessFingerprints;
}

// ─── Production Readiness Report (R40.1) ───────────────────────────────────

/**
 * The consolidated production readiness report for a Release_Candidate.
 */
export interface ProductionReadinessReport {
  readonly id: string;
  readonly releaseCandidateId: string;
  readonly revision: string;
  readonly ready: boolean;
  readonly gates: readonly ReadinessGate[];
  readonly waivers: readonly ReadinessWaiver[];
  readonly documentation: HandoffDocumentation;
  readonly readinessSummaries: readonly ReadinessSummary[];
  readonly mandatoryBlockers: readonly BlockerInfo[];
  readonly generatedAt: string;
  readonly fingerprint: string;
}

// ─── Export Formats (R40.10) ───────────────────────────────────────────────

/**
 * Configuration for exported report format.
 */
export interface ExportOptions {
  readonly format: 'markdown' | 'json';
  readonly redactPaths: boolean;
  readonly redactSecrets: boolean;
  readonly includeWaivers: boolean;
  readonly stableIdentifiers: boolean;
}

/**
 * Exported report with stable identifiers and redacted content.
 */
export interface ExportedReport {
  readonly format: 'markdown' | 'json';
  readonly content: string;
  readonly releaseCandidateId: string;
  readonly revision: string;
  readonly generatedAt: string;
  readonly fingerprint: string;
}

// ─── Evidence Adapter ──────────────────────────────────────────────────────

/**
 * Evidence envelope compatible with the Evidence service.
 */
export interface EvidenceEnvelope {
  readonly id: string;
  readonly kind: string;
  readonly workspaceRevision: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly changeSetId?: string;
  readonly producer: {
    readonly kind: 'tool' | 'user' | 'service';
    readonly id: string;
    readonly version?: string;
  };
  readonly environmentFingerprint?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'pass' | 'fail' | 'blocked' | 'cancelled' | 'stale' | 'waived';
  readonly summary: string;
  readonly payloadRef?: string;
  readonly fingerprint: string;
}
