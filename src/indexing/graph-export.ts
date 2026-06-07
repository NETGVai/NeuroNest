/**
 * Indexing graph export — F10_Encoded_Surface (Feature 10, GCF_Wire_Format).
 *
 * Serializes an indexing graph extract (symbols, edges, distance groups) for
 * LLM consumption. This is the `indexing` surface of the four F10_Encoded_
 * Surfaces enumerated in design.md. The graph extract shape mirrors the
 * `CallGraphEngine` records (`CallGraphNode` / `CallGraphEdge`,
 * `src/indexing/call-graph-engine.ts`) that feed the LLM when the indexing
 * pipeline surfaces structure for a query.
 *
 * Paired-flag gating (Requirement 54.3, Requirement 55), matching the
 * project's PERF_FLAGS paired-rollout pattern:
 *
 *   - `GCF_WIRE_FORMAT=true`  → encode the extract through `encodeGraph` and
 *     send the GCF text to the LLM. Emits `gcf.indexing.savings_ratio`
 *     (Requirement 55.3). Falls back to JSON when `encodeGraph` returns null
 *     (Requirement 51.4).
 *   - `GCF_WIRE_FORMAT=false` AND `GCF_WIRE_FORMAT_SHADOW=true` → compute the
 *     GCF encoding for telemetry only, emit `gcf.shadow_size_bytes`,
 *     `gcf.json_size_bytes`, and `gcf.shadow_savings_ratio` (Requirement
 *     55.2), but keep the pre-existing JSON serialization on the LLM-bound
 *     path (Requirement 54.5).
 *   - both flags `false` → skip GCF computation entirely (Requirement 55.4)
 *     and emit the JSON serialization unchanged.
 *
 * Failure contract: telemetry is best-effort and fully fail-soft — a sink (or
 * logger) failure can never break the serialization path. `encodeGraph` never
 * throws (it returns null on error), so the LLM-bound payload is always a
 * well-formed string.
 *
 * Requirements: 54.3, 55
 */

import { encodeGraph } from '../serializers/gcf-encoder.js';
import type { GraphPayload } from '../serializers/gcf-encoder.js';
import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import { logger } from '../utils/logger.js';

/** Surface identifier used in the `gcf.<surface>.savings_ratio` key. */
const SURFACE = 'indexing';

/** Active-path telemetry key (Requirement 55.3). */
const SAVINGS_RATIO_KEY = `gcf.${SURFACE}.savings_ratio`;

/**
 * Structural Metrics_Sink type — mirrored locally (as in
 * `orchestrator-manager.ts` / `tool-call-recovery.ts`) so this module does not
 * depend on `SessionTelemetryService` directly. Any object exposing
 * `recordMetric(sessionId, key, value)` satisfies it.
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/**
 * A single node in an indexing graph extract. Mirrors the LLM-relevant fields
 * of `CallGraphNode` plus the relevance/locality scoring the indexing pipeline
 * attaches when it selects a sub-graph for a query.
 */
export interface GraphExtractNode {
  /** Stable node id (e.g. the `CallGraphNode.id`). */
  id: string;
  /** Symbol name (e.g. `CallGraphNode.name`). */
  name: string;
  /** Source file the symbol lives in; used as GCF `provenance`. */
  filePath?: string;
  /** Symbol kind. Defaults to `function` when unknown. */
  kind?: 'function' | 'class' | 'method' | 'variable' | 'type';
  /** Relevance score (similarity / centrality), 0..1. Defaults to 0. */
  score?: number;
  /** BFS distance group from the query seed. Defaults to 0. */
  distance?: number;
}

/** A directed edge in an indexing graph extract. */
export interface GraphExtractEdge {
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Edge type (e.g. `calls`). Defaults to `calls`. */
  edgeType?: string;
}

/**
 * An indexing graph extract bound for the LLM: a selected sub-graph of
 * symbols, the edges between them, and their distance grouping.
 */
export interface GraphExtract {
  /** Optional tool/source label carried into the GCF payload. */
  tool?: string;
  /** Selected symbols (nodes). */
  nodes: GraphExtractNode[];
  /** Edges between the selected symbols. */
  edges?: GraphExtractEdge[];
  /** Optional token-budget metadata passed through to GCF. */
  tokenBudget?: number;
  /** Optional tokens-used metadata passed through to GCF. */
  tokensUsed?: number;
}

/** Encoding used for the LLM-bound payload. */
export type GraphEncoding = 'gcf' | 'json';

/** Result of serializing a graph extract for the LLM. */
export interface SerializedGraphExtract {
  /** The string to send to the LLM: GCF text when active, else JSON. */
  payload: string;
  /** Which encoding the LLM-bound `payload` uses. */
  encoding: GraphEncoding;
}

