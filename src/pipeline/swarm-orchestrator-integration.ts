/**
 * Swarm Orchestrator Integration for Imported Agents
 *
 * A self-contained integration module that wires imported agents into the
 * swarm orchestrator's candidate selection, fitness scoring, tool permission
 * enforcement, and execution metrics tracking.
 *
 * This module ensures imported agents participate in task assignment, reviewer
 * selection, and parallel decomposition (Pro/Ultra modes) without preference
 * bias relative to existing agents.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */

import {
  type AgentDefinition,
  AGENT_REGISTRY,
  checkToolPermission,
} from '../agents/agent-registry';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Classification of a task for agent matching purposes. */
export interface TaskClassification {
  department: string;
  keywords: string[];
  requiredTools?: Array<'read' | 'edit' | 'command' | 'mcp'>;
}

/** Assignment roles for agents within the orchestrator. */
export type AssignmentRole = 'primary' | 'supporting' | 'reviewer';

/** Execution metrics tracked per agent for data-driven routing. */
export interface AgentMetrics {
  agentId: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  totalCostUsd: number;
}

/** Result of a fitness score computation. */
export interface FitnessResult {
  agentId: string;
  score: number;
  breakdown: {
    departmentMatch: number;
    specialtyRelevance: number;
    historicalSuccess: number;
  };
}

/** Configuration for the orchestrator integration. */
export interface OrchestratorConfig {
  /** Minimum fitness score required for primary agent assignment. Default: 0.3 */
  primaryThreshold: number;
  /** Weight for department match in fitness score computation. Default: 0.4 */
  departmentWeight: number;
  /** Weight for specialty keyword relevance. Default: 0.35 */
  specialtyWeight: number;
  /** Weight for historical success rate. Default: 0.25 */
  historyWeight: number;
}

/** Tool dispatch request with permission check context. */
export interface ToolDispatchRequest {
  agentId: string;
  toolName: string;
  operation: 'read' | 'edit' | 'command' | 'mcp';
  filePath?: string;
}

/** Result of a tool dispatch permission check. */
export interface ToolDispatchResult {
  allowed: boolean;
  message?: string;
}

// ─────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────

const DEFAULT_CONFIG: OrchestratorConfig = {
  primaryThreshold: 0.3,
  departmentWeight: 0.4,
  specialtyWeight: 0.35,
  historyWeight: 0.25,
};

// ─────────────────────────────────────────────
// In-memory Metrics Store
// ─────────────────────────────────────────────

const metricsStore: Map<string, AgentMetrics> = new Map();

// ─────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────

/**
 * Computes a fitness score for an agent relative to a task classification.
 *
 * The score is a weighted combination of:
 * - Department match (0 or 1): whether the agent's department matches the task's
 * - Specialty relevance (0-1): Jaccard-like keyword overlap between agent specialty and task keywords
 * - Historical success rate (0-1): ratio of successful executions to total executions
 *
 * All agents (original and imported) are scored using the same algorithm
 * without preference bias (Requirement 21.2, 21.7).
 *
 * @param agent - The agent definition to score
 * @param task - The task classification to match against
 * @param config - Scoring weights configuration
 * @returns FitnessResult with score in [0, 1] and detailed breakdown
 */
export function computeFitnessScore(
  agent: AgentDefinition,
  task: TaskClassification,
  config: OrchestratorConfig = DEFAULT_CONFIG,
): FitnessResult {
  // Department match: binary 0 or 1
  const departmentMatch = agent.department.toLowerCase() === task.department.toLowerCase() ? 1.0 : 0.0;

  // Specialty relevance: keyword overlap using Jaccard-like coefficient
  const specialtyRelevance = computeSpecialtyRelevance(agent.specialty, task.keywords);

  // Historical success rate: from metrics store
  const historicalSuccess = getHistoricalSuccessRate(agent.id);

  // Weighted combination
  const score =
    config.departmentWeight * departmentMatch +
    config.specialtyWeight * specialtyRelevance +
    config.historyWeight * historicalSuccess;

  // Clamp to [0, 1]
  const clampedScore = Math.max(0, Math.min(1, score));

  return {
    agentId: agent.id,
    score: clampedScore,
    breakdown: {
      departmentMatch,
      specialtyRelevance,
      historicalSuccess,
    },
  };
}

