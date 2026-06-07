/**
 * ToolIndex — RAG-based tool selection (Feature 4: RAG_Tool_Selection)
 *
 * Aggregates every available tool into a single embedded catalog and returns
 * the top-K most relevant tools per turn, always unioned with a fixed set of
 * built-in "always available" tools. The algorithm is a cosine-similarity
 * ranking with a deterministic id tie-break and an ALWAYS_AVAILABLE union,
 * wired to NeuroNest's three tool sources and the pluggable EmbeddingProvider
 * port.
 *
 * Requirements: 23, 24.3, 24.4, 25, 26, 28, 31
 */

import type { ToolSystem } from '../tools/tool-system.js';
import type { MCPServerManager } from '../mcp/mcp-server-manager.js';
import type { ChatToolDispatchTable } from '../agent-skills/chat-tool-registry.js';
import {
  EmbeddingDaemonProvider,
  type EmbeddingProvider,
} from './embedding-daemon-provider.js';
import { EmbeddingDaemonClient } from '../indexing/embedding-daemon.js';

// Re-export the embedding port from this module so consumers can import the
// ToolIndex public surface (`ToolIndex`, `EmbeddingProvider`, `ALWAYS_AVAILABLE`,
// `ToolEntry`) from a single place, matching the design's components table.
export type { EmbeddingProvider } from './embedding-daemon-provider.js';

// ─── Public types ───────────────────────────────────────────────

/** Origin registry that contributed a tool to the unified catalog. */
export type ToolSource = 'tool-system' | 'mcp' | 'chat-dispatch';

/**
 * A single tool in the unified catalog. `source` records every registry that
 * advertised this `id` (Requirement 23.2, 23.3). `schema` carries the tool's
 * JSON input schema for the ChatRequest passthrough output form.
 */
export interface ToolEntry {
  id: string;
  description: string;
  source: ToolSource[];
  schema?: Record<string, unknown>;
}

/**
 * OpenAI-compatible function-tool object emitted by the ChatRequest passthrough
 * output form. Structurally compatible with `ChatRequest.tools` (Requirement
 * 28.2). Named distinctly from the existing `ToolDefinition` (shared/types) to
 * avoid colliding with the internal tool-definition shape.
 */
export interface ChatRequestTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Built-in tools that are always offered to the model regardless of similarity
 * (Requirement 25.3). The retrieval result always contains every entry here.
 */
export const ALWAYS_AVAILABLE: readonly string[] = [
  'bash',
  'file-read',
  'file-write',
  'file-edit',
  'grep',
  'web-search',
  'web-fetch',
  'agent',
];

/** Default top-K when the caller does not specify one (Requirement 25.2). */
export const DEFAULT_K = 16;

/**
 * Injectable tool sources. Each is optional and structurally typed so callers
 * (and tests) can supply minimal stand-ins, and so a missing/unavailable source
 * never hard-crashes Cold_Start_Indexing.
 */
export interface ToolIndexSources {
  toolSystem?: Pick<ToolSystem, 'list'>;
  mcpManager?: Pick<MCPServerManager, 'getToolRegistry'>;
  chatDispatch?: ChatToolDispatchTable;
}

export interface ToolIndexOptions {
  embeddingProvider?: EmbeddingProvider;
  sources?: ToolIndexSources;
}

// ─── Internal helpers ───────────────────────────────────────────

/**
 * Cosine similarity between two vectors. Returns 0 when either vector is empty,
 * has a zero norm, or the dimensions disagree (compared over the shared prefix).
 * Never throws — a malformed embedding degrades to a 0 score, not a crash.
 */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(sim) ? sim : 0;
}

/** Coerce a caller-supplied K into a non-negative integer. */
function normalizeK(k: number): number {
  if (!Number.isFinite(k)) return DEFAULT_K;
  return Math.max(0, Math.floor(k));
}

// ─── ToolIndex ──────────────────────────────────────────────────

