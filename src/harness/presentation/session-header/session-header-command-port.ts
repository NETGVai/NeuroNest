/**
 * SessionHeaderCommandPort — Submits revisioned header commands with dry-run support.
 *
 * Change controls invoke the owning authority and require dry-run impact
 * where route/profile changes affect model, tools, prompts, permissions,
 * context, cache, cost, or budgets. Commands include source authority,
 * source revision, selected value, and actor identity.
 *
 * Retains committed values through pending/rejected/stale outcomes.
 * Never applies optimistic durable mutations to committed view state.
 *
 * Requirements: 43.3-43.6, 43.12-43.16
 */

import type {
  ConflictReason,
  DryRunResultV1,
  HeaderChangeCommandV1,
  HeaderFieldKind,
  PendingHeaderChange,
  SourceAuthority,
} from './session-header-schemas';

// ─── Authority Port Interface ───────────────────────────────────

/**
 * Port to the owning authority for routing commands and dry-run requests.
 * Each authority (Provider_Registry, Profile_Manager, Collaboration_Service,
 * Turn_Controller, Usage_Accountant, Settings_Service) implements this interface.
 *
 * Requirements: 43.3
 */
export interface HeaderAuthorityPort {
  /**
   * Requests a dry-run evaluation of a proposed change.
   * Returns the projected impact before commit.
   * Requirements: 43.4, 43.15
   */
  requestDryRun(
    fieldKind: HeaderFieldKind,
    selectedValue: string,
    currentSourceRevision: number,
  ): Promise<DryRunResultV1>;

  /**
   * Submits a revisioned command to the owning authority.
   * Requirements: 43.3, 43.12
   */
  submitCommand(command: HeaderChangeCommandV1): Promise<CommandSubmitResult>;

  /**
   * Validates that a change does not conflict with active ownership,
   * policy, compatibility, or turn state.
   * Requirements: 43.5
   */
  validateChange(
    fieldKind: HeaderFieldKind,
    selectedValue: string,
    currentSourceRevision: number,
  ): Promise<ChangeValidationResult>;
}

// ─── Command Submit Result ──────────────────────────────────────

export interface CommandSubmitResult {
  /** Whether the command was accepted for processing. */
  readonly accepted: boolean;
  /** Command ID for tracking. */
  readonly commandId: string;
  /** Rejection reason if not accepted. */
  readonly rejectionReason?: string;
  /** Conflict details if rejected due to conflict. */
  readonly conflict?: ConflictReason;
}

// ─── Change Validation Result ───────────────────────────────────

export interface ChangeValidationResult {
  /** Whether the change is valid. */
  readonly valid: boolean;
  /** Conflict details if invalid. */
  readonly conflict?: ConflictReason;
}

// ─── Dry Run Required Fields ────────────────────────────────────

/**
 * Field kinds that require a dry-run evaluation before commit.
 * Route and profile changes affect model, tools, prompts, permissions,
 * context capacity, cache behavior, cost, and budgets.
 * Requirements: 43.4
 */
const DRY_RUN_REQUIRED_FIELDS: ReadonlySet<HeaderFieldKind> = new Set([
  'model',
  'profile',
]);

// ─── SessionHeaderCommandPort Config ────────────────────────────

export interface SessionHeaderCommandPortConfig {
  /** Timeout for authority commands in milliseconds. */
  readonly commandTimeoutMs: number;
  /** Timeout for dry-run requests in milliseconds. */
  readonly dryRunTimeoutMs: number;
  /** Maximum number of concurrent pending changes. */
  readonly maxPendingChanges: number;
}

const DEFAULT_CONFIG: SessionHeaderCommandPortConfig = {
  commandTimeoutMs: 30_000,
  dryRunTimeoutMs: 15_000,
  maxPendingChanges: 5,
};

// ─── SessionHeaderCommandPort ───────────────────────────────────

export class SessionHeaderCommandPort {
  private readonly config: SessionHeaderCommandPortConfig;
  private readonly pendingChanges: Map<string, PendingHeaderChange> = new Map();
  private commandCounter = 0;

