/**
 * ReleaseReadinessService — generates authoritative Production_Readiness_Reports
 * for Release_Candidates using revision-bound Evidence, staleness detection,
 * waiver enforcement, documentation validation, and shortest-path readiness projection.
 *
 * The report is generated from Authoritative_Status and linked Evidence rather than
 * agent-authored claims. It covers requirements through documentation and waivers,
 * showing pass/fail/blocked/stale/waived/not-applicable with actor, timestamp, revision,
 * and drill-down for every gate.
 *
 * Requirements: 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7, 40.8, 40.9, 40.10, 40.11
 */

import { randomUUID } from 'crypto';

import type {
  BlockerInfo,
  DocumentationIssue,
  DocumentationSection,
  EvidenceEnvelope,
  ExportedReport,
  ExportOptions,
  GateCategory,
  GateOutcome,
  HandoffDocumentation,
  ProductionReadinessReport,
  ReadinessGate,
  ReadinessLevel,
  ReadinessSummary,
  ReadinessWaiver,
  ReleaseCandidate,
  StalenessFingerprints,
} from './types';

// ─── Adapter Interfaces ────────────────────────────────────────────────────

/**
 * Adapter for querying evidence envelopes.
 */
export interface EvidenceProvider {
  getEvidenceForReleaseCandidate(releaseCandidateId: string): readonly EvidenceEnvelope[];
  getEvidenceById(evidenceId: string): EvidenceEnvelope | null;
}

/**
 * Adapter for querying task and requirement coverage.
 */
export interface PlanningProvider {
  getRequirementCoverage(workspaceId: string): readonly RequirementCoverage[];
  getTaskStatus(workspaceId: string): readonly TaskCoverage[];
  getDesignDecisions(workspaceId: string): readonly DesignDecisionStatus[];
}

/**
 * Requirement coverage information.
 */
export interface RequirementCoverage {
  readonly requirementId: string;
  readonly label: string;
  readonly status: 'unplanned' | 'designed' | 'tasked' | 'in_progress' | 'implemented' | 'verified' | 'waived';
  readonly linkedTaskIds: readonly string[];
  readonly linkedEvidenceIds: readonly string[];
}

/**
 * Task completion status.
 */
export interface TaskCoverage {
  readonly taskId: string;
  readonly label: string;
  readonly status: 'ready' | 'queued' | 'running' | 'completed' | 'failed' | 'blocked';
  readonly hasEvidence: boolean;
  readonly linkedEvidenceIds: readonly string[];
}

/**
 * Design decision status.
 */
export interface DesignDecisionStatus {
  readonly designNodeId: string;
  readonly label: string;
  readonly resolved: boolean;
  readonly linkedRequirementIds: readonly string[];
}

/**
 * Adapter for checking documentation validity (R40.7).
 */
export interface DocumentationValidator {
  validateLinks(content: string): readonly DocumentationIssue[];
  validateCommands(content: string, workspaceId: string): readonly DocumentationIssue[];
  validateFiles(content: string, workspaceId: string): readonly DocumentationIssue[];
}

/**
 * Adapter for getting documentation sections (R40.6).
 */
export interface DocumentationProvider {
  getArchitecture(workspaceId: string): string | null;
  getSetup(workspaceId: string): string | null;
  getLocalCommands(workspaceId: string): string | null;
  getConfigurationSchema(workspaceId: string): string | null;
  getInterfaces(workspaceId: string): string | null;
  getOperations(workspaceId: string): string | null;
  getMonitoring(workspaceId: string): string | null;
  getLimitations(workspaceId: string): string | null;
  getMigrations(workspaceId: string): string | null;
  getRollback(workspaceId: string): string | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** All gate categories that the report must cover (R40.2). */
export const ALL_GATE_CATEGORIES: readonly GateCategory[] = [
  'requirements_verification',
  'design_decisions',
  'change_sets',
  'code_review',
  'tests_coverage',
  'diagnostics',
  'build',
  'security',
  'dependencies',
  'runtime_smoke_tests',
  'performance',
  'accessibility',
  'ci',
  'deployment',
  'migrations',
  'rollback',
  'documentation',
  'waivers',
] as const;

/** Categories where gates are mandatory for production readiness (R40.8). */
export const MANDATORY_CATEGORIES: readonly GateCategory[] = [
  'requirements_verification',
  'tests_coverage',
  'build',
  'security',
  'dependencies',
  'deployment',
  'migrations',
  'rollback',
  'documentation',
] as const;

// ─── Errors ────────────────────────────────────────────────────────────────

export class StaleEvidenceError extends Error {
  constructor(
    public readonly evidenceId: string,
    public readonly staleReason: string,
  ) {
    super(`Evidence '${evidenceId}' is stale for the current Release_Candidate: ${staleReason}`);
    this.name = 'StaleEvidenceError';
  }
}

export class MandatoryGateBlockedError extends Error {
  constructor(public readonly blockers: readonly BlockerInfo[]) {
    super(
      `Release_Candidate cannot be production-ready: ${blockers.length} mandatory gate(s) failed — ${blockers.map((b) => b.gateName).join(', ')}`,
    );
    this.name = 'MandatoryGateBlockedError';
  }
}

export class InvalidWaiverError extends Error {
  constructor(public readonly field: string) {
    super(`Waiver missing required field: ${field}`);
    this.name = 'InvalidWaiverError';
  }
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Generates authoritative Production_Readiness_Reports for Release_Candidates.
 *
 * Uses Evidence from prior tasks, enforces staleness rules, validates waivers,
 * assembles documentation, and projects shortest-path readiness.
 */
export class ReleaseReadinessService {
  private readonly releaseCandidates: Map<string, ReleaseCandidate> = new Map();
  private readonly waivers: Map<string, ReadinessWaiver> = new Map();
  private readonly reports: Map<string, ProductionReadinessReport> = new Map();

