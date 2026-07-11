/**
 * Security Remediation Bridge — Routes blocked security findings to the self-healing loop
 * for automated repair, applies corrected edits on success, and marks tasks as blocked
 * on exhaustion.
 *
 * Distinguishes application failures (file system errors, merge conflicts — no retry)
 * from security failures (retry up to maxAttempts with escalating context).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import type {
  AgentEdit,
  ProjectContext,
  VerificationResult,
} from './verification-gate/types';
import type { RealtimeAnalysisFinding } from '../runtime-security/realtime-code-analyzer.js';
import type {
  SelfHealingConfig,
  SelfHealingResult,
  RepairAgent,
  VerificationRunner,
  RepairFeedback,
} from './self-healing-loop';
import {
  DEFAULT_SELF_HEALING_CONFIG,
  runSelfHealingLoop,
} from './self-healing-loop';
import type { SecurityEvidenceStore } from '../runtime-security/security-evidence-store.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * A structured repair request containing all context needed for the self-healing loop
 * to remediate a blocked write.
 *
 * Requirement 10.2: Contains original file content, the attempted edit, all security
 * findings with their remediation strings, and the originating agent context.
 */
export interface RepairRequest {
  /** The original file content before the attempted edit */
  originalContent: string;
  /** The attempted edit that was blocked */
  blockedEdit: AgentEdit;
  /** All security findings that caused the block */
  findings: RealtimeAnalysisFinding[];
  /** The originating agent context (agentId, sessionId) */
  agentContext: { agentId: string; sessionId: string };
}

/**
 * Result of a remediation attempt.
 */
export interface RemediationResult {
  /** Whether the remediation succeeded */
  success: boolean;
  /** The corrected edit (if successful) */
  correctedEdit?: AgentEdit;
  /** Reason for failure (if unsuccessful) */
  failureReason?: string;
  /** Whether the task was marked as blocked */
  taskBlocked: boolean;
}

// ─── Remediation Tracking ───────────────────────────────────────

/**
 * Tracks remediation success/failure per finding category for observability.
 * Provides escalating context on retries.
 */
export interface RemediationStats {
  /** Total attempts for this finding category */
  totalAttempts: number;
  /** Total successes for this finding category */
  successes: number;
  /** Total failures for this finding category */
  failures: number;
  /** Previous remediation hints used (for escalating context) */
  previousHints: string[];
}

// ─── Error Types ────────────────────────────────────────────────

/**
 * Represents an application-level failure (file system, merge conflict) that
 * should NOT be retried. Distinct from security failures which can be retried.
 * Requirement 10.4: Distinguish application failures from security failures.
 */
export class ApplicationFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationFailureError';
  }
}

// ─── Edit Applier Interface ─────────────────────────────────────

/**
 * Interface for applying edits to the file system.
 * Separated to allow distinguishing application failures from security failures.
 */
export interface EditApplier {
  /**
   * Apply an edit to the file system.
   * @throws ApplicationFailureError if the edit cannot be applied (file system errors, merge conflicts)
   */
  apply(edit: AgentEdit, context: ProjectContext): Promise<void>;
}

// ─── Task Blocker Interface ─────────────────────────────────────

/**
 * Interface for marking tasks as blocked and notifying the user.
 */
export interface TaskBlocker {
  /** Mark the task as blocked with full finding context */
  markBlocked(
    taskId: string,
    findings: RealtimeAnalysisFinding[],
    attempts: number,
    lastFailureReason?: string,
  ): Promise<void>;
}

// ─── Security Remediation Bridge ────────────────────────────────

export class SecurityRemediationBridge {
  /** Per-category remediation tracking for observability */
  private readonly stats = new Map<string, RemediationStats>();

  constructor(
    private readonly repairAgent: RepairAgent,
    private readonly verifier: VerificationRunner,
    private readonly config: SelfHealingConfig = DEFAULT_SELF_HEALING_CONFIG,
    private readonly editApplier?: EditApplier,
    private readonly taskBlocker?: TaskBlocker,
    private readonly evidenceStore?: SecurityEvidenceStore,
  ) {}

