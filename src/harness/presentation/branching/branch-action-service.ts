/**
 * Branch Action Service
 *
 * Routes branching, edit-and-resend, and exact retry actions through
 * owning authorities. Enforces immutability: appends lineage before
 * child events, preserves original history/drafts/selection on failure,
 * and keeps current-configuration branching distinct from exact retry.
 *
 * Actions are dispatched through authority adapters; this service never
 * directly mutates the Session_Log. All mutations are append-only.
 *
 * Requirements: 44.1-44.16
 */

import type {
  BranchActionCommand,
  BranchCommand,
  EditAndResendCommand,
  ExactRetryCommand,
  BranchWithCurrentConfigCommand,
  BranchActionOutcome,
  BranchLineageV1,
  MessageActionV1,
  MessageActionKind,
  ActionAvailability,
  ActionConfirmation,
  ConfirmationReason,
  CompletionAnchor,
  PromptFingerprint,
  PreconditionResult,
  RetryPreconditionKind,
  ActiveBranchState,
  CompletionProvenanceV1,
  UnavailabilityReason,
} from './types';
import {
  BranchCommandSchema,
  EditAndResendCommandSchema,
  ExactRetryCommandSchema,
  BranchWithCurrentConfigCommandSchema,
  BranchLineageV1Schema,
  CompletionAnchorSchema,
  PromptFingerprintSchema,
  PreconditionResultSchema,
} from './types';

// ─── Authority Port ─────────────────────────────────────────────

/**
 * Port for the owning authority that manages session mutations.
 * All actions route through this adapter rather than directly mutating state.
 */
export interface BranchAuthorityPort {
  /** Append lineage record to Session_Log before child events. */
  appendLineage(lineage: BranchLineageV1): Promise<void>;
  /** Append a branch event (immutable, never modifies prior events). */
  appendBranchEvent(command: BranchCommand): Promise<string>;
  /** Append edit-and-resend to a child branch (preserves original). */
  appendEditAndResend(command: EditAndResendCommand): Promise<string>;
  /** Dispatch exact retry bound to anchor and fingerprint. */
  dispatchExactRetry(command: ExactRetryCommand): Promise<string>;
  /** Dispatch branch-with-current-config (distinct action). */
  dispatchBranchWithCurrentConfig(command: BranchWithCurrentConfigCommand): Promise<string>;
  /** Check retry preconditions: reconstruction, route, attachment, policy, budget. */
  checkRetryPreconditions(
    anchor: CompletionAnchor,
    fingerprint: PromptFingerprint,
  ): Promise<PreconditionResult[]>;
  /** Generate a new unique branch ID. */
  generateBranchId(): string;
  /** Resolve the active branch state for display. */
  getActiveBranchState(sessionId: string): ActiveBranchState;
  /** Check if a given action requires confirmation. */
  requiresConfirmation(
    command: BranchActionCommand,
    currentState: BranchServiceState,
  ): ActionConfirmation;
}

// ─── Service State ──────────────────────────────────────────────

/**
 * Internal state tracked by the BranchActionService to manage
 * pending commands and preserve state on failure (Req 44.15, 44.16).
 */
export interface BranchServiceState {
  readonly sessionId: string;
  readonly activeBranchId: string;
  readonly activeDraftText: string | null;
  readonly selectedNodeKey: string | null;
  readonly pendingCommandId: string | null;
  readonly projectedHistory: ReadonlyArray<string>;
}

// ─── Service Implementation ─────────────────────────────────────

/**
 * Manages immutable branching, edit-and-resend, and exact retry actions.
 *
 * Key invariants:
 * - Branch/edit/retry NEVER mutate prior events (Req 44.9, 44.13)
 * - Branch creation FIRST appends lineage before child events (Req 44.2)
 * - Exact retry binds to user-selected anchor/fingerprint only (Req 44.4, 44.14)
 * - "Branch with current config" is distinct from exact retry (Design)
 * - Failure preserves active branch, draft, selection, history (Req 44.15)
 * - Pending commands retain original state until projection confirms (Req 44.16)
 */
export class BranchActionService {
  private _state: BranchServiceState;
  private readonly _authority: BranchAuthorityPort;

  constructor(authority: BranchAuthorityPort, initialState: BranchServiceState) {
    this._authority = authority;
    this._state = { ...initialState };
  }

  get state(): BranchServiceState {
    return this._state;
  }

  // ─── Action Resolution ──────────────────────────────────────

