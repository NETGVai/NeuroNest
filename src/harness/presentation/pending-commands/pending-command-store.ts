/**
 * Pending Command Store
 *
 * Manages the lifecycle of pending UI commands, ensuring:
 * - Prior committed projections are retained while commands are pending
 * - Commands commit only from causally compatible projection revisions
 * - User input is preserved on rejection/stale/timeout outcomes
 * - Typed outcomes are displayed for all non-committed terminal states
 *
 * Chat_Interface never applies an optimistic durable mutation to committed
 * view state. It may show a separately styled pending command linked to
 * the prior committed revision. Confirmation occurs only when
 * Projection_Service emits confirmedCommandIds or a projected entity
 * revision causally linked to that command.
 *
 * Requirements: 35.12–35.13, 35.19–35.21, 38.10–38.11, 39.15–39.17,
 *              43.13–43.16, 44.16, 45.6, 45.16
 */

import type {
  PendingCommandEntry,
  PendingCommandStatus,
  PendingCommandOutcome,
  PendingCommandSubmission,
  PendingCommandView,
  PendingCommandConfig,
  ProjectionConfirmation,
} from './types';
import { DEFAULT_PENDING_COMMAND_CONFIG } from './types';

// ─── Store ──────────────────────────────────────────────────────

/**
 * The PendingCommandStore tracks all in-flight commands and manages their
 * lifecycle through projection confirmations, rejections, staleness, and
 * timeouts.
 *
 * The store is ephemeral UI state — it is not persisted. It consumes
 * durable projection events and command outcomes to transition commands
 * between states.
 *
 * Key invariants:
 * - A pending command never replaces committed projection state
 * - Only a causally compatible projection revision may confirm a command
 * - User input is preserved through rejection/stale/timeout for recovery
 * - Resolved commands are retained up to maxResolvedRetention for display
 */
export class PendingCommandStore {
  private readonly config: PendingCommandConfig;
  private committedProjectionRevision: number;
  private readonly commands: Map<string, PendingCommandEntry>;

  constructor(
    initialRevision: number = 0,
    config: PendingCommandConfig = DEFAULT_PENDING_COMMAND_CONFIG,
  ) {
    this.config = config;
    this.committedProjectionRevision = initialRevision;
    this.commands = new Map();
  }

  // ─── Queries ────────────────────────────────────────────────────

  /**
   * Get the last committed projection revision.
   * The UI should display state from this revision as the authoritative view.
   */
  getCommittedRevision(): number {
    return this.committedProjectionRevision;
  }

  /**
   * Get all commands currently in pending status.
   */
  getPendingCommands(): ReadonlyArray<PendingCommandEntry> {
    return Array.from(this.commands.values()).filter(
      (c) => c.status === 'pending',
    );
  }

  /**
   * Get all commands regardless of status.
   */
  getAllCommands(): ReadonlyArray<PendingCommandEntry> {
    return Array.from(this.commands.values());
  }

  /**
   * Check whether a specific command is pending.
   */
  isPending(commandId: string): boolean {
    const entry = this.commands.get(commandId);
    return entry?.status === 'pending';
  }

  /**
   * Get a specific command entry by ID.
   */
  getCommand(commandId: string): PendingCommandEntry | undefined {
    return this.commands.get(commandId);
  }

  /**
   * Determine whether any commands are pending.
   * The UI should retain prior committed projection while this is true.
   *
   * Requirement 35.19: While a durable mutation awaits confirmation,
   * present it as pending and retain the prior committed projection.
   */
  hasPendingCommands(): boolean {
    for (const cmd of this.commands.values()) {
      if (cmd.status === 'pending') return true;
    }
    return false;
  }

  /**
   * Produce presentation views for all tracked commands at the given time.
   * Includes elapsed calculation and timeout warning determination.
   */
  getViews(currentTime: string): ReadonlyArray<PendingCommandView> {
    const now = new Date(currentTime).getTime();
    const views: PendingCommandView[] = [];

    for (const entry of this.commands.values()) {
      const issuedAt = new Date(entry.issuedAt).getTime();
      const elapsedMs = Math.max(0, now - issuedAt);
      const warningThreshold = entry.timeoutMs * this.config.timeoutWarningThreshold;

      views.push({
        commandId: entry.commandId,
        commandType: entry.commandType,
        authorityTarget: entry.authorityTarget,
        status: entry.status,
        userInput: entry.userInput,
        outcome: entry.outcome,
        elapsedMs,
        timeoutWarning: entry.status === 'pending' && elapsedMs >= warningThreshold,
      });
    }

    return views;
  }

  // ─── Commands ───────────────────────────────────────────────────

