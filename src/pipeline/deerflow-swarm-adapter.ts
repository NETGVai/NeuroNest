import type { ToolSystem } from '../tools/tool-system.js';
import type { ExecutionPlan, Topology } from './orchestrator-planner.js';
import type { LLMClient } from './llm-client.js';
import {
  SwarmCoordinator,
  SwarmMemoryPool,
  type SwarmCoordinatorOptions,
  type SwarmResult,
} from './swarm-coordinator.js';
import { createAgentLoopSwarmWorkerFactory } from './swarm-worker-agent-loop.js';

export interface DeerFlowSwarmPlan {
  task: string;
  sessionId: string;
  mode: string;
  agents: string[];
}

export interface DeerFlowSwarmAdapterResult {
  output: string;
  agentsUsed: string[];
  tokensUsed: number;
}

export interface DeerFlowCoordinatorFactoryInput {
  memoryPool: SwarmMemoryPool;
  llmClient: LLMClient;
  skillDb: unknown;
  options: SwarmCoordinatorOptions;
}

export interface DeerFlowSwarmAdapterOptions {
  llmClient: LLMClient;
  skillDb?: unknown;
  toolSystem: ToolSystem;
  resolveProjectDir: (sessionId: string) => string;
  createCoordinator?: (input: DeerFlowCoordinatorFactoryInput) => Pick<SwarmCoordinator, 'execute'>;
}

/** Build the long-lived router adapter while keeping each swarm run isolated. */
export function createDeerFlowSwarmAdapter(options: DeerFlowSwarmAdapterOptions): {
  execute(plan: DeerFlowSwarmPlan): Promise<DeerFlowSwarmAdapterResult>;
} {
  const createCoordinator = options.createCoordinator ?? (input => new SwarmCoordinator(
    input.memoryPool,
    input.llmClient,
    undefined,
    undefined,
    input.skillDb as any,
    input.options,
  ));

  return {
    async execute(plan: DeerFlowSwarmPlan): Promise<DeerFlowSwarmAdapterResult> {
      const projectDir = options.resolveProjectDir(plan.sessionId);
      const workerDelegateFactory = createAgentLoopSwarmWorkerFactory({
        toolSystem: options.toolSystem,
        projectDir,
        sessionId: plan.sessionId,
        actionFirst: { maxRePromptAttempts: 2 },
      });
      const coordinator = createCoordinator({
        memoryPool: new SwarmMemoryPool(),
        llmClient: options.llmClient,
        skillDb: options.skillDb ?? null,
        options: { workerDelegateFactory },
      });
      const topology = (plan.mode === 'parallel' ? 'star' : 'sequential') as Topology;
      const executionPlan: ExecutionPlan = {
        plan: plan.task,
        agents: plan.agents.map(id => ({ id, task: plan.task, dependsOn: [] })),
        topology,
      };
      const result: SwarmResult = await coordinator.execute(executionPlan);
      const outputParts: string[] = [];
      for (const value of result.outputs?.values() ?? []) {
        if (value) outputParts.push(value);
      }
      return {
        output: outputParts.join('\n'),
        agentsUsed: plan.agents,
        tokensUsed: 0,
      };
    },
  };
}
