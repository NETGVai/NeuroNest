/**
 * Turn Activity Surface
 *
 * Implements one stable turn-status surface per turn identity, rendering all
 * projected lifecycle states, elapsed duration from durable start, partial-output
 * retention, cancellation/reconnection details, accessible stop/remediation,
 * reduced-motion indicators, localized status announcements, and exact terminal
 * outcomes.
 *
 * The surface is keyed by turnId and derived exclusively from projected
 * Turn_Activity_State transitions. It never infers cancellation completion
 * from a button click or disconnected stream.
 *
 * Requirements: 36.1–36.17
 */

import { z } from 'zod';
import {
  TurnActivityStateSchema,
  TERMINAL_STATES,
  type TurnActivityState,
  type TurnTransitionRecord,
  type OwnedWorkEntry,
} from '../../runtime/turn-controller-schemas';
import { IdentifierSchema, TimestampSchema } from '../../contracts/primitives';

// ─── Configuration ──────────────────────────────────────────────

/**
 * Elapsed-time threshold: must be positive and finite (Requirement 36.5).
 * Once the active turn duration reaches this threshold, elapsed time is shown.
 */
export const ElapsedTimeThresholdSchema = z.number().positive().finite();

/**
 * Configuration for the turn-activity surface.
 */
export const TurnActivitySurfaceConfigSchema = z.object({
  /** Threshold in ms before elapsed duration is displayed (Requirement 36.5). */
  elapsedTimeThresholdMs: ElapsedTimeThresholdSchema,

  /** Configured cancellation convergence deadline in ms (Requirement 36.8). */
  cancellationDeadlineMs: z.number().positive().finite(),

  /** Accessibility announcement coalesce interval in ms (>= 1000, Requirement 36.11). */
  announcementCoalesceIntervalMs: z.number().min(1000).finite(),

  /** Whether reduced motion is selected (Requirement 36.9). */
  reducedMotion: z.boolean(),
});

export type TurnActivitySurfaceConfig = z.infer<typeof TurnActivitySurfaceConfigSchema>;

export const DEFAULT_TURN_ACTIVITY_SURFACE_CONFIG: TurnActivitySurfaceConfig = {
  elapsedTimeThresholdMs: 5_000,
  cancellationDeadlineMs: 30_000,
  announcementCoalesceIntervalMs: 1_000,
  reducedMotion: false,
};

// ─── Remediation Action ─────────────────────────────────────────

/**
 * Authority-provided remediation action for stalled cancellation
 * or other nonterminal stuck states (Requirement 36.8, 36.17).
 */
export const RemediationActionSchema = z.object({
  actionId: IdentifierSchema,
  label: z.string().min(1),
  accessibilityLabel: z.string().min(1),
  kind: z.enum(['force_cancel', 'retry', 'abort', 'escalate']),
});

export type RemediationAction = z.infer<typeof RemediationActionSchema>;

// ─── Stop Control ───────────────────────────────────────────────

/**
 * Authority-routed stop control exposed while streaming (Requirement 36.14).
 */
export const StopControlSchema = z.object({
  available: z.boolean(),
  accessibilityLabel: z.string().min(1),
  /** Reason why the control is unavailable, if applicable. */
  unavailableReason: z.string().optional(),
});

export type StopControl = z.infer<typeof StopControlSchema>;

// ─── Cancellation Detail ────────────────────────────────────────

/**
 * Cancellation presentation details (Requirements 36.7, 36.8, 36.17).
 *
 * Shows nonterminal owned work and remediation when deadline is exceeded.
 */
export const CancellationDetailSchema = z.object({
  /** When cancellation was requested. */
  requestedAt: TimestampSchema,

  /** Configured deadline for convergence. */
  deadlineMs: z.number().positive().finite(),

  /** Whether the deadline has been exceeded. */
  deadlineExceeded: z.boolean(),

  /** Nonterminal owned work items still active. */
  nonterminalWork: z.array(z.object({
    workId: IdentifierSchema,
    kind: z.string(),
  })),

  /** Authority-provided remediation action if deadline exceeded. */
  remediationAction: RemediationActionSchema.optional(),
});

export type CancellationDetail = z.infer<typeof CancellationDetailSchema>;

