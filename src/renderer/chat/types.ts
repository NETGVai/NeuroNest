//
// Minimal local declarations for `AuthContext`, `UIAdapter`, and
// `SubAgentRunner` — the design names these as Phase 3 types, but the
// Phase 3 types are not yet landed in this codebase. These local
// interfaces capture the slice of their contract that the
// AskSlashCommand dispatcher (task 3.3) actually depends on, so the
// dispatcher compiles in isolation and so callers (the GUI message
// dispatcher in task 3.4 and the HeadlessAdapter integration) can
// inject test doubles without pulling in the eventual full Phase 3
// surface.
//
// When the Phase 3 modules ship, these declarations should be replaced
// with imports from the canonical Phase 3 locations without changing
// any consumer's call site shape.

import type { SubAgentDefinition } from '../../agent-skills/sub-agents/types';

/**
 * Opaque authentication context passed through to the
 * Sub_Agent_Runner. The dispatcher does not inspect any field of this
 * value — it only forwards it. The `unknown`-friendly index signature
 * lets test code construct a stub `{}` while real callers may attach
 * userId / sessionId / licenseKey fields without coupling this module
 * to the eventual Phase 3 shape.
 */
export interface AuthContext {
  readonly [key: string]: unknown;
}

/**
 * Surface used by the AskSlashCommand dispatcher to render output
 * back into the chat — abstracts over the GUI renderer (DOM-backed)
 * and the Headless_Protocol adapter (JSON-RPC-backed) so a single
 * dispatcher implementation drives both call sites identically
 * (Req 2.7, 2.8).
 *
 * The four methods cover the three rendering paths plus pending-state
 * resolution:
 *
 *   - `renderHelp`              — inline help text for the `/ask`
 *                                 (no question) branch (Req 2.9).
 *   - `renderAssistantMessage`  — successful sub-agent answer rendered
 *                                 inline as a regular assistant
 *                                 message in the same chat (Req 2.5).
 *   - `renderError`             — structured error message, used both
 *                                 for sub-agent failure / timeout
 *                                 (Req 2.10) and for the second
 *                                 placeholder-scrub failure (Req 2.6).
 *   - `resolveChatPending`      — clear the pending-message state so
 *                                 the chat does not appear stuck
 *                                 after any terminal outcome (Req 2.10).
 */
export interface UIAdapter {
  /** Render an inline assistant message — used for sub-agent success. */
  renderAssistantMessage(text: string): void;
  /** Render an inline help message — used for the `/ask` help branch. */
  renderHelp(text: string): void;
  /**
   * Render an inline error message naming the failure mode. Called for
   * sub-agent invocation failures, timeouts, and repeated placeholder
   * scrub failures.
   */
  renderError(text: string): void;
  /**
   * Clear the chat-pending state. Called exactly once per dispatch
   * after a terminal outcome (success, error, or repeated placeholder
   * failure) to satisfy the "SHALL NOT leave the chat in a pending
   * state" clause of Req 2.10.
   */
  resolveChatPending(): void;
}

/**
 * Result envelope returned by `SubAgentRunner.runSubAgent`. Either
 * carries the final tool-result string in `output`, or a structured
 * failure naming the failure mode. The `runId` is forwarded to the
 * dispatcher's caller so the GUI / Headless_Protocol layers can
 * correlate later events with the original invocation.
 */
export type SubAgentRunResult =
  | { ok: true;  runId: string; output: string }
  | {
      ok: false;
      runId: string;
      error:
        | { kind: 'invocation_failed'; detail: string }
        | { kind: 'timeout';           detail: string }
        | { kind: 'aborted';           detail: string };
    };

/**
 * Phase 3 Sub_Agent_Runner — the minimal contract the AskSlashCommand
 * dispatcher needs. The design specifies the call shape as
 * `runSubAgent(AskSubAgent, { input: { question } })`, with the
 * AuthContext and UIAdapter sourced from the AskCommandContext.
 *
 * The runner is responsible for: nested LLM loop execution, tool
 * subset enforcement (via Phase 3 ToolSubsetEnforcer), and resolving
 * with either a final tool-result string or a structured failure.
 * The dispatcher does not see intermediate tool calls — only the
 * terminal envelope.
 */
export interface SubAgentRunner {
  runSubAgent(
    definition: SubAgentDefinition,
    options: {
      input: { question: string };
      authContext: AuthContext;
      adapter: UIAdapter;
      abortSignal: AbortSignal;
    },
  ): Promise<SubAgentRunResult>;
}
