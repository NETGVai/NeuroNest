/**
 * Chat event emitter for the Pipeline_Event_Log.
 *
 * Task 11 of the 12-factor-agent-improvements spec: emit `chat.user` and
 * `chat.assistant` Pipeline_Events from the chat-message IPC handler in
 * `src/main/ipc.ts`. Per design.md "Event kinds":
 *
 *   - chat.user      payload: { messageId, body, agentId? }
 *   - chat.assistant payload: { messageId, body, agentId }
 *
 * Validates: Requirements 2.4
 *
 * Design constraints honored here:
 *   - Gated by `PERF_FLAGS.UNIFIED_EVENT_LOG || PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW`
 *     so Phase 0 telemetry runs while the prompt assembler ignores the
 *     reducer output.
 *   - Fail-soft: any emit failure is swallowed with a console warning so
 *     a bad payload never tears down the chat-message handler.
 *   - Events flow through the single main-process EventLog instance
 *     supplied by the caller (Event_Bus_Bridge requirement) — the
 *     emitter never opens its own database handle.
 *
 * Pulled into its own module so the per-emitter unit test can exercise
 * the gating + payload shape without booting the whole IPC layer.
 */

import type { EventLog, EventKind } from '../pipeline/event-log';
import { PERF_FLAGS } from './performance/feature-flags';

/**
 * Shape of the input accepted by `emitChatEvent`. Mirrors the columns the
 * IPC handler already has on hand at the user-message-receipt and
 * assistant-message-persistence sites.
 *
 * `agentId` is optional for `chat.user` (the user is not an agent) and
 * required by the design for `chat.assistant`. We do not enforce that
 * distinction at the type level so the existing callers — which pass the
 * stored `agent` field that may legitimately be undefined for the
 * NeuroNest welcome reply — don't have to special-case it.
 */
export interface ChatEventInput {
  sessionId: string;
  role: 'user' | 'assistant';
  messageId: string;
  body: string;
  agentId?: string;
}

/** Returns true when either of the unified-event-log flags is on. */
export function isChatEmitEnabled(): boolean {
  return Boolean(
    PERF_FLAGS.UNIFIED_EVENT_LOG || PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW,
  );
}

/**
 * Map the message role to its Pipeline_Event kind. Other roles
 * (`system`, `meta`, …) are not part of the chat transcript surface
 * the design enumerates and are silently skipped by `emitChatEvent`.
 */
function chatKindFor(role: string): EventKind | null {
  if (role === 'user') return 'chat.user';
  if (role === 'assistant') return 'chat.assistant';
  return null;
}

/**
 * Emit a `chat.user` or `chat.assistant` Pipeline_Event through the
 * supplied EventLog.
 *
 * Returns `true` if an emit was attempted (even when the EventLog
 * subsequently rejects it asynchronously), `false` if the emitter
 * skipped: gating disabled, missing log, missing sessionId, missing
 * body, or unsupported role.
 *
 * The EventLog itself owns batching and retries — this helper just
 * routes the right shape to `emit`. Errors are caught and logged so a
 * malformed call cannot escape into the chat-message handler's flow.
 */
export function emitChatEvent(
  log: EventLog | null | undefined,
  input: ChatEventInput,
): boolean {
  if (!isChatEmitEnabled()) return false;
  if (!log) return false;

  const sessionId = input.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  const kind = chatKindFor(input.role);
  if (kind === null) return false;

  const body = input.body;
  if (typeof body !== 'string' || body.length === 0) return false;

  const messageId = input.messageId;
  if (typeof messageId !== 'string' || messageId.length === 0) return false;

  // Build the payload exactly as design.md "Event kinds" specifies.
  // `agentId` is only attached when a non-empty string is present so
  // the emitted shape stays clean for chat.user emits that have no
  // agent attribution.
  const payload: { messageId: string; body: string; agentId?: string } = {
    messageId,
    body,
  };
  if (typeof input.agentId === 'string' && input.agentId.length > 0) {
    payload.agentId = input.agentId;
  }

  try {
    // Fire-and-forget: EventLog.emit returns a resolved promise after
    // enqueue. We don't await — the chat-message handler must not
    // block on flush latency.
    void log.emit({ sessionId, kind, payload });
    return true;
  } catch (e) {
    // Defensive: EventLog.emit isn't expected to throw synchronously
    // (it's a pure enqueue) but renderer-side emits are documented as
    // best-effort. Log and continue.
    // eslint-disable-next-line no-console
    console.warn('[chat-event-emitter] emit threw:', (e as Error)?.message);
    return false;
  }
}
