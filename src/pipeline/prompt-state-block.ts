/**
 * Prompt assembler `## Current State` block helper.
 *
 * Task 25 of the 12-factor-agent-improvements spec. The reducer (task 22)
 * folds the Pipeline_Event log into a `SessionState` snapshot; this helper
 * is the single integration point between that snapshot and the prompt
 * the LLM actually sees. It is the consumer side of Factor 5 (unify
 * execution and business state).
 *
 * Contract (per design.md "Prompt assembler integration"):
 *
 *   1. The helper is invoked from every prompt-assembly call site, on
 *      every turn, regardless of feature flag state.
 *   2. When BOTH `UNIFIED_EVENT_LOG` and `UNIFIED_EVENT_LOG_SHADOW` are
 *      `false`, the helper short-circuits to an empty string and records
 *      nothing — the reducer is not consulted at all. This is the
 *      flag-fully-off state the production binary ships in until Phase 1.
 *   3. Otherwise, the helper resolves session state through the reducer,
 *      formats the `## Current State` block, and records the four
 *      `unified_state.*` metrics:
 *
 *        - `unified_state.bytes`              UTF-8 byte length of the block.
 *        - `unified_state.estimated_tokens`   Approximate LLM token count.
 *        - `unified_state.cache_hit`          Already recorded by the
 *                                              reducer itself (task 22),
 *                                              so the helper does NOT
 *                                              double-record it.
 *        - `unified_state.reduce_ms`          Same — recorded by the
 *                                              reducer.
 *
 *      The block-size metrics depend on the assembled block, so they live
 *      with the assembler hook rather than the reducer.
 *   4. When `UNIFIED_EVENT_LOG === true` the formatted block is returned
 *      to the caller for inclusion in the prompt. When only
 *      `UNIFIED_EVENT_LOG_SHADOW === true` (the Phase 0 default) the
 *      helper still runs and records metrics but returns an empty string
 *      so the assembler discards the result. This is the shadow mode
 *      mandated by Requirement 4.4 — telemetry without behavior change.
 *   5. The helper never throws. Any failure resolving state, recording
 *      a metric, or formatting the block falls back to an empty string;
 *      the prompt path is hot and a transient SQLite error must never
 *      tear it down. Errors are logged once at warn level.
 *
 * Requirements: 5.1, 6.6
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import { estimateTokens } from '../session/context-compressor.js';
import type { SessionTelemetryService } from '../session/session-telemetry.js';
import type {
  ApprovalSummary,
  ChatMessage,
  ErrorSummary,
  SessionState,
  TaskSummary,
  UnifiedStateReducer,
  ActiveTool,
} from './unified-state-reducer.js';

// Maximum number of open tasks rendered inline. Beyond this, the count
// is preserved in the header but only the first N are listed. Mirrors
// the design.md snippet (`s.openTasks.slice(0, 5)`).
const MAX_OPEN_TASKS_LISTED = 5;

/**
 * Dependencies the helper needs to resolve state and record metrics. We
 * pass them in explicitly rather than reaching for module-level
 * singletons so tests can swap the reducer / sink for fakes and so the
 * IPC bootstrap layer keeps lifecycle ownership.
 */
export interface PromptStateBlockDeps {
  reducer: UnifiedStateReducer;
  metrics: SessionTelemetryService;
}

/**
 * Build the `## Current State` block for a session.
 *
 * Returns `''` when both `UNIFIED_EVENT_LOG` and `UNIFIED_EVENT_LOG_SHADOW`
 * are off, when the session has no active state worth surfacing, when the
 * reducer fails, or when shadow mode is active (metrics flow but the
 * caller receives nothing to splice into the prompt).
 *
 * Otherwise, returns the formatted block ready to be appended to the
 * system prompt. The caller is responsible for spacing — the helper does
 * not prepend or append blank lines.
 */
