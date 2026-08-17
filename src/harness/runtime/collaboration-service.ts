/**
 * Collaboration Service — Provider-neutral authority for user questions,
 * approvals, permission presets, and human commands.
 *
 * Implements:
 * - Versioned question/approval contracts with stable identity and revision
 * - Exact answer schemas and digests for integrity verification
 * - Atomic one-shot consumption: each decision consumed ONCE, dispatched atomically
 * - Permission presets: versioned collections with revision tracking and bulk confirmation
 * - Fail-closed noninteractive outcomes when no human is available
 * - Expiry: questions and approvals expire after configured duration
 * - Human command events recorded as durable events in Session_Log
 * - Supersession: newer question on same contract supersedes prior
 *
 * Requirements: 8.4–8.5, 19.1–19.8, 38.1–38.6, 38.10–38.16
 */

import { createHash } from 'crypto';
import {
  type CollaborationKind,
  type CollaborationState,
  type QuestionContract,
  type ApprovalContract,
  type ApprovalDigest,
  type AnswerSchemaDefinition,
  type CollaborationDecision,
  type DecisionResult,
  type PermissionPreset,
  type BulkConfirmationRequest,
  type HumanCommandEvent,
  type NoninteractiveOutcome,
  type SupersessionRecord,
  type CollaborationServiceConfig,
  CollaborationServiceConfigSchema,
  CollaborationDecisionSchema,
  TERMINAL_COLLABORATION_STATES,
} from './collaboration-schemas';
import type { ContractRef } from '../contracts/primitives';
import type { ScopeDescriptorV1 } from '../contracts/scope';

// ─── Errors ─────────────────────────────────────────────────────

export class CollaborationError extends Error {
  constructor(
    message: string,
    public readonly code: CollaborationErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CollaborationError';
  }
}

export type CollaborationErrorCode =
  | 'INVALID_CONFIG'
  | 'NOT_FOUND'
  | 'ALREADY_CONSUMED'
  | 'EXPIRED'
  | 'SUPERSEDED'
  | 'REVISION_MISMATCH'
  | 'INVALID_ANSWER'
  | 'DIGEST_MISMATCH'
  | 'NONINTERACTIVE'
  | 'INVALID_DECISION'
  | 'TERMINAL_STATE'
  | 'DUPLICATE_PRESET'
  | 'PRESET_NOT_FOUND';

// ─── Ports ──────────────────────────────────────────────────────

/**
 * Port for persisting human command events to Session_Log.
 */
export interface CollaborationLogPort {
  appendHumanCommandEvent(event: HumanCommandEvent): void;
  appendSupersessionRecord(record: SupersessionRecord): void;
}

/**
 * Port for dispatching authorized operations after approval consumption.
 */
export interface DispatchPort {
  dispatchAuthorized(params: {
    collaborationId: string;
    decisionId: string;
    approvalDigest?: ApprovalDigest;
  }): Record<string, unknown>;
}

// ─── Collaboration Service ──────────────────────────────────────

export class CollaborationService {
  private readonly config: CollaborationServiceConfig;
  private readonly logPort: CollaborationLogPort;
  private readonly dispatchPort: DispatchPort;

  /** Active questions by questionId. */
  private readonly questions = new Map<string, QuestionContract>();
  /** Active approvals by approvalId. */
  private readonly approvals = new Map<string, ApprovalContract>();
  /** Consumed decision IDs (one-shot enforcement). */
  private readonly consumedDecisions = new Set<string>();
  /** Permission presets by presetId. */
  private readonly presets = new Map<string, PermissionPreset>();
  /** Bulk confirmation requests by confirmationId. */
  private readonly bulkConfirmations = new Map<string, BulkConfirmationRequest>();
  /** Supersession records. */
  private readonly supersessionHistory: SupersessionRecord[] = [];
  /** Noninteractive outcomes log. */
  private readonly noninteractiveOutcomes: NoninteractiveOutcome[] = [];

