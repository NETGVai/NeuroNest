/**
 * Collaboration Takeover Store
 *
 * Manages the exact collaboration takeover of the Composer_Workbench.
 * Exactly one unanswered question, approval, or plan review may own
 * the workbench at a time. The store:
 *
 * - Activates takeover from a projected pending contract (38.1–38.3)
 * - Provides applicable decision controls (38.4)
 * - Exposes permission presets before selection (38.5)
 * - Invalidates stale Approval_Digests (38.6)
 * - Suppresses duplicate timeline cards (38.7)
 * - Preserves and restores prior draft/focus (38.8)
 * - Disables submission when authority unavailable (38.9)
 * - Waits for projection confirmation before showing accepted (38.10)
 * - Rejects stale/superseded decisions (38.11)
 * - Exposes full keyboard/screen-reader data (38.12)
 * - Validates answers against the exact schema (38.13)
 * - Commits at most one decision per identity (38.14)
 * - Deduplicates contracts with same identity (38.15)
 * - Rejects decisions targeting stale identities (38.16)
 *
 * Requirements: 38.1–38.16
 */

import {
  type CollaborationTakeoverState,
  type TakeoverStatus,
  type ProjectedTakeoverContract,
  type TakeoverDecisionSubmission,
  type PreservedDraft,
  type TakeoverProjectionUpdate,
  type CollaborationTakeoverView,
  type AccessibilityDecisionData,
  type DecisionAction,
  type TakeoverConfig,
  DEFAULT_TAKEOVER_CONFIG,
  TakeoverDecisionSubmissionSchema,
  ProjectedTakeoverContractSchema,
} from './types';
import type { AnswerSchemaDefinition } from '../../runtime/collaboration-schemas';

// ─── Answer Validation ──────────────────────────────────────────

/**
 * Validates an answer value against the exact projected answer schema.
 * Returns a structured validation result.
 *
 * Requirement 38.13: validate answer against exact projected answer schema.
 */
export function validateAnswer(
  value: unknown,
  schema: AnswerSchemaDefinition,
): { valid: boolean; reason?: string } {
  // Required check
  if (schema.required !== false) {
    if (value === undefined || value === null || value === '') {
      return { valid: false, reason: 'Answer is required and must not be empty' };
    }
  } else {
    // Not required — allow undefined, null, and empty
    if (value === undefined || value === null || value === '') {
      return { valid: true };
    }
  }

  switch (schema.answerType) {
    case 'text': {
      if (typeof value !== 'string') {
        return { valid: false, reason: 'Answer must be a text string' };
      }
      if (schema.required !== false && value.trim().length === 0) {
        return { valid: false, reason: 'Answer is required and must not be empty' };
      }
      return { valid: true };
    }

    case 'choice': {
      if (typeof value !== 'string') {
        return { valid: false, reason: 'Choice answer must be a string' };
      }
      if (schema.allowedValues && !schema.allowedValues.includes(value)) {
        return {
          valid: false,
          reason: `Answer must be one of: ${schema.allowedValues.join(', ')}`,
        };
      }
      return { valid: true };
    }

    case 'confirmation': {
      if (typeof value !== 'boolean') {
        return { valid: false, reason: 'Confirmation answer must be boolean' };
      }
      return { valid: true };
    }

    case 'structured': {
      // For structured types, validate that it's an object
      if (value === null || typeof value !== 'object') {
        return { valid: false, reason: 'Structured answer must be an object' };
      }
      return { valid: true };
    }

    default:
      return { valid: false, reason: `Unknown answer type: ${schema.answerType}` };
  }
}

// ─── Timeline Key Derivation ────────────────────────────────────

/**
 * Derives the stable timeline key for a collaboration contract
 * so the duplicate timeline card can be suppressed (Req 38.7).
 */
export function deriveTimelineKey(
  sessionId: string,
  collaborationId: string,
): string {
  return `collab:${sessionId}:${collaborationId}`;
}

// ─── Accessibility Data Builder ─────────────────────────────────

/**
 * Builds the full accessibility decision data from a projected contract
 * and takeover status (Req 38.12).
 */
