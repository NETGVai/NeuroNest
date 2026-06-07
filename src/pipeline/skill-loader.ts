/**
 * Skill_Loader — lazy-loads agent skill fragments by domain, respecting token budgets.
 *
 * Filters the Agent_Registry by domain tags, maintains a dependency graph with
 * topological ordering, and supports garbage collection of unused skills.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.6
 */

import type { SkillFragment, SkillLoaderConfig } from './types/deerflow-types.js';
import { wrapUntrusted } from './untrusted-context.js';
import { recordUntrustedWrap, type MetricsSink } from './untrusted-telemetry.js';
import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import { computeInputTokenBudget, resolveBudgetInputs } from './token-budget.js';
import { getActiveContextLength } from './active-model.js';

// ─── Default configuration ──────────────────────────────────────
const DEFAULT_CONFIG: SkillLoaderConfig = {
  tokenBudgetFraction: 0.50,
  contextWindowSize: 8192,
};

// ─── SkillLoader ────────────────────────────────────────────────
export class SkillLoader {
  private loaded: Map<string, SkillFragment> = new Map();
  private dependencyGraph: Map<string, string[]> = new Map();
  private readonly config: SkillLoaderConfig;
  private registry: Map<string, SkillFragment> = new Map();
  /**
   * Optional Metrics_Sink for F1 wrap telemetry. When set, every
   * Untrusted_Wrapper wrap performed by {@link renderSkillBody} records
   * `untrusted_wrap.invocations` / `untrusted_wrap.wrapped_bytes`
   * (Requirements 5.5, 5.6). Fail-soft and entirely optional.
   */
  private metricsSink: MetricsSink | null = null;
  /** Session id attached to F1 wrap metric samples. Null records a global metric. */
  private telemetrySessionId: string | null = null;

