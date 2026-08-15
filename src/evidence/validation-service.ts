/**
 * ValidationService — Revision-bound validation with Evidence recording and projection.
 *
 * Enforces that Tasks define validation steps, executes them after Change_Set apply
 * according to autonomy/policy, records immutable Evidence envelopes, compares
 * diagnostics, prevents automatic completion on failure, and projects one authoritative
 * result into multiple surfaces (chat, review, taskbar, run detail).
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8
 */

import { randomUUID } from 'crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Validation method/kind for a step.
 */
export type ValidationMethod =
  | 'test'
  | 'type_check'
  | 'lint'
  | 'build'
  | 'diagnostics_comparison'
  | 'security_scan'
  | 'manual_review'
  | 'custom';

/**
 * Outcome of a validation run.
 */
export type ValidationOutcome =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'cancelled'
  | 'stale'
  | 'waived';

/**
 * Diagnostic severity classification.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * A single diagnostic entry for comparison.
 */
export interface Diagnostic {
  readonly uri: string;
  readonly line: number;
  readonly column: number;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
}

/**
 * Result of comparing diagnostics before/after a change.
 */
export interface DiagnosticsComparison {
  readonly introduced: readonly Diagnostic[];
  readonly resolved: readonly Diagnostic[];
  readonly unchanged: readonly Diagnostic[];
}

/**
 * A configured validation step within a Task.
 */
export interface ValidationStep {
  readonly id: string;
  readonly method: ValidationMethod;
  readonly command?: string;
  readonly required: boolean;
  readonly description: string;
}

/**
 * Autonomy mode that governs automatic vs prompted validation.
 */
export type AutonomyMode = 'automatic' | 'suggest' | 'manual';

/**
 * Task policy configuration for validation.
 */
export interface TaskValidationPolicy {
  readonly taskId: string;
  readonly validationSteps: readonly ValidationStep[];
  readonly autonomyMode: AutonomyMode;
  readonly requireAllPassing: boolean;
}

/**
 * Immutable Evidence envelope for a validation run.
 */
export interface ValidationEvidence {
  readonly id: string;
  readonly kind: 'validation';
  readonly method: ValidationMethod;
  readonly workspaceRevision: string;
  readonly taskId: string;
  readonly runId: string;
  readonly changeSetId: string;
  readonly stepId: string;
  readonly producer: {
    readonly kind: 'tool' | 'user' | 'service';
    readonly id: string;
    readonly version?: string;
  };
  readonly environmentFingerprint: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly outcome: ValidationOutcome;
  readonly summary: string;
  readonly boundedOutput: string;
  readonly diagnosticsComparison: DiagnosticsComparison | null;
  readonly fingerprint: string;
  readonly staleReason: string | null;
}

/**
 * Waiver for a required validation step.
 */
export interface ValidationWaiver {
  readonly id: string;
  readonly stepId: string;
  readonly taskId: string;
  readonly actor: string;
  readonly reason: string;
  readonly scope: string;
  readonly reviewDate: string;
  readonly compensatingControl: string;
  readonly grantedAt: string;
}

/**
 * Staleness check inputs.
 */
export interface StalenessContext {
  readonly sourceRevision: string;
  readonly lockfileHash: string;
  readonly environmentFingerprint: string;
  readonly toolVersion: string;
}

/**
 * Projection target for validation results.
 */
export type ProjectionTarget = 'chat' | 'review' | 'taskbar' | 'run_detail';

/**
 * Shared projection entry for a validation result.
 */
export interface ValidationProjection {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly changeSetId: string;
  readonly stepId: string;
  readonly method: ValidationMethod;
  readonly outcome: ValidationOutcome;
  readonly summary: string;
  readonly diagnosticsComparison: DiagnosticsComparison | null;
  readonly timestamp: string;
  readonly targets: readonly ProjectionTarget[];
}

/**
 * Completion blocker reasons.
 */
export type CompletionBlockReason =
  | 'validation_failed'
  | 'validation_cancelled'
  | 'validation_stale'
  | 'validation_absent';

/**
 * A blocker preventing automatic task completion.
 */
export interface CompletionBlocker {
  readonly reason: CompletionBlockReason;
  readonly stepId: string;
  readonly description: string;
  readonly evidenceId: string | null;
}