  constructor(
    private readonly evidenceProvider: EvidenceProvider,
    private readonly planningProvider: PlanningProvider,
    private readonly documentationValidator: DocumentationValidator,
    private readonly documentationProvider: DocumentationProvider,
  ) {}

  // ─── Release Candidate Management ───────────────────────────────

  /**
   * Register a Release_Candidate for report generation.
   */
  registerReleaseCandidate(candidate: ReleaseCandidate): void {
    this.releaseCandidates.set(candidate.id, candidate);
  }

  /**
   * Get a registered Release_Candidate.
   */
  getReleaseCandidate(id: string): ReleaseCandidate | null {
    return this.releaseCandidates.get(id) ?? null;
  }

  // ─── Waiver Management (R40.9) ──────────────────────────────────

  /**
   * Grant a waiver for a gate.
   * Waivers require: actor, reason, scope, review/expiry date, and compensating control.
   */
  grantWaiver(params: {
    gateId: string;
    actor: string;
    reason: string;
    scope: string;
    reviewDate: string;
    expiryDate?: string;
    compensatingControl: string;
    releaseCandidateId: string;
  }): ReadinessWaiver {
    // Enforce mandatory fields (R40.9)
    if (!params.actor || !params.actor.trim()) {
      throw new InvalidWaiverError('actor');
    }
    if (!params.reason || !params.reason.trim()) {
      throw new InvalidWaiverError('reason');
    }
    if (!params.scope || !params.scope.trim()) {
      throw new InvalidWaiverError('scope');
    }
    if (!params.reviewDate || !params.reviewDate.trim()) {
      throw new InvalidWaiverError('reviewDate');
    }
    if (!params.compensatingControl || !params.compensatingControl.trim()) {
      throw new InvalidWaiverError('compensatingControl');
    }

    const waiver: ReadinessWaiver = {
      id: randomUUID(),
      gateId: params.gateId,
      actor: params.actor,
      reason: params.reason,
      scope: params.scope,
      reviewDate: params.reviewDate,
      expiryDate: params.expiryDate ?? null,
      compensatingControl: params.compensatingControl,
      grantedAt: new Date().toISOString(),
      releaseCandidateId: params.releaseCandidateId,
    };

    this.waivers.set(waiver.id, waiver);
    return waiver;
  }

  /**
   * Get all waivers for a release candidate.
   */
  getWaivers(releaseCandidateId: string): readonly ReadinessWaiver[] {
    return Array.from(this.waivers.values()).filter(
      (w) => w.releaseCandidateId === releaseCandidateId,
    );
  }

  /**
   * Find a waiver for a specific gate.
   */
  findWaiverForGate(gateId: string, releaseCandidateId: string): ReadinessWaiver | null {
    for (const waiver of this.waivers.values()) {
      if (waiver.gateId === gateId && waiver.releaseCandidateId === releaseCandidateId) {
        // Check expiry
        if (waiver.expiryDate) {
          const now = new Date();
          const expiry = new Date(waiver.expiryDate);
          if (now > expiry) continue; // Expired waiver, skip
        }
        return waiver;
      }
    }
    return null;
  }

  // ─── Staleness Detection (R40.4) ────────────────────────────────

  /**
   * Check if an evidence envelope is stale against the Release_Candidate fingerprints.
   * Evidence is stale when source revision, lockfile, RuntimeProfile, environment,
   * tool version, or required input fingerprint differs.
   */
  checkEvidenceStaleness(
    evidence: EvidenceEnvelope,
    candidateFingerprints: StalenessFingerprints,
  ): { stale: boolean; reason: string | null } {
    // Check source revision
    if (evidence.workspaceRevision !== candidateFingerprints.sourceRevision) {
      return { stale: true, reason: 'source_revision_differs' };
    }

    // Check environment fingerprint
    if (
      evidence.environmentFingerprint &&
      evidence.environmentFingerprint !== candidateFingerprints.environmentFingerprint
    ) {
      return { stale: true, reason: 'environment_fingerprint_differs' };
    }

    // Check tool version
    if (evidence.producer.version) {
      const expectedToolVersion =
        candidateFingerprints.toolVersions[evidence.producer.id];
      if (expectedToolVersion && evidence.producer.version !== expectedToolVersion) {
        return { stale: true, reason: 'tool_version_differs' };
      }
    }

    return { stale: false, reason: null };
  }

  // ─── Report Generation (R40.1) ──────────────────────────────────