  /**
   * Remediate a blocked write by routing to the self-healing loop.
   *
   * Requirement 10.1: Constructs RepairRequest from blocked edit and findings.
   * Requirement 10.3: Invokes runSelfHealingLoop with the RepairRequest.
   * Requirement 10.4: Applies corrected edit on success; marks task blocked on exhaustion.
   *                   Distinguishes application failures (no retry) from security failures (retry).
   * Requirement 10.5: Marks task as blocked and notifies user with full finding context on exhaustion.
   */
  async remediate(
    request: RepairRequest,
    context: ProjectContext,
  ): Promise<RemediationResult> {
    // Validate the RepairRequest completeness (Property 18)
    const validationError = this.validateRequest(request);
    if (validationError) {
      return {
        success: false,
        failureReason: validationError,
        taskBlocked: false,
      };
    }

    // Build initial verification result from findings for the self-healing loop
    const initialResult = this.buildInitialVerificationResult(request);

    // Build security-aware feedback with remediation hints (Requirement 9.4)
    // This provides escalating context on retries
    const categoryHints = this.getEscalatingContext(request.findings);

    // Invoke the self-healing loop (Requirement 10.3)
    let healingResult: SelfHealingResult;
    try {
      healingResult = await runSelfHealingLoop(
        request.blockedEdit,
        initialResult,
        this.createSecurityAwareRepairAgent(request, categoryHints),
        this.verifier,
        context,
        this.config,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.trackFailure(request.findings, message);
      return {
        success: false,
        failureReason: `Self-healing loop error: ${message}`,
        taskBlocked: false,
      };
    }

    // Handle the result
    if (healingResult.accepted && healingResult.finalEdit) {
      // Try to apply the corrected edit (Requirement 10.4)
      try {
        if (this.editApplier) {
          await this.editApplier.apply(healingResult.finalEdit, context);
        }
        this.trackSuccess(request.findings);
        return {
          success: true,
          correctedEdit: healingResult.finalEdit,
          taskBlocked: false,
        };
      } catch (err: unknown) {
        // Application failure (file system error, merge conflict) — no retry
        // Requirement 10.4: Distinguish application failures from security failures
        if (err instanceof ApplicationFailureError) {
          const message = err.message;
          await this.blockTask(request, `Application failure: ${message}`);
          return {
            success: false,
            failureReason: `Application failure (no retry): ${message}`,
            taskBlocked: true,
          };
        }
        // Unexpected error during apply — also treat as non-retryable
        const message = err instanceof Error ? err.message : String(err);
        await this.blockTask(request, `Edit application error: ${message}`);
        return {
          success: false,
          failureReason: `Edit application error: ${message}`,
          taskBlocked: true,
        };
      }
    }

    // Self-healing loop exhausted (Requirement 10.5)
    const reason = healingResult.escalationReason === 'token_budget_exceeded'
      ? 'Token budget exceeded'
      : 'Maximum repair attempts exceeded';

    this.trackFailure(request.findings, reason);
    await this.blockTask(request, reason);

    return {
      success: false,
      failureReason: `Remediation failed: ${reason}. Attempts: ${healingResult.attempts.length}`,
      taskBlocked: true,
    };
  }

  /**
   * Get remediation stats for a specific finding category.
   */
  getStats(category: string): RemediationStats | undefined {
    return this.stats.get(category);
  }

  /**
   * Get all remediation stats (for observability dashboards).
   */
  getAllStats(): Map<string, RemediationStats> {
    return new Map(this.stats);
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Validate that a RepairRequest contains all required fields (Property 18).
   */
  private validateRequest(request: RepairRequest): string | null {
    if (!request.originalContent && request.originalContent !== '') {
      return 'RepairRequest must contain originalContent';
    }
    if (!request.blockedEdit) {
      return 'RepairRequest must contain blockedEdit';
    }
    if (!request.findings || request.findings.length === 0) {
      return 'RepairRequest must contain at least one finding';
    }
    if (!request.agentContext?.agentId || !request.agentContext?.sessionId) {
      return 'RepairRequest must contain valid agentContext with agentId and sessionId';
    }
    // Ensure at least one finding has a remediation string
    const hasRemediation = request.findings.some(f => f.remediation && f.remediation.length > 0);
    if (!hasRemediation) {
      return 'RepairRequest must contain at least one finding with a remediation string';
    }
    return null;
  }

  /**
   * Build an initial VerificationResult from findings to seed the self-healing loop.
   */
  private buildInitialVerificationResult(request: RepairRequest): VerificationResult {
    const diagnostics = request.findings.map(finding => ({
      file: finding.file,
      line: finding.line,
      column: 0,
      message: `[${finding.category}] ${finding.message} — Remediation: ${finding.remediation}`,
      severity: (finding.severity === 'critical' || finding.severity === 'high'
        ? 'error'
        : 'warning') as 'error' | 'warning',
    }));

    return {
      totalScore: 0,
      maxScore: 18,
      stages: [
        {
          stageName: 'security',
          passed: false,
          diagnostics,
          durationMs: 0,
        },
      ],
      accepted: false,
      failedAt: 'security',
      totalDurationMs: 0,
    };
  }

  /**
   * Create a security-aware repair agent that augments repair feedback with
   * remediation hints and escalating context on retries (Requirement 9.4, 9.6).
   */
  private createSecurityAwareRepairAgent(
    request: RepairRequest,
    categoryHints: Map<string, string[]>,
  ): RepairAgent {
    let attemptCount = 0;

    return {
      repair: async (originalEdit, feedback, context) => {
        attemptCount++;

        // Augment feedback with security-specific remediation hints
        const augmentedFeedback = this.augmentFeedbackWithRemediation(
          feedback,
          request.findings,
          categoryHints,
          attemptCount,
        );

        // Delegate to the underlying repair agent with augmented feedback
        return this.repairAgent.repair(originalEdit, augmentedFeedback, context);
      },
    };
  }

  /**
   * Augment repair feedback with remediation hints from security findings.
   * Provides escalating context on retries (Requirement 9.6).
   *
   * Requirement 22.2: Formats findings as "Security violation at {file}:{line} — {category}: {remediation}"
   * to match the same format used by constructFeedback() for verification-gate security failures.
   *
   * Requirement 22.3: Security-blocked writes are treated identically to verification-gate failures
   * — same RepairFeedback format, same self-healing loop path.
   *
   * Property 17: For any security finding with a non-empty remediation string,
   * the resulting RepairFeedback.errorMessage SHALL contain the remediation text.
   */
  private augmentFeedbackWithRemediation(
    feedback: RepairFeedback[],
    findings: RealtimeAnalysisFinding[],
    categoryHints: Map<string, string[]>,
    attemptNumber: number,
  ): RepairFeedback[] {
    const augmented: RepairFeedback[] = [...feedback];

    // Add remediation-specific feedback for each finding
    for (const finding of findings) {
      const existingIndex = augmented.findIndex(
        f => f.filePath === finding.file && f.lineNumber === finding.line,
      );

      const file = finding.file || 'unknown';
      const line = Math.max(1, finding.line || 1);
      const remediationHint = finding.remediation || 'Fix the security issue';
      const previousHints = categoryHints.get(finding.category) || [];

      // Format identically to constructFeedback() in self-healing-loop.ts (Req 22.2)
      // "Security violation at {file}:{line} — {category}: {remediation}"
      let contextStr = `Security violation at ${file}:${line} — ${finding.category}: ${remediationHint}`;
      if (attemptNumber > 1 && previousHints.length > 0) {
        contextStr += ` [Attempt ${attemptNumber}; previous approaches failed: ${previousHints.slice(-2).join('; ')}]`;
      }

      if (existingIndex >= 0) {
        // Augment existing feedback with remediation hint
        const existing = augmented[existingIndex]!;
        augmented[existingIndex] = {
          stage: existing.stage,
          errorMessage: `${existing.errorMessage} — ${contextStr}`,
          filePath: existing.filePath,
          lineNumber: existing.lineNumber,
        };
      } else {
        // Add new feedback entry for this finding (Req 22.1, 22.3)
        // Identical structure to verification-gate failures — same stage, same format
        augmented.push({
          stage: 'security',
          errorMessage: contextStr,
          filePath: file,
          lineNumber: line,
        });
      }
    }

    return augmented;
  }

  /**
   * Get escalating context from previous remediation attempts for each finding category.
   */
  private getEscalatingContext(findings: RealtimeAnalysisFinding[]): Map<string, string[]> {
    const hints = new Map<string, string[]>();
    for (const finding of findings) {
      const stats = this.stats.get(finding.category);
      if (stats) {
        hints.set(finding.category, [...stats.previousHints]);
      } else {
        hints.set(finding.category, []);
      }
    }
    return hints;
  }

  /**
   * Track a successful remediation for observability.
   * Records in both the in-memory stats map and the SecurityEvidenceStore (Req 22.5).
   */
  private trackSuccess(findings: RealtimeAnalysisFinding[]): void {
    for (const finding of findings) {
      const stats = this.getOrCreateStats(finding.category);
      stats.successes++;
      stats.totalAttempts++;
      stats.previousHints.push(finding.remediation);
      // Keep history bounded
      if (stats.previousHints.length > 10) {
        stats.previousHints.shift();
      }

      // Persist to SecurityEvidenceStore for dashboard observability (Req 22.5)
      this.recordRemediationEvidence(finding, 'allowed');
    }
  }

  /**
   * Track a failed remediation for observability.
   * Records in both the in-memory stats map and the SecurityEvidenceStore (Req 22.5).
   */
  private trackFailure(findings: RealtimeAnalysisFinding[], reason: string): void {
    for (const finding of findings) {
      const stats = this.getOrCreateStats(finding.category);
      stats.failures++;
      stats.totalAttempts++;
      stats.previousHints.push(`Failed: ${reason}`);
      // Keep history bounded
      if (stats.previousHints.length > 10) {
        stats.previousHints.shift();
      }

      // Persist to SecurityEvidenceStore for dashboard observability (Req 22.5)
      this.recordRemediationEvidence(finding, 'blocked', reason);
    }
  }

  /**
   * Get or create stats for a finding category.
   */
  private getOrCreateStats(category: string): RemediationStats {
    let stats = this.stats.get(category);
    if (!stats) {
      stats = {
        totalAttempts: 0,
        successes: 0,
        failures: 0,
        previousHints: [],
      };
      this.stats.set(category, stats);
    }
    return stats;
  }

  /**
   * Record a remediation event in the SecurityEvidenceStore for observability (Req 22.5).
   * Gracefully handles missing store or recording errors.
   */
  private recordRemediationEvidence(
    finding: RealtimeAnalysisFinding,
    decision: 'blocked' | 'allowed',
    failureReason?: string,
  ): void {
    if (!this.evidenceStore) return;

    try {
      this.evidenceStore.record({
        sourceSubsystem: 'security_remediation_bridge',
        eventType: 'remediation_applied',
        severity: (finding.severity as 'critical' | 'high' | 'medium' | 'low') ?? 'medium',
        affectedFiles: finding.file ? [finding.file] : [],
        findingDetails: JSON.stringify({
          category: finding.category,
          message: finding.message,
          remediation: finding.remediation,
          outcome: decision === 'allowed' ? 'success' : 'failure',
          failureReason,
        }),
        decision,
        sessionId: 'remediation',
      });
    } catch {
      // Graceful degradation — evidence recording failure must not disrupt remediation
    }
  }

  /**
   * Mark the task as blocked and notify user (Requirement 10.5).
   */
  private async blockTask(request: RepairRequest, reason: string): Promise<void> {
    if (this.taskBlocker) {
      const category = request.findings[0]?.category ?? 'unknown';
      const stats = this.stats.get(category);
      await this.taskBlocker.markBlocked(
        request.blockedEdit.taskId,
        request.findings,
        stats?.totalAttempts ?? 0,
        reason,
      );
    }
  }
}
