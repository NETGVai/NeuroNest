/**
 * Execution_Mode_Router — selects and enforces one of five execution modes
 * (flash, standard, pro, ultra, loop) for a given task.
 *
 * - flash:    bypass Swarm_Coordinator, route to single best-fit agent via scoreAllAgents()
 * - standard: planning then single agent via Swarm_Coordinator
 * - pro:      planning then sequential multi-agent via Swarm_Coordinator
 * - ultra:    decompose into sub-tasks, parallel execution via Swarm_Coordinator
 * - loop:     bounded iterative execution via LoopRunner (mutual exclusion with SwarmCoordinator)
 *
 * Dependencies are injected via interfaces so tests can mock them.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 6.1, 6.2, 6.3, 6.4
 */

import type {
  ExecutionMode,
  ModeConfig,
  ExecutionResult,
} from './types/deerflow-types.js';

// ─── Token budgets per mode ─────────────────────────────────────
const MODE_TOKEN_BUDGETS: Record<ExecutionMode, number> = {
  flash: 2_048,
  standard: 4_096,
  pro: 8_192,
  ultra: 16_384,
  loop: 16_384,
};

// ─── Dependency interfaces (for DI / mocking) ──────────────────

/** Minimal interface for an agent definition used by the router. */
export interface AgentDefinitionLike {
  id: string;
  name: string;
  department: string;
  specialty: string;
  systemPrompt: string;
}

/** Minimal interface for the LLM client used in flash mode. */
export interface LLMClientLike {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<{ content: string; tokensUsed?: number }>;
}

/** Minimal interface for the Swarm_Coordinator used in standard/pro/ultra modes. */
export interface SwarmCoordinatorLike {
  execute(
    plan: { task: string; sessionId: string; mode: 'single' | 'sequential' | 'parallel'; agents: string[] },
  ): Promise<{ output: string; agentsUsed: string[]; tokensUsed: number }>;
}

/**
 * Minimal interface for the Loop_Runner used in loop mode.
 * A concrete LoopRunner implementation must be injected by the caller.
 * (The former loop-engine subsystem was removed — spec orphaned-code-remediation
 *  task 14.2, R10 REMOVE disposition.)
 *
 * Requirements: 6.2, 6.5
 */
export interface LoopRunnerLike {
  start(task: string, sessionId: string): Promise<{ runId: string; output: string; tokensUsed: number }>;
}

/**
 * Minimal interface for feature flag checking.
 * Used to gate loop mode on the loops_enabled flag.
 *
 * Requirements: 6.3
 */
export interface FeatureGateLike {
  isEnabled(feature: string): boolean;
}

// ─── ExecutionModeRouter ────────────────────────────────────────

export class ExecutionModeRouter {
  private currentMode: ExecutionMode = 'standard';

  constructor(
    private readonly swarmCoordinator: SwarmCoordinatorLike,
    private readonly llmClient: LLMClientLike,
    private readonly agentRegistry: AgentDefinitionLike[],
    private readonly loopRunner?: LoopRunnerLike,
    private readonly featureGate?: FeatureGateLike,
  ) {}

  /**
   * Set execution mode for subsequent tasks.
   * New mode applies only to tasks submitted after this call.
   *
   * Requirements: 3.2, 3.6
   */
  setMode(mode: ExecutionMode): void {
    this.currentMode = mode;
  }

  /**
   * Get the current execution mode.
   */
  getMode(): ExecutionMode {
    return this.currentMode;
  }

  /**
   * Route a task through the appropriate execution pipeline based on the active mode.
   *
   * Requirements: 3.1, 3.3, 3.4, 3.5, 6.1, 6.2, 6.3
   */
  async execute(task: string, sessionId: string): Promise<ExecutionResult> {
    const mode = this.currentMode;

    switch (mode) {
      case 'flash':
        return this.executeFlash(task, sessionId);
      case 'standard':
        return this.executeStandard(task, sessionId);
      case 'pro':
        return this.executePro(task, sessionId);
      case 'ultra':
        return this.executeUltra(task, sessionId);
      case 'loop':
        return this.executeLoop(task, sessionId);
      default: {
        // Exhaustive check — should never happen with typed input
        const _exhaustive: never = mode;
        throw new Error(`Unknown execution mode: ${_exhaustive}`);
      }
    }
  }