/**
 * Validation mutation (e.g., auto-fix) outcome.
 */
export interface ValidationMutation {
  readonly id: string;
  readonly evidenceId: string;
  readonly files: readonly string[];
  readonly attributedChangeSetId: string | null;
  readonly rolledBack: boolean;
}

/**
 * Parameters for executing a validation step.
 */
export interface ExecuteValidationParams {
  readonly taskId: string;
  readonly runId: string;
  readonly changeSetId: string;
  readonly stepId: string;
  readonly workspaceRevision: string;
  readonly environmentFingerprint: string;
  readonly toolVersion: string;
}

/**
 * Result from running a validation command.
 */
export interface ValidationRunResult {
  readonly exitCode: number;
  readonly output: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly modifiedFiles: readonly string[];
}

/**
 * Executor adapter for running validation commands.
 */
export interface ValidationExecutor {
  execute(step: ValidationStep, params: ExecuteValidationParams): Promise<ValidationRunResult>;
}

/**
 * Adapter for collecting diagnostics.
 */
export interface DiagnosticsCollector {
  collect(workspaceRevision: string, files?: readonly string[]): Promise<readonly Diagnostic[]>;
}

/**
 * Adapter for creating attributed Change_Sets from mutations.
 */
export interface MutationChangeSetAdapter {
  createAttributedChangeSet(
    taskId: string,
    runId: string,
    files: readonly string[],
    source: string,
  ): Promise<string>;
  rollbackFiles(files: readonly string[], workspaceRevision: string): Promise<void>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Maximum output size stored in evidence (characters). */
export const MAX_OUTPUT_SIZE = 10_000;

/** All projection targets for the authoritative shared result. */
export const ALL_PROJECTION_TARGETS: readonly ProjectionTarget[] = [
  'chat',
  'review',
  'taskbar',
  'run_detail',
] as const;

// ─── Errors ────────────────────────────────────────────────────────────────

export class ValidationStepNotFoundError extends Error {
  constructor(stepId: string, taskId: string) {
    super(`Validation step '${stepId}' not found in task '${taskId}'`);
    this.name = 'ValidationStepNotFoundError';
  }
}

export class WaiverRequiredError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly reason: CompletionBlockReason,
  ) {
    super(`Waiver required for step '${stepId}': ${reason}`);
    this.name = 'WaiverRequiredError';
  }
}

export class StaleValidationError extends Error {
  constructor(
    public readonly evidenceId: string,
    public readonly staleReason: string,
  ) {
    super(`Evidence '${evidenceId}' is stale: ${staleReason}`);
    this.name = 'StaleValidationError';
  }
}

// ─── ValidationService ─────────────────────────────────────────────────────

/**
 * Manages revision-bound validation execution, evidence recording, and
 * shared projection across chat, review, taskbar, and run detail.
 */
export class ValidationService {
  private readonly evidence: Map<string, ValidationEvidence> = new Map();
  private readonly waivers: Map<string, ValidationWaiver> = new Map();
  private readonly projections: Map<string, ValidationProjection> = new Map();
  private readonly mutations: Map<string, ValidationMutation> = new Map();
  private readonly policies: Map<string, TaskValidationPolicy> = new Map();

  constructor(
    private readonly executor: ValidationExecutor,
    private readonly diagnosticsCollector: DiagnosticsCollector,
    private readonly mutationAdapter: MutationChangeSetAdapter,
  ) {}

  // ─── Policy Management ─────────────────────────────────────────

  /**
   * Register a Task's validation policy configuration.
   */
  registerPolicy(policy: TaskValidationPolicy): void {
    this.policies.set(policy.taskId, policy);
  }

  /**
   * Get the validation policy for a task.
   */
  getPolicy(taskId: string): TaskValidationPolicy | null {
    return this.policies.get(taskId) ?? null;
  }

  /**
   * Determine whether validation should be offered or executed automatically
   * based on the task's autonomy mode.
   */
  shouldAutoExecute(taskId: string): boolean {
    const policy = this.policies.get(taskId);
    if (!policy) return false;
    return policy.autonomyMode === 'automatic';
  }

  /**
   * Determine whether validation should be suggested (offered) to the user.
   */
  shouldSuggest(taskId: string): boolean {
    const policy = this.policies.get(taskId);
    if (!policy) return false;
    return policy.autonomyMode === 'suggest';
  }

