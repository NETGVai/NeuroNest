/**
 * Tool_Execution_Pipeline — Ordered Policy, Execution, and Presentation Pipeline
 *
 * Implements the canonical ordered tool execution pipeline:
 *
 *   1. Input validation — validate model-supplied arguments against tool schema
 *      before any policy evaluation (Requirement 13.2)
 *   2. Monotonic policy — resolve allow/deny/ask; deny or ask can NEVER be
 *      relaxed by later middleware (Requirement 13.3)
 *   3. Execution — apply Abort_Signal, deadline, eligible retry, metrics, and
 *      immutable call correlation (Requirement 13.4)
 *   4. Output validation — validate provider-returned value before storage
 *      (Requirement 13.5)
 *   5. Commit — store immutable Canonical_Tool_Value (Requirement 13.5)
 *   6. Result policy — apply redaction, spill, retention, model-facing
 *      presentation WITHOUT mutating Canonical_Tool_Value (Requirement 13.6)
 *   7. Observe-only completion — emit event that CANNOT alter committed
 *      outcome (Requirement 13.7)
 *
 * If input or output validation fails, the pipeline returns a synthetic
 * structured result paired with the immutable call identity (Requirement 13.9).
 *
 * Requirements: 13.2–13.7, 13.9
 */

import { createHash } from 'crypto';

import type { ZodSchema } from 'zod';

import type { CanonicalToolValueV1 } from '../contracts/tool-value';
import type { ContractRef } from '../contracts/primitives';

import type {
  PolicyDecision,
  PolicyGuardResult,
  MonotonicPolicyOutcome,
  InputValidationResult,
  OutputValidationResult,
  ToolExecutionContext,
  ToolExecutionMetrics,
  ResultPolicy,
  ModelFacingResult,
  ToolCompletionEvent,
  SyntheticToolResult,
  PipelineInput,
  PipelineOutput,
} from './tool-execution-pipeline-schemas';

// ─── Dependency Ports ───────────────────────────────────────────

/**
 * A policy guard evaluates whether a tool call should be allowed.
 * Guards are evaluated in order; the pipeline enforces monotonicity.
 */