/**
 * Aggregates tools from {@link ToolSystem}, {@link MCPServerManager}'s tool
 * registry, and the {@link ChatToolDispatchTable} into a single embedded
 * catalog, then serves deterministic top-K retrieval per turn.
 */
export class ToolIndex {
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly sources: ToolIndexSources;

  /** Deduplicated catalog keyed by stable tool id (Requirement 23.1). */
  private readonly catalog = new Map<string, ToolEntry>();
  /** Per-tool description embeddings, keyed by the same id. */
  private readonly embeddings = new Map<string, number[]>();

  private ready = false;

  constructor(opts?: ToolIndexOptions) {
    this.sources = opts?.sources ?? {};
    this.embeddingProvider =
      opts?.embeddingProvider ?? ToolIndex.createDefaultEmbeddingProvider();
  }

  /**
   * Default EmbeddingProvider when none is injected (Requirement 24.2): an
   * {@link EmbeddingDaemonProvider} wrapping a default-configured daemon client.
   * The integrator (boot path) is expected to inject a started provider; this
   * fallback is constructed defensively so construction never throws.
   */
  private static createDefaultEmbeddingProvider(): EmbeddingProvider {
    const client = new EmbeddingDaemonClient({
      model: 'nomic-embed-text',
      provider: 'local',
      endpoint: 'http://localhost:11434',
      maxMemoryMB: 512,
    });
    return new EmbeddingDaemonProvider(client);
  }

  /**
   * Cold_Start_Indexing: aggregate every tool from the configured sources,
   * deduplicate on id (recording contributing sources), and embed every
   * description. Sets `ready` on success.
   *
   * If the EmbeddingProvider errors while embedding any description, the index
   * marks itself unavailable and `ready` stays `false` (Requirement 24.4).
   * Runs at most meaningfully once; re-running rebuilds the catalog.
   */
  async init(): Promise<void> {
    this.ready = false;
    this.catalog.clear();
    this.embeddings.clear();

    this.aggregate();

    try {
      // Embed every description. Promise.all is all-or-nothing: a single
      // rejection leaves the index unavailable (Requirement 24.3, 24.4).
      const entries = Array.from(this.catalog.values());
      const vectors = await Promise.all(
        entries.map((entry) => this.embeddingProvider.embed(entry.description)),
      );
      entries.forEach((entry, i) => {
        this.embeddings.set(entry.id, vectors[i]);
      });
    } catch {
      this.markUnavailable();
      return;
    }

    this.ready = true;
  }

  /**
   * Aggregate tools from all three sources into the deduplicated catalog. Each
   * source is guarded independently so an unavailable or throwing source is
   * skipped rather than aborting indexing (Requirement 23).
   */
  private aggregate(): void {
    // 1) ToolSystem — `list()` returns ToolDefinition[] (id is `id`).
    try {
      const toolSystem = this.sources.toolSystem;
      if (toolSystem && typeof toolSystem.list === 'function') {
        for (const def of toolSystem.list()) {
          this.addToCatalog(def.id, def.description ?? '', 'tool-system', def.inputSchema);
        }
      }
    } catch {
      // Source unavailable — skip.
    }

    // 2) MCP — `getToolRegistry()` returns Map<name, MCPTool> (id is `name`).
    try {
      const mcpManager = this.sources.mcpManager;
      if (mcpManager && typeof mcpManager.getToolRegistry === 'function') {
        for (const tool of mcpManager.getToolRegistry().values()) {
          this.addToCatalog(tool.name, tool.description ?? '', 'mcp', tool.inputSchema);
        }
      }
    } catch {
      // Source unavailable — skip.
    }

    // 3) Chat dispatch — ReadonlyMap<id, ExecutableToolDefinition>.
    try {
      const chatDispatch = this.sources.chatDispatch;
      if (chatDispatch && typeof chatDispatch.values === 'function') {
        for (const def of chatDispatch.values()) {
          this.addToCatalog(
            def.id,
            def.description ?? '',
            'chat-dispatch',
            def.inputSchema,
          );
        }
      }
    } catch {
      // Source unavailable — skip.
    }
  }

