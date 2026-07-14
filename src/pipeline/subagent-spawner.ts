/**
 * Subagent Spawner — Lightweight Task Delegation
 *
 * Allows the main agent to spawn focused subagents for specific subtasks.
 * Subagents run in isolation (single-turn LLM call) and return a result
 * without consuming the main conversation's context window.
 *
 * Extended with Skill-Aware Subagent Spawning (Requirements 5.1–5.4, 5.7, 5.8):
 * - Prepends minimalism section when enforceMinimalism is enabled
 * - Runs keyword matching against task description and role
 * - Attaches matched skills within per-role Skill_Budget cap
 * - Rejects (never truncates) skills exceeding remaining budget
 * - Spawns without skill content when no skills match
 *
 * Extended with Dynamic Subagent Task Spawning (Requirements 12.1–12.7):
 * - spawn_subagent tool creates fresh agent contexts for subtasks
 * - Permission inheritance: subagent permissions ⊆ parent permissions
 * - Scoped context: parent task + relevant files (not full history)
 * - Nesting limited to 3 levels to prevent runaway spawning
 * - Per-session spawn budget (default: 10, configurable)
 * - Structured result aggregation returned to parent
 * - Subagent costs attributed to parent session budget
 */

import type { LLMClient, LLMMessage } from './llm-client';
import { buildMinimalismSection, type CodeQualityDirectives } from './system-prompt-builder';
import { findTriggeredSkills } from '../skills/skill-keyword-trigger';
import { resolveRole } from '../orchestration/role-vocabulary';

export interface SubagentTask {
  id: string;
  name: string;
  task: string;
  systemPrompt?: string;
}

// ─── Skill-Aware Subagent Interfaces (Requirement 5) ─────────────

/**
 * Configuration for skill injection into spawned subagents.
 *
 * - enforceMinimalism: when true, prepend minimalism section to specialist prompt
 * - skillBudgetChars: per-role character cap on total injected skill content
 * - roleAllowlist: maps role → list of allowed skill IDs for that role
 */
export interface SkillInjectionConfig {
  enforceMinimalism: boolean;
  skillBudgetChars: number;
  roleAllowlist: Map<string, string[]>;
}

/**
 * Enhanced subagent task with role-based skill injection metadata.
 * Extends SubagentTask with fields used for skill-aware spawning.
 */
export interface EnhancedSubagentTask extends SubagentTask {
  role: string;
  taskKeywords: string[];
  injectedSkills: string[];
}

