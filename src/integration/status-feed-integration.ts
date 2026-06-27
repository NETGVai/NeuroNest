/**
 * StatusFeedIntegration — Wires Agent Status Feed to all subsystems.
 *
 * Sets up CallbackEngine event handlers to relay lifecycle events from:
 *   - Agent Racing Engine (race-start, participant-complete, race-complete)
 *   - Session Forker (fork-created, fork-failed)
 *   - Drift-Aware Orchestrator (drift-recovery-started, drift-recovery-completed,
 *     drift-recovery-failed, drift-recovery-exhausted)
 *
 * All events are translated into AgentStatusEvent instances and emitted through
 * the AgentStatusFeed, which in turn delivers push notifications to the renderer
 * process via IPC for completion, failure, and needs-attention statuses.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.6
 */

import { randomUUID } from 'node:crypto';
import type { CallbackEngine, HookContext } from '../pipeline/callback-engine.js';
import type { IAgentStatusFeed, AgentStatusEvent, AgentStatus } from '../pipeline/agent-status-feed.js';

// ─── Event Type Discriminators ──────────────────────────────────

/** Event types emitted by Agent Racing Engine via CallbackEngine */
type RacingEventType = 'race-start' | 'participant-complete' | 'race-complete';

/** Event types emitted by Drift-Aware Orchestrator via CallbackEngine */
type DriftRecoveryEventType =
  | 'drift-recovery-started'
  | 'drift-recovery-completed'
  | 'drift-recovery-failed'
  | 'drift-recovery-delayed'
  | 'drift-recovery-exhausted';

/** Event types emitted by Session Forker (relayed from integration code) */
type ForkerEventType = 'fork-created' | 'fork-failed';

// ─── Known Racing Events ────────────────────────────────────────

const RACING_EVENTS: ReadonlySet<string> = new Set<RacingEventType>([
  'race-start',
  'participant-complete',
  'race-complete',
]);

// ─── Known Drift Recovery Events ────────────────────────────────

const DRIFT_RECOVERY_EVENTS: ReadonlySet<string> = new Set<string>([
  'drift-recovery-started',
  'drift-recovery-completed',
  'drift-recovery-failed',
  'drift-recovery-delayed',
  'drift-recovery-exhausted',
]);

// ─── Session Forker Event Types ─────────────────────────────────

const FORKER_EVENTS: ReadonlySet<string> = new Set<ForkerEventType>([
  'fork-created',
  'fork-failed',
]);

// ─── StatusFeedIntegration ──────────────────────────────────────

/**
 * Connects subsystem lifecycle events to the Agent Status Feed.
 *
 * Call `setup()` once during application bootstrap to register all event
 * handlers. Call `teardown()` to remove handlers during shutdown or testing.
 */
export class StatusFeedIntegration {
  private readonly callbackEngine: CallbackEngine;
  private readonly statusFeed: IAgentStatusFeed;

  /** Stored handler references for teardown */
  private taskCompleteHandler: ((ctx: HookContext) => void | Promise<void>) | null = null;
  private driftSignalHandler: ((ctx: HookContext) => void | Promise<void>) | null = null;

  constructor(callbackEngine: CallbackEngine, statusFeed: IAgentStatusFeed) {
    this.callbackEngine = callbackEngine;
    this.statusFeed = statusFeed;
  }

  /**
   * Register CallbackEngine event handlers that relay subsystem events
   * to the Agent Status Feed.
   *
   * Racing Engine events arrive on `on-task-complete` with output.type
   * indicating the specific event. Drift recovery events arrive on
   * `on-drift-signal` with input.type indicating the specific event.
   */
  setup(): void {
    // Handler for Racing Engine and Session Forker events
    // These are emitted via CallbackEngine 'on-task-complete' event
    this.taskCompleteHandler = (ctx: HookContext) => {
      this.handleTaskCompleteEvent(ctx);
    };
    this.callbackEngine.register('on-task-complete', this.taskCompleteHandler);

    // Handler for Drift Recovery events
    // These are emitted via CallbackEngine 'on-drift-signal' event
    this.driftSignalHandler = (ctx: HookContext) => {
      this.handleDriftSignalEvent(ctx);
    };
    this.callbackEngine.register('on-drift-signal', this.driftSignalHandler);
  }