  constructor(
    private readonly authorityPort: HeaderAuthorityPort,
    config: Partial<SessionHeaderCommandPortConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Determines whether a dry-run is required for the given field kind.
   * Requirements: 43.4
   */
  requiresDryRun(fieldKind: HeaderFieldKind): boolean {
    return DRY_RUN_REQUIRED_FIELDS.has(fieldKind);
  }

  /**
   * Requests a dry-run evaluation for a proposed change.
   * Returns the projected impact. If the dry-run fails, is incompatible,
   * or becomes stale, commit is blocked.
   *
   * Requirements: 43.4, 43.15
   */
  async requestDryRun(
    fieldKind: HeaderFieldKind,
    selectedValue: string,
    currentSourceRevision: number,
  ): Promise<DryRunResultV1> {
    return this.authorityPort.requestDryRun(fieldKind, selectedValue, currentSourceRevision);
  }

  /**
   * Submits a header change command to the owning authority.
   *
   * Workflow:
   * 1. Validate the change does not conflict (43.5)
   * 2. If dry-run required, verify dry-run was performed and passed (43.4, 43.15)
   * 3. Submit the revisioned command (43.3, 43.12)
   * 4. Track as pending (43.13)
   * 5. Retain committed value until confirmed (43.14)
   *
   * Requirements: 43.3, 43.5, 43.6, 43.12, 43.13
   */
  async submitChange(
    fieldKind: HeaderFieldKind,
    selectedValue: string,
    currentField: { value: string; sourceAuthority: SourceAuthority },
    actor: string,
    targetAuthority: string,
    dryRunResult?: DryRunResultV1,
  ): Promise<SubmitChangeResult> {
    // Check max pending changes limit
    const activePending = this.getActivePendingChanges();
    if (activePending.length >= this.config.maxPendingChanges) {
      return {
        success: false,
        reason: 'max_pending_reached',
        message: `Maximum pending changes (${this.config.maxPendingChanges}) reached`,
      };
    }

    // If dry-run is required, verify it was provided and passed
    if (this.requiresDryRun(fieldKind)) {
      if (!dryRunResult) {
        return {
          success: false,
          reason: 'dry_run_required',
          message: `Dry-run evaluation required for ${fieldKind} changes`,
        };
      }
      if (dryRunResult.commitBlocked) {
        return {
          success: false,
          reason: 'dry_run_blocked',
          message: dryRunResult.blockReason ?? 'Commit blocked by dry-run evaluation',
        };
      }
      if (dryRunResult.stale) {
        return {
          success: false,
          reason: 'dry_run_stale',
          message: 'Dry-run result is stale; re-evaluate before committing',
        };
      }
    }

    // Validate the change with the authority
    const validation = await this.authorityPort.validateChange(
      fieldKind,
      selectedValue,
      currentField.sourceAuthority.sourceRevision,
    );

    if (!validation.valid) {
      return {
        success: false,
        reason: 'conflict',
        message: validation.conflict?.message ?? 'Change conflicts with current state',
        conflict: validation.conflict,
      };
    }

    // Build the revisioned command
    const commandId = this.generateCommandId();
    const command: HeaderChangeCommandV1 = {
      commandId,
      idempotencyKey: `header-${fieldKind}-${commandId}`,
      fieldKind,
      selectedValue,
      displayedSourceAuthority: currentField.sourceAuthority,
      sourceRevision: currentField.sourceAuthority.sourceRevision,
      actor,
      targetAuthority,
      dryRunResult,
    };

    // Submit to authority
    const result = await this.authorityPort.submitCommand(command);

    if (!result.accepted) {
      return {
        success: false,
        reason: 'rejected',
        message: result.rejectionReason ?? 'Command rejected by authority',
        conflict: result.conflict,
      };
    }

    // Track as pending
    const pendingChange: PendingHeaderChange = {
      command,
      status: 'pending',
      committedValue: currentField.value,
      submittedAt: new Date().toISOString(),
    };
    this.pendingChanges.set(commandId, pendingChange);

    return {
      success: true,
      commandId,
      pendingChange,
    };
  }

  /**
   * Applies a projection confirmation to pending changes.
   * When a compatible Projection_Service revision confirms a header change,
   * the value is displayed as committed.
   *
   * Requirements: 43.14
   */
  applyConfirmation(commandId: string, confirmingRevision: number): boolean {
    const pending = this.pendingChanges.get(commandId);
    if (!pending || pending.status !== 'pending') {
      return false;
    }

    this.pendingChanges.set(commandId, {
      ...pending,
      status: 'confirmed',
      confirmingRevision,
    });
    return true;
  }

  /**
   * Marks a pending change as rejected by authority.
   * Retains the prior projected value.
   *
   * Requirements: 43.5, 43.16
   */
  rejectChange(commandId: string, reason: string): boolean {
    const pending = this.pendingChanges.get(commandId);
    if (!pending || pending.status !== 'pending') {
      return false;
    }

    this.pendingChanges.set(commandId, {
      ...pending,
      status: 'rejected',
      rejectionReason: reason,
    });
    return true;
  }

  /**
   * Marks a pending change as timed out.
   * Retains the prior projected value and labels as unresolved.
   *
   * Requirements: 43.16
   */
  timeoutChange(commandId: string): boolean {
    const pending = this.pendingChanges.get(commandId);
    if (!pending || pending.status !== 'pending') {
      return false;
    }

    this.pendingChanges.set(commandId, {
      ...pending,
      status: 'timeout',
    });
    return true;
  }

  /**
   * Marks a pending change as stale (source revision outdated).
   *
   * Requirements: 43.16
   */
  markStale(commandId: string): boolean {
    const pending = this.pendingChanges.get(commandId);
    if (!pending || pending.status !== 'pending') {
      return false;
    }

    this.pendingChanges.set(commandId, {
      ...pending,
      status: 'stale',
    });
    return true;
  }

  /**
   * Returns all active pending changes (status === 'pending').
   */
  getActivePendingChanges(): readonly PendingHeaderChange[] {
    return [...this.pendingChanges.values()].filter((p) => p.status === 'pending');
  }

  /**
   * Returns all pending changes including resolved ones.
   */
  getAllPendingChanges(): readonly PendingHeaderChange[] {
    return [...this.pendingChanges.values()];
  }

  /**
   * Gets a specific pending change by command ID.
   */
  getPendingChange(commandId: string): PendingHeaderChange | undefined {
    return this.pendingChanges.get(commandId);
  }

  /**
   * Removes confirmed/rejected/timeout changes older than the given revision.
   */
  pruneResolved(olderThanRevision: number): number {
    let pruned = 0;
    for (const [id, change] of this.pendingChanges) {
      if (
        change.status !== 'pending' &&
        change.command.sourceRevision < olderThanRevision
      ) {
        this.pendingChanges.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Checks pending changes for timeout based on configured timeout.
   * Returns command IDs that were timed out.
   */
  checkTimeouts(currentTimeMs: number): string[] {
    const timedOut: string[] = [];
    for (const [id, change] of this.pendingChanges) {
      if (change.status !== 'pending') continue;
      const submittedMs = new Date(change.submittedAt).getTime();
      if (currentTimeMs - submittedMs >= this.config.commandTimeoutMs) {
        this.timeoutChange(id);
        timedOut.push(id);
      }
    }
    return timedOut;
  }

  // ─── Private ────────────────────────────────────────────────────

  private generateCommandId(): string {
    this.commandCounter++;
    return `hdr-cmd-${Date.now()}-${this.commandCounter}`;
  }
}

// ─── Result Types ───────────────────────────────────────────────

export type SubmitChangeResult =
  | SubmitChangeSuccess
  | SubmitChangeFailure;

export interface SubmitChangeSuccess {
  readonly success: true;
  readonly commandId: string;
  readonly pendingChange: PendingHeaderChange;
}

export interface SubmitChangeFailure {
  readonly success: false;
  readonly reason:
    | 'max_pending_reached'
    | 'dry_run_required'
    | 'dry_run_blocked'
    | 'dry_run_stale'
    | 'conflict'
    | 'rejected';
  readonly message: string;
  readonly conflict?: ConflictReason;
}
