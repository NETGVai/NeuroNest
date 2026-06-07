//
// The `/ask` chat slash-command dispatcher. Detects whether a
// user-submitted message is an `/ask` invocation and, if so, routes it
// through the Phase 3 Sub_Agent_Runner against the AskSubAgent
// (`src/agent-skills/sub-agents/ask/definition.ts`). Successful
// sub-agent answers are post-processed by `PlaceholderScrub.check`
// (`src/agent-skills/sub-agents/ask/placeholder-scrub.ts`) before
// rendering, with a single placeholder-explicit retry on the first
// failure and an inline error message on the second.
//
// The same dispatcher is used from both the GUI message-dispatcher
// (renderer-side) and the headless `HeadlessAdapter` — Phase 3's
// UIAdapter abstraction makes these two call sites share one
// execution path (Req 2.7, 2.8). No path-specific behavior lives in
// this file.
//
// Validates: Requirements 2.1, 2.5, 2.6, 2.9, 2.10

import { AskSubAgent } from '../../agent-skills/sub-agents/ask/definition';
import { PlaceholderScrub } from '../../agent-skills/sub-agents/ask/placeholder-scrub';

import type {
  AuthContext,
  SubAgentRunner,
  SubAgentRunResult,
  UIAdapter,
} from './types';

// ─── Public types ───────────────────────────────────────────────

/**
 * Execution context for a single `/ask` dispatch. Carries the four
 * pieces of state the dispatcher needs and nothing more — keeping the
 * surface narrow lets the GUI message-dispatcher and the
 * HeadlessAdapter construct identical contexts on each call (Req 2.7,
 * 2.8).
 */
export interface AskCommandContext {
  /** Phase 3 auth context — forwarded unchanged to the
   *  Sub_Agent_Runner. The dispatcher does not inspect any field. */
  authContext: AuthContext;
  /** GUI- or headless-flavored UI adapter used to render help, the
   *  successful answer, or an error message back into the chat. */
  adapter: UIAdapter;
  /** Phase 3 Sub_Agent_Runner — invoked exactly once per dispatch
   *  on the success path, and at most twice when the first response
   *  fails the placeholder scrub (Req 2.6). */
  subAgentRunner: SubAgentRunner;
  /** AbortSignal that fires when the user cancels the chat turn or
   *  closes the headless connection. Forwarded to the runner so any
   *  in-flight nested LLM loop can short-circuit. */
  abortSignal: AbortSignal;
}

/**
 * Outcome of `AskSlashCommand.handle`. The three discriminants
 * correspond to the three branches the message-dispatcher / headless
 * adapter call sites need to distinguish:
 *
 *   - `not_a_command`  — message did not match the `/ask` prefix;
 *                        the caller falls through to the default chat
 *                        path.
 *   - `help_emitted`   — `/ask` with no question text; help was
 *                        rendered inline and no sub-agent invocation
 *                        was performed (Req 2.9).
 *   - `dispatched`     — sub-agent was invoked. The terminal outcome
 *                        (success, scrub failure, or runner failure)
 *                        was rendered through `ctx.adapter` and the
 *                        chat-pending state was cleared. The `runId`
 *                        is forwarded so the GUI / headless layers can
 *                        correlate later telemetry events.
 */
export type AskSlashCommandResult =
  | { kind: 'not_a_command' }
  | { kind: 'help_emitted' }
  | { kind: 'dispatched'; runId: string };