// ─── Reconnection Detail ────────────────────────────────────────

/**
 * Reconnection details (Requirement 36.12).
 */
export const ReconnectionDetailSchema = z.object({
  /** Number of reconnection attempts so far. */
  attemptCount: z.number().int().nonnegative(),

  /** Whether a cancellation control is available during reconnection. */
  cancellationAvailable: z.boolean(),

  /** Reason cancellation is unavailable, if applicable. */
  cancellationUnavailableReason: z.string().optional(),
});

export type ReconnectionDetail = z.infer<typeof ReconnectionDetailSchema>;

// ─── Status Announcement ────────────────────────────────────────

/**
 * Localized accessibility status announcement (Requirement 36.10).
 *
 * Uses 'polite' assertiveness by default to avoid interrupting the user.
 * Content announcements are coalesced to semantic blocks or the configured
 * interval (Requirement 36.11).
 */
export const StatusAnnouncementSchema = z.object({
  /** Localized status label. */
  label: z.string().min(1),

  /** ARIA live region assertiveness level. */
  assertiveness: z.enum(['polite', 'assertive']).default('polite'),

  /** Timestamp when this announcement was generated. */
  generatedAt: TimestampSchema,
});

export type StatusAnnouncement = z.infer<typeof StatusAnnouncementSchema>;

// ─── Streaming Indicator ────────────────────────────────────────

/**
 * Streaming presentation state (Requirements 36.9, 36.14).
 *
 * When reducedMotion is true, cursor blinking and progress animation
 * are replaced with static state indicators.
 */
export const StreamingIndicatorSchema = z.object({
  /** Whether streaming is currently active. */
  active: z.boolean(),

  /** Whether to use reduced motion indicators. */
  reducedMotion: z.boolean(),

  /** The stop control for this streaming turn. */
  stopControl: StopControlSchema,
});

export type StreamingIndicator = z.infer<typeof StreamingIndicatorSchema>;

// ─── Turn Activity Surface ──────────────────────────────────────

/**
 * The single projected lifecycle state presented for a turn (Requirement 36.15).
 *
 * Exactly one instance exists per turn identity while the turn has projected
 * lifecycle state. Keyed by turnId for stable identity through all lifecycle
 * transitions.
 */
export const TurnActivitySurfaceSchema = z.object({
  /** Stable turn identity. */
  turnId: IdentifierSchema,

  /** Current projected lifecycle state (Requirement 36.1–36.3). */
  activityState: TurnActivityStateSchema,

  /** Whether this is a terminal (irreversible) state (Requirement 36.13). */
  isTerminal: z.boolean(),

  /**
   * Elapsed duration in milliseconds from durable turn start (Requirement 36.4).
   * Shown only when exceeding the configured threshold (Requirement 36.5).
   * Precision: 1 second.
   */
  elapsedMs: z.number().nonnegative().optional(),

  /** Whether elapsed time should be displayed (threshold reached). */
  showElapsed: z.boolean(),

  /**
   * Latest durably projected partial output retained through retry,
   * cancellation, interruption, and reconnection (Requirement 36.6, 36.16).
   */
  partialOutput: z.string().optional(),

  /** Cancellation details, present while in 'cancelling' state (Requirement 36.7). */
  cancellationDetail: CancellationDetailSchema.optional(),

  /** Reconnection details, present while in 'reconnecting' state (Requirement 36.12). */
  reconnectionDetail: ReconnectionDetailSchema.optional(),

  /** Streaming indicator and stop control (Requirements 36.9, 36.14). */
  streamingIndicator: StreamingIndicatorSchema.optional(),

  /**
   * Authority-derived terminal outcome label (Requirement 36.13).
   * Present only when isTerminal is true. Never reports success for
   * interrupted or failed turns.
   */
  terminalOutcome: z.string().optional(),

  /** Latest accessibility status announcement (Requirement 36.10). */
  statusAnnouncement: StatusAnnouncementSchema.optional(),
});

export type TurnActivitySurface = z.infer<typeof TurnActivitySurfaceSchema>;

// ─── Status Label Map ───────────────────────────────────────────