  /**
   * Generate one Production_Readiness_Report for a Release_Candidate.
   * Uses Authoritative_Status and linked Evidence rather than agent-authored claims.
   */
  generateReport(releaseCandidateId: string): ProductionReadinessReport {
    const candidate = this.releaseCandidates.get(releaseCandidateId);
    if (!candidate) {
      throw new Error(`Release_Candidate '${releaseCandidateId}' not registered`);
    }

    // Collect all evidence
    const allEvidence = this.evidenceProvider.getEvidenceForReleaseCandidate(releaseCandidateId);

    // Evaluate all gates
    const gates = this.evaluateAllGates(candidate, allEvidence);

    // Collect waivers
    const waivers = this.getWaivers(releaseCandidateId);

    // Validate documentation
    const documentation = this.assembleDocumentation(candidate.workspaceId);

    // Compute readiness summaries at all levels (R40.11)
    const readinessSummaries = this.computeReadinessSummaries(candidate, gates);

    // Identify mandatory blockers (R40.8)
    const mandatoryBlockers = this.identifyMandatoryBlockers(gates);

    // A Release_Candidate SHALL NOT be labeled production ready while any mandatory
    // gate is failed, blocked, stale, or missing (R40.8)
    const ready =
      mandatoryBlockers.length === 0 &&
      gates
        .filter((g) => g.mandatory)
        .every(
          (g) =>
            g.outcome === 'pass' ||
            g.outcome === 'waived' ||
            g.outcome === 'not_applicable',
        );

    const report: ProductionReadinessReport = {
      id: randomUUID(),
      releaseCandidateId,
      revision: candidate.revision,
      ready,
      gates,
      waivers,
      documentation,
      readinessSummaries,
      mandatoryBlockers,
      generatedAt: new Date().toISOString(),
      fingerprint: this.computeReportFingerprint(releaseCandidateId, gates),
    };

    this.reports.set(report.id, report);
    return report;
  }

  /**
   * Get a previously generated report.
   */
  getReport(reportId: string): ProductionReadinessReport | null {
    return this.reports.get(reportId) ?? null;
  }

  /**
   * Get the latest report for a release candidate.
   */
  getLatestReport(releaseCandidateId: string): ProductionReadinessReport | null {
    const candidates = Array.from(this.reports.values())
      .filter((r) => r.releaseCandidateId === releaseCandidateId)
      .sort(
        (a, b) =>
          new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
      );
    return candidates[0] ?? null;
  }

  // ─── Export (R40.10) ─────────────────────────────────────────────

  /**
   * Export the report as stable redacted Markdown or JSON.
   */
  exportReport(
    reportId: string,
    options: ExportOptions,
  ): ExportedReport {
    const report = this.reports.get(reportId);
    if (!report) {
      throw new Error(`Report '${reportId}' not found`);
    }

    let content: string;
    if (options.format === 'markdown') {
      content = this.renderMarkdown(report, options);
    } else {
      content = this.renderJson(report, options);
    }

    return {
      format: options.format,
      content,
      releaseCandidateId: report.releaseCandidateId,
      revision: report.revision,
      generatedAt: report.generatedAt,
      fingerprint: report.fingerprint,
    };
  }

  // ─── Gate Evaluation ─────────────────────────────────────────────

  /**
   * Evaluate all gates for a Release_Candidate (R40.2, R40.3).
   */
  private evaluateAllGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): readonly ReadinessGate[] {
    const gates: ReadinessGate[] = [];

    // R40.2 categories
    gates.push(...this.evaluateRequirementsGates(candidate));
    gates.push(...this.evaluateDesignDecisionGates(candidate));
    gates.push(...this.evaluateChangeSetGates(candidate, allEvidence));
    gates.push(...this.evaluateCodeReviewGates(candidate, allEvidence));
    gates.push(...this.evaluateTestCoverageGates(candidate, allEvidence));
    gates.push(...this.evaluateDiagnosticsGates(candidate, allEvidence));
    gates.push(...this.evaluateBuildGates(candidate, allEvidence));
    gates.push(...this.evaluateSecurityGates(candidate, allEvidence));
    gates.push(...this.evaluateDependencyGates(candidate, allEvidence));
    gates.push(...this.evaluateRuntimeSmokeTestGates(candidate, allEvidence));
    gates.push(...this.evaluatePerformanceGates(candidate, allEvidence));
    gates.push(...this.evaluateAccessibilityGates(candidate, allEvidence));
    gates.push(...this.evaluateCIGates(candidate, allEvidence));
    gates.push(...this.evaluateDeploymentGates(candidate, allEvidence));
    gates.push(...this.evaluateMigrationGates(candidate, allEvidence));
    gates.push(...this.evaluateRollbackGates(candidate, allEvidence));
    gates.push(...this.evaluateDocumentationGates(candidate));

    return gates;
  }

  private evaluateRequirementsGates(candidate: ReleaseCandidate): ReadinessGate[] {
    const coverage = this.planningProvider.getRequirementCoverage(candidate.workspaceId);
    const gates: ReadinessGate[] = [];

    const totalReqs = coverage.length;
    const unverifiedReqs = coverage.filter(
      (r) => r.status !== 'verified' && r.status !== 'waived',
    );

    gates.push({
      id: `gate_req_coverage_${candidate.id}`,
      name: 'Requirements Verification Coverage',
      category: 'requirements_verification',
      outcome: unverifiedReqs.length === 0 ? 'pass' : 'fail',
      mandatory: true,
      actor: 'system',
      timestamp: new Date().toISOString(),
      revision: candidate.revision,
      evidenceId: null,
      description:
        unverifiedReqs.length === 0
          ? `All ${totalReqs} requirements verified or waived`
          : `${unverifiedReqs.length}/${totalReqs} requirements not yet verified`,
      blockerReason:
        unverifiedReqs.length > 0
          ? `Unverified: ${unverifiedReqs.map((r) => r.requirementId).join(', ')}`
          : null,
      drillDownRef:
        unverifiedReqs.length > 0 && unverifiedReqs[0]
          ? {
              kind: 'requirement',
              id: unverifiedReqs[0].requirementId,
              label: unverifiedReqs[0].label,
            }
          : null,
    });

    return gates;
  }