  constructor(config?: Partial<SkillLoaderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Attach a Metrics_Sink so F1 Untrusted_Source_Wrapper telemetry
   * (`untrusted_wrap.invocations` / `untrusted_wrap.wrapped_bytes`) is recorded
   * on each wrapped skill body (Requirements 5.5, 5.6). Optional and fail-soft;
   * when unset, wrap telemetry is logged instead of recorded.
   */
  setMetricsSink(sink: MetricsSink | null, sessionId: string | null = null): void {
    this.metricsSink = sink;
    this.telemetrySessionId = sessionId;
  }

  /**
   * Set the skill registry that loadForTask draws from.
   * Rebuilds the dependency graph on each call.
   */
  setRegistry(fragments: SkillFragment[]): void {
    this.registry.clear();
    this.dependencyGraph.clear();
    for (const frag of fragments) {
      this.registry.set(frag.agentId, frag);
      this.dependencyGraph.set(frag.agentId, [...frag.dependencies]);
    }
  }

  /**
   * Load skills relevant to a task domain. Returns loaded fragment agentIds
   * in topological order (dependencies first), respecting the token budget.
   *
   * If a dependency is missing from the registry, logs a warning and skips it.
   *
   * Budget resolution (Requirement 13):
   * - Backward compatible: when `inputBudget` is `undefined`, the legacy
   *   config-derived budget `floor(tokenBudgetFraction * contextWindowSize)`
   *   is used unchanged, so existing callers passing only `taskDomain` are
   *   unaffected.
   * - When budget context is supplied, the config-derived budget is overridden
   *   by the shared Token_Budget_Calculator (`computeInputTokenBudget`,
   *   Requirement 13.1). The persisted `inputBudget` setting is adapted via
   *   `resolveBudgetInputs`, and the active model's context length is resolved
   *   via the Active_Model_Resolver (`getActiveContextLength`, Requirement
   *   13.2). The resolver returns `0` when no provider record is available,
   *   which the calculator handles by falling back to its documented defaults.
   *
   * @param taskDomain  Domain tag selecting candidate skill fragments.
   * @param inputBudget Optional persisted `inputBudget` setting. A positive
   *                    finite value is honored as an explicit override; any
   *                    other supplied value maps to adaptive sizing. When
   *                    `undefined`, the legacy config-derived budget is used.
   *
   * Requirements: 1.1, 1.2, 1.4, 1.6, 13.1, 13.2
   */
  loadForTask(taskDomain: string, inputBudget?: number | null): string[] {
    let budget: number;
    if (inputBudget === undefined) {
      // Legacy path — config-derived budget, unchanged for existing callers.
      budget = Math.floor(this.config.tokenBudgetFraction * this.config.contextWindowSize);
    } else {
      // Override path — draw the budget from the shared calculator (Req 13.1)
      // using the active model's context length (Req 13.2). No provider record
      // is in scope here, so the resolver returns 0 and the calculator falls
      // back to its documented defaults.
      const { configured, explicit } = resolveBudgetInputs(inputBudget ?? null);
      const contextLength = getActiveContextLength(undefined);
      budget = computeInputTokenBudget(configured, contextLength, explicit);
    }

    // Find all skills matching the requested domain
    const candidates: SkillFragment[] = [];
    for (const frag of this.registry.values()) {
      if (frag.domain === taskDomain) {
        candidates.push(frag);
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    // Collect the full set of agentIds we need (candidates + their transitive deps)
    const needed = new Set<string>();
    const collectDeps = (agentId: string): void => {
      if (needed.has(agentId)) return;
      const frag = this.registry.get(agentId);
      if (!frag) {
        console.warn(`[SkillLoader] Dependency "${agentId}" not found in registry, skipping`);
        return;
      }
      needed.add(agentId);
      for (const dep of frag.dependencies) {
        collectDeps(dep);
      }
    };

    for (const c of candidates) {
      collectDeps(c.agentId);
    }

    // Topological sort of the needed set
    const sorted = this.topologicalSort(needed);

    // Load in topological order, respecting token budget
    const loaded: string[] = [];
    for (const agentId of sorted) {
      if (this.loaded.has(agentId)) {
        // Already loaded — count it but don't re-add
        loaded.push(agentId);
        continue;
      }

      const frag = this.registry.get(agentId);
      if (!frag) continue; // already warned during dep collection

      if (this.getLoadedTokenCost() + frag.tokenCost > budget) {
        // Would exceed budget — stop loading
        break;
      }

      this.loaded.set(agentId, frag);
      loaded.push(agentId);
    }

    return loaded;
  }

  /**
   * Render a loaded skill's BODY content for inclusion in an LLM prompt.
   *
   * A skill fragment's `content` (its system-prompt body) is third-party
   * material — it can originate from installed skill packs or other external
   * sources — so it is an F1_Call_Site. When
   * `PERF_FLAGS.UNTRUSTED_SOURCE_WRAP` is enabled, the body is routed through
   * {@link wrapUntrusted} with the label `skill: ${agentId} (${domain})`, so
   * it is framed with the Untrusted_Source_Wrapper delimiters and policy
   * header before it reaches the LLM (Requirement 5.3). Only the body is
   * wrapped — the `agentId`/`domain` metadata is operator-controlled and is
   * embedded in the label, not in the wrapped segment. When the flag is
   * disabled, the body is returned unwrapped via the pre-existing path
   * (Requirement 4.4).
   *
   * When a Metrics_Sink has been attached via {@link setMetricsSink} and the
   * flag is on, each wrap records `untrusted_wrap.invocations` +
   * `untrusted_wrap.wrapped_bytes` (Requirements 5.5, 5.6). Telemetry is
   * fail-soft and recorded once per actual wrap, so counts are never
   * double-recorded.
   *
   * Requirements: 5.3, 5.5, 5.6
   */
  renderSkillBody(skill: SkillFragment): string {
    if (PERF_FLAGS.UNTRUSTED_SOURCE_WRAP) {
      const wrapped = wrapUntrusted(
        skill.content,
        `skill: ${skill.agentId} (${skill.domain})`,
      );
      // Record F1 telemetry for this single wrapped segment (Requirements 5.5, 5.6).
      recordUntrustedWrap(this.metricsSink, wrapped, this.telemetrySessionId);
      return wrapped;
    }
    return skill.content;
  }

  /**
   * Render the bodies of every currently-loaded skill in topological
   * (dependency-first) load order, each routed through {@link renderSkillBody}
   * so loaded skill bodies pass through the Untrusted_Source_Wrapper when the
   * flag is enabled (Requirement 5.3). Segments are joined with blank lines.
   *
   * Requirements: 5.3
   */
  renderLoadedBodies(): string {
    const bodies: string[] = [];
    for (const frag of this.loaded.values()) {
      bodies.push(this.renderSkillBody(frag));
    }
    return bodies.join('\n\n');
  }

  /**
   * Unload skills not referenced by any active task domain.
   * Returns the number of tokens freed.
   *
   * Requirements: 1.3
   */
  gc(activeTaskDomains: Set<string>): number {
    let freed = 0;
    for (const [agentId, frag] of this.loaded) {
      if (!activeTaskDomains.has(frag.domain)) {
        freed += frag.tokenCost;
        this.loaded.delete(agentId);
      }
    }
    return freed;
  }

  /**
   * Get total token cost of currently loaded skills.
   *
   * Requirements: 1.2
   */
  getLoadedTokenCost(): number {
    let total = 0;
    for (const frag of this.loaded.values()) {
      total += frag.tokenCost;
    }
    return total;
  }

  /**
   * List loaded skills with token costs. For /skills command.
   *
   * Requirements: 1.7
   */
  listLoaded(): Array<{ agentId: string; domain: string; tokenCost: number }> {
    const result: Array<{ agentId: string; domain: string; tokenCost: number }> = [];
    for (const frag of this.loaded.values()) {
      result.push({
        agentId: frag.agentId,
        domain: frag.domain,
        tokenCost: frag.tokenCost,
      });
    }
    return result;
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Topological sort (Kahn's algorithm) over a subset of the dependency graph.
   * Returns agentIds in dependency-first order.
   * Handles cycles gracefully by appending remaining nodes at the end.
   */
  private topologicalSort(subset: Set<string>): string[] {
    // Build in-degree map scoped to the subset
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const id of subset) {
      inDegree.set(id, 0);
      adj.set(id, []);
    }

    for (const id of subset) {
      const deps = this.dependencyGraph.get(id) ?? [];
      for (const dep of deps) {
        if (subset.has(dep)) {
          // dep -> id (dep must come before id)
          adj.get(dep)!.push(id);
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) {
        queue.push(id);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          queue.push(neighbor);
        }
      }
    }

    // If there's a cycle, append remaining nodes (graceful degradation)
    for (const id of subset) {
      if (!sorted.includes(id)) {
        sorted.push(id);
      }
    }

    return sorted;
  }
}

export default SkillLoader;