/** Dispatcher contract — implemented by the namespace export below. */
export interface AskSlashCommand {
  handle(
    rawMessage: string,
    ctx: AskCommandContext,
  ): Promise<AskSlashCommandResult>;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Strict left-anchored prefix for the dispatch branch. The trailing
 * space is significant: messages that begin with `/ask` followed by
 * any non-space character (e.g. `/asking`) MUST fall through as
 * `not_a_command` so the user's typo is not silently absorbed
 * (Req 2.9, INCOSE precision).
 */
const ASK_DISPATCH_PREFIX = '/ask ';

/** Exact match for the help branch (Req 2.9). */
const ASK_HELP_EXACT = '/ask';

/**
 * Inline help text rendered for the `/ask` (no question) branch
 * (Req 2.9). Concrete and self-contained — no placeholders, no
 * external links, copy-pasteable.
 */
const ASK_HELP_TEXT =
  'Usage: `/ask <question>`\n\n' +
  'Asks the read-only Workspace Q&A sub-agent a grounded question ' +
  'about your live workspace. The sub-agent has read-only access to ' +
  'your installed skills, providers, MCP servers, steering files, ' +
  'packaged workflows, and project files.\n\n' +
  'Example: `/ask which skills do I have installed?`';

/**
 * Reminder appended to the question on the placeholder-scrub retry.
 * The AskSubAgent system prompt already forbids placeholders, so a
 * single explicit reminder is enough in practice (design § Item 2).
 */
const PLACEHOLDER_RETRY_REMINDER =
  ' (Reminder: do not include placeholder tokens such as <TODO>, ' +
  '<your-value-here>, {{ todo }}, ...placeholder..., or <INSERT …>. ' +
  'Return concrete values from tool results only.)';

/**
 * Maximum number of sub-agent invocations per `/ask` dispatch
 * (initial + 1 placeholder-scrub retry). Hard-coded to 2 per
 * design § Item 2 — "one retry with a placeholder-explicit reminder;
 * if retry also fails, an inline error message is rendered".
 */
const MAX_INVOCATIONS = 2;

// ─── Implementation ─────────────────────────────────────────────

/**
 * Format a structured error message for inline rendering. The wording
 * names the failure mode (Req 2.10) without leaking transport-level
 * detail that would be confusing for chat readers.
 */
function formatErrorMessage(
  mode: 'invocation_failed' | 'timeout' | 'aborted' | 'placeholder_scrub',
  detail: string,
): string {
  switch (mode) {
    case 'invocation_failed':
      return (
        '⚠️ `/ask` failed: the Workspace Q&A sub-agent could not ' +
        `complete the request (${detail}). No changes were made.`
      );
    case 'timeout':
      return (
        '⚠️ `/ask` failed: the Workspace Q&A sub-agent timed out ' +
        `(${detail}). No changes were made.`
      );
    case 'aborted':
      return (
        '⚠️ `/ask` was cancelled before the Workspace Q&A sub-agent ' +
        `could respond (${detail}). No changes were made.`
      );
    case 'placeholder_scrub':
      return (
        '⚠️ `/ask` failed: the Workspace Q&A sub-agent kept emitting a ' +
        `placeholder token (${detail}) after one retry. Please rephrase ` +
        'your question to ask for a specific concrete value.'
      );
  }
}

/**
 * Invoke the Sub_Agent_Runner exactly once with the given question.
 * Wraps any thrown error into the `invocation_failed` envelope so the
 * caller has a single shape to switch on.
 */
async function runOnce(
  ctx: AskCommandContext,
  question: string,
): Promise<SubAgentRunResult> {
  try {
    return await ctx.subAgentRunner.runSubAgent(AskSubAgent, {
      input: { question },
      authContext: ctx.authContext,
      adapter: ctx.adapter,
      abortSignal: ctx.abortSignal,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Synthesize a runId so the caller still has something to
    // correlate; the runner itself owns the canonical id, but a
    // throw before the runner produced one means we have to invent
    // a placeholder here.
    return {
      ok: false,
      runId: '',
      error: { kind: 'invocation_failed', detail },
    };
  }
}

/**
 * Dispatch the question through the Sub_Agent_Runner with a single
 * placeholder-scrub retry. Returns the final `runId` to forward back
 * to the caller, after rendering the terminal outcome and resolving
 * the pending state.
 */
async function dispatchQuestion(
  ctx: AskCommandContext,
  question: string,
): Promise<string> {
  let lastRunId = '';

  for (let attempt = 0; attempt < MAX_INVOCATIONS; attempt++) {
    const promptForAttempt =
      attempt === 0 ? question : question + PLACEHOLDER_RETRY_REMINDER;

    const result = await runOnce(ctx, promptForAttempt);
    lastRunId = result.runId;

    if (!result.ok) {
      // Sub-agent failure or timeout — Req 2.10. Render a structured
      // error message naming the failure mode and clear the pending
      // state. No further retries: a transport-level failure is not
      // a placeholder issue.
      ctx.adapter.renderError(
        formatErrorMessage(result.error.kind, result.error.detail),
      );
      ctx.adapter.resolveChatPending();
      return lastRunId;
    }

    const scrub = PlaceholderScrub.check(result.output);
    if (scrub.ok) {
      // Success path (Req 2.5): render inline as a regular assistant
      // message and clear the pending state.
      ctx.adapter.renderAssistantMessage(result.output);
      ctx.adapter.resolveChatPending();
      return lastRunId;
    }

    // Placeholder scrub failed (Req 2.6). On the first attempt, loop
    // for the placeholder-explicit retry; on the second, fall through
    // to the error branch below.
    if (attempt === MAX_INVOCATIONS - 1) {
      ctx.adapter.renderError(
        formatErrorMessage('placeholder_scrub', scrub.offendingMatch),
      );
      ctx.adapter.resolveChatPending();
      return lastRunId;
    }
    // else: continue with the retry loop. No render happens between
    // attempts — only the terminal outcome is shown to the user.
  }

  // Unreachable: the loop returns from one of the branches above for
  // every attempt. Defensive fallback to keep the type checker happy
  // and to satisfy noImplicitReturns.
  /* istanbul ignore next */
  ctx.adapter.resolveChatPending();
  /* istanbul ignore next */
  return lastRunId;
}

/**
 * Detect whether `rawMessage` is an `/ask` invocation and dispatch
 * accordingly. Detection is strictly left-anchored on the literal
 * prefixes `'/ask '` and `'/ask'` (Req 2.9) — no whitespace trimming,
 * no case folding. Messages that merely contain `/ask` somewhere in
 * the body are NOT commands.
 */
async function handle(
  rawMessage: string,
  ctx: AskCommandContext,
): Promise<AskSlashCommandResult> {
  // Help branch — exact `/ask` (no trailing characters at all).
  // Checked before the dispatch branch so a bare `/ask` never falls
  // into the non-command bucket.
  if (rawMessage === ASK_HELP_EXACT) {
    ctx.adapter.renderHelp(ASK_HELP_TEXT);
    return { kind: 'help_emitted' };
  }

  // Dispatch branch — strict left-anchored `/ask ` (with the
  // trailing space). The everything-after-the-prefix is the
  // user's question. We deliberately do NOT trim trailing
  // whitespace from the question — the AskSubAgent's input schema
  // requires `minLength: 1`, and the prefix's trailing space
  // already excludes the empty-after-prefix case at compile time
  // (a string starting with `'/ask '` has at least one further
  // character, otherwise it would equal `ASK_HELP_EXACT`).
  if (rawMessage.startsWith(ASK_DISPATCH_PREFIX)) {
    const question = rawMessage.slice(ASK_DISPATCH_PREFIX.length);
    // Defensive: if the rest of the message is whitespace-only, fall
    // back to the help branch — the sub-agent's input schema would
    // reject an empty string anyway, and Req 2.9 mandates that the
    // help message replaces the no-question case.
    if (question.trim().length === 0) {
      ctx.adapter.renderHelp(ASK_HELP_TEXT);
      return { kind: 'help_emitted' };
    }
    const runId = await dispatchQuestion(ctx, question);
    return { kind: 'dispatched', runId };
  }

  // Anything else falls through — the caller's default chat path
  // takes over (Req 2.1: only messages beginning with `/ask ` are
  // intercepted).
  return { kind: 'not_a_command' };
}

/**
 * Frozen runtime export. `AskSlashCommand.handle(rawMessage, ctx)` is
 * the supported call site for the GUI message-dispatcher (task 3.4)
 * and the HeadlessAdapter integration.
 */
export const AskSlashCommand: AskSlashCommand = Object.freeze({ handle });
