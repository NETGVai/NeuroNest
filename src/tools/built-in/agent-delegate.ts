/**
 * Agent Delegation Tool — Delegates subtasks to specialized agents via LLM.
 *
 * Factory function `createAgentExecute` accepts agent registry and LLM client
 * resolver, and returns an execute function that:
 * 1. Validates input (agentId, task, optional maxTokens)
 * 2. Looks up the agent in the registry
 * 3. Invokes the LLM with the agent's systemPrompt + task
 * 4. Returns the LLM response or a structured error
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ToolDependencies, LLMClient } from './tool-dependencies.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Input Interface ────────────────────────────────────────────

export interface AgentDelegateInput {
  agentId: string;
  task: string;
  maxTokens?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 4096;

// ─── Input Schema ───────────────────────────────────────────────

const AGENT_DELEGATE_SCHEMA: FieldSchema[] = [
  { name: 'agentId', type: 'string' },
  { name: 'task', type: 'string' },
  { name: 'maxTokens', type: 'number', required: false },
];

// ─── Factory Function ───────────────────────────────────────────

/**
 * Creates the execute function for the Agent delegation tool.
 *
 * @param deps - Dependencies: agentRegistry for lookup, resolveLLMClient for LLM access
 * @returns A standard tool execute function `(input: unknown, context: ToolContext) => Promise<ToolResult>`
 */
export function createAgentExecute(
  deps: Pick<ToolDependencies, 'agentRegistry' | 'resolveLLMClient'>,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  const { agentRegistry, resolveLLMClient } = deps;

  return safeExecute<AgentDelegateInput>(
    AGENT_DELEGATE_SCHEMA,
    async (input: AgentDelegateInput): Promise<ToolResult> => {
      const { agentId, task, maxTokens } = input;

      // 1. Look up agent in registry by id (Req 3.1)
      const agent = agentRegistry.find((a) => a.id === agentId);
      if (!agent) {
        // Req 3.2: agent not found
        return {
          success: false,
          output: null,
          error: `Agent not found: "${agentId}"`,
        };
      }

      // 2. Resolve the LLM client (Req 3.4)
      const llmClient: LLMClient | null = resolveLLMClient();
      if (!llmClient) {
        return {
          success: false,
          output: null,
          error: 'No AI provider is configured',
        };
      }

      // 3. Invoke LLM with agent's systemPrompt as system message and task as user message (Req 3.3)
      const effectiveMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS; // Req 3.7, 3.8

      const response = await llmClient.chat(
        [
          { role: 'system', content: agent.systemPrompt },
          { role: 'user', content: task },
        ],
        { maxTokens: effectiveMaxTokens },
      );

      // 4. Return LLM response (Req 3.5)
      return {
        success: true,
        output: response,
      };
    },
  );
}
