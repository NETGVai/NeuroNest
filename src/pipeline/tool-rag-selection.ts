/**
 * Flag-gated RAG tool selection (Feature 4: RAG_Tool_Selection — task 16.2).
 *
 * Pure decision layer that sits between the chat-message handler and the
 * booted {@link ToolIndex}. Given the paired rollout flags and a (possibly
 * unavailable) index, it decides what the pipeline should send to the LLM and
 * emits the F4 observability counters to the Metrics_Sink.
 *
 * Decision matrix (Requirement 27, 29):
 *
 *   | TOOL_RAG_SELECTION | …_SHADOW | index ready | retrieve | outcome              |
 *   | ------------------ | -------- | ----------- | -------- | -------------------- |
 *   | false              | false    |     —       |   —      | off → Full_Registry  |
 *   | true               |   —      |   true      |  ok      | rag → retrieved subset |
 *   | false              | true     |   true      |  ok      | shadow → Full_Registry + telemetry |
 *   | true/false (shadow)|   —      |  not ready  |   —      | fallback → Full_Registry |
 *   | true/false (shadow)|   —      |   true      |  throws  | fallback → Full_Registry |
 *
 * Notes:
 *   - When neither flag is set, no retrieval is attempted and no telemetry is
 *     emitted — the request is simply Full_Registry (Requirement 27.2). This is
 *     the "RAG fully off" steady state.
 *   - `TOOL_RAG_SELECTION` takes precedence over the shadow flag: while it is
 *     `true` the retrieved subset is sent (Requirement 27.3); the shadow tap
 *     only runs while selection is `false` (Requirement 27.4).
 *   - Any retrieval error OR an unavailable index falls back to Full_Registry
 *     and records a `tool_rag.fallback` event (Requirement 29.1–29.3, 30.2/30.3).
 *   - All telemetry is fail-soft: a Metrics_Sink failure can never break the
 *     chat pipeline.
 *
 * This module is intentionally free of Electron / `ipcMain` dependencies so it
 * can be unit-tested with stub indices and sinks. The integrator
 * (`src/main/ipc.ts` chat-message handler) supplies the booted index via
 * `getToolIndex()` / `isToolIndexReady()` and a `SessionTelemetryService`
 * Metrics_Sink (consistent with the cold-start boot in task 16.1).
 *
 * Requirements: 27.4, 27.5, 27.6, 29
 */

import { DEFAULT_K, type ToolEntry } from './tool-index.js';
import type { MetricsSink } from './tool-index-boot.js';

/** Metrics_Sink key: a retrieval error / unavailable index fell back (Req 29.3). */
export const TOOL_RAG_FALLBACK_KEY = 'tool_rag.fallback';

/** Metrics_Sink key: shadow-mode retrieved-subset size (Req 27.4). */
export const TOOL_RAG_SHADOW_SIZE_KEY = 'tool_rag.shadow_size';

/** Metrics_Sink key: shadow-mode Full_Registry size for the delta (Req 27.4). */
export const TOOL_RAG_FULL_SIZE_KEY = 'tool_rag.full_size';

/**
 * The paired F4 rollout flags, read structurally so callers can pass
 * `PERF_FLAGS` directly without a hard import dependency.
 */
export interface ToolSelectionFlags {
  TOOL_RAG_SELECTION: boolean;
  TOOL_RAG_SELECTION_SHADOW: boolean;
}

/**
 * Minimal structural view of the {@link ToolIndex} surface this layer needs.
 * Satisfied by the real `ToolIndex`; lets tests pass a lightweight stand-in.
 */
export interface RetrievableToolIndex {
  isReady(): boolean;
  retrieve(query: string, k?: number): Promise<ToolEntry[]>;
}

/** Which branch of the decision matrix was taken. */
export type ToolSelectionMode = 'off' | 'rag' | 'shadow' | 'fallback';

/** Outcome of a single {@link selectToolsForChat} call. */
export interface ToolSelectionDecision {
  /** The branch taken. */
  mode: ToolSelectionMode;
  /**
   * The retrieved subset when one was computed (`rag` or `shadow`), else `null`.
   * In `shadow` mode this is observation-only and MUST NOT alter the request.
   */
  retrieved: ToolEntry[] | null;
  /**
   * Whether the pipeline should send the unfiltered Full_Registry. `true` for
   * `off`, `shadow`, and `fallback`; `false` only when the retrieved subset is
   * sent (`rag`).
   */
  useFullRegistry: boolean;
  /** Whether a fallback to Full_Registry occurred (index unavailable / error). */
  fellBack: boolean;
}