  /**
   * Submit a new pending command. The command is tracked until confirmed,
   * rejected, stale, timed out, or manually dismissed.
   *
   * Requirement 35.12: Route durable mutations to owning authority and
   * treat Projection_Service revision as committed state.
   * Requirement 35.19: Present as pending and retain prior committed projection.
   */
  submit(submission: PendingCommandSubmission): PendingCommandEntry {
    const entry: PendingCommandEntry = {
      commandId: submission.commandId,
      commandType: submission.commandType,
      authorityTarget: submission.authorityTarget,
      sourceProjectionRevision: submission.sourceProjectionRevision,
      expectedRevision: submission.expectedRevision,
      userInput: submission.userInput,
      timeoutMs: submission.timeoutMs,
      issuedAt: submission.issuedAt,
      status: 'pending',
      outcome: undefined,
      confirmingRevision: undefined,
    };

    this.commands.set(entry.commandId, entry);
    this.pruneResolved();
    return entry;
  }

  /**
   * Apply a projection confirmation from Projection_Service.
   *
   * A projection confirms a command when:
   * 1. The projection explicitly lists the commandId in confirmedCommandIds, OR
   * 2. The projection's entity revision is causally compatible with the
   *    command's expected revision (entityRevision > expectedRevision)
   *
   * Only commands whose sourceProjectionRevision < projectionRevision can be
   * confirmed (causal compatibility).
   *
   * Requirement 35.20: Present the mutation as committed when compatible
   * Projection_Service revision confirms it.
   * Requirement 43.14: Update from resulting Projection_Service revision.
   * Requirement 45.16: Present mutation as committed from confirming revision.
   */
  applyConfirmation(confirmation: ProjectionConfirmation): string[] {
    const confirmedIds: string[] = [];

    for (const [commandId, entry] of this.commands) {
      if (entry.status !== 'pending') continue;

      // Causal compatibility: the confirmation must come from a revision
      // newer than the one the command was issued against
      if (confirmation.projectionRevision <= entry.sourceProjectionRevision) {
        continue;
      }

      let confirmed = false;

      // Explicit confirmation by commandId
      if (confirmation.confirmedCommandIds.includes(commandId)) {
        confirmed = true;
      }

      // Causal confirmation by entity revision
      if (
        !confirmed &&
        confirmation.entityRevision !== undefined &&
        entry.expectedRevision !== undefined &&
        confirmation.entityRevision > entry.expectedRevision
      ) {
        confirmed = true;
      }

      if (confirmed) {
        entry.status = 'committed';
        entry.confirmingRevision = confirmation.projectionRevision;
        confirmedIds.push(commandId);
      }
    }

    // Advance committed revision if confirmation is newer
    if (confirmation.projectionRevision > this.committedProjectionRevision) {
      this.committedProjectionRevision = confirmation.projectionRevision;
    }

    return confirmedIds;
  }

  /**
   * Reject a pending command with a typed reason.
   *
   * Requirement 35.21: Retain prior committed projection and user input
   * and display the typed outcome.
   * Requirement 39.17: Restore latest compatible projection, preserve
   * unaffected identities, and retain user edit input.
   */
  reject(commandId: string, reason: string, resolvedAt: string): boolean {
    const entry = this.commands.get(commandId);
    if (!entry || entry.status !== 'pending') return false;

    entry.status = 'rejected';
    entry.outcome = {
      status: 'rejected',
      reason,
      authorityTarget: entry.authorityTarget,
      resolvedAt,
    };
    return true;
  }

  /**
   * Mark a pending command as stale (references an outdated revision).
   *
   * Requirement 35.21: Retain prior committed projection and user input.
   * Requirement 43.16: Retain prior projected value and label as rejected/unresolved.
   */
  markStale(
    commandId: string,
    currentRevision: number,
    resolvedAt: string,
  ): boolean {
    const entry = this.commands.get(commandId);
    if (!entry || entry.status !== 'pending') return false;

    entry.status = 'stale';
    entry.outcome = {
      status: 'stale',
      currentRevision,
      expectedRevision: entry.expectedRevision ?? entry.sourceProjectionRevision,
      resolvedAt,
    };
    return true;
  }

  /**
   * Mark a pending command as timed out.
   *
   * Requirement 35.21: Retain prior committed projection and user input
   * and display the typed outcome.
   * Requirement 45.6: Label last verified revision and avoid presenting
   * stale mutations as committed.
   */
  markTimeout(commandId: string, resolvedAt: string): boolean {
    const entry = this.commands.get(commandId);
    if (!entry || entry.status !== 'pending') return false;

    entry.status = 'timeout';
    entry.outcome = {
      status: 'timeout',
      timeoutMs: entry.timeoutMs,
      resolvedAt,
    };
    return true;
  }

  /**
   * Mark a pending command as unavailable (authority/process unavailable).
   *
   * Requirement 38.10 (mapped to 38.9): Disable approval/answer submission,
   * retain pending decision, display authority-derived unavailable reason.
   */
  markUnavailable(commandId: string, reason: string, resolvedAt: string): boolean {
    const entry = this.commands.get(commandId);
    if (!entry || entry.status !== 'pending') return false;

    entry.status = 'unavailable';
    entry.outcome = {
      status: 'unavailable',
      reason,
      resolvedAt,
    };
    return true;
  }

