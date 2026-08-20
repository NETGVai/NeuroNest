import type { ToolSystem } from '../tools/tool-system.js';
import {
  AgentLoopController,
  type AgentLLMClient,
  type AgentLLMResponse,
  type AgentLoopToolObservation,
  type AgentMessage,
  type FunctionDefinition,
} from './agent-loop.js';
import type { LLMClient } from './llm-client.js';
import type { SwarmWorkerDelegateFactory } from './swarm-coordinator.js';

export interface AgentLoopSwarmWorkerFactoryOptions {
  toolSystem: ToolSystem;
  projectDir: string;
  sessionId: string;
  maxIterations?: number;
  /** The parent chat turn already performed scope-divergence preflight. */
  scopePreflightCompleted?: boolean;
  /** Worker-local bounded enforcement for action requests that return text only. */
  actionFirst?: {
    maxRePromptAttempts: number;
  };
  onToolObservation?: (observation: AgentLoopToolObservation) => void | Promise<void>;
  ipcSend?: (channel: string, data: unknown) => void;
}

/** Adapt the pipeline LLM client to the iterative AgentLoop tool-call contract. */
export function adaptSwarmWorkerLLM(llmClient: LLMClient): AgentLLMClient {
  return {
    async chatWithTools(
      messages: AgentMessage[],
      tools: FunctionDefinition[],
      options?: { temperature?: number; maxTokens?: number },
    ): Promise<AgentLLMResponse> {
      const llmMessages = messages.map(message => ({
        role: message.role,
        content: message.content,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      }));
      const response: any = await (llmClient as any).chat(llmMessages as any, {
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens,
        tools: tools.map(tool => ({ type: 'function' as const, function: tool.function })),
      });

      const result: AgentLLMResponse = { content: response?.content || '' };
      if (response?.tool_calls?.length) result.tool_calls = response.tool_calls;
      if (response?.tokensUsed || response?.promptTokens) {
        result.usage = {
          promptTokens: response.promptTokens || 0,
          completionTokens: response.completionTokens || 0,
          totalTokens: response.tokensUsed || (response.promptTokens || 0) + (response.completionTokens || 0),
        };
      }
      return result;
    },
  };
}

/**
 * Create one bounded AgentLoopController per swarm worker. The owning
 * coordinator supplies cancellation; drift remains owned by the outer run and
 * receives only real terminal tool observations through the callback.
 */
export function createAgentLoopSwarmWorkerFactory(
  options: AgentLoopSwarmWorkerFactoryOptions,
): SwarmWorkerDelegateFactory {
  return request => {
    const controller = new AgentLoopController({
      llmClient: adaptSwarmWorkerLLM(request.llmClient),
      toolSystem: options.toolSystem,
      projectDir: options.projectDir,
      sessionId: request.sessionId || options.sessionId,
      agentId: request.agentId,
      systemPromptPrefix: request.systemPrompt,
      phasedExecutionEnabled: false,
      scopePreflightCompleted: options.scopePreflightCompleted,
      signal: request.signal,
      maxIterations: options.maxIterations ?? 25,
      planMode: false,
      turboEditsEnabled: false,
      smartContextEnabled: false,
      ...(options.actionFirst ? {
        superagentConfig: { flags: { production_ux_action_first: true } },
        actionFirstEnabled: true,
        requireToolUsageBeforeFinalResponse: true,
        maxRePromptAttempts: Math.max(0, Math.floor(options.actionFirst.maxRePromptAttempts)),
      } : {}),
      onToolObservation: options.onToolObservation,
      ipcSend: options.ipcSend,
    });

    return {
      execute: async () => {
        const abortWorkerLLM = () => {
          try { request.llmClient.abort(); } catch {}
        };
        request.signal?.addEventListener('abort', abortWorkerLLM, { once: true });
        try {
          const result = await controller.run(request.task);
          return { response: result.response };
        } finally {
          request.signal?.removeEventListener('abort', abortWorkerLLM);
        }
      },
    };
  };
}
