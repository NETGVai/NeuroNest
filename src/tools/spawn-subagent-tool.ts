/**
 * Spawn Subagent Tool — Agent-facing tool for dynamic subagent creation
 *
 * Registered in the agent tool registry with name `spawn_subagent`.
 * Allows any running agent to invoke `spawn_subagent` to create a fresh
 * agent context for a subtask. Enforces permission inheritance, nesting
 * limits, and per-session spawn budgets.
 *
 * Requirements: 12.1, 12.7
 */

import type { ToolContext, ToolResult } from '../shared/types.js';
import type { ExecutableToolDefinition } from './tool-system.js';
import { safeExecute, type FieldSchema } from './built-in/input-validator.js';
import {
  SubagentTaskSpawner,
  type SpawnSubagentInput,
  type ToolPermissions,
  type SpawnedSubagentResult,
  type CostTracker,
} from '../pipeline/subagent-spawner.js';
import type { LLMClient } from '../pipeline/llm-client.js';

// ─── Types ──────────────────────────────────────────────────────

/** Input parameters for the spawn_subagent tool */
export interface SpawnSubagentToolInput {
  /** Human-readable name for the subtask */
  taskName: string;
  /** The task description for the subagent to execute */
  taskDescription: string;
  /** Optional system prompt override for the subagent */
  systemPrompt?: string;
  /** File paths relevant to the subtask (scoped context) */
  relevantFiles?: Array<{ path: string; content?: string; startLine?: number; endLine?: number }>;
  /** Additional context to pass (e.g., project metadata) */
  additionalContext?: string;
  /** Requested tool permissions (must be subset of parent's) */
  requestedPermissions?: Partial<ToolPermissions>;
  /** Maximum tokens for the subagent's LLM response */
  maxTokens?: number;
}

// ─── Input Schema ───────────────────────────────────────────────

const spawnSubagentSchema: FieldSchema[] = [
  { name: 'taskName', type: 'string' },
  { name: 'taskDescription', type: 'string' },
  { name: 'systemPrompt', type: 'string', required: false },
  { name: 'relevantFiles', type: 'object', required: false },
  { name: 'additionalContext', type: 'string', required: false },
  { name: 'requestedPermissions', type: 'object', required: false },
  { name: 'maxTokens', type: 'number', required: false },
];

// ─── Execute Function Factory ───────────────────────────────────

/**
 * Create the spawn_subagent execute function with injected dependencies.
 *
 * Dependencies:
 * - getLLMClient: resolves the active LLM client for subagent execution
 * - getSessionId: returns the current session ID for budget tracking
 * - getParentPermissions: returns the parent agent's tool permissions
 * - costTracker: optional cost tracker for attributing subagent costs
 * - isFeatureEnabled: checks if subagent_spawning feature flag is on
 */