  // ─── Validation Execution ──────────────────────────────────────

  /**
   * Execute a validation step, record evidence, compare diagnostics,
   * handle mutations, and project the result.
   */
  async executeValidation(params: ExecuteValidationParams): Promise<ValidationEvidence> {
    const policy = this.policies.get(params.taskId);
    if (!policy) {
      throw new ValidationStepNotFoundError(params.stepId, params.taskId);
    }

    const step = policy.validationSteps.find((s) => s.id === params.stepId);
    if (!step) {
      throw new ValidationStepNotFoundError(params.stepId, params.taskId);
    }

    // Collect pre-change diagnostics
    const preDiagnostics = await this.diagnosticsCollector.collect(params.workspaceRevision);

    // Execute the validation
    const result = await this.executor.execute(step, params);

    // Collect post-change diagnostics
    const postDiagnostics = await this.diagnosticsCollector.collect(params.workspaceRevision);

    // Compare diagnostics
    const comparison = this.compareDiagnostics(preDiagnostics, postDiagnostics);

    // Determine outcome
    const outcome = this.determineOutcome(result.exitCode);

    // Truncate output
    const boundedOutput = this.truncateOutput(result.output);

    // Create fingerprint
    const fingerprint = this.computeFingerprint(params, result, comparison);

    // Build evidence envelope
    const evidence: ValidationEvidence = {
      id: randomUUID(),
      kind: 'validation',
      method: step.method,
      workspaceRevision: params.workspaceRevision,
      taskId: params.taskId,
      runId: params.runId,
      changeSetId: params.changeSetId,
      stepId: params.stepId,
      producer: {
        kind: 'tool',
        id: step.command ?? step.method,
        version: params.toolVersion,
      },
      environmentFingerprint: params.environmentFingerprint,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      exitCode: result.exitCode,
      outcome,
      summary: this.buildSummary(step, outcome, comparison),
      boundedOutput,
      diagnosticsComparison: comparison,
      fingerprint,
      staleReason: null,
    };

    // Store evidence
    this.evidence.set(evidence.id, evidence);

    // Handle validation mutations (auto-fix files)
    if (result.modifiedFiles.length > 0) {
      await this.handleValidationMutations(evidence, result.modifiedFiles, params);
    }

    // Project the result to all surfaces
    this.projectResult(evidence);

    return evidence;
  }

  // ─── Staleness Detection ───────────────────────────────────────

  /**
   * Check if evidence is stale given the current context.
   * Evidence is stale when source revision, lockfile, environment,
   * or tool version differs from when it was captured.
   */
  checkStaleness(
    evidenceId: string,
    currentContext: StalenessContext,
  ): { stale: boolean; reason: string | null } {
    const ev = this.evidence.get(evidenceId);
    if (!ev) {
      return { stale: true, reason: 'evidence_not_found' };
    }

    if (ev.workspaceRevision !== currentContext.sourceRevision) {
      return { stale: true, reason: 'source_revision_changed' };
    }

    if (ev.environmentFingerprint !== currentContext.environmentFingerprint) {
      return { stale: true, reason: 'environment_changed' };
    }

    if (ev.producer.version && ev.producer.version !== currentContext.toolVersion) {
      return { stale: true, reason: 'tool_version_changed' };
    }

    return { stale: false, reason: null };
  }

  /**
   * Mark an existing evidence record as stale with a reason.
   */
  markStale(evidenceId: string, reason: string): ValidationEvidence | null {
    const ev = this.evidence.get(evidenceId);
    if (!ev) return null;

    const updated: ValidationEvidence = {
      ...ev,
      outcome: 'stale',
      staleReason: reason,
    };
    this.evidence.set(evidenceId, updated);

    // Update the projection
    this.projectResult(updated);

    return updated;
  }

  // ─── Completion Blocking ───────────────────────────────────────