  /**
   * Check pending commands for timeout based on the current time.
   * Automatically transitions any expired commands to timeout status.
   *
   * Returns the IDs of commands that timed out.
   */
  checkTimeouts(currentTime: string): string[] {
    const now = new Date(currentTime).getTime();
    const timedOut: string[] = [];

    for (const [commandId, entry] of this.commands) {
      if (entry.status !== 'pending') continue;

      const issuedAt = new Date(entry.issuedAt).getTime();
      const elapsed = now - issuedAt;

      if (elapsed >= entry.timeoutMs) {
        this.markTimeout(commandId, currentTime);
        timedOut.push(commandId);
      }
    }

    return timedOut;
  }

  /**
   * Dismiss a resolved (non-pending) command from the store.
   * Returns true if the command was found and removed.
   */
  dismiss(commandId: string): boolean {
    const entry = this.commands.get(commandId);
    if (!entry || entry.status === 'pending') return false;
    return this.commands.delete(commandId);
  }

  /**
   * Clear all committed commands from the store (cleanup after UI acknowledges).
   */
  clearCommitted(): void {
    for (const [commandId, entry] of this.commands) {
      if (entry.status === 'committed') {
        this.commands.delete(commandId);
      }
    }
  }

  /**
   * Advance the committed projection revision without confirming any commands.
   * Used when a projection update arrives that doesn't relate to any pending
   * commands (normal projection advancement).
   *
   * Requirement 35.13: Retain no independently mutable copy of state as
   * a competing source of truth.
   */
  advanceRevision(projectionRevision: number): void {
    if (projectionRevision > this.committedProjectionRevision) {
      this.committedProjectionRevision = projectionRevision;
    }
  }

  // ─── Internal ───────────────────────────────────────────────────

  /**
   * Prune the oldest resolved commands when we exceed the retention limit.
   * Only removes non-pending commands. Preserves the most recent resolved
   * commands for display.
   */
  private pruneResolved(): void {
    const resolved: Array<[string, PendingCommandEntry]> = [];
    for (const [id, entry] of this.commands) {
      if (entry.status !== 'pending') {
        resolved.push([id, entry]);
      }
    }

    if (resolved.length <= this.config.maxResolvedRetention) return;

    // Sort by issuedAt ascending (oldest first)
    resolved.sort((a, b) =>
      new Date(a[1].issuedAt).getTime() - new Date(b[1].issuedAt).getTime(),
    );

    const excess = resolved.length - this.config.maxResolvedRetention;
    for (let i = 0; i < excess; i++) {
      this.commands.delete(resolved[i][0]);
    }
  }
}

// ─── Pure Helpers ───────────────────────────────────────────────

/**
 * Determine if a projection revision is causally compatible with a command.
 * A revision is compatible if it is strictly greater than the command's
 * source projection revision.
 */
export function isCausallyCompatible(
  projectionRevision: number,
  sourceProjectionRevision: number,
): boolean {
  return projectionRevision > sourceProjectionRevision;
}

/**
 * Determine if a command should display a timeout warning.
 * Uses the configured warning threshold fraction of the total timeout.
 */
export function shouldShowTimeoutWarning(
  elapsedMs: number,
  timeoutMs: number,
  warningThreshold: number,
): boolean {
  return elapsedMs >= timeoutMs * warningThreshold;
}

/**
 * Given a list of pending command views and the committed projection revision,
 * determine what the Chat_Interface should display.
 *
 * Returns:
 * - displayCommittedRevision: the revision to show as the authoritative state
 * - pendingViews: commands to show as pending
 * - resolvedViews: commands with terminal outcomes to show
 * - shouldRetainPriorState: whether the UI should keep showing prior committed state
 *
 * Requirement 35.19: While mutations await confirmation, present as pending
 * and retain prior committed projection.
 * Requirement 35.21: Rejected/timeout retains prior projection and user input.
 */
export function derivePendingCommandPresentation(
  views: ReadonlyArray<PendingCommandView>,
  committedRevision: number,
): PendingCommandPresentation {
  const pendingViews = views.filter((v) => v.status === 'pending');
  const resolvedViews = views.filter((v) =>
    v.status === 'rejected' ||
    v.status === 'stale' ||
    v.status === 'timeout' ||
    v.status === 'unavailable',
  );

  return {
    displayCommittedRevision: committedRevision,
    pendingViews,
    resolvedViews,
    shouldRetainPriorState: pendingViews.length > 0 || resolvedViews.length > 0,
    hasPending: pendingViews.length > 0,
    hasUnacknowledgedOutcomes: resolvedViews.length > 0,
  };
}

/**
 * Presentation output from the pending command store.
 */
export interface PendingCommandPresentation {
  /** The revision to display as the authoritative committed state. */
  displayCommittedRevision: number;
  /** Commands currently pending confirmation. */
  pendingViews: ReadonlyArray<PendingCommandView>;
  /** Commands with non-committed outcomes to display. */
  resolvedViews: ReadonlyArray<PendingCommandView>;
  /** Whether the UI should retain the prior committed state view. */
  shouldRetainPriorState: boolean;
  /** Whether any commands are still pending. */
  hasPending: boolean;
  /** Whether there are unacknowledged non-committed outcomes. */
  hasUnacknowledgedOutcomes: boolean;
}