export function createSpawnSubagentExecute(deps: {
  getLLMClient: () => LLMClient | null;
  getSessionId: () => string | null;
  getParentPermissions: (agentId: string) => ToolPermissions;
  costTracker?: CostTracker | null;
  isFeatureEnabled: () => boolean;
}): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<SpawnSubagentToolInput>(
    spawnSubagentSchema,
    async (input: SpawnSubagentToolInput, context: ToolContext): Promise<ToolResult> => {
      // Check feature flag
      if (!deps.isFeatureEnabled()) {
        return {
          success: false,
          output: null,
          error: 'Subagent spawning is disabled. Enable the subagent_spawning feature flag.',
        };
      }

      const { taskName, taskDescription, systemPrompt, relevantFiles, additionalContext, requestedPermissions, maxTokens } = input;

      // Validate required fields
      if (!taskName?.trim()) {
        return { success: false, output: null, error: 'taskName cannot be empty' };
      }
      if (!taskDescription?.trim()) {
        return { success: false, output: null, error: 'taskDescription cannot be empty' };
      }

      // Get session ID
      const sessionId = deps.getSessionId();
      if (!sessionId) {
        return { success: false, output: null, error: 'No active session — cannot track subagent budget' };
      }

      // Get LLM client
      const llmClient = deps.getLLMClient();
      if (!llmClient) {
        return { success: false, output: null, error: 'No LLM provider configured for subagent execution' };
      }

      // Get parent permissions
      const parentPermissions = deps.getParentPermissions(context.agentId);

      // Get or create the SubagentTaskSpawner singleton
      const spawner = SubagentTaskSpawner.getInstance(undefined, deps.costTracker);

      // Check remaining budget
      const remaining = spawner.getRemainingBudget(sessionId);
      if (remaining <= 0) {
        return {
          success: false,
          output: null,
          error: `Session spawn budget exhausted (${spawner.getConfig().spawnBudget} spawns max). No remaining spawns.`,
        };
      }

      // Build the spawn input
      const taskId = `subagent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const spawnInput: SpawnSubagentInput = {
        taskId,
        taskName,
        taskDescription,
        systemPrompt,
        scopedContext: {
          parentTaskDescription: `Parent agent (${context.agentId}) delegated this subtask.`,
          fileReferences: (relevantFiles || []).map(f => ({
            path: f.path,
            content: f.content,
            startLine: f.startLine,
            endLine: f.endLine,
          })),
          additionalContext,
        },
        requestedPermissions,
        maxTokens,
      };

      // Spawn the subagent (nesting depth starts at 1 for tool-invoked subagents)
      let result: SpawnedSubagentResult;
      try {
        result = await spawner.spawn(
          spawnInput,
          llmClient,
          parentPermissions,
          sessionId,
          1, // Tool-invoked subagents start at nesting depth 1
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: `Subagent spawn failed: ${message}` };
      }

      // Return structured result
      return {
        success: result.success,
        output: {
          taskId: result.taskId,
          taskName: result.taskName,
          output: result.output,
          durationMs: result.durationMs,
          nestingDepth: result.nestingDepth,
          costUSD: result.costUSD,
          tokenUsage: result.tokenUsage,
          remainingBudget: spawner.getRemainingBudget(sessionId),
        },
        error: result.error,
      };
    },
  );
}

// ─── Tool Definition ────────────────────────────────────────────

/**
 * Create the spawn_subagent tool definition with injected dependencies.
 *
 * The tool is registered with id `spawn_subagent` and is available to
 * all agents for dynamically spawning focused subagents.
 */
export function createSpawnSubagentTool(deps: {
  getLLMClient: () => LLMClient | null;
  getSessionId: () => string | null;
  getParentPermissions: (agentId: string) => ToolPermissions;
  costTracker?: CostTracker | null;
  isFeatureEnabled: () => boolean;
}): ExecutableToolDefinition {
  return {
    id: 'spawn_subagent',
    name: 'SpawnSubagentTool',
    description:
      'Spawn a focused subagent to complete a specific subtask. The subagent runs in ' +
      'an isolated context and returns a structured result. Use this to decompose complex ' +
      'tasks into smaller, parallelizable pieces. Each session has a limited spawn budget.',
    inputSchema: {
      type: 'object',
      properties: {
        taskName: {
          type: 'string',
          description: 'Human-readable name for the subtask (e.g., "Analyze dependencies")',
        },
        taskDescription: {
          type: 'string',
          description: 'The detailed task description for the subagent to execute',
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional system prompt override for the subagent',
        },
        relevantFiles: {
          type: 'array',
          description: 'File references relevant to the subtask (scoped context)',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
            },
            required: ['path'],
          },
        },
        additionalContext: {
          type: 'string',
          description: 'Additional context to pass to the subagent',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum tokens for the subagent LLM response (default: 1000)',
        },
      },
      required: ['taskName', 'taskDescription'],
    },
    riskLevel: 'execute',
    execute: createSpawnSubagentExecute(deps),
  };
}

// ─── Registration Helper ────────────────────────────────────────

/**
 * Register the spawn_subagent tool with a ToolSystem instance.
 */
export function registerSpawnSubagentTool(
  toolSystem: { register: (tool: ExecutableToolDefinition) => void },
  deps: {
    getLLMClient: () => LLMClient | null;
    getSessionId: () => string | null;
    getParentPermissions: (agentId: string) => ToolPermissions;
    costTracker?: CostTracker | null;
    isFeatureEnabled: () => boolean;
  },
): void {
  const tool = createSpawnSubagentTool(deps);
  toolSystem.register(tool);
}