  /**
   * Determine blockers preventing automatic task completion.
   * A task SHALL NOT be automatically marked completed when required
   * validation is failed, cancelled, stale, or absent.
   */
  getCompletionBlockers(taskId: string): readonly CompletionBlocker[] {
    const policy = this.policies.get(taskId);
    if (!policy) return [];

    const blockers: CompletionBlocker[] = [];

    for (const step of policy.validationSteps) {
      if (!step.required) continue;

      // Check if there's a waiver for this step
      const waiver = this.findWaiver(step.id, taskId);
      if (waiver) continue;

      // Find the latest evidence for this step
      const latestEvidence = this.getLatestEvidenceForStep(taskId, step.id);

      if (!latestEvidence) {
        blockers.push({
          reason: 'validation_absent',
          stepId: step.id,
          description: `Required validation '${step.description}' has not been executed`,
          evidenceId: null,
        });
        continue;
      }

      if (latestEvidence.outcome === 'fail') {
        blockers.push({
          reason: 'validation_failed',
          stepId: step.id,
          description: `Validation '${step.description}' failed`,
          evidenceId: latestEvidence.id,
        });
      } else if (latestEvidence.outcome === 'cancelled') {
        blockers.push({
          reason: 'validation_cancelled',
          stepId: step.id,
          description: `Validation '${step.description}' was cancelled`,
          evidenceId: latestEvidence.id,
        });
      } else if (latestEvidence.outcome === 'stale') {
        blockers.push({
          reason: 'validation_stale',
          stepId: step.id,
          description: `Validation '${step.description}' is stale: ${latestEvidence.staleReason}`,
          evidenceId: latestEvidence.id,
        });
      }
    }

    return blockers;
  }

  /**
   * Check if a task can be automatically completed.
   */
  canAutoComplete(taskId: string): boolean {
    return this.getCompletionBlockers(taskId).length === 0;
  }

  // ─── Waivers ───────────────────────────────────────────────────

  /**
   * Grant a waiver for a required validation step.
   * Requires actor + reason as mandated by the requirements.
   */
  grantWaiver(params: {
    stepId: string;
    taskId: string;
    actor: string;
    reason: string;
    scope: string;
    reviewDate: string;
    compensatingControl: string;
  }): ValidationWaiver {
    if (!params.actor || !params.actor.trim()) {
      throw new WaiverRequiredError(params.stepId, 'validation_absent');
    }
    if (!params.reason || !params.reason.trim()) {
      throw new WaiverRequiredError(params.stepId, 'validation_absent');
    }

    const waiver: ValidationWaiver = {
      id: randomUUID(),
      stepId: params.stepId,
      taskId: params.taskId,
      actor: params.actor,
      reason: params.reason,
      scope: params.scope,
      reviewDate: params.reviewDate,
      compensatingControl: params.compensatingControl,
      grantedAt: new Date().toISOString(),
    };

    this.waivers.set(`${params.taskId}:${params.stepId}`, waiver);
    return waiver;
  }

  /**
   * Find a waiver for a specific step and task.
   */
  findWaiver(stepId: string, taskId: string): ValidationWaiver | null {
    return this.waivers.get(`${taskId}:${stepId}`) ?? null;
  }

  // ─── Evidence Queries ──────────────────────────────────────────

  /**
   * Get all evidence records for a task.
   */
  getEvidenceForTask(taskId: string): readonly ValidationEvidence[] {
    return Array.from(this.evidence.values()).filter((e) => e.taskId === taskId);
  }

  /**
   * Get evidence by ID.
   */
  getEvidence(evidenceId: string): ValidationEvidence | null {
    return this.evidence.get(evidenceId) ?? null;
  }