/** Options for {@link serializeGraphExtract}. */
export interface SerializeGraphExtractOptions {
  /** Session id for symbol dedup (forwarded to `encodeGraph`) and telemetry. */
  sessionId?: string;
  /**
   * Metrics_Sink to record GCF telemetry into (e.g.
   * `SessionTelemetryService`). When omitted, telemetry is logged via the
   * shared logger instead (still fail-soft).
   */
  metricsSink?: MetricsSink;
}

/**
 * Map a {@link GraphExtract} onto the GCF {@link GraphPayload} shape, supplying
 * safe defaults for the fields the encoder treats as required.
 */
export function toGraphPayload(extract: GraphExtract): GraphPayload {
  return {
    tool: extract.tool ?? SURFACE,
    tokenBudget: extract.tokenBudget,
    tokensUsed: extract.tokensUsed,
    symbols: extract.nodes.map((n) => ({
      qualifiedName: n.name,
      kind: n.kind ?? 'function',
      score: n.score ?? 0,
      provenance: n.filePath ?? '',
      distance: n.distance ?? 0,
    })),
    edges: (extract.edges ?? []).map((e) => ({
      source: e.source,
      target: e.target,
      edgeType: e.edgeType ?? 'calls',
    })),
  };
}

/**
 * Serialize an indexing graph extract for LLM consumption under the F10
 * paired-flag pattern.
 *
 * @returns the LLM-bound payload and the encoding it uses. The pre-existing
 *   JSON serialization is always the fallback, so callers receive a
 *   well-formed string in every flag configuration.
 */
export function serializeGraphExtract(
  extract: GraphExtract,
  opts?: SerializeGraphExtractOptions,
): SerializedGraphExtract {
  // Pre-existing serialization — the backward-compatible baseline and the
  // deterministic fallback for every branch below.
  const json = JSON.stringify(extract);

  const active = PERF_FLAGS.GCF_WIRE_FORMAT === true;
  const shadow = PERF_FLAGS.GCF_WIRE_FORMAT_SHADOW === true;

  // Requirement 55.4: both flags off → skip GCF computation entirely.
  if (!active && !shadow) {
    return { payload: json, encoding: 'json' };
  }

  const sessionId = opts?.sessionId ?? null;
  const encoded = encodeGraph(toGraphPayload(extract), {
    sessionId: opts?.sessionId,
  });

  const jsonBytes = Buffer.byteLength(json, 'utf8');

  if (active) {
    // Requirement 54.3 + 55.3: send GCF to the LLM and emit the active
    // savings-ratio. Requirement 51.4: fall back to JSON when encoding fails.
    if (encoded === null) {
      return { payload: json, encoding: 'json' };
    }
    const gcfBytes = Buffer.byteLength(encoded, 'utf8');
    emitMetric(
      opts?.metricsSink,
      sessionId,
      SAVINGS_RATIO_KEY,
      savingsRatio(jsonBytes, gcfBytes),
    );
    return { payload: encoded, encoding: 'gcf' };
  }

  // Shadow mode (active=false, shadow=true). Requirement 55.2: compute both
  // encodings for telemetry only and keep JSON on the LLM-bound path.
  if (encoded !== null) {
    const gcfBytes = Buffer.byteLength(encoded, 'utf8');
    emitMetric(opts?.metricsSink, sessionId, 'gcf.shadow_size_bytes', gcfBytes);
    emitMetric(opts?.metricsSink, sessionId, 'gcf.json_size_bytes', jsonBytes);
    emitMetric(
      opts?.metricsSink,
      sessionId,
      'gcf.shadow_savings_ratio',
      savingsRatio(jsonBytes, gcfBytes),
    );
  }
  return { payload: json, encoding: 'json' };
}

/**
 * Fraction of bytes saved by GCF vs JSON: `(json - gcf) / json`, clamped to a
 * finite value. Returns 0 when the JSON baseline is empty.
 */
function savingsRatio(jsonBytes: number, gcfBytes: number): number {
  if (jsonBytes <= 0) return 0;
  const ratio = (jsonBytes - gcfBytes) / jsonBytes;
  return Number.isFinite(ratio) ? ratio : 0;
}

/**
 * Record a single metric, fully fail-soft. When no Metrics_Sink is supplied
 * (or the sink throws), the observation is logged instead so a telemetry
 * regression can never break the serialization path.
 */
function emitMetric(
  sink: MetricsSink | undefined,
  sessionId: string | null,
  key: string,
  value: number,
): void {
  if (!Number.isFinite(value)) return;
  if (sink) {
    try {
      sink.recordMetric(sessionId, key, value);
      return;
    } catch (err) {
      logger.warn(
        '[graph-export] Metrics_Sink emit failed; falling back to log:',
        (err as Error)?.message,
      );
    }
  }
  logger.debug('[graph-export] metric', { key, value, sessionId });
}
