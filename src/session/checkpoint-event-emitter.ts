/**
 * Checkpoint event emitter for the Pipeline_Event_Log.
 *
 * Task 15 of the 12-factor-agent-improvements spec: emit
 * `checkpoint.created` and `checkpoint.restored` Pipeline_Events from the
 * `WorkspaceCheckpointManager` snapshot/restore methods. Per design.md
 * "Event kinds":
 *
 *   - checkpoint.created  payload: { checkpointId, ref, turnId? }
 *   - checkpoint.restored payload: { checkpointId, turnId }
 *
 * Validates: Requirements 2.8
 *
 * Design constraints honored here:
 *   - Gated by `PERF_FLAGS.UNIFIED_EVENT_LOG ||
 *     PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW` so Phase 0 telemetry runs
 *     while the prompt assembler ignores the reducer output.
 *   - Fail-soft: any emit failure is swallowed with a console warning so
 *     a snapshot/restore call cannot be torn down by an emitter regression.
 *   - Events flow through the single main-process EventLog instance
 *     supplied by the caller (Event_Bus_Bridge requirement) — the
 *     emitter never opens its own database handle.
 *   - The helper takes a structural `EventLog`-like emitter so this module
 *     can sit in `src/session/` without forming an import cycle with
 *     `src/main/ipc.ts` (which already imports from `src/session/`).
 *
 * `ref` mapping: today the WorkspaceCheckpointManager stores snapshots in
 * `~/.neuronest/snapshots/<snapshotId>` rather than as git refs. The
 * design's `refs/neuronest/turn/*` reconciler path (task 28) enumerates
 * git refs separately. For the `checkpoint.created` payload we therefore
 * use the manager's snapshot id as the `ref` — that's the canonical
 * reference under which the snapshot can be located.
 *
 * `turnId` mapping: the manager API today has no notion of turnId; it
 * accepts `agentId` and a free-form `stepDescription`. Callers that
 * later thread a turnId through can pass it via the optional `turnId`
 * field — the emitter passes it through unchanged. When not supplied,
 * the field is omitted from the payload (the reducer's apply tolerates
 * a missing turnId — it only consumes `checkpointId`).
 *
 * Pulled into its own module so the per-emitter unit test can exercise
 * the gating + payload shape without booting the whole IPC layer or
 * touching the filesystem.
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';

// ─── Structural EventLog dependency (no import cycle) ─────────

/**
 * Minimal structural shape of the main-process `EventLog`. We do NOT
 * import the class here to avoid a `session → main → session` import
 * cycle. The full type lives in `src/pipeline/event-log.ts`.
 */
export interface EventLogEmitter {
  emit(input: { sessionId: string; kind: string; payload: unknown }): unknown;
}

// ─── Public input shapes ──────────────────────────────────────

export interface CheckpointCreatedInput {
  sessionId: string;
  checkpointId: string;
  /** Stable reference under which the checkpoint can be located. */
  ref: string;
  /** Optional correlation id for the turn that produced the snapshot. */
  turnId?: string;
}

export interface CheckpointRestoredInput {
  sessionId: string;
  checkpointId: string;
  /** Optional correlation id for the turn the restore is associated with. */
  turnId?: string;
}

// ─── Public API ───────────────────────────────────────────────

/** Returns true when either of the unified-event-log flags is on. */
export function isCheckpointEmitEnabled(): boolean {
  return Boolean(
    PERF_FLAGS.UNIFIED_EVENT_LOG || PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW,
  );
}

/**
 * Emit a `checkpoint.created` Pipeline_Event through the supplied EventLog.
 *
 * Returns `true` if an emit was attempted, `false` if the emitter skipped:
 * gating disabled, missing log, missing sessionId, or missing required
 * payload fields.
 */
