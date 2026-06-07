//
// Headless_Protocol message handler. On each inbound user-submitted
// message (Phase 3 Headless_Protocol `{ type: 'message', text }`
// action), this adapter runs `AskSlashCommand.handle` BEFORE the
// default chat path; only `{ kind: 'not_a_command' }` falls through.
//
// The pre-dispatch sequence here is BIT-FOR-BIT IDENTICAL to the GUI
// message-dispatcher (`src/renderer/chat/message-dispatcher.ts`) so
// GUI and headless share one execution path for `/ask` (Req 2.7, 2.8).
// Both call sites pass the same `AskCommandContext` shape — no
// path-specific behavior lives in either dispatcher.
//
// Note: Phase 3's Headless_Protocol server substrate is not yet
// landed in this codebase. This file is the integration point —
// when the real headless server arrives, its inbound-message handler
// invokes `dispatchHeadlessMessage` below, keeping the `/ask` pre-
// dispatch ordering intact (see TODO marked PHASE-3-HOOK).
//
// Validates: Requirements 2.1, 2.5, 2.7, 2.8

import { AskSlashCommand } from '../renderer/chat/ask-slash-command.js';

import type {
  AskCommandContext,
  AskSlashCommandResult,
} from '../renderer/chat/ask-slash-command.js';

// ─── Public types ───────────────────────────────────────────────

/**
 * Outcome of the headless message dispatcher. The three discriminants
 * mirror the GUI dispatcher's `MessageDispatchResult` so a single
 * caller-side switch covers both paths. Headless callers route the
 * `default_command` and `default_chat` cases into the headless agent
 * loop, exactly as the GUI does into its renderer-side chat pipeline.
 */
export type HeadlessMessageDispatchResult =
  | { kind: 'ask_handled'; ask: AskSlashCommandResult }
  | { kind: 'default_chat'; rawMessage: string }
  | { kind: 'default_command'; rawMessage: string };

/**
 * Surface needed by `dispatchHeadlessMessage`. The `AskCommandContext`
 * is forwarded verbatim to `AskSlashCommand.handle`. The GUI
 * dispatcher constructs this same shape — that shared shape is the
 * one piece of contract that satisfies Req 2.7 and 2.8.
 */
export interface HeadlessAdapterContext {
  /** The `/ask` command's execution context — same shape used by
   *  the GUI message-dispatcher (`src/renderer/chat/message-dispatcher.ts`). */
  ask: AskCommandContext;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Strict left-anchored detection — kept structurally identical to
 * the GUI dispatcher's helper so the two pre-dispatch decisions can
 * never diverge.
 */
function isAskCommand(rawMessage: string): boolean {
  return rawMessage === '/ask' || rawMessage.startsWith('/ask ');
}

function isOtherSlashCommand(rawMessage: string): boolean {
  return rawMessage.startsWith('/') && !isAskCommand(rawMessage);
}

/**
 * Headless inbound-message dispatcher. Pre-dispatches each user-
 * submitted message into `AskSlashCommand.handle` BEFORE the default
 * chat path (Req 2.1, 2.5). Only `{ kind: 'not_a_command' }` falls
 * through.
 *
 * Call ordering (matches the GUI message-dispatcher for Req 2.7, 2.8):
 *   1. AskSlashCommand.handle(rawMessage, ctx.ask)
 *   2. if result.kind !== 'not_a_command' → return ask_handled
 *   3. else if other slash command → return default_command
 *   4. else → return default_chat
 *
 * The Headless_Protocol server (once landed) uses this function from
 * its `{ type: 'message', text }` inbound handler — see PHASE-3-HOOK
 * comment at the bottom of this file.
 */
export async function dispatchHeadlessMessage(
  rawMessage: string,
  ctx: HeadlessAdapterContext,
): Promise<HeadlessMessageDispatchResult> {
  // Step 1: always invoke the AskSlashCommand first (Req 2.1, 2.5).
  // The handler internally renders help / answer / error through
  // ctx.ask.adapter — for the headless path, the UIAdapter is a
  // JSON-RPC-backed wrapper that emits Headless_Protocol `text` /
  // `error` events back to the connected client.
  const askResult = await AskSlashCommand.handle(rawMessage, ctx.ask);

  if (askResult.kind !== 'not_a_command') {
    // `/ask` consumed the message — do NOT route into the default
    // chat path. (Req 2.1.)
    return { kind: 'ask_handled', ask: askResult };
  }

  // Step 3: `/ask` did not match. Other slash commands take the
  // headless server's slash-command registry path; chat content
  // takes the default agent loop.
  if (isOtherSlashCommand(rawMessage)) {
    return { kind: 'default_command', rawMessage };
  }

  return { kind: 'default_chat', rawMessage };
}

// ─── PHASE-3-HOOK ───────────────────────────────────────────────
//
// When Phase 3's Headless_Protocol server substrate lands, attach
// this dispatcher to it as follows (illustrative — the real inbound
// action shape is owned by Phase 3):
//
//   headlessServer.onAction(async (action) => {
//     if (action.type !== 'message') {
//       return defaultActionDispatcher(action);
//     }
//     const result = await dispatchHeadlessMessage(action.text, {
//       ask: buildHeadlessAskCommandContext(action.requestId),
//     });
//     switch (result.kind) {
//       case 'ask_handled':     return; // already emitted via UIAdapter
//       case 'default_command': return slashRegistry.dispatch(result.rawMessage);
//       case 'default_chat':    return agentLoop.send(result.rawMessage);
//     }
//   });
//
// `buildHeadlessAskCommandContext` is the headless-side factory that
// produces the `AskCommandContext` (AuthContext from the protocol
// startup banner, UIAdapter wrapping the JSON-RPC text/error event
// emitter, SubAgentRunner from the headless agent-loop's runner
// reference, and AbortSignal tied to the inbound action's
// cancellation channel). The GUI message-dispatcher (task 3.4
// companion file) constructs the same shape from its renderer-side
// surface — that shared shape is the one piece of Phase 4 contract
// that guarantees Req 2.7 and 2.8.