export interface PolicyGuard {
  /** Unique guard identifier. */
  guardId: string;
  /**
   * Evaluate policy for a tool call.
   * Must return allow, deny, or ask.
   */
  evaluate(
    toolContract: ContractRef,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<PolicyGuardResult>;
}

/**
 * Port for executing a validated, policy-approved tool call.
 */
export interface ToolExecutor {
  /**
   * Execute the tool with the given arguments and context.
   * The implementation must respect the abort signal and deadline.
   * Returns the raw tool output (unvalidated at this point).
   */
  execute(
    toolContract: ContractRef,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Port for committing an immutable Canonical_Tool_Value.
 * Once committed, the value and its digest MUST NOT change.
 */
export interface CanonicalValueStore {
  /**
   * Commit the canonical value. Returns the committed value with its ID.
   * Must be idempotent on the same callId.
   */
  commit(value: CanonicalToolValueV1): Promise<CanonicalToolValueV1>;
}

/**
 * Port for spilling oversized results to durable storage.
 */
export interface SpillStore {
  /**
   * Spill oversized content and return a reference for retrieval.
   */
  spill(callId: string, content: unknown, mediaType: string): Promise<string>;
}

/**
 * Port for emitting observe-only completion events.
 * The event CANNOT alter the committed outcome.
 */
export interface CompletionEventEmitter {
  /**
   * Emit an observe-only completion event.
   * Implementations must not use this to alter committed results.
   */
  emit(event: ToolCompletionEvent): Promise<void>;
}

// ─── Pipeline Configuration ─────────────────────────────────────

export interface ToolExecutionPipelineConfig {
  /** Ordered policy guards. Monotonicity is enforced by the pipeline. */
  policyGuards: PolicyGuard[];
  /** Tool executor port. */
  executor: ToolExecutor;
  /** Canonical value store port. */
  valueStore: CanonicalValueStore;
  /** Spill store for oversized results. */
  spillStore: SpillStore;
  /** Completion event emitter. */
  completionEmitter: CompletionEventEmitter;
  /** ID generator for canonical values and events. */
  generateId?: () => string;
  /** Time source for testability. */
  now?: () => string;
}

// ─── Tool Schema Registry (minimal interface needed by pipeline) ─

/**
 * Minimal tool schema information the pipeline needs for validation.
 * The full Tool_Registry (task 7.1) owns the complete metadata.
 */
export interface ToolSchemaInfo {
  toolContract: ContractRef;
  inputSchema: ZodSchema;
  outputSchema: ZodSchema;
  resultPolicy: ResultPolicy;
}

// ─── Monotonic Policy Engine ────────────────────────────────────

/**
 * Policy decision ordering (monotonic lattice):
 *   allow < ask < deny
 *
 * Once a guard returns 'deny' or 'ask', no later guard can relax it.
 * deny > ask > allow — the most restrictive decision wins.
 */
const POLICY_RANK: Record<PolicyDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Resolve the monotonic aggregate policy from an ordered list of guard results.
 * Requirement 13.3: deny or ask can never be relaxed by later middleware.
 */
export function resolveMonotonicPolicy(guards: PolicyGuardResult[]): MonotonicPolicyOutcome {
  let highestRank = 0;
  let finalDecision: PolicyDecision = 'allow';
  let escalated = false;

  for (const guard of guards) {
    const rank = POLICY_RANK[guard.decision];
    if (rank > highestRank) {
      highestRank = rank;
      finalDecision = guard.decision;
      escalated = true;
    }
  }

  // If we never escalated from 'allow', escalated is false
  if (finalDecision === 'allow') {
    escalated = false;
  }

  return { finalDecision, guards, escalated };
}

// ─── Pipeline Implementation ────────────────────────────────────

export class ToolExecutionPipeline {
  private readonly guards: PolicyGuard[];
  private readonly executor: ToolExecutor;
  private readonly valueStore: CanonicalValueStore;
  private readonly spillStore: SpillStore;
  private readonly completionEmitter: CompletionEventEmitter;
  private readonly generateId: () => string;
  private readonly now: () => string;

  constructor(config: ToolExecutionPipelineConfig) {
    this.guards = config.policyGuards;
    this.executor = config.executor;
    this.valueStore = config.valueStore;
    this.spillStore = config.spillStore;
    this.completionEmitter = config.completionEmitter;
    this.generateId = config.generateId ?? (() => `tep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.now = config.now ?? (() => new Date().toISOString());
  }

  /**
   * Execute the full ordered pipeline for a single tool call.
   *
   * Stage ordering is strict and enforced:
   *   input validation → monotonic policy → execution → output validation →
   *   commit → result policy → observe-only completion
   */
  async execute(input: PipelineInput, schema: ToolSchemaInfo): Promise<PipelineOutput> {
    const pipelineStart = this.now();
    const { callId, toolContract, arguments: args, context, resultPolicy } = input;

    // Initialize metrics tracking
    const metrics: ToolExecutionMetrics = {
      callId,
      startedAt: pipelineStart,
      retryCount: 0,
      aborted: false,
      timedOut: false,
      policyDecision: 'allow',
    };

    // ─── Stage 1: Input Validation (Requirement 13.2) ───────────
    const inputValidation = this.validateInput(args, schema.inputSchema);

    if (!inputValidation.valid) {
      // Requirement 13.9: return synthetic result on input validation failure
      return this.buildSyntheticOutput(
        callId,
        toolContract,
        context,
        'input_validation_failed',
        inputValidation.errors ?? [],
        metrics,
        pipelineStart,
        'validation_failure',
      );
    }

    // ─── Stage 2: Monotonic Policy (Requirement 13.3) ───────────
    const policyOutcome = await this.evaluatePolicy(toolContract, args, context);
    metrics.policyDecision = policyOutcome.finalDecision;

    if (policyOutcome.finalDecision === 'deny') {
      return this.buildSyntheticOutput(
        callId,
        toolContract,
        context,
        'policy_denied',
        [{ message: `Policy denied by guards: ${policyOutcome.guards.filter(g => g.decision === 'deny').map(g => g.guardId).join(', ')}` }],
        metrics,
        pipelineStart,
        'policy_denied',
      );
    }

    if (policyOutcome.finalDecision === 'ask') {
      return this.buildSyntheticOutput(
        callId,
        toolContract,
        context,
        'policy_ask_pending',
        [{ message: `Approval required from guards: ${policyOutcome.guards.filter(g => g.decision === 'ask').map(g => g.guardId).join(', ')}` }],
        metrics,
        pipelineStart,
        'policy_ask',
      );
    }

    // ─── Stage 3: Execution (Requirement 13.4) ──────────────────
    const abortController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    // Set up deadline if configured
    if (context.deadlineAt) {
      const deadlineMs = new Date(context.deadlineAt).getTime() - Date.now();
      if (deadlineMs <= 0) {
        metrics.timedOut = true;
        return this.buildSyntheticOutput(
          callId,
          toolContract,
          context,
          'timed_out',
          [{ message: 'Deadline already passed before execution' }],
          metrics,
          pipelineStart,
          'timed_out',
        );
      }
      deadlineTimer = setTimeout(() => abortController.abort(), deadlineMs);
    }

    // Check if already aborted
    if (context.aborted) {
      metrics.aborted = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      return this.buildSyntheticOutput(
        callId,
        toolContract,
        context,
        'aborted',
        [{ message: 'Call aborted before execution' }],
        metrics,
        pipelineStart,
        'aborted',
      );
    }

    let rawOutput: unknown;
    try {
      rawOutput = await this.executor.execute(
        toolContract,
        args,
        context,
        abortController.signal,
      );
    } catch (error: unknown) {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);

      if (abortController.signal.aborted) {
        metrics.aborted = true;
        metrics.timedOut = context.deadlineAt !== undefined;
        const reason = metrics.timedOut ? 'timed_out' : 'aborted';
        return this.buildSyntheticOutput(
          callId,
          toolContract,
          context,
          reason,
          [{ message: error instanceof Error ? error.message : 'Execution aborted' }],
          metrics,
          pipelineStart,
          reason === 'timed_out' ? 'timed_out' : 'aborted',
        );
      }

      // Execution error
      return this.buildSyntheticOutput(
        callId,
        toolContract,
        context,
        'execution_error',
        [{ message: error instanceof Error ? error.message : 'Unknown execution error' }],
        metrics,
        pipelineStart,
        'execution_error',
      );
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }

    // ─── Stage 4: Output Validation (Requirement 13.5) ──────────
    const outputValidation = this.validateOutput(rawOutput, schema.outputSchema);

    if (!outputValidation.valid) {
      // Requirement 13.9: return synthetic result on output validation failure
      return this.buildSyntheticOutput(
        callId,
        toolContract,
        context,
        'output_validation_failed',
        outputValidation.errors ?? [],
        metrics,
        pipelineStart,
        'validation_failure',
      );
    }

    // ─── Stage 5: Commit Immutable Canonical_Tool_Value (Req 13.5) ─
    const completedAt = this.now();
    metrics.completedAt = completedAt;
    metrics.durationMs = new Date(completedAt).getTime() - new Date(pipelineStart).getTime();

    const valueDigest = this.computeDigest(rawOutput);

    const canonicalValue: CanonicalToolValueV1 = {
      canonicalValueId: this.generateId(),
      callId,
      toolContract,
      mediaType: 'application/json',
      value: rawOutput,
      valueDigest,
      retention: resultPolicy.retention,
      createdAt: completedAt,
      schemaVersion: 1,
    };

    const committedValue = await this.valueStore.commit(canonicalValue);

    // ─── Stage 6: Result Policy (Requirement 13.6) ──────────────
    // Apply redaction, spill, retention, and model-facing presentation
    // WITHOUT mutating the committed Canonical_Tool_Value.
    const modelFacing = await this.applyResultPolicy(
      callId,
      committedValue,
      resultPolicy,
    );

    // ─── Stage 7: Observe-Only Completion (Requirement 13.7) ────
    const completionEvent: ToolCompletionEvent = {
      eventId: this.generateId(),
      callId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      correlationId: context.correlationId,
      toolContract,
      status: 'success',
      pipelineDurationMs: metrics.durationMs ?? 0,
      synthetic: false,
      modelOrderIndex: context.modelOrderIndex,
      metrics,
      emittedAt: this.now(),
      schemaVersion: 1,
    };

    // Emit is observe-only — it cannot alter the committed outcome
    await this.completionEmitter.emit(completionEvent);

    return {
      kind: 'success',
      callId,
      canonicalValue: committedValue,
      modelFacing,
      completionEvent,
      metrics,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Stage 1: Validate input against tool schema (Requirement 13.2).
   * This MUST happen before policy evaluation.
   */
  private validateInput(
    args: Record<string, unknown>,
    inputSchema: ZodSchema,
  ): InputValidationResult {
    const result = inputSchema.safeParse(args);
    if (result.success) {
      return { valid: true, validatedAt: this.now() };
    }

    return {
      valid: false,
      errors: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
      validatedAt: this.now(),
    };
  }

  /**
   * Stage 2: Evaluate monotonic policy (Requirement 13.3).
   * Guards are evaluated in order. The final decision is the most restrictive.
   * Once deny or ask is returned, no later guard can relax it.
   */
  private async evaluatePolicy(
    toolContract: ContractRef,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<MonotonicPolicyOutcome> {
    const guardResults: PolicyGuardResult[] = [];

    for (const guard of this.guards) {
      const result = await guard.evaluate(toolContract, args, context);
      guardResults.push(result);
    }

    return resolveMonotonicPolicy(guardResults);
  }

  /**
   * Stage 4: Validate output against tool schema (Requirement 13.5).
   */
  private validateOutput(
    output: unknown,
    outputSchema: ZodSchema,
  ): OutputValidationResult {
    const result = outputSchema.safeParse(output);
    if (result.success) {
      return { valid: true, validatedAt: this.now() };
    }

    return {
      valid: false,
      errors: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
      validatedAt: this.now(),
    };
  }

  /**
   * Stage 6: Apply result policy without mutating canonical value (Requirement 13.6).
   */
  private async applyResultPolicy(
    callId: string,
    canonicalValue: CanonicalToolValueV1,
    policy: ResultPolicy,
  ): Promise<ModelFacingResult> {
    let content: unknown = canonicalValue.value;
    let redacted = false;
    let spilled = false;
    let spillRef: string | undefined;

    // Apply redaction rules
    if (policy.redactionRules.length > 0) {
      content = this.applyRedaction(content, policy.redactionRules);
      redacted = true;
    }

    // Apply spill if configured and content exceeds threshold
    if (policy.spillConfig) {
      const serialized = JSON.stringify(content);
      if (serialized.length > policy.spillConfig.maxSizeBytes) {
        spillRef = await this.spillStore.spill(
          callId,
          content,
          canonicalValue.mediaType,
        );
        // Replace content with a bounded preview
        content = serialized.slice(0, policy.spillConfig.previewSizeBytes);
        spilled = true;
      }
    }

    return {
      callId,
      redacted,
      spilled,
      content,
      spillRef,
      presentationMode: policy.modelPresentation,
      canonicalDigest: canonicalValue.valueDigest,
    };
  }

  /**
   * Apply redaction rules to content. Creates a copy — never mutates canonical value.
   */
  private applyRedaction(
    content: unknown,
    rules: Array<{ path: string; replacement: string }>,
  ): unknown {
    if (typeof content !== 'object' || content === null) {
      return content;
    }

    // Deep clone to avoid mutating original
    const clone = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;

    for (const rule of rules) {
      const parts = rule.path.split('.');
      let target: Record<string, unknown> = clone;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (typeof target[part] === 'object' && target[part] !== null) {
          target = target[part] as Record<string, unknown>;
        } else {
          break;
        }
      }

      const lastPart = parts[parts.length - 1];
      if (lastPart in target) {
        target[lastPart] = rule.replacement;
      }
    }

    return clone;
  }

  /**
   * Compute a stable digest of tool output for integrity verification.
   */
  private computeDigest(value: unknown): string {
    const serialized = JSON.stringify(value, Object.keys(
      typeof value === 'object' && value !== null ? value : {},
    ).sort());
    return createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Build a synthetic pipeline output for validation/policy failures (Requirement 13.9).
   */
  private async buildSyntheticOutput(
    callId: string,
    toolContract: ContractRef,
    context: ToolExecutionContext,
    reason: SyntheticToolResult['reason'],
    errors: Array<{ path?: string; message: string; code?: string }>,
    metrics: ToolExecutionMetrics,
    pipelineStart: string,
    status: ToolCompletionEvent['status'],
  ): Promise<PipelineOutput> {
    const completedAt = this.now();
    metrics.completedAt = completedAt;
    metrics.durationMs = new Date(completedAt).getTime() - new Date(pipelineStart).getTime();

    const syntheticResult: SyntheticToolResult = {
      callId,
      toolContract,
      reason,
      errors,
      correlationId: context.correlationId,
      createdAt: completedAt,
      schemaVersion: 1,
    };

    const completionEvent: ToolCompletionEvent = {
      eventId: this.generateId(),
      callId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      correlationId: context.correlationId,
      toolContract,
      status,
      pipelineDurationMs: metrics.durationMs ?? 0,
      synthetic: true,
      modelOrderIndex: context.modelOrderIndex,
      metrics,
      emittedAt: this.now(),
      schemaVersion: 1,
    };

    // Emit observe-only completion even for synthetic results
    await this.completionEmitter.emit(completionEvent);

    return {
      kind: 'synthetic',
      callId,
      syntheticResult,
      completionEvent,
      metrics,
    };
  }
}