/**
 * Selects the primary agent for a task from the full candidate pool
 * (both original and imported agents).
 *
 * Only agents meeting the minimum fitness threshold (default 0.3) are
 * eligible for primary assignment (Requirement 21.3).
 *
 * @param task - The task classification to match
 * @param candidates - Optional custom candidate list; defaults to full AGENT_REGISTRY
 * @param config - Configuration including threshold
 * @returns The highest-scoring agent meeting the threshold, or null if none qualify
 */
export function selectPrimaryAgent(
  task: TaskClassification,
  candidates?: AgentDefinition[],
  config: OrchestratorConfig = DEFAULT_CONFIG,
): FitnessResult | null {
  const pool = candidates ?? AGENT_REGISTRY;

  const scored = pool
    .map((agent) => computeFitnessScore(agent, task, config))
    .filter((result) => result.score >= config.primaryThreshold)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0]! : null;
}

/**
 * Selects supporting agents for a task. No minimum threshold is applied
 * for supporting role assignment (Requirement 21.3).
 *
 * Returns agents sorted by fitness score (highest first), excluding
 * the primary agent if provided.
 *
 * @param task - The task classification to match
 * @param excludeAgentId - Agent ID to exclude (typically the primary agent)
 * @param maxCount - Maximum number of supporting agents to return
 * @param candidates - Optional custom candidate list; defaults to full AGENT_REGISTRY
 * @param config - Configuration for scoring weights
 * @returns Array of fitness results for supporting agents, sorted by score descending
 */
export function selectSupportingAgents(
  task: TaskClassification,
  excludeAgentId?: string,
  maxCount: number = 3,
  candidates?: AgentDefinition[],
  config: OrchestratorConfig = DEFAULT_CONFIG,
): FitnessResult[] {
  const pool = candidates ?? AGENT_REGISTRY;

  const scored = pool
    .filter((agent) => agent.id !== excludeAgentId)
    .map((agent) => computeFitnessScore(agent, task, config))
    // No minimum threshold for supporting agents
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxCount);
}

/**
 * Selects agents for the adversarial reviewer pool based on department
 * and specialty match with the work domain (Requirement 21.6).
 *
 * No minimum threshold is applied for reviewer assignment.
 *
 * @param task - The task classification representing the domain being reviewed
 * @param excludeAgentId - Agent ID to exclude (the agent whose work is being reviewed)
 * @param maxCount - Maximum number of reviewers to return
 * @param candidates - Optional custom candidate list; defaults to full AGENT_REGISTRY
 * @param config - Configuration for scoring weights
 * @returns Array of fitness results for reviewer agents, sorted by score descending
 */
export function selectReviewers(
  task: TaskClassification,
  excludeAgentId?: string,
  maxCount: number = 2,
  candidates?: AgentDefinition[],
  config: OrchestratorConfig = DEFAULT_CONFIG,
): FitnessResult[] {
  const pool = candidates ?? AGENT_REGISTRY;

  const scored = pool
    .filter((agent) => agent.id !== excludeAgentId)
    .map((agent) => computeFitnessScore(agent, task, config))
    // Include in reviewer pool when department or specialty matches
    .filter((result) => result.breakdown.departmentMatch > 0 || result.breakdown.specialtyRelevance > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxCount);
}

/**
 * Checks tool permissions before dispatching a tool call to an agent.
 * Enforces registered tool permissions from AGENT_TOOL_PERMISSIONS
 * (Requirement 21.5).
 *
 * If a tool call exceeds the agent's permissions, it is blocked while
 * allowing the agent to continue executing other permitted operations.
 *
 * @param request - The tool dispatch request to validate
 * @returns Whether the dispatch is allowed and an optional denial message
 */