  /**
   * Get metadata about current mode and token budget.
   *
   * Requirements: 3.7
   */
  getModeInfo(): ModeConfig {
    return {
      mode: this.currentMode,
      tokenBudget: MODE_TOKEN_BUDGETS[this.currentMode],
    };
  }

  // ─── Private mode implementations ─────────────────────────────

  /**
   * Flash mode: bypass Swarm_Coordinator, pick best-fit agent, call LLM directly.
   *
   * Requirements: 3.3
   */
  private async executeFlash(task: string, _sessionId: string): Promise<ExecutionResult> {
    const bestAgent = this.scoreAllAgents(task);

    const response = await this.llmClient.chat([
      { role: 'system', content: bestAgent.systemPrompt },
      { role: 'user', content: task },
    ], {
      maxTokens: MODE_TOKEN_BUDGETS.flash,
    });

    return {
      output: response.content,
      mode: 'flash',
      agentsUsed: [bestAgent.id],
      tokensUsed: response.tokensUsed ?? 0,
    };
  }

  /**
   * Standard mode: planning then single agent via Swarm_Coordinator.
   *
   * Requirements: 3.1, 3.5
   */
  private async executeStandard(task: string, sessionId: string): Promise<ExecutionResult> {
    const bestAgent = this.scoreAllAgents(task);

    const result = await this.swarmCoordinator.execute({
      task,
      sessionId,
      mode: 'single',
      agents: [bestAgent.id],
    });

    return {
      output: result.output,
      mode: 'standard',
      agentsUsed: result.agentsUsed,
      tokensUsed: result.tokensUsed,
    };
  }

  /**
   * Pro mode: planning then sequential multi-agent via Swarm_Coordinator.
   *
   * Requirements: 3.1
   */
  private async executePro(task: string, sessionId: string): Promise<ExecutionResult> {
    const agents = this.selectMultipleAgents(task);

    const result = await this.swarmCoordinator.execute({
      task,
      sessionId,
      mode: 'sequential',
      agents: agents.map((a) => a.id),
    });

    return {
      output: result.output,
      mode: 'pro',
      agentsUsed: result.agentsUsed,
      tokensUsed: result.tokensUsed,
    };
  }

  /**
   * Ultra mode: decompose into sub-tasks, parallel execution via Swarm_Coordinator.
   *
   * Requirements: 3.4
   */
  private async executeUltra(task: string, sessionId: string): Promise<ExecutionResult> {
    const agents = this.selectMultipleAgents(task);

    const result = await this.swarmCoordinator.execute({
      task,
      sessionId,
      mode: 'parallel',
      agents: agents.map((a) => a.id),
    });

    return {
      output: result.output,
      mode: 'ultra',
      agentsUsed: result.agentsUsed,
      tokensUsed: result.tokensUsed,
    };
  }

  /**
   * Loop mode: bounded iterative execution via LoopRunner.
   *
   * Enforces mutual exclusion (REQ-6.2): exactly one component is invoked —
   * the LoopRunner. The SwarmCoordinator is NOT called directly by the router
   * in loop mode (the LoopRunner itself calls SwarmCoordinator once per pass).
   *
   * Checks the loops_enabled feature flag (REQ-6.3): throws if disabled.
   *
   * Requirements: 6.1, 6.2, 6.3, 6.4
   */
  private async executeLoop(task: string, sessionId: string): Promise<ExecutionResult> {
    // REQ-6.3: Check loops_enabled feature flag
    if (!this.featureGate || !this.featureGate.isEnabled('loops_enabled')) {
      throw new Error(
        'Loop execution mode is not enabled. Enable the loops_enabled feature flag to use loop mode.',
      );
    }

    // REQ-6.2: Mutual exclusion — exactly one component invoked (LoopRunner)
    // Never both LoopRunner and SwarmCoordinator from the router, and never neither.
    if (!this.loopRunner) {
      throw new Error(
        'Loop execution mode requires a LoopRunner instance. Provide a LoopRunner via the constructor.',
      );
    }

    // Delegate to LoopRunner only — SwarmCoordinator is NOT invoked here.
    // The LoopRunner itself calls SwarmCoordinator once per pass (REQ-6.5).
    const result = await this.loopRunner.start(task, sessionId);

    return {
      output: result.output,
      mode: 'loop',
      agentsUsed: ['loop-runner'],
      tokensUsed: result.tokensUsed,
    };
  }

