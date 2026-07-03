/**
 * Sub_Agent_Context_Isolator — creates and manages isolated context boundaries
 * for each sub-agent within a swarm execution.
 *
 * Each sub-agent operates in its own scope with a dedicated message history,
 * token budget, and isolation level. Supports strict (no shared context) and
 * permissive (shared read-only Memory_Store facts) isolation.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import { randomUUID } from 'node:crypto';
import type { IsolatedContext, IsolationLevel, LLMMessage } from './types/deerflow-types.js';
import type { ContextSummarizer } from './context-summarizer.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import { computeInputTokenBudget } from './token-budget.js';
import { getActiveContextLength } from './active-model.js';
import { isGcfExpandedActive } from './gcf-gate.js';
import { encodeGeneric, GCF_PRIMER } from '../serializers/gcf-encoder.js';

/** Rough token estimate: ~4 chars per token. */
function estimateTokenCost(content: string): number {
  return Math.ceil(content.length / 4);
}

/** Compute total token cost of a message array. */
function totalTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokenCost(m.content), 0);
}

export class SubAgentContextIsolator {
  private readonly scopes: Map<string, IsolatedContext> = new Map();
  private readonly contextSummarizer: ContextSummarizer | null;
  private readonly memoryStore: MemoryStore | null;
  private readonly featureGate: FeatureGateSystem | null;

  constructor(
    contextSummarizer: ContextSummarizer | null,
    memoryStore: MemoryStore | null,
    featureGate?: FeatureGateSystem | null,
  ) {
    this.contextSummarizer = contextSummarizer;
    this.memoryStore = memoryStore;
    this.featureGate = featureGate ?? null;
  }

  /**
   * Create an isolated context for a sub-agent.
   *
   * The scope starts with exactly two messages: the system prompt (role: system)
   * and the task (role: user). In permissive mode, read-only memory facts are
   * injected between the system prompt and the task.
   *
   * Token budget is derived from the shared Adaptive_Token_Budget calculator
   * (`computeInputTokenBudget`) rather than a raw subtraction. The active
   * model's context length is resolved via the Active_Model_Resolver
   * (`getActiveContextLength`), and the orchestrator's reservation is then
   * subtracted with a floor of 1:
   *
   *   tokenBudget = max(1, calculatorBudget - orchestratorReservedTokens).
   *
   * Requirements: 6.1, 6.5, 13.1, 13.2
   */
  createScope(
    agentId: string,
    systemPrompt: string,
    task: string,
    orchestratorReservedTokens: number,
    contextWindowSize: number,
    isolationLevel: IsolationLevel = 'strict',
  ): IsolatedContext {
    const scopeId = randomUUID();

    // Req 13.2: resolve the active model's context length via the
    // Active_Model_Resolver. The caller supplies `contextWindowSize` as a raw
    // number, so present it to the resolver in the `contextLength` field it
    // understands; an undeterminable window resolves to 0 (adaptive default).
    const contextLength = getActiveContextLength({ contextLength: contextWindowSize });

    // Req 13.1: obtain the budget from the Token_Budget_Calculator. No explicit
    // override is wired here, so adaptive sizing applies headroom to the
    // resolved context length.
    const calculatorBudget = computeInputTokenBudget(0, contextLength, false);

    // Subtract the orchestrator's reservation, never dropping below 1.
    const tokenBudget = Math.max(1, calculatorBudget - orchestratorReservedTokens);

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Permissive mode: inject read-only memory facts before the task
    if (isolationLevel === 'permissive' && this.memoryStore) {
      const facts = this.memoryStore.loadContext('default', contextWindowSize);
      if (facts.length > 0) {
        let factsContent = facts
          .map((f) => `[${f.category}] ${f.key}: ${f.value}`)
          .join('\n');

        if (isGcfExpandedActive(this.featureGate)) {
          const encoded = encodeGeneric(factsContent);
          if (encoded !== null) {
            factsContent = GCF_PRIMER + '\n' + encoded;
          } else {
            console.warn('[SubAgentContextIsolator] GCF encoding failed, using plain text');
          }
        }

        messages.push({ role: 'system', content: factsContent });
      }
    }

    messages.push({ role: 'user', content: task });

    const scope: IsolatedContext = {
      scopeId,
      agentId,
      systemPrompt,
      messages,
      tokenBudget,
      isolationLevel,
    };

    this.scopes.set(scopeId, scope);
    return scope;
  }

  /**
   * Append a message to a scope's history. Enforces token budget.
   *
   * Before adding, checks if total token cost would exceed budget.
   * If it would, triggers Context_Summarizer to compress the history.
   *
   * Requirements: 6.4, 6.6
   */
  addMessage(scopeId: string, message: LLMMessage): void {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`);
    }

    const messageCost = estimateTokenCost(message.content);
    const currentCost = totalTokens(scope.messages);

    if (currentCost + messageCost > scope.tokenBudget) {
      // Trigger Context_Summarizer to compress history
      if (this.contextSummarizer) {
        const historyContent = scope.messages
          .filter((m) => m.role !== 'system')
          .map((m) => m.content)
          .join('\n');

        const record = this.contextSummarizer.summarize(
          scopeId,
          `${scope.agentId}-compression`,
          historyContent,
        );

        // Replace non-system messages with the summary
        const systemMessages = scope.messages.filter((m) => m.role === 'system');
        scope.messages = [
          ...systemMessages,
          { role: 'user', content: record.summary },
        ];
      } else {
        // No summarizer available — drop oldest non-system messages to make room
        while (
          scope.messages.length > 1 &&
          totalTokens(scope.messages) + messageCost > scope.tokenBudget
        ) {
          // Find first non-system message and remove it
          const idx = scope.messages.findIndex((m) => m.role !== 'system');
          if (idx === -1) break;
          scope.messages.splice(idx, 1);
        }
      }
    }

    scope.messages.push(message);
  }

  /**
   * Extract final result from a completed scope.
   *
   * Returns the content of the last assistant-role message.
   * If no assistant message exists, returns empty string.
   *
   * Requirements: 6.3
   */
  extractResult(scopeId: string): string {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`);
    }

    for (let i = scope.messages.length - 1; i >= 0; i--) {
      if (scope.messages[i]!.role === 'assistant') {
        return scope.messages[i]!.content;
      }
    }

    return '';
  }

  /**
   * Destroy a scope and free resources.
   *
   * Requirements: 6.2
   */
  destroyScope(scopeId: string): void {
    this.scopes.delete(scopeId);
  }

  /**
   * Get all messages for a scope, each tagged with the scopeId for audit.
   *
   * Requirements: 6.7
   */
  getMessages(scopeId: string): (LLMMessage & { scopeId: string })[] {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`);
    }

    return scope.messages.map((m) => ({ ...m, scopeId }));
  }
}

export default SubAgentContextIsolator;
