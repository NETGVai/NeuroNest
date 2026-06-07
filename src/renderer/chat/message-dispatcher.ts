//
// Renderer-side message-submit handler. On each user-submitted chat
// message, this dispatcher runs `AskSlashCommand.handle` BEFORE the
// default chat path; only `{ kind: 'not_a_command' }` falls through.
//
// The companion `HeadlessAdapter` integration (`src/cli/headless-adapter.ts`)
// uses the IDENTICAL pre-dispatch sequence, with the same
// `AskCommandContext` shape, so GUI and headless mode share a single
// `/ask` execution path (Req 2.7, 2.8).
//
// Note: Phase 3's GUI message-dispatcher substrate is not yet landed
// in this codebase. This file is the integration point — when the
// real GUI dispatcher arrives, the `dispatchMessage` function below
// should be invoked from that dispatcher's existing message-submit
// hook (see TODOs marked PHASE-3-HOOK), keeping the `/ask` pre-
// dispatch ordering intact.
//
// Validates: Requirements 2.1, 2.5, 2.7, 2.8

import { AskSlashCommand } from './ask-slash-command';

import type {
  AskCommandContext,
  AskSlashCommandResult,
} from './ask-slash-command';

// ─── Public types ───────────────────────────────────────────────

/**
 * Outcome of the GUI message dispatcher. Three cases:
 *   - `ask_handled`     — `/ask` consumed the message (help branch
 *                         or full sub-agent dispatch). Caller MUST
 *                         NOT route the message into the default
 *                         chat path (Req 2.1).
 *   - `default_chat`    — message was not an `/ask` invocation.
 *                         Caller routes it through the default chat
 *                         path unchanged.
 *   - `default_command` — message began with `/` but is not `/ask`
 *                         (e.g. `/help`, `/clear`). Caller routes
 *                         it to the existing slash-command registry.
 */
export type MessageDispatchResult =
  | { kind: 'ask_handled'; ask: AskSlashCommandResult }
  | { kind: 'default_chat'; rawMessage: string }
  | { kind: 'default_command'; rawMessage: string };

/**
 * Surface needed by `dispatchMessage`. The `AskCommandContext` is
 * forwarded verbatim to `AskSlashCommand.handle` — both GUI and
 * headless call sites construct this shape identically (Req 2.7, 2.8).
 */
export interface MessageDispatcherContext {
  /** The `/ask` command's execution context — same shape used by the
   *  HeadlessAdapter (`src/cli/headless-adapter.ts`). */
  ask: AskCommandContext;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Strict left-anchored detection — any message beginning with `/`
 * that is NOT an `/ask` invocation is routed to the existing
 * slash-command registry rather than the chat path. The detection
 * mirrors `AskSlashCommand.handle`'s precedence rules: `/ask` and
 * `/ask <question>` are owned by the AskSlashCommand; everything else
 * starting with `/` is a generic command.
 */
function isAskCommand(rawMessage: string): boolean {
  return rawMessage === '/ask' || rawMessage.startsWith('/ask ');
}

function isOtherSlashCommand(rawMessage: string): boolean {
  return rawMessage.startsWith('/') && !isAskCommand(rawMessage);
}

/**
 * GUI message-submit dispatcher. Pre-dispatches each user-submitted
 * message into `AskSlashCommand.handle` BEFORE the default chat path
 * (Req 2.1, 2.5). Only `{ kind: 'not_a_command' }` falls through.
 *
 * Call ordering (matches HeadlessAdapter for Req 2.7, 2.8):
 *   1. AskSlashCommand.handle(rawMessage, ctx.ask)
 *   2. if result.kind !== 'not_a_command' → return ask_handled
 *   3. else if other slash command → return default_command
 *   4. else → return default_chat
 *
 * The caller (the real GUI message-submit handler, once Phase 3's
 * substrate lands) wires step 3's default_command branch into the
 * slash-command registry and step 4's default_chat branch into the
 * existing chat-message pipeline. Steps 1–2 are owned here so the
 * `/ask` pre-dispatch ordering is identical across GUI and headless.
 */
export async function dispatchMessage(
  rawMessage: string,
  ctx: MessageDispatcherContext,
): Promise<MessageDispatchResult> {
  // Step 1: always invoke the AskSlashCommand first (Req 2.1, 2.5).
  // The handler internally renders help / answer / error through
  // ctx.ask.adapter, so by the time we observe a non-fall-through
  // result the chat surface is already updated.
  const askResult = await AskSlashCommand.handle(rawMessage, ctx.ask);

  if (askResult.kind !== 'not_a_command') {
    // `/ask` consumed the message — do NOT route into the default
    // chat path. (Req 2.1: only the AskSlashCommand renders the
    // result for `/ask` messages.)
    return { kind: 'ask_handled', ask: askResult };
  }

  // Step 3: `/ask` did not match. Disambiguate other slash commands
  // from chat content so the GUI's existing slash-command registry
  // still sees commands like `/help`, `/clear`, `/exit`.
  if (isOtherSlashCommand(rawMessage)) {
    return { kind: 'default_command', rawMessage };
  }

  // Step 4: ordinary chat content — fall through to the default
  // chat path unchanged (Req 2.1).
  return { kind: 'default_chat', rawMessage };
}

// ─── PHASE-3-HOOK ───────────────────────────────────────────────
//
// When Phase 3's GUI message-submit substrate lands, attach this
// dispatcher to it as follows (illustrative — the real submit hook
// shape is owned by Phase 3):
//
//   chatInput.onSubmit(async (rawMessage) => {
//     const result = await dispatchMessage(rawMessage, {
//       ask: buildAskCommandContext(),
//     });
//     switch (result.kind) {
//       case 'ask_handled':     return; // already rendered
//       case 'default_command': return slashRegistry.dispatch(result.rawMessage);
//       case 'default_chat':    return chatPipeline.send(result.rawMessage);
//     }
//   });
//
// `buildAskCommandContext` is the GUI-side factory that produces the
// `AskCommandContext` (AuthContext from the renderer's auth store,
// UIAdapter wrapping the chat DOM, SubAgentRunner from the renderer-
// side proxy to the Phase 3 runner, and AbortSignal tied to the
// chat-turn cancel button). The HeadlessAdapter (task 3.4 companion
// file) constructs the same shape from its JSON-RPC channel — that
// shared shape is the one piece of Phase 4 contract that guarantees
// Req 2.7 and 2.8.