export function buildAccessibilityData(
  contract: ProjectedTakeoverContract,
  status: TakeoverStatus,
  unavailableReason?: string,
): AccessibilityDecisionData {
  const isDisabled = status === 'unavailable' || status === 'expired' ||
    status === 'superseded' || status === 'submitting';

  const controls: AccessibilityDecisionData['controls'] = contract.availableActions.map(
    (action) => {
      const label = getActionLabel(action, contract.kind);
      return {
        action,
        label,
        ariaDescription: getActionAriaDescription(action, contract),
        disabled: isDisabled,
        disabledReason: isDisabled ? (unavailableReason ?? getDisabledReason(status)) : undefined,
      };
    },
  );

  const scopeDescription = contract.scope
    ? formatScopeDescription(contract.scope)
    : 'No specific scope';

  const riskDescription = contract.riskSummary ?? 'No risk assessment';

  const expiryDescription = contract.expiresAt
    ? `Expires at ${contract.expiresAt}`
    : 'No expiry';

  return {
    ariaLabel: getTakeoverAriaLabel(contract),
    decisionText: contract.displayText,
    scopeDescription,
    riskDescription,
    expiryDescription,
    controls,
    role: contract.kind === 'approval' || contract.kind === 'plan_review'
      ? 'alertdialog'
      : 'dialog',
    live: status === 'active',
  };
}

function getActionLabel(action: DecisionAction, kind: string): string {
  switch (action) {
    case 'approve':
      return kind === 'plan_review' ? 'Approve Plan' : 'Approve';
    case 'deny':
      return 'Deny';
    case 'answer':
      return 'Submit Answer';
    case 'select_preset':
      return 'Select Permission Preset';
  }
}

function getActionAriaDescription(
  action: DecisionAction,
  contract: ProjectedTakeoverContract,
): string {
  switch (action) {
    case 'approve':
      return `Approve: ${contract.displayText}. Scope: ${contract.scope ? formatScopeDescription(contract.scope) : 'none'}. Risk: ${contract.riskSummary ?? 'unclassified'}`;
    case 'deny':
      return `Deny: ${contract.displayText}`;
    case 'answer':
      return `Answer question: ${contract.displayText}`;
    case 'select_preset':
      return `Select a permission preset for: ${contract.displayText}`;
  }
}

function getTakeoverAriaLabel(contract: ProjectedTakeoverContract): string {
  switch (contract.kind) {
    case 'question':
      return `Collaboration question from ${contract.owner}: ${contract.displayText}`;
    case 'approval':
      return `Approval request from ${contract.owner}: ${contract.displayText}`;
    case 'plan_review':
      return `Plan review from ${contract.owner}: ${contract.displayText}`;
  }
}

function getDisabledReason(status: TakeoverStatus): string {
  switch (status) {
    case 'unavailable':
      return 'Owning authority is unavailable';
    case 'expired':
      return 'This collaboration contract has expired';
    case 'superseded':
      return 'This contract has been superseded by a newer version';
    case 'submitting':
      return 'Decision is being submitted, awaiting confirmation';
    default:
      return '';
  }
}

function formatScopeDescription(scope: { sessionId?: string; workspaceId?: string; projectId?: string }): string {
  const parts: string[] = [];
  if (scope.projectId) parts.push(`project:${scope.projectId}`);
  if (scope.workspaceId) parts.push(`workspace:${scope.workspaceId}`);
  if (scope.sessionId) parts.push(`session:${scope.sessionId}`);
  return parts.length > 0 ? parts.join(', ') : 'global';
}

// ─── Collaboration Takeover Store ───────────────────────────────

/**
 * Manages the state of exactly one collaboration takeover of the Composer_Workbench.
 * Pure state management — no external effects. Consumers drive transitions.
 */
export class CollaborationTakeoverStore {
  private state: CollaborationTakeoverState;
  private readonly config: TakeoverConfig;
  private committedDecisionIds: Set<string> = new Set();

  constructor(config?: Partial<TakeoverConfig>) {
    this.config = { ...DEFAULT_TAKEOVER_CONFIG, ...config };
    this.state = this.createEmptyState();
  }

  // ─── Queries ────────────────────────────────────────────────