export interface SelectToolsForChatOptions {
  /** The booted index, or `null` when boot never started / construction failed. */
  index: RetrievableToolIndex | null;
  /** The retrieval query (the user message). */
  query: string;
  /** The paired F4 rollout flags (e.g. `PERF_FLAGS`). */
  flags: ToolSelectionFlags;
  /** Size of the Full_Registry, used for the shadow-mode size delta. */
  fullRegistrySize: number;
  /** Top-K for retrieval. Defaults to {@link DEFAULT_K}. */
  k?: number;
  /** Metrics_Sink for the F4 counters (optional; telemetry is fail-soft). */
  metricsSink?: MetricsSink;
  /** Session id recorded alongside the metrics. Defaults to `null` (global). */
  sessionId?: string | null;
}

/**
 * Decide what tool set the chat pipeline should send to the LLM under the
 * paired F4 flags, computing retrieval and emitting telemetry as required.
 *
 * Never throws — retrieval errors and Metrics_Sink failures are absorbed and
 * surfaced as a Full_Registry fallback so the chat handler always gets a usable
 * decision (Requirement 29).
 */
export async function selectToolsForChat(
  opts: SelectToolsForChatOptions,
): Promise<ToolSelectionDecision> {
  const { index, query, flags, fullRegistrySize, metricsSink } = opts;
  const k = opts.k ?? DEFAULT_K;
  const sessionId = opts.sessionId ?? null;

  const wantRag = flags.TOOL_RAG_SELECTION || flags.TOOL_RAG_SELECTION_SHADOW;

  // RAG fully off: send Full_Registry unchanged. No retrieval, no telemetry
  // (Requirement 27.2).
  if (!wantRag) {
    return { mode: 'off', retrieved: null, useFullRegistry: true, fellBack: false };
  }

  // Index unavailable (never booted, still cold-starting, failed, or budget
  // exceeded): substitute Full_Registry and record the fallback
  // (Requirement 29.3, 30.2/30.3).
  if (!index || !safeIsReady(index)) {
    recordMetricSafe(metricsSink, sessionId, TOOL_RAG_FALLBACK_KEY, 1);
    return { mode: 'fallback', retrieved: null, useFullRegistry: true, fellBack: true };
  }

  // Attempt retrieval. Any throw (including an EmbeddingProvider error mid-query)
  // falls back to Full_Registry (Requirement 29.1, 29.2).
  let retrieved: ToolEntry[];
  try {
    retrieved = await index.retrieve(query, k);
  } catch {
    recordMetricSafe(metricsSink, sessionId, TOOL_RAG_FALLBACK_KEY, 1);
    return { mode: 'fallback', retrieved: null, useFullRegistry: true, fellBack: true };
  }

  // Active selection: send the retrieved subset to the LLM (Requirement 27.3).
  if (flags.TOOL_RAG_SELECTION) {
    return { mode: 'rag', retrieved, useFullRegistry: false, fellBack: false };
  }

  // Shadow mode (selection off, shadow on): compute the retrieval for
  // observation and emit the size delta, but do NOT alter the request — the
  // Full_Registry is still sent (Requirement 27.4).
  recordMetricSafe(metricsSink, sessionId, TOOL_RAG_SHADOW_SIZE_KEY, retrieved.length);
  recordMetricSafe(metricsSink, sessionId, TOOL_RAG_FULL_SIZE_KEY, fullRegistrySize);
  return { mode: 'shadow', retrieved, useFullRegistry: true, fellBack: false };
}

function safeIsReady(index: RetrievableToolIndex): boolean {
  try {
    return index.isReady() === true;
  } catch {
    return false;
  }
}

function recordMetricSafe(
  sink: MetricsSink | undefined,
  sessionId: string | null,
  key: string,
  value: number,
): void {
  if (!sink) return;
  if (!Number.isFinite(value)) return;
  try {
    sink.recordMetric(sessionId, key, value);
  } catch {
    // Telemetry is fail-soft — a sink failure must never break the chat path.
  }
}
