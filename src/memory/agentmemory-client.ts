/**
 * AgentMemory Client — integrates with the agentmemory service (localhost:3111)
 * for persistent, searchable, cross-session memory.
 *
 * This is an optional enhancement layer. If agentmemory is not running,
 * all methods gracefully return empty/null results and NeuroNest continues
 * with its existing memory systems (SharedMemory + SQLite long_term_memory).
 *
 * Phases implemented:
 *   1. Service Management — health check, auto-start detection
 *   2. Memory Capture — store observations after agent execution
 *   3. Memory Retrieval — inject relevant past knowledge into prompts
 *   4. Cross-Agent Sharing — all agents share project-scoped memory
 */

import { PERF_FLAGS } from '../main/performance/feature-flags';
import { UntrustedContextBuilder, wrapUntrusted } from '../pipeline/untrusted-context';
import { recordUntrustedWrap, type MetricsSink } from '../pipeline/untrusted-telemetry';

const DEFAULT_PORT = 3111;
const DEFAULT_HOST = '127.0.0.1';
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const REQUEST_TIMEOUT = 5000; // 5 seconds for non-search requests
const SEARCH_TIMEOUT = 8000; // 8 seconds for search (may involve embeddings)
const TOKEN_BUDGET = 2000; // max tokens to inject from memory

export interface MemoryObservation {
  project: string;
  session?: string;
  content: string;
  agent?: string;
  tool?: string;
  file?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  content: string;
  score: number;
  session?: string;
  agent?: string;
  timestamp?: string;
  type?: string;
}

export interface MemoryContext {
  memories: MemorySearchResult[];
  tokenCount: number;
  source: 'agentmemory' | 'fallback';
}

export interface AgentMemoryStatus {
  available: boolean;
  healthy: boolean;
  version?: string;
  memoryCount?: number;
  sessionCount?: number;
}

export class AgentMemoryClient {
  private baseUrl: string;
  private available = false;
  private lastHealthCheck = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(port?: number, host?: string) {
    this.baseUrl = `http://${host || DEFAULT_HOST}:${port || DEFAULT_PORT}`;
  }

  // ── Phase 1: Service Management ──

