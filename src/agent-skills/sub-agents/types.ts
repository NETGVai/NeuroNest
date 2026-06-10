/**
 * Shared type contracts for Sub_Agent definitions.
 *
 * Phase 4 (internal-integration) consumes the Phase 3
 * Sub_Agent_Runner / SubAgentDefinition surface. Phase 3 designates
 * `src/agent-skills/sub-agents/` as the location for this type. This
 * file defines the minimal contract that Phase 4's `AskSubAgent`
 * (Item 2 of Phase 4) needs in order to be instantiated by the
 * Sub_Agent_Runner.
 *
 * The shape mirrors the design document § "Phase 1–3 dependencies"
 * for `SubAgentDefinition`:
 *   - id, displayName            — identification
 *   - systemPrompt               — curated system prompt (text)
 *   - toolSubset                 — read-only allow-list of tool IDs
 *   - inputSchema                — JSON Schema for the agent's input
 *   - maxTurns                   — hard cap on the nested LLM loop
 *   - modelOverride (optional)   — pinned model; absent → inherit parent
 */

/** A JSON Schema fragment used to validate sub-agent input. The shape
 *  is intentionally `unknown`-friendly so consumers can use any
 *  compliant schema document without coupling to a specific library. */
export type JsonSchema = Record<string, unknown>;

export interface SubAgentDefinition {
  /** Stable identifier — used by Sub_Agent_Runner to dispatch the
   *  correct definition at runtime. Lower-case, kebab-case. */
  readonly id: string;

  /** Human-readable label shown in the chat UI. */
  readonly displayName: string;

  /** Curated system prompt. Loaded from a co-located `prompt.txt` by
   *  individual sub-agent modules so it remains author-editable
   *  without code changes. */
  readonly systemPrompt: string;

  /** Allow-list of tool IDs the nested LLM loop is permitted to call.
   *  Enforced by Phase 3's ToolSubsetEnforcer — any tool not in this
   *  set is rejected with a `disallowed_tool` envelope before its
   *  `execute` is invoked. */
  readonly toolSubset: ReadonlyArray<string>;

  /** JSON Schema describing the sub-agent's input payload. */
  readonly inputSchema: JsonSchema;

  /** Hard upper bound on the nested LLM loop turn count. */
  readonly maxTurns: number;

  /** Optional model override. When omitted, the sub-agent inherits the
   *  parent run's model selection. */
  readonly modelOverride?: string;
}
