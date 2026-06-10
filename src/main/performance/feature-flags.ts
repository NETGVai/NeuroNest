/**
 * Performance feature flags for safe incremental rollout.
 * Each flag can be independently toggled to enable/disable a specific
 * performance optimization without affecting others.
 */
export const PERF_FLAGS = {
  /** Toggle async command execution (lint, test, build, fix) */
  ASYNC_COMMANDS: true,
  /** Toggle file tree caching (in-memory directory structure) */
  FILE_TREE_CACHE: true,
  /** Toggle lazy module loading (deferred startup) */
  LAZY_MODULES: true,
  /** Toggle message store cap (bounded in-memory messages) */
  BOUNDED_MESSAGES: true,
  /**
   * Toggle prompt-compression (always-on by default).
   *
   * When ON, the LLMClient routes outgoing chat()/chatStream() messages
   * through `maybeCompressMessages` before posting to the upstream provider.
   * Compression is self-contained: if the optional `headroom-ai` SDK + proxy
   * are reachable they are used, otherwise a built-in dependency-free
   * compressor (whitespace/encoding normalization) runs locally. Either way no
   * external service is required, so this defaults ON.
   *
   * Requests routed through the NeuroNest LLM proxy (`llm.neuronest.cc`) are
   * ALSO compressed server-side in the worker; the local transforms are
   * idempotent so the two passes never conflict.
   *
   * Per-message size gating (HEADROOM_CONFIG.minBytes) still avoids paying
   * compression cost on tiny chat replies.
   */
  HEADROOM_COMPRESSION: true,
  /**
   * Toggle the unified event log as the source of truth for agent state.
   *
   * When ON, the agent reconstructs context exclusively from the append-only
   * event log (Factor 5: Unify Execution & Business State). When OFF, the
   * legacy message-store path is used.
   *
   * Default OFF until shadow-mode comparisons demonstrate parity with the
   * legacy path on real workloads.
   */
  UNIFIED_EVENT_LOG: false,
  /**
   * Toggle shadow-mode logging for the unified event log.
   *
   * When ON, events are written to the unified log in parallel with the
   * legacy message-store path so the two can be compared without affecting
   * runtime behavior. Used to validate the unified log before flipping
   * UNIFIED_EVENT_LOG to true.
   *
   * Default ON so we accumulate observability data during rollout.
   */
  UNIFIED_EVENT_LOG_SHADOW: true,
  /**
   * Toggle Error_Compactor active feed (Requirement 4.2).
   *
   * When ON, the Tool_Retry_Site feeds the compacted error text back to
   * the LLM instead of the raw error. Default OFF for the first release.
   * Flips to `true` only after the Phase 1 telemetry preconditions in
   * Requirement 4.4 hold against a 7-day Phase 0 sample.
   */
  ERROR_COMPACTION: false,
  /**
   * Toggle Error_Compactor shadow-mode telemetry (Requirement 4.4 Phase 0).
   *
   * When ON, the compactor runs and records `errors.compacted.*` metrics
   * but the raw error continues to be re-fed to the LLM. This is the
   * observation-only tap that ships first and runs for at least 7 days
   * before `ERROR_COMPACTION` may flip on. Default ON so Phase 0
   * telemetry is collected from the first release.
   */
  ERROR_COMPACTION_SHADOW: true,
  /**
   * Toggle the F1 Untrusted_Source_Wrapper (kill-switch only).
   *
   * When ON, F1_Call_Sites (web-browser, context-references, skill-loader,
   * agentmemory-client) route third-party content through the
   * Untrusted_Wrapper (`src/pipeline/untrusted-context.ts`), surrounding it
   * with fixed delimiters and a policy header before it reaches the LLM so
   * external data is never interpreted as operator instructions. When OFF,
   * those sites forward content via the pre-existing unwrapped path.
   *
   * Default ON; this is a ship-on kill-switch intended only for diagnostics
   * when the wrapping interacts badly with a specific provider or prompt
   * template.
   */
  UNTRUSTED_SOURCE_WRAP: true,
  /**
   * Toggle RAG-based tool selection active path (Requirement 27, Feature 4).
   *
   * When ON, the chat pipeline sends the ToolIndex retrieval result
   * (top-K tools by cosine similarity plus the ALWAYS_AVAILABLE union)
   * to the LLM instead of the Full_Registry. When OFF, the Full_Registry
   * is sent unchanged.
   *
   * Paired with TOOL_RAG_SELECTION_SHADOW per the PERF_FLAGS paired-rollout
   * pattern. Default OFF (Phase 0). Flip to `true` in Phase 1 only after the
   * Phase 0 shadow evaluation gate holds: shadow size < full size by ≥ 30%,
   * fallback rate < 1%, and p95 retrieval latency < 50ms over a ≥ 7-day
   * sample.
   */
  TOOL_RAG_SELECTION: false,
  /**
   * Toggle RAG tool-selection shadow-mode telemetry (Requirement 27 Phase 0).
   *
   * When ON (and TOOL_RAG_SELECTION is `false`), the ToolIndex retrieval
   * runs and emits observation-only telemetry (shadow size delta vs full
   * registry, retrieval latency, fallback rate) while the Full_Registry is
   * still sent to the LLM — the request is never altered. This is the
   * Phase 0 tap that ships first and runs for at least 7 days before
   * TOOL_RAG_SELECTION may flip on. Default ON so Phase 0 telemetry is
   * collected from the first release. Removed from PERF_FLAGS in Phase 2.
   */
  TOOL_RAG_SELECTION_SHADOW: true,
  /**
   * Toggle the F5 Date_Grounding_Preamble (kill-switch only, Requirement 33).
   *
   * When ON, the F5_Call_Sites (orchestrator-planner, web-browser search
   * query generation, iterative-refinement) prepend the Date_Preamble_Helper
   * output (`currentDateContext()` from `src/pipeline/date-grounding.ts`) to
   * their query-generation prompts so the model is grounded in the real
   * current date and stops emitting queries with a stale, training-cutoff
   * year. When OFF, those sites emit prompts unchanged.
   *
   * Default ON; this is a ship-on kill-switch intended only to disable date
   * grounding if a provider reacts poorly to the preamble.
   */
  DATE_GROUNDING_ENABLED: true,
  /**
   * Toggle the F7 Teacher_Escalation_Loop (Requirement 41).
   *
   * When ON, a failed/low-confidence task may escalate to a stronger
   * teacher model (configured via `teacherModel` / `teacherEndpointUrl` in
   * AppConfig) which produces a corrected result the loop can learn from.
   * When OFF, no escalation occurs and tasks run on the primary model only.
   *
   * Default OFF; this is an opt-in flag. The operator opts in by configuring
   * a `teacherModel` in settings — escalation does nothing useful until the
   * teacher model and its endpoint are set.
   */
  TEACHER_ESCALATION_ENABLED: false,
  /**
   * Toggle the F9 MCP_Browser_Server auto-start (kill-switch only,
   * Requirement 49).
   *
   * When ON, the app boot path auto-registers the Browser_MCP_Server
   * (`@playwright/mcp` via the Built_In_MCP_Registry) so the Playwright
   * browser MCP server is available without manual configuration. If the
   * `@playwright/mcp` package is not present in the npx cache, boot logs a
   * structured skip message (naming the missing package and the install
   * command) and continues without error — a fresh install is never blocked
   * by a multi-minute npm download. When OFF, no auto-registration is
   * attempted.
   *
   * Default ON; this is a ship-on kill-switch intended only to disable
   * auto-start if the registration interacts badly with a specific
   * environment.
   */
  MCP_BROWSER_AUTOSTART: true,
  /**
   * Toggle the GCF_Wire_Format active path (Requirement 55, Feature 10).
   *
   * When ON, each F10_Encoded_Surface (MCP boundary, swarm handoff, indexing
   * graph extracts, tool-executor structured outputs) re-encodes its
   * structured LLM payload through GCF (Graph Compact Format) before it
   * reaches the LLM, emitting `gcf.<surface>.savings_ratio` telemetry per
   * encoded payload. When OFF, each surface emits the pre-existing JSON
   * encoding unchanged.
   *
   * Paired with GCF_WIRE_FORMAT_SHADOW per the PERF_FLAGS paired-rollout
   * pattern. Default OFF (Phase 0). Flip to `true` in Phase 1 only after the
   * per-provider F10_Comprehension_Eval passes — every currently-configured
   * provider must be marked `gcf_capable: true` (accuracy within 5 percentage
   * points of its JSON baseline).
   */
  GCF_WIRE_FORMAT: true,
  /**
   * Toggle GCF_Wire_Format shadow-mode telemetry (Requirement 55 Phase 0).
   *
   * When ON (and GCF_WIRE_FORMAT is `false`), each F10_Encoded_Surface
   * computes both the GCF and JSON encodings and emits observation-only
   * telemetry (`gcf.shadow_size_bytes`, `gcf.json_size_bytes`, and
   * `gcf.shadow_savings_ratio`) to the Metrics_Sink while still sending the
   * JSON payload to the LLM — the encoded GCF payload is never sent. This is
   * the Phase 0 tap that ships first so size-savings telemetry is collected
   * before GCF_WIRE_FORMAT may flip on in Phase 1. Default ON. Removed from
   * PERF_FLAGS in Phase 2.
   */
  GCF_WIRE_FORMAT_SHADOW: true,
  /**
   * Toggle the F11 Skill_Pack_System loader (Requirement 58).
   *
   * When ON, the Skill_Pack_Loader (`src/skills/pack-loader.ts`) is active so
   * a skill pack can be installed from a Git URL or local path, its
   * `pack.json` Pack_Manifest read, and its skills registered into the local
   * Skill_Registry. The loader remains opt-in per pack regardless of this
   * flag — nothing is installed or registered until the operator explicitly
   * adds a pack. When OFF, the loader is disabled and no packs can be
   * installed, synced, or registered.
   *
   * Default ON; this is a ship-on kill-switch intended only to disable the
   * skill-pack subsystem if it interacts badly with a specific environment.
   */
  SKILL_PACK_LOADER_ENABLED: true,
};

/**
 * Headroom-specific tunables. Lifted out of PERF_FLAGS because they
 * carry numeric/string values rather than booleans.
 */
export const HEADROOM_CONFIG = {
  /** Skip compression when the request body is below this size (bytes). */
  minBytes: 2048,
  /** Default proxy URL — overridable via HEADROOM_PROXY_URL env var. */
  defaultProxyUrl: process.env.HEADROOM_PROXY_URL || 'http://localhost:8787',
  /**
   * Whether an EXTERNAL Headroom proxy is explicitly configured. When false
   * (the default), the compressor skips the SDK round-trip entirely and uses
   * the built-in local compressor — so the always-on path never pays a wasted
   * connection attempt to a proxy that isn't there. Set HEADROOM_PROXY_URL to
   * opt into the external SDK path (which still falls back to local on error).
   */
  proxyConfigured: !!process.env.HEADROOM_PROXY_URL,
  /** Per-call timeout. Past this we abandon and send the original messages. */
  timeoutMs: 5_000,
  /** SDK retry count. We rely on local proxy so 0 is fine. */
  retries: 0,
};