  /**
   * Resolve which actions are applicable to a given Chat_Node (Req 44.1).
   * Provides availability with specific unavailability reasons (Req 44.6).
   */
  resolveActionsForNode(
    nodeKey: string,
    nodeKind: string,
    nodeRole?: string,
    anchorId?: string,
  ): MessageActionV1[] {
    const actions: MessageActionV1[] = [];

    // Copy is always available for any node
    actions.push(this._makeAction('copy', nodeKey, { available: true }));

    // Expand is available for long content
    actions.push(this._makeAction('expand', nodeKey, { available: true }));

    // Open source is available for nodes with source references
    actions.push(this._makeAction('open_source', nodeKey, { available: true }));

    // Branch is available for user and assistant messages
    if (nodeKind === 'message') {
      actions.push(this._makeAction('branch', nodeKey, { available: true }));
    } else {
      actions.push(this._makeAction('branch', nodeKey, {
        available: false,
        reason: 'lineage_missing',
        displayReason: 'Only message nodes can be branched',
      }));
    }

    // Edit-and-resend only for user messages
    if (nodeKind === 'message' && nodeRole === 'user') {
      actions.push(this._makeAction('edit_and_resend', nodeKey, { available: true }));
    } else {
      actions.push(this._makeAction('edit_and_resend', nodeKey, {
        available: false,
        reason: 'ownership_denied',
        displayReason: 'Only user messages can be edited and resent',
      }));
    }

    // Retry from exact completion only for assistant messages with an anchor
    if (nodeKind === 'message' && nodeRole === 'assistant' && anchorId) {
      actions.push(this._makeAction('retry_from_exact_completion', nodeKey, { available: true }));
    } else {
      const reason: UnavailabilityReason = !anchorId
        ? 'reconstruction_failed'
        : 'ownership_denied';
      const displayReason = !anchorId
        ? 'No completion anchor available for retry'
        : 'Only assistant completions can be retried';
      actions.push(this._makeAction('retry_from_exact_completion', nodeKey, {
        available: false,
        reason,
        displayReason,
      }));
    }

    // Branch with current config — separate action, available when exact retry is not
    if (nodeKind === 'message' && nodeRole === 'assistant') {
      actions.push(this._makeAction('branch_with_current_config', nodeKey, { available: true }));
    } else {
      actions.push(this._makeAction('branch_with_current_config', nodeKey, {
        available: false,
        reason: 'lineage_missing',
        displayReason: 'Only assistant messages support branch with current config',
      }));
    }

    return actions;
  }

  // ─── Command Execution ──────────────────────────────────────

  /**
   * Execute a branch action command. Routes through the owning authority.
   * Appends lineage before child events. Never mutates prior events.
   * On failure, preserves current state (Req 44.15, 44.16).
   */
  async executeCommand(command: BranchActionCommand): Promise<BranchActionOutcome> {
    // Check if confirmation is required (Req 44.10)
    const confirmation = this._authority.requiresConfirmation(command, this._state);
    if (confirmation.required) {
      // Confirmation must be obtained before proceeding.
      // This is signaled back so the UI can show confirmation dialog.
      return {
        status: 'pending',
        commandId: command.idempotencyKey,
      };
    }

    // Snapshot pre-execution state for preservation on failure
    const snapshot = { ...this._state };

    try {
      // Mark as pending
      this._state = { ...this._state, pendingCommandId: command.idempotencyKey };

      switch (command.type) {
        case 'branch':
          return await this._executeBranch(command);
        case 'edit_and_resend':
          return await this._executeEditAndResend(command);
        case 'exact_retry':
          return await this._executeExactRetry(command);
        case 'branch_with_current_config':
          return await this._executeBranchWithCurrentConfig(command);
      }
    } catch (error) {
      // Preserve state on failure (Req 44.15)
      this._state = {
        ...snapshot,
        pendingCommandId: null,
      };

      return {
        status: 'failed',
        commandId: command.idempotencyKey,
        reason: error instanceof Error ? error.message : 'Unknown failure',
        preservedBranchId: snapshot.activeBranchId,
        preservedDraft: snapshot.activeDraftText !== null,
        preservedSelection: snapshot.selectedNodeKey !== null,
        preservedHistory: true,
      };
    }
  }

  // ─── Confirmation Resolution ────────────────────────────────

  /**
   * Determine if an action requires confirmation before proceeding.
   * Actions that appear to replace history, discard drafts, cancel active
   * work, or switch visible branch require confirmation (Req 44.10).
   */
  getConfirmation(command: BranchActionCommand): ActionConfirmation {
    return this._authority.requiresConfirmation(command, this._state);
  }

  /**
   * Execute a command after confirmation has been obtained.
   * Same as executeCommand but bypasses the confirmation check.
   */
  async executeConfirmed(command: BranchActionCommand): Promise<BranchActionOutcome> {
    const snapshot = { ...this._state };

    try {
      this._state = { ...this._state, pendingCommandId: command.idempotencyKey };

      switch (command.type) {
        case 'branch':
          return await this._executeBranch(command);
        case 'edit_and_resend':
          return await this._executeEditAndResend(command);
        case 'exact_retry':
          return await this._executeExactRetry(command);
        case 'branch_with_current_config':
          return await this._executeBranchWithCurrentConfig(command);
      }
    } catch (error) {
      this._state = { ...snapshot, pendingCommandId: null };

      return {
        status: 'failed',
        commandId: command.idempotencyKey,
        reason: error instanceof Error ? error.message : 'Unknown failure',
        preservedBranchId: snapshot.activeBranchId,
        preservedDraft: snapshot.activeDraftText !== null,
        preservedSelection: snapshot.selectedNodeKey !== null,
        preservedHistory: true,
      };
    }
  }