  /** Returns the current takeover state. */
  getState(): Readonly<CollaborationTakeoverState> {
    return this.state;
  }

  /** Whether a takeover is currently active and visible. */
  isActive(): boolean {
    return this.state.active;
  }

  /** Get the timeline keys that should be suppressed (Req 38.7). */
  getSuppressedTimelineKeys(): ReadonlySet<string> {
    return this.state.suppressedTimelineKeys;
  }

  /** Whether the given timeline key should be suppressed. */
  isTimelineKeySuppressed(key: string): boolean {
    return this.state.suppressedTimelineKeys.has(key);
  }

  /** Get the current takeover view for rendering. */
  getView(): CollaborationTakeoverView {
    if (!this.state.active || !this.state.contract) {
      return {
        visible: false,
        kind: null,
        displayText: '',
        accessibility: {
          ariaLabel: '',
          decisionText: '',
          scopeDescription: '',
          riskDescription: '',
          expiryDescription: '',
          controls: [],
          role: 'dialog',
          live: false,
        },
        status: 'active',
        submitDisabled: true,
        submitDisabledReason: 'No active collaboration',
        validating: false,
        suppressedTimelineKeys: new Set(),
      };
    }

    const submitDisabled = this.state.status === 'unavailable' ||
      this.state.status === 'expired' ||
      this.state.status === 'superseded' ||
      this.state.status === 'submitting';

    return {
      visible: true,
      kind: this.state.contract.kind,
      displayText: this.state.contract.displayText,
      accessibility: buildAccessibilityData(
        this.state.contract,
        this.state.status,
        this.state.failureReason,
      ),
      status: this.state.status,
      submitDisabled,
      submitDisabledReason: submitDisabled ? getDisabledReason(this.state.status) : undefined,
      validating: false,
      suppressedTimelineKeys: this.state.suppressedTimelineKeys,
    };
  }

  // ─── Activation ─────────────────────────────────────────────

  /**
   * Activate a collaboration takeover from a projected pending contract.
   *
   * Req 38.1–38.3: replaces ordinary submission controls
   * Req 38.7: suppresses the duplicate timeline card
   * Req 38.8: preserves the prior draft
   * Req 38.15: deduplicates contracts with same identity
   */
  activate(params: {
    contract: ProjectedTakeoverContract;
    preservedDraft: PreservedDraft;
    projectionRevision: number;
  }): { success: boolean; reason?: string } {
    const parseResult = ProjectedTakeoverContractSchema.safeParse(params.contract);
    if (!parseResult.success) {
      return { success: false, reason: `Invalid contract: ${parseResult.error.message}` };
    }

    const contract = parseResult.data as ProjectedTakeoverContract;

    // Req 38.15: If duplicate collaboration records share one identity, render one takeover
    if (
      this.state.active &&
      this.state.currentIdentity?.collaborationId === contract.collaborationId
    ) {
      // Same identity — update revision if newer, keep existing draft/focus
      if (contract.revision > (this.state.currentIdentity?.revision ?? 0)) {
        this.state = {
          ...this.state,
          contract,
          currentIdentity: {
            collaborationId: contract.collaborationId,
            revision: contract.revision,
          },
        };
      }
      return { success: true };
    }

    // Derive the timeline key to suppress (Req 38.7)
    const timelineKey = deriveTimelineKey(contract.sessionId, contract.collaborationId);

    this.state = {
      active: true,
      contract,
      status: 'active',
      suppressedTimelineKeys: new Set([timelineKey]),
      preservedDraft: params.preservedDraft,
      pendingDecision: null,
      sourceProjectionRevision: params.projectionRevision,
      currentIdentity: {
        collaborationId: contract.collaborationId,
        revision: contract.revision,
      },
    };

    return { success: true };
  }

  // ─── Decision Submission ────────────────────────────────────