  /**
   * Check if agentmemory service is running and healthy.
   * Caches result for 30 seconds to avoid excessive pinging.
   */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastHealthCheck < HEALTH_CHECK_INTERVAL) {
      return this.available;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${this.baseUrl}/agentmemory/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.available = resp.ok;
      this.lastHealthCheck = now;
      return this.available;
    } catch {
      this.available = false;
      this.lastHealthCheck = now;
      return false;
    }
  }

  /**
   * Get detailed status of the agentmemory service.
   */
  async getStatus(): Promise<AgentMemoryStatus> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${this.baseUrl}/agentmemory/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) return { available: false, healthy: false };
      const data = await resp.json() as Record<string, unknown>;
      return {
        available: true,
        healthy: true,
        version: data.version as string | undefined,
        memoryCount: data.memories as number | undefined,
        sessionCount: data.sessions as number | undefined,
      };
    } catch {
      return { available: false, healthy: false };
    }
  }

  /**
   * Start periodic health monitoring.
   */
  startMonitoring(onStatusChange?: (available: boolean) => void): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      const wasAvailable = this.available;
      await this.isAvailable();
      if (wasAvailable !== this.available && onStatusChange) {
        onStatusChange(this.available);
      }
    }, HEALTH_CHECK_INTERVAL);
    // Initial check
    this.isAvailable().then((avail) => {
      if (onStatusChange) onStatusChange(avail);
    });
  }

  /**
   * Stop periodic health monitoring.
   */
  stopMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── Phase 2: Memory Capture (Write Path) ──

  /**
   * Store an observation from an agent's execution.
   * Called after each agent_complete event.
   */
  async observe(observation: MemoryObservation): Promise<boolean> {
    if (!this.available) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const resp = await fetch(`${this.baseUrl}/agentmemory/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(observation),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Save a specific fact/insight to long-term memory.
   * Called when user uses /remember command.
   */
  async remember(project: string, content: string, metadata?: Record<string, unknown>): Promise<boolean> {
    if (!this.available) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const resp = await fetch(`${this.baseUrl}/agentmemory/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, content, metadata }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Notify agentmemory that a session has started.
   */
  async sessionStart(project: string, sessionId: string, projectPath?: string): Promise<void> {
    if (!this.available) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      await fetch(`${this.baseUrl}/agentmemory/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, session: sessionId, path: projectPath }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch { /* non-fatal */ }
  }

  /**
   * Notify agentmemory that a session has ended.
   * Triggers consolidation (compress observations into structured memory).
   */
  async sessionEnd(project: string, sessionId: string): Promise<void> {
    if (!this.available) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      await fetch(`${this.baseUrl}/agentmemory/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, session: sessionId }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch { /* non-fatal */ }
  }

  // ── Phase 3: Memory Retrieval (Read Path) ──

  /**
   * Search for relevant memories given a query.
   * Returns top-K results within the token budget.
   */
  async search(project: string, query: string, limit?: number): Promise<MemorySearchResult[]> {
    if (!this.available) return [];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);
      const resp = await fetch(`${this.baseUrl}/agentmemory/smart-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project,
          query,
          limit: limit || 5,
          token_budget: TOKEN_BUDGET,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) return [];
      const data = await resp.json() as { results?: MemorySearchResult[] };
      return data.results || [];
    } catch {
      return [];
    }
  }

  /**
   * Get context for a new session — project profile + relevant memories.
   * This is the main injection point for the pipeline.
   */
  async getContext(project: string, query: string): Promise<MemoryContext> {
    const memories = await this.search(project, query);
    if (memories.length === 0) {
      return { memories: [], tokenCount: 0, source: 'agentmemory' };
    }
    // Estimate token count (rough: 4 chars per token)
    const totalChars = memories.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const tokenCount = Math.ceil(totalChars / 4);
    return { memories, tokenCount, source: 'agentmemory' };
  }

  /**
   * Format memories into a context string suitable for injection into prompts.
   *
   * When `PERF_FLAGS.UNTRUSTED_SOURCE_WRAP` is enabled (F1), the retrieved
   * memory content is routed through the Untrusted_Wrapper via an
   * {@link UntrustedContextBuilder} so the LLM treats recalled memories as
   * untrusted data rather than operator instructions. The human-readable
   * "RECALLED MEMORIES" header/footer remain as operator framing around the
   * delimited untrusted block. When the flag is disabled, the pre-existing
   * unwrapped bullet-list path is preserved exactly.
   *
   * When `metricsSink` is supplied and the flag is on, each wrapped memory
   * segment records `untrusted_wrap.invocations` +
   * `untrusted_wrap.wrapped_bytes` to the Metrics_Sink (Requirements 5.5, 5.6).
   * Telemetry is fail-soft and recorded once per actual wrap (one per memory),
   * so counts are never double-recorded.
   *
   * Validates: Requirement 5.4, 5.5, 5.6
   */
  formatForPrompt(
    memories: MemorySearchResult[],
    metricsSink?: MetricsSink | null,
    sessionId: string | null = null,
  ): string {
    if (memories.length === 0) return '';

    if (PERF_FLAGS.UNTRUSTED_SOURCE_WRAP) {
      // F1 on-path: aggregate the untrusted memory content into a single
      // delimited block. The builder frames each segment via the same scheme
      // as wrapUntrusted; label per design is `memory:${agent}` or `memory`.
      const builder = new UntrustedContextBuilder('agentmemory-client');
      for (const mem of memories) {
        const label = mem.agent ? `memory:${mem.agent}` : 'memory';
        builder.append(mem.content, label);
        // Record F1 telemetry for this single wrapped segment, using the same
        // framing the builder applies (Requirements 5.5, 5.6).
        recordUntrustedWrap(metricsSink, wrapUntrusted(mem.content, label), sessionId);
      }
      const wrapped = builder.build().content;
      return (
        '\n\n--- RECALLED MEMORIES (from past sessions) ---\n' +
        'The following knowledge was automatically recalled from previous work on this project:\n\n' +
        wrapped +
        '\n\n--- END RECALLED MEMORIES ---\n'
      );
    }

    // F1 off-path: pre-existing unwrapped behavior (preserved exactly).
    let context = '\n\n--- RECALLED MEMORIES (from past sessions) ---\n';
    context += 'The following knowledge was automatically recalled from previous work on this project:\n\n';
    for (const mem of memories) {
      const agentTag = mem.agent ? ` [${mem.agent}]` : '';
      const timeTag = mem.timestamp ? ` (${new Date(mem.timestamp).toLocaleDateString()})` : '';
      context += `• ${mem.content}${agentTag}${timeTag}\n`;
    }
    context += '\n--- END RECALLED MEMORIES ---\n';
    return context;
  }

  // ── Phase 4: Cross-Agent Sharing ──

  /**
   * Store an observation tagged with the specific agent that produced it.
   * All agents share the same project memory but observations are attributed.
   */
  async observeFromAgent(
    project: string,
    agentId: string,
    agentName: string,
    content: string,
    sessionId?: string,
  ): Promise<boolean> {
    return this.observe({
      project,
      session: sessionId,
      content: `[${agentName}] ${content}`,
      agent: agentId,
      metadata: { agentId, agentName },
    });
  }

  /**
   * Search memories with optional agent filter.
   * If agentId is provided, prioritizes memories from that agent.
   */
  async searchForAgent(project: string, query: string, agentId?: string): Promise<MemorySearchResult[]> {
    const results = await this.search(project, query);
    if (!agentId || results.length === 0) return results;
    // Sort: memories from the same agent first, then others
    return results.sort((a, b) => {
      const aMatch = a.agent === agentId ? 1 : 0;
      const bMatch = b.agent === agentId ? 1 : 0;
      return bMatch - aMatch;
    });
  }

  /**
   * Forget/delete memories for a project (e.g., when project is deleted).
   */
  async forget(project: string, query?: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const resp = await fetch(`${this.baseUrl}/agentmemory/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, query: query || '*' }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp.ok;
    } catch {
      return false;
    }
  }
}