export function checkToolDispatchPermission(request: ToolDispatchRequest): ToolDispatchResult {
  const result = checkToolPermission(request.agentId, request.operation, request.filePath);
  const output: ToolDispatchResult = { allowed: result.allowed };
  if (result.message !== undefined) {
    output.message = result.message;
  }
  return output;
}

// ─────────────────────────────────────────────
// Execution Metrics (Requirement 21.8)
// ─────────────────────────────────────────────

/**
 * Records the outcome of an agent execution for data-driven routing improvements.
 *
 * @param agentId - The agent that executed the task
 * @param success - Whether the execution was successful
 * @param latencyMs - Execution duration in milliseconds
 * @param costUsd - Cost of the execution in USD
 */
export function recordExecution(
  agentId: string,
  success: boolean,
  latencyMs: number,
  costUsd: number,
): void {
  const existing = metricsStore.get(agentId) ?? {
    agentId,
    totalExecutions: 0,
    successCount: 0,
    failureCount: 0,
    totalLatencyMs: 0,
    totalCostUsd: 0,
  };

  existing.totalExecutions += 1;
  if (success) {
    existing.successCount += 1;
  } else {
    existing.failureCount += 1;
  }
  existing.totalLatencyMs += latencyMs;
  existing.totalCostUsd += costUsd;

  metricsStore.set(agentId, existing);
}

/**
 * Retrieves execution metrics for a specific agent.
 *
 * @param agentId - The agent to retrieve metrics for
 * @returns The agent's execution metrics, or null if no executions recorded
 */
export function getAgentMetrics(agentId: string): AgentMetrics | null {
  return metricsStore.get(agentId) ?? null;
}

/**
 * Retrieves execution metrics for all agents that have recorded executions.
 *
 * @returns Array of all agent metrics
 */
export function getAllMetrics(): AgentMetrics[] {
  return Array.from(metricsStore.values());
}

/**
 * Resets all execution metrics. Primarily used for testing.
 */
export function resetMetrics(): void {
  metricsStore.clear();
}

// ─────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────

/**
 * Computes specialty keyword relevance between an agent's specialty text
 * and a set of task keywords using a Jaccard-like coefficient.
 *
 * Tokenizes the agent's specialty into words and computes the fraction
 * of task keywords that appear in the specialty text.
 */
function computeSpecialtyRelevance(specialty: string, taskKeywords: string[]): number {
  if (taskKeywords.length === 0) {
    return 0;
  }

  // Tokenize the agent's specialty into lowercase words
  const specialtyWords = new Set(
    specialty
      .toLowerCase()
      .split(/[\s,;.!?()[\]{}<>:'"\/\-_]+/)
      .filter((w) => w.length > 0),
  );

  if (specialtyWords.size === 0) {
    return 0;
  }

  // Count how many task keywords are found in the specialty
  const matchedKeywords = taskKeywords.filter((kw) =>
    specialtyWords.has(kw.toLowerCase()),
  );

  // Union-based Jaccard: |intersection| / |union|
  const intersectionSize = matchedKeywords.length;
  const unionSize = new Set([...specialtyWords, ...taskKeywords.map((k) => k.toLowerCase())]).size;

  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

/**
 * Gets the historical success rate for an agent from the metrics store.
 * Returns 0.5 (neutral) for agents with no execution history, ensuring
 * new/imported agents are not penalized or advantaged.
 */
function getHistoricalSuccessRate(agentId: string): number {
  const metrics = metricsStore.get(agentId);
  if (!metrics || metrics.totalExecutions === 0) {
    // Neutral score for agents with no history — no preference bias
    return 0.5;
  }
  return metrics.successCount / metrics.totalExecutions;
}