  // ─── Retry Precondition Checks ──────────────────────────────

  /**
   * Verify all preconditions for exact retry (Req 44.5):
   * reconstructability, route compatibility, attachment availability,
   * policy compatibility, and budget eligibility.
   */
  async checkRetryPreconditions(
    anchor: CompletionAnchor,
    fingerprint: PromptFingerprint,
  ): Promise<{ allPassed: boolean; results: PreconditionResult[] }> {
    const results = await this._authority.checkRetryPreconditions(anchor, fingerprint);
    const allPassed = results.every(r => r.passed);
    return { allPassed, results };
  }

  // ─── Active Branch Display ──────────────────────────────────

  /**
   * Get the current active branch state for UI display (Req 44.7).
   * Shows parent-child lineage and active branch identity.
   */
  getActiveBranchState(): ActiveBranchState {
    return this._authority.getActiveBranchState(this._state.sessionId);
  }

  // ─── Private Execution ──────────────────────────────────────

  private async _executeBranch(command: BranchCommand): Promise<BranchActionOutcome> {
    const childBranchId = this._authority.generateBranchId();

    // Append lineage FIRST before child events (Req 44.2)
    const lineage: BranchLineageV1 = {
      parentSessionId: command.sessionId,
      parentSequence: command.sourceSequence,
      selectedChatNodeKey: command.sourceNodeKey,
      actor: command.actor,
      childBranchId,
      createdAt: new Date().toISOString(),
    };

    await this._authority.appendLineage(lineage);

    // Then append the branch event (immutable, does not modify prior events)
    await this._authority.appendBranchEvent(command);

    // Update state to reflect new branch
    this._state = {
      ...this._state,
      activeBranchId: childBranchId,
      pendingCommandId: null,
    };

    return {
      status: 'committed',
      commandId: command.idempotencyKey,
      resultingBranchId: childBranchId,
      lineage,
    };
  }

  private async _executeEditAndResend(command: EditAndResendCommand): Promise<BranchActionOutcome> {
    const childBranchId = this._authority.generateBranchId();

    // Append lineage FIRST (Req 44.2)
    const lineage: BranchLineageV1 = {
      parentSessionId: command.sessionId,
      parentSequence: command.sourceSequence,
      selectedChatNodeKey: command.sourceNodeKey,
      actor: command.actor,
      childBranchId,
      createdAt: new Date().toISOString(),
    };

    await this._authority.appendLineage(lineage);

    // Append edited content in a new branch linked to original (Req 44.3)
    // Original event is preserved — never modified
    await this._authority.appendEditAndResend(command);

    this._state = {
      ...this._state,
      activeBranchId: childBranchId,
      pendingCommandId: null,
    };

    return {
      status: 'committed',
      commandId: command.idempotencyKey,
      resultingBranchId: childBranchId,
      lineage,
    };
  }

  private async _executeExactRetry(command: ExactRetryCommand): Promise<BranchActionOutcome> {
    // Verify preconditions first (Req 44.5)
    const { allPassed, results } = await this.checkRetryPreconditions(
      command.anchor,
      command.fingerprint,
    );

    if (!allPassed) {
      const failedChecks = results.filter(r => !r.passed);
      const reasons = failedChecks.map(r => `${r.kind}: ${r.detail ?? 'failed'}`).join('; ');
      throw new Error(`Retry preconditions not met: ${reasons}`);
    }

    // Dispatch retry bound to exact anchor and fingerprint (Req 44.4, 44.14)
    // Never substitutes a later completion or prompt
    await this._authority.dispatchExactRetry(command);

    this._state = {
      ...this._state,
      pendingCommandId: null,
    };

    return {
      status: 'committed',
      commandId: command.idempotencyKey,
      resultingBranchId: this._state.activeBranchId,
      lineage: {
        parentSessionId: command.sessionId,
        parentSequence: command.anchor.sequence,
        selectedChatNodeKey: command.anchor.anchorId,
        actor: command.actor,
        childBranchId: this._state.activeBranchId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  private async _executeBranchWithCurrentConfig(
    command: BranchWithCurrentConfigCommand,
  ): Promise<BranchActionOutcome> {
    const childBranchId = this._authority.generateBranchId();

    // This is a DISTINCT action from exact retry (design invariant)
    const lineage: BranchLineageV1 = {
      parentSessionId: command.sessionId,
      parentSequence: command.sourceSequence,
      selectedChatNodeKey: command.sourceNodeKey,
      actor: command.actor,
      childBranchId,
      createdAt: new Date().toISOString(),
    };

    await this._authority.appendLineage(lineage);
    await this._authority.dispatchBranchWithCurrentConfig(command);

    this._state = {
      ...this._state,
      activeBranchId: childBranchId,
      pendingCommandId: null,
    };

    return {
      status: 'committed',
      commandId: command.idempotencyKey,
      resultingBranchId: childBranchId,
      lineage,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────

  private _makeAction(
    kind: MessageActionKind,
    targetNodeKey: string,
    availability: ActionAvailability,
  ): MessageActionV1 {
    return { kind, availability, targetNodeKey };
  }
}