export function emitCheckpointCreated(
  log: EventLogEmitter | null | undefined,
  input: CheckpointCreatedInput,
): boolean {
  if (!isCheckpointEmitEnabled()) return false;
  if (!log) return false;

  const sessionId = input.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  const checkpointId = input.checkpointId;
  if (typeof checkpointId !== 'string' || checkpointId.length === 0) return false;

  const ref = input.ref;
  if (typeof ref !== 'string' || ref.length === 0) return false;

  // Build the payload exactly as design.md "Event kinds" specifies.
  // `turnId` is only attached when a non-empty string is supplied so the
  // emitted shape stays clean for callers that have no turn correlation.
  const payload: { checkpointId: string; ref: string; turnId?: string } = {
    checkpointId,
    ref,
  };
  if (typeof input.turnId === 'string' && input.turnId.length > 0) {
    payload.turnId = input.turnId;
  }

  try {
    // Fire-and-forget. EventLog.emit returns a resolved promise after
    // enqueue. We don't await — snapshot/restore callers must not block
    // on flush latency.
    const result = log.emit({
      sessionId,
      kind: 'checkpoint.created',
      payload,
    });
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch(() => {
        // Swallow async rejection: emitter is best-effort.
      });
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      '[checkpoint-event-emitter] checkpoint.created emit threw:',
      (e as Error)?.message,
    );
    return false;
  }
}

/**
 * Emit a `checkpoint.restored` Pipeline_Event through the supplied
 * EventLog. The `checkpoint.restored` kind is special — observing it
 * triggers cache invalidation in the Unified_State_Reducer (Requirement
 * 6.9), so emitting one drives both prompt-assembly state refresh AND
 * dashboard correlation.
 *
 * Returns `true` if an emit was attempted, `false` if the emitter
 * skipped: gating disabled, missing log, missing sessionId, or missing
 * `checkpointId`.
 */
export function emitCheckpointRestored(
  log: EventLogEmitter | null | undefined,
  input: CheckpointRestoredInput,
): boolean {
  if (!isCheckpointEmitEnabled()) return false;
  if (!log) return false;

  const sessionId = input.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  const checkpointId = input.checkpointId;
  if (typeof checkpointId !== 'string' || checkpointId.length === 0) return false;

  // Design enumerates `turnId` in the payload but the reducer's apply
  // does not require it (only `checkpointId` is consumed). When the
  // caller supplies a non-empty turnId we attach it; otherwise we
  // omit the field to keep the emitted payload shape clean. This
  // mirrors the chat.user emitter's optional `agentId` handling.
  const payload: { checkpointId: string; turnId?: string } = { checkpointId };
  if (typeof input.turnId === 'string' && input.turnId.length > 0) {
    payload.turnId = input.turnId;
  }

  try {
    const result = log.emit({
      sessionId,
      kind: 'checkpoint.restored',
      payload,
    });
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch(() => {
        // Swallow async rejection: emitter is best-effort.
      });
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      '[checkpoint-event-emitter] checkpoint.restored emit threw:',
      (e as Error)?.message,
    );
    return false;
  }
}

// ─── EventLog resolver (for callers that wire late) ───────────

/**
 * Optional lazy resolver pattern, mirroring `error-capture.ts`. The
 * `WorkspaceCheckpointManager` accepts an `EventLogEmitter` directly via
 * its constructor for the simple injection path; this resolver hook is
 * provided for call sites that need to bind the EventLog *after* the
 * manager has been constructed (e.g. in `ipc.ts` where the manager is
 * built inline before all dependencies are wired).
 */
export type EventLogResolver = () => EventLogEmitter | null;

let eventLogResolver: EventLogResolver | null = null;

/** Register the EventLog resolver. Pass `null` to clear (used by tests). */
export function setCheckpointEventLogResolver(
  resolver: EventLogResolver | null,
): void {
  eventLogResolver = resolver;
}

/** Returns the registered resolver's current EventLog, or null. */
export function getCheckpointEventLog(): EventLogEmitter | null {
  if (!eventLogResolver) return null;
  try {
    return eventLogResolver();
  } catch {
    return null;
  }
}