  /**
   * Submit a decision from the takeover surface.
   *
   * Req 38.6: invalidates if context changed (checked by caller before submission)
   * Req 38.10: waits for projection confirmation
   * Req 38.13: validates answer against exact schema
   * Req 38.14: commits at most one decision per identity
   * Req 38.16: rejects stale/superseded identity or revision
   */
  submitDecision(submission: TakeoverDecisionSubmission): {
    accepted: boolean;
    reason?: string;
  } {
    // Validate submission schema
    const parseResult = TakeoverDecisionSubmissionSchema.safeParse(submission);
    if (!parseResult.success) {
      return { accepted: false, reason: `Invalid submission: ${parseResult.error.message}` };
    }

    // Must have an active takeover
    if (!this.state.active || !this.state.contract) {
      return { accepted: false, reason: 'No active collaboration takeover' };
    }

    // Req 38.9: unavailable authority
    if (this.state.status === 'unavailable') {
      return { accepted: false, reason: 'Owning authority is unavailable' };
    }

    // Req 38.11: expired or superseded
    if (this.state.status === 'expired') {
      return { accepted: false, reason: 'Collaboration contract has expired' };
    }
    if (this.state.status === 'superseded') {
      return { accepted: false, reason: 'Collaboration contract has been superseded' };
    }

    // Already submitting
    if (this.state.status === 'submitting') {
      return { accepted: false, reason: 'A decision is already pending confirmation' };
    }

    // Req 38.16: reject stale identity or revision
    if (submission.collaborationId !== this.state.contract.collaborationId) {
      return {
        accepted: false,
        reason: `Stale collaboration identity. Current: ${this.state.contract.collaborationId}`,
      };
    }
    if (submission.expectedRevision !== this.state.contract.revision) {
      return {
        accepted: false,
        reason: `Revision mismatch. Current: ${this.state.contract.revision}`,
      };
    }

    // Req 38.14: at most one decision per identity
    const decisionKey = `${submission.collaborationId}:${submission.expectedRevision}`;
    if (this.committedDecisionIds.has(decisionKey)) {
      return { accepted: false, reason: 'Decision already committed for this identity and revision' };
    }

    // Req 38.13: validate answer against schema (for questions)
    if (submission.action === 'answer' && this.state.contract.answerSchema) {
      const validation = validateAnswer(submission.answerValue, this.state.contract.answerSchema);
      if (!validation.valid) {
        return { accepted: false, reason: validation.reason };
      }
    }

    // Accept — transition to submitting and wait for projection commit (Req 38.10)
    this.state = {
      ...this.state,
      status: 'submitting',
      pendingDecision: submission,
    };

    return { accepted: true };
  }

  // ─── Projection Updates ─────────────────────────────────────

  /**
   * Process a projection update to confirm or reject a pending decision.
   *
   * Req 38.10: wait for resulting Projection_Service revision before displaying accepted.
   * Req 38.11: reject stale/superseded attempts.
   */
  processProjectionUpdate(update: TakeoverProjectionUpdate): {
    confirmed: boolean;
    ended: boolean;
  } {
    if (!this.state.active || !this.state.contract) {
      return { confirmed: false, ended: false };
    }

    // Check if decision was confirmed
    if (
      this.state.status === 'submitting' &&
      this.state.pendingDecision
    ) {
      const decisionConfirmed = update.confirmedDecisionIds.includes(
        this.state.pendingDecision.idempotencyKey,
      );

      if (decisionConfirmed) {
        // Record committed decision (Req 38.14)
        const decisionKey = `${this.state.pendingDecision.collaborationId}:${this.state.pendingDecision.expectedRevision}`;
        this.committedDecisionIds.add(decisionKey);

        this.state = {
          ...this.state,
          status: 'committed',
          pendingDecision: null,
        };
        return { confirmed: true, ended: true };
      }
    }

    // Check if collaboration state changed (expired, superseded, answered, etc.)
    if (update.collaborationState) {
      switch (update.collaborationState) {
        case 'expired':
          this.state = {
            ...this.state,
            status: 'expired',
            pendingDecision: null,
            failureReason: 'Collaboration contract expired before commit',
          };
          return { confirmed: false, ended: true };

        case 'superseded':
          this.state = {
            ...this.state,
            status: 'superseded',
            pendingDecision: null,
            failureReason: 'Collaboration contract superseded by newer version',
          };
          return { confirmed: false, ended: true };

        case 'answered':
        case 'approved':
        case 'denied':
          // Terminal states — the decision was committed (possibly from another source)
          if (this.state.status === 'submitting' && this.state.pendingDecision) {
            const decisionKey = `${this.state.pendingDecision.collaborationId}:${this.state.pendingDecision.expectedRevision}`;
            this.committedDecisionIds.add(decisionKey);
          }
          this.state = {
            ...this.state,
            status: 'committed',
            pendingDecision: null,
          };
          return { confirmed: true, ended: true };
      }
    }

    return { confirmed: false, ended: false };
  }

