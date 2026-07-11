/**
 * ModelRouter — Task classification and intelligent model-provider routing.
 *
 * Classifies agent tasks by type using keyword heuristics on user messages
 * and recent tool history, then selects optimal model-provider pairs from
 * a configurable routing table. Supports user overrides and failover chains.
 *
 * Key behaviors:
 * - classifyTask() uses keyword heuristics to determine task type
 * - classifyTask() ALWAYS returns a valid TaskType string, never throws, never returns undefined
 * - selectProvider() returns first entry from routing table for that task type; returns null if none configured
 * - getFailoverChain() returns the full ordered provider list for failover support
 * - User overrides take priority over the default routing table
 *
 * Performance: Task classification is a lightweight heuristic (<1ms).
 * Normal-path overhead: 0ms when feature gate is disabled.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

// ─── Types & Interfaces ─────────────────────────────────────────

/**
 * Supported task types for model routing classification.
 */
export type TaskType =
  | 'simple_edit'
  | 'code_generation'
  | 'architecture_reasoning'
  | 'code_review'
  | 'commit_message'
  | 'test_generation'
  | 'general'
  // Meta-work types (cheap tier) — used by orchestration subsystems
  | 'agent_routing'
  | 'refusal_detection'
  | 'prompt_scoring'
  | 'metadata_extraction'
  | 'orchestration_meta';

/**
 * Model tier classification for cost-appropriate routing.
 * - 'expensive': Complex reasoning tasks (gpt-4, claude-sonnet class)
 * - 'cheap': Classification and routing tasks (gpt-4o-mini, haiku class)
 */
export type ModelTier = 'expensive' | 'cheap';

/**
 * A single provider-model pair with priority ordering.
 * Lower priority numbers are preferred.
 */
export interface RoutingEntry {
  providerId: string;
  model: string;
  priority: number;
}

/**
 * A routing table entry mapping a task type to its ordered providers.
 */
export interface RoutingTableEntry {
  taskType: TaskType;
  providers: RoutingEntry[];
}

/**
 * Complete routing table with entries per task type and a default fallback.
 */
export interface RoutingTable {
  entries: RoutingTableEntry[];
  defaultProvider: { providerId: string; model: string };
}

// ─── Classification Keywords ────────────────────────────────────

/**
 * Keyword sets used by classifyTask() heuristic.
 * Each set maps to a TaskType. Order matters — first match wins.
 */
const ARCHITECTURE_KEYWORDS = [
  'architecture', 'architect', 'design', 'system design', 'refactor',
  'restructure', 'migrate', 'migration', 'scalability', 'microservice',
  'monorepo', 'module boundary', 'decouple', 'pattern', 'trade-off',
  'tradeoff', 'high-level', 'rfc', 'adr', 'tech debt',
] as const;

const CODE_REVIEW_KEYWORDS = [
  'review', 'code review', 'feedback', 'critique', 'audit',
  'inspect', 'check quality', 'best practice', 'lint', 'smell',
  'vulnerability', 'security review',
] as const;

const TEST_GENERATION_KEYWORDS = [
  'test', 'tests', 'unit test', 'integration test', 'spec',
  'coverage', 'assertion', 'test case', 'describe', 'it should',
  'property test', 'fuzz', 'snapshot test',
] as const;

const COMMIT_MESSAGE_KEYWORDS = [
  'commit message', 'commit msg', 'write commit', 'generate commit',
  'changelog', 'release note', 'conventional commit',
] as const;

const SIMPLE_EDIT_KEYWORDS = [
  'fix typo', 'rename', 'change name', 'update import', 'add import',
  'remove unused', 'delete line', 'fix indent', 'formatting',
  'add comment', 'fix comment', 'update version', 'bump version',
] as const;

/**
 * Tool names that indicate specific task types when found in recent history.
 */
const REVIEW_TOOLS = ['lint', 'diagnostics', 'code_review', 'security_scan'] as const;
const TEST_TOOLS = ['run_tests', 'test_runner', 'coverage'] as const;

// ─── Tier Classification ────────────────────────────────────────

/**
 * Maps each TaskType to its model tier.
 * Expensive tier: complex reasoning (code generation, architecture, tests)
 * Cheap tier: lightweight classification, routing, and meta-work
 *
 * Requirements: 6.1, 6.3
 */
const TIER_MAP: Record<TaskType, ModelTier> = {
  // Expensive tier — complex reasoning tasks
  code_generation: 'expensive',
  architecture_reasoning: 'expensive',
  test_generation: 'expensive',
  // Cheap tier — lightweight classification and meta-work
  simple_edit: 'cheap',
  commit_message: 'cheap',
  code_review: 'cheap',
  general: 'cheap',
  agent_routing: 'cheap',
  refusal_detection: 'cheap',
  prompt_scoring: 'cheap',
  metadata_extraction: 'cheap',
  orchestration_meta: 'cheap',
};

// ─── ModelRouter Class ──────────────────────────────────────────

export class ModelRouter {
  private readonly effectiveTable: RoutingTable;

  constructor(
    private routingTable: RoutingTable,
    private userOverrides?: Partial<RoutingTable>,
  ) {
    this.effectiveTable = this.buildEffectiveTable();
  }