  /**
   * Remove all registered handlers. Safe to call multiple times.
   */
  teardown(): void {
    if (this.taskCompleteHandler) {
      this.callbackEngine.unregister('on-task-complete', this.taskCompleteHandler);
      this.taskCompleteHandler = null;
    }
    if (this.driftSignalHandler) {
      this.callbackEngine.unregister('on-drift-signal', this.driftSignalHandler);
      this.driftSignalHandler = null;
    }
  }

  /**
   * Manually emit a fork event to the status feed.
   *
   * Called by integration code after a SessionForker.fork() call completes,
   * since the SessionForker itself does not emit CallbackEngine events.
   * This provides a convenient entry point for wiring fork lifecycle
   * into the status feed.
   */
  emitForkEvent(
    eventType: ForkerEventType,
    sessionId: string,
    agentId: string,
    details?: { forkedSessionId?: string; error?: string; label?: string },
  ): void {
    const status: AgentStatus = eventType === 'fork-created' ? 'progressing' : 'failed';
    const message =
      eventType === 'fork-created'
        ? `Session forked successfully${details?.label ? ` (${details.label})` : ''}: new session ${details?.forkedSessionId ?? 'unknown'}`
        : `Session fork failed: ${details?.error ?? 'unknown error'}`;

    const event: AgentStatusEvent = {
      eventId: randomUUID(),
      sessionId,
      agentId,
      status,
      iteration: 0,
      timestamp: new Date().toISOString(),
      message,
      ...(eventType === 'fork-failed' && details?.error ? { errorSummary: details.error } : {}),
      context: {
        type: eventType,
        ...(details ?? {}),
      },
    };

    // Fire-and-forget: status feed handles its own error containment
    void this.statusFeed.emit(event);
  }

  // ─── Private Event Handlers ─────────────────────────────────────

  /**
   * Handle events arriving on `on-task-complete`.
   * Discriminates between racing events and forker events based on output.type.
   */
  private handleTaskCompleteEvent(ctx: HookContext): void {
    const output = ctx.output as Record<string, unknown> | undefined;
    if (!output || typeof output['type'] !== 'string') {
      return;
    }

    const eventType = output['type'] as string;

    if (RACING_EVENTS.has(eventType)) {
      this.relayRacingEvent(eventType as RacingEventType, ctx, output);
    } else if (FORKER_EVENTS.has(eventType)) {
      this.relayForkerEvent(eventType as ForkerEventType, ctx, output);
    }
  }

  /**
   * Handle events arriving on `on-drift-signal`.
   * Discriminates drift recovery events based on input.type.
   */
  private handleDriftSignalEvent(ctx: HookContext): void {
    const input = ctx.input as Record<string, unknown> | undefined;
    if (!input || typeof input['type'] !== 'string') {
      return;
    }

    const eventType = input['type'] as string;

    if (DRIFT_RECOVERY_EVENTS.has(eventType)) {
      this.relayDriftRecoveryEvent(eventType as DriftRecoveryEventType, ctx, input);
    }
  }

  // ─── Racing Engine Relay ────────────────────────────────────────

  /**
   * Translate Agent Racing Engine lifecycle events to AgentStatusEvent
   * and emit through the status feed.
   *
   * Requirement 5.1: Real-time event stream from all active sessions.
   * Requirement 5.2: Events emitted within 500ms via CallbackEngine.
   */
  private relayRacingEvent(
    eventType: RacingEventType,
    ctx: HookContext,
    output: Record<string, unknown>,
  ): void {
    const raceId = (output['raceId'] as string) ?? ctx.sessionId;

    let status: AgentStatus;
    let message: string;
    let errorSummary: string | undefined;

    switch (eventType) {
      case 'race-start':
        status = 'started';
        message = `Race started with ${output['participantCount'] ?? 'N'} participants`;
        break;

      case 'participant-complete': {
        const participantStatus = output['status'] as string;
        if (participantStatus === 'failed') {
          status = 'progressing';
          message = `Race participant ${output['participantId'] ?? 'unknown'} failed: ${output['error'] ?? 'unknown error'}`;
          errorSummary = output['error'] as string | undefined;
        } else {
          status = 'progressing';
          message = `Race participant ${output['participantId'] ?? 'unknown'} completed (score: ${output['qualityScore'] ?? 0})`;
        }
        break;
      }

      case 'race-complete': {
        const raceStatus = output['status'] as string;
        if (raceStatus === 'all-failed') {
          status = 'failed';
          message = 'Race completed: all participants failed';
          errorSummary = 'All race participants failed';
        } else if (raceStatus === 'timed-out') {
          status = 'failed';
          message = 'Race timed out';
          errorSummary = 'Race exceeded timeout';
        } else {
          status = 'completed';
          message = `Race completed: winner=${output['winnerId'] ?? 'none'}, duration=${output['totalDurationMs'] ?? 0}ms`;
        }
        break;
      }

      default:
        return;
    }

    const event: AgentStatusEvent = {
      eventId: randomUUID(),
      sessionId: raceId,
      agentId: `racing-engine:${raceId}`,
      status,
      iteration: ctx.iteration,
      timestamp: new Date().toISOString(),
      message,
      ...(errorSummary ? { errorSummary } : {}),
      context: { source: 'agent-racing-engine', eventType, ...output },
    };

    void this.statusFeed.emit(event);
  }