/**
 * Localized status labels per activity state.
 * In production this would come from an i18n system; here we provide
 * canonical English labels as a default map.
 */
export type StatusLabelProvider = (state: TurnActivityState) => string;

export const DEFAULT_STATUS_LABELS: Readonly<Record<TurnActivityState, string>> = {
  queued: 'Queued',
  assembling: 'Preparing request',
  awaiting_first_token: 'Waiting for response',
  reasoning: 'Thinking',
  streaming: 'Writing response',
  tool_running: 'Running tool',
  retrying: 'Retrying',
  waiting_for_user: 'Waiting for input',
  cancelling: 'Cancelling',
  reconnecting: 'Reconnecting',
  completed: 'Completed',
  interrupted: 'Interrupted',
  failed: 'Failed',
};

export const DEFAULT_TERMINAL_OUTCOMES: Readonly<Record<string, string>> = {
  completed: 'Turn completed successfully',
  interrupted: 'Turn was interrupted',
  failed: 'Turn failed',
};

// ─── Reducer Input ──────────────────────────────────────────────

/**
 * Input needed to derive a TurnActivitySurface from projection data.
 */
export interface TurnActivityProjection {
  turnId: string;
  currentState: TurnActivityState;
  durableStartTime: string;
  currentTime: string;
  partialOutput?: string;
  cancellationRequestedAt?: string;
  nonterminalOwnedWork?: Array<{ workId: string; kind: string }>;
  reconnectionAttemptCount?: number;
  cancellationControlAvailable?: boolean;
  cancellationUnavailableReason?: string;
  stopControlAvailable?: boolean;
  stopUnavailableReason?: string;
  remediationAction?: RemediationAction;
}

// ─── Reducer ────────────────────────────────────────────────────

/**
 * Derives exactly one TurnActivitySurface from a turn's projected state.
 *
 * This is a pure function: given the same projection and config, it produces
 * the same surface deterministically. It does not hold mutable state.
 *
 * Requirements: 36.1–36.17
 */
export function deriveTurnActivitySurface(
  projection: TurnActivityProjection,
  config: TurnActivitySurfaceConfig = DEFAULT_TURN_ACTIVITY_SURFACE_CONFIG,
  statusLabels: StatusLabelProvider = (s) => DEFAULT_STATUS_LABELS[s],
): TurnActivitySurface {
  const isTerminal = TERMINAL_STATES.has(projection.currentState);
  const now = new Date(projection.currentTime).getTime();
  const start = new Date(projection.durableStartTime).getTime();
  const rawElapsedMs = Math.max(0, now - start);

  // Round to 1-second precision (Requirement 36.4)
  const elapsedMs = Math.floor(rawElapsedMs / 1000) * 1000;
  const showElapsed = elapsedMs >= config.elapsedTimeThresholdMs;

  // Cancellation detail (Requirements 36.7, 36.8, 36.17)
  let cancellationDetail: CancellationDetail | undefined;
  if (projection.currentState === 'cancelling' && projection.cancellationRequestedAt) {
    const cancelStart = new Date(projection.cancellationRequestedAt).getTime();
    const cancelElapsed = Math.max(0, now - cancelStart);
    const deadlineExceeded = cancelElapsed >= config.cancellationDeadlineMs;

    cancellationDetail = {
      requestedAt: projection.cancellationRequestedAt,
      deadlineMs: config.cancellationDeadlineMs,
      deadlineExceeded,
      nonterminalWork: projection.nonterminalOwnedWork ?? [],
      remediationAction: deadlineExceeded ? projection.remediationAction : undefined,
    };
  }

  // Reconnection detail (Requirement 36.12)
  let reconnectionDetail: ReconnectionDetail | undefined;
  if (projection.currentState === 'reconnecting') {
    reconnectionDetail = {
      attemptCount: projection.reconnectionAttemptCount ?? 0,
      cancellationAvailable: projection.cancellationControlAvailable ?? true,
      cancellationUnavailableReason: projection.cancellationUnavailableReason,
    };
  }

  // Streaming indicator (Requirements 36.9, 36.14)
  let streamingIndicator: StreamingIndicator | undefined;
  if (projection.currentState === 'streaming') {
    streamingIndicator = {
      active: true,
      reducedMotion: config.reducedMotion,
      stopControl: {
        available: projection.stopControlAvailable ?? true,
        accessibilityLabel: 'Stop generation',
        unavailableReason: projection.stopUnavailableReason,
      },
    };
  }

  // Terminal outcome (Requirement 36.13)
  let terminalOutcome: string | undefined;
  if (isTerminal) {
    terminalOutcome = DEFAULT_TERMINAL_OUTCOMES[projection.currentState];
    streamingIndicator = undefined; // Remove streaming indicators for terminal states
  }

  // Status announcement (Requirement 36.10)
  const statusAnnouncement: StatusAnnouncement = {
    label: statusLabels(projection.currentState),
    assertiveness: 'polite',
    generatedAt: projection.currentTime,
  };

  return {
    turnId: projection.turnId,
    activityState: projection.currentState,
    isTerminal,
    elapsedMs: showElapsed ? elapsedMs : undefined,
    showElapsed,
    partialOutput: projection.partialOutput,
    cancellationDetail,
    reconnectionDetail,
    streamingIndicator,
    terminalOutcome,
    statusAnnouncement,
  };
}