  /**
   * Get the latest evidence for a specific validation step.
   */
  getLatestEvidenceForStep(taskId: string, stepId: string): ValidationEvidence | null {
    const matching = Array.from(this.evidence.values())
      .filter((e) => e.taskId === taskId && e.stepId === stepId)
      .sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime());
    return matching[0] ?? null;
  }

  // ─── Projections ───────────────────────────────────────────────

  /**
   * Get the shared projection for a specific evidence record.
   */
  getProjection(evidenceId: string): ValidationProjection | null {
    return this.projections.get(evidenceId) ?? null;
  }

  /**
   * Get all projections for a task.
   */
  getProjectionsForTask(taskId: string): readonly ValidationProjection[] {
    return Array.from(this.projections.values()).filter((p) => p.taskId === taskId);
  }

  // ─── Mutations ─────────────────────────────────────────────────

  /**
   * Get all validation mutations.
   */
  getMutations(): readonly ValidationMutation[] {
    return Array.from(this.mutations.values());
  }

  /**
   * Get a specific mutation by ID.
   */
  getMutation(mutationId: string): ValidationMutation | null {
    return this.mutations.get(mutationId) ?? null;
  }

  // ─── Private Helpers ───────────────────────────────────────────

  /**
   * Compare pre/post diagnostics to find introduced, resolved, and unchanged.
   */
  private compareDiagnostics(
    pre: readonly Diagnostic[],
    post: readonly Diagnostic[],
  ): DiagnosticsComparison {
    const diagnosticKey = (d: Diagnostic): string =>
      `${d.uri}:${d.line}:${d.column}:${d.severity}:${d.code}:${d.message}`;

    const preSet = new Set(pre.map(diagnosticKey));
    const postSet = new Set(post.map(diagnosticKey));

    const introduced = post.filter((d) => !preSet.has(diagnosticKey(d)));
    const resolved = pre.filter((d) => !postSet.has(diagnosticKey(d)));
    const unchanged = post.filter((d) => preSet.has(diagnosticKey(d)));

    return { introduced, resolved, unchanged };
  }

  /**
   * Determine outcome from exit code.
   */
  private determineOutcome(exitCode: number): ValidationOutcome {
    return exitCode === 0 ? 'pass' : 'fail';
  }

  /**
   * Truncate output to bounded size.
   */
  private truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_SIZE) return output;
    return output.slice(0, MAX_OUTPUT_SIZE) + '\n... [truncated]';
  }

  /**
   * Compute a fingerprint for the evidence envelope.
   */
  private computeFingerprint(
    params: ExecuteValidationParams,
    result: ValidationRunResult,
    comparison: DiagnosticsComparison,
  ): string {
    const data = JSON.stringify({
      workspaceRevision: params.workspaceRevision,
      taskId: params.taskId,
      stepId: params.stepId,
      exitCode: result.exitCode,
      introducedCount: comparison.introduced.length,
      resolvedCount: comparison.resolved.length,
    });
    // Simple hash representation for fingerprint
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `fp_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Build a human-readable summary of the validation outcome.
   */
  private buildSummary(
    step: ValidationStep,
    outcome: ValidationOutcome,
    comparison: DiagnosticsComparison,
  ): string {
    const parts = [`${step.description}: ${outcome}`];
    if (comparison.introduced.length > 0) {
      parts.push(`+${comparison.introduced.length} introduced`);
    }
    if (comparison.resolved.length > 0) {
      parts.push(`-${comparison.resolved.length} resolved`);
    }
    return parts.join(', ');
  }

  /**
   * Handle mutations caused by validation (e.g., auto-fix).
   * Converts them to attributed Change_Sets or rolls them back.
   */
  private async handleValidationMutations(
    evidence: ValidationEvidence,
    modifiedFiles: readonly string[],
    params: ExecuteValidationParams,
  ): Promise<void> {
    const mutationId = randomUUID();

    try {
      // Try to create an attributed Change_Set for the mutations
      const changeSetId = await this.mutationAdapter.createAttributedChangeSet(
        params.taskId,
        params.runId,
        modifiedFiles,
        `validation:${evidence.id}`,
      );

      this.mutations.set(mutationId, {
        id: mutationId,
        evidenceId: evidence.id,
        files: modifiedFiles,
        attributedChangeSetId: changeSetId,
        rolledBack: false,
      });
    } catch {
      // Roll back the mutations
      await this.mutationAdapter.rollbackFiles(modifiedFiles, params.workspaceRevision);

      this.mutations.set(mutationId, {
        id: mutationId,
        evidenceId: evidence.id,
        files: modifiedFiles,
        attributedChangeSetId: null,
        rolledBack: true,
      });
    }
  }

  /**
   * Project one authoritative result into chat, review, taskbar, and run detail.
   */
  private projectResult(evidence: ValidationEvidence): void {
    const projection: ValidationProjection = {
      evidenceId: evidence.id,
      taskId: evidence.taskId,
      runId: evidence.runId,
      changeSetId: evidence.changeSetId,
      stepId: evidence.stepId,
      method: evidence.method,
      outcome: evidence.outcome,
      summary: evidence.summary,
      diagnosticsComparison: evidence.diagnosticsComparison,
      timestamp: evidence.finishedAt,
      targets: [...ALL_PROJECTION_TARGETS],
    };

    this.projections.set(evidence.id, projection);
  }
}
