/**
 * DeerFlow Pipeline Integration — hooks DeerFlow modules into the
 * Swarm_Coordinator pipeline via composition and event hooks.
 *
 * All integrations are non-destructive: existing modules are extended
 * via composition, not modified in breaking ways.
 *
 * Requirements: 1.1, 2.1, 3.1, 6.1, 7.1, 8.1
 */

import type { SwarmEvent, SwarmEventCallback } from './swarm-coordinator.js';
import type { SkillLoader } from './skill-loader.js';
import type { ContextSummarizer } from './context-summarizer.js';
import type { ToolCallRecoveryHandler } from './tool-call-recovery.js';
import type { SubAgentContextIsolator } from './sub-agent-context-isolator.js';
import type { ExecutionModeRouter } from './execution-mode-router.js';
import type { SuggestionGenerator } from './suggestion-generator.js';
import type { LLMMessage } from './llm-client.js';
import { computeInputTokenBudget, resolveBudgetInputs } from './token-budget.js';
import { getActiveContextLength } from './active-model.js';

// ─── Pipeline Hook Configuration ────────────────────────────────

export interface DeerFlowPipelineConfig {
  skillLoader: SkillLoader;
  contextSummarizer: ContextSummarizer;
  toolCallRecoveryHandler: ToolCallRecoveryHandler;
  subAgentContextIsolator: SubAgentContextIsolator;
  executionModeRouter: ExecutionModeRouter;
  suggestionGenerator: SuggestionGenerator;
  contextWindowSize?: number;
  /**
   * Active LLM provider, used to resolve the model's context window via
   * `getActiveContextLength` when `contextWindowSize` is not explicitly set.
   */
  activeProvider?: unknown;
  /**
   * Persisted explicit input-token budget override (AppConfigSchema.inputBudget).
   * A positive finite value is honored exactly; anything else falls back to
   * adaptive sizing.
   */
  inputBudget?: number | null;
  userId?: string;
  onSuggestionsReady?: (suggestions: unknown[]) => void;
}

// ─── DeerFlowPipelineIntegration ────────────────────────────────

export class DeerFlowPipelineIntegration {
  private readonly config: DeerFlowPipelineConfig;

  constructor(config: DeerFlowPipelineConfig) {
    this.config = config;
  }

  /**
   * Create a SwarmEventCallback that hooks DeerFlow modules into
   * the Swarm_Coordinator event stream.
   *
   * - phase_start: triggers Skill_Loader to load skills for the phase
   * - agent_start: triggers Skill_Loader and Sub_Agent_Context_Isolator
   * - agent_complete: triggers Context_Summarizer on sub-task completion
   * - swarm_complete: triggers Suggestion_Generator
   */
  createEventHook(existingCallback?: SwarmEventCallback): SwarmEventCallback {
    return (event: SwarmEvent) => {
      // Forward to existing callback first
      existingCallback?.(event);

      // Hook DeerFlow modules based on event type
      switch (event.type) {
        case 'phase_start':
          this.onPhaseStart(event);
          break;
        case 'agent_start':
          this.onAgentStart(event);
          break;
        case 'agent_complete':
          this.onAgentComplete(event);
          break;
        case 'swarm_complete':
          this.onSwarmComplete(event);
          break;
      }
    };
  }

  /**
   * Post-process LLM responses through Tool_Call_Recovery_Handler.
   * Wraps the LLM client's chat() response to detect and repair
   * dangling tool calls.
   *
   * Requirements: 7.1
   */
  processLLMResponse(messages: LLMMessage[]): { messages: LLMMessage[]; recovered: boolean } {
    const { toolCallRecoveryHandler } = this.config;
    const result = toolCallRecoveryHandler.recover(messages);
    return {
      messages: result.messages,
      recovered: result.events.length > 0,
    };
  }

  /**
   * Execute a task through the Execution_Mode_Router entry point.
   * This is the primary entry point for task execution in the DeerFlow pipeline.
   *
   * Requirements: 3.1
   */
  async executeTask(task: string, sessionId: string) {
    const { executionModeRouter } = this.config;
    return executionModeRouter.execute(task, sessionId);
  }

  /**
   * Wrap agent execution in Sub_Agent_Context_Isolator.
   * Creates an isolated scope for the agent, executes the task,
   * and extracts the result.
   *
   * Requirements: 6.1
   */
  executeAgentTask(
    agentId: string,
    systemPrompt: string,
    task: string,
    orchestratorReservedTokens: number,
  ) {
    const { subAgentContextIsolator } = this.config;
    // Adaptive_Token_Budget (Feature 2, Req 13): draw the context window from
    // the shared calculator instead of a hard-coded literal. An explicitly
    // configured `contextWindowSize` still wins (backward compatible); when it
    // is absent, resolve the active model's context length and size the budget
    // adaptively, falling back to the legacy 8192 default when the context
    // length is unknown.
    const { configured, explicit } = resolveBudgetInputs(this.config.inputBudget);
    const contextLength = getActiveContextLength(this.config.activeProvider);
    const contextWindowSize =
      this.config.contextWindowSize ??
      computeInputTokenBudget(configured, contextLength, explicit, { default: 8192 });

    const scope = subAgentContextIsolator.createScope(
      agentId,
      systemPrompt,
      task,
      orchestratorReservedTokens,
      contextWindowSize,
    );

    return {
      scopeId: scope.scopeId,
      addMessage: (message: LLMMessage) => subAgentContextIsolator.addMessage(scope.scopeId, message),
      extractResult: () => subAgentContextIsolator.extractResult(scope.scopeId),
      destroy: () => subAgentContextIsolator.destroyScope(scope.scopeId),
    };
  }

  // ─── Private event handlers ─────────────────────────────────────

  /**
   * Hook Skill_Loader into phase_start events.
   * Loads skills relevant to the phase's domain.
   */
  private onPhaseStart(event: SwarmEvent): void {
    try {
      const domain = event.content ?? 'general';
      this.config.skillLoader.loadForTask(domain);
    } catch (err) {
      console.warn('[DeerFlow Pipeline] Skill loading failed on phase_start:', err);
    }
  }

  /**
   * Hook Skill_Loader into agent_start events.
   * Loads skills relevant to the agent's domain.
   */
  private onAgentStart(event: SwarmEvent): void {
    try {
      const domain = event.agentId ?? 'general';
      this.config.skillLoader.loadForTask(domain);
    } catch (err) {
      console.warn('[DeerFlow Pipeline] Skill loading failed on agent_start:', err);
    }
  }

  /**
   * Insert Context_Summarizer into sub-task completion flow.
   * Summarizes the agent's output when it completes.
   */
  private onAgentComplete(event: SwarmEvent): void {
    try {
      if (event.content && event.agentId) {
        this.config.contextSummarizer.summarize(
          'pipeline-session',
          event.agentId,
          event.content,
        );
      }
    } catch (err) {
      console.warn('[DeerFlow Pipeline] Context summarization failed on agent_complete:', err);
    }
  }

  /**
   * Wire Suggestion_Generator to fire after task completion.
   * Generates follow-up suggestions based on the swarm output.
   */
  private onSwarmComplete(event: SwarmEvent): void {
    try {
      const { suggestionGenerator, onSuggestionsReady } = this.config;
      const userId = this.config.userId ?? 'default';
      const output = event.content ?? '';

      if (output) {
        const suggestions = suggestionGenerator.generate(output, 'general', userId);
        onSuggestionsReady?.(suggestions);
      }
    } catch (err) {
      console.warn('[DeerFlow Pipeline] Suggestion generation failed on swarm_complete:', err);
    }
  }
}

export default DeerFlowPipelineIntegration;