  // ─── Authority Unavailability ───────────────────────────────

  /**
   * Mark the takeover as unavailable due to MCP process or provider disconnect.
   *
   * Req 38.9: disable approval/answer submission, retain pending decision, display reason.
   */
  markUnavailable(reason: string): void {
    if (!this.state.active) return;

    this.state = {
      ...this.state,
      status: 'unavailable',
      failureReason: reason,
    };
  }

  /**
   * Restore availability after reconnection.
   */
  markAvailable(): void {
    if (!this.state.active) return;
    if (this.state.status !== 'unavailable') return;

    // Restore to active if there's still a pending contract
    this.state = {
      ...this.state,
      status: this.state.pendingDecision ? 'submitting' : 'active',
      failureReason: undefined,
    };
  }

  // ─── Rejection ──────────────────────────────────────────────

  /**
   * Handle rejection of a submitted decision.
   *
   * Req 38.11: reject stale attempt and display current pending decision.
   * Req 38.16: reject decisions referencing stale identity/revision.
   */
  handleRejection(reason: string): void {
    if (!this.state.active) return;

    this.state = {
      ...this.state,
      status: 'rejected',
      pendingDecision: null,
      failureReason: reason,
    };
  }

  /**
   * Return to active state after rejection so user can retry with corrected input.
   */
  clearRejection(): void {
    if (!this.state.active || this.state.status !== 'rejected') return;

    this.state = {
      ...this.state,
      status: 'active',
      failureReason: undefined,
    };
  }

  // ─── Timeout ────────────────────────────────────────────────

  /**
   * Check whether the pending decision has timed out awaiting confirmation.
   * Returns true if timed out and the state was updated.
   */
  checkTimeout(now: number): boolean {
    if (
      this.state.status !== 'submitting' ||
      !this.state.pendingDecision
    ) {
      return false;
    }

    const submittedAt = new Date(this.state.pendingDecision.submittedAt).getTime();
    const elapsed = now - submittedAt;

    if (elapsed >= this.config.projectionConfirmTimeoutMs) {
      // Timeout — reject the pending decision
      this.state = {
        ...this.state,
        status: 'rejected',
        pendingDecision: null,
        failureReason: 'Projection confirmation timed out',
      };
      return true;
    }

    return false;
  }

  // ─── Deactivation ──────────────────────────────────────────

  /**
   * Deactivate the takeover and restore the prior draft/focus.
   *
   * Req 38.8: restore prior draft and focus to invoking control or ordinary input.
   */
  deactivate(): PreservedDraft | null {
    const draft = this.state.preservedDraft;
    this.state = this.createEmptyState();
    return draft;
  }

  // ─── Digest Invalidation ───────────────────────────────────

  /**
   * Invalidate the current takeover if the approval digest context has changed.
   *
   * Req 38.6: if normalized arguments, scope, risk, owner, tool version,
   * or plan revision changes, invalidate the pending Approval_Digest.
   */
  invalidateDigest(reason: string): void {
    if (!this.state.active) return;

    this.state = {
      ...this.state,
      status: 'expired',
      pendingDecision: null,
      failureReason: `Approval digest invalidated: ${reason}`,
    };
  }

  // ─── Configuration ─────────────────────────────────────────

  /** Get the current configuration. */
  getConfig(): Readonly<TakeoverConfig> {
    return this.config;
  }

  // ─── Private ────────────────────────────────────────────────

  private createEmptyState(): CollaborationTakeoverState {
    return {
      active: false,
      contract: null,
      status: 'active',
      suppressedTimelineKeys: new Set(),
      preservedDraft: null,
      pendingDecision: null,
      sourceProjectionRevision: 0,
    };
  }
}
