/**
 * TransitionAnnouncer — Announces connection, approval, tool, validation,
 * and dispatch transitions with appropriate live-region priority.
 *
 * Each transition type maps to either 'assertive' (urgent, interrupting)
 * or 'polite' (non-urgent, queued) announcements based on user impact.
 *
 * Priority mapping:
 * - assertive: approval requests, tool failures, validation failures, disconnections
 * - polite: connection established, tool progress, dispatch progress, validation pass
 *
 * Requirements: 23.3
 */

import type { LiveRegionManager } from './live-region-manager';

/** Types of transitions that get announced */
export type TransitionKind =
  | 'connection_established'
  | 'connection_lost'
  | 'connection_reconnecting'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'tool_started'
  | 'tool_succeeded'
  | 'tool_failed'
  | 'tool_cancelled'
  | 'validation_passed'
  | 'validation_failed'
  | 'validation_started'
  | 'dispatch_queued'
  | 'dispatch_running'
  | 'dispatch_completed'
  | 'dispatch_failed'
  | 'dispatch_cancelled';

/** Priority classification for each transition kind */
const TRANSITION_PRIORITY: Record<TransitionKind, 'assertive' | 'polite'> = {
  connection_established: 'polite',
  connection_lost: 'assertive',
  connection_reconnecting: 'polite',
  approval_requested: 'assertive',
  approval_granted: 'polite',
  approval_rejected: 'polite',
  tool_started: 'polite',
  tool_succeeded: 'polite',
  tool_failed: 'assertive',
  tool_cancelled: 'polite',
  validation_passed: 'polite',
  validation_failed: 'assertive',
  validation_started: 'polite',
  dispatch_queued: 'polite',
  dispatch_running: 'polite',
  dispatch_completed: 'polite',
  dispatch_failed: 'assertive',
  dispatch_cancelled: 'polite',
};

/** Human-readable default messages for each transition */
const DEFAULT_MESSAGES: Record<TransitionKind, string> = {
  connection_established: 'Connection established.',
  connection_lost: 'Connection lost. Working offline.',
  connection_reconnecting: 'Attempting to reconnect.',
  approval_requested: 'Approval required.',
  approval_granted: 'Approval granted.',
  approval_rejected: 'Approval rejected.',
  tool_started: 'Tool execution started.',
  tool_succeeded: 'Tool execution succeeded.',
  tool_failed: 'Tool execution failed.',
  tool_cancelled: 'Tool execution cancelled.',
  validation_passed: 'Validation passed.',
  validation_failed: 'Validation failed.',
  validation_started: 'Validation started.',
  dispatch_queued: 'Task queued for dispatch.',
  dispatch_running: 'Task dispatch running.',
  dispatch_completed: 'Task dispatch completed.',
  dispatch_failed: 'Task dispatch failed.',
  dispatch_cancelled: 'Task dispatch cancelled.',
};

/**
 * TransitionAnnouncer routes state transition announcements to the
 * appropriate live regions based on urgency classification.
 */
export class TransitionAnnouncer {
  private readonly liveRegionManager: LiveRegionManager;
  private readonly politeRegionId: string;
  private readonly assertiveRegionId: string;
  private readonly history: Array<{ kind: TransitionKind; message: string; timestamp: number }> = [];

  constructor(
    liveRegionManager: LiveRegionManager,
    politeRegionId: string,
    assertiveRegionId: string,
  ) {
    this.liveRegionManager = liveRegionManager;
    this.politeRegionId = politeRegionId;
    this.assertiveRegionId = assertiveRegionId;
  }

  /**
   * Announce a transition with the appropriate priority.
   * @param kind - The transition type
   * @param detail - Optional detail appended to the default message
   */
  announceTransition(kind: TransitionKind, detail?: string): void {
    const priority = TRANSITION_PRIORITY[kind];
    const baseMessage = DEFAULT_MESSAGES[kind];
    const message = detail ? `${baseMessage} ${detail}` : baseMessage;

    const regionId = priority === 'assertive'
      ? this.assertiveRegionId
      : this.politeRegionId;

    this.liveRegionManager.announce(regionId, message);
    this.history.push({ kind, message, timestamp: Date.now() });
  }

  /**
   * Get the priority classification for a transition kind.
   */
  getPriorityForKind(kind: TransitionKind): 'assertive' | 'polite' {
    return TRANSITION_PRIORITY[kind];
  }

  /**
   * Get announcement history (for testing/debugging).
   */
  getHistory(): ReadonlyArray<{ kind: TransitionKind; message: string; timestamp: number }> {
    return this.history;
  }

  /**
   * Clear announcement history.
   */
  clearHistory(): void {
    this.history.length = 0;
  }
}