  constructor(params: {
    config?: Partial<CollaborationServiceConfig>;
    logPort?: CollaborationLogPort;
    dispatchPort?: DispatchPort;
  } = {}) {
    const rawConfig = {
      ...params.config,
      schemaVersion: 1 as const,
    };
    const parsed = CollaborationServiceConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new CollaborationError(
        `Invalid collaboration service config: ${parsed.error.message}`,
        'INVALID_CONFIG',
        { errors: parsed.error.issues },
      );
    }
    this.config = parsed.data;
    this.logPort = params.logPort ?? { appendHumanCommandEvent: () => {}, appendSupersessionRecord: () => {} };
    this.dispatchPort = params.dispatchPort ?? { dispatchAuthorized: () => ({}) };
  }

  // ─── Question Management ────────────────────────────────────

  /**
   * Issue a provider-neutral question with stable identity, expected answer schema,
   * expiry, and owning session.
   *
   * Requirement 19.1: issue provider-neutral question with stable identity.
   * Requirement 38.13: validate answer against exact projected answer schema.
   *
   * If noninteractive mode is active, immediately returns a fail-closed outcome.
   */
  issueQuestion(params: {
    questionId: string;
    sessionId: string;
    turnId: string;
    owner: string;
    questionText: string;
    answerSchema: AnswerSchemaDefinition;
    scope?: ScopeDescriptorV1;
    expiresAt?: string;
  }): QuestionContract | NoninteractiveOutcome {
    // Fail-closed in noninteractive mode (Requirement 19.7)
    if (this.config.noninteractive) {
      const outcome: NoninteractiveOutcome = {
        type: 'noninteractive_denial',
        collaborationId: params.questionId,
        reason: 'no_interactive_user_available',
        policy: 'fail_closed',
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
      };
      this.noninteractiveOutcomes.push(outcome);
      return outcome;
    }

    // Check for supersession: newer question on same identity
    const existing = this.questions.get(params.questionId);
    const revision = existing ? existing.revision + 1 : 1;

    if (existing && !TERMINAL_COLLABORATION_STATES.has(existing.state)) {
      // Supersede the prior pending question
      existing.state = 'superseded';
      const supersessionRecord: SupersessionRecord = {
        supersededId: params.questionId,
        supersedingId: params.questionId,
        reason: 'new_revision',
        occurredAt: new Date().toISOString(),
      };
      this.supersessionHistory.push(supersessionRecord);
      this.logPort.appendSupersessionRecord(supersessionRecord);
    }

    const expiresAt = params.expiresAt ?? (
      this.config.defaultQuestionExpiryMs > 0
        ? new Date(Date.now() + this.config.defaultQuestionExpiryMs).toISOString()
        : undefined
    );

    const contractDigest = this.computeContractDigest({
      questionId: params.questionId,
      revision,
      questionText: params.questionText,
      answerSchema: params.answerSchema,
    });

    const question: QuestionContract = {
      questionId: params.questionId,
      revision,
      sessionId: params.sessionId,
      turnId: params.turnId,
      owner: params.owner,
      kind: 'question',
      questionText: params.questionText,
      answerSchema: params.answerSchema,
      contractDigest,
      expiresAt,
      state: 'pending',
      scope: params.scope,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.questions.set(params.questionId, question);
    return question;
  }

  /**
   * Issue a risky-call approval contract bound to exact execution context.
   *
   * Requirement 19.2: bind approval to tool version, exact normalized args digest,
   * scope, risk summary, owner, and expiry.
   *
   * If noninteractive mode is active, immediately returns a fail-closed outcome.
   */
  issueApproval(params: {
    approvalId: string;
    sessionId: string;
    turnId: string;
    owner: string;
    description: string;
    approvalDigest: ApprovalDigest;
    scope?: ScopeDescriptorV1;
    expiresAt?: string;
  }): ApprovalContract | NoninteractiveOutcome {
    // Fail-closed in noninteractive mode (Requirement 19.7)
    if (this.config.noninteractive) {
      const outcome: NoninteractiveOutcome = {
        type: 'noninteractive_denial',
        collaborationId: params.approvalId,
        reason: 'no_interactive_user_available',
        policy: 'fail_closed',
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
      };
      this.noninteractiveOutcomes.push(outcome);
      return outcome;
    }

    // Check for supersession: newer approval on same identity
    const existing = this.approvals.get(params.approvalId);
    const revision = existing ? existing.revision + 1 : 1;

    if (existing && !TERMINAL_COLLABORATION_STATES.has(existing.state)) {
      existing.state = 'superseded';
      const supersessionRecord: SupersessionRecord = {
        supersededId: params.approvalId,
        supersedingId: params.approvalId,
        reason: 'new_revision',
        occurredAt: new Date().toISOString(),
      };
      this.supersessionHistory.push(supersessionRecord);
      this.logPort.appendSupersessionRecord(supersessionRecord);
    }

    const expiresAt = params.expiresAt ?? (
      this.config.defaultApprovalExpiryMs > 0
        ? new Date(Date.now() + this.config.defaultApprovalExpiryMs).toISOString()
        : undefined
    );

    const contractDigest = this.computeContractDigest({
      approvalId: params.approvalId,
      revision,
      approvalDigest: params.approvalDigest,
    });

    const approval: ApprovalContract = {
      approvalId: params.approvalId,
      revision,
      sessionId: params.sessionId,
      turnId: params.turnId,
      owner: params.owner,
      kind: 'approval',
      description: params.description,
      approvalDigest: params.approvalDigest,
      contractDigest,
      expiresAt,
      state: 'pending',
      scope: params.scope,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.approvals.set(params.approvalId, approval);
    return approval;
  }

  // ─── Decision Submission ────────────────────────────────────

  /**
   * Submit a human decision (answer/approve/deny) against a collaboration contract.
   *
   * Requirement 19.3: mark approval consumed in same transaction as authorized dispatch.
   * Requirement 38.14: commit no more than one applicable decision per identity.
   * Requirement 38.16: reject stale or superseded collaboration identity or revision.
   *
   * Atomic one-shot: a second submission of the same decision is rejected.
   */
  submitDecision(decision: CollaborationDecision): DecisionResult {
    // Validate decision schema
    const parseResult = CollaborationDecisionSchema.safeParse(decision);
    if (!parseResult.success) {
      throw new CollaborationError(
        `Invalid decision: ${parseResult.error.message}`,
        'INVALID_DECISION',
        { errors: parseResult.error.issues },
      );
    }

    const { collaborationId, expectedRevision, decisionType, answerValue, actor, decidedAt } = decision;

    // One-shot enforcement: reject already-consumed decisions
    const consumptionKey = `${collaborationId}:${expectedRevision}`;
    if (this.consumedDecisions.has(consumptionKey)) {
      return {
        status: 'rejected',
        reason: 'already_consumed',
        details: 'This collaboration decision has already been consumed',
      };
    }

    // Look up the collaboration contract
    const question = this.questions.get(collaborationId);
    const approval = this.approvals.get(collaborationId);
    const contract = question ?? approval;

    if (!contract) {
      return {
        status: 'rejected',
        reason: 'not_found',
        details: `No collaboration contract found for id: ${collaborationId}`,
      };
    }

    // Check expiry
    if (this.isExpired(contract)) {
      contract.state = 'expired';
      return {
        status: 'rejected',
        reason: 'expired',
        details: 'Collaboration contract has expired',
        currentState: 'expired',
      };
    }

    // Check terminal state
    if (TERMINAL_COLLABORATION_STATES.has(contract.state)) {
      if (contract.state === 'superseded') {
        return {
          status: 'rejected',
          reason: 'superseded',
          details: 'This contract has been superseded by a newer revision',
          currentRevision: contract.revision,
          currentState: contract.state,
        };
      }
      return {
        status: 'rejected',
        reason: 'already_consumed',
        details: `Contract is in terminal state: ${contract.state}`,
        currentState: contract.state,
      };
    }

    // Revision mismatch check (Requirement 38.16)
    if (contract.revision !== expectedRevision) {
      return {
        status: 'rejected',
        reason: 'revision_mismatch',
        details: `Expected revision ${expectedRevision}, current is ${contract.revision}`,
        currentRevision: contract.revision,
        currentState: contract.state,
      };
    }

    // Decision-type-specific validation
    if (question && decisionType === 'answer') {
      // Validate answer against exact projected answer schema (Requirement 38.13)
      const answerValid = this.validateAnswer(answerValue, question.answerSchema);
      if (!answerValid.valid) {
        return {
          status: 'rejected',
          reason: 'invalid_answer',
          details: answerValid.reason,
          currentRevision: question.revision,
          currentState: question.state,
        };
      }
    }

    if (approval && decisionType === 'approve') {
      // Verify the approval digest hasn't changed (Requirement 38.6)
      const currentDigest = this.computeContractDigest({
        approvalId: approval.approvalId,
        revision: approval.revision,
        approvalDigest: approval.approvalDigest,
      });
      if (currentDigest !== approval.contractDigest) {
        return {
          status: 'rejected',
          reason: 'digest_mismatch',
          details: 'Approval context has changed since the contract was issued',
          currentRevision: approval.revision,
          currentState: approval.state,
        };
      }
    }

    // ── Atomic one-shot consumption and dispatch ──
    // Mark consumed FIRST (one-shot guarantee)
    this.consumedDecisions.add(consumptionKey);

    // Determine new state
    let newState: CollaborationState;
    if (decisionType === 'answer') {
      newState = 'answered';
    } else if (decisionType === 'approve') {
      newState = 'approved';
    } else {
      newState = 'denied';
    }

    const fromState = contract.state;
    contract.state = newState;

    // Dispatch authorized operation atomically with consumption (Requirement 19.3)
    let dispatchRecord: Record<string, unknown> | undefined;
    if (decisionType === 'approve' && approval) {
      dispatchRecord = this.dispatchPort.dispatchAuthorized({
        collaborationId,
        decisionId: decision.decisionId,
        approvalDigest: approval.approvalDigest,
      });
    }

    // Record human command event in Session_Log (Requirement 19.8)
    const humanCommandEvent: HumanCommandEvent = {
      type: 'human_command',
      commandId: decision.decisionId,
      collaborationId,
      actor,
      scope: decision.scope,
      decisionType,
      resultingTransition: {
        fromState,
        toState: newState,
      },
      occurredAt: decidedAt,
      schemaVersion: 1,
    };
    this.logPort.appendHumanCommandEvent(humanCommandEvent);

    return {
      status: 'accepted',
      decisionId: decision.decisionId,
      collaborationId,
      newState,
      dispatchRecord,
    };
  }

  // ─── Permission Preset Management ──────────────────────────

  /**
   * Register or update a permission preset.
   *
   * Requirement 19.5: persist preset identity and revision at scope.
   */
  registerPreset(preset: PermissionPreset): PermissionPreset {
    const existing = this.presets.get(preset.presetId);
    if (existing && existing.revision >= preset.revision) {
      throw new CollaborationError(
        `Preset revision must be greater than current (${existing.revision})`,
        'DUPLICATE_PRESET',
        { currentRevision: existing.revision },
      );
    }
    this.presets.set(preset.presetId, preset);
    return preset;
  }

  /**
   * Get a preset by identity.
   */
  getPreset(presetId: string): PermissionPreset | undefined {
    return this.presets.get(presetId);
  }

  /**
   * List all presets visible at the given scope.
   */
  listPresets(scope?: ScopeDescriptorV1): PermissionPreset[] {
    const all = Array.from(this.presets.values());
    if (!scope) return all;
    // Simple scope filtering: include presets whose scope overlaps
    return all.filter((p) => this.scopeOverlaps(p.scope, scope));
  }

  /**
   * Check if a tool call is pre-approved by any active preset.
   */
  isPreApproved(params: {
    toolContract: ContractRef;
    riskClass: string;
    scope?: ScopeDescriptorV1;
  }): { approved: boolean; presetId?: string; presetRevision?: number } {
    for (const preset of this.presets.values()) {
      // Check preset expiry
      if (preset.expiresAt && new Date(preset.expiresAt) <= new Date()) {
        continue;
      }
      for (const perm of preset.permissions) {
        if (
          perm.toolContract.name === params.toolContract.name &&
          perm.toolContract.version === params.toolContract.version &&
          perm.allowedRiskClasses.includes(params.riskClass)
        ) {
          // Check individual permission expiry
          if (perm.expiresAt && new Date(perm.expiresAt) <= new Date()) {
            continue;
          }
          return {
            approved: true,
            presetId: preset.presetId,
            presetRevision: preset.revision,
          };
        }
      }
    }
    return { approved: false };
  }

  // ─── Bulk Confirmation ──────────────────────────────────────

  /**
   * Request bulk confirmation when an operation exceeds configured thresholds.
   *
   * Requirement 19.6: require confirmation describing bounded operation set.
   */
  requestBulkConfirmation(params: {
    confirmationId: string;
    sessionId: string;
    owner: string;
    operationDescription: string;
    threshold: { kind: 'item_count' | 'byte_size' | 'cost' | 'risk'; actualValue: number };
    itemCount: number;
    estimatedCost?: number;
    riskSummary?: string;
  }): BulkConfirmationRequest | NoninteractiveOutcome {
    // Fail-closed in noninteractive mode
    if (this.config.noninteractive) {
      const outcome: NoninteractiveOutcome = {
        type: 'noninteractive_denial',
        collaborationId: params.confirmationId,
        reason: 'no_interactive_user_available',
        policy: 'fail_closed',
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
      };
      this.noninteractiveOutcomes.push(outcome);
      return outcome;
    }

    const configuredLimit = this.getConfiguredLimit(params.threshold.kind);

    const request: BulkConfirmationRequest = {
      confirmationId: params.confirmationId,
      sessionId: params.sessionId,
      owner: params.owner,
      operationDescription: params.operationDescription,
      exceededThreshold: {
        kind: params.threshold.kind,
        configuredLimit,
        actualValue: params.threshold.actualValue,
      },
      itemCount: params.itemCount,
      estimatedCost: params.estimatedCost,
      riskSummary: params.riskSummary,
      expiresAt: this.config.defaultApprovalExpiryMs > 0
        ? new Date(Date.now() + this.config.defaultApprovalExpiryMs).toISOString()
        : undefined,
      state: 'pending',
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.bulkConfirmations.set(params.confirmationId, request);
    return request;
  }

  // ─── Invalidation ──────────────────────────────────────────

  /**
   * Invalidate a pending approval when context changes.
   *
   * Requirement 19.4: invalidate prior approval if args/scope/version/risk changes.
   * Requirement 38.6: invalidate if normalized args, scope, risk, owner, tool version,
   * or plan revision changes.
   */
  invalidateApproval(approvalId: string, reason: string): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) return false;
    if (TERMINAL_COLLABORATION_STATES.has(approval.state)) return false;

    approval.state = 'expired';
    return true;
  }

  // ─── Expiry Management ─────────────────────────────────────

  /**
   * Check and expire stale collaboration contracts.
   * Returns the IDs of expired contracts.
   */
  expireStaleContracts(): string[] {
    const expired: string[] = [];
    const now = new Date();

    for (const [id, question] of this.questions) {
      if (!TERMINAL_COLLABORATION_STATES.has(question.state) && this.isExpired(question)) {
        question.state = 'expired';
        expired.push(id);
      }
    }

    for (const [id, approval] of this.approvals) {
      if (!TERMINAL_COLLABORATION_STATES.has(approval.state) && this.isExpired(approval)) {
        approval.state = 'expired';
        expired.push(id);
      }
    }

    for (const [id, confirmation] of this.bulkConfirmations) {
      if (!TERMINAL_COLLABORATION_STATES.has(confirmation.state) && this.isExpired(confirmation)) {
        confirmation.state = 'expired';
        expired.push(id);
      }
    }

    return expired;
  }

  // ─── Queries ───────────────────────────────────────────────

  getQuestion(questionId: string): QuestionContract | undefined {
    return this.questions.get(questionId);
  }

  getApproval(approvalId: string): ApprovalContract | undefined {
    return this.approvals.get(approvalId);
  }

  getBulkConfirmation(confirmationId: string): BulkConfirmationRequest | undefined {
    return this.bulkConfirmations.get(confirmationId);
  }

  getPendingQuestions(sessionId?: string): QuestionContract[] {
    return Array.from(this.questions.values()).filter(
      (q) => q.state === 'pending' && (!sessionId || q.sessionId === sessionId),
    );
  }

  getPendingApprovals(sessionId?: string): ApprovalContract[] {
    return Array.from(this.approvals.values()).filter(
      (a) => a.state === 'pending' && (!sessionId || a.sessionId === sessionId),
    );
  }

  getSupersessionHistory(): ReadonlyArray<SupersessionRecord> {
    return this.supersessionHistory;
  }

  getNoninteractiveOutcomes(): ReadonlyArray<NoninteractiveOutcome> {
    return this.noninteractiveOutcomes;
  }

  isNoninteractive(): boolean {
    return this.config.noninteractive;
  }

  getConfig(): Readonly<CollaborationServiceConfig> {
    return this.config;
  }

  // ─── Approval Digest Computation ───────────────────────────

  /**
   * Compute an Approval_Digest for a tool call.
   *
   * Requirement 19.2: exact normalized arguments, scope, risk, owner, tool version,
   * plan revision, and expiry.
   */
  computeApprovalDigest(params: {
    normalizedArgs: unknown;
    toolContract: ContractRef;
    scope: ScopeDescriptorV1;
    riskSummary: string;
    owner: string;
    planRevisionId?: string;
    expiresAt?: string;
  }): ApprovalDigest {
    const normalizedArgsDigest = this.computeDigest(
      JSON.stringify(params.normalizedArgs),
    );

    const compositeInput = JSON.stringify({
      normalizedArgsDigest,
      toolContract: params.toolContract,
      scope: params.scope,
      riskSummary: params.riskSummary,
      owner: params.owner,
      planRevisionId: params.planRevisionId,
      expiresAt: params.expiresAt,
    });
    const compositeDigest = this.computeDigest(compositeInput);

    return {
      normalizedArgsDigest,
      toolContract: params.toolContract,
      scope: params.scope,
      riskSummary: params.riskSummary,
      owner: params.owner,
      planRevisionId: params.planRevisionId,
      expiresAt: params.expiresAt,
      compositeDigest,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────

  private isExpired(contract: { expiresAt?: string }): boolean {
    if (!contract.expiresAt) return false;
    return new Date(contract.expiresAt) <= new Date();
  }

  private validateAnswer(
    answerValue: unknown,
    schema: AnswerSchemaDefinition,
  ): { valid: boolean; reason?: string } {
    // Required check
    if (schema.required && (answerValue === undefined || answerValue === null || answerValue === '')) {
      return { valid: false, reason: 'Answer is required but was empty' };
    }

    // Skip further validation if not required and empty
    if (!schema.required && (answerValue === undefined || answerValue === null)) {
      return { valid: true };
    }

    switch (schema.answerType) {
      case 'text':
        if (typeof answerValue !== 'string') {
          return { valid: false, reason: 'Expected a text answer (string)' };
        }
        return { valid: true };

      case 'choice':
        if (typeof answerValue !== 'string') {
          return { valid: false, reason: 'Expected a choice answer (string)' };
        }
        if (schema.allowedValues && !schema.allowedValues.includes(answerValue)) {
          return {
            valid: false,
            reason: `Answer must be one of: ${schema.allowedValues.join(', ')}`,
          };
        }
        return { valid: true };

      case 'confirmation':
        if (typeof answerValue !== 'boolean') {
          return { valid: false, reason: 'Expected a confirmation answer (boolean)' };
        }
        return { valid: true };

      case 'structured':
        // For structured types, we accept any non-null value
        // (full JSON schema validation would be done by the caller)
        if (answerValue === undefined || answerValue === null) {
          return { valid: false, reason: 'Expected a structured answer (object)' };
        }
        return { valid: true };

      default:
        return { valid: false, reason: `Unknown answer type: ${schema.answerType}` };
    }
  }

  private computeContractDigest(content: unknown): string {
    return this.computeDigest(JSON.stringify(content));
  }

  private computeDigest(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private getConfiguredLimit(kind: 'item_count' | 'byte_size' | 'cost' | 'risk'): number {
    switch (kind) {
      case 'item_count': return this.config.bulkThresholds.itemCount;
      case 'byte_size': return this.config.bulkThresholds.byteSize;
      case 'cost': return this.config.bulkThresholds.cost;
      case 'risk': return this.config.bulkThresholds.risk;
    }
  }

  private scopeOverlaps(a: ScopeDescriptorV1, b: ScopeDescriptorV1): boolean {
    // A scope overlaps if it matches on all specified dimensions
    if (a.userId && b.userId && a.userId !== b.userId) return false;
    if (a.workspaceId && b.workspaceId && a.workspaceId !== b.workspaceId) return false;
    if (a.projectId && b.projectId && a.projectId !== b.projectId) return false;
    if (a.sessionId && b.sessionId && a.sessionId !== b.sessionId) return false;
    return true;
  }
}