// ─── Announcement Coalescer ─────────────────────────────────────

/**
 * Coalesces content announcements to semantic blocks or a configured
 * interval of at least 1 second (Requirement 36.11).
 *
 * Returns true if enough time has elapsed since the last announcement
 * and a new one should be emitted.
 */
export function shouldEmitAnnouncement(
  lastAnnouncementTime: string | undefined,
  currentTime: string,
  coalesceIntervalMs: number,
): boolean {
  if (!lastAnnouncementTime) return true;
  const last = new Date(lastAnnouncementTime).getTime();
  const now = new Date(currentTime).getTime();
  return (now - last) >= Math.max(1000, coalesceIntervalMs);
}

// ─── Reduced Motion Helper ──────────────────────────────────────

/**
 * Returns presentation attributes adjusted for reduced motion preference
 * (Requirement 36.9).
 *
 * When reduced motion is active:
 * - cursor blinking → static caret indicator
 * - smooth scrolling → instant scroll
 * - progress animation → static progress label
 */
export interface MotionAdjustedPresentation {
  cursorStyle: 'blinking' | 'static';
  scrollBehavior: 'smooth' | 'instant';
  progressStyle: 'animated' | 'static_label';
}

export function getMotionAdjustedPresentation(
  reducedMotion: boolean,
): MotionAdjustedPresentation {
  if (reducedMotion) {
    return {
      cursorStyle: 'static',
      scrollBehavior: 'instant',
      progressStyle: 'static_label',
    };
  }
  return {
    cursorStyle: 'blinking',
    scrollBehavior: 'smooth',
    progressStyle: 'animated',
  };
}

// ─── Partial Output Retention ───────────────────────────────────

/**
 * Merges partial output through lifecycle transitions, retaining the latest
 * durably projected content through retry, cancellation, interruption, and
 * reconnection (Requirement 36.6, 36.16).
 *
 * Only clears partial output on explicit new-turn start (not on retries or
 * reconnection).
 */
export function retainPartialOutput(
  previousPartialOutput: string | undefined,
  newPartialOutput: string | undefined,
  newState: TurnActivityState,
): string | undefined {
  // New partial output always takes precedence when provided
  if (newPartialOutput !== undefined) {
    return newPartialOutput;
  }

  // For retry, cancellation, interruption, and reconnection, retain previous
  const retentionStates: ReadonlySet<TurnActivityState> = new Set([
    'retrying',
    'cancelling',
    'interrupted',
    'reconnecting',
    'completed',
    'failed',
  ]);

  if (retentionStates.has(newState)) {
    return previousPartialOutput;
  }

  // For active states that produce output, preserve until overwritten
  const outputStates: ReadonlySet<TurnActivityState> = new Set([
    'streaming',
    'reasoning',
    'tool_running',
  ]);

  if (outputStates.has(newState)) {
    return previousPartialOutput;
  }

  // Early non-output states (queued, assembling, awaiting_first_token, waiting_for_user)
  // retain output from previous turns that reconnected
  return previousPartialOutput;
}