export interface SubagentResult {
  id: string;
  name: string;
  output: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

const DEFAULT_SUBAGENT_PROMPT = `You are a focused research subagent. Your job is to complete the specific task given to you and return a concise, actionable result. Do not ask follow-up questions — work with what you have. Be thorough but brief.`;

const MAX_CONCURRENT = 3;

/**
 * Spawn a single subagent to complete a focused task.
 * Returns the result without affecting the main conversation context.
 */
export async function spawnSubagent(
  task: SubagentTask,
  llmClient: LLMClient,
  maxTokens: number = 1000
): Promise<SubagentResult> {
  const start = Date.now();

  try {
    const messages: LLMMessage[] = [
      { role: 'system', content: task.systemPrompt || DEFAULT_SUBAGENT_PROMPT },
      { role: 'user', content: task.task },
    ];

    const response = await llmClient.chat(messages, { temperature: 0.4, maxTokens });
    const output = (response.content || '').trim();

    return {
      id: task.id,
      name: task.name,
      output,
      durationMs: Date.now() - start,
      success: output.length > 0,
    };
  } catch (err: any) {
    return {
      id: task.id,
      name: task.name,
      output: '',
      durationMs: Date.now() - start,
      success: false,
      error: err.message,
    };
  }
}

/**
 * Spawn multiple subagents in parallel (up to MAX_CONCURRENT).
 * Returns all results once all complete.
 */
export async function spawnSubagentBatch(
  tasks: SubagentTask[],
  llmClient: LLMClient,
  maxTokens: number = 1000
): Promise<SubagentResult[]> {
  const results: SubagentResult[] = [];

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
    const batch = tasks.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map(task => spawnSubagent(task, llmClient, maxTokens))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Format subagent results as context that can be injected into the main conversation.
 * Keeps it concise to minimize context usage.
 */
export function formatSubagentResults(results: SubagentResult[]): string {
  if (results.length === 0) return '';

  const sections = results
    .filter(r => r.success && r.output)
    .map(r => `[${r.name}]: ${r.output.slice(0, 1500)}`);

  if (sections.length === 0) return '';

  return '--- SUBAGENT RESEARCH RESULTS ---\n' + sections.join('\n\n') + '\n--- END SUBAGENT RESULTS ---';
}

// ─── Skill-Aware Subagent Spawning (Requirement 5) ──────────────

/**
 * Resolve which skills from the catalog should be injected into a subagent's context.
 *
 * Logic:
 * 1. Validate the role against the shared Role_Vocabulary by exact comparison (R10.2)
 * 2. If the role is not in the vocabulary, return no skills and surface an indication (R10.5)
 * 3. Run keyword matching against the task description (text) and role
 * 4. Filter matched skills against the role's allowlist (derived from Role_Vocabulary, R10.3)
 * 5. Enforce per-role budget: reject (never truncate) skills that exceed remaining budget
 * 6. Return skill IDs and their content that fit within budget
 *
 * Requirements: 5.2, 5.4, 5.5, 5.8, 10.2, 10.3, 10.4, 10.5
 */
export function resolveSkillsForRole(
  task: EnhancedSubagentTask,
  config: SkillInjectionConfig,
  skillCatalog: Map<string, string>,
): { skillIds: string[]; skillContent: string; unmatchedIndication?: string } {
  // Validate the role against the shared Role_Vocabulary (R10.2, R10.5)
  const resolution = resolveRole(task.role);
  if (!resolution.matched) {
    // Role absent from vocabulary: return no skills and surface indication (R10.5)
    console.warn(`[resolveSkillsForRole] ${resolution.unmatchedIndication}`);
    return { skillIds: [], skillContent: '', unmatchedIndication: resolution.unmatchedIndication };
  }

  // Get allowlist for this role; if no allowlist entry, no skills are injectable
  const allowedSkills = config.roleAllowlist.get(task.role);
  if (!allowedSkills || allowedSkills.length === 0) {
    return { skillIds: [], skillContent: '' };
  }

  // Build search text from task description and keywords
  const searchText = [task.task, ...task.taskKeywords].join(' ');

  // Run keyword matching against the search text and role
  const triggered = findTriggeredSkills(searchText, task.role);

  // Filter to only skills on the allowlist (R10.3)
  const allowedTriggered = triggered.filter(t => allowedSkills.includes(t.mapping.skillId));

  if (allowedTriggered.length === 0) {
    return { skillIds: [], skillContent: '' };
  }

  // Enforce per-role budget: reject skills that exceed remaining budget (Req 5.8)
  let remainingBudget = config.skillBudgetChars;
  const acceptedSkillIds: string[] = [];
  const acceptedContent: string[] = [];

  for (const { mapping } of allowedTriggered) {
    const content = skillCatalog.get(mapping.skillId);
    if (!content) {
      continue;
    }

    // Reject entirely if skill content exceeds remaining budget
    if (content.length > remainingBudget) {
      continue;
    }

    acceptedSkillIds.push(mapping.skillId);
    acceptedContent.push(content);
    remainingBudget -= content.length;
  }

  return {
    skillIds: acceptedSkillIds,
    skillContent: acceptedContent.join('\n\n'),
  };
}

/**
 * Spawn a skill-aware subagent with role-matched skills and optional minimalism enforcement.
 *
 * Behavior:
 * 1. Prepends minimalism section when `config.enforceMinimalism` is true (Req 5.1)
 * 2. Runs keyword matching against task description and role for skill discovery (Req 5.2)
 * 3. Attaches matched skills within per-role budget (Req 5.4)
 * 4. Rejects (does NOT truncate) skills that exceed remaining budget (Req 5.8)
 * 5. When no skills match, spawns without skill content (Req 5.7)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.7, 5.8
 */
export async function spawnSkillAwareSubagent(
  task: EnhancedSubagentTask,
  llmClient: LLMClient,
  config: SkillInjectionConfig,
  skillCatalog: Map<string, string>,
  maxTokens?: number,
): Promise<SubagentResult> {
  // Resolve which skills should be injected
  const { skillIds, skillContent } = resolveSkillsForRole(task, config, skillCatalog);

  // Record injected skills on the task
  task.injectedSkills = skillIds;

  // Build the system prompt with optional minimalism + skills
  let systemPrompt = task.systemPrompt || DEFAULT_SUBAGENT_PROMPT;

  // Prepend minimalism section when enforceMinimalism is enabled (Req 5.1)
  if (config.enforceMinimalism) {
    const minimalismDirectives: CodeQualityDirectives = {
      enforceErrorHandling: false,
      enforceTypeSafety: false,
      enforceConventionFollowing: false,
      enforceVerification: false,
      verificationTools: [],
      enforceMinimalism: true,
      minimalismMode: 'full',
    };
    const minimalismSection = buildMinimalismSection(minimalismDirectives);
    if (minimalismSection) {
      systemPrompt = minimalismSection + '\n\n' + systemPrompt;
    }
  }

  // Append matched skill content when available (Req 5.3, 5.7)
  if (skillContent) {
    systemPrompt = systemPrompt + '\n\n--- INJECTED SKILLS ---\n' + skillContent + '\n--- END SKILLS ---';
  }

  // Spawn using the enhanced system prompt
  const enhancedTask: SubagentTask = {
    id: task.id,
    name: task.name,
    task: task.task,
    systemPrompt,
  };

  return spawnSubagent(enhancedTask, llmClient, maxTokens ?? 1000);
}


// ─── Dynamic Subagent Task Spawning (Requirement 12) ────────────

/**
 * Maximum nesting depth for subagent spawning.
 * agent (level 1) → subagent (level 2) → sub-subagent (level 3)
 *
 * Requirements: 12.4
 */
export const MAX_NESTING_DEPTH = 3;

/**
 * Default per-session subagent spawn budget.
 *
 * Requirements: 12.6
 */
export const DEFAULT_SPAWN_BUDGET = 10;

/**
 * Represents a file reference passed as scoped context to a subagent.
 *
 * Requirements: 12.3
 */
export interface FileReference {
  /** Absolute or relative file path */
  path: string;
  /** Optional start line (1-indexed) for partial file inclusion */
  startLine?: number;
  /** Optional end line (1-indexed) for partial file inclusion */
  endLine?: number;
  /** Content of the file or file segment */
  content?: string;
}

/**
 * The set of tool permissions that constrain what a subagent can do.
 * Subagent permissions must be a subset of the parent's permissions.
 *
 * Requirements: 12.2
 */
export interface ToolPermissions {
  /** Tool IDs the agent is allowed to use */
  allowedTools: string[];
  /** Maximum risk level the agent can execute (read-only < write < execute < destructive) */
  maxRiskLevel: 'read-only' | 'write' | 'execute' | 'destructive';
  /** Whether auto-approve is enabled (no user confirmation prompts) */
  autoApprove: boolean;
}

/**
 * Scoped context passed to a spawned subagent.
 * Includes only the parent's current task and relevant file references —
 * never the full conversation history.
 *
 * Requirements: 12.3
 */
export interface ScopedContext {
  /** Parent agent's current task description */
  parentTaskDescription: string;
  /** Relevant file references for the subtask */
  fileReferences: FileReference[];
  /** Additional context string (e.g., project metadata) */
  additionalContext?: string;
}

/**
 * Input for the spawn_subagent tool invocation.
 *
 * Requirements: 12.1, 12.2, 12.3
 */
export interface SpawnSubagentInput {
  /** Unique ID for the subagent task */
  taskId: string;
  /** Human-readable name for the subtask */
  taskName: string;
  /** The actual task description for the subagent to execute */
  taskDescription: string;
  /** Optional system prompt override */
  systemPrompt?: string;
  /** Scoped context: parent's task + relevant files */
  scopedContext: ScopedContext;
  /** Tool permissions to grant (must be ⊆ parent's permissions) */
  requestedPermissions?: Partial<ToolPermissions>;
  /** Maximum tokens for LLM response */
  maxTokens?: number;
}

/**
 * Extended result from a dynamically spawned subagent,
 * including cost attribution metadata.
 *
 * Requirements: 12.5, 12.7
 */
export interface SpawnedSubagentResult {
  /** Task identifier */
  taskId: string;
  /** Task name */
  taskName: string;
  /** Whether the subagent completed successfully */
  success: boolean;
  /** The structured output from the subagent */
  output: string;
  /** Error message if the subagent failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Nesting depth at which this subagent ran */
  nestingDepth: number;
  /** Cost in USD attributed to the parent session */
  costUSD: number;
  /** Token usage for this subagent call */
  tokenUsage: { promptTokens: number; completionTokens: number };
}

/**
 * Aggregated summary of multiple subagent results.
 *
 * Requirements: 12.5
 */
export interface SubagentResultsSummary {
  /** Total number of subagents spawned */
  totalSpawned: number;
  /** Number of successful completions */
  successCount: number;
  /** Number of failures */
  failureCount: number;
  /** Total cost across all subagents */
  totalCostUSD: number;
  /** Total duration (wall-clock, not cumulative) */
  totalDurationMs: number;
  /** Individual results */
  results: SpawnedSubagentResult[];
  /** Formatted summary suitable for injection into parent context */
  formattedSummary: string;
}

/**
 * Configuration for the SubagentTaskSpawner.
 *
 * Requirements: 12.6
 */
export interface SubagentSpawnerConfig {
  /** Maximum subagent spawns per session (default: 10) */
  spawnBudget: number;
  /** Maximum nesting depth (default: 3) */
  maxNestingDepth: number;
}

/**
 * Cost tracker interface — integrates with existing CostTrackingService.
 * Subagent costs are attributed to the parent session.
 *
 * Requirements: 12.7
 */
export interface CostTracker {
  /** Record a cost entry attributed to a session */
  recordCost(sessionId: string, costUSD: number, metadata: Record<string, unknown>): void;
  /** Get the current session's accumulated cost */
  getSessionCost(sessionId: string): number;
}

// ─── Risk level ordering for permission comparison ──────────────

const RISK_LEVEL_ORDER: Record<string, number> = {
  'read-only': 0,
  'write': 1,
  'execute': 2,
  'destructive': 3,
};

/**
 * SubagentTaskSpawner — Manages dynamic subagent creation with safeguards.
 *
 * Lazy-initialized singleton pattern consistent with NeuroNest architecture.
 * Tracks spawn counts per session, enforces nesting limits and permission
 * inheritance, and attributes costs back to parent sessions.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
 */
export class SubagentTaskSpawner {
  private static instance: SubagentTaskSpawner | null = null;

  private readonly config: SubagentSpawnerConfig;
  private readonly sessionSpawnCounts: Map<string, number> = new Map();
  private readonly costTracker: CostTracker | null;

  private constructor(config: Partial<SubagentSpawnerConfig> = {}, costTracker?: CostTracker | null) {
    this.config = {
      spawnBudget: config.spawnBudget ?? DEFAULT_SPAWN_BUDGET,
      maxNestingDepth: config.maxNestingDepth ?? MAX_NESTING_DEPTH,
    };
    this.costTracker = costTracker ?? null;
  }

  /**
   * Get or create the singleton instance.
   * Follows NeuroNest's lazy-initialized singleton pattern.
   */
  static getInstance(config?: Partial<SubagentSpawnerConfig>, costTracker?: CostTracker | null): SubagentTaskSpawner {
    if (!SubagentTaskSpawner.instance) {
      SubagentTaskSpawner.instance = new SubagentTaskSpawner(config, costTracker);
    }
    return SubagentTaskSpawner.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    SubagentTaskSpawner.instance = null;
  }

  /**
   * Validate that requested permissions are a subset of parent permissions.
   * Subagents cannot exceed the parent agent's tool permissions.
   *
   * Requirements: 12.2
   */
  validatePermissionInheritance(
    parentPermissions: ToolPermissions,
    requestedPermissions: Partial<ToolPermissions>,
  ): { valid: boolean; reason?: string } {
    // Check tool allowlist: every requested tool must be in parent's allowlist
    if (requestedPermissions.allowedTools) {
      const disallowed = requestedPermissions.allowedTools.filter(
        tool => !parentPermissions.allowedTools.includes(tool),
      );
      if (disallowed.length > 0) {
        return {
          valid: false,
          reason: `Subagent requested tools not permitted by parent: ${disallowed.join(', ')}`,
        };
      }
    }

    // Check risk level: subagent's max risk cannot exceed parent's max risk
    if (requestedPermissions.maxRiskLevel) {
      const parentLevel = RISK_LEVEL_ORDER[parentPermissions.maxRiskLevel] ?? 0;
      const requestedLevel = RISK_LEVEL_ORDER[requestedPermissions.maxRiskLevel] ?? 0;
      if (requestedLevel > parentLevel) {
        return {
          valid: false,
          reason: `Subagent requested risk level "${requestedPermissions.maxRiskLevel}" exceeds parent's "${parentPermissions.maxRiskLevel}"`,
        };
      }
    }

    // Check auto-approve: subagent cannot enable auto-approve if parent doesn't have it
    if (requestedPermissions.autoApprove === true && !parentPermissions.autoApprove) {
      return {
        valid: false,
        reason: 'Subagent cannot enable auto-approve when parent does not have it',
      };
    }

    return { valid: true };
  }

  /**
   * Check if the session has remaining spawn budget.
   *
   * Requirements: 12.6
   */
  hasSpawnBudget(sessionId: string): boolean {
    const count = this.sessionSpawnCounts.get(sessionId) ?? 0;
    return count < this.config.spawnBudget;
  }

  /**
   * Get the number of remaining spawns for a session.
   *
   * Requirements: 12.6
   */
  getRemainingBudget(sessionId: string): number {
    const count = this.sessionSpawnCounts.get(sessionId) ?? 0;
    return Math.max(0, this.config.spawnBudget - count);
  }

  /**
   * Get the total spawns used in a session.
   */
  getSpawnCount(sessionId: string): number {
    return this.sessionSpawnCounts.get(sessionId) ?? 0;
  }

  /**
   * Build the scoped context string from the input.
   * Includes only the parent's task description and relevant file references,
   * never the full conversation history.
   *
   * Requirements: 12.3
   */
  buildScopedContextPrompt(scopedContext: ScopedContext): string {
    const parts: string[] = [];

    parts.push('## Parent Task Context');
    parts.push(scopedContext.parentTaskDescription);

    if (scopedContext.fileReferences.length > 0) {
      parts.push('\n## Relevant Files');
      for (const ref of scopedContext.fileReferences) {
        const lineRange = ref.startLine && ref.endLine
          ? ` (lines ${ref.startLine}-${ref.endLine})`
          : '';
        parts.push(`\n### ${ref.path}${lineRange}`);
        if (ref.content) {
          parts.push('```');
          parts.push(ref.content);
          parts.push('```');
        }
      }
    }

    if (scopedContext.additionalContext) {
      parts.push('\n## Additional Context');
      parts.push(scopedContext.additionalContext);
    }

    return parts.join('\n');
  }

  /**
   * Spawn a subagent with full Requirement 12 safeguards:
   * - Permission inheritance validation
   * - Nesting depth check
   * - Session budget enforcement
   * - Scoped context construction
   * - Cost attribution to parent session
   *
   * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
   */
  async spawn(
    input: SpawnSubagentInput,
    llmClient: LLMClient,
    parentPermissions: ToolPermissions,
    sessionId: string,
    currentNestingDepth: number = 1,
  ): Promise<SpawnedSubagentResult> {
    const start = Date.now();

    // 12.4: Check nesting depth
    if (currentNestingDepth >= this.config.maxNestingDepth) {
      return {
        taskId: input.taskId,
        taskName: input.taskName,
        success: false,
        output: '',
        error: `Maximum nesting depth (${this.config.maxNestingDepth}) exceeded. Current depth: ${currentNestingDepth}`,
        durationMs: Date.now() - start,
        nestingDepth: currentNestingDepth,
        costUSD: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    // 12.6: Check session spawn budget
    if (!this.hasSpawnBudget(sessionId)) {
      return {
        taskId: input.taskId,
        taskName: input.taskName,
        success: false,
        output: '',
        error: `Session spawn budget exhausted (${this.config.spawnBudget} spawns max). Remaining: 0`,
        durationMs: Date.now() - start,
        nestingDepth: currentNestingDepth,
        costUSD: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    // 12.2: Validate permission inheritance
    if (input.requestedPermissions) {
      const validation = this.validatePermissionInheritance(parentPermissions, input.requestedPermissions);
      if (!validation.valid) {
        return {
          taskId: input.taskId,
          taskName: input.taskName,
          success: false,
          output: '',
          error: `Permission inheritance violation: ${validation.reason}`,
          durationMs: Date.now() - start,
          nestingDepth: currentNestingDepth,
          costUSD: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
        };
      }
    }

    // Increment spawn count for this session
    const currentCount = this.sessionSpawnCounts.get(sessionId) ?? 0;
    this.sessionSpawnCounts.set(sessionId, currentCount + 1);

    // 12.3: Build scoped context (parent task + files, not full history)
    const scopedContextPrompt = this.buildScopedContextPrompt(input.scopedContext);

    // Construct the full user message with scoped context + task description
    const userMessage = `${scopedContextPrompt}\n\n## Your Task\n${input.taskDescription}`;

    const systemPrompt = input.systemPrompt || DEFAULT_SUBAGENT_PROMPT;

    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      const maxTokens = input.maxTokens ?? 1000;
      const response = await llmClient.chat(messages, { temperature: 0.4, maxTokens });
      const output = (response.content || '').trim();

      // Extract token usage from response (if available)
      const promptTokens = (response as any).promptTokens ?? Math.ceil(userMessage.length / 4);
      const completionTokens = (response as any).completionTokens ?? Math.ceil(output.length / 4);

      // 12.7: Calculate cost and attribute to parent session
      // Uses a rough estimate; in production, integrate with CostCalculator
      const costUSD = (response as any).costUSD ?? 0;

      if (this.costTracker && costUSD > 0) {
        this.costTracker.recordCost(sessionId, costUSD, {
          type: 'subagent',
          taskId: input.taskId,
          taskName: input.taskName,
          nestingDepth: currentNestingDepth + 1,
        });
      }

      return {
        taskId: input.taskId,
        taskName: input.taskName,
        success: output.length > 0,
        output,
        durationMs: Date.now() - start,
        nestingDepth: currentNestingDepth + 1,
        costUSD,
        tokenUsage: { promptTokens, completionTokens },
      };
    } catch (err: any) {
      return {
        taskId: input.taskId,
        taskName: input.taskName,
        success: false,
        output: '',
        error: err.message,
        durationMs: Date.now() - start,
        nestingDepth: currentNestingDepth + 1,
        costUSD: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      };
    }
  }

  /**
   * Aggregate results from multiple subagent spawns into a structured summary.
   * The summary is suitable for injection into the parent agent's context.
   *
   * Requirements: 12.5
   */
  aggregateResults(results: SpawnedSubagentResult[]): SubagentResultsSummary {
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;
    const totalCostUSD = results.reduce((sum, r) => sum + r.costUSD, 0);
    const totalDurationMs = results.length > 0
      ? Math.max(...results.map(r => r.durationMs))
      : 0;

    const formattedSummary = this.formatAggregatedSummary(results);

    return {
      totalSpawned: results.length,
      successCount,
      failureCount,
      totalCostUSD,
      totalDurationMs,
      results,
      formattedSummary,
    };
  }

  /**
   * Format aggregated results as a structured summary string
   * suitable for injection into the parent agent's context.
   *
   * Requirements: 12.5
   */
  private formatAggregatedSummary(results: SpawnedSubagentResult[]): string {
    if (results.length === 0) return '';

    const lines: string[] = [
      '--- SUBAGENT EXECUTION SUMMARY ---',
      `Total spawned: ${results.length} | Success: ${results.filter(r => r.success).length} | Failed: ${results.filter(r => !r.success).length}`,
      '',
    ];

    for (const result of results) {
      const status = result.success ? '✓' : '✗';
      lines.push(`[${status}] ${result.taskName} (${result.durationMs}ms, $${result.costUSD.toFixed(4)})`);
      if (result.success && result.output) {
        // Truncate long outputs to keep summary concise
        const truncated = result.output.length > 1000
          ? result.output.slice(0, 1000) + '... [truncated]'
          : result.output;
        lines.push(`    Output: ${truncated}`);
      }
      if (!result.success && result.error) {
        lines.push(`    Error: ${result.error}`);
      }
      lines.push('');
    }

    lines.push('--- END SUBAGENT SUMMARY ---');
    return lines.join('\n');
  }

  /**
   * Reset the spawn count for a session (e.g., when session ends).
   */
  resetSessionBudget(sessionId: string): void {
    this.sessionSpawnCounts.delete(sessionId);
  }

  /**
   * Get the current configuration.
   */
  getConfig(): SubagentSpawnerConfig {
    return { ...this.config };
  }

  /**
   * Update the spawn budget for new sessions.
   * Does not affect currently tracked sessions.
   */
  updateSpawnBudget(newBudget: number): void {
    this.config.spawnBudget = Math.max(1, newBudget);
  }
}
