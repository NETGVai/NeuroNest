/**
 * Plan Mode Controller — Reviewed collaboration state that separates
 * planning-safe operations from approved execution.
 *
 * Manages Plan_Mode lifecycle:
 * - Enter/exit transitions with Session_Log evidence
 * - Tool enforcement: only read-only or planning-safe tools while active
 * - Plan revision identity preservation with linked history
 * - Approval bound to exact unchanged plan revision
 * - Approval expiry when approved plan changes before execution
 * - Exit with approved plan identity and execution guidance
 *
 * Requirements: 8.1–8.6
 */

import { createHash } from 'crypto';
import {
  type PlanModeState,
  type PlanRevision,
  type PlanModeEnterTransition,
  type PlanModeExitTransition,
  type PlanApproval,
  type PlanModeToolCheckResult,
  type ToolSafetyClass,
  type ToolPlanModeClassification,
  type PlanModeControllerConfig,
  type PlanExecutionRequest,
  type PlanExecutionValidation,
  PlanModeControllerConfigSchema,
} from './plan-mode-controller-schemas';
import type { ContractRef } from '../contracts/primitives';

// ─── Errors ─────────────────────────────────────────────────────

export class PlanModeError extends Error {
  constructor(
    message: string,
    public readonly code: PlanModeErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PlanModeError';
  }
}

export type PlanModeErrorCode =
  | 'INVALID_CONFIG'
  | 'ALREADY_ACTIVE'
  | 'NOT_ACTIVE'
  | 'TOOL_NOT_CLASSIFIED'
  | 'TOOL_NOT_PERMITTED'
  | 'NO_CURRENT_PLAN'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'REVISION_MISMATCH';

// ─── Session Log Port ───────────────────────────────────────────

/**
 * Minimal port for appending Plan_Mode transitions to Session_Log.
 */
export interface PlanModeLogPort {
  appendEnterTransition(transition: PlanModeEnterTransition): void;
  appendExitTransition(transition: PlanModeExitTransition): void;
}

// ─── Tool Classification Registry Port ──────────────────────────

/**
 * Port for querying tool safety classification from Tool_Registry.
 * Requirement 8.2: tools classified as read-only or planning-safe by Tool_Registry.
 */
export interface ToolClassificationPort {
  getClassification(toolContract: ContractRef): ToolSafetyClass | undefined;
}

// ─── Plan Mode Controller ───────────────────────────────────────

/**
 * Plan_Mode Controller — manages the reviewed collaboration state
 * that separates planning-safe operations from approved execution.
 *
 * Requirements: 8.1–8.6
 */
export class PlanModeController {
  private readonly config: PlanModeControllerConfig;
  private readonly logPort: PlanModeLogPort;
  private readonly toolClassification: ToolClassificationPort;
  private readonly sessionId: string;
  private readonly turnId: string;

  /** Current Plan_Mode state. */
  private state: PlanModeState = 'inactive';

  /** Plan revision history (linked list via priorRevisionId). */
  private revisions: PlanRevision[] = [];

  /** Current approval (if any). */
  private currentApproval: PlanApproval | null = null;

  /** ID counter for generating unique identifiers. */
  private idCounter = 0;

  constructor(params: {
    config: PlanModeControllerConfig;
    logPort: PlanModeLogPort;
    toolClassification: ToolClassificationPort;
    sessionId: string;
    turnId: string;
  }) {
    const parseResult = PlanModeControllerConfigSchema.safeParse(params.config);
    if (!parseResult.success) {
      throw new PlanModeError(
        `Invalid Plan_Mode configuration: ${parseResult.error.message}`,
        'INVALID_CONFIG',
        { issues: parseResult.error.issues },
      );
    }

    this.config = parseResult.data;
    this.logPort = params.logPort;
    this.toolClassification = params.toolClassification;
    this.sessionId = params.sessionId;
    this.turnId = params.turnId;
  }

  // ─── State Queries ──────────────────────────────────────────────

  /**
   * Get the current Plan_Mode state.
   */
  getState(): PlanModeState {
    return this.state;
  }

  /**
   * Whether Plan_Mode is currently active (active, pending_approval, or approved).
   */
  isActive(): boolean {
    return this.state !== 'inactive';
  }

  /**
   * Get the current (latest) plan revision, if any.
   */
  getCurrentRevision(): PlanRevision | null {
    return this.revisions.length > 0 ? this.revisions[this.revisions.length - 1] : null;
  }

  /**
   * Get all plan revisions in order.
   */
  getRevisionHistory(): ReadonlyArray<PlanRevision> {
    return this.revisions;
  }

  /**
   * Get the current approval, if any.
   */
  getCurrentApproval(): PlanApproval | null {
    return this.currentApproval;
  }

  /**
   * Get the planning prompt section name for Prompt_Assembler.
   * Requirement 8.1: include named planning prompt section.
   */
  getPlanningPromptSectionName(): string {
    return this.config.planningPromptSectionName;
  }

  // ─── Plan Mode Entry ──────────────────────────────────────────