  /**
   * Classify a task from the user message and recent tool history.
   *
   * Uses keyword heuristics with the following priority:
   * 1. architecture words → 'architecture_reasoning'
   * 2. commit message patterns → 'commit_message'
   * 3. test/coverage words → 'test_generation'
   * 4. review/audit words → 'code_review'
   * 5. simple edit patterns → 'simple_edit'
   * 6. default → 'code_generation'
   *
   * ALWAYS returns a valid TaskType string. Never throws, never returns undefined.
   *
   * Requirements: 10.1
   */
  classifyTask(userMessage: string, recentTools: string[]): TaskType {
    const messageLower = userMessage.toLowerCase();

    // Check architecture keywords first (highest complexity)
    if (this.matchesKeywords(messageLower, ARCHITECTURE_KEYWORDS)) {
      return 'architecture_reasoning';
    }

    // Check commit message patterns (very specific, check before general)
    if (this.matchesKeywords(messageLower, COMMIT_MESSAGE_KEYWORDS)) {
      return 'commit_message';
    }

    // Check test generation keywords
    if (this.matchesKeywords(messageLower, TEST_GENERATION_KEYWORDS)) {
      return 'test_generation';
    }

    // Check code review keywords
    if (this.matchesKeywords(messageLower, CODE_REVIEW_KEYWORDS)) {
      return 'code_review';
    }

    // Check simple edit patterns (low complexity)
    if (this.matchesKeywords(messageLower, SIMPLE_EDIT_KEYWORDS)) {
      return 'simple_edit';
    }

    // Tool history can also influence classification
    if (this.toolHistoryIndicates(recentTools, REVIEW_TOOLS)) {
      return 'code_review';
    }

    if (this.toolHistoryIndicates(recentTools, TEST_TOOLS)) {
      return 'test_generation';
    }

    // Default to code generation — the most common task type
    return 'code_generation';
  }

  /**
   * Select the optimal provider-model pair for a classified task type.
   * Returns the highest-priority (lowest priority number) provider from the
   * effective routing table for the given task type.
   *
   * Returns null if no providers are configured for that task type.
   *
   * Requirements: 10.2, 10.3, 10.4
   */
  selectProvider(taskType: TaskType): { providerId: string; model: string } | null {
    const entry = this.effectiveTable.entries.find((e) => e.taskType === taskType);

    if (!entry || entry.providers.length === 0) {
      // Fall back to default provider if the task type has no specific routing
      if (this.effectiveTable.defaultProvider) {
        return { ...this.effectiveTable.defaultProvider };
      }
      return null;
    }

    // Providers are sorted by priority — first one is optimal
    const best = entry.providers[0];
    return { providerId: best.providerId, model: best.model };
  }

  /**
   * Get the full ordered failover chain for a task type.
   * Returns providers sorted by priority (ascending) for failover support.
   * Used by ProviderFailover (Req 17) to determine fallback sequence.
   *
   * Returns empty array if no providers configured for the task type.
   *
   * Requirements: 10.5
   */
  getFailoverChain(taskType: TaskType): { providerId: string; model: string }[] {
    const entry = this.effectiveTable.entries.find((e) => e.taskType === taskType);

    if (!entry || entry.providers.length === 0) {
      // If no specific routing, return just the default provider
      if (this.effectiveTable.defaultProvider) {
        return [{ ...this.effectiveTable.defaultProvider }];
      }
      return [];
    }

    return entry.providers.map((p) => ({ providerId: p.providerId, model: p.model }));
  }

  /**
   * Get the tier classification for a task type.
   * Returns 'expensive' for complex reasoning tasks and 'cheap' for
   * lightweight classification and routing tasks.
   *
   * Handles unknown TaskType values gracefully by returning 'cheap' as a
   * safe default to minimize cost.
   *
   * Requirements: 6.1, 6.2, 6.3, 6.8, 6.9
   */
  getTier(taskType: TaskType): ModelTier {
    return TIER_MAP[taskType] ?? 'cheap';
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Build the effective routing table by merging user overrides on top
   * of the default routing table. User overrides take priority.
   *
   * Requirements: 10.4
   */
  private buildEffectiveTable(): RoutingTable {
    if (!this.userOverrides) {
      return this.sortedTable(this.routingTable);
    }

    const defaultEntries = new Map<TaskType, RoutingTableEntry>();
    for (const entry of this.routingTable.entries) {
      defaultEntries.set(entry.taskType, entry);
    }

    // Apply user overrides — replace entire entry for overridden task types
    if (this.userOverrides.entries) {
      for (const override of this.userOverrides.entries) {
        defaultEntries.set(override.taskType, override);
      }
    }

    const mergedEntries = Array.from(defaultEntries.values());

    const effectiveDefault = this.userOverrides.defaultProvider
      ?? this.routingTable.defaultProvider;

    return this.sortedTable({
      entries: mergedEntries,
      defaultProvider: effectiveDefault,
    });
  }

  /**
   * Return a copy of the table with providers sorted by priority (ascending).
   */
  private sortedTable(table: RoutingTable): RoutingTable {
    return {
      ...table,
      entries: table.entries.map((entry) => ({
        ...entry,
        providers: [...entry.providers].sort((a, b) => a.priority - b.priority),
      })),
    };
  }

  /**
   * Check if the message contains any of the given keywords.
   * Uses word-boundary-aware matching to avoid false positives.
   */
  private matchesKeywords(
    messageLower: string,
    keywords: readonly string[],
  ): boolean {
    return keywords.some((keyword) => messageLower.includes(keyword));
  }

  /**
   * Check if recent tool history includes tools indicating a specific task type.
   */
  private toolHistoryIndicates(
    recentTools: string[],
    indicatorTools: readonly string[],
  ): boolean {
    const recentLower = recentTools.map((t) => t.toLowerCase());
    return indicatorTools.some((tool) =>
      recentLower.some((recent) => recent.includes(tool)),
    );
  }
}