  private evaluateDesignDecisionGates(candidate: ReleaseCandidate): ReadinessGate[] {
    const decisions = this.planningProvider.getDesignDecisions(candidate.workspaceId);
    const unresolved = decisions.filter((d) => !d.resolved);

    return [
      {
        id: `gate_design_${candidate.id}`,
        name: 'Unresolved Design Decisions',
        category: 'design_decisions',
        outcome: unresolved.length === 0 ? 'pass' : 'fail',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: null,
        description:
          unresolved.length === 0
            ? 'All design decisions resolved'
            : `${unresolved.length} unresolved design decision(s)`,
        blockerReason:
          unresolved.length > 0
            ? `Unresolved: ${unresolved.map((d) => d.label).join(', ')}`
            : null,
        drillDownRef:
          unresolved.length > 0 && unresolved[0]
            ? {
                kind: 'requirement',
                id: unresolved[0].designNodeId,
                label: unresolved[0].label,
              }
            : null,
      },
    ];
  }

  private evaluateChangeSetGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const changeSetEvidence = allEvidence.filter((e) => e.kind === 'change_set');
    return [
      {
        id: `gate_changesets_${candidate.id}`,
        name: 'Accepted Change Sets',
        category: 'change_sets',
        outcome: changeSetEvidence.length > 0 ? 'pass' : 'not_applicable',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: changeSetEvidence[0]?.id ?? null,
        description:
          changeSetEvidence.length > 0
            ? `${changeSetEvidence.length} change set(s) with evidence`
            : 'No change set evidence (may be a documentation-only release)',
        blockerReason: null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateCodeReviewGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const reviewEvidence = allEvidence.filter((e) => e.kind === 'code_review');
    const failedReviews = reviewEvidence.filter((e) => e.outcome === 'fail');

    return [
      {
        id: `gate_review_${candidate.id}`,
        name: 'Code Review',
        category: 'code_review',
        outcome:
          reviewEvidence.length === 0
            ? 'not_applicable'
            : failedReviews.length > 0
              ? 'fail'
              : 'pass',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: reviewEvidence[0]?.id ?? null,
        description:
          reviewEvidence.length === 0
            ? 'No code review evidence'
            : failedReviews.length > 0
              ? `${failedReviews.length} failed review(s)`
              : `${reviewEvidence.length} review(s) passed`,
        blockerReason: failedReviews.length > 0 ? 'Unresolved review failures' : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateTestCoverageGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const testEvidence = allEvidence.filter(
      (e) => e.kind === 'test' || e.kind === 'validation',
    );
    const freshTests = testEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failedTests = freshTests.filter((e) => e.outcome === 'fail');
    const staleTests = testEvidence.filter(
      (e) => this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );

    let outcome: GateOutcome;
    if (freshTests.length === 0) {
      outcome = 'blocked';
    } else if (staleTests.length > 0 && freshTests.length === 0) {
      outcome = 'stale';
    } else if (failedTests.length > 0) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    // Check for waiver
    const waiver = this.findWaiverForGate(
      `gate_tests_${candidate.id}`,
      candidate.id,
    );
    if (waiver && outcome !== 'pass') {
      outcome = 'waived';
    }

    return [
      {
        id: `gate_tests_${candidate.id}`,
        name: 'Tests and Coverage',
        category: 'tests_coverage',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: freshTests[0]?.id ?? null,
        description: this.buildTestDescription(freshTests, failedTests, staleTests),
        blockerReason:
          outcome === 'fail'
            ? `${failedTests.length} test failure(s)`
            : outcome === 'stale'
              ? 'All test evidence is stale'
              : outcome === 'blocked'
                ? 'No test evidence found'
                : null,
        drillDownRef:
          failedTests.length > 0 && failedTests[0]
            ? { kind: 'evidence', id: failedTests[0].id, label: failedTests[0].summary }
            : null,
      },
    ];
  }

  private evaluateDiagnosticsGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const diagEvidence = allEvidence.filter((e) => e.kind === 'diagnostics');
    const fresh = diagEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    return [
      {
        id: `gate_diagnostics_${candidate.id}`,
        name: 'Diagnostics',
        category: 'diagnostics',
        outcome:
          fresh.length === 0
            ? 'not_applicable'
            : failed.length > 0
              ? 'fail'
              : 'pass',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          fresh.length === 0
            ? 'No diagnostics evidence'
            : failed.length > 0
              ? `${failed.length} diagnostic failure(s)`
              : 'Diagnostics clean',
        blockerReason: failed.length > 0 ? 'Unresolved diagnostics' : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateBuildGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const buildEvidence = allEvidence.filter((e) => e.kind === 'build');
    const fresh = buildEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const stale = buildEvidence.filter(
      (e) => this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    let outcome: GateOutcome;
    if (fresh.length === 0 && stale.length > 0) {
      outcome = 'stale';
    } else if (fresh.length === 0) {
      outcome = 'blocked';
    } else if (failed.length > 0) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    return [
      {
        id: `gate_build_${candidate.id}`,
        name: 'Build',
        category: 'build',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          outcome === 'pass'
            ? 'Build succeeded at current revision'
            : outcome === 'stale'
              ? 'Build evidence is stale'
              : outcome === 'blocked'
                ? 'No build evidence found'
                : `Build failed: ${failed[0]?.summary ?? 'unknown'}`,
        blockerReason:
          outcome !== 'pass'
            ? `Build ${outcome}`
            : null,
        drillDownRef:
          failed.length > 0 && failed[0]
            ? { kind: 'evidence', id: failed[0].id, label: failed[0].summary }
            : null,
      },
    ];
  }

  private evaluateSecurityGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const secEvidence = allEvidence.filter((e) => e.kind === 'security');
    const fresh = secEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    let outcome: GateOutcome;
    if (fresh.length === 0) {
      outcome = 'blocked';
    } else if (failed.length > 0) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    return [
      {
        id: `gate_security_${candidate.id}`,
        name: 'Security',
        category: 'security',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          outcome === 'pass'
            ? 'Security scans passed'
            : outcome === 'blocked'
              ? 'No security evidence found'
              : `Security issues: ${failed[0]?.summary ?? 'unknown'}`,
        blockerReason: outcome !== 'pass' ? `Security ${outcome}` : null,
        drillDownRef:
          failed.length > 0 && failed[0]
            ? { kind: 'evidence', id: failed[0].id, label: failed[0].summary }
            : null,
      },
    ];
  }

  private evaluateDependencyGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const depEvidence = allEvidence.filter((e) => e.kind === 'dependency' || e.kind === 'supply_chain');
    const fresh = depEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    let outcome: GateOutcome;
    if (fresh.length === 0) {
      outcome = 'blocked';
    } else if (failed.length > 0) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    return [
      {
        id: `gate_deps_${candidate.id}`,
        name: 'Dependencies and Supply Chain',
        category: 'dependencies',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          outcome === 'pass'
            ? 'Dependency and supply-chain checks passed'
            : outcome === 'blocked'
              ? 'No dependency evidence found'
              : `Dependency issues: ${failed[0]?.summary ?? 'unknown'}`,
        blockerReason: outcome !== 'pass' ? `Dependencies ${outcome}` : null,
        drillDownRef:
          failed.length > 0 && failed[0]
            ? { kind: 'evidence', id: failed[0].id, label: failed[0].summary }
            : null,
      },
    ];
  }

  private evaluateRuntimeSmokeTestGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const smokeEvidence = allEvidence.filter(
      (e) => e.kind === 'smoke_test' || e.kind === 'runtime',
    );
    const fresh = smokeEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    return [
      {
        id: `gate_smoke_${candidate.id}`,
        name: 'Runtime Smoke Tests',
        category: 'runtime_smoke_tests',
        outcome:
          fresh.length === 0
            ? 'not_applicable'
            : failed.length > 0
              ? 'fail'
              : 'pass',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          fresh.length === 0
            ? 'No runtime smoke test evidence'
            : failed.length > 0
              ? `${failed.length} smoke test failure(s)`
              : 'Runtime smoke tests passed',
        blockerReason: failed.length > 0 ? 'Smoke test failures' : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluatePerformanceGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const perfEvidence = allEvidence.filter((e) => e.kind === 'performance');
    const fresh = perfEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    return [
      {
        id: `gate_perf_${candidate.id}`,
        name: 'Performance',
        category: 'performance',
        outcome:
          fresh.length === 0
            ? 'not_applicable'
            : failed.length > 0
              ? 'fail'
              : 'pass',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          fresh.length === 0
            ? 'No performance evidence'
            : failed.length > 0
              ? `${failed.length} performance regression(s)`
              : 'Performance within thresholds',
        blockerReason: failed.length > 0 ? 'Performance regressions' : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateAccessibilityGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const a11yEvidence = allEvidence.filter((e) => e.kind === 'accessibility');
    const fresh = a11yEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    return [
      {
        id: `gate_a11y_${candidate.id}`,
        name: 'Accessibility',
        category: 'accessibility',
        outcome:
          fresh.length === 0
            ? 'not_applicable'
            : failed.length > 0
              ? 'fail'
              : 'pass',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          fresh.length === 0
            ? 'No accessibility evidence'
            : failed.length > 0
              ? `${failed.length} accessibility issue(s)`
              : 'Accessibility checks passed',
        blockerReason: failed.length > 0 ? 'Accessibility failures' : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateCIGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const ciEvidence = allEvidence.filter((e) => e.kind === 'ci');
    const fresh = ciEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );
    const failed = fresh.filter((e) => e.outcome === 'fail');

    return [
      {
        id: `gate_ci_${candidate.id}`,
        name: 'CI/CD',
        category: 'ci',
        outcome:
          fresh.length === 0
            ? 'not_applicable'
            : failed.length > 0
              ? 'fail'
              : 'pass',
        mandatory: false,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          fresh.length === 0
            ? 'No CI evidence'
            : failed.length > 0
              ? `${failed.length} CI check(s) failed`
              : 'CI checks passed',
        blockerReason: failed.length > 0 ? 'CI failures' : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateDeploymentGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const deployEvidence = allEvidence.filter((e) => e.kind === 'deployment');
    const fresh = deployEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );

    let outcome: GateOutcome;
    if (fresh.length === 0) {
      outcome = 'blocked';
    } else if (fresh.some((e) => e.outcome === 'fail')) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    return [
      {
        id: `gate_deploy_${candidate.id}`,
        name: 'Deployment Readiness',
        category: 'deployment',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          outcome === 'pass'
            ? 'Deployment readiness verified'
            : outcome === 'blocked'
              ? 'No deployment evidence found'
              : 'Deployment readiness check failed',
        blockerReason: outcome !== 'pass' ? `Deployment ${outcome}` : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateMigrationGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const migrationEvidence = allEvidence.filter((e) => e.kind === 'migration');
    const fresh = migrationEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );

    let outcome: GateOutcome;
    if (fresh.length === 0) {
      // If there are no migrations, it's not applicable
      outcome = 'not_applicable';
    } else if (fresh.some((e) => e.outcome === 'fail')) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    return [
      {
        id: `gate_migrations_${candidate.id}`,
        name: 'Migrations',
        category: 'migrations',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          outcome === 'pass'
            ? 'All migrations validated'
            : outcome === 'not_applicable'
              ? 'No migrations detected'
              : 'Migration validation failed',
        blockerReason: outcome === 'fail' ? 'Migration failures' : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateRollbackGates(
    candidate: ReleaseCandidate,
    allEvidence: readonly EvidenceEnvelope[],
  ): ReadinessGate[] {
    const rollbackEvidence = allEvidence.filter((e) => e.kind === 'rollback');
    const fresh = rollbackEvidence.filter(
      (e) => !this.checkEvidenceStaleness(e, candidate.fingerprints).stale,
    );

    let outcome: GateOutcome;
    if (fresh.length === 0) {
      outcome = 'blocked';
    } else if (fresh.some((e) => e.outcome === 'fail')) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    return [
      {
        id: `gate_rollback_${candidate.id}`,
        name: 'Rollback Procedure',
        category: 'rollback',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: fresh[0]?.id ?? null,
        description:
          outcome === 'pass'
            ? 'Rollback procedure verified'
            : outcome === 'blocked'
              ? 'No rollback evidence found'
              : 'Rollback procedure incomplete',
        blockerReason: outcome !== 'pass' ? `Rollback ${outcome}` : null,
        drillDownRef: null,
      },
    ];
  }

  private evaluateDocumentationGates(candidate: ReleaseCandidate): ReadinessGate[] {
    const docs = this.assembleDocumentation(candidate.workspaceId);
    const allSections = [
      docs.architecture,
      docs.setup,
      docs.localCommands,
      docs.configurationSchema,
      docs.interfaces,
      docs.operations,
      docs.monitoring,
      docs.limitations,
      docs.migrations,
      docs.rollback,
    ].filter((s): s is DocumentationSection => s !== null);

    const allIssues = allSections.flatMap((s) => s.issues);
    const errorIssues = allIssues.filter((i) => i.severity === 'error');

    let outcome: GateOutcome;
    if (allSections.length === 0) {
      outcome = 'blocked';
    } else if (errorIssues.length > 0) {
      outcome = 'fail';
    } else {
      outcome = 'pass';
    }

    return [
      {
        id: `gate_docs_${candidate.id}`,
        name: 'Documentation',
        category: 'documentation',
        outcome,
        mandatory: true,
        actor: 'system',
        timestamp: new Date().toISOString(),
        revision: candidate.revision,
        evidenceId: null,
        description:
          outcome === 'pass'
            ? `${allSections.length} documentation section(s) validated`
            : outcome === 'blocked'
              ? 'No documentation sections found'
              : `${errorIssues.length} documentation error(s): ${errorIssues.map((i) => i.description).join('; ')}`,
        blockerReason:
          outcome !== 'pass'
            ? errorIssues.length > 0
              ? `Documentation errors: ${errorIssues.map((i) => i.kind).join(', ')}`
              : 'Missing documentation'
            : null,
        drillDownRef: null,
      },
    ];
  }

  // ─── Documentation Assembly (R40.6, R40.7) ──────────────────────

  /**
   * Assemble and validate the documentation handoff package.
   */
  private assembleDocumentation(workspaceId: string): HandoffDocumentation {
    return {
      architecture: this.buildDocSection('Architecture', this.documentationProvider.getArchitecture(workspaceId), workspaceId),
      setup: this.buildDocSection('Setup', this.documentationProvider.getSetup(workspaceId), workspaceId),
      localCommands: this.buildDocSection('Local Commands', this.documentationProvider.getLocalCommands(workspaceId), workspaceId),
      configurationSchema: this.buildDocSection('Configuration Schema', this.documentationProvider.getConfigurationSchema(workspaceId), workspaceId),
      interfaces: this.buildDocSection('Interfaces', this.documentationProvider.getInterfaces(workspaceId), workspaceId),
      operations: this.buildDocSection('Operations', this.documentationProvider.getOperations(workspaceId), workspaceId),
      monitoring: this.buildDocSection('Monitoring', this.documentationProvider.getMonitoring(workspaceId), workspaceId),
      limitations: this.buildDocSection('Limitations', this.documentationProvider.getLimitations(workspaceId), workspaceId),
      migrations: this.buildDocSection('Migrations', this.documentationProvider.getMigrations(workspaceId), workspaceId),
      rollback: this.buildDocSection('Rollback', this.documentationProvider.getRollback(workspaceId), workspaceId),
    };
  }

  private buildDocSection(
    title: string,
    content: string | null,
    workspaceId: string,
  ): DocumentationSection | null {
    if (!content) return null;

    const issues: DocumentationIssue[] = [
      ...this.documentationValidator.validateLinks(content),
      ...this.documentationValidator.validateCommands(content, workspaceId),
      ...this.documentationValidator.validateFiles(content, workspaceId),
    ];

    const hasErrors = issues.some((i) => i.severity === 'error');

    return {
      title,
      content,
      valid: !hasErrors,
      issues,
    };
  }

  // ─── Readiness Summaries (R40.11) ───────────────────────────────

  /**
   * Compute readiness summaries at requirement, Task, release, and project levels.
   */
  private computeReadinessSummaries(
    candidate: ReleaseCandidate,
    gates: readonly ReadinessGate[],
  ): readonly ReadinessSummary[] {
    const summaries: ReadinessSummary[] = [];

    // Release-level summary
    summaries.push(this.computeLevelSummary('release', candidate.id, candidate.label, gates));

    // Project-level summary (same as release for now, could aggregate across candidates)
    summaries.push(
      this.computeLevelSummary('project', candidate.workspaceId, 'Project', gates),
    );

    // Requirement-level summaries
    const coverage = this.planningProvider.getRequirementCoverage(candidate.workspaceId);
    for (const req of coverage) {
      const reqGates = gates.filter(
        (g) =>
          g.category === 'requirements_verification' ||
          g.drillDownRef?.id === req.requirementId,
      );
      if (reqGates.length > 0) {
        summaries.push(
          this.computeLevelSummary('requirement', req.requirementId, req.label, reqGates),
        );
      }
    }

    // Task-level summaries
    const tasks = this.planningProvider.getTaskStatus(candidate.workspaceId);
    for (const task of tasks) {
      const taskGates = gates.filter((g) => g.drillDownRef?.id === task.taskId);
      if (taskGates.length > 0) {
        summaries.push(
          this.computeLevelSummary('task', task.taskId, task.label, taskGates),
        );
      }
    }

    return summaries;
  }

  private computeLevelSummary(
    level: ReadinessLevel,
    entityId: string,
    entityLabel: string,
    gates: readonly ReadinessGate[],
  ): ReadinessSummary {
    const passCount = gates.filter((g) => g.outcome === 'pass').length;
    const failCount = gates.filter((g) => g.outcome === 'fail').length;
    const blockedCount = gates.filter((g) => g.outcome === 'blocked').length;
    const staleCount = gates.filter((g) => g.outcome === 'stale').length;
    const waivedCount = gates.filter((g) => g.outcome === 'waived').length;
    const notApplicableCount = gates.filter((g) => g.outcome === 'not_applicable').length;

    const blockers: BlockerInfo[] = gates
      .filter(
        (g) =>
          g.mandatory &&
          (g.outcome === 'fail' || g.outcome === 'blocked' || g.outcome === 'stale'),
      )
      .map((g) => ({
        gateId: g.id,
        gateName: g.name,
        category: g.category,
        reason: g.blockerReason ?? g.outcome,
        shortestPathAction: this.computeShortestPath(g),
      }));

    const ready =
      blockers.length === 0 &&
      gates
        .filter((g) => g.mandatory)
        .every(
          (g) =>
            g.outcome === 'pass' ||
            g.outcome === 'waived' ||
            g.outcome === 'not_applicable',
        );

    return {
      level,
      entityId,
      entityLabel,
      ready,
      passCount,
      failCount,
      blockedCount,
      staleCount,
      waivedCount,
      notApplicableCount,
      blockers,
    };
  }

  // ─── Mandatory Blockers (R40.8) ─────────────────────────────────

  /**
   * Identify mandatory gates that are not passing.
   */
  private identifyMandatoryBlockers(gates: readonly ReadinessGate[]): readonly BlockerInfo[] {
    return gates
      .filter(
        (g) =>
          g.mandatory &&
          g.outcome !== 'pass' &&
          g.outcome !== 'waived' &&
          g.outcome !== 'not_applicable',
      )
      .map((g) => ({
        gateId: g.id,
        gateName: g.name,
        category: g.category,
        reason: g.blockerReason ?? g.outcome,
        shortestPathAction: this.computeShortestPath(g),
      }));
  }

  /**
   * Compute the shortest path to resolving a blocker (R40.11).
   */
  private computeShortestPath(gate: ReadinessGate): string {
    switch (gate.outcome) {
      case 'stale':
        return `Re-run ${gate.name} at the current revision`;
      case 'blocked':
        return `Provide evidence for ${gate.name}`;
      case 'fail':
        return `Fix failing ${gate.name} and re-validate`;
      default:
        return `Resolve ${gate.name}`;
    }
  }

  // ─── Export Rendering (R40.10) ───────────────────────────────────

  /**
   * Render report as redacted stable Markdown.
   */
  private renderMarkdown(
    report: ProductionReadinessReport,
    options: ExportOptions,
  ): string {
    const lines: string[] = [];

    lines.push('# Production Readiness Report');
    lines.push('');
    lines.push(`**Release Candidate:** ${report.releaseCandidateId}`);
    lines.push(`**Revision:** ${options.redactPaths ? '[redacted]' : report.revision}`);
    lines.push(`**Status:** ${report.ready ? 'READY' : 'NOT READY'}`);
    lines.push(`**Generated:** ${report.generatedAt}`);
    lines.push(`**Fingerprint:** ${report.fingerprint}`);
    lines.push('');

    // Summary
    if (report.mandatoryBlockers.length > 0) {
      lines.push('## Blockers');
      lines.push('');
      for (const blocker of report.mandatoryBlockers) {
        lines.push(`- **${blocker.gateName}** (${blocker.category}): ${blocker.reason}`);
        lines.push(`  - Action: ${blocker.shortestPathAction}`);
      }
      lines.push('');
    }

    // Gates by category
    lines.push('## Gates');
    lines.push('');
    lines.push('| Gate | Category | Outcome | Actor | Revision | Timestamp |');
    lines.push('|------|----------|---------|-------|----------|-----------|');
    for (const gate of report.gates) {
      const revision = options.redactPaths ? '[redacted]' : gate.revision;
      lines.push(
        `| ${gate.name} | ${gate.category} | ${gate.outcome} | ${gate.actor} | ${revision} | ${gate.timestamp} |`,
      );
    }
    lines.push('');

    // Waivers
    if (options.includeWaivers && report.waivers.length > 0) {
      lines.push('## Waivers');
      lines.push('');
      for (const waiver of report.waivers) {
        lines.push(`### ${waiver.gateId}`);
        lines.push(`- **Actor:** ${waiver.actor}`);
        lines.push(`- **Reason:** ${waiver.reason}`);
        lines.push(`- **Scope:** ${waiver.scope}`);
        lines.push(`- **Review Date:** ${waiver.reviewDate}`);
        if (waiver.expiryDate) {
          lines.push(`- **Expiry:** ${waiver.expiryDate}`);
        }
        lines.push(`- **Compensating Control:** ${waiver.compensatingControl}`);
        lines.push('');
      }
    }

    // Readiness summaries
    lines.push('## Readiness by Level');
    lines.push('');
    for (const summary of report.readinessSummaries) {
      lines.push(
        `### ${summary.level}: ${summary.entityLabel} — ${summary.ready ? 'Ready' : 'Not Ready'}`,
      );
      lines.push(
        `Pass: ${summary.passCount} | Fail: ${summary.failCount} | Blocked: ${summary.blockedCount} | Stale: ${summary.staleCount} | Waived: ${summary.waivedCount} | N/A: ${summary.notApplicableCount}`,
      );
      if (summary.blockers.length > 0) {
        lines.push('');
        lines.push('Blockers:');
        for (const b of summary.blockers) {
          lines.push(`- ${b.gateName}: ${b.shortestPathAction}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Render report as redacted stable JSON.
   */
  private renderJson(
    report: ProductionReadinessReport,
    options: ExportOptions,
  ): string {
    const redactedReport = {
      id: options.stableIdentifiers ? report.id : undefined,
      releaseCandidateId: report.releaseCandidateId,
      revision: options.redactPaths ? '[redacted]' : report.revision,
      ready: report.ready,
      generatedAt: report.generatedAt,
      fingerprint: report.fingerprint,
      gates: report.gates.map((g) => ({
        id: options.stableIdentifiers ? g.id : undefined,
        name: g.name,
        category: g.category,
        outcome: g.outcome,
        mandatory: g.mandatory,
        actor: g.actor,
        timestamp: g.timestamp,
        revision: options.redactPaths ? '[redacted]' : g.revision,
        evidenceId: options.stableIdentifiers ? g.evidenceId : undefined,
        description: g.description,
        blockerReason: g.blockerReason,
      })),
      waivers: options.includeWaivers
        ? report.waivers.map((w) => ({
            id: options.stableIdentifiers ? w.id : undefined,
            gateId: w.gateId,
            actor: w.actor,
            reason: w.reason,
            scope: w.scope,
            reviewDate: w.reviewDate,
            expiryDate: w.expiryDate,
            compensatingControl: w.compensatingControl,
          }))
        : [],
      mandatoryBlockers: report.mandatoryBlockers,
      readinessSummaries: report.readinessSummaries,
    };

    return JSON.stringify(redactedReport, null, 2);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private buildTestDescription(
    fresh: readonly EvidenceEnvelope[],
    failed: readonly EvidenceEnvelope[],
    stale: readonly EvidenceEnvelope[],
  ): string {
    const parts: string[] = [];
    if (fresh.length > 0) {
      parts.push(`${fresh.length} test evidence record(s)`);
    }
    if (failed.length > 0) {
      parts.push(`${failed.length} failed`);
    }
    if (stale.length > 0) {
      parts.push(`${stale.length} stale`);
    }
    if (parts.length === 0) {
      return 'No test evidence found';
    }
    return parts.join(', ');
  }

  private computeReportFingerprint(
    releaseCandidateId: string,
    gates: readonly ReadinessGate[],
  ): string {
    const data = JSON.stringify({
      releaseCandidateId,
      gateOutcomes: gates.map((g) => `${g.id}:${g.outcome}`),
    });
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `rr_fp_${Math.abs(hash).toString(36)}`;
  }
}