  /**
   * Insert or merge a tool into the catalog. On a duplicate id, the first-seen
   * description/schema are retained and the new source is recorded once
   * (Requirement 23.3).
   */
  private addToCatalog(
    id: string,
    description: string,
    source: ToolSource,
    schema?: Record<string, unknown>,
  ): void {
    if (!id) return;

    const existing = this.catalog.get(id);
    if (existing) {
      if (!existing.source.includes(source)) {
        existing.source.push(source);
      }
      return;
    }

    this.catalog.set(id, {
      id,
      description,
      source: [source],
      schema,
    });
  }

  /**
   * Retrieve the top-K tools by cosine similarity to `query`, unioned with all
   * ALWAYS_AVAILABLE tools (Requirement 25, 26).
   *
   * Throws if the index is not ready (Requirement 25.7) so the pipeline's
   * fallback path substitutes Full_Registry rather than receiving a partial
   * result. A mid-query embedding error propagates as a thrown error
   * (Requirement 29.2).
   */
  async retrieve(query: string, k: number = DEFAULT_K): Promise<ToolEntry[]> {
    if (!this.isReady()) {
      throw new Error('ToolIndex is not ready: cold-start indexing has not completed');
    }

    const kk = normalizeK(k);
    const queryVec = await this.embeddingProvider.embed(query);

    // Score every catalog entry, then sort by similarity desc with a
    // deterministic ascending id tie-break (Requirement 26).
    const scored = Array.from(this.catalog.values()).map((entry) => ({
      entry,
      score: cosineSimilarity(queryVec, this.embeddings.get(entry.id) ?? []),
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.entry.id < b.entry.id) return -1;
      if (a.entry.id > b.entry.id) return 1;
      return 0;
    });

    const topK = scored.slice(0, kk);

    // Union with ALWAYS_AVAILABLE-resolved entries, deduplicated (Requirement
    // 25.1, 25.3, 25.4, 25.6).
    const result: ToolEntry[] = [];
    const seen = new Set<string>();

    for (const { entry } of topK) {
      result.push(entry);
      seen.add(entry.id);
    }

    for (const id of ALWAYS_AVAILABLE) {
      if (seen.has(id)) continue;
      result.push(this.catalog.get(id) ?? ToolIndex.synthesizeAlwaysAvailable(id));
      seen.add(id);
    }

    return result;
  }

  /**
   * Build a placeholder entry for an ALWAYS_AVAILABLE tool that is not present
   * in any source registry, so the result always contains every always-available
   * tool (Requirement 25.3, 25.6).
   */
  private static synthesizeAlwaysAvailable(id: string): ToolEntry {
    return {
      id,
      description: 'Always-available built-in tool.',
      source: [],
    };
  }

  /**
   * System_Prompt_Rendering output form (Requirement 28.1). Deterministic text
   * block listing each selected tool.
   */
  renderForSystemPrompt(tools: ToolEntry[]): string {
    const lines = tools.map((t) => `- ${t.id}: ${t.description}`);
    return ['Available tools:', ...lines].join('\n');
  }

  /**
   * ChatRequest_Tools_Passthrough output form (Requirement 28.2). Emits the
   * OpenAI function-tool shape, carrying the same set of tool identifiers as
   * {@link renderForSystemPrompt} over the same selection (Requirement 28.3).
   */
  renderForChatRequestTools(tools: ToolEntry[]): ChatRequestTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.id,
        description: t.description,
        parameters: t.schema ?? {},
      },
    }));
  }

  /** Whether Cold_Start_Indexing completed successfully. */
  isReady(): boolean {
    return this.ready;
  }

  /** Number of deduplicated tools in the catalog. */
  size(): number {
    return this.catalog.size;
  }

  /**
   * Mark the index unavailable (Requirement 24.4, 30.3/30.4). Used by the boot
   * path when init fails or exceeds the cold-start budget; while unavailable,
   * `retrieve` throws and the pipeline substitutes Full_Registry.
   */
  markUnavailable(): void {
    this.ready = false;
  }
}