  // ─── Agent selection helpers ──────────────────────────────────

  /**
   * Score all agents against a task and return the best-fit agent.
   * Uses LLM-based selection when available, falls back to keyword matching.
   */
  private scoreAllAgents(task: string): AgentDefinitionLike {
    if (this.agentRegistry.length === 0) {
      throw new Error('Agent registry is empty — cannot select an agent');
    }

    const taskLower = task.toLowerCase();
    let bestAgent = this.agentRegistry[0];
    let bestScore = -1;

    for (const agent of this.agentRegistry) {
      let score = 0;
      const specialtyWords = agent.specialty.toLowerCase().split(/\s+/);
      const deptWords = agent.department.toLowerCase().split(/\s+/);

      for (const word of specialtyWords) {
        if (word.length > 2 && taskLower.includes(word)) {
          score += 2;
        }
      }
      for (const word of deptWords) {
        if (word.length > 2 && taskLower.includes(word)) {
          score += 1;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    return bestAgent;
  }

  /**
   * Select multiple relevant agents for pro/ultra modes.
   * Returns at least 2 agents (or all if registry has fewer than 2).
   */
  private selectMultipleAgents(task: string): AgentDefinitionLike[] {
    if (this.agentRegistry.length <= 2) {
      return [...this.agentRegistry];
    }

    const taskLower = task.toLowerCase();

    const scored = this.agentRegistry.map((agent) => {
      let score = 0;
      const specialtyWords = agent.specialty.toLowerCase().split(/\s+/);
      const deptWords = agent.department.toLowerCase().split(/\s+/);

      for (const word of specialtyWords) {
        if (word.length > 2 && taskLower.includes(word)) {
          score += 2;
        }
      }
      for (const word of deptWords) {
        if (word.length > 2 && taskLower.includes(word)) {
          score += 1;
        }
      }

      return { agent, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Return top agents, minimum 2
    const topCount = Math.max(2, Math.min(scored.length, Math.ceil(scored.length * 0.3)));
    return scored.slice(0, topCount).map((s) => s.agent);
  }

  /**
   * LLM-based agent selection for flash mode.
   * Falls back to keyword-based scoreAllAgents() if LLM is unavailable.
   */
  async scoreAllAgentsWithLLM(task: string, llmClient?: LLMClientLike): Promise<AgentDefinitionLike> {
    if (llmClient && this.agentRegistry.length > 0) {
      try {
        const { selectAgentsWithLLM } = await import('./llm-decision-engine');
        const agentSummaries = this.agentRegistry.slice(0, 25).map(a => ({
          id: a.id, name: a.name, department: a.department, specialty: a.specialty.slice(0, 80)
        }));
        const result = await selectAgentsWithLLM(task, agentSummaries, llmClient as any);
        if (result && result.agentIds.length > 0) {
          const found = this.agentRegistry.find(a => a.id === result.agentIds[0]);
          if (found) return found;
        }
      } catch (err: any) {
        console.warn('[ExecutionModeRouter] LLM agent selection failed:', err?.message);
      }
    }
    return this.scoreAllAgents(task);
  }

  /**
   * LLM-based multi-agent selection for pro/ultra modes.
   * Falls back to keyword-based selectMultipleAgents() if LLM is unavailable.
   */
  async selectMultipleAgentsWithLLM(task: string, llmClient?: LLMClientLike): Promise<AgentDefinitionLike[]> {
    if (llmClient && this.agentRegistry.length > 0) {
      try {
        const { selectAgentsWithLLM } = await import('./llm-decision-engine');
        const agentSummaries = this.agentRegistry.slice(0, 25).map(a => ({
          id: a.id, name: a.name, department: a.department, specialty: a.specialty.slice(0, 80)
        }));
        const result = await selectAgentsWithLLM(task, agentSummaries, llmClient as any);
        if (result && result.agentIds.length >= 2) {
          const agents = result.agentIds
            .map((id: string) => this.agentRegistry.find((a: AgentDefinitionLike) => a.id === id))
            .filter((a: AgentDefinitionLike | undefined): a is AgentDefinitionLike => a !== undefined);
          if (agents.length >= 2) return agents;
        }
      } catch (err: any) {
        console.warn('[ExecutionModeRouter] LLM multi-agent selection failed:', err?.message);
      }
    }
    return this.selectMultipleAgents(task);
  }
}

export default ExecutionModeRouter;