  // ─── Session Forker Relay ───────────────────────────────────────

  /**
   * Translate Session Forker events arriving via CallbackEngine
   * to AgentStatusEvent and emit through the status feed.
   *
   * Requirement 5.1: Real-time event stream from all active sessions.
   */
  private relayForkerEvent(
    eventType: ForkerEventType,
    ctx: HookContext,
    output: Record<string, unknown>,
  ): void {
    const status: AgentStatus = eventType === 'fork-created' ? 'progressing' : 'failed';
    const message =
      eventType === 'fork-created'
        ? `Session forked: new session ${output['forkedSessionId'] ?? 'unknown'}`
        : `Session fork failed: ${output['error'] ?? 'unknown error'}`;

    const event: AgentStatusEvent = {
      eventId: randomUUID(),
      sessionId: ctx.sessionId,
      agentId: (output['agentId'] as string) ?? `session-forker:${ctx.sessionId}`,
      status,
      iteration: ctx.iteration,
      timestamp: new Date().toISOString(),
      message,
      ...(eventType === 'fork-failed' && output['error'] ? { errorSummary: output['error'] as string } : {}),
      context: { source: 'session-forker', eventType, ...output },
    };

    void this.statusFeed.emit(event);
  }

  // ─── Drift Recovery Relay ───────────────────────────────────────

  /**
   * Translate Drift-Aware Orchestrator recovery events to AgentStatusEvent
   * and emit through the status feed.
   *
   * Requirement 5.3: Push notifications via IPC on completion/failure.
   * Requirement 5.6: Needs-attention notifications on drift pause.
   */
  private relayDriftRecoveryEvent(
    eventType: DriftRecoveryEventType,
    ctx: HookContext,
    input: Record<string, unknown>,
  ): void {
    let status: AgentStatus;
    let message: string;
    let errorSummary: string | undefined;

    const recoveryAttempt = input['recoveryAttempt'] as Record<string, unknown> | undefined;
    const attemptNumber = recoveryAttempt?.['attemptNumber'] ?? 'N/A';
    const category = (input['category'] as string) ?? (recoveryAttempt?.['category'] as string) ?? 'unknown';

    switch (eventType) {
      case 'drift-recovery-started':
        status = 'progressing';
        message = `Drift recovery started (attempt ${attemptNumber}, category: ${category})`;
        break;

      case 'drift-recovery-completed':
        status = 'progressing';
        message = `Drift recovery completed (attempt ${attemptNumber})`;
        break;

      case 'drift-recovery-failed':
        status = 'failed';
        message = `Drift recovery failed (attempt ${attemptNumber}, category: ${category})`;
        errorSummary = `Recovery attempt ${attemptNumber} failed for ${category} drift`;
        break;

      case 'drift-recovery-delayed':
        status = 'progressing';
        message = `Drift recovery delayed — waiting for concurrency slot (attempt ${attemptNumber})`;
        break;

      case 'drift-recovery-exhausted':
        // Needs-attention: recovery attempts exhausted (Req 5.6)
        status = 'needs-attention';
        message = `Recovery exhausted after ${input['totalAttempts'] ?? 'N'} attempts for session ${ctx.sessionId}. Manual intervention required.`;
        errorSummary = `Max recovery attempts (${input['totalAttempts'] ?? 'N'}) exhausted for ${category} drift`;
        break;

      default:
        return;
    }

    const event: AgentStatusEvent = {
      eventId: randomUUID(),
      sessionId: ctx.sessionId,
      agentId: `drift-orchestrator:${ctx.sessionId}`,
      status,
      iteration: ctx.iteration,
      timestamp: new Date().toISOString(),
      message,
      ...(errorSummary ? { errorSummary } : {}),
      context: { source: 'drift-aware-orchestrator', eventType, ...input },
    };

    void this.statusFeed.emit(event);
  }
}