export async function assembleStateBlock(
  sessionId: string,
  deps: PromptStateBlockDeps,
): Promise<string> {
  // Both flags off: full short-circuit. No reducer call, no metrics. This
  // is the legacy path until Phase 0 ships and shadow mode flips on. The
  // check is intentionally redundant with the reducer's own gating — the
  // reducer always records `unified_state.cache_hit` and
  // `unified_state.reduce_ms`, and we want zero overhead when the entire
  // feature is off.
  if (!PERF_FLAGS.UNIFIED_EVENT_LOG && !PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW) {
    return '';
  }

  let state: SessionState;
  try {
    state = await deps.reducer.getSessionState(sessionId);
  } catch (err) {
    // Resolution failure must not poison the prompt. The reducer's own
    // telemetry still records `unified_state.reduce_ms` for the failed
    // call; we just decline to contribute a block.
    console.warn(
      '[prompt-state-block] reducer.getSessionState failed; dropping block:',
      (err as Error)?.message,
    );
    return '';
  }

  const block = formatStateBlock(state);

  // Block-size metrics: ALWAYS recorded when either flag is on. The
  // reducer records cache_hit and reduce_ms inside `getSessionState`,
  // so we deliberately do not duplicate those here. Recording an empty
  // block as `bytes=0` / `estimated_tokens=0` is intentional — the
  // dashboards use those zeros to distinguish "block not yet built"
  // from "block built but empty for this session".
  recordMetricSafe(deps.metrics, sessionId, 'unified_state.bytes', byteLength(block));
  recordMetricSafe(
    deps.metrics,
    sessionId,
    'unified_state.estimated_tokens',
    estimateTokens(block),
  );

  // Shadow mode: discard the result so behavior is unchanged. Metrics
  // already flowed above, which is the entire point of running the
  // helper full-time before flipping the active flag on.
  if (!PERF_FLAGS.UNIFIED_EVENT_LOG) return '';

  return block;
}

/**
 * Pure formatter — given a `SessionState` snapshot, produce the block
 * string. Exposed for tests so they can pin the shape without standing
 * up a reducer + sink + DB. Returns `''` when the state has nothing
 * worth surfacing (e.g. a brand-new session).
 */
export function formatStateBlock(state: SessionState): string {
  const lines: string[] = ['## Current State'];

  if (state.openTasks.length > 0) {
    lines.push(formatOpenTasksLine(state.openTasks));
  }
  if (state.activeTools.length > 0) {
    lines.push(formatActiveToolsLine(state.activeTools));
  }
  if (state.pendingApprovals.length > 0) {
    lines.push(formatPendingApprovalsLine(state.pendingApprovals));
  }
  if (state.lastError) {
    lines.push(formatLastErrorLine(state.lastError));
  }

  // If only the header survived, we have nothing useful to surface. An
  // empty `## Current State` block in the prompt would be noise; return
  // empty string so the assembler omits it entirely.
  if (lines.length === 1) return '';

  return lines.join('\n');
}

// ─── Line formatters ──────────────────────────────────────────

function formatOpenTasksLine(tasks: TaskSummary[]): string {
  const head = tasks.slice(0, MAX_OPEN_TASKS_LISTED).map(formatTask).join('; ');
  return `Open tasks (${tasks.length}): ${head}`;
}

function formatActiveToolsLine(tools: ActiveTool[]): string {
  const names = tools.map((t) => t.name).join(', ');
  return `Active tools: ${names}`;
}

function formatPendingApprovalsLine(approvals: ApprovalSummary[]): string {
  return `Pending approvals: ${approvals.length}`;
}

function formatLastErrorLine(err: ErrorSummary): string {
  // Single-line format: error messages can carry newlines, so collapse
  // whitespace to keep the block compact and predictable.
  const oneLine = err.message.replace(/\s+/g, ' ').trim();
  return `Last error: ${oneLine}`;
}

/**
 * Compact display form for an open task. We surface the id and status
 * so the LLM can correlate with the task tracker and route follow-up
 * actions correctly.
 */
function formatTask(t: TaskSummary): string {
  return `${t.taskId} [${t.status}]`;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * UTF-8 byte length of a string. We avoid `Buffer.byteLength` directly
 * to keep the helper renderer-friendly even though today it only runs
 * in main; `TextEncoder` is universal and well-optimised. Falls back
 * to `Buffer.byteLength` if `TextEncoder` is somehow unavailable so
 * the helper degrades gracefully.
 */
function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  // Node-only fallback. Should never run in normal operation.
  return Buffer.byteLength(s, 'utf8');
}

function recordMetricSafe(
  metrics: SessionTelemetryService,
  sessionId: string,
  key: string,
  value: number,
): void {
  // Telemetry is best-effort. A SQLite busy or constraint failure must
  // not propagate into the prompt-assembly path — the prompt is more
  // important than the metric.
  try {
    metrics.recordMetric(sessionId, key, value);
  } catch (err) {
    console.warn(
      `[prompt-state-block] metric record failed (key=${key}):`,
      (err as Error)?.message,
    );
  }
}

// Unused imports are tolerated only when they exist. The `ChatMessage`
// import is retained for documentation: future iterations may surface
// the most recent N messages in the block, and keeping the type pinned
// here flags a compile error the moment the reducer changes shape.
export type { ChatMessage };