  /**
   * Enter Plan_Mode.
   *
   * Requirement 8.1: append state transition and include named planning
   * prompt section in next assembled request.
   *
   * @param reason - Why Plan_Mode is being entered.
   * @param initialPlanContent - Optional initial plan content to create first revision.
   * @returns The enter transition record.
   */
  enter(
    reason: 'user_request' | 'loop_guard_escalation' | 'policy',
    initialPlanContent?: string,
  ): PlanModeEnterTransition {
    if (this.state !== 'inactive') {
      throw new PlanModeError(
        'Plan_Mode is already active',
        'ALREADY_ACTIVE',
        { currentState: this.state },
      );
    }

    this.state = 'active';

    // Create initial revision if content provided
    let initialRevisionId: string | undefined;
    if (initialPlanContent) {
      const revision = this.createRevision(initialPlanContent, 'system');
      initialRevisionId = revision.revisionId;
    }

    const transition: PlanModeEnterTransition = {
      type: 'plan_mode_enter',
      transitionId: this.generateId('pme'),
      sessionId: this.sessionId,
      turnId: this.turnId,
      planningPromptSection: this.config.planningPromptSectionName,
      initialRevisionId,
      reason,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.logPort.appendEnterTransition(transition);

    return transition;
  }

  // ─── Plan Mode Exit ───────────────────────────────────────────

  /**
   * Exit Plan_Mode.
   *
   * Requirement 8.6: include approved plan identity and execution guidance
   * without changing unrelated prompt sections.
   *
   * @param reason - Why Plan_Mode is exiting.
   * @param executionGuidance - Optional execution guidance text.
   * @returns The exit transition record.
   */
  exit(
    reason: 'execution_approved' | 'user_cancel' | 'timeout' | 'error',
    executionGuidance?: string,
  ): PlanModeExitTransition {
    if (this.state === 'inactive') {
      throw new PlanModeError(
        'Plan_Mode is not active',
        'NOT_ACTIVE',
      );
    }

    const approvedRevisionId = this.currentApproval && !this.currentApproval.expired
      ? this.currentApproval.boundRevisionId
      : undefined;

    const transition: PlanModeExitTransition = {
      type: 'plan_mode_exit',
      transitionId: this.generateId('pmx'),
      sessionId: this.sessionId,
      turnId: this.turnId,
      approvedRevisionId,
      executionGuidance,
      reason,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.logPort.appendExitTransition(transition);

    // Reset state
    this.state = 'inactive';
    this.currentApproval = null;

    return transition;
  }

  // ─── Tool Enforcement ─────────────────────────────────────────

  /**
   * Check if a tool call is permitted while Plan_Mode is active.
   *
   * Requirement 8.2: only tools classified as read-only or planning-safe
   * by Tool_Registry are allowed while Plan_Mode is active.
   *
   * @param toolContract - The tool to check.
   * @returns Whether the tool is permitted, with classification details.
   */
  checkToolPermission(toolContract: ContractRef): PlanModeToolCheckResult {
    if (!this.isActive()) {
      // Not in Plan_Mode — all tools are permitted
      return {
        permitted: true,
        toolContract,
        safetyClass: 'mutating', // classification doesn't matter when not in Plan_Mode
      };
    }

    const classification = this.toolClassification.getClassification(toolContract);

    if (classification === undefined) {
      // Unknown tools are treated as mutating (fail-closed)
      return {
        permitted: false,
        toolContract,
        safetyClass: 'mutating',
        reason: 'Tool is not classified — treated as mutating while Plan_Mode is active',
      };
    }

    if (classification === 'read-only' || classification === 'planning-safe') {
      return {
        permitted: true,
        toolContract,
        safetyClass: classification,
      };
    }

    return {
      permitted: false,
      toolContract,
      safetyClass: classification,
      reason: `Tool classified as '${classification}' is not permitted while Plan_Mode is active`,
    };
  }

  // ─── Plan Revision Management ─────────────────────────────────

  /**
   * Amend the plan by creating a new revision linked to the prior one.
   *
   * Requirement 8.3: preserve amendment identity and link next revision
   * to prior revision.
   *
   * Requirement 8.5: if the approved plan changes before execution,
   * expire the approval and request a new decision.
   *
   * @param content - New plan content.
   * @param author - Actor making the amendment.
   * @returns The new plan revision.
   */
  amendPlan(content: string, author: string): PlanRevision {
    if (!this.isActive()) {
      throw new PlanModeError(
        'Cannot amend plan — Plan_Mode is not active',
        'NOT_ACTIVE',
      );
    }

    const revision = this.createRevision(content, author);

    // Requirement 8.5: expire approval if plan changes
    if (this.currentApproval && !this.currentApproval.expired && !this.currentApproval.consumed) {
      this.expireApproval('plan_revised_after_approval');
    }

    return revision;
  }

  /**
   * Get a specific revision by ID.
   */
  getRevision(revisionId: string): PlanRevision | undefined {
    return this.revisions.find((r) => r.revisionId === revisionId);
  }

  // ─── Approval Management ──────────────────────────────────────

  /**
   * Grant approval bound to the exact current plan revision.
   *
   * Requirement 8.4: require approval bound to exact plan revision.
   *
   * @param approvedBy - Actor granting approval.
   * @returns The approval record.
   */
  grantApproval(approvedBy: string): PlanApproval {
    if (!this.isActive()) {
      throw new PlanModeError(
        'Cannot grant approval — Plan_Mode is not active',
        'NOT_ACTIVE',
      );
    }

    const currentRevision = this.getCurrentRevision();
    if (!currentRevision) {
      throw new PlanModeError(
        'Cannot grant approval — no plan revision exists',
        'NO_CURRENT_PLAN',
      );
    }

    // Expire any existing approval
    if (this.currentApproval && !this.currentApproval.expired && !this.currentApproval.consumed) {
      this.expireApproval('superseded_by_new_approval');
    }

    const now = new Date();
    const expiresAt = this.config.approvalExpiryMs > 0
      ? new Date(now.getTime() + this.config.approvalExpiryMs).toISOString()
      : undefined;

    const approval: PlanApproval = {
      approvalId: this.generateId('apv'),
      planId: currentRevision.planId,
      boundRevisionId: currentRevision.revisionId,
      revisionContentDigest: currentRevision.contentDigest,
      approvedBy,
      approvedAt: now.toISOString(),
      expiresAt,
      consumed: false,
      expired: false,
      schemaVersion: 1,
    };

    this.currentApproval = approval;
    this.state = 'approved';

    return approval;
  }

  /**
   * Validate an execution request against the current approval.
   *
   * Requirement 8.4: execution requires approval bound to exact plan revision.
   * Requirement 8.5: if approved plan changes before execution, expire approval.
   *
   * @param request - The execution request to validate.
   * @returns Validation result.
   */
  validateExecutionRequest(request: PlanExecutionRequest): PlanExecutionValidation {
    if (!this.isActive()) {
      return {
        valid: false,
        reason: 'plan_mode_not_active',
        details: 'Plan_Mode is not active',
      };
    }

    if (!this.currentApproval) {
      return {
        valid: false,
        reason: 'no_approval',
        details: 'No approval has been granted',
      };
    }

    // Check time-based expiry
    if (this.currentApproval.expiresAt) {
      const now = new Date();
      const expiresAt = new Date(this.currentApproval.expiresAt);
      if (now >= expiresAt) {
        this.expireApproval('time_expired');
        return {
          valid: false,
          reason: 'approval_expired',
          details: 'Approval has expired due to time limit',
        };
      }
    }

    if (this.currentApproval.expired) {
      return {
        valid: false,
        reason: 'approval_expired',
        details: `Approval expired: ${this.currentApproval.expiryReason || 'unknown'}`,
      };
    }

    if (this.currentApproval.consumed) {
      return {
        valid: false,
        reason: 'approval_consumed',
        details: 'Approval has already been consumed',
      };
    }

    // Requirement 8.4: approval must be bound to the exact revision
    if (this.currentApproval.boundRevisionId !== request.revisionId) {
      return {
        valid: false,
        reason: 'revision_mismatch',
        details: `Approval is bound to revision ${this.currentApproval.boundRevisionId}, ` +
          `but execution requested for revision ${request.revisionId}`,
      };
    }

    // Verify content digest matches (exact unchanged revision)
    if (this.currentApproval.revisionContentDigest !== request.contentDigest) {
      this.expireApproval('content_digest_mismatch');
      return {
        valid: false,
        reason: 'digest_mismatch',
        details: 'Plan content has changed since approval was granted',
      };
    }

    // Approval is valid — consume it
    this.currentApproval = { ...this.currentApproval, consumed: true };

    return {
      valid: true,
      approvalId: this.currentApproval.approvalId,
      boundRevisionId: this.currentApproval.boundRevisionId,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Create a new plan revision linked to the prior one.
   */
  private createRevision(content: string, author: string): PlanRevision {
    const priorRevision = this.getCurrentRevision();
    const planId = priorRevision?.planId ?? this.generateId('plan');

    const revision: PlanRevision = {
      revisionId: this.generateId('rev'),
      planId,
      sequenceNumber: (priorRevision?.sequenceNumber ?? 0) + 1,
      priorRevisionId: priorRevision?.revisionId ?? null,
      contentDigest: this.computeDigest(content),
      author,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    this.revisions.push(revision);
    return revision;
  }

  /**
   * Expire the current approval.
   *
   * Requirement 8.5: expire approval and request new decision.
   */
  private expireApproval(reason: string): void {
    if (this.currentApproval) {
      this.currentApproval = {
        ...this.currentApproval,
        expired: true,
        expiryReason: reason,
      };
      // Transition state back to active (approval no longer valid)
      if (this.state === 'approved') {
        this.state = 'active';
      }
    }
  }

  /**
   * Compute a content digest for plan revision verification.
   */
  private computeDigest(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 32);
  }

  /**
   * Generate a unique identifier.
   */
  private generateId(prefix: string): string {
    this.idCounter++;
    return `${prefix}_${this.sessionId}_${this.turnId}_${this.idCounter}`;
  }
}
